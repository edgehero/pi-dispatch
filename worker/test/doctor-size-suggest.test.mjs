import assert from "node:assert/strict";
import { test } from "node:test";
import { sizeSuggestionChecks } from "../src/doctor.mjs";
import { parseScopedLimits } from "../src/scoped-limits.mjs";

// Doctor's size suggestion lines (issue #596, phase 3, DES-SIZE-SUGGESTIONS): one line per project, from the one pure
// `suggestSize`, naming the exact admin call. The clock is injected (`nowMs`), always.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const MIB = 1024 * 1024;
const MIN = 60 * 1000;
const limitsOf = (rows) => parseScopedLimits(JSON.stringify({ version: 3, limits: rows }), "sl.json");
const labels = (checks) => checks.map((c) => `${c.ok ? "ok" : c.warn ? "warn" : "FAIL"}: ${c.label}${c.ok ? "" : ` -> ${c.fix}`}`);

function rec({ i = 0, project = "web", memMiB = 4096, cpuCenti = 200, peakMiB = 1024, cores = 1, throttle = 0, full = 0, reason = null } = {}) {
	const end = NOW - (i + 1) * MIN;
	const wall = 10 * MIN * 1000;
	return {
		jobId: `job-${project}-${i}`,
		project,
		reason,
		startedAt: new Date(end - 10 * MIN).toISOString(),
		endedAt: new Date(end).toISOString(),
		resources: { memPeak: peakMiB * MIB, cpuUsec: Math.round(cores * wall), throttledUsec: Math.round(throttle * wall), memFullUsec: Math.round(full * wall) },
		size: { memMiB, cpuCenti, source: "project" },
	};
}
const runs = (n, over) => Array.from({ length: n }, (_, i) => rec({ i, ...over }));
const projects = (...ids) => ids.map((id) => ({ id, name: null, members: [`github:acme/${id}`] }));

// A host whose budget never binds: the rules first, the cap in its own tests.
const ROOMY = { memMiB: 65536, cpuCenti: 3200 };
const checksOf = (args) => sizeSuggestionChecks({ projects: projects("web"), limits: [], env: {}, budget: ROOMY, nowMs: NOW, ...args });

test("a project with too few runs, and one whose runs fit, are fact lines", () => {
	const checks = sizeSuggestionChecks({ projects: projects("web", "api"), limits: [], env: {}, budget: ROOMY, records: [...runs(3, { project: "web" }), ...runs(12, { project: "api", peakMiB: 3500, cores: 1.5 })], nowMs: NOW });
	assert.deepEqual(labels(checks), [
		"ok: project web: size 4g, 2 CPUs: not enough runs to suggest a size yet (3 of the 10 runs with measurements it needs in the last 30 days)",
		"ok: project api: size 4g, 2 CPUs fits its runs (memory: p95 peak 3500m, largest 3500m, over 12 runs; CPUs: p95 1.5 cores used, largest 1.5 cores, over 12 runs)",
	]);
});

test("a RAISE is a warning whose fix is the exact dispatch_limit_edit call; a lowering is a fact line carrying it", () => {
	const limits = limitsOf([{ scope: "acme/web", day: 5 }, { scope: "project:web", memory: "4g" }, { scope: "project:api", memory: "8g", cpus: 4 }]);
	const records = [rec({ project: "web", reason: "oom-killed", peakMiB: 4096 }), ...runs(12, { project: "api", memMiB: 8192, cpuCenti: 400, peakMiB: 2000, cores: 0.5 })];
	assert.deepEqual(labels(sizeSuggestionChecks({ projects: projects("web", "api"), limits, env: {}, budget: ROOMY, records, nowMs: NOW })), [
		'warn: project web: size 4g, 2 CPUs; its runs in the last 30 days suggest memory 6g (oom-killed: 1 run ended oom-killed (the largest size killed 4g)) -> apply it in the admin panel with dispatch_limit_edit {"index":1,"memory":"6g"} (an operator confirms it; nothing applies a size by itself)',
		'ok: project api: size 8g, 4 CPUs; its runs in the last 30 days suggest memory 2560m (oversized: p95 peak 2000m, largest 2000m, over 12 runs) and 0.75 CPUs (underused: p95 0.5 cores used, largest 0.5 cores, over 12 runs); apply it in the admin panel with dispatch_limit_edit {"index":2,"memory":"2560m","cpus":0.75}',
	]);
});

test("a project with no row of its own is named with dispatch_limit_add, its size is the deployment's, and one CPU is singular", () => {
	const checks = checksOf({ env: { PI_JOB_MEMORY: "2g", PI_JOB_CPUS: "1" }, records: [rec({ memMiB: 2048, cpuCenti: 100, reason: "oom-killed", peakMiB: 2048 })] });
	assert.deepEqual(labels(checks), [
		'warn: project web: size 2g, 1 CPU; its runs in the last 30 days suggest memory 3g (oom-killed: 1 run ended oom-killed (the largest size killed 2g)) -> apply it in the admin panel with dispatch_limit_add {"scope":"project:web","memory":"3g"} (an operator confirms it; nothing applies a size by itself)',
	]);
});

test("runs at the limit and throttled runs never raise: each is a fact on the line, with no call", () => {
	const [line] = checksOf({ records: runs(10, { peakMiB: 4096, full: 0.5, cores: 2, throttle: 0.9 }) });
	assert.deepEqual(labels([line]), [
		"ok: project web: size 4g, 2 CPUs fits its runs (memory: p95 peak 4g, largest 4g, over 10 runs; CPUs: p95 2 cores used, largest 2 cores, over 10 runs); 10 of 10 runs reached the memory limit while stalled for memory more than 1% of their time; the median run was held back 90% of its time by this host's CPU ceiling (its CPU budget, shared by every job), which a job's cpus do not change",
	]);
});

test("a raise is capped at this host's budget, or at its own total where the budget is off or unknown; never advises growing the host", () => {
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	const table = [
		// [budget, total, the label's end, the fix]
		[{ memMiB: 5120, cpuCenti: 700 }, null, "suggest memory 5g (oom-killed: 1 run ended oom-killed (the largest size killed 4g); this project's runs need more than this host offers: they ask for 6g, the largest here is 5g)", 'apply it in the admin panel with dispatch_limit_add {"scope":"project:web","memory":"5g"} (an operator confirms it; nothing applies a size by itself)'],
		[{ memMiB: Infinity, cpuCenti: Infinity }, { memMiB: 5632, cpuCenti: 800 }, "suggest memory 5632m (oom-killed: 1 run ended oom-killed (the largest size killed 4g); this project's runs need more than this host offers: they ask for 6g, the largest here is 5632m)", 'apply it in the admin panel with dispatch_limit_add {"scope":"project:web","memory":"5632m"} (an operator confirms it; nothing applies a size by itself)'],
		[{ memMiB: null, cpuCenti: null }, { memMiB: 16384, cpuCenti: 800 }, "suggest memory 6g (oom-killed: 1 run ended oom-killed (the largest size killed 4g))", 'apply it in the admin panel with dispatch_limit_add {"scope":"project:web","memory":"6g"} (an operator confirms it; nothing applies a size by itself)'],
		[{ memMiB: 4096, cpuCenti: 700 }, null, "in the last 30 days 1 run ended oom-killed (the largest size killed 4g); already at the largest size this host offers", "no larger memory is offered: no larger size fits this host"],
		[{ memMiB: Infinity, cpuCenti: Infinity }, null, "in the last 30 days 1 run ended oom-killed (the largest size killed 4g); they ask for 6g, but the largest size this host offers is not known here, so no call is offered", "no memory call is offered while the largest size this host offers is unknown (its budget is off or unknown and its runtime's memory was not read)"],
		[null, null, "in the last 30 days 1 run ended oom-killed (the largest size killed 4g); they ask for 6g, but the largest size this host offers is not known here, so no call is offered", "no memory call is offered while the largest size this host offers is unknown (its budget is off or unknown and its runtime's memory was not read)"],
	];
	for (const [budget, total, end, fix] of table) {
		const [line] = checksOf({ records: oom, budget, total });
		assert.deepEqual([line.ok, line.warn], [false, true], JSON.stringify(budget));
		assert.ok(line.label.endsWith(end), `${JSON.stringify(budget)}: ${line.label}`);
		assert.equal(line.fix, fix);
		assert.doesNotMatch(`${line.label} ${line.fix}`, /raise this host|budget first|grow|increase/i);
	}
	// at the largest size with a lowering of the CPUs still offered: the fix names the call for the rest
	const limits = limitsOf([{ scope: "project:web", memory: "4g", cpus: 4 }]);
	const [both] = checksOf({ limits, budget: { memMiB: 4096, cpuCenti: 800 }, records: [rec({ cpuCenti: 400, reason: "oom-killed", peakMiB: 4096, cores: 0.2 }), ...runs(10, { cpuCenti: 400, peakMiB: 1000, cores: 0.2 }).map((r, i) => ({ ...r, jobId: `x${i}` }))] });
	assert.match(both.label, /^project web: size 4g, 4 CPUs; in the last 30 days 1 run ended oom-killed \(the largest size killed 4g\); already at the largest size this host offers; its runs in the last 30 days suggest 0\.25 CPUs/);
	assert.equal(both.fix, 'no larger memory is offered: no larger size fits this host; for the rest, apply it in the admin panel with dispatch_limit_edit {"index":0,"cpus":0.25} (an operator confirms it; nothing applies a size by itself)');
});

test("a lowering still above what this host offers is a warning that says a job of it would never fit here", () => {
	const big = limitsOf([{ scope: "project:web", memory: "16g" }]);
	const [over] = checksOf({ limits: big, records: runs(10, { memMiB: 16384, peakMiB: 6000 }), budget: { memMiB: 4096, cpuCenti: 700 } });
	assert.deepEqual([over.ok, over.warn], [false, true]);
	assert.match(over.label, /suggest memory 7680m \(oversized: p95 peak 6000m, largest 6000m, over 10 runs\), but memory 7680m is above this host's budget \(4g\), so a job of it would never fit this host$/);
	assert.equal(over.fix, "no call is offered: a job of that size would never fit this host");
	const cpus = limitsOf([{ scope: "project:web", cpus: 8 }]);
	const [cpuFits] = checksOf({ limits: cpus, records: runs(10, { cpuCenti: 800, peakMiB: 4000, cores: 2 }), budget: { memMiB: 65536, cpuCenti: 250 } });
	assert.deepEqual([cpuFits.ok, /suggest 2\.5 CPUs \(underused: p95 2 cores used, largest 2 cores, over 10 runs\); apply it/.test(cpuFits.label)], [true, true], "equal to the budget fits");
	const [cpuOver] = checksOf({ limits: cpus, records: runs(10, { cpuCenti: 800, peakMiB: 4000, cores: 2 }), budget: { memMiB: 65536, cpuCenti: 200 } });
	assert.deepEqual([cpuOver.ok, cpuOver.warn], [false, true]);
	// the cap is named with its unit, never a bare "(2)"
	assert.match(cpuOver.label, /suggest 2\.5 CPUs \(underused: .*\), but 2\.5 CPUs are above this host's budget \(2 CPUs\), so a job of it would never fit this host$/);
	assert.doesNotMatch(cpuOver.fix, /dispatch_limit/);
	// a lowering that fits is a fact line, with the call
	const [low] = checksOf({ limits: big, records: runs(10, { memMiB: 16384, peakMiB: 1000 }), budget: { memMiB: 65536, cpuCenti: 700 } });
	assert.equal(low.ok, true);
	assert.match(low.label, /suggest memory 1280m .*; apply it in the admin panel with dispatch_limit_edit \{"index":0,"memory":"1280m"\}$/);
});

test("a raise is capped at the project's hostShare of this host's budget, never the whole budget", () => {
	const limits = limitsOf([{ scope: "project:web", memory: "4g", hostShare: 50 }]);
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	// 6g wanted; 50% of a 10g budget is 5g: the raise is held there, and the call names 5g, a size the share admits
	const [line] = checksOf({ limits, records: oom, budget: { memMiB: 10240, cpuCenti: 800 } });
	assert.deepEqual([line.ok, line.warn], [false, true]);
	assert.match(line.label, /suggest memory 5g \(oom-killed: .*; this project's runs need more than this host offers: they ask for 6g, the largest here is 5g\)$/);
	assert.equal(line.fix, 'apply it in the admin panel with dispatch_limit_edit {"index":0,"memory":"5g"} (an operator confirms it; nothing applies a size by itself)');
	// floor(budget x share / 100): 50% of 10241m is 5120m, not 5120.5m rounded up past the share
	const [odd] = checksOf({ limits, records: oom, budget: { memMiB: 10241, cpuCenti: 800 } });
	assert.match(odd.fix, /"memory":"5g"/);
	// inside the share the raise is the rule's own
	const [fits] = checksOf({ limits, records: oom, budget: { memMiB: 12288, cpuCenti: 800 } });
	assert.match(fits.fix, /"memory":"6g"/);
	// an off budget has no share to cap at: the runtime's own memory caps it
	const [off] = checksOf({ limits, records: oom, budget: { memMiB: Infinity, cpuCenti: Infinity }, total: { memMiB: 65536, cpuCenti: 800 } });
	assert.match(off.fix, /"memory":"6g"/);
	// already at the share: nothing larger is offered, and no call
	const at = limitsOf([{ scope: "project:web", memory: "5g", hostShare: 50 }]);
	const [held] = checksOf({ limits: at, records: [rec({ memMiB: 5120, reason: "oom-killed", peakMiB: 5120 })], budget: { memMiB: 10240, cpuCenti: 800 } });
	assert.equal(held.fix, "no larger memory is offered: no larger size fits this host");
});

test("a line whose suggestion would never fit the share or the host never carries an apply call", () => {
	const lines = [
		// the raise against a share (was: capped at the whole budget, then flagged, then "apply it")
		...checksOf({ limits: limitsOf([{ scope: "project:web", memory: "6g", hostShare: 50 }]), records: [rec({ memMiB: 6144, reason: "oom-killed", peakMiB: 6144 })], budget: { memMiB: 16384, cpuCenti: 800 } }),
		// a memory raise inside the share, while the CPUs it keeps are above the share: the pair never fits
		...checksOf({ limits: limitsOf([{ scope: "project:web", memory: "4g", cpus: 6, hostShare: 50 }]), records: [rec({ cpuCenti: 600, reason: "oom-killed", peakMiB: 4096 })], budget: { memMiB: 16384, cpuCenti: 800 } }),
		// a lowering still above the share
		...checksOf({ limits: limitsOf([{ scope: "project:web", memory: "16g", hostShare: 25 }]), records: runs(10, { memMiB: 16384, peakMiB: 6000 }), budget: { memMiB: 16384, cpuCenti: 800 } }),
		// a lowering still above the whole budget
		...checksOf({ limits: limitsOf([{ scope: "project:web", memory: "16g" }]), records: runs(10, { memMiB: 16384, peakMiB: 6000 }), budget: { memMiB: 4096, cpuCenti: 800 } }),
	];
	const over = lines.filter((c) => /would never fit/.test(c.label));
	assert.equal(over.length, 3, labels(lines).join("\n"));
	for (const c of over) {
		assert.deepEqual([c.ok, c.warn], [false, true], c.label);
		assert.doesNotMatch(`${c.label} ${c.fix}`, /dispatch_limit|apply it/, c.label);
		assert.match(c.fix, /no call is offered: a job of that size would never fit this host$/);
	}
	// memory held at the largest size while the CPUs it would lower to are still above the host: neither offers a call
	const [both] = checksOf({ limits: limitsOf([{ scope: "project:web", memory: "4g", cpus: 8 }]), records: [rec({ cpuCenti: 800, reason: "oom-killed", peakMiB: 4096, cores: 2 }), ...runs(10, { cpuCenti: 800, peakMiB: 1000, cores: 2 }).map((r, i) => ({ ...r, jobId: `c${i}` }))], budget: { memMiB: 4096, cpuCenti: 200 } });
	assert.equal(both.fix, "no larger memory is offered: no larger size fits this host; no call is offered: a job of that size would never fit this host");
	// the share is named where it is what binds
	assert.match(over[0].label, /, but its 6 CPUs are above its hostShare \(50%\) of this host's budget \(4 CPUs\), so a job of it would never fit this host$/);
	assert.match(over[1].label, /, but memory 7680m is above its hostShare \(25%\) of this host's budget \(4g\), so/);
	// the raise held at the share is no such line: it carries the call for the share's own size, 8g of the 16g
	assert.match(lines[0].fix, /^apply it in the admin panel with dispatch_limit_edit \{"index":0,"memory":"8g"\}/);
});

test("a size already ABOVE what this host offers is said to be above it, not at it", () => {
	const big = limitsOf([{ scope: "project:web", memory: "32g" }]);
	const [line] = checksOf({ limits: big, records: [rec({ memMiB: 32768, reason: "oom-killed", peakMiB: 32768 })], budget: { memMiB: 16384, cpuCenti: 800 } });
	assert.match(line.label, /; already above the largest size this host offers \(16g\)$/);
	assert.equal(line.fix, "no larger memory is offered: the size is already above what this host offers");
	const at = limitsOf([{ scope: "project:web", memory: "16g" }]);
	const [same] = checksOf({ limits: at, records: [rec({ memMiB: 16384, reason: "oom-killed", peakMiB: 16384 })], budget: { memMiB: 16384, cpuCenti: 800 } });
	assert.match(same.label, /; already at the largest size this host offers$/);
	assert.equal(same.fix, "no larger memory is offered: no larger size fits this host");
});

test("memory unmeasured with CPU measured is not 'not enough runs'", () => {
	const noPeak = runs(10, { cores: 1 }).map((r) => ({ ...r, resources: { ...r.resources, memPeak: null } }));
	const [line] = checksOf({ records: noPeak });
	assert.equal(line.label, "project web: size 4g, 2 CPUs fits its runs (memory: not-enough-runs, 0 of the 10 runs with measurements it needs; CPUs: p95 1 core used, largest 1 core, over 10 runs)");
});

test("no projects, no lines; a project's line reads only its own runs", () => {
	assert.deepEqual(sizeSuggestionChecks({ projects: [], records: runs(20), nowMs: NOW }), []);
	const [line] = sizeSuggestionChecks({ projects: projects("api"), limits: [], env: {}, records: runs(20, { project: "web", reason: "oom-killed" }), nowMs: NOW });
	assert.match(line.label, /^project api: size 4g, 2 CPUs: not enough runs/);
});

test("the apply call is offered exactly when this host's admission would accept the suggested pair", () => {
	// a memory lowering while the CPUs it keeps are above the whole budget: admission refuses the pair, so no call,
	// and the line names the CPUs, the dimension that does not fit, not the memory it suggests
	const [cpuOver] = checksOf({ limits: limitsOf([{ scope: "project:web", memory: "4g", cpus: 10 }]), records: runs(10, { cpuCenti: 1000, peakMiB: 500, cores: 9.5 }), budget: { memMiB: 16384, cpuCenti: 800 } });
	assert.deepEqual([cpuOver.ok, cpuOver.warn], [false, true]);
	assert.match(cpuOver.label, /suggest memory 768m \(oversized: .*\), but its 10 CPUs are above this host's budget \(8 CPUs\), so a job of it would never fit this host$/);
	assert.equal(cpuOver.fix, "no call is offered: a job of that size would never fit this host");
	// the budget off or unknown in both dimensions: admission refuses nothing, so a lowering is offered even when it is
	// above the runtime's own memory, which is noted beside the call
	const big = limitsOf([{ scope: "project:web", memory: "64g", cpus: 2 }]);
	for (const budget of [{ memMiB: Infinity, cpuCenti: Infinity }, { memMiB: null, cpuCenti: null }, null]) {
		const [low] = checksOf({ limits: big, records: runs(10, { memMiB: 65536, peakMiB: 36000 }), budget, total: { memMiB: 32768, cpuCenti: 800 } });
		assert.match(low.label, /suggest memory 44g \(oversized: .*\) \(note: memory 44g is above 32g, this host's own memory; its budget is off or unknown, so the worker admits it\)$/, JSON.stringify(budget));
		assert.equal(low.fix, 'apply it in the admin panel with dispatch_limit_edit {"index":0,"memory":"44g"} (an operator confirms it; nothing applies a size by itself)', JSON.stringify(budget));
	}
});
