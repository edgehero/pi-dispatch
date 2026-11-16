import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { localEventJobId } from "../src/local-event.mjs";
import { LOCAL_EVENT_INDEX_KEY, makeLocalEventStore } from "../src/local-event-store.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("local-event-queue REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}

test("real BullMQ consumes one generation and one active successor despite concurrent publishers", { skip: url ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async (t) => {
	const { Queue, Worker } = await import("bullmq");
	const { makeRedisClient, parseConnection } = await import("../src/connection.mjs");
	const tag = randomUUID().replaceAll("-", "");
	const queue = new Queue(`local-event-test-${tag}`, { connection: parseConnection(url) });
	const redis = makeRedisClient(url, {});
	const keys = new Set();
	const stateKeys = new Set();
	const tracked = {
		eval: (...args) => {
			stateKeys.add(args[2]); keys.add(args[2]);
			if (args[4]) keys.add(args[4]);
			return redis.eval(...args);
		},
		get: (...args) => redis.get(...args),
		zscan: (...args) => redis.zscan(...args),
	};
	let instant = 1_000_000;
	const now = () => instant;
	const store = makeLocalEventStore({ redis: tracked, now });
	const secondPublisher = makeLocalEventStore({ redis: tracked, now });
	const owner = `test-owner-${tag}`;
	const [trigger] = parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [{
		on: { type: "issue", action: ["closed"], forge: "github", id: `test-${tag}`, debounceSeconds: 0 },
		run: { kind: "local", folder: "/srv/maintenance", command: "maintain-prs", worker: owner },
	}] }), "triggers.json");
	const identity = { id: trigger.on.id, forge: trigger.on.forge };
	const firstStarted = Promise.withResolvers();
	const firstReleased = Promise.withResolvers();
	const firstCompleted = Promise.withResolvers();
	const secondStarted = Promise.withResolvers();
	const secondReleased = Promise.withResolvers();
	const secondCompleted = Promise.withResolvers();
	const fatal = Promise.withResolvers();
	// An emitter may report a failure while teardown is closing its connections; every waiter below still sees it.
	void fatal.promise.catch(() => {});
	const waitFor = (promise) => Promise.race([promise, fatal.promise]);
	const started = [];
	let active = 0;
	let maxActive = 0;
	let worker;
	t.after(async () => {
		firstReleased.resolve(); secondReleased.resolve();
		try {
			await worker?.close();
			await queue.obliterate({ force: true });
		} finally {
			try {
				if (stateKeys.size) await redis.zrem(LOCAL_EVENT_INDEX_KEY, ...stateKeys);
				if (keys.size) await redis.del(...keys);
			} finally { await queue.close(); redis.disconnect(); }
		}
	});
	queue.on("error", (error) => fatal.reject(error));
	redis.on("error", (error) => fatal.reject(error));
	await store.signal({ trigger, deliveryId: "initial" });
	const initial = (await store.read(identity)).current;
	const firstId = localEventJobId(initial.generation);
	worker = new Worker(queue.name, async (job, token) => {
		const claimed = await store.claim(job.data.localEvent, token);
		assert.equal(claimed.ok, true);
		started.push(job.id); active++; maxActive = Math.max(maxActive, active);
		try {
			assert.equal(job.name, "local");
			assert.equal(job.data.command, "maintain-prs");
			assert.equal(job.data.worker, owner);
			if (job.id === firstId) { firstStarted.resolve(job); await firstReleased.promise; }
			else { secondStarted.resolve(job); await secondReleased.promise; }
			assert.equal((await store.finish(job.data.localEvent, { owner: token })).ok, true);
			return { outcome: "completed" };
		} finally { active--; }
	}, { connection: parseConnection(url), concurrency: 2 });
	worker.on("error", (error) => fatal.reject(error));
	worker.on("failed", (_job, error) => fatal.reject(error));
	worker.on("completed", (job) => (job.id === firstId ? firstCompleted : secondCompleted).resolve(job));
	await waitFor(Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]));
	const reconcile = (publisher) => publisher.reconcile({ worker: owner, queueFor: async (destination) => { assert.equal(destination, owner); return queue; } });
	await waitFor(Promise.all([reconcile(store), reconcile(secondPublisher)]));
	assert.equal((await waitFor(firstStarted.promise)).id, firstId);
	assert.equal((await store.read(identity)).current.phase, "active");

	instant += 1_000;
	await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? store : secondPublisher).signal({ trigger, deliveryId: `during-active-${i}` })));
	const during = await store.read(identity);
	assert.equal(during.current.generation, initial.generation);
	assert.equal(during.current.count, 1);
	assert.equal(during.next.count, 20);
	const secondId = localEventJobId(during.next.generation);
	await waitFor(Promise.all([reconcile(store), reconcile(secondPublisher)]));
	assert.deepEqual(started, [firstId]);
	assert.equal(await queue.getJob(secondId), undefined, "the successor remains durable intent until the active generation finishes");
	assert.deepEqual(await queue.getJobCounts("active", "waiting", "delayed"), { active: 1, waiting: 0, delayed: 0, paused: 0 });

	firstReleased.resolve();
	await waitFor(firstCompleted.promise);
	const promoted = await store.read(identity);
	assert.equal(promoted.current.generation, during.next.generation);
	assert.equal(promoted.next, undefined);
	assert.equal((await store.signal({ trigger, deliveryId: "initial" })).duplicate, true);
	assert.deepEqual(await store.read(identity), promoted, "a receipt from the completed generation cannot dirty its successor");
	await waitFor(Promise.all([reconcile(store), reconcile(secondPublisher)]));
	assert.equal((await waitFor(secondStarted.promise)).id, secondId);
	assert.deepEqual(started, [firstId, secondId]);
	assert.equal(maxActive, 1, "worker concurrency 2 never receives two executable generations of this trigger");
	secondReleased.resolve();
	await waitFor(secondCompleted.promise);
	assert.equal(await store.read(identity), null);
	assert.equal((await queue.getJob(firstId)).returnvalue.outcome, "completed");
	assert.equal((await queue.getJob(secondId)).returnvalue.outcome, "completed");
	assert.deepEqual(await queue.getJobCounts("completed", "active", "waiting", "delayed", "failed"), { completed: 2, active: 0, waiting: 0, delayed: 0, failed: 0, paused: 0 });
	assert.equal((await store.signal({ trigger, deliveryId: "during-active-19" })).duplicate, true);
	await waitFor(Promise.all([reconcile(store), reconcile(secondPublisher)]));
	assert.equal(await store.read(identity), null);
	assert.deepEqual(started, [firstId, secondId], "retained receipts cannot recreate completed work");
});
