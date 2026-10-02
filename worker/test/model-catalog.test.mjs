import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getAllBuiltinModels, getBuiltinClassifierModels, getBuiltinImageModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { checkModelsKnown, declaredFallbacks, isBuiltinModel, knownModel } from "../src/model-catalog.mjs";
import { readOverlayModels } from "../src/model-endpoints.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #502 part 2: the model-exists gate's answer, from pi-ai's builtin catalog at the pin plus the overlay models.json.

const overlayDir = (text) => {
	const dir = tempDir("pi-overlay-");
	if (text !== undefined) writeFileSync(join(dir, "models.json"), text);
	return dir;
};
const OVERLAY = JSON.stringify({ providers: { openai: { models: [{ id: "qwen2.5:0.5b", baseUrl: "http://host.docker.internal:11434/v1" }] }, ollama: { baseUrl: "http://lan:11434/v1", api: "openai-completions", models: [{ id: "qwen3:0.6b" }] } } });

test("every builtin model at the pin is known, chat, image and classifier alike (the catalog is the oracle)", () => {
	let n = 0;
	for (const provider of getBuiltinProviders()) {
		for (const model of getAllBuiltinModels(provider)) {
			n += 1;
			assert.ok(knownModel({ provider, id: model.id }), `${provider}/${model.id}`);
		}
	}
	assert.ok(n > 1000, `walked ${n} ids`);
	// Named, so a reader sees the kinds getPricedModel would have missed.
	const classifier = getBuiltinClassifierModels("typesafe")[0];
	const image = getBuiltinImageModels("openrouter")[0];
	assert.ok(classifier && image, "the pin carries at least one classifier and one image model");
	assert.ok(isBuiltinModel("typesafe", classifier.id), "a classifier model on a list is a known model");
	assert.ok(isBuiltinModel("openrouter", image.id), "an image model on a list is a known model");
});

test("matching is exact on both halves: case, the provider, and prototype keys never pass", () => {
	assert.equal(knownModel({ provider: "anthropic", id: "claude-sonnet-4-5-20250929" }), true);
	assert.equal(knownModel({ provider: "anthropic", id: "Claude-Sonnet-4-5-20250929" }), false, "pi resolves ids case-sensitively");
	assert.equal(knownModel({ provider: "openai", id: "claude-sonnet-4-5-20250929" }), false, "a real id under the wrong provider is not a model");
	assert.equal(knownModel({ provider: "anthropic", id: "claude-sonnet-9" }), false);
	for (const [provider, id] of [["__proto__", "x"], ["constructor", "name"], ["anthropic", "__proto__"], [7, "x"], ["anthropic", null]]) {
		assert.equal(knownModel({ provider, id }), false, `${String(provider)}/${String(id)}`);
	}
});

test("an overlay models.json declares custom ids, under a custom provider or a builtin one", () => {
	const overlay = readOverlayModels(overlayDir(OVERLAY));
	assert.equal(knownModel({ provider: "openai", id: "qwen2.5:0.5b", overlay }), true, "an Ollama model under the builtin openai provider");
	assert.equal(knownModel({ provider: "ollama", id: "qwen3:0.6b", overlay }), true, "a custom provider's model");
	assert.equal(knownModel({ provider: "ollama", id: "qwen9:1b", overlay }), false);
	assert.equal(knownModel({ provider: "openai", id: "qwen2.5:0.5b" }), false, "without the overlay it is not known");
});

test("checkModelsKnown: the overlay is read at most once per job, builtin jobs included; the first unknown ref is named", () => {
	let reads = 0;
	const readOverlay = () => (reads++, JSON.parse(OVERLAY));
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-sonnet-4-5-20250929" }, { provider: "anthropic", id: "claude-haiku-4-5" }], { readOverlay }), { ok: true });
	assert.equal(reads, 1, "a builtin job reads it too, since its provider's entry decides whether pi keeps the operator's endpoint (PR #536's review, round 3)");
	assert.deepEqual(checkModelsKnown([{ provider: "openai", id: "qwen2.5:0.5b" }, { provider: "ollama", id: "qwen3:0.6b" }], { readOverlay }), { ok: true });
	assert.equal(reads, 2, "one read per job, however many refs need it");
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-sonnet-4-5-20250929" }, { provider: "ollama", id: "qwen9:1b" }], { readOverlay }), { unknown: { provider: "ollama", id: "qwen9:1b" }, why: "not-in-catalog" });
	// A transient read does not hold up a builtin job: there is no entry to judge.
	const eio = () => {
		throw Object.assign(new Error("EIO"), { code: "EIO" });
	};
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-haiku-4-5", main: true }], { readOverlay: eio }), { ok: true });
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-haiku-4-5", main: true }, { provider: "ollama", id: "qwen3:0.6b" }], { readOverlay: eio }), { unavailable: "EIO" });
});

test("an absent overlay is no overlay; an unparseable one refuses with its own why; a transient read is unavailable", () => {
	const ref = [{ provider: "ollama", id: "qwen3:0.6b" }];
	assert.deepEqual(checkModelsKnown(ref, { readOverlay: () => readOverlayModels(overlayDir()) }), { unknown: ref[0], why: "not-in-catalog" });
	// pi drops a whole models.json that fails its own validation, so a model only that file declares does not exist
	// in the job either. Refused, named as the file's fault rather than the id's.
	for (const text of ["{ not json", "[]", "null"]) {
		assert.deepEqual(checkModelsKnown(ref, { readOverlay: () => readOverlayModels(overlayDir(text)) }), { unknown: ref[0], why: "overlay-unparseable" }, text);
	}
	// And builtins still pass beside a broken overlay: the file is only read when a ref needs it.
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-haiku-4-5" }], { readOverlay: () => readOverlayModels(overlayDir("{ not json")) }), { ok: true });
	// A transient errno is no verdict: the processor retries it rather than refusing for good.
	const eio = () => {
		throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
	};
	assert.deepEqual(checkModelsKnown(ref, { readOverlay: eio }), { unavailable: "EIO" });
	// A defect is neither: it is rethrown, never turned into a permanent public refusal.
	assert.throws(() => checkModelsKnown(ref, { readOverlay: () => { throw new TypeError("bug"); } }), TypeError);
});

test("a listed model's server-side fallbacks must be listed too: claude-fable-5 is the one builtin that declares any", () => {
	// pi 0.99.1's catalog: exactly anthropic/claude-fable-5 declares compat.allowedFallbackModels.
	assert.deepEqual(declaredFallbacks("anthropic", "claude-fable-5"), ["claude-opus-4-8", "claude-opus-5"]);
	assert.deepEqual(declaredFallbacks("anthropic", "claude-haiku-4-5"), []);
	const fable = { provider: "anthropic", id: "claude-fable-5" };
	const opus48 = { provider: "anthropic", id: "claude-opus-4-8" };
	const opus5 = { provider: "anthropic", id: "claude-opus-5" };
	assert.deepEqual(checkModelsKnown([{ ...fable, main: true }, fable]), { fallbackUnlisted: fable, why: "fallback-unlisted" });
	assert.deepEqual(checkModelsKnown([{ ...fable, main: true }, fable, opus48]), { fallbackUnlisted: fable, why: "fallback-unlisted" }, "both fallbacks, not one");
	assert.deepEqual(checkModelsKnown([{ ...fable, main: true }, fable, opus48, opus5]), { ok: true });
	// No list (the main model alone): nothing to judge fallbacks against, as today.
	assert.deepEqual(checkModelsKnown([{ ...fable, main: true }]), { ok: true });
	// The pair is the MODEL's provider and the fallback id, which is all pi sends.
	const readOverlay = () => ({ providers: { proxy: { baseUrl: "http://127.0.0.1:1", api: "anthropic-messages", apiKey: "k", models: [{ id: "fable-like", compat: { allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-5" }] } }, { id: "claude-opus-5" }] } } });
	const proxied = { provider: "proxy", id: "fable-like" };
	assert.deepEqual(checkModelsKnown([{ ...proxied, main: true }, proxied, opus5], { readOverlay }), { fallbackUnlisted: proxied, why: "fallback-unlisted" }, "anthropic/claude-opus-5 is not proxy/claude-opus-5");
	assert.deepEqual(checkModelsKnown([{ ...proxied, main: true }, proxied, { provider: "proxy", id: "claude-opus-5" }], { readOverlay }), { ok: true });
});

test("declaredFallbacks reads the overlay the way pi composes it: provider compat, a model definition, then modelOverrides", () => {
	const overlay = (entry) => ({ providers: { anthropic: entry } });
	const fb = (...ids) => ({ allowedFallbackModels: ids.map((model) => ({ provider: "anthropic", model })) });
	assert.deepEqual(declaredFallbacks("anthropic", "claude-haiku-4-5", overlay({ compat: fb("x") })), ["x"], "the provider's compat reaches a builtin model");
	assert.deepEqual(declaredFallbacks("anthropic", "claude-fable-5", overlay({ modelOverrides: { "claude-fable-5": { compat: fb() } } })), [], "an override that empties the list");
	assert.deepEqual(declaredFallbacks("anthropic", "my-model", overlay({ models: [{ id: "my-model", compat: fb("y") }] })), ["y"]);
	assert.deepEqual(declaredFallbacks("anthropic", "my-model", overlay({ compat: fb("z"), models: [{ id: "my-model" }] })), ["z"], "a definition without its own compat takes the provider's");
	assert.deepEqual(declaredFallbacks("ollama", "qwen3:0.6b", null), []);
	// A definition that redefines a builtin id REPLACES that model, as pi composes it: without its own compat (and with
	// none on the provider) the builtin fallbacks are gone.
	assert.deepEqual(declaredFallbacks("anthropic", "claude-fable-5", overlay({ models: [{ id: "claude-fable-5" }] })), []);
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-fable-5", main: true }, { provider: "anthropic", id: "claude-fable-5" }], { readOverlay: () => overlay({ models: [{ id: "claude-fable-5" }] }) }), { ok: true });
});

test("a transient overlay read under a list is retried, never a permanent fallback-unlisted refusal", () => {
	const eacces = () => {
		throw Object.assign(new Error("EACCES"), { code: "EACCES" });
	};
	const fable = { provider: "anthropic", id: "claude-fable-5" };
	// The overlay might clear fable-5's fallbacks, so the answer waits for a read that works.
	assert.deepEqual(checkModelsKnown([{ ...fable, main: true }, fable], { readOverlay: eacces }), { unavailable: "EACCES" });
	// No list: nothing is judged that needs the overlay, as before.
	assert.deepEqual(checkModelsKnown([{ ...fable, main: true }], { readOverlay: eacces }), { ok: true });
});
