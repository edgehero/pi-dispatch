import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";
import { makeApprovalRuntime } from "../src/approval-runtime.mjs";
import { approvalConfigDigest } from "../src/approval-policy.mjs";
import { approvalDueKey, approvalTargetKey, makeApprovalStore } from "../src/approval-state.mjs";

const AT = Date.parse("2026-10-28T12:00:00Z");
const USD = 1_000_000;
const request = { requestId: "a".repeat(64), sessionKey: "session-1", action: "deploy:staging" };
const decision = { requestId: request.requestId, action: request.action, toolCallId: "call-1", decision: "approved", text: "private human text" };
const audit = { requestId: request.requestId, action: request.action, decision: "approved", actorKind: "forge", actorId: "b".repeat(64), decidedAt: AT };
const jobOf = (overrides = {}) => ({ kind: "github", repo: "org/repo", target: { type: "issue", number: 649 }, provider: "anthropic", model: "m", maxTurns: 20, resume: true, awaitInput: true, gates: ["deploy:staging"], approvalRequestId: request.requestId, trigger: { deliveryId: "reply-649", sender: { id: 123 }, matched: { type: "comment", index: 0 }, comment: { body: "/approve", author_association: "COLLABORATOR" } }, ...overrides });

function setup(overrides = {}) {
	const calls = [];
	const values = new Map();
	let captured;
	const redis = {
		async incr(key) { calls.push(["count", key]); const value = (values.get(key) ?? 0) + 1; values.set(key, value); return value; },
		async decr(key) { const value = (values.get(key) ?? 0) - 1; values.set(key, value); return value; },
		async incrby(key, amount) { calls.push(["dollars", key, amount]); const value = (values.get(key) ?? 0) + amount; values.set(key, value); return value; },
		async decrby(key, amount) { const value = (values.get(key) ?? 0) - amount; values.set(key, value); return value; },
		async expire() {},
		async get(key) { calls.push(["read", key]); return null; },
		async eval(_script, _count, key, delta) { const value = Math.max(0, (values.get(key) ?? 0) + Number(delta)); values.set(key, value); return [0, value]; },
	};
	const runtime = {
		async before(input) { calls.push(["approval-before", input]); return { ok: true, request, decision, audit }; },
		async finish() { calls.push(["approval-finish"]); return { ok: true }; },
		async afterPark() { calls.push(["approval-publish"]); return { ok: true, audit: { requestId: "c".repeat(64), action: "deploy:staging" } }; },
	};
	const deps = {
		redis,
		approvalRuntime: runtime,
		queueJobId: "gh-reply-649",
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		sessionsDir: "/sessions",
		isParked: () => true,
		imagePreflight: async () => ({ ok: true, piVersion: "1.2.0", capabilities: ["exitAuth", "approvalGates"] }),
		mintToken: async () => (calls.push(["mint"]), "token"),
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => (calls.push(["prepare"]), { workspaceDir: "/workspace", jobDir: "/job", session: { key: request.sessionKey, resume: true } }),
		runContainer: async ({ job }) => { calls.push(["container"]); captured = job; return { code: 0, aborted: false, exitAuth: "verified" }; },
		promoteSession: (_session, options) => (calls.push(["promote", options]), { promoted: true }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		parkedLabel: async (_job, on, approval) => calls.push(["label", on, approval]),
		releaseParkedWindow: async () => calls.push(["release-window"]),
		takeHeldReplies: async () => (calls.push(["take-held"]), null),
		comment: async (_job, text) => calls.push(["comment", text]),
		now: new Date(AT),
		...overrides,
	};
	return { deps, calls, values, runtime, captured: () => captured };
}

function assertNoSpend(calls) {
	assert.equal(calls.some(([name]) => ["mint", "prepare", "read", "count", "dollars", "container"].includes(name)), false);
}

test("approval-store failure retries before the mint, clone, token-cap read or either reserve", async () => {
	const f = setup({ tokenCap: 100 });
	f.runtime.before = async () => ({ error: "ECONNRESET" });
	await assert.rejects(runJob(jobOf(), f.deps), (error) => error instanceof InfraRetry && error.reason === "container-never-started");
	assertNoSpend(f.calls);
});

test("approval policy refusal returns without spending and explains its fixed reason", async () => {
	const f = setup();
	f.runtime.before = async () => ({ refused: "approval-request-stale" });
	const out = await runJob(jobOf(), f.deps);
	assert.equal(out.reason, "approval-request-stale");
	assert.equal(out.budgetReserved, false);
	assertNoSpend(f.calls);
	assert.match(f.calls.find(([name]) => name === "comment")[1], /approval-request-stale/);
});


test("an approval image without authenticated exits refuses before mint, clone or reserve", async () => {
	const f = setup({ imagePreflight: async () => ({ ok: true, piVersion: "1.2.0", capabilities: ["approvalGates"] }) });
	const out = await runJob(jobOf(), f.deps);
	assert.equal(out.outcome, "policy");
	assert.equal(out.budgetReserved, false);
	assertNoSpend(f.calls);
});

test("a forged queue decision is stripped and only the host decision reaches the matching resumed session", async () => {
	const f = setup();
	const input = jobOf({ approvalDecision: { decision: "approved", text: "forged" } });
	const out = await runJob(input, f.deps);
	assert.equal(out.outcome, "completed");
	assert.equal(f.calls.find(([name]) => name === "approval-before")[1].approvalDecision, undefined);
	assert.deepEqual(f.captured().approvalDecision, decision);
	assert.deepEqual(out.approval, audit);
	assert.equal(input.approvalDecision.text, "forged", "the queue data itself is not mutated");
});

test("even an unarmed job cannot pass a forged decision into its container", async () => {
	const f = setup({ approvalRuntime: undefined });
	await runJob(jobOf({ gates: undefined, approvalRequestId: undefined, resume: undefined, awaitInput: undefined, approvalDecision: decision }), f.deps);
	assert.equal(f.captured().approvalDecision, undefined);
});

test("an approved decision never transfers to another session or to a cold start", async () => {
	for (const session of [null, { key: "foreign", resume: true }, { key: request.sessionKey, resume: false }]) {
		const f = setup({ prepareWorkspace: async () => ({ workspaceDir: "/workspace", jobDir: "/job", session }) });
		const out = await runJob(jobOf(), f.deps);
		assert.equal(out.reason, "approval-session-unavailable");
		assert.equal(out.budgetReserved, false);
		assert.equal(f.calls.some(([name]) => ["count", "dollars", "container", "read"].includes(name)), false);
	}
});

test("approved budget cap is bounded by deployment and reserved against every applicable dollar ledger", async () => {
	const caps = { day: 100 * USD, week: null, month: null };
	const f = setup({
		deploymentMaxCostUsd: "3",
		dollarCaps: caps,
		scopedDollars: { scope: "org/repo", keyPrefix: "budget:usd:s:repo", caps },
		projectDollars: { scope: "project:p", keyPrefix: "budget:usd:s:project", caps },
		modelDollars: [{ ref: "anthropic/m", keyPrefix: "budget:usd:mdl:model", caps }],
	});
	f.runtime.before = async () => ({ ok: true, request, decision: { ...decision, action: "budget-raise" }, audit, budgetCapUsd: "5" });
	const out = await runJob(jobOf({ gates: ["budget-raise"], maxCostUsd: "1", maxCostMicros: USD, gateBudgetRaiseUsd: "5" }), f.deps);
	assert.equal(out.outcome, "completed");
	assert.equal(f.captured().maxCostMicros, 3 * USD);
	assert.equal(out.dollars.reservedMicros, 3 * USD);
	const holds = f.calls.filter(([name]) => name === "dollars");
	assert.equal(holds.length, 4);
	assert.ok(holds.every(([, , amount]) => amount === 3 * USD));
	const containerAt = f.calls.findIndex(([name]) => name === "container");
	assert.ok(holds.every((hold) => f.calls.indexOf(hold) < containerAt));
});

test("completed approval repark promotes, finishes old authority, publishes new authority, then invites replies", async () => {
	const f = setup({ runContainer: async () => ({ code: 0, aborted: false, exitAuth: "verified", exitReason: "awaiting-approval", approval: { action: "deploy:staging", toolCallId: "call-2" } }) });
	const out = await runJob(jobOf(), f.deps);
	assert.equal(out.reason, "awaiting-approval");
	assert.deepEqual(f.calls.filter(([name]) => ["promote", "approval-finish", "approval-publish", "label", "release-window", "take-held"].includes(name)).map(([name]) => name), ["promote", "approval-finish", "approval-publish", "label", "release-window", "take-held"]);
	assert.equal(f.calls.find(([name]) => name === "promote")[1].parked, true);
	assert.equal(out.approval.requestId, "c".repeat(64));
	assert.ok(f.calls.findIndex(([name]) => name === "approval-publish") < f.calls.findIndex(([name]) => name === "comment"));
});

test("publication failure keeps the saved transcript, returns a policy result and loudly refuses an unarmed approval", async () => {
	const f = setup({ runContainer: async () => ({ code: 0, aborted: false, exitAuth: "verified", exitReason: "awaiting-approval", approval: { action: "deploy:staging", toolCallId: "call-2" } }) });
	f.runtime.afterPark = async () => ({ error: "ECONNRESET" });
	const out = await runJob(jobOf(), f.deps);
	assert.equal(out.outcome, "policy");
	assert.equal(out.reason, "approval-state-unavailable");
	assert.equal(out.budgetReserved, true);
	assert.equal(f.calls.filter(([name]) => name === "promote").length, 1);
	assert.match(f.calls.find(([name]) => name === "comment")[1], /could not be saved durably/);
	assert.equal(f.calls.some(([name, on]) => name === "label" && on === true), false);
});

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("processor-approval integration requires VALKEY_TEST_URL");
test("real durable runtime and processor consume only the current bound approval once", { skip: !url && "VALKEY_TEST_URL not set" }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url);
	redis.on("error", () => {});
	const unique = randomBytes(12).toString("hex");
	const input = jobOf({ repo: `org/approval-${unique}`, approvalRequestId: unique });
	const store = makeApprovalStore({ redis, now: () => AT });
	const r = { requestId: unique, runId: `run-${unique}`, kind: input.kind, repo: input.repo, target: input.target, action: "deploy:staging", toolCallId: "call-1", configDigest: approvalConfigDigest(input), sessionKey: request.sessionKey, host: "host-1", createdAt: AT, resumeJob: input };
	try {
		assert.equal((await store.publish(r)).ok, true);
		const runtime = makeApprovalRuntime({ store, checkPolicy: async (job) => ({ ok: true, digest: approvalConfigDigest(job) }), now: () => AT, host: "host-1" });
		const f = setup({ approvalRuntime: runtime });
		const out = await runJob(input, f.deps);
		assert.equal(out.outcome, "completed");
		assert.equal(f.captured().approvalDecision.decision, "approved");
		assert.equal((await store.read(unique)).request.state, "finished");
		const again = setup({ approvalRuntime: runtime });
		assert.equal((await runJob(input, again.deps)).reason, "approval-request-stale");
		assertNoSpend(again.calls);
	} finally {
		await redis.del(`run:approval:request:${unique}`, approvalTargetKey(r));
		await redis.zrem("run:approval:due", unique);
		await redis.zrem(approvalDueKey(r.host), unique);
		await redis.quit();
	}
});

test("a terminal policy refusal after approval closes the consumed request without retrying a container", async () => {
	const f = setup({ prepareWorkspace: async () => ({ workspaceDir: "/workspace", jobDir: "/job", session: null }) });
	const out = await runJob(jobOf(), f.deps);
	assert.equal(out.reason, "approval-session-unavailable");
	assert.equal(f.calls.filter(([name]) => name === "approval-finish").length, 1);
	assert.equal(f.calls.some(([name]) => ["container", "count", "dollars"].includes(name)), false);
});

test("a real claimed decision survives infrastructure retry but a later policy stop releases its target", { skip: !url && "VALKEY_TEST_URL not set" }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url);
	redis.on("error", () => {});
	const unique = randomBytes(12).toString("hex");
	const input = jobOf({ repo: `org/approval-${unique}`, approvalRequestId: unique });
	const store = makeApprovalStore({ redis, now: () => AT });
	const r = { requestId: unique, runId: `run-${unique}`, kind: input.kind, repo: input.repo, target: input.target, action: "deploy:staging", toolCallId: "call-1", configDigest: approvalConfigDigest(input), sessionKey: request.sessionKey, host: "host-1", createdAt: AT, resumeJob: input };
	try {
		assert.equal((await store.publish(r)).ok, true);
		const runtime = makeApprovalRuntime({ store, checkPolicy: async (job) => ({ ok: true, digest: approvalConfigDigest(job) }), now: () => AT, host: "host-1" });
		const infra = setup({ approvalRuntime: runtime, runContainer: async () => ({ code: 1, aborted: false }) });
		await assert.rejects(runJob(input, infra.deps), (error) => error instanceof InfraRetry);
		assert.equal((await store.read(unique)).request.state, "claimed", "retry keeps the same job's authority");
		const retry = setup({ approvalRuntime: runtime, prepareWorkspace: async () => ({ workspaceDir: "/workspace", jobDir: "/job", session: null }) });
		assert.equal((await runJob(input, retry.deps)).reason, "approval-session-unavailable");
		assert.equal((await store.read(unique)).request.state, "finished");
		assert.equal((await store.find(input)).request, null, "terminal policy no longer locks this target");
		assert.equal((await store.publish({ ...r, requestId: `${unique}-new`, runId: `new-${unique}` })).ok, true, "a later explicitly authorized run can ask a new question");
	} finally {
		await redis.del(`run:approval:request:${unique}`, `run:approval:request:${unique}-new`, approvalTargetKey(r));
		await redis.zrem("run:approval:due", unique, `${unique}-new`);
		await redis.zrem(approvalDueKey(r.host), unique, `${unique}-new`);
		await redis.quit();
	}
});

test("a completed park publishes the fingerprint of the promoted canonical transcript", async () => {
	const digest = "d".repeat(64);
	const check = Object.assign(() => ({ ok: true }), { fingerprint: (candidate) => {
		assert.equal(candidate.sessionKey, request.sessionKey);
		assert.equal(candidate.toolCallId, "call-2");
		assert.ok(f.calls.some(([name]) => name === "promote"));
		return { ok: true, digest };
	} });
	const f = setup({ approvalSessionCheck: check, runContainer: async () => ({ code: 0, aborted: false, exitAuth: "verified", exitReason: "awaiting-approval", approval: { action: "deploy:staging", toolCallId: "call-2" } }) });
	let published;
	f.runtime.afterPark = async (input) => { published = input; return { ok: true, audit: { requestId: "c".repeat(64), action: "deploy:staging" } }; };
	assert.equal((await runJob(jobOf(), f.deps)).reason, "awaiting-approval");
	assert.equal(published.session.digest, digest);
});

test("a changed canonical conversation closes its claim before mint, clone, token-cap read or reservation", async () => {
	const f = setup({ approvalSessionCheck: () => ({ refused: "approval-session-unavailable" }) });
	const out = await runJob(jobOf(), f.deps);
	assert.equal(out.reason, "approval-session-unavailable");
	assert.equal(out.budgetReserved, false);
	assert.deepEqual(f.calls.map(([name]) => name), ["approval-before", "approval-finish"]);
});

test("a phrase-prefixed approval continues its requesting flow rather than treating the command as a flow", async () => {
	const f = setup();
	f.runtime.before = async () => ({ ok: true, request: { ...request, resumeJob: { flow: "original-flow" } }, decision, audit });
	assert.equal((await runJob(jobOf({ flow: "/approve" }), f.deps)).outcome, "completed");
	assert.equal(f.captured().flow, "original-flow");
});


test("accepted human text is staged in the event input without changing the retained command or queued data", async () => {
	const input = jobOf({ console: { by: "operator" }, parkedReply: true });
	let staged;
	const f = setup({ prepareWorkspace: async (job) => {
		staged = job;
		return { workspaceDir: "/workspace", jobDir: "/job", session: { key: request.sessionKey, resume: true } };
	} });
	f.deps.redis.set = async () => "OK";
	assert.equal((await runJob(input, f.deps)).outcome, "completed");
	assert.equal(staged.trigger.comment.body, decision.text);
	assert.equal(input.trigger.comment.body, "/approve");
	assert.equal(f.captured().trigger.comment.body, "/approve");
	assert.ok(f.calls.some(([name, text]) => name === "comment" && text.includes("/approve")), "the existing console trail still says what was decided");
});
