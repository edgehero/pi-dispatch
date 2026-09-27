import assert from "node:assert/strict";
import { test } from "node:test";
import { attachTurnBudget } from "../src/turn-budget.mjs";
import { agentEnd, assistantError, assistantText, assistantToolUse, continuationTurn, nextTurn, promptTurn, retryTurn, toolsThenError, user } from "./helpers/pi-retry-events.mjs";

/**
 * A stand-in for AgentSession that reproduces the two properties the budget depends on:
 * `_emit` is a synchronous unawaited loop, and abort() flips its signal synchronously
 * before any await. Both verified at agent-session.ts:527-531 and agent.ts:310-312.
 */
function fakeSession() {
	const listeners = [];
	const session = {
		aborted: false,
		abortCalls: 0,
		subscribe(listener) {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		async abort() {
			session.abortCalls += 1;
			session.aborted = true; // sync, before any await -- as pi does
			await Promise.resolve();
		},
		emit(event) {
			for (const l of listeners) l(event); // sync, unawaited -- as pi does
		},
	};
	return session;
}

test("aborts once the turn count exceeds the maximum", () => {
	const session = fakeSession();
	const budget = attachTurnBudget(session, 3);

	for (let i = 0; i < 3; i++) session.emit({ type: "turn_start" });
	assert.equal(session.aborted, false, "must not abort at or below the budget");

	session.emit({ type: "turn_start" }); // the 4th
	assert.equal(session.aborted, true);
	assert.equal(budget.state.aborted, true);
	assert.equal(budget.state.turns, 4);
});

test("every turn past the cap aborts again, while onAbort (the log line) fires once", () => {
	// One abort ends the CURRENT run only. A queued follow-up makes pi start a new run with a fresh
	// AbortController, so a budget that aborted once let that run go unbounded (the real-session pin in
	// pinned-api.test.mjs drives it). Re-aborting each over-cap turn_start is what keeps it bounded.
	const session = fakeSession();
	const logged = [];
	attachTurnBudget(session, 1, { onAbort: (turns) => logged.push(turns) });
	for (let i = 0; i < 5; i++) session.emit({ type: "turn_start" });
	assert.equal(session.abortCalls, 4, "turns 2 through 5 are each past the cap");
	assert.deepEqual(logged, [2], "the operator's line is written once, at the first breach");
});

test("the signal is set synchronously inside the listener", () => {
	// The listener is void-typed and unawaited; if abort only took effect on a later tick,
	// pi could start another paid turn before it landed. This asserts it does not.
	const session = fakeSession();
	attachTurnBudget(session, 0 + 1);
	session.emit({ type: "turn_start" });
	session.emit({ type: "turn_start" });
	assert.equal(session.aborted, true, "abort must land before emit() returns");
});

test("counts turn_start only -- turn_end must not double-count", () => {
	const session = fakeSession();
	const budget = attachTurnBudget(session, 10);
	session.emit({ type: "turn_start" });
	session.emit({ type: "turn_end", message: {} });
	session.emit({ type: "message_update", message: {} });
	assert.equal(budget.state.turns, 1);
});

test("does not rely on turnIndex -- subscribe() delivers a bare turn_start", () => {
	// packages/agent/src/types.ts:420 is `| { type: "turn_start" }` with no fields. The
	// indexed TurnStartEvent exists only on the extension bus. Reading event.turnIndex here
	// would be undefined and the budget would never fire.
	const session = fakeSession();
	const budget = attachTurnBudget(session, 2);
	for (let i = 0; i < 3; i++) session.emit({ type: "turn_start" }); // no turnIndex present
	assert.equal(budget.state.aborted, true, "budget must work off its own counter");
});

test("rejects a nonsensical budget rather than running unbounded", () => {
	for (const bad of [0, -1, 1.5, Number.NaN, undefined]) {
		assert.throws(() => attachTurnBudget(fakeSession(), bad), /invalid PI_MAX_TURNS/);
	}
});

// Issue #449. pi's own auto-retry of a provider error re-emits turn_start (agent.continue()), and counting
// it turned a one-turn job's 429 into a turn_budget policy stop. Each case below drives pi's REAL event
// order at the pin (helpers/pi-retry-events.mjs names the dist lines), not a bare turn_start count.

test("a retry's turn_start is not a budget turn; the next real turn is", () => {
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	const budget = attachTurnBudget(session, 1);
	promptTurn(emit, assistantError());
	agentEnd(emit, [assistantError()], true);
	retryTurn(emit, 1, assistantToolUse());
	assert.equal(budget.state.turns, 1, "the failed first turn was counted when it started; its retry re-does it");
	assert.equal(budget.state.retryTurns, 1);
	assert.equal(session.aborted, false, "a one-turn job survives a 429 its retry recovered from");
	// The recovered turn called a tool, so the loop starts a second REAL turn: that one counts and trips a budget of 1.
	nextTurn(emit, assistantText());
	assert.equal(budget.state.turns, 2);
	assert.equal(budget.state.retryTurns, 1);
	assert.equal(session.aborted, true);
});

test("two retries in one error streak are both uncounted", () => {
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	const budget = attachTurnBudget(session, 1);
	promptTurn(emit, assistantError());
	agentEnd(emit, [assistantError()], true);
	// pi emits no auto_retry_end between attempts of one streak: _retryAttempt stays above 0 until a success.
	retryTurn(emit, 1, assistantError());
	agentEnd(emit, [assistantError()], true);
	retryTurn(emit, 2, assistantText());
	agentEnd(emit, [assistantText()], false);
	assert.equal(budget.state.turns, 1);
	assert.equal(budget.state.retryTurns, 2);
	assert.equal(session.aborted, false);
});

test("a retry cancelled mid-sleep clears the flag: the continuation after it is counted", () => {
	// agent-session.js:2090-2101: abort() during the backoff sleep emits auto_retry_end{success:false} and
	// does NOT continue, so no retry turn follows. A threshold compaction or a queued message can still
	// continue the agent (:760-765); that turn is new work and must be counted, not ride the stale flag.
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	const budget = attachTurnBudget(session, 1);
	promptTurn(emit, assistantError());
	agentEnd(emit, [assistantError()], true);
	emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "429 rate limited" });
	emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
	continuationTurn(emit, assistantText());
	assert.equal(budget.state.turns, 2);
	assert.equal(budget.state.retryTurns, 0);
	assert.equal(session.aborted, true);
});

test("the flag does not leak: an exhausted streak and a recovered one both leave later turns counted", () => {
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	const budget = attachTurnBudget(session, 10);
	// Exhausted at PI_RETRY_MAX=1: the last failure emits no auto_retry_start (:2068-2071), only the final end.
	promptTurn(emit, assistantError());
	agentEnd(emit, [assistantError()], true);
	retryTurn(emit, 1, assistantError(), { maxAttempts: 1 });
	agentEnd(emit, [assistantError()], false);
	emit({ type: "auto_retry_end", success: false, attempt: 1, finalError: "429 rate limited" });
	// A queued message continues the agent: counted.
	continuationTurn(emit, assistantToolUse());
	// A recovered streak inside it, then two real turns after: counted.
	nextTurn(emit, assistantError());
	agentEnd(emit, [assistantError()], true);
	retryTurn(emit, 1, assistantToolUse());
	nextTurn(emit, assistantToolUse());
	nextTurn(emit, assistantText());
	assert.equal(budget.state.retryTurns, 2);
	assert.equal(budget.state.turns, 5, "prompt, continuation, the failed turn, and the two turns after the recovery");
});

test("a retry turn is consumed once, even if pi stopped emitting auto_retry_end on success", () => {
	// Not the order at the pin (a successful retry's message_end emits auto_retry_end before the next
	// turn_start): this pins that the exemption belongs to the ONE turn_start after auto_retry_start, so a
	// pin bump that drops that end event cannot exempt every later turn of the run.
	const session = fakeSession();
	const budget = attachTurnBudget(session, 1);
	session.emit({ type: "turn_start" });
	session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "429" });
	session.emit({ type: "turn_start" });
	session.emit({ type: "turn_start" });
	assert.equal(budget.state.retryTurns, 1);
	assert.equal(budget.state.turns, 2);
	assert.equal(session.aborted, true);
});

test("an abort that lands before the backoff does not stop pi's retry: its turn is still a retry turn, and nothing leaks", () => {
	// Measured at the pin (round #446 M0-f case e): session.abort() issued while the errored call was ending
	// is not sticky across pi's retry. pi still emits agent_end{willRetry:true} and auto_retry_start, sleeps,
	// and starts the retry's agent_start/turn_start; only the meter's own brake then ends that call as
	// "aborted", and pi emits auto_retry_end{success:true} for the ABORTED message (its check is
	// stopReason !== "error"). The flag is consumed by the turn_start, so neither quirk moves the count.
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	const budget = attachTurnBudget(session, 1);
	const aborted = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "pi-dispatch: token cap exceeded" };
	promptTurn(emit, assistantError("overloaded_error: Overloaded"));
	agentEnd(emit, [assistantError("overloaded_error: Overloaded")], true);
	retryTurn(emit, 1, aborted);
	agentEnd(emit, [aborted], false);
	assert.deepEqual({ turns: budget.state.turns, retryTurns: budget.state.retryTurns, aborted: budget.state.aborted }, { turns: 1, retryTurns: 1, aborted: false });
	// A later turn (a queued message's continuation) is counted: the success:true end left no flag behind.
	continuationTurn(emit, assistantText());
	assert.equal(budget.state.turns, 2);
	assert.equal(budget.state.retryTurns, 1);
});

test("a retry after the turn's tools RAN is a new turn and is counted: no laundering through a retry-shaped throw", () => {
	// Gate round 1 of #455, A8: a listener throwing "fetch failed" on each tool result made pi retry turns
	// that had already run their tools, and each retry called the model with fresh tool results. With the
	// exemption unguarded that was 9 paid calls at --max-turns 1. Driven in the measured order.
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	const budget = attachTurnBudget(session, 1);
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	emit({ type: "message_start", message: user });
	emit({ type: "message_end", message: user });
	const failed = toolsThenError(emit);
	agentEnd(emit, [failed], true);
	emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "fetch failed" });
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	assert.deepEqual({ turns: budget.state.turns, retryTurns: budget.state.retryTurns }, { turns: 2, retryTurns: 0 });
	assert.equal(session.aborted, true, "the second real turn trips a budget of 1");
});

test("the tool guard is per turn: a later tool-free turn's retry is exempt again", () => {
	// tool_execution_start in turn 1 must not disarm the exemption for a 429 on turn 2, which ran no tool.
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	const budget = attachTurnBudget(session, 2);
	promptTurn(emit, assistantToolUse());
	emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
	emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: false });
	nextTurn(emit, assistantError());
	agentEnd(emit, [assistantError()], true);
	retryTurn(emit, 1, assistantText());
	assert.deepEqual({ turns: budget.state.turns, retryTurns: budget.state.retryTurns, aborted: budget.state.aborted }, { turns: 2, retryTurns: 1, aborted: false });
});

test("an exempt retry turn past the cap is still aborted: the budget is spent", () => {
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	attachTurnBudget(session, 1);
	promptTurn(emit, assistantText());
	nextTurn(emit, assistantError()); // turn 2: over the cap, aborted
	const callsAfterBreach = session.abortCalls;
	agentEnd(emit, [assistantError()], true);
	retryTurn(emit, 1, assistantText());
	assert.equal(session.abortCalls, callsAfterBreach + 1, "the retry's turn_start aborts again");
});

test("agent_settled clears an armed flag that no retry turn used, so the next prompt's first turn counts", () => {
	// Measured at the pin: a retry-shaped throw after a CLEAN reply (a listener throwing on its turn_end)
	// gets auto_retry_start, then agent.continue() throws "Cannot continue from message role: assistant":
	// no turn_start, no auto_retry_end, only agent_settled. A later prompt on the same session must not
	// inherit the exemption.
	const session = fakeSession();
	const emit = (e) => session.emit(e);
	const budget = attachTurnBudget(session, 1);
	promptTurn(emit, assistantText());
	agentEnd(emit, [assistantError("fetch failed")], true);
	emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "fetch failed" });
	emit({ type: "agent_settled" });
	promptTurn(emit, assistantText());
	assert.deepEqual({ turns: budget.state.turns, retryTurns: budget.state.retryTurns, aborted: budget.state.aborted }, { turns: 2, retryTurns: 0, aborted: true });
});
