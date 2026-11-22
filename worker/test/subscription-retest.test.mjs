import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_COOLDOWN_MAX_MS } from "../src/model-failover.mjs";
import { makeSubscriptionQuotaStore, normalizeClaudeQuota, normalizeSubscriptionQuotaError, subscriptionQuotaKey, SUBSCRIPTION_RETEST_MS } from "../src/subscription-quota.mjs";
import { makeSubscriptionRuntime, subscriptionIdentity } from "../src/subscription-runtime.mjs";

// Issue #960: an exhaustion a provider's refusal recorded with no reset is retried by one job six hours on, and a clean
// run of that job clears it. Every case runs the real store over a compare-and-set double with an injected clock.

const NOW = Date.UTC(2030, 0, 1);
const HOUR = 3_600_000;
const CODE = "subscription_sharing_usage_limit_exceeded";
const identity = (overrides = {}) => ({ connectionId: "chatgpt-one", owner: "worker-one", accountDigest: "12345678-1234-1234-1234-123456789abc", bucket: "openai:subscription", generation: 1, ...overrides });
const refusal = (at = NOW, raw = {}) => normalizeSubscriptionQuotaError({ provider: "openai", code: CODE, status: 429, ...raw }, { observedAt: at });
function fakeRedis() {
	const rows = new Map(), writes = [];
	return {
		rows, writes, collide: null,
		async get(key) { return rows.get(key) ?? null; },
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
const stored = (redis) => JSON.parse(redis.rows.get(subscriptionQuotaKey(identity())));
const rewrite = (redis, change) => redis.rows.set(subscriptionQuotaKey(identity()), JSON.stringify(change(stored(redis))));

test("the retest is the model cooldown's ceiling, six hours", () => {
	assert.equal(SUBSCRIPTION_RETEST_MS, 6 * HOUR);
	assert.equal(SUBSCRIPTION_RETEST_MS, MODEL_COOLDOWN_MAX_MS);
});

test("one millisecond short of six hours admits nothing; at six hours a preview says so and writes nothing, and one attempt claims", async () => {
	const { store, redis, setTime } = fixture();
	await store.record(identity(), refusal());
	assert.equal((await store.read(identity())).retestAt, NOW + 6 * HOUR);
	setTime(NOW + 6 * HOUR - 1);
	const early = await store.admit(identity(), { attemptId: "queue:a:0:0" });
	assert.deepEqual([early.ok, early.reason, early.until], [false, "subscription-quota", null]);
	assert.equal((await store.admit(identity(), { consumeTrial: false })).ok, false);
	setTime(NOW + 6 * HOUR);
	const writes = redis.writes.length;
	for (let i = 0; i < 3; i++) assert.deepEqual(await store.admit(identity(), { consumeTrial: false }).then((row) => [row.ok, row.reason]), [true, "subscription-trial"]);
	assert.equal(redis.writes.length, writes, "a preview claims nothing");
	assert.deepEqual(await store.admit(identity(), { attemptId: "queue:a:0:0" }).then((row) => [row.ok, row.reason]), [true, "subscription-trial"]);
	assert.equal(redis.writes.length, writes + 1);
	assert.deepEqual(await store.admit(identity(), { attemptId: "queue:a:0:0" }).then((row) => [row.ok, row.reason]), [true, "subscription-trial"], "the same attempt again is the same claim");
	assert.equal(redis.writes.length, writes + 1);
	const other = await store.admit(identity(), { attemptId: "queue:b:0:0" });
	assert.deepEqual([other.ok, other.reason, other.until], [false, "subscription-quota", null]);
	assert.equal((await store.admit(identity(), { consumeTrial: false })).ok, false, "a preview while another attempt holds the trial is refused, never an error");
	const status = await store.read(identity());
	assert.deepEqual([status.state, status.trialAvailable, status.retestAt], ["exhausted", false, NOW + 12 * HOUR]);
	const trial = stored(redis).trial;
	assert.deepEqual([trial.auto, trial.claimedAt, /^[a-f0-9]{64}$/.test(trial.usedBy)], [true, NOW + 6 * HOUR, true]);
	assert.doesNotMatch(redis.rows.get(subscriptionQuotaKey(identity())), /queue:a/);
	await assert.rejects(store.admit(identity(), {}), { code: "subscription-invalid-trial" }, "a claim names its attempt");
});

test("two stores racing for the retest write exactly one claim", async () => {
	const { store, redis, setTime } = fixture();
	await store.record(identity(), refusal());
	setTime(NOW + 6 * HOUR);
	const rival = makeSubscriptionQuotaStore({ redis, now: () => NOW + 6 * HOUR });
	let raced;
	redis.collide = async () => { raced = await rival.admit(identity(), { attemptId: "host-two:0:0" }); };
	const first = await store.admit(identity(), { attemptId: "host-one:0:0" });
	assert.deepEqual([raced.ok, first.ok], [true, false], "the rival's write landed first, so this one re-read and was refused");
	assert.equal(first.reason, "subscription-quota");
	assert.equal(redis.writes.filter((row) => JSON.parse(row.after).trial?.auto === true).length, 1);
});

test("a retest that meets the limit again re-latches, and the next retest comes six hours after that refusal", async () => {
	const { store, setTime } = fixture();
	await store.record(identity(), refusal());
	setTime(NOW + 6 * HOUR);
	await store.admit(identity(), { attemptId: "run:1" });
	setTime(NOW + 6 * HOUR + 60_000);
	assert.equal((await store.record(identity(), refusal(NOW + 6 * HOUR + 60_000))).ok, true);
	const status = await store.read(identity());
	assert.deepEqual([status.state, status.retestAt], ["exhausted", NOW + 12 * HOUR + 60_000]);
	setTime(NOW + 12 * HOUR + 59_999);
	assert.equal((await store.admit(identity(), { attemptId: "run:2" })).ok, false);
	setTime(NOW + 12 * HOUR + 60_000);
	assert.equal((await store.admit(identity(), { attemptId: "run:2" })).ok, true);
	// A retest that failed for another cause leaves its trial used: the next comes six hours after its claim.
	setTime(NOW + 18 * HOUR + 59_999);
	assert.equal((await store.admit(identity(), { attemptId: "run:3" })).ok, false);
	setTime(NOW + 18 * HOUR + 60_000);
	assert.equal((await store.admit(identity(), { attemptId: "run:3" })).ok, true);
});

test("no retest for a usage read's exhaustion, Claude's included, a known reset, a required probe or a person's waiting trial", async () => {
	const later = NOW + 7 * HOUR;
	const claude = { ...identity({ connectionId: "claude-one", bucket: "anthropic:subscription" }) };
	const cases = [
		["claude-community, no reset", claude, (store) => store.record(claude, normalizeClaudeQuota({ five_hour: { utilization: 100 }, seven_day: { utilization: 10 }, extra_usage: { is_enabled: false } }, { observedAt: NOW }))],
		["a provider refusal beside a usage read's exhausted row", identity(), async (store) => { await store.record(identity(), refusal(NOW - 1)); await store.record(identity(), normalizeClaudeQuota({ five_hour: { utilization: 100 } }, { observedAt: NOW })); }],
		["a known reset", identity(), (store) => store.record(identity(), refusal(NOW, { resetAt: NOW + 7 * 86_400_000 }))],
		["a required probe", identity(), async (store) => { await store.record(identity(), refusal()); await store.invalidate(identity(), { observedAt: NOW }); }],
		["a person's trial not yet used", identity(), async (store) => { await store.record(identity(), refusal()); await store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "person" }); }],
	];
	for (const [name, who, seed] of cases) {
		const { store, setTime } = fixture();
		await seed(store);
		setTime(later);
		assert.equal((await store.read(who)).retestAt, null, name);
	}
	// Each refusing case also refuses an attempt (the person's trial is that attempt's own admission instead).
	for (const [name, who, seed] of cases.slice(0, 4)) {
		const { store, setTime } = fixture();
		await seed(store);
		setTime(later);
		assert.equal((await store.admit(who, { attemptId: "run:1" })).ok, false, name);
	}
});

test("only the attempt holding the trial clears its refusals, and only when none is newer than its claim", async () => {
	const { store, redis, setTime } = fixture();
	await store.record(identity(), refusal());
	setTime(NOW + 6 * HOUR);
	await store.admit(identity(), { attemptId: "run:1" });
	setTime(NOW + 6 * HOUR + 1000);
	assert.equal((await store.clearTrialEvidence(identity(), { attemptId: "run:2", observedAt: NOW + 6 * HOUR + 1000 })).reason, "subscription-stale-state");
	assert.equal((await store.read(identity())).state, "exhausted");
	const before = stored(redis);
	rewrite(redis, (state) => ({ ...state, observedAt: NOW + 6 * HOUR + 1, windows: state.windows.map((row) => ({ ...row, observedAt: NOW + 6 * HOUR + 1 })) }));
	assert.equal((await store.clearTrialEvidence(identity(), { attemptId: "run:1", observedAt: NOW + 6 * HOUR + 1000 })).reason, "subscription-stale-evidence", "a refusal newer than the claim stays");
	redis.rows.set(subscriptionQuotaKey(identity()), JSON.stringify(before));
	const cleared = await store.clearTrialEvidence(identity(), { attemptId: "run:1", observedAt: NOW + 6 * HOUR + 1000 });
	assert.equal(cleared.ok, true);
	assert.deepEqual([cleared.status.state, cleared.status.retestAt, stored(redis).trial, stored(redis).windows], ["unknown", null, null, []]);
	assert.deepEqual(await store.admit(identity(), { attemptId: "run:3" }).then((row) => [row.ok, row.reason]), [true, "subscription-unknown"]);
	assert.equal((await store.clearTrialEvidence(identity(), { attemptId: "run:1", observedAt: NOW + 6 * HOUR + 2000 })).ok, false, "a second clear finds no trial");
});

test("a person's trial claimed by this build clears the same way; one claimed by an older build, with no claim time, clears nothing", async () => {
	const { store, redis, setTime } = fixture();
	await store.record(identity(), refusal());
	await store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "person" });
	setTime(NOW + 1000);
	assert.equal((await store.admit(identity(), { attemptId: "run:1" })).reason, "subscription-trial");
	assert.deepEqual([stored(redis).trial.auto, stored(redis).trial.claimedAt], [undefined, NOW + 1000]);
	const claimed = stored(redis);
	setTime(NOW + 2000);
	rewrite(redis, (state) => ({ ...state, trial: { id: state.trial.id, usedBy: state.trial.usedBy } }));
	assert.equal((await store.clearTrialEvidence(identity(), { attemptId: "run:1", observedAt: NOW + 2000 })).reason, "subscription-stale-state");
	assert.equal((await store.read(identity())).state, "exhausted");
	redis.rows.set(subscriptionQuotaKey(identity()), JSON.stringify(claimed));
	assert.equal((await store.clearTrialEvidence(identity(), { attemptId: "run:1", observedAt: NOW + 2000 })).ok, true);
});

test("stored trials of both shapes read back, and malformed ones refuse the whole state", async () => {
	const { store, redis } = fixture();
	await store.record(identity(), refusal());
	await store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "person" });
	const base = stored(redis);
	const usedBy = "a".repeat(64);
	for (const trial of [{ id: base.trial.id, usedBy: null }, { id: base.trial.id, usedBy }, { id: base.trial.id, usedBy, claimedAt: NOW }, { id: base.trial.id, usedBy, auto: true, claimedAt: NOW }]) {
		redis.rows.set(subscriptionQuotaKey(identity()), JSON.stringify({ ...base, trial }));
		assert.equal((await store.read(identity())).state, "exhausted", JSON.stringify(trial));
	}
	for (const trial of [{ id: base.trial.id, usedBy, auto: false, claimedAt: NOW }, { id: base.trial.id, usedBy, auto: true }, { id: base.trial.id, usedBy: null, claimedAt: NOW }, { id: base.trial.id, usedBy, claimedAt: -1 }, { id: base.trial.id, usedBy, claimedAt: "soon" }]) {
		redis.rows.set(subscriptionQuotaKey(identity()), JSON.stringify({ ...base, trial }));
		await assert.rejects(store.read(identity()), { code: "subscription-store-invalid" }, JSON.stringify(trial));
	}
});

test("a clear or a give-back never touches a trial while a probe is required, and a clear's time lies between the claim and now", async () => {
	const { store, redis, setTime } = fixture();
	await store.record(identity(), refusal());
	setTime(NOW + 6 * HOUR);
	await store.admit(identity(), { attemptId: "run:1" });
	const claimed = stored(redis);
	setTime(NOW + 6 * HOUR + 1000);
	assert.equal((await store.clearTrialEvidence(identity(), { attemptId: "run:1", observedAt: NOW + 6 * HOUR + 1001 })).reason, "subscription-stale-state", "a time after now");
	assert.equal((await store.clearTrialEvidence(identity(), { attemptId: "run:1", observedAt: NOW + 6 * HOUR - 1 })).reason, "subscription-stale-state", "a time before the claim");
	await assert.rejects(store.clearTrialEvidence(identity(), { attemptId: "run:1" }), { code: "subscription-invalid-observation" });
	await store.invalidate(identity(), { observedAt: NOW + 6 * HOUR + 1000 });
	assert.equal((await store.clearTrialEvidence(identity(), { attemptId: "run:1", observedAt: NOW + 6 * HOUR + 1000 })).reason, "subscription-stale-state");
	assert.equal((await store.releaseTrial(identity(), { attemptId: "run:1" })).reason, "subscription-stale-state");
	assert.deepEqual([stored(redis).trial, stored(redis).windows.length], [claimed.trial, 1], "the trial and the refusal are as they were");
});

test("a clear deletes only a provider's refusals: a person's trial on a Claude connection keeps its usage-read rows", async () => {
	const claudeId = identity({ connectionId: "claude-one", bucket: "anthropic:subscription" });
	const { store, redis, setTime } = fixture();
	await store.record(claudeId, normalizeClaudeQuota({ five_hour: { utilization: 20 }, seven_day: { utilization: 30 }, extra_usage: { is_enabled: false } }, { observedAt: NOW - 1 }));
	await store.record(claudeId, normalizeSubscriptionQuotaError({ provider: "anthropic", code: "usage_limit_reached", status: 429 }, { observedAt: NOW }));
	assert.equal((await store.grantOneTrial(claudeId, { expectedVersion: 2, actorKind: "person" })).ok, true);
	setTime(NOW + 1000);
	assert.equal((await store.admit(claudeId, { attemptId: "run:1" })).reason, "subscription-trial");
	assert.equal((await store.clearTrialEvidence(claudeId, { attemptId: "run:1", observedAt: NOW + 1000 })).ok, true);
	const rows = JSON.parse(redis.rows.get(subscriptionQuotaKey(claudeId))).windows;
	assert.deepEqual(rows.map((row) => [row.id, row.usedPercent]), [["five-hour", 20], ["seven-day", 30]]);
});

test("a give-back drops an automatic trial and makes a person's unused again, under the clear's guards", async () => {
	const { store, redis, setTime } = fixture();
	await store.record(identity(), refusal());
	setTime(NOW + 6 * HOUR);
	await store.admit(identity(), { attemptId: "run:1" });
	assert.equal((await store.releaseTrial(identity(), { attemptId: "run:2" })).reason, "subscription-stale-state", "only the attempt holding it");
	await assert.rejects(store.releaseTrial(identity(), {}), { code: "subscription-invalid-trial" });
	const claimed = stored(redis);
	rewrite(redis, (state) => ({ ...state, observedAt: NOW + 6 * HOUR + 1, windows: state.windows.map((row) => ({ ...row, observedAt: NOW + 6 * HOUR + 1 })) }));
	setTime(NOW + 6 * HOUR + 1);
	assert.equal((await store.releaseTrial(identity(), { attemptId: "run:1" })).reason, "subscription-stale-evidence", "a refusal newer than the claim keeps it");
	redis.rows.set(subscriptionQuotaKey(identity()), JSON.stringify(claimed));
	const released = await store.releaseTrial(identity(), { attemptId: "run:1" });
	assert.deepEqual([released.ok, stored(redis).trial, released.status.retestAt], [true, null, NOW + 6 * HOUR]);
	// A person's trial given back waits for the next pickup, as the person authorized.
	const person = fixture();
	await person.store.record(identity(), refusal());
	await person.store.grantOneTrial(identity(), { expectedVersion: 1, actorKind: "person" });
	person.setTime(NOW + 1000);
	await person.store.admit(identity(), { attemptId: "run:1" });
	const grant = stored(person.redis).trial.id;
	assert.equal((await person.store.releaseTrial(identity(), { attemptId: "run:1" })).ok, true);
	assert.deepEqual(stored(person.redis).trial, { id: grant, usedBy: null });
	assert.equal((await person.store.read(identity())).trialAvailable, true);
});

function runtimeWorld() {
	let clock = NOW;
	const redis = fakeRedis();
	const quota = makeSubscriptionQuotaStore({ redis, now: () => clock });
	const row = { id: "chatgpt-one", connectionId: "chatgpt-one", provider: "openai", ownerHost: "worker-one", adapter: "openai-chatgpt", accountGroup: "12345678-1234-1234-1234-123456789abc", generation: 1 };
	const world = { redis, quota, row, binding: row, at: (value) => { clock = value; }, now: () => clock };
	const auth = { check: async (provider) => provider === "openai" ? { ok: true, managed: true, ...world.binding } : { ok: true, managed: false }, prepareSnapshot: async () => ({ ok: true, snapshot: { ...row, deadlineAt: clock + 1_800_000 } }), validateSnapshot: async () => true, status: async () => [row] };
	world.runtime = makeSubscriptionRuntime({ auth, quota, now: () => clock, lookup: () => ({ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }) });
	world.status = () => quota.read(subscriptionIdentity(row));
	return world;
}
const JOB = { provider: "openai", model: "gpt-6.1-sol", models: ["openai/gpt-6.1-sol"], maxCostMicros: 500_000 };
const REFUSED = { code: 1, exitLineCode: 1, exitAuth: "verified", aborted: false, providerFailure: { kind: "quota-exhausted", subscriptionCode: CODE, subscriptionProvider: "openai" } };
const exit = (code, models, extra = {}) => ({ code, exitLineCode: code, exitAuth: "verified", aborted: false, tokens: { metered: true, calls: models.reduce((n, row) => n + row.calls, 0) }, ...(models.length ? { usage: { v: 1, truncated: 0, models } } : {}), ...extra });
const OPENAI = (calls, output) => ({ provider: "openai", model: "gpt-6.1-sol", calls, output });
/** A connection latched by a refusal, its retest claimed by attempt `a:1:0` six hours on. */
async function retesting() {
	const world = runtimeWorld();
	assert.deepEqual(await world.runtime.observe(JOB, REFUSED, [world.row]), { quotaExhausted: true });
	assert.equal((await world.runtime.prepare(JOB, { attemptId: "a:0:0" })).wait, "subscription-quota");
	world.at(NOW + 6 * HOUR);
	world.prepared = await world.runtime.prepare(JOB, { attemptId: "a:1:0" });
	assert.equal(world.prepared.ok, true);
	world.at(NOW + 6 * HOUR + 60_000);
	return world;
}

test("through the runtime: a refusal latches, the retest admits one pickup, and an answered exit clears the block", async () => {
	const world = await retesting();
	assert.equal((await world.runtime.prepare(JOB, { attemptId: "b:0:0" })).wait, "subscription-quota", "one pickup per retest");
	const clean = exit(0, [OPENAI(1, 12)]);
	// Settles nothing: unverified, a code the container did not end with, aborted, unmetered, calls that returned no
	// output, another attempt, a quota or rate-limit failure on any provider (one read from prose names none).
	for (const [result, attemptId] of [[{ ...clean, exitAuth: "unverified" }, "a:1:0"], [{ ...clean, exitLineCode: 1 }, "a:1:0"], [{ ...clean, aborted: true }, "a:1:0"], [{ ...clean, tokens: { metered: false } }, "a:1:0"], [exit(0, [OPENAI(2, 0)]), "a:1:0"], [clean, "b:0:0"], [exit(1, [OPENAI(1, 12)], { providerFailure: { kind: "quota-exhausted" } }), "a:1:0"], [exit(1, [OPENAI(1, 12)], { providerFailure: { kind: "rate-limited", subscriptionProvider: "anthropic" } }), "a:1:0"], [exit(3, [OPENAI(1, 12)]), "a:1:0"]]) {
		assert.deepEqual(await world.runtime.settleTrial(JOB, result, world.prepared.snapshots, { attemptId }), [], JSON.stringify(result));
		assert.deepEqual([(await world.status()).state, (await world.status()).trialClaimedAt], ["exhausted", NOW + 6 * HOUR]);
	}
	assert.deepEqual(await world.runtime.settleTrial(JOB, { ...clean, code: 2, exitLineCode: 2 }, world.prepared.snapshots, { attemptId: "a:1:0" }), [{ provider: "openai", trial: "cleared" }], "a policy stop after the model answered");
	assert.equal((await world.status()).state, "unknown");
	assert.equal((await world.runtime.prepare(JOB, { attemptId: "b:0:0" })).ok, true, "the connection is open again for every pickup");
});

test("a retest that exits 1 for another cause after the provider answered clears the block, and the retry is admitted", async () => {
	const world = await retesting();
	const overloaded = exit(1, [OPENAI(2, 40)], { providerFailure: { kind: "overloaded" } });
	assert.equal(await world.runtime.observe(JOB, overloaded, world.prepared.snapshots), undefined, "an overload records nothing on the connection");
	assert.deepEqual(await world.runtime.settleTrial(JOB, overloaded, world.prepared.snapshots, { attemptId: "a:1:0" }), [{ provider: "openai", trial: "cleared" }]);
	assert.equal((await world.runtime.prepare(JOB, { attemptId: "a:2:0" })).ok, true);
});

test("a retest that never asked the provider gives the trial back, so the retest is due again at once", async () => {
	for (const [label, result] of [
		["a policy stop before any call (no ledger)", exit(2, [])],
		["a run that called only another provider", exit(0, [{ provider: "anthropic", model: "x", calls: 3, output: 9 }])],
		["an exit 1 with no call on the provider", exit(1, [OPENAI(0, 0)], { providerFailure: { kind: "overloaded" } })],
	]) {
		const world = await retesting();
		assert.equal((await world.runtime.prepare(JOB, { attemptId: "b:0:0" })).wait, "subscription-quota", label);
		assert.deepEqual(await world.runtime.settleTrial(JOB, result, world.prepared.snapshots, { attemptId: "a:1:0" }), [{ provider: "openai", trial: "released" }], label);
		const status = await world.status();
		assert.deepEqual([status.state, status.retestAt <= world.now()], ["exhausted", true], `${label}: still exhausted, the retest due`);
		assert.equal((await world.runtime.prepare(JOB, { attemptId: "b:0:0" })).ok, true, `${label}: the next pickup retests`);
	}
	// A ledger that cannot rule the provider out (the dollar settlement's rule): rows folded away, a `truncated` it did not
	// report, an `other/other` row that made calls (folded overflow and model-less calls), or no ledger on a line that
	// counted calls (a cut line). The trial stays used, and an `other/other` row's output is never that provider's answer.
	const anthropic = { provider: "anthropic", model: "x", calls: 1, output: 4 };
	const other = { provider: "other", model: "other", calls: 3, output: 120 };
	const cases = [
		["rows folded away", (() => { const r = exit(0, [anthropic]); r.usage.truncated = 1; return r; })()],
		["truncated not reported", (() => { const r = exit(0, [anthropic]); delete r.usage.truncated; return r; })()],
		["an other/other row with calls and output", exit(0, [other])],
		["an other/other row beside another provider's", exit(2, [anthropic, other])],
		["no ledger on a line that counted calls", { ...exit(0, []), tokens: { metered: true, calls: 2 } }],
	];
	for (const [label, result] of cases) {
		const world = await retesting();
		assert.deepEqual(await world.runtime.settleTrial(JOB, result, world.prepared.snapshots, { attemptId: "a:1:0" }), [], label);
		assert.deepEqual([(await world.status()).state, (await world.status()).trialClaimedAt], ["exhausted", NOW + 6 * HOUR], label);
		assert.equal((await world.runtime.prepare(JOB, { attemptId: "b:0:0" })).wait, "subscription-quota", label);
	}
});

test("a person's trial whose run may have called the provider through other/other is never handed to a second attempt", async () => {
	const world = runtimeWorld();
	await world.runtime.observe(JOB, REFUSED, [world.row]);
	assert.equal((await world.quota.grantOneTrial(subscriptionIdentity(world.row), { expectedVersion: 1, actorKind: "person" })).ok, true);
	world.at(NOW + 1000);
	const prepared = await world.runtime.prepare(JOB, { attemptId: "a:0:0" });
	assert.equal(prepared.ok, true);
	assert.deepEqual(await world.runtime.settleTrial(JOB, exit(0, [{ provider: "other", model: "other", calls: 3, output: 120 }]), prepared.snapshots, { attemptId: "a:0:0" }), []);
	assert.equal((await world.runtime.prepare(JOB, { attemptId: "b:0:0" })).wait, "subscription-quota", "the grant was used once");
	// The control: a run that provably never called it gives the grant back to the next pickup.
	assert.deepEqual(await world.runtime.settleTrial(JOB, exit(2, []), prepared.snapshots, { attemptId: "a:0:0" }), [{ provider: "openai", trial: "released" }]);
	assert.equal((await world.runtime.prepare(JOB, { attemptId: "b:0:0" })).ok, true);
});

test("a retest that meets the limit again re-latches through observe, and settling it changes nothing", async () => {
	const world = await retesting();
	assert.deepEqual(await world.runtime.observe(JOB, REFUSED, world.prepared.snapshots), { quotaExhausted: true });
	assert.deepEqual(await world.runtime.settleTrial(JOB, { ...REFUSED, tokens: { metered: true, calls: 1 }, usage: { v: 1, models: [OPENAI(1, 0)] } }, world.prepared.snapshots, { attemptId: "a:1:0" }), []);
	const status = await world.status();
	assert.deepEqual([status.state, status.trialClaimedAt, status.retestAt], ["exhausted", null, NOW + 12 * HOUR + 60_000]);
});

test("a settlement needs the snapshot's binding to still hold", async () => {
	const world = await retesting();
	world.binding = { ...world.row, generation: 2 };
	assert.deepEqual(await world.runtime.settleTrial(JOB, exit(0, [OPENAI(1, 5)]), world.prepared.snapshots, { attemptId: "a:1:0" }), []);
	assert.deepEqual(await world.runtime.settleTrial(JOB, exit(2, []), world.prepared.snapshots, { attemptId: "a:1:0" }), []);
	assert.equal((await world.status()).trialClaimedAt, NOW + 6 * HOUR);
});
