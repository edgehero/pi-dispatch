import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TOUCH_CAUSES, TOUCH_MAX_EVENTS, TOUCH_MAX_RETENTION_DAYS } from "../src/touch-state.mjs";
import { QUESTION_GROUP_LIMITS, QUESTION_GROUP_STATUSES } from "../src/question-groups.mjs";
import { validateQuestionGroupingInput } from "../../image/runner/src/question-grouping.mjs";

const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
const section = (id) => spec.split(`## ${id}\n`)[1].split(/\n## /)[0];
const jsonList = (id) => JSON.parse(section(id).match(/```json\n([^`]+)\n\s*```/)[1]);

test("the touch and grouping spec vocabularies equal their producers in both directions", () => {
	assert.deepEqual(jsonList("INT-TOUCH-INDEX"), TOUCH_CAUSES);
	assert.deepEqual(jsonList("INT-QUESTION-GROUPS"), QUESTION_GROUP_STATUSES);
});

test("the documented finite touch/corpus bounds stay tied to their source constants", () => {
	const touch = section("INT-TOUCH-INDEX");
	assert.ok(touch.includes(`${TOUCH_MAX_RETENTION_DAYS} days and ${TOUCH_MAX_EVENTS.toLocaleString("en-US")} indexed events`));
	const groups = section("INT-QUESTION-GROUPS");
	for (const [key, words] of [["excerptBytes", "excerpt bytes"], ["inputBytes", "total input bytes"], ["corpusEntries", "private entries"], ["metadataEntries", "safe metadata entries"]]) assert.ok(groups.includes(`${QUESTION_GROUP_LIMITS[key].toLocaleString("en-US")} ${words}`), key);
	assert.ok(groups.includes(`${QUESTION_GROUP_LIMITS.candidates} existing candidate groups`));
	assert.ok(groups.includes(`at most ${QUESTION_GROUP_LIMITS.retentionDays} private days`));
});

test("the isolated runner accepts the worker's maximum candidate vocabulary and refuses one more", () => {
	const candidates = Array.from({ length: QUESTION_GROUP_LIMITS.candidates }, (_, i) => ({ slot: `g${i}`, excerpt: `Question ${i}?` }));
	const input = { version: 1, model: { provider: "test", id: "classifier" }, source: "Which package manager?", candidates, confidence: 0.9 };
	assert.equal(validateQuestionGroupingInput(input).candidates.length, QUESTION_GROUP_LIMITS.candidates);
	assert.throws(() => validateQuestionGroupingInput({ ...input, candidates: [...candidates, { slot: `g${candidates.length}`, excerpt: "Too many" }] }));
	assert.throws(() => validateQuestionGroupingInput({ ...input, source: "x".repeat(QUESTION_GROUP_LIMITS.excerptBytes + 1) }));
});
