import assert from "node:assert/strict";
import { test } from "node:test";
import {
	COMMENT_ID_RE,
	PROGRESS_HEARTBEAT_MS,
	PROGRESS_ID_MAX,
	PROGRESS_KEY_PREFIX,
	PROGRESS_MAX_BYTES,
	PROGRESS_OPEN_MAX,
	PROGRESS_PHASES_MAX,
	PROGRESS_RECENT_MAX,
	PROGRESS_RUNNING_MAX,
	makeProgress,
	makeProgressSink,
	makeProgressWriter,
	progressKeyFor,
	recordToolOf,
	serializeProgress,
} from "../src/run-progress.mjs";
import { makeRedactor } from "../src/redact-secrets.mjs";
import { PROGRESS_RECORD_TOOLS, buildRecord, recordedProgress } from "../src/run-history.mjs";
import { makeStatusCommenter } from "../src/status-comment.mjs";

// Issue #644: the progress reducer, fed pi 1.2.0-shaped session entries (pi-agent-core dist/agent-loop.js
// `createToolResultMessage`: a toolResult carries toolCallId, toolName, isError and, when the tool ran, durationMs).
// The key writer against a real Valkey is in live-transcript.test.mjs, which owns database 14.

const T0 = Date.parse("2026-10-16T10:00:00.000Z");
const clock = (start = T0) => {
	let t = start;
	const now = () => t;
	now.advance = (ms) => (t += ms);
	return now;
};
const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const asst = (...calls) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "thinking aloud" }, ...calls], stopReason: calls.length ? "toolUse" : "stop" } });
const result = (id, name, { isError = false, durationMs } = {}) => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "out" }], isError, ...(durationMs === undefined ? {} : { durationMs }) } });

test("the key and the constants readers share (#644)", () => {
	assert.equal(PROGRESS_KEY_PREFIX, "run:progress:");
	assert.equal(progressKeyFor("repeat:abc:17"), "run:progress:repeat_abc_17");
	assert.equal(PROGRESS_MAX_BYTES, 16 * 1024);
	assert.deepEqual([PROGRESS_OPEN_MAX, PROGRESS_RECENT_MAX, PROGRESS_RUNNING_MAX, PROGRESS_PHASES_MAX], [256, 20, 8, 32]);
	assert.ok(COMMENT_ID_RE.test("123:456") && !COMMENT_ID_RE.test("a b") && !COMMENT_ID_RE.test(""));
	assert.deepEqual([...PROGRESS_RECORD_TOOLS], ["read", "bash", "edit", "write", "grep", "find", "ls", "await_human_input", "report_progress"]);
	assert.equal(recordToolOf("bash"), "bash");
	assert.equal(recordToolOf("Bash"), "other");
	assert.equal(recordToolOf({ toString: () => "bash" }), "other", "compared, never coerced");
});

test("turns and steps: one turn per assistant message, a step per call, closed by its result (#644)", () => {
	const now = clock();
	const p = makeProgress({ jobId: "j", now });
	p.consume({ type: "session", id: "s" }, T0);
	p.consume(asst(), T0 + 1);
	p.consume(asst(call("a", "read", { path: "x" })), T0 + 2);
	let s = p.snapshot();
	assert.equal(s.turn, 2);
	assert.deepEqual(s.running, [{ tool: "read", since: T0 + 2 }]);
	p.consume(result("a", "read", { durationMs: 40 }), T0 + 50);
	p.consume(asst(call("b", "bash")), T0 + 60);
	p.consume(result("b", "bash", { isError: true, durationMs: 7 }), T0 + 70);
	s = p.snapshot();
	assert.deepEqual([s.v, s.turn, s.steps, s.failed, s.interrupted, s.ended, s.outcome, s.prior, s.phase, s.note], [1, 3, 2, 1, 0, false, null, null, null, null]);
	assert.deepEqual(s.running, []);
	assert.deepEqual(s.recent, [
		{ tool: "read", status: "ok", durationMs: 40, at: T0 + 50 },
		{ tool: "bash", status: "error", durationMs: 7, at: T0 + 70 },
	]);
	assert.equal(s.startedAt, T0);
	assert.deepEqual(p.summary(), { turns: 3, steps: 2, failed: 1, toolMs: 47, longestStepMs: 40, tools: { read: 1, bash: 1 } });
});

test("a parallel batch: durations come from durationMs, never from the results' shared timestamp (#644)", () => {
	const p = makeProgress({ now: clock() });
	p.consume(asst(call("1", "read"), call("2", "grep"), call("3", "bash")), T0);
	assert.equal(p.snapshot().running.length, 3);
	// pi saves the whole batch's results together, after the slowest one.
	for (const [id, name, ms] of [["1", "read", 5], ["2", "grep", 9], ["3", "bash", 3000]]) p.consume(result(id, name, { durationMs: ms }), T0 + 3001);
	const s = p.snapshot();
	assert.deepEqual(s.recent.map((r) => r.durationMs), [5, 9, 3000]);
	assert.deepEqual(p.summary(), { turns: 1, steps: 3, toolMs: 3014, longestStepMs: 3000, tools: { read: 1, bash: 1, grep: 1 } });
});

test("a result with no durationMs (failed before it ran) has a null duration, and junk durations count as none (#644)", () => {
	const p = makeProgress({ now: clock() });
	p.consume(asst(call("1", "nope"), call("2", "read"), call("3", "read")), T0);
	p.consume(result("1", "nope", { isError: true }), T0 + 1);
	p.consume(result("2", "read", { durationMs: -5 }), T0 + 1);
	p.consume(result("3", "read", { durationMs: "9" }), T0 + 1);
	assert.deepEqual(p.snapshot().recent.map((r) => r.durationMs), [null, null, null]);
	assert.deepEqual(p.summary(), { turns: 1, steps: 3, failed: 1, tools: { read: 2, other: 1 } });
});

test("an unknown or hostile tool name shows as ?, counts as other, and a name redaction would change is ? too (#644)", () => {
	const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
	const p = makeProgress({ now: clock(), redact: makeRedactor({ values: [token] }) });
	p.consume(asst(call("1", "<script>x</script>"), call("2", token), call("3", "my_tool"), call("4", 42)), T0);
	assert.deepEqual(p.snapshot().running.map((r) => r.tool), ["?", "?", "my_tool", "?"]);
	for (const id of ["1", "2", "3", "4"]) p.consume(result(id, "x", { durationMs: 1 }), T0 + 1);
	assert.deepEqual(p.summary().tools, { other: 4 });
	assert.ok(!JSON.stringify(p.snapshot()).includes(token));
});

test("duplicate and unknown result ids, and a reused call id, are anomalies and change nothing (#644)", () => {
	const p = makeProgress({ now: clock() });
	p.consume(asst(call("1", "read")), T0);
	p.consume(result("1", "read", { durationMs: 1 }), T0 + 1);
	const before = JSON.stringify(p.snapshot());
	p.consume(result("1", "read", { durationMs: 99 }), T0 + 2); // duplicate
	p.consume(result("zz", "bash", { durationMs: 99 }), T0 + 2); // unknown
	p.consume({ type: "message", message: { role: "toolResult", toolName: "read" } }, T0 + 2); // no id
	assert.equal(JSON.stringify(p.snapshot()), before);
	p.consume(asst(call("2", "read"), call("2", "bash"), call("", "ls")), T0 + 3);
	assert.deepEqual(p.snapshot().running.map((r) => r.tool), ["read"], "the second call with the same id is not opened");
	assert.equal(p.stats().anomalies, 5);
	assert.equal(p.summary().steps, 1);
});

test("open steps at the end are interrupted; nothing is consumed after the end (#644)", () => {
	const now = clock();
	const p = makeProgress({ now });
	p.consume(asst(call("1", "bash"), call("2", "read")), T0);
	p.consume(result("2", "read", { durationMs: 3 }), T0 + 5);
	now.advance(1000);
	const s = p.finalSnapshot("policy");
	assert.deepEqual([s.ended, s.outcome, s.interrupted, s.steps, s.running.length], [true, "policy", 1, 1, 0]);
	assert.deepEqual(s.recent.at(-1), { tool: "bash", status: "interrupted", durationMs: null, at: T0 + 1000 });
	p.consume(asst(call("3", "ls")), T0 + 2000);
	assert.equal(p.snapshot().turn, 1, "ignored after the end");
	assert.equal(p.finalSnapshot("completed").outcome, "policy", "the end is taken once");
	assert.deepEqual(p.summary(), { turns: 1, steps: 1, interrupted: 1, toolMs: 3, longestStepMs: 3, longestInterruptedMs: 1000, tools: { read: 1 } }, "interrupted steps are not closed steps in tools");
	assert.equal(makeProgress({ now }).finalSnapshot("weird").outcome, "unknown");
});

test("the resume baseline: prior lines seed prior counts and the phases, never this attempt's counters (#644)", () => {
	const p = makeProgress({ now: clock(), phasesEnabled: true });
	const prior = { prior: true };
	p.consume({ type: "session" }, T0, prior);
	p.consume(asst(call("p1", "report_progress", { phase: "plan", total: 3, done: 1 })), T0, prior);
	p.consume(result("p1", "report_progress", { durationMs: 1 }), T0, prior);
	p.consume(asst(call("p2", "report_progress", { phase: "build" })), T0, prior);
	p.consume(result("p2", "report_progress", { durationMs: 1 }), T0, prior);
	p.consume(asst(call("p3", "bash")), T0, prior); // left open by the earlier run
	let s = p.snapshot();
	assert.deepEqual([s.turn, s.steps, s.running.length], [0, 0, 0], "nothing counted for this attempt");
	assert.deepEqual(s.prior, { turns: 3, steps: 2 });
	assert.deepEqual(s.phases, ["plan", "build"]);
	assert.deepEqual(s.phase, { index: 1, done: null, total: null });
	// This attempt continues the phases.
	p.consume(asst(call("n1", "report_progress", { phase: "plan", done: 3, total: 3 })), T0 + 1);
	p.consume(result("n1", "report_progress", { durationMs: 1 }), T0 + 2);
	p.consume(result("p3", "bash", { durationMs: 1 }), T0 + 3); // the earlier run's open call: unknown here
	s = p.snapshot();
	assert.deepEqual([s.turn, s.steps], [1, 1]);
	assert.deepEqual(s.phase, { index: 0, done: 3, total: 3 });
	assert.equal(p.finalSnapshot("completed").interrupted, 0, "an earlier run's open call is not this attempt's to interrupt");
	assert.deepEqual(p.summary(), { turns: 1, steps: 1, toolMs: 1, longestStepMs: 1, phasesDeclared: 2, lastPhaseIndex: 0, tools: { report_progress: 1 } });
});

test("a call id longer than 128 units is an anomaly: a forged megabyte id pins nothing, live or prior (#644)", () => {
	assert.equal(PROGRESS_ID_MAX, 128);
	const p = makeProgress({ now: clock(), phasesEnabled: true });
	// One line just under a mebibyte, one id filling it: refused, so `open` holds nothing.
	const big = `${"x".repeat(1024 * 1024 - 200)}`;
	const line = JSON.stringify(asst(call(big, "bash")));
	assert.ok(Buffer.byteLength(line) < 1024 * 1024);
	p.consume(JSON.parse(line), T0);
	assert.equal(p.stats().open, 0);
	assert.equal(p.stats().anomalies, 1);
	// The edge: 128 units is a step, 129 is not, and a result naming a long id is an anomaly too.
	p.consume(asst(call("a".repeat(128), "read"), call("b".repeat(129), "read")), T0);
	assert.equal(p.stats().open, 1);
	p.consume(result(big, "bash", { durationMs: 1 }), T0);
	assert.equal(p.stats().anomalies, 3);
	assert.equal(p.summary().steps, undefined);
	// The prior path keeps no long id either: its result finds nothing to apply, so no phase is set.
	const q = makeProgress({ now: clock(), phasesEnabled: true });
	q.consume(asst(call(big, "report_progress", { phase: "plan" })), T0, { prior: true });
	q.consume(result(big, "report_progress", { durationMs: 1 }), T0, { prior: true });
	assert.deepEqual([q.snapshot().phase, q.snapshot().phases, q.snapshot().prior], [null, [], { turns: 1, steps: 1 }]);
});

test("a message that ended in a provider error or an abort opens no steps; an error is not a turn, an abort is (#644)", () => {
	// pi-agent-core's agent loop returns on stopReason "error" or "aborted" before it runs a tool, and an auto-retry asks
	// again with new ids, so the first message's half-streamed calls would read as running for good.
	const now = clock();
	const p = makeProgress({ now, phasesEnabled: true });
	const ended = (stopReason, ...calls) => ({ type: "message", message: { role: "assistant", content: calls, stopReason } });
	p.consume(ended("error", call("c1", "bash")), T0);
	p.consume(asst(call("c2", "bash")), T0 + 1);
	p.consume(result("c2", "bash", { durationMs: 5 }), T0 + 2);
	p.consume(ended("aborted", call("c3", "read"), call("c4", "report_progress", { phase: "x" })), T0 + 3);
	const s = p.snapshot();
	assert.deepEqual([s.turn, s.steps, s.running.length, s.phases.length], [2, 1, 0, 0], "the retry and the abort are turns, the error is not");
	assert.equal(p.stats().anomalies, 3, "each call pi never ran is counted");
	now.advance(60_000);
	assert.equal(p.finalSnapshot("completed").interrupted, 0, "nothing reads as interrupted either");
	// The prior lines count turns the same way, and a report in an errored message is no phase.
	const q = makeProgress({ now: clock(), phasesEnabled: true });
	q.consume(ended("error", call("p1", "report_progress", { phase: "plan" })), T0, { prior: true });
	q.consume(result("p1", "report_progress", { durationMs: 1 }), T0, { prior: true });
	q.consume(asst(), T0, { prior: true });
	assert.deepEqual([q.snapshot().prior, q.snapshot().phase], [{ turns: 1, steps: 1 }, null]);
});

test("a report_progress the runner refused in the prior lines does not set the resumed run's phase (#644)", () => {
	const p = makeProgress({ now: clock(), phasesEnabled: true });
	const prior = { prior: true };
	p.consume(asst(call("p1", "report_progress", { phase: "plan" })), T0, prior);
	p.consume(result("p1", "report_progress", { isError: true, durationMs: 1 }), T0, prior);
	assert.deepEqual([p.snapshot().phase, p.snapshot().phases], [null, []]);
	p.consume(asst(call("p2", "report_progress", { phase: "build" })), T0, prior);
	p.consume(result("p2", "report_progress", { durationMs: 1 }), T0, prior);
	assert.deepEqual([p.snapshot().phase, p.snapshot().phases], [{ index: 0, done: null, total: null }, ["build"]], "an accepted one does");
});

test("longestInterruptedMs: an open step's time from its call to the end, beside toolMs as a sum (#644)", () => {
	const now = clock();
	const p = makeProgress({ now });
	p.consume(asst(call("a", "bash"), call("b", "bash"), call("c", "bash")), T0);
	for (const id of ["a", "b", "c"]) p.consume(result(id, "bash", { durationMs: 60_000 }), T0 + 61_000);
	p.consume(asst(call("h", "bash"), call("i", "read")), T0 + 62_000);
	p.consume(asst(call("j", "ls")), T0 + 100_000);
	now.advance(62_000 + 29 * 60_000);
	p.finalSnapshot("policy");
	const sum = p.summary();
	assert.equal(sum.toolMs, 180_000, "a parallel batch adds each step's duration");
	assert.equal(sum.longestStepMs, 60_000);
	assert.equal(sum.longestInterruptedMs, 29 * 60_000, "the hung step, from its call to the end");
	assert.equal(recordedProgress(sum).longestInterruptedMs, 29 * 60_000, "and the record keeps it");
	assert.equal(recordedProgress({ longestInterruptedMs: 1.5 }).longestInterruptedMs, undefined, "integers only");
	// A forged call time past the end clamps to 0, never a negative.
	const q = makeProgress({ now: clock() });
	q.consume(asst(call("f", "bash")), T0 + 3_600_000);
	q.finalSnapshot("failed");
	assert.equal(q.summary().longestInterruptedMs, undefined);
});

test("a reset keeps the counts seen; replayed lines count nothing except a result closing a step still open (#644)", () => {
	const p = makeProgress({ now: clock(), phasesEnabled: true });
	p.consume(asst(call("1", "read")), T0);
	p.consume(result("1", "read", { durationMs: 2 }), T0 + 1);
	p.consume(asst(call("2", "bash")), T0 + 2);
	p.reset();
	const replay = { prior: false, replay: true };
	p.consume(asst(call("1", "read")), T0, replay);
	p.consume(result("1", "read", { durationMs: 2 }), T0 + 1, replay);
	p.consume(asst(call("2", "bash")), T0 + 2, replay);
	p.consume(asst(call("r", "report_progress", { phase: "x" })), T0 + 2, replay);
	p.consume(result("r", "report_progress", { durationMs: 1 }), T0 + 2, replay);
	p.consume(result("2", "bash", { durationMs: 9 }), T0 + 3, replay); // the open step's result, inside the rewrite
	let s = p.snapshot();
	assert.deepEqual([s.turn, s.steps, s.phases.length, s.prior], [2, 2, 0, null]);
	assert.equal(p.stats().anomalies, 0, "a replayed duplicate is not an anomaly");
	assert.equal(p.stats().resets, 1);
	p.consume(asst(call("3", "ls")), T0 + 4);
	p.consume(result("3", "ls", { durationMs: 1 }), T0 + 5);
	s = p.snapshot();
	assert.deepEqual([s.turn, s.steps], [3, 3], "lines after the rewrite count as usual");
});

test("memory is bounded: 256 open steps, 20 recent, 8 running, 32 phases (#644)", () => {
	const p = makeProgress({ now: clock(), phasesEnabled: true });
	const many = Array.from({ length: PROGRESS_OPEN_MAX + 10 }, (_, i) => call(`c${i}`, "read"));
	p.consume(asst(...many), T0);
	assert.equal(p.stats().open, PROGRESS_OPEN_MAX);
	assert.equal(p.stats().evicted, 10);
	assert.equal(p.snapshot().running.length, PROGRESS_RUNNING_MAX);
	assert.equal(p.snapshot().running.at(-1).since, T0, "newest last");
	p.consume(result("c0", "read", { durationMs: 1 }), T0 + 1);
	assert.equal(p.snapshot().steps, 0, "an evicted step's result is unknown");
	for (let i = 10; i < 50; i += 1) p.consume(result(`c${i}`, "read", { durationMs: i }), T0 + i);
	assert.equal(p.snapshot().recent.length, PROGRESS_RECENT_MAX);
	assert.equal(p.snapshot().recent.at(-1).durationMs, 49, "the newest kept");
	for (let i = 0; i < PROGRESS_PHASES_MAX + 5; i += 1) {
		p.consume(asst(call(`ph${i}`, "report_progress", { phase: `phase ${i}` })), T0);
		p.consume(result(`ph${i}`, "report_progress", { durationMs: 1 }), T0);
	}
	const s = p.snapshot();
	assert.equal(s.phases.length, PROGRESS_PHASES_MAX);
	assert.equal(s.phase.index, PROGRESS_PHASES_MAX - 1, "a new name past the cap leaves the current phase");
	assert.equal(p.stats().phaseRefused, 5);
});

test("phases: ignored without run.progress, applied on an ok result only, and invalid arguments ignored whole (#644)", () => {
	const off = makeProgress({ now: clock(), phasesEnabled: false });
	off.consume(asst(call("1", "report_progress", { phase: "plan" })), T0);
	off.consume(result("1", "report_progress", { durationMs: 1 }), T0);
	assert.deepEqual([off.snapshot().phases, off.snapshot().phase], [[], null]);
	assert.deepEqual(off.summary().tools, { report_progress: 1 }, "still a step");

	const on = makeProgress({ now: clock(), phasesEnabled: true });
	on.consume(asst(call("e", "report_progress", { phase: "plan" })), T0);
	on.consume(result("e", "report_progress", { isError: true, durationMs: 1 }), T0);
	assert.deepEqual(on.snapshot().phases, [], "the runner refused it: an error result is not a report");
	const bad = [
		{ phase: "" },
		{ phase: "   " },
		{ phase: "x".repeat(65) },
		{ phase: 7 },
		{ phase: "a", done: 4, total: 3 },
		{ phase: "a", total: 0 },
		{ phase: "a", done: -1 },
		{ phase: "a", done: 1.5 },
		{ phase: "a", total: 1_000_001 },
		{ phase: "a", note: "n".repeat(201) },
		{ phase: "a", note: 5 },
		"phase=a",
		null,
	];
	bad.forEach((args, i) => {
		on.consume(asst(call(`b${i}`, "report_progress", args)), T0);
		on.consume(result(`b${i}`, "report_progress", { durationMs: 1 }), T0);
	});
	assert.deepEqual(on.snapshot().phases, [], "none of them");
	assert.equal(on.stats().phaseRefused, bad.length);
	on.consume(asst(call("g", "report_progress", { phase: "x".repeat(64), done: 0, total: 1_000_000, note: "half" })), T0);
	assert.deepEqual(on.snapshot().phases, [], "not before its result");
	on.consume(result("g", "report_progress", { durationMs: 1 }), T0);
	assert.deepEqual(on.snapshot().phase, { index: 0, done: 0, total: 1_000_000 });
	assert.equal(on.snapshot().note, "half");
	on.consume(asst(call("h", "report_progress", { phase: "x".repeat(64) })), T0);
	on.consume(result("h", "report_progress", { durationMs: 1 }), T0);
	assert.deepEqual([on.snapshot().phases.length, on.snapshot().note], [1, null], "a known name keeps its index; a report with no note clears it");
});

test("hostile phase text is redacted then escaped and cut, and a secret in a note is redacted (#644)", () => {
	const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	const p = makeProgress({ now: clock(), phasesEnabled: true, redact: makeRedactor({ values: [secret] }) });
	const phase = "ok‮evil\u0007\n<b>";
	p.consume(asst(call("1", "report_progress", { phase, note: `key ${secret} here\u001b[2J` })), T0);
	p.consume(result("1", "report_progress", { durationMs: 1 }), T0);
	const s = p.snapshot();
	assert.equal(s.phases[0], "ok\\u{202E}evil\\u{0007}\\u{000A}<b>");
	assert.ok(!s.note.includes(secret), "redacted");
	assert.ok(!/[\u0000-\u001f‮]/.test(s.note + s.phases[0]), "no control or bidi character survives");
	// A phase of 64 control characters escapes to far more than 64 code points, and is cut whole-escape.
	p.consume(asst(call("2", "report_progress", { phase: "\u0007".repeat(64) })), T0);
	p.consume(result("2", "report_progress", { durationMs: 1 }), T0);
	const cut = p.snapshot().phases[1];
	assert.ok([...cut].length <= 64);
	assert.match(cut, /^(\\u\{0007\})+$/);
	// A redactor that throws: the phase is dropped, never its raw text.
	const throwing = makeProgress({ now: clock(), phasesEnabled: true, redact: () => { throw new Error("x"); } });
	throwing.consume(asst(call("1", "report_progress", { phase: "raw" })), T0);
	throwing.consume(result("1", "report_progress", { durationMs: 1 }), T0);
	assert.deepEqual(throwing.snapshot().phases, []);
	assert.deepEqual(throwing.snapshot().recent.map((r) => r.tool), ["?"], "and the tool name is ? when the redactor throws");
});

test("the serialized snapshot fits 16 KiB: recent first, then phases from the tail, then the note (#644)", () => {
	const big = (n) => "\u{1F600}".repeat(n);
	const snap = {
		v: 1,
		turn: 1,
		steps: 1,
		failed: 0,
		interrupted: 0,
		running: [],
		// Past what the reducer's caps produce, so every cut is reached: serializeProgress is the last bound, not the only one.
		recent: Array.from({ length: 20 }, (_, i) => ({ tool: "x".repeat(400), status: "ok", durationMs: i, at: T0 })),
		phase: { index: 31, done: null, total: null },
		phases: Array.from({ length: 32 }, (_, i) => `${i}${big(200)}`),
		note: big(200),
		prior: null,
		startedAt: T0,
		updatedAt: T0,
		ended: false,
		outcome: null,
		commentId: null,
	};
	const json = serializeProgress(snap);
	assert.ok(Buffer.byteLength(json) <= PROGRESS_MAX_BYTES, `${Buffer.byteLength(json)} bytes`);
	const back = JSON.parse(json);
	assert.equal(back.recent.length, 0, "recent went first");
	assert.ok(back.phases.length < 32 && back.phases.length > 0, "then the tail of phases");
	assert.equal(back.phases[0], snap.phases[0], "the head kept");
	assert.equal(snap.recent.length, 20, "the input is not changed");
	const tiny = JSON.parse(serializeProgress(snap, 300));
	assert.deepEqual([tiny.recent.length, tiny.phases.length, tiny.note], [0, 0, null], "and the note last");
});

// --- the run record --------------------------------------------------------------------------------------------

const JOB = { id: "42", name: "github", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } }, attemptsMade: 0 };
const rec = (progress) => buildRecord({ job: JOB, result: { outcome: "completed", exitCode: 0, ...(progress === undefined ? {} : { progress }) }, startedAt: "a", endedAt: "b" });

test("the record's progress: integers and closed keys at the tail, absent when the reducer did not run (#644)", () => {
	const without = rec(undefined);
	assert.equal("progress" in without, false, "absent, so a record without it is byte-identical to before");
	assert.equal("progress" in rec(null), false);
	const p = makeProgress({ now: clock(), phasesEnabled: true });
	p.consume(asst(call("1", "report_progress", { phase: "one" }), call("2", "edit")), T0);
	p.consume(result("1", "report_progress", { durationMs: 2 }), T0);
	p.consume(asst(call("3", "bash")), T0);
	p.finalSnapshot("completed");
	const r = rec(p.summary());
	assert.deepEqual(Object.keys(r).slice(-2), ["stalledRepick", "progress"], "the tail, after stalledRepick");
	assert.deepEqual(Object.keys(r).slice(0, -1), Object.keys(without), "every other key where it was");
	assert.deepEqual(r.progress, { turns: 2, steps: 1, interrupted: 2, toolMs: 2, longestStepMs: 2, phasesDeclared: 1, lastPhaseIndex: 0, tools: { report_progress: 1 } });
	assert.deepEqual(rec({}).progress, {}, "the reducer ran and saw nothing: present and empty");
});

test("make-it-lie: a tool call named like a secret or markup leaves no string from it in the record (#644)", () => {
	const hostile = ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "<img src=x onerror=alert(1)>", "../../etc/passwd", "bash ", "__proto__", "constructor", "toString"];
	const p = makeProgress({ now: clock(), phasesEnabled: true });
	p.consume(asst(...hostile.map((name, i) => call(`h${i}`, name)), call("ph", "report_progress", { phase: "SECRET-PHASE-NAME", note: "SECRET-NOTE" })), T0);
	hostile.forEach((name, i) => p.consume(result(`h${i}`, name, { durationMs: 1 }), T0));
	p.consume(result("ph", "report_progress", { durationMs: 1 }), T0);
	assert.ok(JSON.stringify(p.snapshot()).includes("SECRET-PHASE-NAME"), "the key does carry it (operators only)");
	const json = JSON.stringify(rec(p.summary()).progress);
	for (const s of [...hostile.map((h) => h.trim()), "SECRET", "img", "etc"]) assert.ok(!json.includes(s), `no ${s} in ${json}`);
	assert.deepEqual(rec(p.summary()).progress.tools, { report_progress: 1, other: hostile.length });
	// And a forged summary handed straight to the record: unknown keys, strings and junk numbers are dropped.
	const forged = { turns: "7", steps: 2.5, failed: -1, toolMs: 3, evil: "<b>", lastPhaseIndex: 4, tools: { bash: 1, "<b>": 9, other: "x", __proto__: { read: 5 } } };
	assert.deepEqual(recordedProgress(forged), { toolMs: 3, tools: { bash: 1 } }, "lastPhaseIndex only beside declared phases");
	assert.equal(recordedProgress([1]), undefined);
	assert.equal(recordedProgress("x"), undefined);
});

// --- the writer and the sink, with hand-rolled fakes ------------------------------------------------------------

function fakeRedis({ old = null, status = "ready" } = {}) {
	const sets = [];
	return {
		status,
		sets,
		get: async () => old,
		set: async (key, value, px, ttl) => (sets.push({ key, value: JSON.parse(value), px, ttl }), "OK"),
	};
}
function fakeTimers() {
	const timers = [];
	return {
		timers,
		setTimer: (fn, ms) => {
			const t = { fn, ms, cleared: false };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => {
			if (t) t.cleared = true;
		},
		// The pending timer due soonest (the shortest delay; the first made on a tie), so a 30 s heartbeat waits behind a
		// trailing write.
		fire: async () => {
			const t = timers.filter((x) => !x.cleared && !x.fired).sort((a, b) => a.ms - b.ms)[0];
			if (!t) return false;
			t.fired = true;
			t.fn();
			await new Promise((r) => setImmediate(r));
			return true;
		},
	};
}
const settle = () => new Promise((r) => setImmediate(r));

test("the sink: the commenter starts with the earlier attempt's comment id, is fed each write, and finishes with the outcome (#644)", async () => {
	const now = clock();
	const redis = fakeRedis({ old: JSON.stringify({ v: 1, commentId: "c-41" }) });
	const timers = fakeTimers();
	const seen = [];
	const commenter = {
		start: (s) => seen.push(["start", s.commentId, s.turn]),
		update: (s) => seen.push(["update", s.turn]),
		finish: async (s, outcome) => seen.push(["finish", outcome, s.ended, s.commentId]),
	};
	const made = [];
	const sink = makeProgressSink({ redis, jobId: "j:1", now, phasesEnabled: false, makeCommenter: (o) => (made.push(o), commenter), writer: { setTimer: timers.setTimer, clearTimer: timers.clearTimer } });
	await sink.start();
	assert.equal(made[0].commentId, "c-41");
	assert.equal(made[0].jobId, "j:1");
	assert.deepEqual(seen[0], ["start", "c-41", 0]);
	await settle();
	sink.consume(asst(call("1", "read")), T0);
	sink.consume(asst(), T0);
	await settle();
	assert.ok(timers.timers.length >= 1, "a burst inside the second waits for the trailing write");
	now.advance(1000);
	await timers.fire();
	await settle();
	assert.equal(redis.sets.at(-1).value.turn, 2, "the trailing write carries the latest");
	assert.equal(redis.sets.at(-1).value.commentId, "c-41", "the comment id rides every write");
	assert.ok(seen.some((e) => e[0] === "update" && e[1] === 2));
	await sink.finish("failed");
	assert.deepEqual(seen.at(-1), ["finish", "failed", true, "c-41"]);
	assert.equal(redis.sets.at(-1).value.ended, true);
	assert.equal(redis.sets.at(-1).value.interrupted, 1);
	const writes = redis.sets.length;
	sink.consume(asst(), T0);
	await settle();
	assert.equal(redis.sets.length, writes, "nothing written after the final write");
	assert.deepEqual(sink.summary(), { turns: 2, interrupted: 1, longestInterruptedMs: 1000 });
});

test("the sink with no commenter, a throwing one, and a commenter id posted later (#644)", async () => {
	const redis = fakeRedis();
	const plain = makeProgressSink({ redis, jobId: "a", now: clock() });
	await plain.start();
	await plain.finish("completed");
	assert.equal(redis.sets.at(-1).value.commentId, null);
	assert.equal(redis.sets.at(-1).value.outcome, "completed");

	const r2 = fakeRedis();
	const throwing = makeProgressSink({ redis: r2, jobId: "b", now: clock(), makeCommenter: () => { throw new Error("x"); } });
	await throwing.start();
	await throwing.finish("completed");
	assert.equal(r2.sets.at(-1).value.ended, true, "a commenter that throws costs the comment, never the key");

	const r3 = fakeRedis();
	let onId;
	const posting = makeProgressSink({ redis: r3, jobId: "c", now: clock(), makeCommenter: (o) => ((onId = o.onId), { start() {}, update() {}, finish: async () => {} }) });
	await posting.start();
	onId("not valid!");
	onId("9001");
	await posting.finish("completed");
	assert.equal(r3.sets.at(-1).value.commentId, "9001", "the posted id lands in the key, a malformed one never");
});

test("the writer never throws: a client that is not ready, rejects or hangs is counted and logged once (#644)", async () => {
	const logs = [];
	const notReady = makeProgressWriter({ redis: { status: "connecting", get: async () => null, set: async () => "OK" }, jobId: "x", log: (e) => logs.push(e) });
	notReady.update({ v: 1 });
	await notReady.final({ v: 1, ended: true });
	assert.equal(notReady.stats().failed, 1);
	const rejecting = makeProgressWriter({ redis: { get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); } }, jobId: "y", log: (e) => logs.push(e) });
	assert.equal(await rejecting.init(), null);
	await rejecting.final({ v: 1 });
	const hanging = makeProgressWriter({ redis: { get: () => new Promise(() => {}), set: () => new Promise(() => {}) }, jobId: "z", timeoutMs: 20 });
	const t = Date.now();
	await hanging.final({ v: 1 });
	assert.ok(Date.now() - t < 1000, "bounded");
	assert.deepEqual(logs, ["run_progress_write_failed", "run_progress_write_failed"]);
});

test("the writer stamps updatedAt with each write's time and rewrites the snapshot every 30 s until the end (#644)", async () => {
	assert.equal(PROGRESS_HEARTBEAT_MS, 30_000);
	const now = clock();
	const redis = fakeRedis();
	const timers = fakeTimers();
	const w = makeProgressWriter({ redis, jobId: "hb", now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
	w.update({ v: 1, turn: 1, updatedAt: 1, ended: false });
	await settle();
	assert.equal(redis.sets.length, 1);
	assert.equal(redis.sets[0].value.updatedAt, T0, "the write's own time, not the snapshot's");
	for (let i = 1; i <= 3; i++) {
		const beat = timers.timers.filter((t) => !t.cleared && !t.fired).at(-1);
		assert.equal(beat?.ms, PROGRESS_HEARTBEAT_MS, "a heartbeat armed after every write");
		now.advance(PROGRESS_HEARTBEAT_MS);
		await timers.fire();
		await settle();
		assert.equal(redis.sets.length, 1 + i);
		assert.deepEqual([redis.sets.at(-1).value.turn, redis.sets.at(-1).value.updatedAt], [1, T0 + i * PROGRESS_HEARTBEAT_MS], "the same snapshot, fresh updatedAt");
	}
	await w.final({ v: 1, turn: 1, ended: true });
	assert.equal(timers.timers.filter((t) => !t.cleared && !t.fired).length, 0, "no heartbeat after the final write");
	assert.equal(redis.sets.at(-1).value.ended, true);
});

test("the heartbeat never outlives the key's 7-day window: it stops for good, and no write sets a TTL under a second (#644)", async () => {
	const WEEK = 7 * 24 * 3600 * 1000;
	const now = clock();
	const redis = fakeRedis();
	const timers = fakeTimers();
	const logs = [];
	// A finish that never comes: only the heartbeat keeps writing.
	const w = makeProgressWriter({ redis, jobId: "wk", now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: (e) => logs.push(e) });
	w.update({ v: 1, turn: 1, ended: false });
	await settle();
	assert.equal(redis.sets[0].ttl, WEEK);
	now.advance(WEEK - 1_500);
	await timers.fire();
	await settle();
	assert.equal(redis.sets.length, 2);
	assert.ok(redis.sets[1].ttl >= 1_000, "a write still made sets at least a second");
	now.advance(PROGRESS_HEARTBEAT_MS);
	await timers.fire();
	await settle();
	assert.equal(redis.sets.length, 2, "past the window nothing is written");
	assert.equal(timers.timers.filter((t) => !t.cleared && !t.fired).length, 0, "and no heartbeat is armed again");
	assert.deepEqual(logs, ["run_progress_expired"]);
	w.update({ v: 1, turn: 2, ended: false });
	await settle();
	assert.equal(redis.sets.length, 2, "an update after it writes nothing either");
	await w.final({ v: 1, turn: 2, ended: true });
	assert.equal(redis.sets.at(-1).value.ended, true, "the final write still ends the key");
	assert.ok(redis.sets.every((x) => x.ttl > 1), "never PX 1 or less");
});

/** A Valkey fake that keeps the key, so a second attempt reads what the first left. */
function keepingRedis() {
	const store = new Map();
	const sets = [];
	return {
		status: "ready",
		sets,
		get: async (k) => store.get(k) ?? null,
		set: async (k, v) => (store.set(k, v), sets.push(JSON.parse(v)), "OK"),
	};
}

test("the sink writes the empty snapshot at start, replacing the previous attempt's final one at once (#644)", async () => {
	const redis = keepingRedis();
	const first = makeProgressSink({ redis, jobId: "r", now: clock() });
	await first.start();
	first.consume(asst(), T0);
	await settle();
	await first.finish("failed");
	assert.equal(redis.sets.at(-1).ended, true);
	const second = makeProgressSink({ redis, jobId: "r", now: clock() });
	await second.start();
	await settle();
	assert.deepEqual([redis.sets.at(-1).ended, redis.sets.at(-1).turn, redis.sets.at(-1).outcome], [false, 0, null], "no transcript line was needed");
});

test("a status comment post slower than the final write still lands its id, so the retry edits it (#644)", async () => {
	const redis = keepingRedis();
	const posts = [];
	const edits = [];
	const attempt = async (postMs) => {
		const sink = makeProgressSink({
			redis,
			jobId: "slow",
			now: clock(),
			makeCommenter: ({ commentId, onId }) =>
				makeStatusCommenter({
					jobId: "slow",
					commentId,
					onId,
					post: (text) => new Promise((resolve) => setTimeout(() => (posts.push(text), resolve({ id: "c-9" })), postMs)),
					edit: async (id, text) => (edits.push([id, text]), { ok: true }),
				}),
		});
		await sink.start();
		// The run ends while the post is still in flight.
		await sink.finish("completed");
	};
	await attempt(50);
	assert.equal(posts.length, 1);
	assert.equal(redis.sets.at(-1).commentId, "c-9", "the final write carries the id the post brought");
	await attempt(0);
	assert.equal(posts.length, 1, "one post across both attempts");
	assert.ok(edits.length >= 1 && edits.every(([id]) => id === "c-9"), "the retry edits the first comment");
});
