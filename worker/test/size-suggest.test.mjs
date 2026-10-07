import assert from "node:assert/strict";
import { test } from "node:test";
import { RECORD_CLOCK_SKEW_MS } from "../src/run-history.mjs";
import {
	CPU_REASONS,
	MEMORY_REASONS,
	SUGGEST_CLOCK_SKEW_MS,
	SUGGEST_MAX_WALL_MS,
	SUGGEST_MIN_SAMPLES,
	SUGGEST_WINDOW_DAYS,
	SUGGEST_WINDOW_RUNS,
	peakSeries,
	roundCpusUp,
	roundMemoryUp,
	suggestSize,
	suggestionCall,
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
function rec({ i = 0, ago = i + 1, project = "web", memMiB = 4096, cpuCenti = 200, peakMiB = 1024, memPeak = peakMiB * MIB, cores = 1, throttle = 0, reason = null, resources = undefined, size = undefined, startedAt = undefined } = {}) {
	const end = NOW - ago * MIN;
	return {
		jobId: `job-${i}`,
		project,
		outcome: reason === "oom-killed" ? "policy" : "completed",
		reason,
		startedAt: startedAt === undefined ? new Date(end - WALL_MS).toISOString() : startedAt,
		endedAt: new Date(end).toISOString(),
		resources: resources === undefined ? { memPeak, swapPeak: 0, oomKills: reason === "oom-killed" ? 1 : 0, memSomeUsec: 0, memFullUsec: 0, cpuUsec: Math.round(cores * WALL_US), throttledUsec: Math.round(throttle * WALL_US), throttled: 0, pidsPeak: 10 } : resources,
		size: size === undefined ? { memMiB, cpuCenti, source: "project" } : size,
	};
}
const runs = (n, over = {}) => Array.from({ length: n }, (_, i) => rec({ i, ...over }));
const suggest = (records, { current = CURRENT, budget = null } = {}) => suggestSize({ project: "web", records, current, budget, now: NOW });
const mem = (records, opts) => suggest(records, opts).memory;
const cpu = (records, opts) => suggest(records, opts).cpu;

test("the window and the thresholds are the plan's: 30 days or 50 runs, 10 samples, and the clock skew is run-history's", () => {
	assert.deepEqual([SUGGEST_WINDOW_DAYS, SUGGEST_WINDOW_RUNS, SUGGEST_MIN_SAMPLES, SUGGEST_MAX_WALL_MS], [30, 50, 10, 7 * 24 * 60 * MIN]);
	assert.equal(SUGGEST_CLOCK_SKEW_MS, RECORD_CLOCK_SKEW_MS);
	assert.deepEqual(MEMORY_REASONS, ["oom-killed", "at-limit", "not-enough-runs", "oversized", "fits"]);
	assert.deepEqual(CPU_REASONS, ["throttled", "not-enough-runs", "underused", "fits"]);
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
	assert.deepEqual(mem(runs(9, { peakMiB: 3072 })), { current: 4096, suggested: null, reason: "not-enough-runs", evidence: { samples: 9, p95MiB: 3072, ooms: 0, atLimit: 0, atLimitPct: 0 }, overBudget: false });
	assert.deepEqual(mem(runs(10, { peakMiB: 3072 })), { current: 4096, suggested: null, reason: "fits", evidence: { samples: 10, p95MiB: 3072, ooms: 0, atLimit: 0, atLimitPct: 0 }, overBudget: false });
	assert.equal(mem([]).reason, "not-enough-runs");
	assert.equal(mem([]).evidence.p95MiB, null);
});

test("memory: more than 10% of the runs at the limit raises to 1.5x; exactly 10% does not", () => {
	const limit = 4096 * MIB;
	const atNinety = Math.ceil((limit * 9) / 10); // the smallest peak at 90% of the limit or more
	const table = [
		// [runs at the limit, runs below, the reason, the suggestion]
		[1, 9, "fits", null], // exactly 10%
		[2, 8, "at-limit", 6144], // 20%
		[1, 8, "at-limit", 6144], // 11%: and below 10 samples, a run cut off still decides
		[1, 0, "at-limit", 6144],
		[0, 10, "fits", null],
	];
	for (const [at, below, reason, suggested] of table) {
		const list = [...runs(at, { memPeak: atNinety }), ...Array.from({ length: below }, (_, i) => rec({ i: 100 + i, peakMiB: 3072 }))];
		const m = mem(list);
		assert.deepEqual([m.reason, m.suggested, m.evidence.atLimit], [reason, suggested, at], `${at} at the limit of ${at + below}`);
	}
	// a byte under 90% is not at the limit
	const under = [rec({ i: 0, memPeak: atNinety - 1 }), rec({ i: 1, memPeak: atNinety - 1 }), ...runs(8, { peakMiB: 3072 })];
	assert.equal(mem(under).evidence.atLimit, 0);
	assert.equal(mem(under).reason, "fits");
	assert.equal(mem([...runs(2, { memPeak: atNinety }), ...Array.from({ length: 8 }, (_, i) => rec({ i: 50 + i, peakMiB: 3072 }))]).evidence.atLimitPct, 20);
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
	assert.equal(mem([refused]).evidence.ooms, 0);
	assert.equal(mem([refused]).reason, "at-limit", "it still ran into its limit");
	assert.equal(mem([{ ...rec({ peakMiB: 100 }), outcome: "policy", reason: "cost-cap" }]).reason, "not-enough-runs");
});

test("memory: a peak of exactly 90% of the limit is at the limit", () => {
	// 5g: 90% of 5368709120 bytes is exactly 4831838208.
	const current = { memMiB: 5120, cpuCenti: 200 };
	const exact = (5120 * MIB * 9) / 10;
	assert.equal(Number.isInteger(exact), true);
	const list = (peak) => [rec({ i: 0, memMiB: 5120, memPeak: peak }), rec({ i: 1, memMiB: 5120, memPeak: peak }), ...Array.from({ length: 8 }, (_, i) => rec({ i: 10 + i, memMiB: 5120, peakMiB: 3500 }))];
	assert.equal(mem(list(exact), { current }).evidence.atLimit, 2);
	assert.equal(mem(list(exact), { current }).reason, "at-limit");
	assert.equal(mem(list(exact - 1), { current }).evidence.atLimit, 0);
});

test("memory: an OOM raises to the larger of 1.5x the size and 1.25x the p95, with any number of runs", () => {
	const oom = rec({ i: 0, reason: "oom-killed", peakMiB: 4096 });
	assert.deepEqual(mem([oom]), { current: 4096, suggested: 6144, reason: "oom-killed", evidence: { samples: 1, p95MiB: 4096, ooms: 1, atLimit: 1, atLimitPct: 100 }, overBudget: false });
	// runs at a LARGER size count, and their true peaks can ask for more than 1.5x: 1.25 x 7g = 8.75g, rounded up to 9g.
	const big = Array.from({ length: 19 }, (_, i) => rec({ i: 10 + i, memMiB: 8192, peakMiB: 7168 }));
	assert.equal(mem([oom, ...big]).suggested, 9216);
	assert.equal(mem([oom, ...big]).reason, "oom-killed");
	// an OOM beats a lowering: nine tiny runs and one OOM still raise.
	assert.equal(mem([oom, ...runs(9, { ago: 30, peakMiB: 100 })]).reason, "oom-killed");
});

test("memory: runs given LESS than the current size are not evidence, so an OOM before a raise does not ask again", () => {
	const old = Array.from({ length: 3 }, (_, i) => rec({ i, memMiB: 4096, reason: "oom-killed", peakMiB: 4096 }));
	const now6 = { memMiB: 6144, cpuCenti: 200 };
	assert.equal(mem(old, { current: now6 }).reason, "not-enough-runs");
	assert.equal(mem(old, { current: now6 }).evidence.samples, 0);
	assert.equal(mem([...old, ...Array.from({ length: 10 }, (_, i) => rec({ i: 10 + i, memMiB: 6144, peakMiB: 4500 }))], { current: now6 }).reason, "fits");
});

test("memory: it lowers only when 1.25x the p95 is at most 0.75x the size, to that target rounded up", () => {
	const current = { memMiB: 5120, cpuCenti: 200 }; // 0.75 x 5g = 3840m = 1.25 x 3072m
	const at = (memPeak) => mem(runs(10, { memMiB: 5120, memPeak }), { current });
	assert.deepEqual([at(3072 * MIB).reason, at(3072 * MIB).suggested], ["oversized", 4096]); // exactly 0.75x: 3840m rounds up to 4g
	assert.deepEqual([at(3072 * MIB + 1).reason, at(3072 * MIB + 1).suggested], ["fits", null]); // a byte more keeps it
	// the p95 is the nearest rank: of 20 runs, the 19th; one outlier at the top does not hold the size up.
	const list = [...runs(19, { memMiB: 5120, peakMiB: 1000 }), rec({ i: 40, memMiB: 5120, peakMiB: 5000 })];
	assert.equal(mem(list, { current }).evidence.p95MiB, 1000);
	assert.equal(mem(list, { current }).suggested, 1280); // 1.25 x 1000 = 1250, rounded up to 1280
});

test("memory: a lowering never goes below the 512m floor, and one that would round back to the size is fits", () => {
	assert.deepEqual([mem(runs(10, { memMiB: 1024, peakMiB: 100 }), { current: { memMiB: 1024, cpuCenti: 200 } }).suggested], [512]);
	const floor = mem(runs(10, { memMiB: 512, peakMiB: 100 }), { current: { memMiB: 512, cpuCenti: 200 } });
	assert.deepEqual([floor.reason, floor.suggested], ["fits", null]);
	// 9g: 0.75 x 9216 = 6912; a p95 of 5529m targets 6912 (1.25 x 5529.6 rounds to 6912), rounded up to 7g.
	const nine = mem(runs(10, { memMiB: 9216, memPeak: Math.floor(5529.6 * MIB) }), { current: { memMiB: 9216, cpuCenti: 200 } });
	assert.deepEqual([nine.reason, nine.suggested], ["oversized", 7168]);
});

test("memory: a raise past the largest size suggests nothing, and keeps its reason", () => {
	const top = { memMiB: 1024 * 1024, cpuCenti: 200 };
	const m = mem([rec({ memMiB: 1024 * 1024, reason: "oom-killed", peakMiB: 1024 * 1024 })], { current: top });
	assert.deepEqual([m.reason, m.suggested], ["oom-killed", null]);
});

test("CPU: fewer than 10 runs is not enough, exactly 10 decides", () => {
	assert.deepEqual(cpu(runs(9, { cores: 1.5 })), { current: 200, suggested: null, reason: "not-enough-runs", evidence: { samples: 9, p95CoresCenti: 150, throttledPct: 0 }, overBudget: false });
	assert.deepEqual(cpu(runs(10, { cores: 1.5 })), { current: 200, suggested: null, reason: "fits", evidence: { samples: 10, p95CoresCenti: 150, throttledPct: 0 }, overBudget: false });
	// even fully throttled: nine runs decide nothing for CPU
	assert.equal(cpu(runs(9, { cores: 2, throttle: 1 })).reason, "not-enough-runs");
});

test("CPU: the p50 run throttled MORE than 25% of its wall raises by 50%; exactly 25% does not", () => {
	const at = (throttledUsec) => cpu(runs(10, { cores: 2, resources: { memPeak: MIB, cpuUsec: 2 * WALL_US, throttledUsec } }));
	assert.deepEqual([at(WALL_US / 4).reason, at(WALL_US / 4).evidence.throttledPct], ["fits", 25]);
	assert.deepEqual([at(WALL_US / 4 + 1).reason, at(WALL_US / 4 + 1).suggested], ["throttled", 300]);
	// the p50 is the 5th of 10 by throttle: four heavily throttled runs do not decide, five do.
	const mix = (heavy) => [...runs(heavy, { cores: 2, throttle: 0.9 }), ...Array.from({ length: 10 - heavy }, (_, i) => rec({ i: 20 + i, cores: 2, throttle: 0 }))];
	assert.equal(cpu(mix(5)).reason, "fits");
	assert.equal(cpu(mix(6)).reason, "throttled");
	// rounded up to a 0.25 step: 0.25 x 1.5 = 0.375 -> 0.5; and capped at the ceiling, where it suggests nothing.
	assert.equal(cpu(runs(10, { cpuCenti: 25, cores: 0.25, throttle: 0.5 }), { current: { memMiB: 4096, cpuCenti: 25 } }).suggested, 50);
	const top = cpu(runs(10, { cpuCenti: 25600, cores: 256, throttle: 0.5 }), { current: { memMiB: 4096, cpuCenti: 25600 } });
	assert.deepEqual([top.reason, top.suggested], ["throttled", null]);
});

test("CPU: the p95 cores used BELOW 0.4x the cpus lowers to 1.25x that p95; exactly 0.4x keeps it", () => {
	const at = (cpuUsec) => cpu(runs(10, { resources: { memPeak: MIB, cpuUsec, throttledUsec: 0 } }));
	assert.deepEqual([at(0.8 * WALL_US).reason, at(0.8 * WALL_US).suggested], ["fits", null]); // exactly 0.4 x 2
	assert.deepEqual([at(0.8 * WALL_US - 1).reason, at(0.8 * WALL_US - 1).suggested], ["underused", 100]); // 1.25 x 0.8 = 1
	// the floor: an idle 1-CPU job goes to 0.25, and an idle 0.25 job stays.
	assert.equal(cpu(runs(10, { cpuCenti: 100, cores: 0 }), { current: { memMiB: 4096, cpuCenti: 100 } }).suggested, 25);
	assert.equal(cpu(runs(10, { cpuCenti: 25, cores: 0 }), { current: { memMiB: 4096, cpuCenti: 25 } }).reason, "fits");
	// a lowering that rounds back up to the size is fits: 0.4 x 0.5 = 0.2 > a p95 of 0.19, and 1.25 x 0.19 = 0.2375 -> 0.25 < 0.5 lowers;
	// at cpus 0.25, 0.4 x 0.25 = 0.1 > 0.09, and 1.25 x 0.09 rounds to 0.25 = the size: fits.
	assert.equal(cpu(runs(10, { cpuCenti: 50, cores: 0.19 }), { current: { memMiB: 4096, cpuCenti: 50 } }).suggested, 25);
	assert.equal(cpu(runs(10, { cpuCenti: 25, cores: 0.09 }), { current: { memMiB: 4096, cpuCenti: 25 } }).reason, "fits");
	// the p95 is the busiest run but one of 20: a single burst does not hold the size up.
	const list = [...runs(19, { cores: 0.2 }), rec({ i: 40, cores: 2 })];
	assert.deepEqual([cpu(list).evidence.p95CoresCenti, cpu(list).suggested], [20, 25]);
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
	assert.equal(cpu([...short, long]).evidence.p95CoresCenti, 20);
	// and the p50 throttle share likewise: the long run's large throttled time is a small share of its wall.
	const longThrottled = { ...long, resources: { memPeak: MIB, cpuUsec: 0, throttledUsec: 20 * MIN * 1000 } };
	const shortThrottled = Array.from({ length: 9 }, (_, i) => rec({ i, cores: 1, throttle: [0.3, 0.3, 0.3, 0.3, 0.3, 0, 0, 0, 0][i] }));
	assert.equal(cpu([...shortThrottled, longThrottled]).evidence.throttledPct, 20);
});

test("peakSeries: the same runs a suggestion reads, oldest first, judged the same way", () => {
	const list = [rec({ i: 0, peakMiB: 3000 }), rec({ i: 1, memPeak: Number.MAX_SAFE_INTEGER, reason: "oom-killed" }), rec({ i: 2, memPeak: -5 }), rec({ i: 3, project: "api" }), rec({ i: 4, ago: 31 * 24 * 60 })];
	assert.deepEqual(peakSeries({ project: "web", records: list, now: NOW }), [
		{ at: NOW - 2 * MIN, peakMiB: 4096, sizeMiB: 4096, oom: true },
		{ at: NOW - MIN, peakMiB: 3000, sizeMiB: 4096, oom: false },
	]);
	assert.throws(() => peakSeries({ project: "web", records: list }), /needs `now`/);
});

test("CPU: runs given fewer cpus than now are not evidence, so a throttle before a raise does not ask again", () => {
	const old = runs(10, { cpuCenti: 200, cores: 2, throttle: 0.9 });
	assert.equal(cpu(old, { current: { memMiB: 4096, cpuCenti: 300 } }).reason, "not-enough-runs");
	assert.equal(cpu(old).reason, "throttled");
});

test("the window: the project's runs of the last 30 days, newest first, at most 50; other projects and old records are not read", () => {
	const fits = Array.from({ length: 50 }, (_, i) => rec({ i, peakMiB: 3072 }));
	const olderOoms = Array.from({ length: 10 }, (_, i) => rec({ i: 100 + i, ago: 1000 + i, reason: "oom-killed", peakMiB: 4096 }));
	const s = suggest([...olderOoms, ...fits]);
	assert.deepEqual([s.runs, s.memory.reason, s.memory.evidence.ooms], [50, "fits", 0], "the 50 newest decide");
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
	// a huge but safe peak is clamped to the run's own limit: it reads AT the limit, and the p95 is the size.
	const huge = suggest(Array.from({ length: 2 }, (_, i) => rec({ i, memPeak: Number.MAX_SAFE_INTEGER })));
	assert.deepEqual([huge.memory.evidence.p95MiB, huge.memory.reason, huge.memory.suggested], [4096, "at-limit", 6144]);
	// CPU time past 256 cores of the wall is clamped there; throttled time past the wall reads as all of it.
	const wild = suggest(runs(10, { resources: { memPeak: MIB, cpuUsec: Number.MAX_SAFE_INTEGER, throttledUsec: Number.MAX_SAFE_INTEGER } })).cpu;
	assert.deepEqual([wild.evidence.p95CoresCenti, wild.evidence.throttledPct, wild.reason, wild.suggested], [25600, 100, "throttled", 300]);
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

test("a suggestion above the host budget is flagged; an off, unknown or absent budget flags nothing", () => {
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	assert.equal(suggest(oom, { budget: { memMiB: 6143, cpuCenti: 700 } }).memory.overBudget, true);
	assert.equal(suggest(oom, { budget: { memMiB: 6144, cpuCenti: 700 } }).memory.overBudget, false, "equal to the budget fits");
	for (const budget of [null, { memMiB: Infinity, cpuCenti: Infinity }, { memMiB: null, cpuCenti: null }, {}]) assert.equal(suggest(oom, { budget }).memory.overBudget, false);
	const hot = runs(10, { cores: 2, throttle: 0.9 });
	assert.equal(suggest(hot, { budget: { memMiB: 9999, cpuCenti: 299 } }).cpu.overBudget, true);
	assert.equal(suggest(hot, { budget: { memMiB: 9999, cpuCenti: 300 } }).cpu.overBudget, false);
	// a size that stays is never over the budget here (doctor's budget lines say so for the current size)
	assert.equal(suggest(runs(10, { peakMiB: 3072 }), { budget: { memMiB: 1024, cpuCenti: 25 } }).memory.overBudget, false);
});

test("suggestSize needs its clock and the current size, and accepts a Date", () => {
	assert.throws(() => suggestSize({ project: "web", records: [], current: CURRENT }), /needs `now`/);
	assert.throws(() => suggestSize({ project: "web", records: [], current: { memMiB: 100, cpuCenti: 200 }, now: NOW }), /current size/);
	assert.throws(() => suggestSize({ project: "web", records: [], current: null, now: NOW }), /current size/);
	assert.deepEqual(suggestSize({ project: "web", records: [rec({ reason: "oom-killed", peakMiB: 4096 })], current: CURRENT, now: new Date(NOW) }).memory.suggested, 6144);
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
	// end to end: what the call names is what suggestSize suggested
	assert.equal(suggestionCall(suggest([rec({ reason: "oom-killed", peakMiB: 4096 })]), limits), 'dispatch_limit_edit {"index":1,"memory":"6g"}');
});
