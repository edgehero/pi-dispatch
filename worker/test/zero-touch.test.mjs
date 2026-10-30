import assert from "node:assert/strict";
import { test } from "node:test";
import { computeZeroTouch, readZeroTouch, ZERO_TOUCH_NO_PROJECT } from "../src/zero-touch.mjs";
import { cleanTouch, touchScopeOf } from "../src/touch-state.mjs";
import { buildRecord } from "../src/run-history.mjs";

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 30, 12);
const SCOPE = "a".repeat(64);
const coverage = { fromMs: NOW - 180 * DAY, partial: false, reasons: [] };
const record = (jobId, daysAgo = 1, extra = {}) => ({ jobId, kind: "github", target: "acme/api#1", project: "api", touchScopeId: SCOPE, touchTrackingVersion: 1, endedAt: new Date(NOW - daysAgo * DAY).toISOString(), outcome: "completed", reason: null, ...extra });
const event = (runId, cause, daysAgo = 1, extra = {}) => ({ runId, cause, at: NOW - daysAgo * DAY, type: "touch", scopeId: SCOPE, project: "api", ...extra });
const compute = (extra = {}) => computeZeroTouch({ nowMs: NOW, windowDays: 30, coverage, ...extra });

test("independent distinct-run recount, exclusive earliest causes and duplicate fleet copies", () => {
	const records = [record("a"), record("b"), record("a"), record("c")];
	const events = [event("a", "steer", 2), event("a", "question-answer"), event("a", "rerun"), event("b", "cancel")];
	const result = compute({ records, events });
	assert.deepEqual(result.touchedRunIds, ["a", "b"]);
	assert.equal(result.totals.runs, 3);
	assert.equal(result.totals.rate, 2 / 3 * 100);
	assert.equal(result.causes.reduce((n, c) => n + c.count, 0), 2);
	assert.equal(result.causes.find((c) => c.cause === "steer").count, 1);
	assert.equal(result.projects[0].repositories[0].touched, 2);
});

test("a real project named unassigned cannot absorb runs without a project", () => {
	const records = [record("missing", 1, { project: null }), record("named", 1, { project: "unassigned", touchScopeId: "b".repeat(64) })];
	const events = [event("missing", "steer"), event("named", "rerun", 1, { project: "unassigned" })];
	const all = compute({ records, events });
	assert.equal(all.projects.length, 2);
	assert.equal(all.projects.find(p => p.project === ZERO_TOUCH_NO_PROJECT).name, "No project recorded");
	assert.equal(all.projects.find(p => p.project === "unassigned").name, "unassigned");
	assert.deepEqual(compute({ records, events, project: ZERO_TOUCH_NO_PROJECT }).touchedRunIds, ["missing"]);
	assert.deepEqual(compute({ records, events, project: "unassigned" }).touchedRunIds, ["named"]);
});

test("the production reader includes retained old parks in the current wait interval", async () => {
	const parked = record("old-park", 60, { reason: "awaiting-input" });
	const bytes = Buffer.from(JSON.stringify(parked));
	const redis = { async eval(_script, _count, key) { return key === "touch:meta" ? [["since", String(NOW - 100 * DAY)], [], 0, 0] : [0]; } };
	const fs = { readdirSync: () => ["old-park.json"], statSync: () => ({ isFile: () => true, mtimeMs: NOW - 60 * DAY, size: bytes.length }), readFileSync: () => bytes };
	const result = await readZeroTouch({ redis, logsDir: "/unused", retentionDays: 365, now: () => NOW, windowDays: 7, fs });
	assert.equal(result.totals.runs, 0, "the old park is not a run ending this week");
	assert.equal(result.totals.pending, 1, "an old unanswered park still waits now");
	assert.equal(result.totals.waitingHours, 168, "only the seven-day overlap is counted");
	assert.deepEqual(result.totals.waitingNow.map(row => row.runId), ["old-park"]);
});

test("stops are separate, internal analysis does not dilute workloads, ordinary starts and reads are not touches", () => {
	const result = compute({ records: [record("work"), record("analysis", 1, { purpose: "zero-touch-grouping" })], events: [event("stop", null, 1, { type: "stop" }), event("work", "merge"), event("work", "read"), event("work", "sandbox")] });
	assert.equal(result.totals.runs, 1);
	assert.equal(result.totals.touched, 0);
	assert.equal(result.totals.stopped, 1);
});

test("the actual record builder preserves the internal purpose before and after grouping resolution", () => {
	const endedAt = new Date(NOW - DAY).toISOString();
	const reference = { runId: "parked-source", digest: "c".repeat(64), configDigest: "d".repeat(64) };
	const built = [
		buildRecord({ job: { id: "refused-analysis", data: { kind: "question-grouping", questionGrouping: reference } }, result: { outcome: "policy", reason: "question-group-refused", budgetReserved: false }, endedAt, touchTracking: true }),
		buildRecord({ job: { id: "paid-analysis", data: { kind: "local", purpose: "zero-touch-grouping", questionGrouping: reference } }, result: { outcome: "completed", tokens: { cost: 0.03 }, budgetReserved: true }, endedAt, touchTracking: true }),
	];
	assert.ok(built.every((r) => r.purpose === "zero-touch-grouping"));
	assert.equal(built[1].budgetReserved, true, "metering and ordinary run history are retained");
	const workload = record("work");
	const result = compute({ records: [workload, ...built], events: [event("work", "steer")] });
	assert.equal(result.totals.runs, 1);
	assert.equal(result.totals.rate, 100, "neither a refused nor a paid analysis job dilutes the workload rate");
	assert.equal(buildRecord({ job: { id: "ordinary", data: { kind: "local" } }, result: { outcome: "completed" }, endedAt }).purpose, undefined);
});

test("scoped stopped counts use known scope evidence and keep unattributed CLI stops visible", () => {
	const otherScope = "b".repeat(64);
	const records = [record("api"), record("web", 1, { touchScopeId: otherScope, project: "web" })];
	const stops = [
		{ type: "stop", runId: "known-api", at: NOW - DAY, scopeId: SCOPE },
		{ type: "stop", runId: "known-web", at: NOW - DAY, scopeId: otherScope },
		{ type: "stop", runId: "unknown-cli-local", at: NOW - DAY },
	];
	const project = compute({ records, events: stops, project: "api" });
	assert.equal(project.totals.stopped, 1, "a stopped job has no record, but an observed scope identifies its project");
	assert.equal(project.totals.stoppedUnattributed, 1, "the shared-queue local CLI stop cannot be called outside this project");
	assert.equal(project.coverage.stopsPartial, true);
	assert.equal(project.totals.runs, 1, "stops stay outside the workload denominator");
	const folder = compute({ records, events: stops, scopeId: SCOPE });
	assert.equal(folder.totals.stopped, 1);
	assert.equal(folder.totals.stoppedUnattributed, 1);
	const all = compute({ records, events: stops });
	assert.equal(all.totals.stopped, 3, "every successful removal is counted fleet-wide");
});

test("same-basename folders have different opaque identities without recording a path", () => {
	const a = touchScopeOf({ kind: "local", folder: "/srv/first/api" }, "one");
	const b = touchScopeOf({ kind: "local", folder: "/srv/second/api" }, "one");
	assert.match(a, /^[a-f0-9]{64}$/);
	assert.notEqual(a, b);
	assert.notEqual(a, touchScopeOf({ kind: "local", folder: "/srv/first/api" }, "two"));
	const result = compute({ records: [record("a", 1, { kind: "local", target: "local:api", touchScopeId: a }), record("b", 1, { kind: "local", target: "local:api", touchScopeId: b })] });
	assert.equal(result.projects[0].repositories.length, 2);
});

test("late intervention uses source ended window while streak uses real intervention time", () => {
	const source = record("source", 20, { outcome: "failed" });
	const result = compute({ records: [source], events: [event("source", "rerun", 1)] });
	assert.equal(result.totals.touched, 1);
	assert.equal(result.projects[0].streakDays, 1);
	assert.equal(result.projects[0].zeroTouch, false);
});

test("a repository's streak is not reset by a touched sibling in the same project", () => {
	const otherScope = "b".repeat(64);
	const result = compute({ records: [record("quiet", 1), record("busy", 1, { touchScopeId: otherScope, target: "acme/web#2" })], events: [event("busy", "steer", 1, { scopeId: otherScope })] });
	assert.equal(result.projects[0].streakDays, 1, "the project includes the intervention");
	const quiet = result.projects[0].repositories.find((r) => r.scopeId === SCOPE);
	const busy = result.projects[0].repositories.find((r) => r.scopeId === otherScope);
	assert.equal(quiet.streakDays, 180, "the quiet repository retains its own observed streak");
	assert.equal(quiet.zeroTouch, true);
	assert.equal(busy.streakDays, 1);
	assert.equal(busy.zeroTouch, false);
});

test("legacy records and missing touch history cannot become an untouched or zero-touch claim", () => {
	const old = record("old", 10); delete old.touchTrackingVersion;
	const result = compute({ records: [old, record("new", 1)], coverage: { fromMs: NOW - 30 * DAY, partial: false, reasons: [] } });
	assert.equal(result.coverage.partial, true);
	assert.equal(result.coverage.unknownRuns, 1);
	assert.ok(result.coverage.fromMs > NOW - 10 * DAY);
	assert.equal(result.totals.runs, 1);
	assert.equal(result.projects[0].zeroTouch, false);
	const none = compute({ records: [record("new")], coverage: { fromMs: NOW, partial: true, reasons: ["touch-index-unavailable"] } });
	assert.equal(none.totals.rate, null);
	assert.equal(none.totals.runs, 0);
});

test("the actual record builder preserves unknown resumed-answer lineage and prevents a false zero", () => {
	const gap = buildRecord({ job: { id: "resumed-answer", data: { kind: "github", repo: "acme/api", target: { type: "issue", number: 1 } } }, result: { outcome: "completed", touchLineageSkipped: "source-unavailable" }, endedAt: new Date(NOW - DAY).toISOString(), touchTracking: true });
	assert.equal(gap.touchLineageSkipped, "source-unavailable");
	const result = compute({ records: [gap, record("unprovable-parent", 3, { reason: "awaiting-input" })] });
	assert.equal(result.totals.rate, null);
	assert.equal(result.totals.runs, 0);
	assert.equal(result.coverage.fromMs, NOW);
	assert.equal(result.coverage.partial, true);
	assert.ok(result.coverage.reasons.includes("answer-source-unavailable"));
	assert.ok(result.projects.every((p) => !p.zeroTouch));
	const other = compute({ records: [gap, record("work", 1, { project: "different" })], project: "different" });
	assert.equal(other.totals.runs, 1, "the named gap affects its selected scope, not unrelated projects");
});

test("waits sum clipped run-hours and end at trusted receipt rather than eventual pickup", () => {
	const parkedAt = NOW - 2 * DAY;
	const receivedAt = parkedAt + 2 * 3600_000;
	const result = compute({ records: [record("answered", 2, { reason: "awaiting-input" }), record("pending", 1, { reason: "awaiting-input" })], events: [event("answered", "question-answer", 1, { parkedAt, receivedAt })] });
	assert.equal(result.totals.waitingHours, 26);
	assert.equal(result.totals.medianWaitMs, 2 * 3600_000);
	assert.equal(result.totals.pending, 1);
	assert.equal(result.projects[0].zeroTouch, false);
});

test("thirty observed days need activity and no outstanding park", () => {
	assert.equal(compute({ records: [record("work")] }).projects[0].zeroTouch, true);
	assert.equal(compute({ records: [record("old", 40)] }).projects[0].zeroTouch, false);
	assert.equal(compute({ records: [record("park", 1, { reason: "awaiting-input" })] }).projects[0].zeroTouch, false);
	assert.equal(compute({ records: [record("work")], coverage: { fromMs: NOW - 29 * DAY } }).projects[0].zeroTouch, false);
});

test("fix comparisons include untouched refusal recurrences, equal elapsed spans and run exposure", () => {
	const at = NOW - 2 * DAY;
	const result = compute({ records: [record("before1", 3, { reason: "secret-unresolved", outcome: "policy" }), record("before2", 3.5, { reason: "secret-unresolved", outcome: "policy" }), record("after", 1, { reason: "secret-unresolved", outcome: "policy" }), record("success", 0.5)], fixes: [{ id: "fix", at, scopeId: SCOPE, reason: "secret-unresolved" }] });
	assert.equal(result.totals.touched, 0);
	assert.deepEqual({ before: result.fixes[0].before, after: result.fixes[0].after, spanMs: result.fixes[0].spanMs, afterRuns: result.fixes[0].afterRuns }, { before: 2, after: 1, spanMs: 2 * DAY, afterRuns: 2 });
	assert.equal(result.fixes[0].worked, true);
	assert.deepEqual({ beforeCount: result.fixes[0].beforeCount, afterCount: result.fixes[0].afterCount, subsequentRuns: result.fixes[0].subsequentRuns, status: result.fixes[0].status }, { beforeCount: 2, afterCount: 1, subsequentRuns: 2, status: "improved" }, "the public fix vocabulary feeds the actual console projection");
	assert.equal(compute({ fixes: [{ at, reason: "secret-unresolved" }] }).fixes[0].worked, false);
});

test("the production fix fold ends a reverted observation at Undo and cannot call it improved", () => {
	const at = NOW - 4 * DAY, undoneAt = NOW - 3 * DAY;
	const result = compute({ records: [record("before", 4.5, { reason: "secret-unresolved" }), record("during", 3.5), record("after-undo", 1, { reason: "secret-unresolved" })], fixes: [{ at, undoneAt, scopeId: SCOPE, reason: "secret-unresolved" }] }).fixes[0];
	assert.equal(result.spanMs, DAY);
	assert.deepEqual([result.beforeCount, result.afterCount, result.subsequentRuns], [1, 0, 1], "runs after removing the fix cannot establish its effectiveness");
	assert.equal(result.status, "observing");
	assert.equal(result.worked, false);
});

test("group fixes count unanswered questions, independently of primary touch cause", () => {
	const records = [record("before", 3, { reason: "awaiting-input" }), record("after", 1, { reason: "awaiting-input" })];
	const result = compute({ records, events: [event("before", "steer", 4)], groups: [{ groupId: "g", runIds: ["before", "after"] }], fixes: [{ at: NOW - 2 * DAY, groupId: "g" }] });
	assert.equal(result.fixes[0].before, 1);
	assert.equal(result.fixes[0].after, 1);
	assert.equal(result.fixes[0].worked, false);
});

test("unclassified questions cannot prove a group fix worked, while complete positive workload exposure can", () => {
	const before = record("before", 3, { reason: "awaiting-input" });
	const after = record("unclassified", 1, { reason: "awaiting-input" });
	const fix = { at: NOW - 2 * DAY, groupId: "g", scopeId: SCOPE };
	const groups = [{ groupId: "g", runIds: ["before"] }, { id: null, runIds: ["unclassified"] }];
	const uncertain = compute({ records: [before, after], groups, fixes: [fix] }).fixes[0];
	assert.equal(uncertain.afterCount, 0, "no assignment has identified the new question as this group");
	assert.equal(uncertain.subsequentRuns, 1);
	assert.equal(uncertain.partial, true, "an unassigned question may be a recurrence");
	assert.equal(uncertain.status, "observing");
	assert.equal(uncertain.worked, false);
	const complete = compute({ records: [before, record("completed", 1)], groups, fixes: [fix] }).fixes[0];
	assert.equal(complete.partial, false);
	assert.equal(complete.status, "improved");
	assert.equal(complete.worked, true);
	const other = compute({ records: [before, after], groups: [...groups, { id: "other", runIds: ["unclassified"] }], fixes: [fix] }).fixes[0];
	assert.equal(other.status, "improved", "a known assignment to another group is evidence of a different question");
});

test("telemetry rejects unknown causes and strips every text-bearing field", () => {
	assert.equal(cleanTouch({ runId: "run", cause: "merge", at: NOW }), null);
	const clean = cleanTouch({ runId: "run", cause: "steer", at: NOW, question: "secret question", instruction: "secret" });
	assert.ok(clean);
	assert.ok(!JSON.stringify(clean).includes("secret"));
	assert.equal(cleanTouch({ runId: "run", cause: "steer", at: NOW, target: "<script>" }), null);
});
