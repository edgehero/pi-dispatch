import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthService, AUTH_RENEWABLE_MARGIN_MS, AUTH_RENEWABLE_MIN_RUNWAY_MS } from "../src/auth-connections.mjs";
import { makeSubscriptionRuntime } from "../src/subscription-runtime.mjs";
import { makeCredentialRefresher } from "../src/credential-refresh.mjs";
import { installSubscriptionCredentials } from "../../image/runner/src/subscription-credentials.mjs";
import { createCredentialRefresher, parseCredentialDrop } from "../../image/runner/src/credential-refresh.mjs";

const MIN = 60_000;
const BASE = 1_800_000_000_000;
const model = { provider: "openai", id: "fixture", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
const job = { provider: "openai", model: "fixture", models: ["openai/fixture"] };
function harness({ access = null } = {}) {
	const h = { t: BASE, access, refreshes: [], admissions: 0, writes: [], stops: [], logs: [] };
	const now = () => h.t;
	let saved = null;
	let tail = Promise.resolve();
	const store = { read: () => saved, transaction(id, fn) {
		const result = tail.then(() => fn(saved, async (row) => { saved = row; }));
		tail = result.catch(() => {});
		return result;
	} };
	const credential = () => ({ access: h.access ?? `opaque.lease.${h.t}`, refresh: `private.grant.${h.t}`, expires: h.t + 60 * MIN, earliestRefreshAt: h.t + 54 * MIN });
	const policy = { version: 1, connections: [{ id: "fixture", provider: "openai", adapter: "openai-chatgpt", ownerHost: "owner" }], bindings: { openai: "fixture" } };
	h.auth = createAuthService({ policy, host: "owner", store, now, adapters: { "openai-chatgpt": {
		login: async () => credential(), refresh: async ({ credential: previous }) => {
			assert.ok(h.t >= previous.earliestRefreshAt, "never rotate early");
			h.refreshes.push(h.t);
			return credential();
		},
	} } });
	h.runtime = makeSubscriptionRuntime({ auth: h.auth, now, lookup: () => model, quota: { admit: async (_identity, { consumeTrial }) => { if (consumeTrial) h.admissions++; return { ok: true }; } } });
	h.now = now;
	return h;
}

test("every minute of the token hour admits a renewable job, while legacy admission still requires full coverage", async () => {
	for (let minute = 0; minute < 60; minute++) {
		const h = harness(); await h.auth.login("fixture"); h.t += minute * MIN;
		const result = await h.runtime.prepare(job, { deadlineAt: h.t + 30 * MIN, renewable: true });
		assert.equal(result.ok, true, `token age ${minute}`);
		const [snapshot] = result.snapshots;
		assert.ok(snapshot.expiresAt > snapshot.deadlineAt + AUTH_RENEWABLE_MARGIN_MS);
		assert.ok(snapshot.deadlineAt > h.t + AUTH_RENEWABLE_MIN_RUNWAY_MS);
		assert.equal(await h.runtime.validate(result.snapshots), true);
		assert.equal(h.refreshes.length, minute >= 54 ? 1 : 0);
	}
	const h = harness(); await h.auth.login("fixture"); h.t += 25 * MIN;
	const legacy = await h.runtime.prepare(job, { deadlineAt: h.t + 30 * MIN });
	assert.equal(legacy.wait, "subscription-auth");
	assert.equal(legacy.until, BASE + 54 * MIN);
});

test("real host lifecycle and runner guard keep requests usable through three hours and multiple rotations", async () => {
	for (const start of [0, 4, 23, 24, 25, 53, 54]) {
		const h = harness(); await h.auth.login("fixture"); h.t += start * MIN;
		const { snapshots } = await h.runtime.prepare(job, { deadlineAt: h.t + 30 * MIN, renewable: true });
		const entries = snapshots.map((s) => ({ ...s }));
		class Runtime { async getAuth() { return {}; } async prepareRequest(model, options) { return { model, options }; } }
		const env = { ...snapshots[0].env };
		const guard = installSubscriptionCredentials({ ModelRuntime: Runtime, entries, env, now: h.now });
		let drop = null;
		const runner = createCredentialRefresher({ read: () => drop, subscriptions: guard, env });
		const host = makeCredentialRefresher({ subscriptions: snapshots, now: h.now,
			extend: (s, options) => h.runtime.extend(s, options),
			write: (payload) => { drop = parseCredentialDrop(JSON.stringify(payload)); h.writes.push(drop); },
			onExpired: (kind) => h.stops.push(kind), log: (event) => h.logs.push(event),
		});
		try {
			// Offset the minute checks from token issuance; delivery follows one poll later.
			for (let elapsed = 0; elapsed <= 180 * MIN; elapsed += 15_000) {
				h.t = BASE + start * MIN + elapsed;
				runner.apply();
				if (elapsed % MIN === 15_000) await host.check();
				const request = await new Runtime().prepareRequest(model, {});
				assert.equal(request.options.apiKey, env.OPENAI_API_KEY);
			}
			assert.deepEqual(h.stops, [], `start age ${start}`);
			assert.ok(h.refreshes.length >= 3);
			assert.equal(h.admissions, 1, "extensions never admit quota or claim a trial");
			assert.ok(!h.logs.includes("credential_renew_failed"), "waiting for eligibility is ordinary");
		} finally { host.stop(); runner.stop(); guard.uninstall(); }
	}
});

test("renewable admission and final validation require access that the unchanged-token drop can deliver", async () => {
	for (const length of [7, 8, 4096, 4097]) {
		const access = "a".repeat(length);
		const h = harness({ access }); await h.auth.login("fixture");
		const options = { deadlineAt: h.t + 30 * MIN };
		const legacy = await h.auth.prepareSnapshot("openai", options);
		assert.equal(legacy.ok, true, "the provider/store's existing token range stays valid for legacy admission");
		const supported = length >= 8 && length <= 4096;
		assert.equal(await h.auth.validateSnapshot({ ...legacy.snapshot, renewable: true }), supported, `final validation, length ${length}`);
		const result = await h.runtime.prepare(job, { ...options, renewable: true });
		assert.equal(result.ok, supported, `admission, length ${length}`);
		if (!supported) {
			assert.equal(result.reason, "auth-capability-unsupported");
			assert.equal(result.unavailable, false, "a known transport limit is a policy refusal, never a retry");
			assert.equal(result.snapshots, undefined);
			assert.equal(JSON.stringify(result).includes(access), false);
			assert.deepEqual(h.refreshes, [], "a fresh bearer is not rotated to work around a transport limit");
			continue;
		}
		const host = makeCredentialRefresher({ now: h.now, subscriptions: result.snapshots, extend: (s, opts) => h.runtime.extend(s, opts), write: (drop) => h.writes.push(drop) });
		h.t += 20 * MIN;
		await host.check();
		const drop = parseCredentialDrop(JSON.stringify(h.writes[0]));
		assert.equal(drop.subscriptions[0].token, access, "the first lease extension reuses the admitted bearer");
		class Runtime { async getAuth() { return {}; } async prepareRequest(model, options) { return { model, options }; } }
		const guard = installSubscriptionCredentials({ ModelRuntime: Runtime, entries: result.snapshots.map((s) => ({ ...s })), env: { OPENAI_API_KEY: access }, now: h.now });
		try { assert.equal(guard.refresh(drop.subscriptions[0]), true, "the actual runner guard accepts the published extension"); }
		finally { guard.uninstall(); host.stop(); }
	}
});

test("a rotation that exceeds the drop's token limit remains durable before renewable admission refuses", async () => {
	const h = harness(); await h.auth.login("fixture");
	h.t += 54 * MIN;
	h.access = "a".repeat(4097);
	const options = { deadlineAt: h.t + 30 * MIN };
	const result = await h.auth.prepareSnapshot("openai", { ...options, renewable: true });
	assert.equal(result.ok, false);
	assert.equal(result.reason, "auth-capability-unsupported");
	assert.equal(result.unavailable, false);
	assert.equal((await h.auth.status())[0].state, "connected", "delivery incompatibility must not discard a rotated grant");
	const legacy = await h.auth.prepareSnapshot("openai", options);
	assert.equal(legacy.ok, true);
	assert.equal(legacy.snapshot.env.OPENAI_API_KEY, h.access);
	assert.equal(legacy.snapshot.generation, 2);
	assert.equal(h.refreshes.length, 1, "the saved replacement is reused, never rotated twice");
});

test("startup validation refuses a lease consumed by preparation, including the exact runway boundary", async () => {
	const h = harness(); await h.auth.login("fixture"); h.t += 53 * MIN;
	const { snapshots } = await h.runtime.prepare(job, { deadlineAt: h.t + 30 * MIN, renewable: true });
	h.t = snapshots[0].deadlineAt - AUTH_RENEWABLE_MIN_RUNWAY_MS - 1;
	assert.equal(await h.runtime.validate(snapshots), true);
	h.t++;
	assert.equal(await h.runtime.validate(snapshots), false);
});

test("a hanging forge renewal cannot prevent subscription delivery or expiry supervision", async () => {
	const h = harness(); await h.auth.login("fixture");
	const { snapshots } = await h.runtime.prepare(job, { deadlineAt: h.t + 30 * MIN, renewable: true });
	let finish;
	const host = makeCredentialRefresher({ now: h.now, subscriptions: snapshots,
		forge: { expiresAt: BASE + 30 * MIN, mint: () => new Promise((resolve) => { finish = resolve; }) },
		extend: (s, options) => h.runtime.extend(s, options),
		write: (drop) => h.writes.push(drop), onExpired: (kind) => h.stops.push(kind),
	});
	h.t = BASE + 20 * MIN;
	const pending = host.check();
	for (let i = 0; i < 50 && h.writes.length === 0; i++) await Promise.resolve();
	assert.equal(h.writes.length, 1, "subscription published while mint is unanswered");
	h.t = BASE + 28 * MIN;
	host.checkExpiry();
	assert.deepEqual(h.stops, ["forge-token"]);
	finish({ token: "late-forge-token", expiresAt: BASE + 90 * MIN });
	await pending;
	assert.equal(h.writes.length, 1, "late renewal cannot resurrect an expired run");
	host.stop();
});

test("failed secret registration prevents a drop; stopping discards an in-flight replacement", async () => {
	let t = BASE + 20 * MIN, finish;
	const writes = [];
	const snapshot = { provider: "openai", connectionId: "fixture", generation: 1, expiresAt: BASE + 60 * MIN, deadlineAt: BASE + 30 * MIN, env: { OPENAI_API_KEY: "original" } };
	const host = makeCredentialRefresher({ now: () => t, subscriptions: [snapshot],
		extend: async (s, { deadlineAt }) => ({ ...s, deadlineAt, env: { OPENAI_API_KEY: "replacement" } }),
		onCredentials: () => { throw new Error("collector unavailable"); }, write: (drop) => writes.push(drop),
	});
	await host.check();
	assert.equal(writes.length, 0);
	assert.equal(host.state.delivered.subscriptions[0], snapshot.deadlineAt);
	host.stop();
	const other = makeCredentialRefresher({ now: () => t, subscriptions: [snapshot], extend: () => new Promise((resolve) => { finish = resolve; }), write: (drop) => writes.push(drop) });
	const pending = other.check(); await Promise.resolve(); other.stop();
	finish({ ...snapshot, deadlineAt: t + 30 * MIN });
	await pending;
	assert.equal(writes.length, 0);
});
