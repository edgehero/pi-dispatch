import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The mirror's trim script (`TRIM_SCRIPT`, issue #599) against a real Valkey: the fake in run-mirror.test.mjs restates
 * it step for step, so only a live server can say the Lua does what the fake does. Skips cleanly without
 * VALKEY_TEST_URL, and refuses to skip when CI requires the worker's integration tests. Every key is under a prefix
 * of its own and deleted after.
 */
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("run-mirror.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "VALKEY_TEST_URL not set; run mirror integration skipped locally";

test("the trim script trims by age and count, raises the horizon by GT only when it removed something, and expires both keys at the deepest window", { skip }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const { MIRROR_MAX_DAYS, RUNS_HORIZON_MEMBER, TRIM_SCRIPT } = await import("../src/run-mirror.mjs");
	const redis = makeRedisClient(url);
	const tag = `pi-test-trim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const index = `${tag}:index`;
	const horizon = `${tag}:horizon`;
	const ttl = MIRROR_MAX_DAYS * 24 * 3600 * 1000;
	const trim = (cutoff, cap) => redis.eval(TRIM_SCRIPT, 2, index, horizon, cutoff, cap, ttl, RUNS_HORIZON_MEMBER);
	try {
		await redis.zadd(index, 1_000_000_000_100, "a", 1_000_000_000_200, "b", 1_000_000_000_300, "c");
		assert.equal(await trim(1_000_000_000_000, 10), null, "nothing removed: no horizon");
		assert.equal(await redis.exists(horizon), 0);
		assert.ok((await redis.pttl(index)) > ttl - 60_000, "the index expires at the deepest window");

		assert.equal(await trim(1_000_000_000_150, 10), "1000000000150", "by age: the cutoff");
		assert.deepEqual(await redis.zrange(index, 0, -1), ["b", "c"]);
		assert.equal(await redis.zscore(horizon, RUNS_HORIZON_MEMBER), "1000000000150");
		assert.ok((await redis.pttl(horizon)) > ttl - 60_000);

		assert.equal(await trim(1_000_000_000_000, 1), "1000000000300", "by count: the oldest that remains");
		assert.equal(await redis.zscore(horizon, RUNS_HORIZON_MEMBER), "1000000000300");
		await redis.zadd(index, 1_000_000_000_050, "old", 1_000_000_000_400, "d");
		await trim(1_000_000_000_060, 10);
		assert.equal(await redis.zscore(horizon, RUNS_HORIZON_MEMBER), "1000000000300", "GT: a lower cut never lowers it");
	} finally {
		await redis.del(index, horizon);
		await redis.quit();
	}
});
