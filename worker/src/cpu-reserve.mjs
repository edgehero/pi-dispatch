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
 * NO AGGREGATE `memory.max`. Measured: a parent memory limit makes the KERNEL choose the victim by size, and it killed
 * the innocent 300 MiB job while the one that grew lived (Q6). Admission by the ledger stays the memory bound; an
 * aggregate memory limit is an operator-only backstop, documented, never set here.
 */

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

/**
 * The one-shot helper's `docker run` argv (no leading binary): with `cpuCenti` it WRITES the quota (`null` writes `max`,
 * no quota), without (`read: true`) it only reads `cpu.max` through a read-only mount.
 *
 * Every flag is a reason. uid 0 because writing a knob of an existing cgroup needs it even with every capability
 * dropped (uid 1000 got `Permission denied`, measured); `--cap-drop=ALL` because creating a cgroup needs
 * CAP_DAC_OVERRIDE and this must not be able to; `--network=none`, `--read-only`, `no-new-privileges`; `--pull=never`
 * and an image the worker already pins (the job image), never a tag fetched for this (CONST-PI-VERSION-PINNED);
 * `--cgroup-parent` so the helper itself is a job-parented container and the parent exists before the mount resolves.
 * The mount is the parent's own directory and nothing else: a bind source docker does not find it CREATES, and under
 * `/sys/fs/cgroup` that mkdir makes a cgroup, so any other path (a typo) would leave a stray one. The value is built
 * from an integer, so nothing an operator or a job wrote reaches the shell.
 */
export function helperArgs({ image, cpuCenti = undefined, read = false }) {
	if (typeof image !== "string" || image === "" || image.startsWith("-")) throw new Error(`cpu reserve: refusing a helper image ${JSON.stringify(image)}`);
	const write = !read;
	if (write && cpuCenti !== null && !(Number.isSafeInteger(cpuCenti) && cpuCenti > 0)) throw new Error(`cpu reserve: refusing a quota that is not a positive integer of hundredths: ${JSON.stringify(cpuCenti)}`);
	const line = write ? (cpuCenti === null ? `max ${QUOTA_PERIOD_US}` : cpuMaxLine(cpuCenti)) : null;
	return [
		"run",
		"--rm",
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
 *             `podman-rootful-remote` or null
 * `facts` is the venue's parsed info: for `local` the `docker info` facts (`parseDaemonFacts`, with `cgroupDriver` and
 * `cgroupVersion`), for `podman` the `podman info` read (`parsePodmanInfo`). `endpointLocal` is the docker endpoint's
 * observed locality, and `platform` this process's: a systemd read on THIS host says nothing about a remote daemon's.
 */
export function reservePlan({ venue, facts, endpointLocal = false, platform = process.platform }) {
	const plan = (parent, method, why) => ({ venue, parent, method, why });
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
	// Two runner shapes: `execDockerBounded`'s `error`, and doctor's `liveRunVia`'s `ended` (`timeout` or `error`).
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
 */
export async function readQuota(plan, { run, image, bin = plan.venue === "podman" ? "podman" : "docker", timeoutMs = RESERVE_STEP_TIMEOUT_MS }) {
	let result;
	let parse;
	let used;
	if (plan.method === "user-systemd" || plan.method === "system-systemd") {
		used = "systemctl";
		result = await run("systemctl", showQuotaArgs({ user: plan.method === "user-systemd" }), { timeoutMs }).catch((error) => ({ code: null, stdout: "", error }));
		parse = parseQuotaPerSec;
	} else if (plan.method === "helper") {
		used = bin;
		result = await run(bin, helperArgs({ image, read: true }), { timeoutMs }).catch((error) => ({ code: null, stdout: "", error }));
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
export async function writeQuota(plan, cpuCenti, { run, image, bin = plan.venue === "podman" ? "podman" : "docker", timeoutMs = RESERVE_STEP_TIMEOUT_MS }) {
	let result;
	let used;
	if (plan.method === "user-systemd") {
		used = "systemctl";
		result = await run("systemctl", userSetPropertyArgs(cpuCenti), { timeoutMs }).catch((error) => ({ code: null, stdout: "", error }));
	} else if (plan.method === "helper") {
		used = bin;
		result = await run(bin, helperArgs({ image, cpuCenti }), { timeoutMs }).catch((error) => ({ code: null, stdout: "", error }));
	} else {
		return { ok: false, reason: plan.method === "system-systemd" ? "needs-root" : (plan.why ?? "unmanaged") };
	}
	const failed = stepFailure(result, used);
	return failed ? { ok: false, reason: failed } : { ok: true };
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
 * States (`status`): `held` (the quota read back is the one wanted), `unset` / `differs` (read back, not as wanted:
 * on `system-systemd` the operator's command is the fix), `unreadable`, `unmanaged` (no method here, `why`),
 * `no-parent`, `budget-unknown`. Logged once per change: `cpu_reserve` when held, `cpu_reserve_fail_open` otherwise.
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

export function makeCpuReserve({ run, image, now = () => Date.now(), log = () => {} }) {
	const states = new Map();
	const said = new Map();
	let running = false;

	const record = (venue, state) => {
		states.set(venue, state);
		const key = `${state.status}|${state.method}|${state.wantCenti}|${state.quotaCenti}|${state.reason}`;
		if (said.get(venue) === key) return;
		said.set(venue, key);
		const fields = { venue, method: state.method, status: state.status, wantCenti: state.wantCenti ?? "none", quotaCenti: state.quotaCenti === undefined ? "unread" : (state.quotaCenti ?? "none"), reason: state.reason ?? "" };
		if (state.status === "held") log("cpu_reserve", fields);
		else log("cpu_reserve_fail_open", { ...fields, failOpen: failOpenSaid(state) });
	};

	const one = async (plan, cpuCenti) => {
		const base = { venue: plan.venue, method: plan.method, wantCenti: undefined, quotaCenti: undefined, reason: plan.why, checkedAt: now() };
		if (!plan.parent) return record(plan.venue, { ...base, status: "no-parent" });
		if (cpuCenti === null || cpuCenti === undefined) return record(plan.venue, { ...base, status: "budget-unknown", reason: "budget-unknown" });
		const want = cpuCenti === Infinity ? null : cpuCenti;
		if (!plan.method) return record(plan.venue, { ...base, wantCenti: want, status: "unmanaged" });
		const prev = states.get(plan.venue);
		const t = now();
		const fresh = prev && prev.wantCenti === want && prev.method === plan.method && t - prev.checkedAt < (prev.status === "held" ? RESERVE_RECHECK_MS : RESERVE_RETRY_MS);
		if (fresh) return undefined;
		const seen = await readQuota(plan, { run, image });
		if (seen.ok && seen.cpuCenti === want) return record(plan.venue, { ...base, wantCenti: want, quotaCenti: seen.cpuCenti, status: "held", reason: null, checkedAt: now() });
		if (plan.method === "system-systemd") {
			return record(plan.venue, { ...base, wantCenti: want, quotaCenti: seen.ok ? seen.cpuCenti : undefined, status: !seen.ok ? "unreadable" : seen.cpuCenti === null ? "unset" : "differs", reason: seen.ok ? "needs-root" : seen.reason, checkedAt: now() });
		}
		const wrote = await writeQuota(plan, want, { run, image });
		const back = await readQuota(plan, { run, image });
		if (wrote.ok && back.ok && back.cpuCenti === want) return record(plan.venue, { ...base, wantCenti: want, quotaCenti: back.cpuCenti, status: "held", reason: null, checkedAt: now() });
		const status = !back.ok ? "unreadable" : back.cpuCenti === null ? "unset" : "differs";
		return record(plan.venue, { ...base, wantCenti: want, quotaCenti: back.ok ? back.cpuCenti : undefined, status, reason: !wrote.ok ? `write-${wrote.reason}` : !back.ok ? `read-${back.reason}` : "not-applied", checkedAt: now() });
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
