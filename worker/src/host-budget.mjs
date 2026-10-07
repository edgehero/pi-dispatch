/**
 * The host budget (issue #596, phase 2, DES-HOST-BUDGET): how much memory and CPU this host's running jobs may hold
 * together, and the one ledger that keeps their sizes inside it.
 *
 * A LEAF beside `job-size.mjs`, importing nothing else of this project's: `config.mjs` validates the four settings at
 * boot with `hostBudgetSettings`, and `scoped-limits.mjs` imports `config.mjs`, so a project row is matched here by its
 * scope string (`project:<id>`) the way `job-size.mjs` matches it.
 *
 * WHY A LEDGER AND NOT A COUNT. `PI_CONCURRENCY` counts containers, and a count cannot tell one 20g job from five 2g
 * ones. The budget sums the SIZE each running job was started at (`memMiB`, `cpuCenti`, integers, so a sum is exact),
 * keyed by job id, so a release is idempotent: the job that took a hold gives back exactly what it took, once, whatever
 * the limits file says by then. `PI_CONCURRENCY` stays an upper bound on the count; whichever binds first, binds.
 *
 * WHY HOLDS. A deferred job goes to the back of the delayed set, so a 20g job behind a stream of 2g jobs would wait
 * forever: every time 2g frees, a 2g job takes it. A HOLD is room the budget keeps for a waiting job while it is away:
 *   - tier 1, the oldest waiter of each project that runs fewer than its `minJobs` here (the soft minimum);
 *   - tier 2, the single oldest waiter of all.
 * A job is admitted only if what runs, plus its own size, plus every hold RANKED ABOVE IT, fits in both memory and CPU,
 * and its project stays within its `hostShare`. A hold that is not the job's own only obstacle is SUSPENDED (another
 * gate deferred the job: a full scope, a busy endpoint, a pause window), so a job never keeps room it could not use. A
 * hold whose job has not come back is VERIFIED after `HOLD_VERIFY_AFTER_MS` against the queue (`job.getState()`) and
 * dropped when the job is active elsewhere, finished or gone; on a Valkey error it is dropped once its job has been away
 * for `HOLD_DROP_ON_ERROR_MS`.
 *
 * WHY ADMISSION IS SYNCHRONOUS. `gate` reads the ledger, decides and writes it with no `await` between, so on Node's one
 * thread two pickups on one host can never both see the same free room. The facts the budget is computed from are read
 * OFF the decision (`refresh`, on the tick), never inside it.
 *
 * A JOB WHOSE STOP FAILED keeps its hold (`orphan`): the container may still be running and still be using what its
 * size promised. The hold is given back only when the runtime confirms the container is gone (`sweep`, on the tick); the
 * boot reaper, which kills every job container before a worker drains, is the backstop for a worker that restarts.
 */

import { formatCpus, formatMemory } from "./job-size.mjs";

/** The four settings, env only for this release (never the settings overlay: a budget must not move under running jobs). */
export const HOST_BUDGET_KEYS = Object.freeze({
	memory: "PI_HOST_MEMORY_BUDGET",
	cpus: "PI_HOST_CPU_BUDGET",
	reserveMemory: "PI_HOST_RESERVE_MEMORY",
	reserveCpus: "PI_HOST_RESERVE_CPUS",
});

/**
 * How often a job the budget deferred asks again. Its own value, like every re-check cadence, because nothing records WHY
 * a job sits in the delayed set and the wake instant is the only evidence there is: distinct from the scope re-check
 * (5 s), the endpoint re-check (7 s), the wait throttle floor (11 s) and the supersede re-ask (15 s). A test keeps them
 * apart. Short, because a hold keeps the room meanwhile: the wait is the latency of a freed slot, not a queue position.
 */
export const BUDGET_RECHECK_MS = 9_000;

/**
 * How long a forge job too big for THIS host waits before another pickup asks again. Longer than every re-check above,
 * because the answer is not "soon" but "on another host": the job goes back to the shared queue for a host it fits on.
 */
export const NEVER_FITS_RECHECK_MS = 60_000;

/**
 * How long a "no live host can fit this" read must stand before a forge job is refused `job-size-exceeds-fleet`: two
 * reads at least this far apart. Two host beats (`HOST_BEAT_MS`, 15 s), so a peer whose row was missing from one read
 * (a restart, a deleted keyspace) has beaten again before the second: the registry can delay a refusal, never invent one.
 */
export const FLEET_NO_FIT_CONFIRM_MS = 30_000;

/** A hold whose job has not been back for this long is checked against the queue. */
export const HOLD_VERIFY_AFTER_MS = 15_000;
/** A hold that cannot be checked (Valkey does not answer) is dropped once its job has been away this long. */
export const HOLD_DROP_ON_ERROR_MS = 120_000;
/** How often the budget re-reads its facts, verifies stale holds and sweeps orphans. Off every job path. */
export const HOST_BUDGET_TICK_MS = 5_000;

/** The `auto` memory reserve: 10% of the host's memory, at least 1 GiB and at most 4 GiB. */
export const RESERVE_MEMORY_MIN_MIB = 1024;
export const RESERVE_MEMORY_MAX_MIB = 4096;
/** The `auto` CPU reserve: one CPU on a host with at least this many, else none. */
export const RESERVE_CPUS_FROM = 4;

/** The largest CPU budget a setting may name: the runtimes' own CPU count ceiling (`daemon-facts.mjs` `cpuCount`). */
const BUDGET_CPUS_CEILING_CENTI = 4096 * 100;
/** The largest memory budget or reserve a setting may name: 64 TiB, `daemon-facts.mjs` `memoryMiB`'s ceiling. */
const BUDGET_MEMORY_CEILING_MIB = 64 * 1024 * 1024;

const PROJECT_ROW_PREFIX = "project:";

/** A memory setting (`64g`, `1536m`) in MiB, or 0 for `"0"` where `zero` allows it. Throws an Error naming the rule. */
function parseBudgetMemory(value, { zero = false } = {}) {
	if (zero && value === "0") return 0;
	if (typeof value !== "string" || !/^[1-9]\d{0,8}[mg]$/.test(value)) {
		throw new Error(`a memory amount is a whole number of megabytes or gigabytes such as "1536m" or "64g"${zero ? ", or 0" : ""} (got ${JSON.stringify(value)})`);
	}
	const mib = Number(value.slice(0, -1)) * (value.endsWith("g") ? 1024 : 1);
	if (mib > BUDGET_MEMORY_CEILING_MIB) throw new Error(`a memory amount must be at most ${BUDGET_MEMORY_CEILING_MIB / 1024}g (got ${JSON.stringify(value)})`);
	return mib;
}

/** A CPU setting (`3.5`, `16`) in hundredths, or 0 for `"0"` where `zero` allows it. Throws an Error naming the rule. */
function parseBudgetCpus(value, { zero = false } = {}) {
	if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) {
		throw new Error(`a CPU amount is a number with at most two decimals such as 3.5 or 16${zero ? ", or 0" : ""} (got ${JSON.stringify(value)})`);
	}
	const [whole, fraction = ""] = value.split(".");
	const centi = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	if (centi === 0 && !zero) throw new Error(`a CPU amount must be above 0 (got ${JSON.stringify(value)})`);
	if (centi > BUDGET_CPUS_CEILING_CENTI) throw new Error(`a CPU amount must be at most ${BUDGET_CPUS_CEILING_CENTI / 100} (got ${JSON.stringify(value)})`);
	return centi;
}

/**
 * The four settings as the worker runs them, validated (issue #596): `{ memory, cpus, reserveMemory, reserveCpus }`, each
 * `{ mode: "auto" }`, `{ mode: "off" }` (the two budgets only) or `{ mode: "value", memMiB | cpuCenti }`. Unset or empty
 * is `auto`. Throws an Error naming the key and the rule for anything else, and for a budget VALUE below one job of the
 * deployment's default size (`jobDefault`, `{ memMiB, cpuCenti }`): such a budget would refuse every default-size job,
 * so it is a configuration error at boot rather than a refusal per job. `auto` never falls below that size by
 * construction (`computeHostBudget`), which is decision 3 of the issue.
 *
 * A reserve is what `auto` leaves for the host itself (the OS, the egress proxy, a Valkey, the worker). It applies only
 * to `auto`: a budget given as a value IS the budget.
 */
export function hostBudgetSettings(env = {}, jobDefault = { memMiB: 4096, cpuCenti: 200 }) {
	const read = (key, parse) => {
		const raw = env?.[key];
		if (raw === undefined || raw === null || String(raw).trim() === "" || String(raw).trim() === "auto") return { mode: "auto" };
		const text = String(raw).trim();
		try {
			return parse(text);
		} catch (error) {
			throw new Error(`${key}: ${error.message}`);
		}
	};
	const memory = read(HOST_BUDGET_KEYS.memory, (text) => (text === "off" ? { mode: "off" } : { mode: "value", memMiB: parseBudgetMemory(text) }));
	const cpus = read(HOST_BUDGET_KEYS.cpus, (text) => (text === "off" ? { mode: "off" } : { mode: "value", cpuCenti: parseBudgetCpus(text) }));
	const reserveMemory = read(HOST_BUDGET_KEYS.reserveMemory, (text) => ({ mode: "value", memMiB: parseBudgetMemory(text, { zero: true }) }));
	const reserveCpus = read(HOST_BUDGET_KEYS.reserveCpus, (text) => ({ mode: "value", cpuCenti: parseBudgetCpus(text, { zero: true }) }));
	if (memory.mode === "value" && memory.memMiB < jobDefault.memMiB) {
		throw new Error(`${HOST_BUDGET_KEYS.memory}: ${formatMemory(memory.memMiB)} is below one job of the default size (${formatMemory(jobDefault.memMiB)}, PI_JOB_MEMORY), so every such job would be refused; raise it, lower PI_JOB_MEMORY, or use auto`);
	}
	if (cpus.mode === "value" && cpus.cpuCenti < jobDefault.cpuCenti) {
		throw new Error(`${HOST_BUDGET_KEYS.cpus}: ${formatCpus(cpus.cpuCenti)} is below one job of the default size (${formatCpus(jobDefault.cpuCenti)} CPUs, PI_JOB_CPUS), so every such job would be refused; raise it, lower PI_JOB_CPUS, or use auto`);
	}
	return { memory, cpus, reserveMemory, reserveCpus };
}

/** The smaller of the known values (a number), or null when none is known. */
function smallerKnown(...values) {
	const known = values.filter((v) => Number.isSafeInteger(v) && v > 0);
	return known.length === 0 ? null : Math.min(...known);
}

/**
 * The budget this host's facts give under the settings: `{ memMiB, cpuCenti, detail }`. Each budget is an integer,
 * `Infinity` for `off`, or `null` when `auto` has no fact to work from (the runtime did not answer): the gate then fails
 * OPEN on that dimension and says so (`host_budget_unknown`), the posture `--cpus` takes when the CPU count is unknown.
 *
 * `facts`: `{ memTotalMiB, hostCpus, userMemMiB, userCpuCenti }`, the runtime's own memory and CPU count
 * (`daemon-facts.mjs`) and, on rootless Podman, the user service's `memory.max` and `cpu.max` (`readUserServiceLimits`).
 * `auto` is the smaller of those, minus the reserve, and never below one job of the default size (`jobDefault`):
 * `floored` says when that floor, not the host, set the number.
 */
export function computeHostBudget(settings, facts = {}, jobDefault = { memMiB: 4096, cpuCenti: 200 }) {
	const detail = { memMode: settings.memory.mode, cpuMode: settings.cpus.mode, memTotalMiB: null, memReserveMiB: null, memFloored: false, cpuTotalCenti: null, cpuReserveCenti: null, cpuFloored: false };
	let memMiB = null;
	if (settings.memory.mode === "off") memMiB = Infinity;
	else if (settings.memory.mode === "value") memMiB = settings.memory.memMiB;
	else {
		const total = smallerKnown(facts.memTotalMiB, facts.userMemMiB);
		if (total !== null) {
			const reserve = settings.reserveMemory.mode === "value" ? settings.reserveMemory.memMiB : Math.min(RESERVE_MEMORY_MAX_MIB, Math.max(RESERVE_MEMORY_MIN_MIB, Math.floor(total / 10)));
			detail.memTotalMiB = total;
			detail.memReserveMiB = reserve;
			detail.memFloored = total - reserve < jobDefault.memMiB;
			memMiB = Math.max(total - reserve, jobDefault.memMiB);
		}
	}
	let cpuCenti = null;
	if (settings.cpus.mode === "off") cpuCenti = Infinity;
	else if (settings.cpus.mode === "value") cpuCenti = settings.cpus.cpuCenti;
	else {
		const total = smallerKnown(Number.isSafeInteger(facts.hostCpus) ? facts.hostCpus * 100 : null, facts.userCpuCenti);
		if (total !== null) {
			const reserve = settings.reserveCpus.mode === "value" ? settings.reserveCpus.cpuCenti : total >= RESERVE_CPUS_FROM * 100 ? 100 : 0;
			detail.cpuTotalCenti = total;
			detail.cpuReserveCenti = reserve;
			detail.cpuFloored = total - reserve < jobDefault.cpuCenti;
			cpuCenti = Math.max(total - reserve, jobDefault.cpuCenti);
		}
	}
	return { memMiB, cpuCenti, detail };
}

/**
 * The cgroup directories that bound a rootless account's containers, outermost first: the account's slice and its
 * systemd user manager's service (`user@<uid>.service`), under which rootless Podman's containers live. Either may carry
 * a `memory.max` or `cpu.max` an administrator set (`systemctl set-property`), and both bound every container below.
 */
export function userServiceCgroupDirs(uid) {
	return [`/sys/fs/cgroup/user.slice/user-${uid}.slice`, `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`];
}

/** A `memory.max` file's value in MiB (rounded down), or null for `max`, an empty file or anything else. */
export function parseMemoryMax(text) {
	const value = String(text ?? "").trim();
	if (!/^[0-9]{1,20}$/.test(value)) return null;
	const bytes = Number(value);
	return Number.isSafeInteger(bytes) && bytes >= 1048576 ? Math.floor(bytes / 1048576) : null;
}

/** A `cpu.max` file's quota in hundredths of a CPU (rounded down), or null for `max <period>` or anything else. */
export function parseCpuMax(text) {
	const match = /^([0-9]{1,15}) ([0-9]{1,15})$/.exec(String(text ?? "").trim());
	if (!match) return null;
	const quota = Number(match[1]);
	const period = Number(match[2]);
	if (period <= 0 || quota <= 0) return null;
	const centi = Math.floor((quota * 100) / period);
	return centi > 0 ? centi : null;
}

/**
 * The smallest `memory.max` and `cpu.max` over a rootless account's slice and user service (`userServiceCgroupDirs`), as
 * `{ userMemMiB, userCpuCenti }`, each null where no file is readable or none sets a bound. Best effort and synchronous:
 * an unreadable file is no bound rather than an error, so a host without cgroup v2 or with another layout keeps the
 * runtime's own numbers. `readFile` is injected (`fs.readFileSync` with "utf8").
 */
export function readUserServiceLimits({ uid, readFile }) {
	let userMemMiB = null;
	let userCpuCenti = null;
	if (!Number.isSafeInteger(uid) || uid < 0 || typeof readFile !== "function") return { userMemMiB, userCpuCenti };
	const read = (path) => {
		try {
			return readFile(path);
		} catch {
			return null;
		}
	};
	for (const dir of userServiceCgroupDirs(uid)) {
		userMemMiB = smallerKnown(userMemMiB, parseMemoryMax(read(`${dir}/memory.max`)));
		userCpuCenti = smallerKnown(userCpuCenti, parseCpuMax(read(`${dir}/cpu.max`)));
	}
	return { userMemMiB, userCpuCenti };
}

/**
 * A project's two budget knobs from a limits snapshot: `{ hostShare, minJobs, size }`, hostShare a percentage or null,
 * minJobs an integer or 0, `size` the row's `{ memory, cpus }` strings as written (for doctor). Nothing for no row.
 */
export function projectBudgetRow(limits, project) {
	if (typeof project !== "string" || !Array.isArray(limits)) return { hostShare: null, minJobs: 0 };
	const row = limits.find((l) => l?.scope === `${PROJECT_ROW_PREFIX}${project}`) ?? null;
	return {
		hostShare: Number.isSafeInteger(row?.hostShare) ? row.hostShare : null,
		minJobs: Number.isSafeInteger(row?.minJobs) && row.minJobs > 0 ? row.minJobs : 0,
	};
}

/** `x` fits in `budget` (null is unknown and `Infinity` is off: both fit). */
function fits(x, budget) {
	return budget === null || budget === Infinity || x <= budget;
}

/** `x` fits in `share` percent of `budget`, in integers (null share is no share). */
function withinShare(x, budget, share) {
	return share === null || budget === null || budget === Infinity || x * 100 <= share * budget;
}

function sumOf(entries) {
	let memMiB = 0;
	let cpuCenti = 0;
	for (const e of entries) {
		memMiB += e.memMiB;
		cpuCenti += e.cpuCenti;
	}
	return { memMiB, cpuCenti };
}

/** Oldest first; the id breaks a tie, so the order is total and two hosts would rank one set the same way. */
function byAge(a, b) {
	return a.firstAt - b.firstAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The holds, in rank order (PURE): tier 1, the oldest unsuspended waiter of each project that runs fewer than its
 * `minJobs` here (oldest first among them), then tier 2, the single oldest unsuspended waiter of all when it is not
 * already in tier 1. `running` counts every ledger entry of a project, orphans included: an orphan's container may run.
 */
export function rankHolds(waiters, ledger, minJobsOf = () => 0) {
	const active = [...waiters].filter((w) => !w.suspended).sort(byAge);
	const running = new Map();
	for (const e of ledger) if (e.project) running.set(e.project, (running.get(e.project) ?? 0) + 1);
	const tier1 = [];
	const seen = new Set();
	for (const w of active) {
		if (!w.project || seen.has(w.project)) continue;
		seen.add(w.project);
		const min = minJobsOf(w.project);
		if (min > 0 && (running.get(w.project) ?? 0) < min) tier1.push(w);
	}
	const oldest = active[0];
	return oldest && !tier1.includes(oldest) ? [...tier1, oldest] : tier1;
}

/**
 * THE ADMISSION RULE (PURE): may `ask` (`{ id, project, memMiB, cpuCenti }`) start now? `{ ok: true }`, or `{ ok: false,
 * why }` with `why` `share` (its project would hold more than its `hostShare` of the budget) or `budget` (what runs, plus
 * `ask`, plus every hold ranked above it, does not fit in memory or in CPU). `holds` is `rankHolds`' order; a job that
 * holds no hold has every hold above it. The share is judged first, so a job its own project's share stops is not
 * reported as waiting for the budget (and so does not hold room it could not use).
 */
export function admit({ budget, ledger, holds, ask, shareOf = () => null }) {
	const share = ask.project ? shareOf(ask.project) : null;
	if (share !== null) {
		const mine = sumOf(ledger.filter((e) => e.project === ask.project));
		if (!withinShare(mine.memMiB + ask.memMiB, budget.memMiB, share) || !withinShare(mine.cpuCenti + ask.cpuCenti, budget.cpuCenti, share)) return { ok: false, why: "share" };
	}
	const rank = holds.findIndex((h) => h.id === ask.id);
	const need = sumOf([...ledger, ask, ...(rank === -1 ? holds : holds.slice(0, rank))]);
	if (!fits(need.memMiB, budget.memMiB) || !fits(need.cpuCenti, budget.cpuCenti)) return { ok: false, why: "budget" };
	return { ok: true };
}

/**
 * Whether a size can EVER start on a host with this budget (PURE): null when it can, `host` when it is larger than the
 * budget in memory or CPU, `share` when it fits the budget but not its project's `hostShare` of it. An unknown or `off`
 * budget never refuses.
 */
export function neverFits(size, budget, share = null) {
	if (!fits(size.memMiB, budget.memMiB) || !fits(size.cpuCenti, budget.cpuCenti)) return "host";
	if (!withinShare(size.memMiB, budget.memMiB, share) || !withinShare(size.cpuCenti, budget.cpuCenti, share)) return "share";
	return null;
}

/** A budget as the registry row carries it (INT-HOST-REGISTRY-CONTRACT): an integer as text, `off`, or "" for unknown. */
export function budgetField(value) {
	return value === Infinity ? "off" : Number.isSafeInteger(value) ? String(value) : "";
}

/** A registry row's published budget back: `{ memMiB, cpuCenti }`, each an integer, `Infinity` (`off`) or null. */
export function publishedBudget(row) {
	const read = (v) => (v === "off" ? Infinity : typeof v === "string" && /^[0-9]{1,15}$/.test(v) ? Number(v) : null);
	return { memMiB: read(row?.budgetMemMiB), cpuCenti: read(row?.budgetCpuCenti) };
}

/**
 * Whether ANY live host can fit a size (PURE), from one registry read (`readLiveHosts`' rows, this host's own included):
 * `fits` when a host's published budget (and the project's share of it) fits it, `none` when every row publishes a
 * budget in both dimensions and none fits, else `unknown` (no row for this host, or a row without a budget: a worker
 * from before the budget, or one whose facts are not read yet). Only `none` may refuse, and only twice in a row
 * (`FLEET_NO_FIT_CONFIRM_MS`).
 */
export function fleetFit(size, share, rows, self) {
	if (!Array.isArray(rows) || !rows.some((r) => r?.name === self)) return "unknown";
	let unknown = false;
	for (const row of rows) {
		const budget = publishedBudget(row);
		if (budget.memMiB === null || budget.cpuCenti === null) {
			unknown = true;
			continue;
		}
		if (neverFits(size, budget, share) === null) return "fits";
	}
	return unknown ? "unknown" : "none";
}

/**
 * The host budget's state and its four doors (`gate`, `suspend`, `release`, `orphan`), built ONCE per worker
 * (`createWorker`) and shared by both of its processors, so one host keeps one ledger whatever queue a job came from.
 *
 *   settings      `hostBudgetSettings`' answer
 *   jobDefault    the deployment's default size, `{ memMiB, cpuCenti }`, under which `auto` never falls
 *   readFacts     async () => `{ memTotalMiB, hostCpus, userMemMiB, userCpuCenti }`, the runtime's answers (cached by
 *                 their own readers); read by `refresh`, never by `gate`
 *   scopedLimits  () => the live limits snapshot, for the holds' `minJobs` and the shares when no pickup snapshot is given
 *   containerGone async (name, venue) => true (the runtime says it is gone), false (it runs), null (could not ask)
 *   onRefresh     (budget, facts) => anything, after every refresh, NOT awaited and never allowed to throw into it: the
 *                 CPU reserve (`cpu-reserve.mjs`) keeps the jobs' parent cgroup's quota at the budget from here, so a
 *                 slow `systemctl` or helper container delays no refresh, no gate and no pickup
 */
export function makeHostBudget({ settings, jobDefault = { memMiB: 4096, cpuCenti: 200 }, readFacts = async () => ({}), scopedLimits = () => [], containerGone = async () => null, onRefresh = () => {}, now = () => Date.now(), log = () => {} }) {
	let budget = { memMiB: null, cpuCenti: null };
	let detail = null;
	let unknownSaid = "";
	/** jobId -> { id, project, memMiB, cpuCenti, at, orphan: null | { name, venue, since } } */
	const ledger = new Map();
	/** jobId -> { id, project, memMiB, cpuCenti, firstAt, lastAt, checkedAt, suspended, state } */
	const waiters = new Map();
	/** The jobs this host's processors are handling right now, so a hold of an `active` job is not mistaken for elsewhere. */
	const handling = new Set();
	const rulesOf = (limits) => ({
		shareOf: (p) => projectBudgetRow(limits, p).hostShare,
		minJobsOf: (p) => projectBudgetRow(limits, p).minJobs,
	});

	const refresh = async () => {
		let facts = {};
		try {
			facts = (await readFacts()) ?? {};
		} catch {
			facts = {};
		}
		const next = computeHostBudget(settings, facts, jobDefault);
		budget = { memMiB: next.memMiB, cpuCenti: next.cpuCenti };
		detail = next.detail;
		const unknown = [budget.memMiB === null ? "memory" : null, budget.cpuCenti === null ? "cpus" : null].filter(Boolean).join(",");
		if (unknown !== unknownSaid) {
			unknownSaid = unknown;
			if (unknown !== "") log("host_budget_unknown", { unknown, reason: "the runtime gave no memory or CPU count, so no job is held back on it" });
			else log("host_budget", { memMiB: budgetField(budget.memMiB), cpuCenti: budgetField(budget.cpuCenti), memFloored: detail.memFloored, cpuFloored: detail.cpuFloored });
		}
		try {
			Promise.resolve(onRefresh({ ...budget }, facts)).catch(() => {});
		} catch {
			// a hook that throws synchronously is the hook's own failure, never the budget's
		}
		return budget;
	};
	const ready = refresh();

	const holdsNow = (limits) => rankHolds(waiters.values(), [...ledger.values()], rulesOf(limits).minJobsOf);

	return {
		ready,
		refresh,
		/** The budget in force: `{ memMiB, cpuCenti }`, each an integer, `Infinity` (off) or null (unknown). */
		current: () => ({ ...budget }),
		detail: () => detail,
		/** null when `size` can start here some day, else `host` or `share` (`neverFits`). */
		neverFits: (size, project, limits = scopedLimits()) => neverFits(size, budget, project ? rulesOf(limits).shareOf(project) : null),
		/** The project's `hostShare` in the given snapshot, for a refusal's record. */
		shareOf: (project, limits = scopedLimits()) => (project ? rulesOf(limits).shareOf(project) : null),
		/** Marks a job as inside one of this host's processors (`enter`) or no longer (`leave`). */
		enter: (id) => handling.add(id),
		leave: (id) => handling.delete(id),
		/**
		 * THE GATE, synchronous: `{ admitted: true }` with the hold taken, or `{ admitted: false, why }` with the job kept
		 * (or made) a waiter. `getState` is the job's own `getState`, kept for `verify`.
		 */
		gate({ id, project = null, size, getState = null, limits = scopedLimits() }) {
			const t = now();
			const was = waiters.get(id);
			const ask = { id, project, memMiB: size.memMiB, cpuCenti: size.cpuCenti, firstAt: was?.firstAt ?? t };
			const rules = rulesOf(limits);
			// The asking job is ranked as the waiter it is (or would be), so a tier 1 job arriving now outranks an old tier 2
			// hold, which is what `minJobs` promises, and an old waiter keeps its rank across its own deferrals.
			const candidates = new Map(waiters);
			candidates.set(id, { ...ask, suspended: false });
			const holds = rankHolds(candidates.values(), [...ledger.values()], rules.minJobsOf);
			const verdict = admit({ budget, ledger: [...ledger.values()], holds, ask, shareOf: rules.shareOf });
			if (verdict.ok) {
				waiters.delete(id);
				ledger.set(id, { id, project, memMiB: size.memMiB, cpuCenti: size.cpuCenti, at: t, orphan: null });
				return { admitted: true };
			}
			// A share-stopped job is a waiter that holds nothing: the budget is not its obstacle.
			waiters.set(id, { ...ask, lastAt: t, checkedAt: t, suspended: verdict.why === "share", state: typeof getState === "function" ? getState : was?.state ?? null });
			return { admitted: false, why: verdict.why, rank: holds.findIndex((h) => h.id === id) };
		},
		/** Another gate deferred the job: its hold (if any) keeps its age and stops counting until it comes back. */
		suspend(id) {
			const w = waiters.get(id);
			if (w) waiters.set(id, { ...w, suspended: true, lastAt: now() });
		},
		/** The job ended without waiting for the budget again (refused, failed, ran): its waiter is dropped. */
		forget(id) {
			waiters.delete(id);
		},
		/** Gives back a running job's hold. IDEMPOTENT: true only the first time, and never for an orphan. */
		release(id) {
			const entry = ledger.get(id);
			if (!entry || entry.orphan) return false;
			ledger.delete(id);
			return true;
		},
		/** The job's container may outlive it (its stop did not take): the hold stays until `sweep` sees the container gone. */
		orphan(id, { name = null, venue = null } = {}) {
			const entry = ledger.get(id);
			if (!entry || entry.orphan) return false;
			ledger.set(id, { ...entry, orphan: { name, venue, since: now() } });
			log("host_budget_orphan", { jobId: id, memMiB: entry.memMiB, cpuCenti: entry.cpuCenti });
			return true;
		},
		/** Drops the holds of waiters whose job is not coming back (see the header). */
		async verify() {
			const t = now();
			for (const w of [...waiters.values()]) {
				if (t - Math.max(w.lastAt, w.checkedAt) < HOLD_VERIFY_AFTER_MS) continue;
				let state;
				try {
					if (typeof w.state !== "function") throw new Error("no state reader");
					state = await w.state();
				} catch {
					if (t - w.lastAt >= HOLD_DROP_ON_ERROR_MS && waiters.get(w.id) === w) {
						waiters.delete(w.id);
						log("host_budget_hold_dropped", { jobId: w.id, because: "unverifiable" });
					}
					continue;
				}
				// The waiter may have come back (or been replaced) while the state was read: only the one read is judged.
				if (waiters.get(w.id) !== w) continue;
				const gone = state === "completed" || state === "failed" || state === "unknown" || (state === "active" && !handling.has(w.id));
				if (gone) {
					waiters.delete(w.id);
					log("host_budget_hold_dropped", { jobId: w.id, because: state === "active" ? "active-elsewhere" : state });
				} else {
					waiters.set(w.id, { ...w, checkedAt: t });
				}
			}
		},
		/** Gives back an orphan's hold once the runtime says its container is gone. */
		async sweep() {
			for (const entry of [...ledger.values()]) {
				if (!entry.orphan) continue;
				let gone = null;
				try {
					gone = await containerGone(entry.orphan.name, entry.orphan.venue);
				} catch {
					gone = null;
				}
				if (gone === true && ledger.get(entry.id) === entry) {
					ledger.delete(entry.id);
					log("host_budget_orphan_released", { jobId: entry.id, heldForMs: now() - entry.orphan.since });
				}
			}
		},
		/** One tick: facts, then the stale holds, then the orphans. Never throws. */
		async tick() {
			await refresh().catch(() => {});
			await this.verify().catch(() => {});
			await this.sweep().catch(() => {});
		},
		/**
		 * What the registry row and doctor show: the budget, what runs (orphans included), what the holds keep, and counts.
		 * Integers only.
		 */
		snapshot(limits = scopedLimits()) {
			const entries = [...ledger.values()];
			const used = sumOf(entries);
			const holds = holdsNow(limits);
			const held = sumOf(holds);
			return {
				memMiB: budget.memMiB,
				cpuCenti: budget.cpuCenti,
				usedMemMiB: used.memMiB,
				usedCpuCenti: used.cpuCenti,
				heldMemMiB: held.memMiB,
				heldCpuCenti: held.cpuCenti,
				running: entries.length,
				orphans: entries.filter((e) => e.orphan).length,
				holds: holds.length,
				waiters: waiters.size,
			};
		},
		/** Test and doctor seams: copies, never the live maps. */
		entries: () => [...ledger.values()].map((e) => ({ ...e })),
		waiting: () => [...waiters.values()].map(({ state: _s, ...w }) => ({ ...w })),
	};
}

/** The largest memory and CPU sizes a project may run at on a host with this budget and share, for doctor. */
export function largestFit(budget, share = null) {
	const cap = (b) => (b === null || b === Infinity ? b : share === null ? b : Math.floor((share * b) / 100));
	return { memMiB: cap(budget.memMiB), cpuCenti: cap(budget.cpuCenti) };
}
