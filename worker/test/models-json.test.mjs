import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkModelsKnown } from "../src/model-catalog.mjs";
import { parseModelsJson } from "../src/models-json.mjs";
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
let piVersion;
let importError;
try {
	({ ModelConfig } = await import(new URL("dist/core/model-config.js", PI).href));
	({ ModelRuntime } = await import(new URL("dist/core/model-runtime.js", PI).href));
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
					headers: { "x-m": "n" },
					compat: { supportsEagerToolInputStreaming: true, allowedFallbackModels: [{ provider: "anthropic", model: "claude-x", cost: COST }] },
				},
			],
			modelOverrides: { "qwen2.5:0.5b": { name: "Q", cost: { input: 1 }, contextWindow: 1, compat: { supportsMaxOutputTokens: true } } },
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

test("the mirror is transcribed from pi 0.99.1: a pi bump must re-transcribe it, then move this pin", { skip }, () => {
	// The corpus below mutates the fields the mirror KNOWS. A pi release that adds a typed field, or a composition rule,
	// would pass it green. So the version is pinned here, the host-pi.pinned.test.mjs rule: a bump fails this line
	// until someone re-reads pi's model-config.js and provider-composer.js and updates models-json.mjs and
	// model-catalog.mjs (overlayProviderProblem) to match.
	assert.equal(piVersion, "0.99.1", "pi-coding-agent moved: re-transcribe ModelsConfigSchema (models-json.mjs) and applyModelsJson/modelFromJson (model-catalog.mjs overlayProviderProblem) from the new release, then update this pin");
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
		// runtime have the model, exactly when the worker's gate calls it known? Asked as the MAIN model, which is chat.
		const runtime = await ModelRuntime.create({ modelsPath: file, authPath: join(dir, "auth.json"), refreshOnCreate: false });
		const readOverlay = () => {
			if (parsed.error !== undefined) throw Object.assign(new Error(parsed.error), { piDispatchConfig: true });
			return parsed.value;
		};
		for (const [provider, id] of declared(text)) {
			const piHas = runtime.getModel(provider, id) !== undefined;
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

test("the cases PR #536's review found, by name", () => {
	// pi accepts these; the worker used to refuse them as not JSON.
	assert.ok(parseModelsJson('﻿{ "providers": {} }').value);
	assert.ok(parseModelsJson('{ "providers": { "o": { "models": [ { "id": "q" }, ] } } // trailing\n}').value);
	// pi drops the whole file over one bad field on ANOTHER provider; the worker used to accept it.
	const bad = parseModelsJson(JSON.stringify({ providers: { ok: { models: [{ id: "q" }] }, other: { models: [{ id: "x", contextWindow: "big" }] } } }));
	assert.match(bad.error, /schema/);
	assert.ok(!/big/.test(bad.error), "the message never quotes the file");
});
