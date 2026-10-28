import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalDueKey, approvalTargetKey } from "../src/approval-state.mjs";
import { enqueueForgeJob } from "../src/queue.mjs";

const fields = () => ({ repo: "org/repo", target: { type: "issue", number: 649 }, flow: "work", resume: true, gates: ["deploy:staging"], trigger: { deliveryId: "reply-1", comment: { body: "/approve" }, sender: { id: 123 } } });
function queue(request = null) {
	if (request) request = {
		version: 1, runId: "requesting-run", kind: "github", repo: "org/repo", target: fields().target,
		action: "deploy:staging", toolCallId: "call-1", configDigest: "digest", sessionKey: "session-key", host: "host-1", createdAt: 123456,
		...(request.state !== "pending" ? { decision: { decisionId: "reply-1", decision: "approved", actor: { kind: "forge", id: "actor-id" }, text: "", at: 123457 } } : {}),
		...request,
	};
	const reads = [];
	const adds = [];
	const redis = { eval() { throw new Error("binding must only read"); }, async get(key) {
		reads.push(key);
		if (key === approvalTargetKey({ kind: "github", ...fields() })) return request?.requestId ?? null;
		return request ? JSON.stringify(request) : null;
	} };
	return { reads, adds, client: Promise.resolve(redis), async add(kind, data, options) { adds.push({ kind, data, options }); return { id: options.jobId }; } };
}

test("comment ingress binds the pending request at job level, never in trigger", async () => {
	const q = queue({ requestId: "request-1", state: "pending" });
	const input = fields();
	await enqueueForgeJob(q, "github", input);
	assert.equal(q.adds[0].data.approvalRequestId, "request-1");
	assert.equal(input.approvalRequestId, undefined, "does not mutate filter output retained as fallback");
	assert.equal(q.adds[0].data.trigger.approvalRequestId, undefined);
	assert.equal(q.reads.length, 2);
});

test("held-before-publication input remains unbound, then post-park enqueue binds the new request", async () => {
	const input = fields();
	const before = queue();
	await enqueueForgeJob(before, "github", input);
	assert.equal(before.adds[0].data.approvalRequestId, undefined);
	const after = queue({ requestId: "request-2", state: "pending" });
	await enqueueForgeJob(after, "github", input);
	assert.equal(after.adds[0].data.approvalRequestId, "request-2");
});

test("explicit preview binding survives only for the same active request", async () => {
	for (const state of ["pending", "decided", "claimed"]) {
		const q = queue({ requestId: "request-1", state });
		await enqueueForgeJob(q, "github", { ...fields(), approvalRequestId: "request-1" });
		assert.equal(q.adds[0].data.approvalRequestId, "request-1");
	}
	for (const active of [null, { requestId: "request-2", state: "pending" }]) {
		const q = queue(active);
		await assert.rejects(enqueueForgeJob(q, "github", { ...fields(), approvalRequestId: "request-1" }), { name: "TypeError", message: "approval-request-stale" });
		assert.equal(q.adds.length, 0);
	}
});

test("ordinary jobs retain their payload and do not read an approval store", async () => {
	const q = queue();
	const input = fields();
	delete input.gates;
	await enqueueForgeJob(q, "github", input);
	assert.equal(q.reads.length, 0);
	assert.equal(q.adds[0].data.approvalRequestId, undefined);
});

test("already decided requests do not bind unrelated new comments", async () => {
	const q = queue({ requestId: "request-1", state: "decided" });
	await enqueueForgeJob(q, "github", fields());
	assert.equal(q.adds[0].data.approvalRequestId, undefined);
});

test("unavailable lookup and malformed explicit bindings cannot enqueue", async () => {
	const q = queue();
	q.client = Promise.resolve({ eval() {}, get() { throw new Error("private payload"); } });
	await assert.rejects(enqueueForgeJob(q, "github", fields()), { message: "approval-state-unavailable" });
	assert.equal(q.adds.length, 0);
	await assert.rejects(enqueueForgeJob(queue(), "github", { ...fields(), approvalRequestId: "bad/id" }), { name: "TypeError", message: "approval-request-invalid" });
});

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("approval queue routing requires VALKEY_TEST_URL");
test("a bound decision goes to the session owner's host queue with both dedup layers unchanged", { skip: !url && "VALKEY_TEST_URL not set" }, async () => {
	const { randomBytes } = await import("node:crypto");
	const { makeRedisClient, parseConnection } = await import("../src/connection.mjs");
	const { makeApprovalStore } = await import("../src/approval-state.mjs");
	const { makeQueue } = await import("../src/queue.mjs");
	const id = randomBytes(12).toString("hex");
	const host = `approval-${id}`;
	const hostQueue = `pi-jobs@${host}`;
	const source = makeQueue(parseConnection(url), { name: `approval-shared-${id}` });
	const owner = makeQueue(parseConnection(url), { name: hostQueue });
	const redis = makeRedisClient(url);
	redis.on("error", () => {});
	const store = makeApprovalStore({ redis, now: () => 123456 });
	const input = { ...fields(), repo: `org/${id}` };
	const r = { requestId: id, runId: `run-${id}`, kind: "github", repo: input.repo, target: input.target, action: "deploy:staging", toolCallId: "call-1", configDigest: "digest", sessionKey: "session-1", host, hostQueue, createdAt: 123456 };
	try {
		assert.equal((await store.publish(r)).ok, true);
		const first = await enqueueForgeJob(source, "github", input);
		assert.equal(first.queue, hostQueue);
		assert.equal(await source.getJob(first.jobId), undefined, "the shared queue must never receive this paid continuation");
		const queued = await owner.getJob(first.jobId);
		assert.ok(queued);
		assert.equal(queued.data.approvalRequestId, id);
		assert.equal(queued.opts.attempts, 2);
		assert.equal(queued.opts.removeOnComplete.age, 31 * 86400);
		const replay = await enqueueForgeJob(source, "github", input);
		assert.equal(replay.jobId, first.jobId, "delivery ID dedup remains stable across routed handles");
		const duplicate = await enqueueForgeJob(source, "github", { ...input, trigger: { ...input.trigger, deliveryId: "second-delivery" } });
		assert.equal(duplicate.deduplicated, true);
		assert.equal(duplicate.survivingJobId, first.jobId);
		assert.equal(duplicate.queue, hostQueue);
		assert.equal(await owner.getWaitingCount(), 1);
		assert.equal(await source.getWaitingCount(), 0, "the caller's queue remains open and usable");
		const alreadyOnOwner = await enqueueForgeJob(owner, "github", input);
		assert.equal(alreadyOnOwner.queue, undefined, "only an actual redirect adds a queue result field");
		assert.equal(await owner.getWaitingCount(), 1, "an already selected owner queue is not closed");
	} finally {
		await source.obliterate({ force: true }).catch(() => {});
		await owner.obliterate({ force: true }).catch(() => {});
		await Promise.all([source.close(), owner.close()]);
		await redis.del(`run:approval:request:${id}`, approvalTargetKey(r));
		await redis.zrem("run:approval:due", id);
		await redis.zrem(approvalDueKey(r.host), id);
		await redis.quit();
	}
});
