import assert from "node:assert/strict";
import { test } from "node:test";
import { collectedWatchTrace, publicWatchTrace } from "../src/watch-trace.mjs";
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
