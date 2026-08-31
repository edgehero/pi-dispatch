import assert from "node:assert/strict";
import { test } from "node:test";
import { makeStallGuard, stallKey } from "../src/scheduler-stall-guard.mjs";

const WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Minimal ioredis-compatible fake: a plain string store plus per-method call counters.
 *
 * One key per scheduler since issue #267, so the fake models keys rather than hash fields -- and it carries
 * a CLOCK, because the defect being fixed was entirely about whose activity moves whose expiry. A fake with
 * no clock cannot tell a per-key window from a per-hash one.
 */
function fakeRedis() {
	const store = new Map(); // key -> { value, deadline }
	const calls = { incr: 0, expire: 0, del: 0 };
	const expires = []; // { key, seconds } per expire call
	const clock = { now: 0 };
	const live = (key) => {
		const e = store.get(key);
		if (e && clock.now >= e.deadline) {
			store.delete(key);
			return undefined;
		}
		return e;
	};
	return {
		store,
		calls,
		expires,
		clock,
		count(schedulerId) {
			return live(stallKey(schedulerId))?.value;
		},
		async incr(key) {
			calls.incr++;
			const e = live(key);
			const v = (e?.value ?? 0) + 1;
			store.set(key, { value: v, deadline: e?.deadline ?? Infinity });
			return v;
		},
		async expire(key, seconds) {
			calls.expire++;
			expires.push({ key, seconds });
			const e = live(key);
			if (e) e.deadline = clock.now + seconds * 1000;
		},
		async del(key) {
			calls.del++;
			store.delete(key);
		},
	};
}

/** removeJobScheduler spy; records ids, optionally rejects as if the scheduler were already gone. */
function makeRemoveSpy({ throwNotFound = false } = {}) {
	const removed = [];
	const fn = async (id) => {
		removed.push(id);
		if (throwNotFound) throw new Error(`Job scheduler ${id} not found`);
	};
	fn.removed = removed;
	return fn;
}

/** log spy: keeps every (event, fields) call and offers a per-event filter. */
function makeLog() {
	const entries = [];
	const fn = (event, fields) => entries.push({ event, fields });
	fn.entries = entries;
	fn.of = (event) => entries.filter((e) => e.event === event);
	return fn;
}

test("ordinary (non-repeat) jobId is a no-op -- no hincrby, no teardown", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	await onStalled("local-abc");

	assert.equal(redis.calls.incr, 0);
	assert.equal(redis.calls.expire, 0);
	assert.deepEqual(removeJobScheduler.removed, []);
	assert.equal(log.entries.length, 0);
});

test("repeat:<id>:<millis> increments that scheduler's OWN counter key", async () => {
	const redis = fakeRedis();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler: makeRemoveSpy(), log: makeLog() });

	await onStalled("repeat:nightly-tidy:1699999999999");

	assert.equal(redis.calls.incr, 1);
	assert.equal(redis.count("nightly-tidy"), 1);
});

test("N stalls at or below threshold do not tear down", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	for (let i = 0; i < 3; i++) await onStalled("repeat:nightly-tidy:1699999999999");

	assert.equal(redis.count("nightly-tidy"), 3);
	assert.deepEqual(removeJobScheduler.removed, []);
	assert.equal(redis.calls.del, 0);
	assert.equal(log.of("scheduler_torn_down").length, 0);
});

test("the stall that crosses threshold (count === threshold+1) tears down exactly once", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	for (let i = 0; i < 4; i++) await onStalled("repeat:nightly-tidy:1699999999999");

	assert.deepEqual(removeJobScheduler.removed, ["nightly-tidy"]);
	assert.equal(redis.calls.del, 1);
	const torn = log.of("scheduler_torn_down");
	assert.equal(torn.length, 1);
	assert.deepEqual(torn[0].fields, { schedulerId: "nightly-tidy", stalls: 4 });
});

test("expire is set on every increment, and on THAT SCHEDULER'S key -- not a shared one", () => {
	// The assertion this replaces pinned the defect: it required every `expire` to target one shared hash,
	// which is precisely what let any scheduler's stall push every other scheduler's window forward.
	const redis = fakeRedis();
	const onStalled = makeStallGuard({ redis, threshold: 10, removeJobScheduler: makeRemoveSpy(), log: makeLog() });
	return (async () => {
		for (let i = 0; i < 3; i++) await onStalled("repeat:nightly-tidy:1699999999999");
		assert.equal(redis.calls.expire, redis.calls.incr);
		assert.equal(redis.calls.expire, 3);
		for (const e of redis.expires) {
			assert.equal(e.key, stallKey("nightly-tidy"), "each expire targets the stalling scheduler's own key");
			assert.equal(e.seconds, WINDOW_SECONDS);
		}
	})();
});

test("a NOISY scheduler cannot keep a QUIET one's count alive -- the money finding", async () => {
	// The defect, and the reason this file never caught it: every test here used a single scheduler id, and
	// with one id a per-hash window and a per-key window are indistinguishable.
	//
	// Same three stalls ninety days apart. Quiet deployment: the window lapses twice, so the count never
	// reaches the threshold. With a neighbour stalling twice a day the shared EXPIRE never lapsed, the count
	// accumulated across three months, and the trigger was torn down. Same scheduler, same stalls, opposite
	// outcome, decided entirely by an unrelated trigger.
	const DAY = 24 * 60 * 60 * 1000;
	for (const noisy of [false, true]) {
		const redis = fakeRedis();
		const removeJobScheduler = makeRemoveSpy();
		const onStalled = makeStallGuard({ redis, threshold: 2, removeJobScheduler, log: makeLog() });

		await onStalled("repeat:nightly:1");
		for (let h = 12; h <= 24 * 90; h += 12) {
			redis.clock.now = h * 3600 * 1000;
			if (noisy) await onStalled("repeat:other:9");
		}
		await onStalled("repeat:nightly:2");
		await onStalled("repeat:nightly:3");

		assert.deepEqual(
			removeJobScheduler.removed.filter((id) => id === "nightly"),
			[],
			`three stalls across ninety days is not sustained stalling${noisy ? ", and a noisy neighbour must not make it look like it" : ""}`,
		);
	}
	// And the window still works: three stalls INSIDE one window do tear down.
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const onStalled = makeStallGuard({ redis, threshold: 2, removeJobScheduler, log: makeLog() });
	for (let i = 0; i < 3; i++) await onStalled("repeat:wedged:1");
	assert.deepEqual(removeJobScheduler.removed, ["wedged"], "sustained stalling inside one window still trips");
	assert.equal(redis.clock.now < DAY, true);
});

test("a removeJobScheduler not-found rejection is swallowed; teardown still completes", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy({ throwNotFound: true });
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	// resolves despite removeJobScheduler throwing
	for (let i = 0; i < 4; i++) await onStalled("repeat:nightly-tidy:1699999999999");

	assert.deepEqual(removeJobScheduler.removed, ["nightly-tidy"]);
	assert.equal(redis.calls.del, 1, "the counter is cleared even though remove threw");
	assert.equal(log.of("scheduler_torn_down").length, 1, "torn_down logged even though remove threw");
	assert.equal(log.of("scheduler_teardown_remove_failed").length, 1);
});

test("empty schedulerId (repeat::123) is logged and never hincrby'd", async () => {
	const redis = fakeRedis();
	const removeJobScheduler = makeRemoveSpy();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler, log });

	await onStalled("repeat::123");

	assert.equal(redis.calls.incr, 0);
	assert.deepEqual(removeJobScheduler.removed, []);
	assert.equal(log.of("scheduler_stall_unparsed").length, 1);
});

test("degenerate repeat:<n> (single colon) is also treated as empty schedulerId", async () => {
	const redis = fakeRedis();
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler: makeRemoveSpy(), log });

	await onStalled("repeat:123");

	assert.equal(redis.calls.incr, 0);
	assert.equal(log.of("scheduler_stall_unparsed").length, 1);
});

test("a redis.hincrby that throws does not reject onStalled -- error is swallowed and logged", async () => {
	const redis = {
		async hincrby() {
			throw new Error("redis down");
		},
		async expire() {},
		async hdel() {},
	};
	const log = makeLog();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler: makeRemoveSpy(), log });

	await assert.doesNotReject(onStalled("repeat:nightly-tidy:1699999999999"));
	assert.equal(log.of("scheduler_stall_guard_error").length, 1);
});

test("a schedulerId with valid internal chars parses correctly", async () => {
	const redis = fakeRedis();
	const onStalled = makeStallGuard({ redis, threshold: 3, removeJobScheduler: makeRemoveSpy(), log: makeLog() });

	await onStalled("repeat:my.flow-1:123");

	assert.equal(redis.count("my.flow-1"), 1);
});
