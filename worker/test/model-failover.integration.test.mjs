import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

// The Lua compare-and-set is the concurrency boundary. A hand-rolled fake cannot establish its atomicity.
// Every key belongs to this test; no flush or scan touches another deployment sharing the test server.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("model-failover.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const skip = url ? false : "needs VALKEY_TEST_URL";

test("model cooldown Lua keeps the longest concurrent reset and the real key's bounded TTL", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const { MODEL_COOLDOWN_MAX_MS, markModelCooldown, modelCooldownKey, readModelCooldown } = await import("../src/model-failover.mjs");
	const clients = Array.from({ length: 8 }, () => makeRedisClient(url, {}));
	t.after(() => clients.forEach((client) => client.disconnect()));
	const ref = `integration/m-${randomBytes(8).toString("hex")}`;
	const at = Date.UTC(2026, 9, 28, 12);
	try {
		const resets = [60_000, 120_000, MODEL_COOLDOWN_MAX_MS * 2, 30_000, 90_000, 10_000, 1_000, 1_800_000];
		await Promise.all(clients.map((client, i) => markModelCooldown(client, ref, { kind: "rate-limited", resetAt: at + resets[i] }, { now: () => at })));
		assert.deepEqual(await readModelCooldown(clients[0], ref, { now: () => at }), { ref, kind: "rate-limited", until: at + MODEL_COOLDOWN_MAX_MS });
		const ttl = await clients[0].pttl(modelCooldownKey(ref));
		assert.ok(ttl > 0 && ttl <= MODEL_COOLDOWN_MAX_MS, `bounded real TTL: ${ttl}`);
		assert.equal(await readModelCooldown(clients[0], ref, { now: () => at + MODEL_COOLDOWN_MAX_MS }), null, "expiry is judged by the injected clock too");
	} finally {
		await clients[0].del(modelCooldownKey(ref));
	}
});

test("attempt safety survives a long queue pause without a TTL and locks the previously selected fallback", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const { modelAttemptKey, readModelAttempt, selectFailoverJob, writeModelAttempt } = await import("../src/model-failover.mjs");
	const redis = makeRedisClient(url, {});
	t.after(() => redis.disconnect());
	const id = `integration:${randomBytes(8).toString("hex")}`;
	const at = Date.UTC(2026, 9, 28, 12);
	try {
		await writeModelAttempt(redis, id, { ref: "openai/fallback", safe: false, modelWhy: "fallback-cooldown" });
		assert.equal(await redis.pttl(modelAttemptKey(id)), -1, "a delayed retry can outlive any chosen TTL");
		assert.equal((await readModelAttempt(redis, id)).safe, false);
		const selection = await selectFailoverJob({ provider: "anthropic", model: "primary", models: ["anthropic/primary", "openai/fallback"], fallbackModels: ["openai/fallback"] }, {
			redis, id, retry: true, now: () => at + 90 * 24 * 60 * 60 * 1000, checkCandidate: async () => null,
		});
		assert.equal(selection.ref, "openai/fallback");
		assert.equal(selection.job.modelWhy, "fallback-cooldown");
	} finally {
		await redis.del(modelAttemptKey(id));
	}
});
