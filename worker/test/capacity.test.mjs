import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPACITY_MAX_BUCKETS, CAPACITY_TOP_PROJECTS, CAPACITY_WINDOWS, LEGACY_MIN_WALL_MS, LIVE_FRESH_MS, PRE_SLOT_REFUSAL_REASONS, capacityOf, computeCapacity, occupancyOf } from "../src/capacity.mjs";
import { recordedCapacity } from "../src/run-history.mjs";
import * as rowIds from "../src/live-jobs.mjs";
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

test("promised memory and CPU against the budget, CPU used against the host's CPUs; with the CPU budget off, promises too", () => {
	const size = { memMiB: 4096, cpuCenti: 200, source: "env" };
	// 12 of 24 hours, one CPU busy the whole time.
	const resources = { cpuUsec: 12 * H * 1000 };
	const budgeted = hostA([run("1", 12, 0, { size, resources })]);
	assert.equal(budgeted.promisedMemPerMille, 125, "4g for half the day of a 16g budget");
	assert.equal(budgeted.promisedCpuPerMille, 125, "2 CPUs for half the day of the 8 CPU budget");
	assert.equal(budgeted.usedCpuPerMille, 63, "1 CPU for half the day of the host's 8: 62.5, rounded half up");
	// A 4 CPU budget on an 8 CPU host: each job's --cpus is the whole budget, and nothing proves the jobs together are
	// held to it (the parent cgroup quota is not set where only root can set it), so two jobs each using all 4 CPUs at
	// once is possible: all of the host. Used is over the host's CPUs, and never above them.
	const fourOnEight = { slots: 2, memMiB: 8192, cpuCenti: 400, cpus: 8 };
	const both = hostA([run("d1", 24, 0, { size, capacity: fourOnEight, resources: { cpuUsec: 4 * DAY * 1000 } }), run("d2", 24, 0, { size, capacity: fourOnEight, resources: { cpuUsec: 4 * DAY * 1000 } })]);
	assert.deepEqual([both.usedCpuPerMille, both.promisedCpuPerMille, both.coverage.cpuClamped], [1000, 1000, 0]);
	const three = hostA([1, 2, 3].map((i) => run(`t${i}`, 24, 0, { size, capacity: { ...fourOnEight, slots: 3 }, resources: { cpuUsec: 4 * DAY * 1000 } })));
	assert.deepEqual([three.usedCpuPerMille, three.coverage.cpuClamped], [1000, 3], "three jobs at 4 CPUs each on 8: held to the host, never above 100%");
	const fit = hostA([run("d1", 24, 0, { size, capacity: fourOnEight, resources: { cpuUsec: 2 * DAY * 1000 } }), run("d2", 24, 0, { size, capacity: fourOnEight, resources: { cpuUsec: 2 * DAY * 1000 } })]);
	assert.deepEqual([fit.usedCpuPerMille, fit.coverage.cpuClamped], [500, 0], "two jobs of 2 CPUs: nothing cut");
	const offTwo = hostA([run("d1", 24, 0, { size, capacity: { ...fourOnEight, cpuCenti: "off" }, resources: { cpuUsec: 8 * DAY * 1000 } }), run("d2", 24, 0, { size, capacity: { ...fourOnEight, cpuCenti: "off" }, resources: { cpuUsec: 8 * DAY * 1000 } })]);
	assert.deepEqual([offTwo.usedCpuPerMille, offTwo.coverage.cpuClamped], [1000, 2], "budget off: never more than the host's CPUs");

	const off = hostA([run("1", 12, 0, { size, resources, capacity: { slots: 2, memMiB: "off", cpuCenti: "off", cpus: 4 } })]);
	assert.equal(off.promisedMemPerMille, null, "no memory budget, so no share of one");
	assert.equal(off.promisedCpuPerMille, 250, "2 CPUs for half the day of the machine's 4");
	assert.equal(off.usedCpuPerMille, 125);
	const unknown = hostA([run("1", 12, 0, { size, resources, capacity: { slots: 2, memMiB: null, cpuCenti: null, cpus: null } })]);
	assert.deepEqual([unknown.promisedCpuPerMille, unknown.usedCpuPerMille], [null, null], "neither a budget nor a CPU count: no denominator, no number");
});

test("each piece of time is judged against the capacity in force then, so a lowered budget is an over-commit only where it was", () => {
	const size = { memMiB: 4096, cpuCenti: 200, source: "project" };
	const big = { slots: 2, memMiB: 8192, cpuCenti: 400, cpus: 8 };
	const small = { slots: 1, memMiB: 1024, cpuCenti: 100, cpus: 8 };
	// Two jobs the whole day under the big budget, then for the last hour the budget is lowered (a run started under it).
	const a = hostA([run("b1", 24, 0, { size, capacity: big }), run("b2", 24, 0, { size, capacity: big }), run("b3", 1, 0, { size: { memMiB: 512, cpuCenti: 50, source: "project" }, capacity: small })]);
	// memory: 23h x 8192 promised of 8192, then 1h x 8704 of 1024: (23 x 8192 + 8704) / (23 x 8192 + 1024)
	assert.equal(a.promisedMemPerMille, Math.round(((23 * 8192 + 8704) * 1000) / (23 * 8192 + 1024)));
	assert.deepEqual(a.capacity, { ...small, basis: "recorded", changed: true });
	// The slot count in force: two slots for 23 hours (full: both ran), one for the last (full: three ran).
	assert.equal(a.fullMs, DAY);
	const halfFull = hostA([run("x", 24, 12, { capacity: big }), run("y", 12, 0, { capacity: { ...big, slots: 1 } })]);
	assert.equal(halfFull.fullMs, 12 * H, "one run is full only under the one-slot capacity");
});

test("CPU used is the run's CPU time spread over its wall, clipped with it, and clamped to what its job could use", () => {
	// A 4-hour run whose second half is inside a 2-hour window: half its CPU time counts.
	const a = computeCapacity({ records: [run("1", 4, 0, { size: { memMiB: 1024, cpuCenti: 100, source: "env" }, resources: { cpuUsec: 4 * H * 1000 * 2 } })], windowStartMs: NOW - 2 * H, nowMs: NOW, bucketMs: H }).hosts[0];
	assert.equal(a.usedCpuPerMille, 250, "2 CPUs over the window, of the host's 8");
	// A container that reports more CPU time than its job could have is clamped to its --cpus (the 8 CPU budget) over its
	// wall, and counted (resources are produced in the job).
	const liar = hostA([run("1", 12, 0, { resources: { cpuUsec: Number.MAX_SAFE_INTEGER } })]);
	assert.equal(liar.usedCpuPerMille, 500, "at most 8 CPUs for its 12 hours, of 8, over a day");
	assert.equal(liar.coverage.cpuClamped, 1);
	// With a smaller budget the ceiling is the budget; with none, the host's CPUs; with neither, the size ceiling.
	const budget = hostA([run("1", 12, 0, { resources: { cpuUsec: Number.MAX_SAFE_INTEGER }, capacity: { ...CAP, cpuCenti: 200 } })]);
	assert.equal(budget.usedCpuPerMille, 125);
	const noBudget = hostA([run("1", 12, 0, { resources: { cpuUsec: Number.MAX_SAFE_INTEGER }, capacity: { ...CAP, cpuCenti: "off", cpus: 4 } })]);
	assert.equal(noBudget.usedCpuPerMille, 500);
	assert.equal(hostA([run("1", 12, 0, { resources: { cpuUsec: 12 * H * 1000 } })]).coverage.cpuClamped, 0, "a true measurement is not counted as clamped");
});

test("which records held a slot: capacity says it outright, a legacy record is inferred both ways and counted", () => {
	assert.deepEqual(occupancyOf({ capacity: CAP }), { occupied: true, inferred: false });
	assert.deepEqual(occupancyOf({ capacity: null, startedAt: iso(NOW - H), endedAt: iso(NOW) }), { occupied: false, inferred: false }, "a refusal before a slot, however long its record spans");
	assert.equal(occupancyOf({ capacity: "full" }), null, "neither object nor null cannot be told");
	assert.equal(occupancyOf(null), null);
	const legacy = (ms, extra = {}) => ({ startedAt: iso(NOW - ms), endedAt: iso(NOW), ...extra });
	assert.deepEqual(occupancyOf(legacy(LEGACY_MIN_WALL_MS)), { occupied: true, inferred: true });
	assert.deepEqual(occupancyOf(legacy(LEGACY_MIN_WALL_MS - 1)), { occupied: false, inferred: true });
	assert.deepEqual(occupancyOf(legacy(0, { resources: { cpuUsec: 1 } })), { occupied: true, inferred: true }, "a measured container ran");
	// A refusal the processor gives before a slot, by its reason, however long the gate took to give it.
	for (const reason of PRE_SLOT_REFUSAL_REASONS) assert.deepEqual(occupancyOf(legacy(5 * M, { outcome: "policy", reason })), { occupied: false, inferred: true }, reason);
	assert.deepEqual(occupancyOf(legacy(5 * M, { outcome: "policy", reason: "over-budget" })), { occupied: true, inferred: true }, "a reason decided after admission held a slot");

	const { capacity: _drop, ...noKey } = run("legacy", 3, 2);
	const r = report([noKey, { ...noKey, jobId: "refused", startedAt: iso(NOW - H), endedAt: iso(NOW - H) }, { ...noKey, jobId: "waited", startedAt: iso(NOW - 3 * H), endedAt: iso(NOW - 2 * H), reason: "wait-expired" }, run("new", 5, 4), run("no", 6, 6, { capacity: null })]);
	const a = r.hosts[0];
	assert.deepEqual([a.coverage.used, a.coverage.legacyOccupied, a.coverage.legacyRefused, a.coverage.refusedBeforeSlot], [2, 1, 2, 3]);
	assert.deepEqual([r.coverage.used, r.coverage.legacyOccupied, r.coverage.legacyRefused, r.coverage.refusedBeforeSlot], [2, 1, 2, 3], "the fleet totals are the hosts' sums");
	assert.equal(a.busyMs, 2 * H);
});

test("a span, a host or a project this report cannot trust is not counted, and is counted as unreadable", () => {
	const r = report([
		run("backwards", 1, 2),
		{ ...run("week", 1, 0), startedAt: iso(NOW - SUGGEST_MAX_WALL_MS - 1) },
		{ ...run("future", 1, 0), endedAt: iso(NOW + SUGGEST_CLOCK_SKEW_MS + 1) },
		{ ...run("garbled", 1, 0), startedAt: "yesterday" },
		{ ...run("weird", 1, 0), capacity: 7 },
		run("escape", 1, 0, { host: "x\u001b[2J" }),
		run("slash", 1, 0, { host: "../etc" }),
		run("long", 1, 0, { host: "h".repeat(65) }),
		run("painted", 1, 0, { project: "p\u001b[31m" }),
		run("named", 1, 0, { project: "Web Shop" }),
		run("fine", 1, 0, { project: "web" }),
	]);
	assert.equal(r.coverage.unreadable, 10);
	assert.equal(r.coverage.used, 1);
	assert.deepEqual(r.hosts.map((h) => h.name), ["a"], "no hostile name reaches the report");
	assert.equal(r.hosts[0].busyMs, H);
	const noHost = report([run("x", 1, 0, { host: null })]);
	assert.deepEqual([noHost.coverage.withoutHost, noHost.hosts.length], [1, 0]);
	assert.deepEqual(report([], { live: [{ name: "evil\u001b]0;x\u0007" }, { name: "b" }] }).hosts.map((h) => h.name), ["b"], "nor a hostile live row");
});

test("a run of no length held its slot for no time: counted, its wait kept, busy unchanged", () => {
	const a = hostA([run("zero", 2, 2, { queuedAt: iso(NOW - 2 * H - 30_000) })]);
	assert.deepEqual([a.coverage.used, a.busyMs, a.runs], [1, 0, 1]);
	assert.deepEqual(a.waits, { n: 1, p50Ms: 30_000, p95Ms: 30_000 });
	assert.equal(hostA([run("zero", 2, 2)], { coverage: { fromMs: NOW - H } }), undefined, "before the covered window: not counted, and the host has nothing else");
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

test("each host's history starts where the best source holding all its runs starts; a host no source holds is missing", () => {
	const live = [
		{ name: "a", routes: "true", concurrency: "2" },
		{ name: "b", routes: "false", concurrency: "4" },
		{ name: "here", routes: "false", concurrency: "1" },
		{ name: "seen", routes: "false", concurrency: "1" },
	];
	const coverage = { localHost: "here", localHosts: ["seen"], local: { fromMs: NOW - 20 * H }, mirror: { fromMs: NOW - 6 * H, truncated: true, hosts: ["a", "gone"] } };
	const r = report([run("1", 2, 1), run("2", 2, 1, { host: "b" }), run("3", 2, 1, { host: "seen" }), run("4", 2, 1, { host: "gone" })], { live, coverage });
	assert.deepEqual(r.coverage.historyNotShared, ["b"], "a live worker that mirrors nothing, seen from another host");
	const by = Object.fromEntries(r.hosts.map((h) => [h.name, h]));
	assert.deepEqual([by.b.shared, by.b.coveredMs, by.b.missingMs, by.b.busyMs, by.b.idleMs, by.b.coverage.used], [false, 0, DAY, 0, 0, 0], "and its own record is not counted at all");
	assert.deepEqual([by.a.coverage.fromMs, by.a.coverage.source, by.a.coverage.truncated, by.a.missingMs], [NOW - 6 * H, "mirror", true, 18 * H], "a named host: the mirror's start, which a trim cut");
	assert.deepEqual([by.gone.coverage.fromMs, by.gone.coverage.source], [NOW - 6 * H, "mirror"], "a host no longer live whose runs the mirror holds");
	assert.deepEqual([by.here.coverage.fromMs, by.here.coverage.source, by.here.coverage.truncated, by.here.idleMs], [NOW - 20 * H, "local", false, 20 * H], "this host: its own files, to their retention");
	assert.deepEqual([by.seen.coverage.fromMs, by.seen.coverage.source], [NOW - 20 * H, "local"], "a peer on a shared logs directory");
	assert.equal(r.coverage.used, 3);
	assert.equal(r.coverage.fromMs, NOW - 6 * H, "the fleet's: every covered host has history from here on");
	// A host both sources hold is covered from the earlier of the two, and its source says both.
	const both = report([], { live: [{ name: "here", routes: "true" }], coverage: { ...coverage, mirror: { ...coverage.mirror, hosts: ["here"] } } });
	assert.deepEqual([both.hosts[0].coverage.fromMs, both.hosts[0].coverage.source, both.hosts[0].coverage.truncated], [NOW - 20 * H, "mirror+local", false]);
	// On a tie the files' start is taken (the mirror's cut does not apply to them), still named as both.
	const tie = report([], { live: [{ name: "here", routes: "true" }], coverage: { ...coverage, local: { fromMs: NOW - 6 * H }, mirror: { ...coverage.mirror, hosts: ["here"] } } });
	assert.deepEqual([tie.hosts[0].coverage.source, tie.hosts[0].coverage.truncated], ["mirror+local", false]);
	// Without a readable mirror a named host is not shared; without the logs directory this host is not either.
	assert.deepEqual(report([], { live, coverage: { ...coverage, mirror: null } }).coverage.historyNotShared, ["a", "b"]);
	assert.deepEqual(report([], { live, coverage: { ...coverage, local: null } }).coverage.historyNotShared, ["b", "here", "seen"]);
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
	// A retry: its queuedAt (from a record written before the field went null on retries) would include the earlier
	// attempt. Not a wait; counted as retried, since its earlier attempts' slot time is not in any record.
	const retried = hostA([run("r", 2, 1, { attempt: 2, queuedAt: iso(NOW - 5 * H) }), run("f", 2, 1, { attempt: 1, queuedAt: iso(NOW - 2 * H - 1000) })]);
	assert.deepEqual([retried.waits.n, retried.waits.p50Ms, retried.coverage.retried], [1, 1000, 1]);
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
	const r = report([run("1", 2, 1, { host: "b" }), run("2", 2, 1)], { live: [{ name: "c", budgetRunning: "2" }, { name: "d", budgetRunning: "" }, { name: "e", budgetRunning: "1" }], coverage: { source: "mirror+local", reason: "why" } });
	assert.equal(r.v, 1);
	assert.deepEqual(r.window, { fromMs: NOW - DAY, toMs: NOW, bucketMs: H });
	assert.deepEqual(Object.keys(r.coverage), ["source", "reason", "fromMs", "truncated", "used", "refusedBeforeSlot", "legacyOccupied", "legacyRefused", "withoutSize", "withoutResources", "cpuClamped", "retried", "earlier", "stalledRepick", "live", "liveNotCounted", "liveUnreadable", "orphans", "unreadable", "withoutHost", "earlierDropped", "running", "historyNotShared"]);
	assert.deepEqual([r.coverage.source, r.coverage.reason, r.coverage.running, r.coverage.liveNotCounted, r.coverage.withoutSize, r.coverage.withoutResources], ["mirror+local", "why", 3, 3, 2, 2], "a row from before `jobs` says how many run, and none of them is counted");
	assert.deepEqual(r.hosts.map((h) => h.name), ["a", "b", "c", "d", "e"]);
	assert.equal(report([]).coverage.running, null, "no live row says: unknown, not zero");
	assert.deepEqual(Object.keys(r.hosts[0]), ["name", "shared", "notShared", "coverage", "capacity", "coveredMs", "missingMs", "busyMs", "idleMs", "fullMs", "peak", "avgMilli", "promisedMemPerMille", "promisedCpuPerMille", "usedCpuPerMille", "runs", "projects", "otherProjects", "waits", "buckets"]);
	assert.deepEqual(Object.keys(r.hosts[0].coverage), ["fromMs", "source", "truncated", "used", "refusedBeforeSlot", "legacyOccupied", "legacyRefused", "withoutSize", "withoutResources", "cpuClamped", "retried", "earlier", "stalledRepick", "live", "liveNotCounted", "liveUnreadable", "orphans"]);
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
		const at = () => (pick(2) === 0 ? windowStart - pick(60) * M : windowStart + pick(windowMin) * M);
		const live = pick(2) === 0 ? [{ name: "c", routes: "false" }] : [];
		const coverage = { localHost: "a", local: pick(4) === 0 ? null : { fromMs: at() }, mirror: pick(4) === 0 ? null : { fromMs: at(), truncated: true, hosts: ["b", "c"] } };
		const r = computeCapacity({ records, live, windowStartMs: windowStart, nowMs: NOW, bucketMs: (15 + pick(60)) * M, coverage });
		for (const h of r.hosts) {
			assert.equal(h.busyMs + h.idleMs + h.missingMs, windowMin * M, `seed ${seed} host ${h.name}`);
			assert.equal(h.buckets.reduce((s, b) => s + b.busyMs, 0), h.busyMs, `seed ${seed}: buckets sum to busy`);
			assert.equal(h.buckets.reduce((s, b) => s + b.coveredMs, 0), h.coveredMs, `seed ${seed}: buckets sum to covered`);
			// The brute force: every covered minute, how many slot-holding runs of this host cover it.
			const coveredFrom = h.shared ? h.coverage.fromMs : NOW;
			assert.ok(coveredFrom >= windowStart && coveredFrom <= NOW);
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

test("a retry's earlier attempts count as occupied intervals on their own hosts, with their size and no wait or CPU", () => {
	const earlier = [
		{ host: "b", startedAt: iso(NOW - 10 * H), endedAt: iso(NOW - 9 * H), memMiB: 4096, cpuCenti: 200 },
		{ host: "a", startedAt: iso(NOW - 8 * H), endedAt: iso(NOW - 6 * H), memMiB: 4096, cpuCenti: 200 },
		{ host: "evil\u001b", startedAt: iso(NOW - 8 * H), endedAt: iso(NOW - 6 * H) },
		{ host: "a", startedAt: "garbled", endedAt: iso(NOW) },
	];
	const r = report([run("r", 2, 1, { attempt: 3, earlier, size: { memMiB: 4096, cpuCenti: 200, source: "env" } })]);
	const by = Object.fromEntries(r.hosts.map((h) => [h.name, h]));
	assert.deepEqual([by.a.busyMs, by.a.coverage.used, by.a.coverage.earlier, by.a.coverage.retried, by.a.waits.n], [3 * H, 1, 1, 1, 0]);
	assert.deepEqual([by.b.busyMs, by.b.coverage.used, by.b.coverage.earlier, by.b.coverage.withoutResources], [H, 0, 1, 0], "on its own host; no measurement is expected of it");
	assert.equal(by.a.promisedMemPerMille, Math.round((4096 * 3 * 1000) / (16384 * 24)), "its size is promised");
	assert.deepEqual(r.hosts.map((h) => h.name), ["a", "b"], "no hostile name reaches the report");
	// A refused retry still carries what the attempts before it held.
	const refused = report([run("q", 1, 1, { capacity: null, attempt: 2, earlier: [earlier[1]] })]);
	assert.deepEqual([refused.hosts[0].busyMs, refused.hosts[0].coverage.earlier], [2 * H, 1]);
});

test("a pickup after a stall is counted and adds no wait: the stalled pickup's time is unknown", () => {
	const a = hostA([run("s", 2, 1, { stalledRepick: true, queuedAt: iso(NOW - 3 * H) })]);
	assert.deepEqual([a.coverage.stalledRepick, a.waits.n], [1, 0]);
});

test("capacity.mjs stays pure: its import graph holds no filesystem, no os and no config.mjs", async () => {
	const { readFileSync } = await import("node:fs");
	const seen = new Set();
	const walk = (file) => {
		if (seen.has(file)) return;
		seen.add(file);
		const src = readFileSync(new URL(file, import.meta.url), "utf8");
		for (const m of src.matchAll(/^import [^;]*? from "([^"]+)";/gms)) {
			const spec = m[1];
			if (spec.startsWith("./")) walk(new URL(spec, new URL(file, import.meta.url)).href);
			else seen.add(spec);
		}
	};
	walk(new URL("../src/capacity.mjs", import.meta.url).href);
	const graph = [...seen].map((f) => f.replace(/^.*\/src\//, ""));
	for (const banned of ["node:fs", "fs", "node:os", "os", "node:child_process", "config.mjs"]) assert.ok(!graph.includes(banned), `${banned} in ${graph.join(", ")}`);
	assert.ok(graph.includes("worker-name.mjs") && graph.includes("project-id.mjs"), "the two name rules come from leaves");
});

test("a record's earlier attempts are rebuilt by the writer's rule: the newest 4 valid ones, none overlapping the record's own run on its host", () => {
	const at = (h) => iso(NOW - h * H);
	const many = Array.from({ length: 26 }, (_, i) => ({ host: "b", startedAt: at(26 - i), endedAt: at(25.5 - i) }));
	const r = report([run("r", 0.4, 0.1, { attempt: 27, earlier: many })]);
	const b = r.hosts.find((h) => h.name === "b");
	assert.deepEqual([b.coverage.earlier, b.busyMs, r.coverage.earlierDropped], [4, 2 * H, 22], "a hand-edited record carries no more than the writer would write");
	// An entry overlapping its carrier's own run on the same host is the same slot twice: dropped and counted.
	const overlap = report([run("o", 3, 1, { attempt: 2, earlier: [{ host: "a", startedAt: at(2.5), endedAt: at(2) }, { host: "a", startedAt: at(5), endedAt: at(4) }, { host: "a b", startedAt: at(5), endedAt: at(4) }] })]);
	assert.deepEqual([overlap.hosts[0].coverage.earlier, overlap.hosts[0].busyMs, overlap.coverage.earlierDropped], [1, 3 * H, 2]);
	assert.deepEqual(report([run("n", 2, 1)]).coverage.earlierDropped, 0);
});

// Issue #599, phase 2: the jobs a live row lists as running now (`jobs`, live-jobs.mjs) are busy up to now.
const liveRow = (jobs, extra = {}) => ({ name: "a", concurrency: "2", staleMs: 5_000, jobs: JSON.stringify(jobs), jobsMore: "0", ...extra });
const job = (id, fromH, extra = {}) => ({ id, p: "web", m: 4096, c: 200, at: NOW - fromH * H, ...extra });

test("a job running now is busy from its admission to now, marked live, never in used, and adds no wait or CPU", () => {
	const r = report([run("done", 5, 4)], { live: [liveRow([job("now-1", 2)])] });
	const a = r.hosts.find((h) => h.name === "a");
	assert.equal(a.busyMs, 3 * H, "the record's hour and the running job's two");
	assert.deepEqual([a.coverage.used, a.coverage.live, a.coverage.liveNotCounted, a.coverage.withoutResources, a.waits.n], [1, 1, 0, 1, 0], "the record has no resources; the running job is not counted as without them");
	assert.equal(a.runs, 2);
	assert.deepEqual(a.projects.find((p) => p.project === "web"), { project: "web", runMs: 2 * H, cpuMs: 0 });
	assert.equal(a.buckets.at(-1).busyMs, H, "the last bucket is busy to its end");
	assert.equal(r.coverage.running, 1);
	// Its size is promised: 4096 of 16384 MiB for 2 of 24 hours is 1/48.
	assert.equal(a.promisedMemPerMille, 21);
	assert.equal(a.busyMs + a.idleMs + a.missingMs, DAY);
});

test("running jobs overlap like records: peak and full count them", () => {
	const a = hostA([run("r", 3, 0.5)], { live: [liveRow([job("x", 1), job("y", 2)])] });
	assert.equal(a.peak, 3);
	assert.equal(a.fullMs, 2 * H, "two or three at once from y's start 2h ago to now");
});

test("a stale row vouches for its jobs only up to its last beat", () => {
	assert.equal(LIVE_FRESH_MS, 30_000, "two beats");
	const fresh = hostA([], { live: [liveRow([job("x", 1)], { staleMs: LIVE_FRESH_MS })] });
	assert.equal(fresh.busyMs, H, "two beats old is fresh");
	const stale = hostA([], { live: [liveRow([job("x", 1)], { staleMs: LIVE_FRESH_MS + 1 })] });
	assert.equal(stale.busyMs, H - LIVE_FRESH_MS - 1, "ends at the beat");
	const noBeat = report([], { live: [liveRow([job("x", 1)], { staleMs: null })] }).hosts[0];
	assert.deepEqual([noBeat.busyMs, noBeat.coverage.live, noBeat.coverage.liveNotCounted], [0, 0, 1], "no beat known: not counted, and said");
});

test("a listed job whose record is already in the window is the record's, counted once", () => {
	const a = hostA([run("x", 1, 0.5)], { live: [liveRow([job("x", 1)])] });
	assert.deepEqual([a.busyMs, a.coverage.live, a.coverage.used], [30 * M, 0, 1]);
	// An EARLIER attempt's record (it started before this admission) does not hide the running retry.
	const retry = hostA([run("x", 3, 2)], { live: [liveRow([job("x", 1)])] });
	assert.deepEqual([retry.busyMs, retry.coverage.live], [2 * H, 1]);
});

test("an orphan is counted as an orphan, not as busy: its record covers its run", () => {
	const a = hostA([], { live: [liveRow([job("gone", 3, { o: 1 }), job("x", 1)])] });
	assert.deepEqual([a.busyMs, a.coverage.orphans, a.coverage.live], [H, 1, 1]);
});

test("running jobs a row does not list, or cannot vouch for, are counted as not counted", () => {
	const more = report([], { live: [liveRow([job("x", 1)], { jobsMore: "3" })] });
	assert.deepEqual([more.hosts[0].coverage.liveNotCounted, more.coverage.running], [3, 4]);
	// Hostile entries are dropped by the allowlist and counted, never read.
	const hostile = report([], { live: [liveRow([job("x", 1), { ...job("y", 1), id: "a/b" }, { ...job("z", 1), p: "Web\u001b[2J" }, { ...job("w", 1), at: "1" }, { ...job("v", 1), m: -1 }])] }).hosts[0];
	assert.deepEqual([hostile.coverage.live, hostile.coverage.liveNotCounted, hostile.busyMs], [1, 4, H]);
	// A job admitted more than the longest wall a run may have, or in the future past the skew: not counted.
	const old = report([], { live: [liveRow([job("x", (SUGGEST_MAX_WALL_MS + H) / H), job("y", -1)])] }).hosts[0];
	assert.deepEqual([old.coverage.live, old.coverage.liveNotCounted], [0, 2]);
	// A host whose history is not shared is missing as a whole: its running jobs are not counted either.
	const unshared = report([], { live: [liveRow([job("x", 1)], { routes: "false" })], coverage: { local: null, mirror: { fromMs: NOW - DAY, truncated: false, hosts: [] } } }).hosts[0];
	assert.deepEqual([unshared.shared, unshared.busyMs, unshared.coverage.liveNotCounted], [false, 0, 1]);
	// A raw string that is not a list: the row lists nothing, and without a budget says nothing.
	assert.equal(report([], { live: [{ name: "a", jobs: "{" }] }).coverage.running, null);
});

test("a running job that began before the host's covered window is clipped to it, never counted in the missing part", () => {
	const r = report([], { live: [liveRow([job("x", 20)])], coverage: { local: { fromMs: NOW - 10 * H }, localHost: "a" } });
	const a = r.hosts[0];
	assert.deepEqual([a.busyMs, a.missingMs, a.busyMs + a.idleMs + a.missingMs], [10 * H, 14 * H, DAY]);
	assert.equal(a.projects[0].runMs, 10 * H, "its project's run time is clipped too");
});

test("a row readLiveHosts already parsed (jobs an array, o a boolean, jobsMore a number) counts the same as the raw one", () => {
	const raw = report([], { live: [liveRow([job("x", 1), job("y", 2, { o: 1 })], { jobsMore: "2" })] }).hosts[0];
	const parsed = report([], { live: [{ name: "a", concurrency: "2", staleMs: 5_000, jobs: [{ id: "x", p: "web", m: 4096, c: 200, at: NOW - H, o: false }, { id: "y", p: "web", m: 4096, c: 200, at: NOW - 2 * H, o: true }], jobsMore: 2 }] }).hosts[0];
	assert.deepEqual([parsed.busyMs, parsed.coverage.live, parsed.coverage.orphans, parsed.coverage.liveNotCounted], [H, 1, 1, 2]);
	assert.deepEqual(parsed, raw);
});

test("a listed job whose id the row published as its digest is matched to its record, counted once", () => {
	const { publishedJobId } = rowIds;
	for (const raw of ["gl-a/b+c==", "x".repeat(200)]) {
		const row = liveRow([{ ...job("ignored", 2), id: publishedJobId(raw) }]);
		const a = hostA([run(raw, 2, 1 / 3600)], { live: [row] });
		assert.deepEqual([a.runs, a.coverage.live, a.peak], [1, 0, 1], raw.slice(0, 12));
	}
});

test("running counts what the rows say runs now: the jobs counted and those not, never one its record already counts", () => {
	const r = report([run("x", 1, 0.5)], { live: [liveRow([job("x", 1), job("y", 1), job("o", 3, { o: 1 })], { jobsMore: "2" })] });
	assert.deepEqual([r.coverage.live, r.coverage.liveNotCounted, r.coverage.orphans, r.coverage.running], [1, 2, 1, 3], "an orphan is not running");
});

test("a row whose jobs value is there and is not a list: its running jobs are unknown, said, and nothing stands in", () => {
	for (const row of [{ name: "a", staleMs: 1000, jobs: "{", jobsMore: "0", budgetRunning: "3" }, { name: "a", staleMs: 1000, jobs: null, jobsUnreadable: true, jobsMore: null, budgetRunning: "3" }]) {
		const r = report([], { live: [row] });
		assert.deepEqual([r.hosts[0].coverage.liveUnreadable, r.hosts[0].coverage.liveNotCounted, r.coverage.running], [1, 0, null], "the budget's count is not read in its place");
	}
	// A row from before the field (no jobs at all) still says how many run through its budget.
	const old = report([], { live: [{ name: "a", staleMs: 1000, budgetRunning: "3" }] });
	assert.deepEqual([old.hosts[0].coverage.liveUnreadable, old.coverage.running], [0, 3]);
});

test("one row whose list cannot be read makes the fleet's running count unknown, while the other rows' jobs still count", () => {
	const r = report([], { live: [liveRow([job("x", 1)]), { name: "b", staleMs: 1000, jobs: "[[", jobsMore: "0" }] });
	assert.deepEqual([r.coverage.live, r.coverage.liveUnreadable, r.coverage.running], [1, 1, null]);
});

test("why a host's history is not here: a row that does not route is unnamed; one that routes, with no mirror read, is unread", () => {
	const cov = { local: { fromMs: NOW - DAY }, localHost: "z", mirror: null, source: "local", reason: "run mirror unreachable (timeout): only this host's files were read" };
	const r = report([], { live: [{ name: "named", routes: "true" }, { name: "plain", routes: "false" }], coverage: cov });
	assert.deepEqual(r.hosts.map((h) => [h.name, h.shared, h.notShared]), [["named", false, "unread"], ["plain", false, "unnamed"]]);
	const read = report([], { live: [{ name: "plain", routes: "false" }], coverage: { ...cov, mirror: { fromMs: NOW - DAY, truncated: false, hosts: [] } } });
	assert.equal(read.hosts[0].notShared, "unnamed");
	assert.equal(report([run("1", 2, 1)]).hosts[0].notShared, null);
	// A row with no `routes` (it says nothing about the mirror) is not taken for a routing one.
	assert.equal(report([], { live: [{ name: "odd" }], coverage: cov }).hosts[0].notShared, "unnamed");
});
