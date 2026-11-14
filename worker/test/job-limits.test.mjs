import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	ACTIVITY_FILE,
	BACKSTOP_GRACE_MS,
	effectiveJobLimits,
	JOB_IDLE_MINUTES_DEFAULT,
	JOB_MINUTES_MAX,
	JOB_STALL_MINUTES_DEFAULT,
	makeActivityBackstop,
	malformedJobLimits,
	parseActivityCounters,
	readActivityFile,
	validateJobLimits,
	WALL_CLOCK_FALLBACK_MS,
	WATCH_DECISION_RECHECK_MS,
	WATCH_MAX_MINUTES,
} from "../src/job-limits.mjs";
import { JOB_TIMEOUT_MS } from "../src/index.mjs";
import { ABORT_RECORD_REASONS } from "../src/processor.mjs";
import { makeStderrTranscript } from "../src/stderr-transcript.mjs";
import { buildRecord, recordedLimits, RUNNER_POLICY_REASONS } from "../src/run-history.mjs";
import { TERMINAL_COMMENTS } from "../src/comment-tables.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const MIN = 60_000;

test("the effective limits: the trigger's idle and stall, else the deployment's, else the defaults", () => {
	assert.deepEqual(effectiveJobLimits({}, {}), { idleMinutes: JOB_IDLE_MINUTES_DEFAULT, stallMinutes: JOB_STALL_MINUTES_DEFAULT, maxMinutes: null });
	assert.deepEqual(effectiveJobLimits({}, { idleMinutes: 20, stallMinutes: 0, maxMinutes: null }), { idleMinutes: 20, stallMinutes: 0, maxMinutes: null });
	// A trigger may raise either as well as lower it: neither bounds money.
	assert.deepEqual(effectiveJobLimits({ idleTimeoutMinutes: 60, stallTimeoutMinutes: 600 }, { idleMinutes: 20, stallMinutes: 240 }), { idleMinutes: 60, stallMinutes: 600, maxMinutes: null });
});

test("the effective ceiling is the smaller of the trigger's and the deployment's, each counted only when set", () => {
	assert.equal(effectiveJobLimits({ maxMinutes: 90 }, {}).maxMinutes, 90);
	assert.equal(effectiveJobLimits({}, { maxMinutes: 120 }).maxMinutes, 120);
	assert.equal(effectiveJobLimits({ maxMinutes: 300 }, { maxMinutes: 120 }).maxMinutes, 120, "an operator's ceiling is a ceiling");
	assert.equal(effectiveJobLimits({ maxMinutes: 60 }, { maxMinutes: 120 }).maxMinutes, 60);
});

test("a watch job keeps its 30-minute ceiling whatever else is set, and its re-check is derived from it", () => {
	assert.equal(effectiveJobLimits({ watch: { stage: "decision" } }, {}).maxMinutes, WATCH_MAX_MINUTES);
	assert.equal(effectiveJobLimits({ watch: { stage: "decision" }, maxMinutes: 10 }, {}).maxMinutes, 10);
	assert.equal(WATCH_DECISION_RECHECK_MS, 35 * MIN, "the re-check stays where the 30-minute timeout put it");
});

test("a malformed queued limit counts as unset and is named", () => {
	const data = { idleTimeoutMinutes: "15", stallTimeoutMinutes: -1, maxMinutes: 1.5 };
	assert.deepEqual(effectiveJobLimits(data, { idleMinutes: 20 }), { idleMinutes: 20, stallMinutes: JOB_STALL_MINUTES_DEFAULT, maxMinutes: null });
	assert.deepEqual(malformedJobLimits(data), ["idleTimeoutMinutes", "stallTimeoutMinutes", "maxMinutes"]);
	assert.deepEqual(malformedJobLimits({ idleTimeoutMinutes: 5 }), []);
});

test("the trigger fields: whole minutes in range, refused otherwise, never bent", () => {
	const refuse = (message) => {
		throw new Error(message);
	};
	assert.deepEqual(validateJobLimits({ idleTimeoutMinutes: 5, stallTimeoutMinutes: 0, maxMinutes: 90 }, refuse), { idleTimeoutMinutes: 5, stallTimeoutMinutes: 0, maxMinutes: 90 });
	assert.deepEqual(validateJobLimits({}, refuse), {});
	for (const [field, value] of [["idleTimeoutMinutes", 0], ["idleTimeoutMinutes", 1441], ["idleTimeoutMinutes", "15"], ["stallTimeoutMinutes", -1], ["maxMinutes", 0], ["maxMinutes", JOB_MINUTES_MAX + 1], ["maxMinutes", 2.5]]) {
		assert.throws(() => validateJobLimits({ [field]: value }, refuse), new RegExp(`run\\.${field} must be a whole number`), `${field}=${value}`);
	}
});

test("the 30-minute fallback is the constant the worker keeps until a watch takes over", () => {
	assert.equal(WALL_CLOCK_FALLBACK_MS, 30 * MIN);
	assert.equal(JOB_TIMEOUT_MS, WALL_CLOCK_FALLBACK_MS);
});

test("the counters parse only in their exact shape", () => {
	assert.deepEqual(parseActivityCounters('{"v":1,"steps":3,"active":7}\n'), { steps: 3, active: 7 });
	for (const bad of ["", "{}", '{"v":2,"steps":1,"active":1}', '{"v":1,"steps":-1,"active":1}', '{"v":1,"steps":1.5,"active":1}', "[1]", "x".repeat(300), null]) {
		assert.equal(parseActivityCounters(bad), null, String(bad));
	}
});

test("the counters file is read as the job's own: a regular file only, never through a link, bounded", () => {
	const dir = tempDir("job-limits-");
	assert.equal(readActivityFile(dir), null, "no file yet");
	fs.writeFileSync(join(dir, ACTIVITY_FILE), '{"v":1,"steps":2,"active":4}\n');
	assert.deepEqual(readActivityFile(dir), { steps: 2, active: 4 });
	const other = tempDir("job-limits-other-");
	fs.writeFileSync(join(other, "real.json"), '{"v":1,"steps":9,"active":9}\n');
	fs.rmSync(join(dir, ACTIVITY_FILE));
	fs.symlinkSync(join(other, "real.json"), join(dir, ACTIVITY_FILE));
	assert.equal(readActivityFile(dir), null, "a link is never followed");
	fs.rmSync(join(dir, ACTIVITY_FILE));
	fs.writeFileSync(join(dir, ACTIVITY_FILE), " ".repeat(10_000));
	assert.equal(readActivityFile(dir), null, "an oversize file is not read");
});

/** A backstop on a fake clock. */
function backstop({ idleMs = 15 * MIN, stallMs = 240 * MIN } = {}) {
	const h = { t: 0, stops: [] };
	h.b = makeActivityBackstop({ idleMs, stallMs, now: () => h.t, onStop: (r) => h.stops.push(r) });
	return h;
}

test("the backstop stops a job whose counters stopped changing, a grace after the runner should have", () => {
	const h = backstop();
	h.b.observe({ steps: 1, active: 1 });
	h.t = 15 * MIN + BACKSTOP_GRACE_MS - 1;
	assert.equal(h.b.check(), null);
	h.t += 1;
	assert.equal(h.b.check(), "idle");
	assert.deepEqual(h.stops, ["idle"]);
	h.t += MIN;
	h.b.check();
	assert.deepEqual(h.stops, ["idle"], "once");
});

test("the backstop's clocks move only when a counter changes, stamped with the worker's clock", () => {
	const h = backstop({ idleMs: 15 * MIN, stallMs: 60 * MIN });
	h.b.observe({ steps: 1, active: 1 });
	// Activity every five minutes, no step: not idle, stalled at 60 + grace after the last step.
	for (let i = 1; i * 5 * MIN < 60 * MIN + BACKSTOP_GRACE_MS; i++) {
		h.t = i * 5 * MIN;
		h.b.observe({ steps: 1, active: 1 + i });
		assert.equal(h.b.check(), null, `at ${i * 5} minutes`);
	}
	h.t = 60 * MIN + BACKSTOP_GRACE_MS;
	h.b.observe({ steps: 1, active: 99 });
	assert.equal(h.b.check(), "stalled");
	assert.equal(h.b.state.lastStepAt, 0);
});

test("the backstop starts its clocks at the container's start: a runner that never writes is a runner that never judged", () => {
	const h = backstop();
	h.t = 17 * MIN;
	assert.equal(h.b.check(), "idle");
});

test("a stall limit of 0 or none is never a stall", () => {
	for (const stallMs of [0, null]) {
		const h = backstop({ idleMs: 15 * MIN, stallMs });
		for (let m = 1; m <= 600; m++) {
			h.t = m * MIN;
			h.b.observe({ steps: 1, active: m });
		}
		assert.equal(h.b.check(), null);
	}
});

test("on a copying venue the counters arrive as a signed `a` record, and a forged one is not read", () => {
	const key = "k".repeat(64);
	const runId = "pi-job-gh-1";
	const record = (seq, type, end, payload) => {
		const bytes = Buffer.from(payload);
		const mac = createHmac("sha256", key).update(`pi-dispatch-transcript\0${runId}\0${seq}\0${type}\0${end}\0`, "utf8").update(bytes).digest("hex");
		return `\x1epidt ${seq} ${type} ${end} ${mac} ${bytes.toString("base64")}\n`;
	};
	const seen = [];
	const demux = makeStderrTranscript({ key, runId, onActivity: (bytes) => seen.push(parseActivityCounters(Buffer.from(bytes).toString("utf8"))) });
	const out = demux.push(Buffer.from(record(1, "b", 0, "") + record(2, "a", 0, '{"v":1,"steps":1,"active":2}') + record(3, "a", 0, '{"v":1,"steps":2,"active":3}').replace(/ [0-9a-f]{64} /, ` ${"0".repeat(64)} `)));
	assert.equal(out.length, 0, "no record reaches the job log");
	assert.deepEqual(seen, [{ steps: 1, active: 2 }]);
	assert.equal(demux.stats().unverified, 1);
});

test("the new stops are named: the abort reasons map closed, the runner's two are policy reasons, each has a comment", () => {
	assert.equal(ABORT_RECORD_REASONS.idle, "idle");
	assert.equal(ABORT_RECORD_REASONS.stalled, "stalled");
	assert.equal(ABORT_RECORD_REASONS["max-minutes"], "max-minutes");
	assert.equal(ABORT_RECORD_REASONS["job-timeout-30m"], "max-minutes", "the wall clock is a time limit, named as one");
	assert.equal(Object.hasOwn(ABORT_RECORD_REASONS, "shutdown"), false, "a shutdown stays worker-abort");
	assert.ok(RUNNER_POLICY_REASONS.has("idle") && RUNNER_POLICY_REASONS.has("stalled"));
	for (const reason of ["idle", "stalled", "max-minutes"]) assert.equal(typeof TERMINAL_COMMENTS[reason], "string", reason);
	assert.doesNotMatch(TERMINAL_COMMENTS["worker-abort"], /30-minute/, "a shutdown is no longer worded as a time limit");
});

test("the record's limits are rebuilt from a closed shape, and absent before a job was admitted", () => {
	assert.equal(recordedLimits(null), null);
	assert.equal(recordedLimits({ basis: "nonsense" }), null);
	assert.deepEqual(recordedLimits({ idleMinutes: 15, stallMinutes: 240, maxMinutes: null, basis: "activity", channel: "file", lastStepAt: "2026-11-14T10:00:00.000Z", lastActivityAt: "2026-11-14T10:05:00Z", extra: "x" }), { idleMinutes: 15, stallMinutes: 240, maxMinutes: null, basis: "activity", channel: "file", lastStepAt: "2026-11-14T10:00:00.000Z", lastActivityAt: "2026-11-14T10:05:00.000Z" });
	assert.deepEqual(recordedLimits({ idleMinutes: 15, stallMinutes: 0, maxMinutes: 30, basis: "wall-clock", why: "subscription", unavailable: "no-transcript" }), { idleMinutes: 15, stallMinutes: 0, maxMinutes: 30, basis: "wall-clock", why: "subscription", unavailable: "no-transcript" });
	assert.deepEqual(recordedLimits({ idleMinutes: 15, stallMinutes: 240, maxMinutes: null, basis: "wall-clock", why: "a job's own words", channel: "elsewhere" }), { idleMinutes: 15, stallMinutes: 240, maxMinutes: null, basis: "wall-clock" });
	const job = { id: "j1", name: "j1", data: { kind: "local" }, attemptsMade: 0, timestamp: 0 };
	const at = "2026-11-14T10:00:00.000Z";
	assert.equal("limits" in buildRecord({ job, result: { outcome: "policy", reason: "idle" }, startedAt: at, endedAt: at }), false, "no limits passed, no key");
	const record = buildRecord({ job, result: { outcome: "policy", reason: "idle" }, startedAt: at, endedAt: at, limits: { idleMinutes: 15, stallMinutes: 240, maxMinutes: null, basis: "activity" } });
	assert.deepEqual(record.limits, { idleMinutes: 15, stallMinutes: 240, maxMinutes: null, basis: "activity" });
	assert.equal(Object.keys(record).at(-1), "v", "the version stays the last key");
});
