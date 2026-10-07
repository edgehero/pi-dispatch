import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSizingRecords, sizeSuggestionChecks } from "../src/doctor.mjs";
import { parseScopedLimits } from "../src/scoped-limits.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Doctor's size suggestion lines (issue #596, phase 3, DES-SIZE-SUGGESTIONS): one line per project, from the one pure
// `suggestSize`, naming the exact admin call. The clock is injected (`nowMs`), always.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const MIB = 1024 * 1024;
const MIN = 60 * 1000;
const limitsOf = (rows) => parseScopedLimits(JSON.stringify({ version: 3, limits: rows }), "sl.json");
const labels = (checks) => checks.map((c) => `${c.ok ? "ok" : c.warn ? "warn" : "FAIL"}: ${c.label}${c.ok ? "" : ` -> ${c.fix}`}`);

function rec({ i = 0, project = "web", memMiB = 4096, cpuCenti = 200, peakMiB = 1024, cores = 1, throttle = 0, reason = null } = {}) {
	const end = NOW - (i + 1) * MIN;
	const wall = 10 * MIN * 1000;
	return {
		jobId: `job-${project}-${i}`,
		project,
		reason,
		startedAt: new Date(end - 10 * MIN).toISOString(),
		endedAt: new Date(end).toISOString(),
		resources: { memPeak: peakMiB * MIB, cpuUsec: Math.round(cores * wall), throttledUsec: Math.round(throttle * wall) },
		size: { memMiB, cpuCenti, source: "project" },
	};
}
const runs = (n, over) => Array.from({ length: n }, (_, i) => rec({ i, ...over }));
const projects = (...ids) => ids.map((id) => ({ id, name: null, members: [`github:acme/${id}`] }));

test("a project with too few runs, and one whose runs fit, are fact lines", () => {
	const checks = sizeSuggestionChecks({ projects: projects("web", "api"), limits: [], env: {}, records: [...runs(3, { project: "web" }), ...runs(12, { project: "api", peakMiB: 3500, cores: 1.5 })], nowMs: NOW });
	assert.deepEqual(labels(checks), [
		"ok: project web: size 4g, 2 CPUs: not enough runs to suggest a size yet (3 of the 10 runs with measurements it needs in the last 30 days)",
		"ok: project api: size 4g, 2 CPUs fits its runs (memory: p95 peak 3500m over 12 runs; CPUs: p95 1.5 cores used over 12 runs)",
	]);
});

test("a RAISE is a warning whose fix is the exact dispatch_limit_edit call; a lowering is a fact line carrying it", () => {
	const limits = limitsOf([{ scope: "acme/web", day: 5 }, { scope: "project:web", memory: "4g" }, { scope: "project:api", memory: "8g", cpus: 4 }]);
	const records = [rec({ project: "web", reason: "oom-killed", peakMiB: 4096 }), ...runs(12, { project: "api", memMiB: 8192, cpuCenti: 400, peakMiB: 2000, cores: 0.5 })];
	assert.deepEqual(labels(sizeSuggestionChecks({ projects: projects("web", "api"), limits, env: {}, records, nowMs: NOW })), [
		'warn: project web: size 4g, 2 CPUs; its runs in the last 30 days suggest memory 6g (oom-killed: 1 run ended oom-killed) -> apply it in the admin panel with dispatch_limit_edit {"index":1,"memory":"6g"} (an operator confirms it; nothing applies a size by itself)',
		'ok: project api: size 8g, 4 CPUs; its runs in the last 30 days suggest memory 2560m (oversized: p95 peak 2000m over 12 runs) and 0.75 CPUs (underused: p95 0.5 cores used over 12 runs); apply it in the admin panel with dispatch_limit_edit {"index":2,"memory":"2560m","cpus":0.75}',
	]);
});

test("a project with no row of its own is named with dispatch_limit_add, and its size is the deployment's", () => {
	const checks = sizeSuggestionChecks({ projects: projects("web"), limits: [], env: { PI_JOB_MEMORY: "2g", PI_JOB_CPUS: "1" }, records: runs(10, { memMiB: 2048, cpuCenti: 100, peakMiB: 2048, throttle: 0.5, cores: 1 }), nowMs: NOW });
	assert.deepEqual(labels(checks), [
		'warn: project web: size 2g, 1 CPUs; its runs in the last 30 days suggest memory 3g (at-limit: 10 of 10 runs peaked at 90% of their memory or more) and 1.5 CPUs (throttled: the median run held back 50% of its time) -> apply it in the admin panel with dispatch_limit_add {"scope":"project:web","memory":"3g","cpus":1.5} (an operator confirms it; nothing applies a size by itself)',
	]);
});

test("a suggestion above this host's budget is a warning that says a job of it would never fit, also for a lowering", () => {
	const oom = [rec({ reason: "oom-killed", peakMiB: 4096 })];
	const [line] = sizeSuggestionChecks({ projects: projects("web"), limits: [], env: {}, records: oom, budget: { memMiB: 5120, cpuCenti: 700 }, nowMs: NOW });
	assert.deepEqual([line.ok, line.warn], [false, true]);
	assert.match(line.label, /suggest memory 6g \(oom-killed: 1 run ended oom-killed\), but memory 6g is above this host's budget \(5g\), so a job of it would never fit this host$/);
	assert.match(line.fix, /^raise this host's budget first, then apply it in the admin panel with dispatch_limit_add/);
	const hot = runs(10, { throttle: 0.9, cores: 2 });
	const [cpuLine] = sizeSuggestionChecks({ projects: projects("web"), limits: [], env: {}, records: hot, budget: { memMiB: 65536, cpuCenti: 250 }, nowMs: NOW });
	assert.match(cpuLine.label, /but 3 CPUs are above this host's budget \(2\.5\)/);
	// a budget that is off or unknown never flags
	for (const budget of [{ memMiB: Infinity, cpuCenti: Infinity }, { memMiB: null, cpuCenti: null }, null]) {
		const [l] = sizeSuggestionChecks({ projects: projects("web"), limits: [], env: {}, records: oom, budget, nowMs: NOW });
		assert.doesNotMatch(l.label, /budget/);
	}
	// a lowering below a budget the current size already exceeds is not flagged (doctor's budget lines name that size)
	const big = limitsOf([{ scope: "project:web", memory: "16g" }]);
	const [low] = sizeSuggestionChecks({ projects: projects("web"), limits: big, env: {}, records: runs(10, { memMiB: 16384, peakMiB: 1000 }), budget: { memMiB: 8192, cpuCenti: 700 }, nowMs: NOW });
	assert.equal(low.ok, true);
	assert.match(low.label, /suggest memory 1280m .*; apply it in the admin panel with dispatch_limit_edit \{"index":0,"memory":"1280m"\}$/);
});

test("a CPU-only raise is a warning too; a lowering above this host's budget warns; memory unmeasured with CPU measured is not 'not enough runs'", () => {
	const [cpuRaise] = sizeSuggestionChecks({ projects: projects("web"), limits: [], env: {}, records: runs(10, { peakMiB: 3072, cores: 2, throttle: 0.5 }), nowMs: NOW });
	assert.deepEqual([cpuRaise.ok, cpuRaise.warn], [false, true]);
	assert.match(cpuRaise.label, /suggest 3 CPUs \(throttled: the median run held back 50% of its time\)$/);
	const big = limitsOf([{ scope: "project:web", memory: "16g" }]);
	const [over] = sizeSuggestionChecks({ projects: projects("web"), limits: big, env: {}, records: runs(10, { memMiB: 16384, peakMiB: 6000 }), budget: { memMiB: 4096, cpuCenti: 700 }, nowMs: NOW });
	assert.deepEqual([over.ok, over.warn], [false, true]);
	assert.match(over.label, /suggest memory 7680m \(oversized: p95 peak 6000m over 10 runs\), but memory 7680m is above this host's budget \(4g\)/);
	const noPeak = runs(10, { cores: 1 }).map((r) => ({ ...r, resources: { ...r.resources, memPeak: null } }));
	const [line] = sizeSuggestionChecks({ projects: projects("web"), limits: [], env: {}, records: noPeak, nowMs: NOW });
	assert.equal(line.label, "project web: size 4g, 2 CPUs fits its runs (memory: not-enough-runs, 0 of the 10 runs with measurements it needs; CPUs: p95 1 cores used over 10 runs)");
});

test("no projects, no lines; a project's line reads only its own runs", () => {
	assert.deepEqual(sizeSuggestionChecks({ projects: [], records: runs(20), nowMs: NOW }), []);
	const [line] = sizeSuggestionChecks({ projects: projects("api"), limits: [], env: {}, records: runs(20, { project: "web", reason: "oom-killed" }), nowMs: NOW });
	assert.match(line.label, /^project api: size 4g, 2 CPUs: not enough runs/);
});

test("readSizingRecords reads the window's run records by mtime and skips junk; an absent directory holds none", () => {
	const dir = tempDir("pi-sizing-records-");
	const write = (name, body, ageDays = 0) => {
		const p = join(dir, name);
		writeFileSync(p, body);
		const t = (NOW - ageDays * 24 * 60 * MIN) / 1000;
		utimesSync(p, t, t);
	};
	write("a.json", JSON.stringify(rec({ i: 1 })));
	write("b.json", JSON.stringify(rec({ i: 2 })), 30.5); // inside the window plus its day of skew
	write("c.json", JSON.stringify(rec({ i: 3 })), 31.5); // outside: not even read
	write("d.json", "{ not json");
	write("e.log", JSON.stringify(rec({ i: 5 }))); // a record's own log is never read, whatever it holds
	mkdirSync(join(dir, "f.json"));
	const got = readSizingRecords(dir, { nowMs: NOW }).map((r) => r.jobId).sort();
	assert.deepEqual(got, ["job-web-1", "job-web-2"]);
	assert.deepEqual(readSizingRecords(join(dir, "nope"), { nowMs: NOW }), []);
});
