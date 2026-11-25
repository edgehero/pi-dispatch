import assert from "node:assert/strict";
import { test } from "node:test";
import { HELD_PRUNE_SCRIPT, HELD_SET, HELD_SWEEP_LOOK_MAX, jobKey, makeWaitState, pruneHeld, sweepHeld } from "../src/wait-state.mjs";

// Issue #1075: the worker's sweep of the held index (`wait:held`) and the one prune script every pruner sends. Against a
// fake that runs the script as Valkey would, then against a real Valkey on a database of this file's own.

/**
 * A fake with the sweep's surface: SSCAN over the set as it stood when the walk began (cursor "0"), `page` places a call,
 * answering the members still there (a cursor that is the next place, "0" at the end), as SSCAN guarantees: removals
 * during a walk move no member past it. And EVAL of the prune script, run as the script reads. `beforePrune(id)` runs
 * before each member is judged, for a hold written between the sweep's look and the script.
 */
function fakeRedis({ members = [], hashes = {}, page = 64, beforePrune = () => {} } = {}) {
	const set = new Set(members);
	const sent = [];
	let walk = [];
	return {
		set,
		hashes,
		sent,
		async sscan(key, cursor, countWord, count) {
			sent.push(["sscan", key, cursor, countWord, count]);
			if (cursor === "0") walk = [...set];
			const from = Number(cursor);
			const next = from + page;
			return [next >= walk.length ? "0" : String(next), walk.slice(from, next).filter((id) => set.has(id))];
		},
		async eval(script, numKeys, ...args) {
			assert.equal(script, HELD_PRUNE_SCRIPT);
			const keys = args.slice(0, numKeys);
			const ids = args.slice(numKeys);
			assert.equal(keys[0], HELD_SET);
			assert.deepEqual(keys.slice(1), ids.map(jobKey), "every key declared, each member's own hash");
			sent.push(["eval", ids.length]);
			let removed = 0;
			for (const id of ids) {
				beforePrune(id);
				const h = hashes[jobKey(id)];
				if (h === "WRONGTYPE") continue;
				if ((h?.since ?? "") === "" && set.delete(id)) removed += 1;
			}
			return removed;
		},
	};
}

const hold = (since = "1764072000000") => ({ since, target: "o/r#1", label: "ci" });

test("the sweep removes a member with no hash and one whose hash has no clock, and keeps a live hold (#1075)", async () => {
	const redis = fakeRedis({ members: ["gone", "counters-only", "live", "empty-clock"], hashes: { [jobKey("counters-only")]: { checks: "3", faults: "0" }, [jobKey("live")]: hold(), [jobKey("empty-clock")]: { since: "" } } });
	assert.deepEqual(await sweepHeld({ redis }), { looked: 4, removed: 3, more: false });
	assert.deepEqual([...redis.set], ["live"], "the readers' own rule: no `since`, or an empty one, is stale");
});

test("a hold written between the sweep's look and the script keeps its member: the look is the script's own (#1075)", async () => {
	const hashes = {};
	const redis = fakeRedis({
		members: ["renewed", "gone"],
		hashes,
		beforePrune: (id) => {
			if (id === "renewed") hashes[jobKey("renewed")] = hold();
		},
	});
	assert.deepEqual(await sweepHeld({ redis }), { looked: 2, removed: 1, more: false });
	assert.deepEqual([...redis.set], ["renewed"]);
});

test("a hash Valkey answers with an error keeps its member, as a reader that cannot read it removes nothing (#1075)", async () => {
	const redis = fakeRedis({ members: ["odd", "gone"], hashes: { [jobKey("odd")]: "WRONGTYPE" } });
	assert.deepEqual(await sweepHeld({ redis }), { looked: 2, removed: 1, more: false });
	assert.deepEqual([...redis.set], ["odd"]);
});

test("one pass looks at no more than its bound, says more remain, and the next pass goes on from what is left (#1075)", async () => {
	assert.equal(HELD_SWEEP_LOOK_MAX, 10_000, "five times what a reader looks at");
	const members = Array.from({ length: 300 }, (_, i) => `gone-${i}`);
	const redis = fakeRedis({ members });
	// A bound that falls inside a page: the page is cut at the member, and the cut members are left for the next pass.
	assert.deepEqual(await sweepHeld({ redis, lookMax: 100 }), { looked: 100, removed: 100, more: true });
	assert.equal(redis.set.size, 200);
	assert.deepEqual(redis.sent.filter(([what]) => what === "sscan").map(([, key, cursor, word, count]) => [key, cursor, word, count]), [[HELD_SET, "0", "COUNT", 64], [HELD_SET, "64", "COUNT", 64]], "SSCAN pages of 64, never SMEMBERS");
	assert.deepEqual(await sweepHeld({ redis, lookMax: 1000 }), { looked: 200, removed: 200, more: false });
	assert.equal(redis.set.size, 0);
	// A small set answers whole on its first page, whatever COUNT asked: the bound is still held to the member.
	const whole = fakeRedis({ members: Array.from({ length: 120 }, (_, i) => `g-${i}`), page: 1000 });
	assert.deepEqual(await sweepHeld({ redis: whole, lookMax: 50 }), { looked: 50, removed: 50, more: true });
});

test("a sweep stops between pages once the retention sweep closes, and says members remain (#1075)", async () => {
	const redis = fakeRedis({ members: Array.from({ length: 200 }, (_, i) => `gone-${i}`) });
	let pages = 0;
	const sscan = redis.sscan.bind(redis);
	redis.sscan = async (...args) => (pages += 1, sscan(...args));
	assert.deepEqual(await sweepHeld({ redis, stopped: () => pages >= 2 }), { looked: 128, removed: 128, more: true });
});

test("an empty index costs one SSCAN and no script; an answer of the wrong shape throws, for the retention sweep to log (#1075)", async () => {
	const empty = fakeRedis();
	assert.deepEqual(await sweepHeld({ redis: empty }), { looked: 0, removed: 0, more: false });
	assert.deepEqual(empty.sent.map(([what]) => what), ["sscan"]);
	for (const reply of [null, ["x", []], [0, []], ["0", "a"], ["123456789012345678901", []]]) {
		await assert.rejects(() => sweepHeld({ redis: { sscan: async () => reply, eval: async () => 0 } }), /unexpected shape/);
	}
	await assert.rejects(() => pruneHeld({ eval: async () => "1" }, ["a"]), /count/);
	assert.equal(await pruneHeld({ eval: async () => assert.fail("no script for nothing") }, []), 0);
});

// ── against a real Valkey ─────────────────────────────────────────────────────────────────────────────

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("held-sweep REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const skip = url ? false : "VALKEY_TEST_URL not set; CI runs these";
// Database 11, this file's alone: the held index has one fixed key, and other files plant stale members in database 0's
// and count them, so a sweep there would race them.
const OWN_DB = url ? Object.assign(new URL(url), { pathname: "/11" }).href : undefined;

async function ownDatabase(t) {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(OWN_DB);
	const made = new Set();
	const tidy = async () => {
		await redis.del(HELD_SET, ...[...made].map(jobKey)).catch(() => {});
	};
	await tidy();
	t.after(async () => {
		await tidy();
		redis.disconnect();
	});
	return { redis, made };
}

test("on a real Valkey: 3,000 stale members and one live hold, one pass removes the stale ones, and a reader's look sees the hold whole (#1075)", { skip, timeout: 60_000 }, async (t) => {
	const { redis, made } = await ownDatabase(t);
	const now = Date.now();
	const waits = makeWaitState({ redis, now: () => now });
	await waits.hold("live-1", { dedupId: "o/r#1:fix#0", target: "o/r#1", label: "ci", untilMs: now + 60_000 });
	made.add("live-1");
	const stale = Array.from({ length: 3000 }, (_, i) => `gone-${i}`);
	for (const id of stale) made.add(id);
	await redis.sadd(HELD_SET, ...stale);
	// A counter's hash with no clock is stale too, and a key of another type keeps its member.
	await redis.hset(jobKey("gone-0"), "checks", "2");
	await redis.set(jobKey("odd"), "x");
	await redis.sadd(HELD_SET, "odd");
	made.add("odd");
	// SSCAN may answer a member twice when the set is resized under the walk, never miss one: `looked` is a floor.
	const swept = await sweepHeld({ redis });
	assert.deepEqual([swept.looked >= 3002, swept.removed, swept.more], [true, 3000, false]);
	assert.deepEqual((await redis.smembers(HELD_SET)).sort(), ["live-1", "odd"]);
	assert.equal(await redis.hget(jobKey("live-1"), "since"), String(now), "the live hold is untouched");
	assert.equal(await redis.exists(jobKey("gone-0")), 1, "the sweep removes members, never a hash");
	assert.deepEqual(await sweepHeld({ redis }), { looked: 2, removed: 0, more: false }, "and a second pass finds nothing to do");
	await waits.release("live-1", { dedupId: "o/r#1:fix#0" });
});

test("on a real Valkey: a hold written between the look and the script is kept, and two sweeps at once remove each member once (#1075)", { skip, timeout: 60_000 }, async (t) => {
	const { redis, made } = await ownDatabase(t);
	const now = Date.now();
	const waits = makeWaitState({ redis, now: () => now });
	for (const id of ["renewed", "gone-a", "gone-b"]) made.add(id);
	await redis.sadd(HELD_SET, "renewed", "gone-a", "gone-b");
	// The sweep's page names "renewed" with no hash; the job's wake renews its hold before the script runs.
	const racing = {
		sscan: (...args) => redis.sscan(...args),
		eval: async (...args) => {
			await waits.hold("renewed", { dedupId: "o/r#2:fix#0", target: "o/r#2", label: "ci", untilMs: now + 60_000 });
			return redis.eval(...args);
		},
	};
	assert.deepEqual(await sweepHeld({ redis: racing }), { looked: 3, removed: 2, more: false });
	assert.deepEqual(await redis.smembers(HELD_SET), ["renewed"]);
	// Two hosts' sweeps over one crowd: each member is removed once, and the counts add up to the crowd.
	const crowd = Array.from({ length: 500 }, (_, i) => `crowd-${i}`);
	for (const id of crowd) made.add(id);
	await redis.sadd(HELD_SET, ...crowd);
	const { makeRedisClient } = await import("../src/connection.mjs");
	const other = makeRedisClient(OWN_DB);
	t.after(() => other.disconnect());
	const [a, b] = await Promise.all([sweepHeld({ redis }), sweepHeld({ redis: other })]);
	assert.equal(a.removed + b.removed, 500);
	assert.deepEqual(await redis.smembers(HELD_SET), ["renewed"]);
	assert.equal(await pruneHeld(redis, ["renewed", "not-a-member"]), 0, "a live hold and a name that is no member: nothing removed");
});
