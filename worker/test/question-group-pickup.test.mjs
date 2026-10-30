import assert from "node:assert/strict";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { makeQuestionGroupRuntime, questionGroupConfigDigest } from "../src/question-group-runtime.mjs";
import { scopeKeyPrefix } from "../src/scoped-limits.mjs";

const NOW = Date.UTC(2026, 9, 30, 12);
const config = { capture: true, model: "test/classifier", maxCostUsd: "0.05", confidence: 0.9, names: {} };
const digest = "b".repeat(64);
function fixture(currentProjects) {
	const ops = [];
	const records = [];
	const runtime = makeQuestionGroupRuntime({
		store: { privateInput: async () => ({ status: "ready", meta: { runId: "source", scopeId: "a".repeat(64), digest, project: "shop" }, excerpt: "private source", revision: 0, candidates: [] }), setStatus: async () => {} },
		triggersPath: "/triggers.json", readFile: () => JSON.stringify({ triggers: [], zeroTouch: config }),
		getSettings: () => ({ provider: "test", model: "chat" }), resolveClassifier: () => ({ type: "classifier", contextWindow: 4096, cost: { input: 0, output: 0 } }),
	});
	const redis = { get: async () => null, incr: async (key) => { ops.push(["incr", key]); return key.startsWith(scopeKeyPrefix("project:shop")) ? 2 : 1; }, decr: async () => 0, expire: async () => {}, del: async () => 0 };
	const processor = makeProcessor({
		redis, now: () => NOW, projects: () => currentProjects, scopedLimits: () => [{ scope: "project:shop", day: 1 }],
		getSettings: () => ({ provider: "test", model: "chat", maxTurns: 1, maxCostUsd: "0.05", dailyCap: 100, weeklyCap: null, monthlyCap: null, concurrency: 1 }),
		recordRun: (row) => records.push(row),
		deps: { questionGroupRuntime: runtime, imagePreflight: async () => ({ ok: true, piVersion: "1.4.0", capabilities: ["questionGrouping", "costCap", "modelPolicy"] }), prepareWorkspace: async () => ({ workspace: "/internal-empty-workspace", jobDir: "/job" }), runContainer: async () => { throw new Error("a refused classification must not start a container"); }, cleanup: async () => {}, comment: async () => {}, log: () => {} },
	});
	const job = { id: "grouping-job", data: { kind: "question-grouping", questionGrouping: { runId: "source", digest, configDigest: questionGroupConfigDigest(config) } }, timestamp: NOW, attemptsMade: 0, opts: { attempts: 1 } };
	return { processor, job, ops, records };
}

test("a resolved grouping job reserves against its source project rather than the empty workspace's other tier", async () => {
	const { processor, job, ops, records } = fixture([{ id: "shop", members: ["github:acme/api"] }]);
	const result = await processor(job, "lock-token", new AbortController().signal);
	assert.equal(result.reason, "project-cap");
	assert.equal(result.budgetReserved, false);
	assert.ok(ops.some(([op, key]) => op === "incr" && key.startsWith(scopeKeyPrefix("project:shop"))), "the real runtime's source identity reaches the project ledger");
	assert.equal(records.at(-1).project, "shop");
});

test("a deleted grouping source project is refused before any ledger or container is reached", async () => {
	const { processor, job, ops, records } = fixture([]);
	const result = await processor(job, "lock-token", new AbortController().signal);
	assert.equal(result.reason, "question-group-config-changed");
	assert.equal(result.budgetReserved, false);
	assert.deepEqual(ops, []);
	assert.equal(records.at(-1).project, null);
});
