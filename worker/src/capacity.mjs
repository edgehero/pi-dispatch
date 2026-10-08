/**
 * How busy each host is and was (issue #599, DES-CAPACITY-FROM-RECORDS): ONE pure function, `computeCapacity`, over
 * run records (INT-RUN-HISTORY-FILE-CONTRACT) and the live host rows, which the CLI (`pi-dispatch capacity`) calls and
 * every later surface will, so they can never disagree. The report is `INT-CAPACITY-REPORT`.
 *
 * A LEAF beside `size-suggest.mjs` and `job-size.mjs`, importing nothing else of this project's, for size-suggest's
 * reason: the admin bundle inlines it. That is why it reads a record's `capacity` itself (`capacityOf`) rather than
 * importing the writer's `recordedCapacity`; a test holds the two to the same answers.
 *
 * JOBS ONLY. Busy means "a job of this deployment held a slot here", read from the records alone: no host load is
 * sampled, so a machine busy with other work reads as idle, and every surface says so.
 *
 * WHICH RECORDS HELD A SLOT (`occupancyOf`). A record written since #599 says it outright: `capacity` is an object on a
 * run the processor admitted and null on every refusal before a slot. An older record has no such key, and is
 * inferred: it held a slot when it ran at least `LEGACY_MIN_WALL_MS` or reported `resources` (a refusal before a slot
 * writes `startedAt` equal to `endedAt` and never has a container to measure). Each inference is counted, never hidden.
 *
 * THE SPAN is the record's `startedAt` (set when the job was admitted, index.mjs) to its `endedAt`. A span that is not
 * readable, ends before it starts, runs longer than `SUGGEST_MAX_WALL_MS` or ends more than `SUGGEST_CLOCK_SKEW_MS` in
 * the future is not counted, and is counted as `unreadable`: the same bounds a size suggestion reads a wall time by.
 *
 * MISSING HISTORY IS NEVER IDLE. A window that reaches back before what the sources hold (`coverage.fromMs`: a mirror at
 * its cap, the log retention) and a live host whose history is not shared here (an unnamed worker writes no mirror) is
 * MISSING time, counted in neither busy nor idle, so busy + idle + missing is the window for every host, and a
 * truncated history can never read as a quiet machine. A job running now has no record yet and is not in the history
 * until it ends; the coverage says how many the live rows count, where they say.
 *
 * INTEGER MATH. Every instant is a millisecond count from `Date.parse` (a safe integer), and every span, busy, idle and
 * full time is at most the window, so those stay Numbers. A sum of run time is NOT bounded by the window (it is the
 * window times the concurrency), and a product with a memory size, a CPU size or a CPU time can pass 2^53 (256 CPUs of
 * CPU time over 7 days is about 1.5e14 microseconds before it is multiplied by a span), so every such sum and product is
 * a BigInt, and only the final per-mille ratios, rounded half up, come back as Numbers.
 */

import { JOB_CPUS_CEILING_CENTI, recordedJobSize } from "./job-size.mjs";
import { SUGGEST_CLOCK_SKEW_MS, SUGGEST_MAX_WALL_MS } from "./size-suggest.mjs";

/** The report's version (`INT-CAPACITY-REPORT`). */
export const CAPACITY_REPORT_VERSION = 1;
/** A record from before `capacity` held a slot when it ran at least this long (or reported `resources`). */
export const LEGACY_MIN_WALL_MS = 1000;
/** How many projects a host lists by name; the rest are summed as other. */
export const CAPACITY_TOP_PROJECTS = 5;
/** The most buckets one report splits its window into, so a caller's mistake cannot cost a render its memory. */
export const CAPACITY_MAX_BUCKETS = 10_000;

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
const isHostName = (v) => typeof v === "string" && v !== "";

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
	const start = Date.parse(record.startedAt ?? "");
	const end = Date.parse(record.endedAt ?? "");
	const wall = Number.isFinite(start) && Number.isFinite(end) ? end - start : NaN;
	return { occupied: wall >= LEGACY_MIN_WALL_MS || isObject(record.resources), inferred: true };
}

/**
 * A record's `capacity` as this report reads it, the writer's rule (run-history.mjs `recordedCapacity`) restated for the
 * leaf rule above: `{ slots, memMiB, cpuCenti, cpus }`, each a positive integer (a budget may be 0), `"off"` for a budget
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

/**
 * The capacity report (`INT-CAPACITY-REPORT`): `{ v, window, coverage, hosts }`.
 *
 * - `records`: run records, already merged (one per job id).
 * - `live`: the live host rows (`readLiveHosts`), `[]` when unknown. Each gives a host its CURRENT capacity where no
 *   record in the window recorded one, and says whether its history is shared.
 * - `windowStartMs`, `nowMs`: the window, integers; `bucketMs` splits it from its start (the last bucket ends at now).
 * - `coverage`: what the reader could see, `{ source, reason, fromMs, truncated, localHost, localHosts, mirrored }`
 *   (capacity-records.mjs). Time before `fromMs` is missing, never idle. A live host is NOT SHARED when it is neither
 *   this host, nor seen in the local files, nor a host that mirrors its runs (`routes`) to a mirror that was read.
 *
 * Throws a RangeError on a window or bucket this function cannot honour: those are the caller's mistake, not data.
 */
export function computeCapacity({ records = [], live = [], windowStartMs, nowMs, bucketMs, coverage = {} } = {}) {
	if (!Number.isSafeInteger(windowStartMs) || !Number.isSafeInteger(nowMs) || windowStartMs >= nowMs) throw new RangeError("the window must be two integer instants, start before now");
	if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) throw new RangeError("bucketMs must be a positive integer");
	const windowMs = nowMs - windowStartMs;
	const bucketCount = Math.ceil(windowMs / bucketMs);
	if (bucketCount > CAPACITY_MAX_BUCKETS) throw new RangeError(`at most ${CAPACITY_MAX_BUCKETS} buckets (got ${bucketCount})`);
	const fromMs = Number.isSafeInteger(coverage.fromMs) ? Math.min(nowMs, Math.max(windowStartMs, coverage.fromMs)) : windowStartMs;

	const liveRows = (Array.isArray(live) ? live : []).filter((row) => isHostName(row?.name));
	const localHosts = new Set(Array.isArray(coverage.localHosts) ? coverage.localHosts.filter(isHostName) : []);
	if (isHostName(coverage.localHost)) localHosts.add(coverage.localHost);
	const notShared = new Set(liveRows.filter((row) => !localHosts.has(row.name) && !(coverage.mirrored === true && row.routes === "true")).map((row) => row.name));

	const counts = { used: 0, refusedBeforeSlot: 0, legacyInferred: 0, withoutSize: 0, withoutResources: 0, unreadable: 0, withoutHost: 0 };
	const byHost = new Map();
	const hostOf = (name) => {
		if (!byHost.has(name)) byHost.set(name, { runs: [], recorded: [], waits: [], refused: 0 });
		return byHost.get(name);
	};

	for (const record of Array.isArray(records) ? records : []) {
		const occupancy = occupancyOf(record);
		if (occupancy === null) {
			counts.unreadable++;
			continue;
		}
		const span = spanOf(record, nowMs);
		if (!occupancy.occupied) {
			// A refusal is counted where it ENDED inside the window, the instant it happened; it took no slot time.
			const end = Date.parse(record.endedAt ?? "");
			if (Number.isFinite(end) && end >= windowStartMs && end <= nowMs + SUGGEST_CLOCK_SKEW_MS) {
				counts.refusedBeforeSlot++;
				if (isHostName(record.host)) hostOf(record.host).refused++;
			}
			continue;
		}
		if (span === null) {
			counts.unreadable++;
			continue;
		}
		const start = Math.max(span.start, fromMs);
		const end = Math.min(span.end, nowMs);
		if (end <= start) continue; // outside the covered window
		if (!isHostName(record.host)) {
			counts.withoutHost++;
			continue;
		}
		if (notShared.has(record.host)) continue; // that host's history is missing as a whole, not partly
		counts.used++;
		if (occupancy.inferred) counts.legacyInferred++;
		const size = recordedJobSize(record.size);
		if (size === null) counts.withoutSize++;
		const raw = record.resources?.cpuUsec;
		// Untrusted (produced inside the job's container): clamped to the most CPU a job can be given over its wall.
		const cpuUsec = isCount(raw) && span.wallMs > 0 ? BigInt(Math.min(raw, (span.wallMs * 1000 * JOB_CPUS_CEILING_CENTI) / 100)) : null;
		if (cpuUsec === null) counts.withoutResources++;
		const host = hostOf(record.host);
		host.runs.push({ start, end, wallMs: span.wallMs, size, cpuUsec, project: typeof record.project === "string" ? record.project : null });
		const recorded = capacityOf(record.capacity);
		if (recorded !== null) host.recorded.push({ at: span.start, capacity: recorded });
		// The wait of a run that STARTED inside the covered window, and only a non-negative one (a clock between two hosts
		// can put a queuedAt after its own start; that run says nothing about waiting).
		const queued = typeof record.queuedAt === "string" ? Date.parse(record.queuedAt) : NaN;
		if (Number.isFinite(queued) && span.start >= fromMs && span.start <= nowMs && span.start - queued >= 0) host.waits.push(span.start - queued);
	}
	for (const row of liveRows) hostOf(row.name);

	const hosts = [];
	for (const name of [...byHost.keys()].sort()) {
		const h = byHost.get(name);
		const shared = !notShared.has(name);
		const coveredFrom = shared ? fromMs : nowMs;
		const coveredMs = nowMs - coveredFrom;
		const missingMs = windowMs - coveredMs;

		// The capacity this host is judged against: the newest one a run in the window recorded, else the live row's,
		// else unknown. `changed` says the window saw more than one.
		const newest = h.recorded.reduce((a, b) => (a === null || b.at > a.at ? b : a), null);
		const changed = h.recorded.some((r) => newest !== null && !sameCapacity(r.capacity, newest.capacity));
		const row = liveRows.find((r) => r.name === name);
		const base = newest !== null ? newest.capacity : row ? liveCapacityOf(row) : { slots: null, memMiB: null, cpuCenti: null, cpus: null };
		const basis = newest !== null ? "recorded" : row ? "current" : "unknown";
		// CPU is judged against the CPU budget, or where that is off or unknown against every CPU of the machine.
		const cpuDenom = Number.isSafeInteger(base.cpuCenti) && base.cpuCenti > 0 ? base.cpuCenti : base.cpus !== null ? base.cpus * 100 : null;
		const memDenom = Number.isSafeInteger(base.memMiB) && base.memMiB > 0 ? base.memMiB : null;

		const buckets = [];
		for (let i = 0; i < bucketCount; i++) {
			const bStart = windowStartMs + i * bucketMs;
			const bEnd = Math.min(nowMs, bStart + bucketMs);
			buckets.push({ fromMs: bStart, coveredMs: Math.max(0, bEnd - Math.max(bStart, coveredFrom)), busyMs: 0, fullMs: 0, peak: 0, runMs: 0n });
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

		// THE SWEEP: every run's start and end in time order, ends before starts at one instant. Only a segment of positive
		// length is counted, so a run that ends exactly when the next begins is one slot reused, never two at once,
		// whatever the order of the two events; sorting the end first keeps the level itself true at that instant too.
		const events = [];
		for (const r of h.runs) events.push([r.start, 1], [r.end, -1]);
		events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		let level = 0;
		let at = coveredFrom;
		let busyMs = 0;
		let fullMs = 0;
		let peak = 0;
		let runMs = 0n;
		const segment = (a, b, n) => {
			if (b <= a) return;
			if (n > 0) busyMs += b - a;
			if (base.slots !== null && n >= base.slots) fullMs += b - a;
			if (n > peak) peak = n;
			runMs += BigInt(n) * BigInt(b - a);
			eachBucket(a, b, (bucket, lo, hi) => {
				if (n > 0) bucket.busyMs += hi - lo;
				if (base.slots !== null && n >= base.slots) bucket.fullMs += hi - lo;
				if (n > bucket.peak) bucket.peak = n;
				bucket.runMs += BigInt(n) * BigInt(hi - lo);
			});
		};
		for (const [t, delta] of events) {
			segment(at, t, level);
			at = Math.max(at, t);
			level += delta;
		}
		segment(at, nowMs, level);

		// What the runs were promised and what they used, each run weighted by the part of it inside the window. CPU used
		// is spread evenly over the run's wall time: a record carries one total, not a profile.
		let memMs = 0n;
		let cpuCentiMs = 0n;
		let cpuUsedUsec = 0n;
		const projects = new Map();
		for (const r of h.runs) {
			const len = BigInt(r.end - r.start);
			if (r.size !== null) {
				memMs += BigInt(r.size.memMiB) * len;
				cpuCentiMs += BigInt(r.size.cpuCenti) * len;
			}
			const used = r.cpuUsec !== null ? (r.cpuUsec * len) / BigInt(r.wallMs) : 0n;
			cpuUsedUsec += used;
			const p = projects.get(r.project) ?? { runMs: 0n, cpuUsec: 0n };
			p.runMs += len;
			p.cpuUsec += used;
			projects.set(r.project, p);
		}
		const ranked = [...projects.entries()].sort((a, b) => (b[1].runMs > a[1].runMs ? 1 : b[1].runMs < a[1].runMs ? -1 : String(a[0] ?? "").localeCompare(String(b[0] ?? ""))));
		const toProject = ([project, p]) => ({ project, runMs: Number(p.runMs), cpuMs: Number(p.cpuUsec / 1000n) });
		const rest = ranked.slice(CAPACITY_TOP_PROJECTS);
		const other = rest.length === 0 ? null : { count: rest.length, runMs: Number(rest.reduce((s, [, p]) => s + p.runMs, 0n)), cpuMs: Number(rest.reduce((s, [, p]) => s + p.cpuUsec, 0n) / 1000n) };

		const waits = [...h.waits].sort((a, b) => a - b);
		const covered = BigInt(coveredMs);
		hosts.push({
			name,
			shared,
			capacity: { ...base, basis, changed },
			coveredMs,
			missingMs,
			busyMs,
			idleMs: coveredMs - busyMs,
			fullMs: base.slots !== null ? fullMs : null,
			peak,
			avgMilli: perMille(runMs, covered),
			promisedMemPerMille: memDenom !== null ? perMille(memMs, BigInt(memDenom) * covered) : null,
			promisedCpuPerMille: cpuDenom !== null ? perMille(cpuCentiMs, BigInt(cpuDenom) * covered) : null,
			// CPU time in microseconds over (CPUs x covered ms x 1000), with CPUs = hundredths / 100.
			usedCpuPerMille: cpuDenom !== null ? perMille(cpuUsedUsec, BigInt(cpuDenom) * covered * 10n) : null,
			runs: h.runs.length,
			refused: h.refused,
			projects: ranked.slice(0, CAPACITY_TOP_PROJECTS).map(toProject),
			otherProjects: other,
			waits: { n: waits.length, p50Ms: waits.length > 0 ? rank(waits, 50) : null, p95Ms: waits.length > 0 ? rank(waits, 95) : null },
			buckets: buckets.map((b) => ({ fromMs: b.fromMs, coveredMs: b.coveredMs, busyMs: b.busyMs, fullMs: base.slots !== null ? b.fullMs : null, peak: b.peak, avgMilli: perMille(b.runMs, BigInt(b.coveredMs)) })),
		});
	}

	const running = liveRows.reduce((sum, row) => {
		const n = typeof row.budgetRunning === "string" && /^\d{1,9}$/.test(row.budgetRunning) ? Number(row.budgetRunning) : null;
		return n === null ? sum : (sum ?? 0) + n;
	}, null);
	return {
		v: CAPACITY_REPORT_VERSION,
		window: { fromMs: windowStartMs, toMs: nowMs, bucketMs },
		coverage: {
			source: typeof coverage.source === "string" ? coverage.source : "local",
			reason: typeof coverage.reason === "string" ? coverage.reason : null,
			fromMs,
			truncated: coverage.truncated === true,
			...counts,
			running,
			historyNotShared: [...notShared].sort(),
		},
		hosts,
	};
}
