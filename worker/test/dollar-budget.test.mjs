import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_TTL_SECONDS, MONTH_TTL_SECONDS, WEEK_TTL_SECONDS } from "../src/budget.mjs";
import { DOLLAR_BASIS, DOLLAR_KEY_PREFIX, FLOOR_COUNTERS, PROJECT_DOLLAR_KEY_PREFIX, SETTLE_SCRIPT, dollarLedgers, dollarSettlement, dollarWindowCaps, dollarsRecord, meteredMicros, releaseDollars, reserveDollars, settleDollars } from "../src/dollar-budget.mjs";

/**
 * A keyed fake of the ioredis calls dollar-budget.mjs makes. Each call awaits once before it acts, so parallel
 * callers interleave between commands the way they would against a server, and each command is atomic, as INCRBY is.
 * `failOn` makes the Nth call of a command reject, to drive the fault paths.
 */
function keyedRedis({ failOn = {} } = {}) {
	const store = new Map();
	const ttls = new Map();
	const calls = [];
	const counts = {};
	const step = async (op) => {
		await Promise.resolve();
		counts[op] = (counts[op] ?? 0) + 1;
		if (failOn[op] === counts[op]) throw Object.assign(new Error(`${op} refused`), { code: "ECONNRESET" });
	};
	const redis = {
		store,
		ttls,
		calls,
		async incrby(key, n) {
			await step("incrby");
			assert.ok(Number.isSafeInteger(n), `INCRBY takes integers only, got ${n}`);
			calls.push(["incrby", key, n]);
			const v = (store.get(key) ?? 0) + n;
			store.set(key, v);
			return v;
		},
		async decrby(key, n) {
			await step("decrby");
			assert.ok(Number.isSafeInteger(n), `DECRBY takes integers only, got ${n}`);
			calls.push(["decrby", key, n]);
			const v = (store.get(key) ?? 0) - n;
			store.set(key, v);
			return v;
		},
		// SETTLE_SCRIPT's semantics, one atomic step: a missing key is skipped, a result below 0 is clamped back to 0.
		async eval(script, numKeys, key, arg) {
			await step("eval");
			assert.equal(script, SETTLE_SCRIPT);
			assert.equal(numKeys, 1);
			const delta = Number(arg);
			assert.ok(Number.isSafeInteger(delta), `the settle delta is an integer, got ${arg}`);
			calls.push(["settle", key, delta]);
			if (!store.has(key)) return [1, 0];
			const v = store.get(key) + delta;
			if (v < 0) {
				store.set(key, 0);
				return [2, 0];
			}
			store.set(key, v);
			return [0, v];
		},
		async expire(key, s) {
			await step("expire");
			calls.push(["expire", key, s]);
			ttls.set(key, s);
			return 1;
		},
	};
	return redis;
}

const USD = 1_000_000;
const NOW = new Date("2026-10-07T12:00:00Z"); // a Wednesday; its Monday is 2026-10-05
const caps = (day = null, week = null, month = null) => ({ day, week, month });

test("the keys are budget:usd:<day>, budget:usd:w:<Monday> and budget:usd:m:<month>, on budget.mjs's UTC boundaries and TTLs", async () => {
	const redis = keyedRedis();
	const res = await reserveDollars(redis, { ledgers: dollarLedgers(caps(10 * USD, 50 * USD, 100 * USD)), amountMicros: 2 * USD, now: NOW });
	assert.equal(res.allowed, true);
	assert.deepEqual(res.hold, {
		amountMicros: 2 * USD,
		keys: ["budget:usd:2026-10-07", "budget:usd:w:2026-10-05", "budget:usd:m:2026-10"],
	});
	assert.deepEqual([...redis.ttls.entries()], [["budget:usd:2026-10-07", DAY_TTL_SECONDS], ["budget:usd:w:2026-10-05", WEEK_TTL_SECONDS], ["budget:usd:m:2026-10", MONTH_TTL_SECONDS]]);
	assert.deepEqual([...redis.store.entries()], [["budget:usd:2026-10-07", 2 * USD], ["budget:usd:w:2026-10-05", 2 * USD], ["budget:usd:m:2026-10", 2 * USD]]);
	assert.equal(DOLLAR_KEY_PREFIX, "budget:usd");
	assert.equal(PROJECT_DOLLAR_KEY_PREFIX, "budget:usd:p", "reserved for #499");
	assert.ok(![...redis.store.keys()].some((k) => k.startsWith("budget:usd:p:")), "no project key is ever written");
});

test("only ACTIVE windows are counted: a null cap is no window, and no window at all is an empty hold", async () => {
	const redis = keyedRedis();
	const res = await reserveDollars(redis, { ledgers: dollarLedgers(caps(null, 50 * USD, null)), amountMicros: USD, now: NOW });
	assert.deepEqual(res.hold.keys, ["budget:usd:w:2026-10-05"]);
	const none = await reserveDollars(keyedRedis(), { ledgers: [], amountMicros: USD, now: NOW });
	assert.deepEqual(none, { allowed: true, hold: { amountMicros: USD, keys: [] } });
});

test("dollarWindowCaps: null with no window set (the off switch), micro-dollars otherwise", () => {
	assert.equal(dollarWindowCaps({}), null);
	assert.equal(dollarWindowCaps({ maxCostUsd: "2", dailyCostUsd: null, weeklyCostUsd: undefined, monthlyCostUsd: null }), null, "a per-job cap alone reserves nothing");
	assert.deepEqual(dollarWindowCaps({ dailyCostUsd: "10", weeklyCostUsd: 25.5, monthlyCostUsd: null }), { day: 10 * USD, week: 25_500_000, month: null });
	assert.deepEqual(dollarLedgers(null), []);
});

test("reserving across several ledgers, with the TTL set on the FIRST write only", async () => {
	const redis = keyedRedis();
	const ledgers = [
		{ keyPrefix: "budget:usd", caps: caps(10 * USD) },
		{ keyPrefix: "budget:usd:s:abcdef0123456789", caps: caps(5 * USD, null, 20 * USD) },
	];
	const first = await reserveDollars(redis, { ledgers, amountMicros: USD, now: NOW });
	assert.deepEqual(first.hold.keys, ["budget:usd:2026-10-07", "budget:usd:s:abcdef0123456789:2026-10-07", "budget:usd:s:abcdef0123456789:m:2026-10"]);
	assert.equal(redis.calls.filter((c) => c[0] === "expire").length, 3, "each new key gets its TTL");
	await reserveDollars(redis, { ledgers, amountMicros: USD, now: NOW });
	assert.equal(redis.calls.filter((c) => c[0] === "expire").length, 3, "a second reservation does not push the expiry forward");
	assert.equal(redis.store.get("budget:usd:s:abcdef0123456789:2026-10-07"), 2 * USD);
});

test("a refusal gives back EVERY key it touched, the refusing one included, and names the ledger and window", async () => {
	const redis = keyedRedis();
	redis.store.set("budget:usd:w:2026-10-05", 49 * USD); // the week has $1 of room
	const ledgers = dollarLedgers(caps(10 * USD, 50 * USD, 100 * USD));
	const res = await reserveDollars(redis, { ledgers, amountMicros: 2 * USD, now: NOW });
	assert.deepEqual(res, { allowed: false, reason: "dollar-cap", ledger: "budget:usd", window: "week", reservedMicros: 51 * USD, capMicros: 50 * USD, stranded: 0 });
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 0, "the day it added to is given back");
	assert.equal(redis.store.get("budget:usd:w:2026-10-05"), 49 * USD, "the refusing week is given back too");
	assert.equal(redis.store.has("budget:usd:m:2026-10"), false, "the month after it was never touched");
});

test("a total EQUAL to the cap fits; one micro-dollar over refuses", async () => {
	const redis = keyedRedis();
	const ledgers = dollarLedgers(caps(10 * USD));
	for (let i = 0; i < 5; i++) assert.equal((await reserveDollars(redis, { ledgers, amountMicros: 2 * USD, now: NOW })).allowed, true, `job ${i + 1}`);
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 10 * USD);
	assert.equal((await reserveDollars(redis, { ledgers, amountMicros: 1, now: NOW })).allowed, false);
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 10 * USD, "refused and given back");
});

test("20 parallel $2 reservations against a $10 window admit at most 5, and after settling the counter is the sum settled (fake)", async () => {
	const redis = keyedRedis();
	const ledgers = dollarLedgers(caps(10 * USD));
	const results = await Promise.all(Array.from({ length: 20 }, () => reserveDollars(redis, { ledgers, amountMicros: 2 * USD, now: NOW })));
	const admitted = results.filter((r) => r.allowed);
	assert.ok(admitted.length <= 5, `admitted ${admitted.length}`);
	assert.ok(admitted.length >= 1);
	assert.ok(redis.store.get("budget:usd:2026-10-07") <= 10 * USD);
	const settled = admitted.map((_, i) => 300_001 * (i + 1));
	await Promise.all(admitted.map((r, i) => settleDollars(redis, r.hold, settled[i])));
	assert.equal(redis.store.get("budget:usd:2026-10-07"), settled.reduce((a, b) => a + b, 0));
});

test("settle applies ONE INCRBY of (settled - reserved) per held key, an overshoot is charged in full, and equal is a no-op", async () => {
	const redis = keyedRedis();
	const ledgers = dollarLedgers(caps(10 * USD, 50 * USD));
	const { hold } = await reserveDollars(redis, { ledgers, amountMicros: 2 * USD, now: NOW });
	redis.calls.length = 0;
	assert.deepEqual(await settleDollars(redis, hold, 350_000), { applied: 2, of: 2 });
	assert.deepEqual(redis.calls, [["settle", "budget:usd:2026-10-07", 350_000 - 2 * USD], ["settle", "budget:usd:w:2026-10-05", 350_000 - 2 * USD]]);
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 350_000);

	const over = await reserveDollars(redis, { ledgers, amountMicros: 2 * USD, now: NOW });
	await settleDollars(redis, over.hold, 2_400_000);
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 350_000 + 2_400_000, "above the reservation: charged in full, never capped");

	const same = await reserveDollars(redis, { ledgers, amountMicros: USD, now: NOW });
	redis.calls.length = 0;
	await settleDollars(redis, same.hold, USD);
	assert.deepEqual(redis.calls, [], "nothing to apply");
});

test("a reservation at 23:59:59 UTC settles into ITS day after midnight: the hold's keys, never the clock's", async () => {
	const redis = keyedRedis();
	const ledgers = dollarLedgers(caps(10 * USD, 50 * USD, 100 * USD));
	// Sunday 2026-10-11 23:59:59, the last second of a day, a week and (not) a month.
	const { hold } = await reserveDollars(redis, { ledgers, amountMicros: 2 * USD, now: new Date("2026-10-11T23:59:59Z") });
	// The settle takes no clock at all; a job that ends at 00:05 the next day touches only the reservation's keys.
	await settleDollars(redis, hold, 500_000);
	assert.equal(redis.store.get("budget:usd:2026-10-11"), 500_000);
	assert.equal(redis.store.get("budget:usd:w:2026-10-05"), 500_000);
	assert.equal(redis.store.has("budget:usd:2026-10-12"), false, "the next day is untouched");
	assert.equal(redis.store.has("budget:usd:w:2026-10-12"), false, "and the next week");
});

test("settle and release NEVER throw: a fault logs dollar_settle_error / dollar_release_error and leaves the rest standing", async () => {
	const redis = keyedRedis({ failOn: { eval: 1 } });
	const ledgers = dollarLedgers(caps(10 * USD, 50 * USD));
	const { hold } = await reserveDollars(redis, { ledgers, amountMicros: 2 * USD, now: NOW });
	const logged = [];
	const res = await settleDollars(redis, hold, 0, { log: (event, fields) => logged.push([event, fields]) }); // the first settle step fails
	assert.deepEqual(res, { applied: 0, of: 2 });
	assert.deepEqual(logged, [["dollar_settle_error", { code: "ECONNRESET", applied: 0, of: 2 }]]);
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 2 * USD, "the reservation stands: overcounting, the safe side");

	const r2 = keyedRedis({ failOn: { eval: 2 } });
	const h2 = (await reserveDollars(r2, { ledgers, amountMicros: 2 * USD, now: NOW })).hold;
	const l2 = [];
	assert.deepEqual(await releaseDollars(r2, h2, { log: (e, f) => l2.push([e, f]) }), { applied: 1, of: 2 });
	assert.deepEqual(l2, [["dollar_release_error", { code: "ECONNRESET", applied: 1, of: 2 }]]);
	assert.equal(r2.store.get("budget:usd:2026-10-07"), 0);
	assert.equal(r2.store.get("budget:usd:w:2026-10-05"), 2 * USD);
});

test("settle refuses a settled amount that is not integer micro-dollars (a float, NaN, negative) and keeps the reservation", async () => {
	const redis = keyedRedis();
	const { hold } = await reserveDollars(redis, { ledgers: dollarLedgers(caps(10 * USD)), amountMicros: 2 * USD, now: NOW });
	for (const bad of [0.5, 1234.5, Number.NaN, -1, Infinity, "100"]) {
		const logged = [];
		assert.deepEqual(await settleDollars(redis, hold, bad, { log: (e, f) => logged.push([e, f]) }), { applied: 0, of: 1 }, String(bad));
		assert.deepEqual(logged, [["dollar_settle_error", { code: "not-micros", applied: 0, of: 1 }]]);
	}
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 2 * USD);
});

test("reserve refuses a float or negative amount before touching Valkey, and an amount of 0 reserves nothing", async () => {
	const redis = keyedRedis();
	assert.deepEqual(await reserveDollars(redis, { ledgers: dollarLedgers(caps(10 * USD)), amountMicros: 0, now: NOW }), { allowed: true, hold: { amountMicros: 0, keys: [] } }, "a cap of 0 has nothing to hold, and is never a TypeError retried for ever");
	for (const bad of [1.5, -1, Number.NaN, "2000000"]) {
		await assert.rejects(reserveDollars(redis, { ledgers: dollarLedgers(caps(10 * USD)), amountMicros: bad, now: NOW }), TypeError, String(bad));
	}
	assert.deepEqual(redis.calls, []);
});

test("a Valkey fault part-way through a reservation gives back what it added, then rethrows", async () => {
	const redis = keyedRedis({ failOn: { incrby: 2 } });
	await assert.rejects(reserveDollars(redis, { ledgers: dollarLedgers(caps(10 * USD, 50 * USD)), amountMicros: 2 * USD, now: NOW }), /incrby refused/);
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 0, "the day it added to is given back");
});

test("a key that expired or was evicted before the settle is SKIPPED, never recreated negative; a result below 0 is clamped", async () => {
	const redis = keyedRedis();
	const { hold } = await reserveDollars(redis, { ledgers: dollarLedgers(caps(10 * USD, 50 * USD)), amountMicros: 2 * USD, now: NOW });
	redis.store.delete("budget:usd:2026-10-07");
	redis.store.set("budget:usd:w:2026-10-05", 300_000); // an edit left less than this hold in the week
	const logged = [];
	assert.deepEqual(await settleDollars(redis, hold, 300_000, { log: (e, f) => logged.push([e, f]) }), { applied: 2, of: 2 });
	assert.equal(redis.store.has("budget:usd:2026-10-07"), false, "not recreated");
	assert.equal(redis.store.get("budget:usd:w:2026-10-05"), 0, "clamped at 0, never negative");
	assert.deepEqual(logged, [["dollar_settle_key_missing", { key: "budget:usd:2026-10-07" }], ["dollar_settle_clamped", { key: "budget:usd:w:2026-10-05" }]]);
});

test("SETTLE_SCRIPT is one atomic step that skips a missing key and clamps at 0 (the text the live test runs)", () => {
	assert.match(SETTLE_SCRIPT, /EXISTS', KEYS\[1\]\) == 0 then return \{1, 0\}/);
	assert.match(SETTLE_SCRIPT, /if total < 0 then redis.call\('INCRBY', KEYS\[1\], -total\) return \{2, 0\} end/);
});

test("the give-back on refusal is best effort PER KEY: a failing DECRBY is logged and every other key is still given back", async () => {
	const redis = keyedRedis({ failOn: { decrby: 1 } });
	redis.store.set("budget:usd:m:2026-10", 99 * USD);
	const logged = [];
	const res = await reserveDollars(redis, { ledgers: dollarLedgers(caps(10 * USD, 50 * USD, 100 * USD)), amountMicros: 2 * USD, now: NOW, log: (e, f) => logged.push([e, f]) });
	assert.equal(res.allowed, false);
	assert.equal(res.stranded, 1);
	assert.equal(redis.store.get("budget:usd:2026-10-07"), 2 * USD, "the day's give-back failed and is logged");
	assert.equal(redis.store.get("budget:usd:w:2026-10-05"), 0, "the week was still given back");
	assert.equal(redis.store.get("budget:usd:m:2026-10"), 99 * USD, "and the refusing month");
	assert.deepEqual(logged, [["dollar_giveback_error", { code: "ECONNRESET", key: "budget:usd:2026-10-07" }]]);
});

// ---- the settlement basis ----

const COMPLETE = { input: 10, output: 5, total: 15, cost: 0.123456, metered: true, unresolved: 0, unpriced: 0, costCapMicros: 2 * USD, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 };
const LEDGER = { v: 1, piAi: null, truncated: 0, models: [] };

test("metered only when the count is complete: metered, under the cap, every floor counter present and 0, a ledger", () => {
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: COMPLETE, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 123_456, basis: "metered" });
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, cost: 0 }, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 0, basis: "metered" }, "a complete count of $0");
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, cost: 2.5 }, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 2_500_000, basis: "metered" }, "an overshoot is returned whole");
	assert.deepEqual(FLOOR_COUNTERS, ["unresolved", "unpriced", "boundExceeded", "longContext", "costUnjudged", "costUnanswered"]);
	assert.deepEqual(DOLLAR_BASIS, ["metered", "floor", "refunded", "unreserved"]);
});

test("a real 401 before any answer (one call, no content, costUnanswered 1, cost 0) settles at the FLOOR: the auth label is text, not a status", () => {
	// What the runner writes for a provider's 401 (lab542 step 3): the call was counted, it never started, so it is
	// costUnanswered, and its metered cost is 0. provider-auth-refused is classified from the error TEXT (outcome.mjs),
	// and a container-written label must not lower what a window is charged, so the floor stands.
	const tokens = { ...COMPLETE, calls: 1, cost: 0, costUnanswered: 1 };
	assert.deepEqual(dollarSettlement({ trusted: true, tokens, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 2 * USD, basis: "floor" });
});

test("a run that made NO provider call (no ledger, calls 0, cost 0, every counter 0) settles metered at 0, costRefused allowed", () => {
	const none = { ...COMPLETE, calls: 0, cost: 0 };
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: none, usage: null, reservedMicros: 2 * USD }), { settledMicros: 0, basis: "metered" }, "a command job or an early exit");
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...none, costRefused: 1 }, usage: null, reservedMicros: 2 * USD }), { settledMicros: 0, basis: "metered" }, "the guard refused the first call: a refused call is never sent");
	const floor = { settledMicros: 2 * USD, basis: "floor" };
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...none, calls: 1 }, usage: null, reservedMicros: 2 * USD }), floor, "a call without a ledger is not complete");
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...none, cost: 0.000001 }, usage: null, reservedMicros: 2 * USD }), floor, "a cost with no call is not complete");
	const { calls: _, ...noCalls } = none;
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: noCalls, usage: null, reservedMicros: 2 * USD }), floor, "an absent call count is not 0");
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...none, costUnanswered: 1 }, usage: null, reservedMicros: 2 * USD }), floor, "every floor counter still applies");
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...none, metered: false }, usage: null, reservedMicros: 2 * USD }), floor, "the fallback meter never");
});

test("the floor is AT LEAST the reservation and never less than a reported metered cost", () => {
	for (const key of FLOOR_COUNTERS) {
		assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, cost: 5, [key]: 1 }, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 5 * USD, basis: "floor" }, key);
	}
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, cost: 5, metered: false }, usage: null, reservedMicros: 2 * USD }), { settledMicros: 5 * USD, basis: "floor" }, "the fallback meter's number too");
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, cost: 0.5, boundExceeded: 1 }, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 2 * USD, basis: "floor" }, "below the reservation: the reservation");
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, cost: Number.NaN, boundExceeded: 1 }, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 2 * USD, basis: "floor" }, "no valid cost: the reservation");
});

test("a runner cap WIDER than the reservation settles at the floor: the run was not bounded by what was held", () => {
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, costCapMicros: 2 * USD + 1 }, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 2 * USD, basis: "floor" });
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, costCapMicros: USD }, usage: LEDGER, reservedMicros: 2 * USD }).basis, "metered", "a narrower cap is fine");
});

test("tokens: null (no exit line, a job killed before it wrote one) settles at the floor", () => {
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: null, usage: null, reservedMicros: 2 * USD }), { settledMicros: 2 * USD, basis: "floor" });
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: undefined, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 2 * USD, basis: "floor" });
});

test("each floor counter, non-zero, forces the floor", () => {
	for (const key of FLOOR_COUNTERS) {
		assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, [key]: 1 }, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 2 * USD, basis: "floor" }, key);
	}
});

test("each floor counter, ABSENT, forces the floor: an unmeasured number is not an honest zero", () => {
	for (const key of FLOOR_COUNTERS) {
		const { [key]: _, ...tokens } = COMPLETE;
		assert.deepEqual(dollarSettlement({ trusted: true, tokens, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 2 * USD, basis: "floor" }, key);
	}
});

test("the fallback meter, no costCapMicros, no ledger, or a cost that does not convert: the floor", () => {
	const floor = { settledMicros: 2 * USD, basis: "floor" };
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, metered: false }, usage: LEDGER, reservedMicros: 2 * USD }), floor);
	const { costCapMicros: _, ...noCap } = COMPLETE;
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: noCap, usage: LEDGER, reservedMicros: 2 * USD }), floor);
	assert.deepEqual(dollarSettlement({ trusted: true, tokens: COMPLETE, usage: null, reservedMicros: 2 * USD }), floor);
	for (const cost of [undefined, -0.1, Number.NaN, Infinity, "0.1", 1e300]) assert.deepEqual(dollarSettlement({ trusted: true, tokens: { ...COMPLETE, cost }, usage: LEDGER, reservedMicros: 2 * USD }), floor, String(cost));
});

test("the metered float becomes integer micro-dollars ROUNDED UP: Math.ceil(cost x 1e6), never Math.round", () => {
	assert.equal(meteredMicros(0.0000014), 2, "1.4 micro-dollars charges 2 (round would say 1)");
	assert.equal(meteredMicros(0.000001), 1);
	assert.equal(meteredMicros(0.25), 250_000);
	assert.equal(meteredMicros(0.1 + 0.2), 300_001, "float noise reads at most one micro-dollar high, never low");
	assert.equal(meteredMicros(0), 0);
	for (const v of [0.0000014, 0.123456789, 0.1 + 0.2, 12.3456785]) assert.ok(Number.isSafeInteger(meteredMicros(v)) && meteredMicros(v) >= v * USD, String(v));
	assert.equal(meteredMicros(-1), null);
	assert.equal(meteredMicros(1e300), null);
	assert.equal(meteredMicros("1"), null);
});

test("dollarsRecord: the four-key literal, modelBasis null until per-model windows land", () => {
	assert.deepEqual(dollarsRecord({ reservedMicros: 1, settledMicros: 2, basis: "metered" }), { reservedMicros: 1, settledMicros: 2, basis: "metered", modelBasis: null });
});

test("an exit line that is NOT trusted (the worker stopped the container, or its code is not the container's) settles at the floor, the zero-call rule included", () => {
	const floor = { settledMicros: 2 * USD, basis: "floor" };
	assert.deepEqual(dollarSettlement({ tokens: COMPLETE, usage: LEDGER, reservedMicros: 2 * USD }), floor, "trusted defaults to false: fail closed");
	assert.deepEqual(dollarSettlement({ trusted: false, tokens: COMPLETE, usage: LEDGER, reservedMicros: 2 * USD }), floor);
	assert.deepEqual(dollarSettlement({ trusted: false, tokens: { ...COMPLETE, calls: 0, cost: 0 }, usage: null, reservedMicros: 2 * USD }), floor, "a forged zero-call line");
	assert.deepEqual(dollarSettlement({ trusted: false, tokens: { ...COMPLETE, cost: 5 }, usage: LEDGER, reservedMicros: 2 * USD }), { settledMicros: 5 * USD, basis: "floor" }, "the floor still never charges less than the reported cost");
	assert.deepEqual(dollarSettlement({ trusted: 1, tokens: COMPLETE, usage: LEDGER, reservedMicros: 2 * USD }), floor, "only true trusts");
});
