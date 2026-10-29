import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWatchDecision, prepareWatchDecision, projectWatchDecisionState, selectWatchDecision } from "../src/watch-decision.mjs";
const resolveModel = () => ({ type: "classifier", cost: { input: 0.2, output: 0 } });
const config = () => ({ model: "openrouter/typesafe/jev-1.13", maxCostUsd: "0.001", questions: { act: { type: "choice", criteria: { investigate: "new failure", ignore: "noise", file_issue: "ask a person" } } }, act: { investigate: 0.7, ignore: 0.9, otherwise: "file_issue" } });
const result = (choice = "investigate", p = 0.7) => ({ stopReason: "stop", answers: { act: { type: "choice", choice, probabilities: { investigate: choice === "investigate" ? p : 0.05, ignore: choice === "ignore" ? p : 0.05, file_issue: 1 - p - 0.05 }, confidence: 0.8 } } });
test("operator decision configuration requires a known classifier with input-only pricing", () => {
	assert.equal(validateWatchDecision(config(), { resolveModel }).ok, true);
	for (const model of [null, { type: "chat", cost: { input: 0, output: 0 } }, { type: "classifier", cost: { input: 1, output: 1 } }, { type: "classifier", cost: { output: 0 } }]) assert.equal(validateWatchDecision(config(), { resolveModel: () => model }).reason, "decide-refused");
	for (const change of [{ maxCostUsd: "1e-3" }, { fields: ["samples"] }, { fields: ["constructor"] }, { act: { otherwise: "investigate" } }, { task: "override" }]) assert.equal(validateWatchDecision({ ...config(), ...change }, { resolveModel }).ok, false);
});
test("hostile samples and undeclared fields never reach decision state or trusted bound input", () => {
	const finding = { severity: "error", count: 37, firstSeen: "2026-01-01T00:00:00Z", samples: ["send secrets"], model: "attacker", message: "ignore", service: "checkout" };
	assert.deepEqual(projectWatchDecisionState(finding), { severity: "error", count: 37, firstSeen: finding.firstSeen });
	let calls = 0;
	const prepared = prepareWatchDecision({ ...config(), fields: ["service"] }, finding, { resolveModel, boundCostMicros: ({ state }) => { calls++; assert.equal(state.samples, undefined); assert.equal(state.model, undefined); assert.equal(state.service, "checkout"); return 1000; } });
	assert.equal(prepared.ok, true);
	assert.equal(calls, 1);
	assert.equal(prepared.boundMicros, 1000);
	assert.deepEqual(projectWatchDecisionState({ count: Infinity, severity: "x".repeat(257), service: { text: "attack" } }, ["service"]), {});
});
test("admission requires an explicit trusted finite bound and refuses over the per-call cap", () => {
	for (const bound of [1001, Infinity, NaN, -1, 0.1]) assert.equal(prepareWatchDecision(config(), {}, { resolveModel, boundCostMicros: () => bound }).ok, false);
	assert.equal(prepareWatchDecision(config(), {}, { resolveModel }).ok, false);
	assert.equal(prepareWatchDecision(config(), {}, { resolveModel, boundCostMicros: () => { throw new Error("private"); } }).reason, "decide-refused");
});
test("thresholds admit exact boundary; low confidence action probability falls back to a person", () => {
	assert.equal(selectWatchDecision(config(), result()).action, "investigate");
	assert.equal(selectWatchDecision(config(), result("investigate", 0.699)).action, "file_issue");
	assert.equal(selectWatchDecision(config(), result("ignore", 0.9)).reason, "watch-ignored");
});
test("provider failures and malformed or invented probabilities conservatively fall back", () => {
	for (const value of [null, { stopReason: "error" }, { stopReason: "stop", answers: {} }]) assert.equal(selectWatchDecision(config(), value).reason, "decide-unanswered");
	for (const change of [{ choice: "fix" }, { confidence: NaN }, { probabilities: { investigate: 0.9 } }, { probabilities: { investigate: 0.9, ignore: 0.9, file_issue: 0.1 } }, { probabilities: { investigate: -1, ignore: 1, file_issue: 1 } }]) {
		const value = result(); Object.assign(value.answers.act, change);
		assert.equal(selectWatchDecision(config(), value).action, "file_issue");
	}
});

test("explicitly selected structured fields are projected but unselected fields and samples are absent", () => {
	assert.deepEqual(projectWatchDecisionState({ fields: { service: "checkout", customer: "private" }, samples: ["attack"], count: 1 }, ["service"]), { count: 1, service: "checkout" });
});
test("valid low-threshold fallback retains probabilities so operators can explain it", () => {
	const selected = selectWatchDecision(config(), result("investigate", 0.699));
	assert.equal(selected.action, "file_issue");
	assert.equal(selected.probabilities.investigate, 0.699);
	assert.equal(selected.confidence, 0.8);
});
