import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSubscriptionRuntime, subscriptionIdentity, subscriptionRoutes, subscriptionBindingDigest } from "../src/subscription-runtime.mjs";

import { makeSubscriptionQuotaStore, normalizeSubscriptionQuotaError } from "../src/subscription-quota.mjs";

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

test("current generation copies only the same route with exactly the existing lease", async () => {
	const { runtime, auth, calls } = fixture();
	const snapshot = { ...connection, bindingSignature: "bound", deadlineAt: instant + 20 * 60_000, renewable: true };
	let patch = { generation: 3 };
	auth.readSnapshot = async (_provider, options) => {
		assert.equal(options.deadlineAt, snapshot.deadlineAt);
		return { ok: true, snapshot: { ...snapshot, ...patch } };
	};
	assert.equal((await runtime.current(snapshot)).generation, 3);
	for (const bad of [{ generation: 2 }, { provider: "openai" }, { connectionId: "other" }, { bindingSignature: "other" }, { adapter: "other" }, { accountGroup: "other" }, { deadlineAt: snapshot.deadlineAt + 1 }, { deadlineAt: snapshot.deadlineAt - 1 }]) {
		patch = { generation: 3, ...bad };
		assert.equal(await runtime.current(snapshot), null, JSON.stringify(bad));
	}
	assert.deepEqual(calls, [], "neither quota admission nor refresh is invoked");
});
test("subscription routes include every finite model and decision role exactly once", () => {
	assert.deepEqual(subscriptionRoutes({ ...job, models: [...job.models, "openai/gpt"], watchDecisionModel: { provider: "openai", id: "gpt" }, answerDecisionModel: { provider: "other", id: "small" } }), [{ provider: "anthropic", id: "sonnet" }, { provider: "openai", id: "gpt" }, { provider: "other", id: "small" }]);
});

test("whole-pool policy inspection classifies exhausted and unavailable routes without quota, trial or refresh calls", async () => {
	for (const models of [["anthropic/sonnet", "openai/gpt"], ["openai/gpt", "anthropic/sonnet"]]) {
		const { runtime, calls } = fixture({ quotaResult: { ok: false, reason: "subscription-quota", until: instant + 100_000 } });
		assert.equal((await runtime.inspectPolicy({ models })).reason, "auth-mixed-billing");
		assert.deepEqual(calls, []);
	}
	const { runtime, calls } = fixture({ checkResult: { ok: false, managed: true, reason: "auth-store-unavailable", unavailable: true } });
	assert.equal((await runtime.inspectPolicy(job)).unavailable, true);
	assert.deepEqual(calls, []);
});

test("random selected billing/account binding survives preparation while ordinary credential refresh remains valid", async () => {
	const { runtime, auth, calls } = fixture();
	const binding = subscriptionBindingDigest(connection);
	const selected = { ...job, modelSelection: { strategy: "random", candidates: job.models }, modelSelectionBilling: "subscription", modelSelectionBinding: binding };
	assert.equal(subscriptionBindingDigest({ ...connection, generation: connection.generation + 1 }), binding);
	assert.notEqual(subscriptionBindingDigest({ ...connection, accountGroup: "another" }), binding);
	auth.check = async (_provider, request) => { assert.equal(request.readOnly, true); return { ok: true, managed: true, ...connection }; };
	assert.equal((await runtime.inspectPolicy(selected)).bindings["anthropic/sonnet"], binding);
	auth.check = async () => ({ ok: true, managed: false });
	assert.equal((await runtime.prepare(selected)).reason, "auth-binding-changed");
	assert.deepEqual(calls, []);
	auth.check = async () => ({ ok: true, managed: true, ...connection, accountGroup: "changed" });
	assert.equal((await runtime.prepare(selected)).reason, "auth-binding-changed");
	auth.check = async () => ({ ok: true, managed: true, ...connection });
	auth.prepareSnapshot = async () => ({ ok: true, snapshot: { ...connection, accountGroup: "changed" } });
	assert.equal((await runtime.prepare(selected)).reason, "auth-binding-changed", "changed connection after quota admission cannot become the run's snapshot");
	auth.prepareSnapshot = async () => ({ ok: true, snapshot: { ...connection, generation: 3 } });
	assert.equal((await runtime.prepare(selected)).ok, true);
});

test("quota replay permission is returned only after an authoritative exhausted write succeeds for the attempt binding", async () => {
	const snapshot = { ...connection, provider: "openai", adapter: "openai-chatgpt" };
	const result = { code: 1, exitLineCode: 1, exitAuth: "verified", providerFailure: { kind: "quota-exhausted", subscriptionProvider: "openai", subscriptionCode: "usage_limit_reached" } };
	for (const written of [{ ok: true, status: { state: "exhausted", bindingValid: true } }, { ok: false, status: { state: "exhausted" } }, { ok: true, status: { state: "unknown" } }, { ok: true, status: { state: "exhausted", bindingValid: false } }]) {
		const runtime = makeSubscriptionRuntime({ now: () => instant, auth: { check: async () => ({ ok: true, managed: true, ...snapshot }) }, quota: { record: async () => written } });
		assert.equal((await runtime.observe({ provider: "openai", model: "gpt" }, result, [snapshot]))?.quotaExhausted === true, written.ok && written.status.state === "exhausted" && written.status.bindingValid !== false);
		assert.equal(await runtime.observe(job, { ...result, providerFailure: { kind: "rate-limited", subscriptionProvider: "openai" } }, [snapshot]), undefined, "generic 429 is not subscription exhaustion");
	}
	const runtime = makeSubscriptionRuntime({ now: () => instant, auth: { check: async () => ({ ok: true, managed: true, ...snapshot, accountGroup: "another-account" }) }, quota: { record: async () => assert.fail("changed binding cannot record attempt evidence") } });
	assert.equal(await runtime.observe(job, result, [snapshot]), undefined);
});
test("candidate preview never refreshes or consumes an operator trial; selected preparation does", async () => {
	const { runtime, calls } = fixture();
	assert.equal((await runtime.check(job)).ok, true);
	assert.equal(calls[0].policy.consumeTrial, false);
	assert.equal(calls[0].policy.modelRef, "anthropic/sonnet");
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
test("issue #888, part 3: a running job's snapshot is extended for the same connection and binding only, with no quota admission", async () => {
	const { runtime, calls, auth } = fixture();
	const started = (await runtime.prepare(job, { deadlineAt: instant + 1_800_000, attemptId: "delivery-1" })).snapshots[0];
	const admissions = calls.filter((c) => typeof c === "object" && c?.policy).length;
	auth.prepareSnapshot = async (provider, { deadlineAt }) => (calls.push("extend"), { ok: true, snapshot: { ...connection, generation: 3, expiresAt: deadlineAt + 3_600_000, deadlineAt, env: { ANTHROPIC_OAUTH_TOKEN: "renewed-access" } } });
	const extended = await runtime.extend(started, { deadlineAt: instant + 3_600_000 });
	assert.equal(extended.deadlineAt, instant + 3_600_000);
	assert.equal(extended.env.ANTHROPIC_OAUTH_TOKEN, "renewed-access");
	assert.equal(extended.connectionId, started.connectionId);
	assert.equal(calls.filter((c) => typeof c === "object" && c?.policy).length, admissions, "no second quota admission or trial");
	// Another connection, another account group or a refused preparation: nothing is handed to the job.
	for (const swap of [{ connectionId: "other" }, { accountGroup: "another-group" }, { adapter: "@gotgenes/pi-anthropic-auth@3.4.3" }]) {
		auth.prepareSnapshot = async (provider, { deadlineAt }) => ({ ok: true, snapshot: { ...connection, ...swap, deadlineAt, env: { ANTHROPIC_OAUTH_TOKEN: "x" } } });
		assert.equal(await runtime.extend(started, { deadlineAt: instant + 3_600_000 }), null, JSON.stringify(swap));
	}
	auth.prepareSnapshot = async () => ({ ok: false, reason: "auth-reauth-required" });
	assert.equal(await runtime.extend(started, { deadlineAt: instant + 3_600_000 }), null);
});

test("each finite subscription route carries its exact physical model into quota admission", async () => {
	const { runtime, calls } = fixture();
	const models = ["anthropic/claude-opus-5-5", "anthropic/claude-fable-5-2"];
	assert.equal((await runtime.check({ ...job, model: "claude-opus-5-5", models })).ok, true);
	assert.deepEqual(calls.filter(call => call.policy).map(call => call.policy.modelRef), models);
});

test("explicit auxiliary routes admit paid panel models while root candidates retain their billing boundary", async () => {
	const { runtime, calls } = fixture();
	const panel = { ...job, models: [...job.models, "openrouter/frontier"], auxiliaryModels: ["openrouter/frontier"] };
	assert.equal((await runtime.inspectPolicy(panel)).ok, true);
	assert.deepEqual(calls, [], "policy inspection never reserves quota");
	assert.equal((await runtime.check(panel)).ok, true);
	assert.equal((await runtime.check(panel)).rootManaged, true);
	assert.equal((await runtime.check({ ...panel, auxiliaryModels: undefined })).reason, "auth-mixed-billing");
	assert.equal((await runtime.inspectPolicy({ ...panel, modelSelection: { strategy: "random", candidates: panel.models } })).reason, "auth-mixed-billing", "an auxiliary grant cannot authorize a paid root candidate");
});

test("auxiliary authority requires a finite exact allowlist and positive explicit cap before auth or quota", async () => {
	const { runtime, auth, calls } = fixture();
	auth.check = async () => assert.fail("invalid authority reaches no credential store");
	for (const patch of [{ models: ["anthropic/*"] }, { auxiliaryModels: ["openrouter/unlisted"] }, { maxCostMicros: null }, { maxCostMicros: 0 }]) {
		const panel = { ...job, models: [...job.models, "openrouter/frontier"], auxiliaryModels: ["openrouter/frontier"], ...patch };
		assert.equal((await runtime.inspectPolicy(panel)).reason, "auth-route-unbounded");
		assert.equal((await runtime.check(panel)).reason, "auth-route-unbounded");
	}
	assert.deepEqual(calls, []);
});

test("selected root identity does not reject a separately bound subscription auxiliary", async () => {
	const { runtime, auth } = fixture();
	const other = { ...connection, id: "gpt", connectionId: "gpt", provider: "openai", adapter: "openai-chatgpt", accountGroup: "other-account" };
	auth.check = async (provider) => ({ ok: true, managed: true, ...(provider === "openai" ? other : connection) });
	auth.prepareSnapshot = async (provider) => ({ ok: true, snapshot: provider === "openai" ? other : connection });
	const panel = { ...job, models: [...job.models, "openai/gpt"], auxiliaryModels: ["anthropic/sonnet", "openai/gpt"], modelSelection: { strategy: "random", candidates: job.models }, modelSelectionBilling: "subscription", modelSelectionBinding: subscriptionBindingDigest(connection) };
	const checked = await runtime.check(panel);
	assert.equal(checked.ok, true);
	assert.equal(checked.binding, subscriptionBindingDigest(connection));
	assert.deepEqual((await runtime.prepare(panel)).snapshots.map(row => row.provider), ["anthropic", "openai"]);
});

test("API roots stay API when an auxiliary subscription is unavailable or exhausted", async () => {
	const panel = { provider: "openrouter", model: "frontier", models: ["openrouter/frontier", "anthropic/sonnet"], auxiliaryModels: ["anthropic/sonnet"], maxCostMicros: 500_000, modelSelectionBilling: "api" };
	for (const failure of [{ ok: false, managed: true, reason: "auth-reauth-required" }, { ok: false, managed: true, reason: "auth-owner-host" }]) {
		const { runtime, auth } = fixture();
		auth.check = async provider => provider === "openrouter" ? { ok: true, managed: false } : failure;
		const result = await runtime.check(panel);
		assert.equal(result.rootManaged, false);
		assert.equal(result.ok, false);
		assert.notEqual(result.reason, "auth-binding-changed");
	}
	const { runtime } = fixture({ quotaResult: { ok: false, reason: "subscription-quota", status: { state: "exhausted" } } });
	const result = await runtime.check(panel);
	assert.equal(result.rootManaged, false);
	assert.equal(result.wait, "subscription-quota");
	assert.equal(result.auxiliary, true);
});


test("two models on one subscription consume one trial for the same durable attempt", async () => {
	const rows = new Map();
	let writes = 0;
	const redis = { get: async key => rows.get(key) ?? null, eval: async (_script, _count, key, before, after) => {
		if ((rows.get(key) ?? "") !== before) return 0;
		rows.set(key, after); writes++; return 1;
	} };
	const quota = makeSubscriptionQuotaStore({ redis, now: () => instant });
	const native = { ...connection, provider: "openai", adapter: "openai-chatgpt", accountGroup: "12345678-1234-1234-1234-123456789abc" };
	const identity = subscriptionIdentity(native);
	await quota.record(identity, normalizeSubscriptionQuotaError({ provider: "openai", code: "usage_limit_reached", status: 429 }, { observedAt: instant }));
	assert.equal((await quota.grantOneTrial(identity, { actorKind: "person", expectedVersion: 1 })).ok, true);
	const runtime = makeSubscriptionRuntime({ now: () => instant, quota, auth: { check: async () => ({ ok: true, managed: true, ...native }), prepareSnapshot: async () => ({ ok: true, snapshot: native }) }, lookup: () => ({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }) });
	const panel = { provider: "openai", model: "sol", models: ["openai/sol", "openai/astra"], auxiliaryModels: ["openai/astra"], maxCostMicros: 500_000 };
	const before = writes;
	const prepared = await runtime.prepare(panel, { attemptId: "durable-attempt" });
	assert.equal(prepared.ok, true);
	assert.equal(prepared.snapshots.length, 1);
	assert.equal(writes - before, 1, "the shared subscription trial is consumed only once");
	assert.equal((await runtime.check(panel, { attemptId: "another-attempt", consumeTrial: true })).wait, "subscription-quota");
});


test("auxiliary snapshots stay on the independently admitted binding across preparation races", async () => {
	const { runtime, auth } = fixture();
	const other = { ...connection, id: "gpt", connectionId: "gpt", provider: "openai", adapter: "openai-chatgpt", accountGroup: "other-account" };
	auth.check = async provider => ({ ok: true, managed: true, ...(provider === "openai" ? other : connection) });
	const panel = { ...job, models: [...job.models, "openai/gpt"], auxiliaryModels: ["openai/gpt"] };
	for (const change of [{ connectionId: "new-connection" }, { accountGroup: "new-account" }, { adapter: "another-adapter" }, { bindingSignature: "changed-policy" }]) {
		auth.prepareSnapshot = async provider => ({ ok: true, snapshot: provider === "openai" ? { ...other, ...change } : connection });
		assert.equal((await runtime.prepare(panel)).reason, "auth-binding-changed");
	}
	auth.prepareSnapshot = async provider => ({ ok: true, snapshot: { ...(provider === "openai" ? other : connection), generation: 3 } });
	assert.equal((await runtime.prepare(panel)).ok, true, "refreshing the same admitted connection remains valid");
});
