import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRedisClient } from "../src/connection.mjs";
import { GATEWAY_AUTH_MS, GATEWAY_SCRIPTS, gatewayHash, gatewayRandom, makeGatewayStore } from "../src/sandbox-gateway-protocol.mjs";
const observe = async store => { const clock = await store.observeTime(); assert.equal(clock.ok, true); return clock.nowMs; };

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("gateway protocol integration requires VALKEY_TEST_URL");
// Redis is the injected clock/TTL authority. No fixed JS instant is paired with production Date.now.
test("real Valkey binds independent proofs, atomically consumes grants and fences every window generation", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 }); redis.on("error", () => {});
	const prefix = `gateway-test:${gatewayRandom().replaceAll("-", "_")}:`;
	const store = makeGatewayStore({ redis, prefix });
	const actor = { name: "ops", role: "operator", session: "a".repeat(12) };
	const target = { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "podman" };
	const input = () => ({ intentId: gatewayRandom(), owner: gatewayRandom(), handoffHash: gatewayHash(handoff), target, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example", theme: "dark" });
	let handoff = gatewayRandom();
	try {
		const first = input();
		assert.equal((await store.createIntent(first)).ok, true);
		assert.equal((await store.bindIntent({ intentId: first.intentId, handoff: gatewayRandom(), browserHash: gatewayHash("attacker"), gatewayOrigin: first.gatewayOrigin, host: target.host })).refused, "handoff-invalid");
		assert.equal((await store.authorizeIntent({ intentId: first.intentId, owner: first.owner, actor, observedAt: await observe(store) })).refused, "intent-unavailable", "public intent plus operator identity cannot skip binding");
		const attempts = await Promise.all(["browser", "attacker"].map((who) => store.bindIntent({ intentId: first.intentId, handoff, browserHash: gatewayHash(who), gatewayOrigin: first.gatewayOrigin, host: target.host })));
		assert.equal(attempts.filter((r) => r.ok).length, 1);
		const browserHash = attempts.find((r) => r.ok).intent.browserHash;
		assert.equal((await store.authorizeIntent({ intentId: first.intentId, owner: gatewayRandom(), actor, observedAt: await observe(store) })).refused, "intent-unavailable");
		assert.equal((await store.authorizeIntent({ intentId: first.intentId, owner: first.owner, actor, observedAt: await observe(store) })).ok, true);
		assert.equal((await store.redeem({ intentId: first.intentId, browserHash: gatewayHash("wrong"), connectionId: gatewayRandom() })).refused, "grant-unavailable");
		const connectionId = gatewayRandom();
		const races = await Promise.all([connectionId, gatewayRandom()].map((id) => store.redeem({ intentId: first.intentId, browserHash, connectionId: id })));
		assert.equal(races.filter((r) => r.ok).length, 1);
		const owner = races.find((r) => r.ok).intent.connectionId;
		assert.ok(races.find((r) => r.ok).authRemainingMs > 0);
		assert.equal((await store.renewAttachment({ intentId: first.intentId, browserHash, connectionId: owner })).ok, true);
		handoff = gatewayRandom(); const second = input();
		assert.equal((await store.createIntent(second)).ok, true);
		assert.equal((await store.bindIntent({ intentId: second.intentId, handoff, browserHash, gatewayOrigin: second.gatewayOrigin, host: target.host })).ok, true);
		assert.equal((await store.authorizeIntent({ intentId: second.intentId, owner: second.owner, actor, observedAt: await observe(store) })).ok, true);
		assert.equal((await store.redeem({ intentId: second.intentId, browserHash, connectionId: gatewayRandom() })).refused, "window-busy");
		assert.equal((await store.release({ intentId: first.intentId, connectionId: gatewayRandom() })).refused, "window-lost");
		assert.equal((await store.renewAttachment({ intentId: first.intentId, browserHash, connectionId: owner })).ok, true, "wrong-generation cleanup cannot erase current window");
		await redis.del(`${prefix}auth:${first.intentId}`);
		assert.equal((await store.renewAuthorization({ intentId: first.intentId, owner: first.owner, observedAt: await observe(store) })).refused, "authorization-expired", "a delayed renewal never resurrects expired authority");
		assert.equal((await store.renewAttachment({ intentId: first.intentId, browserHash, connectionId: owner })).refused, "authorization-expired");
		assert.equal((await store.release({ intentId: first.intentId, connectionId: owner, reason: "session-ended" })).ok, true);
		assert.equal((await store.redeem({ intentId: second.intentId, browserHash, connectionId: gatewayRandom() })).refused, "grant-unavailable", "losing a window consumed the competing grant");
	} finally {
		const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); redis.disconnect();
	}
});

test("server-clock expiry refuses stale handoffs and abandoned grants despite continuing broker renewals", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 }); redis.on("error", () => {});
	const prefix = `gateway-test:${gatewayRandom().replaceAll("-", "_")}:`, store = makeGatewayStore({ redis, prefix });
	const handoff = gatewayRandom(), intentId = gatewayRandom(), owner = gatewayRandom();
	const config = { intentId, owner, handoffHash: gatewayHash(handoff), target: { host: "host-a", id: "run", nonce: "a".repeat(32), containerId: "c".repeat(64), venue: "local" }, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example" };
	const expire = async (field) => redis.eval(`local m=cjson.decode(redis.call('GET',KEYS[1])); local t=redis.call('TIME'); m[ARGV[1]]=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL'); return 1`, 1, `${prefix}intent:${intentId}`, field);
	try {
		await store.createIntent(config); await expire("handoffUntil");
		assert.equal((await store.bindIntent({ intentId, handoff, browserHash: gatewayHash("browser"), gatewayOrigin: config.gatewayOrigin, host: config.target.host })).refused, "handoff-expired");
		await redis.del(`${prefix}intent:${intentId}`); await store.createIntent(config);
		await store.bindIntent({ intentId, handoff, browserHash: gatewayHash("browser"), gatewayOrigin: config.gatewayOrigin, host: config.target.host });
		await store.authorizeIntent({ intentId, owner, actor: { name: "ops", role: "operator", session: "a".repeat(12) }, observedAt: await observe(store) });
		await expire("grantUntil");
		assert.equal((await store.renewAuthorization({ intentId, owner, observedAt: await observe(store) })).refused, "authorization-expired");
		assert.equal((await store.redeem({ intentId, browserHash: gatewayHash("browser"), connectionId: gatewayRandom() })).refused, "grant-unavailable");
	} finally { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); redis.disconnect(); }
});

test("a timed-out delayed write cannot extend authority beyond its immutable pre-judgment Redis instant", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 }); redis.on("error", () => {});
	const prefix = `gateway-test:${gatewayRandom().replaceAll("-", "_")}:`, ordinary = makeGatewayStore({ redis, prefix });
	const actor = { name: "ops", role: "operator", session: "a".repeat(12) };
	const target = { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "c".repeat(64), venue: "local" };
	let delayedScript, executeLate, clock;
	// The transport is injected. Only the authority command stalls; authoritative time is sampled
	// through the ordinary client before the current judgment, without a short positive RTT fuse.
	const transport = { eval: (script, ...args) => {
		if (script === GATEWAY_SCRIPTS.time) return Promise.resolve(clock);
		if (script === delayedScript) return new Promise((resolve, reject) => { executeLate = async () => { try { const result = await redis.eval(script, ...args); resolve(result); return JSON.parse(result); } catch (error) { reject(error); throw error; } }; });
		return redis.eval(script, ...args);
	}, get: (...args) => redis.get(...args) };
	const delayed = makeGatewayStore({ redis: transport, prefix, timeoutMs: 2 });
	async function bound() {
		const intentId = gatewayRandom(), owner = gatewayRandom(), handoff = gatewayRandom();
		await ordinary.createIntent({ intentId, owner, handoffHash: gatewayHash(handoff), target, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example" });
		await ordinary.bindIntent({ intentId, handoff, browserHash: gatewayHash("browser"), gatewayOrigin: "https://gateway.example", host: target.host });
		return { intentId, owner };
	}
	try {
		const first = await bound();
		assert.equal((await ordinary.authorizeIntent({ ...first, actor, observedAt: await observe(ordinary) })).ok, true);
		clock = await observe(ordinary); const judgedAt = (await delayed.observeTime()).nowMs;
		delayedScript = GATEWAY_SCRIPTS.renewAuth;
		assert.equal((await delayed.renewAuthorization({ ...first, observedAt: judgedAt })).refused, "control-unavailable");
		assert.ok(await redis.pttl(`${prefix}auth:${first.intentId}`) > 0, "the old lease is still live when the delayed command executes");
		clock = await observe(ordinary); await delayed.observeTime();
		assert.equal((await executeLate()).ok, true);
		assert.equal(await redis.pexpiretime(`${prefix}auth:${first.intentId}`), judgedAt + GATEWAY_AUTH_MS, "arrival time and another observation cannot buy five fresh seconds");
		const oldObservation = (await observe(ordinary)) - GATEWAY_AUTH_MS - 1;
		assert.equal((await ordinary.renewAuthorization({ ...first, observedAt: oldObservation })).refused, "authorization-expired", "an expired judgment refuses even while another lease keeps the AUTH key live");
		const second = await bound();
		clock = await observe(ordinary); const stepUpAt = (await delayed.observeTime()).nowMs;
		delayedScript = GATEWAY_SCRIPTS.authorize;
		assert.equal((await delayed.authorizeIntent({ ...second, actor, observedAt: stepUpAt })).refused, "control-unavailable");
		clock = await observe(ordinary); await delayed.observeTime();
		assert.equal((await executeLate()).ok, true);
		assert.equal(await redis.pexpiretime(`${prefix}auth:${second.intentId}`), stepUpAt + GATEWAY_AUTH_MS);
		const third = await bound(), current = await observe(ordinary);
		for (const observedAt of [current - GATEWAY_AUTH_MS - 1, current + 100000]) assert.equal((await ordinary.authorizeIntent({ ...third, actor, observedAt })).refused, "authorization-expired");
		assert.equal(await redis.exists(`${prefix}auth:${third.intentId}`), 0);
		assert.equal((await ordinary.renewAuthorization({ ...first, observedAt: current + 100000 })).refused, "authorization-expired");
	} finally { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); redis.disconnect(); }
});
