import assert from "node:assert/strict";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { buildRecord, makeRecordWriter } from "../src/run-history.mjs";
import { TOUCH_SCRIPTS } from "../src/touch-state.mjs";
import { readZeroTouch } from "../src/zero-touch.mjs";

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
	assert.equal(report.state, "unavailable");
	assert.ok(report.coverage.reasons.includes("touch-tracking-not-started"));
	assert.equal(report.coverage.fromMs, NOW);
});
