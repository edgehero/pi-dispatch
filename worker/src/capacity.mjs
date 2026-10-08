/**
 * How busy each host is and was (issue #599, DES-CAPACITY-FROM-RECORDS): ONE pure function, `computeCapacity`, over
 * run records (INT-RUN-HISTORY-FILE-CONTRACT) and the live host rows, which the CLI (`pi-dispatch capacity`) calls and
 * every later surface will, so they can never disagree. The report is `INT-CAPACITY-REPORT`.
 *
 * Pure: no clock, no filesystem, no Valkey. It imports only other pure modules of this project (the size and wait
 * vocabularies, the worker-name and project-id rules), so the admin bundle can inline it. It reads a record's
 * `capacity` itself (`capacityOf`) rather than importing the writer's `recordedCapacity`, which lives beside the record
 * writer's filesystem code; a test holds the two to the same answers.
 *
 * JOBS ONLY. Busy means "a job of this deployment held a slot here", read from the records alone: no host load is
 * sampled, so a machine busy with other work reads as idle, and every surface says so.
 *
 * WHICH RECORDS HELD A SLOT (`occupancyOf`). A record written since #599 says it outright: `capacity` is an object on a
 * run the processor admitted and null on every refusal before a slot. An older record has no such key, and is
 * inferred: a refusal reason the processor gives before a slot (the wait gate's, the never-fits pair) did not hold one;
 * otherwise it did when it ran at least `LEGACY_MIN_WALL_MS` or reported `resources` (a container ran). Each inference is
 * counted, both ways, never hidden.
 *
 * THE SPAN is the record's `startedAt` (set when the job was admitted, index.mjs) to its `endedAt`. A span that is not
 * readable, ends before it starts, runs longer than `SUGGEST_MAX_WALL_MS` or ends more than `SUGGEST_CLOCK_SKEW_MS` in
 * the future is not counted, and is counted as `unreadable`: the same bounds a size suggestion reads a wall time by. So
 * is a record whose host is not a worker name or whose project is not a project id: neither can come from a worker,
 * and both are printed to a terminal.
 *
 * MISSING HISTORY IS NEVER IDLE, and it is judged PER HOST. A host's history starts where the best source that holds
 * ALL of its runs starts: this host's own files (and a peer's, on a shared logs directory) from the log retention on,
 * and a named host's runs in the run mirror from the mirror's own start on (its window, its cap, and the fleet horizon
 * every writer's trim raises). A host no source holds (a live worker with no `PI_WORKER_NAME`, seen from another host)
 * is missing for the whole window. Missing time is counted in neither busy nor idle, so busy + idle + missing is the
 * window for every host, and a truncated history can never read as a quiet machine.
 *
 * A JOB RUNNING NOW has no record yet, so the live rows supply it (issue #599, phase 2): each host row lists the jobs
 * it runs (`jobs`, live-jobs.mjs), and each is counted as an occupied interval from its admission to now, with its size
 * and project, marked live (no wait, no CPU measured) and counted in `live`, never in `used`. Only what the row can
 * vouch for: a row that has not beaten within `LIVE_FRESH_MS` vouches only up to its last beat, so the interval ends
 * there; a job whose record is already in the window (it ended between the beat and this read) is the record's; an
 * orphan (`o`, a container whose stop did not take) is not counted, since its record already covers its run; and a
 * running job the row does not list (past its 32, an entry its allowlist drops, a worker from before the field, a host
 * whose history is not shared) is counted in `liveNotCounted`, never guessed. A row whose `jobs` value is there and is
 * not a list says nothing about how many it runs: that host is counted in `liveUnreadable`, and `running` is unknown
 * (null). A listed job is matched to its record by the id as the row publishes it (`publishedJobId`).
 *
 * RETRIES AND STALLS. A retry's record replaces its earlier attempt's, so the record carries those attempts' slot
 * intervals (`earlier`), each counted as an occupied interval on its own host with its size (no wait, no CPU measured).
 * A pickup after a stall (`stalledRepick`) follows a pickup that wrote no record, whose time is unknown: it is counted,
 * and said, never guessed. Neither adds a wait.
 *
 * THE CAPACITY IN FORCE. Every admitted run recorded what its host offered when it started, so the host's capacity is a
 * step function of time (each recorded value holds from its run's start until the next one; before the first, the first
 * holds). Each piece of time is judged against the capacity in force then: the slot count for "full", the budget for
 * what was promised, the host's CPUs for what was used. A promise above 100% is then a real over-commit (a budget
 * lowered while jobs ran), and is reported as one. CPU used never is: in every moment the jobs' measured CPU time is
 * held to the host's CPUs, so a container that inflates its own numbers cannot push the host past what it has.
 *
 * INTEGER MATH. Every instant is a millisecond count from `Date.parse` (a safe integer), and every span, busy, idle and
 * full time is at most the window, so those stay Numbers. A sum of run time is NOT bounded by the window (it is the
 * window times the concurrency), and a product with a memory size, a CPU size or a CPU time can pass 2^53 (256 CPUs of
 * CPU time over 7 days is about 1.5e14 microseconds before it is multiplied by a span), so every such sum and product is
 * a BigInt, and only the final per-mille ratios, rounded half up, come back as Numbers.
 */

import { WORKER_NAME_RE } from "./worker-name.mjs";
import { JOB_CPUS_CEILING_CENTI, SIZE_REFUSAL_REASONS, recordedJobSize } from "./job-size.mjs";
import { isProjectId } from "./project-id.mjs";
import { HOST_BEAT_MS } from "./host-registry.mjs";
import { parseJobsMore, parseLiveJobs, publishedJobId } from "./live-jobs.mjs";
import { recordedEarlier } from "./run-earlier.mjs";
import { SUGGEST_CLOCK_SKEW_MS, SUGGEST_MAX_WALL_MS } from "./size-suggest.mjs";
import { WAIT_REFUSAL_REASONS } from "./wait-for.mjs";

/** The report's version (`INT-CAPACITY-REPORT`). */
export const CAPACITY_REPORT_VERSION = 1;
/** A record from before `capacity` held a slot when it ran at least this long (or reported `resources`). */
export const LEGACY_MIN_WALL_MS = 1000;
/** How many projects a host lists by name; the rest are summed as other. */
export const CAPACITY_TOP_PROJECTS = 5;
/** The most buckets one report splits its window into, so a caller's mistake cannot cost a render its memory. */
export const CAPACITY_MAX_BUCKETS = 10_000;
/**
 * How recent a host row's beat must be for its running jobs to count up to NOW: two beats. A row older than that (its
 * worker slow, stopped or gone, the row not yet expired) vouches for its jobs only up to its last beat.
 */
export const LIVE_FRESH_MS = 2 * HOST_BEAT_MS;
/** The refusal reasons the processor gives BEFORE a job holds a slot: a legacy record carrying one never held one. */
export const PRE_SLOT_REFUSAL_REASONS = Object.freeze([...WAIT_REFUSAL_REASONS, ...SIZE_REFUSAL_REASONS]);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/**
 * The windows a surface offers, each with the bucket its timeline is split into: an hour over a day, six hours over a
 * week, a day over thirty. One table, so the CLI, doctor and the panel name the same three.
 */
export const CAPACITY_WINDOWS = Object.freeze({
	"24h": Object.freeze({ ms: DAY_MS, bucketMs: HOUR_MS }),
	"7d": Object.freeze({ ms: 7 * DAY_MS, bucketMs: 6 * HOUR_MS }),
	"30d": Object.freeze({ ms: 30 * DAY_MS, bucketMs: DAY_MS }),
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
/** A host name a worker can have written (config.mjs `WORKER_NAME_RE`, the rule `PI_WORKER_NAME` is held to). */
const isHostName = (v) => typeof v === "string" && WORKER_NAME_RE.test(v);
const UNKNOWN_CAPACITY = Object.freeze({ slots: null, memMiB: null, cpuCenti: null, cpus: null });

/**
 * Whether a record held a slot: `{ occupied, inferred }`, or null when it cannot be told (a `capacity` that is neither
 * an object nor null). `inferred` is true for a record from before `capacity` existed.
 */
export function occupancyOf(record) {
	if (!isObject(record)) return null;
	if ("capacity" in record) {
		if (record.capacity === null) return { occupied: false, inferred: false };
		return isObject(record.capacity) ? { occupied: true, inferred: false } : null;
	}
	if (PRE_SLOT_REFUSAL_REASONS.includes(record.reason)) return { occupied: false, inferred: true };
	const start = Date.parse(record.startedAt ?? "");
	const end = Date.parse(record.endedAt ?? "");
	const wall = Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN;
	return { occupied: wall >= LEGACY_MIN_WALL_MS || isObject(record.resources), inferred: true };
}

/**
 * A record's `capacity` as this report reads it, the writer's rule (run-history.mjs `recordedCapacity`) restated (see
 * the header): `{ slots, memMiB, cpuCenti, cpus }`, each a positive integer (a budget may be 0), `"off"` for a budget
 * switched off, or null; null for anything that is not an object.
 */
export function capacityOf(value) {
	if (!isObject(value)) return null;
	const positive = (v) => (Number.isSafeInteger(v) && v >= 1 ? v : null);
	const budget = (v) => (v === "off" ? "off" : isCount(v) ? v : null);
	return { slots: positive(value.slots), memMiB: budget(value.memMiB), cpuCenti: budget(value.cpuCenti), cpus: positive(value.cpus) };
}

/** A live host row's capacity (host-registry.mjs strings): the slot count and both budgets; the CPU count is not published. */
function liveCapacityOf(row) {
	const int = (s) => (typeof s === "string" && /^\d{1,15}$/.test(s) ? Number(s) : null);
	const budget = (s) => (s === "off" ? "off" : int(s));
	const slots = int(row?.concurrency);
	return { slots: slots !== null && slots >= 1 ? slots : null, memMiB: budget(row?.budgetMemMiB), cpuCenti: budget(row?.budgetCpuCenti), cpus: null };
}

const sameCapacity = (a, b) => a.slots === b.slots && a.memMiB === b.memMiB && a.cpuCenti === b.cpuCenti && a.cpus === b.cpus;
const positiveInt = (v) => Number.isSafeInteger(v) && v > 0;
/** What CPU promises are judged against: the CPU budget, or every CPU of the host where the budget is off or unknown. */
const promiseCpuCenti = (c) => (positiveInt(c.cpuCenti) ? c.cpuCenti : positiveInt(c.cpus) ? c.cpus * 100 : null);
/**
 * The most CPU one job can use, in hundredths: its `--cpus` is the host's CPU budget (capped at the runtime's count),
 * so the smaller of the two that are known, else the size ceiling.
 */
const jobCpuCeilingCenti = (c) => {
	const known = [positiveInt(c.cpuCenti) ? c.cpuCenti : null, positiveInt(c.cpus) ? c.cpus * 100 : null].filter((v) => v !== null);
	return known.length > 0 ? Math.min(...known) : JOB_CPUS_CEILING_CENTI;
};

/**
 * The most CPU this host's jobs could use TOGETHER, in hundredths: the host's CPUs, which is physically true; null when
 * not known. Not the CPU budget: the parent cgroup quota that holds the jobs to it (`cpu-reserve.mjs`) is not set
 * where only root can set it, so the budget is not a proven ceiling.
 */
const segmentCpuCeilingCenti = (c) => (positiveInt(c.cpus) ? c.cpus * 100 : null);

/** A record's span `{ start, end, wallMs }` in millis, or null when it is not one this report counts (see the header). */
function spanOf(record, nowMs) {
	const start = Date.parse(record.startedAt ?? "");
	const end = Date.parse(record.endedAt ?? "");
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
	if (end - start > SUGGEST_MAX_WALL_MS || end > nowMs + SUGGEST_CLOCK_SKEW_MS) return null;
	return { start, end, wallMs: end - start };
}

/** num / den in thousandths, rounded half up, as a Number; null when the denominator is 0. Both BigInt. */
function perMille(num, den) {
	if (den <= 0n) return null;
	return Number((num * 2000n + den) / (den * 2n));
}

/** The nearest-rank percentile of a sorted array: the value at rank ceil(p/100 x n). size-suggest's rule. */
const rank = (sorted, pct) => sorted[Math.max(0, Math.ceil((pct * sorted.length) / 100) - 1)];

const zeroCounts = () => ({ used: 0, refusedBeforeSlot: 0, legacyOccupied: 0, legacyRefused: 0, withoutSize: 0, withoutResources: 0, cpuClamped: 0, retried: 0, earlier: 0, stalledRepick: 0, live: 0, liveNotCounted: 0, liveUnreadable: 0, orphans: 0 });

/**
 * A live row's running jobs: `{ jobs, notListed, unreadable }`, `jobs` the listed entries through live-jobs.mjs'
 * allowlist (a row from `readLiveHosts` is parsed already; a raw string is parsed here, the same rule) or null when the
 * row lists none, `notListed` the running jobs it reports and does not list (its `jobsMore`, or a worker from before
 * `jobs`: its budget's `budgetRunning`), null when it says nothing. `unreadable` is a row that HAS a `jobs` value that
 * is not a list (`readLiveHosts` flags it `jobsUnreadable`): how many it runs is then unknown, and nothing stands in.
 */
function rowJobsOf(row) {
	const parsed = parseLiveJobs(row?.jobs);
	if (parsed.jobs === null) {
		if (row?.jobsUnreadable === true || (row?.jobs !== undefined && row?.jobs !== null && row?.jobs !== "")) return { jobs: null, notListed: null, unreadable: true };
		const n = typeof row?.budgetRunning === "string" && /^\d{1,9}$/.test(row.budgetRunning) ? Number(row.budgetRunning) : null;
		return { jobs: null, notListed: n, unreadable: false };
	}
	return { jobs: parsed.jobs, notListed: (parseJobsMore(row.jobsMore) ?? 0) + parsed.dropped, unreadable: false };
}

/**
 * Where each host's history starts: `Map<name, { fromMs, source, truncated } | null>`, null for a host no source holds.
 * With no source described at all (`coverage.local` and `coverage.mirror` both undefined: a caller with records and
 * nothing else), every host is covered from `coverage.fromMs` (else the window start).
 */
function hostCoverage(names, liveByName, coverage, windowStartMs, nowMs) {
	const clamp = (ms) => Math.min(nowMs, Math.max(windowStartMs, Number.isSafeInteger(ms) ? ms : windowStartMs));
	const out = new Map();
	if (coverage.local === undefined && coverage.mirror === undefined) {
		for (const name of names) out.set(name, { fromMs: clamp(coverage.fromMs), source: typeof coverage.source === "string" ? coverage.source : "records", truncated: coverage.truncated === true });
		return out;
	}
	const localHosts = new Set(Array.isArray(coverage.localHosts) ? coverage.localHosts : []);
	if (isHostName(coverage.localHost)) localHosts.add(coverage.localHost);
	const mirrorHosts = new Set(Array.isArray(coverage.mirror?.hosts) ? coverage.mirror.hosts : []);
	for (const name of names) {
		const options = [];
		if (isObject(coverage.local) && localHosts.has(name)) options.push({ fromMs: clamp(coverage.local.fromMs), source: "local", truncated: false });
		const row = liveByName.get(name);
		// A named host's runs are all in the mirror (its row says it routes), and so are those of a host with no live row
		// whose runs the mirror holds; a live row that does NOT route is a worker without `PI_WORKER_NAME`, which mirrors none.
		if (isObject(coverage.mirror) && (row ? row.routes === "true" : mirrorHosts.has(name))) options.push({ fromMs: clamp(coverage.mirror.fromMs), source: "mirror", truncated: coverage.mirror.truncated === true });
		options.sort((a, b) => a.fromMs - b.fromMs);
		out.set(name, options[0] ?? null);
	}
	return out;
}

/**
 * The capacity report (`INT-CAPACITY-REPORT`): `{ v, window, coverage, hosts }`.
 *
 * - `records`: run records, already merged (one per job id).
 * - `live`: the live host rows (`readLiveHosts`), `[]` when unknown. Each gives a host its CURRENT capacity where no
 *   record in the window recorded one, and says whether it mirrors its runs (`routes`).
 * - `windowStartMs`, `nowMs`: the window, integers; `bucketMs` splits it from its start (the last bucket ends at now).
 * - `coverage`: what the reader could see (capacity-records.mjs): `{ source, reason, localHost, localHosts, local:
 *   { fromMs } | null, mirror: { fromMs, truncated, hosts } | null }`, `local` null when this host's files could not be
 *   read and `mirror` null when the mirror was not read. Without either key, every host is covered from
 *   `coverage.fromMs`.
 *
 * Throws a RangeError on a window or bucket this function cannot honour: those are the caller's mistake, not data.
 */
export function computeCapacity({ records = [], live = [], windowStartMs, nowMs, bucketMs, coverage = {} } = {}) {
	if (!Number.isSafeInteger(windowStartMs) || !Number.isSafeInteger(nowMs) || windowStartMs >= nowMs) throw new RangeError("the window must be two integer instants, start before now");
	if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) throw new RangeError("bucketMs must be a positive integer");
	const windowMs = nowMs - windowStartMs;
	const bucketCount = Math.ceil(windowMs / bucketMs);
	if (bucketCount > CAPACITY_MAX_BUCKETS) throw new RangeError(`at most ${CAPACITY_MAX_BUCKETS} buckets (got ${bucketCount})`);

	const liveByName = new Map((Array.isArray(live) ? live : []).filter((row) => isHostName(row?.name)).map((row) => [row.name, row]));
	let unreadable = 0;
	let withoutHost = 0;
	let earlierDropped = 0;

	// PASS 1: every record judged once, so the hosts (and so each host's coverage) are known before anything is counted.
	const judged = [];
	const earlierRuns = [];
	for (const record of Array.isArray(records) ? records : []) {
		const occupancy = occupancyOf(record);
		const project = record?.project ?? null;
		if (occupancy === null || (project !== null && !isProjectId(project))) {
			unreadable++;
			continue;
		}
		if (record.host === null || record.host === undefined) {
			withoutHost++;
			continue;
		}
		if (!isHostName(record.host)) {
			unreadable++;
			continue;
		}
		judged.push({ record, occupancy, project, span: spanOf(record, nowMs) });
		// The slot time of the job's EARLIER attempts, which this record carries because it replaced theirs: each an
		// occupied interval on its own host, with its size and nothing else known (no wait, no CPU measurement).
		// Rebuilt by the writer's own rule (`recordedEarlier`: valid entries, the newest EARLIER_MAX), and an entry that
		// overlaps this record's own span on its own host dropped: one job's attempts cannot hold one host's slot twice at
		// once. Every entry not kept is counted.
		const given = Array.isArray(record.earlier) ? record.earlier.length : 0;
		const rebuilt = recordedEarlier(record.earlier) ?? [];
		const own = spanOf(record, nowMs);
		const kept = rebuilt.filter((e) => !(own !== null && e.host === record.host && Date.parse(e.startedAt) < own.end && Date.parse(e.endedAt) > own.start));
		earlierDropped += given - kept.length;
		for (const e of kept) {
			const eSpan = spanOf(e, nowMs);
			if (eSpan === null) {
				earlierDropped++;
				continue;
			}
			const eSize = positiveInt(e.memMiB) && positiveInt(e.cpuCenti) ? { memMiB: e.memMiB, cpuCenti: e.cpuCenti } : null;
			earlierRuns.push({ host: e.host, span: eSpan, size: eSize, project });
		}
	}
	// The newest admission among each job id's records, so a job the live row still lists after its record was written
	// (it ended between the beat and this read) is counted once, as the record.
	const recordedFrom = new Map();
	for (const { record, span } of judged) {
		// Keyed by the id AS A ROW PUBLISHES IT (`publishedJobId`): an id outside the row's charset is its digest there.
		const id = typeof record.jobId === "string" ? publishedJobId(record.jobId) : null;
		if (id !== null && span !== null) recordedFrom.set(id, Math.max(recordedFrom.get(id) ?? -Infinity, span.start));
	}
	const names = new Set([...liveByName.keys()]);
	for (const j of judged) names.add(j.record.host);
	for (const e of earlierRuns) names.add(e.host);
	const covers = hostCoverage(names, liveByName, coverage, windowStartMs, nowMs);

	const byHost = new Map();
	const hostOf = (name) => {
		if (!byHost.has(name)) byHost.set(name, { runs: [], recorded: [], waits: [], counts: zeroCounts() });
		return byHost.get(name);
	};
	for (const name of names) if (liveByName.has(name)) hostOf(name);

	// PASS 2: count each record against its host's own coverage.
	for (const { record, occupancy, project, span } of judged) {
		const cover = covers.get(record.host);
		if (cover === null) continue; // that host's history is missing as a whole, not partly
		const coveredFrom = cover.fromMs;
		if (!occupancy.occupied) {
			// A refusal is counted where it ENDED inside the covered window, the instant it happened; it took no slot time.
			const end = Date.parse(record.endedAt ?? "");
			if (Number.isFinite(end) && end >= coveredFrom && end <= nowMs + SUGGEST_CLOCK_SKEW_MS) {
				const counts = hostOf(record.host).counts;
				counts.refusedBeforeSlot++;
				if (occupancy.inferred) counts.legacyRefused++;
			}
			continue;
		}
		if (span === null) {
			unreadable++;
			continue;
		}
		const start = Math.max(span.start, coveredFrom);
		const end = Math.min(span.end, nowMs);
		// Outside the covered window. A run of no length counts where it started (it held a slot for no time, and its wait
		// is a wait like any other); one that ended exactly as the window began spent none of it.
		if (end < start || (end === start && (span.start < coveredFrom || span.start > nowMs))) continue;
		const host = hostOf(record.host);
		host.counts.used++;
		if (occupancy.inferred) host.counts.legacyOccupied++;
		const size = recordedJobSize(record.size);
		if (size === null) host.counts.withoutSize++;
		const retry = Number.isInteger(record.attempt) && record.attempt > 1;
		if (retry) host.counts.retried++;
		// A pickup after a stall: the stalled pickup wrote no record (a crash or a lost lock), so its time is unknown.
		const repick = record.stalledRepick === true;
		if (repick) host.counts.stalledRepick++;
		const recorded = capacityOf(record.capacity);
		if (recorded !== null) host.recorded.push({ at: span.start, capacity: recorded });
		const raw = record.resources?.cpuUsec;
		host.runs.push({ start, end, span, size, rawCpuUsec: isCount(raw) && span.wallMs > 0 ? raw : null, recorded, project });
		// The wait of a FIRST attempt that started inside the covered window, non-negative only: a retry's `queuedAt` is
		// its first add's, so its wait would include the earlier attempt; a clock between two hosts can put a queuedAt
		// after its own start, and that run says nothing about waiting.
		const queued = typeof record.queuedAt === "string" ? Date.parse(record.queuedAt) : NaN;
		if (!retry && !repick && Number.isFinite(queued) && span.start >= coveredFrom && span.start <= nowMs && span.start - queued >= 0) host.waits.push(span.start - queued);
	}

	for (const e of earlierRuns) {
		const cover = covers.get(e.host);
		if (cover === null) continue;
		const start = Math.max(e.span.start, cover.fromMs);
		const end = Math.min(e.span.end, nowMs);
		if (end < start || (end === start && (e.span.start < cover.fromMs || e.span.start > nowMs))) continue;
		const host = hostOf(e.host);
		host.counts.earlier++;
		host.runs.push({ start, end, span: e.span, size: e.size, rawCpuUsec: null, recorded: null, project: e.project, earlier: true });
	}

	// THE JOBS RUNNING NOW (see the header), from each live row, each an occupied interval to now (or to a stale row's
	// last beat), clipped to the host's covered window like a record.
	// `running` is what the rows say runs now: the jobs counted plus those not counted, never a listed job whose record
	// already counts it (it has ended); null when no row says anything, or when one row's list could not be read (how
	// many run on that host is unknown, so the fleet's number is too).
	let rowsSay = false;
	for (const [name, row] of liveByName) {
		const { jobs, notListed, unreadable } = rowJobsOf(row);
		const host = hostOf(name);
		const cover = covers.get(name);
		if (jobs !== null || notListed !== null) rowsSay = true;
		if (unreadable) host.counts.liveUnreadable++;
		host.counts.liveNotCounted += notListed ?? 0;
		const staleMs = Number.isSafeInteger(row.staleMs) && row.staleMs >= 0 ? row.staleMs : null;
		for (const j of jobs ?? []) {
			if (j.o) {
				host.counts.orphans++;
				continue;
			}
			if ((recordedFrom.get(j.id) ?? -Infinity) >= j.at) continue; // its record counts it (keyed as the row publishes ids)
			const end = staleMs === null ? null : staleMs <= LIVE_FRESH_MS ? nowMs : nowMs - staleMs;
			const span = end === null ? null : spanOf({ startedAt: new Date(j.at).toISOString(), endedAt: new Date(end).toISOString() }, nowMs);
			if (cover === null || cover === undefined || span === null) {
				host.counts.liveNotCounted++;
				continue;
			}
			const start = Math.max(span.start, cover.fromMs);
			const stop = Math.min(span.end, nowMs);
			if (stop < start) {
				host.counts.liveNotCounted++;
				continue;
			}
			host.counts.live++;
			const size = positiveInt(j.m) && positiveInt(j.c) ? { memMiB: j.m, cpuCenti: j.c } : null;
			host.runs.push({ start, end: stop, span, size, rawCpuUsec: null, recorded: null, project: j.p, live: true });
		}
	}

	const hosts = [];
	const totals = zeroCounts();
	const notShared = [];
	for (const name of [...byHost.keys()].sort()) {
		const h = byHost.get(name);
		const cover = covers.get(name) ?? null;
		if (cover === null) notShared.push(name);
		const coveredFrom = cover === null ? nowMs : cover.fromMs;
		const coveredMs = nowMs - coveredFrom;
		const missingMs = windowMs - coveredMs;

		// THE CAPACITY IN FORCE, a step function from the runs' own records ordered by start; before the first, the first.
		// With none recorded, the live row's (the current setting), else unknown.
		const steps = [...h.recorded].sort((a, b) => a.at - b.at);
		const row = liveByName.get(name);
		const fallback = row ? liveCapacityOf(row) : UNKNOWN_CAPACITY;
		const capAt = (t) => {
			if (steps.length === 0) return fallback;
			let found = steps[0].capacity;
			for (const s of steps) {
				if (s.at > t) break;
				found = s.capacity;
			}
			return found;
		};
		// The instants inside the covered window where the capacity in force changes.
		const changes = [];
		for (let i = 1; i < steps.length; i++) {
			if (steps[i].at > coveredFrom && steps[i].at < nowMs && !sameCapacity(steps[i].capacity, steps[i - 1].capacity)) changes.push(steps[i].at);
		}
		const newest = steps.at(-1) ?? null;
		const base = newest !== null ? newest.capacity : fallback;
		const basis = newest !== null ? "recorded" : row ? "current" : "unknown";
		const changed = steps.some((s) => !sameCapacity(s.capacity, base));

		const buckets = [];
		for (let i = 0; i < bucketCount; i++) {
			const bStart = windowStartMs + i * bucketMs;
			const bEnd = Math.min(nowMs, bStart + bucketMs);
			buckets.push({ fromMs: bStart, coveredMs: Math.max(0, bEnd - Math.max(bStart, coveredFrom)), busyMs: 0, fullMs: 0, fullKnown: false, peak: 0, runMs: 0n });
		}
		// Calls fn(bucket, a, b) for each piece of [a, b) cut at the bucket edges.
		const eachBucket = (a, b, fn) => {
			for (let i = Math.floor((a - windowStartMs) / bucketMs); i < bucketCount; i++) {
				const bStart = windowStartMs + i * bucketMs;
				if (bStart >= b) break;
				const lo = Math.max(a, bStart);
				const hi = Math.min(b, bStart + bucketMs, nowMs);
				if (hi > lo) fn(buckets[i], lo, hi);
			}
		};

		// THE SWEEP: every run's start and end, and every change of capacity, in time order (ends, then changes, then
		// starts, at one instant). Only a segment of positive length is counted, so a run that ends exactly when the next
		// begins is one slot reused, never two at once, whatever the order of the two events; sorting the end first keeps
		// the level itself true at that instant too. A segment's slot count is the one in force when it begins.
		// Each run's own CPU time first, clamped to what its job could use: its `--cpus` (the CPU budget, capped at the
		// runtime's count) over its whole wall. A run with no measurement adds nothing to CPU used.
		const clamped = new Set();
		h.runs.forEach((r, i) => {
			r.used = 0n;
			r.cpuUsec = null;
			if (r.rawCpuUsec === null) {
				if (!r.earlier && !r.live) h.counts.withoutResources++;
				return;
			}
			const most = BigInt(jobCpuCeilingCenti(r.recorded ?? capAt(r.span.start))) * BigInt(r.span.wallMs) * 10n; // hundredths x ms x 10 = microseconds
			const reported = BigInt(r.rawCpuUsec);
			if (reported > most) clamped.add(i);
			r.cpuUsec = reported > most ? most : reported;
		});
		const events = [];
		h.runs.forEach((r, i) => events.push([r.start, 1, i], [r.end, -1, i]));
		for (const t of changes) events.push([t, 0, -1]);
		events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		let level = 0;
		let at = coveredFrom;
		let busyMs = 0;
		let fullMs = 0;
		let fullKnown = false;
		let peak = 0;
		let runMs = 0n;
		let cpuUsedNum = 0n;
		const active = new Set();
		const segment = (a, b, n) => {
			if (b <= a) return;
			const cap = capAt(a);
			// CPU used in this segment: each running job's measured time spread over its wall, together never more than
			// the host's CPUs. Past it, every share is cut in proportion and the runs are counted as clamped.
			const parts = [];
			let sum = 0n;
			for (const i of active) {
				const r = h.runs[i];
				if (r.cpuUsec === null || r.span.wallMs <= 0) continue;
				const part = (r.cpuUsec * BigInt(b - a)) / BigInt(r.span.wallMs);
				parts.push([i, part]);
				sum += part;
			}
			const ceiling = segmentCpuCeilingCenti(cap);
			const most = ceiling === null ? null : BigInt(ceiling) * BigInt(b - a) * 10n;
			const cut = most !== null && sum > most;
			for (const [i, part] of parts) {
				const kept = cut ? (part * most) / sum : part;
				h.runs[i].used += kept;
				if (positiveInt(cap.cpus)) cpuUsedNum += kept;
				if (cut) clamped.add(i);
			}
			const slots = cap.slots;
			if (slots !== null) fullKnown = true;
			const full = slots !== null && n >= slots;
			if (n > 0) busyMs += b - a;
			if (full) fullMs += b - a;
			if (n > peak) peak = n;
			runMs += BigInt(n) * BigInt(b - a);
			eachBucket(a, b, (bucket, lo, hi) => {
				if (n > 0) bucket.busyMs += hi - lo;
				if (slots !== null) bucket.fullKnown = true;
				if (full) bucket.fullMs += hi - lo;
				if (n > bucket.peak) bucket.peak = n;
				bucket.runMs += BigInt(n) * BigInt(hi - lo);
			});
		};
		for (const [t, delta, i] of events) {
			segment(at, t, level);
			at = Math.max(at, t);
			level += delta;
			if (delta === 1) active.add(i);
			else if (delta === -1) active.delete(i);
		}
		segment(at, nowMs, level);
		h.counts.cpuClamped += clamped.size;

		// What was promised (CPU used is counted in the sweep above), against the capacity IN FORCE piece by piece (the
		// covered window cut at every change). A piece whose budget (or CPU count) is not a number adds to neither side of
		// its share.
		const pieces = [coveredFrom, ...changes, nowMs];
		const forEachPiece = (a, b, fn) => {
			for (let i = 0; i + 1 < pieces.length; i++) {
				const lo = Math.max(a, pieces[i]);
				const hi = Math.min(b, pieces[i + 1]);
				if (hi > lo) fn(capAt(pieces[i]), BigInt(hi - lo));
			}
		};
		let memDen = 0n;
		let cpuPromiseDen = 0n;
		let cpuUsedDen = 0n;
		forEachPiece(coveredFrom, nowMs, (c, len) => {
			if (positiveInt(c.memMiB)) memDen += BigInt(c.memMiB) * len;
			const promise = promiseCpuCenti(c);
			if (promise !== null) cpuPromiseDen += BigInt(promise) * len;
			// microseconds of CPU the host had: CPUs x ms x 1000
			if (positiveInt(c.cpus)) cpuUsedDen += BigInt(c.cpus) * len * 1000n;
		});
		let memNum = 0n;
		let cpuPromiseNum = 0n;
		const projects = new Map();
		for (const r of h.runs) {
			forEachPiece(r.start, r.end, (c, len) => {
				if (r.size !== null && positiveInt(c.memMiB)) memNum += BigInt(r.size.memMiB) * len;
				if (r.size !== null && promiseCpuCenti(c) !== null) cpuPromiseNum += BigInt(r.size.cpuCenti) * len;
			});
			const p = projects.get(r.project) ?? { runMs: 0n, cpuUsec: 0n };
			p.runMs += BigInt(r.end - r.start);
			p.cpuUsec += r.used;
			projects.set(r.project, p);
		}
		const ranked = [...projects.entries()].sort((a, b) => (b[1].runMs > a[1].runMs ? 1 : b[1].runMs < a[1].runMs ? -1 : String(a[0] ?? "").localeCompare(String(b[0] ?? ""))));
		const toProject = ([project, p]) => ({ project, runMs: Number(p.runMs), cpuMs: Number(p.cpuUsec / 1000n) });
		const rest = ranked.slice(CAPACITY_TOP_PROJECTS);
		const other = rest.length === 0 ? null : { count: rest.length, runMs: Number(rest.reduce((s, [, p]) => s + p.runMs, 0n)), cpuMs: Number(rest.reduce((s, [, p]) => s + p.cpuUsec, 0n) / 1000n) };

		for (const [k, v] of Object.entries(h.counts)) totals[k] += v;
		const waits = [...h.waits].sort((a, b) => a - b);
		hosts.push({
			name,
			shared: cover !== null,
			coverage: { fromMs: coveredFrom, source: cover?.source ?? null, truncated: cover?.truncated === true && coveredFrom > windowStartMs, ...h.counts },
			capacity: { ...base, basis, changed },
			coveredMs,
			missingMs,
			busyMs,
			idleMs: coveredMs - busyMs,
			fullMs: fullKnown ? fullMs : null,
			peak,
			avgMilli: perMille(runMs, BigInt(coveredMs)),
			promisedMemPerMille: perMille(memNum, memDen),
			promisedCpuPerMille: perMille(cpuPromiseNum, cpuPromiseDen),
			usedCpuPerMille: perMille(cpuUsedNum, cpuUsedDen),
			runs: h.runs.length,
			projects: ranked.slice(0, CAPACITY_TOP_PROJECTS).map(toProject),
			otherProjects: other,
			waits: { n: waits.length, p50Ms: waits.length > 0 ? rank(waits, 50) : null, p95Ms: waits.length > 0 ? rank(waits, 95) : null },
			buckets: buckets.map((b) => ({ fromMs: b.fromMs, coveredMs: b.coveredMs, busyMs: b.busyMs, fullMs: b.fullKnown ? b.fullMs : null, peak: b.peak, avgMilli: perMille(b.runMs, BigInt(b.coveredMs)) })),
		});
	}

	const covered = hosts.filter((h) => h.shared);
	return {
		v: CAPACITY_REPORT_VERSION,
		window: { fromMs: windowStartMs, toMs: nowMs, bucketMs },
		coverage: {
			source: typeof coverage.source === "string" ? coverage.source : "records",
			reason: typeof coverage.reason === "string" ? coverage.reason : null,
			// Every covered host has history from here on (the latest of their starts); each host's own is in its entry.
			fromMs: covered.length > 0 ? Math.max(...covered.map((h) => h.coverage.fromMs)) : windowStartMs,
			truncated: covered.some((h) => h.coverage.truncated),
			...totals,
			unreadable,
			withoutHost,
			earlierDropped,
			running: rowsSay && totals.liveUnreadable === 0 ? totals.live + totals.liveNotCounted : null,
			historyNotShared: notShared,
		},
		hosts,
	};
}
