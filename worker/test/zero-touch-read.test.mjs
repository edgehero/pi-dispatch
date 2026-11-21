import assert from "node:assert/strict";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { buildRecord, makeRecordWriter } from "../src/run-history.mjs";
import { TOUCH_SCRIPTS } from "../src/touch-state.mjs";
import { readZeroTouch, TOUCH_NOT_STARTED, TOUCH_UNREAD_REASONS } from "../src/zero-touch.mjs";
import { READ_SCRIPT } from "../src/run-mirror.mjs";

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 30, 12);
function localRecord() {
	const logsDir = tempDir("zero-touch-read-");
	makeRecordWriter({ logsDir })(buildRecord({
		job: { id: "local-work", data: { kind: "github", repo: "acme/api", flow: "fix", target: { type: "issue", number: 1 } } },
		result: { outcome: "completed", reason: null },
		endedAt: new Date(NOW - DAY).toISOString(), project: "api", host: "local", touchTracking: true,
	}));
	return logsDir;
}

test("local workload records never turn an unreadable touch index into a known empty rate", async () => {
	const redis = { async eval() { throw new Error("offline"); } };
	const report = await readZeroTouch({ redis, logsDir: localRecord(), now: () => NOW, retentionDays: 90, includeRecords: true });
	assert.equal(report.records.length, 1, "the denominator source is present, but its human interventions are unknown");
	assert.equal(report.state, "unavailable");
	assert.ok(report.coverage.reasons.includes("touch-index-unavailable"));
	assert.equal(report.totals.rate, null);
});

test("a shorter actually observed interval still reports useful partial counts", async () => {
	const redis = { async eval(script) { return script === TOUCH_SCRIPTS.READ ? [["since", String(NOW - 10 * DAY)], [], 0, 0] : [0]; } };
	const report = await readZeroTouch({ redis, logsDir: localRecord(), now: () => NOW, retentionDays: 90 });
	assert.equal(report.state, "ready");
	assert.equal(report.coverage.partial, true);
	assert.equal(report.coverage.fromMs, NOW - 10 * DAY);
	assert.equal(report.totals.runs, 1);
	assert.equal(report.totals.touched, 0);
	assert.equal(report.totals.rate, 0);
});

test("an intact local record source with tracking not started has no observed interval yet", async () => {
	const redis = { async eval(script) { return script === TOUCH_SCRIPTS.READ ? [[], [], 0, 0] : [0]; } };
	const report = await readZeroTouch({ redis, logsDir: localRecord(), now: () => NOW, retentionDays: 90 });
	// Read, and not started: no failure to report, and still no interval (issue #962).
	assert.equal(report.state, "not-started");
	assert.ok(report.coverage.reasons.includes("touch-tracking-not-started"));
	assert.equal(report.coverage.fromMs, NOW);
});

test("not started is said only of a touch index that was read and holds no loss beside it", async () => {
	const state = async (read, logsDir = localRecord()) => (await readZeroTouch({ redis: { async eval(script) { if (script !== TOUCH_SCRIPTS.READ) return [0]; return read(); } }, logsDir, now: () => NOW, retentionDays: 90 })).state;
	assert.equal(await state(() => [[], [], 0, 0]), "not-started");
	// An action still unresolved beside it resets the window too, and is evidence not read: unavailable.
	assert.equal(await state(() => [[], [], 1, 0]), "unavailable");
	// A surviving epoch whose index was lost, an unresolved action after a start, a read that threw, an answer that is no answer.
	assert.equal(await state(() => [["since", String(NOW - 10 * DAY), "indexed", "1"], [], 0, 0]), "unavailable");
	assert.equal(await state(() => [["since", String(NOW - 10 * DAY)], [], 1, 0]), "unavailable");
	assert.equal(await state(() => { throw new Error("down"); }), "unavailable");
	assert.equal(await state(() => null), "unavailable");
	// A logs folder that does not exist is a read that showed no run, not a failed read (issue #962): a deployment that
	// has run nothing and tracks nothing has not started, and with a started index it is ready and holds no run.
	const absent = "/nonexistent/zero-touch-read";
	assert.equal(await state(() => [[], [], 0, 0], absent), "not-started");
	const started = await readZeroTouch({ redis: { async eval(script) { return script === TOUCH_SCRIPTS.READ ? [["since", String(NOW - 10 * DAY)], [], 0, 0] : [0]; } }, logsDir: absent, now: () => NOW, retentionDays: 90 });
	assert.deepEqual([started.state, started.totals.runs, started.coverage.fromMs], ["ready", 0, NOW - 10 * DAY]);
	// A folder that is there and cannot be read is run records nobody read: unavailable, whatever the index says.
	const denied = { readdirSync() { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, statSync() { throw new Error("unused"); }, readFileSync() { throw new Error("unused"); } };
	const unread = await readZeroTouch({ redis: { async eval(script) { return script === TOUCH_SCRIPTS.READ ? [[], [], 0, 0] : [0]; } }, logsDir: absent, fs: denied, now: () => NOW, retentionDays: 90 });
	assert.equal(unread.state, "unavailable");
	// An absent folder beside a mirror that did not answer: nothing was read of any run.
	const mirrorDown = await readZeroTouch({ redis: { async eval(script) { if (script === TOUCH_SCRIPTS.READ) return [[], [], 0, 0]; throw new Error("timeout"); } }, logsDir: absent, now: () => NOW, retentionDays: 90 });
	assert.equal(mirrorDown.state, "unavailable");
	// The control: a started index over a covered interval is ready.
	assert.equal(await state(() => [["since", String(NOW - 10 * DAY)], [], 0, 0]), "ready");
	assert.deepEqual([TOUCH_NOT_STARTED, [...TOUCH_UNREAD_REASONS]], ["touch-tracking-not-started", ["touch-index-unavailable", "touch-index-lost", "touch-actions-unresolved", "touch-events-missing"]]);
});

test("the real retained-record reader separates ancient-wait uncertainty from a measurable current rate", async () => {
	const logsDir = localRecord();
	const write = makeRecordWriter({ logsDir });
	const redis = { async eval(script) { return script === TOUCH_SCRIPTS.READ ? [["since", String(NOW - 50 * DAY)], [], 0, 0] : [0]; } };
	const read = () => readZeroTouch({ redis, logsDir, now: () => NOW, retentionDays: 0, windowDays: 7 });
	const before = await read();
	write(buildRecord({ job: { id: "ancient-approval", data: { kind: "github", repo: "acme/api", flow: "fix", target: { type: "issue", number: 2 } } }, result: { outcome: "completed", reason: "awaiting-approval" }, endedAt: new Date(NOW - 60 * DAY).toISOString(), project: "api", host: "local", touchTracking: true }));
	const unknown = await read();
	assert.equal(unknown.state, "ready");
	assert.deepEqual([unknown.totals.runs, unknown.totals.rate, unknown.coverage], [before.totals.runs, before.totals.rate, before.coverage], "the old park must not hide or change valid current rate evidence");
	assert.deepEqual([unknown.totals.waitingPartial, unknown.totals.waitingUnknown, unknown.totals.pending, unknown.totals.waitingHours], [true, 1, null, null]);
	assert.equal(unknown.projects[0].streakDays, null);
	write(buildRecord({ job: { id: "retained-decision", data: { kind: "github", repo: "acme/api", flow: "fix", target: { type: "issue", number: 2 } } }, result: { outcome: "completed", touches: [{ runId: "ancient-approval", cause: "approval-decision", at: NOW - 59 * DAY }] }, endedAt: new Date(NOW - 59 * DAY).toISOString(), project: "api", host: "local", touchTracking: true }));
	const proven = await read();
	assert.deepEqual([proven.totals.waitingPartial, proven.totals.pending, proven.totals.waitingHours], [false, 0, 0], "a surviving record fallback is terminal proof without an old index entry");
});

test("the real reader recounts expired and revoked approvals as closed waits with zero human touches", async () => {
	const logsDir = tempDir("zero-touch-terminal-wait-");
	const write = makeRecordWriter({ logsDir });
	for (const [id, daysAgo] of [["expired", 3], ["revoked", 2]]) write(buildRecord({ job: { id, data: { kind: "github", repo: "acme/api", flow: "fix", target: { type: "issue", number: 1 } } }, result: { outcome: "completed", reason: "awaiting-approval" }, endedAt: new Date(NOW - daysAgo * DAY).toISOString(), project: "api", host: "local", touchTracking: true }));
	const events = [{ type: "wait-end", reason: "approval-expired", runId: "expired", at: NOW - 2.5 * DAY }, { type: "wait-end", reason: "approval-policy-changed", runId: "revoked", at: NOW - DAY }];
	const redis = { async eval(script) { return script === TOUCH_SCRIPTS.READ ? [["since", String(NOW - 40 * DAY), "indexed", "1"], ["expiry", "revocation"], 0, 1] : [0]; }, async mget() { return events.map(event => JSON.stringify(event)); } };
	const report = await readZeroTouch({ redis, logsDir, now: () => NOW, retentionDays: 90, windowDays: 7 });
	assert.equal(report.state, "ready");
	assert.deepEqual([report.totals.runs, report.totals.touched, report.totals.rate, report.totals.pending, report.totals.waitingHours, report.totals.medianWaitMs], [2, 0, 0, 0, 36, null]);
	assert.equal(report.totals.waitingPartial, false);
	assert.deepEqual(report.totals.waitingNow, []);
	assert.equal(report.causes.reduce((sum, row) => sum + row.count, 0), 0);
});

test("the run index cap reaches the run records read: a large index of a raised cap is not read as cut by count (#761)", async () => {
	// The mirror holds 6,000 runs (none in this window) and its own start long ago, its oldest run two days old; the touch
	// index has observed ten days. At the built-in 5,000 cap that index reads as cut at its oldest run; told the
	// deployment's 10,000, it is whole, and the observed interval is the touch index's.
	const redis = {
		async eval(script) {
			if (script === TOUCH_SCRIPTS.READ) return [["since", String(NOW - 10 * DAY)], [], 0, 0];
			if (script === READ_SCRIPT) return [6000, String(NOW - 2 * DAY), null, String(NOW - 100 * DAY), 1, []];
			return [0];
		},
		async mget() { return []; },
	};
	const cut = await readZeroTouch({ redis, logsDir: localRecord(), now: () => NOW, retentionDays: 90 });
	assert.equal(cut.coverage.fromMs, NOW - 2 * DAY, "the built-in cap: the oldest run is the start");
	const whole = await readZeroTouch({ redis, logsDir: localRecord(), now: () => NOW, retentionDays: 90, indexMax: 10_000 });
	assert.equal(whole.coverage.fromMs, NOW - 10 * DAY, "the deployment's cap: nothing was cut");
});
