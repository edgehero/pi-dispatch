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
