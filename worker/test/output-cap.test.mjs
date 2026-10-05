import assert from "node:assert/strict";
import { test } from "node:test";
import { callCostBound, COMPLETIONS_CATALOG_HOSTS as RUNNER_CATALOG_HOSTS, COMPLETIONS_EXTRA_HOSTS as RUNNER_EXTRA_HOSTS, completionsOwnServer as runnerOwnServer } from "../../image/runner/src/usage-meter.mjs";
import { costCapFitChecks, modelSubjects } from "../src/doctor.mjs";
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
	const urls = ["http://host.docker.internal:11434/v1", "https://openrouter.ai/api/v1", "https://API.GROQ.COM/openai/v1", "https://api.openai.com/v1", "http://api.groq.com@127.0.0.1:11434/v1", "not a url", undefined, "http://[fd00::2]:8000/v1"];
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
