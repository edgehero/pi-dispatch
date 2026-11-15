import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createAuthService } from "../src/auth-connections.mjs";
import { createAuthStore } from "../src/auth-store.mjs";
import { makeCredentialRefresher } from "../src/credential-refresh.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const MIN = 60_000;
const BASE = 1_800_000_000_000;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("a timed-out rotation persists its replacement, occupies its lane until settled and is reused without rotating twice", async () => {
	let at = BASE;
	const now = () => at;
	const started = deferred(), replacement = deferred(), settled = deferred();
	let rotations = 0;
	const store = createAuthStore({ dir: join(tempDir("renewal-supervision-"), "private") });
	const auth = createAuthService({
		policy: { version: 1, connections: [{ id: "owner", provider: "openai", adapter: "openai-chatgpt", ownerHost: "host" }], bindings: { openai: "owner" } },
		host: "host", store, now,
		adapters: { "openai-chatgpt": {
			login: async () => ({ access: "original.opaque.access", refresh: "original.private.grant", expires: BASE + 60 * MIN, earliestRefreshAt: BASE + 54 * MIN }),
			refresh: async ({ signal }) => { rotations++; started.resolve(signal); return replacement.promise; },
		} },
	});
	await auth.login("owner");
	at = BASE + 53 * MIN;
	const { snapshot } = await auth.prepareSnapshot("openai", { deadlineAt: at + 30 * MIN, renewable: true });
	let timeout = new AbortController();
	const writes = [], stops = [];
	const refresher = makeCredentialRefresher({
		subscriptions: [snapshot], now, renewalTimeout: () => timeout.signal,
		extend: async (_snapshot, options) => { try { return (await auth.prepareSnapshot("openai", { ...options, renewable: true, extending: true })).snapshot; } finally { settled.resolve(); } },
		write: (payload) => writes.push(payload), onExpired: (kind) => stops.push(kind),
	});
	at = BASE + 54 * MIN;
	const checking = refresher.check();
	const grantSignal = await started.promise;
	assert.equal(store.read("owner").state, "refresh-uncertain");
	timeout.abort();
	await checking;
	assert.equal(grantSignal.aborted, false, "the caller timeout cannot discard a rotating grant");
	await refresher.check();
	assert.equal(rotations, 1, "the timed-out lane is still occupied while persistence is pending");
	replacement.resolve({ access: "replacement.opaque.access", refresh: "replacement.private.grant", expires: at + 60 * MIN, earliestRefreshAt: at + 54 * MIN });
	await settled.promise;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(store.read("owner").state, "connected");
	assert.equal(store.read("owner").credential.refresh, "replacement.private.grant");
	assert.equal(writes.length, 0, "the timed-out result never publishes late");
	timeout = new AbortController();
	await refresher.check();
	assert.equal(rotations, 1);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].subscriptions[0].token, "replacement.opaque.access");
	assert.deepEqual(stops, []);
	refresher.stop();
});

test("one unanswered subscription does not block another subscription or expiry supervision", async () => {
	let at = BASE + 20 * MIN;
	const now = () => at;
	const stopped = [], written = [], started = deferred(), pending = deferred();
	const snapshots = [
		{ provider: "openai", connectionId: "chatgpt", generation: 1, deadlineAt: BASE + 30 * MIN, expiresAt: BASE + 60 * MIN, env: { OPENAI_API_KEY: "original.openai.access" } },
		{ provider: "anthropic", connectionId: "claude", generation: 1, deadlineAt: BASE + 30 * MIN, expiresAt: BASE + 60 * MIN, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-original" } },
	];
	const refresher = makeCredentialRefresher({ subscriptions: snapshots, now,
		extend: (snapshot, { deadlineAt }) => {
			if (snapshot.provider === "openai") { started.resolve(); return pending.promise; }
			return { ...snapshot, deadlineAt, expiresAt: deadlineAt + 30 * MIN, env: { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-replacement" } };
		},
		write: (payload) => written.push(payload), onExpired: (kind) => stopped.push(kind),
	});
	const checking = refresher.check();
	await started.promise;
	for (let i = 0; i < 20 && written.length === 0; i++) await Promise.resolve();
	assert.equal(written.length, 1);
	assert.equal(written[0].subscriptions[1].token, "sk-ant-oat-replacement");
	at = BASE + 28 * MIN;
	refresher.checkExpiry();
	assert.deepEqual(stopped, ["subscription"]);
	pending.resolve({ ...snapshots[0], deadlineAt: BASE + 60 * MIN });
	await checking;
	assert.equal(written.length, 1, "an expired run cannot publish a delayed answer");
	refresher.stop();
});
