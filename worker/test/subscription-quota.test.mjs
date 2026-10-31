import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { makeSubscriptionQuotaStore, normalizeClaudeQuota, normalizeOpenAIQuota, normalizeSubscriptionQuotaError, subscriptionQuotaKey, SUBSCRIPTION_QUOTA_LIMITS } from "../src/subscription-quota.mjs";

const NOW = Date.UTC(2030, 0, 1);
const DAY = 86_400_000;
const identity = (overrides = {}) => ({ connectionId: "claude-one", owner: "worker-one", accountDigest: "12345678-1234-1234-1234-123456789abc", bucket: "anthropic:subscription", generation: 1, ...overrides });
const claude = (raw, at = NOW) => normalizeClaudeQuota(raw, { observedAt: at });
const failure = (raw = {}, at = NOW) => normalizeSubscriptionQuotaError({ provider: "anthropic", code: "usage_limit_reached", status: 429, ...raw }, { observedAt: at });
const known = (used = 10, overrides = {}) => ({ five_hour: { utilization: used }, seven_day: { utilization: used }, extra_usage: { is_enabled: false }, ...overrides });
function fakeRedis() {
	const rows = new Map(), writes = [];
	return {
		rows, writes, reads: 0, collide: null,
		async get(key) { this.reads++; return rows.get(key) ?? null; },
		async eval(_script, count, key, before, after) {
			assert.equal(count, 1);
			if (this.collide) { const collision = this.collide; this.collide = null; await collision(key); }
			if ((rows.get(key) ?? "") !== before) return 0;
			rows.set(key, after); writes.push({ key, after }); return 1;
		},
	};
}
function fixture(at = NOW) {
	let clock = at;
	const redis = fakeRedis();
	return { redis, store: makeSubscriptionQuotaStore({ redis, now: () => clock }), setTime(value) { clock = value; } };
}

test("Claude missing, inactive and malformed windows stay unknown rather than invented zero", () => {
	for (const raw of [{}, null, [], "not-json", { five_hour: null }, { five_hour: { utilization: "0" } }, { limits: [{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: null }] }]) {
		const value = claude(raw);
		assert.equal(value.complete, false);
		assert.equal(value.windows[0].state, "unknown");
		assert.equal(value.windows[1].usedPercent, null);
		assert.ok(value.windows.every(row => row.usedPercent === null));
	}
});

test("Claude legacy, modern scoped limits and extra usage retain measured fields without profile prose", () => {
	const raw = known(15, {
		limits: [{ kind: "session", percent: 100, resets_at: new Date(NOW + 5 * 3_600_000).toISOString() }, { kind: "weekly_scoped", scope: { model: { display_name: "private@example.com" }, surface: "secret-token" }, utilization: 101, resets_at: new Date(NOW + 7 * DAY).toISOString() }],
		seven_day_sonnet: { utilization: 42 },
		extra_usage: { is_enabled: true, utilization: 8, used_credits: 1234, monthly_limit: 5000, currency: "USD", decimal_places: 2 },
		account: { email: "private@example.com" },
	});
	const value = claude(raw);
	assert.equal(value.complete, true);
	assert.equal(value.windows[0].state, "exhausted");
	assert.equal(value.windows[0].resetAt, NOW + 5 * 3_600_000);
	assert.deepEqual(value.windows.filter(row => row.scope === "scoped").map(row => [row.state, row.usedPercent]), [["exhausted", 101], ["available", 42]]);
	assert.deepEqual(value.extraUsage, { enabled: true, usedPercent: 8, usedCredits: 1234, monthlyLimit: 5000, currency: "USD", decimalPlaces: 2 });
	assert.doesNotMatch(JSON.stringify(value), /private@example|secret-token|email|display_name/);
});

test("duplicate account limits cannot replace exhaustion with a lower utilization", () => {
	for (const limits of [[{ kind: "session", percent: 100 }, { kind: "session", percent: 20 }], [{ kind: "session", percent: 20 }, { kind: "session", percent: 100 }]]) {
		assert.equal(claude({ limits }).windows[0].state, "exhausted");
	}
});

test("parsers bound payloads, collection sizes, percentages and resets without assuming USD", () => {
	const oversized = JSON.stringify({ ignored: "x".repeat(SUBSCRIPTION_QUOTA_LIMITS.payloadBytes) });
	const circular = {}; circular.self = circular;
	for (const raw of [oversized, circular, { limits: Array.from({ length: 33 }, () => ({ kind: "session", percent: 100 })) }]) assert.equal(claude(raw).windows[0].state, "unknown");
	const result = claude({ five_hour: { utilization: -1, resets_at: "tomorrow" }, seven_day: { utilization: Infinity, resets_at: new Date(NOW + 100 * DAY).toISOString() }, extra_usage: { is_enabled: "false", currency: "invalid", used_credits: -1, decimal_places: 8 } });
	assert.ok(result.windows.every(row => row.state === "unknown" && row.resetAt === null));
	assert.deepEqual(result.extraUsage, { enabled: null, usedPercent: null, usedCredits: null, monthlyLimit: null, currency: null, decimalPlaces: null });
	assert.throws(() => normalizeClaudeQuota({}, {}), { code: "subscription-invalid-observation" });
});

test("OpenAI normalizes typed primary/secondary durations and seconds while retaining missing windows", () => {
	const result = normalizeOpenAIQuota({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: NOW / 1000 + 300 }, secondary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: NOW / 1000 + 7 * DAY / 1000 }, credits: { balance: "private" } } }, { observedAt: NOW });
	assert.equal(result.complete, true);
	assert.deepEqual(result.windows.map(row => [row.window, row.state, row.resetAt]), [["five-hour", "exhausted", NOW + 300_000], ["seven-day", "available", NOW + 7 * DAY]]);
	const missing = normalizeOpenAIQuota({ primary: { usedPercent: 50, windowDurationMins: 60, resetsAt: "tomorrow" } }, { observedAt: NOW });
	assert.equal(missing.complete, false);
	assert.equal(missing.windows[0].usedPercent, null);
	assert.equal(missing.windows.at(-1).window, "other");
	assert.doesNotMatch(JSON.stringify(result), /private|credits|balance/);
});

test("typed quota errors reject arbitrary diagnostic prose, auth, overload and unknown codes", () => {
	for (const raw of [{ code: "You have hit your ChatGPT usage limit" }, { code: "insufficient_quota" }, { provider: "attacker" }, { status: 401 }, { status: 403 }, { status: 400 }, { status: 500 }]) assert.equal(failure(raw), null);
	const result = failure({ provider: "openai-codex", code: "usage_not_included", resetAt: NOW + 7 * DAY, errorMessage: "private" });
	assert.equal(result.windows[0].state, "exhausted");
	assert.equal(result.windows[0].resetAt, NOW + 7 * DAY);
	assert.equal(result.complete, false);
	assert.doesNotMatch(JSON.stringify(result), /private|errorMessage/);
});

test("initial unknown quota admits only after the separate Claude billing policy passes", async () => {
	const { store, redis } = fixture();
	assert.equal((await store.admit(identity())).reason, "subscription-unknown");
	assert.equal((await store.admit(identity(), { requireExtraUsageKnownDisabled: true })).reason, "subscription-extra-usage");
	assert.equal(redis.writes.length, 0);
	await assert.rejects(store.admit(identity(), { allowExtraUsage: true }), { code: "subscription-invalid-policy" });
	const authorized = await store.admit(identity(), { allowExtraUsage: true, maxCreditMicros: 1000, requireExtraUsageKnownDisabled: true });
	assert.equal(authorized.ok, true);
	assert.equal(authorized.creditCapMicros, 1000, "root admission must also narrow the normal per-job dollar cap");
});

test("fresh available evidence becomes honest stale unknown without manufacturing exhaustion", async () => {
	const { store, setTime } = fixture();
	await store.record(identity(), claude(known()));
	assert.equal((await store.read(identity())).state, "available");
	assert.equal((await store.admit(identity(), { requireExtraUsageKnownDisabled: true })).ok, true);
	setTime(NOW + SUBSCRIPTION_QUOTA_LIMITS.freshMs + 1);
	const status = await store.read(identity());
	assert.equal(status.fresh, false);
	assert.equal(status.state, "unknown");
	assert.ok(status.windows.every(row => !row.fresh && row.state === "unknown"));
	assert.equal((await store.admit(identity())).reason, "subscription-unknown");
});

test("known weekly reset is preserved for the whole week despite monitoring preferences", async () => {
	const { store, setTime } = fixture();
	await store.record(identity(), claude(known(10, { seven_day: { utilization: 100, resets_at: new Date(NOW + 7 * DAY).toISOString() } })));
	const blocked = await store.admit(identity());
	assert.equal(blocked.ok, false);
	assert.equal(blocked.until, NOW + 7 * DAY, "subscription reset is not the six-hour model cooldown cap");
	assert.equal((await store.admit(identity(), { windows: ["five-hour"] })).until, NOW + 7 * DAY, "an unmonitored exhausted window is still authority to stop spending");
	setTime(NOW + 6 * DAY);
	assert.equal((await store.read(identity())).state, "exhausted", "stale evidence cannot erase a known future reset");
	setTime(NOW + 7 * DAY);
	assert.equal((await store.admit(identity())).reason, "subscription-unknown", "a reset permits normal admission but does not prove unused quota");
});

test("both exhausted windows wait until the last applicable reset", async () => {
	const { store } = fixture();
	await store.record(identity(), claude(known(100, { five_hour: { utilization: 100, resets_at: new Date(NOW + 3_600_000).toISOString() }, seven_day: { utilization: 100, resets_at: new Date(NOW + 7 * DAY).toISOString() } })));
	assert.equal((await store.admit(identity())).until, NOW + 7 * DAY);
	assert.equal((await store.admit(identity(), { windows: ["five-hour"] })).until, NOW + 7 * DAY);
	assert.equal((await store.admit(identity(), { windows: [] })).ok, false);
});

test("unknown-reset exhaustion never expires or clears from missing, stale or partial evidence", async () => {
	const { store, setTime, redis } = fixture();
	await store.record(identity(), failure());
	setTime(NOW + 90 * DAY);
	assert.equal((await store.read(identity())).blockedUnknownReset, true);
	assert.equal((await store.admit(identity())).until, null);
	await store.record(identity(), claude({}, NOW + 90 * DAY));
	assert.equal((await store.admit(identity())).ok, false);
	const stale = await store.record(identity(), claude(known(), NOW + DAY));
	assert.equal(stale.reason, "subscription-stale-evidence");
	assert.equal((await store.read(identity())).blockedUnknownReset, true);
	assert.equal(redis.writes.length, 2);
});

test("a newer complete quota snapshot clears generic error exhaustion; partial availability cannot", async () => {
	const { store, setTime } = fixture();
	await store.record(identity(), failure());
	setTime(NOW + 1);
	await store.record(identity(), claude({ five_hour: { utilization: 10 } }, NOW + 1));
	assert.equal((await store.admit(identity())).ok, false);
	setTime(NOW + 2);
	await store.record(identity(), claude(known(), NOW + 2));
	assert.equal((await store.admit(identity())).ok, true);
});

test("an unavailable scoped window is not invented zero and known scoped exhaustion blocks conservatively", async () => {
	const { store } = fixture();
	await store.record(identity(), claude(known(10, { limits: [{ kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "a model with no reviewed alias" } } }] })));
	assert.equal((await store.admit(identity())).ok, false);
	assert.equal((await store.admit(identity(), { windows: ["five-hour"] })).ok, false);
	assert.ok((await store.read(identity())).windows.some(row => row.scope === "scoped" && row.state === "exhausted"));
});

test("enabled or unknown extra usage never authorizes paid credits by default", async () => {
	for (const extra of [{ is_enabled: true }, {}]) {
		const { store } = fixture();
		await store.record(identity(), claude(known(10, { extra_usage: extra })));
		assert.equal((await store.admit(identity(), { requireExtraUsageKnownDisabled: true })).reason, "subscription-extra-usage");
	}
	const { store } = fixture();
	await store.record(identity(), claude(known(100, { extra_usage: { is_enabled: true } })));
	assert.equal((await store.admit(identity(), { allowExtraUsage: true, maxCreditMicros: 25_000, requireExtraUsageKnownDisabled: true })).creditCapMicros, 25_000);
	assert.equal((await store.admit(identity())).ok, false);
});

test("one person's trial is previewed without consumption and atomically belongs to one durable attempt", async () => {
	const { store, redis } = fixture();
	await store.record(identity(), failure());
	await assert.rejects(store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "agent" }), { code: "subscription-trial-person-required" });
	assert.equal((await store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "person" })).ok, true);
	const writes = redis.writes.length;
	for (let i = 0; i < 3; i++) assert.equal((await store.admit(identity(), { consumeTrial: false })).reason, "subscription-trial");
	assert.equal(redis.writes.length, writes);
	const results = await Promise.all(["queue:one:1", "queue:two:1"].map(attemptId => store.admit(identity(), { attemptId })));
	assert.equal(results.filter(row => row.ok).length, 1);
	const attemptId = results[0].ok ? "queue:one:1" : "queue:two:1";
	assert.equal((await store.admit(identity(), { attemptId })).reason, "subscription-trial");
	assert.equal((await store.admit(identity(), { attemptId: "queue:three:1" })).ok, false);
	assert.equal((await store.read(identity())).trialAvailable, false);
	assert.doesNotMatch([...redis.rows.values()].join(""), /queue:one|queue:two/);
});

test("trial cannot bypass known resets, billing policy, or new evidence racing the person's confirmation", async () => {
	const { store, setTime } = fixture();
	await store.record(identity(), failure({ resetAt: NOW + 7 * DAY }));
	assert.equal((await store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "person" })).ok, false);
	setTime(NOW + 1);
	await store.record(identity(), failure({}, NOW + 1));
	assert.equal((await store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "person" })).reason, "subscription-stale-state");
	assert.equal((await store.grantOneTrial(identity(), { expectedVersion: 2, actorKind: "person" })).ok, true);
	assert.equal((await store.admit(identity(), { attemptId: "run:1", requireExtraUsageKnownDisabled: true })).reason, "subscription-extra-usage");
	assert.equal((await store.read(identity())).trialAvailable, true);
});

test("new evidence revokes a granted trial and an unknown scoped row cannot clear old exhaustion", async () => {
	const { store, setTime } = fixture();
	await store.record(identity(), failure({ window: "seven-day" }));
	await store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "person" });
	setTime(NOW + 1);
	await store.record(identity(), claude({}, NOW + 1));
	assert.equal((await store.read(identity())).trialAvailable, false);
	assert.equal((await store.admit(identity(), { attemptId: "run:1" })).ok, false);
});

test("connection, account and application bucket isolation persist across credential generation changes", async () => {
	const { store } = fixture();
	await store.record(identity(), failure());
	for (const changed of [{ connectionId: "claude-two" }, { accountDigest: "a".repeat(64) }, { bucket: "other-product:subscription" }]) assert.equal((await store.admit(identity(changed))).ok, true);
	assert.equal(subscriptionQuotaKey(identity()), subscriptionQuotaKey(identity({ generation: 2, owner: "worker-two" })));
	assert.equal((await store.admit(identity({ generation: 2, owner: "worker-two" }), { consumeTrial: false })).ok, false, "a reconnect does not erase exhaustion");
	await store.grantOneTrial(identity({ generation: 2, owner: "worker-two" }), { expectedVersion: 1, actorKind: "person" });
	assert.equal((await store.admit(identity())).reason, "subscription-stale-binding");
	assert.equal((await store.record(identity(), claude(known()))).reason, "subscription-stale-binding");
});

test("selected prepare promotes a newer generation atomically without erasing its quota refusal", async () => {
	const { store, redis } = fixture();
	await store.record(identity(), failure());
	const next = identity({ generation: 2, owner: "worker-two" });
	await store.admit(next, { consumeTrial: false });
	assert.equal(redis.writes.length, 1, "candidate preview cannot publish a binding");
	assert.equal((await store.admit(next)).reason, "subscription-quota");
	assert.equal((await store.read(next)).generation, 2);
	assert.equal((await store.admit(identity())).reason, "subscription-stale-binding");
});

test("same-generation wrong owner is refused, and incoming arbitrary identity fields are never stored", async () => {
	const { store, redis } = fixture();
	await store.record(identity({ ignored: "never-store-me" }), failure());
	assert.equal((await store.admit(identity({ owner: "other-worker" }))).reason, "subscription-stale-binding");
	assert.doesNotMatch([...redis.rows.values()].join(""), /never-store-me/);
	await assert.rejects(store.read(identity({ accountDigest: "person@example.com" })), { code: "subscription-invalid-binding" });
});

test("CAS collision re-reads new evidence instead of overwriting it with an earlier observation", async () => {
	const { store, redis, setTime } = fixture(NOW + 2);
	await store.record(identity(), claude(known(), NOW));
	redis.collide = async () => { await store.record(identity(), failure({}, NOW + 2)); };
	const result = await store.record(identity(), claude(known(), NOW + 1));
	assert.equal(result.reason, "subscription-stale-evidence");
	assert.equal((await store.read(identity())).state, "exhausted");
	setTime(NOW + 3);
	assert.equal((await store.record(identity(), claude(known(), NOW + 3), { expectedVersion: 1 })).reason, "subscription-stale-state");
});

test("same-millisecond evidence ties preserve exhaustion in either arrival order", async () => {
	for (const reverse of [false, true]) {
		const { store } = fixture();
		const observations = [claude(known()), failure()];
		if (reverse) observations.reverse();
		for (const evidence of observations) await store.record(identity(), evidence);
		assert.equal((await store.admit(identity())).ok, false);
		assert.equal((await store.read(identity())).blockedUnknownReset, true);
	}
});

test("a measured 429 invalidates cached availability and billing facts without inventing exhaustion", async () => {
	const { store } = fixture();
	await store.record(identity(), claude(known()));
	const invalidated = await store.invalidate(identity(), { observedAt: NOW });
	assert.equal(invalidated.ok, true);
	assert.equal(invalidated.status.state, "unknown");
	assert.equal(invalidated.status.fresh, false);
	assert.equal(invalidated.status.extraUsage.enabled, null);
	assert.equal(invalidated.status.probeRequired, true);
	assert.equal(invalidated.status.blockedUnknownReset, false, "a short provider throttle is not a plan-exhaustion claim");
	assert.equal(invalidated.status.until, null);
	const preview = await store.admit(identity(), { consumeTrial: false, requireExtraUsageKnownDisabled: true });
	assert.equal(preview.ok, true);
	assert.equal(preview.requiresUsage, true);
	const selected = await store.admit(identity(), { requireExtraUsageKnownDisabled: true });
	assert.equal(selected.ok, false);
	assert.equal(selected.reason, "subscription-observation-required");
});

test("probe invalidation preserves known exhaustion and cannot be cleared by an old or unversioned fetch", async () => {
	const { store, setTime } = fixture();
	await store.record(identity(), claude(known()));
	const before = await store.read(identity());
	await store.invalidate(identity(), { observedAt: NOW });
	assert.equal((await store.record(identity(), claude(known()), { expectedVersion: before.version })).reason, "subscription-stale-state");
	assert.equal((await store.record(identity(), claude(known()))).reason, "subscription-stale-state");
	const pending = await store.read(identity());
	await store.invalidate(identity(), { observedAt: NOW });
	assert.equal((await store.record(identity(), claude(known()), { expectedVersion: pending.version })).reason, "subscription-stale-state");
	const current = await store.read(identity());
	assert.equal((await store.record(identity(), claude(known()), { expectedVersion: current.version })).ok, true, "the fetch bound to the latest invalidation may finish in the same millisecond");
	assert.equal((await store.admit(identity(), { requireExtraUsageKnownDisabled: true })).ok, true);
	setTime(NOW + 1);
	await store.record(identity(), failure({ resetAt: NOW + 7 * DAY }, NOW + 1));
	await store.invalidate(identity(), { observedAt: NOW + 1 });
	assert.equal((await store.admit(identity(), { consumeTrial: false })).until, NOW + 7 * DAY);
});

test("invalidation before the first observation persists and does not inherit a guessed TTL", async () => {
	const { store, setTime } = fixture();
	await store.invalidate(identity(), { observedAt: NOW });
	setTime(NOW + 60 * DAY);
	const status = await store.read(identity());
	assert.equal(status.probeRequired, true);
	assert.equal(status.state, "unknown");
	assert.equal((await store.admit(identity())).reason, "subscription-observation-required");
});

test("quota store rejects corrupt, oversize or future evidence and bounds collision retries without scans", async () => {
	const { store, redis } = fixture();
	assert.equal((await store.record(identity(), claude(known(), NOW + 1))).reason, "subscription-stale-evidence");
	for (const raw of ["broken", "x".repeat(SUBSCRIPTION_QUOTA_LIMITS.payloadBytes + 1), JSON.stringify({ version: 1, source: "attacker" })]) {
		redis.rows.set(subscriptionQuotaKey(identity()), raw);
		await assert.rejects(store.read(identity()), { code: "subscription-store-invalid" });
	}
	redis.rows.clear();
	redis.eval = async () => 0;
	const before = redis.reads;
	await assert.rejects(store.record(identity(), failure()), { code: "subscription-store-conflict" });
	assert.equal(redis.reads - before, SUBSCRIPTION_QUOTA_LIMITS.casAttempts);
});

// The real Lua comparison, not a fake's implementation, establishes the multi-worker race boundary.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("subscription-quota REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
test("real Valkey shares persistent unknown exhaustion and grants only one trial across workers", { skip: url ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async t => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const clients = Array.from({ length: 8 }, () => makeRedisClient(url, {}));
	t.after(() => clients.forEach(client => client.disconnect()));
	const bound = identity({ connectionId: randomUUID() });
	const stores = clients.map(redis => makeSubscriptionQuotaStore({ redis, now: () => NOW }));
	try {
		await stores[0].record(bound, failure());
		assert.equal(await clients[0].pttl(subscriptionQuotaKey(bound)), -1, "unknown reset persists without a guessed TTL");
		assert.equal((await stores[7].read(bound)).blockedUnknownReset, true);
		await stores[0].grantOneTrial(bound, { expectedVersion: 1, actorKind: "person" });
		const claims = await Promise.all(stores.map((store, index) => store.admit(bound, { attemptId: `integration:${index}:1` })));
		assert.equal(claims.filter(claim => claim.ok).length, 1);
		assert.equal((await stores[0].read(bound)).version, 3);
	} finally { await clients[0].del(subscriptionQuotaKey(bound)); }
});

test("real Valkey CAS prevents an in-flight usage response from clearing another worker's 429 invalidation", { skip: url ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async t => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const clients = [makeRedisClient(url, {}), makeRedisClient(url, {})];
	t.after(() => clients.forEach(client => client.disconnect()));
	const bound = identity({ connectionId: randomUUID() });
	const stores = clients.map(redis => makeSubscriptionQuotaStore({ redis, now: () => NOW }));
	try {
		await stores[0].record(bound, claude(known()));
		await stores[0].invalidate(bound, { observedAt: NOW });
		const fetchStarted = await stores[0].read(bound);
		await stores[1].invalidate(bound, { observedAt: NOW });
		const stale = await stores[0].record(bound, claude(known()), { expectedVersion: fetchStarted.version });
		assert.equal(stale.reason, "subscription-stale-state");
		assert.equal((await stores[0].admit(bound)).reason, "subscription-observation-required");
		const current = await stores[1].read(bound);
		assert.equal((await stores[1].record(bound, claude(known()), { expectedVersion: current.version })).ok, true);
		assert.equal((await stores[0].admit(bound)).ok, true);
	} finally { await clients[0].del(subscriptionQuotaKey(bound)); }
});
