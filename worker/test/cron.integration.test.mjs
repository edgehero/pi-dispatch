import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Tier-3, real-Valkey integration for the cron path (DES-CRON-VIA-BULLMQ-SCHEDULER). It runs the
 * actual BullMQ v5.80.4 Job Scheduler against a live Valkey, with runContainer/prepareWorkspace/
 * cleanup/comment stubbed -- no docker, no provider key, offline and free.
 *
 * This EXTENDS the REQ-UPSTREAM-CONTRACT-TESTS pattern (pin pi/BullMQ, then verify the upstream
 * contract in CI rather than trust it) to the three scheduler properties DES-CRON-VIA-BULLMQ-SCHEDULER
 * (design.md:207) commits to and calls out as "verified rather than assumed": no-backfill, no-overlap,
 * and the deterministic repeat:<id>:<millis> jobId. The tier-1 cron.test.mjs proves reconcile's LOGIC
 * against a fake queue; only a live Valkey can retire the two "unconfirmed until it runs against live
 * Valkey" caveats written into cron.mjs:
 *   1. the -10/-11 throw-vs-return path (cron.mjs:10-13), and
 *   2. the getJobSchedulers descriptor id-field that `d.key ?? d.id ?? d.name` (cron.mjs:54) depends on.
 * Both are pinned to concrete findings below.
 *
 * ISOLATION: real Valkey persists schedulers and the shared budget / stall keys across runs, so every
 * test uses a UNIQUE queue name (module-level counter + Date.now()/Math.random(), which are fine in a
 * test file) and a teardown that removes every resident scheduler, deletes the stall key and any budget
 * keys it created, obliterates the queue, and closes the worker/queue/redis handles -- no leaked handle,
 * no cross-test contamination.
 */

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("cron.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "VALKEY_TEST_URL not set; cron integration skipped locally";

// The PREFIX, not a key: since issue #267 each scheduler counts under `<prefix>:<schedulerId>`, so a
// teardown that deletes the bare prefix clears nothing. Deleting by pattern is right here and only here --
// this is a test teardown against a shared live Valkey, not a reader on the panel's per-tick path.
const STALL_PREFIX = "pi-dispatch:sched-stalls";
const delStallKeys = async (redis) => {
	const keys = await redis.keys(`${STALL_PREFIX}*`);
	if (keys.length > 0) await redis.del(...keys);
};
// A far-future pattern: its single upcoming slot stays DELAYED and is never promoted, so a scheduler
// installed with it holds one stable resident that a no-worker test can inspect without racing a tick.
const FAR_FUTURE = "0 0 1 1 *"; // 00:00 on Jan 1, yearly
const RETENTION = { removeOnComplete: { age: 3600 }, removeOnFail: { age: 3600 } };

// Unique per run so parallel/repeated Valkey tests cannot see each other's jobs or schedulers.
let queueCounter = 0;
function uniqueQueueName() {
	return `pi-jobs-test-${Date.now()}-${queueCounter++}-${Math.random().toString(36).slice(2, 8)}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded poll to a deadline -- never a fixed sleep. Resolves with the first truthy value fn() yields;
// rejects at the deadline so a wedged expectation fails loudly instead of hanging CI.
async function waitFor(fn, { timeoutMs = 6000, intervalMs = 50 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		await sleep(intervalMs);
	}
}

// Dynamic imports of bullmq/ioredis-backed modules, deferred to test-run time so a SKIPPED run imports
// nothing heavy and exits clean. Mirrors queue.test.mjs's freshGitHubQueue.
async function load() {
	const { Queue, Worker } = await import("bullmq");
	const { parseConnection, makeRedisClient } = await import("../src/connection.mjs");
	const { makeProcessor } = await import("../src/index.mjs");
	const { reconcile } = await import("../src/cron.mjs");
	const { makeStallGuard } = await import("../src/scheduler-stall-guard.mjs");
	const { dayKey } = await import("../src/budget.mjs");
	return { Queue, Worker, parseConnection, makeRedisClient, makeProcessor, reconcile, makeStallGuard, dayKey };
}

// afterEach-equivalent teardown, in the order the isolation contract requires: drain every resident
// scheduler, delete the shared stall key and any budget keys the test created, obliterate the queue,
// then close the worker, the queue, and the raw redis client so no handle is left open.
async function teardown({ queue, worker, redis, budgetKeys = [] }) {
	if (queue) {
		const resident = await queue.getJobSchedulers(0, -1, true).catch(() => []);
		for (const d of resident) {
			const id = typeof d === "string" ? d : (d.key ?? d.id ?? d.name);
			await queue.removeJobScheduler(id).catch(() => {});
		}
	}
	if (redis) {
		await delStallKeys(redis).catch(() => {});
		for (const key of budgetKeys) await redis.del(key).catch(() => {});
	}
	await queue?.obliterate({ force: true }).catch(() => {});
	await worker?.close().catch(() => {});
	await queue?.close().catch(() => {});
	await redis?.quit().catch(() => {});
}

// A normalized local-job template, the shape schedules.mjs emits and runJob consumes. `trigger` is the
// cron-only data field (INT-CONTAINER-JOB-INPUTS); pure passthrough here -- the verbatim data assertion
// below proves BullMQ carries it into the drained job untouched.
function localTemplate(task = "nightly") {
	return { kind: "local", folder: "/proj", flow: "tidy", task, provider: "anthropic", model: "m", maxTurns: 7, trigger: { id: "t", pattern: "0 3 * * *" } };
}

// The injected deps runJob needs for a LOCAL job: no token, no branch check, workspace/cleanup/comment
// stubbed. `runContainer` is supplied per test. `now` fixes the budget key deterministically.
function localDeps({ runContainer, now }) {
	return {
		mintToken: async () => null,
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspace: "/tmp/ws", jobDir: "/tmp/job" }),
		runContainer,
		cleanup: async () => {},
		comment: async () => {},
		log: () => {},
		now,
	};
}

// 1. END-TO-END DRAIN + BUDGET-BEFORE-CONTAINER. A real Worker (makeProcessor + new Worker) drains one
//    scheduled job; the stub runContainer reads the budget key at call time to prove the INCR already
//    happened before the container ran (CONST-BUDGET-BEFORE-TOKENS), and the deterministic jobId, name,
//    and data template are asserted against what BullMQ actually enqueued.
test("scheduled job drains through a real Worker; budget INCR precedes the container", { skip }, async () => {
	const { Queue, Worker, parseConnection, makeRedisClient, makeProcessor, dayKey } = await load();
	const name = uniqueQueueName();
	const conn = parseConnection(url);
	const redis = makeRedisClient(url);
	const queue = new Queue(name, { connection: conn });
	let worker;
	// runJob does NOT forward keyPrefix to reserveBudget (processor.mjs:80), so the prefix is the default
	// "budget"; a fixed far-future `now` makes the key deterministic and collision-free with any real day.
	const fixedNow = new Date(Date.UTC(2099, 0, 1, 12, 0, 0));
	const budgetKey = dayKey(fixedNow); // "budget:2099-01-01"
	try {
		await redis.del(budgetKey).catch(() => {});
		await queue.obliterate({ force: true }).catch(() => {});

		const template = localTemplate("nightly");
		let budgetAtContainer = null;
		const runContainer = async () => {
			// The reservation must be visible before the only money-spending step runs.
			budgetAtContainer = Number(await redis.get(budgetKey));
			return { code: 0, aborted: false };
		};
		const baseProcessor = makeProcessor({
			cancelJob: () => {},
			stopContainer: () => {},
			redis,
			getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 100, concurrency: 3 }),
			deps: localDeps({ runContainer, now: fixedNow }),
		});
		let drainedJob = null;
		// Arity 3 so BullMQ allocates the AbortController exactly as production does; captures the raw
		// BullMQ Job (with .id/.name/.data) as it enters processing.
		const processor = (job, token, signal) => {
			drainedJob = job;
			return baseProcessor(job, token, signal);
		};
		worker = new Worker(name, processor, { connection: { ...conn, maxRetriesPerRequest: null } });

		await queue.upsertJobScheduler("t", { every: 800 }, { name: "local", data: template, opts: RETENTION });

		// Wait until the container stub ran (=> reserveBudget already executed), then assert.
		await waitFor(() => budgetAtContainer !== null, { timeoutMs: 6000 });

		assert.ok(drainedJob, "a job drained");
		assert.equal(drainedJob.name, "local");
		assert.match(drainedJob.id, /^repeat:t:/, "deterministic repeat:<schedulerId>:<millis> jobId");
		assert.deepEqual(drainedJob.data, template, "job data is the upserted template verbatim");
		assert.ok(budgetAtContainer >= 1, `budget INCR must precede the container; saw ${budgetAtContainer}`);
	} finally {
		await teardown({ queue, worker, redis, budgetKeys: [budgetKey] });
	}
});

// 2. NO BACKFILL. A fresh scheduler yields exactly ONE upcoming slot, not N catch-up ticks -- the
//    property that turns "six hours down" into one paid run, not six (design.md:207).
test("a fresh scheduler installs exactly one upcoming slot (no backfill)", { skip }, async () => {
	const { Queue, parseConnection, makeRedisClient } = await load();
	const name = uniqueQueueName();
	const conn = parseConnection(url);
	const redis = makeRedisClient(url);
	const queue = new Queue(name, { connection: conn });
	try {
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.upsertJobScheduler("nb", { pattern: FAR_FUTURE }, { name: "local", data: localTemplate("t"), opts: RETENTION });

		const delayed = await queue.getDelayed();
		assert.equal(delayed.length, 1, "exactly one upcoming job, never N backfilled catch-ups");
		const scheduler = await queue.getJobScheduler("nb");
		assert.equal(typeof scheduler.next, "number", "scheduler resolves a single next slot");
		assert.ok(scheduler.next > Date.now(), "that slot is in the future");
	} finally {
		await teardown({ queue, redis });
	}
});

// 3. DESCRIPTOR ID-FIELD (LOAD-BEARING). cron.mjs prunes orphans via `d.key ?? d.id ?? d.name`; this
//    pins the CONCRETE field the live API populates, then drives a real prune to prove the fallback
//    resolves against reality.
test("getJobSchedulers descriptor carries the schedulerId on `.key`; reconcile prunes the orphan", { skip }, async () => {
	const { Queue, parseConnection, makeRedisClient, reconcile } = await load();
	const name = uniqueQueueName();
	const conn = parseConnection(url);
	const redis = makeRedisClient(url);
	const queue = new Queue(name, { connection: conn });
	try {
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.upsertJobScheduler("a", { pattern: FAR_FUTURE }, { name: "local", data: localTemplate("a"), opts: RETENTION });
		await queue.upsertJobScheduler("b", { pattern: FAR_FUTURE }, { name: "local", data: localTemplate("b"), opts: RETENTION });

		const descriptors = await queue.getJobSchedulers(0, -1, true);
		// Log one raw descriptor so the discovered shape is visible in CI output.
		console.log("bullmq 5.80.4 getJobSchedulers descriptor:", JSON.stringify(descriptors[0]));
		assert.equal(descriptors.length, 2);
		for (const d of descriptors) {
			assert.equal(typeof d.key, "string", ".key carries the schedulerId (transformSchedulerData)");
			assert.equal(d.id, undefined, ".id is absent on the new job-scheduler path (only legacy keyToData sets it)");
		}
		assert.deepEqual(descriptors.map((d) => d.key).sort(), ["a", "b"]);

		// Config names only "a": reconcile must prune orphan "b", which requires `d.key` to resolve.
		const schedule = { schedulerId: "a", name: "local", pattern: FAR_FUTURE, data: localTemplate("a"), opts: RETENTION };
		const res = await reconcile(queue, [schedule], { log: () => {} });
		assert.equal(res.removed, 1);
		const after = await queue.getJobSchedulers(0, -1, true);
		assert.deepEqual(after.map((d) => d.key), ["a"], "orphan b pruned, a kept -- d.key matched the live shape");
	} finally {
		await teardown({ queue, redis });
	}
});

// 4. STALL -> REMOVE. The money backstop BullMQ does not provide for scheduler jobs: past the
//    threshold, makeStallGuard tears the scheduler down through the REAL removeJobScheduler and logs
//    the alert (CONST-RETRY-INFRA-ONLY).
test("stall guard tears a scheduler down past the threshold (real removeJobScheduler + alert)", { skip }, async () => {
	const { Queue, parseConnection, makeRedisClient, makeStallGuard } = await load();
	const name = uniqueQueueName();
	const conn = parseConnection(url);
	const redis = makeRedisClient(url);
	const queue = new Queue(name, { connection: conn });
	try {
		await delStallKeys(redis).catch(() => {});
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.upsertJobScheduler("s", { pattern: FAR_FUTURE }, { name: "local", data: localTemplate("t"), opts: RETENTION });
		assert.deepEqual((await queue.getJobSchedulers(0, -1, true)).map((d) => d.key), ["s"]);

		const events = [];
		const threshold = 2;
		const onStalled = makeStallGuard({
			redis,
			threshold,
			removeJobScheduler: (id) => queue.removeJobScheduler(id),
			log: (event, fields) => events.push({ event, fields }),
		});
		// count reaches threshold+1 on the last call -> teardown fires exactly once.
		for (let i = 0; i < threshold + 1; i++) await onStalled("repeat:s:123");

		assert.deepEqual(await queue.getJobSchedulers(0, -1, true), [], "scheduler s removed from Valkey");
		const torn = events.filter((e) => e.event === "scheduler_torn_down");
		assert.equal(torn.length, 1, "scheduler_torn_down alert fired once");
		assert.equal(torn[0].fields.schedulerId, "s");
	} finally {
		await teardown({ queue, redis });
	}
});

// 5. NO OVERLAP / NO STACK. With a blocking runContainer on a short `every`, the scheduler yields at
//    most one active run and at most one pending next tick -- BullMQ creates the following tick only
//    when the current one starts processing, so ticks do not stack into a pile of concurrent runs.
test("a blocking scheduled run never overlaps or stacks", { skip }, async () => {
	const { Queue, Worker, parseConnection, makeRedisClient, makeProcessor } = await load();
	const name = uniqueQueueName();
	const conn = parseConnection(url);
	const redis = makeRedisClient(url);
	const queue = new Queue(name, { connection: conn });
	let worker;
	let releaseBlock;
	const blockGate = new Promise((resolve) => {
		releaseBlock = resolve;
	});
	// Cap the block so a bug cannot hang CI: even if the sampling path throws before releasing, the held
	// run resolves and the worker can close.
	const safety = setTimeout(() => releaseBlock?.(), 4000);
	const fixedNow = new Date(Date.UTC(2099, 0, 2, 12, 0, 0));
	const budgetKey = `budget:2099-01-02`;
	try {
		await redis.del(budgetKey).catch(() => {});
		await queue.obliterate({ force: true }).catch(() => {});

		const runContainer = async () => {
			await blockGate; // hold the single active slot open across many `every:300` ticks
			return { code: 0, aborted: false };
		};
		const processor = makeProcessor({
			cancelJob: () => {},
			stopContainer: () => {},
			redis,
			getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 1000, concurrency: 3 }),
			deps: localDeps({ runContainer, now: fixedNow }),
		});
		worker = new Worker(name, processor, { connection: { ...conn, maxRetriesPerRequest: null }, concurrency: 1 });

		await queue.upsertJobScheduler("ov", { every: 300 }, { name: "local", data: localTemplate("t"), opts: RETENTION });

		await waitFor(async () => (await queue.getActiveCount()) >= 1, { timeoutMs: 4000 });

		// Sample across a window in which ~5 `every:300` ticks would elapse. A backfill/overlap bug shows
		// >1 active or a growing pile of ready jobs; the scheduler must yield neither.
		const deadline = Date.now() + 1500;
		let maxActive = 0;
		while (Date.now() < deadline) {
			const active = await queue.getActiveCount();
			maxActive = Math.max(maxActive, active);
			assert.ok(active <= 1, `at most one active scheduled run; saw ${active}`);
			const pending = (await queue.getWaitingCount()) + (await queue.getDelayedCount());
			assert.ok(pending <= 1, `the next tick does not stack; pending=${pending}`);
			await sleep(100);
		}
		assert.equal(maxActive, 1, "exactly one run was ever active during the block");
	} finally {
		clearTimeout(safety);
		releaseBlock?.();
		await teardown({ queue, worker, redis, budgetKeys: [budgetKey] });
	}
});

// 6. -10 / -11 SENTINEL. Assert the happy path (a clean, idempotent install) against the LIVE upsert,
//    and document the sentinel behavior rather than assert a non-reproducible throw-vs-return gate.
//
// FINDING (bullmq 5.80.4): SchedulerJobIdCollision(-10) / SchedulerJobSlotsBusy(-11) is NOT returned as
// a negative number. scripts.addJobScheduler (node_modules/bullmq/.../scripts.js:321-322) does
// `if (typeof result === 'number' && result < 0) throw this.finishedErrors(...)`, so the SDK THROWS.
// cron.mjs therefore trips its try/catch (thrown) path; its `typeof res === "number" && res < 0` branch
// (cron.mjs:42) is defensive insurance against a future upstream that RETURNS the sentinel instead of
// throwing. Forcing the sentinel deterministically requires a job pinned at the exact nextMillis in a
// non-updatable (active/completed/failed) state (addJobScheduler-11.lua:150-191) -- timing-dependent and
// inherently flaky -- so this asserts the reproducible happy path instead.
test("reconcile installs cleanly and idempotently against live upsert (sentinel behavior documented)", { skip }, async () => {
	const { Queue, parseConnection, makeRedisClient, reconcile } = await load();
	const name = uniqueQueueName();
	const conn = parseConnection(url);
	const redis = makeRedisClient(url);
	const queue = new Queue(name, { connection: conn });
	try {
		await queue.obliterate({ force: true }).catch(() => {});
		const schedule = { schedulerId: "sentinel", name: "local", pattern: FAR_FUTURE, data: localTemplate("t"), opts: RETENTION };

		const first = await reconcile(queue, [schedule], { log: () => {} });
		assert.deepEqual(first, { installed: 1, removed: 0 }, "clean install");
		const second = await reconcile(queue, [schedule], { log: () => {} });
		assert.deepEqual(second, { installed: 1, removed: 0 }, "idempotent re-run installs the same set, removes nothing");
		assert.deepEqual((await queue.getJobSchedulers(0, -1, true)).map((d) => d.key), ["sentinel"]);
	} finally {
		await teardown({ queue, redis });
	}
});
