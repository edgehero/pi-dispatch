import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSandboxTelemetry } from "../src/host-telemetry.mjs";
import { sandboxDeadline } from "../src/sandbox-store.mjs";
import { makeSandboxInventory, readSandboxInventories, sandboxInventoryKey, sandboxInventorySettings, sandboxManifestGeneration, SANDBOX_INVENTORY_HOSTS, SANDBOX_INVENTORY_INTERVAL_MS, SANDBOX_INVENTORY_TTL_MS } from "../src/sandbox-inventory.mjs";

const instant = 1_800_000_000_000;
const settings = { image: "job:one", defaultBackend: "podman", backends: ["local", "podman"], egress: true, egressProxy: "pi-dispatch-egress", sandboxRetentionHours: 24, sandboxPinDays: 7, jobMemory: "2g", jobCpus: "1" };
const manifest = { jobId: `sb-${"a".repeat(32)}`, image: "job:one", kind: "github", backend: "podman", origin: "prepared", workspace: "/private/kept/workspace", createdAt: new Date(instant).toISOString(), prepared: { requestDigest: "b".repeat(64), repo: "private/repo", ref: "private/branch" }, project: "unverified-project", prompt: "private issue text", token: "never publish" };

function redisFake() {
	const values = new Map(), sets = new Map(), writes = [];
	return { values, sets, writes, set: async (key, value, ...args) => { values.set(key, value); writes.push([key, value, ...args]); return "OK"; }, sadd: async (key, ...members) => { if (!sets.has(key)) sets.set(key, new Set()); members.forEach((m) => sets.get(key).add(m)); }, smembers: async (key) => [...(sets.get(key) ?? [])], mget: async (...keys) => keys.map((k) => values.get(k) ?? null), srem: async (key, ...names) => names.forEach((n) => sets.get(key)?.delete(n)) };
}

test("durable inventory reuses telemetry's bounded scrubbed projection and publishes host preview facts only", async () => {
	let clock = instant;
	const redis = redisFake();
	const read = makeSandboxTelemetry({ list: () => [manifest], deadline: sandboxDeadline, retentionHours: 24, canOpen: () => true, now: () => clock });
	const inventory = makeSandboxInventory({ redis, host: "host-one", read, settings: { ...settings, token: "never-publish", jobsDir: "/private/jobs" }, now: () => clock });
	assert.equal((await inventory.publish()).published, true);
	const stored = redis.values.get(sandboxInventoryKey("host-one"));
	assert.doesNotMatch(stored, /private|workspace|prompt|token|never-publish|jobsDir|branch|unverified-project/);
	assert.deepEqual(redis.writes[0].slice(-2), ["PX", SANDBOX_INVENTORY_TTL_MS], "snapshot and expiry are one write");
	const result = await readSandboxInventories(redis, { now: () => clock });
	assert.equal(result.hosts[0].stale, false);
	assert.deepEqual(result.hosts[0].settings, settings);
	assert.deepEqual(result.hosts[0].rows, [{ id: manifest.jobId, v: "podman", until: instant + 24 * 3_600_000, pin: false, prepared: true, canOpen: true, generation: sandboxManifestGeneration(manifest), image: "job:one", kind: "github" }]);
	clock += 2 * SANDBOX_INVENTORY_INTERVAL_MS + 1;
	const old = await readSandboxInventories(redis, { now: () => clock });
	assert.equal(old.hosts[0].stale, true);
	assert.deepEqual(old.hosts[0].rows, result.hosts[0].rows, "a departed host's evidence stays explicitly stale");
	await inventory.close();
	assert.equal(redis.values.has(sandboxInventoryKey("host-one")), true, "shutdown does not erase last known kept evidence");
});

test("failed inventory reads publish unknown, never falsely empty, and malformed/newer records stay unknown", async () => {
	const redis = redisFake();
	const inventory = makeSandboxInventory({ redis, host: "host-one", read: () => { throw new Error("disk private detail"); }, settings, now: () => instant });
	await inventory.publish();
	assert.equal((await readSandboxInventories(redis, { now: () => instant })).hosts[0].unreadable, true);
	for (const value of ["{", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, host: "other", at: instant, rows: [], more: 0, retentionHours: 24 }), JSON.stringify({ version: 1, host: "host-one", at: instant, rows: [{ id: "../evil" }], more: 0, retentionHours: 24 })]) {
		redis.values.set(sandboxInventoryKey("host-one"), value);
		const host = (await readSandboxInventories(redis, { now: () => instant })).hosts[0];
		assert.equal(host.unreadable, true);
		assert.equal(host.rows, null);
	}
	await inventory.close();
});

test("a malformed optional row fact stays unknown through telemetry, publication and durable inventory reading", async () => {
	for (const patch of [{ image: "--help" }, { kind: "private/local/path" }]) {
		const redis = redisFake();
		const read = makeSandboxTelemetry({ list: () => [{ ...manifest, ...patch }], deadline: sandboxDeadline, retentionHours: 24, now: () => instant });
		const inventory = makeSandboxInventory({ redis, host: "host-one", read, settings, now: () => instant });
		await inventory.publish();
		const host = (await readSandboxInventories(redis, { now: () => instant })).hosts[0];
		assert.equal(host.unreadable, true);
		assert.equal(host.rows, null, "a malformed row can never turn into a false empty host");
		await inventory.close();
	}
});

test("unknown hosts, truncation and future host clocks are explicit; polluted index names are never queried", async () => {
	const redis = redisFake();
	await redis.sadd(SANDBOX_INVENTORY_HOSTS, "../path", ...Array.from({ length: 70 }, (_, n) => `host-${String(n).padStart(2, "0")}`));
	const read = await readSandboxInventories(redis, { now: () => instant });
	assert.equal(read.hosts.length, 64);
	assert.equal(read.more, 6);
	assert.equal(read.hosts.some((h) => h.name === "../path"), false);
	assert.equal(read.hosts.every((h) => h.missing && h.unreadable && h.stale), true);
	const one = redisFake();
	const inv = makeSandboxInventory({ redis: one, host: "future", read: () => ({ sandboxes: "[]", sandboxesMore: "7", sandboxRetentionHours: "24" }), now: () => instant + 60_000, settings });
	await inv.publish();
	const future = (await readSandboxInventories(one, { now: () => instant })).hosts[0];
	assert.equal(future.stale, true, "a future timestamp is not an indefinitely fresh snapshot");
	assert.equal(future.more, 7);
	assert.deepEqual(future.rows, []);
	await inv.close();
});

test("bounded unresponsive Valkey calls fail visibly, and a late publish after close cannot recreate its index", async () => {
	const logs = [];
	const hang = makeSandboxInventory({ redis: { set: () => new Promise(() => {}) }, host: "host-one", read: () => ({ sandboxes: "[]" }), now: () => instant, timeoutMs: 5, log: (event, fields) => logs.push({ event, fields }) });
	assert.equal((await hang.publish()).unreachable, true);
	assert.equal((await hang.publish()).unreachable, true);
	assert.equal(logs.length, 1);
	assert.equal((await readSandboxInventories({ smembers: () => new Promise(() => {}) }, { now: () => instant, timeoutMs: 5 })).unreachable, true);
	await hang.close();
	let finish;
	const redis = redisFake();
	redis.set = () => new Promise((resolve) => { finish = resolve; });
	const inv = makeSandboxInventory({ redis, host: "host-two", read: () => ({ sandboxes: "[]" }), now: () => instant, timeoutMs: 5 });
	const writing = inv.publish();
	await new Promise((resolve) => setImmediate(resolve));
	const closing = inv.close();
	finish("OK");
	await Promise.all([writing, closing]);
	assert.deepEqual(await redis.smembers(SANDBOX_INVENTORY_HOSTS), []);
});

test("host preview settings and incarnations discard extra fields and reject invalid authority-shaped facts", () => {
	assert.deepEqual(sandboxInventorySettings({ ...settings, providerKey: "never", path: "/private" }), settings);
	for (const change of [{ image: "--help" }, { backends: ["unknown"] }, { egress: "false" }, { egressProxy: "bad/name" }, { jobMemory: "0g" }, { jobCpus: -1 }]) assert.equal(sandboxInventorySettings({ ...settings, ...change }), null);
	const initial = sandboxManifestGeneration(manifest);
	assert.equal(sandboxManifestGeneration({ ...manifest, keepUntil: "later", prompt: "changed" }), initial, "pin and private payload changes are not a new checkout");
	assert.notEqual(sandboxManifestGeneration({ ...manifest, baseSha: "c".repeat(40) }), initial);
	assert.equal(sandboxManifestGeneration({ jobId: "missing" }), null);
});
