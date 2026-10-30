import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { approvalAudit, approvalConfigDigest, approvalRequestId, makeCheckApprovalPolicy } from "../src/approval-policy.mjs";
import { parseTriggers } from "../src/triggers.mjs";
import { APPROVAL_EXPIRED_COMMENT, APPROVAL_REVOKED_COMMENT, approvalExpiryJobId, makeApprovalRuntime } from "../src/approval-runtime.mjs";
import { makeApprovalStore, approvalDueKey, approvalTargetKey } from "../src/approval-state.mjs";

const AT = Date.parse("2026-10-28T10:00:00Z");
const clock = () => AT;
const job = (extra = {}) => ({ id: "job-1", approvalRequestId: "request-1", kind: "github", resume: true, repo: "org/repo", maxCostUsd: "1.00", target: { type: "issue", number: 649 }, gates: ["deploy:staging", "budget-raise"], gateTimeout: 1, gateBudgetRaiseUsd: "3.00", trigger: { sender: { id: 123 }, deliveryId: "delivery-1", comment: { body: "/approve" } }, ...extra });
const request = (extra = {}) => ({ requestId: "request-1", runId: "parked-1", kind: "github", repo: "org/repo", target: { type: "issue", number: 649 }, host: "host-1", configDigest: "digest", action: "budget-raise", toolCallId: "call-1", sessionKey: "session-1", state: "pending", createdAt: AT, resumeJob: job(), ...extra });
const accepted = (extra = {}) => request({ state: "decided", decision: { decisionId: "job-1", decision: "approved", text: "private reason", actor: { kind: "forge", id: "123" }, at: AT }, ...extra });

function setup({ pending = request(), checkPolicy = () => ({ ok: true, digest: "digest" }), hooks = {}, methods = {} } = {}) {
	const calls = [];
	const store = {
		async find() { calls.push("find"); return { ok: true, request: pending }; },
		async read() { return { ok: true, request: null }; },
		async decide(value) { calls.push(["decide", value]); return { ok: true, request: accepted({ decision: { ...value, at: AT } }) }; },
		async claim(value) { calls.push(["claim", value]); return { ok: true, request: accepted() }; },
		async publish(value) { calls.push(["publish", value]); return { ok: true, request: { ...value, state: "pending" } }; },
		async cancel(value) { calls.push(["cancel", value]); return { ok: true, request: accepted({ state: "finished", decision: { decisionId: "revocation-request-1", decision: "declined", actor: { kind: "system", id: "revocation" }, text: "", at: AT } }) }; },
		...methods,
	};
	return { calls, store, runtime: makeApprovalRuntime({ store, checkPolicy, now: clock, host: "host-1", ...hooks }) };
}

test("no active request leaves ordinary parked behavior alone, but explicit stale IDs refuse", async () => {
	const { runtime } = setup({ pending: null });
	assert.deepEqual(await runtime.before(job({ approvalRequestId: undefined, parkedReply: true, gates: undefined, gateTimeout: undefined, gateBudgetRaiseUsd: undefined })), { ok: true });
	assert.deepEqual(await runtime.before(job({ approvalRequestId: "stale" })), { refused: "approval-request-stale" });
});

test("initial gated runs validate queued configuration and the current policy before spending", async () => {
	const changed = setup({ pending: null, checkPolicy: () => ({ refused: "approval-policy-changed" }) });
	assert.deepEqual(await changed.runtime.before(job({ approvalRequestId: undefined })), { refused: "approval-policy-changed" });
	const valid = setup({ pending: null });
	assert.equal((await valid.runtime.before(job({ approvalRequestId: undefined }))).ok, true);
	for (const extra of [{ gates: ["push"] }, { resume: false }, { gates: ["budget-raise"], gateBudgetRaiseUsd: "0.01" }, { gateTimeout: 0 }, { recover: true }]) {
		const { runtime, calls } = setup({ pending: null });
		assert.deepEqual(await runtime.before(job({ ...extra, approvalRequestId: undefined })), { refused: "approval-config-invalid" });
		assert.deepEqual(calls, ["find"]);
	}
});

test("free host, policy, identity and noncomment refusals never decide or claim", async () => {
	for (const [options, input, reason] of [
		[{ pending: request({ host: "elsewhere" }) }, job(), "approval-host-mismatch"],
		[{}, job({ approvalRequestId: "old" }), "approval-request-stale"],
		[{}, job({ approvalRequestId: undefined }), "approval-request-unbound"],
		[{ checkPolicy: () => ({ ok: true, digest: "changed" }) }, job(), "approval-policy-changed"],
		[{ checkPolicy: () => ({ refused: "approval-policy-changed" }) }, job(), "approval-policy-changed"],
		[{}, job({ trigger: {} }), "approval-pending"],
		[{}, job({ trigger: { comment: { body: "/approve" } } }), "approval-author-missing"],
		[{}, job({ id: undefined }), "approval-job-id-missing"],
	]) {
		const { runtime, calls } = setup(options);
		assert.equal((await runtime.before(input)).refused, reason);
		assert.deepEqual(calls, reason === "approval-policy-changed" ? ["find", ["cancel", { requestId: "request-1", jobId: "job-1" }]] : ["find"]);
	}
});

test("approved budget decision uses the private canonical result and an audit without text", async () => {
	const { runtime, calls } = setup();
	const out = await runtime.before(job());
	assert.equal(out.ok, true);
	assert.equal(out.budgetCapUsd, "3.00");
	assert.deepEqual(out.decision, { requestId: "request-1", action: "budget-raise", toolCallId: "call-1", decision: "approved", text: "private reason" });
	assert.deepEqual(out.audit, approvalAudit(accepted()));
	assert.equal(JSON.stringify(out.audit).includes("private reason"), false);
	assert.equal(calls[1][1].decision, "approved");
	assert.deepEqual(calls[2], ["claim", { requestId: "request-1", jobId: "job-1" }]);
});

test("forge replies with the configured trigger phrase still parse typed decisions", async () => {
	const { runtime, calls } = setup();
	await runtime.before(job({ trigger: { sender: { id: 123 }, matched: { phrase: "@pi" }, comment: { body: "@pi /approve" } } }));
	assert.equal(calls.find((call) => call[0] === "decide")[1].decision, "approved");
});

test("declines and questions cannot elevate the cap, and a failed claim never grants a decision", async () => {
	for (const decision of ["declined", "question"]) {
		const { runtime } = setup({ methods: { async claim() { return { ok: true, request: accepted({ decision: { ...accepted().decision, decision } }) }; } } });
		const out = await runtime.before(job());
		assert.equal(out.decision.decision, decision);
		assert.equal("budgetCapUsd" in out, false);
	}
	const { runtime } = setup({ methods: { async claim() { return { refused: "not-decided" }; } } });
	assert.deepEqual(await runtime.before(job()), { refused: "approval-state-conflict" });
});

test("only a bound synthetic job consumes an immutable system expiry decision", async () => {
	const expired = accepted({ decision: { ...accepted().decision, decision: "declined", actor: { kind: "system", id: "expiry" } } });
	const { runtime, calls } = setup({ pending: expired, methods: { async claim() { return { ok: true, request: expired }; } } });
	assert.deepEqual(await runtime.before(job()), { refused: "approval-expired" });
	const out = await runtime.before(job({ id: approvalExpiryJobId("request-1"), approvalRequestId: "request-1", trigger: { deliveryId: "expiry-request-1" } }));
	assert.equal(out.decision.decision, "declined");
	assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "decide"), false);
	const plain = setup();
	assert.deepEqual(await plain.runtime.before(job({ id: approvalExpiryJobId("request-1"), approvalRequestId: "request-1", trigger: { deliveryId: "expiry-request-1" } })), { refused: "approval-expiry-invalid" });
});

test("the human losing the deadline race cannot consume the system decline", async () => {
	const { runtime, calls } = setup({ methods: { async decide() { return { ok: true, request: accepted({ decision: { ...accepted().decision, decision: "declined", actor: { kind: "system", id: "expiry" } } }) }; } } });
	assert.deepEqual(await runtime.before(job()), { refused: "approval-expired" });
	assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "claim"), false);
});

test("parking publishes bound metadata without the model summary and strips effective-only fields", async () => {
	const { runtime, calls } = setup();
	const out = await runtime.afterPark({ job: job({ maxCostMicros: 123 }), session: { key: "session-1" }, metadata: { action: "budget-raise", toolCallId: "call-1", summary: "private summary" } });
	const value = calls.find((call) => call[0] === "publish")[1];
	assert.equal(value.requestId, approvalRequestId("job-1", "call-1"));
	assert.equal(value.expiresAt, AT + 86400_000);
	assert.equal(value.sessionKey, "session-1");
	assert.equal(value.resumeJob.id, undefined);
	assert.equal(value.resumeJob.maxCostMicros, undefined);
	assert.equal(JSON.stringify(value).includes("private summary"), false);
	assert.equal(out.audit.requestId, value.requestId);
});

test("parking retry reuses the durable request instead of moving its deadline", async () => {
	const prior = request({ requestId: approvalRequestId("job-1", "call-1"), runId: "job-1" });
	const { runtime, calls } = setup({ methods: { async read() { return { ok: true, request: prior }; } } });
	const out = await runtime.afterPark({ job: job(), session: { key: "session-1" }, metadata: { action: "budget-raise", toolCallId: "call-1" } });
	assert.deepEqual(out.request, prior);
	assert.equal(calls.length, 0);
});

test("expiry enqueue faults are loud and retry the same durable decline", async () => {
	const expired = accepted({ decision: { ...accepted().decision, decision: "declined", actor: { kind: "system", id: "expiry" } } });
	let attempts = 0;
	const comments = [];
	const { runtime } = setup({ methods: {
		async due() { return { ok: true, requestIds: ["request-1"] }; },
		async read() { return { ok: true, request: expired }; },
		async expire() { return { ok: true, request: expired }; },
	}, hooks: {
		async enqueueExpiry(r) { assert.equal(r.requestId, "request-1"); if (++attempts === 1) throw new Error("offline"); return { ok: true }; },
		async comment(r, text) { comments.push([r.requestId, text]); },
	} });
	assert.equal((await runtime.sweep()).ok, false);
	assert.deepEqual(await runtime.sweep(), { ok: true, enqueued: 1, failures: [] });
	assert.deepEqual(comments, [["request-1", APPROVAL_EXPIRED_COMMENT]]);
});

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("approval-runtime tests REQUIRE VALKEY_TEST_URL");
const live = url ? false : "VALKEY_TEST_URL not set; durable orchestration needs real Valkey";

test("durable park, restart, approved resume and another park reject replies bound to the old request", { skip: live }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	// The suite never flushes database 0; unique request/target keys and exact cleanup keep concurrent tests apart.
	const liveUrl = new URL(url);
	liveUrl.pathname = "/0";
	const redis = makeRedisClient(liveUrl.toString());
	redis.on("error", () => {});
	const root = job({ id: `approval-runtime-test-${randomBytes(12).toString("hex")}`, approvalRequestId: undefined });
	root.repo = `org/${root.id}`;
	const requestIds = [];
	t.after(async () => {
		for (const id of requestIds) { await redis.del(`run:approval:request:${id}`); await redis.zrem("run:approval:due", id); await redis.zrem(approvalDueKey("host-1"), id); }
		await redis.del(approvalTargetKey(root));
		await redis.quit();
	});
	const runtime = () => makeApprovalRuntime({ store: makeApprovalStore({ redis, now: clock }), now: clock, host: "host-1", checkPolicy: (j) => ({ ok: true, digest: approvalConfigDigest(j) }) });
	const parked = await runtime().afterPark({ job: root, session: { key: "saved-session" }, metadata: { action: "budget-raise", toolCallId: "gate-1" } });
	assert.equal(parked.ok, true);
	requestIds.push(parked.request.requestId);
	const reply = { ...root, id: `${root.id}-reply`, approvalRequestId: parked.request.requestId };
	const approved = await runtime().before(reply);
	assert.equal(approved.ok, true);
	assert.equal(approved.budgetCapUsd, "3.00");
	assert.equal(approved.decision.toolCallId, "gate-1");
	assert.deepEqual(await runtime().before(reply), approved, "a retry after process restart sees the canonical decision");
	assert.equal((await runtime().before({ ...reply, gateBudgetRaiseUsd: "9.00" })).refused, "approval-policy-changed");
	assert.equal((await runtime().finish({ requestId: parked.request.requestId, jobId: reply.id })).ok, true);
	const next = await runtime().afterPark({ job: reply, session: { key: "saved-session" }, metadata: { action: "deploy:staging", toolCallId: "gate-2" } });
	assert.equal(next.ok, true);
	requestIds.push(next.request.requestId);
	assert.deepEqual(await runtime().before(reply), { refused: "approval-request-stale" });
	assert.deepEqual(await runtime().before({ ...reply, id: `${root.id}-unbound`, approvalRequestId: undefined }), { refused: "approval-request-unbound" });
	assert.equal((await makeApprovalStore({ redis, now: clock }).read(next.request.requestId)).request.state, "pending");
});


test("parking carries the configured host queue while a single-host deployment leaves routing absent", async () => {
	for (const hostQueue of [null, "pi-jobs@host-1"]) {
		const { runtime, calls } = setup({ hooks: { hostQueue } });
		const out = await runtime.afterPark({ job: job(), session: { key: "session-1" }, metadata: { action: "budget-raise", toolCallId: "call-1" } });
		assert.ok(out.audit);
		const published = calls.find((call) => Array.isArray(call) && call[0] === "publish")[1];
		assert.equal(published.hostQueue, hostQueue ?? undefined);
	}
});

test("the wired runtime requires transcript generation binding both when publishing and when granting a decision", async () => {
	const missing = setup({ hooks: { requireSessionDigest: true } });
	assert.deepEqual(await missing.runtime.before(job()), { refused: "approval-session-unavailable" });
	assert.equal(missing.calls.some((call) => call[0] === "decide"), false);
	assert.deepEqual(await missing.runtime.afterPark({ job: job(), session: { key: "session-1" }, metadata: { action: "budget-raise", toolCallId: "call-1" } }), { refused: "approval-session-unavailable" });
	const present = setup({ hooks: { requireSessionDigest: true } });
	const out = await present.runtime.afterPark({ job: job(), session: { key: "session-1", digest: "a".repeat(64) }, metadata: { action: "budget-raise", toolCallId: "call-1" } });
	assert.equal(out.ok, true);
	assert.equal(present.calls.find((call) => call[0] === "publish")[1].sessionDigest, "a".repeat(64));
});

test("a bound reply retires revoked policy without returning a runnable decision; unavailable policy stays pending", async () => {
	const changed = setup({ checkPolicy: () => ({ refused: "approval-policy-changed" }) });
	const out = await changed.runtime.before(job());
	assert.equal(out.refused, "approval-policy-changed");
	assert.equal(out.request.state, "finished");
	assert.equal(out.audit.actorId, "revocation");
	assert.equal(out.decision, undefined);
	assert.equal(out.budgetCapUsd, undefined);
	assert.deepEqual(changed.calls, ["find", ["cancel", { requestId: "request-1", jobId: "job-1" }]]);
	const unknown = setup({ checkPolicy: () => ({ refused: "approval-policy-unavailable" }) });
	assert.deepEqual(await unknown.runtime.before(job()), { refused: "approval-policy-unavailable" });
	assert.deepEqual(unknown.calls, ["find"]);
	const unbound = setup({ checkPolicy: () => ({ refused: "approval-policy-changed" }) });
	assert.deepEqual(await unbound.runtime.before(job({ approvalRequestId: undefined })), { refused: "approval-request-unbound" });
	assert.deepEqual(unbound.calls, ["find"], "an older unbound queue entry cannot cancel a newer request");
});

test("expiry withdraws revoked policy without enqueuing; unavailable policy remains retryable", async () => {
	for (const reason of ["approval-policy-changed", "approval-policy-unavailable"]) {
		const comments = [];
		let cancelled = 0;
		let enqueued = 0;
		const { runtime } = setup({
			checkPolicy: () => ({ refused: reason }),
			methods: {
				async due(limit, host) { assert.equal(host, "host-1"); return { ok: true, requestIds: ["request-1"] }; },
				async read() { return { ok: true, request: request() }; },
				async cancel() { cancelled++; return { ok: true, request: accepted({ state: "finished" }) }; },
				async expire() { throw new Error("revoked or unknown policy must not expire into a runnable job"); },
			},
			hooks: { async enqueueExpiry() { enqueued++; }, async comment(r, text) { comments.push(text); } },
		});
		const out = await runtime.sweep();
		assert.equal(enqueued, 0);
		assert.equal(cancelled, reason === "approval-policy-changed" ? 1 : 0);
		assert.equal(out.ok, reason === "approval-policy-changed");
		assert.deepEqual(comments, reason === "approval-policy-changed" ? [APPROVAL_REVOKED_COMMENT] : []);
	}
});

test("a valid comment reply cannot approve a timeless request after its initiating label declaration is withdrawn", { skip: live }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const liveUrl = new URL(url);
	liveUrl.pathname = "/0";
	const redis = makeRedisClient(liveUrl.toString());
	redis.on("error", () => {});
	const records = [];
	t.after(async () => {
		for (const r of records) {
			await redis.del(`run:approval:request:${r.requestId}`, approvalTargetKey(r));
			await redis.zrem("run:approval:due", r.requestId);
			await redis.zrem(approvalDueKey(r.host), r.requestId);
		}
		await redis.quit();
	});
	for (const state of ["unchanged", "removed", "changed"]) {
		const id = `approval-source-${randomBytes(12).toString("hex")}`;
		const run = { kind: "github", flow: "fix", resume: true, gates: ["deploy:staging"] };
		const label = { on: { type: "label", any: ["pi:fix"] }, run };
		const comment = { on: { type: "comment", phrase: "@pi" }, run };
		let text = JSON.stringify({ triggers: [label, comment] });
		const checkPolicy = makeCheckApprovalPolicy({ triggersPath: "/triggers.json", parseTriggers, fs: { readFileSync: () => text } });
		const original = { ...run, id, repo: `org/${id}`, target: { type: "issue", number: 649 }, trigger: { matched: { index: 0, type: "label" } } };
		const actualStore = makeApprovalStore({ redis, now: clock });
		let decisions = 0;
		const store = { ...actualStore, async decide(value) { decisions++; return actualStore.decide(value); } };
		const runtime = makeApprovalRuntime({ store, checkPolicy, host: "host-1", now: clock });
		const parked = await runtime.afterPark({ job: original, session: { key: "saved-session" }, metadata: { action: "deploy:staging", toolCallId: "source-call" } });
		assert.equal(parked.ok, true);
		records.push(parked.request);
		assert.equal(parked.request.expiresAt, undefined, "the request cannot depend on a timeout sweep to notice withdrawal");
		const reply = { ...original, id: `${id}-reply`, approvalRequestId: parked.request.requestId, trigger: { sender: { id: 123 }, matched: { index: 1, type: "comment", phrase: "@pi" }, comment: { body: "/approve" } } };
		if (state !== "unchanged") text = JSON.stringify({ triggers: [{ ...label, run: { ...run, gates: state === "removed" ? undefined : ["deploy:production"] } }, comment] });
		assert.equal(checkPolicy(reply).ok, true, "the independent comment declaration is still unchanged and valid");
		const out = await runtime.before(reply);
		if (state === "unchanged") {
			assert.equal(out.ok, true);
			assert.equal(out.decision.decision, "approved");
			assert.equal(decisions, 1);
		} else {
			assert.equal(out.refused, "approval-policy-changed");
			assert.equal(out.decision, undefined);
			assert.equal(decisions, 0, "no approval was accepted and no continuation authority was returned");
			assert.equal((await actualStore.read(parked.request.requestId)).request.state, "finished");
			assert.equal((await actualStore.find(original)).request, null);
		}
	}
});

test("accepted human approval decisions are touches even when the later continuation cannot claim, system expiry is not", async () => {
	const writes = [];
	const { runtime } = setup({ hooks: { touchStore: { write: async (e) => { writes.push(e); return { ok: true }; } } }, methods: { async claim() { return { refused: "claim-conflict" }; } } });
	await runtime.before(job());
	assert.equal(writes.length, 1);
	assert.equal(writes[0].runId, "parked-1");
	assert.equal(writes[0].cause, "approval-decision");
	assert.equal(writes[0].at, AT);
	assert.ok(!JSON.stringify(writes).includes("private reason"));
	writes.length = 0;
	const system = accepted({ decision: { ...accepted().decision, actor: { kind: "system", id: "expiry" }, decision: "declined" } });
	const expired = setup({ pending: system, hooks: { touchStore: { write: async (e) => writes.push(e) } } });
	assert.equal((await expired.runtime.before(job())).refused, "approval-expired");
	assert.equal(writes.length, 0);
});
