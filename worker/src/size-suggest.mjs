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
 * never guessed: a run with no size cannot say whether its peak was cut off, and a run with no measurement says
 * nothing.
 *
 * THE NUMBERS ARE UNTRUSTED. `resources` is produced inside the job's container, which runs code the job controls, so
 * every number is judged again here whatever the worker judged when it wrote the record (a record is a file anyone with
 * the account can edit, and a mirrored one came over Valkey): a field that is not a safe non-negative integer is
 * IGNORED (that record leaves that dimension), and a value past what the container could hold is CLAMPED to it. A
 * peak above the record's own memory limit reads as AT the limit, which is what a job may honestly reach anyway, so
 * inflating a peak buys a job nothing it could not take by allocating. And the suggestion is NEVER applied by anything:
 * every surface names the `dispatch_limit_edit` call, and an operator confirms it.
 *
 * WHICH RUNS COUNT FOR A DIMENSION: only those given at least the CURRENT size in it. A run at a smaller size that was
 * cut off says the OLD size was too small, which is no longer the question; counted, an OOM from before a raise would
 * ask for the raise again (1.5x of the new size) until it aged out of the window. A run at a larger size counts: its
 * peak below its limit is a true measurement, which is what a lowering needs.
 *
 * MEMORY, in this order (the first that applies decides):
 *   1. an `oom-killed` run: raise to the larger of 1.5x the current size and 1.25x the p95 peak;
 *   2. more than 10% of the runs at 90% or more of their own limit: raise to 1.5x the current size. `memory.peak`
 *      counts page cache, which the kernel reclaims at the limit, so a peak AT the limit is a run that was cut off,
 *      never a true need; erring high is the safe direction;
 *   3. fewer than `SUGGEST_MIN_SAMPLES` runs: not enough runs;
 *   4. the target 1.25x the p95 peak at most 0.75x the current size: lower to the target;
 *   5. otherwise it fits.
 *   Rules 1 and 2 need no minimum: an OOM, or a run cut off, is a fact about the current size by itself.
 *   A size is rounded UP to a step: 256m up to 2g, 512m up to 8g, then 1g; never below the 512m floor.
 * CPUs (no event decides them alone, so the minimum comes first):
 *   1. fewer than `SUGGEST_MIN_SAMPLES` runs: not enough runs;
 *   2. the p50 run throttled more than 25% of its wall time: raise by 50%;
 *   3. the p95 cores used (CPU time over wall time) below 0.4x the current cpus: lower to 1.25x that p95;
 *   4. otherwise it fits.
 *   A CPU size is rounded UP to a 0.25 step, never below 0.25.
 * The wall time is the record's pickup-to-end span (`startedAt` to `endedAt`), which includes the clone before the
 * container starts, so cores used read slightly LOW; the 0.4 threshold keeps a margin for that.
 *
 * Every boundary is decided in integers (BigInt where a product can pass 2^53), so "exactly 10%" and "exactly 0.75x"
 * land on the side the rule says, on every host.
 */

import { JOB_CPUS_CEILING_CENTI, JOB_CPUS_FLOOR_CENTI, JOB_MEMORY_CEILING_MIB, JOB_MEMORY_FLOOR_MIB, formatCpus, formatMemory, recordedJobSize } from "./job-size.mjs";

/** How far back a suggestion reads: 30 days. */
export const SUGGEST_WINDOW_DAYS = 30;
/** How many runs a suggestion reads at most, newest first: 50. The window is whichever of the two is fewer runs. */
export const SUGGEST_WINDOW_RUNS = 50;
/** Fewer runs than this in a dimension and only an OOM or a cut-off run decides it. */
export const SUGGEST_MIN_SAMPLES = 10;
/**
 * How far a record's `endedAt` may lie past `now` and still count: 5 minutes, ordinary skew between hosts. A copy of
 * run-history.mjs `RECORD_CLOCK_SKEW_MS` (this module imports nothing heavy); a test holds the two equal.
 */
export const SUGGEST_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** The longest wall time a record may claim and still give a CPU sample: 7 days. A longer span is no job's. */
export const SUGGEST_MAX_WALL_MS = 7 * 24 * 60 * 60 * 1000;

/** Why a memory suggestion is what it is. */
export const MEMORY_REASONS = Object.freeze(["oom-killed", "at-limit", "not-enough-runs", "oversized", "fits"]);
/** Why a CPU suggestion is what it is. */
export const CPU_REASONS = Object.freeze(["throttled", "not-enough-runs", "underused", "fits"]);

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
 * throttledUsec }`. `memPeak` (bytes, clamped to the record's own limit) is null when absent or not a count;
 * `wallUsec`, `cpuUsec` and `throttledUsec` are null unless all three can be read (CPU time clamped to the CPU ceiling
 * over the wall time, throttled time to the wall time).
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
	let cpu = { wallUsec: null, cpuUsec: null, throttledUsec: null };
	if (Number.isSafeInteger(wallMs) && wallMs > 0 && wallMs <= SUGGEST_MAX_WALL_MS && isCount(r.cpuUsec) && isCount(r.throttledUsec)) {
		const wallUsec = wallMs * 1000;
		const cpuCap = (wallUsec * JOB_CPUS_CEILING_CENTI) / 100;
		cpu = { wallUsec, cpuUsec: Math.min(r.cpuUsec, cpuCap), throttledUsec: Math.min(r.throttledUsec, wallUsec) };
	}
	if (memPeak === null && cpu.wallUsec === null) return null;
	return { at, size, memPeak, oom: record.reason === "oom-killed", ...cpu };
}

/** a x b > c x d, exactly. */
const productAbove = (a, b, c, d) => BigInt(a) * BigInt(b) > BigInt(c) * BigInt(d);

function suggestMemory(runs, current) {
	const relevant = runs.filter((e) => e.memPeak !== null && e.size.memMiB >= current);
	const samples = relevant.length;
	const peaks = relevant.map((e) => e.memPeak).sort((a, b) => a - b);
	const p95 = samples > 0 ? rank(peaks, 95) : null;
	const ooms = relevant.filter((e) => e.oom).length;
	// at the limit: 90% or more of the run's own limit, in integers (peak x 10 >= limit x 9).
	const atLimit = relevant.filter((e) => !productAbove(e.size.memMiB * MIB, 9, e.memPeak, 10)).length;
	const evidence = { samples, p95MiB: p95 === null ? null : Math.ceil(p95 / MIB), ooms, atLimit, atLimitPct: samples > 0 ? Math.round((atLimit * 100) / samples) : 0 };
	// 1.25 x p95 in MiB, rounded up: ceil(5 x p95 / (4 x MiB)).
	const target = p95 === null ? null : Math.ceil((5 * p95) / (4 * MIB));
	const half = Math.ceil((current * 3) / 2);
	const out = (reason, suggested) => ({ current, suggested: suggested === null || suggested === current ? null : suggested, reason, evidence });
	if (ooms > 0) return out("oom-killed", roundMemoryUp(Math.max(half, target ?? 0)));
	// more than 10%: atLimit x 10 > samples.
	if (atLimit * 10 > samples) return out("at-limit", roundMemoryUp(half));
	if (samples < SUGGEST_MIN_SAMPLES) return out("not-enough-runs", null);
	// lower only when 1.25 x p95 <= 0.75 x current, that is 5 x p95 <= 3 x current (in bytes).
	if (!productAbove(5, p95, 3, current * MIB)) {
		const lower = roundMemoryUp(target);
		return lower < current ? out("oversized", lower) : out("fits", null);
	}
	return out("fits", null);
}

function suggestCpus(runs, current) {
	const relevant = runs.filter((e) => e.wallUsec !== null && e.size.cpuCenti >= current);
	const samples = relevant.length;
	// ordered by the exact fraction, never a float: a/b < c/d  <=>  a x d < c x b.
	const byFraction = (num) => (x, y) => (productAbove(num(y), x.wallUsec, num(x), y.wallUsec) ? -1 : productAbove(num(x), y.wallUsec, num(y), x.wallUsec) ? 1 : 0);
	const throttle = samples > 0 ? rank([...relevant].sort(byFraction((e) => e.throttledUsec)), 50) : null;
	const busy = samples > 0 ? rank([...relevant].sort(byFraction((e) => e.cpuUsec)), 95) : null;
	const evidence = {
		samples,
		p95CoresCenti: busy === null ? null : Math.ceil((busy.cpuUsec * 100) / busy.wallUsec),
		throttledPct: throttle === null ? null : Math.round((throttle.throttledUsec * 100) / throttle.wallUsec),
	};
	const out = (reason, suggested) => ({ current, suggested: suggested === null || suggested === current ? null : suggested, reason, evidence });
	if (samples < SUGGEST_MIN_SAMPLES) return out("not-enough-runs", null);
	// throttled more than 25% of the wall time: throttled x 4 > wall.
	if (productAbove(throttle.throttledUsec, 4, throttle.wallUsec, 1)) return out("throttled", roundCpusUp((current * 3) / 2));
	// p95 cores below 0.4 x cpus: cpuUsec / wall < 0.4 x current / 100, that is cpuUsec x 1000 < 4 x current x wall.
	if (productAbove(4 * current, busy.wallUsec, busy.cpuUsec, 1000)) {
		// 1.25 x the p95 cores, in hundredths: ceil(cpuUsec x 125 / wall).
		const lower = roundCpusUp(Number((BigInt(busy.cpuUsec) * 125n + BigInt(busy.wallUsec) - 1n) / BigInt(busy.wallUsec)));
		return lower < current ? out("underused", lower) : out("fits", null);
	}
	return out("fits", null);
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

/** Whether a size is above a budget dimension: only an integer budget can be exceeded (`off`, Infinity and unknown cannot). */
const aboveBudget = (size, budget) => size !== null && Number.isSafeInteger(budget) && size > budget;

/**
 * The suggestion for one project. Pure: no I/O, no clock read (`now` is injected, millis or a Date).
 *
 * `records` is any list of run records (other projects' are skipped), `current` the project's size now (`{ memMiB,
 * cpuCenti }`, `resolveJobSize`'s answer), `budget` the host budget it is judged against (`{ memMiB, cpuCenti }`, each an
 * integer, Infinity for off, or null for unknown; null for none known).
 *
 * Returns `{ project, runs, memory, cpu }`: `runs` the records read (after the window), and per dimension `{ current,
 * suggested, reason, evidence, overBudget }`, where `suggested` is null when the size should stay (`fits`, `not-enough-runs`,
 * or a raise already at the largest size), `reason` one of `MEMORY_REASONS` / `CPU_REASONS`, and `overBudget` true when
 * the suggested size is above that budget dimension (a job of it would never fit this host). NEVER throws on records.
 */
export function suggestSize({ project, records = [], current, budget = null, now }) {
	const nowMs = now instanceof Date ? now.getTime() : now;
	if (!Number.isFinite(nowMs)) throw new TypeError("suggestSize needs `now` (millis or a Date)");
	if (recordedJobSize({ ...current, source: "project" }) === null) throw new TypeError("suggestSize needs the current size ({ memMiB, cpuCenti })");
	const runs = windowRuns(project, records, nowMs);
	const memory = suggestMemory(runs, current.memMiB);
	const cpu = suggestCpus(runs, current.cpuCenti);
	return {
		project,
		runs: runs.length,
		memory: { ...memory, overBudget: aboveBudget(memory.suggested, budget?.memMiB) },
		cpu: { ...cpu, overBudget: aboveBudget(cpu.suggested, budget?.cpuCenti) },
	};
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

/**
 * The evidence of one dimension's suggestion in words, for doctor, the panel and the insights page alike: `{ memory,
 * cpu }`, each a short clause such as `2 runs ended oom-killed` or `p95 peak 2560m over 24 runs`. Ids and numbers only.
 */
export function suggestionEvidence(suggestion) {
	const m = suggestion?.memory?.evidence ?? {};
	const c = suggestion?.cpu?.evidence ?? {};
	const memWords = {
		"oom-killed": `${plural(m.ooms, "run")} ended oom-killed`,
		"at-limit": `${m.atLimit} of ${plural(m.samples, "run")} peaked at 90% of their memory or more`,
		"not-enough-runs": `${m.samples} of the ${SUGGEST_MIN_SAMPLES} runs with measurements it needs`,
		oversized: `p95 peak ${formatMemory(m.p95MiB ?? 0)} over ${plural(m.samples, "run")}`,
		fits: `p95 peak ${formatMemory(m.p95MiB ?? 0)} over ${plural(m.samples, "run")}`,
	};
	const cpuWords = {
		throttled: `the median run held back ${c.throttledPct}% of its time`,
		"not-enough-runs": `${c.samples} of the ${SUGGEST_MIN_SAMPLES} runs with measurements it needs`,
		underused: `p95 ${formatCpus(c.p95CoresCenti ?? 0)} cores used over ${plural(c.samples, "run")}`,
		fits: `p95 ${formatCpus(c.p95CoresCenti ?? 0)} cores used over ${plural(c.samples, "run")}`,
	};
	return { memory: memWords[suggestion?.memory?.reason] ?? "", cpu: cpuWords[suggestion?.cpu?.reason] ?? "" };
}
