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
	const input = { intentId: gatewayRandom(), owner: gatewayRandom(), target, handoffHash: gatewayHash("proof"), gatewayOrigin: "https://gateway.example", consoleOrigin: "https://console.example" };
	assert.equal((await store.createIntent(input)).refused, "fixture");
	assert.doesNotMatch(JSON.stringify(calls), /PRIVATE|private\/path/);
	assert.equal((await store.createIntent({ ...input, token: "PRIVATE" })).refused, "intent-invalid");
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
