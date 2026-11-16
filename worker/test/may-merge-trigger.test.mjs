import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggers, parseTriggersDocument, triggersFileVersionFor, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";
import { mergePolicyDigest } from "../src/merge-policy.mjs";
import { enqueueForgeJob, enqueueLateForgeJob } from "../src/queue.mjs";
import { JOB_DATA_VERSION, jobDataNewer } from "../src/job-data-version.mjs";

const entry = (over = {}) => ({ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", ...over } });
const load = (value) => parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [value] }), "/triggers.json")[0];

for (const kind of ["github", "gitlab", "forgejo", "azure"]) {
	for (const [type, on] of Object.entries({ label: { any: ["pi"] }, comment: { phrase: "@pi" }, pull_request: { action: [kind === "azure" ? "created" : kind === "gitlab" ? "open" : "opened"] }, ...(kind !== "azure" ? { issue: { action: [kind === "gitlab" ? "close" : "closed"] } } : {}) })) {
		test(`${kind} ${type}: explicit permission normalizes, false is exactly the absent run`, () => {
			const base = { on: { type, ...on }, run: { kind, flow: "fix", ...(kind === "azure" && type !== "pull_request" ? { repository: "repo" } : {}) } };
			assert.equal(load({ ...base, run: { ...base.run, mayMerge: true } }).run.mayMerge, true);
			assert.deepEqual(load({ ...base, run: { ...base.run, mayMerge: false } }), load(base));
		});
	}
}

test("permission rejects non-booleans and every unsupported envelope, including false", () => {
	for (const mayMerge of [null, "true", "false", 1, 0, {}, []]) assert.throws(() => load(entry({ mayMerge })), /run.mayMerge must be a boolean/);
	for (const mayMerge of [true, false]) {
		assert.throws(() => load({ on: { type: "cron", id: "x", pattern: "0 * * * *" }, run: { kind: "local", folder: "/work", task: "work", mayMerge } }), /run.mayMerge is accepted only/);
		assert.throws(() => load({ on: { type: "watch", id: "x" }, run: { kind: "local", mayMerge } }), /run.mayMerge is accepted only/);
		assert.throws(() => load(entry({ flow: undefined, command: "do work", mayMerge })), /run.mayMerge is accepted only/);
	}
});

test("permission stamps only content needing it, so older loaders refuse instead of discarding it", () => {
	const raw = entry({ mayMerge: true });
	assert.equal(triggersFileVersionFor({ triggers: [raw] }), 4);
	assert.equal(triggersFileVersionFor({ triggers: [entry()] }), 1);
	assert.throws(() => parseTriggersDocument(JSON.stringify({ triggers: [raw] }), "/t"), /mayMerge needs triggers file version 4/);
	assert.throws(() => parseTriggersDocument(JSON.stringify({ version: 4, triggers: [raw] }), "/t", { supported: 3 }), (e) => e.newer === true);
});

test("both forge builders carry the reviewed reference, stamp the job, and omit false", async () => {
	const normalized = load(entry({ mayMerge: true }));
	const mayMergePolicy = mergePolicyDigest(normalized);
	const fields = { repo: "org/repo", flow: "fix", target: { type: "issue", number: 9 }, trigger: { deliveryId: "d-908", matched: { index: 0, type: "label" } } };
	for (const enqueue of [enqueueForgeJob, enqueueLateForgeJob]) {
		const got = [];
		const queue = { add: async (_name, data, opts) => { got.push(data); return { id: opts.jobId }; } };
		await enqueue(queue, "github", { ...fields, mayMerge: true, mayMergePolicy });
		assert.equal(got[0].mayMerge, true);
		assert.equal(got[0].mayMergePolicy, mayMergePolicy);
		assert.equal(got[0].dataVersion, 5);
		assert.deepEqual(jobDataNewer(got[0], { supported: 4 }), { version: 5 });
		await enqueue(queue, "github", { ...fields, mayMerge: false });
		assert.equal(Object.hasOwn(got[1], "mayMerge"), false);
		assert.equal(Object.hasOwn(got[1], "mayMergePolicy"), false);
		assert.equal(Object.hasOwn(got[1], "dataVersion"), false);
		for (const bad of [{ mayMerge: "true" }, { mayMerge: true }, { mayMerge: true, mayMergePolicy: "bad" }, { mayMerge: false, mayMergePolicy }, { mayMergePolicy }, { mayMerge: true, mayMergePolicy, command: "go" }]) await assert.rejects(enqueue(queue, "github", { ...fields, ...bad }), /merge-policy-invalid/);
		assert.equal(got.length, 2, "malformed policy enqueues nothing");
	}
	assert.equal(JOB_DATA_VERSION, 7);
});
