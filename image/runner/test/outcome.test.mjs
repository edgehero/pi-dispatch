import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
	capExitMessage,
	captureTerminal,
	classifyPromptRejection,
	classifyStopReason,
	classifyThrow,
	configError,
	COST_CAP,
	COST_CAP_UNENFORCEABLE,
	COST_REFUSALS,
	costRefusalField,
	decideExit,
	EXIT_COMPLETED,
	EXIT_INFRA,
	EXIT_MESSAGE_MAX_CHARS,
	EXIT_POLICY,
	loadRetryPredicate,
	MODEL_NOT_ALLOWED,
	MODEL_POLICY_UNENFORCEABLE,
	providerAuthRefused,
	STOP_REASONS,
	TOKEN_BUDGET,
} from "../src/outcome.mjs";
import { attachTurnBudget } from "../src/turn-budget.mjs";
import { agentEnd, assistantError, assistantText, promptTurn, retryTurn } from "./helpers/pi-retry-events.mjs";

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

test("every one of pi's seven stopReasons is handled explicitly", () => {
	// pi-ai 0.99.1 dist/types.d.ts:311, in the union's own order; pinned-api.test.mjs holds this list to that
	// line of the pinned artifact. If pi's union grows, this fails rather than guessing.
	assert.deepEqual(STOP_REASONS, ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);
	for (const stopReason of STOP_REASONS) {
		const outcome = classifyStopReason({ stopReason });
		assert.ok(!String(outcome.reason).startsWith("unknown-"), `${stopReason} fell through`);
	}
});

test("a deferred terminal is policy, a pending one is infra (issue #509)", () => {
	// deferred: the provider holds the answer for later and still bills it; whatever asked for deferral asks
	// again on a retry, so a queue retry pays twice and fetches nothing. pending: the stream stopped before the
	// provider finished, no evidence the agent ran -- the no-terminal-message verdict under its own name.
	assert.deepEqual(classifyStopReason({ stopReason: "deferred" }), { code: EXIT_POLICY, reason: "deferred" });
	assert.deepEqual(classifyStopReason({ stopReason: "pending" }), { code: EXIT_INFRA, reason: "pending" });
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
	// Single-layer Google JSON is not a shape streaming produces (issue #451 reads only the double wrap).
	'{"error":{"code":401,"message":"API key not valid.","status":"UNAUTHENTICATED"}}',
	'502: {"detail":"OpenAI API error (401): upstream"}',
	'400: {"detail":"Azure OpenAI API error (403): upstream"}',
	'400: {"detail":"Mistral API error (401): upstream"}',
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

// --- issue #451: the Google, Vertex and Bedrock refusal shapes, from the M0-d measurements ---

// @google/genai's wrap of a text/event-stream error body, byte for byte as measured: Google pretty-prints
// its body with two spaces and a final newline, and the SDK puts that TEXT in error.message with the HTTP
// status and reason phrase beside it. The first literal below is the real answer to a bogus AI Studio key,
// verbatim, which is what keeps this helper honest.
const googleWrap = (inner, code, statusText) => JSON.stringify({ error: { message: `${JSON.stringify(inner, null, 2)}\n`, code, status: statusText } });
const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const googleBody = (code, status, message, details) => ({ error: { code, message, status, ...(details ? { details } : {}) } });
const REAL_GOOGLE_BOGUS_KEY = '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"API key not valid. Please pass a valid API key.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\",\\n    \\"details\\": [\\n      {\\n        \\"@type\\": \\"type.googleapis.com/google.rpc.ErrorInfo\\",\\n        \\"reason\\": \\"API_KEY_INVALID\\",\\n        \\"domain\\": \\"googleapis.com\\",\\n        \\"metadata\\": {\\n          \\"service\\": \\"generativelanguage.googleapis.com\\"\\n        }\\n      },\\n      {\\n        \\"@type\\": \\"type.googleapis.com/google.rpc.LocalizedMessage\\",\\n        \\"locale\\": \\"en-US\\",\\n        \\"message\\": \\"API key not valid. Please pass a valid API key.\\"\\n      }\\n    ]\\n  }\\n}\\n","code":400,"status":"Bad Request"}}';
const VERTEX_UNAUTHENTICATED = "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.";
const API_KEY_INVALID_BODY = googleBody(400, "INVALID_ARGUMENT", "x", [{ "@type": ERROR_INFO, reason: "API_KEY_INVALID" }]);
const vertexBogusKey = (metadata) => googleWrap(googleBody(401, "UNAUTHENTICATED", VERTEX_UNAUTHENTICATED, [{ "@type": ERROR_INFO, reason: "ACCESS_TOKEN_TYPE_UNSUPPORTED", metadata }]), 401, "Unauthorized");
const STREAM_JUNK = '{"_events":{"close":[null,null],"error":[null,null]},"_readableState":{"highWaterMark":65536,"buffer":[],"bufferIndex":0,"length":0,"pipes":[],"awaitDrainWriters":null},"_writableState":{"highWaterMark":65536,"length":0,"corked":0,"writelen":0,"bufferedIndex":0,"pendingcb":0},"allowHalfOpen":true,"_eventsCount":11}';

const AUTH_REFUSED_451 = [
	// Google: the real bogus AI Studio key (HTTP 400, refused by its ErrorInfo reason alone).
	REAL_GOOGLE_BOGUS_KEY,
	// Vertex: the real bogus api key, in BOTH metadata key orders Google sent to two identical requests.
	vertexBogusKey({ method: "google.cloud.aiplatform.v1.PredictionService.StreamGenerateContent", service: "aiplatform.googleapis.com" }),
	vertexBogusKey({ service: "aiplatform.googleapis.com", method: "google.cloud.aiplatform.v1.PredictionService.StreamGenerateContent" }),
	// Each reason alone under a status that is not an auth status, so dropping either fails here. The 403
	// row is a measured reason under a 403, so dropping 403 from the outer-code set fails too.
	googleWrap(googleBody(400, "INVALID_ARGUMENT", "x", [{ "@type": ERROR_INFO, reason: "API_KEY_INVALID" }]), 400, "Bad Request"),
	googleWrap(googleBody(400, "INVALID_ARGUMENT", "x", [{ "@type": ERROR_INFO, reason: "ACCESS_TOKEN_TYPE_UNSUPPORTED" }]), 400, "Bad Request"),
	googleWrap(googleBody(403, "PERMISSION_DENIED", "x", [{ "@type": ERROR_INFO, reason: "API_KEY_INVALID" }]), 403, "Forbidden"),
	// Bedrock: the one measured refusal NAME, whatever follows it (issue #509). pi-ai 0.99.1 prints AWS's own
	// sentence and no status (the first row, verbatim as the loopback table in pinned-api.test.mjs measures
	// it), or `<status>: <body>` when the SDK did not fold the body into its message; pi-ai 0.80.7 lost the
	// message and printed the status and junk, on HTTP/1 ([object Object]) and HTTP/2 (the stream junk). The
	// rule reads the name alone, so a status the old rule demanded (403) no longer matters, 401 included.
	"UnrecognizedClientException: The security token included in the request is invalid.",
	"UnrecognizedClientException: The security token included in the request is expired",
	"UnrecognizedClientException: 403: [object Object]",
	`UnrecognizedClientException: 403: ${STREAM_JUNK}`,
	"UnrecognizedClientException: 401: [object Object]",
	"UnrecognizedClientException: 4031: x",
];

const NOT_AUTH_REFUSED_451 = [
	// Google quota, both wordings: pi calls the first non-transient ("billing"), and it is still infra.
	googleWrap(googleBody(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits."), 429, "Too Many Requests"),
	googleWrap(googleBody(429, "RESOURCE_EXHAUSTED", "Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details."), 429, "Too Many Requests"),
	// A bad payload: INVALID_ARGUMENT with no auth reason.
	googleWrap(googleBody(400, "INVALID_ARGUMENT", 'Invalid JSON payload received. Unknown name "foo": Cannot find field.'), 400, "Bad Request"),
	googleWrap(googleBody(500, "INTERNAL", "An internal error has occurred."), 500, "Internal Server Error"),
	// PERMISSION_DENIED is a residual: never measured against a real endpoint, and it has transient
	// windows pi's predicate does not catch (the gate's adversary rows, verbatim in shape).
	googleWrap(googleBody(403, "PERMISSION_DENIED", "Permission denied: Consumer 'api_key:AIza' has been suspended."), 403, "Forbidden"),
	googleWrap(googleBody(403, "PERMISSION_DENIED", "Generative Language API has not been used in project 1 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=1 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.", [{ "@type": ERROR_INFO, reason: "SERVICE_DISABLED", domain: "googleapis.com" }]), 403, "Forbidden"),
	googleWrap(googleBody(403, "PERMISSION_DENIED", "Permission 'aiplatform.endpoints.predict' denied on resource '//aiplatform.googleapis.com/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-pro' (or it may not exist).", [{ "@type": ERROR_INFO, reason: "IAM_PERMISSION_DENIED", domain: "aiplatform.googleapis.com" }]), 403, "Forbidden"),
	googleWrap(googleBody(403, "PERMISSION_DENIED", "The caller does not have permission"), 403, "Forbidden"),
	// UNAUTHENTICATED alone is a residual: a status names a class, not a cause. The first is the real
	// bogus Vertex key's status and message WITHOUT its reason; the second is a hypothetical transient
	// UNAUTHENTICATED that pi's predicate does not read as transient.
	googleWrap(googleBody(401, "UNAUTHENTICATED", VERTEX_UNAUTHENTICATED), 401, "Unauthorized"),
	googleWrap(googleBody(401, "UNAUTHENTICATED", "Authentication backend unavailable, try again later."), 401, "Unauthorized"),
	// A measured reason under an outer code outside the measured set (a 5xx, a 200) is not a refusal.
	googleWrap(API_KEY_INVALID_BODY, 503, "Service Unavailable"),
	googleWrap(API_KEY_INVALID_BODY, 200, "OK"),
	googleWrap(googleBody(400, "INVALID_ARGUMENT", "x", [{ "@type": ERROR_INFO, reason: "API_KEY_INVALID" }]), 500, "Internal Server Error"),
	// Only own fields are read: a `__proto__` key JSON.parse keeps as an own property carries nothing.
	JSON.stringify({ error: { message: `{"error":{"__proto__":{"details":[{"@type":"${ERROR_INFO}","reason":"API_KEY_INVALID"}]}}}`, code: 400 } }),
	JSON.stringify({ error: { message: `{"error":{"status":"X","details":[{"__proto__":{"@type":"${ERROR_INFO}","reason":"API_KEY_INVALID"}}]}}`, code: 400 } }),
	// UNAUTHENTICATED and API_KEY_INVALID present only INSIDE a string that is not error.status or a
	// reason: a byte match reads these, a parse does not.
	googleWrap(googleBody(400, "INVALID_ARGUMENT", 'upstream said "status": "UNAUTHENTICATED", reason API_KEY_INVALID'), 400, "Bad Request"),
	googleWrap(googleBody(400, "INVALID_ARGUMENT", JSON.stringify({ error: { status: "UNAUTHENTICATED" } })), 400, "Bad Request"),
	// The reason on a detail that is not an ErrorInfo, and an ErrorInfo whose reason is not in the set.
	googleWrap(googleBody(400, "INVALID_ARGUMENT", "x", [{ "@type": "type.googleapis.com/google.rpc.LocalizedMessage", reason: "API_KEY_INVALID" }]), 400, "Bad Request"),
	googleWrap(googleBody(400, "INVALID_ARGUMENT", "x", [{ "@type": ERROR_INFO, reason: "API_KEY_SERVICE_BLOCKED_x" }]), 400, "Bad Request"),
	// The OUTER status is the HTTP reason phrase and is never read, whatever it says.
	JSON.stringify({ error: { message: JSON.stringify(googleBody(500, "INTERNAL", "x")), code: 401, status: "UNAUTHENTICATED" } }),
	// Not the SDK's wrap: no numeric code, a non-JSON inner text, trailing or leading bytes, an array.
	JSON.stringify({ error: { message: JSON.stringify(API_KEY_INVALID_BODY), status: "Bad Request" } }),
	JSON.stringify({ error: { message: "<html>401 UNAUTHENTICATED</html>", code: 401, status: "Unauthorized" } }),
	`${googleWrap(API_KEY_INVALID_BODY, 400, "Bad Request")} trailing`,
	` ${googleWrap(API_KEY_INVALID_BODY, 400, "Bad Request")}`,
	`[${googleWrap(API_KEY_INVALID_BODY, 400, "Bad Request")}]`,
	"text that merely mentions API_KEY_INVALID and UNAUTHENTICATED",
	'500: {"error":{"status":"UNAUTHENTICATED","details":[{"reason":"API_KEY_INVALID"}]}}',
	// Bedrock: the transient and non-credential prefixes pi-ai maps, in both the 0.99.1 form (AWS's message)
	// and the 0.80.7 one, and each anchor boundary of the name rule.
	"Throttling error: Too many requests, please wait before trying again.",
	"Throttling error: 429: [object Object]",
	"Service unavailable: 503: [object Object]",
	"Validation error: 400: [object Object]",
	// AccessDeniedException and ExpiredTokenException are residuals: the first also means an intermittent
	// cross-region SCP/IAM denial or a propagating fix, told apart only by the message pi-ai loses; the
	// second was never seen from real AWS.
	"AccessDeniedException: User is not authorized to perform: bedrock:InvokeModelWithResponseStream",
	"ExpiredTokenException: The security token included in the request is expired",
	"AccessDeniedException: 403: [object Object]",
	`AccessDeniedException: 403: ${STREAM_JUNK}`,
	"ExpiredTokenException: 403: [object Object]",
	" UnrecognizedClientException: 403: x",
	"Error: UnrecognizedClientException: 403: x",
	"UnrecognizedClientExceptionX: 403: x",
	"UnrecognizedClientException:403: x",
	"UnrecognizedClientException 403: x",
	"AccessDeniedException: 4031: x",
	"AccessDeniedException: 403 x",
	" AccessDeniedException: 403: x",
	"Error: AccessDeniedException: 403: x",
	"ThrottlingException: 403: x",
	// Google OAuth under Vertex ADC, a residual: invalid_grant also covers a clock-skewed JWT assertion and
	// a service account still propagating, and a bare invalid_client is too generic. The three forms: the
	// service account's (the real answer, verbatim), the authorized_user's bare code, the external_account's.
	"invalid_grant: Invalid grant: account not found",
	"invalid_grant: Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.",
	"invalid_client",
	"invalid_grant",
	"Error code invalid_grant: The audience in ID Token does not match the expected audience.",
	// Codex, by decision: the server's own sentence, no status on either transport.
	"Could not parse your authentication token. Please try signing in again.",
];

test("issue #451: Google's parsed status or reason and Bedrock's exception prefix exit 2", () => {
	// The helper rebuilds the measured bytes exactly, so the synthetic rows above are the real format.
	const measured = googleWrap(googleBody(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [
		{ "@type": ERROR_INFO, reason: "API_KEY_INVALID", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } },
		{ "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en-US", message: "API key not valid. Please pass a valid API key." },
	]), 400, "Bad Request");
	assert.equal(measured, REAL_GOOGLE_BOGUS_KEY);
	for (const errorMessage of AUTH_REFUSED_451) {
		assert.equal(providerAuthRefused(err(errorMessage), NOT_TRANSIENT), true, errorMessage);
		assert.deepEqual(classifyStopReason(err(errorMessage), NOT_TRANSIENT), { code: EXIT_POLICY, reason: "provider-auth-refused", message: errorMessage }, errorMessage);
		// The retry-predicate guard covers every new shape: a message pi calls transient is never a refusal.
		assert.equal(providerAuthRefused(err(errorMessage), TRANSIENT), false, errorMessage);
	}
});

test("issue #451: the must-stay-infra shapes stay retryable infra, and a malformed body never throws", () => {
	for (const errorMessage of NOT_AUTH_REFUSED_451) {
		assert.equal(providerAuthRefused(err(errorMessage), NOT_TRANSIENT), false, errorMessage);
		assert.deepEqual(classifyStopReason(err(errorMessage), NOT_TRANSIENT), { code: EXIT_INFRA, reason: "error", message: errorMessage }, errorMessage);
	}
	for (const errorMessage of ["{", "{}", '{"error":null}', '{"error":{"message":"{","code":401}}', '{"error":{"message":"null","code":401}}', '{"error":{"message":"{\\"error\\":{\\"details\\":[null,1,\\"x\\"]}}","code":401}}']) {
		assert.equal(providerAuthRefused(err(errorMessage), NOT_TRANSIENT), false, errorMessage);
	}
});

test("issue #451: only OWN fields are read, so a polluted Object.prototype cannot make a refusal", () => {
	// Defense in depth: JSON.parse never produces inherited fields, so this only matters if other code
	// pollutes Object.prototype. A plain read would then find an inherited `details`, or an inherited
	// `reason` and `@type` on an empty detail, and read a bad payload as a credential refusal.
	const noDetails = googleWrap(googleBody(400, "INVALID_ARGUMENT", "x"), 400, "Bad Request");
	const emptyDetail = googleWrap(googleBody(400, "INVALID_ARGUMENT", "x", [{}]), 400, "Bad Request");
	const keys = ["details", "reason", "@type"];
	try {
		Object.prototype.details = [{ "@type": ERROR_INFO, reason: "API_KEY_INVALID" }];
		Object.prototype.reason = "API_KEY_INVALID";
		Object.prototype["@type"] = ERROR_INFO;
		assert.equal(providerAuthRefused(err(noDetails), NOT_TRANSIENT), false, "an inherited details array was read");
		assert.equal(providerAuthRefused(err(emptyDetail), NOT_TRANSIENT), false, "an inherited reason and @type were read");
	} finally {
		for (const key of keys) delete Object.prototype[key];
	}
	// The same messages are refusals when the fields are really there, so the rows above are live.
	assert.equal(providerAuthRefused(err(googleWrap(API_KEY_INVALID_BODY, 400, "Bad Request")), NOT_TRANSIENT), true);
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

test("the exit-line message budget is 1900 characters AS SERIALIZED, whatever the body escapes to", () => {
	// The literal, pinned: every other test here derives from the constant, so a raised cap would pass them
	// all while the worker's tail lost the label. worker/test/run-history.test.mjs measures the real line.
	assert.equal(EXIT_MESSAGE_MAX_CHARS, 1900);
	const escaped = (message) => JSON.stringify(message).length - 2;
	// A quote or newline serializes to 2 characters and a control byte to 6: the budget is what the tail
	// sees, so each of these must come out at or under the budget in escaped characters, plus the marker.
	for (const body of ['"'.repeat(5000), "\n".repeat(5000), "\u0001".repeat(5000), `403 ${'<a href="x">'.repeat(900)}`]) {
		const capped = capExitMessage({ code: 2, reason: "provider-auth-refused", message: body }).message;
		const kept = capped.slice(0, capped.lastIndexOf("... [truncated "));
		assert.ok(escaped(kept) <= EXIT_MESSAGE_MAX_CHARS, `kept ${escaped(kept)} escaped chars`);
		assert.ok(escaped(kept) > EXIT_MESSAGE_MAX_CHARS - 6, "and it spends the budget rather than stopping far short");
		assert.ok(body.startsWith(kept));
		assert.ok(capped.endsWith(`... [truncated ${body.length - kept.length} chars]`));
	}
	// A body at the budget raw but over it escaped is cut; one at the budget escaped is not.
	const half = EXIT_MESSAGE_MAX_CHARS / 2;
	assert.notEqual(capExitMessage({ message: '"'.repeat(half + 1) }).message, '"'.repeat(half + 1));
	assert.equal(capExitMessage({ message: '"'.repeat(half) }).message, '"'.repeat(half));
	// Whole code points only: an astral character is never split into a lone surrogate.
	const astral = capExitMessage({ message: "\u{1F600}".repeat(3000) }).message;
	const keptAstral = astral.slice(0, astral.lastIndexOf("... [truncated "));
	assert.equal(keptAstral, "\u{1F600}".repeat(half), "two UTF-16 units each, kept raw by JSON.stringify");
	assert.equal(keptAstral.isWellFormed(), true);
	// A lone surrogate escapes to 6 characters and U+2028 is kept raw by JSON.stringify; both are budgeted as serialized.
	for (const body of ["\uD800".repeat(1000), "\u2028".repeat(3000)]) {
		const capped = capExitMessage({ message: body }).message;
		assert.ok(escaped(capped.slice(0, capped.lastIndexOf("... [truncated "))) <= EXIT_MESSAGE_MAX_CHARS);
	}
});

test("capExitMessage never throws on a body whose escaped form would exceed the engine's string limit", () => {
	// 100M control bytes escape to 600M characters, past V8's maximum string length: stringifying the whole
	// message first threw a RangeError here, on the exit path, and lost the exit line itself.
	const capped = capExitMessage({ code: 2, reason: "provider-auth-refused", message: "\u0001".repeat(100_000_000) });
	assert.ok(capped.message.length < EXIT_MESSAGE_MAX_CHARS + 40);
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

test("decideExit ranks a meter stop over everything but the turn budget: the catch path reuses it after a stop (issue #543)", () => {
	for (const reason of ["cost-cap", "model-not-allowed", "token_budget"]) {
		assert.deepEqual(decideExit({ budgetAborted: false, meterStop: reason }), { code: EXIT_POLICY, reason });
	}
});

test("run-job.mjs caps every exit line and hands decideExit the pinned retry predicate", () => {
	// Both are wiring the unit tests above cannot see: an exit line that bypasses the cap loses the label
	// host-side on a big body, and a decideExit call without isRetryable silently turns #437 off.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const exitLines = src.match(/exitWriter\.writeExit\(\{[^\n]*/g) ?? [];
	assert.equal(exitLines.length, 2, "the runner has two exit-line paths (the decided outcome and the preflight throw)");
	assert.match(exitLines[0], /\.\.\.capExitMessage\(outcome\)/, "the decided outcome's exit line must be capped");
	assert.match(src, /const capped = capExitMessage\(outcome\);\s*exitWriter\.writeExit\(\{ code: capped\.code, reason: capped\.reason, \.\.\.costRefusalField\(outcome, costRefusalWhy\(\)\), message: capped\.message, \.\.\.meteredExitFields\(\) \}\)/, "the throw path's exit line must be capped");
	assert.match(src, /loadRetryPredicate\(\{ module: usageMeter\.ok \? usageMeter\.module : null, candidates: resolvePiAiCompat\(\) \}\)/);
	assert.match(src, /decideExit\(\{[\s\S]*?\n\t\tisRetryable,\n\t\trejected,\n\t\}\);/, "decideExit must receive isRetryable, and the classified rejection");
});

test("run-job.mjs classifies a prompt() rejection only through classifyPromptRejection, and rethrows the rest (issue #509)", () => {
	// Wiring the unit tests above cannot see. Without the catch, pi's unresumable retry is exit 1 and the queue
	// re-runs paid work on a fresh budget; without the rethrow, every OTHER rejection (the preflight path)
	// would vanish into a decided outcome; without the retry tracking, the verdict can never fire.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /\} catch \(error\) \{\n\t\trejected = classifyPromptRejection\(error, \{ retryInFlight \}\);\n\t\tif \(!rejected\) throw error;\n\t\} finally \{/, "the prompt() catch must classify, and rethrow what it does not classify");
	assert.ok(src.indexOf("await session.prompt(prompt);") < src.indexOf("rejected = classifyPromptRejection("), "the catch belongs to the prompt() call");
	assert.match(src, /if \(event\.type === "auto_retry_start"\) \{\n\t\t\tretryInFlight = true;/, "auto_retry_start must arm the in-flight flag");
	assert.match(src, /if \(event\.type === "auto_retry_end"\) retryInFlight = false;/, "auto_retry_end must clear it");
});

/**
 * Issue #449, end to end through the runner's own pieces: the turn budget, captureTerminal and decideExit
 * wired to one bus the way run-job.mjs wires them, driven by pi's real retry order. With --max-turns 1 a
 * provider 429 used to be counted twice (the failed turn, then pi's retry of it) and exited 2 turn_budget:
 * policy, never retried, and paged. PI_RETRY_MAX is 2 here, the runner's default (src/config.mjs).
 */
function runOneTurnJob(drive) {
	const listeners = [];
	const session = {
		subscribe(listener) {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		async abort() {},
	};
	const emit = (event) => {
		for (const l of listeners) l(event);
	};
	let terminal;
	session.subscribe((event) => {
		terminal = captureTerminal(terminal, event);
	});
	const budget = attachTurnBudget(session, 1);
	drive(emit);
	const outcome = decideExit({ budgetAborted: budget.state.aborted, budgetTurns: budget.state.turns, tokenAborted: false, terminal, isRetryable: () => true });
	return { outcome, budget };
}

test("max-turns 1: a 429 that pi's retry recovers from exits 0, not turn_budget", () => {
	const { outcome, budget } = runOneTurnJob((emit) => {
		promptTurn(emit, assistantError());
		agentEnd(emit, [assistantError()], true);
		retryTurn(emit, 1, assistantText());
		agentEnd(emit, [assistantText()], false);
	});
	assert.equal(outcome.code, EXIT_COMPLETED);
	assert.equal(outcome.reason, "stop");
	assert.deepEqual({ turns: budget.state.turns, retryTurns: budget.state.retryTurns }, { turns: 1, retryTurns: 1 });
});

test("max-turns 1: a 429 that outlasts pi's retries exits 1, a retried infra failure, not turn_budget", () => {
	const { outcome, budget } = runOneTurnJob((emit) => {
		promptTurn(emit, assistantError());
		agentEnd(emit, [assistantError()], true);
		retryTurn(emit, 1, assistantError());
		agentEnd(emit, [assistantError()], true);
		retryTurn(emit, 2, assistantError());
		// Exhausted: no auto_retry_start, only the final end (agent-session.js:2068-2071, :751-758).
		agentEnd(emit, [assistantError()], false);
		emit({ type: "auto_retry_end", success: false, attempt: 2, finalError: "429 rate limited" });
	});
	assert.equal(outcome.code, EXIT_INFRA);
	assert.equal(outcome.reason, "error");
	assert.equal(budget.state.aborted, false);
	assert.deepEqual({ turns: budget.state.turns, retryTurns: budget.state.retryTurns }, { turns: 1, retryTurns: 2 });
});

test("run-job.mjs puts the turn budget's retryTurns on the decided exit line beside turns", () => {
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const decided = (src.match(/exitWriter\.writeExit\(\{[^\n]*/g) ?? [])[0] ?? "";
	assert.match(decided, /turns: budget\.state\.turns, retryTurns: budget\.state\.retryTurns,/);
});

// --- issue #509: a prompt() that rejects while pi's own retry is in flight ---

const UNRESUMABLE = "Cannot continue from message role: assistant";

test("pi's unresumable retry is policy under its own name, not a queue retry of paid work (issue #509)", () => {
	// The shape the loopback test in pinned-api.test.mjs measures at 0.99.1: a retry-shaped throw after the
	// turn's tool ran, pi omits the failed attempt, and continue() refuses a transcript ending on the
	// assistant. Exit 1 would re-run the whole job, model call and tool run included, on a fresh budget.
	assert.deepEqual(classifyPromptRejection(new Error(UNRESUMABLE), { retryInFlight: true }), { code: EXIT_POLICY, reason: "retry-unresumable", message: UNRESUMABLE });
	// Both conditions are required: the same words outside a retry are some other bug, and a different
	// rejection during a retry is not this one. null leaves either to classifyThrow, unchanged.
	assert.equal(classifyPromptRejection(new Error(UNRESUMABLE), { retryInFlight: false }), null);
	assert.equal(classifyPromptRejection(new Error(UNRESUMABLE)), null);
	assert.equal(classifyPromptRejection(new Error("fetch failed"), { retryInFlight: true }), null);
	assert.equal(classifyPromptRejection(new Error(`x ${UNRESUMABLE}`), { retryInFlight: true }), null, "anchored at the start");
	// pi's other continue() refusal wording belongs to the same family, and a non-Error rejection is read as text.
	assert.equal(classifyPromptRejection(UNRESUMABLE, { retryInFlight: true })?.reason, "retry-unresumable");
	assert.equal(classifyPromptRejection(new Error("Cannot continue from message role: toolResult"), { retryInFlight: true })?.reason, "retry-unresumable");
});

test("decideExit ranks a classified rejection below both budget aborts and above the terminal message", () => {
	const rejected = { code: EXIT_POLICY, reason: "retry-unresumable", message: UNRESUMABLE };
	// The last message a rejected prompt leaves is a toolUse, which alone would read as a clean exit 0.
	const terminal = { stopReason: "toolUse" };
	assert.deepEqual(decideExit({ budgetAborted: false, tokenAborted: false, terminal, rejected }), rejected);
	assert.equal(decideExit({ budgetAborted: true, budgetTurns: 2, tokenAborted: false, terminal, rejected }).reason, "turn_budget");
	assert.equal(decideExit({ budgetAborted: false, tokenAborted: true, terminal, rejected }).reason, "token_budget");
	assert.deepEqual(decideExit({ budgetAborted: false, tokenAborted: false, terminal, rejected, command: { failed: true } }), rejected, "a command job's rejection is classified the same way");
	// Absent, the decision tree is byte-identical to before.
	assert.deepEqual(decideExit({ budgetAborted: false, tokenAborted: false, terminal }), { code: EXIT_COMPLETED, reason: "toolUse" });
});

// ── Issues #501/#502: the meter's stop reaches the exit decision by reason ────────────────────────────

test("the four policy reasons are exported literals, spelled once", () => {
	assert.deepEqual([TOKEN_BUDGET, COST_CAP, MODEL_NOT_ALLOWED, COST_CAP_UNENFORCEABLE, MODEL_POLICY_UNENFORCEABLE], ["token_budget", "cost-cap", "model-not-allowed", "cost-cap-unenforceable", "model-policy-unenforceable"]);
});

test("decideExit: turn_budget > meterStop > tokenAborted > rejected > the terminal message", () => {
	const ok = { role: "assistant", stopReason: "stop" };
	const rejected = { code: EXIT_POLICY, reason: "retry-unresumable", message: "x" };
	for (const stop of [TOKEN_BUDGET, COST_CAP, MODEL_NOT_ALLOWED]) {
		assert.deepEqual(decideExit({ budgetAborted: false, meterStop: stop, tokenAborted: false, terminal: ok }), { code: EXIT_POLICY, reason: stop }, stop);
		assert.equal(decideExit({ budgetAborted: true, budgetTurns: 3, meterStop: stop, terminal: ok }).reason, "turn_budget", `turn budget outranks ${stop}`);
		assert.equal(decideExit({ budgetAborted: false, meterStop: stop, tokenAborted: false, terminal: ok, rejected }).reason, stop, `${stop} outranks a rejected prompt`);
		assert.equal(decideExit({ budgetAborted: false, meterStop: stop, tokenAborted: false, terminal: ok, command: { failed: true } }).reason, stop, `${stop} outranks a failed command`);
	}
	assert.equal(decideExit({ budgetAborted: false, meterStop: COST_CAP, tokenAborted: true, terminal: ok }).reason, COST_CAP, "the meter's stop outranks the fallback's flag");
	assert.equal(decideExit({ budgetAborted: false, meterStop: null, tokenAborted: true, terminal: ok, rejected }).reason, TOKEN_BUDGET, "the fallback bus meter still names a token stop");
	assert.deepEqual(decideExit({ budgetAborted: false, tokenAborted: false, terminal: ok }), { code: EXIT_COMPLETED, reason: "stop" }, "no stop at all: unchanged");
});

test("classifyThrow honours the tag of both unenforceable refusals: exit 2, its own reason", () => {
	for (const reason of [COST_CAP_UNENFORCEABLE, MODEL_POLICY_UNENFORCEABLE]) {
		const outcome = classifyThrow(configError("PI_MAX_COST_MICROS is set but cannot be enforced before a call: no guard", reason));
		assert.deepEqual([outcome.code, outcome.reason], [EXIT_POLICY, reason]);
	}
});

test("costRefusalField: a `why` only on a cost-cap outcome and only from COST_REFUSALS, else nothing at all (#507)", () => {
	assert.deepEqual([...COST_REFUSALS], ["unboundable", "external", "over-cap"]);
	for (const why of COST_REFUSALS) assert.deepEqual(costRefusalField({ code: EXIT_POLICY, reason: COST_CAP }, why), { why });
	assert.deepEqual(costRefusalField({ code: EXIT_POLICY, reason: COST_CAP }, null), {}, "a cost-cap stop the guard did not refuse");
	assert.deepEqual(costRefusalField({ code: EXIT_POLICY, reason: COST_CAP }, "something-else"), {});
	for (const reason of [MODEL_NOT_ALLOWED, TOKEN_BUDGET, COST_CAP_UNENFORCEABLE, "stop"]) {
		assert.deepEqual(costRefusalField({ code: EXIT_POLICY, reason }, "unboundable"), {}, reason);
	}
	assert.deepEqual(costRefusalField(undefined, "unboundable"), {});
});
