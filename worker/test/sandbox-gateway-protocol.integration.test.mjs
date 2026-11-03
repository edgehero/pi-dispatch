import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRedisClient } from "../src/connection.mjs";
import { GATEWAY_AUTH_MS, GATEWAY_SCRIPTS, gatewayHash, gatewayRandom, makeGatewayStore } from "../src/sandbox-gateway-protocol.mjs";
const observe = async store => { const clock = await store.observeTime(); assert.equal(clock.ok, true); return clock.nowMs; };

const url = process.env.VALKEY_TEST_URL;
async function observerFixture() {
	const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 }); redis.on("error", () => {});
	const prefix = `gateway-watch-test:${gatewayRandom().replaceAll("-", "_")}:`;
	const store = makeGatewayStore({ redis, prefix }), otherProcess = makeGatewayStore({ redis, prefix });
	const target = { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" };
	async function bound(kind = "drive", driver, session = gatewayRandom()) {
		const handoff = gatewayRandom(), m = { intentId: gatewayRandom(), owner: gatewayRandom(), kind, sessionKey: gatewayHash(session), runFacts: null, handoffHash: gatewayHash(handoff), target, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example", ...(driver ? { driver } : {}) };
		assert.equal((await store.createIntent(m)).ok, true);
		m.browserHash = gatewayHash(gatewayRandom());
		assert.equal((await store.bindIntent({ receiptHash: gatewayHash("receipt"), intentId: m.intentId, handoff, browserHash: m.browserHash, gatewayOrigin: m.gatewayOrigin, host: target.host })).ok, true);
		return m;
	}
	const actor = { name: "ops", role: "operator", session: "a".repeat(12) };
	const authorize = async (m, who = actor) => store.authorizeIntent({ intentId: m.intentId, owner: m.owner, actor: who, observedAt: await observe(store) });
	const connect = async m => { m.connectionId = gatewayRandom(); return store.redeem({ intentId: m.intentId, browserHash: m.browserHash, connectionId: m.connectionId }); };
	const driverSession = gatewayRandom(), driver = await bound("drive", undefined, driverSession); assert.equal((await authorize(driver)).ok, true); assert.equal((await connect(driver)).ok, true);
	const identity = m => ({ intentId: m.intentId, connectionId: m.connectionId, browserHash: m.browserHash });
	assert.equal((await store.startDriver({ ...identity(driver), cols: 120, rows: 36 })).ok, true);
	return { redis, prefix, store, otherProcess, target, driver, driverSession, actor, bound, authorize, connect, identity, async close() { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); redis.disconnect(); } };
}

test("after a gateway dies the console stops renewing what nobody holds, and a watcher's time ends with the room it left", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const f = await observerFixture();
	try {
		const enabled = await f.store.setWatching({ ...f.identity(f.driver), enabled: true }); assert.equal(enabled.ok, true);
		const watch = await f.bound("watch", { intentId: f.driver.intentId, connectionId: f.driver.connectionId, epoch: enabled.room.epoch });
		assert.equal((await f.authorize(watch, { ...f.actor, name: "lee" })).ok, true); assert.equal((await f.connect(watch)).ok, true);
		const renew = async m => f.store.renewAuthorization({ intentId: m.intentId, owner: m.owner, observedAt: await observe(f.store) });
		assert.equal((await renew(f.driver)).ok, true); assert.equal((await renew(watch)).ok, true);
		// The driver's process is what renews the room. The console keeps renewing its AUTH regardless, so that alone cannot be the bound.
		await f.redis.pexpire(`${f.prefix}room:${f.target.host}:${f.target.containerId}`, 400);
		const bounded = await f.otherProcess.renewAttachment(f.identity(watch));
		assert.equal(bounded.ok, true); assert.ok(bounded.authRemainingMs <= 400, `${bounded.authRemainingMs} ms: a watcher cannot outlive the room`);
		const [watchLease] = await f.redis.keys(`${f.prefix}watch-window:*`); assert.ok(watchLease);
		await f.redis.del(watchLease);
		assert.equal((await renew(watch)).refused, "window-lost", "a watch nobody holds stops being renewed, so its slot can lapse");
		await f.redis.del(`${f.prefix}window:${f.target.host}:${f.target.containerId}`);
		assert.equal((await renew(f.driver)).refused, "window-lost", "and so does a driver nobody holds");
	} finally { await f.close(); }
});

test("Remove or Off before a watcher redeems refuses that grant; a grant of one kind cannot start the other", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const f = await observerFixture();
	try {
		const enabled = await f.store.setWatching({ ...f.identity(f.driver), enabled: true }); assert.equal(enabled.ok, true);
		const reference = () => ({ intentId: f.driver.intentId, connectionId: f.driver.connectionId, epoch: enabled.room.epoch });
		const removed = await f.bound("watch", reference()); assert.equal((await f.authorize(removed, { ...f.actor, name: "lee" })).ok, true);
		assert.equal((await f.otherProcess.removeWatcher({ ...f.identity(f.driver), watcherKey: gatewayHash(removed.intentId) })).ok, true);
		assert.notEqual((await f.connect(removed)).ok, true, "a removed reservation cannot be redeemed");
		assert.equal(Object.keys((await f.store.readRoom(f.target)).watchers).length, 0, "and its slot is free");

		const off = await f.bound("watch", reference()); assert.equal((await f.authorize(off, { ...f.actor, name: "sam" })).ok, true);
		assert.equal((await f.otherProcess.setWatching({ ...f.identity(f.driver), enabled: false })).ok, true);
		assert.notEqual((await f.connect(off)).ok, true, "turning watching off withdraws a grant nobody has redeemed");

		assert.notEqual((await f.store.readyWatch(f.identity(f.driver))).ok, true, "a drive grant cannot become a watch");
		const reenabled = await f.store.setWatching({ ...f.identity(f.driver), enabled: true }); assert.equal(reenabled.ok, true);
		const watch = await f.bound("watch", { ...reference(), epoch: reenabled.room.epoch }); assert.equal((await f.authorize(watch, { ...f.actor, name: "kim" })).ok, true); assert.equal((await f.connect(watch)).ok, true);
		assert.notEqual((await f.store.startDriver({ ...f.identity(watch), cols: 80, rows: 24 })).ok, true, "and a watch grant can never start a driver");
		const room = await f.store.readRoom(f.target);
		assert.equal(room.driverConnectionId, f.driver.connectionId, "the driver stays who it was");
	} finally { await f.close(); }
});

test("an acknowledgement from before a watcher joined never admits it: the driver has not rendered that name", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const f = await observerFixture();
	try {
		const enabled = await f.store.setWatching({ ...f.identity(f.driver), enabled: true }); assert.equal(enabled.ok, true);
		const before = (await f.store.readRoom(f.target)).rosterRevision;
		const watch = await f.bound("watch", { intentId: f.driver.intentId, connectionId: f.driver.connectionId, epoch: enabled.room.epoch });
		assert.equal((await f.authorize(watch, { ...f.actor, name: "lee" })).ok, true); assert.equal((await f.connect(watch)).ok, true);
		const joined = (await f.store.readRoom(f.target)).rosterRevision; assert.ok(joined > before, "joining publishes a new roster revision");
		await f.otherProcess.acknowledgeRoster({ ...f.identity(f.driver), revision: before }).catch(() => {});
		assert.equal((await f.otherProcess.renewAttachment(f.identity(watch))).rosterSeen, false, "a stale acknowledgement says nothing about the new name");
		assert.equal((await f.store.readyWatch(f.identity(watch))).refused, "roster-unseen");
		assert.equal((await f.store.acknowledgeRoster({ ...f.identity(f.driver), revision: joined })).ok, true);
		assert.equal((await f.otherProcess.renewAttachment(f.identity(watch))).rosterSeen, true);
	} finally { await f.close(); }
});

test("two control processes reserve three watches, require roster acknowledgement, and never trust the window TTL as driver authority", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const f = await observerFixture();
	try {
		assert.equal((await f.store.readRoom(f.target)).enabled, false);
		const enabled = await f.otherProcess.setWatching({ ...f.identity(f.driver), enabled: true }); assert.equal(enabled.ok, true);
		const ref = { intentId: f.driver.intentId, connectionId: f.driver.connectionId, epoch: enabled.room.epoch };
		const watches = await Promise.all(Array.from({ length: 4 }, () => f.bound("watch", ref)));
		const accepted = await Promise.all(watches.map(m => f.authorize(m, { ...f.actor, name: "lee" })));
		assert.equal(accepted.filter(r => r.ok).length, 3); assert.equal(accepted.filter(r => r.refused === "watch-limit").length, 1);
		const watch = watches[accepted.findIndex(r => r.ok)]; assert.equal((await f.connect(watch)).ok, true);
		const before = await f.otherProcess.renewAttachment(f.identity(watch));
		assert.equal(before.ok, true); assert.equal(before.rosterSeen, false);
		assert.equal((await f.store.readyWatch(f.identity(watch))).refused, "roster-unseen");
		const room = await f.store.readRoom(f.target);
		for (const changes of [{ id: "different-run" }, { nonce: "c".repeat(32) }, { venue: "podman" }]) assert.equal(await f.otherProcess.readRoom({ ...f.target, ...changes }), null, "the key's host/container coincidence never substitutes for the requested incarnation");
		assert.equal(Object.keys(room.watchers).length, 3, "authorized and connecting participants both occupy slots");
		assert.equal((await f.store.acknowledgeRoster({ ...f.identity(f.driver), revision: room.rosterRevision + 1 })).refused, "roster-invalid");
		assert.equal((await f.store.acknowledgeRoster({ ...f.identity(f.driver), revision: room.rosterRevision })).ok, true);
		const watching = await f.otherProcess.readyWatch(f.identity(watch)); assert.equal(watching.ok, true);
		assert.equal(watching.room.rosterRevision, room.rosterRevision + 1, "the persistent roster changes its pending label with a new observable revision");
		assert.equal((await f.otherProcess.readyWatch(f.identity(watch))).room.rosterRevision, watching.room.rosterRevision, "repeating the same ready receipt cannot manufacture a roster change");
		assert.equal((await f.otherProcess.renewAttachment(f.identity(watch))).rosterSeen, true);
		const changed = await f.store.updateGeometry({ ...f.identity(f.driver), cols: 91, rows: 23 }); assert.equal(changed.ok, true);
		const observed = await f.otherProcess.renewAttachment(f.identity(watch));
		assert.deepEqual(observed.room.geometry, { cols: 91, rows: 23, revision: 2 });
		assert.equal((await f.otherProcess.updateGeometry({ ...f.identity(watch), cols: 2, rows: 1 })).refused, "driver-ended");
		assert.ok(await f.redis.pttl(`${f.prefix}window:${f.target.host}:${f.target.containerId}`) > 0);
		await f.redis.del(`${f.prefix}auth:${f.driver.intentId}`);
		assert.equal(await f.otherProcess.readRoom(f.target), null);
		assert.equal((await f.otherProcess.renewAttachment(f.identity(watch))).refused, "driver-ended");
		assert.equal((await f.otherProcess.renewAuthorization({ intentId: watch.intentId, owner: watch.owner, observedAt: await observe(f.store) })).refused, "driver-ended");
	} finally { await f.close(); }
});

test("off/on rotates consent, removal fences exact slots, and a duplicate watch grant returns its actual winning attachment", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const f = await observerFixture();
	try {
		let enabled = await f.store.setWatching({ ...f.identity(f.driver), enabled: true });
		let ref = { intentId: f.driver.intentId, connectionId: f.driver.connectionId, epoch: enabled.room.epoch };
		const first = await f.bound("watch", ref, "same-session"), duplicate = await f.bound("watch", ref, "same-session");
		assert.equal((await f.authorize(first)).ok, true); assert.equal((await f.authorize(duplicate)).ok, true);
		assert.equal((await f.connect(first)).ok, true);
		const refused = await f.connect(duplicate);
		assert.equal(refused.refused, "window-busy"); assert.equal(refused.winnerConnectionId, first.connectionId);
		assert.equal((await f.connect(duplicate)).refused, "grant-unavailable", "duplicate rejection consumed its grant and released its reservation");
		const room = await f.store.readRoom(f.target), key = room.watchers[first.intentId].watcherKey;
		assert.equal((await f.otherProcess.removeWatcher({ ...f.identity(f.driver), watcherKey: key })).ok, true);
		assert.equal((await f.otherProcess.renewAttachment(f.identity(first))).refused, "watch-removed", "a specific consent removal is not misreported as console logout");
		assert.equal((await f.store.renewAuthorization({ intentId: first.intentId, owner: first.owner, observedAt: await observe(f.store) })).refused, "authorization-expired");
		const pending = await f.bound("watch", ref); assert.equal((await f.authorize(pending)).ok, true);
		assert.equal((await f.connect(pending)).ok, true);
		assert.equal((await f.store.setWatching({ ...f.identity(f.driver), enabled: false })).ok, true);
		assert.equal((await f.otherProcess.renewAttachment(f.identity(pending))).refused, "watch-disabled");
		enabled = await f.otherProcess.setWatching({ ...f.identity(f.driver), enabled: true });
		assert.notEqual(enabled.room.epoch, ref.epoch);
		assert.equal((await f.connect(pending)).refused, "grant-unavailable");
		const stale = await f.bound("watch", ref);
		assert.equal((await f.authorize(stale)).refused, "watch-disabled");
		ref = { ...ref, epoch: enabled.room.epoch };
		const fresh = await f.bound("watch", ref); assert.equal((await f.authorize(fresh)).ok, true);
		assert.equal((await f.connect(fresh)).ok, true, "fresh authorization can watch again; Remove creates no person ban");
		await f.store.release({ ...f.identity(f.driver), reason: "disconnected" });
		assert.equal((await f.otherProcess.renewAttachment(f.identity(fresh))).refused, "driver-ended");
	} finally { await f.close(); }
});
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("gateway protocol integration requires VALKEY_TEST_URL");
// Redis is the injected clock/TTL authority. No fixed JS instant is paired with production Date.now.
test("real Valkey binds independent proofs, atomically consumes grants and fences every window generation", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 }); redis.on("error", () => {});
	const prefix = `gateway-test:${gatewayRandom().replaceAll("-", "_")}:`;
	const store = makeGatewayStore({ redis, prefix });
	const actor = { name: "ops", role: "operator", session: "a".repeat(12) };
	const target = { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "podman" };
	const input = () => ({ intentId: gatewayRandom(), owner: gatewayRandom(), kind: "drive", sessionKey: gatewayHash("session"), runFacts: null, handoffHash: gatewayHash(handoff), target, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example", theme: "dark" });
	let handoff = gatewayRandom();
	try {
		const first = input();
		assert.equal((await store.createIntent(first)).ok, true);
		assert.equal((await store.bindIntent({ receiptHash: gatewayHash("receipt"), intentId: first.intentId, handoff: gatewayRandom(), browserHash: gatewayHash("attacker"), gatewayOrigin: first.gatewayOrigin, host: target.host })).refused, "handoff-invalid");
		assert.equal((await store.authorizeIntent({ intentId: first.intentId, owner: first.owner, actor, observedAt: await observe(store) })).refused, "intent-unavailable", "public intent plus operator identity cannot skip binding");
		const attempts = await Promise.all(["browser", "attacker"].map((who) => store.bindIntent({ receiptHash: gatewayHash("receipt"), intentId: first.intentId, handoff, browserHash: gatewayHash(who), gatewayOrigin: first.gatewayOrigin, host: target.host })));
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
		assert.equal((await store.bindIntent({ receiptHash: gatewayHash("receipt"), intentId: second.intentId, handoff, browserHash, gatewayOrigin: second.gatewayOrigin, host: target.host })).ok, true);
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
	const config = { intentId, owner, kind: "drive", sessionKey: gatewayHash("session"), runFacts: null, handoffHash: gatewayHash(handoff), target: { host: "host-a", id: "run", nonce: "a".repeat(32), containerId: "c".repeat(64), venue: "local" }, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example" };
	const expire = async (field) => redis.eval(`local m=cjson.decode(redis.call('GET',KEYS[1])); local t=redis.call('TIME'); m[ARGV[1]]=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL'); return 1`, 1, `${prefix}intent:${intentId}`, field);
	try {
		await store.createIntent(config); await expire("handoffUntil");
		assert.equal((await store.bindIntent({ receiptHash: gatewayHash("receipt"), intentId, handoff, browserHash: gatewayHash("browser"), gatewayOrigin: config.gatewayOrigin, host: config.target.host })).refused, "handoff-expired");
		await redis.del(`${prefix}intent:${intentId}`); await store.createIntent(config);
		await store.bindIntent({ receiptHash: gatewayHash("receipt"), intentId, handoff, browserHash: gatewayHash("browser"), gatewayOrigin: config.gatewayOrigin, host: config.target.host });
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
		await ordinary.createIntent({ intentId, owner, kind: "drive", sessionKey: gatewayHash("session"), runFacts: null, handoffHash: gatewayHash(handoff), target, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example" });
		await ordinary.bindIntent({ receiptHash: gatewayHash("receipt"), intentId, handoff, browserHash: gatewayHash("browser"), gatewayOrigin: "https://gateway.example", host: target.host });
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

test("expired watch reservations free capacity while stale driver geometry, roster and cleanup cannot affect a replacement", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const f = await observerFixture();
	try {
		const enabled = await f.store.setWatching({ ...f.identity(f.driver), enabled: true });
		const ref = { intentId: f.driver.intentId, connectionId: f.driver.connectionId, epoch: enabled.room.epoch };
		const abandoned = await Promise.all(Array.from({ length: 3 }, () => f.bound("watch", ref)));
		for (const watch of abandoned) assert.equal((await f.authorize(watch)).ok, true);
		// Redis is this test's clock. Expire the reservation facts atomically rather than
		// sleeping beside a production wall clock and hoping CI schedules us in time.
		await f.redis.eval("local r=cjson.decode(redis.call('GET',KEYS[1])); local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000); for _,w in pairs(r.watchers) do w.expiresAt=now end; redis.call('SET',KEYS[1],cjson.encode(r),'KEEPTTL'); return 1", 1, `${f.prefix}room:${f.target.host}:${f.target.containerId}`);
		const fresh = await f.bound("watch", ref); assert.equal((await f.authorize(fresh)).ok, true);
		const pruned = await f.store.readRoom(f.target);
		assert.deepEqual(Object.keys(pruned.watchers), [fresh.intentId]);
		assert.equal((await f.authorize(abandoned[0])).refused, "intent-unavailable", "a reservation expiry does not make the old grant replayable");
		assert.equal((await f.connect(abandoned[0])).refused, "watch-removed");
		await f.store.release({ ...f.identity(f.driver), reason: "disconnected" });
		const replacement = await f.bound(); assert.equal((await f.authorize(replacement)).ok, true); assert.equal((await f.connect(replacement)).ok, true);
		const newer = await f.store.startDriver({ ...f.identity(replacement), cols: 100, rows: 30 }); assert.equal(newer.ok, true);
		assert.equal((await f.otherProcess.updateGeometry({ ...f.identity(f.driver), cols: 2, rows: 1 })).refused, "authorization-expired");
		assert.equal((await f.otherProcess.acknowledgeRoster({ ...f.identity(f.driver), revision: 999 })).refused, "authorization-expired");
		assert.equal((await f.otherProcess.setWatching({ ...f.identity(f.driver), enabled: true })).refused, "authorization-expired");
		await f.otherProcess.release({ ...f.identity(f.driver), reason: "disconnected" });
		const intact = await f.store.readRoom(f.target);
		assert.equal(intact.driverConnectionId, replacement.connectionId); assert.equal(intact.enabled, false);
		assert.deepEqual(intact.geometry, { cols: 100, rows: 30, revision: 1 });
		assert.equal((await f.store.renewAuthorization({ intentId: fresh.intentId, owner: fresh.owner, observedAt: await observe(f.store) })).refused, "authorization-expired");
	} finally { await f.close(); }
});

test("watching one's own exact driver session reserves no slot, while the same operator name in another session can watch", { skip: !url && "needs VALKEY_TEST_URL" }, async () => {
	const f = await observerFixture();
	try {
		const enabled = await f.store.setWatching({ ...f.identity(f.driver), enabled: true });
		const ref = { intentId: f.driver.intentId, connectionId: f.driver.connectionId, epoch: enabled.room.epoch };
		const own = await f.bound("watch", ref, f.driverSession);
		assert.equal(own.sessionKey, f.driver.sessionKey);
		assert.equal((await f.authorize(own, f.actor)).refused, "self-watch");
		assert.equal(await f.redis.get(`${f.prefix}auth:${own.intentId}`), null);
		assert.equal(Object.keys((await f.store.readRoom(f.target)).watchers).length, 0);
		const other = await f.bound("watch", ref); assert.notEqual(other.sessionKey, f.driver.sessionKey);
		assert.equal((await f.authorize(other, f.actor)).ok, true, "same name is not evidence of the same original console session");
		assert.equal((await f.connect(other)).ok, true);
		assert.equal((await f.otherProcess.renewAttachment(f.identity(f.driver))).ok, true, "watch authorization never promotes or replaces the driver");
	} finally { await f.close(); }
});
