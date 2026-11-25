import assert from "node:assert/strict";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { makeQuestionGroupRuntime, questionGroupConfigDigest } from "../src/question-group-runtime.mjs";
import { validateZeroTouchConfig } from "../src/question-groups.mjs";
import { buildContainerEnv, declaredProviderKey, providerKeyCandidates } from "../src/env-allowlist.mjs";
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

// Issue #1013: the zeroTouch block's declared keys, from the real runtime through the processor's credential gate.
test("issue #1013: a grouping job's declared keys reach its main and classifier credentials through the real runtime and gate, the host's keys stay out, and an empty value refuses before spend", async () => {
	const block = { ...config, model: "openai/omni-moderation-latest", secrets: { OPENAI_API_KEY: "op://ci/openai", OPENROUTER_API_KEY: "op://ci/openrouter", ANTHROPIC_API_KEY: "op://ci/anthropic" } };
	// The worker's gate for a provider no subscription binds (start.mjs `checkProviderCredential`), on the real rule.
	const gate = (job, { secrets = null } = {}) => {
		const declared = declaredProviderKey(job);
		if (declared === null) return { ok: true };
		if (secrets === null) return { ok: true, declared };
		return typeof secrets[declared] === "string" && secrets[declared] !== "" ? { ok: true, declared } : { ok: false };
	};
	const run = async (values) => {
		const containerSaw = [], resolverSaw = [], logs = [], records = [];
		const runtime = makeQuestionGroupRuntime({
			store: { privateInput: async () => ({ status: "ready", meta: { runId: "source", scopeId: "a".repeat(64), digest, project: null }, excerpt: "private source", revision: 0, candidates: [] }), setStatus: async () => {} },
			triggersPath: "/triggers.json", readFile: () => JSON.stringify({ version: 12, triggers: [], zeroTouch: block }), providerKeyNames: providerKeyCandidates, log: (event, fields) => logs.push({ event, fields }),
			getSettings: () => ({ provider: "openrouter", model: "deepseek/deepseek-chat" }), resolveClassifier: () => ({ type: "classifier", contextWindow: 4096, cost: { input: 0, output: 0 } }),
		});
		const redis = { get: async () => null, incr: async () => 1, decr: async () => 0, expire: async () => {}, del: async () => 0 };
		const processor = makeProcessor({
			redis, now: () => NOW, projects: () => [],
			getSettings: () => ({ provider: "openrouter", model: "deepseek/deepseek-chat", maxTurns: 1, maxCostUsd: "0.05", dailyCap: 100, weeklyCap: null, monthlyCap: null, concurrency: 1 }),
			recordRun: (row) => records.push(row),
			deps: {
				questionGroupRuntime: runtime, checkProviderCredential: gate, checkModelsKnown: () => ({ ok: true }),
				resolveSecrets: async (job, options) => (resolverSaw.push({ names: Object.keys(job.secrets), mainCredential: options?.mainCredential }), { ok: true, secrets: { ...values } }),
				imagePreflight: async () => ({ ok: true, piVersion: "1.4.0", capabilities: ["questionGrouping", "costCap", "modelPolicy"] }), prepareWorkspace: async () => ({ workspace: "/internal-empty-workspace", jobDir: "/job", outboxDir: "/job/outbox" }),
				runContainer: async (ctx) => (containerSaw.push(ctx), { code: 0, aborted: false }), cleanup: async () => {}, comment: async () => {}, log: () => {},
			},
		});
		const job = { id: "grouping-job", data: { kind: "question-grouping", questionGrouping: { runId: "source", digest, configDigest: questionGroupConfigDigest(validateZeroTouchConfig(block)) } }, timestamp: NOW, attemptsMade: 0, opts: { attempts: 1 } };
		return { result: await processor(job, "lock-token", new AbortController().signal), containerSaw, resolverSaw, logs };
	};
	const ran = await run({ OPENROUTER_API_KEY: "sk-or-declared-private", OPENAI_API_KEY: "sk-declared-openai-private" });
	assert.equal(ran.containerSaw.length, 1, JSON.stringify(ran.result));
	// The settings file's provider is the main model's, the block's classifier the secondary one; the anthropic key is
	// neither's, so the builder withheld it and the resolver never read it.
	assert.deepEqual(ran.resolverSaw, [{ names: ["OPENAI_API_KEY", "OPENROUTER_API_KEY"], mainCredential: "OPENROUTER_API_KEY" }]);
	assert.deepEqual(ran.logs, [{ event: "declared_key_withheld", fields: { zeroTouch: true, names: ["ANTHROPIC_API_KEY"] } }]);
	const ctx = ran.containerSaw[0];
	assert.deepEqual([ctx.mainCredential, ctx.secondaryCredential], ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]);
	const env = buildContainerEnv({ provider: ctx.job.provider, secondaryProvider: ctx.job.questionGroupModel.provider, model: ctx.job.model, maxTurns: 1, jobId: "grouping", forgeKind: "local", hostEnv: { OPENROUTER_API_KEY: "host-openrouter", OPENAI_API_KEY: "host-openai", ANTHROPIC_API_KEY: "host-anthropic" }, secrets: ctx.secrets, mainCredential: ctx.mainCredential, secondaryCredential: ctx.secondaryCredential });
	assert.deepEqual([env.OPENROUTER_API_KEY, env.OPENAI_API_KEY, env.ANTHROPIC_API_KEY], ["sk-or-declared-private", "sk-declared-openai-private", undefined]);
	const empty = await run({ OPENROUTER_API_KEY: "sk-or-declared-private", OPENAI_API_KEY: "" });
	assert.deepEqual([empty.result.reason, empty.result.budgetReserved, empty.containerSaw.length], ["provider-unconfigured", false, 0]);
});
