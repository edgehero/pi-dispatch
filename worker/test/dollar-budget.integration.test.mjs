import assert from "node:assert/strict";
import { test } from "node:test";
import { reserveDollars, settleDollars } from "../src/dollar-budget.mjs";

// The dollar windows against a real Valkey (issue #501): INCRBY's atomicity is the whole concurrency argument, so it is
// measured here, not assumed. Gated on VALKEY_TEST_URL; in CI PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a missing URL
// into a hard failure. Each run uses its own key prefix and deletes its keys, so it never touches a live deployment's.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("dollar-budget.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "needs VALKEY_TEST_URL";
const USD = 1_000_000;

test("20 parallel $2 reservations against a $10 window never admit more than 5, and after settling the counter is the sum settled (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	t.after(() => redis.disconnect());
	const keyPrefix = `pi-dispatch-test-usd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const now = new Date("2026-10-11T23:59:59Z");
	const ledgers = [{ keyPrefix, caps: { day: 10 * USD, week: 10 * USD, month: null } }];
	try {
		// One client per reservation, so the INCRBYs genuinely race on the server rather than queueing on one socket.
		const clients = Array.from({ length: 20 }, () => makeRedisClient(url, {}));
		t.after(() => clients.forEach((c) => c.disconnect()));
		const results = await Promise.all(clients.map((c) => reserveDollars(c, { ledgers, amountMicros: 2 * USD, now })));
		const admitted = results.filter((r) => r.allowed);
		assert.ok(admitted.length <= 5, `admitted ${admitted.length}`);
		assert.ok(admitted.length >= 1, "at least the first fits");
		const day = `${keyPrefix}:2026-10-11`;
		const week = `${keyPrefix}:w:2026-10-05`;
		assert.equal(Number(await redis.get(day)), admitted.length * 2 * USD, "every refusal gave back what it added");
		assert.ok((await redis.ttl(day)) > 0, "the day key has its TTL");
		// Settle each to a different metered amount, in parallel, with the clock already past midnight: the hold decides.
		const settled = admitted.map((_, i) => 123_457 * (i + 1));
		await Promise.all(admitted.map((r, i) => settleDollars(clients[i], r.hold, settled[i])));
		const sum = settled.reduce((a, b) => a + b, 0);
		assert.equal(Number(await redis.get(day)), sum);
		assert.equal(Number(await redis.get(week)), sum);
		assert.equal(await redis.exists(`${keyPrefix}:2026-10-12`), 0, "nothing landed on the next day");
	} finally {
		const keys = await redis.keys(`${keyPrefix}*`);
		if (keys.length > 0) await redis.del(...keys);
	}
});

test("SETTLE_SCRIPT on a real Valkey: a missing key is skipped (never recreated), a result below 0 is clamped and keeps its TTL", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	t.after(() => redis.disconnect());
	const keyPrefix = `pi-dispatch-test-usd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const now = new Date("2026-10-07T12:00:00Z");
	try {
		const { hold } = await reserveDollars(redis, { ledgers: [{ keyPrefix, caps: { day: 10 * USD, week: 10 * USD, month: null } }], amountMicros: 2 * USD, now });
		const [day, week] = hold.keys;
		await redis.del(day); // expired or evicted
		await redis.set(week, 300_000, "KEEPTTL"); // an edit left less than the hold
		const logged = [];
		assert.deepEqual(await settleDollars(redis, hold, 100_000, { log: (e, f) => logged.push([e, f]) }), { applied: 2, of: 2 });
		assert.equal(await redis.exists(day), 0, "not recreated");
		assert.equal(Number(await redis.get(week)), 0, "clamped at 0");
		assert.ok((await redis.ttl(week)) > 0, "and still expires");
		assert.deepEqual(logged.map((l) => l[0]), ["dollar_settle_key_missing", "dollar_settle_clamped"]);
	} finally {
		const keys = await redis.keys(`${keyPrefix}*`);
		if (keys.length > 0) await redis.del(...keys);
	}
});
