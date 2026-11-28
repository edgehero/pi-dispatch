import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { gatewayHash, gatewayRandom, makeGatewayStore } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { makeGatewayBroker } from "../../admin/src/console/gateway-broker.mjs";
import { makeSessionStore } from "../../admin/src/console/sessions.mjs";
import { makeRedisClient } from "../../worker/src/connection.mjs";
import { findToken } from "../../worker/src/console-tokens.mjs";
import { runGatewaySession } from "../src/session.mjs";

// The console's real broker and the gateway's real session, joined by nothing but a live store, so each answer below is
// the one its Lua gives. The session's timer is a stub, so every renewal is one this test asks for.
const url = process.env.VALKEY_TEST_URL;
const sha = value => createHash("sha256").update(value).digest("hex");

/** A driver launched and authorized through the real broker, connected through the real store, attached as a session. */
async function attachedDriver(t, { now } = {}) {
	const redis = makeRedisClient(url, { disconnectTimeoutMs: 0 }); redis.on("error", () => {});
	const prefix = `gateway-revocation:${gatewayRandom().replaceAll("-", "_")}:`, real = makeGatewayStore({ redis, prefix });
	t.after(async () => { const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); redis.disconnect(); });
	const target = { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" };
	const consoleOrigin = "http://console.localhost", gatewayOrigin = "http://gateway.localhost", token = `pdc_${"x".repeat(43)}`;
	const file = { version: 1, generation: 0, tokens: [{ name: "ops", role: "operator", sha256: sha(token) }] };
	const sessions = makeSessionStore(), signedIn = sessions.create({ name: "ops", role: "operator", tokenHash: sha(token), generation: 0 });
	const session = sessions.peek(signedIn.id, file), actor = { name: "ops", role: "operator", session: "a".repeat(12) };
	const broker = makeGatewayBroker({ store: real, sessions, findToken, readTokens: () => ({ file }), readRegistry: () => ({ config: { consoleOrigin, hosts: { [target.host]: { origin: gatewayOrigin } } }, digest: "r1" }), readSessions: async () => ({ sessions: [target] }), audit: { append() {} }, schedule: false });
	t.after(() => broker.close());

	const launched = await broker.launch({ session, body: { host: target.host, id: target.id, width: 1440 }, origin: consoleOrigin, actor });
	const handoff = new URLSearchParams(new URL(launched.launchUrl).hash.slice(1)).get("handoff"), browserHash = gatewayHash(gatewayRandom()), receipt = gatewayRandom();
	assert.equal((await real.bindIntent({ intentId: launched.intentId, handoff, browserHash, receiptHash: gatewayHash(receipt), gatewayOrigin, host: target.host })).ok, true);
	assert.equal((await broker.authorize({ session, origin: consoleOrigin, actor, body: { intentId: launched.intentId, tabProof: launched.tabProof, receipt, token, width: 1440 } })).ok, true);
	const connectionId = gatewayRandom(), redeemed = await real.redeem({ intentId: launched.intentId, browserHash, connectionId });
	const started = await real.startDriver({ intentId: launched.intentId, connectionId, browserHash, cols: 80, rows: 24 });
	assert.equal(redeemed.ok && started.ok, true);

	const ends = [], store = { ...real }, ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send() {}, close() { this.readyState = 3; }, terminate() { this.readyState = 3; } });
	const driver = runGatewaySession({ ws, channel: { stream: new EventEmitter(), detach() {} }, store, intent: redeemed.intent, connectionId, browserHash, room: started.room, authRemainingMs: started.authRemainingMs, idleMinutes: 0, runtime: { inspect: async () => ({ ok: true }) }, audit: async () => {}, ...(now ? { now } : {}), setTimer: () => ({}), clearTimer: () => {}, onEnd: result => ends.push(result.reason) });
	const acknowledge = async () => {
		ws.emit("message", Buffer.from(JSON.stringify({ type: "sharing-seen", revision: started.room.rosterRevision })), false);
		for (let turn = 0; turn < 200 && !ends.length; turn++) await new Promise(resolve => setImmediate(resolve));
	};
	return { redis, prefix, real, store, broker, file, launched, connectionId, browserHash, started, driver, ends, acknowledge };
}

test("a driver the console revokes ends as a session end through the real store, even when its roster acknowledgement gets there before its renewal (issues #1039, #1048)", { skip: !url && "needs VALKEY_TEST_URL" }, async t => {
	const w = await attachedDriver(t);
	await w.broker.tick(); await w.driver.tick();
	assert.deepEqual(w.ends, [], "renewed through the real broker and store, the driver stays");

	w.file.tokens.splice(0, 1); await w.broker.tick();
	assert.equal((await w.real.readIntent(w.launched.intentId)).state, "revoked", "the console revoked it");
	// The page acknowledges the roster it was just sent, and that control reaches the store before the next renewal.
	await w.acknowledge();
	assert.deepEqual(w.ends, ["session-ended"], "Operator session ended, not an authority nobody could confirm");
	assert.equal((await w.real.renewAttachment({ intentId: w.launched.intentId, connectionId: w.connectionId, browserHash: w.browserHash })).refused, "authorization-expired", "the word a renewal would have got too");
});

test("a driver whose lease ran out with nobody revoking it ends as unconfirmed, though the store refuses it with the revocation's word (issues #1039, #1048)", { skip: !url && "needs VALKEY_TEST_URL" }, async t => {
	let at = 0;
	const w = await attachedDriver(t, { now: () => at });
	// The console renewed nothing, so the owner key expired: what a lapse leaves, with the intent still connected.
	await w.redis.del(`${w.prefix}auth:${w.launched.intentId}`);
	assert.equal((await w.real.readIntent(w.launched.intentId)).state, "connected", "nobody revoked it");
	// The acknowledgement leaves inside the session's lease, and its refusal is read after the deadline, before the timer runs.
	w.store.acknowledgeRoster = async input => { const answer = await w.real.acknowledgeRoster(input); at = w.started.authRemainingMs; return answer; };
	at = 10; await w.acknowledge();
	assert.deepEqual(w.ends, ["authorization-unavailable"], "Authorization could not be checked, never Operator session ended");
	assert.equal((await w.real.renewAttachment({ intentId: w.launched.intentId, connectionId: w.connectionId, browserHash: w.browserHash })).refused, "authorization-expired", "the store's word is the same as for a revocation");
});
