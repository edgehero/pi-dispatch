import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanGatewayTarget, distinctGatewayOrigins, gatewayHash, gatewayOrigin, gatewayRandom, makeGatewayStore, GATEWAY_PENDING_MS, GATEWAY_HANDOFF_MS, GATEWAY_GRANT_MS, GATEWAY_AUTH_MS, GATEWAY_WINDOW_MS, GATEWAY_MAX_INTENTS } from "../src/sandbox-gateway-protocol.mjs";

test("the exported gateway authority and retention limits cannot widen their approved maxima through a constructor seam", () => {
	const redis = { eval() { throw new Error("invalid bounds must never touch control storage"); } };
	for (const [field, actual, cap] of [["pendingMs", GATEWAY_PENDING_MS, 300000], ["handoffMs", GATEWAY_HANDOFF_MS, 60000], ["grantMs", GATEWAY_GRANT_MS, 60000], ["authMs", GATEWAY_AUTH_MS, 5000], ["windowMs", GATEWAY_WINDOW_MS, 15000], ["maxIntents", GATEWAY_MAX_INTENTS, 256]]) {
		assert.equal(actual, cap, `${field}: changing the reviewed maximum requires a contract decision`);
		for (const value of [0, -1, cap + 1, Infinity, 1.5]) assert.throws(() => makeGatewayStore({ redis, [field]: value }), /bounds cannot exceed/, `${field}=${value}`);
		assert.doesNotThrow(() => makeGatewayStore({ redis, [field]: 1 }), `${field}: a test may tighten its injected bound`);
	}
});

test("gateway enrollment refuses port-only cookie separation, ambiguous authorities and runtime host aliases", () => {
	assert.equal(distinctGatewayOrigins("https://gateway.example", "https://console.example"), true);
	assert.equal(distinctGatewayOrigins("http://localhost:8788", "http://127.0.0.1:8787"), true);
	assert.equal(distinctGatewayOrigins("https://console.example:8788", "https://console.example:8787"), false);
	for (const value of ["https://gateway.example/", "https://GATEWAY.example", "https://gateway.example.", "http://gateway.example", "https://a@gateway.example", "https://gateway.example/path", "https://host.docker.internal", "https://gateway.docker.internal", "https://host.containers.internal"]) assert.equal(gatewayOrigin(value), null, value);
});

test("protocol input rebuilding cannot carry lease payload, paths, arbitrary hosts or console secrets", async () => {
	const calls = [];
	const store = makeGatewayStore({ redis: { eval: async (...args) => { calls.push(args); return JSON.stringify({ refused: "fixture" }); } } });
	const target = { host: "host-a", id: "sb-safe", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local", text: "PRIVATE", workspace: "/private/path" };
	assert.deepEqual(cleanGatewayTarget(target), { host: "host-a", id: "sb-safe", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" });
	const input = { intentId: gatewayRandom(), owner: gatewayRandom(), target, kind: "drive", sessionKey: gatewayHash("session"), runFacts: null, handoffHash: gatewayHash("proof"), gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example" };
	assert.equal((await store.createIntent(input)).refused, "fixture");
	assert.doesNotMatch(JSON.stringify(calls), /PRIVATE|private\/path/);
	assert.equal((await store.createIntent({ ...input, token: "PRIVATE" })).refused, "intent-invalid");
	assert.equal((await store.createIntent({ ...input, kind: "watch" })).refused, "intent-invalid", "a watch names the exact driver it watches");
	assert.equal((await store.createIntent({ ...input, driver: { intentId: gatewayRandom(), connectionId: gatewayRandom(), epoch: gatewayRandom() } })).refused, "intent-invalid", "a driver watches nobody");
	assert.equal((await store.createIntent({ ...input, intentId: "B".repeat(43) })).refused, "intent-invalid", "noncanonical base64 padding bits refuse");
	assert.equal((await store.createIntent({ ...input, target: { ...target, venue: "openshell" } })).refused, "intent-invalid");
	assert.equal(calls.length, 1, "determinate invalid inputs never reach control storage");
});
test("authority writes require an explicit bounded clock observation and time reads themselves fail closed", async () => {
	let calls = 0;
	const redis = { eval: async () => { calls++; return 123; } }, store = makeGatewayStore({ redis });
	assert.deepEqual(await store.observeTime(), { ok: true, nowMs: 123 });
	const input = { intentId: gatewayRandom(), owner: gatewayRandom(), actor: { name: "ops", role: "operator", session: "a".repeat(12) } };
	for (const observedAt of [undefined, null, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
		assert.equal((await store.authorizeIntent({ ...input, observedAt })).refused, "intent-invalid");
		assert.equal((await store.renewAuthorization({ ...input, observedAt })).refused, "intent-invalid");
	}
	assert.equal(calls, 1, "missing/floating/future-overflow seams never reach authority storage");
	assert.deepEqual(await makeGatewayStore({ redis: { eval: async () => "123" } }).observeTime(), { refused: "control-invalid" });
	assert.deepEqual(await makeGatewayStore({ redis: { eval: () => new Promise(() => {}) }, timeoutMs: 2 }).observeTime(), { refused: "control-unavailable" });
});

test("v2 immutable intent and room payloads fail closed independently, including old versions and mixed valid/invalid results", async () => {
	const intentId = gatewayRandom(), connectionId = gatewayRandom(), target = { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" };
	const intent = { v: 2, intentId, owner: gatewayRandom(), kind: "drive", sessionKey: gatewayHash("session"), runFacts: null, target, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example", theme: null, state: "connected", actor: { name: "ops", role: "operator", session: "a".repeat(12) }, connectionId, createdAt: 0, handoffUntil: 60, pendingUntil: 300 };
	const room = { v: 2, target, driverIntentId: intentId, driverConnectionId: connectionId, driverActor: intent.actor, sessionKey: intent.sessionKey, gatewayOrigin: intent.gatewayOrigin, consoleOrigin: intent.consoleOrigin, enabled: false, epoch: null, geometry: { cols: 80, rows: 24, revision: 1 }, rosterRevision: 0, seenRosterRevision: 0, watchers: {} };
	let result = { ok: true, intent, room }, rawIntent = intent;
	const store = makeGatewayStore({ redis: { get: async () => JSON.stringify(rawIntent), eval: async () => JSON.stringify(result) } });
	assert.equal((await store.renewAttachment({ intentId, connectionId, browserHash: gatewayHash("B") })).ok, true);
	for (const invalid of [{ ...intent, v: 1 }, { ...intent, sessionKey: null }, { ...intent, kind: "watch" }, { ...intent, runFacts: { id: "other", outcome: "failed", project: null, target: null, flow: null, endedAt: null } }]) {
		rawIntent = invalid;
		await assert.rejects(store.readIntent(intentId), /control-invalid/);
		rawIntent = intent; result = { ok: true, intent: invalid, room };
		assert.equal((await store.renewAttachment({ intentId, connectionId, browserHash: gatewayHash("B") })).refused, "control-invalid", "a valid room never masks an invalid immutable intent");
	}
	result = { ok: true, intent, room: { ...room, epoch: gatewayRandom(), enabled: true, seenRosterRevision: 1 } };
	assert.equal((await store.renewAttachment({ intentId, connectionId, browserHash: gatewayHash("B") })).refused, "control-invalid", "a valid intent never masks an invalid room");
	for (const bad of [{ refused: "window-busy", winnerConnectionId: "B".repeat(43) }, { refused: "grant-unavailable", winnerConnectionId: connectionId }, { refused: "window-busy", winnerConnectionId: connectionId, sessionKey: intent.sessionKey }]) {
		result = bad;
		assert.equal((await store.redeem({ intentId, connectionId, browserHash: gatewayHash("B") })).refused, "control-invalid", "winner identity is conditional and canonical");
	}
});

test("run facts are a closed projection bound to this exact run and never a transcript transport", async () => {
	let calls = 0;
	const store = makeGatewayStore({ redis: { eval: async () => { calls++; return JSON.stringify({ refused: "fixture" }); } } });
	const target = { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" };
	const input = { intentId: gatewayRandom(), owner: gatewayRandom(), kind: "drive", sessionKey: gatewayHash("session"), runFacts: { id: "run-a", outcome: "awaiting-approval", project: "app", target: "edgehero/app#12", flow: "fix-issue", endedAt: "2026-01-01T00:00:00.000Z" }, handoffHash: gatewayHash("H"), target, gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example" };
	assert.equal((await store.createIntent(input)).refused, "fixture");
	for (const runFacts of [{ ...input.runFacts, id: "run-other" }, { ...input.runFacts, outcome: "policy" }, { ...input.runFacts, question: "PRIVATE" }, { ...input.runFacts, endedAt: "2026-02-30T00:00:00.000Z" }, { ...input.runFacts, flow: "arbitrary shell command" }]) assert.equal((await store.createIntent({ ...input, runFacts })).refused, "intent-invalid");
	assert.equal((await store.createIntent({ ...input, runFacts: null })).refused, "fixture");
	assert.equal(calls, 2, "invalid facts refuse before control storage");
});
