import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { makeRedisClient } from "../src/connection.mjs";
import { readSandboxSessions, releaseSandboxSession, renewSandboxSession, requestSandboxEnd, sandboxEndKey, sandboxSessionKey, sandboxSessionTick } from "../src/sandbox-sessions.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("sandbox session integration requires VALKEY_TEST_URL");
test("real Valkey lease comparisons, expiry and End bind a shell incarnation across detach", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 });
	redis.on("error", () => {});
	const now = () => 1_800_000_000_000;
	const nonce = randomBytes(16).toString("hex");
	const session = { v: 1, host: `sb-${nonce.slice(0, 12)}`, id: `sb-${nonce}`, nonce, containerId: "b".repeat(64), venue: "podman", by: "ops", since: now(), at: now() };
	const key = sandboxSessionKey(session.host, session.id);
	try {
		assert.equal(await renewSandboxSession(redis, session, { now }), true);
		assert.ok(await redis.pttl(key) > 40_000);
		assert.equal((await readSandboxSessions(redis, { hosts: [session.host], now })).sessions.length, 1);
		const skewed = { ...session, since: now() - 90_000, at: now() - 60_000 };
		assert.equal(await renewSandboxSession(redis, skewed, { now: () => now() - 60_000 }), true);
		assert.equal((await readSandboxSessions(redis, { hosts: [session.host], now: () => now() + 86_400_000 })).sessions.length, 1, "a fresh key from a slow host remains visible to a fast console");
		await redis.set(sandboxEndKey(nonce), JSON.stringify({ ...session, requestId: nonce }), "PX", 15_000);
		await sandboxSessionTick({ redis, session, now, inspect: async () => ({ present: true, nonce, containerId: session.containerId }), stop: async () => false });
		assert.equal(await redis.get(`sandbox:ended:${nonce}:${nonce}`), "stop-failed");
		let retryStopped = false, waited = 0;
		const retryId = "c".repeat(32);
		const retried = await requestSandboxEnd({ redis, ...session, now: () => now() + 86_400_000, random: () => retryId, sleep: async () => {
			waited++;
			await sandboxSessionTick({ redis, session, now, inspect: async () => retryStopped ? { present: false } : { present: true, nonce, containerId: session.containerId }, stop: async () => (retryStopped = true) });
		} });
		assert.deepEqual(retried, { ended: true });
		assert.equal(waited, 1, "retry waits for its own acknowledgement instead of consuming the previous failure");
		await redis.del(`sandbox:ended:${nonce}:${retryId}`);
		assert.equal(await renewSandboxSession(redis, session, { now }), true);
		const later = { ...session, nonce: randomBytes(16).toString("hex"), containerId: "c".repeat(64) };
		assert.equal(await renewSandboxSession(redis, later, { now }), false);
		await redis.set(sandboxEndKey(nonce), JSON.stringify({ ...session, requestId: nonce }), "PX", 15_000);
		let stopped = false;
		const result = await sandboxSessionTick({ redis, session, now, inspect: async () => stopped ? { present: false } : { present: true, nonce, containerId: session.containerId }, stop: async (id) => (assert.equal(id, session.containerId), stopped = true) });
		assert.equal(result.ended, true);
		assert.equal(await redis.get(key), null);
		assert.equal(await renewSandboxSession(redis, later, { now }), true);
		await releaseSandboxSession(redis, session);
		assert.equal(JSON.parse(await redis.get(key)).nonce, later.nonce, "an old owner cannot delete a replacement");
		assert.equal((await requestSandboxEnd({ redis, ...session, now })).refused, "session-changed");
		await redis.del(key);
		assert.equal((await readSandboxSessions(redis, { hosts: [session.host], now })).sessions.length, 0, "an expired key is absent even if its index survives");
	} finally {
		await redis.del(key, sandboxEndKey(nonce), `sandbox:ended:${nonce}:${nonce}`);
		await redis.zrem("sandbox:shells", `${session.host}:${key.split(":").at(-1)}`);
		redis.disconnect();
	}
});
