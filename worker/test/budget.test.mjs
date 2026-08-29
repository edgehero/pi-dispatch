import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeKeyPrefix } from "../src/scoped-limits.mjs";
import {
	checkTokenCap,
	dayKey,
	monthKey,
	recordTokenSpend,
	releaseBudget,
	reserveBudget,
	tokenDayKey,
	weekKey,
	windowState,
} from "../src/budget.mjs";

/** Minimal ioredis-compatible fake, keyed by the redis key so the three windows count independently. */
function fakeRedis() {
	const store = new Map();
	const ttl = new Map();
	return {
		store,
		ttl,
		async incr(k) {
			const v = (store.get(k) ?? 0) + 1;
			store.set(k, v);
			return v;
		},
		async incrby(k, n) {
			const v = (store.get(k) ?? 0) + n;
			store.set(k, v);
			return v;
		},
		async decr(k) {
			const v = (store.get(k) ?? 0) - 1;
			store.set(k, v);
			return v;
		},
		async get(k) {
			return store.has(k) ? String(store.get(k)) : null; // ioredis GET returns a string or null
		},
		async expire(k, s) {
			ttl.set(k, s);
		},
	};
}

const NOW = new Date("2026-07-16T10:00:00Z");
const DAY = "budget:2026-07-16";
const WEEK = "budget:w:2026-07-13"; // the Monday of NOW's week
const MONTH = "budget:m:2026-07";

// ---- keys ----

test("dayKey / weekKey / monthKey are distinct UTC sub-namespaces", () => {
	assert.equal(dayKey(NOW), DAY);
	assert.equal(weekKey(NOW), WEEK);
	assert.equal(monthKey(NOW), MONTH);
	// A timestamp just before UTC midnight stays on its UTC day/week/month regardless of local tz.
	assert.equal(dayKey(new Date("2026-07-16T00:00:01Z")), DAY);
});

test("weekKey buckets a whole Mon-Sun week to one Monday key, and rolls at the boundary", () => {
	assert.equal(weekKey(new Date("2026-07-13T00:00:00Z")), WEEK, "Monday");
	assert.equal(weekKey(new Date("2026-07-19T23:59:59Z")), WEEK, "the following Sunday is the same week");
	assert.equal(weekKey(new Date("2026-07-20T00:00:00Z")), "budget:w:2026-07-20", "the next Monday is a new bucket");
	// Year boundary: 2027-01-01 is a Friday, still in the week that started 2026-12-28.
	assert.equal(weekKey(new Date("2027-01-01T00:00:00Z")), "budget:w:2026-12-28");
});

// ---- windowState (the shared classifier) ----

test("windowState: ok below the band, soft-hold inside it, over beyond the cap", () => {
	// cap 10, pct 80 -> threshold floor(8) = 8. reserved <=8 ok; 9,10 soft-hold; 11+ over.
	assert.equal(windowState(8, 10, 80), "ok");
	assert.equal(windowState(9, 10, 80), "soft-hold");
	assert.equal(windowState(10, 10, 80), "soft-hold");
	assert.equal(windowState(11, 10, 80), "over");
	// pct null disables the band: everything up to the cap is ok, only over the cap is "over".
	assert.equal(windowState(10, 10, null), "ok");
	assert.equal(windowState(11, 10, null), "over");
	// cap <= 0 fails closed: any reservation is over.
	assert.equal(windowState(1, 0, null), "over");
});

// ---- single (day) window: the original behaviour, preserved ----

test("day-only: reserves within the cap, refuses beyond it, and a refusal never gives back", async () => {
	const redis = fakeRedis();
	const results = [];
	for (let i = 0; i < 5; i++) results.push(await reserveBudget(redis, { caps: { day: 3 }, now: NOW }));

	assert.deepEqual(
		results.map((r) => r.allowed),
		[true, true, true, false, false],
	);
	assert.deepEqual(
		results.map((r) => r.windows.day.reserved),
		[1, 2, 3, 4, 5],
	);
	assert.deepEqual(
		results.map((r) => r.reason),
		["ok", "ok", "ok", "over-budget", "over-budget"],
	);
	assert.equal(results[3].blockedWindow, "day");
});

test("day-only: the TTL is set once, on first reservation only", async () => {
	const redis = fakeRedis();
	await reserveBudget(redis, { caps: { day: 10 }, now: NOW });
	assert.ok(redis.ttl.has(DAY), "TTL set on first reserve");
	redis.ttl.delete(DAY);
	await reserveBudget(redis, { caps: { day: 10 }, now: NOW });
	assert.ok(!redis.ttl.has(DAY), "TTL must NOT be reset on later reserves");
});

test("day cap 0 fails closed -- every job refused, not 'unlimited'", async () => {
	const redis = fakeRedis();
	const r = await reserveBudget(redis, { caps: { day: 0 }, now: NOW });
	assert.equal(r.allowed, false);
	assert.equal(r.reason, "over-budget");
});

// ---- multi-window ----

test("multi-window: day/week/month count on independent keys", async () => {
	const redis = fakeRedis();
	const r = await reserveBudget(redis, { caps: { day: 10, week: 20, month: 30 }, now: NOW });
	assert.deepEqual(
		[r.windows.day.reserved, r.windows.week.reserved, r.windows.month.reserved],
		[1, 1, 1],
	);
	assert.equal(redis.store.get(DAY), 1);
	assert.equal(redis.store.get(WEEK), 1);
	assert.equal(redis.store.get(MONTH), 1);
	assert.ok(redis.ttl.get(WEEK) > redis.ttl.get(DAY), "the week TTL outlives the day TTL");
	assert.ok(redis.ttl.get(MONTH) > redis.ttl.get(WEEK), "the month TTL outlives the week TTL");
});

test("multi-window: ANY window over its cap refuses, and blockedWindow names it (day > week > month)", async () => {
	const redis = fakeRedis();
	redis.store.set(WEEK, 5); // the week window is already at its cap
	const r = await reserveBudget(redis, { caps: { day: 100, week: 5, month: 100 }, now: NOW });
	assert.equal(r.allowed, false);
	assert.equal(r.reason, "over-budget");
	assert.equal(r.blockedWindow, "week", "the week ceiling is the one that blocked");
	assert.equal(r.windows.day.state, "ok", "the day window is still fine");
});

test("a disabled window (null cap) is neither counted nor evaluated", async () => {
	const redis = fakeRedis();
	const r = await reserveBudget(redis, { caps: { day: 10, week: null, month: null }, now: NOW });
	assert.equal(r.allowed, true);
	assert.equal(r.windows.week, null);
	assert.equal(r.windows.month, null);
	assert.ok(!redis.store.has(WEEK), "a disabled week window creates no key");
	assert.ok(!redis.store.has(MONTH), "a disabled month window creates no key");
});

// ---- soft-hold band ----

test("soft-hold: a reservation inside the band refuses with a distinct reason, still counting", async () => {
	const redis = fakeRedis();
	redis.store.set(DAY, 8); // next reservation lands at 9, inside the 80% band of cap 10 (threshold 8)
	const r = await reserveBudget(redis, { caps: { day: 10 }, softHoldPct: 80, now: NOW });
	assert.equal(r.allowed, false);
	assert.equal(r.reason, "soft-hold");
	assert.equal(r.blockedWindow, "day");
	assert.equal(r.windows.day.reserved, 9);
	assert.equal(r.windows.day.state, "soft-hold");
});

test("soft-hold: below the band the run is allowed", async () => {
	const redis = fakeRedis();
	redis.store.set(DAY, 6); // -> 7, below the threshold of 8
	const r = await reserveBudget(redis, { caps: { day: 10 }, softHoldPct: 80, now: NOW });
	assert.equal(r.allowed, true);
	assert.equal(r.reason, "ok");
});

test("soft-hold: over-budget outranks soft-hold, and day outranks week", async () => {
	const redis = fakeRedis();
	redis.store.set(DAY, 10); // -> 11, OVER the day cap of 10
	redis.store.set(WEEK, 8); // -> 9, inside the week's soft-hold band
	const r = await reserveBudget(redis, { caps: { day: 10, week: 10 }, softHoldPct: 80, now: NOW });
	assert.equal(r.reason, "over-budget", "a hard over beats a soft-hold");
	assert.equal(r.blockedWindow, "day");
	assert.equal(r.windows.week.state, "soft-hold", "the week is still surfaced as soft-hold in its window");
});

// ---- release ----

test("release gives a slot back in every active window (infra never-started path)", async () => {
	const redis = fakeRedis();
	await reserveBudget(redis, { caps: { day: 3, week: 3, month: 3 }, now: NOW });
	await reserveBudget(redis, { caps: { day: 3, week: 3, month: 3 }, now: NOW });
	await releaseBudget(redis, { caps: { day: 3, week: 3, month: 3 }, now: NOW });
	assert.equal(redis.store.get(DAY), 1);
	assert.equal(redis.store.get(WEEK), 1);
	assert.equal(redis.store.get(MONTH), 1);
	const r = await reserveBudget(redis, { caps: { day: 3, week: 3, month: 3 }, now: NOW });
	assert.equal(r.windows.day.reserved, 2, "a released slot is reusable");
	assert.equal(r.allowed, true);
});

test("release only decrements active windows -- a disabled window is untouched", async () => {
	const redis = fakeRedis();
	redis.store.set(DAY, 5);
	await releaseBudget(redis, { caps: { day: 3, week: null, month: null }, now: NOW });
	assert.equal(redis.store.get(DAY), 4);
	assert.ok(!redis.store.has(WEEK), "a disabled window is never decremented into existence");
});

// ---- daily token counter (issue #25): check-BEFORE (read) + record-AFTER (INCRBY) ----

const TOKEN_DAY = "budget:t:2026-07-16";

test("tokenDayKey is a distinct t: sub-namespace, never colliding with the job-count keys", () => {
	assert.equal(tokenDayKey(NOW), TOKEN_DAY);
	assert.notEqual(tokenDayKey(NOW), dayKey(NOW), "token ledger and job-count ledger are separate keys");
});

test("checkTokenCap: a null cap is disabled -- always allowed, reads nothing", async () => {
	const redis = fakeRedis();
	redis.store.set(TOKEN_DAY, 9_999_999);
	const r = await checkTokenCap(redis, { cap: null, now: NOW });
	assert.deepEqual(r, { allowed: true, reason: "ok", spent: 0, cap: null });
});

test("checkTokenCap: allowed below the cap, refused once accumulated spend reaches it", async () => {
	const redis = fakeRedis();
	assert.equal((await checkTokenCap(redis, { cap: 1000, now: NOW })).allowed, true, "no prior spend -> allowed");

	redis.store.set(TOKEN_DAY, 999);
	const below = await checkTokenCap(redis, { cap: 1000, now: NOW });
	assert.deepEqual(below, { allowed: true, reason: "ok", spent: 999, cap: 1000 });

	redis.store.set(TOKEN_DAY, 1000); // reached the cap
	const at = await checkTokenCap(redis, { cap: 1000, now: NOW });
	assert.equal(at.allowed, false, "at the cap the NEXT job is refused (>=)");
	assert.equal(at.reason, "daily-token-cap");
	assert.equal(at.spent, 1000);
});

test("checkTokenCap: read-only -- it never mutates the counter", async () => {
	const redis = fakeRedis();
	redis.store.set(TOKEN_DAY, 500);
	await checkTokenCap(redis, { cap: 1000, now: NOW });
	assert.equal(redis.store.get(TOKEN_DAY), 500, "a check must consume nothing (it precedes reserveBudget)");
});

test("checkTokenCap: a cap <= 0 fails closed (every job blocked), matching reserveBudget", async () => {
	const redis = fakeRedis();
	const r = await checkTokenCap(redis, { cap: 0, now: NOW });
	assert.equal(r.allowed, false, "spent 0 >= cap 0 blocks -- a nonsensical cap is not 'unlimited'");
});

test("recordTokenSpend: INCRBY accumulates and sets the day TTL once, on first write", async () => {
	const redis = fakeRedis();
	assert.equal(await recordTokenSpend(redis, 400, { now: NOW }), 400);
	assert.equal(redis.ttl.get(TOKEN_DAY), 2 * 24 * 60 * 60, "TTL set on the first write");

	redis.ttl.delete(TOKEN_DAY); // prove the second write does NOT re-set it
	assert.equal(await recordTokenSpend(redis, 600, { now: NOW }), 1000, "accumulates across jobs");
	assert.equal(redis.ttl.has(TOKEN_DAY), false, "a busy day cannot push its own expiry forward");
});

test("check-before + record-after compose: prior jobs' recorded spend gates the next", async () => {
	const redis = fakeRedis();
	await recordTokenSpend(redis, 700, { now: NOW });
	await recordTokenSpend(redis, 400, { now: NOW }); // 1100 recorded
	const gate = await checkTokenCap(redis, { cap: 1000, now: NOW });
	assert.equal(gate.allowed, false, "the lagging cap stops the NEXT job once the day is over budget");
	assert.equal(gate.spent, 1100);
});

// ── the keyPrefix seam under a scoped prefix (issue #242) ───────────────────────────────────────────
// The first PRODUCTION use of keyPrefix: the scoped budget windows reserve under
// budget:s:<hash16>:... beside the globals in the same store. These pins hold the two ledgers apart.

test("a scoped reserve lives entirely under its prefix, independent of a same-store global reserve", async () => {
	const redis = fakeRedis();
	const prefix = scopeKeyPrefix("acme/web");
	const scoped = await reserveBudget(redis, { caps: { day: 1, week: null, month: null }, now: NOW, keyPrefix: prefix });
	assert.equal(scoped.allowed, true);
	const global = await reserveBudget(redis, { caps: { day: 1, week: null, month: null }, now: NOW });
	assert.equal(global.allowed, true, "the global day window did not see the scoped INCR");
	assert.equal(redis.store.get(`${prefix}:2026-07-16`), 1);
	assert.equal(redis.store.get("budget:2026-07-16"), 1);
	const scoped2 = await reserveBudget(redis, { caps: { day: 1, week: null, month: null }, now: NOW, keyPrefix: prefix });
	assert.equal(scoped2.allowed, false, "the scope's own cap refuses on the scope's own count");
	assert.equal(scoped2.blockedWindow, "day");
	assert.equal(redis.store.get(`${prefix}:2026-07-16`), 2, "refused-still-counts holds per ledger");
	assert.equal(redis.store.get("budget:2026-07-16"), 1, "the global counter never moved");
	await releaseBudget(redis, { caps: { day: 1, week: null, month: null }, now: NOW, keyPrefix: prefix });
	assert.equal(redis.store.get(`${prefix}:2026-07-16`), 1, "release decrements only the prefixed key");
	assert.equal(redis.store.get("budget:2026-07-16"), 1);
});

test("TTLs are set on first INCR under a prefix, exactly as under the default", async () => {
	const redis = fakeRedis();
	const prefix = scopeKeyPrefix("/srv/site");
	await reserveBudget(redis, { caps: { day: 5, week: 10, month: null }, now: NOW, keyPrefix: prefix });
	assert.equal(redis.ttl.get(`${prefix}:2026-07-16`), 2 * 24 * 60 * 60);
	assert.equal(redis.ttl.get(`${prefix}:w:2026-07-13`), 9 * 24 * 60 * 60);
	await reserveBudget(redis, { caps: { day: 5, week: 10, month: null }, now: NOW, keyPrefix: prefix });
	assert.equal(redis.ttl.get(`${prefix}:2026-07-16`), 2 * 24 * 60 * 60, "set once, on reserved === 1 only");
});

test("a null window under a prefix is disabled, exactly as under the default (budgetCapsFor's shape)", async () => {
	const redis = fakeRedis();
	const prefix = scopeKeyPrefix("acme/web");
	// week-only caps -- the shape budgetCapsFor emits for a { scope, week: N } row.
	const r = await reserveBudget(redis, { caps: { day: null, week: 2, month: null }, now: NOW, keyPrefix: prefix });
	assert.equal(r.allowed, true);
	assert.equal(r.windows.day, null, "a null window is disabled, never a zero cap");
	assert.equal(redis.store.has(`${prefix}:2026-07-16`), false, "no day key was created");
	assert.equal(redis.store.get(`${prefix}:w:2026-07-13`), 1);
});
