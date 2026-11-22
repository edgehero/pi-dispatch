import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { DEFER_FIELDS, deferKey, parseDefer } from "../src/defer-reasons.mjs";
import { identityForModelSelection, readModelSelection } from "../src/model-selection-state.mjs";
import { makeSubscriptionQuotaStore, normalizeClaudeQuota, subscriptionQuotaKey, SUBSCRIPTION_QUOTA_LIMITS } from "../src/subscription-quota.mjs";
import { makeSubscriptionRuntime, subscriptionIdentity, QUOTA_RESERVE_RECHECK_MS } from "../src/subscription-runtime.mjs";
import { deferRecordOf, withDeferRecords } from "./helpers/defer-redis.mjs";
import { modelSelectionRedis } from "./helpers/model-selection-redis.mjs";

// Issue #1008: the quota reserve at pickup, through the real processor, the real subscription runtime and the real quota
// store. A random pool passes over a Claude candidate the reserve holds at its first draw, exactly as over an exhausted
// one; a committed draw waits on it; and the wait is recorded as `subscription-reserve`, in a real Valkey too.

const NOW = Date.UTC(2030, 0, 1);
const DAY = 86_400_000;
const iso = (at) => new Date(at).toISOString();
const reading = (utilization) => ({ five_hour: { utilization: 10, resets_at: iso(NOW + 3 * 3_600_000) }, seven_day: { utilization, resets_at: iso(NOW + 2 * DAY) }, extra_usage: { is_enabled: false } });

function subscriptions({ redis, clock, accountGroup = "12345678-1234-4234-8234-123456789abc", connectionId = "claude-main" }) {
	const claude = { id: connectionId, connectionId, provider: "anthropic", ownerHost: "owner", adapter: "pi-anthropic-oauth@0.3.6", accountGroup, generation: 1, state: "connected", active: true };
	const quota = makeSubscriptionQuotaStore({ redis, now: () => clock.at });
	let fresh = reading(30);
	const snapshots = [];
	const auth = {
		check: async (provider) => provider === "anthropic" ? { ok: true, managed: true, ...claude } : { ok: true, managed: false },
		status: async () => [claude],
		usage: async () => ({ kind: "observation", observedAt: clock.at, ...claude, payload: fresh }),
		prepareSnapshot: async (provider) => (snapshots.push(provider), { ok: true, snapshot: { ...claude, kind: "subscription", expiresAt: clock.at + DAY, deadlineAt: clock.at + 1_800_000, env: { ANTHROPIC_OAUTH_TOKEN: "access" } } }),
		validateSnapshot: async () => true,
	};
	const runtime = makeSubscriptionRuntime({
		auth, quota, now: () => clock.at, quotaReservePercent: 85,
		lookup: (provider) => ({ api: provider === "anthropic" ? "anthropic-messages" : "openai-responses", baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1" }),
		packageRootFor: () => ({ root: "/opt/pi-global/packages/claude", digest: "a".repeat(64) }),
	});
	return {
		runtime, quota, snapshots, identity: subscriptionIdentity(claude),
		seed: (utilization) => quota.record(subscriptionIdentity(claude), normalizeClaudeQuota(reading(utilization), { observedAt: clock.at })),
		setUsage(utilization) { fresh = reading(utilization); },
	};
}

function pickup({ redis, runtime, clock, data, id = "reserve-j" }) {
	const seen = [];
	const records = [];
	const processor = makeProcessor({
		redis, cancelJob: () => {}, stopContainer: () => {}, now: () => clock.at,
		getSettings: () => ({ provider: "openai", model: "default", maxTurns: 5, dailyCap: 10, concurrency: 3, softHoldPct: null }),
		modelEndpoints: () => [], overlayModels: () => null, recordRun: (record) => records.push(record),
		deps: { imagePreflight: async () => ({ ok: true, capabilities: ["exitAuth", "modelPolicy", "modelFailover", "costCap"] }), now: new Date(clock.at), checkFailoverCandidate: async () => null, randomInt: () => 0, mintToken: async () => (seen.push("mint"), "token"), isDefaultBranchProtected: async () => true, prepareWorkspace: async () => (seen.push("clone"), { workspaceDir: "/w", jobDir: "/j" }), cleanup: async () => {}, comment: async () => {}, log: () => {}, runContainer: async (ctx) => { seen.push(ctx.job); return { code: 0, aborted: false }; }, subscriptionRuntime: runtime },
	});
	const queued = { queueName: "github", id, timestamp: clock.at, attemptsMade: 0, name: "github", data: { kind: "github", repo: "org/repo", flow: "fix", trigger: { matched: { index: 0, type: "label", label: "go" } }, ...data }, moveToDelayed: async (until) => seen.push({ delayed: until }) };
	return { queued, seen, records, run: () => processor(queued, "lock", new AbortController().signal) };
}

const pool = ["openai/gpt-a", "anthropic/claude-b"];
const poolData = { models: pool, modelSelection: { strategy: "random", candidates: pool }, modelSelectionGeneration: "12345678-1234-4234-8234-123456789abc", maxCostUsd: "1" };

test("a random pool's first draw passes over the Claude candidate the reserve holds and draws the API-key one", async () => {
	const clock = { at: NOW };
	const redis = withDeferRecords(modelSelectionRedis());
	const sub = subscriptions({ redis, clock });
	await sub.seed(91);
	const p = pickup({ redis, runtime: sub.runtime, clock, data: poolData });
	const result = await p.run();
	assert.equal(result.outcome, "completed");
	assert.equal(result.model, "gpt-a", "the shuffle put the Claude candidate first; the reserve passed over it");
	assert.deepEqual(p.seen.filter((value) => value?.model).map((value) => value.models), [["openai/gpt-a"]]);
	assert.deepEqual(sub.snapshots, [], "no subscription credential for a draw that bills an API key");
	assert.equal((await readModelSelection(redis, identityForModelSelection(p.queued))).ref, "openai/gpt-a");
});

test("a committed Claude draw held at prepare waits on the reserve, and keeps waiting rather than drawing again", async () => {
	const clock = { at: NOW };
	const redis = withDeferRecords(modelSelectionRedis());
	const sub = subscriptions({ redis, clock });
	// Under the reserve, and stale: the draw and its recheck pass, and prepare reads usage, which is now over it.
	await sub.seed(40);
	clock.at = NOW + SUBSCRIPTION_QUOTA_LIMITS.freshMs + 60_000;
	sub.setUsage(88);
	const p = pickup({ redis, runtime: sub.runtime, clock, data: { ...poolData, maxCostUsd: undefined, models: ["anthropic/claude-b"], modelSelection: { strategy: "random", candidates: ["anthropic/claude-b"] } } });
	await assert.rejects(p.run, { name: "DelayedError" });
	assert.deepEqual(p.seen, [{ delayed: clock.at + QUOTA_RESERVE_RECHECK_MS }], "nothing minted, cloned or started");
	assert.deepEqual(sub.snapshots, []);
	const record = deferRecordOf(redis, p.queued.id);
	assert.deepEqual([record.why, record.bucket, record.until, record.resetAt], ["subscription-reserve", "check", clock.at + QUOTA_RESERVE_RECHECK_MS, NOW + 2 * DAY]);
	const id = identityForModelSelection(p.queued);
	assert.deepEqual([(await readModelSelection(redis, id)).phase, (await readModelSelection(redis, id)).ref], ["selected", "anthropic/claude-b"]);
	// The next pickup finds the fresh reading over the reserve at the committed draw itself, and waits again.
	clock.at += QUOTA_RESERVE_RECHECK_MS;
	await assert.rejects(p.run, { name: "DelayedError" });
	const again = deferRecordOf(redis, p.queued.id);
	assert.deepEqual([again.why, again.until, again.resetAt], ["subscription-reserve", clock.at + 60_000, NOW + 2 * DAY], "the random selector's own recheck, with the reset");
	assert.equal((await readModelSelection(redis, id)).phase, "selected", "the reserve is not exhaustion: no quota reselection");
	assert.equal(p.seen.filter((value) => value?.model).length, 0);
});

test("a fallback list whose every candidate the reserve holds waits within a minute, and its record names the reset", async () => {
	const clock = { at: NOW };
	const redis = withDeferRecords(modelSelectionRedis());
	const sub = subscriptions({ redis, clock });
	await sub.seed(90);
	const p = pickup({ redis, runtime: sub.runtime, clock, data: { provider: "anthropic", model: "claude-a", models: ["anthropic/claude-a", "anthropic/claude-b"], fallbackModels: ["anthropic/claude-b"] } });
	await assert.rejects(p.run, { name: "DelayedError" });
	assert.deepEqual(p.seen, [{ delayed: NOW + 60_000 }], "the fallback selector's own recheck");
	const record = deferRecordOf(redis, p.queued.id);
	assert.deepEqual([record.why, record.until, record.resetAt], ["subscription-reserve", NOW + 60_000, NOW + 2 * DAY]);
	assert.deepEqual(sub.snapshots, []);
});

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("subscription-reserve-pickup REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");

test("real Valkey: the reserve's wait is recorded as subscription-reserve, from the pickup check and from prepare", { skip: url ? false : "needs VALKEY_TEST_URL", timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	t.after(() => redis.disconnect());
	const keys = [];
	try {
		for (const stage of ["pickup check", "prepare"]) {
			const clock = { at: NOW };
			const sub = subscriptions({ redis, clock, connectionId: `claude-${randomUUID()}` });
			keys.push(subscriptionQuotaKey(sub.identity));
			await sub.seed(stage === "prepare" ? 40 : 93);
			if (stage === "prepare") {
				clock.at = NOW + SUBSCRIPTION_QUOTA_LIMITS.freshMs + 60_000;
				sub.setUsage(93);
			}
			const p = pickup({ redis, runtime: sub.runtime, clock, id: `reserve-${randomUUID()}`, data: { provider: "anthropic", model: "claude-b", models: ["anthropic/claude-b"] } });
			keys.push(deferKey(p.queued.id));
			await assert.rejects(p.run, { name: "DelayedError" }, stage);
			const record = parseDefer(await redis.hmget(deferKey(p.queued.id), ...DEFER_FIELDS));
			assert.deepEqual([record.why, record.known, record.bucket, record.until, record.resetAt, record.trigger], ["subscription-reserve", true, "check", clock.at + QUOTA_RESERVE_RECHECK_MS, NOW + 2 * DAY, 0], stage);
			assert.ok((await redis.pttl(deferKey(p.queued.id))) > 0, "the record expires with its wait");
			assert.deepEqual(sub.snapshots, [], stage);
		}
	} finally {
		await redis.del(...keys);
	}
});
