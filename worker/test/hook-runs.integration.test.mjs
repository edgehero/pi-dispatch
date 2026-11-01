import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { makeHookRunsPublisher, readHookRuns, HOOK_HOSTS, hookRunsKey, HOOK_RUNS_TTL_MS } from "../src/hook-runs.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw Error("hook-runs integration REQUIRES VALKEY_TEST_URL");
const skip = url ? false : "needs VALKEY_TEST_URL";
const AT = Date.UTC(2026, 10, 1, 12);

test("real transactions retain the latest twenty, expire atomically, prune expired hosts, and tolerate deleted display keys (#775)", { skip }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url);
	const name = `hook-${randomUUID()}`;
	const expired = `hook-old-${randomUUID()}`;
	const publisher = makeHookRunsPublisher({ redis, name, now: () => AT });
	t.after(async () => { publisher.close(); await redis.del(hookRunsKey(name)); await redis.srem(HOOK_HOSTS, name, expired); redis.disconnect(); });
	await redis.sadd(HOOK_HOSTS, expired);
	for (let i = 0; i < 23; i++) publisher.publish({ jobId: `gh-${i}`, outcome: "failed", reason: "infra", detail: i % 2 ? "timeout" : "exit", code: i % 2 ? null : 3 });
	for (let i = 0; i < 100 && JSON.parse((await redis.lrange(hookRunsKey(name), 0, 0))[0] ?? "null")?.jobId !== "gh-22"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	const rows = (await redis.lrange(hookRunsKey(name), 0, -1)).map(JSON.parse);
	assert.equal(rows.length, 20);
	assert.deepEqual(rows.map((row) => row.jobId), Array.from({ length: 20 }, (_, i) => `gh-${22 - i}`));
	const ttl = await redis.pttl(hookRunsKey(name));
	assert.ok(ttl > HOOK_RUNS_TTL_MS - 5000 && ttl <= HOOK_RUNS_TTL_MS);
	assert.equal(await redis.sismember(HOOK_HOSTS, expired), 0);
	const read = await readHookRuns(redis, { names: [name] });
	assert.equal(read.hosts.find((host) => host.name === name).runs[0].at, AT);
	await redis.del(hookRunsKey(name));
	assert.equal((await readHookRuns(redis, { names: [name] })).hosts.find((host) => host.name === name).absent, true);
	publisher.publish({ jobId: "gh-after-delete", outcome: "failed", reason: "infra", detail: "unresolvable", code: null });
	for (let i = 0; i < 100 && await redis.llen(hookRunsKey(name)) === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(JSON.parse((await redis.lrange(hookRunsKey(name), 0, 0))[0]).jobId, "gh-after-delete");
});
