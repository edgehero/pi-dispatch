import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Real-Valkey check of the defer record (issue #737) against the pinned BullMQ (5.80.4): a real Worker hands a real job
 * to `makeDeferTo` over a real client, and the record and BullMQ's delayed score are read back.
 *
 *   - the reason is written, then the job is moved, and the zset score's due (`dueOfScore`) is the record's `until`;
 *   - a write that fails still moves the job;
 *   - a move that rejects (a token that is not the lock's) is rethrown, and the compare-and-delete removes this
 *     writer's record and leaves another writer's;
 *   - a retry's record, written before the throw, agrees with the delay BullMQ then puts on the job by its own clock.
 *
 * Every instant is taken from the real clock just before the call that uses it: `moveToDelayed` clamps a past instant
 * to `Date.now()`, so a fixed clock would test the clamp rather than the score. The keys it touches are its own: a queue
 * of a unique name (obliterated), and the `defer:job:<id>` of job ids with a unique tail (deleted), since that keyspace
 * is not queue-scoped. It never flushes and never selects another database. Skips cleanly without VALKEY_TEST_URL,
 * and refuses to skip when CI requires the worker's integration tests.
 */

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("defer-write.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "VALKEY_TEST_URL not set; the defer record integration skipped locally";

let counter = 0;
const tail = () => `${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
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

async function load() {
	const { DelayedError, Queue, Worker } = await import("bullmq");
	const { makeRedisClient, parseConnection } = await import("../src/connection.mjs");
	const { DEFER_CAD_LUA, makeDeferTo } = await import("../src/defer-write.mjs");
	const { deferKey, deferTtlMs, dueOfScore } = await import("../src/defer-reasons.mjs");
	// The writer as the processor builds it, with BullMQ's own DelayedError class.
	return { Queue, Worker, makeRedisClient, parseConnection, DEFER_CAD_LUA, makeDeferTo: (opts) => makeDeferTo({ DelayedError, ...opts }), deferKey, deferTtlMs, dueOfScore };
}

/** One queue of a unique name, a client, and a teardown that removes exactly what the test made. */
async function world() {
	const k = await load();
	const name = `pi-jobs-defer-write-${tail()}`;
	const queue = new k.Queue(name, { connection: k.parseConnection(url) });
	const redis = k.makeRedisClient(url);
	const ids = [];
	const workers = [];
	return {
		...k,
		name,
		queue,
		redis,
		jobId: (what) => {
			const id = `defer-it-${what}-${tail()}`;
			ids.push(id);
			return id;
		},
		worker: (processor) => {
			const w = new k.Worker(name, processor, { connection: k.parseConnection(url) });
			workers.push(w);
			return w;
		},
		delayedScore: (id) => redis.zscore(queue.toKey("delayed"), id),
		teardown: async () => {
			for (const w of workers) await w.close().catch(() => {});
			await queue.obliterate({ force: true }).catch(() => {});
			await queue.close().catch(() => {});
			if (ids.length > 0) await redis.del(...ids.map((id) => k.deferKey(id))).catch(() => {});
			await redis.quit().catch(() => {});
		},
	};
}

test("the reason is written, then the job is moved: the record holds the fields and the delayed score's due is its until", { skip }, async () => {
	const w = await world();
	try {
		const id = w.jobId("write");
		const seen = {};
		const writer = w.makeDeferTo({ redis: w.redis, hostName: "it-host" });
		w.worker(async (job, token) => {
			seen.until = Date.now() + 5_000;
			try {
				await writer.deferTo(job, token, seen.until, "host-slot", { project: "shop" });
			} catch (error) {
				seen.error = error;
				throw error;
			}
		});
		const before = Date.now();
		await w.queue.add("t", { kind: "local", trigger: { matched: { index: 2 } } }, { jobId: id });
		await until(async () => seen.error && (await w.delayedScore(id)) !== null);
		assert.equal(seen.error.name, "DelayedError");
		const fields = await w.redis.hgetall(w.deferKey(id));
		assert.deepEqual({ ...fields, at: undefined, n: undefined }, { why: "host-slot", at: undefined, until: String(seen.until), project: "shop", host: "it-host", trigger: "2", n: undefined });
		assert.match(fields.n, /^[0-9a-f]{16}$/);
		const at = Number(fields.at);
		assert.ok(at >= before && at <= seen.until, "written at the gate's moment");
		assert.equal(w.dueOfScore(await w.delayedScore(id)), seen.until, "BullMQ's score decodes to the record's until");
		const pttl = await w.redis.pttl(w.deferKey(id));
		const ttl = w.deferTtlMs(seen.until, at);
		assert.ok(pttl <= ttl && pttl > ttl - 2_000, `the record expires with its job's due time plus the slack: ${pttl} of ${ttl}`);
	} finally {
		await w.teardown();
	}
});

test("a write that fails still moves the job, and leaves no record", { skip }, async () => {
	const w = await world();
	try {
		const id = w.jobId("failed");
		const seen = {};
		const logs = [];
		// A client wrapper whose transaction rejects at exec; everything else is the real client's.
		const failing = {
			multi: () => {
				const tx = { del: () => tx, hset: () => tx, pexpire: () => tx, exec: async () => Promise.reject(Object.assign(new Error("injected"), { code: "EINJECTED" })) };
				return tx;
			},
			eval: (...args) => w.redis.eval(...args),
		};
		const writer = w.makeDeferTo({ redis: failing, hostName: "it-host", log: (event, fields) => logs.push({ event, fields }) });
		w.worker(async (job, token) => {
			seen.until = Date.now() + 5_000;
			try {
				await writer.deferTo(job, token, seen.until, "endpoint", { endpoint: "lan-ollama" });
			} catch (error) {
				seen.error = error;
				throw error;
			}
		});
		await w.queue.add("t", { kind: "local" }, { jobId: id });
		await until(async () => seen.error && (await w.delayedScore(id)) !== null);
		assert.equal(seen.error.name, "DelayedError");
		assert.equal(w.dueOfScore(await w.delayedScore(id)), seen.until, "moved to the gate's instant");
		assert.equal(await w.redis.exists(w.deferKey(id)), 0);
		assert.deepEqual(logs, [{ event: "defer_reason_unwritten", fields: { why: "endpoint", reason: "EINJECTED" } }]);
	} finally {
		await w.teardown();
	}
});

test("a move with a token that is not the lock's rejects raw, and the compare-and-delete removes only this writer's record", { skip }, async () => {
	const w = await world();
	try {
		const mine = w.jobId("mine");
		const theirs = w.jobId("theirs");
		const OTHER = "ffffffffffffffff";
		const seen = new Map();
		const writer = w.makeDeferTo({ redis: w.redis, hostName: "it-host" });
		w.worker(async (job) => {
			// The job as the gate sees it, except that its move carries a token this worker does not hold. For `theirs`,
			// another writer's record replaces ours between our write and the move (a later deferral of the same id).
			const shown = Object.create(job);
			shown.moveToDelayed = async (ts) => {
				if (job.id === theirs) await w.redis.hset(w.deferKey(job.id), "why", "host-budget", "n", OTHER);
				return job.moveToDelayed(ts, "not-the-lock-token");
			};
			try {
				await writer.deferTo(shown, "not-the-lock-token", Date.now() + 5_000, "scope-repo");
			} catch (error) {
				seen.set(job.id, { error, record: await w.redis.hgetall(w.deferKey(job.id)) });
			}
			return 1;
		});
		await w.queue.add("t", { kind: "github" }, { jobId: mine });
		await w.queue.add("t", { kind: "github" }, { jobId: theirs });
		await until(() => seen.size === 2);
		for (const id of [mine, theirs]) {
			const { error } = seen.get(id);
			assert.notEqual(error.name, "DelayedError", `${id}: the move's own rejection, not a deferral`);
			assert.match(String(error.message), /lock/i, `${id}: BullMQ's lock refusal, unchanged: ${error.message}`);
			assert.equal(await w.delayedScore(id), null, `${id}: never delayed`);
		}
		assert.deepEqual(seen.get(mine).record, {}, "our record is gone");
		assert.deepEqual([seen.get(theirs).record.why, seen.get(theirs).record.n], ["host-budget", OTHER], "another writer's record is left alone");
		// The script on its own: a nonce that does not match deletes nothing.
		assert.equal(await w.redis.eval(w.DEFER_CAD_LUA, 1, w.deferKey(theirs), "0000000000000000"), 0);
		assert.equal(await w.redis.eval(w.DEFER_CAD_LUA, 1, w.deferKey(theirs), OTHER), 1);
		assert.equal(await w.redis.exists(w.deferKey(theirs)), 0);
	} finally {
		await w.teardown();
	}
});

test("a retry's record, written before the throw, agrees with the delay BullMQ then puts on the job by its own clock", { skip }, async () => {
	const w = await world();
	try {
		const id = w.jobId("retry");
		const seen = {};
		const writer = w.makeDeferTo({ redis: w.redis, hostName: "it-host" });
		w.worker(async (job) => {
			seen.attempts = (seen.attempts ?? 0) + 1;
			await writer.noteRetry(job, { project: "shop" });
			throw new Error("infrastructure");
		});
		// The queue's own retry policy (queue.mjs): two attempts, exponential from a minute.
		await w.queue.add("t", { kind: "local" }, { jobId: id, attempts: 2, backoff: { type: "exponential", delay: 60_000 } });
		await until(async () => (await w.delayedScore(id)) !== null);
		const fields = await w.redis.hgetall(w.deferKey(id));
		assert.deepEqual([fields.why, fields.attempt, fields.attempts, fields.project, fields.host], ["retry", "2", "2", "shop", "it-host"], "attempt 2 of 2");
		const due = w.dueOfScore(await w.delayedScore(id));
		const recorded = Number(fields.until);
		assert.ok(due >= recorded && due - recorded < 2_000, `BullMQ's due ${due} is the record's until ${recorded} within a round trip`);
		assert.equal(Number(fields.until) - Number(fields.at), 60_000, "the backoff BullMQ applies before attempt 2");
		assert.equal(seen.attempts, 1, "one attempt so far: the retry waits its minute");
	} finally {
		await w.teardown();
	}
});
