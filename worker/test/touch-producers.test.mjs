import assert from "node:assert/strict";
import { test } from "node:test";
import { removeQueuedJob } from "../src/cancel-state.mjs";
import { touchScopeOf } from "../src/touch-state.mjs";
import { hostQueueName } from "../src/queue.mjs";
const NOW = Date.UTC(2026, 9, 30);

test("shared cancellation counts only successful never-started removals beside the rate", async () => {
	const rows = [];
	let aborts = 0;
	const touchStore = { begin: async (event) => ({ ok: true, event }), write: async (event) => { rows.push(event); return { ok: true }; }, abort: async () => { aborts++; } };
	const redis = { hgetall: async () => ({}), del: async () => 1 };
	const job = { data: { kind: "local", folder: "/srv/api" }, attemptsMade: 0, getState: async () => "waiting", remove: async () => {} };
	const invoke = () => removeQueuedJob({ redis, job, jobId: "queued", touchStore, now: () => NOW });
	assert.equal((await invoke()).ok, true);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].type, "stop");
	assert.equal(rows[0].runId, "queued");
	job.attemptsMade = 1;
	assert.equal((await invoke()).ok, true);
	assert.equal(rows.length, 1, "an old attempted job is not 'stopped before it ran'");
	job.attemptsMade = 0;
	job.remove = async () => { throw new Error("locked"); };
	assert.equal((await invoke()).raced, true);
	assert.equal(rows.length, 1, "a raced removal writes no successful stop");
	assert.equal(aborts, 2);
});

test("a removal succeeds once while unavailable tracking is reported without retrying removal", async () => {
	let removes = 0;
	const touchStore = { begin: async (event) => ({ event, error: "touch-index-unavailable" }), write: async () => ({ error: "touch-index-unavailable" }), abort: async () => ({}) };
	const result = await removeQueuedJob({ redis: { hgetall: async () => ({}), del: async () => 1 }, job: { data: {}, attemptsMade: 0, getState: async () => "waiting", remove: async () => { removes++; } }, jobId: "queued", touchStore, now: () => NOW });
	assert.equal(result.ok, true);
	assert.equal(result.touchWarning, "touch-tracking-incomplete");
	assert.equal(removes, 1);
});

test("cancelled private classifier references and resolved jobs never count as stopped workloads", async () => {
	const rows = [];
	let removes = 0;
	let aborts = 0;
	const touchStore = { begin: async (event) => ({ ok: true, event }), write: async (event) => { rows.push(event); return { ok: true }; }, abort: async () => { aborts++; } };
	for (const data of [{ kind: "question-grouping", questionGrouping: { runId: "source" } }, { kind: "local", purpose: "zero-touch-grouping", questionGrouping: { runId: "source" } }]) {
		const result = await removeQueuedJob({ redis: { hgetall: async () => ({}), del: async () => 1 }, job: { data, attemptsMade: 0, getState: async () => "waiting", remove: async () => { removes++; } }, jobId: "analysis", touchStore, now: () => NOW });
		assert.equal(result.ok, true);
	}
	assert.equal(removes, 2, "each requested removal still happens once");
	assert.equal(rows.length, 0, "internal analysis cannot affect workload counters");
	assert.equal(aborts, 2);
});

test("a local pre-start stop only names a folder scope when its queue proves the owning host", async () => {
	const rows = [];
	const store = { begin: async (event) => ({ ok: true, event }), write: async (event) => { rows.push(event); return { ok: true }; }, abort: async () => ({ ok: true }) };
	const job = { data: { kind: "local", folder: "/srv/api", projectId: "api" }, attemptsMade: 0, getState: async () => "waiting", remove: async () => {} };
	const redis = { hgetall: async () => ({}), del: async () => 1 };
	await removeQueuedJob({ redis, queue: { name: hostQueueName("host-a") }, job, jobId: "known", touchStore: store, now: () => NOW });
	assert.equal(rows[0].scopeId, touchScopeOf(job.data, "host-a"));
	assert.equal(rows[0].project, "api");
	await removeQueuedJob({ redis, queue: { name: "pi-jobs" }, job, jobId: "shared", touchStore: store, now: () => NOW });
	assert.equal(rows[1].scopeId, undefined, "there is no host to substitute with an empty string");
	assert.equal(rows[1].project, "api", "an explicit reviewed project binding remains usable");
});
