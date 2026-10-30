import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { parseConnection } from "../src/connection.mjs";
import { enqueueSandboxPreparation, readSandboxPreparation, sandboxPreparationRequest, sandboxPrepareQueueName, sandboxPrepareSlotKey, startSandboxPrepareWorker, SANDBOX_PREPARE_PENDING_MAX, SANDBOX_PREPARE_REQUEST_TTL_MS } from "../src/sandbox-prepare-requests.mjs";

const instant = 1_800_000_000_000;
const id = (n = 0) => `sb-${n.toString(16).padStart(32, "0")}`;
const request = (n = 0) => ({ op: "prepare", id: id(n), host: "worker-a", by: "operator", repo: "owner/repo", ref: "main", triggerIndex: 0, triggerDigest: "a".repeat(64), planDigest: "b".repeat(64), pin: false });

function redisFake() {
	const values = new Map();
	return { values, set: async (key, value, ...args) => { if (args.includes("NX") && values.has(key)) return null; values.set(key, value); return "OK"; }, eval: async (_script, _count, key, value) => { if (values.get(key) === value) return Number(values.delete(key)); return 0; } };
}

function queueFake(redis = redisFake()) {
	const jobs = new Map();
	const queue = { name: sandboxPrepareQueueName("worker-a"), client: Promise.resolve(redis), jobs, getJob: async (jobId) => jobs.get(jobId) ?? null, add: async (name, data, opts) => {
		if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, { id: opts.jobId, data, opts, name, getState: async () => "waiting" });
		return jobs.get(opts.jobId);
	} };
	return queue;
}

test("only reviewed preparation/pin fields enter control data; unknown operation and missing authority refuse", () => {
	const parsed = sandboxPreparationRequest({ ...request(), token: "secret", image: "host-image", command: "attack" }).request;
	assert.deepEqual(parsed, request());
	for (const patch of [{ by: "viewer/../evil" }, { id: "../../outside" }, { host: "--option" }, { op: "exec" }, { triggerDigest: "old" }, { planDigest: undefined }, { pin: "false" }]) assert.equal(sandboxPreparationRequest({ ...request(), ...patch }).refused, "sandbox-request-invalid");
	assert.equal(sandboxPreparationRequest({ op: "pin", id: id(), host: "worker-a", by: "operator", runId: "run-1" }).refused, "sandbox-request-invalid", "pin needs the reviewed incarnation");
	assert.throws(() => sandboxPrepareQueueName("a:b"), /checked host/);
	assert.doesNotMatch(sandboxPrepareQueueName("worker-a"), /^pi-jobs/, "ordinary fleet queue discovery cannot find control requests");
});

test("enqueue is host-bound, bounded atomically to 32 pending requests, and conflicting ids cannot replace a request", async () => {
	const redis = redisFake();
	const queue = queueFake(redis);
	for (let i = 0; i < SANDBOX_PREPARE_PENDING_MAX; i++) {
		const result = await enqueueSandboxPreparation(queue, request(i), { now: () => instant });
		assert.equal(result.state, "pending");
	}
	assert.equal((await enqueueSandboxPreparation(queue, request(100), { now: () => instant })).refused, "sandbox-preparation-full");
	const duplicate = await enqueueSandboxPreparation(queue, request(0), { now: () => instant });
	assert.equal(duplicate.existing, true);
	assert.equal(redis.values.size, 32);
	assert.equal((await enqueueSandboxPreparation(queue, { ...request(0), repo: "owner/foreign" }, { now: () => instant })).refused, "sandbox-request-collision");
	assert.equal(queue.jobs.get(id()).data.repo, "owner/repo");
	assert.equal((await enqueueSandboxPreparation(queue, { ...request(100), host: "worker-b" }, { now: () => instant })).refused, "sandbox-host-mismatch");
	assert.equal(queue.jobs.get(id()).data.requestedAt, instant);
	assert.equal(queue.jobs.get(id()).opts.attempts, 2);
});

test("request statuses preserve pending/preparing/policy/infra/ready distinction without leaking error details", async () => {
	const queue = queueFake();
	const job = { id: id(), data: { ...request(), requestedAt: instant }, getState: async () => "active" };
	queue.jobs.set(id(), job);
	assert.equal((await readSandboxPreparation(queue, id())).state, "preparing");
	job.getState = async () => "completed";
	job.returnvalue = { refused: "sandbox-trigger-changed", message: "preview again" };
	assert.equal((await readSandboxPreparation(queue, id())).state, "refused");
	job.returnvalue = { id: id(), host: "worker-a", until: instant + 1000, pinned: false, backend: "local", prepared: true, private: "must not escape" };
	const ready = await readSandboxPreparation(queue, id());
	assert.equal(ready.state, "ready");
	assert.equal(ready.result.private, undefined);
	job.getState = async () => "failed";
	job.failedReason = "private forged content";
	assert.equal((await readSandboxPreparation(queue, id())).state, "failed");
	assert.doesNotMatch(JSON.stringify(await readSandboxPreparation(queue, id())), /private forged/);
	assert.equal((await readSandboxPreparation(queue, id(42))).state, "unknown");
});

function workerWorld({ prepare, pin, now = () => instant } = {}) {
	const redis = redisFake();
	class FakeWorker extends EventEmitter {
		constructor(name, handler, options) { super(); this.name = name; this.handler = handler; this.options = options; this.client = Promise.resolve(redis); }
	}
	const worker = startSandboxPrepareWorker({ connection: parseConnection("redis://127.0.0.1:6379"), host: "worker-a", prepare, pin, now, Worker: FakeWorker });
	const job = { data: { ...request(), requestedAt: instant, slot: 0 }, opts: { attempts: 2 }, attemptsMade: 0 };
	redis.values.set(sandboxPrepareSlotKey("worker-a", 0), id());
	return { redis, worker, job };
}

test("policy returns release the pending claim; infrastructure throws retry only up to the request's limit", async () => {
	let calls = 0;
	const policy = workerWorld({ prepare: async () => { calls++; return { refused: "sandbox-trigger-changed", message: "preview again" }; } });
	assert.equal((await policy.worker.handler(policy.job)).refused, "sandbox-trigger-changed");
	assert.equal(calls, 1);
	assert.equal(policy.redis.values.size, 0);
	assert.equal(policy.worker.options.concurrency, 1);
	const infra = workerWorld({ prepare: async () => { throw new Error("private network detail"); } });
	await assert.rejects(infra.worker.handler(infra.job), /^Error: sandbox preparation infrastructure failed$/);
	assert.equal(infra.redis.values.size, 1, "first infra attempt keeps its claim for its retry");
	infra.job.attemptsMade = 1;
	await assert.rejects(infra.worker.handler(infra.job), /infrastructure failed/);
	assert.equal(infra.redis.values.size, 0, "last infra attempt releases only its own claim");
});

test("expired/future requests and unsupported pin handlers cost no preparation; pin uses its separate handler", async () => {
	let prepares = 0, pins = 0;
	const w = workerWorld({ prepare: async () => { prepares++; }, pin: async () => { pins++; return { id: "run-one" }; }, now: () => instant + SANDBOX_PREPARE_REQUEST_TTL_MS + 1 });
	assert.equal((await w.worker.handler(w.job)).refused, "sandbox-request-expired");
	assert.equal(prepares, 0);
	const p = workerWorld({ prepare: async () => { prepares++; }, pin: async () => { pins++; return { id: "run-one" }; } });
	p.job.data = { ...p.job.data, op: "pin", runId: "run-one", expect: { generation: "c".repeat(64), until: instant, pin: false } };
	assert.equal((await p.worker.handler(p.job)).id, "run-one");
	assert.equal(pins, 1);
	assert.equal(prepares, 0);
});
