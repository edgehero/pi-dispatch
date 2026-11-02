import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_DATA_FIELD_VERSIONS, JOB_DATA_VERSION, JOB_DATA_VERSION_FIELD, jobDataNewer, withJobDataVersion } from "../src/job-data-version.mjs";
import { enqueueForgeJob, enqueueLateForgeJob, enqueueLocalJob, enqueueLocalJobReporting } from "../src/queue.mjs";
import { loadSchedules } from "../src/schedules.mjs";
import { approvalTargetKey } from "../src/approval-state.mjs";

// The job data builders stamp `dataVersion` (issue #761, DES-STORE-VERSION-WHEN-NEEDED): the lowest version the data's
// fields need, never below the version the input arrived with, and nothing at all while that is 1. The shipped table is
// empty, so today's data is byte-identical; an INJECTED table runs the machinery. Input from a release newer than the
// builder's throws a RangeError (`code: "newer-release"`) before anything is queued.

// A future field: an existing job data key stands in for it, at version 2, with a build that reads version 2.
const V2 = Object.freeze({ table: Object.freeze({ waitFor: 2 }), supported: 2 });
const WAIT = [{ profile: "jira", ticket: "PD-1" }];

function fakeQueue(request = null) {
	const adds = [];
	const redis = {
		eval() {
			throw new Error("binding must only read");
		},
		async get(key) {
			if (request && key === approvalTargetKey({ kind: "github", ...FORGE })) return request.requestId;
			return request ? JSON.stringify(request) : null;
		},
	};
	return {
		adds,
		name: "pi-jobs",
		client: Promise.resolve(redis),
		async add(name, data, opts) {
			adds.push({ name, data, opts });
			return { id: opts.jobId };
		},
		async getJob(id) {
			const added = adds.find((a) => a.opts.jobId === id);
			return added ? { data: added.data, timestamp: 0, getState: async () => "waiting" } : null;
		},
	};
}

const FORGE = { repo: "acme/web", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "d-761", sender: { id: 1 } } };
const LOCAL = { folder: "/srv/site", flow: "tidy", task: "t", now: new Date("2026-11-02T09:00:00Z") };

test("the shipped table is empty and this build reads version 1, so nothing is stamped today", () => {
	assert.deepEqual(JOB_DATA_FIELD_VERSIONS, { packageCanary: 2 }, "issue #796: an older worker would run a plain paid job in a canary's place");
	assert.equal(JOB_DATA_VERSION, 2);
	assert.equal(JOB_DATA_VERSION_FIELD, "dataVersion");
});

test("every builder's data is unchanged by the stamp today: no dataVersion key, and every key it always had", async () => {
	const q = fakeQueue();
	await enqueueForgeJob(q, "github", { ...FORGE, waitFor: WAIT });
	await enqueueLateForgeJob(q, "github", { ...FORGE, trigger: { ...FORGE.trigger, deliveryId: "d-late" } });
	await enqueueLocalJob(q, LOCAL);
	for (const { data } of q.adds) assert.equal(Object.hasOwn(data, JOB_DATA_VERSION_FIELD), false, JSON.stringify(data));
	// Byte-identical: the exact text of a forge job and a local job, keys in their order, undefined fields dropped.
	assert.equal(JSON.stringify(q.adds[0].data), '{"kind":"github","repo":"acme/web","target":{"type":"issue","number":7},"flow":"fix","trigger":{"deliveryId":"d-761","sender":{"id":1}},"waitFor":[{"profile":"jira","ticket":"PD-1"}]}');
	assert.equal(JSON.stringify(q.adds[2].data), '{"kind":"local","folder":"/srv/site","flow":"tidy","task":"t"}');
	// A version-1 input (written by hand, or by a build that stamped 1) is stored as nothing, version 1's spelling.
	await enqueueForgeJob(q, "github", { ...FORGE, trigger: { ...FORGE.trigger, deliveryId: "d-v1" }, dataVersion: 1 });
	assert.equal(Object.hasOwn(q.adds.at(-1).data, JOB_DATA_VERSION_FIELD), false);
});

test("with an injected table, a forge job using the field is stamped with the lowest version it needs, last, and one without it is not", async () => {
	const q = fakeQueue();
	await enqueueForgeJob(q, "github", { ...FORGE, waitFor: WAIT }, { dataVersions: V2 });
	assert.equal(q.adds[0].data.dataVersion, 2);
	assert.equal(Object.keys(q.adds[0].data).at(-1), "dataVersion");
	await enqueueForgeJob(q, "github", { ...FORGE, trigger: { ...FORGE.trigger, deliveryId: "d-2" } }, { dataVersions: V2 });
	assert.equal(Object.hasOwn(q.adds[1].data, "dataVersion"), false, "unsetting the field drops the stamp");
	await enqueueLateForgeJob(q, "github", { ...FORGE, waitFor: WAIT, trigger: { ...FORGE.trigger, deliveryId: "d-3" } }, { dataVersions: V2 });
	assert.equal(q.adds[2].data.dataVersion, 2, "the late-message path stamps through the same builder");
	await enqueueLocalJob(q, { ...LOCAL, models: ["anthropic/m"] }, { dataVersions: { table: Object.freeze({ models: 2 }), supported: 2 } });
	assert.equal(q.adds[3].data.dataVersion, 2, "and the local builder");
	const reported = await enqueueLocalJobReporting(q, { ...LOCAL, task: "u", models: ["anthropic/m"] }, { dataVersions: { table: Object.freeze({ models: 2 }), supported: 2 } });
	assert.equal(reported.existing, null);
	assert.equal(q.adds[4].data.dataVersion, 2);
});

test("an input's own version is kept when its fields need less (a stored job re-enqueued is never lowered)", async () => {
	const q = fakeQueue();
	await enqueueForgeJob(q, "github", { ...FORGE, dataVersion: 2 }, { dataVersions: { supported: 2 } });
	assert.equal(q.adds[0].data.dataVersion, 2);
	await enqueueLocalJob(q, { ...LOCAL, dataVersion: 2 }, { dataVersions: { supported: 2 } });
	assert.equal(q.adds[1].data.dataVersion, 2);
});

test("input from a newer release (or a version nothing wrote) throws newer-release before anything is queued", async () => {
	const newerRelease = (e) => e instanceof RangeError && e.code === "newer-release" && !/PD-1/.test(e.message);
	for (const dataVersion of [3, "3", 0, null]) {
		const q = fakeQueue();
		await assert.rejects(enqueueForgeJob(q, "github", { ...FORGE, waitFor: WAIT, dataVersion }), newerRelease, String(dataVersion));
		await assert.rejects(enqueueLateForgeJob(q, "github", { ...FORGE, dataVersion }), newerRelease);
		await assert.rejects(enqueueLocalJob(q, { ...LOCAL, dataVersion }), newerRelease);
		await assert.rejects(enqueueLocalJobReporting(q, { ...LOCAL, dataVersion }), newerRelease);
		assert.equal(q.adds.length, 0, "nothing queued");
	}
});

test("a malformed dataVersion (present, not a whole number of 1 or more) is held like a newer one, and its words never say 'above'", async () => {
	// No release writes one. The processor's gate defers such a job (`jobDataNewer` answers for it), which spends nothing
	// and which an operator can cancel; running it would guess at data nothing here wrote. A builder refuses to rebuild it.
	const words = "job data carries a dataVersion this build cannot read (newer than 2, or not a whole number of 1 or more), so it cannot rebuild it";
	for (const dataVersion of [null, "1", 1.5, 0]) {
		assert.deepEqual(jobDataNewer({ ...FORGE, dataVersion }), { version: null }, JSON.stringify(dataVersion));
		assert.throws(() => withJobDataVersion({ ...FORGE, dataVersion }), (e) => e instanceof RangeError && e.message === words, JSON.stringify(dataVersion));
		const q = fakeQueue();
		await assert.rejects(enqueueForgeJob(q, "github", { ...FORGE, dataVersion }), (e) => e.code === "newer-release" && e.message === words);
		assert.equal(q.adds.length, 0, "nothing queued");
	}
	// A newer one says the same, with this build's version in it.
	assert.throws(() => withJobDataVersion({ ...FORGE, dataVersion: 4 }, { supported: 3 }), (e) => e.message === words.replace("newer than 2", "newer than 3"));
});

test("with an injected value table, the builders stamp a wider value of an existing field and leave an ordinary one byte-identical", async () => {
	// A condition kind this build does not have stands in for one a later release adds to `waitFor`.
	const valueTable = Object.freeze({ waitFor: (conditions) => (Array.isArray(conditions) && conditions.some((c) => Object.hasOwn(c ?? {}, "issueClosed")) ? 3 : 1) });
	const q = fakeQueue();
	await enqueueForgeJob(q, "github", { ...FORGE, waitFor: [...WAIT, { issueClosed: 12 }] }, { dataVersions: { valueTable, supported: 3 } });
	assert.equal(q.adds[0].data.dataVersion, 3);
	assert.equal(Object.keys(q.adds[0].data).at(-1), "dataVersion");
	assert.deepEqual(jobDataNewer(q.adds[0].data), { version: 3 }, "a worker of this build's version defers it");
	await enqueueForgeJob(q, "github", { ...FORGE, waitFor: WAIT, trigger: { ...FORGE.trigger, deliveryId: "d-plain" } }, { dataVersions: { valueTable, supported: 3 } });
	assert.equal(JSON.stringify(q.adds[1].data), '{"kind":"github","repo":"acme/web","target":{"type":"issue","number":7},"flow":"fix","trigger":{"deliveryId":"d-plain","sender":{"id":1}},"waitFor":[{"profile":"jira","ticket":"PD-1"}]}');
	await enqueueLocalJob(q, { ...LOCAL, models: ["anthropic/m"] }, { dataVersions: { valueTable: Object.freeze({ models: (m) => (m.length > 0 ? 3 : 1) }), supported: 3 } });
	assert.equal(q.adds[2].data.dataVersion, 3, "and the local builder");
});

test("the approval binding adds a field after the build, and the stored data is stamped for it too", async () => {
	const request = { version: 1, requestId: "request-1", state: "pending", runId: "run", kind: "github", repo: "acme/web", target: FORGE.target, action: "deploy:staging", toolCallId: "call-1", configDigest: "digest", sessionKey: "key", host: "host-1", createdAt: 1 };
	const q = fakeQueue(request);
	const input = { ...FORGE, resume: true, gates: ["deploy:staging"], trigger: { ...FORGE.trigger, comment: { body: "/approve" } } };
	await enqueueForgeJob(q, "github", input, { dataVersions: { table: Object.freeze({ approvalRequestId: 2 }), supported: 2 } });
	assert.equal(q.adds[0].data.approvalRequestId, "request-1");
	assert.equal(q.adds[0].data.dataVersion, 2);
	const plain = fakeQueue(request);
	await enqueueForgeJob(plain, "github", input);
	assert.equal(Object.hasOwn(plain.adds[0].data, "dataVersion"), false, "and nothing with the shipped table");
});

test("the cron template is stamped like every builder: nothing today, the lowest version needed with an injected table", () => {
	const cron = (run) => JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "t", ...run } }] });
	const load = (text, dataVersions) => loadSchedules({ triggersFile: "/triggers.json" }, { readFileSync: () => text, existsSync: () => true, ...(dataVersions ? { dataVersions } : {}) })[0].data;
	const today = load(cron({ models: ["anthropic/m"] }));
	assert.equal(Object.hasOwn(today, "dataVersion"), false);
	assert.equal(JSON.stringify(today), '{"kind":"local","folder":"/proj","flow":"tidy","task":"t","models":["anthropic/m"],"trigger":{"id":"nightly","pattern":"0 3 * * *"}}');
	const table = { table: Object.freeze({ models: 2 }), supported: 2 };
	assert.equal(load(cron({ models: ["anthropic/m"] }), table).dataVersion, 2);
	assert.equal(Object.hasOwn(load(cron({}), table), "dataVersion"), false, "a schedule without the field needs nothing");
});
