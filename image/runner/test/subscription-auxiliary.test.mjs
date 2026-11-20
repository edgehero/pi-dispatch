import assert from "node:assert/strict";
import { test } from "node:test";
import { createPolicyGuard } from "../src/usage-meter.mjs";
import { COST_CAP, MODEL_NOT_ALLOWED } from "../src/outcome.mjs";

const instant = 1_800_000_000_000;
const now = () => instant;
const native = { provider: "openai", id: "native-fixture", api: "openai-responses", baseUrl: "https://api.openai.com/v1", maxTokens: 1000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
const auxiliary = { ...native, provider: "openrouter", id: "vendor/auxiliary-fixture", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", compat: { maxTokensField: "max_tokens" } };
const allowedModels = [native, auxiliary].map(({ provider, id }) => ({ provider, model: id }));
const subscriptions = [{ provider: "openai", adapter: "openai-chatgpt", connectionId: "fixture", generation: 1, expiresAt: instant + 3_600_000, deadlineAt: instant + 1_800_000 }];
const options = { allowedModels, subscriptions, now, env: { OPENAI_API_KEY: "fixture.oauth.access" }, subscriptionAdmission: provider => provider === "openai" };
const call = (model, extra = {}) => ({ method: "streamSimple", model, args: [{ messages: [{ role: "user", content: "fixture" }] }, { maxTokens: 10, ...extra }] });

test("a subscription and an explicit paid auxiliary route share the existing model and cost guards", async () => {
	const guard = createPolicyGuard({ ...options, maxCostMicros: 1_000_000 });
	assert.deepEqual([...guard.enforces], [MODEL_NOT_ALLOWED, COST_CAP]);
	for (const model of [native, auxiliary]) {
		const request = call(model);
		assert.equal(guard.admit(request), null);
		const prepared = guard.prepare({ ...request, stop: reason => assert.fail(reason) });
		assert.equal(typeof prepared[1].onPayload, "function", "both routes retain the final wire checks");
		await prepared[1].onPayload({ model: model.id, ...(model === native ? { max_output_tokens: 10, input: [] } : { max_tokens: 10, messages: [] }) });
		assert.ok(guard.spend().inflightMicros > 0, "the paid route gets a reservation too");
		guard.bind({ result: () => Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.000003 } } }) });
		await new Promise(resolve => setImmediate(resolve));
	}
	assert.equal(guard.spend().spentMicros, 6);
	assert.equal(guard.spend().inflightMicros, 0);
	assert.equal(guard.snapshot().costRefused, 0);
	assert.equal(guard.snapshot().modelRefused, 0);
});

test("auxiliary permission never bypasses an off-list route or the shared cost cap", () => {
	const guard = createPolicyGuard({ ...options, maxCostMicros: 1_000_000 });
	assert.equal(guard.admit(call({ ...auxiliary, id: "vendor/unlisted" })), MODEL_NOT_ALLOWED);
	assert.equal(guard.snapshot().modelRefused, 1);
	assert.equal(guard.spend().inflightMicros, 0);
	const capped = createPolicyGuard({ ...options, maxCostMicros: 1 });
	assert.equal(capped.admit(call(auxiliary)), COST_CAP);
	assert.equal(capped.snapshot().modelRefused, 0);
	assert.equal(capped.snapshot().costRefused, 1);
});

test("adding a paid auxiliary route retains native subscription registration and credential restrictions", () => {
	const guard = createPolicyGuard({ ...options, maxCostMicros: 1_000_000 });
	assert.equal(guard.admit(call(native, { apiKey: "another-key" })), MODEL_NOT_ALLOWED);
	assert.equal(guard.admit(call({ ...native, baseUrl: "https://proxy.invalid/v1" })), MODEL_NOT_ALLOWED);
	const unsealed = createPolicyGuard({ ...options, maxCostMicros: 1_000_000, subscriptionAdmission: () => false });
	assert.equal(unsealed.admit(call(native)), MODEL_NOT_ALLOWED);
	assert.equal(unsealed.admit(call(auxiliary)), null, "an unrelated API provider is not a subscription adapter");
});
