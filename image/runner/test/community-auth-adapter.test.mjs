import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifySubscriptionAuthEntries, validateSubscriptionRequest, installSubscriptionRegistrationGuard } from "../src/community-auth-adapter.mjs";

const instant = 1_800_000_000_000;
const now = () => instant;
const openai = () => ({ provider: "openai", adapter: "openai-chatgpt", connectionId: "chatgpt", generation: 1, expiresAt: instant + 3600_000, deadlineAt: instant + 30 * 60_000 });
const anthropic = () => ({ ...openai(), provider: "anthropic", adapter: "pi-anthropic-oauth@0.3.6", root: "/opt/pi-package", digest: "a".repeat(64) });

test("subscription metadata validates lifetime, provider ownership and exact adapter before extension loading", () => {
	let verified = 0;
	const entries = [openai(), anthropic()];
	assert.equal(verifySubscriptionAuthEntries(entries, { now, verify(args) { verified++; assert.equal(args.root, "/opt/pi-package"); assert.equal(args.digest, "a".repeat(64)); } }), entries);
	assert.equal(verified, 1);
	for (const row of [{ ...openai(), expiresAt: instant }, { ...openai(), deadlineAt: instant }, { ...openai(), generation: -1 }, { ...openai(), expiresAt: Infinity }, { ...openai(), adapter: "unreviewed" }, { ...anthropic(), adapter: "openai-chatgpt" }]) assert.throws(() => verifySubscriptionAuthEntries([row], { now, verify() {} }), /auth-/);
	assert.throws(() => verifySubscriptionAuthEntries([openai(), openai()], { now }), /auth-snapshot-invalid/);
	assert.throws(() => verifySubscriptionAuthEntries([anthropic()], { now, verify() { throw new Error("auth-adapter-unpinned"); } }), /auth-adapter-unpinned/);
});

test("subscription calls reject Decisions, alternate hosts and expired snapshots while unmanaged routes pass", () => {
	const entries = [openai()];
	assert.equal(validateSubscriptionRequest({ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }, entries, { now }), true);
	assert.equal(validateSubscriptionRequest({ provider: "openai", api: "openai-decisions", baseUrl: "https://api.openai.com/v1" }, entries, { now }), false);
	assert.equal(validateSubscriptionRequest({ provider: "openai", api: "openai-responses", baseUrl: "https://proxy.invalid/v1" }, entries, { now }), false);
	assert.equal(validateSubscriptionRequest({ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }, entries, { now: () => instant + 31 * 60_000 }), false);
	assert.equal(validateSubscriptionRequest({ provider: "other", api: "anything", baseUrl: "anything" }, entries, { now }), true);
});

test("worker and runner source pins and deterministic adaptations remain byte identical", () => {
	for (const file of ["community-auth-patches.mjs", "community-auth-metadata.mjs", "community-auth-pins.mjs", "community-auth-output-pins.mjs"]) assert.equal(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), readFileSync(new URL(`../../../worker/src/${file}`, import.meta.url), "utf8"));
});

const marker = Symbol.for("pi-dispatch.subscription-adapter");
function marked(adapter, fn = () => {}) { Object.defineProperty(fn, marker, { value: adapter }); return fn; }
class FakeRuntime {
	constructor() { this.configs = new Map(); }
	registerProvider(provider, config) { this.configs.set(provider, config); }
	registerNativeProvider(provider) { this.configs.set(provider.id, provider); }
	unregisterProvider(provider) { this.configs.delete(provider); }
	getRegisteredProviderConfig(provider) { return this.configs.get(provider); }
	getRegisteredProviderIds() { return [...this.configs.keys()]; }
}

test("registered adapter is mandatory before sealing and later provider mutation latches refusal", () => {
	const guard = installSubscriptionRegistrationGuard({ ModelRuntime: FakeRuntime, entries: [anthropic()] });
	try {
		const runtime = new FakeRuntime();
		assert.equal(guard.admitted("anthropic"), false);
		assert.throws(() => guard.seal(runtime), /auth-adapter-conflicting/);
		runtime.unregisterProvider("anthropic");
		runtime.registerProvider("anthropic", { api: "anthropic-messages", streamSimple: marked(anthropic().adapter) });
		guard.seal(runtime);
		assert.equal(guard.admitted("anthropic"), true);
		assert.throws(() => runtime.registerProvider("anthropic", { api: "anthropic-messages", streamSimple() {} }), /auth-adapter-conflicting/);
		assert.equal(guard.admitted("anthropic"), false);
	} finally { guard.uninstall(); }
});

test("conflicting earlier factories, wrong adapter markers and native overrides cannot be hidden by later registration", () => {
	for (const attempt of [(r) => r.registerProvider("anthropic", { api: "anthropic-messages", streamSimple() {} }), (r) => r.registerProvider("anthropic", { api: "anthropic-messages", streamSimple: marked("wrong") }), (r) => r.registerNativeProvider({ id: "anthropic" })]) {
		const guard = installSubscriptionRegistrationGuard({ ModelRuntime: FakeRuntime, entries: [anthropic()] });
		try {
			const runtime = new FakeRuntime();
			assert.throws(() => attempt(runtime), /auth-adapter-conflicting/);
			runtime.registerProvider("anthropic", { api: "anthropic-messages", streamSimple: marked(anthropic().adapter) });
			assert.throws(() => guard.seal(runtime), /auth-adapter-conflicting/);
		} finally { guard.uninstall(); }
	}
});

test("OpenAI extension overrides are refused while unrelated providers remain usable", () => {
	const guard = installSubscriptionRegistrationGuard({ ModelRuntime: FakeRuntime, entries: [openai()] });
	try {
		const runtime = new FakeRuntime();
		runtime.registerProvider("other", { streamSimple() {} });
		guard.seal(runtime);
		assert.equal(guard.admitted("openai"), true);
		assert.equal(guard.admitted("other"), true);
		assert.throws(() => runtime.unregisterProvider("openai"), /auth-adapter-conflicting/);
		assert.equal(guard.admitted("openai"), false);
	} finally { guard.uninstall(); }
});

test("actual pinned ModelRuntime composes the marked transport and catches direct config mutation", async () => {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
	const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
	const guard = installSubscriptionRegistrationGuard({ ModelRuntime, entries: [anthropic()] });
	try {
		let calls = 0;
		const streamSimple = marked(anthropic().adapter, (model) => {
			calls++;
			const stream = createAssistantMessageEventStream();
			const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: instant };
			stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream;
		});
		runtime.registerProvider("anthropic", { api: "anthropic-messages", streamSimple });
		guard.seal(runtime);
		assert.equal(guard.admitted("anthropic"), true);
		const model = runtime.getModels("anthropic")[0];
		const result = await runtime.streamSimple(model, { messages: [] }, { apiKey: "sk-ant-oat-fixture" }).result();
		assert.equal(calls, 1);
		assert.equal(result.model, model.id);
		const child = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} } });
		let wire = 0;
		assert.throws(() => child.streamSimple(model, { messages: [] }, { apiKey: "sk-ant-oat-fixture", fetch: async () => { wire++; throw new Error("must not dispatch"); } }), /auth-adapter-conflicting/);
		assert.equal(wire, 0);
		assert.equal(calls, 1);
		runtime.getRegisteredProviderConfig("anthropic").apiKey = "different-billing-key";
		assert.equal(guard.admitted("anthropic"), false);
	} finally { guard.uninstall(); await runtime.refresh({ allowNetwork: false }); }
});
