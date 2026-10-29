import assert from "node:assert/strict";
import { test } from "node:test";
import { executeWatchDecision, readWatchDecision, validateWatchDecisionInput } from "../src/watch-decision.mjs";
const input = () => ({ version: 1, model: { provider: "openrouter", id: "typesafe/jev-1.13" }, state: { count: 37 }, questions: { act: { type: "choice", criteria: { ignore: "noise", file_issue: "person" } } } });
test("deterministic watch decision dispatches exactly one classifier and writes bounded data only", async () => {
	let calls = 0; let written;
	const result = await executeWatchDecision({ input: input(), runtime: { getModelsOfType: () => [{ id: input().model.id, cost: { input: 1, output: 0 } }], async classify(_model, context) { calls++; assert.deepEqual(context.state, { count: 37 }); return { stopReason: "stop", answers: { act: { choice: "ignore" } }, errorMessage: "private" }; } }, fs: { writeFileSync(path, value) { assert.equal(path, "/outbox/decision.json"); written = JSON.parse(value); } } });
	assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(written.version, 1); assert.equal(JSON.stringify(written).includes("private"), false);
});
test("output-priced, absent and unknown-price classifiers never dispatch", async () => {
	for (const model of [undefined, { id: input().model.id }, { id: input().model.id, cost: { input: 1, output: 1 } }]) {
		const result = await executeWatchDecision({ input: input(), runtime: { getModelsOfType: () => model ? [model] : [], classify() { assert.fail("must refuse before call"); } } });
		assert.equal(result.reason, "decide-refused");
	}
});
test("transport failure yields an unanswered response without leaking exception text or retrying", async () => {
	let calls = 0; let written;
	const result = await executeWatchDecision({ input: input(), runtime: { getModelsOfType: () => [{ id: input().model.id, cost: { input: 1, output: 0 } }], async classify() { calls++; throw new Error("private"); } }, fs: { writeFileSync(_path, value) { written = value; } } });
	assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(JSON.parse(written).stopReason, "error"); assert.equal(written.includes("private"), false);
});
test("decision input rejects samples, nested state, writable selectors and malformed marker files", () => {
	assert.equal(validateWatchDecisionInput(input()).version, 1);
	for (const state of [{ samples: "hostile" }, { service: { text: "hostile" } }, { count: Infinity }]) assert.throws(() => validateWatchDecisionInput({ ...input(), state }));
	assert.throws(() => validateWatchDecisionInput({ ...input(), tools: ["write"] }));
	assert.throws(() => readWatchDecision({ fs: { lstatSync: () => ({ isFile: () => false, size: 0 }) } }));
	assert.throws(() => readWatchDecision({ fs: { lstatSync: () => ({ isFile: () => true, size: 32769 }) } }));
	assert.equal(readWatchDecision({ fs: { lstatSync() { throw Object.assign(new Error(), { code: "ENOENT" }); } } }), null);
});
