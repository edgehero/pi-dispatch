import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { checkModelsKnown } from "../src/model-catalog.mjs";
import { readOverlayModels } from "../src/model-endpoints.mjs";
import { parseModelsJson, stripJsonComments } from "../src/models-json.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The DIFFERENTIAL bolt for `models-json.mjs` (issue #502, PR #536's review): the worker's reading of the overlay
 * `models.json` must agree with pi's own `ModelConfig.load` at the pin, file for file, in both directions. pi's module
 * is reached by path because the worker does not depend on pi-coding-agent; the workspace root installs it for the
 * runner, which is where CI runs this. A pi bump that moves the schema turns this red, never the worker silently.
 */
const PI = new URL("../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url);
// pi's runtime is asked about models only; it must never reach for the network or install anything while it is.
process.env.PI_OFFLINE = "1";
let ModelConfig;
let ModelRuntime;
let piStripJsonComments;
let piVersion;
let importError;
try {
	({ ModelConfig } = await import(new URL("dist/core/model-config.js", PI).href));
	({ ModelRuntime } = await import(new URL("dist/core/model-runtime.js", PI).href));
	({ stripJsonComments: piStripJsonComments } = await import(new URL("dist/utils/json.js", PI).href));
	piVersion = JSON.parse(readFileSync(new URL("package.json", PI), "utf8")).version;
} catch (error) {
	importError = error;
}
if (!ModelConfig && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`models-json differential tests are REQUIRED here but pi's model-config could not import.\n${importError}`);
}
const skip = ModelConfig ? false : `pi-coding-agent not installed at the workspace root (${importError?.message}); CI runs these`;

// A maximal valid document: every object in pi's schema appears, so a mutation of any leaf is a case.
const COST = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 };
const MAXIMAL = {
	providers: {
		ollama: {
			name: "Ollama",
			baseUrl: "http://gpu.lan:11434/v1",
			apiKey: "$PI_DISPATCH_KEYLESS",
			api: "openai-completions",
			headers: { "x-a": "b" },
			authHeader: true,
			compat: {
				supportsStore: false,
				maxTokensField: "max_tokens",
				thinkingFormat: "qwen",
				chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled", omitWhenOff: true }, temp: 1, flag: null },
				openRouterRouting: { allow_fallbacks: true, data_collection: "deny", order: ["a"], sort: { by: "price", partition: null }, max_price: { prompt: 1, completion: "2" }, preferred_min_throughput: { p50: 1 }, preferred_max_latency: 3 },
				vercelGatewayRouting: { only: ["x"] },
				sessionAffinityFormat: "openrouter",
				vllmPriority: 2,
			},
			models: [
				{
					id: "qwen2.5:0.5b",
					name: "Qwen",
					api: "openai-completions",
					baseUrl: "http://gpu.lan:11434/v1",
					reasoning: true,
					thinkingLevelMap: { off: null, low: "low" },
					input: ["text", "image"],
					inputLimits: { maxRequestBytes: 10, images: { resize: { maxWidth: 1, maxHeight: 1, maxBytes: 1, jpegQuality: 100 }, maxPerMessage: 1, maxPerRequest: 1 } },
					cost: { ...COST, tiers: [{ inputTokensAbove: 200000, ...COST }] },
					promptCache: { short: 1, long: 2 },
					contextWindow: 32768,
					maxTokens: 4096,
					samplingParams: { temperature: 0.2, anything: [1, { x: 2 }] },
					samplingParamsByThinkingLevel: { off: { temperature: 0 }, high: { max_tokens: 100, anything: [1] }, max: {} },
					headers: { "x-m": "n" },
					compat: { supportsEagerToolInputStreaming: true, allowedFallbackModels: [{ provider: "anthropic", model: "claude-x", cost: COST }] },
				},
			],
			modelOverrides: { "qwen2.5:0.5b": { name: "Q", cost: { input: 1 }, contextWindow: 1, samplingParamsByThinkingLevel: { low: { top_p: 0.5 } }, compat: { supportsMaxOutputTokens: true } } },
		},
		radius: { oauth: "radius" },
	},
};

// Files that pass pi's SCHEMA and then fail, or not, at pi's provider COMPOSITION (provider-composer.js
// applyModelsJson/modelFromJson). pi keeps the provider's builtin models and drops every model the overlay added.
const COMPOSITION = {
	"custom provider, no api": { providers: { ollama: { baseUrl: "http://gpu:11434/v1", apiKey: "k", models: [{ id: "qwen" }] } } },
	"custom provider, no baseUrl": { providers: { ollama: { api: "openai-completions", apiKey: "k", models: [{ id: "qwen" }] } } },
	"custom model contextWindow 0": { providers: { ollama: { baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen", contextWindow: 0 }] } } },
	"custom model maxTokens -1": { providers: { ollama: { baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen", maxTokens: -1 }] } } },
	"model-level api and baseUrl only": { providers: { ollama: { models: [{ id: "qwen", api: "openai-completions", baseUrl: "http://gpu:11434/v1" }] } } },
	"second model inherits from the first": { providers: { ollama: { models: [{ id: "a", api: "openai-completions", baseUrl: "http://gpu:11434/v1" }, { id: "b" }] } } },
	"first model lacks what the second has": { providers: { ollama: { models: [{ id: "a" }, { id: "b", api: "openai-completions", baseUrl: "http://gpu:11434/v1" }] } } },
	"sibling provider broken": { providers: { ollama: { baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen" }] }, other: { models: [{ id: "x" }] } } },
	"builtin provider, empty entry": { providers: { openai: {} } },
	"builtin provider, custom model maxTokens 0": { providers: { openai: { models: [{ id: "my-ft", maxTokens: 0 }] } } },
	"builtin provider, custom model inherits": { providers: { openai: { models: [{ id: "my-ft" }] } } },
	"builtin provider, custom model, foreign api": { providers: { anthropic: { models: [{ id: "my-ft", api: "openai-completions" }] } } },
	"oauth without baseUrl": { providers: { ollama: { oauth: "radius", api: "openai-completions", models: [{ id: "qwen", baseUrl: "http://gpu:11434/v1" }] } } },
	"oauth with baseUrl": { providers: { ollama: { oauth: "radius", baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen" }] } } },
	"radius builtin, custom model": { providers: { radius: { oauth: "radius", baseUrl: "http://gpu:11434/v1", models: [{ id: "qwen" }] } } },
	"authHeader only": { providers: { openai: { authHeader: false } } },
	"overrides only, on a custom provider": { providers: { ollama: { modelOverrides: { qwen: { contextWindow: 0 } } } } },
	// pi 1.0.3 renamed the Azure provider to `azure` (issue #587): a block under the old id that only moves the baseUrl
	// is now a custom provider of its own, with no models, and the builtin azure models keep an empty baseUrl.
	"old azure id, baseUrl only": { providers: { "azure-openai-responses": { baseUrl: "https://example.openai.azure.com/openai/v1" } } },
	"new azure id, baseUrl only": { providers: { azure: { baseUrl: "https://example.openai.azure.com/openai/v1" } } },
};

// Every path to a value in a document, objects and arrays included.
function paths(value, at = []) {
	const out = [at];
	if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) out.push(...paths(v, [...at, Array.isArray(value) ? Number(k) : k]));
	return out;
}
const clone = (v) => structuredClone(v);
function setAt(doc, path, value) {
	if (path.length === 0) return value;
	const copy = clone(doc);
	let node = copy;
	for (const k of path.slice(0, -1)) node = node[k];
	if (value === DELETE) {
		if (Array.isArray(node)) node.splice(path.at(-1), 1);
		else delete node[path.at(-1)];
	} else node[path.at(-1)] = value;
	return copy;
}
const DELETE = Symbol("delete");
const REPLACEMENTS = [DELETE, "x", "", 0, -1, 1.5, 0.5, 101, true, null, [], {}, ["x"], [1], { extra: 1 }];

function corpus() {
	const texts = new Map();
	const add = (label, text) => texts.set(label, text);
	for (const path of paths(MAXIMAL)) {
		for (const r of REPLACEMENTS) if (path.length > 0 || r !== DELETE) add(`${path.join(".") || "root"} = ${typeof r === "symbol" ? "<deleted>" : JSON.stringify(r)}`, JSON.stringify(setAt(MAXIMAL, path, r)));
	}
	// Text-level: what pi strips, and what it cannot parse.
	const body = JSON.stringify(MAXIMAL, null, 2);
	add("BOM", `﻿${body}`);
	add("line comments", `// overlay\n${body.replace("\n", "\n  // a comment\n")}`);
	add("comment-looking string", JSON.stringify({ providers: { p: { baseUrl: "http://a//b", models: [{ id: "x//y" }] } } }));
	add("trailing commas", '{ "providers": { "p": { "models": [ { "id": "m", }, ], }, }, }');
	add("block comment", `/* no */ ${body}`);
	add("not json", "{ not json");
	add("empty", "");
	for (const t of ["[]", "null", "1", '"x"', "{}", '{"providers":[]}', '{"providers":null}', '{"providers":{}}', '{"providers":{"p":[]}}', '{"providers":{"p":{}}}']) add(`root ${t}`, t);
	// TypeBox's Record pattern `^.*$` skips a key with a line terminator, so its value is never checked.
	for (const nl of ["\n", "\r", "\u2028", "\u2029"]) {
		add(`provider key with ${JSON.stringify(nl)}`, JSON.stringify({ providers: { [`p${nl}q`]: 7, ok: { baseUrl: "http://a/v1", api: "openai-completions", models: [{ id: "m" }] } } }));
		add(`header key with ${JSON.stringify(nl)}`, JSON.stringify({ providers: { ok: { baseUrl: "http://a/v1", api: "openai-completions", headers: { [`x${nl}`]: 1 }, models: [{ id: "m" }] } } }));
	}
	for (const [label, doc] of Object.entries(COMPOSITION)) add(`compose: ${label}`, JSON.stringify(doc));
	return texts;
}

/**
 * The exact pi files the two mirrors were transcribed from, by content (issue #587): models-json.mjs from
 * model-config.js's schema, model-catalog.mjs's overlayProviderProblem from provider-composer.js's applyModelsJson and
 * modelFromJson. Hashes, not the version: a version pin went red on every pi bump whether these files moved or not, and
 * a review forced for nothing teaches people to bump the pin unread. Re-transcribed at 1.0.3: model-config.js gained
 * samplingParamsByThinkingLevel under models[] and modelOverrides; provider-composer.js merges it per level.
 */
const MIRRORED_PI_FILES = Object.freeze({
	"dist/core/model-config.js": "24a0e0f98672766e16e00d9f61587f50f9481915581156ae71a14e48ee912e4c",
	"dist/core/provider-composer.js": "b088d1babb75360da6bf1bcbe8e140ce600e1db15f51345f1965d3d1e9f267ef",
});

test("the mirror is transcribed from the pinned pi's own files: a file that changed must be re-transcribed, then its hash moved", { skip }, () => {
	// The corpus below mutates the fields the mirror KNOWS. A pi release that adds a typed field, or a composition rule,
	// would pass it green. So the source files are pinned here by content: a bump that changes either fails this line,
	// by name, until someone re-reads it and updates models-json.mjs and model-catalog.mjs (overlayProviderProblem).
	for (const [file, sha256] of Object.entries(MIRRORED_PI_FILES)) {
		assert.equal(createHash("sha256").update(readFileSync(new URL(file, PI))).digest("hex"), sha256, `pi-coding-agent ${piVersion}'s ${file} changed: re-transcribe ModelsConfigSchema (models-json.mjs) or applyModelsJson/modelFromJson (model-catalog.mjs overlayProviderProblem) from it, and worker/src/output-cap.mjs (outputCapView, which composes api, baseUrl and maxTokensField the same way) from it, then update this hash`);
	}
});

// The `provider/id` pairs a file declares under `providers.<p>.models[].id`, read leniently (a file pi refuses still has
// ids worth asking about: pi must lack them, and so must the worker).
function declared(text) {
	let doc;
	try {
		doc = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch {
		return [];
	}
	const out = [];
	for (const [p, cfg] of Object.entries(doc?.providers ?? {})) {
		if (cfg === null || typeof cfg !== "object") continue;
		for (const m of Array.isArray(cfg.models) ? cfg.models : []) if (typeof m?.id === "string" && m.id !== "") out.push([p, m.id]);
	}
	return out;
}

test("the worker reads every corpus file exactly as pi's ModelConfig.load does at the pin", { skip }, async () => {
	const dir = tempDir("pi-models-json-");
	const file = join(dir, "models.json");
	const mismatches = [];
	let n = 0;
	let piRefused = 0;
	let composed = 0;
	for (const [label, text] of corpus()) {
		writeFileSync(file, text);
		const pi = await ModelConfig.load(file);
		const piOk = pi.getError() === undefined;
		const parsed = parseModelsJson(text);
		const ours = parsed.error === undefined;
		n += 1;
		if (!piOk) piRefused += 1;
		if (piOk !== ours) mismatches.push(`${label}: pi ${piOk ? "loads" : "drops"}, worker ${ours ? "loads" : "drops"}`);
		// And past the loader, at pi's provider COMPOSITION: for every string model id the file declares, does pi's own
		// runtime have the model AS THE FILE DECLARES IT, exactly when the worker's gate calls it known? Asked as the MAIN
		// model, which is chat. A file pi drops declares nothing it keeps: a builtin id under it is the public model, which
		// the worker refuses since issue #539 (its provider has an entry in the file).
		const runtime = await ModelRuntime.create({ modelsPath: file, authPath: join(dir, "auth.json"), refreshOnCreate: false });
		const readOverlay = () => readOverlayModels(dir);
		for (const [provider, id] of declared(text)) {
			const piHas = piOk && runtime.getModel(provider, id) !== undefined;
			const workerHas = checkModelsKnown([{ provider, id, main: true }], { readOverlay }).ok === true;
			composed += 1;
			if (piHas !== workerHas) mismatches.push(`${label}: ${provider}/${id}: pi ${piHas ? "has" : "lacks"} it, the worker calls it ${workerHas ? "known" : "unknown"}`);
		}
	}
	assert.ok(composed > 1000, `the runtime half asked about ${composed} models`);
	assert.ok(n > 1500 && piRefused > 500 && n - piRefused > 300, `a corpus that exercises both verdicts (${n} files, ${piRefused} refused by pi)`);
	assert.deepEqual(mismatches, [], "every disagreement is a job admitted to fail in a container, or a working overlay refused");
});

test("pi drops a provider entry it cannot compose, endpoint included, and the worker refuses that provider's builtin models", { skip }, async () => {
	// Round 3 of PR #536's review: pi falls back to the BUILTIN provider when an overlay entry fails composition, so
	// the entry's baseUrl silently stops applying. Asked of pi's own runtime: the resolved baseUrl moves.
	const dir = tempDir("pi-models-endpoint-");
	const file = join(dir, "models.json");
	const proxy = "http://proxy.lan:8080/v1";
	for (const [label, extra, routed] of [["composes", {}, true], ["one bad custom model", { models: [{ id: "my-ft", maxTokens: 0 }] }, false], ["oauth without its own baseUrl", { oauth: "radius", baseUrl: undefined }, false]]) {
		const entry = { baseUrl: proxy, headers: { "x-team": "a" }, ...extra };
		const doc = { providers: { openai: JSON.parse(JSON.stringify(entry)) } };
		writeFileSync(file, JSON.stringify(doc));
		const runtime = await ModelRuntime.create({ modelsPath: file, authPath: join(dir, "auth.json"), refreshOnCreate: false });
		const model = runtime.getModel("openai", "gpt-4o");
		assert.equal(model?.baseUrl === proxy, routed, `${label}: pi ${routed ? "routes" : "does not route"} gpt-4o through the entry's baseUrl`);
		const verdict = checkModelsKnown([{ provider: "openai", id: "gpt-4o", main: true }], { readOverlay: () => parseModelsJson(JSON.stringify(doc)).value });
		assert.equal(verdict.ok === true, routed, `${label}: the worker admits the job exactly when pi keeps the entry (${JSON.stringify(verdict)})`);
	}
});

test("a file pi drops sends every builtin provider's entry to the public endpoint, and the worker refuses it (issue #539)", { skip }, async () => {
	// Asked of pi's own ModelConfig.load and ModelRuntime at the pin, for every builtin provider: an entry that routes
	// the provider through a proxy, beside a schema error under another provider. pi drops the whole file, so the
	// builtin model resolves to its public baseUrl; the worker refuses every job until the file is fixed.
	const dir = tempDir("pi-models-dropped-");
	const file = join(dir, "models.json");
	const proxy = "http://proxy.lan:8080/v1";
	const bad = { models: [{ id: "m", contextWindow: "big" }] };
	let providers = 0;
	for (const provider of getBuiltinProviders()) {
		const main = getBuiltinModels(provider)[0];
		if (main === undefined) continue;
		providers += 1;
		const ref = { provider, id: main.id };
		for (const [label, doc, routed] of [["valid", { providers: { [provider]: { baseUrl: proxy } } }, true], ["schema error elsewhere", { providers: { [provider]: { baseUrl: proxy }, "zz-other": bad } }, false]]) {
			writeFileSync(file, JSON.stringify(doc));
			assert.equal((await ModelConfig.load(file)).getError() === undefined, routed, `${provider} ${label}: pi ${routed ? "loads" : "drops"} the file`);
			const runtime = await ModelRuntime.create({ modelsPath: file, authPath: join(dir, "auth.json"), refreshOnCreate: false });
			assert.equal(runtime.getModel(provider, main.id)?.baseUrl === proxy, routed, `${provider} ${label}: pi ${routed ? "routes" : "does not route"} ${main.id} through the entry`);
			const verdict = checkModelsKnown([{ ...ref, main: true }], { readOverlay: () => readOverlayModels(dir) });
			assert.deepEqual(verdict, routed ? { ok: true } : { unknown: ref, why: "overlay-unparseable" }, `${provider} ${label}`);
		}
	}
	assert.ok(providers > 30, `every builtin provider with a chat model (${providers})`);
	// PR #546's review: pi drops a file for many reasons beside its schema, and every one loses the entry the same
	// way. Since round 3 the worker refuses every job then, whichever provider it runs or lists. Each reason is asked of
	// pi's own loader, so the empty, whitespace-only and BOM-only files are pinned as files pi DROPS (an error), not as
	// "no overlay": refusing them is pi's own verdict.
	const entry = `{ "baseUrl": "${proxy}" }`;
	for (const [label, text] of [
		["a block comment", `/* team proxy */ { "providers": { "openai": ${entry} } }`],
		["a truncated write", `{ "providers": { "openai": { "baseUrl": "${proxy.slice(0, 12)}`],
		["a UTF-16 save", Buffer.from(`\uFEFF{ "providers": { "openai": ${entry} } }`, "utf16le")],
		["a UTF-16 save without a BOM", Buffer.from(`{ "providers": { "openai": ${entry} } }`, "utf16le")],
		["a valid entry beside an unrelated error", `{ "providers": { "openai": ${entry}, "lan": 7 } }`],
		["an empty file", ""],
		["whitespace only", " \n\t\r\n"],
		["a byte order mark only", "\uFEFF"],
		["a comment only", "// nothing yet\n"],
	]) {
		writeFileSync(file, text);
		assert.notEqual((await ModelConfig.load(file)).getError(), undefined, `${label}: pi drops it`);
		const runtime = await ModelRuntime.create({ modelsPath: file, authPath: join(dir, "auth.json"), refreshOnCreate: false });
		assert.notEqual(runtime.getModel("openai", "gpt-4o")?.baseUrl, proxy, `${label}: pi runs gpt-4o on its public endpoint`);
		for (const ref of [{ provider: "openai", id: "gpt-4o" }, { provider: "anthropic", id: "claude-haiku-4-5" }]) {
			assert.deepEqual(checkModelsKnown([{ ...ref, main: true }], { readOverlay: () => readOverlayModels(dir) }), { unknown: ref, why: "overlay-unparseable" }, `${label}: ${ref.provider}`);
		}
	}
	// And an absent file is no overlay, for pi and for the worker.
	rmSync(file);
	assert.equal((await ModelConfig.load(file)).getError(), undefined);
	assert.deepEqual(checkModelsKnown([{ provider: "openai", id: "gpt-4o", main: true }], { readOverlay: () => readOverlayModels(dir) }), { ok: true });
});

test("a file the job cannot read loads none of it; the worker refuses a permission error or a link and reads what the job reads as no file as absent (issue #552)", { skip: skip || (typeof process.getuid === "function" && process.getuid() === 0 ? "root reads a mode-000 file" : false) }, async () => {
	// The JOB's view, asked of pi's own loader at the pin: the runner picks the overlay with existsSync (run-job.mjs)
	// and otherwise points pi at an agent-dir models.json that is absent, then pi's ModelConfig.load reads it. An entry
	// routing openai through a proxy, made unreadable each way. In every case the job loads none of the file and gpt-4o
	// would run on its public endpoint. The worker refuses where the operator's content exists (a permission error),
	// and reads as absent what the job reads as no file (existsSync false: no content is lost).
	const proxy = "http://proxy.lan:8080/v1";
	const body = JSON.stringify({ providers: { openai: { baseUrl: proxy } } });
	const gpt = { provider: "openai", id: "gpt-4o" };
	const jobView = async (dir) => {
		const modelsPath = existsSync(join(dir, "models.json")) ? join(dir, "models.json") : join(tempDir("pi-agent-"), "models.json");
		const runtime = await ModelRuntime.create({ modelsPath, authPath: join(dir, "auth.json"), refreshOnCreate: false });
		return { error: (await ModelConfig.load(modelsPath)).getError(), routed: runtime.getModel("openai", "gpt-4o")?.baseUrl === proxy };
	};
	const cases = [
		["a mode-000 file", { exists: true, error: /^Failed to load models\.json: EACCES/ }, { unknown: gpt, why: "overlay-unreadable" }, (dir) => {
			writeFileSync(join(dir, "models.json"), body);
			chmodSync(join(dir, "models.json"), 0o000);
			return { dir, undo: () => chmodSync(join(dir, "models.json"), 0o600) };
		}],
		["a folder without search permission", { exists: false }, { unknown: gpt, why: "overlay-unreadable" }, (dir) => {
			const inner = join(dir, "overlay");
			mkdirSync(inner);
			writeFileSync(join(inner, "models.json"), body);
			chmodSync(inner, 0o600);
			return { dir: inner, undo: () => chmodSync(inner, 0o700) };
		}],
		// PR #553's review: models.json is never a link (the job's mount resolves links differently), so a dangling one
		// is refused as a link; ELOOP and ENOTDIR come only from the folder's path, which the job reads as no overlay.
		["a dangling models.json link", { exists: false }, { unknown: gpt, why: "overlay-link" }, (dir) => {
			symlinkSync("nowhere.json", join(dir, "models.json"));
			return { dir };
		}],
		["a folder path that loops", { exists: false }, { ok: true }, (dir) => {
			symlinkSync(join(dir, "loop"), join(dir, "loop"));
			return { dir: join(dir, "loop") };
		}],
		["a folder path through a file", { exists: false }, { ok: true }, (dir) => {
			writeFileSync(join(dir, "plain"), body);
			return { dir: join(dir, "plain") };
		}],
	];
	for (const [label, job, verdict, make] of cases) {
		const { dir, undo } = make(tempDir("pi-models-unreadable-"));
		try {
			assert.equal(existsSync(join(dir, "models.json")), job.exists, `${label}: the runner's existsSync`);
			const seen = await jobView(dir);
			if (job.error) assert.match(String(seen.error), job.error, `${label}: pi's own read fails`);
			else assert.equal(seen.error, undefined, `${label}: pi is pointed at no overlay, silently`);
			assert.equal(seen.routed, false, `${label}: the job runs gpt-4o on its public endpoint`);
			assert.deepEqual(checkModelsKnown([{ ...gpt, main: true }], { readOverlay: () => readOverlayModels(dir) }), verdict, label);
		} finally {
			undo?.();
		}
	}
});

// Adversarial inputs for the strip: the shapes that made pi's regex strip quadratic, and the edges of its
// string rule (an escape before a line terminator, a backslash at the end, U+2028 and U+2029).
function adversarial() {
	const out = [];
	for (const n of [0, 1, 2, 3, 7]) {
		out.push(`"${'\\"'.repeat(n)}`, '"'.repeat(n), `,${" ".repeat(n)}}`, `"a\\${"\n".repeat(n)}"//x"`);
	}
	const atoms = ['"', "\\", "/", "//", ",", " ", "\n", "\r", "\u2028", "\u2029", "}", "]", "a", "\u00a0", "\ufeff", "/*", "*/"];
	let seed = 7;
	const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	for (let k = 0; k < 4000; k += 1) {
		let s = "";
		const len = 1 + Math.floor(rand() * 14);
		for (let i = 0; i < len; i += 1) s += atoms[Math.floor(rand() * atoms.length)];
		out.push(s);
	}
	return out;
}

test("stripJsonComments is pi's own, output for output, over the corpus and adversarial cases", { skip }, () => {
	const texts = [...corpus().values(), ...adversarial()];
	const differ = texts.filter((t) => stripJsonComments(t) !== piStripJsonComments(t));
	assert.ok(texts.length > 5000, `${texts.length} texts`);
	assert.deepEqual(differ.slice(0, 5).map((t) => JSON.stringify(t)), [], `${differ.length} texts strip differently`);
});

test("the strip is linear: the shapes that took pi's strip seconds take milliseconds here", () => {
	const n = 100_000;
	for (const text of [`"${'\\"'.repeat(n)}`, '"'.repeat(n), `{"providers":{"${"\\".repeat(n)}`, `,${" ".repeat(n)}`, "//".repeat(n), `"${"a\\\n".repeat(n)}`]) {
		const started = performance.now();
		stripJsonComments(text);
		parseModelsJson(text);
		const ms = performance.now() - started;
		assert.ok(ms < 2000, `${text.length} code units took ${ms.toFixed(0)} ms (pi's strip took 13 s on 160 KB)`);
	}
});

test("the cases PR #536's review found, by name", () => {
	// pi accepts these; the worker used to refuse them as not JSON.
	assert.ok(parseModelsJson('﻿{ "providers": {} }').value);
	assert.ok(parseModelsJson('{ "providers": { "o": { "models": [ { "id": "q" }, ] } } // trailing\n}').value);
	// pi drops the whole file over one bad field on ANOTHER provider; the worker used to accept it.
	const bad = parseModelsJson(JSON.stringify({ providers: { ok: { models: [{ id: "q" }] }, other: { models: [{ id: "x", contextWindow: "big" }] } } }));
	assert.match(bad.error, /schema/);
	assert.ok(!/big/.test(bad.error), "the message never quotes the file");
});
