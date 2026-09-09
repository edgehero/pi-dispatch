import assert from "node:assert/strict";
import { test } from "node:test";
import { CANCEL_ACK_TTL_MS, CANCEL_REQ_TTL_MS, cancelAckKey, cancelReqKey, removeHeldJob, requestCancel } from "../src/cancel-state.mjs";

test("the cancel keyspace is exactly cancel:req:/cancel:ack: -- the CLI, the panel and the worker meet on these strings", () => {
	assert.equal(cancelReqKey("j1"), "cancel:req:j1");
	assert.equal(cancelAckKey("j1"), "cancel:ack:j1");
});

/** A redis fake that records every call in order and answers `get` from a scripted sequence. */
function fakeRedis({ acks = [] } = {}) {
	const ops = [];
	let ackIdx = 0;
	return {
		ops,
		async set(key, value, px, ttl) {
			ops.push(["set", key, value, px, ttl]);
		},
		async get(key) {
			ops.push(["get", key]);
			const v = acks[ackIdx];
			ackIdx += 1;
			return v === undefined ? null : v;
		},
		async del(key) {
			ops.push(["del", key]);
			return 1;
		},
	};
}

test("requestCancel writes the request with its TTL and resolves the ack that appears mid-poll", async () => {
	const redis = fakeRedis({ acks: [null, null, "hostA"] });
	const sleeps = [];
	const res = await requestCancel({ redis, jobId: "j1", ackTimeoutMs: 10_000, pollMs: 250, sleep: async (ms) => sleeps.push(ms) });
	assert.deepEqual(res, { ack: "hostA" });
	// The request key carries the fixed reason value and a PX TTL: an orphaned request must reap itself.
	assert.deepEqual(redis.ops[0], ["set", "cancel:req:j1", "operator-cancel", "PX", CANCEL_REQ_TTL_MS]);
	assert.deepEqual(sleeps, [250, 250], "two empty polls, then the answer");
	assert.ok(!redis.ops.some((op) => op[0] === "del"), "an answered request is the worker's to consume, not the requester's");
});

test("an ack of the empty string is an ACK (an undeclared host), never a timeout", async () => {
	const redis = fakeRedis({ acks: [""] });
	const res = await requestCancel({ redis, jobId: "j1", pollMs: 1, sleep: async () => {} });
	assert.deepEqual(res, { ack: "" });
});

test("requestCancel times out by deleting its own request -- a cancel the operator was told failed cannot fire later", async () => {
	const redis = fakeRedis({ acks: [] });
	const res = await requestCancel({ redis, jobId: "j2", ackTimeoutMs: 500, pollMs: 250, sleep: async () => {} });
	assert.deepEqual(res, { timeout: true });
	const dels = redis.ops.filter((op) => op[0] === "del");
	assert.deepEqual(dels, [["del", "cancel:req:j2"]], "the timeout's DEL is the whole honesty of 'nothing was changed'");
});

/** The held-removal fakes share ONE ops array so the hold-keys-before-remove ORDER is observable. */
function heldWorld({ hash, state = "delayed", holder, removeThrows = false, jobMissing = false } = {}) {
	const ops = [];
	const job = {
		async getState() {
			ops.push(["getState"]);
			return state;
		},
		async remove() {
			ops.push(["remove"]);
			if (removeThrows) throw new Error("job j1 could not be removed because it is locked by another worker");
		},
	};
	const redis = {
		ops,
		async hgetall(key) {
			ops.push(["hgetall", key]);
			return hash;
		},
		async del(key) {
			ops.push(["del", key]);
			return 1;
		},
		async srem(key, member) {
			ops.push(["srem", key, member]);
			return 1;
		},
		async get(key) {
			ops.push(["get", key]);
			return holder ?? null;
		},
	};
	const queue = {
		async getJob(id) {
			ops.push(["getJob", id]);
			return jobMissing ? null : job;
		},
	};
	return { ops, redis, queue };
}

test("removeHeldJob refuses a hash without a clock -- the worker's counters create the key before anything is held", async () => {
	const { redis, queue } = heldWorld({ hash: { throttles: "2" } });
	const res = await removeHeldJob({ redis, queue, jobId: "j1" });
	assert.deepEqual(res, { invalid: "job j1 is not waiting on a condition" });
});

test("removeHeldJob refuses a job that left the queue, and one that left the hold", async () => {
	const gone = heldWorld({ hash: { since: "1" }, jobMissing: true });
	assert.deepEqual(await removeHeldJob({ redis: gone.redis, queue: gone.queue, jobId: "j1" }), { invalid: "job j1 is no longer in the queue" });
	const done = heldWorld({ hash: { since: "1" }, state: "completed" });
	assert.deepEqual(await removeHeldJob({ redis: done.redis, queue: done.queue, jobId: "j1" }), {
		invalid: "job j1 is completed, not waiting -- it has already left the hold",
	});
});

test("removeHeldJob deletes the hold keys BEFORE the job, and takes the lease only when it names this job", async () => {
	const { ops, redis, queue } = heldWorld({ hash: { since: "1", dedupId: "d1" }, holder: "j1" });
	const res = await removeHeldJob({ redis, queue, jobId: "j1" });
	assert.deepEqual(res, { ok: true, jobId: "j1" });
	// The exact sequence is the contract: an orphaned hash is a lying panel row, an orphaned job merely runs.
	assert.deepEqual(ops, [
		["hgetall", "wait:job:j1"],
		["getJob", "j1"],
		["getState"],
		["del", "wait:job:j1"],
		["srem", "wait:held", "j1"],
		["get", "wait:key:d1"],
		["del", "wait:key:d1"],
		["remove"],
	]);
});

test("removeHeldJob leaves another job's supersede lease alone", async () => {
	const { ops, redis, queue } = heldWorld({ hash: { since: "1", dedupId: "d1" }, holder: "j2" });
	await removeHeldJob({ redis, queue, jobId: "j1" });
	assert.ok(!ops.some((op) => op[0] === "del" && op[1] === "wait:key:d1"), "deleting the winner's lease would widen its deafening window");
});

test("a remove() throw yields { invalid } with the hold keys already gone -- the chosen direction of the partial failure", async () => {
	const { ops, redis, queue } = heldWorld({ hash: { since: "1" }, removeThrows: true });
	const res = await removeHeldJob({ redis, queue, jobId: "j1" });
	assert.match(res.invalid, /locked by another worker/);
	assert.ok(ops.some((op) => op[0] === "del" && op[1] === "wait:job:j1"), "hold keys go first even when the remove then fails");
});
