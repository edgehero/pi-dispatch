import assert from "node:assert/strict";
import { test } from "node:test";
import { attachTokenBudget } from "../src/token-budget.mjs";

/**
 * A stand-in for AgentSession reproducing the two properties the budget depends on: `_emit` is a
 * synchronous unawaited loop, and abort() flips its signal synchronously before any await. Mirrors
 * turn-budget.test.mjs's fake so the two budgets are verified against the same session contract.
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

/** A turn_end event carrying an assistant message with the given usage, as pi emits (0.80.7 and 0.99.1). */
function turnEnd(usage) {
	return { type: "turn_end", message: { role: "assistant", usage } };
}

const usage = ({ input = 0, output = 0, total = input + output, cost = 0 }) => ({
	input,
	output,
	totalTokens: total,
	cost: { total: cost },
});

test("accumulates usage across turns (meter is always on, no cap)", () => {
	const session = fakeSession();
	const budget = attachTokenBudget(session, null);

	session.emit(turnEnd(usage({ input: 100, output: 20, cost: 0.01 })));
	session.emit(turnEnd(usage({ input: 200, output: 30, cost: 0.02 })));

	assert.equal(budget.state.input, 300);
	assert.equal(budget.state.output, 50);
	assert.equal(budget.state.total, 350);
	assert.equal(Math.round(budget.state.cost * 100) / 100, 0.03);
	assert.equal(budget.state.aborted, false, "no cap means never abort");
	assert.equal(session.aborted, false);
});

test("aborts once the cumulative total exceeds the cap", () => {
	const session = fakeSession();
	const budget = attachTokenBudget(session, 1000);

	session.emit(turnEnd(usage({ input: 400, output: 100 }))); // 500 total
	assert.equal(session.aborted, false, "must not abort at or below the cap");

	session.emit(turnEnd(usage({ input: 400, output: 200 }))); // 500 + 600 = 1100 cumulative -> over
	assert.equal(session.aborted, true);
	assert.equal(budget.state.aborted, true);
	assert.equal(budget.state.total, 1100);
});

test("abort fires exactly once even if more usage arrives", () => {
	const session = fakeSession();
	attachTokenBudget(session, 100);
	for (let i = 0; i < 5; i++) session.emit(turnEnd(usage({ input: 100, output: 100 })));
	assert.equal(session.abortCalls, 1);
});

test("the signal is set synchronously inside the listener", () => {
	const session = fakeSession();
	attachTokenBudget(session, 10);
	session.emit(turnEnd(usage({ input: 20, output: 0 })));
	assert.equal(session.aborted, true, "abort must land before emit() returns");
});

test("accumulates on turn_end only -- agent_end must not double-count", () => {
	const session = fakeSession();
	const budget = attachTokenBudget(session, null);
	const message = { role: "assistant", usage: usage({ input: 100, output: 50 }) };
	session.emit({ type: "turn_end", message });
	// agent_end carries the same messages[] as a terminal snapshot; accumulating it would double.
	session.emit({ type: "agent_end", messages: [message] });
	session.emit({ type: "message_update", message });
	assert.equal(budget.state.total, 150);
});

test("ignores turn_end without assistant usage", () => {
	const session = fakeSession();
	const budget = attachTokenBudget(session, null);
	session.emit({ type: "turn_end", message: { role: "tool", usage: usage({ input: 999 }) } });
	session.emit({ type: "turn_end", message: { role: "assistant" } }); // no usage
	session.emit({ type: "turn_end" }); // no message
	assert.equal(budget.state.total, 0);
	assert.equal(budget.state.input, 0);
});

test("a null or absent cap is a pure meter, not an error", () => {
	assert.doesNotThrow(() => attachTokenBudget(fakeSession(), null));
	assert.doesNotThrow(() => attachTokenBudget(fakeSession(), undefined));
});

test("rejects a nonsensical cap rather than running unbounded", () => {
	for (const bad of [0, -1, 1.5, Number.NaN]) {
		assert.throws(() => attachTokenBudget(fakeSession(), bad), /invalid PI_MAX_TOKENS/);
	}
});

test("once breached, every later turn_start aborts again; onAbort still fires once", () => {
	// Issue #455 gate round 1, A11. The breach aborts on a turn_end; when that turn failed with a retryable
	// error pi retries it with a FRESH AbortController, and a queued follow-up starts a new run the same way,
	// so the one abort never reaches the next run. Each such run opens with turn_start before its model call.
	const session = fakeSession();
	const logged = [];
	attachTokenBudget(session, 100, { onAbort: (total) => logged.push(total) });
	session.emit({ type: "turn_start" });
	assert.equal(session.abortCalls, 0, "no abort before a breach");
	session.emit({ type: "turn_end", message: { role: "assistant", stopReason: "error", usage: usage({ input: 5000, output: 1 }) } });
	assert.equal(session.abortCalls, 1);
	session.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: "Overloaded" });
	session.emit({ type: "agent_start" });
	session.emit({ type: "turn_start" });
	assert.equal(session.abortCalls, 2, "the retry's turn_start aborts again");
	session.emit({ type: "turn_start" });
	assert.equal(session.abortCalls, 3);
	assert.deepEqual(logged, [5001], "the operator's line is written once");
});
