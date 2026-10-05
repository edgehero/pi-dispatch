import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { callCostBound, COMPLETIONS_CATALOG_HOSTS as RUNNER_CATALOG_HOSTS, COMPLETIONS_EXTRA_HOSTS as RUNNER_EXTRA_HOSTS, completionsOwnServer as runnerOwnServer } from "../../image/runner/src/usage-meter.mjs";
import { costCapFitChecks, modelSubjects } from "../src/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { builtinChatModels as catalogChatModels, builtinModel as catalogModel } from "../src/model-catalog.mjs";
import { COMPLETIONS_CATALOG_HOSTS, COMPLETIONS_EXTRA_HOSTS, completionsOwnServer, outputCapView, outputUnboundable } from "../src/output-cap.mjs";

/**
 * Issue #507: the worker's copy of the runner's output-cap rule (output-cap.mjs) for doctor. The job image ships the
 * runner alone and the worker package its `src` alone, so the rule is a copy, and this file holds it to the runner's.
 */

const PRICED = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

test("the host lists and the own-server predicate are the runner's, over a matrix of baseUrls", () => {
	assert.deepEqual([...COMPLETIONS_CATALOG_HOSTS], [...RUNNER_CATALOG_HOSTS]);
	assert.deepEqual([...COMPLETIONS_EXTRA_HOSTS], [...RUNNER_EXTRA_HOSTS]);
	const urls = ["http://host.docker.internal:11434/v1", "https://openrouter.ai/api/v1", "https://API.GROQ.COM/openai/v1", "https://api.openai.com/v1", "http://api.groq.com@127.0.0.1:11434/v1", "not a url", undefined, "", "http://[fd00::2]:8000/v1"];
	for (const baseUrl of urls) {
		for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
			assert.equal(completionsOwnServer({ api, baseUrl }), runnerOwnServer({ api, baseUrl }), `${api} ${baseUrl}`);
		}
	}
});

test("outputUnboundable says exactly when the runner's bound is Infinity for the output cap's sake", () => {
	const ctx = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
	const base = { id: "m", provider: "p", api: "openai-completions", baseUrl: "http://gpu.lan:8000/v1", contextWindow: 32768, maxTokens: 256 };
	const cases = [
		[{}, PRICED],
		[{ maxTokensField: "max_tokens" }, PRICED],
		[{ maxTokensField: "max_completion_tokens" }, PRICED],
		[{}, FREE],
	];
	for (const baseUrl of ["http://gpu.lan:8000/v1", "https://openrouter.ai/api/v1", "https://api.openai.com/v1"]) {
		for (const [compat, cost] of cases) {
			const model = { ...base, baseUrl, compat, cost };
			const view = { api: model.api, baseUrl, maxTokensField: compat.maxTokensField, cost };
			assert.equal(outputUnboundable(view), callCostBound("streamSimple", model, ctx, {}, {}) === Infinity, `${baseUrl} ${JSON.stringify(compat)} ${JSON.stringify(cost)}`);
		}
	}
});

test("outputCapView composes api, baseUrl and the field as pi's provider composer does", () => {
	const groq = { id: "g", api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1", cost: PRICED, compat: { supportsStrictMode: true } };
	const builtinModel = (provider, id) => (provider === "groq" && id === "g" ? groq : null);
	// A builtin provider pointed at a proxy: the builtin model takes the provider's baseUrl, and is unboundable there.
	const proxied = { providers: { groq: { baseUrl: "http://litellm.lan:4000/v1" } } };
	assert.deepEqual(outputCapView({ models: proxied, provider: "groq", modelId: "g", builtinModel }), { api: "openai-completions", baseUrl: "http://litellm.lan:4000/v1", maxTokensField: undefined, cost: PRICED });
	assert.equal(outputUnboundable(outputCapView({ models: proxied, provider: "groq", modelId: "g", builtinModel })), true);
	assert.equal(outputUnboundable(outputCapView({ models: null, provider: "groq", modelId: "g", builtinModel })), false, "on its own host it is the catalog's");
	// The provider's compat, then the override's, decide the field for a builtin model.
	const fixed = { providers: { groq: { baseUrl: "http://litellm.lan:4000/v1", compat: { maxTokensField: "max_tokens" } } } };
	assert.equal(outputUnboundable(outputCapView({ models: fixed, provider: "groq", modelId: "g", builtinModel })), false);
	const undone = { providers: { groq: { ...fixed.providers.groq, modelOverrides: { g: { compat: { maxTokensField: "max_completion_tokens" } } } } } };
	assert.equal(outputUnboundable(outputCapView({ models: undone, provider: "groq", modelId: "g", builtinModel })), true);
	// A defined model: its own api and baseUrl over the provider's, and no builtin compat.
	const defined = { providers: { lan: { api: "openai-completions", baseUrl: "http://gpu.lan:8000/v1", models: [{ id: "q", cost: PRICED }, { id: "r", cost: PRICED, api: "anthropic-messages" }, { id: "s" }] } } };
	assert.equal(outputUnboundable(outputCapView({ models: defined, provider: "lan", modelId: "q" })), true);
	assert.equal(outputUnboundable(outputCapView({ models: defined, provider: "lan", modelId: "r" })), false, "another api");
	assert.equal(outputUnboundable(outputCapView({ models: defined, provider: "lan", modelId: "s" })), false, "no cost is all zeros in pi");
	assert.equal(outputCapView({ models: defined, provider: "lan", modelId: "nope" }), null);
	// A defined model with no api of its own or its provider's (final review of #507): pi takes its DEFAULTS model's,
	// `findModelDefaults` over the provider's chat models, here groq's first openai-completions model.
	const chat = (p) => (p === "groq" ? [{ id: "a", api: "anthropic-messages", baseUrl: "https://api.groq.com/x" }, groq] : []);
	const added = { providers: { groq: { baseUrl: "http://proxy.lan:8080/openai/v1", models: [{ id: "new-groq", cost: PRICED }] } } };
	assert.deepEqual(outputCapView({ models: added, provider: "groq", modelId: "new-groq", builtinModel, builtinChatModels: chat }), { api: "openai-completions", baseUrl: "http://proxy.lan:8080/openai/v1", maxTokensField: undefined, cost: PRICED });
	assert.equal(outputUnboundable(outputCapView({ models: added, provider: "groq", modelId: "new-groq", builtinModel, builtinChatModels: chat })), true);
	// The defaults list grows with each definition in the file's order, and one with an api picks a model of that api.
	const chain = { providers: { lan: { baseUrl: "http://gpu.lan:8000/v1", models: [{ id: "first", api: "openai-completions", cost: PRICED }, { id: "second", cost: PRICED }, { id: "third", api: "anthropic-messages", cost: PRICED }] } } };
	assert.equal(outputCapView({ models: chain, provider: "lan", modelId: "second" }).api, "openai-completions", "the earlier definition is the default");
	assert.equal(outputCapView({ models: chain, provider: "lan", modelId: "third" }).api, "anthropic-messages");
});

test("an empty catalog baseUrl is the operator's own server: unbounded under a cap until compat sends max_tokens (issue #587)", () => {
	// pi 1.0.3: every azure row has baseUrl "", azure/deepseek-v4-pro on openai-completions among them. The real host is
	// whatever the operator configures (their own server, possibly), so the guard stays fail closed there.
	const deepseek = catalogModel("azure", "deepseek-v4-pro");
	assert.equal(deepseek?.api, "openai-completions", "the premise: the pinned catalog serves it on openai-completions");
	assert.equal(deepseek.baseUrl, "", "the premise: with no baseUrl");
	assert.equal(completionsOwnServer(deepseek), true);
	assert.equal(outputUnboundable(outputCapView({ models: null, provider: "azure", modelId: "deepseek-v4-pro", builtinModel: catalogModel, builtinChatModels: catalogChatModels })), deepseek.cost.output > 0, "priced: unbounded");
	const wayOut = { providers: { azure: { modelOverrides: { "deepseek-v4-pro": { compat: { maxTokensField: "max_tokens" } } } } } };
	assert.equal(outputUnboundable(outputCapView({ models: wayOut, provider: "azure", modelId: "deepseek-v4-pro", builtinModel: catalogModel, builtinChatModels: catalogChatModels })), false, "the documented override bounds it");
});

// pi's own composer, at the pin: the view must say what pi's ModelRuntime composes for each model of a few overlays.
let piCore = null;
try {
	const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
	piCore = {
		ModelRuntime: (await import(new URL("core/model-runtime.js", entry).href)).ModelRuntime,
		AuthStorage: (await import(new URL("core/auth-storage.js", entry).href)).AuthStorage,
		Store: (await import(new URL("core/models-store.js", entry).href)).InMemoryCodingAgentModelsStore,
	};
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`output-cap's parity with pi's composer REQUIRES pi-coding-agent here: ${error}`);
}

test("outputCapView agrees with pi's own ModelRuntime on api, baseUrl and the field, over overlays that lean on each composer rule (#507)", { skip: piCore ? false : "pi-coding-agent not importable" }, async () => {
	const overlay = {
		providers: {
			litellm: { api: "openai-completions", baseUrl: "http://litellm.lan:4000/v1", apiKey: "x", models: [{ id: "gw", cost: PRICED }] },
			groq: { baseUrl: "http://proxy.lan:8080/openai/v1", compat: { maxTokensField: "max_tokens" }, models: [{ id: "new-groq", cost: PRICED }, { id: "own", cost: PRICED, compat: { maxTokensField: "max_completion_tokens" } }], modelOverrides: { "llama-3.1-8b-instant": { compat: { maxTokensField: "max_completion_tokens" } } } },
			ollama: { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "x", models: [{ id: "qa", cost: PRICED, compat: { maxTokensField: "max_tokens" } }, { id: "qb", cost: PRICED }, { id: "qc", baseUrl: "http://gpu.lan:8000/v1" }] },
			openrouter: { baseUrl: "http://or-proxy.lan/v1" },
			// pi 1.0.3's azure catalog serves deepseek-v4-pro on openai-completions with an empty baseUrl (issue #587):
			// the documented way out of the fail-closed bound is this override.
			azure: { modelOverrides: { "deepseek-v4-pro": { compat: { maxTokensField: "max_tokens" } } } },
		},
	};
	const dir = tempDir("output-cap-pi-");
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify(overlay));
	const saved = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	let rt;
	try {
		rt = await piCore.ModelRuntime.create({ modelsPath: path, credentials: piCore.AuthStorage.inMemory(), modelsStore: new piCore.Store(), refreshOnCreate: false });
	} finally {
		if (saved === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = saved;
	}
	const refs = [["litellm", "gw"], ["groq", "new-groq"], ["groq", "own"], ["ollama", "qa"], ["ollama", "qb"], ["ollama", "qc"], ...catalogChatModels("groq").slice(0, 3).map((m) => ["groq", m.id]), ...catalogChatModels("openrouter").slice(0, 3).map((m) => ["openrouter", m.id]), ["azure", "deepseek-v4-pro"], ["azure", "gpt-5.4"]];
	for (const [provider, modelId] of refs) {
		const m = rt.getModel(provider, modelId);
		assert.ok(m, `${provider}/${modelId}: pi composes it`);
		const view = outputCapView({ models: overlay, provider, modelId, builtinModel: catalogModel, builtinChatModels: catalogChatModels });
		assert.deepEqual([view.api, view.baseUrl, view.maxTokensField], [m.api, m.baseUrl, m.compat?.maxTokensField], `${provider}/${modelId}`);
	}
});

test("costCapFitChecks names a capped job's unboundable model once, on a line of its own, and gives it no floor (#507)", () => {
	const models = { providers: { lan: { api: "openai-completions", baseUrl: "http://litellm.lan:4000/v1", models: [{ id: "q", cost: PRICED, maxTokens: 256 }] } } };
	const unboundable = (ref) => outputUnboundable(outputCapView({ models, provider: ref.provider, modelId: ref.id }));
	const modelOf = (ref) => (ref.provider === "lan" ? models.providers.lan.models[0] : null);
	const subjects = modelSubjects({ deployment: { provider: "lan", model: "q", maxCostUsd: "5" }, runs: [{ label: "trigger nightly", provider: "lan", model: "q", maxCostUsd: "1" }] });
	const checks = costCapFitChecks(subjects, modelOf, { unboundable });
	assert.equal(checks.length, 1, JSON.stringify(checks));
	assert.equal(checks[0].label, 'A job under a per-job cost cap may use a model whose output cap travels as max_completion_tokens to a server that may ignore it (one outside pi\'s own hosted providers), so the runner counts every call to it unboundable and refuses it under the cap: lan/q (the main model, so such a job makes no call at all) (the deployment default, trigger nightly)');
	assert.match(checks[0].fix, /"maxTokensField": "max_tokens"/);
	assert.deepEqual(costCapFitChecks(modelSubjects({ deployment: { provider: "lan", model: "q", maxCostUsd: null } }), modelOf, { unboundable }), [], "no cap, nothing refused");
	assert.equal(costCapFitChecks(subjects, modelOf).length, 0, "without the predicate the floor alone is judged, and $5 covers it");
});
