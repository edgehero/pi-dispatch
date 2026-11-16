import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { removeQueuedJob } from "../src/cancel-state.mjs";
import { localEventJobId, LOCAL_EVENT_MAX_AGE_MS } from "../src/local-event.mjs";
import { LocalEventWait, makeLocalEventRuntime } from "../src/local-event-runtime.mjs";
import { LOCAL_EVENT_INDEX_KEY, localEventStateKey, makeLocalEventStore, readLocalEventStatus } from "../src/local-event-store.mjs";
import { FORGE_JOB_RETENTION_S, LOCAL_JOB_KEPT_COMPLETED_S, LOCAL_JOB_KEPT_FAILED_S } from "../src/retention.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";

// Exercise the atomic receipt and signal transitions in the real Lua engine. The queue fake models only public
// methods, including a successful add whose acknowledgement is lost; no test writes BullMQ's private keys.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("local-event-store REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const live = { skip: url ? false : "needs VALKEY_TEST_URL", timeout: 30_000 };

async function harness(t, { debounceSeconds = 10, once = false } = {}) {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	const keys = new Set();
	const states = new Set();
	const receipts = new Set();
	const tracked = {
		eval: (...args) => {
			states.add(args[2]); keys.add(args[2]);
			if (args[4]) { receipts.add(args[4]); keys.add(args[4]); }
			return redis.eval(...args);
		},
		get: (...args) => redis.get(...args),
		del: (...args) => redis.del(...args),
		zscan: (...args) => redis.zscan(...args),
		zrem: (...args) => redis.zrem(...args),
	};
	t.after(async () => {
		try {
			if (states.size) await redis.zrem(LOCAL_EVENT_INDEX_KEY, ...states);
			if (keys.size) await redis.del(...keys);
		} finally { redis.disconnect(); }
	});
	const id = `test-${randomUUID().replaceAll("-", "")}`;
	const worker = `owner-${randomUUID().replaceAll("-", "")}`;
	const [trigger] = parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [{
		on: { type: "issue", forge: "github", id, action: ["closed"], debounceSeconds, ...(once && { once: true, number: 7 }) },
		run: { kind: "local", folder: "/srv/maintenance", command: "maintain-prs", worker },
	}] }), "triggers.json");
	let instant = 1_000_000;
	const now = () => instant;
	const store = makeLocalEventStore({ redis: tracked, now });
	const jobs = new Map();
	const queue = {
		calls: [],
		beforeAdd: null,
		afterAdd: null,
		async getJob(jobId) { return jobs.get(jobId) ?? null; },
		async add(name, data, opts) {
			this.calls.push({ name, data, opts });
			await this.beforeAdd?.();
			if (!jobs.has(opts.jobId)) {
				jobs.set(opts.jobId, { id: opts.jobId, data, status: opts.delay > 0 ? "delayed" : "waiting", async getState() { return this.status; }, async remove() { jobs.delete(opts.jobId); } });
			}
			await this.afterAdd?.();
			return jobs.get(opts.jobId);
		},
	};
	return {
		redis, tracked, receipts, trigger, worker, now, store, jobs, queue,
		at(value) { instant = value; },
		advance(value) { instant += value; },
		signal(deliveryId, definition = trigger) { return store.signal({ trigger: definition, deliveryId }); },
		read() { return store.read({ id, forge: "github" }); },
		async meta() { return (await this.read()).current.data.localEvent; },
		reconcile() { return store.reconcile({ worker, queueFor: async (owner) => { assert.equal(owner, worker); return queue; } }); },
	};
}

test("a burst extends trailing debounce once per delivery, bounded by the first signal's maximum age", live, async (t) => {
	const h = await harness(t);
	const first = await h.signal("first");
	assert.equal(first.coalesced, false);
	h.advance(5_000);
	const second = await h.signal("second");
	assert.equal(second.generation, first.generation);
	assert.equal(second.coalesced, true);
	const before = await h.read();
	assert.equal(before.current.count, 2);
	assert.equal(before.current.dueAt, h.now() + 10_000);
	h.advance(4_000);
	assert.equal((await h.signal("second")).duplicate, true);
	assert.deepEqual(await h.read(), before, "redelivery must not change the count, age or due time");
	assert.deepEqual(await h.store.claim(before.current.data.localEvent, "attempt"), { untilMs: before.current.dueAt });
	h.at(before.current.firstAt + LOCAL_EVENT_MAX_AGE_MS - 1);
	await h.signal("late-burst");
	const capped = await h.read();
	assert.equal(capped.current.dueAt, before.current.firstAt + LOCAL_EVENT_MAX_AGE_MS);
	assert.equal(await h.redis.ttl(localEventStateKey(capped.current.data.localEvent)), -1, "intent never expires while execution is uncertain");
	for (const receipt of h.receipts) {
		const ttl = await h.redis.ttl(receipt);
		assert.ok(ttl > 0 && ttl <= FORGE_JOB_RETENTION_S);
	}
});

test("concurrent deliveries commit one receipt and one pending generation across publisher instances", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	const other = makeLocalEventStore({ redis: h.tracked, now: h.now });
	const duplicates = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? other : h.store).signal({ trigger: h.trigger, deliveryId: "same-delivery" })));
	assert.equal(duplicates.filter((r) => !r.duplicate).length, 1);
	assert.equal((await h.read()).current.count, 1);
	await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? other : h.store).signal({ trigger: h.trigger, deliveryId: `distinct-${i}` })));
	const state = await h.read();
	assert.equal(state.current.count, 25);
	assert.equal(state.next, undefined);
	assert.equal(h.receipts.size, 25);
});

test("an active generation holds exactly one debounced successor, and stale completion cannot consume it", live, async (t) => {
	const h = await harness(t);
	await h.signal("first"); h.advance(10_000);
	const meta = await h.meta();
	assert.deepEqual(await h.store.claim(meta, "attempt-one"), { ok: true, count: 1 });
	await Promise.all(Array.from({ length: 16 }, (_, i) => h.signal(`active-${i}`)));
	const active = await h.read();
	assert.equal(active.current.phase, "active");
	assert.equal(active.current.count, 1);
	assert.equal(active.next.count, 16);
	assert.notEqual(active.next.generation, active.current.generation);
	assert.equal((await h.signal("first")).duplicate, true);
	assert.deepEqual(await h.read(), active, "an earlier receipt must not dirty active work");
	assert.deepEqual(await h.store.finish(meta, { owner: "wrong-attempt" }), { stale: true });
	h.advance(3_000);
	assert.deepEqual(await h.store.finish(meta, { owner: "attempt-one" }), { ok: true });
	const promoted = await h.read();
	assert.equal(promoted.current.generation, active.next.generation);
	assert.equal(promoted.current.dueAt, active.next.dueAt, "remaining debounce survives promotion");
	assert.equal(promoted.next, undefined);
	assert.deepEqual(await h.store.finish(meta, { owner: "attempt-one" }), { stale: true });
	assert.deepEqual(await h.read(), promoted);
	h.at(promoted.current.dueAt);
	assert.equal((await h.store.claim(promoted.current.data.localEvent, "attempt-two")).ok, true);
	await h.store.finish(promoted.current.data.localEvent, { owner: "attempt-two" });
	assert.equal(await h.read(), null);
	assert.equal(await h.redis.zscore(LOCAL_EVENT_INDEX_KEY, localEventStateKey(meta)), null);
	assert.equal((await h.signal("first")).duplicate, true, "receipts outlive the completed intent");
	assert.equal(await h.read(), null);
});

test("a definition change keeps the running generation immutable and replaces only its pending successor", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first");
	await h.store.claim(await h.meta(), "attempt");
	const original = await h.read();
	const changed = { ...h.trigger, run: { ...h.trigger.run, command: "maintain-v2" } };
	await h.signal("edited", changed);
	const replacement = { ...h.trigger, run: { ...h.trigger.run, command: "maintain-v3" } };
	await h.signal("edited-again", replacement);
	const state = await h.read();
	assert.deepEqual(state.current, original.current);
	assert.equal(state.next.data.command, "maintain-v3");
	assert.equal(state.next.count, 1);
	await h.store.finish(original.current.data.localEvent);
	assert.equal((await h.read()).current.data.command, "maintain-v3");
});

test("an unclaimed definition change supersedes old work and routes immediately to the new owner", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first"); await h.reconcile();
	const old = await h.meta();
	const replacement = { ...h.trigger, run: { ...h.trigger.run, worker: `${h.worker}-new`, command: "maintain-v2" } };
	await h.signal("edited-owner", replacement);
	const state = await h.read();
	assert.notEqual(state.current.generation, old.generation);
	assert.equal(state.current.data.worker, replacement.run.worker);
	assert.equal(state.next, undefined);
	assert.deepEqual(await h.store.claim(old, "stale-owner"), { stale: true });
	await h.store.reconcile({ worker: replacement.run.worker, queueFor: async (owner) => { assert.equal(owner, replacement.run.worker); return h.queue; } });
	assert.ok(h.jobs.has(localEventJobId(state.current.generation)), "the unavailable old owner cannot hold up unclaimed replacement work");
});

test("cancel clears accepted work, while a later distinct signal survives as a new generation", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first");
	const meta = await h.meta();
	await h.store.claim(meta, "attempt");
	await h.signal("before-cancel");
	await h.store.cancel(meta);
	const cancelled = await h.read();
	assert.equal(cancelled.current.cancelled, true);
	assert.equal(cancelled.next, undefined);
	assert.deepEqual(await h.store.claim(meta, "attempt"), { cancelled: true });
	assert.equal((await h.signal("before-cancel")).duplicate, true);
	assert.equal((await h.read()).next, undefined);
	await h.signal("after-cancel");
	const next = (await h.read()).next;
	assert.equal(next.count, 1);
	await h.store.cancel(meta);
	assert.equal((await h.read()).next.generation, next.generation, "a repeated cancel acknowledgement cannot erase a later signal");
	await h.store.finish(meta, { owner: "attempt" });
	assert.equal((await h.read()).current.generation, next.generation);
	assert.deepEqual(await h.store.cancel(meta), { stale: true }, "an old cancel cannot cancel the new generation");
});

test("a lost queue-add acknowledgement reconciles to the same job without losing its intent", live, async (t) => {
	const h = await harness(t);
	await h.signal("first");
	const meta = await h.meta();
	h.queue.afterAdd = () => { throw new Error("connection closed after add"); };
	await assert.rejects(h.reconcile(), /connection closed after add/);
	assert.equal(h.jobs.size, 1);
	assert.equal((await h.read()).current.generation, meta.generation);
	h.queue.afterAdd = null;
	const restarted = makeLocalEventStore({ redis: h.tracked, now: h.now });
	assert.deepEqual(await restarted.reconcile({ worker: h.worker, queueFor: async () => h.queue }), { published: 0 });
	assert.equal(h.jobs.size, 1);
	assert.equal(h.queue.calls.length, 1);
	assert.equal(h.queue.calls[0].opts.jobId, localEventJobId(meta.generation));
	assert.equal(h.queue.calls[0].opts.delay, 10_000);
	assert.deepEqual(h.queue.calls[0].opts.removeOnComplete, { age: LOCAL_JOB_KEPT_COMPLETED_S });
	assert.deepEqual(h.queue.calls[0].opts.removeOnFail, { age: LOCAL_JOB_KEPT_FAILED_S });
});

test("parallel reconciliation publishes only the deterministic generation and survives a pre-add outage", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first");
	h.queue.beforeAdd = () => { throw new Error("queue unavailable"); };
	await assert.rejects(h.reconcile(), /queue unavailable/);
	assert.equal(h.jobs.size, 0);
	assert.equal((await h.read()).current.phase, "pending");
	h.queue.beforeAdd = null;
	const second = makeLocalEventStore({ redis: h.tracked, now: h.now });
	await Promise.all([h.reconcile(), second.reconcile({ worker: h.worker, queueFor: async () => h.queue })]);
	assert.equal(h.jobs.size, 1);
	assert.equal(new Set(h.queue.calls.map((call) => call.opts.jobId)).size, 1);
});

test("cleanup of a stale scan entry cannot remove a fresh signal's reconciliation index", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first");
	const meta = await h.meta();
	const key = localEventStateKey(meta);
	let raced = false;
	h.tracked.get = async (requested) => {
		if (requested !== key || raced) return h.redis.get(requested);
		raced = true;
		await h.store.finish(meta);
		const absent = await h.redis.get(key);
		await h.signal("arrives-after-empty-read");
		return absent;
	};
	await h.reconcile();
	assert.equal(raced, true);
	const replacement = await h.read();
	assert.notEqual(replacement.current.generation, meta.generation);
	assert.notEqual(await h.redis.zscore(LOCAL_EVENT_INDEX_KEY, key), null, "the new intent must remain discoverable");
	await h.reconcile();
	assert.equal(h.jobs.has(localEventJobId(replacement.current.generation)), true);
});

test("cancellation during a queue publish is reclaimed without consuming a subsequent signal", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first");
	const old = await h.meta();
	h.queue.beforeAdd = async () => { await h.store.cancel(old); await h.signal("after-cancel"); };
	await h.reconcile();
	assert.equal(h.jobs.size, 1, "the raced queue entry is harmless until pickup rechecks state");
	h.queue.beforeAdd = null;
	const replacement = (await h.read()).current;
	assert.notEqual(replacement.generation, old.generation);
	await h.reconcile();
	assert.equal((await h.read()).current.generation, replacement.generation);
	assert.equal(h.jobs.has(localEventJobId(replacement.generation)), true);
	assert.deepEqual(await h.store.claim(old, "old-attempt"), { stale: true }, "an already-sent publish can leave only a superseded queue entry");
});

test("signals during retry stay in one successor until the original job reaches a terminal state", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first"); await h.reconcile();
	const meta = await h.meta();
	await h.store.claim(meta, "first-attempt");
	await h.signal("during-first");
	const job = h.jobs.get(localEventJobId(meta.generation));
	for (const status of ["delayed", "waiting", "active"]) {
		job.status = status;
		await h.reconcile();
		assert.equal((await h.read()).current.generation, meta.generation, status);
	}
	await h.store.claim(meta, "retry-attempt");
	await h.signal("during-retry");
	assert.equal((await h.read()).next.count, 2);
	assert.deepEqual(await h.store.finish(meta, { owner: "first-attempt" }), { stale: true });
	const next = (await h.read()).next;
	job.status = "failed";
	await h.reconcile();
	assert.equal((await h.read()).current.generation, next.generation);
	await h.reconcile();
	assert.equal(h.jobs.has(localEventJobId(next.generation)), true);
});

test("terminal completion promotes only once, and spent one-shots discard their successor", live, async (t) => {
	for (const once of [false, true]) {
		const h = await harness(t, { debounceSeconds: 0, once });
		await h.signal("first"); await h.reconcile();
		const meta = await h.meta();
		await h.store.claim(meta, "attempt");
		await h.signal("during");
		const next = (await h.read()).next;
		const job = h.jobs.get(localEventJobId(meta.generation));
		job.status = "completed";
		await h.reconcile();
		if (once) assert.equal(await h.read(), null);
		else assert.equal((await h.read()).current.generation, next.generation);
		assert.deepEqual(await h.store.finish(meta), { stale: true });
	}
});

test("settling a spent one-shot preserves a successor accepted under a new reviewed definition", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0, once: true });
	await h.signal("first"); await h.reconcile();
	const meta = await h.meta();
	await h.store.claim(meta, "attempt");
	await h.signal("changed", { ...h.trigger, run: { ...h.trigger.run, command: "maintain-v2" } });
	const next = (await h.read()).next;
	h.jobs.get(localEventJobId(meta.generation)).status = "completed";
	await h.reconcile();
	assert.equal((await h.read()).current.generation, next.generation);
	assert.equal((await h.read()).current.data.command, "maintain-v2");
});

test("missing active jobs remain held indefinitely and are never inferred safe from elapsed time", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first"); await h.reconcile();
	const meta = await h.meta();
	await h.store.claim(meta, "attempt"); await h.signal("successor");
	h.jobs.delete(localEventJobId(meta.generation));
	h.advance(10 * 24 * 60 * 60 * 1000);
	assert.deepEqual(await h.reconcile(), { published: 0, blocked: 1 });
	assert.equal(h.jobs.size, 0);
	assert.equal((await h.read()).current.generation, meta.generation);
	assert.equal((await h.read()).next.count, 1);
});

test("cancelled active work with a missing queue entry still blocks a later signal", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first"); await h.reconcile();
	const meta = await h.meta();
	await h.store.claim(meta, "attempt"); await h.store.cancel(meta); await h.signal("after-cancel");
	const next = (await h.read()).next;
	h.jobs.delete(localEventJobId(meta.generation));
	assert.deepEqual(await h.reconcile(), { published: 0, blocked: 1 });
	assert.equal((await h.read()).current.generation, meta.generation);
	assert.equal((await h.read()).next.generation, next.generation);
	assert.equal(h.jobs.size, 0);
});

test("queued cancellation removes its intent before reconciliation can recreate the job", live, async (t) => {
	const h = await harness(t);
	await h.signal("first"); await h.reconcile();
	const meta = await h.meta();
	const job = h.jobs.get(localEventJobId(meta.generation));
	const removed = await removeQueuedJob({ redis: h.tracked, queue: h.queue, job, jobId: job.id, state: "delayed", now: h.now, touchStore: null });
	assert.equal(removed.ok, true);
	assert.equal((await h.read()).current.cancelled, true);
	await h.reconcile(); await h.reconcile();
	assert.equal(await h.read(), null);
	assert.equal(h.jobs.size, 0);
	assert.equal((await h.signal("first")).duplicate, true);
	assert.equal(await h.read(), null);
	await h.signal("new-delivery"); await h.reconcile();
	assert.equal(h.jobs.size, 1);
	assert.equal(h.jobs.has(job.id), false, "new work has its own generation");
});

test("a queued removal that fails reports committed or uncertain signal mutation explicitly", live, async (t) => {
	for (const lostAnswer of [false, true]) {
		const h = await harness(t);
		await h.signal("first"); await h.reconcile();
		const meta = await h.meta();
		const job = h.jobs.get(localEventJobId(meta.generation));
		let removeCalled = false;
		job.remove = async () => { removeCalled = true; job.status = "active"; throw new Error("job is locked"); };
		const evalOriginal = h.tracked.eval;
		if (lostAnswer) h.tracked.eval = async (...args) => { await evalOriginal(...args); throw new Error("lost cancellation reply"); };
		const result = await removeQueuedJob({ redis: h.tracked, queue: h.queue, job, jobId: job.id, state: "delayed", now: h.now, touchStore: null });
		assert.equal(result.raced, true);
		assert.equal(result.localSignalChanged, lostAnswer ? "unknown" : "yes");
		assert.equal((await h.read()).current.cancelled, true);
		assert.equal(removeCalled, !lostAnswer, "without an acknowledged tombstone, removal must not be attempted");
		assert.equal(h.jobs.size, 1);
	}
});

test("a stale publish after intent deletion cannot resurrect executable authority", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first");
	const meta = await h.meta();
	h.queue.beforeAdd = async () => { await h.store.cancel(meta); await h.store.finish(meta); };
	await h.reconcile();
	assert.equal(await h.read(), null);
	const stale = h.jobs.get(localEventJobId(meta.generation));
	assert.ok(stale, "a publisher can be in flight while an operator removes the intent");
	const runtime = makeLocalEventRuntime({ store: h.store, worker: h.worker, now: h.now, triggersPath: "triggers.json", readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [h.trigger] }) });
	assert.deepEqual(await runtime.claim(stale, "stale-attempt"), { outcome: "policy", reason: "local-event-superseded", budgetReserved: false });
	assert.equal(await h.read(), null);
});

test("owner routing stays deterministic and operator status omits execution data", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first");
	const meta = await h.meta();
	assert.deepEqual(await h.store.reconcile({ worker: "another-owner", queueFor: () => assert.fail("other owner must not open a queue") }), { published: 0 });
	assert.equal(h.jobs.size, 0);
	await h.store.claim(meta, "attempt"); await h.signal("next");
	const state = await h.read();
	assert.deepEqual(await readLocalEventStatus(h.redis, meta), {
		current: { jobId: localEventJobId(meta.generation), phase: "active", cancelled: false, count: 1, dueAt: state.current.dueAt },
		next: { jobId: localEventJobId(state.next.generation), phase: "pending", cancelled: false, count: 1, dueAt: state.next.dueAt },
	});
});

test("a job round-tripped through Lua retains its reviewed authority at runtime", live, async (t) => {
	const h = await harness(t, { debounceSeconds: 0 });
	await h.signal("first"); await h.reconcile();
	const job = h.jobs.get(localEventJobId((await h.meta()).generation));
	const runtime = makeLocalEventRuntime({ store: h.store, worker: h.worker, now: h.now, triggersPath: "triggers.json", readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [h.trigger] }) });
	assert.deepEqual(await runtime.check(job), { ok: true, index: 0 });
	assert.deepEqual(await runtime.claim(job, "attempt"), { ok: true });
});

test("atomic store readiness decides debounce despite a worker clock ahead of or behind the authority clock", live, async (t) => {
	const h = await harness(t);
	await h.signal("first"); await h.reconcile();
	const meta = await h.meta();
	const job = h.jobs.get(localEventJobId(meta.generation));
	const initial = await h.read();
	let skew = 1_000_000;
	const runtime = makeLocalEventRuntime({ store: h.store, worker: h.worker, now: () => h.now() + skew, triggersPath: "triggers.json", readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [h.trigger] }) });
	assert.deepEqual(await runtime.check(job), { untilMs: initial.current.dueAt }, "a fast worker clock cannot admit the job early");
	assert.deepEqual(await h.read(), initial, "readiness does not claim or rewrite the signal");
	h.advance(10_000); skew = -1_000_000;
	assert.deepEqual(await runtime.check(job), { ok: true, index: 0 }, "a slow worker clock cannot keep a due signal waiting forever");
	assert.deepEqual(await runtime.claim(job, "attempt"), { ok: true });
});

test("a delivery or cancellation between runtime check and atomic claim is rechecked before spending", live, async (t) => {
	for (const race of ["signal", "cancel"]) {
		const h = await harness(t);
		await h.signal("first"); await h.reconcile(); h.advance(10_000);
		const meta = await h.meta();
		const job = h.jobs.get(localEventJobId(meta.generation));
		const store = { ...h.store, async claim(value, owner) {
			if (race === "signal") await h.signal("arrived-after-check");
			else await h.store.cancel(meta);
			return h.store.claim(value, owner);
		} };
		const runtime = makeLocalEventRuntime({ store, worker: h.worker, now: h.now, triggersPath: "triggers.json", readFile: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [h.trigger] }) });
		if (race === "signal") {
			await assert.rejects(runtime.claim(job, "attempt"), (error) => error instanceof LocalEventWait && error.untilMs === h.now() + 10_000);
		} else {
			assert.deepEqual(await runtime.claim(job, "attempt"), { outcome: "policy", reason: "operator-cancel", budgetReserved: false });
		}
		assert.equal((await h.read()).current.phase, "pending", "the stale check never claims execution");
	}
});
