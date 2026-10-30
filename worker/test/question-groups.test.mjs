import assert from "node:assert/strict";
import { test } from "node:test";
import { validateZeroTouchConfig, privateQuestionExcerpt, makeQuestionGroupStore, QUESTION_GROUP_LIMITS } from "../src/question-groups.mjs";
import { parseTriggersDocument } from "../src/triggers.mjs";
import { makeQuestionGroupRuntime, questionGroupConfigDigest, prepareQuestionGrouping } from "../src/question-group-runtime.mjs";
import { enqueueQuestionGroupJob } from "../src/queue.mjs";
import { compareZeroTouchFixes } from "../src/zero-touch-fixes.mjs";
const nowMs = 1900000000000;
const config = { capture: true, model: "test/classifier", maxCostUsd: "0.05", confidence: 0.9, names: {} };
const scopeId = "a".repeat(64), digest = "b".repeat(64), groupId = "c".repeat(32);

test("grouping config is opt-in and human names are bounded; malformed settings cannot silently disable capture", () => {
	assert.equal(validateZeroTouchConfig(undefined), null);
	assert.deepEqual(parseTriggersDocument(JSON.stringify({ triggers: [], zeroTouch: config }), "test").zeroTouch, config);
	for (const mutation of [{ ...config, model: "floating" }, { ...config, maxCostUsd: -1 }, { ...config, confidence: 0.5 }, { ...config, summary: "from the question" }, { ...config, names: { [groupId]: "bad\u202ename" } }, { ...config, names: { [groupId]: "a".repeat(121) } }]) assert.throws(() => validateZeroTouchConfig(mutation));
	assert.equal(validateZeroTouchConfig({ ...config, names: { [groupId]: "a".repeat(120) } }).names[groupId].length, 120);
});
test("capture redacts before bounding, requires redactor and refuses overlong context", async () => {
	assert.deepEqual(privateQuestionExcerpt("secret", undefined), { status: "source-unavailable" });
	assert.deepEqual(privateQuestionExcerpt("secret".repeat(3000), text => text.replaceAll("secret", "x")), { status: "unassigned", excerpt: "x".repeat(3000) });
	assert.deepEqual(privateQuestionExcerpt("x".repeat(QUESTION_GROUP_LIMITS.excerptBytes + 1), text => text), { status: "source-oversize" });
	const sent = [];
	const store = makeQuestionGroupStore({ redis: { eval: async (...args) => sent.push(args) }, now: () => nowMs, retentionDays: 0 });
	await store.capture({ runId: "run-1", scopeId, at: nowMs, text: "password=SECRET", redact: text => text.replace("SECRET", "[redacted]") });
	assert.ok(!JSON.stringify(sent).includes("SECRET"));
	assert.ok(JSON.stringify(sent).includes("[redacted]"));
	assert.equal(sent[0][9], 90 * 86400000, "keep forever does not create an unbounded private corpus");
});
test("queue producer persists only references and permits one paid attempt", async () => {
	const sent = [];
	await enqueueQuestionGroupJob({ add: async (...args) => sent.push(args) }, { runId: "source", digest, configDigest: digest }, { nonce: () => "fixed" });
	assert.deepEqual(sent[0][1], { kind: "question-grouping", questionGrouping: { runId: "source", digest, configDigest: digest } });
	assert.equal(sent[0][2].attempts, 1);
	await assert.rejects(enqueueQuestionGroupJob({ add() { throw new Error("must not enqueue"); } }, { runId: "bad/id", digest, configDigest: digest }));
});
function runtimeFixture(changes = {}) {
	const source = { status: "ready", meta: { runId: "source", scopeId, digest, project: null }, excerpt: "PRIVATE QUESTION", revision: 0, candidates: [{ id: groupId, runId: "example", excerpt: "PRIVATE EXAMPLE" }] };
	const calls = [];
	const store = { privateInput: async () => source, setStatus: async (...args) => calls.push(["status", ...args]), assign: async args => (calls.push(["assign", args]), { status: "assigned", groupId }) };
	const runtime = makeQuestionGroupRuntime({ store, triggersPath: "/triggers.json", readFile: () => JSON.stringify({ triggers: [], zeroTouch: config }), getSettings: () => ({ provider: "test", model: "chat" }), resolveClassifier: () => ({ type: "classifier", contextWindow: 4096, cost: { input: 1, output: 0 } }), ...changes });
	const data = { kind: "question-grouping", questionGrouping: { runId: "source", digest, configDigest: questionGroupConfigDigest(config) } };
	return { runtime, data, source, calls, store };
}
test("pickup stages private context in nonenumerable memory and refuses stale configuration before paid work", async () => {
	const { runtime, data } = runtimeFixture();
	const got = await runtime.resolve(data, "grouping-job");
	assert.equal(got.data.purpose, "zero-touch-grouping");
	assert.equal(got.data.questionGrouping.input.source, "PRIVATE QUESTION");
	assert.ok(!JSON.stringify(got.data).includes("PRIVATE"), "deferring a job must never serialize private evidence");
	assert.deepEqual(got.data.models, ["test/chat", "test/classifier"]);
	assert.equal((await runtime.resolve({ ...data, questionGrouping: { ...data.questionGrouping, configDigest: "0".repeat(64) } }, "grouping-job")).result.reason, "question-group-config-changed");
	const writes = [];
	const prepared = prepareQuestionGrouping(got.data, { jobDir: "/job", fs: { mkdirSync: () => {}, writeFileSync: (...args) => writes.push(args) } });
	assert.equal(prepared.workspaceReadOnly, true);
	assert.ok(writes.some(([path, body]) => path.endsWith("question-grouping.json") && body.includes("PRIVATE QUESTION")));
	assert.ok(writes.find(([path]) => path.endsWith("event.json"))[1].includes("zero-touch-grouping"));
});
test("collector imports only a closed slot and cannot retry paid work when import fails", async () => {
	const fixture = runtimeFixture({ fs: { lstatSync: () => ({ isFile: () => true, size: 50 }), readFileSync: () => JSON.stringify({ version: 1, slot: "g0", confidence: 0.95 }) } });
	const job = (await fixture.runtime.resolve(fixture.data, "grouping-job")).data;
	assert.equal((await fixture.runtime.collect({ job, prepared: { outboxDir: "/outbox" }, completed: true })).status, "assigned");
	assert.equal(fixture.calls.find(row => row[0] === "assign")[1].groupId, groupId);
	const bad = runtimeFixture({ fs: { lstatSync: () => ({ isFile: () => true, size: 50 }), readFileSync: () => JSON.stringify({ version: 1, slot: "g0", confidence: 0.95, name: "PRIVATE QUESTION" }) } });
	assert.equal((await bad.runtime.collect({ job: (await bad.runtime.resolve(bad.data, "job")).data, prepared: { outboxDir: "/outbox" }, completed: true })).status, "failed");
	assert.ok(!bad.calls.some(row => row[0] === "assign"));
});
test("fix recurrence counts untouched refusals and unanswered groups over equal spans, with exposure", () => {
	const at = nowMs - 2 * 86400000;
	const fix = { id: groupId, kind: "config", at, runId: "source", scopeId, project: null, groupId: null, reason: "secret-unresolved", triggerIndex: 0 };
	const record = (ended, reason) => ({ touchScopeId: scopeId, endedAt: new Date(ended).toISOString(), reason });
	const records = [record(at - 86400000, "secret-unresolved"), record(at + 86400000, "secret-unresolved"), record(at + 3600000, null)];
	const comparison = compareZeroTouchFixes({ fixes: [fix], records, coverageFromMs: nowMs - 30 * 86400000, nowMs, windowDays: 30 })[0];
	assert.equal(comparison.spanMs, 2 * 86400000);
	assert.equal(comparison.beforeCount, 1); assert.equal(comparison.afterCount, 1); assert.equal(comparison.subsequentRuns, 2); assert.equal(comparison.status, "unchanged");
	const questionFix = { ...fix, groupId, reason: null };
	assert.equal(compareZeroTouchFixes({ fixes: [questionFix], records, assignments: [{ scopeId, groupId, at: at + 1000 }], coverageFromMs: at - 10000, nowMs, windowDays: 30 })[0].afterCount, 1, "an unanswered recurrence still counts");
	assert.equal(compareZeroTouchFixes({ fixes: [fix], records: [], coverageFromMs: nowMs - 30 * 86400000, nowMs, windowDays: 30 })[0].status, "observing");
});
test("classifier type, known context bound and configured cap are free pickup refusals", async () => {
	for (const model of [null, { type: "text", contextWindow: 4096, cost: { input: 1, output: 0 } }, { type: "classifier", cost: { input: 1, output: 0 } }, { type: "classifier", contextWindow: 100000, cost: { input: 1, output: 0 } }, { type: "classifier", contextWindow: 4096, cost: { input: 1, output: 1 } }]) {
		const fixture = runtimeFixture({ resolveClassifier: () => model });
		const result = await fixture.runtime.resolve(fixture.data, "job");
		assert.equal(result.result.reason, "question-group-refused");
		assert.equal(result.result.budgetReserved, false);
		assert.ok(!fixture.calls.some(row => row[0] === "status" && row[2] === "pending"));
	}
});
