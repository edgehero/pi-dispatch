import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRedisClient } from "../src/connection.mjs";
import { makeTouchStore, TOUCH_INDEX, TOUCH_META, TOUCH_PENDING, touchEventKey } from "../src/touch-state.mjs";
import { computeZeroTouch } from "../src/zero-touch.mjs";
import { buildRecord } from "../src/run-history.mjs";
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("touch-state.integration requires VALKEY_TEST_URL");
const skip = url ? false : "VALKEY_TEST_URL not set";
const NOW = Date.UTC(2026, 9, 30, 12);
const DAY = 86400_000;

test("the real scripts count fleet events once, retain pending uncertainty and reset their coverage after index loss", { skip }, async () => {
	const redis = makeRedisClient(url);
	const prefix = `pi-test-touch-${Math.random().toString(16).slice(2)}:`;
	let now = NOW - 40 * DAY;
	const store = makeTouchStore({ redis, prefix, now: () => now, retentionDays: 90 });
	try {
		assert.deepEqual(await store.initialize(), { ok: true });
		now = NOW;
		const e = { runId: "first", cause: "steer", at: NOW - DAY, nonce: "message-1" };
		const pending = await store.begin(e);
		assert.equal(pending.ok, true);
		const unresolved = await store.read();
		assert.deepEqual(unresolved.coverage.reasons, ["touch-actions-unresolved"]);
		const source = buildRecord({ job: { id: "first", data: { kind: "local", folder: "/repo" } }, result: { outcome: "completed" }, endedAt: new Date(NOW - DAY).toISOString(), touchTracking: true });
		const unknown = computeZeroTouch({ records: [source], events: unresolved.events, coverage: unresolved.coverage, nowMs: now });
		assert.equal(unknown.totals.rate, null, "a possibly applied intervention is not classified as an untouched run");
		assert.equal(unknown.totals.runs, 0);
		assert.equal((await store.write(e)).added, true);
		assert.equal((await store.write(e)).added, false);
		await store.write({ runId: "second", cause: "rerun", at: NOW - 2 * DAY, nonce: "other-host" });
		let read = await store.read();
		assert.equal(read.events.length, 2);
		assert.equal(read.coverage.fromMs, NOW - 40 * DAY);
		assert.equal(read.coverage.partial, false);
		assert.equal(await redis.hlen(prefix + TOUCH_PENDING), 0);
		const ttl = await redis.pttl(prefix + touchEventKey(pending.event.id));
		assert.ok(ttl <= 90 * DAY && ttl > 90 * DAY - 60_000);
		await redis.del(prefix + TOUCH_INDEX);
		read = await store.read();
		assert.deepEqual(read.events, []);
		assert.equal(read.coverage.fromMs, now, "missing events are unknown before any new event repairs the epoch");
		assert.equal(read.coverage.partial, true);
		assert.deepEqual(read.coverage.reasons, ["touch-index-lost"]);
		now += DAY;
		await store.write({ runId: "new", cause: "cancel", at: now, nonce: "after-loss" });
		read = await store.read();
		assert.equal(read.events.length, 1);
		assert.equal(read.coverage.fromMs, now, "a surviving old meta key does not vouch for a lost index");
		await redis.del(prefix + TOUCH_META);
		assert.equal((await store.read()).coverage.partial, true);
	} finally {
		const keys = await redis.keys(`${prefix}*`);
		if (keys.length) await redis.del(...keys);
		await redis.quit();
	}
});

test("an expired event body is explicit missing coverage, never a zero-touch observation", { skip }, async () => {
	const redis = makeRedisClient(url);
	const prefix = `pi-test-touch-expiry-${Math.random().toString(16).slice(2)}:`;
	const store = makeTouchStore({ redis, prefix, now: () => NOW });
	try {
		const row = await store.write({ runId: "lost", cause: "steer", at: NOW - DAY });
		await redis.del(prefix + touchEventKey(row.event.id));
		const read = await store.read();
		assert.equal(read.events.length, 0);
		assert.equal(read.coverage.fromMs, NOW);
		assert.deepEqual(read.coverage.reasons, ["touch-events-missing"]);
	} finally {
		const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys);
		await redis.quit();
	}
});
