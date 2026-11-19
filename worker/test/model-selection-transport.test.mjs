import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile } from "../src/cron.mjs";
import { localJobId } from "../src/job-id.mjs";
import { jobDataNewer, jobDataVersionFor } from "../src/job-data-version.mjs";
import { enqueueForgeJob, enqueueLocalJobReporting, enqueueTriggerRunReporting } from "../src/queue.mjs";
import { localRunData } from "../src/local-job.mjs";
import { loadSchedules } from "../src/schedules.mjs";
import { modelSelectionGenerationValid, withModelSelectionGeneration } from "../src/model-selection-generation.mjs";

const POLICY = { strategy: "random", candidates: ["openai/gpt-5.4", "anthropic/claude-haiku-4-5"] };
const NOW = new Date("2026-11-16T10:00:00.000Z");
const LOCAL = { folder: "/project", flow: "work", task: "t", models: POLICY.candidates, modelSelection: POLICY, now: NOW };

function queue() {
	const jobs = new Map();
	return {
		jobs,
		async add(name, data, opts) {
			if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, { id: opts.jobId, name, data: structuredClone(data), timestamp: NOW.getTime(), getState: async () => "waiting" });
			return { id: opts.jobId };
		},
		async getJob(id) { return jobs.get(id); },
	};
}

test("random generation is absent for legacy jobs and is host-produced even if the caller supplies one", () => {
	const legacy = { kind: "local" };
	assert.equal(withModelSelectionGeneration(legacy), legacy);
	const stamped = withModelSelectionGeneration({ modelSelection: POLICY, modelSelectionGeneration: "untrusted" }, { nonce: () => "host-generation" });
	assert.equal(stamped.modelSelectionGeneration, "host-generation");
	assert.equal(jobDataVersionFor(stamped), 7);
	assert.equal(jobDataVersionFor({ modelSelection: POLICY }), 7);
	assert.equal(jobDataNewer({ ...stamped, dataVersion: 7 }, { supported: 6 }).version, 7);
});

test("local dedup retains the original generation; fresh reuse at the identical instant gets a new generation", async () => {
	const q = queue();
	const first = await enqueueLocalJobReporting(q, LOCAL);
	const a = structuredClone(q.jobs.get(first.id).data);
	assert.equal(modelSelectionGenerationValid(a.modelSelectionGeneration), true);
	assert.deepEqual(a.modelSelection, POLICY);
	assert.equal(a.dataVersion, 7);
	const duplicate = await enqueueLocalJobReporting(q, LOCAL);
	assert.ok(duplicate.existing);
	assert.equal(q.jobs.get(first.id).data.modelSelectionGeneration, a.modelSelectionGeneration);
	q.jobs.delete(first.id);
	const fresh = await enqueueLocalJobReporting(q, { ...LOCAL, modelSelectionGeneration: a.modelSelectionGeneration });
	assert.equal(fresh.id, first.id);
	assert.equal(q.jobs.get(first.id).timestamp, NOW.getTime());
	assert.notEqual(q.jobs.get(first.id).data.modelSelectionGeneration, a.modelSelectionGeneration);
});

test("pool enters local identity but generation never changes dedup identity", () => {
	const base = { folder: "/project", flow: "work", task: "t", minute: "2026-11-16T10:00" };
	const random = localJobId({ ...base, modelSelection: POLICY });
	assert.notEqual(random, localJobId(base));
	assert.notEqual(random, localJobId({ ...base, modelSelection: { ...POLICY, candidates: [POLICY.candidates[0]] } }));
	assert.equal(random, localJobId({ ...base, modelSelection: POLICY, modelSelectionGeneration: "ignored" }));
});

test("forge deliveries mint generations and a removed delivery id cannot recover its old choice", async () => {
	const q = queue();
	const fields = { repo: "a/b", target: { type: "issue", number: 1 }, flow: "work", trigger: { deliveryId: "delivery" }, modelSelection: POLICY };
	await enqueueForgeJob(q, "github", fields);
	const [job] = q.jobs.values();
	const first = job.data.modelSelectionGeneration;
	assert.equal(modelSelectionGenerationValid(first), true);
	assert.deepEqual(job.data.modelSelection, POLICY);
	await enqueueForgeJob(q, "github", fields);
	assert.equal(q.jobs.get(job.id).data.modelSelectionGeneration, first);
	q.jobs.delete(job.id);
	await enqueueForgeJob(q, "github", { ...fields, modelSelectionGeneration: first });
	assert.notEqual(q.jobs.get(job.id).data.modelSelectionGeneration, first);
});

test("manual trigger jobs draw as fresh logical enqueues rather than inheriting a scheduler generation", async () => {
	const q = queue();
	const schedule = { schedulerId: "nightly", name: "local", data: { ...localRunData({ kind: "local", ...LOCAL }), dataVersion: 7, modelSelectionGeneration: "template" }, opts: {} };
	const result = await enqueueTriggerRunReporting(q, schedule, { now: NOW });
	const job = q.jobs.get(result.id);
	assert.notEqual(job.data.modelSelectionGeneration, "template");
	assert.equal(modelSelectionGenerationValid(job.data.modelSelectionGeneration), true);
	const generation = job.data.modelSelectionGeneration;
	await enqueueTriggerRunReporting(q, schedule, { now: NOW });
	assert.equal(job.data.modelSelectionGeneration, generation);
});

test("cron keeps unchanged template generation on reload and recreates it after deletion", async () => {
	let resident;
	let calls = 0;
	const nonce = () => `00000000-0000-4000-8000-${String(++calls).padStart(12, "0")}`;
	const q = {
		async getJobScheduler() { return resident; },
		async upsertJobScheduler(id, repeat, template) { resident = { key: id, ...repeat, template: structuredClone(template) }; },
		async getJobSchedulers() { return resident ? [resident] : []; },
	};
	const schedule = { schedulerId: "nightly", name: "local", pattern: "0 * * * *", data: { ...localRunData({ kind: "local", ...LOCAL }), dataVersion: 7 }, opts: {} };
	assert.equal("modelSelectionGeneration" in schedule.data, false, "pure normalization does not mint identity");
	await reconcile(q, [schedule], { nonce });
	const first = resident.template.data.modelSelectionGeneration;
	await reconcile(q, [schedule], { nonce });
	assert.equal(resident.template.data.modelSelectionGeneration, first);
	assert.equal(calls, 1);
	resident = undefined;
	await reconcile(q, [schedule], { nonce });
	assert.notEqual(resident.template.data.modelSelectionGeneration, first);
	assert.equal(calls, 2);
});

test("auxiliary grants survive local, manual and every forge queue builder without joining the root pool", async () => {
	const auxiliaryModels = ["openrouter/google/gemini-4-neon"];
	const models = [...POLICY.candidates, ...auxiliaryModels];
	const fields = { ...LOCAL, models, auxiliaryModels, maxCostUsd: "1" };
	const q = queue();
	const local = await enqueueLocalJobReporting(q, fields);
	const check = (data) => {
		assert.deepEqual(data.auxiliaryModels, auxiliaryModels);
		assert.deepEqual(data.models, models);
		assert.deepEqual(data.modelSelection.candidates, POLICY.candidates);
		assert.equal(data.maxCostUsd, "1");
		assert.equal(data.dataVersion, 11);
		assert.deepEqual(jobDataNewer(data, { supported: 10 }), { version: 11 });
	};
	check(q.jobs.get(local.id).data);
	for (const forge of ["github", "gitlab", "forgejo", "azure"]) {
		const id = await enqueueForgeJob(q, forge, { ...fields, repo: "a/b", target: { type: "issue", number: 1 }, trigger: { deliveryId: `aux-${forge}` } });
		check(q.jobs.get(id.jobId).data);
	}
	const [schedule] = loadSchedules({ triggersFile: "/triggers.json" }, { existsSync: () => true, readFileSync: () => JSON.stringify({ version: 9, triggers: [{ on: { type: "cron", id: "aux-nightly", pattern: "0 * * * *" }, run: { kind: "local", ...fields } }] }) });
	const data = schedule.data;
	const manual = await enqueueTriggerRunReporting(q, { schedulerId: "aux-nightly", name: "local", data, opts: {} }, { now: NOW });
	check(q.jobs.get(manual.id).data);
	let template;
	await reconcile({ getJobSchedulers: async () => [], getJobScheduler: async () => null, upsertJobScheduler: async (_id, _repeat, next) => { template = next; } }, [{ schedulerId: "aux-nightly", name: "local", pattern: "0 * * * *", data, opts: {} }]);
	check(template.data);
	assert.notEqual(localJobId({ ...LOCAL, auxiliaryModels }), localJobId(LOCAL), "a changed grant is distinct work");
	assert.notEqual(localJobId({ ...LOCAL, auxiliaryModels }), localJobId({ ...LOCAL, auxiliaryModels: [models[0]] }));
});
