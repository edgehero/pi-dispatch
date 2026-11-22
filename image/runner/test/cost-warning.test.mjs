import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createCostWarnings, HELD_TURNS_MAX, LIMIT_WARNING_CUSTOM_TYPE, LIMIT_WARNING_FACTORY, LIMIT_WARNING_PERCENT, LIMIT_WARNINGS, steersQueued, warningThreshold } from "../src/cost-warning.mjs";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { sessionFixture, scriptedSession } from "./helpers/recover-session.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #985: the warning before the cost cap (src/cost-warning.mjs). The threshold's arithmetic and the hook's rules
 * are pure; the delivery runs a scripted offline model over a real persisted session, like inbox.test.mjs, and skips
 * where pi cannot load (failing instead under PI_DISPATCH_REQUIRE_LOADER_TESTS=1).
 */
let deps;
let importError;
try {
	deps = {
		pi: await import("@earendil-works/pi-coding-agent"),
		piAi: await import("@earendil-works/pi-ai"),
		loaderModule: await import("../src/loader.mjs"),
		createJobModelRuntime,
	};
} catch (error) {
	importError = error;
}
if (!deps && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`cost warning tests are REQUIRED here but pi could not be imported.\n${importError}`);
const skip = deps ? false : `pi not installed (node ${process.version}); CI runs these`;

const TEXT = LIMIT_WARNINGS["cost-cap"];
const lsCall = (callId) => [{ type: "toolCall", id: callId, name: "ls", arguments: { path: "." } }];
const text = (value) => [{ type: "text", text: value }];
const userText = (message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join(""));
const warningsIn = (messages) => messages.filter((message) => message.role === "user" && userText(message) === TEXT).length;
const customEntries = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "custom_message");

test("the threshold is 70% of the limit rounded up, exact for every safe integer, and a limit is watched only with its own fixed text", () => {
	assert.equal(LIMIT_WARNING_PERCENT, 70);
	assert.deepEqual([1, 3, 10, 99, 100, 101, 1_000_000, 150_000_000].map((limit) => warningThreshold(limit)), [1, 3, 7, 70, 70, 71, 700_000, 105_000_000], "ceil(0.7 x limit): 0.7, 2.1, 7, 69.3, 70, 70.7, ...");
	// 0.7 x 2^53-1 is not a float the product can name; the split by hundreds is exact: 90071992547409 x 70 + ceil(91 x 0.7).
	assert.equal(warningThreshold(Number.MAX_SAFE_INTEGER), 90_071_992_547_409 * 70 + 64);
	for (const bad of [-1, 1.5, Number.NaN, "100"]) assert.throws(() => warningThreshold(bad), /whole number/);
	const warnings = createCostWarnings({ rootSessionId: "root" });
	assert.equal(warnings.armed(), false, "nothing watched: the factory is not loaded");
	assert.throws(() => warnings.watch({ name: "token_budget", limit: 10, settled: () => 0 }), /fixed text/, "no words, no limit");
	assert.throws(() => warnings.watch({ name: "cost-cap", limit: 0, settled: () => 0 }), /above 0/);
	assert.throws(() => warnings.watch({ name: "cost-cap", limit: 10, settled: 5 }), /function/);
	warnings.watch({ name: "cost-cap", limit: 10, settled: () => 0 });
	assert.throws(() => warnings.watch({ name: "cost-cap", limit: 20, settled: () => 0 }), /once/);
	assert.equal(warnings.armed(), true);
	assert.equal(warnings.factory.name, LIMIT_WARNING_FACTORY);
	// Fixed words: the only figure is the module's own 70, and nothing a run produced can reach the model through it.
	for (const words of Object.values(LIMIT_WARNINGS)) {
		assert.deepEqual(words.match(/\d+/g), ["70"]);
		assert.equal(/[\u0000-\u001f\u007f\u2013\u2014]/.test(words), false);
	}
});

test("on the hook's seams: a measure that cannot be read has not reached the limit, a queued steer holds it back for at most three turns, a follow-up never does, a send that throws is tried again, and an idle session gets nothing", () => {
	const handlers = [];
	const sent = [];
	let failSend = false;
	const api = { on: (event, handler) => handlers.push({ event, handler }), sendMessage: (message, options) => {
		if (failSend) throw new Error("This extension instance is stale");
		sent.push({ message, options });
	} };
	let measure = () => {
		throw new Error("no fold");
	};
	const logs = [];
	let steerQueued = false;
	const warnings = createCostWarnings({ rootSessionId: "root", queuedElsewhere: () => steerQueued, log: (event, fields) => logs.push({ event, ...fields }) });
	warnings.watch({ name: "cost-cap", limit: 1000, settled: () => measure() });
	warnings.factory.factory(api);
	assert.deepEqual(handlers.map((entry) => entry.event), ["turn_end"], "one handler, on turn_end");
	// `pending` is pi's hasPendingMessages(), which counts a queued follow-up: never a reason to wait.
	const turnEnd = ({ idle = false, pending = false } = {}) => handlers[0].handler({ type: "turn_end", toolResults: [{ role: "toolResult" }] }, { sessionManager: { getSessionId: () => "root" }, isIdle: () => idle, hasPendingMessages: () => pending });
	// With the send working, so only the measure can hold it back.
	turnEnd();
	for (const value of [Number.NaN, Infinity, "900", null]) {
		measure = () => value;
		turnEnd();
	}
	assert.deepEqual([sent.length, warnings.warned("cost-cap")], [0, false], "a reader that throws or says no number has not reached it");
	measure = () => 700;
	steerQueued = true;
	turnEnd();
	turnEnd();
	assert.equal(sent.length, 0, "a steer already queued: this one would wait behind it, and could un-park a later turn");
	steerQueued = false;
	failSend = true;
	turnEnd();
	assert.deepEqual([sent.length, warnings.warned("cost-cap")], [0, false], "the send threw: not warned");
	failSend = false;
	turnEnd({ idle: true });
	assert.equal(sent.length, 0, "an idle session would append the message unread");
	turnEnd({ pending: true });
	assert.deepEqual(sent, [{ message: { customType: LIMIT_WARNING_CUSTOM_TYPE, content: [{ type: "text", text: TEXT }], display: true, details: { limit: "cost-cap" } }, options: { deliverAs: "steer" } }], "a queued follow-up does not hold it back");
	assert.equal(warnings.warned("cost-cap"), true);
	turnEnd();
	assert.equal(sent.length, 1, "once a run");
	assert.deepEqual(logs, [{ event: "cost_warning", limit: "cost-cap", settled: 700, threshold: 700, cap: 1000 }], "numbers and the limit's name, never the text");
	// A steer queued at every turn's end holds it back HELD_TURNS_MAX turns in a row, then it goes anyway.
	const always = { handlers: [], sent: [] };
	const stubborn = createCostWarnings({ rootSessionId: "root", queuedElsewhere: () => true });
	stubborn.watch({ name: "cost-cap", limit: 1000, settled: () => 900 });
	stubborn.factory.factory({ on: (event, handler) => always.handlers.push(handler), sendMessage: (message) => always.sent.push(message) });
	const counts = [];
	for (let turn = 0; turn < HELD_TURNS_MAX + 2; turn += 1) {
		always.handlers[0]({ type: "turn_end", toolResults: [{ role: "toolResult" }] }, { sessionManager: { getSessionId: () => "root" }, isIdle: () => false });
		counts.push(always.sent.length);
	}
	assert.equal(HELD_TURNS_MAX, 3);
	assert.deepEqual(counts, [0, 0, 0, 1, 1]);
});

/** A real session on a persisted transcript with the warning hook loaded, its measure `measure(n)` after call n. */
async function warnedSession(name, { script, measure, rootSessionId = null, isParked = () => false, before = [] }) {
	const f = sessionFixture(tempDir(`pi-dispatch-cost-warning-${name}-`));
	const { openSessionManager } = await import("../src/session.mjs");
	const { sessionManager } = openSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace });
	let settled = 0;
	const logs = [];
	// As run-job.mjs wires it: pi's steering queue of the session, read late (the session exists after the factories).
	let session = null;
	const warnings = createCostWarnings({ rootSessionId: rootSessionId ?? sessionManager.getSessionId(), isParked, queuedElsewhere: () => steersQueued(session), log: (event, fields) => logs.push({ event, ...fields }) });
	warnings.watch({ name: "cost-cap", limit: 1000, settled: () => settled });
	const built = await scriptedSession(deps, f, { api: `pi-dispatch-cost-warning-${name}`, script, sessionManager, onCall: (n) => (settled = measure(n)), extensionFactories: [...before, warnings.factory] });
	session = built.session;
	return { f, warnings, logs, ...built };
}

test("on a real session the warning lands once, after the tool turn whose end found 70% settled and before the next model call, as user text", { skip }, async () => {
	// Settled after each call: 600 (under 700), then 700 (the threshold), then 900.
	const s = await warnedSession("once", { script: [lsCall("call-1"), lsCall("call-2"), lsCall("call-3"), text("done")], measure: (n) => [600, 700, 900, 900][n - 1] });
	try {
		await s.session.prompt("start");
		assert.equal(s.contexts.length, 4, "no model call of its own: it rides the call pi makes after a tool turn");
		assert.deepEqual(s.contexts.map((context) => warningsIn(context.messages)), [0, 0, 1, 1], "after turn 2, and never again");
		const third = s.contexts[2].messages;
		assert.equal(third.at(-2).role, "toolResult");
		assert.equal(third.at(-2).toolCallId, "call-2");
		assert.equal(userText(third.at(-1)), TEXT);
		const persisted = customEntries(s.f.sessionFile);
		assert.equal(persisted.length, 1);
		assert.deepEqual([persisted[0].customType, persisted[0].details], [LIMIT_WARNING_CUSTOM_TYPE, { limit: "cost-cap" }]);
		assert.equal(s.warnings.warned("cost-cap"), true);
		assert.deepEqual(s.logs.map((line) => line.settled), [700]);
	} finally {
		s.session.dispose();
	}
});

test("on a real session nothing is sent past 70% after a turn with no tool calls, in a parked run, or to a session that is not the root", { skip }, async () => {
	const over = () => 950;
	const cases = [
		{ name: "tool-free", script: [text("done")], calls: 1, why: "the agent was stopping: a steer would start another turn after its last answer" },
		{ name: "parked", script: [lsCall("call-1"), text("done")], isParked: () => true, calls: 2, why: "a queued message would un-park the run" },
		{ name: "not-root", script: [lsCall("call-1"), text("done")], rootSessionId: "another-session", calls: 2, why: "an in-process subagent's session is not the job's" },
	];
	for (const { name, script, isParked, rootSessionId, calls, why } of cases) {
		const s = await warnedSession(name, { script, measure: over, isParked, rootSessionId });
		try {
			await s.session.prompt("start");
			assert.equal(s.contexts.length, calls, `${name}: no call added`);
			assert.equal(s.contexts.reduce((sum, context) => sum + warningsIn(context.messages), 0), 0, `${name}: ${why}`);
			assert.deepEqual([customEntries(s.f.sessionFile).length, s.warnings.warned("cost-cap")], [0, false], name);
		} finally {
			s.session.dispose();
		}
	}
});

test("on a real session a queued follow-up never holds the warning back, a queued steer holds it to the next turn, and steers at every turn hold it three turns at most", { skip }, async () => {
	const over = () => 950;
	const script = [lsCall("c1"), lsCall("c2"), lsCall("c3"), lsCall("c4"), lsCall("c5"), lsCall("c6"), text("done"), text("bye")];
	// Another extension's handlers, loaded before the warning's (as a file extension's run first): a follow-up queued at the
	// first turn's end; a steer queued at the first; a steer queued at every one.
	const followUp = (pi) => {
		let once = false;
		pi.on("turn_end", () => {
			if (once) return;
			once = true;
			pi.sendUserMessage("when you are done, say bye", { deliverAs: "followUp" });
		});
	};
	// Only after a turn that ran tools: a steer after the agent's last answer would start another turn, for ever.
	const steer = (every) => (pi) => {
		let turns = 0;
		pi.on("turn_end", (event) => {
			turns += 1;
			if ((event?.toolResults?.length ?? 0) > 0 && (every || turns === 1)) pi.sendMessage({ customType: "another-extension", content: [{ type: "text", text: `steer ${turns}` }], display: true }, { deliverAs: "steer" });
		});
	};
	// Which model call first carries the warning: call n+1 follows turn n's end.
	const cases = [
		{ name: "follow-up", before: [followUp], firstCall: 2, why: "pi delivers a follow-up only when the agent would stop: it never delays a steer" },
		{ name: "steer-once", before: [steer(false)], firstCall: 3, why: "behind that turn's steer it would be read a turn late, so it waits one turn" },
		{ name: "steer-always", before: [steer(true)], firstCall: 6, why: "held three turns, sent at the fourth turn's end, read behind that turn's steer" },
	];
	for (const { name, before, firstCall, why } of cases) {
		const s = await warnedSession(name, { script, measure: over, before });
		try {
			await s.session.prompt("start");
			assert.equal(s.warnings.warned("cost-cap"), true, `${name}: warned`);
			const first = s.contexts.findIndex((context) => warningsIn(context.messages) > 0) + 1;
			assert.equal(first, firstCall, `${name}: ${why}`);
			assert.equal(customEntries(s.f.sessionFile).filter((entry) => entry.customType === LIMIT_WARNING_CUSTOM_TYPE).length, 1, `${name}: once`);
		} finally {
			s.session.dispose();
		}
	}
});
