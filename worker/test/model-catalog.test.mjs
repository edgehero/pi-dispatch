import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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
	// A transient read holds up a builtin job too (issue #552): the file may route its provider.
	const eio = () => {
		throw Object.assign(new Error("EIO"), { code: "EIO" });
	};
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-haiku-4-5", main: true }], { readOverlay: eio }), { unavailable: "EIO" });
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
	// And builtins too since issue #539: pi drops every entry with the file, so no job runs until it is fixed.
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-haiku-4-5" }], { readOverlay: () => readOverlayModels(overlayDir("{ not json")) }), { unknown: { provider: "anthropic", id: "claude-haiku-4-5" }, why: "overlay-unparseable" });
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
	const emfile = () => {
		throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
	};
	const fable = { provider: "anthropic", id: "claude-fable-5" };
	// The overlay might clear fable-5's fallbacks, so the answer waits for a read that works.
	assert.deepEqual(checkModelsKnown([{ ...fable, main: true }, fable], { readOverlay: emfile }), { unavailable: "EMFILE" });
	// No list: retried too since issue #552, since the file may route the provider.
	assert.deepEqual(checkModelsKnown([{ ...fable, main: true }], { readOverlay: emfile }), { unavailable: "EMFILE" });
});

test("an overlay the worker cannot read refuses every job, unless the errno is one a moment can clear (issue #552)", () => {
	const gpt = { provider: "openai", id: "gpt-4o" };
	const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
	const qwen = { provider: "ollama", id: "qwen3:0.6b" };
	const jobs = [[{ ...gpt, main: true }], [{ ...haiku, main: true }, gpt], [{ ...qwen, main: true }]];
	const throwing = (code) => () => {
		throw Object.assign(new Error(`${code}: read failed`), { code });
	};
	// The job loads none of the file over each of these (models-json.test.mjs pins EACCES against the runner's choice and
	// pi's loader), and an errno nobody listed is judged the same way: fail closed, never a job that runs.
	for (const code of ["EACCES", "EPERM", "EROFS", "ESTALE", "EWHATEVER"]) {
		for (const refs of jobs) {
			assert.deepEqual(checkModelsKnown(refs, { readOverlay: throwing(code) }), { unknown: { provider: refs[0].provider, id: refs[0].id }, why: "overlay-unreadable" }, `${code}: ${refs[0].provider}`);
		}
	}
	// The transient errnos, listed: every job retries, builtin ones included, and none is refused.
	for (const code of ["EIO", "EAGAIN", "EMFILE", "ENFILE"]) {
		for (const refs of jobs) assert.deepEqual(checkModelsKnown(refs, { readOverlay: throwing(code) }), { unavailable: code }, `${code}: ${refs[0].provider}`);
	}
	// Absence is still no overlay.
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(overlayDir()) }), { ok: true });
});

test("a real mode-000 overlay or a folder without search permission refuses every job; a folder path that loops or runs through a file is no overlay (issue #552)", { skip: typeof process.getuid === "function" && process.getuid() === 0 ? "root reads a mode-000 file" : false }, () => {
	const gpt = { provider: "openai", id: "gpt-4o" };
	const refused = { unknown: gpt, why: "overlay-unreadable" };
	const proxy = JSON.stringify({ providers: { openai: { baseUrl: "http://proxy.lan:8080/v1" } } });
	const file = overlayDir(proxy);
	chmodSync(join(file, "models.json"), 0o000);
	try {
		assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(file) }), refused, "a mode-000 file");
	} finally {
		chmodSync(join(file, "models.json"), 0o600);
	}
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(file) }), { ok: true }, "readable again, it runs");
	const parent = overlayDir();
	const inner = join(parent, "overlay");
	mkdirSync(inner);
	writeFileSync(join(inner, "models.json"), proxy);
	chmodSync(inner, 0o600);
	try {
		assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(inner) }), refused, "a folder without x");
	} finally {
		chmodSync(inner, 0o700);
	}
	// What the job reads as no file is no overlay (PR #553's review): with models.json never a link, ELOOP and ENOTDIR come
	// only from the folder's path, and the runner's existsSync is false for them. No content is lost.
	const loop = join(overlayDir(), "loop");
	symlinkSync(loop, loop);
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(loop) }), { ok: true }, "a folder path that loops (ELOOP)");
	const plainFile = join(overlayDir(), "plain");
	writeFileSync(plainFile, "x");
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(plainFile) }), { ok: true }, "a folder path through a file (ENOTDIR)");
});

test("a models.json that is a link of any kind refuses every job; the file itself, or a folder that is a link, runs (PR #553's review)", () => {
	const gpt = { provider: "openai", id: "gpt-4o" };
	const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
	const qwen = { provider: "ollama", id: "qwen3:0.6b" };
	const proxy = JSON.stringify({ providers: { openai: { baseUrl: "http://proxy.lan:8080/v1" } } });
	const outsideDir = overlayDir(proxy);
	const linked = (target) => {
		const dir = overlayDir();
		writeFileSync(join(dir, "real.json"), proxy);
		symlinkSync(typeof target === "function" ? target(dir) : target, join(dir, "models.json"));
		return dir;
	};
	for (const [label, dir] of [
		["absolute inside", linked((dir) => join(dir, "real.json"))],
		["absolute outside", linked(join(outsideDir, "models.json"))],
		["relative inside", linked("real.json")],
		["relative outside", linked((dir) => relative(dir, join(outsideDir, "models.json")))],
		["dangling: a link, not absence", linked("nowhere.json")],
	]) {
		for (const refs of [[{ ...gpt, main: true }], [{ ...haiku, main: true }, gpt], [{ ...qwen, main: true }]]) {
			assert.deepEqual(checkModelsKnown(refs, { readOverlay: () => readOverlayModels(dir) }), { unknown: { provider: refs[0].provider, id: refs[0].id }, why: "overlay-link" }, `${label}: ${refs[0].provider}`);
		}
	}
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(overlayDir(proxy)) }), { ok: true }, "a plain file");
	const folderLink = join(overlayDir(), "overlay-link");
	symlinkSync(outsideDir, folderLink);
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(folderLink) }), { ok: true }, "the overlay folder is a link");
});

test("a models.json that is a named pipe, socket or device refuses every job, never opened (issue #556)", () => {
	const gpt = { provider: "openai", id: "gpt-4o" };
	const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
	const qwen = { provider: "ollama", id: "qwen3:0.6b" };
	const fifo = { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false };
	const readOverlay = () => readOverlayModels(overlayDir(), { lstatSync: () => fifo, readFileSync: () => assert.fail("opened") });
	for (const refs of [[{ ...gpt, main: true }], [{ ...haiku, main: true }, gpt], [{ ...qwen, main: true }]]) {
		assert.deepEqual(checkModelsKnown(refs, { readOverlay }), { unknown: { provider: refs[0].provider, id: refs[0].id }, why: "overlay-not-a-file" }, refs[0].provider);
	}
});

test("an overlay pi drops, for any reason, refuses every job until it is fixed (issue #539)", () => {
	// PR #546's review, after its third round: which providers a broken file meant to route cannot be read from
	// it, so no job runs. pi drops every one of these (pinned against pi in models-json.test.mjs).
	const gpt = { provider: "openai", id: "gpt-4o" };
	const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
	const qwen = { provider: "ollama", id: "qwen3:0.6b" };
	const proxy = '{ "baseUrl": "http://proxy.lan:8080/v1" }';
	for (const [label, text] of [
		["a schema error under another provider", `{ "providers": { "openai": ${proxy}, "lan": { "models": [ { "id": "m", "contextWindow": "big" } ] } } }`],
		["a block comment", `/* team proxy */ { "providers": { "openai": ${proxy} } }`],
		["a truncated write", `{ "providers": { "openai": { "baseUrl": "http://proxy.la`],
		["a UTF-16 save (PowerShell 5.1's default)", Buffer.from(`﻿{ "providers": { "openai": ${proxy} } }`, "utf16le")],
		["a valid entry for an unrelated provider beside an error", `{ "providers": { "lan": ${proxy}, "z": 7 } }`],
		["an empty file", ""],
		["whitespace only", " \n\t\r\n"],
		["a byte order mark only", "﻿"],
	]) {
		const readOverlay = () => readOverlayModels(overlayDir(text));
		assert.throws(readOverlay, (e) => e.piDispatchConfig === true, `${label}: pi would drop it`);
		assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay }), { unknown: gpt, why: "overlay-unparseable" }, `${label}: a builtin main model`);
		assert.deepEqual(checkModelsKnown([{ ...haiku, main: true }, gpt], { readOverlay }), { unknown: haiku, why: "overlay-unparseable" }, `${label}: a provider the file never mentions`);
		assert.deepEqual(checkModelsKnown([{ ...qwen, main: true }], { readOverlay }), { unknown: qwen, why: "overlay-unparseable" }, `${label}: an overlay model`);
	}
	// A directory: pi fails to read it the same way, so every job is refused too, with its own why, never retried.
	const dir = overlayDir();
	mkdirSync(join(dir, "models.json"));
	assert.deepEqual(checkModelsKnown([{ ...haiku, main: true }], { readOverlay: () => readOverlayModels(dir) }), { unknown: haiku, why: "overlay-is-a-directory" });
	// A valid file and an absent one are unchanged.
	const valid = () => readOverlayModels(overlayDir(`{ "providers": { "openai": ${proxy} } }`));
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }, haiku], { readOverlay: valid }), { ok: true });
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(overlayDir()) }), { ok: true });
	// A transient read is still no verdict: every job retries (issue #552), a builtin one with no list included.
	const eio = () => {
		throw Object.assign(new Error("EIO"), { code: "EIO" });
	};
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: eio }), { unavailable: "EIO" });
	assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }, qwen], { readOverlay: eio }), { unavailable: "EIO" });
});
