/**
 * A size suggestion for one project (issue #596, phase 3, DES-SIZE-SUGGESTIONS): what memory and CPUs its jobs
 * should be given, read from what its recent runs used. ONE pure function, `suggestSize`, which doctor, the panel's
 * PROJECTS view, the `dispatch_limit_edit` preview and the insights page all call, so the four can never disagree.
 *
 * A LEAF beside `job-size.mjs`, importing nothing else of this project's: the admin bundle inlines it, and the insights
 * page builder refuses every worker import, so its caller computes the suggestion and hands the page the result.
 *
 * WHAT IT READS. Run records (INT-RUN-HISTORY-FILE-CONTRACT) of the project, from the last `SUGGEST_WINDOW_DAYS`
 * days, newest first, at most `SUGGEST_WINDOW_RUNS` of them, and only those that carry BOTH `resources` (what the
 * container used, issue #596 phase 0) and `size` (what it was given, phase 1). A record from before either is ignored,
 * never guessed.
 *
 * THE NUMBERS ARE UNTRUSTED. `resources` is produced inside the job's container, which runs code the job controls, so
 * every number is judged again here whatever the worker judged when it wrote the record: a field that is not a safe
 * non-negative integer is IGNORED (that record leaves that dimension), and a value past what the container could hold
 * is CLAMPED to it. The suggestion is NEVER applied by anything: every surface names the call, and an operator confirms.
 *
 * TWO MEASURED FACTS SHAPE THE RULES (the review gate of this phase, in the lab):
 *   - page cache alone drives `memory.peak` to exactly the limit with no OOM kill (a 512m container reading 1.2 GB of
 *     files peaked at 512m, oom_kill 0). A peak AT the limit therefore says nothing about need, so it never raises:
 *     an earlier rule that raised on it walked an I/O-heavy project up step by step to the budget. Only a confirmed
 *     OOM (the record's reason `oom-killed`, which the WORKER decides, not the job) raises memory.
 *   - a job's throttled time is the same at 1024 and 4096 CPU shares, because `--cpus` is the host's CPU ceiling for
 *     every job, not the job's size (the size is its weight). Raising a job's cpus never reduces its throttling, so
 *     throttling never raises CPUs; it is shown as a fact about the host.
 *
 * WHICH RUNS COUNT: in each dimension the runs given at least the CURRENT size decide (a run at a smaller size that
 * was cut off says the old size was too small, which is no longer the question). The floors of a lowering read EVERY
 * run of the window, whatever its size: a lowering must never undo a raise an OOM caused, nor drop below what the
 * heaviest run used.
 *
 * MEMORY, in this order (the first that applies decides):
 *   1. an `oom-killed` run at the current size or larger: raise to 1.5x the larger of the current size and the
 *      largest size in the window that was OOM-killed (one step; that run no longer counts once the raise is applied);
 *   2. fewer than `SUGGEST_MIN_SAMPLES` runs: not enough runs;
 *   3. the target 1.25x the p95 peak at most 0.75x the current size: lower to it, but never below 1.25x the window's
 *      largest peak (peak / 0.8), 1.5x the largest OOM-killed size in the window, nor the 512m floor;
 *   4. otherwise it fits.
 *   A FACT (no call) rides along when runs at the limit were also under real memory pressure (`memFullUsec` above 1%
 *   of the wall time): information, never an instruction.
 *   A size is rounded UP to a step: 256m up to 2g, 512m up to 8g, then 1g.
 * CPUs: fewer than `SUGGEST_MIN_SAMPLES` runs is not enough runs; the p95 cores used (CPU time over wall time) below
 * 0.4x the current cpus lowers to 1.25x that p95, never below 1.25x the window's largest cores used, nor 0.25;
 * otherwise it fits. A FACT (no call) rides along when the median run was throttled more than 25% of its wall time.
 * The wall time is the record's pickup-to-end span, which includes the clone, so cores used read slightly LOW.
 *
 * THE CAP. A raise never goes past `cap` (this host's budget per dimension, or where that is off or unknown the host's
 * memory and CPU count; `hostCap`, `fleetCap`). A project with a `hostShare` is capped at its SHARE of each integer
 * budget, floor(budget x hostShare / 100), since the worker refuses a job above it (`job-size-exceeds-share`): a cap
 * at the whole budget would offer a call to a size this project could never run at. Where the cap binds the
 * suggestion is the cap and says the project's runs need more than this host offers; where the size already is the
 * cap or the largest size there is, it suggests nothing and says so; where no cap is known, a raise offers no call at
 * all, only the fact, and `capMissing` says why (`MEMORY_CAP_MISSING`). Nothing here ever advises growing a host's
 * budget: the budget is what the host promised everyone else.
 *
 * Every boundary is decided in integers (BigInt where a product can pass 2^53), so "exactly 0.75x" and "exactly 1%"
 * land on the side the rule says, on every host.
 */

import { JOB_CPUS_CEILING_CENTI, JOB_CPUS_FLOOR_CENTI, JOB_MEMORY_CEILING_MIB, JOB_MEMORY_FLOOR_MIB, formatCpus, formatMemory, recordedJobSize } from "./job-size.mjs";

/** How far back a suggestion reads: 30 days. */
export const SUGGEST_WINDOW_DAYS = 30;
/** How many runs a suggestion reads at most, newest first: 50. The window is whichever of the two is fewer runs. */
export const SUGGEST_WINDOW_RUNS = 50;
/** Fewer runs than this in a dimension and only an OOM decides it. */
export const SUGGEST_MIN_SAMPLES = 10;
/**
 * How far a record's `endedAt` may lie past `now` and still count: 5 minutes, ordinary skew between hosts. A copy of
 * run-history.mjs `RECORD_CLOCK_SKEW_MS` (this module imports nothing heavy); a test holds the two equal.
 */
export const SUGGEST_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The longest wall time a record may claim and still give a CPU sample: 7 days. A longer span is no job's. */
export const SUGGEST_MAX_WALL_MS = 7 * 24 * 60 * 60 * 1000;

/** Why a memory suggestion is what it is. */
export const MEMORY_REASONS = Object.freeze(["oom-killed", "not-enough-runs", "oversized", "fits"]);
/** Why a CPU suggestion is what it is. There is no raise: see the header. */
export const CPU_REASONS = Object.freeze(["not-enough-runs", "underused", "fits"]);
/**
 * Why a memory raise suggests less than it wanted, or nothing: `cap` (the cap bound; the suggestion IS the cap),
 * `largest` (the size already is the cap or the largest size there is), `no-cap` (no cap is known: no call at all).
 */
export const MEMORY_HELD = Object.freeze(["cap", "largest", "no-cap"]);
/**
 * Why no cap is known, where a raise is held `no-cap` across live hosts (`hosts`): `unread` (no live host's budget in
 * this dimension was read as a number, and not every one is `off`: none published, or none read here), `none-holds` (budgets were read, but no live host's
 * budget holds the project's size in the other dimension), `off` (every live host's budget is `off` in this dimension,
 * so the panel cannot know how much it holds). Null for a single host's cap (doctor), whose own words say why.
 */
export const MEMORY_CAP_MISSING = Object.freeze(["unread", "none-holds", "off"]);
/** The facts a suggestion may carry with no call: memory `pressure`, CPU `ceiling`. */
export const SIZE_FACTS = Object.freeze(["pressure", "ceiling"]);

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A memory size rounded UP to its step: 256m up to 2g, 512m up to 8g, then 1g; at least the floor, at most the ceiling. */
export function roundMemoryUp(memMiB) {
	const v = Math.max(JOB_MEMORY_FLOOR_MIB, Math.ceil(memMiB));
	const step = v <= 2048 ? 256 : v <= 8192 ? 512 : 1024;
	return Math.min(JOB_MEMORY_CEILING_MIB, Math.ceil(v / step) * step);
}

/** A CPU size in hundredths rounded UP to a 0.25 step; at least 0.25, at most the ceiling. */
export function roundCpusUp(cpuCenti) {
	const v = Math.max(JOB_CPUS_FLOOR_CENTI, Math.ceil(cpuCenti));
	return Math.min(JOB_CPUS_CEILING_CENTI, Math.ceil(v / 25) * 25);
}

/** The nearest-rank percentile of a sorted array: the value at rank ceil(p/100 x n). */
function rank(sorted, pct) {
	return sorted[Math.max(0, Math.ceil((pct * sorted.length) / 100) - 1)];
}

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * One record as a suggestion reads it, or null when it is not evidence: `{ at, size, memPeak, oom, wallUsec, cpuUsec,
 * throttledUsec, memFullUsec }`. `memPeak` (bytes, clamped to the record's own limit) is null when absent or not a
 * count; `wallUsec` is null unless the span is readable; `cpuUsec` and `throttledUsec` are null unless both can be read
 * with a wall time (CPU time clamped to the CPU ceiling over the wall, throttled time to the wall); `memFullUsec` is
 * null unless it can be read with a wall time.
 */
function evidenceOf(record, project, nowMs) {
	if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
	if (record.project !== project) return null;
	const size = recordedJobSize(record.size);
	const r = record.resources;
	if (size === null || r === null || typeof r !== "object") return null; // an array carries no named key, so no evidence
	const at = typeof record.endedAt === "string" ? Date.parse(record.endedAt) : NaN;
	if (!Number.isFinite(at) || at > nowMs + SUGGEST_CLOCK_SKEW_MS || at < nowMs - SUGGEST_WINDOW_DAYS * DAY_MS) return null;
	const limitBytes = size.memMiB * MIB;
	const memPeak = isCount(r.memPeak) ? Math.min(r.memPeak, limitBytes) : null;
	const start = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : NaN;
	const wallMs = Number.isFinite(start) ? at - start : NaN;
	const wallUsec = Number.isSafeInteger(wallMs) && wallMs > 0 && wallMs <= SUGGEST_MAX_WALL_MS ? wallMs * 1000 : null;
	let cpu = { cpuUsec: null, throttledUsec: null };
	if (wallUsec !== null && isCount(r.cpuUsec) && isCount(r.throttledUsec)) {
		const cpuCap = (wallUsec * JOB_CPUS_CEILING_CENTI) / 100;
		cpu = { cpuUsec: Math.min(r.cpuUsec, cpuCap), throttledUsec: Math.min(r.throttledUsec, wallUsec) };
	}
	// unclamped: it is only ever compared (exactly, in BigInt) with 1% of the wall, and a stall past the wall is above it
	const memFullUsec = wallUsec !== null && isCount(r.memFullUsec) ? r.memFullUsec : null;
	if (memPeak === null && cpu.cpuUsec === null) return null;
	return { at, size, memPeak, oom: record.reason === "oom-killed", wallUsec, ...cpu, memFullUsec };
}

/** a x b > c x d, exactly. */
const productAbove = (a, b, c, d) => BigInt(a) * BigInt(b) > BigInt(c) * BigInt(d);
/** 1.25 x bytes in MiB, rounded up: ceil(5 x bytes / (4 x MiB)). Equally, bytes / 0.8. */
const quarterMoreMiB = (bytes) => Math.ceil((5 * bytes) / (4 * MIB));
/** 1.25 x the cores of a CPU sample, in hundredths, rounded up: ceil(cpuUsec x 125 / wall). */
const quarterMoreCenti = (e) => Number((BigInt(e.cpuUsec) * 125n + BigInt(e.wallUsec) - 1n) / BigInt(e.wallUsec));

/** A raise held to the cap: `{ suggested, held }`. `wanted` is already rounded and at most the largest size. */
function heldToCap(wanted, current, cap) {
	if (wanted <= current) return { suggested: null, held: "largest" }; // the largest size there is
	if (!Number.isSafeInteger(cap)) return { suggested: null, held: "no-cap" };
	if (cap <= current) return { suggested: null, held: "largest" };
	if (wanted > cap) return { suggested: cap, held: "cap" };
	return { suggested: wanted, held: null };
}

function suggestMemory(runs, current, cap) {
	const measured = runs.filter((e) => e.memPeak !== null);
	const relevant = measured.filter((e) => e.size.memMiB >= current);
	const samples = relevant.length;
	const p95 = samples > 0 ? rank(relevant.map((e) => e.memPeak).sort((a, b) => a - b), 95) : null;
	const ooms = relevant.filter((e) => e.oom).length;
	const maxPeak = measured.length > 0 ? Math.max(...measured.map((e) => e.memPeak)) : null;
	const oomSizes = measured.filter((e) => e.oom).map((e) => e.size.memMiB);
	const largestOom = oomSizes.length > 0 ? Math.max(...oomSizes) : null;
	// at the limit (90% of it or more: peak x 10 >= limit x 9) AND stalled for memory more than 1% of the wall.
	const pressured = relevant.filter((e) => !productAbove(e.size.memMiB * MIB, 9, e.memPeak, 10) && e.memFullUsec !== null && productAbove(e.memFullUsec, 100, e.wallUsec, 1)).length;
	const evidence = { samples, p95MiB: p95 === null ? null : Math.ceil(p95 / MIB), maxPeakMiB: maxPeak === null ? null : Math.ceil(maxPeak / MIB), ooms, largestOomMiB: largestOom, pressured };
	const fact = pressured > 0 ? "pressure" : null;
	const out = (reason, suggested, more = {}) => ({ current, suggested: suggested === null || suggested === current ? null : suggested, reason, evidence, fact, held: null, wanted: null, ...more });
	if (ooms > 0) {
		const wanted = roundMemoryUp(Math.ceil((Math.max(current, largestOom) * 3) / 2));
		const { suggested, held } = heldToCap(wanted, current, cap);
		return out("oom-killed", suggested, { held, wanted });
	}
	if (samples < SUGGEST_MIN_SAMPLES) return out("not-enough-runs", null);
	// lower only when 1.25 x p95 <= 0.75 x current, that is 5 x p95 <= 3 x current (in bytes).
	if (!productAbove(5, p95, 3, current * MIB)) {
		const floor = Math.max(roundMemoryUp(quarterMoreMiB(maxPeak)), largestOom === null ? 0 : roundMemoryUp(Math.ceil((largestOom * 3) / 2)));
		const lower = Math.max(roundMemoryUp(quarterMoreMiB(p95)), floor);
		return lower < current ? out("oversized", lower) : out("fits", null);
	}
	return out("fits", null);
}

function suggestCpus(runs, current) {
	const measured = runs.filter((e) => e.cpuUsec !== null);
	const relevant = measured.filter((e) => e.size.cpuCenti >= current);
	const samples = relevant.length;
	// ordered by the exact fraction, never a float: a/b < c/d  <=>  a x d < c x b.
	const byFraction = (num) => (x, y) => (productAbove(num(y), x.wallUsec, num(x), y.wallUsec) ? -1 : productAbove(num(x), y.wallUsec, num(y), x.wallUsec) ? 1 : 0);
	const throttle = samples > 0 ? rank([...relevant].sort(byFraction((e) => e.throttledUsec)), 50) : null;
	const busy = samples > 0 ? rank([...relevant].sort(byFraction((e) => e.cpuUsec)), 95) : null;
	const busiest = measured.length > 0 ? [...measured].sort(byFraction((e) => e.cpuUsec)).at(-1) : null;
	const coresOf = (e) => (e === null ? null : Math.ceil((e.cpuUsec * 100) / e.wallUsec));
	const evidence = {
		samples,
		p95CoresCenti: coresOf(busy),
		maxCoresCenti: coresOf(busiest),
		throttledPct: throttle === null ? null : Math.round((throttle.throttledUsec * 100) / throttle.wallUsec),
	};
	const out = (reason, suggested, fact = null) => ({ current, suggested: suggested === null || suggested === current ? null : suggested, reason, evidence, fact, held: null, wanted: null });
	if (samples < SUGGEST_MIN_SAMPLES) return out("not-enough-runs", null);
	// throttled more than 25% of the wall time (throttled x 4 > wall): a fact about the host's ceiling, never a call.
	const fact = productAbove(throttle.throttledUsec, 4, throttle.wallUsec, 1) ? "ceiling" : null;
	// p95 cores below 0.4 x cpus: cpuUsec / wall < 0.4 x current / 100, that is cpuUsec x 1000 < 4 x current x wall.
	if (productAbove(4 * current, busy.wallUsec, busy.cpuUsec, 1000)) {
		const lower = Math.max(roundCpusUp(quarterMoreCenti(busy)), roundCpusUp(quarterMoreCenti(busiest)));
		return lower < current ? out("underused", lower, fact) : out("fits", null, fact);
	}
	return out("fits", null, fact);
}

/** The runs a suggestion reads, judged: the project's evidence in the window, newest first, at most SUGGEST_WINDOW_RUNS. */
function windowRuns(project, records, nowMs) {
	return (Array.isArray(records) ? records : [])
		.map((r) => evidenceOf(r, project, nowMs))
		.filter((e) => e !== null)
		.sort((a, b) => b.at - a.at)
		.slice(0, SUGGEST_WINDOW_RUNS);
}

/**
 * The memory peaks a suggestion reads, for a chart of peak against size over time (the insights page): `[{ at, peakMiB,
 * sizeMiB, oom }]`, OLDEST first, the same runs `suggestSize` reads and judged the same way (a peak clamped to its run's
 * size, rounded up to whole MiB), so the chart shows exactly the evidence. Runs with no readable peak are left out. Pure.
 */
export function peakSeries({ project, records = [], now }) {
	const nowMs = now instanceof Date ? now.getTime() : now;
	if (!Number.isFinite(nowMs)) throw new TypeError("peakSeries needs `now` (millis or a Date)");
	return windowRuns(project, records, nowMs)
		.filter((e) => e.memPeak !== null)
		.reverse()
		.map((e) => ({ at: e.at, peakMiB: Math.ceil(e.memPeak / MIB), sizeMiB: e.size.memMiB, oom: e.oom }));
}

const capDim = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const isShare = (share) => Number.isSafeInteger(share) && share > 0 && share <= 100;
/**
 * A budget dimension as a project with `share` may use it: floor(budget x share / 100) for an integer budget (the
 * worker's own `largestFit`; a job above it is refused), the budget itself without a share, and `off` or unknown as
 * they are (a share of no number refuses nothing).
 */
const shareOf = (budget, share) => (Number.isSafeInteger(budget) && isShare(share) ? Math.floor((budget * share) / 100) : budget);

/**
 * The cap of one host (doctor's): per dimension its budget where that is a number (the project's `share` of it when the
 * project has a `hostShare`), else (budget `off` or unknown) the host's own total (`{ memMiB, cpuCenti }`, the
 * runtime's memory and CPU count), else null: no cap known.
 */
export function hostCap(budget, total, share = null) {
	return { memMiB: capDim(shareOf(budget?.memMiB, share)) ?? capDim(total?.memMiB), cpuCenti: capDim(shareOf(budget?.cpuCenti, share)) ?? capDim(total?.cpuCenti) };
}

/**
 * The cap across live hosts (the panel's and the insights page's), judged per host on its OWN pair of budgets: in each
 * dimension, the largest budget of a host whose OTHER dimension holds the project's current size (`off` and unknown
 * hold anything), each budget taken as the project's `share` of it where the project has a `hostShare`. A host that publishes `off` or nothing in a dimension gives no number there (the panel cannot read
 * a host's memory or CPU count), so where no host gives one the cap is null and a raise offers no call. The largest
 * per dimension across DIFFERENT hosts would be a pair no host has.
 */
export function fleetCap(budgets, current, share = null) {
	const { memMiB, cpuCenti } = fleetCapWhy(budgets, current, share);
	return { memMiB: memMiB.cap, cpuCenti: cpuCenti.cap };
}

/** `fleetCap` with, per dimension, why no cap is known: `{ memMiB: { cap, missing }, cpuCenti: { cap, missing } }`. */
function fleetCapWhy(budgets, current, share) {
	const list = (Array.isArray(budgets) ? budgets : []).filter((b) => b !== null && typeof b === "object");
	const holds = (v, need) => !Number.isSafeInteger(v) || shareOf(v, share) >= need;
	const best = (key, other, need) => {
		const known = list.filter((b) => holds(b[other], need)).map((b) => capDim(shareOf(b[key], share))).filter((v) => v !== null);
		if (known.length > 0) return { cap: Math.max(...known), missing: null };
		if (list.some((b) => capDim(b[key]) !== null)) return { cap: null, missing: "none-holds" };
		return { cap: null, missing: list.length > 0 && list.every((b) => b[key] === Infinity) ? "off" : "unread" };
	};
	return { memMiB: best("memMiB", "cpuCenti", current?.cpuCenti), cpuCenti: best("cpuCenti", "memMiB", current?.memMiB) };
}

/**
 * How one host's admission refuses `pair` for ever, per dimension, or null when it may start there some day: the
 * worker's own `neverFits` (host-budget.mjs) restated, since this module imports nothing heavy, and held equal to it
 * over a grid by size-suggest.test.mjs. A dimension above the whole budget is `host`; only when neither is, a dimension
 * above the project's `share` of it is `share`. `off` (Infinity) and unknown (null) refuse nothing.
 */
function refusedOn(pair, budget, share) {
	const over = (k, pct) => Number.isSafeInteger(budget[k]) && BigInt(pair[k]) * 100n > BigInt(pct) * BigInt(budget[k]);
	const host = { memMiB: over("memMiB", 100), cpuCenti: over("cpuCenti", 100) };
	if (host.memMiB || host.cpuCenti) return { memMiB: host.memMiB ? "host" : null, cpuCenti: host.cpuCenti ? "host" : null };
	if (share === null || share === undefined) return null;
	const part = { memMiB: over("memMiB", share), cpuCenti: over("cpuCenti", share) };
	return part.memMiB || part.cpuCenti ? { memMiB: part.memMiB ? "share" : null, cpuCenti: part.cpuCenti ? "share" : null } : null;
}

/**
 * THE ONE RULE for offering an apply call (DES-SIZE-SUGGESTIONS): a call is offered exactly when admission would
 * accept the suggested job, the pair `{ memMiB, cpuCenti }` (each dimension the suggested size, or the current one where
 * nothing is suggested). Doctor passes its one host's budget, the panel and the insights page the live hosts' budgets.
 * Only a host that published an integer budget in some dimension is judged: with every budget `off` or unknown,
 * admission refuses nothing, so the call is offered. The call is withheld when EVERY judged host refuses the pair (for
 * doctor: its host refuses it). Returns null (offer the call) or the refusal, `{ memMiB, cpuCenti }`, each `host`
 * (above every judged host's budget), `share` (above the project's `hostShare` of every judged host's budget) or null
 * (not refused by every judged host in that dimension: then the pair as a whole is what no host admits).
 */
export function sizeRefusal(pair, budgets, share = null) {
	const judged = (Array.isArray(budgets) ? budgets : []).filter((b) => b !== null && typeof b === "object" && (Number.isSafeInteger(b.memMiB) || Number.isSafeInteger(b.cpuCenti)));
	if (judged.length === 0) return null;
	const each = judged.map((b) => refusedOn(pair, b, share));
	if (each.some((r) => r === null)) return null;
	const dim = (k) => (each.every((r) => r[k] !== null) ? (each.every((r) => r[k] === "host") ? "host" : "share") : null);
	return { memMiB: dim("memMiB"), cpuCenti: dim("cpuCenti") };
}

/**
 * A refusal (`sizeRefusal`) in words, naming the dimension that does not fit: `memory 6g is above this host's budget
 * (4g)`, `its 4 CPUs are above its hostShare (40%) of this host's budget (3.2 CPUs)`. A dimension the suggestion changes
 * is named by its new size, one it keeps by "its". With `budget` (doctor's one host) the words are that host's and name
 * its limit; without it (the panel) they speak of every live host.
 */
export function refusalWords(refusal, suggestion, share = null, budget = null) {
	if (refusal === null || refusal === undefined) return "";
	const where = budget === null ? "every live host's budget" : "this host's budget";
	const m = suggestion?.memory ?? {};
	const c = suggestion?.cpu ?? {};
	const mem = m.suggested ?? m.current;
	const cpus = c.suggested ?? c.current;
	const limit = (k, kind, text) => (budget === null || !Number.isSafeInteger(budget[k]) ? "" : ` (${text(kind === "share" ? Math.floor((budget[k] * share) / 100) : budget[k])})`);
	const above = (k, kind, text) => `above ${kind === "share" ? `its hostShare (${share}%) of ${where}` : where}${limit(k, kind, text)}`;
	const parts = [];
	if (refusal.memMiB) parts.push(`${m.suggested ? "memory" : "its memory"} ${formatMemory(mem)} is ${above("memMiB", refusal.memMiB, formatMemory)}`);
	if (refusal.cpuCenti) parts.push(`${c.suggested ? "" : "its "}${cpusText(cpus)} ${cpus === 100 ? "is" : "are"} ${above("cpuCenti", refusal.cpuCenti, cpusText)}`);
	return parts.length > 0 ? parts.join(" and ") : `memory ${formatMemory(mem)} with ${cpusText(cpus)} fits no live host's budget`;
}

/**
 * The suggestion for one project. Pure: no I/O, no clock read (`now` is injected, millis or a Date).
 *
 * `records` is any list of run records (other projects' are skipped), `current` the project's size now (`{ memMiB,
 * cpuCenti }`, `resolveJobSize`'s answer), `cap` the largest size a raise may reach on ONE host (`{ memMiB, cpuCenti }`,
 * each an integer or null for unknown; `hostCap`), or instead `hosts`, the live hosts' budget pairs (`fleetCap` judges
 * them per host, against the size the other dimension will have), and `hostShare` the project's row's share (an
 * integer percent, or null), which caps each integer budget at floor(budget x hostShare / 100) on the `hosts` path (on
 * the `cap` path the caller passes `hostCap(budget, total, hostShare)`).
 *
 * Returns `{ project, runs, memory, cpu }`: `runs` the records read (after the window), and per dimension `{ current,
 * suggested, reason, evidence, fact, held, wanted, overBudget }`, where `suggested` is null when the size should stay,
 * `reason` one of `MEMORY_REASONS` / `CPU_REASONS`, `fact` one of `SIZE_FACTS` or null, `held` one of `MEMORY_HELD` or
 * null, `cap` the cap the dimension was judged against (null for none known), `capMissing` one of `MEMORY_CAP_MISSING` where a `hosts` raise is held `no-cap` (else null), `wanted` the raise before the cap (null for no raise), and `overBudget` true when a suggested LOWERING is still
 * above the cap (a size already larger than the host). NEVER throws on records.
 */
export function suggestSize({ project, records = [], current, cap = null, hosts = null, hostShare = null, now }) {
	const nowMs = now instanceof Date ? now.getTime() : now;
	if (!Number.isFinite(nowMs)) throw new TypeError("suggestSize needs `now` (millis or a Date)");
	if (recordedJobSize({ ...current, source: "project" }) === null) throw new TypeError("suggestSize needs the current size ({ memMiB, cpuCenti })");
	const runs = windowRuns(project, records, nowMs);
	// With `hosts`, each dimension's cap is judged per host against the size the OTHER dimension will have: the CPUs are
	// decided first (they have no raise, so no cap bends them), then the memory against the hosts that hold those CPUs,
	// then the CPUs' flag against the hosts that hold that memory.
	const fleet = Array.isArray(hosts);
	const capOf = (other) => (fleet ? fleetCapWhy(hosts, other, hostShare) : { memMiB: { cap: cap?.memMiB, missing: null }, cpuCenti: { cap: cap?.cpuCenti, missing: null } });
	const cpu = suggestCpus(runs, current.cpuCenti);
	const memWhy = capOf({ memMiB: current.memMiB, cpuCenti: cpu.suggested ?? current.cpuCenti }).memMiB;
	const memCap = capDim(memWhy.cap);
	const memory = suggestMemory(runs, current.memMiB, memCap);
	const cpuCap = capDim(capOf({ memMiB: memory.suggested ?? current.memMiB, cpuCenti: current.cpuCenti }).cpuCenti.cap);
	const above = (dim, c) => dim.suggested !== null && c !== null && dim.suggested > c;
	const capMissing = memory.held === "no-cap" ? memWhy.missing : null;
	return { project, runs: runs.length, memory: { ...memory, cap: memCap, capMissing, overBudget: above(memory, memCap) }, cpu: { ...cpu, cap: cpuCap, capMissing: null, overBudget: above(cpu, cpuCap) } };
}

/**
 * The exact admin call that applies a suggestion, or null when there is nothing to apply: `dispatch_limit_edit` with the
 * index of the project's `project:<id>` row in `limits` (the parsed scoped-limits rows, in file order) and only the
 * changed fields, or `dispatch_limit_add` with the row's scope when the project has none. Fields in the one spelling the
 * parser stores (`formatMemory`, `formatCpus` as a number).
 */
export function suggestionCall(suggestion, limits = []) {
	const fields = {};
	if (suggestion?.memory?.suggested) fields.memory = formatMemory(suggestion.memory.suggested);
	if (suggestion?.cpu?.suggested) fields.cpus = Number(formatCpus(suggestion.cpu.suggested));
	if (Object.keys(fields).length === 0) return null;
	const scope = `project:${suggestion.project}`;
	const index = (Array.isArray(limits) ? limits : []).findIndex((l) => l?.scope === scope);
	return index >= 0 ? `dispatch_limit_edit ${JSON.stringify({ index, ...fields })}` : `dispatch_limit_add ${JSON.stringify({ scope, ...fields })}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Cores in words: `1 core`, `0.5 cores`, `2 cores`. */
export const coresText = (centi) => `${formatCpus(centi)} core${centi === 100 ? "" : "s"}`;
/** CPUs in words: `1 CPU`, `0.5 CPUs`, `2 CPUs`. */
export const cpusText = (centi) => `${formatCpus(centi)} CPU${centi === 100 ? "" : "s"}`;

/**
 * The evidence of a suggestion in words, for doctor, the panel and the insights page alike: `{ memory, cpu, memoryHeld,
 * memoryFact, cpuFact }`, each a short clause (empty when it does not apply), such as `2 runs ended oom-killed (the
 * largest size killed 4g)` or `p95 peak 2560m, largest 3g, over 24 runs`. Ids and numbers only. A fact is worded as
 * information and a held raise as what the host offers: none of them is an instruction, and none advises growing a
 * host's budget.
 */
export function suggestionEvidence(suggestion) {
	const m = suggestion?.memory ?? {};
	const c = suggestion?.cpu ?? {};
	const me = m.evidence ?? {};
	const ce = c.evidence ?? {};
	const peaks = `p95 peak ${formatMemory(me.p95MiB ?? 0)}, largest ${formatMemory(me.maxPeakMiB ?? 0)}, over ${plural(me.samples, "run")}`;
	const cores = `p95 ${coresText(ce.p95CoresCenti ?? 0)} used, largest ${coresText(ce.maxCoresCenti ?? 0)}, over ${plural(ce.samples, "run")}`;
	const memWords = {
		"oom-killed": `${plural(me.ooms, "run")} ended oom-killed (the largest size killed ${formatMemory(me.largestOomMiB ?? 0)})`,
		"not-enough-runs": `${me.samples} of the ${SUGGEST_MIN_SAMPLES} runs with measurements it needs`,
		oversized: peaks,
		fits: peaks,
	};
	const cpuWords = {
		"not-enough-runs": `${ce.samples} of the ${SUGGEST_MIN_SAMPLES} runs with measurements it needs`,
		underused: cores,
		fits: cores,
	};
	const wanted = Number.isSafeInteger(m.wanted) ? formatMemory(m.wanted) : "";
	const heldWords = {
		cap: `this project's runs need more than this host offers: they ask for ${wanted}, the largest here is ${formatMemory(m.suggested ?? 0)}`,
		// a size ABOVE the cap (set by hand, or a hostShare lowered since) is not "at" the largest: say which it is
		largest: Number.isSafeInteger(m.cap) && m.current > m.cap ? `already above the largest size this host offers (${formatMemory(m.cap)})` : "already at the largest size this host offers",
		"no-cap": `they ask for ${wanted}, but the largest size this host offers is not known here, so no call is offered`,
	};
	return {
		memory: memWords[m.reason] ?? "",
		cpu: cpuWords[c.reason] ?? "",
		memoryHeld: heldWords[m.held] ?? "",
		memoryFact: m.fact === "pressure" ? `${me.pressured} of ${plural(me.samples, "run")} reached the memory limit while stalled for memory more than 1% of their time` : "",
		cpuFact: c.fact === "ceiling" ? `the median run was held back ${ce.throttledPct}% of its time by this host's CPU ceiling (its CPU budget, shared by every job), which a job's cpus do not change` : "",
	};
}
