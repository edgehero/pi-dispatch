import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSubscriptionRuntime, subscriptionIdentity, subscriptionRoutes } from "../src/subscription-runtime.mjs";

const instant = 1_800_000_000_000;
const connection = { id: "claude", connectionId: "claude", provider: "anthropic", ownerHost: "owner", adapter: "pi-anthropic-oauth@0.3.6", accountGroup: "opaque-group", generation: 2 };
const job = { provider: "anthropic", model: "sonnet", models: ["anthropic/sonnet"], maxCostMicros: 500_000 };
function fixture({ row = connection, quotaResult = { ok: true }, checkResult, stageResult } = {}) {
	const calls = [];
	const auth = {
		check: async (provider) => checkResult ?? (provider === row.provider ? { ok: true, managed: true, ...row } : { ok: true, managed: false }),
		prepareSnapshot: async () => (calls.push("refresh"), { ok: true, snapshot: { ...row, expiresAt: instant + 4_000_000, deadlineAt: instant + 1_800_000, env: { ANTHROPIC_OAUTH_TOKEN: "private-access" } } }),
		validateSnapshot: async () => true,
		status: async () => [row],
	};
	const quota = { admit: async (identity, policy) => (calls.push({ identity, policy }), quotaResult), record: async (...args) => (calls.push(args), { ok: true }), read: async () => ({ state: "unknown" }) };
	const runtime = makeSubscriptionRuntime({ auth, quota, now: () => instant, lookup: (provider) => ({ api: provider === "openai" ? "openai-responses" : "anthropic-messages", baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com" }), packageRootFor: () => stageResult ?? ({ root: "/opt/pi-global/packages/claude", digest: "a".repeat(64) }) });
	return { runtime, calls, auth };
}
test("subscription routes include every finite model and decision role exactly once", () => {
	assert.deepEqual(subscriptionRoutes({ ...job, models: [...job.models, "openai/gpt"], watchDecisionModel: { provider: "openai", id: "gpt" }, answerDecisionModel: { provider: "other", id: "small" } }), [{ provider: "anthropic", id: "sonnet" }, { provider: "openai", id: "gpt" }, { provider: "other", id: "small" }]);
});
test("candidate preview never refreshes or consumes an operator trial; selected preparation does", async () => {
	const { runtime, calls } = fixture();
	assert.equal((await runtime.check(job)).ok, true);
	assert.equal(calls[0].policy.consumeTrial, false);
	assert.equal(calls.includes("refresh"), false);
	const prepared = await runtime.prepare(job, { deadlineAt: instant + 1_800_000, attemptId: "delivery-1" });
	assert.equal(prepared.snapshots[0].env.ANTHROPIC_OAUTH_TOKEN, "private-access");
	assert.equal(calls[2].policy.consumeTrial, true);
	assert.equal(calls[2].policy.requireExtraUsageKnownDisabled, true);
	assert.deepEqual(calls[0].identity, subscriptionIdentity(connection));
});
test("weekly and unknown-reset exhaustion defer without refreshing or inference", async () => {
	for (const until of [instant + 7 * 86_400_000, null]) {
		const { runtime, calls } = fixture({ quotaResult: { ok: false, reason: "subscription-quota", until } });
		const result = await runtime.prepare(job, { deadlineAt: instant + 1_800_000 });
		assert.equal(result.wait, "subscription-quota");
		assert.equal(result.until, until ?? instant + 60_000);
		assert.equal(calls.includes("refresh"), false);
	}
});
test("an explicit binding refuses unrestricted, disabled-extension and unsupported-venue jobs", async () => {
	for (const [patch, reason] of [[{ models: null }, "auth-route-unbounded"], [{ packages: false }, "auth-adapter-disabled"], [{ backend: "openshell" }, "auth-venue-unsupported"]]) {
		const { runtime, calls } = fixture();
		assert.equal((await runtime.check({ ...job, ...patch })).reason, reason);
		assert.deepEqual(calls, []);
	}
});
test("paid overage requires an explicit positive policy ceiling and a job bound no greater than it", async () => {
	const { runtime, calls } = fixture({ row: { ...connection, extraUsageCreditMicros: 400_000 } });
	assert.equal((await runtime.check(job)).reason, "auth-credit-cap-required");
	assert.deepEqual(calls, []);
	assert.equal((await runtime.check({ ...job, maxCostMicros: 300_000 })).ok, true);
	assert.equal(calls[0].policy.maxCreditMicros, 400_000);
});
test("OpenAI subscription classifier roles refuse before any quota claim", async () => {
	const { runtime, calls } = fixture({ row: { ...connection, provider: "openai", adapter: "openai-chatgpt" } });
	const result = await runtime.check({ provider: "openai", model: "gpt", models: ["openai/gpt"], watchDecisionModel: { provider: "openai", id: "gpt" } });
	assert.equal(result.reason, "auth-capability-unsupported");
	assert.deepEqual(calls, []);
});
test("only authenticated matching terminal quota evidence can latch a connection", async () => {
	const openai = { ...connection, provider: "openai", adapter: "openai-chatgpt" };
	const { runtime, calls } = fixture({ row: openai });
	const result = { code: 1, exitLineCode: 1, exitAuth: "verified", providerFailure: { kind: "quota-exhausted", subscriptionCode: "usage_limit_reached", subscriptionProvider: "openai" } };
	for (const patch of [{ exitAuth: "unverified" }, { exitLineCode: 2 }, { aborted: true }, { providerFailure: { kind: "overloaded" } }]) await runtime.observe(job, { ...result, ...patch }, [openai]);
	assert.deepEqual(calls, []);
	await runtime.observe(job, result, [openai]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0][1].windows[0].state, "exhausted");
	assert.equal(calls[0][1].windows[0].resetAt, null);
});


test("a known staged provider conflict refuses before quota or refresh", async () => {
	const { runtime, calls } = fixture({ stageResult: { refused: "auth-adapter-conflicting" } });
	assert.equal((await runtime.check(job)).reason, "auth-adapter-conflicting");
	assert.deepEqual(calls, []);
});

test("lifecycle diagnostics map to closed actionable run-record reasons", async () => {
	for (const [code, reason] of [["auth-credential-invalid", "auth-reauth-required"], ["auth-adapter-unpinned", "auth-adapter-unavailable"], ["auth-store-permissions", "auth-store-unavailable"]]) {
		const { runtime, calls } = fixture({ checkResult: { ok: false, managed: true, reason: code, unavailable: false } });
		assert.equal((await runtime.check(job)).reason, reason);
		assert.deepEqual(calls, []);
	}
});
