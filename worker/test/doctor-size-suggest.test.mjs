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
	assert.match(over.label, /suggest memory 7680m \(oversized: p95 peak 6000m, largest 6000m, over 10 runs\), but memory 7680m is above the largest size this host offers \(4g\), so a job of it would never fit this host$/);
	const cpus = limitsOf([{ scope: "project:web", cpus: 8 }]);
	const [cpuFits] = checksOf({ limits: cpus, records: runs(10, { cpuCenti: 800, peakMiB: 4000, cores: 2 }), budget: { memMiB: 65536, cpuCenti: 250 } });
	assert.deepEqual([cpuFits.ok, /suggest 2\.5 CPUs \(underused: p95 2 cores used, largest 2 cores, over 10 runs\); apply it/.test(cpuFits.label)], [true, true], "equal to the budget fits");
	const [cpuOver] = checksOf({ limits: cpus, records: runs(10, { cpuCenti: 800, peakMiB: 4000, cores: 2 }), budget: { memMiB: 65536, cpuCenti: 200 } });
	assert.deepEqual([cpuOver.ok, cpuOver.warn], [false, true]);
	assert.match(cpuOver.label, /suggest 2\.5 CPUs \(underused: .*\), but 2\.5 CPUs are above the most this host offers \(2\), so a job of it would never fit this host$/);
	// a lowering that fits is a fact line, with the call
	const [low] = checksOf({ limits: big, records: runs(10, { memMiB: 16384, peakMiB: 1000 }), budget: { memMiB: 65536, cpuCenti: 700 } });
	assert.equal(low.ok, true);
	assert.match(low.label, /suggest memory 1280m .*; apply it in the admin panel with dispatch_limit_edit \{"index":0,"memory":"1280m"\}$/);
});

test("a suggestion above the project's hostShare of this host's budget is flagged too", () => {
	const limits = limitsOf([{ scope: "project:web", memory: "4g", hostShare: 50 }]);
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	// 6g of a 10g budget is above 50% of it: such a job would be refused here (job-size-exceeds-share)
	const [line] = checksOf({ limits, records: oom, budget: { memMiB: 10240, cpuCenti: 800 } });
	assert.deepEqual([line.ok, line.warn], [false, true]);
	assert.match(line.label, /suggest memory 6g .*, but that is above its hostShare \(50% of this host's budget\), so a job of it would never fit this host$/);
	const [fits] = checksOf({ limits, records: oom, budget: { memMiB: 12288, cpuCenti: 800 } });
	assert.doesNotMatch(fits.label, /hostShare/);
	// a lowering inside the share is not flagged, and an off budget has no share to be above
	const [off] = checksOf({ limits, records: oom, budget: { memMiB: Infinity, cpuCenti: Infinity }, total: { memMiB: 65536, cpuCenti: 800 } });
	assert.doesNotMatch(off.label, /hostShare/);
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
