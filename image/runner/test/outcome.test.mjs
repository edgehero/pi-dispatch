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
	providerAuthRefused,
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

// --- issue #437: a provider's refusal of the credential is policy, not infra ---

// The shapes the pinned pi-ai actually produces (the loopback table in pinned-api.test.mjs proves
// each one), with 401 AND 403 for every form, so dropping either status from any entry fails here.
const AUTH_REFUSED = [
	'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
	'403 {"type":"error","error":{"type":"permission_error","message":"denied"}}',
	'401: {"message":"Incorrect API key provided","code":"invalid_api_key"}',
	'403: {"message":"Incorrect API key provided","code":"invalid_api_key"}',
	'OpenAI API error (401): {"message":"Incorrect API key provided"}',
	'OpenAI API error (403): {"message":"Incorrect API key provided"}',
	'Azure OpenAI API error (401): {"message":"Incorrect API key provided"}',
	'Azure OpenAI API error (403): {"message":"Incorrect API key provided"}',
	'Mistral API error (401): {"error":{"message":"Incorrect API key provided"}}',
	'Mistral API error (403): {"error":{"message":"Incorrect API key provided"}}',
];

// Each of these would be a FALSE refusal under a looser rule, and a false refusal drops real work: a
// transient failure recorded as not-retried. The unanchored, prefix-free and status-in-the-body cases are
// the ones a bare /401|403/ would get wrong.
const NOT_AUTH_REFUSED = [
	"4010 x",
	"4031: x",
	" 401 x",
	"429 rate limited",
	"500 upstream said 401",
	"Connection error.",
	"",
	undefined,
	"Proxy response (403) !== 200 when HTTP Tunneling",
	"OpenAI API error (429): slow down",
	"Some API error (401): not a proved prefix",
	'{"error":{"code":401,"message":"API key not valid.","status":"UNAUTHENTICATED"}}',
];

test("a provider's 401/403 refusal of the credential exits 2 as provider-auth-refused, never retried", () => {
	for (const errorMessage of AUTH_REFUSED) {
		assert.equal(providerAuthRefused(errorMessage), true, errorMessage);
		const outcome = classifyStopReason({ stopReason: "error", errorMessage });
		assert.deepEqual(outcome, { code: EXIT_POLICY, reason: "provider-auth-refused", message: errorMessage }, errorMessage);
	}
});

test("anything that is not a proved refusal shape stays retryable infra", () => {
	for (const errorMessage of NOT_AUTH_REFUSED) {
		assert.equal(providerAuthRefused(errorMessage), false, String(errorMessage));
		const outcome = classifyStopReason({ stopReason: "error", errorMessage });
		assert.deepEqual(outcome, { code: EXIT_INFRA, reason: "error", message: errorMessage }, String(errorMessage));
	}
	// A non-string never throws: the terminal message is pi's, not ours.
	for (const value of [null, 401, {}, ["401 x"]]) assert.equal(providerAuthRefused(value), false);
});

test("only an error stopReason can be a refusal, and budget aborts still win over it", () => {
	const refusal = { stopReason: "error", errorMessage: "401 invalid x-api-key" };
	assert.equal(classifyStopReason({ stopReason: "stop", errorMessage: "401 x" }).code, EXIT_COMPLETED);
	assert.equal(decideExit({ budgetAborted: true, budgetTurns: 3, tokenAborted: false, terminal: refusal }).reason, "turn_budget");
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: true, terminal: refusal }).reason, "token_budget");
	// A handler-driven command turn gets the terminal's real verdict, refusal included; a thrown handler still wins.
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: false, terminal: refusal, command: { failed: false } }).reason, "provider-auth-refused");
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: false, terminal: refusal, command: { failed: true } }).reason, "command-error");
	// classifyThrow is unchanged: a thrown 401 string is not the stopReason channel.
	assert.equal(classifyThrow(new Error("401 invalid x-api-key")).code, EXIT_INFRA);
});
