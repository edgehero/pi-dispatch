import assert from "node:assert/strict";
import { test } from "node:test";
import {
	classifyStopReason,
	classifyThrow,
	configError,
	decideExit,
	EXIT_COMPLETED,
	EXIT_INFRA,
	EXIT_POLICY,
	STOP_REASONS,
} from "../src/outcome.mjs";

// INT-RUNNER-EXIT-CODE-PROTOCOL. These two blocks are deliberately a PAIR: each catches
// the failure the other's implementation causes. A try/catch-only runner exits 0 on every
// provider failure; a stopReason-only runner crashes on a missing API key and exits 1,
// which the protocol defines as retryable -- so the queue pays to retry a job that can
// never succeed. Both were live in the spec at different times. Both were wrong.

test("provider error exits 1, NOT 0 -- the try/catch-only trap", () => {
	const outcome = classifyStopReason({ stopReason: "error", errorMessage: "429 rate limited" });
	assert.equal(outcome.code, EXIT_INFRA);
	assert.notEqual(outcome.code, EXIT_COMPLETED, "a 429 recorded as success is a job that did nothing");
});

test("missing API key exits 2, NOT 1 -- the stopReason-only trap", () => {
	// pi's own JSDoc: "@throws Error if no model selected or no API key available".
	const outcome = classifyThrow(new Error("No API key found for provider anthropic"));
	assert.equal(outcome.code, EXIT_POLICY);
	assert.notEqual(outcome.code, EXIT_INFRA, "retrying a missing key pays to rediscover it");
});

test("no model selected is config, not infra", () => {
	assert.equal(classifyThrow(new Error("No model selected")).code, EXIT_POLICY);
});

test("'Agent is already processing' is our bug -- infra, retryable", () => {
	// Thrown by Agent.runWithLifecycle BEFORE its own try block, so it escapes to us.
	assert.equal(classifyThrow(new Error("Agent is already processing.")).code, EXIT_INFRA);
});

test("turn-budget abort exits 2, NOT 0", () => {
	assert.equal(classifyStopReason({ stopReason: "aborted" }).code, EXIT_POLICY);
});

test("'can't fix' is a SUCCESS -- exit 0, never retried", () => {
	// CONST-RETRY-INFRA-ONLY. The agent's verdict is the product, not the failure.
	assert.equal(classifyStopReason({ stopReason: "stop" }).code, EXIT_COMPLETED);
});

test("'length' exits 0 but is flagged truncated -- not hidden by a default branch", () => {
	const outcome = classifyStopReason({ stopReason: "length" });
	assert.equal(outcome.code, EXIT_COMPLETED);
	assert.equal(outcome.truncated, true, "a truncated run must be visible, not silently 'success'");
});

test("every one of pi's five stopReasons is handled explicitly", () => {
	// packages/ai/src/types.ts:380. If pi's union grows, this fails rather than guessing.
	assert.deepEqual(STOP_REASONS, ["stop", "length", "toolUse", "error", "aborted"]);
	for (const stopReason of STOP_REASONS) {
		const outcome = classifyStopReason({ stopReason });
		assert.ok(!String(outcome.reason).startsWith("unknown-"), `${stopReason} fell through`);
	}
});

test("an unknown stopReason is infra, not assumed benign", () => {
	// CONST-PI-VERSION-PINNED: upstream moves silently. Do not guess a new value is fine.
	const outcome = classifyStopReason({ stopReason: "somethingNew" });
	assert.equal(outcome.code, EXIT_INFRA);
});

test("no terminal message is infra -- absence of evidence is not success", () => {
	assert.equal(classifyStopReason(undefined).code, EXIT_INFRA);
});

// decideExit: a cap-abort surfaces as stopReason "aborted"; intercepting it names WHICH cap fired
// and keeps it a policy outcome (exit 2, not retried) rather than the generic "aborted".
test("token-budget abort exits 2 with reason token_budget", () => {
	const outcome = decideExit({ budgetAborted: false, tokenAborted: true, terminal: { stopReason: "aborted" } });
	assert.equal(outcome.code, EXIT_POLICY);
	assert.equal(outcome.reason, "token_budget");
});

test("turn-budget abort wins over token-budget for a stable reason", () => {
	const outcome = decideExit({ budgetAborted: true, budgetTurns: 31, tokenAborted: true, terminal: {} });
	assert.equal(outcome.reason, "turn_budget");
	assert.equal(outcome.turns, 31);
});

test("no abort defers to the stopReason classification", () => {
	const outcome = decideExit({ budgetAborted: false, tokenAborted: false, terminal: { stopReason: "stop" } });
	assert.equal(outcome.code, EXIT_COMPLETED);
	assert.equal(outcome.reason, "stop");
});

// --- decideExit for command jobs (issue #189, run.command) ---

test("a headless command run exits 0 as command-completed -- not retried as no-terminal-message", () => {
	// session.prompt("/name args") dispatches the handler and resolves with NO assistant message.
	// Before run.command, that shape was the retryable no-terminal branch: a SUCCESSFUL command job
	// would be re-run and re-billed by the queue until attempts ran out.
	const outcome = decideExit({ budgetAborted: false, tokenAborted: false, terminal: undefined, command: { failed: false } });
	assert.deepEqual(outcome, { code: EXIT_COMPLETED, reason: "command-completed" });
});

test("a throwing handler exits 1 as command-error, and wins over a success-claiming terminal", () => {
	// pi swallows the throw (emitError, handled=true), so the ONLY evidence is the extension error
	// channel -- and a handler that drove the model before throwing may have left a stopReason that
	// claims success. The throw must win, or the swallow reaches the exit code.
	// Exit 1 retryable is the DELIBERATE choice (DES-COMMAND-ENTRY-POINT): pi hands us a message
	// string, transient-vs-deterministic is undecidable, and the accepted cost is that a
	// deterministic extension bug retries until the queue's attempts run out.
	const failed = decideExit({ budgetAborted: false, tokenAborted: false, terminal: undefined, command: { failed: true } });
	assert.deepEqual(failed, { code: EXIT_INFRA, reason: "command-error" });
	const failedWithTerminal = decideExit({ budgetAborted: false, tokenAborted: false, terminal: { stopReason: "stop" }, command: { failed: true } });
	assert.deepEqual(failedWithTerminal, { code: EXIT_INFRA, reason: "command-error" });
});

test("a handler that drove the model gets the terminal's real verdict -- a 429 inside stays retryable", () => {
	const outcome = decideExit({
		budgetAborted: false,
		tokenAborted: false,
		terminal: { stopReason: "error", errorMessage: "429" },
		command: { failed: false },
	});
	assert.equal(outcome.code, EXIT_INFRA);
	assert.equal(outcome.reason, "error");
	const clean = decideExit({ budgetAborted: false, tokenAborted: false, terminal: { stopReason: "stop" }, command: { failed: false } });
	assert.deepEqual(clean, { code: EXIT_COMPLETED, reason: "stop" });
});

test("budget aborts still win over the command outcome -- a handler-driven fanout is bounded", () => {
	const turns = decideExit({ budgetAborted: true, budgetTurns: 31, tokenAborted: false, terminal: undefined, command: { failed: false } });
	assert.equal(turns.reason, "turn_budget");
	const tokens = decideExit({ budgetAborted: false, tokenAborted: true, terminal: undefined, command: { failed: true } });
	assert.equal(tokens.reason, "token_budget");
});

test("a prompt job's decision tree is byte-identical with command absent, null, or omitted", () => {
	for (const command of [undefined, null]) {
		assert.deepEqual(
			decideExit({ budgetAborted: false, tokenAborted: false, terminal: undefined, command }),
			{ code: EXIT_INFRA, reason: "no-terminal-message" },
		);
	}
});

test("configError's optional reason rides classifyThrow onto the exit line; the default stays config", () => {
	const tagged = classifyThrow(configError("no such command", "command-unregistered"));
	assert.equal(tagged.code, EXIT_POLICY, "an unregistered command is deterministic: never retried");
	assert.equal(tagged.reason, "command-unregistered");
	const plain = classifyThrow(configError("missing env"));
	assert.deepEqual({ code: plain.code, reason: plain.reason }, { code: EXIT_POLICY, reason: "config" });
});
