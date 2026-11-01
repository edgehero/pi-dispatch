import assert from "node:assert/strict";
import { test } from "node:test";
import { makeReceiverObservations, makeReceiverPublisher, readReceiverStatus, receiverKey, RECEIVER_LIVE } from "../src/receiver-status.mjs";
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("receiver-status integration requires VALKEY_TEST_URL");

test("real Valkey holds one atomic expiring receiver record; deleting it changes only the display (#775)", { skip: url ? false : "VALKEY_TEST_URL not set" }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	const name = `receiver-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	const now = () => Date.now();
	const observations = makeReceiverObservations({ now }); observations.observe("github", 401);
	const publisher = makeReceiverPublisher({ client: () => redis, name, version: "4.3.1", port: 3000, bind: "all", forges: ["github"], observations, now });
	t.after(async () => { publisher.close(); await redis.del(receiverKey(name)); await redis.srem(RECEIVER_LIVE, name); redis.disconnect(); });
	publisher.beat();
	let raw;
	for (let i = 0; i < 100; i++) { raw = await redis.get(receiverKey(name)); if (raw && await redis.sismember(RECEIVER_LIVE, name)) break; await new Promise((resolve) => setTimeout(resolve, 5)); }
	assert.ok(raw); assert.equal(JSON.parse(raw).deliveries.github.unauthorized.hours.at(-1)[1], 1);
	const ttl = await redis.pttl(receiverKey(name)); assert.ok(ttl > 85_000 && ttl <= 90_000);
	const row = (await readReceiverStatus(redis, { names: [name], now })).hosts.find((h) => h.name === name);
	assert.ok(row); assert.equal(row.port, 3000); assert.ok(row.ageMs >= 0 && row.ageMs < 5000);
	await redis.del(receiverKey(name));
	assert.ok(!(await readReceiverStatus(redis, { names: [name], now })).hosts.some((h) => h.name === name));
	observations.observe("github", 202, "queued"); publisher.beat();
	for (let i = 0; i < 100; i++) { raw = await redis.get(receiverKey(name)); if (raw) break; await new Promise((resolve) => setTimeout(resolve, 5)); }
	assert.equal(JSON.parse(raw).deliveries.github.queued.hours.at(-1)[1], 1);
});
