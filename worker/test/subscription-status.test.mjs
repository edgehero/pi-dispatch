import assert from "node:assert/strict";
import { test } from "node:test";
import { publishSubscriptionStatus, readSubscriptionStatus, subscriptionStatusKey } from "../src/subscription-status.mjs";

test("published status excludes private binding digests at every quota nesting", async () => {
	let published;
	await publishSubscriptionStatus({ set: async (...args) => { published = args; } }, "host1", { status: async () => ({ state: "ready", partial: false, connections: [{ id: "connection", ownerHost: "host1", accountGroup: "private-group", generation: 2, quota: { accountDigest: "private-group", bucket: "anthropic:subscription", generation: 2, state: "exhausted", until: null } }] }) });
	assert.equal(published[0], subscriptionStatusKey("host1"));
	assert.deepEqual(published.slice(2), ["PX", 90_000]);
	assert.equal(published[1].includes("private-group"), false);
	assert.equal(published[1].includes("generation"), false);
	assert.equal(JSON.parse(published[1]).connections[0].quota.state, "exhausted");
});
test("an owner's publication wins over other-host copies and is shown only once", async () => {
	const row = { id: "claude", ownerHost: "owner", state: "connected" };
	const values = { owner: { connections: [row] }, peer: { connections: [{ ...row, state: "other-host" }] } };
	const redis = { get: async (key) => JSON.stringify({ state: "ready", partial: false, ...values[key.split(":").at(-1)] }) };
	for (const hosts of [["owner", "peer"], ["peer", "owner"]]) {
		const result = await readSubscriptionStatus(redis, hosts);
		assert.equal(result.connections.length, 1);
		assert.equal(result.connections[0].state, "connected");
		assert.equal(result.partial, false);
	}
});
test("unpublished, corrupt and owner-absent status never claims a complete empty configuration", async () => {
	assert.equal((await readSubscriptionStatus({ get: async () => null }, ["host1"])).partial, true);
	assert.equal((await readSubscriptionStatus({ get: async () => "{" }, ["host1"])).partial, true);
	const result = await readSubscriptionStatus({ get: async () => JSON.stringify({ state: "ready", connections: [{ id: "claude", ownerHost: "owner", state: "connected" }] }) }, ["peer"]);
	assert.equal(result.partial, true);
	assert.equal(result.connections[0].state, "other-host");
});

test("maximum supported connection and window status roundtrips without losing exhaustion", async () => {
	const { SUBSCRIPTION_CONNECTION_LIMIT } = await import("../src/subscription-limits.mjs");
	const { SUBSCRIPTION_QUOTA_LIMITS } = await import("../src/subscription-quota.mjs");
	const connections = Array.from({ length: SUBSCRIPTION_CONNECTION_LIMIT }, (_, i) => ({ id: `connection-${i}`, provider: "anthropic", ownerHost: "host1", state: "connected", quota: { state: "exhausted", until: null, extraUsage: { enabled: false }, windows: Array.from({ length: SUBSCRIPTION_QUOTA_LIMITS.windows }, (_, j) => ({ id: `scope-${j}-${"a".repeat(100)}`, window: "seven-day", scope: "scoped", usedPercent: 100, resetAt: null, observedAt: 1_800_000_000_000, fresh: true, state: "exhausted" })) } }));
	let payload;
	const redis = { set: async (_key, value) => { payload = value; }, get: async () => payload };
	await publishSubscriptionStatus(redis, "host1", { status: async () => ({ state: "ready", partial: false, connections }) });
	assert.ok(Buffer.byteLength(payload) > 131_072, "the old reader ceiling rejected valid maximum-size states");
	const read = await readSubscriptionStatus(redis, ["host1"]);
	assert.equal(read.partial, false);
	assert.deepEqual(read.connections, connections);
	assert.equal(read.connections.flatMap(row => row.quota.windows).length, SUBSCRIPTION_CONNECTION_LIMIT * SUBSCRIPTION_QUOTA_LIMITS.windows);
});

test("publisher and reader share the same explicit payload ceiling", async () => {
	const { SUBSCRIPTION_STATUS_BYTES } = await import("../src/subscription-status.mjs");
	const oversized = { state: "ready", partial: false, connections: [], padding: "x".repeat(SUBSCRIPTION_STATUS_BYTES) };
	let writes = 0;
	await assert.rejects(() => publishSubscriptionStatus({ set: async () => writes++ }, "host1", { status: async () => oversized }), /exceeds its bounds/);
	assert.equal(writes, 0);
	const read = await readSubscriptionStatus({ get: async () => JSON.stringify(oversized) }, ["host1"]);
	assert.equal(read.partial, true);
	assert.deepEqual(read.connections, []);
});

test("the bounded host read explicitly reports omitted hosts", async () => {
	let reads = 0;
	const view = await readSubscriptionStatus({ get: async () => (reads++, JSON.stringify({ state: "ready", partial: false, connections: [] })) }, Array.from({ length: 65 }, (_, i) => `host${i}`));
	assert.equal(reads, 64);
	assert.equal(view.partial, true);
});
