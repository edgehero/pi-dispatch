import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Real-Valkey check of the registry reader's three PTTL fields (issue #737, host-registry.mjs `readLiveHosts`): a row
 * the registry writes reads back with its age on Valkey's clock, a row with no expiry says so, and a writer whose clock
 * is off by two minutes reads back with that skew, in both directions.
 *
 * Every host name has a unique tail, because `host:live` and `host:h:*` are not scoped to a test: each test removes
 * exactly the rows and index members it wrote, never flushes, and reads with `prune: false`, so it never removes another
 * test's member either. Skips cleanly without VALKEY_TEST_URL, and refuses to skip when CI requires the worker's
 * integration tests.
 */

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("host-registry.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "VALKEY_TEST_URL not set; host registry integration skipped locally";

let counter = 0;
const uniqueHost = (what) => `hr-${what}-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function world(t) {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const registry = await import("../src/host-registry.mjs");
	const redis = makeRedisClient(url, {});
	const names = new Set();
	const opened = [];
	t.after(async () => {
		for (const reg of opened) await reg.close().catch(() => {});
		for (const name of names) {
			await redis.del(registry.hostKey(name)).catch(() => {});
			await redis.srem(registry.HOST_SET, name).catch(() => {});
		}
		redis.disconnect();
	});
	const host = (what, opts = {}) => {
		const name = uniqueHost(what);
		names.add(name);
		const reg = registry.makeHostRegistry({ redis, name, ...opts });
		opened.push(reg);
		return { name, reg };
	};
	const row = async (name) => {
		const read = await registry.readLiveHosts(redis, { prune: false });
		assert.ok(Array.isArray(read.hosts), JSON.stringify(read));
		const found = read.hosts.find((h) => h.name === name);
		assert.ok(found, `${name} is listed`);
		return found;
	};
	return { ...registry, redis, names, host, row };
}

test("a row the registry writes has its age on Valkey's clock, no skew to claim, and an expiry (#737)", { skip }, async (t) => {
	const w = await world(t);
	const { name, reg } = w.host("fresh");
	await reg.start({ version: "test" });
	const now = await w.row(name);
	assert.equal(now.noExpiry, false);
	assert.ok(now.ttlAgeMs >= 0 && now.ttlAgeMs < 2000, `ttlAgeMs ${now.ttlAgeMs}`);
	assert.ok(Math.abs(now.skewMs) < 2000, `skewMs ${now.skewMs}`);
	// The age is Valkey's own count of the time since the PEXPIRE: it grows while nothing is written.
	await sleep(400);
	const later = await w.row(name);
	assert.ok(later.ttlAgeMs >= 350 && later.ttlAgeMs < 2400, `ttlAgeMs ${later.ttlAgeMs} after 400 ms`);
	assert.ok(Math.abs(later.skewMs) < 2000, `skewMs ${later.skewMs}`);
});

test("an index member whose row has no expiry reads noExpiry, with no age and no skew (#737)", { skip }, async (t) => {
	const w = await world(t);
	const name = uniqueHost("forever");
	w.names.add(name);
	await w.redis.hset(w.hostKey(name), "name", name, "beatAt", String(Date.now()));
	await w.redis.sadd(w.HOST_SET, name);
	assert.equal(await w.redis.pttl(w.hostKey(name)), -1, "written without a PEXPIRE (vacuous otherwise)");
	const found = await w.row(name);
	assert.deepEqual([found.noExpiry, found.ttlAgeMs, found.skewMs], [true, null, null]);
});

test("a writer whose clock is two minutes behind reads back skewed by about +120 s, and one ahead by about -120 s (#737)", { skip }, async (t) => {
	const w = await world(t);
	const behind = w.host("behind", { now: () => Date.now() - 120_000 });
	const ahead = w.host("ahead", { now: () => Date.now() + 120_000 });
	await behind.reg.start({});
	await ahead.reg.start({});
	const slow = await w.row(behind.name);
	const fast = await w.row(ahead.name);
	assert.ok(Math.abs(slow.skewMs - 120_000) < 3000, `behind: skewMs ${slow.skewMs}`);
	assert.ok(Math.abs(fast.skewMs + 120_000) < 3000, `ahead: skewMs ${fast.skewMs}`);
	assert.ok(slow.skewMs > w.HOST_SKEW_CLAIM_MS && -fast.skewMs > w.HOST_SKEW_CLAIM_MS, "both past the claim");
	// The age stays small for both: Valkey's clock is the third one, and the writers' clocks do not enter it.
	for (const r of [slow, fast]) assert.ok(r.ttlAgeMs >= 0 && r.ttlAgeMs < 2000, `ttlAgeMs ${r.ttlAgeMs}`);
	assert.equal(fast.staleMs, 0, "staleMs is unchanged: clamped for a clock ahead");
});
