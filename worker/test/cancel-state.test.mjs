import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplyError } from "ioredis";
import { CANCEL_ACK_TTL_MS, CANCEL_REQ_TTL_MS, QUEUED_STATES, cancelAckKey, cancelReqKey, removeHeldJob, removeQueuedJob, requestCancel } from "../src/cancel-state.mjs";

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
function heldWorld({ hash, state = "delayed", holder, removeThrows = false, jobMissing = false, attemptsMade } = {}) {
	const ops = [];
	const job = {
		attemptsMade,
		async getState() {
			ops.push(["getState"]);
			return state;
		},
		async remove() {
			ops.push(["remove"]);
			if (removeThrows) throw new Error("job j1 could not be removed because it is locked by another worker");
		},
	};
	let present = hash !== null && hash !== undefined;
	const redis = {
		ops,
		async hgetall(key) {
			ops.push(["hgetall", key]);
			return hash;
		},
		async del(key) {
			ops.push(["del", key]);
			if (key === "wait:job:j1") present = false;
			return 1;
		},
		async hexists(key, field) {
			ops.push(["hexists", key, field]);
			return key === "wait:job:j1" && field === "since" && present && hash?.since !== undefined ? 1 : 0;
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
	assert.deepEqual(res, { ok: true, jobId: "j1", attemptsMade: 0 });
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

test("a remove() throw yields { invalid, cleared: true } with the hold keys already gone -- the chosen direction of the partial failure", async () => {
	const { ops, redis, queue } = heldWorld({ hash: { since: "1" }, removeThrows: true });
	const res = await removeHeldJob({ redis, queue, jobId: "j1" });
	assert.match(res.invalid, /locked by another worker/);
	assert.deepEqual(Object.keys(res), ["invalid", "cleared"]);
	assert.equal(res.cleared, true, "the hold is gone, so a caller must not say nothing was changed");
	assert.ok(ops.some((op) => op[0] === "del" && op[1] === "wait:job:j1"), "hold keys go first even when the remove then fails");
	// The same command sequence as a removal that succeeds: the mark is the answer's, never a command of its own.
	assert.deepEqual(ops, [["hgetall", "wait:job:j1"], ["getJob", "j1"], ["getState"], ["del", "wait:job:j1"], ["srem", "wait:held", "j1"], ["remove"]]);
});

test("removeHeldJob marks cleared from the hold's first delete on, and never before it", async () => {
	// A delete that throws may still have landed: from the moment it is sent, the hold may be gone.
	const delThrows = heldWorld({ hash: { since: "1" } });
	delThrows.redis.del = async (key) => {
		delThrows.ops.push(["del", key]);
		throw new Error("ECONNRESET");
	};
	delThrows.redis.hexists = async () => {
		throw new Error("ECONNRESET");
	};
	assert.deepEqual(await removeHeldJob({ redis: delThrows.redis, queue: delThrows.queue, jobId: "j1" }), { invalid: "ECONNRESET", cleared: true });
	// The same failure, the connection back by the read: the hold is read back in place, so nothing was changed.
	const readBack = heldWorld({ hash: { since: "1" } });
	readBack.redis.del = async (key) => {
		readBack.ops.push(["del", key]);
		throw new Error("ECONNRESET");
	};
	assert.deepEqual(await removeHeldJob({ redis: readBack.redis, queue: readBack.queue, jobId: "j1" }), { invalid: "ECONNRESET" });
	assert.deepEqual(readBack.ops.slice(-2), [["del", "wait:job:j1"], ["hexists", "wait:job:j1", "since"]]);
	// A client that cannot read it back keeps the mark.
	const noExists = heldWorld({ hash: { since: "1" } });
	noExists.redis.del = async () => {
		throw new Error("ECONNRESET");
	};
	delete noExists.redis.hexists;
	assert.deepEqual(await removeHeldJob({ redis: noExists.redis, queue: noExists.queue, jobId: "j1" }), { invalid: "ECONNRESET", cleared: true });
	// A lease read that throws after the hash and the member went: cleared, and the job was never asked to go.
	const leaseThrows = heldWorld({ hash: { since: "1", dedupId: "d1" } });
	leaseThrows.redis.get = async () => {
		throw new Error("ECONNRESET");
	};
	assert.deepEqual(await removeHeldJob({ redis: leaseThrows.redis, queue: leaseThrows.queue, jobId: "j1" }), { invalid: "ECONNRESET", cleared: true });
	assert.ok(!leaseThrows.ops.some((op) => op[0] === "remove"));
	// A failure before any delete changed nothing, and says so by carrying no mark.
	const lookupThrows = heldWorld({ hash: { since: "1" } });
	lookupThrows.queue.getJob = async () => {
		throw new Error("ECONNRESET");
	};
	assert.deepEqual(await removeHeldJob({ redis: lookupThrows.redis, queue: lookupThrows.queue, jobId: "j1" }), { invalid: "ECONNRESET" });
	assert.ok(!lookupThrows.ops.some((op) => op[0] === "del"));
});

test("removeHeldJob: a first delete Valkey refused, with the hold read back in place, carries no mark; a refused resend of a delete that ran keeps it", async () => {
	// Valkey's own refusal (ioredis's ReplyError, as an ACL without DEL, a read-only replica or a failed save answers):
	// the hold is read back, it is still there, so nothing was changed and a caller may say so.
	for (const refusal of ["NOPERM User ops has no permissions to run the 'del' command", "READONLY You can't write against a read only replica.", "MISCONF Errors writing to the AOF file"]) {
		const world = heldWorld({ hash: { since: "1", dedupId: "d1" }, holder: "j1" });
		world.redis.del = async (key) => {
			world.ops.push(["del", key]);
			throw new ReplyError(refusal);
		};
		const res = await removeHeldJob({ redis: world.redis, queue: world.queue, jobId: "j1" });
		assert.deepEqual(res, { invalid: refusal }, refusal);
		// The same commands up to the refused one, and none after it: the sequence is the sequence.
		assert.deepEqual(world.ops, [["hgetall", "wait:job:j1"], ["getJob", "j1"], ["getState"], ["del", "wait:job:j1"], ["hexists", "wait:job:j1", "since"]], refusal);
		// And the shared sequence passes it on as a refusal, never as a hold cleared.
		const queued = heldWorld({ hash: { since: "1" } });
		queued.redis.del = async () => {
			throw new ReplyError(refusal);
		};
		assert.deepEqual(await removeQueuedJob({ redis: queued.redis, queue: queued.queue, job: null, jobId: "j1" }), { invalid: refusal }, refusal);
	}
	// A refusal that answers ioredis's resend of a DEL that already ran (the connection dropped before its reply): the
	// hold is not read back, so the mark stays.
	const resent = heldWorld({ hash: { since: "1" } });
	const firstDel = resent.redis.del;
	resent.redis.del = async (key) => {
		await firstDel(key);
		throw new ReplyError("READONLY You can't write against a read only replica.");
	};
	assert.deepEqual(await removeHeldJob({ redis: resent.redis, queue: resent.queue, jobId: "j1" }), { invalid: "READONLY You can't write against a read only replica.", cleared: true });
	// A counter that re-created the key after the delete ran (the worker's own noteCheck) is no hold: the clock is gone.
	const counted = heldWorld({ hash: { since: "1" } });
	const deleteThenCount = counted.redis.del;
	counted.redis.del = async (key) => {
		await deleteThenCount(key);
		throw new ReplyError("READONLY You can't write against a read only replica.");
	};
	counted.redis.hexists = async (key, field) => {
		counted.ops.push(["hexists", key, field]);
		return 0;
	};
	assert.deepEqual(await removeHeldJob({ redis: counted.redis, queue: counted.queue, jobId: "j1" }), { invalid: "READONLY You can't write against a read only replica.", cleared: true });
	// A transport failure whose read back fails too: the mark stays.
	const reset = heldWorld({ hash: { since: "1" } });
	reset.redis.del = async () => {
		throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
	};
	reset.redis.hexists = async () => {
		throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
	};
	assert.deepEqual(await removeHeldJob({ redis: reset.redis, queue: reset.queue, jobId: "j1" }), { invalid: "read ECONNRESET", cleared: true });
	// A refusal of a LATER delete (the lease's) comes after the hold's own key went: cleared, and the job was not asked.
	const lease = heldWorld({ hash: { since: "1", dedupId: "d1" }, holder: "j1" });
	lease.redis.del = async (key) => {
		lease.ops.push(["del", key]);
		if (key === "wait:key:d1") throw new ReplyError("NOPERM User ops has no permissions to run the 'del' command");
		return 1;
	};
	assert.deepEqual(await removeHeldJob({ redis: lease.redis, queue: lease.queue, jobId: "j1" }), { invalid: "NOPERM User ops has no permissions to run the 'del' command", cleared: true });
	assert.ok(!lease.ops.some((op) => op[0] === "remove"));
});

test("removeHeldJob reports the attempts the job had made, for the caller's sentence (#477)", async () => {
	// A job held again on a retry had run: the CLI and the panel word it from this count (`ranBefore`).
	const ran = heldWorld({ hash: { since: "1" }, attemptsMade: 2 });
	assert.deepEqual(await removeHeldJob({ redis: ran.redis, queue: ran.queue, jobId: "j1" }), { ok: true, jobId: "j1", attemptsMade: 2 });
	for (const made of [undefined, -1, 1.5, "3"]) {
		const odd = heldWorld({ hash: { since: "1" }, attemptsMade: made });
		assert.equal((await removeHeldJob({ redis: odd.redis, queue: odd.queue, jobId: "j1" })).attemptsMade, 0, String(made));
	}
});

// ---- issue #737: removeQueuedJob, the one sequence the CLI's cancel and the console's cancel-queued share ----------

/**
 * One ops array across the job, the queue and redis, so the ORDER is observable: the hold before the job, the defer
 * record only after the job is gone. `state` may be a list, read in turn (the last one repeats).
 */
function queuedWorld({ hash = {}, state = "delayed", removeThrows = false, attemptsMade, jobMissing = false, holder, hgetallRejects = false, del = "ok" } = {}) {
	const ops = [];
	const states = Array.isArray(state) ? [...state] : [state];
	const job = {
		attemptsMade,
		async getState() {
			ops.push(["getState"]);
			const s = states.length > 1 ? states.shift() : states[0];
			if (s instanceof Error) throw s;
			return s;
		},
		async remove() {
			ops.push(["remove"]);
			if (removeThrows) throw new Error("Job j1 belongs to a job scheduler and cannot be removed directly. remove");
		},
	};
	const redis = {
		async hgetall(key) {
			ops.push(["hgetall", key]);
			if (hgetallRejects) throw new Error("ECONNRESET");
			return hash;
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
	if (del !== "absent") {
		redis.del = (key) => {
			ops.push(["del", key]);
			// The hold keys always answer: `del` modes are for the defer record, the step under test.
			if (!key.startsWith("defer:")) return Promise.resolve(1);
			if (del === "hang") return new Promise(() => {});
			if (del === "reject") return Promise.reject(new Error("ECONNRESET"));
			if (del === "throw") throw new Error("not connected");
			return Promise.resolve(1);
		};
	}
	const queue = {
		async getJob(id) {
			ops.push(["getJob", id]);
			return jobMissing ? null : job;
		},
	};
	return { ops, redis, queue, job };
}

test("QUEUED_STATES are the four states a job waits to start in, the CLI's own list", () => {
	assert.deepEqual(QUEUED_STATES, ["delayed", "waiting", "prioritized", "paused"]);
	assert.ok(Object.isFrozen(QUEUED_STATES));
});

test("removeQueuedJob: a held job goes through removeHeldJob's exact sequence, then its defer record, and only then", async () => {
	const { ops, redis, queue, job } = queuedWorld({ hash: { since: "1", dedupId: "d1" }, holder: "j1", attemptsMade: 1 });
	const res = await removeQueuedJob({ redis, queue, job, jobId: "j1" });
	assert.deepEqual(res, { ok: true, held: true, jobId: "j1", attemptsMade: 1 });
	assert.deepEqual(ops, [
		["hgetall", "wait:job:j1"],
		// removeHeldJob, UNCHANGED (its own test above pins the same eight steps)
		["hgetall", "wait:job:j1"],
		["getJob", "j1"],
		["getState"],
		["del", "wait:job:j1"],
		["srem", "wait:held", "j1"],
		["get", "wait:key:d1"],
		["del", "wait:key:d1"],
		["remove"],
		["del", "defer:job:j1"],
	]);
});

test("removeQueuedJob: removeHeldJob's refusal is the answer, its cleared mark carried, and the defer record stays", async () => {
	for (const [world, want, keys] of [
		[{ jobMissing: true }, /no longer in the queue/, ["invalid"]],
		[{ state: "completed" }, /is completed, not waiting -- it has already left the hold/, ["invalid"]],
		// The remove failed after the hold's keys were deleted: the caller must be able to say the hold is gone.
		[{ removeThrows: true }, /cannot be removed directly/, ["invalid", "cleared"]],
	]) {
		const { ops, redis, queue, job } = queuedWorld({ hash: { since: "1" }, ...world });
		const res = await removeQueuedJob({ redis, queue, job, jobId: "j1" });
		assert.deepEqual(Object.keys(res), keys);
		assert.match(res.invalid, want);
		if (keys.includes("cleared")) assert.equal(res.cleared, true);
		assert.ok(!ops.some((op) => op[0] === "del" && op[1] === "defer:job:j1"), "a job that may still be there keeps its reason");
	}
});

test("removeQueuedJob: a guard is asked right before the removal is sent, and its refusal changes nothing", async () => {
	const asked = (ops) => async (job) => {
		ops.push(["guard", job === null ? null : "job"]);
		return null;
	};
	// A waiting job: after the state check, before the remove.
	const plain = queuedWorld();
	assert.deepEqual(await removeQueuedJob({ redis: plain.redis, queue: plain.queue, job: plain.job, jobId: "j1", guard: asked(plain.ops) }), { ok: true, held: false, jobId: "j1", state: "delayed", attemptsMade: 0 });
	assert.deepEqual(plain.ops, [["hgetall", "wait:job:j1"], ["getState"], ["guard", "job"], ["remove"], ["del", "defer:job:j1"]]);
	// A held job: before removeHeldJob's sequence, which is unchanged after it.
	const held = queuedWorld({ hash: { since: "1" } });
	assert.equal((await removeQueuedJob({ redis: held.redis, queue: held.queue, job: held.job, jobId: "j1", guard: asked(held.ops) })).ok, true);
	assert.deepEqual(held.ops.slice(0, 3), [["hgetall", "wait:job:j1"], ["guard", "job"], ["hgetall", "wait:job:j1"]]);
	// A refusal, or a throw: the answer, and nothing removed or deleted, on either path.
	for (const hash of [{}, { since: "1" }]) {
		const refused = queuedWorld({ hash });
		assert.deepEqual(await removeQueuedJob({ redis: refused.redis, queue: refused.queue, job: refused.job, jobId: "j1", guard: async () => "it ran since" }), { refused: "it ran since" });
		assert.ok(!refused.ops.some((op) => op[0] === "remove" || op[0] === "del" || op[0] === "srem"), JSON.stringify(hash));
		const thrown = queuedWorld({ hash });
		const boom = new Error("ECONNRESET");
		assert.deepEqual(await removeQueuedJob({ redis: thrown.redis, queue: thrown.queue, job: thrown.job, jobId: "j1", guard: async () => { throw boom; } }), { refused: null, error: boom });
		assert.ok(!thrown.ops.some((op) => op[0] === "remove" || op[0] === "del" || op[0] === "srem"), JSON.stringify(hash));
	}
	// A job not waiting to start is answered by its state before any guard is asked.
	const active = queuedWorld({ state: "active" });
	assert.deepEqual(await removeQueuedJob({ redis: active.redis, queue: active.queue, job: active.job, jobId: "j1", guard: asked(active.ops) }), { notQueued: true, state: "active" });
	assert.ok(!active.ops.some((op) => op[0] === "guard"));
});

test("removeQueuedJob: a job in each waiting state is removed, then its defer record; the hash without a clock is no hold", async () => {
	for (const state of QUEUED_STATES) {
		const { ops, redis, queue, job } = queuedWorld({ hash: { throttles: "2" }, state });
		const res = await removeQueuedJob({ redis, queue, job, jobId: "j1" });
		assert.deepEqual(res, { ok: true, held: false, jobId: "j1", state, attemptsMade: 0 }, state);
		assert.deepEqual(ops, [["hgetall", "wait:job:j1"], ["getState"], ["remove"], ["del", "defer:job:j1"]], state);
	}
	// The attempts it had made, for the caller's sentence; anything but a positive whole number is none.
	const ran = queuedWorld({ attemptsMade: 2 });
	assert.equal((await removeQueuedJob({ redis: ran.redis, queue: ran.queue, job: ran.job, jobId: "j1" })).attemptsMade, 2);
	for (const made of [undefined, -1, 1.5, "3"]) {
		const odd = queuedWorld({ attemptsMade: made });
		assert.equal((await removeQueuedJob({ redis: odd.redis, queue: odd.queue, job: odd.job, jobId: "j1" })).attemptsMade, 0, String(made));
	}
});

test("removeQueuedJob: a hash that cannot be read is not a hold, as the CLI has always read it", async () => {
	const { ops, redis, queue, job } = queuedWorld({ hgetallRejects: true });
	assert.deepEqual(await removeQueuedJob({ redis, queue, job, jobId: "j1" }), { ok: true, held: false, jobId: "j1", state: "delayed", attemptsMade: 0 });
	assert.ok(ops.some((op) => op[0] === "remove"));
});

test("removeQueuedJob: a job not waiting to start is left alone, its state said, and nothing is deleted", async () => {
	for (const [state, said] of [["active", "active"], ["completed", "completed"], ["failed", "failed"], ["waiting-children", "waiting-children"], [new Error("gone"), "unknown"]]) {
		const { ops, redis, queue, job } = queuedWorld({ state });
		assert.deepEqual(await removeQueuedJob({ redis, queue, job, jobId: "j1" }), { notQueued: true, state: said });
		assert.ok(!ops.some((op) => op[0] === "remove" || op[0] === "del"), said);
	}
	// No job to remove: nothing is asked of one.
	const none = queuedWorld();
	assert.deepEqual(await removeQueuedJob({ redis: none.redis, queue: none.queue, job: null, jobId: "j1" }), { notQueued: true, state: "unknown" });
});

test("removeQueuedJob: a state the caller already read is used as it is, not read again", async () => {
	const { ops, redis, queue, job } = queuedWorld({ state: "active" });
	assert.deepEqual(await removeQueuedJob({ redis, queue, job, jobId: "j1", state: "waiting" }), { ok: true, held: false, jobId: "j1", state: "waiting", attemptsMade: 0 });
	assert.ok(!ops.some((op) => op[0] === "getState"));
	const refused = queuedWorld({ state: "delayed" });
	assert.deepEqual(await removeQueuedJob({ redis: refused.redis, queue: refused.queue, job: refused.job, jobId: "j1", state: "active" }), { notQueued: true, state: "active" });
});

test("removeQueuedJob: a remove() that throws is raced, with the state read again and the throw itself, and the record stays", async () => {
	for (const after of ["active", "delayed", new Error("gone")]) {
		const { ops, redis, queue, job } = queuedWorld({ state: ["delayed", after], removeThrows: true });
		const res = await removeQueuedJob({ redis, queue, job, jobId: "j1" });
		assert.equal(res.raced, true);
		assert.equal(res.state, after instanceof Error ? "unknown" : after);
		assert.ok(res.error instanceof Error && /cannot be removed directly/.test(res.error.message));
		assert.deepEqual(Object.keys(res).sort(), ["error", "raced", "state"]);
		assert.deepEqual(ops.map((op) => op[0]), ["hgetall", "getState", "remove", "getState"], "no delete: the job is still there");
	}
});

test("removeQueuedJob: the defer record's delete is best-effort and bounded, and never costs the answer", async () => {
	for (const del of ["hang", "reject", "throw", "absent"]) {
		const { redis, queue, job } = queuedWorld({ del });
		const t0 = Date.now();
		const res = await removeQueuedJob({ redis, queue, job, jobId: "j1", timeoutMs: 30 });
		assert.ok(Date.now() - t0 < 1000, `${del}: bounded`);
		assert.deepEqual(res, { ok: true, held: false, jobId: "j1", state: "delayed", attemptsMade: 0 }, del);
	}
	// The bound's timer is cleared once the delete answers: a CLI that sets its exit code is not held open by it.
	const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	const before = timers();
	const { redis, queue, job } = queuedWorld();
	await removeQueuedJob({ redis, queue, job, jobId: "j1", timeoutMs: 60_000 });
	assert.equal(timers(), before);
});
