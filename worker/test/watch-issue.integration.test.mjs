import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWatchIssuePublisher } from "../src/watch-issue.mjs";
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("watch-issue.integration REQUIRES VALKEY_TEST_URL");
const skip = url ? false : "needs VALKEY_TEST_URL";
test("real Valkey atomically bounds issue mappings, preserves concurrent create identity and notices close races", { skip }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs"); const redis = makeRedisClient(url, {});
	const prefix = `watch-issue-test-${Math.random().toString(36).slice(2)}`; let clock = 1000; let created = 0; let closed = 0; let reopened = 0; let race = false; let publish;
	t.after(async () => { const keys = await redis.keys(`${prefix}:*`); if (keys.length) await redis.del(...keys); redis.disconnect(); });
	const args = { source: "prod", ruleId: "errors", fingerprint: "a".repeat(64), target: { kind: "github", repo: "owner/repo", closeAfter: "1m" }, finding: { count: 10, severity: "error" } };
	publish = makeWatchIssuePublisher({ redis, prefix, now: () => clock, maxPerSource: 1, canClose: async () => true, adapter: {
		async findIssue() { return created ? { id: 7 } : null; }, async createIssue() { created++; return { id: 7 }; }, async updateIssue({ state }) { if (state === "open") reopened++; }, async closeIssue() { closed++; if (race) await publish.noteActivity(args); },
	} });
	await Promise.all(Array.from({ length: 20 }, () => publish(args)));
	assert.equal(created, 1);
	assert.equal((await publish({ ...args, fingerprint: "b".repeat(64) })).reason, "watch-issue-cap");
	assert.equal((await redis.keys(`${prefix}:activity:*`)).length, 1, "capped new identities allocate no activity keys");
	clock = 60000; await publish.noteActivity(args); clock = 61001; assert.deepEqual(await publish.sweep(), []);
	clock = 120000; race = true; assert.equal((await publish.sweep())[0].reason, "watch-issue-close-raced"); assert.equal(closed, 1); assert.ok(reopened > 0);
	clock = 180000; race = false; assert.equal((await publish.sweep())[0].status, "closed");
	await publish(args); assert.equal(created, 1);
});
