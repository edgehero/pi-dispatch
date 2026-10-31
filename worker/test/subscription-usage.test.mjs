import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSubscriptionQuotaStore, normalizeClaudeQuota } from "../src/subscription-quota.mjs";
import { makeSubscriptionRuntime, subscriptionIdentity } from "../src/subscription-runtime.mjs";

const NOW = 1_800_000_000_000;
const WEEK = 7 * 86_400_000;
const connection = {
	id: "claude", connectionId: "claude", provider: "anthropic", active: true, ownerHost: "worker-one",
	adapter: "pi-anthropic-oauth@0.3.6", accountGroup: "12345678-1234-1234-1234-123456789abc", generation: 2,
};
const job = { provider: "anthropic", model: "sonnet", models: ["anthropic/sonnet"], maxCostMicros: 500_000 };
const available = () => ({ five_hour: { utilization: 20 }, seven_day: { utilization: 30 }, extra_usage: { is_enabled: false } });
const throttled = { code: 1, exitLineCode: 1, exitAuth: "verified", providerFailure: { kind: "rate-limited", subscriptionProvider: "anthropic" } };

function fixture() {
	const records = new Map();
	let writes = 0;
	const redis = {
		async get(key) { return records.get(key) ?? null; },
		async eval(_script, count, key, before, after) {
			assert.equal(count, 1);
			if ((records.get(key) ?? "") !== before) return 0;
			records.set(key, after);
			writes++;
			return 1;
		},
	};
	const quota = makeSubscriptionQuotaStore({ redis, now: () => NOW });
	const identity = subscriptionIdentity(connection);
	const calls = [];
	let current = { ...connection };
	let fetchUsage = async () => available();
	const auth = {
		check: async provider => provider === current.provider ? { ok: true, managed: true, ...current } : { ok: true, managed: false },
		status: async () => [current],
		async usage() {
			calls.push("usage");
			const bound = { ...current };
			const payload = await fetchUsage();
			return payload?.kind === "unavailable" ? payload : { kind: "observation", observedAt: NOW, ...bound, payload };
		},
		async prepareSnapshot() { calls.push("snapshot"); return { ok: true, snapshot: { ...current } }; },
	};
	const runtime = makeSubscriptionRuntime({
		auth, quota, now: () => NOW,
		lookup: provider => ({ api: provider === "anthropic" ? "anthropic-messages" : "openai-responses", baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1" }),
		packageRootFor: () => ({ root: "/opt/pi-global/packages/claude", digest: "a".repeat(64) }),
	});
	return {
		auth, quota, runtime, identity, calls,
		get writes() { return writes; },
		setUsage(fn) { fetchUsage = fn; },
		changeBinding(patch) { current = { ...current, ...patch }; },
		seed: raw => quota.record(identity, normalizeClaudeQuota(raw ?? available(), { observedAt: NOW })),
	};
}

test("a measured Claude throttle invalidates fresh availability before usage, then a versioned same-clock response restores it", async () => {
	const f = fixture();
	await f.seed();
	f.setUsage(async () => {
		const status = await f.quota.read(f.identity);
		assert.equal(status.version, 2);
		assert.equal(status.probeRequired, true);
		assert.equal(status.state, "unknown");
		assert.equal(status.extraUsage.enabled, null);
		const blocked = await f.quota.admit(f.identity, { attemptId: "another-model" });
		assert.equal(blocked.reason, "subscription-observation-required");
		assert.equal(blocked.ok, false, "the previous fresh observation cannot authorize another physical model");
		return available();
	});
	await f.runtime.observe(job, throttled, [connection]);
	const status = await f.quota.read(f.identity);
	assert.deepEqual([status.version, status.probeRequired, status.state, status.extraUsage.enabled, f.writes], [3, false, "available", false, 3]);
	assert.equal((await f.quota.admit(f.identity, { attemptId: "ordinary-next", requireExtraUsageKnownDisabled: true })).ok, true);
	assert.deepEqual(f.calls, ["usage"]);
});

test("failed usage after a Claude throttle persists the shared probe and selected preparation fetches before credentials", async () => {
	const f = fixture();
	await f.seed();
	f.setUsage(async () => ({ kind: "unavailable", reason: "auth-usage-unavailable" }));
	await assert.rejects(f.runtime.observe(job, throttled, [connection]), /subscription usage unavailable after throttling/);
	assert.equal((await f.quota.read(f.identity)).probeRequired, true);
	const preview = await f.quota.admit(f.identity, { consumeTrial: false });
	assert.deepEqual([preview.ok, preview.requiresUsage, f.writes], [true, true, 2]);
	assert.equal((await f.quota.admit(f.identity, { attemptId: "different-attempt" })).ok, false);
	const result = await f.runtime.prepare({ ...job, model: "opus", models: ["anthropic/opus"] }, { deadlineAt: NOW + 60_000, attemptId: "different-model" });
	assert.deepEqual([result.ok, result.reason, result.unavailable], [false, "auth-usage-unavailable", true]);
	assert.deepEqual(f.calls, ["usage", "usage"], "no access snapshot is prepared while required usage is unavailable");
	assert.equal(f.writes, 2);
});

test("a newer same-clock invalidation rejects an in-flight usage response by CAS version", async () => {
	const f = fixture();
	await f.seed();
	f.setUsage(async () => {
		assert.equal((await f.quota.read(f.identity)).version, 2);
		await f.quota.invalidate(f.identity, { observedAt: NOW });
		return available();
	});
	await assert.rejects(f.runtime.observe(job, throttled, [connection]), /subscription usage unavailable after throttling/);
	assert.deepEqual([(await f.quota.read(f.identity)).version, (await f.quota.read(f.identity)).probeRequired, f.writes], [3, true, 3]);
	f.setUsage(async () => available());
	const recovered = await f.runtime.usage(connection.id);
	assert.deepEqual([recovered.kind, recovered.quota.version, recovered.quota.probeRequired, recovered.quota.state], ["observation", 4, false, "available"]);
});

test("usage bound to an old credential generation cannot clear an invalidation", async () => {
	const f = fixture();
	await f.seed();
	await f.quota.invalidate(f.identity, { observedAt: NOW });
	f.setUsage(async () => { f.changeBinding({ generation: 3 }); return available(); });
	const result = await f.runtime.usage(connection.id);
	assert.deepEqual(result, { kind: "unavailable", reason: "auth-binding-changed" });
	assert.deepEqual([(await f.quota.read(f.identity)).probeRequired, f.writes], [true, 2]);
});

test("a partial usage observation cannot erase prior weekly exhaustion during a throttle probe", async () => {
	const f = fixture();
	await f.seed({ five_hour: { utilization: 20 }, seven_day: { utilization: 100, resets_at: new Date(NOW + WEEK).toISOString() }, extra_usage: { is_enabled: false } });
	f.setUsage(async () => ({ five_hour: { utilization: 30 }, extra_usage: { is_enabled: false } }));
	await f.runtime.observe(job, throttled, [connection]);
	const status = await f.quota.read(f.identity);
	assert.deepEqual([status.probeRequired, status.state, status.until], [false, "exhausted", NOW + WEEK]);
	assert.equal((await f.quota.admit(f.identity, { attemptId: "still-exhausted" })).reason, "subscription-quota");
});

test("untrusted, aborted, mismatched and unattributed failures cannot invalidate a subscription", async () => {
	const f = fixture();
	await f.seed();
	for (const patch of [
		{ exitAuth: "unverified" }, { exitLineCode: 2 }, { aborted: true },
		{ providerFailure: { kind: "rate-limited" } },
		{ providerFailure: { kind: "rate-limited", subscriptionProvider: "openai" } },
		{ providerFailure: { kind: "overloaded", subscriptionProvider: "anthropic" } },
	]) await f.runtime.observe(job, { ...throttled, ...patch }, [connection]);
	assert.deepEqual([f.writes, f.calls, (await f.quota.read(f.identity)).state], [1, [], "available"]);
});

test("mixed subscription and API routes refuse before usage or credentials; two explicitly bound subscription providers remain admissible", async () => {
	const f = fixture();
	await f.seed();
	const mixed = { ...job, models: ["anthropic/sonnet", "openai/gpt"] };
	assert.equal((await f.runtime.prepare(mixed, { deadlineAt: NOW + 60_000, attemptId: "mixed" })).reason, "auth-mixed-billing");
	assert.deepEqual([f.calls, f.writes], [[], 1]);
	const apiOnly = await f.runtime.check({ provider: "openai", model: "gpt", models: ["openai/gpt"] });
	assert.deepEqual(apiOnly, { ok: true, managed: [] });
	f.auth.check = async provider => ({ ok: true, managed: true, ...(provider === "anthropic" ? connection : { ...connection, id: "chatgpt", connectionId: "chatgpt", provider: "openai", adapter: "openai-chatgpt" }) });
	const both = await f.runtime.check(mixed);
	assert.deepEqual([both.ok, both.managed.map(row => row.provider)], [true, ["anthropic", "openai"]]);
	assert.equal(f.writes, 1, "candidate inspection is read-only for both connections");
});
