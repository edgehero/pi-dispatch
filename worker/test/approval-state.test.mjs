import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { APPROVAL_FINISHED_TTL_MS, approvalDueKey, approvalTargetKey, makeApprovalStore } from "../src/approval-state.mjs";

const AT = Date.parse("2026-10-28T12:00:00Z");
const clock = () => AT;
const request = (id = "request-1") => ({ requestId: id, runId: "run-1", kind: "github", repo: "org/repo", target: { type: "issue", number: 649 }, action: "budget-raise", toolCallId: "call-1", configDigest: "abc", sessionKey: "session-1", host: "host-1", createdAt: AT, expiresAt: AT + 1000 });
const decision = (requestId, decisionId = "reply-1", value = "approved") => ({ requestId, decisionId, decision: value, actor: { kind: "forge", id: "123" }, text: "Proceed" });

test("target lookup hashes the entire forge/repository/type/number tuple", () => {
	const a = request();
	const first = approvalTargetKey(a);
	assert.match(first, /^run:approval:target:[a-f0-9]{64}$/);
	for (const changed of [{ kind: "gitlab" }, { repo: "org/other" }, { target: { type: "pull_request", number: 649 } }, { target: { type: "issue", number: 650 } }]) assert.notEqual(approvalTargetKey({ ...a, ...changed }), first);
	assert.equal(approvalTargetKey({ ...a, target: { type: "issue", number: 0 } }), null);
});

test("invalid input refuses before touching the store", async () => {
	const store = makeApprovalStore({ redis: { eval() { throw new Error("must not touch"); } }, now: clock });
	assert.deepEqual(await store.publish({ ...request(), expiresAt: AT }), { refused: "request-invalid" });
	assert.deepEqual(await store.publish({ ...request(), resumeJob: "bad" }), { refused: "request-invalid" });
	assert.deepEqual(await store.publish({ ...request(), sessionDigest: "not-a-digest" }), { refused: "request-invalid" });
	for (const hostQueue of ["pi-jobs@other", "pi-jobs", "pi-jobs@host-1:bad", 7]) assert.deepEqual(await store.publish({ ...request(), hostQueue }), { refused: "request-invalid" });
	assert.deepEqual(await store.read("bad/id"), { refused: "request-invalid" });
	assert.deepEqual(await store.decide({ ...decision("a"), actor: { kind: "system", id: "expiry" } }), { refused: "decision-invalid" });
	assert.deepEqual(await store.decide({ ...decision("a"), text: "x".repeat(8193) }), { refused: "decision-invalid" });
	assert.deepEqual(await store.claim({ requestId: "a", jobId: "bad/id" }), { refused: "job-invalid" });
	assert.deepEqual(await store.due(1001), { refused: "limit-invalid" });
});

test("infrastructure faults return only a code and never leak private values", async () => {
	const fail = () => { throw Object.assign(new Error("private text"), { code: "ECONNREFUSED" }); };
	const store = makeApprovalStore({ redis: { eval: fail, get: fail, zrangebyscore: fail }, now: clock });
	for (const operation of [() => store.publish(request()), () => store.read("a"), () => store.find(request()), () => store.decide(decision("a")), () => store.claim({ requestId: "a", jobId: "job" }), () => store.finish({ requestId: "a", jobId: "job" }), () => store.expire("a"), () => store.due()]) assert.deepEqual(await operation(), { error: "ECONNREFUSED" });
});

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("approval-state tests REQUIRE VALKEY_TEST_URL");
const skip = url ? false : "VALKEY_TEST_URL not set; atomic transitions need real Valkey";
let redis;
const ids = [];
async function setup({ now = clock } = {}) {
	if (!redis) {
		const { makeRedisClient } = await import("../src/connection.mjs");
		// Database 0 is the suite's shared never-flushed database. Every request and target is unique; cleanup
		// removes only this file's records and due-index members, so parallel queue tests keep their own keys.
		const liveUrl = new URL(url);
		liveUrl.pathname = "/0";
		redis = makeRedisClient(liveUrl.toString());
		redis.on("error", () => {});
	}
	const id = `approval-test-${randomBytes(12).toString("hex")}`;
	const r = { ...request(id), repo: `org/${id}` };
	ids.push(r);
	return { store: makeApprovalStore({ redis, now }), r };
}
test.after(async () => {
	if (!redis) return;
	for (const r of ids) {
		await redis.del(`run:approval:request:${r.requestId}`, approvalTargetKey(r));
		await redis.zrem("run:approval:due", r.requestId);
		await redis.zrem(approvalDueKey(r.host), r.requestId);
	}
	await redis.quit();
});

test("publish survives reconnection, is idempotent and protects an active target", { skip }, async () => {
	const { store, r } = await setup();
	assert.equal((await store.publish(r)).request.state, "pending");
	assert.deepEqual(await store.publish(r), await store.read(r.requestId));
	assert.deepEqual(await store.publish({ ...r, action: "deploy:staging" }), { refused: "request-conflict" });
	assert.deepEqual(await store.publish({ ...r, requestId: `${r.requestId}-other` }), { refused: "target-pending" });
	const reopened = makeApprovalStore({ redis, now: clock });
	assert.equal((await reopened.find(r)).request.requestId, r.requestId);
	assert.equal(await redis.pttl(`run:approval:request:${r.requestId}`), -1, "a deadline must not delete undecided evidence");
	assert.equal((await reopened.read("absent")).request, null);
});

test("racing decisions pick one immutable winner; duplicate delivery returns canonical text", { skip }, async () => {
	const { store, r } = await setup();
	await store.publish(r);
	const results = await Promise.all([store.decide(decision(r.requestId, "yes")), store.decide(decision(r.requestId, "no", "declined"))]);
	assert.equal(results.filter((x) => x.ok).length, 1);
	assert.equal(results.filter((x) => x.refused === "already-decided").length, 1);
	const canonical = results.find((x) => x.ok);
	const retried = await store.decide({ ...decision(r.requestId, canonical.request.decision.decisionId, "question"), text: "changed reply" });
	assert.deepEqual(retried, canonical);
});

test("claim retries remain the same job and finished requests cannot authorize later jobs", { skip }, async () => {
	const { store, r } = await setup();
	await store.publish(r);
	assert.deepEqual(await store.claim({ requestId: r.requestId, jobId: "resume-1" }), { refused: "not-decided" });
	await store.decide(decision(r.requestId));
	const claim = await store.claim({ requestId: r.requestId, jobId: "resume-1" });
	assert.equal(await redis.pttl(`run:approval:request:${r.requestId}`), -1, "claimed authority must survive until a terminal outcome");
	assert.deepEqual(await store.claim({ requestId: r.requestId, jobId: "resume-1" }), claim);
	assert.deepEqual(await store.claim({ requestId: r.requestId, jobId: "resume-2" }), { refused: "not-decided" });
	assert.deepEqual(await store.finish({ requestId: r.requestId, jobId: "resume-2" }), { refused: "not-claimed" });
	const finished = await store.finish({ requestId: r.requestId, jobId: "resume-1" });
	assert.equal(finished.request.state, "finished");
	const ttl = await redis.pttl(`run:approval:request:${r.requestId}`);
	assert.ok(ttl > 0 && ttl <= APPROVAL_FINISHED_TTL_MS, "finished evidence outlives queue retention, then expires");
	assert.equal(APPROVAL_FINISHED_TTL_MS, 32 * 86400_000);
	assert.deepEqual(await store.finish({ requestId: r.requestId, jobId: "resume-1" }), finished);
	assert.equal((await store.find(r)).request, null);
	assert.deepEqual(await store.claim({ requestId: r.requestId, jobId: "resume-2" }), { refused: "request-stale" });
});

test("expiry is a durable decline at the boundary, and races cannot approve expired requests", { skip }, async () => {
	let at = AT;
	const { store, r } = await setup({ now: () => at });
	await store.publish(r);
	assert.deepEqual(await store.expire(r.requestId), { refused: "not-expired" });
	assert.equal((await store.due()).requestIds.includes(r.requestId), false);
	at = r.expiresAt;
	assert.equal((await store.due()).requestIds.includes(r.requestId), true);
	await Promise.all([store.decide(decision(r.requestId)), store.expire(r.requestId)]);
	const state = (await store.read(r.requestId)).request;
	assert.equal(state.decision.decision, "declined");
	assert.deepEqual(state.decision.actor, { kind: "system", id: "expiry" });
	assert.equal((await store.due()).requestIds.includes(r.requestId), true, "a durable expiry remains discoverable until its resume job claims it");
	assert.deepEqual((await store.expire(r.requestId)).request, state);
	await store.claim({ requestId: r.requestId, jobId: "expiry-resume" });
	assert.equal((await store.due()).requestIds.includes(r.requestId), false);
});

test("a decision before the deadline wins over the expiry sweep; questions grant no approval", { skip }, async () => {
	let at = AT;
	const { store, r } = await setup({ now: () => at });
	await store.publish(r);
	const accepted = await store.decide(decision(r.requestId, "question", "question"));
	at = r.expiresAt + 1;
	assert.deepEqual(await store.expire(r.requestId), { refused: "already-decided" });
	assert.deepEqual(await store.read(r.requestId), accepted);
	assert.equal(accepted.request.decision.decision, "question");
});


test("the durable request retains only its matching session owner's host queue", { skip }, async () => {
	const { store, r } = await setup();
	const out = await store.publish({ ...r, hostQueue: "pi-jobs@host-1", sessionDigest: "a".repeat(64) });
	assert.equal(out.ok, true);
	assert.equal(out.request.hostQueue, "pi-jobs@host-1");
	assert.equal((await store.find(r)).request.hostQueue, "pi-jobs@host-1");
	assert.equal((await store.read(r.requestId)).request.sessionDigest, "a".repeat(64));
});

test("per-host deadlines include future work and cannot be starved by another host's older requests", { skip }, async () => {
	let at = AT;
	const own = await setup({ now: () => at });
	const foreign = await setup({ now: () => at });
	own.r.host = `${own.r.requestId}-host`;
	foreign.r.host = `${foreign.r.requestId}-host`;
	foreign.r.expiresAt = AT + 500;
	await own.store.publish(own.r);
	await foreign.store.publish(foreign.r);
	assert.deepEqual(await own.store.hasPending(own.r.host), { ok: true, pending: true });
	assert.deepEqual(await own.store.due(1, own.r.host), { ok: true, requestIds: [] });
	at = AT + 1000;
	assert.deepEqual(await own.store.due(1, own.r.host), { ok: true, requestIds: [own.r.requestId] });
	await own.store.decide(decision(own.r.requestId));
	await own.store.claim({ requestId: own.r.requestId, jobId: "expiry-job" });
	assert.deepEqual(await own.store.hasPending(own.r.host), { ok: true, pending: false });
	assert.deepEqual(await foreign.store.hasPending(foreign.r.host), { ok: true, pending: true });
});

test("host withdrawal closes pending and accepted requests, preserving an accepted decision", { skip }, async () => {
	for (const phase of ["pending", "decided", "claimed"]) {
		const { store, r } = await setup();
		await store.publish(r);
		if (phase !== "pending") await store.decide(decision(r.requestId));
		if (phase === "claimed") {
			await store.claim({ requestId: r.requestId, jobId: "owner" });
			assert.deepEqual(await store.cancel({ requestId: r.requestId, jobId: "other" }), { refused: "not-claimed" });
		}
		const closed = await store.cancel({ requestId: r.requestId, jobId: "owner" });
		assert.equal(closed.request.state, "finished");
		assert.equal(closed.request.decision.decision, phase === "pending" ? "declined" : "approved");
		if (phase === "pending") assert.deepEqual(closed.request.decision.actor, { kind: "system", id: "revocation" });
		assert.equal((await store.find(r)).request, null);
		assert.equal((await store.due(100, r.host)).requestIds.includes(r.requestId), false);
		assert.deepEqual(await store.cancel({ requestId: r.requestId, jobId: "owner" }), closed);
		assert.ok(await redis.pttl(`run:approval:request:${r.requestId}`) > 0);
	}
});

test("unknown, absent and corrupt schema versions are determinate refusals and cannot be mutated", { skip }, async () => {
	const { store, r } = await setup();
	const written = await store.publish(r);
	assert.equal(written.request.version, 1);
	assert.deepEqual(await store.publish({ ...r, version: 2 }), { refused: "request-invalid" });
	for (const raw of [JSON.stringify({ ...written.request, version: undefined }), JSON.stringify({ ...written.request, version: 2 }), "not json"]) {
		await redis.set(`run:approval:request:${r.requestId}`, raw);
		assert.deepEqual(await store.read(r.requestId), { refused: "state-invalid" });
		assert.deepEqual(await store.decide(decision(r.requestId)), { refused: "state-invalid" });
		assert.deepEqual(await store.publish(r), { refused: "state-invalid" }, "Lua must protect publish's idempotent read too");
		assert.equal(await redis.get(`run:approval:request:${r.requestId}`), raw);
	}
	await redis.set(`run:approval:request:${r.requestId}`, JSON.stringify(written.request));
	const future = JSON.stringify({ ...written.request, version: 2 });
	const raced = makeApprovalStore({ now: clock, redis: {
		get: (...args) => redis.get(...args),
		async eval(...args) {
			await redis.set(`run:approval:request:${r.requestId}`, future);
			return redis.eval(...args);
		},
	} });
	assert.deepEqual(await raced.decide(decision(r.requestId)), { refused: "state-invalid" }, "the Lua guard catches a future version substituted after the JavaScript read");
	assert.equal(await redis.get(`run:approval:request:${r.requestId}`), future);
});
