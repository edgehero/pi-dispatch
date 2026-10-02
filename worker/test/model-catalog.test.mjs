import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getAllBuiltinModels, getBuiltinClassifierModels, getBuiltinImageModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { checkModelsKnown, isBuiltinModel, knownModel } from "../src/model-catalog.mjs";
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
