/**
 * The aggregate CPU reserve (issue #596, phase 2, DES-HOST-BUDGET): ONE parent cgroup for every job container, with the
 * host's CPU budget as its quota, so all jobs TOGETHER leave the host's reserve free.
 *
 * WHY A PARENT AND NOT A FLAG PER JOB. `--cpus` is a quota per container and the quotas do not sum: two busy jobs on a
 * 4-core host with `--cpus=3` used 4.06 cores (measured). The ledger in `host-budget.mjs` bounds the jobs' SIZES
 * together, not what they USE. A parent cgroup with a quota bounds the use: with `pidispatch.slice` at the budget
 * (NCPU-1), three busy jobs held 3.00-3.06 of 4 cores and 12.95-13.02 of 14 on all five venues of the lab, and a
 * busy neighbour outside kept its core (round-size/pr3/lab/FACTS.md, Q2).
 *
 * THE PARENT ALONE ALREADY HELPS, which is why it is ALWAYS on a job's argv, quota or not. Inside a parent, a job's
 * weight competes only with its sibling jobs; the parent competes with the egress proxy, Valkey and the host's services
 * as ONE group of the default weight 100. Without it a job of weight 10000 (`--cpu-shares=262144`) left a single-threaded
 * proxy-like container 0.01 of a core; inside a weight-100 parent with no quota at all the proxy kept 0.98-1.00 (Q3, Q4).
 * The runtime creates a missing parent silently with no quota (every venue, exit 0, measured), so the flag never fails
 * a run; nothing can be learned from a run either, which is why the quota is READ back here rather than assumed.
 *
 * ONE NAME, NO DASH. `--cgroup-parent=pidispatch.slice` is accepted by every driver measured (under systemd it is a
 * slice, under Docker Desktop's cgroupfs driver the directory `/sys/fs/cgroup/pidispatch.slice`). A dash nests:
 * `pd-jobs.slice` lands in `/pd.slice/pd-jobs.slice/`, where a quota put on the name the operator typed would be on
 * another cgroup than the one the jobs share.
 *
 * WHO CAN SET THE QUOTA, per venue (Q1), and therefore what this module does:
 *   - rootless Podman (`user-systemd`): the worker's own account, through its systemd user manager, which delegates
 *     `cpu`: `systemctl --user set-property pidispatch.slice CPUQuota=<budget*100>%`. Persistent (a drop-in under
 *     `~/.config/systemd/user.control`), so a reboot keeps it; re-applied whenever the budget changes and read back.
 *   - Docker with the cgroupfs driver, Docker Desktop's (`helper`): kernel state in the runtime's VM, writable from a
 *     one-shot container that runs as uid 0 with every capability dropped and only the parent's own directory mounted.
 *     NOT persistent: a Docker Desktop restart drops it, so it is re-read on the facts' own cadence and re-applied.
 *   - Docker with the systemd driver and rootful Podman (`system-systemd`): root only (`Interactive authentication
 *     required.` for anyone else), so the worker only READS `systemctl show -P CPUQuotaPerSecUSec pidispatch.slice`
 *     and doctor prints the one operator command. A direct `cpu.max` write (root, or the docker group through a bind
 *     mount) works until the next `systemctl daemon-reload`, which every package upgrade runs, resets it: rejected.
 *
 * FAILS OPEN, AND SAYS WHICH. Every runtime command is bounded (`RESERVE_STEP_TIMEOUT_MS`) and runs off every job path
 * (on the budget's refresh), so a hung `systemctl` or a slow daemon never holds a pickup. A quota that could not be set
 * or read leaves the parent without one: the jobs still share the parent (and so still cannot starve the proxy), the
 * reserve across them is not held, the worker logs `cpu_reserve_fail_open` with a named reason and doctor warns.
 *
 * ONE FIXED NAME PER ROLE, SO THE DAEMON BOUNDS WHAT A SLOW START LEAVES (issue #978). The helper is a `docker run
 * --rm`, and `--rm` is the daemon's AutoRemove, which fires only when the container exits: a CLI killed at its bound
 * between create and start (a slow VM-backed daemon) left a `created` container behind for good, one per timed-out
 * step, 168 of them on one host. Every helper now runs under one name (`helperName`: the worker's
 * `pi-dispatch-cpu-reserve-<hex8>`, doctor's `pi-dispatch-cpu-reserve-doctor-<hex8>`) with the label
 * `pi.dispatch.helper=cpu-reserve`. A step that did not end cleanly marks the name dirty, a timeout removes it at once
 * (`rm -f`, bounded), and while it is dirty `rm -f` runs before the next helper (`guardHelperRun`). A create that lands
 * after that rm holds the name, and the next helper's create then fails at once (exit 125, no container) until an rm
 * gets through: at most one leftover per name, across restarts, on a remote daemon, whatever either clock says.
 * Rejected: random names plus a sweep of old labelled helpers (an age needs a clock shared with the daemon, and the
 * helper also runs on a remote cgroupfs daemon); `--cidfile` (blind to the same late create, plus a temp file);
 * `docker create` then `start -a` (twice the calls, on the daemon that is already slow). A timed-out step also
 * ends its attempt, and the next one waits longer (`makeCpuReserve`). The unnamed helpers an older worker left are
 * removed by exact fingerprint (`removeLegacyHelpers`), until one pass over them finishes.
 *
 * NO AGGREGATE `memory.max`. Measured: a parent memory limit makes the KERNEL choose the victim by size, and it killed
 * the innocent 300 MiB job while the one that grew lived (Q6). Admission by the ledger stays the memory bound; an
 * aggregate memory limit is an operator-only backstop, documented, never set here.
 */

import { createHash } from "node:crypto";
import { parseCpuMax } from "./host-budget.mjs";
import { CGROUP_PARENT } from "./job-size.mjs";

// The parent's name and the parentless shares cap live in `job-size.mjs`, the leaf `container-spec.mjs` may import (its
// leaf property is what `packages.mjs` rests on); re-exported here, where they are explained.
export { CGROUP_PARENT, PARENTLESS_SHARES_MAX } from "./job-size.mjs";

/** Each runtime command's bound: a `systemctl` call or a one-shot container's whole life. */
export const RESERVE_STEP_TIMEOUT_MS = 15_000;

/**
 * How often a quota already read back as held is read again: the cadence the runtime's own facts are re-read at
 * (`JOB_USER_FACTS_MAX_AGE_MS`, ten minutes), so a Docker Desktop restart that dropped the helper's write is found on
 * the same clock that finds its new CPU count. Restated here rather than imported, to keep this module a leaf; a test
 * holds the two equal.
 */
export const RESERVE_RECHECK_MS = 10 * 60_000;

/** How soon a quota NOT held (unset, unreadable, a failed write) is tried again. */
export const RESERVE_RETRY_MS = 60_000;

/** The CFS period every quota here is written in, in microseconds (the kernel's and systemd's default). */
export const QUOTA_PERIOD_US = 100_000;

/** systemd's property for a CPU budget in hundredths: one CPU is `100%`, so the hundredths ARE the percentage. */
export function cpuQuotaProperty(cpuCenti) {
	return `CPUQuota=${cpuCenti}%`;
}

/** The `cpu.max` line for a CPU budget in hundredths: `<quota> 100000`, integers only (1 CPU = 100000 us per period). */
export function cpuMaxLine(cpuCenti) {
	return `${cpuCenti * (QUOTA_PERIOD_US / 100)} ${QUOTA_PERIOD_US}`;
}

/** The command an operator runs, once, as root, on a venue whose quota only root can set. */
export function operatorQuotaCommand(cpuCenti) {
	return cpuCenti === null ? `sudo systemctl set-property ${CGROUP_PARENT} CPUQuota=` : `sudo systemctl set-property ${CGROUP_PARENT} ${cpuQuotaProperty(cpuCenti)}`;
}

/** The rootless venue's own command (no root), as the worker runs it: `null` clears the quota. */
export function userQuotaCommand(cpuCenti) {
	return `systemctl --user set-property ${CGROUP_PARENT} ${cpuCenti === null ? "CPUQuota=" : cpuQuotaProperty(cpuCenti)}`;
}

/** `systemctl` argv (no leading binary) that sets, or with `null` clears, the user manager's quota on the parent. */
export function userSetPropertyArgs(cpuCenti) {
	return ["--user", "set-property", CGROUP_PARENT, cpuCenti === null ? "CPUQuota=" : cpuQuotaProperty(cpuCenti)];
}

/** `systemctl` argv that reads the parent's quota, from the user manager (`user: true`) or the system one. */
export function showQuotaArgs({ user }) {
	return [...(user ? ["--user"] : []), "show", "-P", "CPUQuotaPerSecUSec", CGROUP_PARENT];
}

/** The host path of the parent under the cgroupfs driver. The ONLY `/sys/fs/cgroup` path the helper ever mounts. */
export const HELPER_PARENT_PATH = `/sys/fs/cgroup/${CGROUP_PARENT}`;

/** The label key a short-lived helper container carries, as `pi.dispatch.helper=<role>`, so it is told from a job's. */
export const HELPER_LABEL_KEY = "pi.dispatch.helper";

/** Docker's own rule for a container name, which every helper name is held to before it reaches an argv. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

/**
 * The helper's one fixed name (PURE): `pi-dispatch-cpu-reserve-<hex8>` for the worker and
 * `pi-dispatch-cpu-reserve-doctor-<hex8>` for doctor, hex8 the first eight hex digits of the sha256 of the declared
 * worker name (empty when none). Stable across restarts, so a process removes what the last one left; distinct per
 * named worker, so two workers on one daemon never share it; doctor's own, so a doctor never removes the worker's
 * helper mid-step. Hashed because a worker name may run to 64 characters and here it is only an identity.
 */
export function helperName(workerName = "", { doctor = false } = {}) {
	const hex8 = createHash("sha256").update(String(workerName ?? "")).digest("hex").slice(0, 8);
	return `pi-dispatch-cpu-reserve-${doctor ? "doctor-" : ""}${hex8}`;
}

/**
 * The one-shot helper's `docker run` argv (no leading binary): with `cpuCenti` it WRITES the quota (`null` writes `max`,
 * no quota), without (`read: true`) it only reads `cpu.max` through a read-only mount.
 *
 * Every flag is a reason. `--name` and the label: one fixed name per role (the header), the label so a helper is never
 * read as a job's container. uid 0 because writing a knob of an existing cgroup needs it even with every capability
 * dropped (uid 1000 got `Permission denied`, measured); `--cap-drop=ALL` because creating a cgroup needs
 * CAP_DAC_OVERRIDE and this must not be able to; `--network=none`, `--read-only`, `no-new-privileges`; `--pull=never`
 * and an image the worker already pins (the job image), never a tag fetched for this (CONST-PI-VERSION-PINNED);
 * `--cgroup-parent` so the helper itself is a job-parented container and the parent exists before the mount resolves.
 * The mount is the parent's own directory and nothing else: a bind source docker does not find it CREATES, and under
 * `/sys/fs/cgroup` that mkdir makes a cgroup, so any other path (a typo) would leave a stray one. The value is built
 * from an integer, so nothing an operator or a job wrote reaches the shell.
 */
export function helperArgs({ image, name, cpuCenti = undefined, read = false }) {
	if (typeof image !== "string" || image === "" || image.startsWith("-")) throw new Error(`cpu reserve: refusing a helper image ${JSON.stringify(image)}`);
	if (typeof name !== "string" || !CONTAINER_NAME_RE.test(name)) throw new Error(`cpu reserve: refusing a helper name ${JSON.stringify(name)}`);
	const write = !read;
	if (write && cpuCenti !== null && !(Number.isSafeInteger(cpuCenti) && cpuCenti > 0)) throw new Error(`cpu reserve: refusing a quota that is not a positive integer of hundredths: ${JSON.stringify(cpuCenti)}`);
	const line = write ? (cpuCenti === null ? `max ${QUOTA_PERIOD_US}` : cpuMaxLine(cpuCenti)) : null;
	return [
		"run",
		"--rm",
		"--name",
		name,
		"--label",
		`${HELPER_LABEL_KEY}=cpu-reserve`,
		"--pull=never",
		"--user=0:0",
		"--cap-drop=ALL",
		"--security-opt",
		"no-new-privileges",
		"--network=none",
		"--read-only",
		`--cgroup-parent=${CGROUP_PARENT}`,
		"-v",
		`${HELPER_PARENT_PATH}:/p${write ? "" : ":ro"}`,
		"--entrypoint",
		write ? "sh" : "cat",
		image,
		...(write ? ["-c", `echo "${line}" > /p/cpu.max`] : ["/p/cpu.max"]),
	];
}

/**
 * A systemd timespan as `systemctl show` prints `CPUQuotaPerSecUSec`, in hundredths of a CPU: `{ cpuCenti }`, with
 * `cpuCenti: null` for `infinity` (no quota), or null when the text is not a timespan. `3s` is 300% (measured), and
 * systemd prints a fraction either as `1.500000s` or `1s 500ms` depending on its version, so every unit and both forms
 * are read. A quota below a hundredth of a CPU rounds down to nothing and is no fact.
 */
export function parseQuotaPerSec(text) {
	const value = String(text ?? "").trim();
	if (value === "infinity") return { cpuCenti: null };
	if (!/^(?:\d{1,12}(?:\.\d{1,9})?(?:us|µs|μs|ms|s|min|h)\s*)+$/.test(value)) return null;
	const unit = { us: 1, µs: 1, μs: 1, ms: 1_000, s: 1_000_000, min: 60_000_000, h: 3_600_000_000 };
	let usec = 0;
	for (const m of value.matchAll(/(\d{1,12}(?:\.\d{1,9})?)(us|µs|μs|ms|s|min|h)/g)) usec += Number(m[1]) * unit[m[2]];
	const centi = Math.floor(Math.round(usec) / 10_000);
	return Number.isSafeInteger(centi) && centi > 0 ? { cpuCenti: centi } : null;
}

/** A `cpu.max` read as `{ cpuCenti }` (`null` for `max <period>`, no quota), or null when it is not a `cpu.max` line. */
export function parseCpuMaxRead(text) {
	const value = String(text ?? "").trim();
	if (/^max [0-9]{1,15}$/.test(value)) return { cpuCenti: null };
	const centi = parseCpuMax(value);
	return centi === null ? null : { cpuCenti: centi };
}

/**
 * Whether a container on this runtime is started under the parent (`CGROUP_PARENT`) or without one (`null`), from the
 * runtime's own facts. Without only where Podman says it uses a cgroup manager other than `systemd`: there libpod puts a
 * rootless container with a named parent at `/<parent>/libpod-<id>` from the hierarchy's ROOT (source, not measured), a
 * directory a rootless account cannot create, so a job would fail to start. Every other answer keeps the parent,
 * including no answer (a podman venue whose `info` did not answer runs no job anyway). Docker's drivers both take it.
 */
export function cgroupParentFor(runtime) {
	if (runtime?.podman === true && typeof runtime.cgroupManager === "string" && runtime.cgroupManager !== "systemd") return null;
	return CGROUP_PARENT;
}

/**
 * HOW the quota is kept on one venue (PURE), from that venue's facts: `{ venue, parent, method, why }`.
 *   `parent`  false when jobs run without the parent (`cgroupParentFor`): their shares are then capped instead
 *   `method`  `user-systemd` | `helper` | `system-systemd` | null (the quota is not kept here; `why` says which)
 *   `why`     a fixed token: `podman-cgroupfs`, `cgroup-v1`, `remote-daemon`, `rootless-docker`, `driver-unknown`,
 *             `podman-rootful-remote`, `venue-unmanaged` or null
 * `facts` is the venue's parsed info: for `local` the `docker info` facts (`parseDaemonFacts`, with `cgroupDriver` and
 * `cgroupVersion`), for `podman` the `podman info` read (`parsePodmanInfo`). `endpointLocal` is the docker endpoint's
 * observed locality, and `platform` this process's: a systemd read on THIS host says nothing about a remote daemon's.
 */
export function reservePlan({ venue, facts, endpointLocal = false, platform = process.platform }) {
	const plan = (parent, method, why) => ({ venue, parent, method, why });
	// Issue #681: only the two venues whose facts this reads are planned. Another venue used to fall through to docker's
	// rules and could be handed docker's helper; it keeps no quota here, said with a token rather than guessed.
	if (venue !== "local" && venue !== "podman") return plan(false, null, "venue-unmanaged");
	if (venue === "podman") {
		if (cgroupParentFor({ podman: true, cgroupManager: facts?.cgroupManager }) === null) return plan(false, null, "podman-cgroupfs");
		if (facts?.cgroupVersion && facts.cgroupVersion !== "v2") return plan(true, null, "cgroup-v1");
		if (facts?.rootless === true) return plan(true, "user-systemd", null);
		return plan(true, null, "podman-rootful-remote");
	}
	if (facts?.cgroupVersion && facts.cgroupVersion !== "v2") return plan(true, null, "cgroup-v1");
	if (facts?.rootless === true) return plan(true, null, "rootless-docker");
	if (facts?.cgroupDriver === "cgroupfs") return plan(true, "helper", null);
	if (facts?.cgroupDriver === "systemd") return endpointLocal === true && platform === "linux" ? plan(true, "system-systemd", null) : plan(true, null, "remote-daemon");
	return plan(true, null, "driver-unknown");
}

/** A runtime command's failure as a fixed token, never its stderr (which can carry paths and endpoints). */
export function stepFailure(result, bin) {
	// Two runner shapes: an `error` (the worker's `execDockerBounded`, and `dockerRunVia`, the runner doctor passes), and
	// `liveRunVia`'s `ended` (`timeout` or `error`, the podman conformance check's). `cleanupTimedOut` is the guard's own
	// (`guardHelperRun`).
	if (result?.error?.cleanupTimedOut) return "cleanup-timeout";
	if (result?.error?.timedOut || result?.error?.killed || result?.ended === "timeout") return "timeout";
	if (result?.ended === "error") return "spawn-failed";
	if (result?.error?.code === "ENOENT") return `${bin}-not-found`;
	if (typeof result?.error?.code === "string") return `spawn-${result.error.code.toLowerCase()}`;
	if (Number.isSafeInteger(result?.code) && result.code !== 0) return `exit-${result.code}`;
	if (result?.error) return "spawn-failed";
	return null;
}

/**
 * Read the parent's quota on a venue: `{ ok: true, cpuCenti }` (`null` is no quota) or `{ ok: false, reason }`.
 * `run(bin, args, { timeoutMs })` resolves `{ code, stdout, error }` and never rejects (`execDockerBounded`'s shape).
 * `name` is the helper's (`helperName`); a helper's `run` is `guardHelperRun`'s, which keeps that name free.
 */
export async function readQuota(plan, { run, image, name, bin = plan.venue === "podman" ? "podman" : "docker", timeoutMs = RESERVE_STEP_TIMEOUT_MS }) {
	let result;
	let parse;
	let used;
	if (plan.method === "user-systemd" || plan.method === "system-systemd") {
		used = "systemctl";
		result = await run("systemctl", showQuotaArgs({ user: plan.method === "user-systemd" }), { timeoutMs }).catch((error) => ({ code: null, stdout: "", error }));
		parse = parseQuotaPerSec;
	} else if (plan.method === "helper") {
		used = bin;
		result = await run(bin, helperArgs({ image, name, read: true }), { timeoutMs }).catch((error) => ({ code: null, stdout: "", error }));
		parse = parseCpuMaxRead;
	} else {
		return { ok: false, reason: plan.why ?? "unmanaged" };
	}
	const failed = stepFailure(result, used);
	if (failed) return { ok: false, reason: failed };
	const read = parse(result?.stdout);
	return read === null ? { ok: false, reason: "unparseable" } : { ok: true, cpuCenti: read.cpuCenti };
}

/** Set (or with `null` clear) the parent's quota where this worker may: `{ ok: true }` or `{ ok: false, reason }`. */
export async function writeQuota(plan, cpuCenti, { run, image, name, bin = plan.venue === "podman" ? "podman" : "docker", timeoutMs = RESERVE_STEP_TIMEOUT_MS }) {
	let result;
	let used;
	if (plan.method === "user-systemd") {
		used = "systemctl";
		result = await run("systemctl", userSetPropertyArgs(cpuCenti), { timeoutMs }).catch((error) => ({ code: null, stdout: "", error }));
	} else if (plan.method === "helper") {
		used = bin;
		result = await run(bin, helperArgs({ image, name, cpuCenti }), { timeoutMs }).catch((error) => ({ code: null, stdout: "", error }));
	} else {
		return { ok: false, reason: plan.method === "system-systemd" ? "needs-root" : (plan.why ?? "unmanaged") };
	}
	const failed = stepFailure(result, used);
	return failed ? { ok: false, reason: failed } : { ok: true };
}

/**
 * `run` for one role's helper, keeping its one name free (the header): while `state.dirty` (true at first, so a process
 * removes what the last one left) `rm -f <name>` runs before the helper; any step that did not end cleanly (code null
 * or non-zero) makes it dirty again, and a timeout also removes the name at once. An rm that times out runs no helper
 * and answers `{ code: null, error: { cleanupTimedOut: true } }` (`cleanup-timeout`): the daemon is too slow to clear
 * the name, and another create would only queue behind it. Any other rm failure runs the helper anyway, because a name
 * still taken fails the create at once with exit 125 and makes no container. Every rm is bounded like a step.
 */
export function guardHelperRun({ run, name, state = { dirty: true }, timeoutMs = RESERVE_STEP_TIMEOUT_MS }) {
	const settle = (bin, args, opts) =>
		Promise.resolve()
			.then(() => run(bin, args, opts))
			.catch((error) => ({ code: null, stdout: "", error }));
	return async (bin, args, opts) => {
		if (state.dirty) {
			if (stepFailure(await settle(bin, ["rm", "-f", name], { timeoutMs }), bin) === "timeout") return { code: null, stdout: "", error: { cleanupTimedOut: true } };
			state.dirty = false;
		}
		const result = await settle(bin, args, opts);
		if (result?.code !== 0) state.dirty = true;
		if (stepFailure(result, bin) === "timeout") await settle(bin, ["rm", "-f", name], { timeoutMs });
		return result;
	};
}

/** How old an unnamed helper must be, by this process's clock, before `removeLegacyHelpers` takes it. */
export const LEGACY_HELPER_MIN_AGE_MS = 10 * 60_000;

/** How many leftovers one `inspect` and one `rm` name at most, so each call stays short and its argv small. */
export const LEGACY_HELPER_CHUNK = 20;

/** The output bound for the listing and each `inspect`: a busy host lists many containers, and each has its labels. */
const LEGACY_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The prefilter: every `created` container, by full id, with its `pi.dispatch.helper` label (empty when it has none)
 * and its command. `{{.Labels}}` would not do: a container inherits its image's labels, and the job image has several.
 */
export const LEGACY_LIST_ARGS = Object.freeze(["ps", "-a", "--filter", "status=created", "--no-trunc", "--format", `{{.ID}}\t{{.Label "${HELPER_LABEL_KEY}"}}\t{{.Command}}`]);

/**
 * One JSON object per container, holding only what the fingerprint reads. Every value goes through `index`, never a
 * dotted path: the CLI evaluates a template that names a field its typed struct lacks (`.Id`) against the raw JSON with
 * missing keys as errors, and the daemon omits a key it has nothing for (`HostConfig.Mounts` without a `--mount`), so
 * `{{json .HostConfig.Mounts}}` refused every container (Docker 28.0.4, measured: exit 1, no output). `index` answers
 * an absent key with null. `mounts` is the top-level list, always there; `hostMounts` the `--mount` list, absent here.
 */
export const LEGACY_INSPECT_FORMAT = '{"id":{{json (index . "Id")}},"image":{{json (index . "Image")}},"created":{{json (index . "Created")}},"state":{{json (index . "State" "Status")}},"entrypoint":{{json (index . "Config" "Entrypoint")}},"cmd":{{json (index . "Config" "Cmd")}},"user":{{json (index . "Config" "User")}},"labels":{{json (index . "Config" "Labels")}},"parent":{{json (index . "HostConfig" "CgroupParent")}},"binds":{{json (index . "HostConfig" "Binds")}},"hostMounts":{{json (index . "HostConfig" "Mounts")}},"autoRemove":{{json (index . "HostConfig" "AutoRemove")}},"network":{{json (index . "HostConfig" "NetworkMode")}},"readOnly":{{json (index . "HostConfig" "ReadonlyRootfs")}},"mounts":{{json (index . "Mounts")}}}';

/** An image's own labels, null when it has none (an image config may omit the key), the same way. */
export const LEGACY_IMAGE_LABELS_FORMAT = '{{json (index . "Config" "Labels")}}';

const LEGACY_WRITE_RE = /^echo "(?:max|\d+) 100000" > \/p\/cpu\.max$/;
// The read mounted the parent read-only and the write read-write, and nothing else: each role's one bind, exactly.
const LEGACY_BINDS = Object.freeze({ read: `${HELPER_PARENT_PATH}:/p:ro`, write: `${HELPER_PARENT_PATH}:/p` });

/**
 * Whether one inspected container (a `LEGACY_INSPECT_FORMAT` row) is a helper an older worker left (PURE): EXACTLY what
 * `helperArgs` made before it had a name. `cat` of `/p/cpu.max` with the parent bound read-only, or `sh -c` echoing a
 * quota line into it with the parent bound read-write; that one bind and no other mount (the top-level list holds it
 * alone, as a bind of the parent at `/p` with the role's RW); under the parent; uid 0, auto-removed, no network, a
 * read-only root; never started; no label beyond what its image gave it (`imageLabels`, the image's own, `undefined`
 * when unread, which matches nothing); and at least `LEGACY_HELPER_MIN_AGE_MS` old by `nowMs`, so a helper an older
 * worker on the same daemon is starting now is left.
 */
export function isLegacyHelper(c, { imageLabels, nowMs }) {
	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	const reads = same(c?.entrypoint, ["cat"]) && same(c?.cmd, ["/p/cpu.max"]);
	const writes = same(c?.entrypoint, ["sh"]) && Array.isArray(c?.cmd) && c.cmd.length === 2 && c.cmd[0] === "-c" && LEGACY_WRITE_RE.test(String(c.cmd[1]));
	const mount = Array.isArray(c?.mounts) && c.mounts.length === 1 ? c.mounts[0] : null;
	const noMountFlag = c?.hostMounts === null || c?.hostMounts === undefined || (Array.isArray(c.hostMounts) && c.hostMounts.length === 0);
	const bind = same(c?.binds, [writes ? LEGACY_BINDS.write : LEGACY_BINDS.read]) && noMountFlag && mount?.Type === "bind" && mount.Source === HELPER_PARENT_PATH && mount.Destination === "/p" && mount.RW === writes;
	const labels = (a, b) => {
		const x = a ?? {};
		const y = b ?? {};
		if (typeof x !== "object" || typeof y !== "object") return false;
		const keys = Object.keys(x).sort();
		return same(keys, Object.keys(y).sort()) && keys.every((k) => x[k] === y[k]);
	};
	const created = Date.parse(c?.created);
	return c?.state === "created" && (reads || writes) && c.parent === CGROUP_PARENT && bind && c.user === "0:0" && c.autoRemove === true && c.network === "none" && c.readOnly === true && imageLabels !== undefined && labels(c.labels, imageLabels) && Number.isFinite(created) && nowMs - created >= LEGACY_HELPER_MIN_AGE_MS;
}

/**
 * One pass over the unnamed helpers a worker before issue #978 left in `created` (a CLI killed between create and
 * start; the header), run after a read that held (a daemon that answers). The listing keeps the unlabelled `created`
 * containers whose command names `/p/cpu.max`; each chunk of `LEGACY_HELPER_CHUNK` is inspected, every image met is
 * inspected once for its own labels, and only an exact fingerprint (`isLegacyHelper`) is removed, with a plain `rm`:
 * never `-f`, so one that started meanwhile is refused. Every call is bounded. `--filter volume=` is not used to narrow
 * the listing: how it matches a bind mount was never measured.
 * Answers `{ complete, reason, removed, failed }`. A pass is cut short, `complete: false` with `reason`
 * `<list|inspect|image|rm>-<failure>`, by a listing that failed, any step that timed out, or an inspect that answered
 * without one row of its chunk (`inspect-no-rows` when it exited 0): it established nothing about what is left, so the
 * caller tries again. `failed` counts fingerprints the `rm` left. `run` is `execDockerBounded`'s shape, and is passed
 * `maxBuffer` for the two long outputs.
 */
export async function removeLegacyHelpers({ run, bin = "docker", now = () => Date.now(), timeoutMs = RESERVE_STEP_TIMEOUT_MS }) {
	const call = (args, extra = {}) =>
		Promise.resolve()
			.then(() => run(bin, args, { timeoutMs, ...extra }))
			.catch((error) => ({ code: null, stdout: "", error }));
	let removed = 0;
	let failed = 0;
	const cut = (step, result) => ({ complete: false, reason: `${step}-${stepFailure(result, bin) ?? "no-rows"}`, removed, failed });
	const listing = await call(LEGACY_LIST_ARGS, { maxBuffer: LEGACY_OUTPUT_MAX_BYTES });
	if (stepFailure(listing, bin)) return cut("list", listing);
	const candidates = [];
	for (const line of String(listing.stdout ?? "").split("\n")) {
		const [id, label, ...command] = line.split("\t");
		// A full id only, so nothing a listing printed can reach an argv as a flag.
		if (/^[0-9a-f]{64}$/.test(id) && label === "" && command.join("\t").includes("/p/cpu.max")) candidates.push(id);
	}
	const imageLabels = new Map();
	for (let i = 0; i < candidates.length; i += LEGACY_HELPER_CHUNK) {
		const chunk = candidates.slice(i, i + LEGACY_HELPER_CHUNK);
		// Exit 1 still prints the ones found when another went away meanwhile, so the lines are read whatever the code.
		const inspected = await call(["container", "inspect", "--format", LEGACY_INSPECT_FORMAT, ...chunk], { maxBuffer: LEGACY_OUTPUT_MAX_BYTES });
		if (stepFailure(inspected, bin) === "timeout") return cut("inspect", inspected);
		const rows = [];
		for (const line of String(inspected.stdout ?? "").split("\n")) {
			try {
				const row = JSON.parse(line);
				if (chunk.includes(row?.id)) rows.push(row);
			} catch {
				// not a row
			}
		}
		// No row at all is a refusal (a template the CLI would not run, a daemon error), not a chunk with nothing in it.
		if (rows.length === 0) return cut("inspect", inspected);
		for (const image of new Set(rows.map((r) => r.image))) {
			if (imageLabels.has(image) || typeof image !== "string" || !/^sha256:[0-9a-f]{64}$/.test(image)) continue;
			const read = await call(["image", "inspect", "--format", LEGACY_IMAGE_LABELS_FORMAT, image]);
			if (stepFailure(read, bin) === "timeout") return cut("image", read);
			let labels;
			try {
				labels = read.code === 0 ? JSON.parse(String(read.stdout).trim()) : undefined;
			} catch {
				labels = undefined;
			}
			imageLabels.set(image, labels);
		}
		const nowMs = now();
		const doomed = rows.filter((r) => isLegacyHelper(r, { imageLabels: imageLabels.get(r.image), nowMs })).map((r) => r.id);
		if (doomed.length === 0) continue;
		const rm = await call(["rm", ...doomed]);
		const gone = new Set(String(rm.stdout ?? "").split("\n").map((s) => s.trim()));
		const n = rm.code === 0 ? doomed.length : doomed.filter((id) => gone.has(id)).length;
		removed += n;
		failed += doomed.length - n;
		if (stepFailure(rm, bin) === "timeout") return cut("rm", rm);
	}
	return { complete: true, reason: null, removed, failed };
}

/**
 * The reserve's state per venue, kept in step with the budget (`sync`, on every budget refresh; never on a job path).
 *
 * `sync({ cpuCenti, plans })`: `cpuCenti` is the budget in force (an integer, `Infinity` for off, null for unknown) and
 * `plans` the venues' `reservePlan`s. Per venue, the quota WANTED is the budget, or no quota when the budget is off
 * (the worker clears what it set: an old persistent drop-in would otherwise keep capping jobs at a budget the operator
 * turned off). A venue is read again when the wanted quota or its method changed, when a held quota is
 * `RESERVE_RECHECK_MS` old, and when one not held is `RESERVE_RETRY_MS` old. Where the worker may write, a quota that
 * reads back wrong is written and read back once more. One sync at a time: a sync asked for while one runs is dropped
 * (the next refresh asks again), so slow commands cannot pile up.
 *
 * A TIMED-OUT STEP ENDS THE ATTEMPT (issue #978): no write after a read that timed out, no read back after a write that
 * did. A timed-out write may still apply, so it is `unreadable` (`write-timeout`), never `differs`; the next attempt
 * starts with a read, which finds it. And the next attempt waits longer: a minute after the first timeout, doubling to
 * `RESERVE_RECHECK_MS` (60, 120, 240, 480, then 600 s), until a read holds. Only a timeout backs off: any other failure
 * keeps `RESERVE_RETRY_MS`, because the runtime answered and an operator's fix is then seen within a minute. A helper
 * venue's steps run through `guardHelperRun` under `name`, and after a read that holds this process removes what an
 * older worker left there (`removeLegacyHelpers`, logged `cpu_reserve_leftovers_removed`), until one pass finishes.
 *
 * States (`status`): `held` (the quota read back is the one wanted), `unset` / `differs` (read back, not as wanted:
 * on `system-systemd` the operator's command is the fix), `unreadable`, `unmanaged` (no method here, `why`),
 * `no-parent`, `budget-unknown`. Logged once per change: `cpu_reserve` when held, `cpu_reserve_fail_open` otherwise,
 * with `retryMs` while timeouts back it off.
 */
/**
 * What a reserve that is not held MEANS for the jobs, one sentence per case. `differs` is two different truths, and the
 * generic "no quota held" line was the opposite of one of them (the executing review of the aggregate reserve): a quota
 * IS held there, the wrong one. With the budget off (`wantCenti` null) and the operator's quota still set, jobs together
 * are capped to a budget the operator turned off, which is what doctor says too.
 */
export function failOpenSaid(state) {
	if (state.status === "no-parent") return "jobs run without the parent, their CPU weight capped at 1024: a fair share for the proxy and Valkey, not a reserve";
	if (state.status === "differs" && Number.isSafeInteger(state.quotaCenti)) {
		const held = `${state.quotaCenti / 100} CPUs`;
		if (state.wantCenti === null) return `the CPU budget is off, but the parent still holds a quota of ${held}, so jobs together are still capped to it until it is cleared`;
		return `jobs run under the parent held to a quota of ${held}, not the CPU budget of ${state.wantCenti / 100}: jobs together are capped there, and the reserve kept is not the one configured`;
	}
	return "jobs run under the parent with no quota held across them: the proxy and Valkey are not starved, the host's CPU reserve is not kept";
}

export function makeCpuReserve({ run, image, name, now = () => Date.now(), log = () => {} }) {
	const states = new Map();
	const said = new Map();
	// Per helper venue: its guarded runner (the name starts dirty), and the older leftovers: whether a pass over them
	// finished, how many this process removed, and whether a pass cut short was said.
	const helperRuns = new Map();
	const leftoversDone = new Set();
	const leftoversRemoved = new Map();
	const leftoversCutSaid = new Set();
	let running = false;

	const record = (venue, state) => {
		states.set(venue, state);
		const key = `${state.status}|${state.method}|${state.wantCenti}|${state.quotaCenti}|${state.reason}|${state.retryMs}`;
		if (said.get(venue) === key) return;
		said.set(venue, key);
		const fields = { venue, method: state.method, status: state.status, wantCenti: state.wantCenti ?? "none", quotaCenti: state.quotaCenti === undefined ? "unread" : (state.quotaCenti ?? "none"), reason: state.reason ?? "", ...(state.retryMs === undefined ? {} : { retryMs: state.retryMs }) };
		if (state.status === "held") log("cpu_reserve", fields);
		else log("cpu_reserve_fail_open", { ...fields, failOpen: failOpenSaid(state) });
	};

	const helperRun = (venue) => {
		if (!helperRuns.has(venue)) helperRuns.set(venue, guardHelperRun({ run, name }));
		return helperRuns.get(venue);
	};

	// Until one pass finishes, then never again in this process. A pass cut short is said once, and the next read that
	// holds starts another; `removed` is this process's total, `failed` what the last pass left.
	const leftovers = async (plan) => {
		const { venue } = plan;
		if (plan.method !== "helper" || leftoversDone.has(venue)) return;
		const pass = await removeLegacyHelpers({ run, bin: venue === "podman" ? "podman" : "docker", now });
		const removed = (leftoversRemoved.get(venue) ?? 0) + pass.removed;
		leftoversRemoved.set(venue, removed);
		if (pass.complete) {
			leftoversDone.add(venue);
			if (removed + pass.failed > 0) log("cpu_reserve_leftovers_removed", { venue, removed, failed: pass.failed, complete: true });
		} else if (!leftoversCutSaid.has(venue)) {
			leftoversCutSaid.add(venue);
			log("cpu_reserve_leftovers_removed", { venue, removed, failed: pass.failed, complete: false, reason: pass.reason });
		}
	};

	const one = async (plan, cpuCenti) => {
		const base = { venue: plan.venue, method: plan.method, wantCenti: undefined, quotaCenti: undefined, reason: plan.why, checkedAt: now() };
		if (!plan.parent) return record(plan.venue, { ...base, status: "no-parent" });
		if (cpuCenti === null || cpuCenti === undefined) return record(plan.venue, { ...base, status: "budget-unknown", reason: "budget-unknown" });
		const want = cpuCenti === Infinity ? null : cpuCenti;
		if (!plan.method) return record(plan.venue, { ...base, wantCenti: want, status: "unmanaged" });
		const prev = states.get(plan.venue);
		const t = now();
		const fresh = prev && prev.wantCenti === want && prev.method === plan.method && t - prev.checkedAt < (prev.status === "held" ? RESERVE_RECHECK_MS : (prev.retryMs ?? RESERVE_RETRY_MS));
		if (fresh) return undefined;
		const steps = { run: plan.method === "helper" ? helperRun(plan.venue) : run, image, name };
		const timedOut = (r) => !r.ok && (r.reason === "timeout" || r.reason === "cleanup-timeout");
		const named = (step, r) => (r.reason === "cleanup-timeout" ? "cleanup-timeout" : `${step}-${r.reason}`);
		// `retryMs` is set only by a timeout, doubled from the last one's; a held read or any other failure clears it.
		const settle = (state, slow) => record(plan.venue, { ...base, wantCenti: want, ...state, retryMs: slow ? Math.min(prev?.retryMs === undefined ? RESERVE_RETRY_MS : prev.retryMs * 2, RESERVE_RECHECK_MS) : undefined, checkedAt: now() });
		const held = async (quotaCenti) => {
			settle({ quotaCenti, status: "held", reason: null }, false);
			await leftovers(plan);
		};
		const seen = await readQuota(plan, steps);
		if (seen.ok && seen.cpuCenti === want) return held(seen.cpuCenti);
		if (plan.method === "system-systemd") {
			return settle({ quotaCenti: seen.ok ? seen.cpuCenti : undefined, status: !seen.ok ? "unreadable" : seen.cpuCenti === null ? "unset" : "differs", reason: seen.ok ? "needs-root" : seen.reason }, timedOut(seen));
		}
		if (timedOut(seen)) return settle({ status: "unreadable", reason: named("read", seen) }, true);
		const wrote = await writeQuota(plan, want, steps);
		if (timedOut(wrote)) return settle({ status: "unreadable", reason: named("write", wrote) }, true);
		const back = await readQuota(plan, steps);
		// The read back is the fact: a quota that reads as wanted is held, whatever the write answered.
		if (back.ok && back.cpuCenti === want) return held(back.cpuCenti);
		const status = !back.ok ? "unreadable" : back.cpuCenti === null ? "unset" : "differs";
		const reason = back.reason === "cleanup-timeout" ? "cleanup-timeout" : !wrote.ok ? named("write", wrote) : !back.ok ? named("read", back) : "not-applied";
		return settle({ quotaCenti: back.ok ? back.cpuCenti : undefined, status, reason }, timedOut(back));
	};

	return {
		async sync({ cpuCenti, plans = [] }) {
			if (running) return false;
			running = true;
			try {
				for (const plan of plans) {
					try {
						await one(plan, cpuCenti);
					} catch (error) {
						record(plan.venue, { venue: plan.venue, method: plan.method, wantCenti: undefined, quotaCenti: undefined, status: "unreadable", reason: `threw-${String(error?.code ?? "error").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "error"}`, checkedAt: now() });
					}
				}
			} finally {
				running = false;
			}
			return true;
		},
		/** Copies of each venue's state, for the registry and tests. */
		states: () => [...states.values()].map((s) => ({ ...s })),
	};
}
