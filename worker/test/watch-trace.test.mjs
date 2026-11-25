import assert from "node:assert/strict";
import { test } from "node:test";
import { collectedWatchTrace, decisionCallFacts, publicWatchTrace } from "../src/watch-trace.mjs";
test("untrusted collector cannot promote private text or forged review markers into public fields", () => {
	const entry = { id: "watch-1", kind: "decide", status: "completed", model: "secret-value", modelReviewed: true, source: "secret-value", option: "secret-value", count: "secret-value", confidence: "secret-value", costUsd: "secret-value", probabilities: { private: "secret-value" }, state: { account: "secret-value" }, query: "secret-value", questions: { private: "secret-value" }, checks: { private: "secret-value" } };
	const imported = collectedWatchTrace(entry, { model: "openrouter/typesafe/jev-1.13", ruleId: "reviewed-rule", runId: "run1" });
	const visible = publicWatchTrace(imported);
	assert.equal(visible.model, "openrouter/typesafe/jev-1.13"); assert.equal(visible.ruleId, "reviewed-rule");
	assert.equal(JSON.stringify(visible).includes("secret-value"), false);
	assert.equal(imported.state.account, "secret-value");
});
test("public summary admits finite typed values and fixed choices, never private payload", () => {
	const entry = { id: "run1:watch-1", at: 123, kind: "decide", status: "completed", model: "openrouter/typesafe/jev-1.13", modelReviewed: true, option: "ignore", probabilities: { investigate: 0.02, ignore: 0.95, file_issue: 0.03 }, confidence: 0.9, costUsd: 0.001, state: { private: "secret" }, samples: ["secret"] };
	assert.equal(publicWatchTrace(entry).action, "ignore"); assert.deepEqual(publicWatchTrace(entry).probabilities, entry.probabilities);
	assert.equal(publicWatchTrace({ model: "attacker-model" }).model, undefined);
	assert.deepEqual(publicWatchTrace({ probabilities: { ignore: NaN }, confidence: Infinity, costUsd: -1, rows: -1, count: "secret", status: "secret" }), {});
});
test("unknown trace kinds, unsafe ids and invalid statuses refuse import", () => {
	for (const entry of [null, { kind: "query", id: "../secret", status: "completed" }, { kind: "query", id: "watch-1", status: "secret" }, { kind: "script", id: "watch-1", status: "completed" }]) assert.equal(collectedWatchTrace(entry, { ruleId: "rule", runId: "run1" }), null);
});
test("a decide call's provider id stays in the operator's trace, and only a yes that the provider billed reaches the public one (pi 1.6.1)", () => {
	const entry = { id: "watch-2", kind: "decide", status: "completed", answers: {}, usage: { input: 40, output: 0, totalTokens: 40, cost: { total: 0.000004, totalFromProvider: true } }, responseId: "gen-1764081234-AbCdEf" };
	const imported = collectedWatchTrace(entry, { model: "openrouter/typesafe/jev-1.13", ruleId: "r", runId: "run1" });
	assert.equal(imported.responseId, "gen-1764081234-AbCdEf");
	assert.equal(imported.billed, true);
	const visible = publicWatchTrace(imported);
	assert.equal(visible.billed, true);
	assert.equal(visible.responseId, undefined, "the provider's id is the operator's");
	assert.equal(JSON.stringify(visible).includes("gen-1764081234"), false);
	// A catalog-priced call, an older image's line without either field, a malformed id and a forged public field.
	assert.deepEqual(decisionCallFacts({ usage: { cost: { total: 0.1, totalFromProvider: false } }, responseId: "resp_1" }), { responseId: "resp_1" });
	assert.deepEqual(decisionCallFacts({ answers: {} }), {});
	for (const responseId of ["gen 1", "a".repeat(129), "", 42, { id: "x" }, "id\u0000"]) assert.equal(decisionCallFacts({ responseId }).responseId, undefined, JSON.stringify(responseId));
	assert.equal(decisionCallFacts({ usage: { cost: { totalFromProvider: "true" } } }).billed, undefined);
	assert.equal(collectedWatchTrace({ id: "watch-3", kind: "query", status: "completed", responseId: "r1", billed: true }, { model: null, ruleId: "r", runId: "run1" }).responseId, undefined, "only a decide line carries them");
	assert.equal(collectedWatchTrace({ id: "watch-3", kind: "query", status: "completed", billed: true }, { model: null, ruleId: "r", runId: "run1" }).billed, undefined, "the worker derives billed, the line cannot state it");
	assert.equal(publicWatchTrace({ billed: "yes" }).billed, undefined);
});
