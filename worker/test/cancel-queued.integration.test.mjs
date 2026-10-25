import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Real-Valkey check of `removeQueuedJob` (issue #737, cancel-state.mjs), the one sequence `pi-dispatch cancel` and the
 * console's cancel-queued share, on the pinned BullMQ (5.80.4):
 *
 *   - a job in each state a job waits to start in (delayed, waiting, prioritized, and the paused list, which BullMQ
 *     reads as `waiting`) is removed, and its defer record with it;
 *   - a held job leaves no `wait:held` member, no `wait:job` hash and no supersede lease behind;
 *   - a job scheduler's next run is refused by BullMQ's remove, so it is answered as raced and stays, its record too;
 *   - the CLI's own output is the same bytes, and it now leaves no defer record behind either.
 *
 * Every queue name and job id has a unique tail, because `defer:job:*`, `wait:held` and `wait:job:*` are not
 * queue-scoped: each test deletes exactly the keys it wrote and never flushes. Skips cleanly without VALKEY_TEST_URL,
 * and refuses to skip when CI requires the worker's integration tests.
 */

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("cancel-queued.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "VALKEY_TEST_URL not set; cancel-queued integration skipped locally";

let counter = 0;
const tail = () => `${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;

async function load() {
	const { Queue } = await import("bullmq");
	const { parseConnection, makeRedisClient } = await import("../src/connection.mjs");
	const { removeQueuedJob } = await import("../src/cancel-state.mjs");
	const { deferHsetArgs, deferKey } = await import("../src/defer-reasons.mjs");
	const { HELD_SET, jobKey, leaseKey } = await import("../src/wait-state.mjs");
	return { Queue, parseConnection, makeRedisClient, removeQueuedJob, deferHsetArgs, deferKey, HELD_SET, jobKey, leaseKey };
}

/** A world of its own: one client, the queues it opened, and every deployment-wide key it wrote, removed at the end. */
async function world(t) {
	const deps = await load();
	const redis = deps.makeRedisClient(url, {});
	const queues = [];
	const keys = new Set();
	const held = new Set();
	t.after(async () => {
		for (const q of queues) {
			for (const d of (await q.getJobSchedulers(0, -1, true).catch(() => [])) ?? []) await q.removeJobScheduler(typeof d === "string" ? d : (d.key ?? d.id ?? d.name)).catch(() => {});
			await q.obliterate({ force: true }).catch(() => {});
			await q.close().catch(() => {});
		}
		for (const key of keys) await redis.del(key).catch(() => {});
		for (const member of held) await redis.srem(deps.HELD_SET, member).catch(() => {});
		redis.disconnect();
	});
	const queue = (opts = {}) => {
		const q = new deps.Queue(`pi-jobs-cancel-queued-${tail()}`, { connection: deps.parseConnection(url), ...opts });
		queues.push(q);
		return q;
	};
	// The worker's own record shape, through the leaf's writer rules; a TTL so a record a failed cleanup leaves expires.
	const writeReason = async (jobId) => {
		const key = deps.deferKey(jobId);
		keys.add(key);
		const at = Date.now();
		await redis.hset(key, ...deps.deferHsetArgs({ why: "host-slot", at, until: at + 600_000, host: "mini1", n: "0123456789abcdef" }));
		await redis.pexpire(key, 600_000);
		assert.equal(await redis.exists(key), 1, "the record was written (this test is vacuous otherwise)");
		return key;
	};
	return { ...deps, redis, queue, keys, held, writeReason };
}

test("removeQueuedJob removes a delayed, a waiting, a prioritized and a paused-queue job, each with its defer record", { skip }, async (t) => {
	const w = await world(t);
	const open = w.queue();
	const paused = w.queue();
	await paused.pause();
	const id = tail();
	const jobs = [
		[open, await open.add("t", { n: 1 }, { jobId: `cq-${id}-delayed`, delay: 600_000 }), "delayed"],
		[open, await open.add("t", { n: 2 }, { jobId: `cq-${id}-waiting` }), "waiting"],
		[open, await open.add("t", { n: 3 }, { jobId: `cq-${id}-prioritized`, priority: 5 }), "prioritized"],
		// A paused queue's list, which BullMQ 5.80.4 reads as `waiting`.
		[paused, await paused.add("t", { n: 4 }, { jobId: `cq-${id}-paused` }), "waiting"],
	];
	assert.deepEqual(await w.redis.lrange(paused.toKey("paused"), 0, -1), [`cq-${id}-paused`], "the job is in the paused list");
	for (const [q, added, state] of jobs) {
		const record = await w.writeReason(added.id);
		const job = await q.getJob(added.id);
		assert.equal(await job.getState(), state, added.id);
		const res = await w.removeQueuedJob({ redis: w.redis, queue: q, job, jobId: added.id });
		assert.deepEqual(res, { ok: true, held: false, jobId: added.id, state, attemptsMade: 0 }, added.id);
		assert.equal(await q.getJob(added.id), undefined, `${added.id} is gone`);
		assert.equal(await w.redis.exists(record), 0, `${added.id}'s defer record is gone`);
	}
	assert.deepEqual(await w.redis.lrange(paused.toKey("paused"), 0, -1), []);
});

test("a held job leaves no wait:held member, no wait:job hash and no supersede lease, nor its defer record", { skip }, async (t) => {
	const w = await world(t);
	const q = w.queue();
	const jobId = `cq-${tail()}-held`;
	const dedupId = `cq-dedup-${tail()}`;
	await q.add("t", { n: 1 }, { jobId, delay: 600_000 });
	w.keys.add(w.jobKey(jobId));
	w.keys.add(w.leaseKey(dedupId));
	w.held.add(jobId);
	await w.redis.hset(w.jobKey(jobId), "since", String(Date.now()), "dedupId", dedupId, "checks", "1");
	await w.redis.sadd(w.HELD_SET, jobId);
	await w.redis.set(w.leaseKey(dedupId), jobId, "PX", 600_000);
	const record = await w.writeReason(jobId);
	const res = await w.removeQueuedJob({ redis: w.redis, queue: q, job: await q.getJob(jobId), jobId });
	assert.deepEqual(res, { ok: true, held: true, jobId, attemptsMade: 0 });
	assert.equal(await q.getJob(jobId), undefined);
	assert.equal(await w.redis.sismember(w.HELD_SET, jobId), 0, "no wait:held member");
	assert.equal(await w.redis.exists(w.jobKey(jobId)), 0, "no wait:job hash");
	assert.equal(await w.redis.exists(w.leaseKey(dedupId)), 0, "no lease");
	assert.equal(await w.redis.exists(record), 0, "no defer record");
});

test("a job scheduler's next run is refused by BullMQ's remove: raced, with its state read again, and it stays with its record", { skip }, async (t) => {
	const w = await world(t);
	const q = w.queue();
	const tag = tail();
	// Delayed: a scheduler whose first run is in the future. `every` alone runs its first job at once, which reads
	// `waiting`, and is refused the same way.
	for (const [schedulerId, repeat, state] of [
		[`cq-next-${tag}`, { every: 600_000, startDate: Date.now() + 600_000 }, "delayed"],
		[`cq-now-${tag}`, { every: 600_000 }, "waiting"],
	]) {
		const next = await q.upsertJobScheduler(schedulerId, repeat, { name: "t", data: {} });
		assert.match(next.id, new RegExp(`^repeat:${schedulerId}:\\d+$`));
		const record = await w.writeReason(next.id);
		const job = await q.getJob(next.id);
		assert.equal(await job.getState(), state);
		const res = await w.removeQueuedJob({ redis: w.redis, queue: q, job, jobId: next.id });
		assert.equal(res.raced, true, schedulerId);
		assert.equal(res.state, state);
		assert.match(res.error?.message ?? "", /belongs to a job scheduler and cannot be removed directly/);
		assert.equal(await q.getJobState(next.id), state, "the job stays");
		assert.equal(await w.redis.exists(record), 1, "and keeps its reason");
	}
});

test("pi-dispatch cancel says the same bytes, and leaves no defer record behind", { skip }, async (t) => {
	const w = await world(t);
	const { runCancel } = await import("../src/cancel-cli.mjs");
	const q = w.queue();
	const id = tail();
	const out = [];
	const seams = { write: (c) => out.push(c), errWrite: (c) => out.push(c), refusalFn: async () => null, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], fleetQueueNamesFn: () => [], unionQueueNamesFn: () => [q.name] };

	const plain = await q.add("t", { n: 1 }, { jobId: `cq-${id}-cli`, delay: 600_000 });
	const plainRecord = await w.writeReason(plain.id);
	assert.equal(await runCancel(plain.id, url, seams), 0, out.join(""));
	assert.equal(out.join(""), `removed ${plain.id} (delayed): it never ran; no record written\n`);
	assert.equal(await q.getJob(plain.id), undefined);
	assert.equal(await w.redis.exists(plainRecord), 0);

	const jobId = `cq-${id}-cli-held`;
	await q.add("t", { n: 2 }, { jobId, delay: 600_000 });
	w.keys.add(w.jobKey(jobId));
	w.held.add(jobId);
	await w.redis.hset(w.jobKey(jobId), "since", String(Date.now()));
	await w.redis.sadd(w.HELD_SET, jobId);
	const heldRecord = await w.writeReason(jobId);
	out.length = 0;
	assert.equal(await runCancel(jobId, url, seams), 0, out.join(""));
	assert.equal(out.join(""), `cancelled ${jobId}: it was held on its wait condition, and it never ran; no record written\n`);
	assert.equal(await w.redis.exists(heldRecord), 0);
	assert.equal(await w.redis.sismember(w.HELD_SET, jobId), 0);
});
