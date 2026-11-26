import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tempDir } from "./helpers/temp-dir.mjs";
import { jobTree, runRealJob } from "./helpers/real-job.mjs";
import { createJobModelRuntime, loadPiAuthStorage } from "../src/model-runtime.mjs";
import { captureTerminal, classifyStopReason, decideExit, loadRetryPredicate } from "../src/outcome.mjs";
import { jobSettings } from "../src/config.mjs";
import { createPolicyGuard, createUsageMeter, installProcessUsageMeter, resolvePiAiCompat } from "../src/usage-meter.mjs";
import { classifyProviderFailure, createToolStartLatch, installProviderFailureObserver, MAX_RESET_MS, providerReplaySafe, providerSpendLimit, resetFromHeaders } from "../src/provider-failure.mjs";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const error = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });

// Issue #1106: OpenRouter's answer to a call on a workspace whose monthly budget is used up, measured 2026-11-26 (POST
// /api/v1/chat/completions, HTTP 403), verbatim. It holds no key. pi-ai's openai-completions prints the `error` object
// after the status (utils/error-body.js `formatProviderError`), which the loopback test below pins.
const OPENROUTER_BUDGET_403 = '{"error":{"message":"Workspace monthly budget of $50.00 exceeded. Contact your org admin. $50.07 of $50.00 used; resets 2026-12-01T00:00:00.000Z.","code":403,"metadata":{"limit_source":"openrouter_workspace_budget","remedy_hint":"Wait for the budget interval to reset (see metadata.resets_at), or ask your org admin to raise the workspace budget.","scope":"workspace","limit_usd":50,"spend_usd":50.068100718,"resets_at":"2026-12-01T00:00:00.000Z"}}}';
const piText = (status, body) => `${status}: ${JSON.stringify(JSON.parse(body).error)}`;
const BUDGET = piText(403, OPENROUTER_BUDGET_403);
const OPENROUTER_CREDITS_402 = JSON.stringify({ error: { message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", code: 402 } });
const OPENAI_INVALID_KEY_401 = JSON.stringify({ error: { message: "Incorrect API key provided: dummy-key.", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
const OPENAI_NOT_ALLOWED_403 = JSON.stringify({ error: { message: "You are not allowed to sample from this model", type: "invalid_request_error", param: null, code: null } });
// The same refusal from OpenRouter's anthropic-messages endpoint (POST /api/v1/messages, HTTP 403, streaming or not),
// measured 2026-11-26, verbatim: the sentence one level deeper, under Anthropic's `permission_error` type. The Anthropic
// SDK prints the status, a space and the whole body, and pi-ai passes that on.
const OPENROUTER_MESSAGES_403 = '{"type":"error","error":{"type":"permission_error","message":"Workspace monthly budget of $50.00 exceeded. Contact your org admin. $50.07 of $50.00 used; resets 2026-12-01T00:00:00.000Z.","error_type":"permission_denied"},"request_id":"gen-1795721338-o5OTYqK8NDZVSU77SvJl","metadata":{"limit_source":"openrouter_workspace_budget","remedy_hint":"Wait for the budget interval to reset (see metadata.resets_at), or ask your org admin to raise the workspace budget.","scope":"workspace","limit_usd":50,"spend_usd":50.068100718,"resets_at":"2026-12-01T00:00:00.000Z"}}';
const sdkText = (status, body) => `${status} ${body}`;
// Anthropic's own refusal of a key that may not use a model, under the same type: a credential refusal, which stays one.
const ANTHROPIC_PERMISSION_403 = JSON.stringify({ type: "error", error: { type: "permission_error", message: "Your API key does not have permission to use the specified resource." } });
const OPENROUTER_UPSTREAM_403 = JSON.stringify({ error: { message: "Provider returned error", code: 403, metadata: { raw: "upstream connect error or disconnect/reset before headers" } } });

test("provider classifications are closed; successful, parameter, auth and unknown failures do not switch", () => {
	for (const [message, measured, expected] of [
		["429 rate limit", { status: 429, resetAt: NOW + 2000 }, { kind: "rate-limited", resetAt: NOW + 2000 }],
		["429 rate limit", { status: 429 }, { kind: "quota-exhausted" }],
		['{"error":{"code":"insufficient_quota"}}', null, { kind: "quota-exhausted" }],
		["enforced_spend_limit_reached", { status: 429 }, { kind: "quota-exhausted" }],
		["You have reached your specified API usage limits", null, { kind: "quota-exhausted" }],
		["RESOURCE_EXHAUSTED quota exceeded", null, { kind: "quota-exhausted" }],
		["Throttling error: request throughput exceeded", null, { kind: "quota-exhausted" }],
		["ThrottlingException: retry later", null, { kind: "quota-exhausted" }],
		["TooManyRequestsException: retry later", null, { kind: "quota-exhausted" }],
		["ServiceQuotaExceededException: account capacity", null, { kind: "quota-exhausted" }],
		["overloaded", null, { kind: "overloaded" }],
		["Service unavailable: try again", null, { kind: "overloaded" }],
		["Internal server error: try again", null, { kind: "overloaded" }],
		["unavailable", { status: 503 }, { kind: "overloaded" }],
		["context_length_exceeded", null, { kind: "context-overflow" }],
		["invalid_parameter quota exceeded", null, null],
		["authentication_error rate limit", null, null],
		["socket hang up", null, null],
		["400 malformed request", null, null],
		["400 invalid context window parameter", { status: 400 }, null],
		["context window exceeded", { status: 400 }, { kind: "context-overflow" }],
		["429 mentioned in invalid request", { status: 400 }, null],
		["rate limit", { status: 401 }, null],
	]) assert.deepEqual(classifyProviderFailure(error(message), measured), expected, message);
	assert.equal(classifyProviderFailure({ stopReason: "stop", errorMessage: "429" }, { status: 429 }), null);
	assert.equal(classifyProviderFailure({ ...error("429"), role: "toolResult" }), null);
	const bedrock = (message, status) => ({ ...error(message), diagnostics: [{ type: "bedrock_response_failure", details: { status, requestId: "never-recorded" } }] });
	assert.equal(classifyProviderFailure(bedrock("Service unavailable quota exceeded", 403)), null, "measured auth refusal wins over incidental retry words");
	assert.equal(classifyProviderFailure(bedrock("rate limit", 400)), null, "measured parameter refusal never switches");
	assert.deepEqual(classifyProviderFailure(bedrock("request failed", 429)), { kind: "quota-exhausted" });
	assert.deepEqual(classifyProviderFailure(bedrock("request failed", 503)), { kind: "overloaded" });
});

test("reset evidence uses injected time, accepts header dates/seconds, caps and rejects invalid/past resets", () => {
	assert.equal(resetFromHeaders(new Headers({ "retry-after": "2" }), NOW), NOW + 2000);
	assert.equal(resetFromHeaders({ "retry-after": new Date(NOW + 5000).toUTCString() }, NOW), NOW + 5000);
	assert.equal(resetFromHeaders({ "retry-after": "99999999" }, NOW), NOW + MAX_RESET_MS);
	assert.equal(resetFromHeaders({ "retry-after": "2", "anthropic-ratelimit-tokens-reset": new Date(NOW + 4000).toISOString() }, NOW), NOW + 4000);
	for (const value of ["", "no", "-2", "0", "Infinity", new Date(NOW - 1000).toUTCString()]) assert.equal(resetFromHeaders({ "retry-after": value }, NOW), null, value);
	assert.equal(resetFromHeaders({}, NOW), null);
});

test("tool start is a monotonic run-wide latch across turns and retries", () => {
	const latch = createToolStartLatch();
	assert.equal(latch.toolsStarted, false);
	latch.observe({ type: "turn_start" });
	latch.observe({ type: "tool_execution_start" });
	for (const type of ["turn_end", "turn_start", "auto_retry_start", "auto_retry_end"]) latch.observe({ type });
	assert.equal(latch.toolsStarted, true);
});

test("observer preserves stream identity, fetch behavior and per-call evidence, without reading bodies", async () => {
	const messages = [];
	class Runtime {
		streamSimple(model, context, options) {
			const message = context.message;
			const promise = Promise.resolve().then(async () => {
				if (options?.fetch) await options.fetch("https://unused.invalid", { method: "POST" });
				return message;
			});
			const stream = { result: () => promise };
			messages.push(stream);
			return stream;
		}
	}
	const original = Runtime.prototype.streamSimple;
	let calls = 0;
	const observer = installProviderFailureObserver({ ModelRuntime: Runtime, now: () => NOW });
	try {
		const runtime = new Runtime();
		const failed = error("rate limit");
		const customFetch = async (url, options) => {
			calls += 1;
			assert.equal(url, "https://unused.invalid");
			assert.equal(options.method, "POST");
			return { status: 429, headers: new Headers({ "retry-after": "2", authorization: "secret" }), text() { throw new Error("must not read body"); } };
		};
		const stream = runtime.streamSimple({ api: "openai-responses" }, { message: failed }, { fetch: customFetch });
		assert.equal(stream, messages[0]);
		await stream.result();
		assert.deepEqual(observer.failure(failed), { kind: "rate-limited", resetAt: NOW + 2000 });
		assert.equal(calls, 1);
		const succeeded = { role: "assistant", stopReason: "stop" };
		await runtime.streamSimple({ api: "openai-responses" }, { message: succeeded }, { fetch: customFetch }).result();
		assert.equal(observer.failure(succeeded), null);
		assert.deepEqual(observer.failure(error("rate limit")), { kind: "quota-exhausted" }, "a different call must not inherit reset evidence");
	} finally { observer.uninstall(); }
	assert.equal(Runtime.prototype.streamSimple, original);
});

test("unsupported custom-fetch transports are left untouched", async () => {
	const options = { apiKey: "sentinel" };
	class Runtime { streamSimple(model, context, passed) { assert.equal(passed, options); return { result: async () => error("RESOURCE_EXHAUSTED") }; } }
	const observer = installProviderFailureObserver({ ModelRuntime: Runtime, now: () => NOW });
	try { await new Runtime().streamSimple({ api: "google-generative-ai" }, {}, options).result(); } finally { observer.uninstall(); }
});

let pi;
try { pi = await import("@earendil-works/pi-coding-agent"); } catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw error;
}

// Exercise the pinned runtime and real adapters. Through pi 1.6.0 Anthropic's onResponse was not called on an HTTP
// rejection, which is why the observer reads failure headers through the per-call fetch. pi 1.6.1 calls onResponse
// for every attempt, a rejection included, on these adapters; the fetch path stays, because it is the one the
// observer is built on and a type-only assertion would miss a return of the old behaviour.
for (const [provider, api] of [["anthropic", "anthropic-messages"], ["openai", "openai-responses"], ["groq", "openai-completions"]]) {
	test(`pinned ${api} failure headers reach evidence through per-call fetch`, { skip: !pi }, async () => {
		const root = tempDir("pi-failure-");
		const AuthStorage = await loadPiAuthStorage();
		const runtime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, AuthStorage, agentDir: root, modelsPath: join(root, "models.json"), readFile: () => "{}" });
		const model = runtime.getModels(provider).find((m) => m.api === api);
		assert.ok(model, `pin must retain a ${provider}/${api} catalog model`);
		let calls = 0;
		let responseHooks = 0;
		const fetch = async () => {
			calls += 1;
			return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limit" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } });
		};
		const observer = installProviderFailureObserver({ ModelRuntime: pi.ModelRuntime, now: () => NOW });
		try {
			const terminal = await runtime.streamSimple(model, { messages: [{ role: "user", content: "test", timestamp: 0 }], tools: [] }, { apiKey: "fake-key", fetch, onResponse: () => { responseHooks += 1; } }).result();
			assert.equal(terminal.stopReason, "error");
			assert.ok(calls > 0);
			assert.deepEqual(observer.failure(terminal), { kind: "rate-limited", resetAt: NOW + 2000, ...(provider === "anthropic" ? { subscriptionProvider: "anthropic" } : {}) });
			assert.equal(responseHooks, calls, "pi 1.6.1 hands every attempt's response, a rejection included, to onResponse");
		} finally { observer.uninstall(); }
	});
}

test("replay safety refuses tools, child/loose/non-root calls, missing coverage and unresolved calls", () => {
	const clean = { toolsStarted: false, observer: { nonRootCalls: false, rootCalls: 1 }, tokens: { metered: true, calls: 1, sessions: 1, unresolved: 0 } };
	assert.equal(providerReplaySafe(clean), true);
	assert.equal(providerReplaySafe({ ...clean, toolsStarted: true }), false);
	assert.equal(providerReplaySafe({ ...clean, observer: { ...clean.observer, nonRootCalls: true } }), false);
	for (const change of [{ metered: false }, { calls: 2 }, { sessions: 2 }, { unresolved: 1 }, { childProcesses: 1 }, { unmeteredChildren: 1 }]) assert.equal(providerReplaySafe({ ...clean, tokens: { ...clean.tokens, ...change } }), false);
});

test("an egress proxy's refused tunnel is no evidence about the model, though pi 1.5.2 now names its status (#853)", { skip: !pi }, async () => {
	// The real chain: pi's own undici through a loopback proxy that refuses CONNECT with each status, wrapped as the
	// provider SDKs wrap a failed fetch ("Connection error."), then pi-ai's own withCauseDetail, which appends the
	// deepest cause. pi 1.5.0 left the bare "Connection error.", which no pattern here matched.
	const { createServer } = await import("node:http");
	const { loadPiUndici } = await import("../src/env-proxy.mjs");
	const { withCauseDetail } = await import(new URL("./utils/error-body.js", import.meta.resolve("@earendil-works/pi-ai")).href);
	const undici = loadPiUndici();
	let status = 0;
	const proxy = createServer();
	proxy.on("connect", (_request, socket) => socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`));
	await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const dispatcher = new undici.ProxyAgent({ uri: `http://127.0.0.1:${proxy.address().port}`, proxyTunnel: true });
	try {
		for (status of [403, 429, 500, 502, 503, 504]) {
			const failed = await undici.fetch("https://provider.invalid/v1/messages", { dispatcher, method: "POST" }).then(() => null, (e) => e);
			assert.ok(failed, `a ${status} tunnel refusal must fail the fetch`);
			const message = withCauseDetail(new Error("Connection error.", { cause: failed }));
			assert.match(message, new RegExp(`^Connection error\\.: .*\\b${status}\\b`), "the premise: pi 1.5.2 carries the proxy's status into the message");
			assert.equal(classifyProviderFailure(error(message)), null, `${message}: an api the observer cannot see`);
			assert.equal(classifyProviderFailure(error(message), { connection: true }), null, `${message}: an api the observer sees`);
		}
	} finally {
		await dispatcher.close();
		await new Promise((resolve) => proxy.close(resolve));
	}
	// Cutting the proxy's text leaves the provider's own words to the patterns.
	assert.deepEqual(classifyProviderFailure(error("Service unavailable: try again")), { kind: "overloaded" });
});

test("a fetch that got no answer records that, and the next call's answer is its own (#853)", async () => {
	class Runtime {
		streamSimple(model, context, options) {
			const done = options.fetch("https://unused.invalid").catch(() => {}).then(() => context.message);
			return { result: () => done };
		}
	}
	const observer = installProviderFailureObserver({ ModelRuntime: Runtime, now: () => NOW });
	try {
		const runtime = new Runtime();
		const unreachable = error("Connection error.: 503 Service Unavailable");
		await runtime.streamSimple({ api: "anthropic-messages" }, { message: unreachable }, { fetch: async () => { throw new TypeError("fetch failed"); } }).result();
		assert.equal(observer.failure(unreachable), null, "no HTTP answer: whatever the message says, the model is not judged");
		const answered = error("Service Unavailable");
		await runtime.streamSimple({ api: "anthropic-messages" }, { message: answered }, { fetch: async () => ({ status: 503, headers: new Headers() }) }).result();
		assert.deepEqual(observer.failure(answered), { kind: "overloaded" }, "a measured 503 still switches");
		// pi's own retries inside one call: the last attempt's evidence is the call's.
		const attempts = (...outcomes) => async () => { const next = outcomes.shift(); if (next === "throw") throw new TypeError("fetch failed"); return { status: next, headers: new Headers() }; };
		class Retrying {
			streamSimple(model, context, options) {
				const done = (async () => { for (let i = 0; i < 2; i += 1) await options.fetch("https://unused.invalid").catch(() => {}); return context.message; })();
				return { result: () => done };
			}
		}
		observer.uninstall();
		const retrying = installProviderFailureObserver({ ModelRuntime: Retrying, now: () => NOW });
		try {
			const thenAnswered = error("Service Unavailable");
			await new Retrying().streamSimple({ api: "openai-responses" }, { message: thenAnswered }, { fetch: attempts("throw", 503) }).result();
			assert.deepEqual(retrying.failure(thenAnswered), { kind: "overloaded" }, "no answer, then a 503: the 503 is the evidence");
			const thenLost = error("Connection error.: 429 rate limit");
			await new Retrying().streamSimple({ api: "openai-responses" }, { message: thenLost }, { fetch: attempts(429, "throw") }).result();
			assert.equal(retrying.failure(thenLost), null, "a 429, then no answer: the call ended on the network, as before this release");
		} finally { retrying.uninstall(); }
	} finally { observer.uninstall(); }
});

test("pinned SDK prompt resolves on 429 yet terminal events retain reset evidence and root-only replay proof", { skip: !pi }, async () => {
	const bedrock = readFileSync(new URL("./api/bedrock-converse-stream.js", import.meta.resolve("@earendil-works/pi-ai")), "utf8");
	assert.match(bedrock, /type: "bedrock_response_failure"/);
	assert.match(bedrock, /details\.status = metadata\.httpStatusCode/);
	const root = tempDir("pi-failure-sdk-");
	const AuthStorage = await loadPiAuthStorage();
	const runtime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, AuthStorage, agentDir: root, modelsPath: join(root, "models.json"), readFile: () => "{}" });
	await runtime.setRuntimeApiKey("anthropic", "fake-key");
	const model = runtime.getModel("anthropic", "claude-sonnet-4-5-20250929");
	assert.ok(model);
	const settingsManager = pi.SettingsManager.inMemory(jobSettings({ maxRetries: 0, baseDelayMs: 1 }));
	const resourceLoader = new pi.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await resourceLoader.reload();
	const sessionManager = pi.SessionManager.inMemory(root);
	const observer = installProviderFailureObserver({ ModelRuntime: pi.ModelRuntime, now: () => NOW, rootSessionId: sessionManager.getSessionId(), fetch: async () => new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "rate limit" } }), { status: 429, headers: { "retry-after": "2" } }) });
	const meter = createUsageMeter({ rootSessionId: sessionManager.getSessionId(), allowedModels: [{ provider: model.provider, model: model.id }], maxCostMicros: 100000000 });
	const guardNotes = [];
	const guard = createPolicyGuard({ log: (event, fields) => guardNotes.push({ event, fields }), allowedModels: [{ provider: model.provider, model: model.id }], maxCostMicros: 100000000 });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime, meter, guard });
	assert.equal(installed.ok, true);
	let session;
	try {
		({ session } = await pi.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model, settingsManager, sessionManager, resourceLoader, tools: [] }));
		let terminal;
		const tools = createToolStartLatch();
		session.subscribe((event) => { terminal = captureTerminal(terminal, event); tools.observe(event); });
		await session.prompt("test");
		const outcome = decideExit({ terminal, meterStop: meter.state.stopReason });
		assert.equal(outcome.code, 1, `a fulfilled prompt is still a terminal provider failure: ${JSON.stringify(outcome)} terminal=${JSON.stringify(terminal)} guard=${JSON.stringify(guardNotes)}`);
		assert.deepEqual(observer.failure(terminal), { kind: "rate-limited", resetAt: NOW + 2000, ...(model.provider === "anthropic" ? { subscriptionProvider: "anthropic" } : {}) });
		assert.equal(observer.nonRootCalls, false);
		assert.equal(observer.rootCalls, 1);
		assert.equal(tools.toolsStarted, false);
		assert.equal(providerReplaySafe({ toolsStarted: tools.toolsStarted, observer, tokens: meter.snapshot() }), true, "the same policy/meter/observer stack as the runner must admit replay evidence");
	} finally { session?.dispose(); installed.uninstall(); observer.uninstall(); }
});

test("issue #1106: a provider's spending limit is one predicate's answer, and the credential rule and the failover evidence both ask it", () => {
	const keyLimit = '403: {"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys","code":403}';
	for (const [text, measured, expected, why] of [
		[BUDGET, { status: 403 }, true, "the measured workspace budget"],
		[BUDGET, null, true, "no measurement: the 403 that begins pi's message, as the credential rule reads it"],
		[keyLimit, { status: 403 }, true, "OpenRouter's per-key limit"],
		[piText(402, OPENROUTER_CREDITS_402), { status: 402 }, true, "a measured 402 whatever its body"],
		[piText(402, OPENROUTER_CREDITS_402), null, false, "a 402 only when measured"],
		[BUDGET, { status: 500 }, false, "a measured status other than 402 or 403"],
		[BUDGET, { connection: true }, false, "no HTTP answer"],
		['403: {"message":"Workspace monthly budget of $50.00 exceeded.","code":"invalid_api_key"}', { status: 403 }, false, "an explicit credential wording wins"],
		[piText(403, OPENROUTER_UPSTREAM_403), { status: 403 }, false, "OpenRouter's upstream 403"],
		[piText(403, OPENAI_NOT_ALLOWED_403), { status: 403 }, false, "a permission refusal"],
		['403: {"message":"Forbidden","metadata":{"raw":"Workspace monthly budget of $50.00 exceeded."}}', { status: 403 }, false, "the wording in another field"],
		['403: {"message":"Note: Workspace monthly budget of $50.00 exceeded."}', { status: 403 }, false, "the wording not at the start"],
		[sdkText(403, OPENROUTER_MESSAGES_403), { status: 403 }, true, "the measured budget through anthropic-messages: `error.message`"],
		[sdkText(403, OPENROUTER_MESSAGES_403), null, true, "the same with no measurement"],
		['403 {"message":"Workspace monthly budget of $50.00 exceeded."}', { status: 403 }, true, "either form, either place"],
		[sdkText(403, ANTHROPIC_PERMISSION_403), { status: 403 }, false, "Anthropic's own permission_error: the wording decides, never the type"],
		['403 {"error":{"error":{"message":"Workspace monthly budget of $50.00 exceeded."}}}', { status: 403 }, false, "nested deeper than measured"],
		['403 {"error":"Workspace monthly budget of $50.00 exceeded."}', { status: 403 }, false, "an `error` that is a string, not an object"],
		["403: Workspace monthly budget of $50.00 exceeded.", { status: 403 }, false, "no JSON body"],
	]) assert.equal(providerSpendLimit(error(text), measured), expected, why);
	// The failover evidence: a used-up quota, read before the 401/403 rule; a measured reset rides along as for any quota.
	assert.deepEqual(classifyProviderFailure(error(BUDGET), { status: 403 }), { kind: "quota-exhausted" });
	assert.deepEqual(classifyProviderFailure(error(BUDGET), { status: 403, resetAt: NOW + 5000 }), { kind: "quota-exhausted", resetAt: NOW + 5000 });
	assert.deepEqual(classifyProviderFailure(error(piText(402, OPENROUTER_CREDITS_402)), { status: 402 }), { kind: "quota-exhausted" });
	assert.equal(classifyProviderFailure(error(piText(401, OPENAI_INVALID_KEY_401)), { status: 401 }), null);
	assert.equal(classifyProviderFailure(error(piText(403, OPENAI_NOT_ALLOWED_403)), { status: 403 }), null);
	// The outcome: the infrastructure exit with the provider's message, never a credential refusal, under pi's own verdict
	// that the error is permanent; a refused credential is unchanged.
	const permanent = () => false;
	assert.deepEqual(classifyStopReason(error(BUDGET), permanent, { status: 403 }), { code: 1, reason: "error", message: BUDGET });
	assert.deepEqual(decideExit({ terminal: error(BUDGET), isRetryable: permanent, measured: { status: 403 } }), { code: 1, reason: "error", message: BUDGET });
	assert.equal(classifyStopReason(error(keyLimit), permanent, { status: 403 }).reason, "error");
	assert.equal(classifyStopReason(error(piText(401, OPENAI_INVALID_KEY_401)), permanent, { status: 401 }).reason, "provider-auth-refused");
	assert.equal(classifyStopReason(error(piText(403, OPENAI_NOT_ALLOWED_403)), permanent, { status: 403 }).reason, "provider-auth-refused");
	assert.equal(classifyStopReason(error(sdkText(403, OPENROUTER_MESSAGES_403)), permanent, { status: 403 }).reason, "error");
	assert.deepEqual(classifyProviderFailure(error(sdkText(403, OPENROUTER_MESSAGES_403)), { status: 403 }), { kind: "quota-exhausted" });
	assert.equal(classifyStopReason(error(sdkText(403, ANTHROPIC_PERMISSION_403)), permanent, { status: 403 }).reason, "provider-auth-refused");
	assert.equal(classifyProviderFailure(error(sdkText(403, ANTHROPIC_PERMISSION_403)), { status: 403 }), null);
});

test("issue #1106: the measured budget 403 through pi's real openai-completions and anthropic-messages on loopback is a used-up quota, and a refused key is still a refusal", { skip: !pi }, async () => {
	let answer = { status: 500, body: "{}" };
	let calls = 0;
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			calls += 1;
			res.writeHead(answer.status, { "content-type": "application/json" });
			res.end(answer.body);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const root = tempDir("pi-spend-limit-");
	const modelsPath = join(root, "models.json");
	// OpenRouter's own catalog entry, its baseUrl pointed at the loopback server.
	writeFileSync(modelsPath, JSON.stringify({ providers: { openrouter: { baseUrl: `http://127.0.0.1:${server.address().port}/api/v1` } } }));
	const isRetryable = await loadRetryPredicate({ candidates: resolvePiAiCompat() });
	assert.equal(typeof isRetryable, "function");
	try {
		const AuthStorage = await loadPiAuthStorage();
		const runtime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, AuthStorage, agentDir: root, modelsPath, readFile: () => "{}" });
		await runtime.setRuntimeApiKey("openrouter", "sk-or-v1-test-not-a-key");
		// The model the issue's jobs drew, on openai-completions, and one of OpenRouter's anthropic-messages models.
		const completions = runtime.getModel("openrouter", "deepseek/deepseek-v4.1-flash-1017");
		const messages = runtime.getModel("openrouter", "anthropic/claude-opus-5.5");
		assert.deepEqual([completions?.api, messages?.api], ["openai-completions", "anthropic-messages"]);
		for (const [model, status, body, text, want, failure] of [
			[completions, 403, OPENROUTER_BUDGET_403, piText, { code: 1, reason: "error" }, { kind: "quota-exhausted" }],
			[completions, 402, OPENROUTER_CREDITS_402, piText, { code: 1, reason: "error" }, { kind: "quota-exhausted" }],
			[completions, 401, OPENAI_INVALID_KEY_401, piText, { code: 2, reason: "provider-auth-refused" }, null],
			[completions, 403, OPENROUTER_UPSTREAM_403, piText, { code: 1, reason: "error" }, null],
			[messages, 403, OPENROUTER_MESSAGES_403, sdkText, { code: 1, reason: "error" }, { kind: "quota-exhausted" }],
			[messages, 403, ANTHROPIC_PERMISSION_403, sdkText, { code: 2, reason: "provider-auth-refused" }, null],
		]) {
			answer = { status, body };
			const before = calls;
			const settingsManager = pi.SettingsManager.inMemory(jobSettings({ maxRetries: 0, baseDelayMs: 1 }));
			const resourceLoader = new pi.DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
			await resourceLoader.reload();
			const sessionManager = pi.SessionManager.inMemory(root);
			const observer = installProviderFailureObserver({ ModelRuntime: pi.ModelRuntime, rootSessionId: sessionManager.getSessionId() });
			let session;
			try {
				({ session } = await pi.createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model, settingsManager, sessionManager, resourceLoader, tools: [] }));
				let terminal;
				session.subscribe((event) => { terminal = captureTerminal(terminal, event); });
				await session.prompt("test");
				assert.equal(calls, before + 1, `${status}: one call reached the loopback provider`);
				assert.equal(terminal?.errorMessage, text(status, body), `${model.api} ${status}: pi's message, as each adapter forms it`);
				assert.deepEqual(observer.measured(terminal), { status }, `${status}: what the observer measured`);
				const outcome = decideExit({ terminal, isRetryable, measured: observer.measured(terminal) });
				assert.deepEqual({ code: outcome.code, reason: outcome.reason }, want, `${status} ${body}`);
				assert.deepEqual(observer.failure(terminal), failure, `${status} ${body}`);
			} finally {
				session?.dispose();
				observer.uninstall();
			}
		}
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

for (const [model, body, said] of [["deepseek/deepseek-v4.1-flash-1017", OPENROUTER_BUDGET_403, BUDGET], ["anthropic/claude-opus-5.5", OPENROUTER_MESSAGES_403, sdkText(403, OPENROUTER_MESSAGES_403)]]) {
	test(`issue #1106: the real run-job.mjs ends the measured budget 403 on openrouter/${model} as exit 1 with quota-exhausted evidence and the provider's message`, { skip: !pi }, async () => {
		let calls = 0;
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				calls += 1;
				res.writeHead(403, { "content-type": "application/json" });
				res.end(body);
			});
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const base = `http://127.0.0.1:${server.address().port}/api/v1`;
			const root = jobTree({ base });
			writeFileSync(join(root, "opt", "pi-global", "models.json"), `${JSON.stringify({ providers: { openrouter: { baseUrl: base } } })}\n`);
			const { code, exit, stderr } = await runRealJob(root, { PI_PROVIDER: "openrouter", PI_MODEL: model, OPENROUTER_API_KEY: "sk-or-v1-test-not-a-key" });
			assert.equal(calls, 1, "one refused call, then the job ends");
			assert.equal(code, 1, `${JSON.stringify(exit)}\n${stderr}`);
			assert.deepEqual([exit.code, exit.reason], [1, "error"], "the infrastructure exit, not provider-auth-refused");
			assert.deepEqual(exit.providerFailure, { kind: "quota-exhausted" });
			assert.equal(exit.message, said, "the provider's message rides the line for the worker");
			assert.deepEqual([exit.toolsStarted, exit.replaySafe], [false, true]);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
}

test("the image failover capability is backed by an offline signed normal-entrypoint conformance run", () => {
	const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	const label = dockerfile.match(/LABEL dev\.pi-dispatch\.capabilities="([^"]+)"/)[1].split(",");
	assert.ok(label.includes("modelFailover"));
	const verifier = readFileSync(new URL("../../verify-image.sh", import.meta.url), "utf8");
	const branch = verifier.match(/\n\t\t\tmodelFailover\)([\s\S]*?)\n\t\t\t\t;;/)[1];
	for (const expected of ["--network none", "PI_EXIT_AUTH=stdin", "provider-failure-fetch.mjs", '"toolsStarted":false', '"replaySafe":true', '"kind":"rate-limited"', "openssl dgst -sha256 -hmac"]) assert.ok(branch.includes(expected), expected);
	const runner = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(runner, /outcome\.code === EXIT_INFRA && outcome\.reason === "error" \? failureObserver\.failure\(terminal\) : null/);
	assert.match(runner, /exitWriter\.writeExit\(\{[^\n]*replaySafe, toolsStarted: toolStarts\.toolsStarted, \.\.\.\(providerFailure \? \{ providerFailure \} : \{\}\)/);
});
