import assert from "node:assert/strict";
import { test } from "node:test";
import { RECORD_CLOCK_SKEW_MS } from "../src/run-history.mjs";
import { neverFits } from "../src/host-budget.mjs";
import {
	CPU_REASONS,
	MEMORY_CAP_MISSING,
	MEMORY_HELD,
	MEMORY_REASONS,
	SIZE_FACTS,
	SUGGEST_CLOCK_SKEW_MS,
	SUGGEST_MAX_WALL_MS,
	SUGGEST_MIN_SAMPLES,
	SUGGEST_WINDOW_DAYS,
	SUGGEST_WINDOW_RUNS,
	peakSeries,
	refusalWords,
	roundCpusUp,
	sizeRefusal,
	coresText,
	cpusText,
	fleetCap,
	hostCap,
	roundMemoryUp,
	suggestSize,
	suggestionCall,
	suggestionEvidence,
} from "../src/size-suggest.mjs";

// The size suggestion (issue #596, phase 3, DES-SIZE-SUGGESTIONS): one pure function over run records, every rule
// boundary table-driven, every record judged again as untrusted. The clock is ALWAYS injected (`now`).

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const MIB = 1024 * 1024;
const MIN = 60 * 1000;
const WALL_MS = 10 * MIN;
const WALL_US = WALL_MS * 1000;
const CURRENT = { memMiB: 4096, cpuCenti: 200 };

/**
 * One run record of project `web`, ended `ago` minutes before NOW (each record a minute older by default), with a
 * memory peak in MiB (or `memPeak` in bytes), its size, CPU time as a fraction of a 10-minute wall, and throttling.
 */
function rec({ i = 0, ago = i + 1, project = "web", memMiB = 4096, cpuCenti = 200, peakMiB = 1024, memPeak = peakMiB * MIB, cores = 1, throttle = 0, full = 0, reason = null, resources = undefined, size = undefined, startedAt = undefined } = {}) {
	const end = NOW - ago * MIN;
	return {
		jobId: `job-${i}`,
		project,
		outcome: reason === "oom-killed" ? "policy" : "completed",
		reason,
		startedAt: startedAt === undefined ? new Date(end - WALL_MS).toISOString() : startedAt,
		endedAt: new Date(end).toISOString(),
		resources: resources === undefined ? { memPeak, swapPeak: 0, oomKills: reason === "oom-killed" ? 1 : 0, memSomeUsec: 0, memFullUsec: Math.round(full * WALL_US), cpuUsec: Math.round(cores * WALL_US), throttledUsec: Math.round(throttle * WALL_US), throttled: 0, pidsPeak: 10 } : resources,
		size: size === undefined ? { memMiB, cpuCenti, source: "project" } : size,
	};
}
const runs = (n, over = {}) => Array.from({ length: n }, (_, i) => rec({ i, ...over }));
// A cap that never binds, unless a test names one: the rules first, the cap in its own tests.
const ROOMY = { memMiB: 1024 * 1024, cpuCenti: 25600 };
const suggest = (records, { current = CURRENT, cap = ROOMY } = {}) => suggestSize({ project: "web", records, current, cap, now: NOW });
const mem = (records, opts) => suggest(records, opts).memory;
const cpu = (records, opts) => suggest(records, opts).cpu;

const NO = { fact: null, held: null, wanted: null, overBudget: false };

test("the window and the thresholds are the plan's: 30 days or 50 runs, 10 samples, and the clock skew is run-history's", () => {
	assert.deepEqual([SUGGEST_WINDOW_DAYS, SUGGEST_WINDOW_RUNS, SUGGEST_MIN_SAMPLES, SUGGEST_MAX_WALL_MS], [30, 50, 10, 7 * 24 * 60 * MIN]);
	assert.equal(SUGGEST_CLOCK_SKEW_MS, RECORD_CLOCK_SKEW_MS);
	// no at-limit memory reason and no throttled CPU reason: neither can say a larger size would help (see the module)
	assert.deepEqual(MEMORY_REASONS, ["oom-killed", "not-enough-runs", "oversized", "fits"]);
	assert.deepEqual(CPU_REASONS, ["not-enough-runs", "underused", "fits"]);
	assert.deepEqual(MEMORY_HELD, ["cap", "largest", "no-cap"]);
	assert.deepEqual(SIZE_FACTS, ["pressure", "ceiling"]);
});

test("a memory size rounds UP to its step: 256m to 2g, 512m to 8g, then 1g, never below 512m nor above the ceiling", () => {
	const table = [
		[0, 512],
		[100, 512],
		[512, 512],
		[513, 768],
		[1793, 2048],
		[2048, 2048], // the last 256m step
		[2049, 2560], // the first 512m step
		[3841, 4096],
		[8192, 8192], // the last 512m step
		[8193, 9216], // the first 1g step
		[9216, 9216],
		[9216.5, 10240],
		[1024 * 1024, 1024 * 1024],
		[1024 * 1024 + 1, 1024 * 1024], // the ceiling holds
	];
	for (const [given, want] of table) assert.equal(roundMemoryUp(given), want, `${given}m`);
});

test("a CPU size rounds UP to a 0.25 step, never below 0.25 nor above the ceiling", () => {
	const table = [
		[0, 25],
		[1, 25],
		[25, 25],
		[26, 50],
		[150, 150],
		[150.5, 175],
		[299, 300],
		[25600, 25600],
		[25601, 25600],
	];
	for (const [given, want] of table) assert.equal(roundCpusUp(given), want, `${given} hundredths`);
});

test("memory: fewer than 10 runs is not enough, exactly 10 decides", () => {
	const ev = (samples) => ({ samples, p95MiB: 3072, maxPeakMiB: 3072, ooms: 0, largestOomMiB: null, pressured: 0 });
	assert.deepEqual(mem(runs(9, { peakMiB: 3072 })), { current: 4096, suggested: null, reason: "not-enough-runs", evidence: ev(9), ...NO, cap: ROOMY.memMiB, capMissing: null });
	assert.deepEqual(mem(runs(10, { peakMiB: 3072 })), { current: 4096, suggested: null, reason: "fits", evidence: ev(10), ...NO, cap: ROOMY.memMiB, capMissing: null });
	assert.equal(mem([]).reason, "not-enough-runs");
	assert.deepEqual([mem([]).evidence.p95MiB, mem([]).evidence.maxPeakMiB], [null, null]);
});

test("memory: a peak AT the limit never raises (page cache alone drives memory.peak to the limit with no OOM)", () => {
	const limit = 4096 * MIB;
	// fifty runs, every one at its limit: no raise, whatever the share; the size fits.
	for (const n of [1, 2, 10, 50]) {
		const m = mem(runs(n, { memPeak: limit }));
		assert.deepEqual([m.reason, m.suggested, m.fact], [n < 10 ? "not-enough-runs" : "fits", null, null], `${n} at the limit`);
	}
	// an inflated peak is clamped to the limit and buys nothing either
	assert.deepEqual([mem(runs(20, { memPeak: Number.MAX_SAFE_INTEGER })).reason, mem(runs(20, { memPeak: Number.MAX_SAFE_INTEGER })).suggested], ["fits", null]);
});

test("memory: a FACT, no call, when runs at the limit were stalled for memory MORE than 1% of their wall", () => {
	const limit = 4096 * MIB;
	const at = (memFullUsec, memPeak = limit) => mem(runs(10, { resources: { memPeak, cpuUsec: WALL_US, throttledUsec: 0, memFullUsec } }));
	assert.deepEqual([at(WALL_US / 100).fact, at(WALL_US / 100).evidence.pressured], [null, 0], "exactly 1% is not");
	assert.deepEqual([at(WALL_US / 100 + 1).fact, at(WALL_US / 100 + 1).evidence.pressured, at(WALL_US / 100 + 1).suggested, at(WALL_US / 100 + 1).reason], ["pressure", 10, null, "fits"]);
	// at the limit means 90% of it or more: at 5g, 90% is an exact byte count
	const five = { memMiB: 5120, cpuCenti: 200 };
	const exact = (5120 * MIB * 9) / 10;
	assert.equal(Number.isInteger(exact), true);
	const near = (peak) => mem(runs(10, { memMiB: 5120, memPeak: peak, full: 0.5 }), { current: five }).evidence.pressured;
	assert.deepEqual([near(exact), near(exact - 1)], [10, 0]);
	// stalled but well below the limit is not at the limit; a run with no wall time gives no pressure reading
	assert.equal(mem(runs(10, { peakMiB: 1000, full: 0.5 })).fact, null);
	assert.equal(mem(runs(10, { memPeak: limit, full: 0.5, startedAt: null })).fact, null);
	// a junk stall time is ignored; one past the wall is above 1% of it
	for (const memFullUsec of [-1, 1.5, "600000000", null]) assert.equal(at(memFullUsec).evidence.pressured, 0, String(memFullUsec));
	assert.equal(at(Number.MAX_SAFE_INTEGER).evidence.pressured, 10);
	// a pressured run with an OOM: the OOM raises and the fact rides along
	const both = mem([rec({ i: 0, reason: "oom-killed", memPeak: limit, full: 0.5 })]);
	assert.deepEqual([both.reason, both.suggested, both.fact], ["oom-killed", 6144, "pressure"]);
});

test("the p95 and p50 are the nearest rank: of 10 runs the p95 is the largest, of 9 the p50 is the 5th", () => {
	// 10 distinct peaks: the p95 rank is ceil(9.5) = 10, the largest, never the 9th.
	const ten = Array.from({ length: 10 }, (_, i) => rec({ i, peakMiB: 1000 + 100 * i }));
	assert.equal(mem(ten).evidence.p95MiB, 1900);
	// 9 runs of distinct throttling: the p50 rank is ceil(4.5) = 5, the 5th smallest share (30%), never the 4th (24%).
	// Nine runs decide nothing for CPU, so the rank is read through the evidence.
	const nine = Array.from({ length: 9 }, (_, i) => rec({ i, cores: 2, throttle: [0.1, 0.2, 0.22, 0.24, 0.3, 0.4, 0.5, 0.6, 0.7][i] }));
	assert.equal(cpu(nine).evidence.throttledPct, 30);
});

test("an OOM is the record's reason, never its outcome alone: another policy refusal is no OOM", () => {
	const refused = { ...rec({ peakMiB: 4096 }), outcome: "policy", reason: "cost-cap" };
	assert.deepEqual([mem([refused]).evidence.ooms, mem([refused]).reason, mem([refused]).suggested], [0, "not-enough-runs", null]);
});

test("memory: an OOM raises ONE step, to 1.5x the larger of the size and the largest OOM-killed size in the window", () => {
	const oom = rec({ i: 0, reason: "oom-killed", peakMiB: 4096 });
	assert.deepEqual(mem([oom]), { current: 4096, suggested: 6144, reason: "oom-killed", evidence: { samples: 1, p95MiB: 4096, maxPeakMiB: 4096, ooms: 1, largestOomMiB: 4096, pressured: 0 }, fact: null, held: null, wanted: 6144, cap: ROOMY.memMiB, capMissing: null, overBudget: false });
	// an OOM at a LARGER size than now (a lowering that went too far): 1.5x of that size, 8g -> 12g
	assert.equal(mem([rec({ i: 0, memMiB: 8192, reason: "oom-killed", peakMiB: 8192 })]).suggested, 12288);
	// the p95 asks for nothing: heavy runs at 8g beside an OOM at 4g still raise to 6g, not 1.25x their 7g
	const big = Array.from({ length: 19 }, (_, i) => rec({ i: 10 + i, memMiB: 8192, peakMiB: 7168 }));
	assert.deepEqual([mem([oom, ...big]).reason, mem([oom, ...big]).suggested], ["oom-killed", 6144]);
	// an OOM beats a lowering: nine tiny runs and one OOM still raise.
	assert.equal(mem([oom, ...runs(9, { ago: 30, peakMiB: 100 })]).reason, "oom-killed");
	// raised to 3g after an OOM at 2g, then killed again at 3g: 1.5 x 3g, the older OOM is not counted twice
	const three = { memMiB: 3072, cpuCenti: 200 };
	const again = [rec({ i: 0, memMiB: 2048, reason: "oom-killed", peakMiB: 2048, ago: 90 }), rec({ i: 1, memMiB: 3072, reason: "oom-killed", peakMiB: 3072 })];
	assert.deepEqual([mem(again, { current: three }).suggested, mem(again, { current: three }).evidence.ooms], [4608, 1]);
});

test("memory: an OOM at a SMALLER size than now does not ask again, so a raise is one step per OOM at the size applied", () => {
	const old = Array.from({ length: 3 }, (_, i) => rec({ i, memMiB: 4096, reason: "oom-killed", peakMiB: 4096 }));
	const now6 = { memMiB: 6144, cpuCenti: 200 };
	assert.deepEqual([mem(old, { current: now6 }).reason, mem(old, { current: now6 }).evidence.samples, mem(old, { current: now6 }).suggested], ["not-enough-runs", 0, null]);
	assert.equal(mem([...old, ...Array.from({ length: 10 }, (_, i) => rec({ i: 10 + i, memMiB: 6144, peakMiB: 4500 }))], { current: now6 }).reason, "fits");
	// a job that is OOM-killed on purpose at every size climbs one 1.5x step per new OOM, and stops at the cap
	const cap = { memMiB: 16384, cpuCenti: 800 };
	let cur = { memMiB: 2048, cpuCenti: 200 };
	const history = [];
	const sizes = [];
	for (let step = 0; step < 20; step++) {
		history.push(rec({ i: step, ago: 100 - step, memMiB: cur.memMiB, reason: "oom-killed", peakMiB: cur.memMiB }));
		const m = mem(history, { current: cur, cap });
		if (m.suggested === null) {
			assert.equal(m.held, "largest");
			break;
		}
		assert.ok(m.suggested <= roundMemoryUp((cur.memMiB * 3) / 2) && m.suggested <= cap.memMiB, `${cur.memMiB} -> ${m.suggested}`);
		sizes.push(m.suggested);
		cur = { ...cur, memMiB: m.suggested };
	}
	assert.deepEqual(sizes, [3072, 4608, 7168, 11264, 16384]);
});

test("memory: a raise is held to the cap, says when the size already is the largest, and offers no call with no cap known", () => {
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	const table = [
		// [cap, suggested, held]
		[{ memMiB: 8192 }, 6144, null],
		[{ memMiB: 6144 }, 6144, null],
		[{ memMiB: 5120 }, 5120, "cap"], // the runs ask for 6g, this host offers 5g
		[{ memMiB: 4096 }, null, "largest"], // already the cap
		[{ memMiB: 2048 }, null, "largest"], // already past it
		[{ memMiB: null }, null, "no-cap"],
		[{ memMiB: Infinity }, null, "no-cap"], // off is no number: hostCap turns it into the host's total first
		[{ memMiB: 0 }, null, "no-cap"],
		[null, null, "no-cap"],
	];
	for (const [cap, suggested, held] of table) {
		const m = mem(oom, { cap });
		assert.deepEqual([m.suggested, m.held, m.wanted, m.reason, m.overBudget], [suggested, held, 6144, "oom-killed", false], JSON.stringify(cap));
	}
	// the largest size there is, with no cap known: still "largest", never a call
	const top = { memMiB: 1024 * 1024, cpuCenti: 200 };
	const m = mem([rec({ memMiB: 1024 * 1024, reason: "oom-killed", peakMiB: 1024 * 1024 })], { current: top, cap: null });
	assert.deepEqual([m.reason, m.suggested, m.held], ["oom-killed", null, "largest"]);
});

test("memory: it lowers only when 1.25x the p95 is at most 0.75x the size, to that target rounded up", () => {
	const current = { memMiB: 5120, cpuCenti: 200 }; // 0.75 x 5g = 3840m = 1.25 x 3072m
	const at = (memPeak) => mem(runs(10, { memMiB: 5120, memPeak }), { current });
	assert.deepEqual([at(3072 * MIB).reason, at(3072 * MIB).suggested], ["oversized", 4096]); // exactly 0.75x: 3840m rounds up to 4g
	assert.deepEqual([at(3072 * MIB + 1).reason, at(3072 * MIB + 1).suggested], ["fits", null]); // a byte more keeps it
});

test("memory: a lowering never goes below 1.25x the window's largest peak, so the p95 cannot drop the heavy runs", () => {
	// the deflation case: 48 runs at 300m and 2 at 6000m with 8g. The p95 of 50 is the 48th (300m), and 1.25 x 300m is
	// far under 0.75 x 8g, but 6000m / 0.8 = 7500m: the lowering stops at 7.5g.
	const eight = { memMiB: 8192, cpuCenti: 200 };
	const deflated = [...runs(48, { memMiB: 8192, peakMiB: 300, ago: 10 }).map((r, i) => ({ ...r, endedAt: new Date(NOW - (10 + i) * MIN).toISOString(), startedAt: new Date(NOW - (20 + i) * MIN).toISOString() })), rec({ i: 90, memMiB: 8192, peakMiB: 6000 }), rec({ i: 91, memMiB: 8192, peakMiB: 6000 })];
	const d = mem(deflated, { current: eight });
	assert.deepEqual([d.evidence.samples, d.evidence.p95MiB, d.evidence.maxPeakMiB, d.reason, d.suggested], [50, 300, 6000, "oversized", 7680]);
	assert.ok(d.suggested >= 7680, "never below 7.5g");
	// one heavy run of twenty holds a 5g size up: 5000m / 0.8 rounds up to 6.5g, above the size, so it fits
	const five = { memMiB: 5120, cpuCenti: 200 };
	const one = mem([...runs(19, { memMiB: 5120, peakMiB: 1000 }), rec({ i: 40, memMiB: 5120, peakMiB: 5000 })], { current: five });
	assert.deepEqual([one.evidence.p95MiB, one.reason, one.suggested], [1000, "fits", null]);
	// the floor binds and it still lowers: 8g, p95 1000m, the heaviest 4000m: 5g, not 1280m
	const four = mem([...runs(19, { memMiB: 8192, peakMiB: 1000 }), rec({ i: 40, memMiB: 8192, peakMiB: 4000 })], { current: eight });
	assert.deepEqual([four.reason, four.suggested], ["oversized", 5120]);
	// the heaviest run at a SMALLER size counts too (its peak clamped to its own limit): 2g / 0.8 = 2.5g
	const small = mem([...runs(20, { memMiB: 8192, peakMiB: 500 }), rec({ i: 40, memMiB: 2048, peakMiB: 2048 })], { current: eight });
	assert.deepEqual([small.reason, small.suggested], ["oversized", 2560]);
});

test("memory: a lowering never goes below 1.5x the largest OOM-killed size in the window (no flip-flop)", () => {
	// OOM at 2g, raised to 3g, then 49 calm runs at 1000m: 1.25 x 1000m = 1250m, but 1.5 x 2g = 3g holds the size.
	const three = { memMiB: 3072, cpuCenti: 200 };
	const calm = [rec({ i: 0, memMiB: 2048, reason: "oom-killed", peakMiB: 2048, ago: 60 }), ...runs(49, { memMiB: 3072, peakMiB: 1000 })];
	const f = mem(calm, { current: three });
	assert.deepEqual([f.reason, f.suggested, f.evidence.largestOomMiB], ["fits", null, 2048]);
	// with room to lower, it lowers to the OOM floor, never to the p95: 8g, an OOM at 2g, runs at 500m: 3g
	const eight = { memMiB: 8192, cpuCenti: 200 };
	const room = mem([rec({ i: 0, memMiB: 2048, reason: "oom-killed", peakMiB: 2048, ago: 60 }), ...runs(20, { memMiB: 8192, peakMiB: 500 })], { current: eight });
	assert.deepEqual([room.reason, room.suggested], ["oversized", 3072]);
	// once the OOM leaves the window (the 50 newest), the floor goes with it
	const later = mem([rec({ i: 0, memMiB: 2048, reason: "oom-killed", peakMiB: 2048, ago: 60 }), ...runs(50, { memMiB: 8192, peakMiB: 500 })], { current: eight });
	assert.deepEqual([later.reason, later.suggested], ["oversized", 768]);
});

test("memory: a lowering never goes below the 512m floor, and one that would round back to the size is fits", () => {
	assert.deepEqual([mem(runs(10, { memMiB: 1024, peakMiB: 100 }), { current: { memMiB: 1024, cpuCenti: 200 } }).suggested], [512]);
	const floor = mem(runs(10, { memMiB: 512, peakMiB: 100 }), { current: { memMiB: 512, cpuCenti: 200 } });
	assert.deepEqual([floor.reason, floor.suggested], ["fits", null]);
	// 9g: 0.75 x 9216 = 6912; a p95 of 5529m targets 6912 (1.25 x 5529.6 rounds to 6912), rounded up to 7g.
	const nine = mem(runs(10, { memMiB: 9216, memPeak: Math.floor(5529.6 * MIB) }), { current: { memMiB: 9216, cpuCenti: 200 } });
	assert.deepEqual([nine.reason, nine.suggested], ["oversized", 7168]);
});

test("CPU: fewer than 10 runs is not enough, exactly 10 decides", () => {
	const ev = (samples) => ({ samples, p95CoresCenti: 150, maxCoresCenti: 150, throttledPct: 0 });
	assert.deepEqual(cpu(runs(9, { cores: 1.5 })), { current: 200, suggested: null, reason: "not-enough-runs", evidence: ev(9), ...NO, cap: ROOMY.cpuCenti, capMissing: null });
	assert.deepEqual(cpu(runs(10, { cores: 1.5 })), { current: 200, suggested: null, reason: "fits", evidence: ev(10), ...NO, cap: ROOMY.cpuCenti, capMissing: null });
	// even fully throttled: nine runs decide nothing for CPU, and carry no fact
	assert.deepEqual([cpu(runs(9, { cores: 2, throttle: 1 })).reason, cpu(runs(9, { cores: 2, throttle: 1 })).fact], ["not-enough-runs", null]);
});

test("CPU: throttling NEVER raises (--cpus is the host's ceiling); the median run throttled MORE than 25% is a fact, no call", () => {
	const at = (throttledUsec) => cpu(runs(10, { cores: 2, resources: { memPeak: MIB, cpuUsec: 2 * WALL_US, throttledUsec } }));
	assert.deepEqual([at(WALL_US / 4).reason, at(WALL_US / 4).suggested, at(WALL_US / 4).fact, at(WALL_US / 4).evidence.throttledPct], ["fits", null, null, 25]);
	assert.deepEqual([at(WALL_US / 4 + 1).reason, at(WALL_US / 4 + 1).suggested, at(WALL_US / 4 + 1).fact], ["fits", null, "ceiling"]);
	// the p50 is the 5th of 10 by throttle: five heavily throttled runs do not decide, six do.
	const mix = (heavy) => [...runs(heavy, { cores: 2, throttle: 0.9 }), ...Array.from({ length: 10 - heavy }, (_, i) => rec({ i: 20 + i, cores: 2, throttle: 0 }))];
	assert.deepEqual([cpu(mix(5)).fact, cpu(mix(6)).fact], [null, "ceiling"]);
	// throttled at the smallest size and at the largest: no raise either way
	assert.deepEqual([cpu(runs(10, { cpuCenti: 25, cores: 0.25, throttle: 0.9 }), { current: { memMiB: 4096, cpuCenti: 25 } }).suggested, cpu(runs(10, { cpuCenti: 25, cores: 0.25, throttle: 0.9 }), { current: { memMiB: 4096, cpuCenti: 25 } }).fact], [null, "ceiling"]);
	// the fact rides along with a lowering too: a mostly idle job that waited on the ceiling in bursts
	const idle = cpu(runs(10, { cpuCenti: 400, cores: 0.5, throttle: 0.5 }), { current: { memMiB: 4096, cpuCenti: 400 } });
	assert.deepEqual([idle.reason, idle.suggested, idle.fact], ["underused", 75, "ceiling"]);
});

test("CPU: the p95 cores used BELOW 0.4x the cpus lowers to 1.25x that p95; exactly 0.4x keeps it", () => {
	const at = (cpuUsec) => cpu(runs(10, { resources: { memPeak: MIB, cpuUsec, throttledUsec: 0 } }));
	assert.deepEqual([at(0.8 * WALL_US).reason, at(0.8 * WALL_US).suggested], ["fits", null]); // exactly 0.4 x 2
	assert.deepEqual([at(0.8 * WALL_US - 1).reason, at(0.8 * WALL_US - 1).suggested], ["underused", 100]); // 1.25 x 0.8 = 1
	// the floor: an idle 1-CPU job goes to 0.25, and an idle 0.25 job stays.
	assert.equal(cpu(runs(10, { cpuCenti: 100, cores: 0 }), { current: { memMiB: 4096, cpuCenti: 100 } }).suggested, 25);
	assert.equal(cpu(runs(10, { cpuCenti: 25, cores: 0 }), { current: { memMiB: 4096, cpuCenti: 25 } }).reason, "fits");
	// a lowering that rounds back up to the size is fits
	assert.equal(cpu(runs(10, { cpuCenti: 50, cores: 0.19 }), { current: { memMiB: 4096, cpuCenti: 50 } }).suggested, 25);
	assert.equal(cpu(runs(10, { cpuCenti: 25, cores: 0.09 }), { current: { memMiB: 4096, cpuCenti: 25 } }).reason, "fits");
});

test("CPU: a lowering never goes below 1.25x the window's busiest run", () => {
	// one burst of 2 cores among nineteen at 0.2 holds 2 CPUs up: 1.25 x 2 = 2.5 is above the size, so it fits
	const burst = cpu([...runs(19, { cores: 0.2 }), rec({ i: 40, cores: 2 })]);
	assert.deepEqual([burst.evidence.p95CoresCenti, burst.evidence.maxCoresCenti, burst.reason, burst.suggested], [20, 200, "fits", null]);
	// the floor binds and it still lowers: 4 CPUs, p95 0.5, the busiest 1.2: 1.5, not 0.75
	const four = { memMiB: 4096, cpuCenti: 400 };
	assert.equal(cpu([...runs(19, { cpuCenti: 400, cores: 0.5 }), rec({ i: 40, cpuCenti: 400, cores: 1.2 })], { current: four }).suggested, 150);
	// the busiest run at a SMALLER size counts too: 2.4 cores at 1 CPU (the size is a weight, --cpus the host's)
	assert.equal(cpu([...runs(20, { cpuCenti: 400, cores: 0.5 }), rec({ i: 40, cpuCenti: 100, cores: 2.4 })], { current: four }).suggested, 300);
});

test("CPU: a lowering is 1.25x the p95 cores, not the p95 itself", () => {
	// 1 core of 4: below 0.4 x 4 = 1.6, and 1.25 x 1 = 1.25.
	assert.equal(cpu(runs(10, { cpuCenti: 400, cores: 1 }), { current: { memMiB: 4096, cpuCenti: 400 } }).suggested, 125);
});

test("CPU: the p95 orders runs by cores used (CPU time over wall time), not by CPU time", () => {
	// nine short runs at 0.2 cores, one run ten times as long at 0.1 cores: the most CPU time, the fewest cores.
	const short = Array.from({ length: 9 }, (_, i) => rec({ i, cores: 0.2 }));
	const end = NOW - 30 * MIN;
	const long = { ...rec({ i: 20 }), startedAt: new Date(end - 100 * MIN).toISOString(), endedAt: new Date(end).toISOString(), resources: { memPeak: MIB, cpuUsec: 0.1 * 100 * MIN * 1000, throttledUsec: 0 } };
	assert.deepEqual([cpu([...short, long]).evidence.p95CoresCenti, cpu([...short, long]).evidence.maxCoresCenti], [20, 20]);
	// and the p50 throttle share likewise: the long run's large throttled time is a small share of its wall.
	const longThrottled = { ...long, resources: { memPeak: MIB, cpuUsec: 0, throttledUsec: 20 * MIN * 1000 } };
	const shortThrottled = Array.from({ length: 9 }, (_, i) => rec({ i, cores: 1, throttle: [0.3, 0.3, 0.3, 0.3, 0.3, 0, 0, 0, 0][i] }));
	assert.equal(cpu([...shortThrottled, longThrottled]).evidence.throttledPct, 20);
});

test("CPU: runs given fewer cpus than now are not evidence for the rules", () => {
	const old = runs(10, { cpuCenti: 200, cores: 0.1 });
	assert.equal(cpu(old, { current: { memMiB: 4096, cpuCenti: 300 } }).reason, "not-enough-runs");
	assert.deepEqual([cpu(old).reason, cpu(old).suggested], ["underused", 25]);
});

test("peakSeries: the same runs a suggestion reads, oldest first, judged the same way", () => {
	const list = [rec({ i: 0, peakMiB: 3000 }), rec({ i: 1, memPeak: Number.MAX_SAFE_INTEGER, reason: "oom-killed" }), rec({ i: 2, memPeak: -5 }), rec({ i: 3, project: "api" }), rec({ i: 4, ago: 31 * 24 * 60 })];
	assert.deepEqual(peakSeries({ project: "web", records: list, now: NOW }), [
		{ at: NOW - 2 * MIN, peakMiB: 4096, sizeMiB: 4096, oom: true },
		{ at: NOW - MIN, peakMiB: 3000, sizeMiB: 4096, oom: false },
	]);
	assert.throws(() => peakSeries({ project: "web", records: list }), /needs `now`/);
});

test("the window: the project's runs of the last 30 days, newest first, at most 50; other projects and old records are not read", () => {
	const fits = Array.from({ length: 50 }, (_, i) => rec({ i, peakMiB: 3072 }));
	const olderOoms = Array.from({ length: 10 }, (_, i) => rec({ i: 100 + i, ago: 1000 + i, reason: "oom-killed", peakMiB: 4096 }));
	const s = suggest([...olderOoms, ...fits]);
	assert.deepEqual([s.runs, s.memory.reason, s.memory.evidence.ooms, s.memory.evidence.largestOomMiB], [50, "fits", 0, null], "the 50 newest decide");
	assert.equal(suggest([...olderOoms, ...fits.slice(0, 49)]).memory.reason, "oom-killed", "with 49 newer, the 50th is an OOM");
	const day = 24 * 60;
	const edge = (ago) => suggest([rec({ ago, reason: "oom-killed", peakMiB: 4096 })]).memory.reason;
	assert.equal(edge(30 * day), "oom-killed", "exactly 30 days ago is in");
	assert.equal(edge(30 * day + 1), "not-enough-runs", "a minute older is out");
	assert.equal(edge(-5), "oom-killed", "five minutes in the future is skew");
	assert.equal(edge(-6), "not-enough-runs", "six is not");
	assert.equal(suggest(runs(10, { project: "api", reason: "oom-killed" })).runs, 0);
	assert.equal(suggest(runs(10, { project: null })).runs, 0);
});

test("records from before resources or size are ignored, never guessed", () => {
	const old = [...runs(5, { resources: null }), ...runs(5, { size: null }), ...runs(5, { resources: undefined, size: { memMiB: 4096 } })];
	assert.equal(suggest(old).runs, 0);
	assert.equal(suggest(old).memory.reason, "not-enough-runs");
	// a record from before the field has no key at all, or one a hand edit left as a bare value
	const keyless = runs(3).map(({ resources, size, ...rest }) => ({ ...rest, size }));
	const bare = [{ ...rec(), resources: 7 }, { ...rec(), resources: "x" }];
	assert.equal(suggest([...keyless, ...bare]).runs, 0);
	// a record with no endedAt, or junk timestamps, is not in any window
	assert.equal(suggest([{ ...rec(), endedAt: null }, { ...rec(), endedAt: "yesterday" }, null, "x", [], 7]).runs, 0);
});

test("adversarial resources: a non-integer field is ignored, a value past the container's bounds is clamped", () => {
	const r = (resources) => rec({ resources: { cpuUsec: WALL_US, throttledUsec: 0, ...resources } });
	// a memory peak that is not a safe non-negative integer leaves the memory dimension; the CPU sample stays.
	for (const memPeak of [-1, 1.5, "4294967296", 2 ** 60, Number.NaN, null, undefined, true, {}]) {
		const s = suggest([r({ memPeak })]);
		assert.deepEqual([s.runs, s.memory.evidence.samples, s.cpu.evidence.samples], [1, 0, 1], `memPeak ${String(memPeak)}`);
	}
	// a huge but safe peak is clamped to the run's own limit: it reads AT the limit, and asks for nothing.
	const huge = suggest(Array.from({ length: 2 }, (_, i) => rec({ i, memPeak: Number.MAX_SAFE_INTEGER })));
	assert.deepEqual([huge.memory.evidence.p95MiB, huge.memory.evidence.maxPeakMiB, huge.memory.reason, huge.memory.suggested], [4096, 4096, "not-enough-runs", null]);
	// CPU time past 256 cores of the wall is clamped there; throttled time past the wall reads as all of it; neither raises.
	const wild = suggest(runs(10, { resources: { memPeak: MIB, cpuUsec: Number.MAX_SAFE_INTEGER, throttledUsec: Number.MAX_SAFE_INTEGER } })).cpu;
	assert.deepEqual([wild.evidence.p95CoresCenti, wild.evidence.maxCoresCenti, wild.evidence.throttledPct, wild.reason, wild.suggested, wild.fact], [25600, 25600, 100, "fits", null, "ceiling"]);
	// a negative or fractional CPU field, or a missing one, leaves the CPU dimension; the memory sample stays.
	for (const bad of [{ cpuUsec: -1 }, { cpuUsec: 0.5 }, { throttledUsec: "0" }, { throttledUsec: null }, { cpuUsec: undefined }]) {
		const s = suggest([r({ memPeak: MIB, ...bad })]);
		assert.deepEqual([s.memory.evidence.samples, s.cpu.evidence.samples], [1, 0], JSON.stringify(bad));
	}
	// a record whose resources are an array, or a size out of range or of another shape, is no evidence at all.
	assert.equal(suggest([rec({ resources: [1, 2] }), rec({ size: { memMiB: 100, cpuCenti: 200, source: "project" } }), rec({ size: { memMiB: 4096, cpuCenti: 1.5, source: "project" } }), rec({ size: { memMiB: 4096, cpuCenti: 200, source: "guess" } })]).runs, 0);
});

test("adversarial wall times: none, negative, zero or past 7 days give no CPU sample, and the memory sample stays", () => {
	const end = NOW - MIN;
	for (const startedAt of [null, "", "soon", new Date(end).toISOString(), new Date(end + MIN).toISOString(), new Date(end - SUGGEST_MAX_WALL_MS - 1).toISOString()]) {
		const s = suggest([rec({ ago: 1, startedAt })]);
		assert.deepEqual([s.memory.evidence.samples, s.cpu.evidence.samples], [1, 0], String(startedAt));
	}
	assert.equal(suggest([rec({ ago: 1, startedAt: new Date(end - SUGGEST_MAX_WALL_MS).toISOString() })]).cpu.evidence.samples, 1, "exactly 7 days counts");
});

test("a LOWERING still above the cap is flagged (the size is already larger than the host); a held raise never is", () => {
	const sixteen = { memMiB: 16384, cpuCenti: 200 };
	const low = (cap) => mem(runs(10, { memMiB: 16384, peakMiB: 1000 }), { current: sixteen, cap });
	assert.deepEqual([low({ memMiB: 1279 }).suggested, low({ memMiB: 1279 }).overBudget], [1280, true]);
	assert.equal(low({ memMiB: 1280 }).overBudget, false, "equal to the cap fits");
	for (const cap of [null, { memMiB: null }, { memMiB: Infinity }, {}]) assert.equal(low(cap).overBudget, false, JSON.stringify(cap));
	assert.equal(mem([rec({ reason: "oom-killed", peakMiB: 4096 })], { cap: { memMiB: 5120 } }).overBudget, false);
	const four = { memMiB: 4096, cpuCenti: 400 };
	assert.deepEqual([cpu(runs(10, { cpuCenti: 400, cores: 0.2 }), { current: four, cap: { cpuCenti: 24 } }).overBudget, cpu(runs(10, { cpuCenti: 400, cores: 0.2 }), { current: four, cap: { cpuCenti: 25 } }).overBudget], [true, false]);
});

test("hostCap: this host's budget per dimension, else (off or unknown) its own total, else nothing known", () => {
	const table = [
		[{ memMiB: 5120, cpuCenti: 700 }, { memMiB: 16384, cpuCenti: 800 }, { memMiB: 5120, cpuCenti: 700 }],
		[{ memMiB: Infinity, cpuCenti: null }, { memMiB: 16384, cpuCenti: 800 }, { memMiB: 16384, cpuCenti: 800 }],
		[{ memMiB: Infinity, cpuCenti: Infinity }, null, { memMiB: null, cpuCenti: null }],
		[null, { memMiB: 0, cpuCenti: -1 }, { memMiB: null, cpuCenti: null }],
		[{ memMiB: 0, cpuCenti: 300 }, { memMiB: 2048 }, { memMiB: 2048, cpuCenti: 300 }],
	];
	for (const [budget, total, want] of table) assert.deepEqual(hostCap(budget, total), want, JSON.stringify([budget, total]));
});

test("hostCap and fleetCap: a project with a hostShare is capped at floor(budget x share / 100), never the whole budget", () => {
	// the worker refuses a job above the share (job-size-exceeds-share), so a raise capped at the whole budget would
	// offer a call to a size this project never runs at
	const table = [
		[{ memMiB: 16384, cpuCenti: 800 }, null, 50, { memMiB: 8192, cpuCenti: 400 }],
		[{ memMiB: 10241, cpuCenti: 701 }, null, 50, { memMiB: 5120, cpuCenti: 350 }], // floored, never rounded past
		[{ memMiB: 16384, cpuCenti: 800 }, null, 100, { memMiB: 16384, cpuCenti: 800 }],
		[{ memMiB: 16384, cpuCenti: 800 }, null, null, { memMiB: 16384, cpuCenti: 800 }],
		// a share of an off or unknown budget refuses nothing: the runtime's own total caps it, whole
		[{ memMiB: Infinity, cpuCenti: null }, { memMiB: 16384, cpuCenti: 800 }, 50, { memMiB: 16384, cpuCenti: 800 }],
	];
	for (const [budget, total, share, want] of table) assert.deepEqual(hostCap(budget, total, share), want, JSON.stringify([budget, total, share]));
	const cur = { memMiB: 4096, cpuCenti: 200 };
	assert.deepEqual(fleetCap([{ memMiB: 16384, cpuCenti: 800 }], cur, 50), { memMiB: 8192, cpuCenti: 400 });
	// the other dimension is judged at the share too: 50% of 3 CPUs is 1.5, which does not hold a 2-CPU job
	assert.deepEqual(fleetCap([{ memMiB: 32768, cpuCenti: 300 }, { memMiB: 8192, cpuCenti: 800 }], cur, 50), { memMiB: 4096, cpuCenti: 400 });
	assert.deepEqual(fleetCap([{ memMiB: 32768, cpuCenti: 300 }, { memMiB: 8192, cpuCenti: 800 }], cur), { memMiB: 32768, cpuCenti: 800 });
	// and suggestSize threads it: an OOM at 6g wants 9g, 50% of 16g is 8g, so the raise is held at 8g on either path
	const oom = [rec({ memMiB: 6144, reason: "oom-killed", peakMiB: 6144 })];
	const six = { memMiB: 6144, cpuCenti: 200 };
	const viaHosts = suggestSize({ project: "web", records: oom, current: six, hosts: [{ memMiB: 16384, cpuCenti: 800 }], hostShare: 50, now: NOW }).memory;
	const viaCap = suggestSize({ project: "web", records: oom, current: six, cap: hostCap({ memMiB: 16384, cpuCenti: 800 }, null, 50), now: NOW }).memory;
	for (const m of [viaHosts, viaCap]) assert.deepEqual([m.suggested, m.held, m.wanted, m.cap, m.overBudget], [8192, "cap", 9216, 8192, false]);
	assert.equal(suggestSize({ project: "web", records: oom, current: six, hosts: [{ memMiB: 16384, cpuCenti: 800 }], now: NOW }).memory.suggested, 9216);
});

test("a raise with no cap across live hosts says why: none read, none holds the size, or every budget off", () => {
	assert.deepEqual(MEMORY_CAP_MISSING, ["unread", "none-holds", "off"]);
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	const why = (hosts, hostShare = null) => {
		const s = suggestSize({ project: "web", records: oom, current: CURRENT, hosts, hostShare, now: NOW });
		return [s.memory.held, s.memory.capMissing, s.cpu.capMissing];
	};
	assert.deepEqual(why([]), ["no-cap", "unread", null]);
	assert.deepEqual(why([{ memMiB: null, cpuCenti: null }]), ["no-cap", "unread", null]);
	assert.deepEqual(why([{ memMiB: Infinity, cpuCenti: 800 }, { memMiB: Infinity, cpuCenti: Infinity }]), ["no-cap", "off", null]);
	// off and unknown mixed: not EVERY budget is off, so it was not read as a number
	assert.deepEqual(why([{ memMiB: Infinity, cpuCenti: 800 }, { memMiB: null, cpuCenti: 800 }]), ["no-cap", "unread", null]);
	// budgets read, but no host's CPUs hold this 2-CPU job (one has 1 CPU, one has 3 of which a 50% share is 1.5)
	assert.deepEqual(why([{ memMiB: 16384, cpuCenti: 100 }]), ["no-cap", "none-holds", null]);
	assert.deepEqual(why([{ memMiB: 16384, cpuCenti: 300 }], 50), ["no-cap", "none-holds", null]);
	// a cap found: nothing missing; and a single host's cap (doctor) never says why, its own words do
	assert.deepEqual(why([{ memMiB: 16384, cpuCenti: 800 }]), [null, null, null]);
	assert.equal(suggestSize({ project: "web", records: oom, current: CURRENT, cap: null, now: NOW }).memory.capMissing, null);
	// no raise, no reason: a project that fits says nothing about a cap, even with none read
	assert.equal(suggestSize({ project: "web", records: runs(10, { peakMiB: 3072 }), current: CURRENT, hosts: [], now: NOW }).memory.capMissing, null);
});

test("fleetCap: each host judged on its OWN pair, never the largest per dimension across hosts", () => {
	const cur = { memMiB: 4096, cpuCenti: 200 };
	const table = [
		[[], { memMiB: null, cpuCenti: null }],
		// a 16g host with 1 CPU cannot run this 2-CPU job: its memory is no cap for it
		[[{ memMiB: 16384, cpuCenti: 100 }, { memMiB: 8192, cpuCenti: 400 }], { memMiB: 8192, cpuCenti: 400 }],
		[[{ memMiB: Infinity, cpuCenti: 400 }], { memMiB: null, cpuCenti: 400 }],
		[[{ memMiB: 8192, cpuCenti: null }], { memMiB: 8192, cpuCenti: null }],
		// a 2g host cannot hold this 4g job: its CPUs are no cap for it
		[[{ memMiB: 8192, cpuCenti: Infinity }, { memMiB: 2048, cpuCenti: 800 }], { memMiB: 8192, cpuCenti: null }],
		[[null, 7, { memMiB: 6144, cpuCenti: 200 }], { memMiB: 6144, cpuCenti: 200 }],
	];
	for (const [budgets, want] of table) assert.deepEqual(fleetCap(budgets, cur), want, JSON.stringify(budgets));
	assert.deepEqual(fleetCap("junk", cur), { memMiB: null, cpuCenti: null });
});

test("suggestSize needs its clock and the current size, and accepts a Date", () => {
	assert.throws(() => suggestSize({ project: "web", records: [], current: CURRENT }), /needs `now`/);
	assert.throws(() => suggestSize({ project: "web", records: [], current: { memMiB: 100, cpuCenti: 200 }, now: NOW }), /current size/);
	assert.throws(() => suggestSize({ project: "web", records: [], current: null, now: NOW }), /current size/);
	assert.deepEqual(suggestSize({ project: "web", records: [rec({ reason: "oom-killed", peakMiB: 4096 })], current: CURRENT, cap: ROOMY, now: new Date(NOW) }).memory.suggested, 6144);
	assert.equal(suggestSize({ project: "web", records: [rec({ reason: "oom-killed", peakMiB: 4096 })], current: CURRENT, now: NOW }).memory.held, "no-cap", "no cap given is no cap known");
	assert.equal(suggestSize({ project: "web", records: "junk", current: CURRENT, now: NOW }).runs, 0);
});

test("the call that applies a suggestion: the project row's index and only the changed fields, or an add without a row", () => {
	const limits = [{ scope: "acme/web", day: 3 }, { scope: "project:web", memory: "4g" }];
	const both = { project: "web", memory: { suggested: 6144 }, cpu: { suggested: 150 } };
	assert.equal(suggestionCall(both, limits), 'dispatch_limit_edit {"index":1,"memory":"6g","cpus":1.5}');
	assert.equal(suggestionCall({ project: "web", memory: { suggested: 1280 }, cpu: { suggested: null } }, limits), 'dispatch_limit_edit {"index":1,"memory":"1280m"}');
	assert.equal(suggestionCall({ project: "web", memory: { suggested: null }, cpu: { suggested: 300 } }, limits), 'dispatch_limit_edit {"index":1,"cpus":3}');
	assert.equal(suggestionCall(both, []), 'dispatch_limit_add {"scope":"project:web","memory":"6g","cpus":1.5}');
	assert.equal(suggestionCall({ project: "web", memory: { suggested: null }, cpu: { suggested: null } }, limits), null);
	// end to end: what the call names is what suggestSize suggested, held to the cap; a raise with no cap has no call
	assert.equal(suggestionCall(suggest([rec({ reason: "oom-killed", peakMiB: 4096 })]), limits), 'dispatch_limit_edit {"index":1,"memory":"6g"}');
	assert.equal(suggestionCall(suggest([rec({ reason: "oom-killed", peakMiB: 4096 })], { cap: { memMiB: 5120 } }), limits), 'dispatch_limit_edit {"index":1,"memory":"5g"}');
	assert.equal(suggestionCall(suggest([rec({ reason: "oom-killed", peakMiB: 4096 })], { cap: null }), limits), null);
});

test("the words: singular one core and one CPU, held raises as what the host offers, facts as information", () => {
	assert.deepEqual([coresText(100), coresText(150), coresText(25), cpusText(100), cpusText(25), cpusText(200)], ["1 core", "1.5 cores", "0.25 cores", "1 CPU", "0.25 CPUs", "2 CPUs"]);
	const fits = suggestionEvidence(suggest(runs(10, { peakMiB: 3072, cores: 1 })));
	assert.deepEqual([fits.memory, fits.cpu, fits.memoryHeld, fits.memoryFact, fits.cpuFact], ["p95 peak 3g, largest 3g, over 10 runs", "p95 1 core used, largest 1 core, over 10 runs", "", "", ""]);
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	assert.equal(suggestionEvidence(suggest(oom)).memory, "1 run ended oom-killed (the largest size killed 4g)");
	assert.equal(suggestionEvidence(suggest(oom, { cap: { memMiB: 5120 } })).memoryHeld, "this project's runs need more than this host offers: they ask for 6g, the largest here is 5g");
	assert.equal(suggestionEvidence(suggest(oom, { cap: { memMiB: 4096 } })).memoryHeld, "already at the largest size this host offers");
	// a size ABOVE the cap is not "at" it: the words say which, and name the cap
	assert.equal(suggestionEvidence(suggest(oom, { cap: { memMiB: 2048 } })).memoryHeld, "already above the largest size this host offers (2g)");
	assert.equal(suggestionEvidence(suggest(oom, { cap: null })).memoryHeld, "they ask for 6g, but the largest size this host offers is not known here, so no call is offered");
	const pressed = suggestionEvidence(suggest(runs(10, { memPeak: 4096 * MIB, full: 0.5, cores: 2, throttle: 0.9 })));
	assert.equal(pressed.memoryFact, "10 of 10 runs reached the memory limit while stalled for memory more than 1% of their time");
	assert.equal(pressed.cpuFact, "the median run was held back 90% of its time by this host's CPU ceiling (its CPU budget, shared by every job), which a job's cpus do not change");
	assert.equal(suggestionEvidence(suggest(runs(3))).memory, "3 of the 10 runs with measurements it needs");
	// nothing any of them says advises raising a size past the cap, or growing a host's budget
	for (const w of [fits, pressed, suggestionEvidence(suggest(oom, { cap: { memMiB: 5120 } })), suggestionEvidence(suggest(oom, { cap: null }))]) {
		for (const text of Object.values(w)) assert.doesNotMatch(text, /raise|increase|grow/i, text);
	}
});

test("with hosts, each dimension is capped per host against the size the OTHER dimension will have", () => {
	const big = { memMiB: 16384, cpuCenti: 800 };
	const list = runs(10, { memMiB: 16384, cpuCenti: 800, peakMiB: 6000, cores: 3 });
	// the CPUs lower to 3.75 first; a host with 7 CPUs holds that, so its 5g caps the memory, and 7.5g is above it
	const s = suggestSize({ project: "web", records: list, current: big, hosts: [{ memMiB: 5120, cpuCenti: 700 }], now: NOW });
	assert.deepEqual([s.cpu.suggested, s.memory.suggested, s.memory.overBudget, s.cpu.overBudget], [375, 7680, true, false]);
	// and the CPUs' flag is judged against the memory the lowering leaves: a 8g host holds 7.5g, so its 3 CPUs flag 3.75
	const c = suggestSize({ project: "web", records: list, current: big, hosts: [{ memMiB: 8192, cpuCenti: 300 }], now: NOW });
	assert.deepEqual([c.cpu.suggested, c.cpu.overBudget, c.memory.suggested, c.memory.overBudget], [375, true, 7680, false]);
	// judged against the CURRENT 8 CPUs instead, no host would hold it and nothing would be flagged
	assert.deepEqual(fleetCap([{ memMiB: 5120, cpuCenti: 700 }], big), { memMiB: null, cpuCenti: null });
	// a raise: the 1-CPU host's 16g is no cap for a 2-CPU job, the 2-CPU host's 5g is
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	const r = suggestSize({ project: "web", records: oom, current: CURRENT, hosts: [{ memMiB: 16384, cpuCenti: 100 }, { memMiB: 5120, cpuCenti: 200 }], now: NOW });
	assert.deepEqual([r.memory.suggested, r.memory.held], [5120, "cap"]);
	// no host, or none with a number: no call
	assert.equal(suggestSize({ project: "web", records: oom, current: CURRENT, hosts: [], now: NOW }).memory.held, "no-cap");
	assert.equal(suggestSize({ project: "web", records: oom, current: CURRENT, hosts: [{ memMiB: Infinity, cpuCenti: Infinity }], now: NOW }).memory.held, "no-cap");
	// `hosts` wins over `cap` when both are given (one caller passes one of them)
	assert.equal(suggestSize({ project: "web", records: oom, current: CURRENT, cap: ROOMY, hosts: [], now: NOW }).memory.held, "no-cap");
});

test("sizeRefusal judges one host exactly as admission's neverFits does, dimension by dimension", () => {
	const vals = [null, Infinity, 0, 1, 99, 100, 101, 199, 200, 201, 400];
	const shares = [null, 1, 33, 50, 100];
	let refused = 0;
	for (const memB of vals) for (const cpuB of vals) for (const share of shares) for (const mem of [1, 50, 100, 101, 200, 401]) for (const cpu of [1, 50, 100, 101, 200, 401]) {
		const budget = { memMiB: memB, cpuCenti: cpuB };
		const pair = { memMiB: mem, cpuCenti: cpu };
		const why = neverFits(pair, budget, share);
		const r = sizeRefusal(pair, [budget], share);
		assert.equal(r !== null, why !== null, JSON.stringify({ budget, pair, share }));
		if (r === null) continue;
		refused++;
		// the kind is admission's: a dimension above the whole budget is "host", else above the share is "share"
		assert.ok([r.memMiB, r.cpuCenti].includes(why), JSON.stringify({ budget, pair, share, r }));
		assert.equal(r.memMiB === "host", Number.isSafeInteger(memB) && mem > memB);
		assert.equal(r.cpuCenti === "host", Number.isSafeInteger(cpuB) && cpu > cpuB);
	}
	assert.ok(refused > 1000, "the grid exercises refusals");
});

test("sizeRefusal over the live hosts: withheld only when every host with an integer budget refuses the pair", () => {
	const pair = { memMiB: 4096, cpuCenti: 400 };
	// no host, or every budget off or unknown: admission refuses nothing, so the call is offered
	for (const hosts of [null, [], [null], [{ memMiB: null, cpuCenti: null }], [{ memMiB: Infinity, cpuCenti: Infinity }], [{ memMiB: Infinity, cpuCenti: null }, { memMiB: null, cpuCenti: Infinity }]]) assert.equal(sizeRefusal(pair, hosts, 10), null, JSON.stringify(hosts));
	// a host that admits it, even beside hosts that refuse it
	assert.equal(sizeRefusal(pair, [{ memMiB: 2048, cpuCenti: 800 }, { memMiB: 8192, cpuCenti: 800 }]), null);
	// a host that is off in one dimension and holds the other is judged, and admits it
	assert.equal(sizeRefusal(pair, [{ memMiB: 2048, cpuCenti: 800 }, { memMiB: Infinity, cpuCenti: 400 }]), null);
	// every judged host refuses: per dimension, how every one of them refuses it
	assert.deepEqual(sizeRefusal(pair, [{ memMiB: 16384, cpuCenti: 800 }], 40), { memMiB: null, cpuCenti: "share" });
	assert.deepEqual(sizeRefusal(pair, [{ memMiB: 16384, cpuCenti: 300 }, { memMiB: 16384, cpuCenti: 800 }], 40), { memMiB: null, cpuCenti: "share" }, "above one host and above the other's share is above the share of both");
	assert.deepEqual(sizeRefusal(pair, [{ memMiB: 2048, cpuCenti: 300 }, { memMiB: 16384, cpuCenti: 300 }]), { memMiB: null, cpuCenti: "host" });
	assert.deepEqual(sizeRefusal(pair, [{ memMiB: 2048, cpuCenti: 800 }, { memMiB: 16384, cpuCenti: 300 }]), { memMiB: null, cpuCenti: null }, "no dimension every host refuses: the pair as a whole");
	// an off or unknown host beside them changes nothing: it publishes no number to judge
	assert.deepEqual(sizeRefusal(pair, [{ memMiB: 16384, cpuCenti: 800 }, { memMiB: null, cpuCenti: null }, { memMiB: Infinity, cpuCenti: Infinity }], 40), { memMiB: null, cpuCenti: "share" });
});

test("refusalWords names the dimension that does not fit, by its new size or as the one it keeps", () => {
	const s = (mem, cpu) => ({ memory: { current: 4096, suggested: mem }, cpu: { current: 400, suggested: cpu } });
	const host = { memMiB: 16384, cpuCenti: 800 };
	assert.equal(refusalWords(null, s(768, null)), "");
	assert.equal(refusalWords({ memMiB: null, cpuCenti: "share" }, s(768, null), 40, host), "its 4 CPUs are above its hostShare (40%) of this host's budget (3.2 CPUs)");
	assert.equal(refusalWords({ memMiB: "host", cpuCenti: null }, s(6144, null), null, { memMiB: 4096, cpuCenti: 800 }), "memory 6g is above this host's budget (4g)");
	assert.equal(refusalWords({ memMiB: "host", cpuCenti: "host" }, s(null, 100), null, { memMiB: 2048, cpuCenti: 50 }), "its memory 4g is above this host's budget (2g) and 1 CPU is above this host's budget (0.5 CPUs)");
	assert.equal(refusalWords({ memMiB: null, cpuCenti: "share" }, s(768, null), 40), "its 4 CPUs are above its hostShare (40%) of every live host's budget");
	assert.equal(refusalWords({ memMiB: null, cpuCenti: null }, s(768, null)), "memory 768m with 4 CPUs fits no live host's budget");
});
