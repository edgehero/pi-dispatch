import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { tempDir } from "./helpers/temp-dir.mjs";
import { installSubscriptionCredentials, subscriptionRequestOverrides } from "../src/subscription-credentials.mjs";

const instant = 1_800_000_000_000;
const now = () => instant;
const entry = (provider) => ({ provider, adapter: provider === "openai" ? "openai-chatgpt" : "pi-anthropic-oauth@0.3.6", connectionId: provider, generation: 1, expiresAt: instant + 3600_000, deadlineAt: instant + 30 * 60_000 });
async function runtimeWith(config) {
	const root = tempDir("subscription-credentials-");
	const modelsPath = join(root, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: config }));
	return ModelRuntime.create({ modelsPath, allowModelNetwork: false, credentials: { async read() { return { type: "api_key", key: "stored-paid-api-key", env: { OPENAI_API_KEY: "stored-override" } }; }, async list() { return []; }, async modify() {}, async delete() {} } });
}

test("actual pinned auth and request preparation use selected access over stored and models.json keys/headers", async () => {
	const runtime = await runtimeWith({ openai: { apiKey: "configured-paid-api-key", headers: { Authorization: "Bearer configured-paid-api-key", "X-Api-Key": "configured-other-key", "OpenAI-Project": "another-project", "X-Trace": "fixture" } } });
	const token = "selected.oauth.access";
	const guard = installSubscriptionCredentials({ ModelRuntime, entries: [entry("openai")], env: { OPENAI_API_KEY: token }, now });
	try {
		const model = runtime.getModels("openai").find((row) => row.api === "openai-responses");
		assert.ok(model);
		const auth = await runtime.getAuth(model);
		assert.equal(auth.auth.apiKey, token);
		const prepared = await runtime.prepareRequest(model, {});
		assert.equal(prepared.options.apiKey, token);
		assert.equal(prepared.options.headers.Authorization, undefined);
		assert.equal(prepared.options.headers["X-Api-Key"], undefined);
		assert.equal(prepared.options.headers["OpenAI-Project"], undefined);
		for (const name of Object.keys(prepared.model.headers ?? {})) assert.equal(["authorization", "x-api-key", "openai-project"].includes(name.toLowerCase()), false);
		assert.equal(prepared.options.headers["X-Trace"], "fixture");
		assert.equal(prepared.model.baseUrl, "https://api.openai.com/v1");
	} finally { guard.uninstall(); await runtime.refresh({ allowNetwork: false }); }
});

test("actual pinned runtime refuses caller auth/env overrides, alternate routes and expired inference", async () => {
	const runtime = await runtimeWith({ openai: { apiKey: "unused" } });
	let current = instant;
	const token = "selected.oauth.access";
	const guard = installSubscriptionCredentials({ ModelRuntime, entries: [entry("openai")], env: { OPENAI_API_KEY: token }, now: () => current });
	try {
		const model = runtime.getModels("openai").find((row) => row.api === "openai-responses");
		for (const options of [{ apiKey: "sk-other-paid-key" }, { headers: { AUTHORIZATION: "Bearer other" } }, { env: { OPENAI_API_KEY: "sk-other-paid-key" } }, { env: { ANTHROPIC_AUTH_TOKEN: "other" } }]) {
			await assert.rejects(runtime.getAuth(model, options), /auth-request-override/);
			await assert.rejects(runtime.prepareRequest(model, options), /auth-request-override/);
		}
		await assert.rejects(runtime.prepareRequest({ ...model, baseUrl: "https://proxy.invalid/v1" }, {}), /auth-request-override/);
		current = instant + 31 * 60_000;
		await assert.rejects(runtime.prepareRequest(model, {}), /auth-request-override/);
	} finally { guard.uninstall(); await runtime.refresh({ allowNetwork: false }); }
});

test("Anthropic selected access outranks API key configuration and its auth headers", async () => {
	const runtime = await runtimeWith({ anthropic: { apiKey: "unused", headers: { "x-api-key": "paid-key", Authorization: "Bearer another", "anthropic-organization-id": "another-organization" } } });
	const token = "sk-ant-oat01-selected-access";
	const guard = installSubscriptionCredentials({ ModelRuntime, entries: [entry("anthropic")], env: { ANTHROPIC_OAUTH_TOKEN: token }, now });
	try {
		const model = runtime.getModels("anthropic")[0];
		const prepared = await runtime.prepareRequest(model, {});
		assert.equal(prepared.options.apiKey, token);
		for (const name of Object.keys(prepared.options.headers)) assert.equal(["authorization", "x-api-key", "anthropic-organization-id"].includes(name.toLowerCase()), false);
	} finally { guard.uninstall(); await runtime.refresh({ allowNetwork: false }); }
});

test("credential override predicate checks case-insensitive auth headers and preserves unrelated request settings", () => {
	assert.equal(subscriptionRequestOverrides({ apiKey: "selected", headers: { "X-Trace": "fixture" }, env: { PI_CACHE_RETENTION: "short" } }, "selected"), false);
	for (const name of ["Authorization", "X-API-KEY", "OpenAI-Organization", "Anthropic-Organization-Id"]) assert.equal(subscriptionRequestOverrides({ headers: { [name]: "other" } }, "selected"), true);
});
