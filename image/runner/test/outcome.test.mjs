import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
	capExitMessage,
	classifyStopReason,
	classifyThrow,
	configError,
	decideExit,
	EXIT_COMPLETED,
	EXIT_INFRA,
	EXIT_MESSAGE_MAX_CHARS,
	EXIT_POLICY,
	loadRetryPredicate,
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

// pi-ai's retry predicate is injected; here it is faked so the SHAPE list is tested on its own. The real
// predicate runs against real provider output in pinned-api.test.mjs's loopback table.
const NOT_TRANSIENT = () => false;
const TRANSIENT = () => true;
const err = (errorMessage) => ({ stopReason: "error", errorMessage });

// The shapes the pinned pi-ai actually produces (the loopback table in pinned-api.test.mjs proves
// each one), with 401 AND 403 for every form, so dropping either status from any entry fails here.
const AUTH_REFUSED = [
	'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
	'403 {"type":"error","error":{"type":"permission_error","message":"denied"}}',
	'401: {"message":"Incorrect API key provided","code":"invalid_api_key"}',
	'403: {"message":"Incorrect API key provided","code":"invalid_api_key"}',
	"401 Unauthorized: bad token (unauthorized)",
	"403 Forbidden: bad token (unauthorized)",
	'OpenAI API error (401): {"message":"Incorrect API key provided"}',
	'OpenAI API error (403): {"message":"Incorrect API key provided"}',
	'Azure OpenAI API error (401): {"message":"Incorrect API key provided"}',
	'Azure OpenAI API error (403): {"message":"Incorrect API key provided"}',
	'Mistral API error (401): {"error":{"message":"Incorrect API key provided"}}',
	'Mistral API error (403): {"error":{"message":"Incorrect API key provided"}}',
];

// Each of these would be a FALSE refusal under a looser rule, and a false refusal drops real work: a
// transient failure recorded as not-retried. The unanchored, prefix-free and status-in-the-body cases are
// the ones a bare /401|403/ would get wrong. The three prefixed literals each appear AFTER position 0
// once, so dropping the `^` from any one of them fails here.
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
	'502: {"detail":"OpenAI API error (401): upstream"}',
	'400: {"detail":"Azure OpenAI API error (403): upstream"}',
	'400: {"detail":"Mistral API error (401): upstream"}',
	"AccessDeniedException: 403: denied",
	"Your authentication token is invalid.",
];

test("a provider's 401/403 refusal of the credential exits 2 as provider-auth-refused, never retried", () => {
	for (const errorMessage of AUTH_REFUSED) {
		assert.equal(providerAuthRefused(err(errorMessage), NOT_TRANSIENT), true, errorMessage);
		const outcome = classifyStopReason(err(errorMessage), NOT_TRANSIENT);
		assert.deepEqual(outcome, { code: EXIT_POLICY, reason: "provider-auth-refused", message: errorMessage }, errorMessage);
	}
});

test("anything that is not a proved refusal shape stays retryable infra", () => {
	for (const errorMessage of NOT_AUTH_REFUSED) {
		assert.equal(providerAuthRefused(err(errorMessage), NOT_TRANSIENT), false, String(errorMessage));
		const outcome = classifyStopReason(err(errorMessage), NOT_TRANSIENT);
		assert.deepEqual(outcome, { code: EXIT_INFRA, reason: "error", message: errorMessage }, String(errorMessage));
	}
	// A non-message never throws: the terminal message is pi's, not ours.
	for (const value of [null, undefined, 401, {}, { errorMessage: 401 }, { errorMessage: ["401 x"] }]) {
		assert.equal(providerAuthRefused(value, NOT_TRANSIENT), false);
	}
});

test("a refusal shape pi-ai calls retryable is NOT a refusal -- a gateway's transient 403 keeps retrying", () => {
	const shaped = err('403: {"message":"Provider returned error","code":403,"metadata":{"raw":"upstream connect error"}}');
	assert.deepEqual(classifyStopReason(shaped, TRANSIENT), { code: EXIT_INFRA, reason: "error", message: shaped.errorMessage });
	// The predicate receives the terminal message itself, which is the argument pi's own session passes it.
	const seen = [];
	providerAuthRefused(shaped, (message) => (seen.push(message), false));
	assert.deepEqual(seen, [shaped]);
	// No predicate, a non-boolean answer, or one that throws: the runner cannot tell transient from
	// determinate, so it retries -- the false determinate is the costlier error.
	for (const isRetryable of [null, undefined, "yes", () => undefined, () => 0, () => { throw new Error("boom"); }]) {
		assert.equal(providerAuthRefused(err("401 invalid x-api-key"), isRetryable), false, String(isRetryable));
		assert.equal(classifyStopReason(err("401 invalid x-api-key"), isRetryable).code, EXIT_INFRA);
	}
	// The predicate is consulted only for a shape match: a 429 is never asked about, whatever it would say.
	let asked = 0;
	providerAuthRefused(err("429 rate limited"), () => (asked++, false));
	assert.equal(asked, 0);
});

test("only an error stopReason can be a refusal, and budget aborts still win over it", () => {
	const refusal = err("401 invalid x-api-key");
	const isRetryable = NOT_TRANSIENT;
	assert.equal(classifyStopReason({ stopReason: "stop", errorMessage: "401 x" }, isRetryable).code, EXIT_COMPLETED);
	assert.equal(decideExit({ budgetAborted: true, budgetTurns: 3, tokenAborted: false, terminal: refusal, isRetryable }).reason, "turn_budget");
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: true, terminal: refusal, isRetryable }).reason, "token_budget");
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: false, terminal: refusal, isRetryable }).reason, "provider-auth-refused");
	// decideExit without the predicate keeps every provider error retryable, as it was before #437.
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: false, terminal: refusal }).reason, "error");
	// A handler-driven command turn gets the terminal's real verdict, refusal included; a thrown handler still wins.
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: false, terminal: refusal, command: { failed: false }, isRetryable }).reason, "provider-auth-refused");
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: false, terminal: refusal, command: { failed: true }, isRetryable }).reason, "command-error");
	// classifyThrow is unchanged: a thrown 401 string is not the stopReason channel.
	assert.equal(classifyThrow(new Error("401 invalid x-api-key")).code, EXIT_INFRA);
});

test("loadRetryPredicate prefers the meter's accepted module, then the candidates in order, and never throws", async () => {
	const fromMeter = () => false;
	const fromCandidate = () => true;
	assert.equal(await loadRetryPredicate({ module: { isRetryableAssistantError: fromMeter }, candidates: [{ url: "x" }], load: async () => ({ isRetryableAssistantError: fromCandidate }) }), fromMeter);
	const loaded = [];
	const load = async (url) => {
		loaded.push(url);
		if (url === "broken") throw new Error("ENOENT");
		if (url === "empty") return {};
		return { isRetryableAssistantError: fromCandidate };
	};
	assert.equal(await loadRetryPredicate({ module: null, candidates: [{ url: "broken" }, { url: "empty" }, { url: "good" }], load }), fromCandidate);
	assert.deepEqual(loaded, ["broken", "empty", "good"]);
	assert.equal(await loadRetryPredicate({ module: {}, candidates: [], load }), null);
	assert.equal(await loadRetryPredicate(), null);
});

test("capExitMessage bounds the exit line's message and marks the cut; shorter outcomes pass through untouched", () => {
	const short = { code: 2, reason: "provider-auth-refused", message: "401 x" };
	assert.equal(capExitMessage(short), short);
	const exact = { code: 1, reason: "error", message: "y".repeat(EXIT_MESSAGE_MAX_CHARS) };
	assert.equal(capExitMessage(exact), exact);
	const long = { code: 2, reason: "provider-auth-refused", message: `403 ${"<p>x</p>".repeat(2000)}` };
	const capped = capExitMessage(long);
	assert.equal(capped.code, 2);
	assert.equal(capped.reason, "provider-auth-refused");
	assert.ok(capped.message.startsWith(long.message.slice(0, EXIT_MESSAGE_MAX_CHARS)));
	assert.ok(capped.message.endsWith(`... [truncated ${long.message.length - EXIT_MESSAGE_MAX_CHARS} chars]`));
	assert.ok(capped.message.length < EXIT_MESSAGE_MAX_CHARS + 40);
	assert.equal(long.message.length, 4 + 16000, "the input is not mutated");
	for (const outcome of [{ code: 0, reason: "stop" }, { code: 2, reason: "x", message: 5 }, null, undefined]) assert.equal(capExitMessage(outcome), outcome);
});

test("the exit-line message budget is 2000 characters AS SERIALIZED, whatever the body escapes to", () => {
	// The literal, pinned: every other test here derives from the constant, so a raised cap would pass them
	// all while the worker's tail lost the label. worker/test/run-history.test.mjs measures the real line.
	assert.equal(EXIT_MESSAGE_MAX_CHARS, 2000);
	const escaped = (message) => JSON.stringify(message).length - 2;
	// A quote or newline serializes to 2 characters and a control byte to 6: the budget is what the tail
	// sees, so each of these must come out at or under 2000 escaped characters plus the marker.
	for (const body of ['"'.repeat(5000), "\n".repeat(5000), "\u0001".repeat(5000), `403 ${'<a href="x">'.repeat(900)}`]) {
		const capped = capExitMessage({ code: 2, reason: "provider-auth-refused", message: body }).message;
		const kept = capped.slice(0, capped.lastIndexOf("... [truncated "));
		assert.ok(escaped(kept) <= EXIT_MESSAGE_MAX_CHARS, `kept ${escaped(kept)} escaped chars`);
		assert.ok(escaped(kept) > EXIT_MESSAGE_MAX_CHARS - 6, "and it spends the budget rather than stopping far short");
		assert.ok(body.startsWith(kept));
		assert.ok(capped.endsWith(`... [truncated ${body.length - kept.length} chars]`));
	}
	// A body at the budget raw but over it escaped is cut; one at the budget escaped is not.
	assert.notEqual(capExitMessage({ message: '"'.repeat(1001) }).message, '"'.repeat(1001));
	assert.equal(capExitMessage({ message: '"'.repeat(1000) }).message, '"'.repeat(1000));
	// Whole code points only: an astral character is never split into a lone surrogate.
	const astral = capExitMessage({ message: "\u{1F600}".repeat(3000) }).message;
	const keptAstral = astral.slice(0, astral.lastIndexOf("... [truncated "));
	assert.equal(keptAstral, "\u{1F600}".repeat(1000));
	assert.equal(keptAstral.isWellFormed(), true);
});

test("run-job.mjs logs retry_predicate_unavailable when no pinned retry predicate loads", () => {
	// The fail-open direction is safe (everything retries) but it silently turns #437 off, so the one
	// signal an operator gets is this line. Pinned beside the loadRetryPredicate call it guards.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(
		src,
		/const isRetryable = await loadRetryPredicate\([^\n]*\);\n\tif \(!isRetryable\) log\("retry_predicate_unavailable", \{\}\);/,
		"the null-predicate log line must follow the loadRetryPredicate call",
	);
});

test("run-job.mjs caps every exit line and hands decideExit the pinned retry predicate", () => {
	// Both are wiring the unit tests above cannot see: an exit line that bypasses the cap loses the label
	// host-side on a big body, and a decideExit call without isRetryable silently turns #437 off.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const exitLines = src.match(/log\("exit", \{[^\n]*/g) ?? [];
	assert.equal(exitLines.length, 2, "the runner has two exit-line paths (the decided outcome and the preflight throw)");
	assert.match(exitLines[0], /\.\.\.capExitMessage\(outcome\)/, "the decided outcome's exit line must be capped");
	assert.match(src, /const capped = capExitMessage\(outcome\);\s*log\("exit", \{ code: capped\.code, reason: capped\.reason, message: capped\.message \}\)/, "the throw path's exit line must be capped");
	assert.match(src, /loadRetryPredicate\(\{ module: usageMeter\.ok \? usageMeter\.module : null, candidates: resolvePiAiCompat\(\) \}\)/);
	assert.match(src, /decideExit\(\{[\s\S]*?\n\t\tisRetryable,\n\t\}\);/, "decideExit must receive isRetryable");
});
