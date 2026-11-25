import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { builtinModel } from "../src/model-catalog.mjs";
import { thinkingModel, thinkingLevelAllowed } from "../src/thinking-level.mjs";
import { FORK_THINKING_LEVELS } from "../src/fork-job.mjs";

const piRoot = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { composeModelProvider } = await import(pathToFileURL(join(piRoot, "core/provider-composer.js")).href);
const provider = "anthropic";
const id = "claude-haiku-4-5";
const baseModel = builtinModel(provider, id);

test("worker thinking gates agree with the pinned composer's definitions and merged overrides", () => {
	for (const config of [
		{ apiKey: "fake" },
		{ apiKey: "fake", modelOverrides: { [id]: { thinkingLevelMap: { low: null, xhigh: "high", max: "high" } } } },
		{ apiKey: "fake", models: [{ id }] },
		{ apiKey: "fake", models: [{ id, reasoning: true, thinkingLevelMap: { low: null, xhigh: "high" } }], modelOverrides: { [id]: { thinkingLevelMap: { max: "high" } } } },
		{ apiKey: "fake", modelOverrides: { [id]: { reasoning: false } } },
	]) {
		const models = { providers: { [provider]: config } };
		const actual = composeModelProvider(provider, { getModels: () => [baseModel], auth: {} }, { getProvider: () => config }).getModels()[0];
		assert.deepEqual(thinkingModel({ models, provider, modelId: id, builtinModel }), { reasoning: actual.reasoning, thinkingLevelMap: actual.thinkingLevelMap });
		for (const thinkingLevel of FORK_THINKING_LEVELS) assert.equal(thinkingLevelAllowed({ provider, model: id, thinkingLevel }, { models, builtinModel }), clampThinkingLevel(actual, thinkingLevel) === thinkingLevel, `${JSON.stringify(config)} ${thinkingLevel}`);
	}
});

test("unknown models and unrecognized levels cannot silently become a default", () => {
	assert.equal(thinkingLevelAllowed({ provider, model: "missing", thinkingLevel: "high" }, { builtinModel }), false);
	assert.equal(thinkingLevelAllowed({ provider, model: id, thinkingLevel: "unlimited" }, { builtinModel }), false);
});

test("a fork that asks for off where pi 1.6.1 raises off to its lowest level is refused, never upgraded to a paid level", () => {
	// pi 1.6.1 maps `off` to null on the Claude 5.5 routes of Bedrock, Copilot, Cloudflare AI Gateway and Vercel AI
	// Gateway (Anthropic's own route already did), and a session asked for `off` there runs at the lowest level the model
	// has. A fork's operator asked for no thinking: running it with some would spend more than was chosen, so the check
	// refuses it and `minimal` stays open.
	for (const [routeProvider, model] of [["amazon-bedrock", "us.anthropic.claude-sonnet-5-5"], ["github-copilot", "claude-sonnet-5.5"], ["cloudflare-ai-gateway", "claude-opus-5-5"], ["vercel-ai-gateway", "anthropic/claude-opus-5.5"]]) {
		assert.ok(builtinModel(routeProvider, model), `${routeProvider}/${model} is in the pinned catalog`);
		assert.equal(thinkingLevelAllowed({ provider: routeProvider, model, thinkingLevel: "off" }, { builtinModel }), false, `${routeProvider}/${model} off`);
		assert.equal(thinkingLevelAllowed({ provider: routeProvider, model, thinkingLevel: "minimal" }, { builtinModel }), true, `${routeProvider}/${model} minimal`);
	}
	assert.equal(thinkingLevelAllowed({ provider: "anthropic", model: "claude-haiku-4-5", thinkingLevel: "off" }, { builtinModel }), true, "a model that maps no level still has off");
});
