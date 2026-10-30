import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Queue } from "bullmq";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedisClient } from "../src/connection.mjs";
import { enqueueQuestionGroupJob } from "../src/queue.mjs";
import { makeQuestionGroupStore } from "../src/question-groups.mjs";
import { makeQuestionGroupRuntime, questionGroupConfigDigest } from "../src/question-group-runtime.mjs";
import { makePrepareWorkspace } from "../src/prepare.mjs";
import { makeProcessor } from "../src/index.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { computeZeroTouch } from "../src/zero-touch.mjs";
import { executeQuestionGrouping, readQuestionGrouping } from "../../image/runner/src/question-grouping.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("question-group-pipeline.integration requires VALKEY_TEST_URL");
const skip = url ? false : "needs VALKEY_TEST_URL";
const CLOCK = Date.UTC(2026, 9, 30, 12);
const MODEL = { provider: "openrouter", id: "typesafe/jev-1.13", type: "classifier", api: "openrouter-classifier", contextWindow: 4096, cost: { input: 1, output: 0 } };
const PRIVATE = "PRIVATE question and exemplar text must stay out of references and metadata";

/** Prefix every ledger key, including Lua KEYS, so this file can run beside every other real-queue test. */
function isolatedLedger(redis, prefix, events) {
	const one = (method) => async (key, ...args) => {
		if (method === "incr") events.push("job-reserve");
		return redis[method](`${prefix}${key}`, ...args);
	};
	return {
		...Object.fromEntries(["get", "incr", "decr", "expire", "incrby", "set", "hgetall", "exists", "pexpire", "hget", "del"].map((method) => [method, one(method)])),
		async eval(script, count, ...args) {
			const keys = args.slice(0, count).map((key) => `${prefix}${key}`);
			if (keys.some((key) => key.includes("budget:usd"))) events.push("dollar-ledger");
			return redis.eval(script, count, ...keys, ...args.slice(count));
		},
	};
}
async function fixture(t) {
	const root = tempDir("question-pipeline-");
	const jobsDir = join(root, "jobs");
	mkdirSync(jobsDir);
	const name = `question-pipeline-${randomBytes(8).toString("hex")}`;
	const redis = makeRedisClient(url);
	const queue = new Queue(name, { connection: redis });
	t.after(async () => {
		await queue.obliterate({ force: true });
		await queue.close();
		const keys = await redis.keys(`${name}:*`);
		if (keys.length) await redis.del(...keys);
		redis.disconnect();
	});
	const config = { capture: true, model: `${MODEL.provider}/${MODEL.id}`, maxCostUsd: "0.05", confidence: 0.9, names: {} };
	const triggersPath = join(root, "triggers.json");
	const document = { triggers: [], zeroTouch: config };
	writeFileSync(triggersPath, JSON.stringify(document));
	const store = makeQuestionGroupStore({ redis, now: () => CLOCK, prefix: `${name}:questions:` });
	const scopeId = "a".repeat(64);
	await store.capture({ runId: "source", scopeId, project: "api", repo: "acme/api", at: CLOCK - 1000, text: PRIVATE, redact: (text) => text });
	const meta = await store.readMeta("source");
	const id = await enqueueQuestionGroupJob(queue, { runId: "source", digest: meta.digest, configDigest: questionGroupConfigDigest(config) }, { nonce: () => "fixed" });
	const job = await queue.getJob(id);
	const settings = { provider: "anthropic", model: "claude-sonnet-4-5-20250929", maxTurns: 10, concurrency: 3, dailyCap: 10, dailyCostUsd: "1", maxCostUsd: "0.05" };
	const runtime = makeQuestionGroupRuntime({ store, triggersPath, getSettings: () => settings, resolveClassifier: () => MODEL });
	return { root, jobsDir, name, redis, queue, store, job, runtime, settings, document, triggersPath, scopeId };
}

test("real references, corpus and admission reserve before the isolated classifier, then import an opaque group", { skip }, async (t) => {
	const f = await fixture(t);
	const events = [], credentials = [], records = [];
	const ledger = isolatedLedger(f.redis, `${f.name}:ledger:`, events);
	const prepare = makePrepareWorkspace({ jobsDir: f.jobsDir, forgeFor: () => assert.fail("grouping cannot resolve a forge"), prepareLocal: () => assert.fail("grouping has no repository to prepare") });
	let calls = 0;
	const process = makeProcessor({
		redis: ledger, now: () => CLOCK, getSettings: () => f.settings,
		projects: () => [{ id: "api", members: ["github:acme/api"] }],
		cancelJob() {}, stopContainer() {}, cancelPollMs: 60000,
		recordRun: (args) => records.push(buildRecord({ ...args, host: "test-host", touchTracking: true })),
		deps: {
			questionGroupRuntime: f.runtime,
			imagePreflight: async () => ({ ok: true, piVersion: "1.4.0", capabilities: ["costCap", "modelPolicy", "questionGrouping"] }),
			checkProviderCredential: async (job) => { credentials.push(job.provider); return { ok: true }; },
			checkModelsKnown: () => ({ ok: true }),
			prepareWorkspace: async (...args) => { events.push("prepare"); return prepare(...args); },
			mintToken: async () => assert.fail("no forge token belongs to a grouping job"),
			async runContainer({ job, prepared }) {
				events.push("container");
				assert.equal(job.purpose, "zero-touch-grouping");
				assert.equal(prepared.workspaceReadOnly, true);
				assert.equal(statSync(join(prepared.jobDir, "question-grouping.json")).mode & 0o777, 0o444);
				assert.equal(readFileSync(join(prepared.jobDir, "prompt.md"), "utf8"), "");
				assert.ok(events.includes("job-reserve"));
				const dollarKeys = await f.redis.keys(`${f.name}:ledger:budget:usd:*`);
				assert.ok(dollarKeys.length > 0, "ordinary dollar windows were reserved before any classifier call");
				assert.ok((await f.redis.mget(...dollarKeys)).some((value) => Number(value) === 50000), "the real window holds the configured cap");
				const input = readQuestionGrouping({ path: join(prepared.jobDir, "question-grouping.json") });
				const done = await executeQuestionGrouping({ input, outbox: prepared.outboxDir, runtime: {
					getModelsOfType: (type, provider) => { assert.equal(type, "classifier"); assert.equal(provider, MODEL.provider); return [MODEL]; },
					async classify(_model, context) {
						calls++; events.push("classify");
						assert.equal(context.state.source, PRIVATE);
						return { stopReason: "stop", answers: { group: { type: "choice", choice: "new", probabilities: { new: 0.97, unassigned: 0.03 } } } };
					},
				} });
				assert.equal(done.ok, true);
				assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(prepared.outboxDir, "question-group.json")))).sort(), ["confidence", "slot", "version"]);
				return { code: 0, aborted: false, turns: 0, tokens: { input: 1, output: 0, total: 1, cost: 0, metered: true } };
			},
			collectChain: async () => ({ enqueued: 0, refused: 0 }), cleanup: async () => {}, comment: async () => assert.fail("grouping posts nothing"),
		},
	});
	assert.doesNotMatch(JSON.stringify(f.job.data), /PRIVATE/);
	const result = await process(f.job, "token", new AbortController().signal);
	assert.equal(result.outcome, "completed");
	assert.equal(calls, 1);
	assert.deepEqual(credentials, ["anthropic", "openrouter"], "both credentials pass the free gate");
	assert.ok(events.indexOf("job-reserve") < events.indexOf("container"));
	assert.ok(events.indexOf("dollar-ledger") < events.indexOf("classify"));
	const assigned = await f.store.readMeta("source");
	assert.equal(assigned.status, "assigned", "processor finalization imports the classifier result");
	assert.match(assigned.groupId, /^[a-f0-9]{32}$/);
	assert.equal(records.at(-1).purpose, "zero-touch-grouping");
	assert.equal(records.at(-1).project, "api", "analysis spend retains its source project's admission binding");
	assert.equal(computeZeroTouch({ records, nowMs: CLOCK + 1, windowDays: 7, coverage: { fromMs: CLOCK - 7 * 86400000 } }).totals.runs, 0);
	assert.doesNotMatch(JSON.stringify(await f.store.publicSnapshot()), /PRIVATE/);
});

test("a persisted admission deferral reconstructs private context and overrides queued execution selectors", { skip }, async (t) => {
	const f = await fixture(t);
	const first = (await f.runtime.resolve(f.job.data, f.job.id)).data;
	assert.equal(first.questionGrouping.input.source, PRIVATE);
	const saved = JSON.parse(JSON.stringify(first));
	assert.equal(saved.questionGrouping.input, undefined);
	saved.provider = "attacker"; saved.model = "arbitrary"; saved.secrets = { EXFILTRATE: "value" }; saved.github = true;
	await f.job.updateData(saved);
	const restored = (await f.runtime.resolve((await f.queue.getJob(f.job.id)).data, f.job.id)).data;
	assert.equal(restored.provider, "anthropic");
	assert.equal(restored.model, f.settings.model);
	assert.equal(restored.github, false);
	assert.equal(restored.secrets, undefined);
	assert.equal(restored.questionGrouping.input.source, PRIVATE);
	assert.doesNotMatch(JSON.stringify(restored), /PRIVATE|EXFILTRATE|attacker/);
});

test("missing secondary credentials and exhausted windows never dispatch a classifier", { skip }, async (t) => {
	for (const refusal of ["credential", "budget"]) {
		const f = await fixture(t);
		const events = [];
		const process = makeProcessor({ redis: isolatedLedger(f.redis, `${f.name}:ledger:`, events), now: () => CLOCK, getSettings: () => ({ ...f.settings, ...(refusal === "budget" ? { dailyCap: 0 } : {}) }),
			projects: () => [{ id: "api", members: ["github:acme/api"] }], cancelJob() {}, stopContainer() {},
			deps: { questionGroupRuntime: f.runtime,
				checkProviderCredential: (job) => job.provider === "openrouter" && refusal === "credential" ? { ok: false } : { ok: true },
				prepareWorkspace: makePrepareWorkspace({ jobsDir: f.jobsDir }),
				runContainer: () => assert.fail("a free or budget refusal cannot dispatch"), cleanup: async () => {}, comment: async () => {},
			},
		});
		const result = await process(f.job, "token", new AbortController().signal);
		assert.equal(result.outcome, "policy");
		assert.equal(result.reason, refusal === "credential" ? "provider-unconfigured" : "over-budget");
		if (refusal === "credential") assert.ok(!events.includes("job-reserve"), "credential refusal runs before reserve");
	}
});

test("expired private context is a recorded policy refusal before credentials, preparation or reservations", { skip }, async (t) => {
	const f = await fixture(t);
	const privateKeys = await f.redis.keys(`${f.name}:questions:private:*`);
	assert.equal(privateKeys.length, 1);
	await f.redis.del(...privateKeys);
	const events = [], records = [];
	const process = makeProcessor({
		redis: isolatedLedger(f.redis, `${f.name}:ledger:`, events), now: () => CLOCK, getSettings: () => f.settings,
		cancelJob() {}, stopContainer() {},
		recordRun: (args) => records.push(buildRecord({ ...args, host: "test-host", touchTracking: true })),
		deps: {
			questionGroupRuntime: f.runtime,
			checkProviderCredential: () => assert.fail("expired input is a free refusal before credential work"),
			prepareWorkspace: () => assert.fail("expired input cannot prepare a container"),
			runContainer: () => assert.fail("expired input cannot spend"),
		},
	});
	const result = await process(f.job, "token", new AbortController().signal);
	assert.equal(result.outcome, "policy");
	assert.equal(result.reason, "question-group-source-expired");
	assert.equal(result.budgetReserved, false);
	assert.deepEqual(events, []);
	assert.equal(records[0].purpose, "zero-touch-grouping");
	assert.equal(records[0].kind, null, "an unresolved internal reference adds no public forge/local kind");
	assert.equal((await f.store.readMeta("source")).status, "source-expired");
});
