import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPACITY_MAX_BUCKETS, CAPACITY_TOP_PROJECTS, CAPACITY_WINDOWS, LEGACY_MIN_WALL_MS, capacityOf, computeCapacity, occupancyOf } from "../src/capacity.mjs";
import { recordedCapacity } from "../src/run-history.mjs";
import { SUGGEST_CLOCK_SKEW_MS, SUGGEST_MAX_WALL_MS } from "../src/size-suggest.mjs";

// The capacity report (issue #599, DES-CAPACITY-FROM-RECORDS, INT-CAPACITY-REPORT). Every instant is an offset from one
// injected `NOW`; nothing here reads the clock.
const NOW = Date.UTC(2026, 9, 8, 12, 0);
const M = 60 * 1000;
const H = 60 * M;
const DAY = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const CAP = { slots: 2, memMiB: 16384, cpuCenti: 800, cpus: 8 };
/** A run on host `a` from `from` to `to` hours AGO. */
const run = (jobId, from, to, extra = {}) => ({ jobId, host: "a", startedAt: iso(NOW - from * H), endedAt: iso(NOW - to * H), capacity: CAP, ...extra });
const report = (records, opts = {}) => computeCapacity({ records, windowStartMs: NOW - DAY, nowMs: NOW, bucketMs: H, ...opts });
const hostA = (records, opts) => report(records, opts).hosts.find((h) => h.name === "a");

test("overlapping runs: busy is the union, peak the most at once, full the time at the slot count", () => {
	const a = hostA([run("1", 10, 8), run("2", 9, 7)]);
	assert.equal(a.busyMs, 3 * H);
	assert.equal(a.idleMs, 21 * H);
	assert.equal(a.peak, 2);
	assert.equal(a.fullMs, 1 * H, "both slots of two were taken for the hour they overlapped");
	assert.equal(a.avgMilli, 167, "4 hours of run time over 24: 0.1666, rounded half up in thousandths");
	assert.equal(a.runs, 2);
});

test("a run nested inside another counts its time once toward busy and twice toward run time", () => {
	const a = hostA([run("outer", 10, 4), run("inner", 8, 6)]);
	assert.equal(a.busyMs, 6 * H);
	assert.equal(a.peak, 2);
	assert.equal(a.fullMs, 2 * H);
	assert.equal(a.avgMilli, 333);
});

test("touching runs reuse one slot: an end is swept before a start at the same instant", () => {
	const a = hostA([run("2", 8, 6), run("1", 10, 8)]);
	assert.equal(a.busyMs, 4 * H);
	assert.equal(a.peak, 1, "never two at once");
	assert.equal(a.fullMs, 0);
	const one = hostA([run("2", 8, 6, { capacity: { ...CAP, slots: 1 } }), run("1", 10, 8, { capacity: { ...CAP, slots: 1 } })]);
	assert.equal(one.fullMs, 4 * H, "with one slot, both runs fill it");
});

test("the window clips a run that began before it, and the buckets split a run at their edges", () => {
	const a = hostA([run("old", 30, 20), run("mid", 10.5, 9.5)]);
	assert.equal(a.busyMs, 4 * H + 1 * H, "only the part inside the window");
	assert.equal(a.buckets.length, 24);
	assert.deepEqual(a.buckets.map((b) => b.busyMs).slice(0, 5), [H, H, H, H, 0], "the old run fills the first four hourly buckets");
	assert.equal(a.buckets[13].busyMs, 30 * M, "10.5h ago to 10h ago");
	assert.equal(a.buckets[14].busyMs, 30 * M, "10h ago to 9.5h ago");
	assert.equal(a.buckets.reduce((s, b) => s + b.busyMs, 0), a.busyMs, "the buckets add up to the whole");
	assert.equal(a.buckets[0].fromMs, NOW - DAY);
	// A window that does not divide into whole buckets ends its last bucket at now.
	const odd = computeCapacity({ records: [run("x", 1, 0)], windowStartMs: NOW - 90 * M, nowMs: NOW, bucketMs: H }).hosts[0];
	assert.deepEqual(odd.buckets.map((b) => b.coveredMs), [H, 30 * M]);
	assert.deepEqual(odd.buckets.map((b) => b.busyMs), [30 * M, 30 * M]);
	// A run that has not ended by now (a clock a little ahead) is cut at now.
	const ahead = hostA([run("ahead", 1, -2 / 60)]);
	assert.equal(ahead.busyMs, 1 * H);
});

test("promised memory and CPU against the budget; with the CPU budget off, CPU is judged against every CPU", () => {
	const size = { memMiB: 4096, cpuCenti: 200, source: "env" };
	// 12 of 24 hours, one CPU busy the whole time.
	const resources = { cpuUsec: 12 * H * 1000 };
	const budgeted = hostA([run("1", 12, 0, { size, resources })]);
	assert.equal(budgeted.promisedMemPerMille, 125, "4g for half the day of a 16g budget");
	assert.equal(budgeted.promisedCpuPerMille, 125, "2 CPUs for half the day of 8");
	assert.equal(budgeted.usedCpuPerMille, 63, "1 CPU for half the day of 8: 62.5, rounded half up");

	const off = hostA([run("1", 12, 0, { size, resources, capacity: { slots: 2, memMiB: "off", cpuCenti: "off", cpus: 4 } })]);
	assert.equal(off.promisedMemPerMille, null, "no memory budget, so no share of one");
	assert.equal(off.promisedCpuPerMille, 250, "2 CPUs for half the day of the machine's 4");
	assert.equal(off.usedCpuPerMille, 125);
	const unknown = hostA([run("1", 12, 0, { size, resources, capacity: { slots: 2, memMiB: null, cpuCenti: null, cpus: null } })]);
	assert.deepEqual([unknown.promisedCpuPerMille, unknown.usedCpuPerMille], [null, null], "neither a budget nor a CPU count: no denominator, no number");
});

test("CPU used is the run's CPU time spread over its wall, clipped with it, and clamped to the CPU ceiling", () => {
	// A 4-hour run whose second half is inside a 2-hour window: half its CPU time counts.
	const a = computeCapacity({ records: [run("1", 4, 0, { size: { memMiB: 1024, cpuCenti: 100, source: "env" }, resources: { cpuUsec: 4 * H * 1000 * 2 } })], windowStartMs: NOW - 2 * H, nowMs: NOW, bucketMs: H }).hosts[0];
	assert.equal(a.usedCpuPerMille, 250, "2 CPUs over the window, of 8");
	// A container that reports more CPU time than any job could have is clamped (resources are produced in the job).
	const liar = hostA([run("1", 1, 0, { resources: { cpuUsec: Number.MAX_SAFE_INTEGER } })]);
	assert.equal(liar.usedCpuPerMille, Math.round((256 * 1000) / 8 / 24), "at most 256 CPUs for its hour, of 8, over a day");
});

test("which records held a slot: capacity says it outright, a legacy record is inferred and counted", () => {
	assert.deepEqual(occupancyOf({ capacity: CAP }), { occupied: true, inferred: false });
	assert.deepEqual(occupancyOf({ capacity: null, startedAt: iso(NOW - H), endedAt: iso(NOW) }), { occupied: false, inferred: false }, "a refusal before a slot, however long its record spans");
	assert.equal(occupancyOf({ capacity: "full" }), null, "neither object nor null cannot be told");
	assert.equal(occupancyOf(null), null);
	const legacy = (ms, extra = {}) => ({ startedAt: iso(NOW - ms), endedAt: iso(NOW), ...extra });
	assert.deepEqual(occupancyOf(legacy(LEGACY_MIN_WALL_MS)), { occupied: true, inferred: true });
	assert.deepEqual(occupancyOf(legacy(LEGACY_MIN_WALL_MS - 1)), { occupied: false, inferred: true });
	assert.deepEqual(occupancyOf(legacy(0, { resources: { cpuUsec: 1 } })), { occupied: true, inferred: true }, "a measured container ran");

	const { capacity: _drop, ...noKey } = run("legacy", 3, 2);
	const r = report([noKey, { ...noKey, jobId: "refused", startedAt: iso(NOW - H), endedAt: iso(NOW - H) }, run("new", 5, 4), run("no", 6, 6, { capacity: null })]);
	assert.equal(r.coverage.used, 2);
	assert.equal(r.coverage.legacyInferred, 1);
	assert.equal(r.coverage.refusedBeforeSlot, 2, "the inferred refusal and the recorded one");
	assert.equal(r.hosts[0].busyMs, 2 * H);
	assert.equal(r.hosts[0].refused, 2);
});

test("a span this report cannot trust is not counted, and is counted as unreadable", () => {
	const r = report([
		run("backwards", 1, 2),
		{ ...run("week", 1, 0), startedAt: iso(NOW - SUGGEST_MAX_WALL_MS - 1) },
		{ ...run("future", 1, 0), endedAt: iso(NOW + SUGGEST_CLOCK_SKEW_MS + 1) },
		{ ...run("garbled", 1, 0), startedAt: "yesterday" },
		{ ...run("weird", 1, 0), capacity: 7 },
		run("fine", 1, 0),
	]);
	assert.equal(r.coverage.unreadable, 5);
	assert.equal(r.coverage.used, 1);
	assert.equal(r.hosts[0].busyMs, H);
	const noHost = report([run("x", 1, 0, { host: null })]);
	assert.deepEqual([noHost.coverage.withoutHost, noHost.hosts.length], [1, 0]);
});

test("history the sources do not hold is MISSING, never idle, and leaves both busy and idle", () => {
	// A mirror at its cap whose oldest run ended 6 hours ago: the 18 hours before are not history.
	const r = report([run("1", 10, 2)], { coverage: { fromMs: NOW - 6 * H, truncated: true, source: "mirror", mirrored: true } });
	const a = r.hosts[0];
	assert.equal(a.missingMs, 18 * H);
	assert.equal(a.coveredMs, 6 * H);
	assert.equal(a.busyMs, 4 * H, "only the part of the run inside the covered window");
	assert.equal(a.idleMs, 2 * H);
	assert.equal(a.avgMilli, 667, "the average is over the covered time, not the window");
	assert.equal(a.buckets[0].coveredMs, 0);
	assert.equal(a.buckets[0].avgMilli, null, "a bucket with no history has no average, not a zero");
	assert.equal(r.coverage.truncated, true);
	assert.equal(r.coverage.fromMs, NOW - 6 * H);
	// A coverage start before the window is the window.
	assert.equal(report([], { coverage: { fromMs: NOW - 2 * DAY } }).coverage.fromMs, NOW - DAY);
});

test("a live host whose history is not shared is missing for the whole window, and its records are not half counted", () => {
	const live = [
		{ name: "a", routes: "true", concurrency: "2" },
		{ name: "b", routes: "false", concurrency: "4" },
		{ name: "here", routes: "false", concurrency: "1" },
		{ name: "seen", routes: "false", concurrency: "1" },
	];
	const r = report([run("1", 2, 1), run("2", 2, 1, { host: "b" }), run("3", 2, 1, { host: "seen" })], { live, coverage: { mirrored: true, localHost: "here", localHosts: ["seen"] } });
	assert.deepEqual(r.coverage.historyNotShared, ["b"], "named-and-mirrored, this host and a host in the local files are shared");
	const b = r.hosts.find((h) => h.name === "b");
	assert.deepEqual([b.shared, b.coveredMs, b.missingMs, b.busyMs, b.idleMs], [false, 0, DAY, 0, 0]);
	assert.equal(r.coverage.used, 2, "b's own record is not counted at all");
	assert.equal(r.hosts.find((h) => h.name === "here").idleMs, DAY, "this host with no run is idle: its files are its whole history");
	// Without a readable mirror, a named host is not shared either.
	assert.deepEqual(report([], { live, coverage: { mirrored: false, localHost: "here" } }).coverage.historyNotShared, ["a", "b", "seen"]);
});

test("the capacity basis: the newest recorded in the window, else the live row's, else unknown; changed when runs disagree", () => {
	const newer = { slots: 4, memMiB: 32768, cpuCenti: "off", cpus: 16 };
	const a = hostA([run("1", 5, 4), run("2", 3, 2, { capacity: newer })]);
	assert.deepEqual(a.capacity, { ...newer, basis: "recorded", changed: true });
	assert.deepEqual(hostA([run("1", 5, 4), run("2", 3, 2)]).capacity, { ...CAP, basis: "recorded", changed: false });
	for (const key of ["slots", "memMiB", "cpuCenti", "cpus"]) {
		assert.equal(hostA([run("1", 5, 4), run("2", 3, 2, { capacity: { ...CAP, [key]: 1 } })]).capacity.changed, true, `${key} alone differs`);
	}
	const live = [{ name: "a", concurrency: "3", budgetMemMiB: "off", budgetCpuCenti: "" }];
	const current = report([], { live }).hosts[0];
	assert.deepEqual(current.capacity, { slots: 3, memMiB: "off", cpuCenti: null, cpus: null, basis: "current", changed: false });
	assert.equal(current.fullMs, 0);
	const legacyOnly = hostA([{ jobId: "x", host: "a", startedAt: iso(NOW - 2 * H), endedAt: iso(NOW - H) }]);
	assert.deepEqual(legacyOnly.capacity, { slots: null, memMiB: null, cpuCenti: null, cpus: null, basis: "unknown", changed: false });
	assert.equal(legacyOnly.fullMs, null, "no slot count, no time at it");
	assert.equal(legacyOnly.buckets[22].fullMs, null);
});

test("waits: startedAt minus queuedAt for runs that started in the covered window, non-negative only, nearest-rank percentiles", () => {
	const records = [];
	for (let i = 1; i <= 20; i++) records.push(run(`w${i}`, 10, 9, { startedAt: iso(NOW - 10 * H + i * M), queuedAt: iso(NOW - 10 * H + i * M - i * 10_000) }));
	records.push(run("ahead", 3, 2, { queuedAt: iso(NOW - 2 * H) }), run("none", 3, 2), run("held", 3, 2, { queuedAt: null }));
	records.push(run("before", 30, 1, { queuedAt: iso(NOW - 31 * H) }), run("refused", 2, 2, { capacity: null, queuedAt: iso(NOW - 3 * H) }));
	const a = hostA(records);
	assert.deepEqual(a.waits, { n: 20, p50Ms: 100_000, p95Ms: 190_000 }, "the 10th and 19th of twenty");
	assert.deepEqual(hostA([run("1", 2, 1)]).waits, { n: 0, p50Ms: null, p95Ms: null });
	assert.deepEqual(hostA([run("1", 2, 1, { queuedAt: iso(NOW - 2 * H - 5000) })]).waits, { n: 1, p50Ms: 5000, p95Ms: 5000 });
});

test(`the top ${CAPACITY_TOP_PROJECTS} projects by run time are named, the rest summed as other`, () => {
	const records = [];
	["p1", "p2", "p3", "p4", "p5", "p6", "p7"].forEach((p, i) => records.push(run(`r${i}`, 20, 20 - (7 - i), { project: p, resources: { cpuUsec: (7 - i) * H * 1000 } })));
	records.push(run("none", 2, 1.5, { project: null }));
	const a = hostA(records);
	assert.deepEqual(a.projects.map((p) => p.project), ["p1", "p2", "p3", "p4", "p5"]);
	assert.deepEqual(a.projects[0], { project: "p1", runMs: 7 * H, cpuMs: 7 * H });
	assert.deepEqual(a.otherProjects, { count: 3, runMs: 2 * H + 1 * H + 30 * M, cpuMs: 3 * H });
	assert.equal(hostA([run("1", 2, 1, { project: "x" })]).otherProjects, null);
});

test("the report's frame: version, window, every coverage count, hosts sorted, and the live rows' running jobs", () => {
	const r = report([run("1", 2, 1, { host: "b" }), run("2", 2, 1)], { live: [{ name: "c", budgetRunning: "2" }, { name: "d", budgetRunning: "" }, { name: "e", budgetRunning: "1" }], coverage: { source: "mirror+local", reason: "why", mirrored: true, localHost: "c", localHosts: ["d", "e"] } });
	assert.equal(r.v, 1);
	assert.deepEqual(r.window, { fromMs: NOW - DAY, toMs: NOW, bucketMs: H });
	assert.deepEqual(Object.keys(r.coverage), ["source", "reason", "fromMs", "truncated", "used", "refusedBeforeSlot", "legacyInferred", "withoutSize", "withoutResources", "unreadable", "withoutHost", "running", "historyNotShared"]);
	assert.deepEqual([r.coverage.source, r.coverage.reason, r.coverage.running, r.coverage.withoutSize, r.coverage.withoutResources], ["mirror+local", "why", 3, 2, 2]);
	assert.deepEqual(r.hosts.map((h) => h.name), ["a", "b", "c", "d", "e"]);
	assert.equal(report([]).coverage.running, null, "no live row says: unknown, not zero");
	assert.deepEqual(Object.keys(r.hosts[0]), ["name", "shared", "capacity", "coveredMs", "missingMs", "busyMs", "idleMs", "fullMs", "peak", "avgMilli", "promisedMemPerMille", "promisedCpuPerMille", "usedCpuPerMille", "runs", "refused", "projects", "otherProjects", "waits", "buckets"]);
});

test("a window or bucket the function cannot honour is the caller's mistake, refused", () => {
	assert.throws(() => computeCapacity({ windowStartMs: NOW, nowMs: NOW, bucketMs: H }), RangeError);
	assert.throws(() => computeCapacity({ windowStartMs: NOW - H, nowMs: NOW, bucketMs: 0 }), RangeError);
	assert.throws(() => computeCapacity({ windowStartMs: NOW - DAY, nowMs: NOW, bucketMs: 1 }), RangeError, `more than ${CAPACITY_MAX_BUCKETS} buckets`);
	for (const [key, w] of Object.entries(CAPACITY_WINDOWS)) {
		assert.ok(Math.ceil(w.ms / w.bucketMs) <= CAPACITY_MAX_BUCKETS, key);
		assert.doesNotThrow(() => computeCapacity({ windowStartMs: NOW - w.ms, nowMs: NOW, bucketMs: w.bucketMs }));
	}
});

test("capacityOf reads a record's capacity exactly as recordedCapacity writes it (the leaf's restatement, held)", () => {
	const cases = [CAP, { slots: 1, memMiB: Infinity, cpuCenti: "off", cpus: 1 }, { slots: 0, memMiB: 0, cpuCenti: -1, cpus: 1.5 }, { slots: "2", memMiB: "1", cpuCenti: null, cpus: undefined }, { memMiB: 2 ** 53 }, null, 7, [1], {}];
	for (const c of cases) {
		// What a reader meets is the JSON line, so the writer's output goes through it first.
		const written = JSON.parse(JSON.stringify({ c: recordedCapacity(c) })).c;
		assert.deepEqual(capacityOf(written), written, JSON.stringify(c));
	}
});

/** A small deterministic PRNG (mulberry32), so the property test is the same run every time. */
function prng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("property: for every host, busy + idle + missing is the window, and busy, full and peak match a minute-by-minute count", () => {
	for (let seed = 1; seed <= 60; seed++) {
		const rand = prng(seed);
		const pick = (n) => Math.floor(rand() * n);
		const windowMin = 120 + pick(600);
		const windowStart = NOW - windowMin * M;
		const records = [];
		const hosts = ["a", "b", "c"];
		for (let i = 0, n = pick(25); i < n; i++) {
			const start = windowStart - 60 * M + pick(windowMin + 90) * M;
			const end = start + pick(180) * M;
			records.push({ jobId: `j${i}`, host: hosts[pick(3)], startedAt: iso(start), endedAt: iso(Math.min(end, NOW)), capacity: { ...CAP, slots: 2 }, project: `p${pick(4)}`, ...(pick(5) === 0 ? { capacity: null } : {}) });
		}
		const fromMs = pick(2) === 0 ? windowStart : windowStart + pick(windowMin) * M;
		const live = pick(2) === 0 ? [{ name: "c", routes: "false" }] : [];
		const r = computeCapacity({ records, live, windowStartMs: windowStart, nowMs: NOW, bucketMs: (15 + pick(60)) * M, coverage: { fromMs, mirrored: true } });
		for (const h of r.hosts) {
			assert.equal(h.busyMs + h.idleMs + h.missingMs, windowMin * M, `seed ${seed} host ${h.name}`);
			assert.equal(h.buckets.reduce((s, b) => s + b.busyMs, 0), h.busyMs, `seed ${seed}: buckets sum to busy`);
			assert.equal(h.buckets.reduce((s, b) => s + b.coveredMs, 0), h.coveredMs, `seed ${seed}: buckets sum to covered`);
			// The brute force: every covered minute, how many slot-holding runs of this host cover it.
			const coveredFrom = h.shared ? Math.max(windowStart, fromMs) : NOW;
			const mine = h.shared ? records.filter((x) => x.host === h.name && x.capacity !== null) : [];
			let busy = 0;
			let full = 0;
			let peak = 0;
			for (let t = coveredFrom; t < NOW; t += M) {
				const n = mine.filter((x) => Date.parse(x.startedAt) <= t && t < Date.parse(x.endedAt)).length;
				if (n > 0) busy += M;
				if (n >= 2) full += M;
				peak = Math.max(peak, n);
			}
			assert.deepEqual([h.busyMs, h.fullMs ?? 0, h.peak], [busy, full, peak], `seed ${seed} host ${h.name}`);
		}
	}
});
