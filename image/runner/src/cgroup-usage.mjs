import * as nodeFs from "node:fs";

/**
 * What this job's container used, read from its own cgroup at exit (issue #596, INT-RUNNER-EXIT-CODE-PROTOCOL).
 *
 * The worker cannot read it afterwards: every job container runs with `--rm`, a fixed isolation flag, so the cgroup is
 * gone by the time `docker run` returns. The runner is the last process that can see it, which is why these numbers
 * ride the signed exit line and are read as late as possible, just before that line is written.
 *
 * Measured inside a job (Docker Desktop, rootful Docker 29 and rootless Podman 4.9, `--cgroupns=private`): the
 * container's own cgroup is the root of the view (`/proc/self/cgroup` is `0::/`), mounted read-only, with every file
 * read below present. The path is still taken from `/proc/self/cgroup` rather than assumed to be the mount's root,
 * because under a host cgroup namespace the root of `/sys/fs/cgroup` is the HOST's cgroup, and its `cpu.stat` and
 * `memory.pressure` would report the whole machine as this job.
 *
 * Every read is synchronous and best effort: a missing, unreadable or malformed file is a null for its keys, and this
 * module never throws. A job whose numbers cannot be read still ends exactly as it would have; the record then says
 * "not measured" (null), never zero. cgroup v1 is read for the cheap half only (peak memory, OOM kills, CPU time and
 * throttling); every other key is null there.
 *
 * From `memory.events` only `oom_kill` is read, never `oom` or `max`: under crun (rootless and rootful Podman) the limit
 * sits on the parent `libpod-<id>.scope` and the namespace root is a `container` leaf below it, so the OOM is counted on
 * the parent and the leaf the job can see shows `oom 0` with `oom_kill 1` (measured on Podman 4.9 and 5.8). Only the kill
 * is charged to the job's own cgroup on every venue.
 *
 * Every value is a non-negative SAFE integer: bytes, microseconds or counts. The worker re-checks each one
 * (worker/src/run-history.mjs `parseExitResources`), so nothing here is trusted beyond its shape.
 */

/** The keys, in the order they are written. The worker's copy is held to this list by a test. */
export const RESOURCE_KEYS = Object.freeze([
	"memPeak", // bytes, memory.peak (v1: memory.max_usage_in_bytes): the most the job held at once
	"oomKills", // memory.events `oom_kill` (v1: memory.oom_control): processes the kernel killed for memory
	"memSomeUsec", // memory.pressure `some total`: microseconds some task waited on memory
	"memFullUsec", // memory.pressure `full total`: microseconds every task waited on memory
	"cpuUsec", // cpu.stat `usage_usec` (v1: cpuacct.usage / 1000): CPU time used
	"throttledUsec", // cpu.stat `throttled_usec` (v1: throttled_time / 1000): time held back by the CPU limit
	"throttled", // cpu.stat `nr_throttled`: periods in which the CPU limit held it back
	"pidsPeak", // pids.peak: the most processes at once
]);

export const CGROUP_ROOT = "/sys/fs/cgroup";
const SELF_CGROUP = "/proc/self/cgroup";

/** A decimal count that is a safe non-negative integer, or null. Never a float, a sign or an exponent. */
function count(text) {
	if (typeof text !== "string" || !/^\d{1,16}$/.test(text)) return null;
	const n = Number(text);
	return Number.isSafeInteger(n) ? n : null;
}

/** `key value` lines (memory.events, cpu.stat, memory.oom_control) as a Map of the raw value strings. */
function flatKeyed(text) {
	const out = new Map();
	if (typeof text !== "string") return out;
	for (const line of text.split("\n")) {
		const [key, value, extra] = line.trim().split(/\s+/);
		if (key && value !== undefined && extra === undefined) out.set(key, value);
	}
	return out;
}

/** memory.pressure's `total=` for the `some` or `full` line, or null. */
function pressureTotal(text, which) {
	if (typeof text !== "string") return null;
	for (const line of text.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[0] !== which) continue;
		const total = fields.find((f) => f.startsWith("total="));
		return total === undefined ? null : count(total.slice("total=".length));
	}
	return null;
}

/** Nanoseconds to whole microseconds, or null. */
function usecOfNsec(text) {
	const ns = count(text);
	return ns === null ? null : Math.floor(ns / 1000);
}

/**
 * The directory of this process's own v2 cgroup, or null when there is none to read. `0::/` (a private cgroup
 * namespace, every venue measured) is the mount's root; any other path is that path under the mount, and a path that
 * tries to leave it is refused.
 */
function v2Dir(read) {
	const self = read(SELF_CGROUP);
	if (self === null) return CGROUP_ROOT;
	const line = self.split("\n").find((l) => l.startsWith("0::"));
	if (line === undefined) return null;
	const path = line.slice(3).trim();
	if (path === "/" || path === "") return CGROUP_ROOT;
	if (!path.startsWith("/") || path.split("/").includes("..")) return null;
	return `${CGROUP_ROOT}${path}`;
}

/** This process's v1 cgroup path for one controller (`memory`, `cpuacct`, `cpu`), under that controller's mount. */
function v1Path(read, controller) {
	const self = read(SELF_CGROUP);
	if (self === null) return `${CGROUP_ROOT}/${controller}`;
	for (const line of self.split("\n")) {
		const [, controllers, path] = line.split(":");
		if (controllers === undefined || path === undefined) continue;
		if (!controllers.split(",").includes(controller)) continue;
		const p = path.trim();
		if (!p.startsWith("/") || p.split("/").includes("..")) return null;
		// Docker on v1 mounts the container's own cgroup at the controller's root, while /proc/self/cgroup still names
		// the host path: prefer the path when it exists under the mount, else the mount's root.
		return p === "/" ? `${CGROUP_ROOT}/${controller}` : `${CGROUP_ROOT}/${controller}${p}`;
	}
	return `${CGROUP_ROOT}/${controller}`;
}

function readV2(dir, read) {
	const events = flatKeyed(read(`${dir}/memory.events`));
	const pressure = read(`${dir}/memory.pressure`);
	const cpu = flatKeyed(read(`${dir}/cpu.stat`));
	return {
		memPeak: count(read(`${dir}/memory.peak`)?.trim()),
		oomKills: count(events.get("oom_kill")),
		memSomeUsec: pressureTotal(pressure, "some"),
		memFullUsec: pressureTotal(pressure, "full"),
		cpuUsec: count(cpu.get("usage_usec")),
		throttledUsec: count(cpu.get("throttled_usec")),
		throttled: count(cpu.get("nr_throttled")),
		pidsPeak: count(read(`${dir}/pids.peak`)?.trim()),
	};
}

function readV1(read, exists) {
	const at = (controller, file) => {
		const own = v1Path(read, controller);
		if (own === null) return null;
		const root = `${CGROUP_ROOT}/${controller}`;
		return read(exists(`${own}/${file}`) ? `${own}/${file}` : `${root}/${file}`);
	};
	const cpu = flatKeyed(at("cpu", "cpu.stat"));
	return {
		memPeak: count(at("memory", "memory.max_usage_in_bytes")?.trim()),
		oomKills: count(flatKeyed(at("memory", "memory.oom_control")).get("oom_kill")),
		memSomeUsec: null,
		memFullUsec: null,
		cpuUsec: usecOfNsec(at("cpuacct", "cpuacct.usage")?.trim()),
		throttledUsec: usecOfNsec(cpu.get("throttled_time")),
		throttled: count(cpu.get("nr_throttled")),
		pidsPeak: null,
	};
}

/**
 * Read this job's resource use: an object of RESOURCE_KEYS, each a safe non-negative integer or null, or null when not
 * one key could be read (no cgroup filesystem at all: an image run by hand outside a container, or a venue that hides
 * it). `fs` is a seam for tests: `readFileSync` and `existsSync` are all it uses. Never throws.
 */
export function readCgroupUsage({ fs = nodeFs } = {}) {
	try {
		const read = (path) => {
			try {
				return String(fs.readFileSync(path, "utf8"));
			} catch {
				return null;
			}
		};
		const exists = (path) => {
			try {
				return fs.existsSync(path) === true;
			} catch {
				return false;
			}
		};
		let usage;
		if (exists(`${CGROUP_ROOT}/cgroup.controllers`)) {
			const dir = v2Dir(read);
			if (dir === null) return null;
			usage = readV2(dir, read);
		} else if (exists(`${CGROUP_ROOT}/memory`)) {
			usage = readV1(read, exists);
		} else {
			return null;
		}
		const out = {};
		for (const key of RESOURCE_KEYS) out[key] = Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null;
		return RESOURCE_KEYS.some((key) => out[key] !== null) ? out : null;
	} catch {
		return null;
	}
}
