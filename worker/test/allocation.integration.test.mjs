import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAllocationState } from "../src/allocation.mjs";
import { envelopeDigest, parseEnvelope } from "../src/envelope.mjs";

// The applied split against a real Valkey (issue #504 part B): the compare-and-set is a Lua script that decodes the
// stored state with cjson, and the lock is SET NX PX, so the race between two writers is measured here, not assumed.
// Gated on VALKEY_TEST_URL; in CI PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a missing URL into a hard failure. Each run
// uses its own key prefix and deletes its keys, so it never touches a deployment's `alloc:*`.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("allocation.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "needs VALKEY_TEST_URL";
const NOW = Date.parse("2026-10-05T12:00:00Z");
const PROJECTS = [
	{ id: "shop", members: ["github:acme/web"] },
	{ id: "platform", members: ["github:acme/infra"] },
];
const envelope = parseEnvelope(
	JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10" }, defaultWeights: { _other: 0 }, delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 0, maxPlanDays: 14 } }),
	"/e/envelope.json",
	{ projects: PROJECTS, maxCostMicros: 1_000_000 },
);
const digest = envelopeDigest(envelope);
const plan = (shop, platform, basis = null) => JSON.stringify({ version: 1, basis, projects: [{ id: "shop", weight: shop }, { id: "platform", weight: platform }, { id: "_other", weight: 0 }] });

test("two applies racing on one basis: exactly one applies, the other is plan-stale or plan-busy, and the state is the winner's (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const prefix = `pi-dispatch-test-alloc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const admin = makeRedisClient(url, {});
	t.after(() => admin.disconnect());
	// One client per host, so the commands genuinely race on the server rather than queueing on one socket.
	const a = makeRedisClient(url, {});
	const b = makeRedisClient(url, {});
	t.after(() => {
		a.disconnect();
		b.disconnect();
	});
	try {
		for (let round = 0; round < 10; round++) {
			const keys = await admin.keys(`${prefix}*`);
			if (keys.length > 0) await admin.del(...keys);
			const rows = [];
			const audit = { append: (row) => rows.push(row) };
			const mini1 = makeAllocationState({ redis: a, host: "mini1", audit, prefix });
			const mini2 = makeAllocationState({ redis: b, host: "mini2", audit, prefix });
			await mini1.reconcile({ envelope, digest, now: NOW });
			const [r1, r2] = await Promise.all([
				mini1.applyPlan({ envelope, digest, projects: PROJECTS, text: plan(3, 1), writer: { kind: "operator-session" }, now: NOW }),
				mini2.applyPlan({ envelope, digest, projects: PROJECTS, text: plan(1, 3), writer: { kind: "portfolio-job", jobId: "j1" }, now: NOW }),
			]);
			const outcomes = [r1, r2].map((r) => r.outcome);
			assert.equal(outcomes.filter((o) => o === "applied").length, 1, `round ${round}: ${JSON.stringify([r1, r2])}`);
			const loser = [r1, r2].find((r) => r.outcome !== "applied");
			assert.ok(["plan-stale", "plan-busy"].includes(loser.reason), `round ${round}: ${loser.reason}`);
			const winner = [r1, r2].find((r) => r.outcome === "applied");
			const state = JSON.parse(await admin.get(`${prefix}:plan`));
			assert.equal(state.planId, winner.planId, "the state is the winner's, written by the CAS");
			assert.equal(await admin.exists(`${prefix}:lock`), 0, "the winner released its own lock");
			assert.equal(rows.filter((r) => r.outcome === "applied").length, 1);
		}
	} finally {
		const keys = await admin.keys(`${prefix}*`);
		if (keys.length > 0) await admin.del(...keys);
	}
});

test("the CAS script on a real Valkey: a stale id or digest writes nothing, the current pair writes (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const { CAS_SCRIPT, SEED_SCRIPT } = await import("../src/allocation.mjs");
	const prefix = `pi-dispatch-test-alloc-cas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const redis = makeRedisClient(url, {});
	t.after(() => redis.disconnect());
	const key = `${prefix}:plan`;
	try {
		await redis.set(key, JSON.stringify({ version: 1, planId: null, envelopeDigest: "d1" }));
		assert.equal(Number(await redis.eval(CAS_SCRIPT, 1, key, "", "d2", '{"x":1}')), 0, "another digest");
		assert.equal(Number(await redis.eval(CAS_SCRIPT, 1, key, "abc", "d1", '{"x":1}')), 0, "another id");
		assert.equal(Number(await redis.eval(CAS_SCRIPT, 1, key, "", "d1", '{"x":2}')), 1, "a null id is the empty string, and the pair matches");
		assert.equal(await redis.get(key), '{"x":2}');
		await redis.set(key, "{ not json");
		assert.equal(Number(await redis.eval(CAS_SCRIPT, 1, key, "", "d1", '{"x":3}')), 0, "a value that does not decode is never overwritten by the CAS");
		// The seed script: replaces that value only while it is exactly what was read, and sets expected beside it,
		// overwriting a stale one; SET NX on an absent plan does the same, and a present plan is left alone.
		const expected = `${prefix}:envelope:expected`;
		// Replacing an UNREADABLE plan keeps the expected digest beside it: it still names the fleet's envelope.
		await redis.set(expected, "fleet");
		assert.equal(Number(await redis.eval(SEED_SCRIPT, 2, key, expected, '{"seed":1}', "d9", "eq", "{ not json")), 1);
		assert.deepEqual([await redis.get(key), await redis.get(expected)], ['{"seed":1}', "fleet"]);
		await redis.set(key, "{ not json");
		await redis.del(expected);
		assert.equal(Number(await redis.eval(SEED_SCRIPT, 2, key, expected, '{"seed":1}', "d9", "eq", "{ not json")), 1);
		assert.equal(await redis.get(expected), "d9", "and seeds it when there is none");
		assert.equal(Number(await redis.eval(SEED_SCRIPT, 2, key, expected, '{"seed":2}', "d8", "nx", "")), 0, "a present plan is never seeded over");
		assert.equal(await redis.get(expected), "d9", "and expected is untouched then");
		await redis.del(key);
		await redis.set(expected, "stale");
		assert.equal(Number(await redis.eval(SEED_SCRIPT, 2, key, expected, '{"seed":3}', "d7", "nx", "")), 1);
		assert.equal(await redis.get(expected), "d7", "a stale expected never survives a new seed");
	} finally {
		await redis.del(key, `${prefix}:envelope:expected`);
	}
});
