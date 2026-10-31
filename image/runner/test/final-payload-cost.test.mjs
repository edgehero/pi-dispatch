import assert from "node:assert/strict";
import { test } from "node:test";
import { callCostBound, createCostGuard, createPolicyGuard } from "../src/usage-meter.mjs";
import { COST_CAP } from "../src/outcome.mjs";
import { SONNET_4_5, GPT_5_4 } from "./helpers/catalog-models.mjs";

const context = { messages: [{ role: "user", content: "hello" }] };
const call = (model, options = {}) => ({ method: "streamSimple", model, args: [context, options] });
test("final serialized body growth is refused before the transport, using the same reservation", async () => {
	const original = callCostBound("streamSimple", SONNET_4_5, context, { maxTokens: 100 }, {});
	const guard = createCostGuard({ capMicros: original + 1000, env: {} });
	const request = call(SONNET_4_5, { maxTokens: 100, onPayload: (payload) => ({ ...payload, system: "x".repeat(100_000) }) });
	assert.equal(guard.admit(request), null);
	let reason = null;
	let sends = 0;
	const options = guard.prepare({ ...request, stop: (value) => { reason = value; } })[1];
	await assert.rejects(async () => { const body = await options.onPayload({ model: SONNET_4_5.id, max_tokens: 100, messages: [] }); JSON.stringify(body); sends += 1; });
	assert.equal(reason, COST_CAP);
	assert.equal(sends, 0);
	assert.equal(guard.spend().inflightMicros, original);
	guard.bind(undefined);
	assert.equal(guard.spend().inflightMicros, 0);
	assert.equal(guard.spend().spentMicros, original);
});
test("concurrent final payload reservations include other calls and never charge a ticket twice", async () => {
	const guard = createCostGuard({ capMicros: 300_000, env: {} });
	const request = call(SONNET_4_5, { maxTokens: 100 });
	assert.equal(guard.admit(request), null);
	const first = guard.prepare({ ...request, stop() {} })[1];
	let finish;
	guard.bind({ result: () => new Promise((resolve) => { finish = resolve; }) });
	assert.equal(guard.admit(request), null);
	const second = guard.prepare({ ...request, stop() {} })[1];
	guard.bind(new Promise(() => {}));
	await first.onPayload({ model: SONNET_4_5.id, max_tokens: 100, system: "a".repeat(50_000) });
	const held = guard.spend().inflightMicros;
	await assert.rejects(() => second.onPayload({ model: SONNET_4_5.id, max_tokens: 100, system: "b".repeat(50_000) }));
	assert.equal(guard.spend().inflightMicros, held);
	finish({ usage: { input: 1, output: 2, cost: { total: 0.00002 } }, stopReason: "stop", content: [{ type: "text", text: "ok" }] });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(guard.spend().spentMicros, 20);
});
test("model and caller hooks run before the final cost check; permitted JSON is the measured JSON", async () => {
	const guard = createPolicyGuard({ maxCostMicros: 1_000_000, allowedModels: [{ provider: SONNET_4_5.provider, model: SONNET_4_5.id }], env: {} });
	const request = call(SONNET_4_5, { maxTokens: 100, cacheRetention: "long", onPayload: (payload) => { payload.system = "retained hard rule"; } });
	assert.equal(guard.admit(request), null);
	const options = guard.prepare({ ...request, stop() {} })[1];
	const body = await options.onPayload({ model: SONNET_4_5.id, max_tokens: 100, messages: [] });
	assert.equal(JSON.parse(JSON.stringify(body)).system, "retained hard rule");
	assert.ok(guard.spend().inflightMicros >= callCostBound("streamSimple", SONNET_4_5, { ...context, finalPayload: body }, request.args[1], {}));
});
test("ChatGPT omitted output limit stays bounded by catalog maximum after final shaping", async () => {
	const model = { ...GPT_5_4, baseUrl: "https://api.openai.com/v1" };
	const env = { OPENAI_API_KEY: "header.payload.signature" };
	const before = callCostBound("streamSimple", model, context, { maxTokens: 20 }, env);
	assert.ok(before > 0);
	const guard = createCostGuard({ capMicros: before + 100_000, env });
	const request = call(model, { maxTokens: 20 });
	assert.equal(guard.admit(request), null);
	const body = await guard.prepare({ ...request, stop() {} })[1].onPayload({ model: model.id, input: [] });
	assert.equal(body.max_output_tokens, undefined);
	assert.ok(guard.spend().inflightMicros >= before);
});

test("a final hook cannot remove or disable a local server's output cap", async () => {
	const model = { id: "local", provider: "local", api: "openai-completions", baseUrl: "http://localhost:1", maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" } };
	for (const disabled of [undefined, 0, -1, null]) {
		const guard = createCostGuard({ capMicros: 20_000, env: {} });
		const request = call(model, { maxTokens: 1 });
		assert.equal(guard.admit(request), null);
		const options = guard.prepare({ ...request, stop() {} })[1];
		await assert.rejects(() => options.onPayload({ model: model.id, max_tokens: disabled }));
		assert.equal(guard.refusedWhy(), "final-payload");
	}
});

test("final sampling multiplicity and one-hour cache writes are bounded from the wire", async () => {
	const model = { id: "hosted", provider: "openai", api: "openai-completions", baseUrl: "https://api.openai.com/v1", maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" } };
	const guard = createCostGuard({ capMicros: 20_000, env: {} });
	const request = call(model, { maxTokens: 1 });
	assert.equal(guard.admit(request), null);
	await assert.rejects(() => guard.prepare({ ...request, stop() {} })[1].onPayload({ model: model.id, max_tokens: 1, n: 100_000 }));
	const cached = createCostGuard({ capMicros: 100_000, env: {} });
	const cacheCall = call(SONNET_4_5, { maxTokens: 1, cacheRetention: "short" });
	assert.equal(cached.admit(cacheCall), null);
	const body = await cached.prepare({ ...cacheCall, stop() {} })[1].onPayload({ model: SONNET_4_5.id, max_tokens: 1, system: [{ type: "text", text: "cache", cache_control: { type: "ephemeral", ttl: "1h" } }] });
	const expected = callCostBound("streamSimple", SONNET_4_5, { ...context, finalPayload: body }, { maxTokens: 1, cacheRetention: "long" }, {});
	assert.equal(cached.spend().inflightMicros, expected);
});
