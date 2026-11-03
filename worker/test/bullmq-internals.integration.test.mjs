import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Real-Valkey check of the BullMQ leaf (issue #761) against the pinned BullMQ: every key, field, flag, score and id the
 * module names is read back off what the library itself wrote, so a bump that moves one fails here even where the text
 * pins of bullmq-internals.test.mjs still hold.
 *
 *   1. a queue writes its meta key, and its version field names the verified release;
 *   2. the module's key for every type is the queue's own, and each key is the Valkey type BullMQ makes;
 *   3. a host queue is found by both keyspace scans, and its meta key names it;
 *   4. a delayed job's score decodes to its due instant;
 *   5. a plain job waits in `wait`, a prioritized one in `prioritized`;
 *   6. pause writes the meta flag the module reads by presence and moves the wait list to `paused`; resume deletes it;
 *   7. a job's hash carries the fields the module names, and a failed attempt counts in `atm`;
 *   8. a scheduler's run id is the module's grammar, carries its `rjk`, is the scheduler's next run, and a far run's
 *      delayed score decodes to its slot;
 *   9. `queue.add` refuses exactly the custom ids `customJobIdAllowed` refuses.
 *
 * Every instant is taken from the real clock just before the call that uses it, so it holds under the suite's shifted
 * clock too (BullMQ stamps and computes in the caller's process). Each test makes queues of its own unique names and a
 * teardown removes their schedulers, obliterates them and closes every handle; it never flushes and never selects
 * another database. Skips cleanly without VALKEY_TEST_URL, and refuses to skip when CI requires the worker's
 * integration tests.
 */

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("bullmq-internals.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "VALKEY_TEST_URL not set; the BullMQ internals integration skipped locally";

let counter = 0;
const rand = () => Math.random().toString(36).slice(2, 8);
const tail = () => `${Date.now()}-${counter++}-${rand()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded poll to a deadline, never a fixed sleep: a wedged expectation fails loudly instead of hanging CI.
async function until(fn, { timeoutMs = 8000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await fn()) return;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
		await sleep(intervalMs);
	}
}

/** The libraries and the module, loaded only when the tests run (bullmq is not installed below the node floor). */
async function load() {
	const { Worker } = await import("bullmq");
	const { makeRedisClient, parseConnection } = await import("../src/connection.mjs");
	const { discoverHostQueuesReporting, hostQueueName, makeQueue } = await import("../src/queue.mjs");
	const { canaryQueueNames } = await import("../src/canary-lock.mjs");
	const internals = await import("../src/bullmq-internals.mjs");
	return { Worker, makeRedisClient, parseConnection, discoverHostQueuesReporting, hostQueueName, makeQueue, canaryQueueNames, ...internals };
}

/** A client and queues of unique names, with a teardown that removes exactly what the test made. */
async function world() {
	const k = await load();
	const redis = k.makeRedisClient(url);
	const queues = [];
	const workers = [];
	const schedulers = [];
	return {
		k,
		redis,
		queue: (name = `pi-jobs-bi-${tail()}`) => {
			const q = k.makeQueue(k.parseConnection(url), { name });
			queues.push(q);
			return q;
		},
		worker: (name, processor) => {
			const w = new k.Worker(name, processor, { connection: k.parseConnection(url) });
			workers.push(w);
			return w;
		},
		scheduler: (q, id) => {
			schedulers.push([q, id]);
			return id;
		},
		/** A queue's meta key exists: the constructor writes it once its connection is ready. */
		metaWritten: (q) => until(async () => (await redis.exists(k.queueKey(q.name, k.QUEUE_KEY.meta))) === 1),
		teardown: async () => {
			for (const w of workers) await w.close().catch(() => {});
			for (const [q, id] of schedulers) await q.removeJobScheduler(id).catch(() => {});
			for (const q of queues) {
				await q.obliterate({ force: true }).catch(() => {});
				await q.close().catch(() => {});
			}
			await redis.quit().catch(() => {});
		},
	};
}

test("1, 2: a queue writes its meta key with the verified version, and every key the module names is the queue's own", { skip }, async () => {
	const w = await world();
	const { k, redis } = w;
	try {
		const q = w.queue();
		await w.metaWritten(q);
		const meta = k.queueKey(q.name, k.QUEUE_KEY.meta);
		assert.equal(k.metaVersionOf(await redis.hget(meta, k.META_FIELD.version)), k.BULLMQ_VERIFIED_VERSION, "the library that ran is the verified one");
		assert.equal(await redis.type(meta), "hash");
		for (const type of Object.values(k.QUEUE_KEY)) {
			assert.equal(k.queueKeyOf(q, type), k.queueKey(q.name, type), type);
			assert.equal(k.queueKeyOf({ name: q.name }, type), q.toKey(type), `${type}: the module's own spelling, for a reader without a queue`);
		}
		const id = `bi-${rand()}`;
		assert.equal(k.jobKeyOf(q, id), k.queueKey(q.name, id));
		assert.equal(k.jobKeyOf({ name: q.name }, id), q.toKey(id));
	} finally {
		await w.teardown();
	}
});

test("3: a host queue is found by both keyspace scans, and its meta key names it", { skip }, async () => {
	const w = await world();
	const { k, redis } = w;
	try {
		const host = `bi-${rand()}`;
		const q = w.queue(k.hostQueueName(host));
		await w.metaWritten(q);
		const meta = k.queueKey(q.name, k.QUEUE_KEY.meta);
		assert.equal(k.queueNameOfMetaKey(meta), q.name);
		assert.ok((await redis.keys(k.metaKeyPattern(q.name))).includes(meta), "the SCAN pattern matches the key BullMQ wrote");
		const found = await k.discoverHostQueuesReporting(redis, { timeoutMs: 5_000 });
		assert.equal(found.incomplete, null);
		assert.ok(found.names.includes(q.name), `the kill switch's scan finds ${q.name}`);
		assert.ok((await k.canaryQueueNames(redis)).includes(q.name), `the canary's scan finds ${q.name}`);
	} finally {
		await w.teardown();
	}
});

test("4, 5: a delayed job's score decodes to its due instant; a plain job waits in wait and a prioritized one in prioritized", { skip }, async () => {
	const w = await world();
	const { k, redis } = w;
	try {
		const q = w.queue();
		const delay = 3_600_000;
		const before = Date.now();
		const delayed = await q.add("local", {}, { jobId: `bi-delayed-${rand()}`, delay });
		const after = Date.now();
		const due = k.dueOfScore(await redis.zscore(k.queueKeyOf(q, k.QUEUE_KEY.delayed), delayed.id));
		assert.ok(due !== null && due >= before + delay && due <= after + delay, `due ${due} within [${before + delay}, ${after + delay}]`);
		const plain = await q.add("local", {}, { jobId: `bi-plain-${rand()}` });
		const prioritized = await q.add("local", {}, { jobId: `bi-prio-${rand()}`, priority: 1 });
		assert.ok((await redis.lrange(k.queueKeyOf(q, k.QUEUE_KEY.wait), 0, -1)).includes(plain.id));
		assert.notEqual(await redis.zscore(k.queueKeyOf(q, k.QUEUE_KEY.prioritized), prioritized.id), null);
		for (const [type, kind] of [[k.QUEUE_KEY.delayed, "zset"], [k.QUEUE_KEY.prioritized, "zset"], [k.QUEUE_KEY.wait, "list"]]) assert.equal(await redis.type(k.queueKeyOf(q, type)), kind, type);
		assert.equal(await redis.type(k.jobKeyOf(q, plain.id)), "hash", "a job's own hash");
	} finally {
		await w.teardown();
	}
});

test("6: pause writes the meta flag read by presence and moves the wait list to paused; resume deletes the flag", { skip }, async () => {
	const w = await world();
	const { k, redis } = w;
	try {
		const q = w.queue();
		const job = await q.add("local", {}, { jobId: `bi-paused-${rand()}` });
		const meta = k.queueKeyOf(q, k.QUEUE_KEY.meta);
		await q.pause();
		assert.equal(await redis.hexists(meta, k.META_FIELD.paused), 1);
		assert.equal(k.isPausedFlag("hexists", await redis.hexists(meta, k.META_FIELD.paused)), true);
		assert.equal(k.isPausedFlag("hget", await redis.hget(meta, k.META_FIELD.paused)), true);
		assert.ok((await redis.lrange(k.queueKeyOf(q, k.QUEUE_KEY.paused), 0, -1)).includes(job.id), "the waiting job is in the paused list");
		assert.equal(await redis.type(k.queueKeyOf(q, k.QUEUE_KEY.paused)), "list");
		assert.equal(await q.isPaused(), true, "BullMQ's own reading agrees");
		await q.resume();
		assert.equal(await redis.hexists(meta, k.META_FIELD.paused), 0);
		assert.equal(k.isPausedFlag("hget", await redis.hget(meta, k.META_FIELD.paused)), false);
		assert.equal(await q.isPaused(), false);
	} finally {
		await w.teardown();
	}
});

test("7: a job's hash carries the named fields, and a failed attempt counts in atm", { skip }, async () => {
	const w = await world();
	const { k, redis } = w;
	try {
		const q = w.queue();
		const dedup = `bi-dedup-${rand()}`;
		const before = Date.now();
		// A fixed backoff long past the test parks the job in delayed after its first failure, with one attempt made.
		const job = await q.add("local", {}, { jobId: `bi-fields-${rand()}`, deduplication: { id: dedup }, attempts: 2, backoff: { type: "fixed", delay: 3_600_000 } });
		const after = Date.now();
		const key = k.jobKeyOf(q, job.id);
		const [name, deid, timestamp] = await redis.hmget(key, k.JOB_FIELD.name, k.JOB_FIELD.dedupId, k.JOB_FIELD.timestamp);
		assert.equal(name, "local");
		assert.equal(deid, dedup);
		assert.ok(Number(timestamp) >= before && Number(timestamp) <= after, `timestamp ${timestamp} within [${before}, ${after}]`);
		w.worker(q.name, async () => {
			throw new Error("a first attempt that fails");
		});
		await until(async () => (await redis.hget(key, k.JOB_FIELD.attempts)) === "1");
		await until(async () => (await redis.zscore(k.queueKeyOf(q, k.QUEUE_KEY.delayed), job.id)) !== null);
		const fresh = await q.getJob(job.id);
		assert.equal(fresh.attemptsMade, 1, "BullMQ's own reading of the same field");
		assert.equal(fresh.deduplicationId, dedup);
	} finally {
		await w.teardown();
	}
});

test("8: a scheduler's run id is the module's grammar, names its scheduler and is its next run; a far run's score is its slot", { skip }, async () => {
	const w = await world();
	const { k, redis } = w;
	try {
		const q = w.queue();
		const every = w.scheduler(q, `bi-every-${rand()}`);
		const first = await q.upsertJobScheduler(every, { every: 3_600_000 }, { name: "local", data: {} });
		const run = k.cronRunOf(first.id);
		assert.deepEqual(run && { kind: run.kind, id: run.id }, { kind: k.SCHEDULER_JOB_PREFIX, id: every }, `${first.id} parses`);
		assert.equal(k.schedulerJobId(every, run.ms), first.id);
		assert.equal(k.isSchedulerJobId(first.id), true);
		assert.equal(await redis.hget(k.jobKeyOf(q, first.id), k.JOB_FIELD.schedulerKey), every);
		const nextRaw = await redis.zscore(k.queueKeyOf(q, k.QUEUE_KEY.repeat), every);
		assert.equal(k.isSchedulerNext(first.id, every, nextRaw), true, "BullMQ's next run, by BullMQ's own rule");
		assert.equal(await redis.type(k.queueKeyOf(q, k.QUEUE_KEY.repeat)), "zset");

		// A slot far enough ahead that it stays delayed: its delayed score's due is the slot its id names.
		const far = w.scheduler(q, `bi-far-${rand()}`);
		const farRun = await q.upsertJobScheduler(far, { pattern: "0 0 1 1 *" }, { name: "local", data: {} });
		const parsed = k.cronRunOf(farRun.id);
		assert.equal(parsed?.id, far);
		assert.equal(k.scheduledForMillis(farRun.id), parsed.ms);
		assert.ok(parsed.ms > Date.now(), "a run ahead of now");
		assert.equal(k.dueOfScore(await redis.zscore(k.queueKeyOf(q, k.QUEUE_KEY.delayed), farRun.id)), parsed.ms);
		assert.equal(k.isSchedulerNext(farRun.id, far, await redis.zscore(k.queueKeyOf(q, k.QUEUE_KEY.repeat), far)), true);
	} finally {
		await w.teardown();
	}
});

test("9: queue.add refuses exactly the custom ids customJobIdAllowed refuses", { skip }, async () => {
	const w = await world();
	const { k } = w;
	try {
		const q = w.queue();
		const x = rand();
		for (const [jobId, allowed] of [[`a${x}:b`, false], [`a${x}:b:c:d`, false], ["123", false], [`manual:${x}:60000`, true], [`a${x}:b:c`, true], [`gh-${x}.r1`, true]]) {
			assert.equal(k.customJobIdAllowed(jobId), allowed, `${jobId}: the module`);
			if (allowed) assert.equal((await q.add("local", {}, { jobId })).id, jobId, `${jobId}: stored under that id`);
			else await assert.rejects(q.add("local", {}, { jobId }), /Custom Id cannot/, `${jobId}: refused`);
		}
	} finally {
		await w.teardown();
	}
});
