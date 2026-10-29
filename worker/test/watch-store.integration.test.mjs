import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWatchStore } from "../src/watch-store.mjs";
import { normalizeWatchRule } from "../src/watch-contract.mjs";
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("watch-store.integration REQUIRES VALKEY_TEST_URL");
const skip = url ? false : "needs VALKEY_TEST_URL";
const CLOCK = Date.parse("2026-01-01T00:00:00Z");
const rule = () => normalizeWatchRule({ type: "watch", id: "errors", source: "prod", fingerprint: ["service"], minCount: 5, window: "10m", cooldown: "6h", maxPerDay: 4 });
const finding = (service = "checkout") => ({ fields: { service }, severity: "error", count: 1, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z", samples: ["private evidence"] });
async function fixture(t) {
	const { makeRedisClient } = await import("../src/connection.mjs"); const redis = makeRedisClient(url, {});
	const prefix = `watch-test-${Math.random().toString(36).slice(2)}`; let clock = CLOCK;
	t.after(async () => { const keys = await redis.keys(`${prefix}:*`); if (keys.length) await redis.del(...keys); redis.disconnect(); });
	return { redis, prefix, store: makeWatchStore(redis, { prefix, now: () => clock }), setNow: value => { clock = value; } };
}
test("watch atomic digest folds concurrent deliveries once and replay recovers the same enqueue id", { skip }, async t => {
	const { store } = await fixture(t); const input = { source: "prod", rule: rule(), finding: finding() };
	const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.ingest({ ...input, delivery: `delivery-${i}` })));
	assert.equal(new Set(results.map(x => x.id)).size, 1);
	const held = results[0]; const f = await store.readFinding(held.id, { private: true }); assert.equal(f.count, 20); assert.equal(f.samples.length, 8);
	assert.deepEqual(await store.ingest({ ...input, delivery: "delivery-0" }), held);
	assert.equal((await store.readFinding(held.id, { private: true })).count, 20);
	assert.equal((await store.readFinding(held.id)).samples, undefined); assert.equal((await store.readFinding(held.id)).fields, undefined);
	assert.equal((await store.listFindings("errors")).length, 1); assert.equal((await store.listRules()).length, 1);
});
test("watch cooldown, rule daily cap, source cap, cardinality and expiry use injected clock", { skip }, async t => {
	const { store, setNow } = await fixture(t); const r = { ...rule(), maxPerDay: 1, maxFingerprints: 1 };
	const input = { source: "prod", rule: r, finding: finding(), delivery: "one" };
	const first = await store.ingest(input); setNow(first.dueAt + 1);
	assert.equal((await store.ingest({ ...input, delivery: "two" })).status, "suppressed");
	assert.equal((await store.ingest({ ...input, finding: finding("other"), delivery: "three" })).status, "capped");
	setNow(CLOCK + 86400000); assert.equal((await store.ingest({ ...input, delivery: "four" })).status, "held");
	assert.equal((await store.ingest({ ...input, delivery: "five", sourceMaxPerDay: 1 })).status, "capped");
});
test("watch trace public projection and board CAS preserve private state and frozen versions", { skip }, async t => {
	const { store } = await fixture(t);
	await store.appendTrace("finding", { id: "trace-1", kind: "decide", state: { secret: "private" }, option: "ignore", probabilities: { ignore: 0.9 }, query: "private query" });
	assert.equal((await store.readTrace("finding"))[0].state, undefined); assert.equal((await store.readTrace("finding"))[0].query, undefined);
	assert.deepEqual((await store.readTrace("finding", { private: true }))[0].state, { secret: "private" });
	const proposal = await store.proposeBoard("errors", { version: 1, blocks: [{ id: "note-1", type: "note", traceId: "trace-1", text: "investigation" }] }, "run-1");
	assert.equal((await store.readBoard("errors")).blocks.length, 0);
	assert.equal((await store.mutateBoard("errors", { action: "adopt", proposalId: proposal.id }, 0)).ok, true);
	assert.equal((await store.mutateBoard("errors", { action: "clear" }, 0)).reason, "board-conflict");
	assert.equal((await store.mutateBoard("errors", { action: "freeze", frozen: true }, 1)).ok, true);
	assert.equal((await store.mutateBoard("errors", { action: "adopt", proposalId: proposal.id }, 2)).reason, "board-frozen");
	assert.equal((await store.mutateBoard("errors", { action: "clear" }, 2)).ok, true);
	assert.equal((await store.mutateBoard("errors", { action: "revert", version: 1 }, 3)).board.blocks[0].text, "investigation");
});

test("trace trimming is bounded and explicitly reports the entries that no longer remain", { skip }, async t => {
	const { store } = await fixture(t);
	for (let i = 0; i < 1002; i++) await store.appendTrace("finding", { id: `trace-${i}`, kind: "rule", status: "held" });
	const visible = await store.readTrace("finding");
	assert.equal(visible.length, 1001);
	assert.equal(visible[0].status, "trace-trimmed"); assert.equal(visible[0].count, 2);
	assert.equal(visible[1].id, "trace-2");
});
test("watch take freezes evidence at due and retries return the same snapshot; threshold never runs early", { skip }, async t => {
	const { store, setNow } = await fixture(t); const input = { source: "prod", rule: rule(), finding: finding(), delivery: "one" };
	const first = await store.ingest(input); assert.equal((await store.takeFinding(first.id)).status, "held");
	setNow(first.dueAt); const snapshot = await store.takeFinding(first.id); assert.equal(snapshot.status, "below-threshold"); assert.equal(snapshot.finding.count, 1);
	assert.equal((await store.ingest({ ...input, delivery: "late" })).status, "suppressed"); assert.deepEqual(await store.takeFinding(first.id), snapshot);
});
test("cap and unmatched summaries remain visible without storing attacker evidence", { skip }, async t => {
	const { store } = await fixture(t);
	await store.recordVerdict("errors", "prod", "capped"); await store.recordVerdict("errors", "prod", "unmatched");
	const [row] = await store.listRules(); assert.equal(row.summary.capped, "1"); assert.equal(row.summary.unmatched, "1"); assert.equal(Number(row.summary.lastDeliveryAt), CLOCK);
	assert.deepEqual(await store.listFindings("errors"), []);
});
