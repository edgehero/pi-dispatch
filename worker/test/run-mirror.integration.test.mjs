import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The mirror's trim script (`TRIM_SCRIPT`, issue #599) against a real Valkey: the fake in run-mirror.test.mjs restates
 * it step for step, so only a live server can say the Lua does what the fake does. Skips cleanly without
 * VALKEY_TEST_URL, and refuses to skip when CI requires the worker's integration tests. Every key is under a prefix
 * of its own and deleted after.
 */
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("run-mirror.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "VALKEY_TEST_URL not set; run mirror integration skipped locally";
/** A PTTL that is the deepest window exactly, less the moments the test took: never more, never much less. */
const atDepth = (pttl, ttl, why) => assert.ok(pttl <= ttl && pttl > ttl - 60_000, `${why ?? "at the deepest window"}: ${pttl} of ${ttl}`);

test("the trim script trims by age and count, raises the horizon by GT only when it removed something, and expires both keys at the deepest window", { skip }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const { MIRROR_MAX_DAYS, RUNS_HORIZON_MEMBER, TRIM_SCRIPT } = await import("../src/run-mirror.mjs");
	const redis = makeRedisClient(url);
	const tag = `pi-test-trim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const index = `${tag}:index`;
	const horizon = `${tag}:horizon`;
	const since = `${tag}:since`;
	const ttl = MIRROR_MAX_DAYS * 24 * 3600 * 1000;
	// Each call writes one member: a fresh id, scored inside what the call keeps.
	let n = 0;
	const trim = (cutoff, cap, score = 1_000_000_000_500) => redis.eval(TRIM_SCRIPT, 3, index, horizon, since, cutoff, cap, ttl, RUNS_HORIZON_MEMBER, score, `w${++n}`, 1_000_000_000_999);
	try {
		await redis.zadd(index, 1_000_000_000_100, "a", 1_000_000_000_200, "b", 1_000_000_000_300, "c");
		assert.equal(await trim(1_000_000_000_000, 10), null, "nothing removed: no horizon");
		assert.equal(await redis.exists(horizon), 0);
		atDepth(await redis.pttl(index), ttl, "the index expires at the deepest window");

		assert.equal(await trim(1_000_000_000_150, 10), "1000000000150", "by age: the cutoff");
		assert.deepEqual(await redis.zrange(index, 0, -1), ["b", "c", "w1", "w2"]);
		assert.equal(await redis.zscore(horizon, RUNS_HORIZON_MEMBER), "1000000000150");
		atDepth(await redis.pttl(horizon), ttl);

		assert.equal(await trim(1_000_000_000_000, 1, 1_000_000_000_600), "1000000000600", "by count: the oldest that remains");
		assert.equal(await redis.zscore(horizon, RUNS_HORIZON_MEMBER), "1000000000600");
		await redis.zadd(index, 1_000_000_000_050, "old", 1_000_000_000_700, "d");
		await trim(1_000_000_000_060, 10);
		assert.equal(await redis.zscore(horizon, RUNS_HORIZON_MEMBER), "1000000000600", "GT: a lower cut never lowers it");
	} finally {
		await redis.del(index, horizon, since);
		await redis.quit();
	}
});

test("the script records the mirror's start: set by the write that creates the index, kept while its run is held, handed on by a trim, replaced when its run is gone, and expiring with the index", { skip }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const { MIRROR_MAX_DAYS, RUNS_HORIZON_MEMBER, TRIM_SCRIPT } = await import("../src/run-mirror.mjs");
	const redis = makeRedisClient(url);
	const tag = `pi-test-since-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [index, horizon, since] = [`${tag}:index`, `${tag}:horizon`, `${tag}:since`];
	const ttl = MIRROR_MAX_DAYS * 24 * 3600 * 1000;
	const write = (id, score, writtenMs, cutoff = 0) => redis.eval(TRIM_SCRIPT, 3, index, horizon, since, cutoff, 10, ttl, RUNS_HORIZON_MEMBER, score, id, writtenMs);
	const start = () => redis.hgetall(since);
	try {
		await write("a", 1_000_000_000_100, 1_000_000_000_150);
		assert.deepEqual(await start(), { at: "1000000000150", member: "a" }, "a new index: the write's time, vouched for by its run");
		atDepth(await redis.pttl(since), ttl, "at the index's depth");
		await write("b", 1_000_000_000_200, 1_000_000_000_250);
		assert.deepEqual(await start(), { at: "1000000000150", member: "a" }, "kept while its run is held");
		// A peer's short retention trims the start's run: `at` stays, the oldest run kept vouches for it.
		await write("c", 1_000_000_000_300, 1_000_000_000_350, 1_000_000_000_150);
		assert.equal(await redis.zscore(horizon, RUNS_HORIZON_MEMBER), "1000000000150");
		assert.deepEqual(await start(), { at: "1000000000150", member: "b" }, "handed on, never moved");
		// The expiry moves with the index's: shorten both, write, and both are back at the depth exactly.
		await redis.pexpire(index, 1000);
		await redis.pexpire(since, 1000);
		await write("d", 1_000_000_000_400, 1_000_000_000_450);
		atDepth(await redis.pttl(since), ttl);
		atDepth(await redis.pttl(index), ttl);
		// A start whose run is not in the index (an older worker removed it, or recreated the index): this write cannot
		// trust it, and starts it at the index's oldest run before the write.
		await redis.hset(since, "member", "gone");
		await write("old-score", 1_000_000_000_050, 1_000_000_000_500);
		assert.deepEqual(await start(), { at: "1000000000200", member: "b" });
		// No start at all (an older writer's index, or the key was lost): the same.
		await redis.del(since);
		await write("f", 1_000_000_000_550, 1_000_000_000_560);
		assert.deepEqual(await start(), { at: "1000000000050", member: "old-score" });
		// Every runs:* key gone, or only the index: the next write starts the mirror again, at that write.
		await redis.del(index);
		await write("e", 1_000_000_000_600, 1_000_000_000_650);
		assert.deepEqual(await start(), { at: "1000000000650", member: "e" }, "a start that outlived its index is replaced");
	} finally {
		await redis.del(index, horizon, since);
		await redis.quit();
	}
});

/** A client whose every key (a script's KEYS too) is under a prefix of its own, so the fixed `runs:*` names stay apart. */
async function prefixed(tag) {
	const { Redis } = await import("ioredis");
	const prefix = `pi-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}:`;
	const redis = new Redis(url, { keyPrefix: prefix, maxRetriesPerRequest: 1 });
	redis.cleanup = async () => {
		const left = await redis.keys(`${prefix}*`);
		if (left.length > 0) await redis.del(...left.map((k) => k.slice(prefix.length)));
		await redis.quit();
	};
	return redis;
}

/** A worker from before the start key (4.0.1): its member and its own trims, the index expiring at ITS retention. */
async function olderWrite(redis, id, score, { retentionDays = 30 } = {}) {
	await redis.set(`runs:rec:${id}`, JSON.stringify({ jobId: id, host: "hostb", endedAt: new Date(score).toISOString() }), "PX", retentionDays * 86_400_000);
	await redis.zadd("runs:index", score, id);
	await redis.pexpire("runs:index", retentionDays * 86_400_000);
}

test("an index an older worker recreated after its own expiry does not inherit the start that outlived it", { skip }, async () => {
	const { makeRunMirror } = await import("../src/run-mirror.mjs");
	const { readMirrorWindow } = await import("../src/capacity-records.mjs");
	const redis = await prefixed("expired-index");
	const T0 = Date.parse("2026-07-01T00:00:00.000Z");
	const D = 86_400_000;
	let clock = T0;
	const write = (id, at) => ((clock = at), makeRunMirror({ redis, retentionDays: 30, now: () => clock }).mirror({ jobId: id, host: "hosta", endedAt: new Date(at).toISOString() }, id));
	try {
		for (let d = 0; d < 20; d++) await write(`n${d}`, T0 + d * D);
		await olderWrite(redis, "old", T0 + 20 * D);
		assert.ok((await redis.pttl("runs:index")) <= 30 * D, "the older worker set the index's expiry to its own 30 days");
		// A quiet month: the index's 30 days run out, the start's 92 do not.
		await redis.del("runs:index");
		const F = T0 + 50 * D;
		await olderWrite(redis, "b1", F + 3_600_000);
		const read = await readMirrorWindow(redis, { sinceMs: F + 2 * 3_600_000 - 92 * D, nowMs: F + 2 * 3_600_000 });
		assert.equal(read.fromMs, F + 3_600_000, "the start's run is not in the index: from its oldest run, not the stale start");
		await write("n-after", F + 2 * 3_600_000);
		assert.deepEqual(await redis.hgetall("runs:since"), { at: String(F + 3_600_000), member: "b1" }, "the writer replaces the start it cannot trust");
		const after = await readMirrorWindow(redis, { sinceMs: F + 3 * 3_600_000 - 92 * D, nowMs: F + 3 * 3_600_000 });
		assert.equal(after.fromMs, F + 3_600_000);
	} finally {
		await redis.cleanup();
	}
});

test("a pruning reader that removes every member takes the start with it, and records the cut, so an older worker's recreated index starts at its own run", { skip }, async () => {
	const { makeRunMirror, readMirroredRuns } = await import("../src/run-mirror.mjs");
	const { readMirrorWindow } = await import("../src/capacity-records.mjs");
	const redis = await prefixed("emptied");
	const T0 = Date.parse("2026-07-01T00:00:00.000Z");
	const D = 86_400_000;
	let clock = T0;
	try {
		for (let d = 0; d < 20; d++) {
			clock = T0 + d * D;
			await makeRunMirror({ redis, retentionDays: 30, now: () => clock }).mirror({ jobId: `n${d}`, host: "hosta", endedAt: new Date(clock).toISOString() }, `n${d}`);
		}
		for (const k of await redis.keys(`${redis.options.keyPrefix}runs:rec:*`)) await redis.del(k.slice(redis.options.keyPrefix.length));
		await readMirroredRuns(redis, { limit: 5000, sinceMs: 0 });
		assert.deepEqual([await redis.exists("runs:index"), await redis.exists("runs:since")], [0, 0], "no index, no start");
		assert.equal(await redis.zscore("runs:horizon", "trim"), String(T0 + 19 * D), "the cut is recorded");
		const F = T0 + 45 * D;
		await olderWrite(redis, "b1", F + 3_600_000);
		const read = await readMirrorWindow(redis, { sinceMs: F + 2 * 3_600_000 - 92 * D, nowMs: F + 2 * 3_600_000 });
		assert.equal(read.fromMs, F + 3_600_000);
	} finally {
		await redis.cleanup();
	}
});

test("a pruning reader no longer erases the expired-body bound: the time up to the runs it removed stays missing", { skip }, async () => {
	const { makeRunMirror, readMirroredRuns } = await import("../src/run-mirror.mjs");
	const { readMirrorWindow } = await import("../src/capacity-records.mjs");
	const redis = await prefixed("pruned");
	const T0 = Date.parse("2026-07-01T00:00:00.000Z");
	const D = 86_400_000;
	let clock = T0;
	const write = (id, at, retentionDays) => ((clock = at), makeRunMirror({ redis, retentionDays, now: () => clock }).mirror({ jobId: id, host: id[0] === "a" ? "hosta" : "hostb", endedAt: new Date(at).toISOString() }, id));
	try {
		// hosta keeps 7 days and goes quiet after ten; hostb keeps 30 and goes on.
		for (let d = 0; d < 10; d++) await write(`a${d}`, T0 + d * D, 7);
		for (let d = 10; d < 25; d++) await write(`b${d}`, T0 + d * D, 30);
		const now = T0 + 25 * D;
		for (let d = 0; d < 10; d++) await redis.del(`runs:rec:a${d}`); // their 7 day bodies expired; hostb's trims keep the members
		const before = await readMirrorWindow(redis, { sinceMs: now - 30 * D, nowMs: now });
		assert.equal(before.fromMs, T0 + 9 * D, "the newest expired body bounds it");
		await readMirroredRuns(redis, { limit: 5000, sinceMs: now - 30 * D });
		const after = await readMirrorWindow(redis, { sinceMs: now - 30 * D, nowMs: now });
		assert.equal(after.fromMs, T0 + 9 * D, "and still does once a panel's read pruned them: the horizon holds it");
	} finally {
		await redis.cleanup();
	}
});

test("losing every runs:* key, then one more write: a peer reads the lost runs as missing, never as idle", { skip }, async () => {
	const { Redis } = await import("ioredis");
	const { makeRunMirror } = await import("../src/run-mirror.mjs");
	const { readCapacityRecords } = await import("../src/capacity-records.mjs");
	const { computeCapacity } = await import("../src/capacity.mjs");
	const { tempDir } = await import("./helpers/temp-dir.mjs");
	// The mirror's keys are fixed names, so this client prefixes every key (KEYS of a script too) to stay apart.
	const prefix = `pi-test-lost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}:`;
	const redis = new Redis(url, { keyPrefix: prefix, maxRetriesPerRequest: 1 });
	const NOW = Date.parse("2026-10-09T12:00:00.000Z");
	const H = 3_600_000;
	const CAP = { slots: 3, memMiB: 4096, cpuCenti: 400, cpus: 4 };
	const run = (jobId, from, to) => ({ jobId, host: "hosta", project: "shop", startedAt: new Date(NOW - from * H).toISOString(), endedAt: new Date(NOW - to * H).toISOString(), capacity: CAP, outcome: "completed" });
	let clock = NOW - 12 * H;
	const mirror = makeRunMirror({ redis, retentionDays: 30, now: () => clock });
	try {
		// Ten hours of hosta busy, written as each run ended.
		for (const [id, from, to] of [["a1", 20, 15], ["a2", 15, 10], ["a3", 10, 5]]) {
			clock = NOW - to * H;
			assert.equal(await mirror.mirror(run(id, from, to), id), true);
		}
		// A flushed Valkey: every runs:* key gone. Then one more job on hosta, written at its end.
		const keys = await redis.keys(`${prefix}runs:*`);
		assert.ok(keys.length >= 5, "the index, the start and the bodies were there");
		await redis.del(...keys.map((k) => k.slice(prefix.length)));
		clock = NOW - H;
		assert.equal(await mirror.mirror(run("a4", 2, 1), "a4"), true);

		// hostb reads the fleet: no local files of its own runs, both hosts named.
		const sinceMs = NOW - 24 * H;
		const read = await readCapacityRecords({ redis, logsDir: tempDir("pi-cap-lost-"), sinceMs, nowMs: NOW, retentionDays: 30, localHost: "hostb" });
		const live = [{ name: "hosta", routes: "true" }, { name: "hostb", routes: "true" }];
		const report = computeCapacity({ records: read.records, live, windowStartMs: sinceMs, nowMs: NOW, bucketMs: H, coverage: read.coverage });
		const a = report.hosts.find((h) => h.name === "hosta");
		assert.equal(a.coverage.fromMs, NOW - H, "hosta's history starts where the mirror started again");
		assert.equal(a.coverage.truncated, true);
		assert.equal(a.missingMs, 23 * H, "the lost runs are missing time");
		assert.deepEqual([a.busyMs, a.idleMs], [0, H], "only the hour since the mirror started again is covered (the last run ended as it did)");
		assert.equal(report.coverage.truncated, true);
	} finally {
		const left = await redis.keys(`${prefix}*`);
		if (left.length > 0) await redis.del(...left.map((k) => k.slice(prefix.length)));
		await redis.quit();
	}
});

test("a pruning reader never hands on a start it did not trust: one left under a recreated index stays untrusted", { skip }, async () => {
	const { makeRunMirror, readMirroredRuns } = await import("../src/run-mirror.mjs");
	const { readMirrorWindow } = await import("../src/capacity-records.mjs");
	const redis = await prefixed("stale-prune");
	const T0 = Date.parse("2026-07-01T00:00:00.000Z");
	const D = 86_400_000;
	const H = 3_600_000;
	let clock = T0;
	try {
		for (let d = 0; d < 20; d++) {
			clock = T0 + d * D;
			await makeRunMirror({ redis, retentionDays: 30, now: () => clock }).mirror({ jobId: `n${d}`, host: "hosta", endedAt: new Date(clock).toISOString() }, `n${d}`);
		}
		// The index lost on its own, and an older worker recreates it with two runs; one body then expires.
		await redis.del("runs:index");
		const F = T0 + 20 * D + H;
		await olderWrite(redis, "b1", F + H);
		await olderWrite(redis, "b2", F + 2 * H);
		await redis.del("runs:rec:b1");
		await readMirroredRuns(redis, { limit: 5000, sinceMs: 0 });
		assert.deepEqual(await redis.hgetall("runs:since"), { at: String(T0), member: "n0" }, "left as it was: its run is not in this index");
		const read = await readMirrorWindow(redis, { sinceMs: F + 3 * H - 30 * D, nowMs: F + 3 * H });
		assert.equal(read.fromMs, F + 2 * H, "from what the index holds and the pruned run's cut, never the stale start");
	} finally {
		await redis.cleanup();
	}
});

test("a start that is not a hash (a stray string) is read as absent and replaced by the next write: the mirror keeps working", { skip }, async () => {
	const { makeRunMirror, readMirroredRuns } = await import("../src/run-mirror.mjs");
	const { readMirrorWindow } = await import("../src/capacity-records.mjs");
	const redis = await prefixed("stray");
	const T0 = Date.parse("2026-07-01T00:00:00.000Z");
	const H = 3_600_000;
	let clock = T0;
	const write = (id, at) => ((clock = at), makeRunMirror({ redis, retentionDays: 30, now: () => clock }).mirror({ jobId: id, host: "hosta", endedAt: new Date(at).toISOString() }, id));
	try {
		await olderWrite(redis, "a1", T0);
		await redis.set("runs:since", String(T0 - 100 * H));
		const read = await readMirrorWindow(redis, { sinceMs: T0 - 200 * H, nowMs: T0 + H });
		assert.deepEqual([read.state, read.fromMs], ["ok", T0], "read as absent: from the oldest run");
		await redis.del("runs:rec:a1");
		await readMirroredRuns(redis, { limit: 50, sinceMs: 0 });
		assert.equal(await redis.exists("runs:since"), 0, "a pruning reader deletes the stray value too");
		await olderWrite(redis, "a1", T0);
		await redis.set("runs:since", "stray");
		assert.equal(await write("a2", T0 + H), true, "the write succeeds");
		assert.deepEqual(await redis.hgetall("runs:since"), { at: String(T0), member: "a1" }, "the start is the oldest run");
	} finally {
		await redis.cleanup();
	}
});
