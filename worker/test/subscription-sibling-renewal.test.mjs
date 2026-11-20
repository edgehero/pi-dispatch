import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthStore } from "../src/auth-store.mjs";
import { makeCredentialRefresher } from "../src/credential-refresh.mjs";

const MIN = 60_000;
const base = { provider: "anthropic", connectionId: "claude", generation: 6, expiresAt: 60 * MIN, deadlineAt: 30 * MIN, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-old" } };
const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a sibling rotation publishes before this job's renewal window, preserving its lease and registering the secret", async () => {
	let changed;
	let generation = 6;
	let closed = 0;
	const writes = [];
	const order = [];
	const h = makeCredentialRefresher({
		subscriptions: [base], now: () => 5 * MIN, timers,
		watch: (_snapshot, callback) => { changed = callback; return () => closed++; },
		current: async (snapshot) => generation > snapshot.generation ? { ...snapshot, generation, expiresAt: 8 * 60 * MIN, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-new" } } : null,
		extend: async () => assert.fail("an early synchronization must not renew the lease"),
		onCredentials: () => order.push("register"),
		write: (drop) => { order.push("write"); writes.push(drop); },
	});
	h.start(); await tick();
	assert.equal(writes.length, 0);
	generation = 7; changed(); await tick();
	assert.deepEqual(order, ["register", "write"]);
	assert.equal(writes[0].subscriptions[0].generation, 7);
	assert.equal(writes[0].subscriptions[0].deadlineAt, base.deadlineAt);
	h.stop(); changed(); await tick();
	assert.equal(closed, 1); assert.equal(writes.length, 1);
});

test("subscription synchronization cannot delay an unrelated due forge renewal", async () => {
	let release;
	const writes = [];
	const h = makeCredentialRefresher({
		now: () => 5 * MIN, subscriptions: [base],
		forge: { expiresAt: 10 * MIN, mint: async () => ({ token: "ghs_new_token", expiresAt: 65 * MIN }) },
		current: () => new Promise((resolve) => { release = resolve; }),
		write: (drop) => writes.push(drop),
	});
	const pending = h.check(); await tick();
	assert.equal(writes.length, 1); assert.equal(writes[0].forge.token, "ghs_new_token");
	release(null); await pending; h.stop();
});

test("a watch during extension runs after that lane settles and never overwrites its newer lease", async () => {
	let changed;
	let release;
	let t = 0;
	let generation = 6;
	const writes = [];
	const h = makeCredentialRefresher({
		now: () => t, subscriptions: [base], timers,
		watch: (_snapshot, callback) => { changed = callback; return () => {}; },
		current: async (snapshot) => generation > snapshot.generation ? { ...snapshot, generation, expiresAt: 8 * 60 * MIN, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-newer" } } : null,
		extend: (snapshot, { deadlineAt }) => new Promise((resolve) => { release = () => resolve({ ...snapshot, generation: 7, deadlineAt, expiresAt: 8 * 60 * MIN, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-new" } }); }),
		write: (drop) => writes.push(drop),
	});
	h.start(); await tick(); t = 20 * MIN;
	const pending = h.check(); await tick();
	generation = 8; changed(); release(); await pending; await tick();
	assert.deepEqual(writes.map((drop) => [drop.subscriptions[0].generation, drop.subscriptions[0].deadlineAt]), [[7, 50 * MIN], [8, 50 * MIN]]);
	h.stop();
});

test("failed secret registration and stop discard a sibling replacement", async () => {
	let release;
	let writes = 0;
	const h = makeCredentialRefresher({ now: () => 0, subscriptions: [base], current: () => new Promise((resolve) => { release = resolve; }), onCredentials: () => { throw new Error("collector failed"); }, write: () => writes++ });
	const pending = h.check(); await tick();
	release({ ...base, generation: 7, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-new" } }); await pending;
	assert.equal(writes, 0); assert.equal(h.state.delivered.subscriptions[0], base.deadlineAt);
	h.stop(); await h.check(); assert.equal(writes, 0);
});

test("connection watches filter lock events and report nameless/error degradation once without a read-lock loop", () => {
	let event, error;
	let closed = 0;
	const notifications = [];
	const store = createAuthStore({ dir: "/private-fixture", fs: { watch: (_dir, _options, callback) => { event = callback; return { on: (_name, callback) => { error = callback; }, close: () => closed++ }; } } });
	const stop = store.watch("claude", (value) => notifications.push(value));
	event("rename", "claude.json.lock"); event("rename", ".claude.tmp");
	event("rename", null); event("rename", undefined); error();
	event("rename", Buffer.from("claude.json"));
	assert.deepEqual(notifications, [{ watchFailed: true }, undefined]);
	stop(); assert.equal(closed, 1);
});

test("stop while a sibling snapshot read is unresolved discards its eventual credential", async () => {
	let release;
	let published = 0;
	const h = makeCredentialRefresher({ now: () => 0, subscriptions: [base], current: () => new Promise((resolve) => { release = resolve; }), onCredentials: () => published++, write: () => published++ });
	const pending = h.check(); await tick(); h.stop();
	release({ ...base, generation: 7, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-late" } });
	await pending; await tick();
	assert.equal(published, 0);
	assert.equal(h.state.subscriptions[0].generation, 6);
});
