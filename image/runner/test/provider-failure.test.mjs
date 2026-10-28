import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createJobModelRuntime, loadPiAuthStorage } from "../src/model-runtime.mjs";
import { captureTerminal, decideExit } from "../src/outcome.mjs";
import { jobSettings } from "../src/config.mjs";
import { createPolicyGuard, createUsageMeter, installProcessUsageMeter } from "../src/usage-meter.mjs";
import { classifyProviderFailure, createToolStartLatch, installProviderFailureObserver, MAX_RESET_MS, providerReplaySafe, resetFromHeaders } from "../src/provider-failure.mjs";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const error = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });

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

// Exercise the pinned runtime and real adapters: Anthropic's onResponse is not called on HTTP rejection.
// A type-only assertion would miss that exact failure and turn a short rate limit into a quota cooldown.
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
			assert.deepEqual(observer.failure(terminal), { kind: "rate-limited", resetAt: NOW + 2000 });
			if (api === "anthropic-messages") assert.equal(responseHooks, 0, "failure headers cannot rely on Anthropic onResponse");
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
		assert.deepEqual(observer.failure(terminal), { kind: "rate-limited", resetAt: NOW + 2000 });
		assert.equal(observer.nonRootCalls, false);
		assert.equal(observer.rootCalls, 1);
		assert.equal(tools.toolsStarted, false);
		assert.equal(providerReplaySafe({ toolsStarted: tools.toolsStarted, observer, tokens: meter.snapshot() }), true, "the same policy/meter/observer stack as the runner must admit replay evidence");
	} finally { session?.dispose(); installed.uninstall(); observer.uninstall(); }
});


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
