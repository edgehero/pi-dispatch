import { test } from "node:test";
import assert from "node:assert/strict";
import { getAllBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { MODEL_REF_PATTERN } from "../src/model-ref.mjs";

const isRecordableModelId = (id) => typeof id === "string" && MODEL_REF_PATTERN.test(id);

/**
 * The record's model-id allowlist (issues #501, #502). The ledger used to refuse 55 builtin catalog ids, and
 * one refused row nulls the whole `usage` block, so a job on one of those models recorded no ledger. These
 * pin both halves: everything the pinned catalog can name passes, and the shapes the first-character rule
 * exists for still fail.
 */

test("every builtin provider and model id at the pin is recordable (the catalog is the oracle, not a sample)", () => {
	const refused = [];
	let ids = 0;
	for (const provider of getBuiltinProviders()) {
		if (!isRecordableModelId(provider.toLowerCase())) refused.push(provider);
		for (const model of getAllBuiltinModels(provider)) {
			ids += 1;
			if (!isRecordableModelId(model.id.toLowerCase())) refused.push(`${provider}/${model.id}`);
		}
	}
	assert.ok(ids > 1000, `the catalog walk found ${ids} ids: the enumeration is reading nothing`);
	assert.deepEqual(refused, [], "a builtin id the ledger refuses nulls the whole usage block of every job on it");
});

test("the shapes the widening was for: @cf, ~alias, @ inside, underscore tags", () => {
	for (const id of ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "workers-ai/@cf/openai/gpt-oss-20b", "~anthropic/claude-sonnet-latest", "qwen2.5:0.5b-instruct-q4_k_m", "a".repeat(64), "~".concat("a".repeat(63))]) {
		assert.ok(isRecordableModelId(id), id);
	}
});

test("still refused: path shapes at character one, a doubled prefix, foreign characters, over 64", () => {
	for (const id of ["", ".hidden", "../etc", "/abs", ":x", "~~x", "@@x", "~@x", "~.x", "@/x", "bad provider!", "a\\b", "a\"b", "a\nb", "A", "a".repeat(65), `~${"a".repeat(64)}`, 7, null]) {
		assert.equal(isRecordableModelId(id), false, JSON.stringify(id));
	}
	assert.equal(MODEL_REF_PATTERN.flags, "", "applied to lowercased ids: no i flag, so uppercase is refused, never folded here");
});
