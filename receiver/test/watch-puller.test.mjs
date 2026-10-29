import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli.mjs";
import { pollWatchSources, startWatchPuller } from "../src/watch-puller.mjs";
const NOW = Date.parse("2026-01-01T00:00:00Z"); const now = () => NOW;
const finding = { fields: { service: "checkout" }, severity: "error", count: 1, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z", samples: ["private source text"] };
function setup() {
	const values = new Map(); const calls = []; const enqueued = [];
	const cfg = { valkeyUrl: "redis://unused", triggers: { watchSources: { prod: { maxPerDay: 1000, pull: { kind: "file", path: "/reviewed/log", fields: { service: "checkout" }, intervalSeconds: 30 } } }, watch: [{ on: { id: "rule", source: "prod", fingerprint: ["service"], match: {} } }] } };
	const redis = { async set(key, value, nx) { if (nx === "NX" && values.has(key)) return null; values.set(key, value); return "OK"; }, async get(key) { return values.get(key); }, async eval(script, count, leaseKey, ...args) { if (count === 1) { if (values.get(leaseKey) === args[0]) return values.delete(leaseKey) ? 1 : 0; return 0; } const [cursorKey, token, cursor] = args; if (values.get(leaseKey) !== token) return 0; values.set(cursorKey, cursor); return 1; } };
	const store = { async ingest(input) { calls.push(input); return { status: "held", id: "a".repeat(64), dueAt: NOW + 1000 }; }, async appendTrace() {}, async recordVerdict() {} };
	const adapterFactory = () => ({ async poll(cursor) { calls.push({ cursor }); return { findings: [finding], deliveries: ["delivery-1"], cursor: { offset: 12 } }; } });
	return { cfg, redis, values, calls, enqueued, store, adapterFactory, enqueue: async input => { enqueued.push(input); }, now, env: {} };
}
test("pull checkpoint follows successful ingest and enqueue; collector text is redacted", async () => {
	const deps = setup(); await pollWatchSources(deps);
	assert.equal(deps.enqueued.length, 1); assert.deepEqual(JSON.parse([...deps.values.entries()].find(([key]) => key.includes(":cursor:"))[1]), { offset: 12 });
	assert.equal(deps.calls.find(value => value.finding).finding.samples[0], "[redacted]"); assert.equal(deps.calls.find(value => value.finding).sourceMaxPerDay, 1000);
});
test("failed enqueue retains old cursor; retry reuses the same source delivery", async () => {
	const deps = setup(); await assert.rejects(pollWatchSources({ ...deps, enqueue: async () => { throw new Error("failed"); } })); assert.equal([...deps.values.keys()].some(key => key.includes(":cursor:")), false);
	await pollWatchSources(deps); const inputs = deps.calls.filter(value => value.finding); assert.equal(inputs.length, 2); assert.equal(inputs[0].delivery, inputs[1].delivery);
});
test("a competing source lease prevents duplicate polling and enqueue", async () => {
	const deps = setup(); const original = deps.redis.set; deps.redis.set = async (...args) => args[2] === "NX" ? null : original(...args);
	await pollWatchSources(deps); assert.equal(deps.calls.length, 0); assert.equal(deps.enqueued.length, 0);
});
test("watch CLI awaits puller's done and passes the supplied environment", async () => {
	const env = { ONLY: "test" }; let completed = false;
	assert.equal(await main(["watch"], env, { startWatch: async received => { assert.equal(received, env); return { done: Promise.resolve().then(() => { completed = true; }) }; } }), 0); assert.equal(completed, true);
});
test("puller stops promptly and removes its timer without owning injected clients", async () => {
	const deps = setup(); let disconnected = false; deps.redis.disconnect = () => { disconnected = true; };
	const puller = await startWatchPuller({}, { ...deps, loadConfig: () => deps.cfg, reload: () => ({ ok: true }), signals: false, out: () => {} });
	puller.stop(); await puller.done; assert.equal(disconnected, false);
});
