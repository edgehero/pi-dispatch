/**
 * Dollar windows (issue #501, parts 3 and 4; DES-DOLLAR-RESERVE-AND-SETTLE, the worker half).
 *
 * A deployment may cap what its jobs spend per UTC day, Monday week and month, in dollars. Before a container
 * starts, the worker RESERVES the job's per-job cost cap against every active window (`reserveDollars`); after
 * the run it SETTLES that reservation to what the job really cost (`settleDollars`), or keeps it whole when the
 * cost is not fully known. The runner enforces the per-job cap before every provider call, so the reservation is
 * a true bound on what the run can spend, and the worker needs no prices.
 *
 * Every amount is an INTEGER number of micro-dollars (money.mjs). Valkey's INCRBY adds integers exactly; nothing
 * here stores, adds or compares a float. The one float this module ever reads is the runner's metered cost, and
 * `meteredMicros` turns it into an integer once, rounding up.
 *
 * Keys, all under `budget:usd`, built by budget.mjs's own key functions so a dollar window and a job-count window
 * share their UTC boundaries (the day, the week from Monday, the month) and their TTLs:
 *   - `budget:usd:YYYY-MM-DD`, `budget:usd:w:<Monday>`, `budget:usd:m:YYYY-MM`: the deployment's windows;
 *   - `budget:usd:s:<hash16>` (a repo or folder, and a project: the hash of its row scope `project:<id>`) and
 *     `budget:usd:mdl:<hash16>` (a model): the scoped, project and per-model windows of `scoped-limits.json` version 2,
 *     which reach `reserveDollars` as further ledgers with their own `keyPrefix` (scoped-limits.mjs builds them).
 *     `budget:usd:p:` was reserved for project windows and is WITHDRAWN (issue #499 part B): a project row's keys come
 *     from its row scope like every other row's, one key rule and no second keyspace.
 * None of those sub-namespaces can collide with a day key, whose first segment after the prefix is a 4-digit year.
 *
 * Unlike the job-count ledger, a REFUSED dollar reservation is given back at once (`budget.mjs` keeps a refused
 * slot on purpose): one lost slot out of 25 is tolerable, while five refused $2 reservations would empty a $10
 * window with nothing run.
 *
 * `redis` is any ioredis-compatible client, injected so the logic is testable without a server.
 */

import { createHash } from "node:crypto";
import { DAY_TTL_SECONDS, MONTH_TTL_SECONDS, WEEK_TTL_SECONDS, dayKey, monthKey, weekKey } from "./budget.mjs";
import { MICROS_PER_USD, optionalUsdMicros } from "./money.mjs";

/** The deployment's dollar ledger prefix. */
export const DOLLAR_KEY_PREFIX = "budget:usd";
/** The refusal reason a full dollar window gives, in the record, the log and the result. */
export const DOLLAR_CAP_REASON = "dollar-cap";

/**
 * The three `basis` values a settled record carries, plus `refunded` and `unreserved` (INT-RUN-HISTORY-FILE-CONTRACT):
 *   - `metered`: the window was charged the runner's metered cost, which was complete;
 *   - `floor`: the cost was not fully known, so the window keeps the whole reservation;
 *   - `refunded`: no container ran (never started, refused by configuration, or the reservation itself refused),
 *     so the reservation was given back in full;
 *   - `unreserved`: the job could not spend, so nothing was reserved (a zero-rated local model, issue #503 part 7).
 */
export const DOLLAR_BASIS = Object.freeze(["metered", "floor", "refunded", "unreserved"]);

/**
 * The deployment's dollar window caps in micro-dollars, from the effective settings, or `null` when no window is
 * set. `null` is the switch that keeps a deployment with no dollar setting byte-identical: the processor reserves
 * and settles nothing, and no `budget:usd:*` key is ever written. The values were validated where they were read
 * (config.mjs at boot, `validateOverlay` per job), so a throw here is a defect, not a state.
 */
export function dollarWindowCaps(settings) {
	const day = optionalUsdMicros(settings?.dailyCostUsd, "dailyCostUsd");
	const week = optionalUsdMicros(settings?.weeklyCostUsd, "weeklyCostUsd");
	const month = optionalUsdMicros(settings?.monthlyCostUsd, "monthlyCostUsd");
	if (day === null && week === null && month === null) return null;
	return { day, week, month };
}

/**
 * The ledgers for one job, in reservation order: the deployment's (when it has any window), then its repo or folder
 * row's (`dollarCapsFor`), then its project row's (`projectDollarCapsFor`, issue #499 part B), then `_other`'s under an
 * envelope (issue #504 part B: a job in no envelope project), then each model row it reserves in (`modelDollarRows`).
 * One `reserveDollars` call over all of them, so a refusal in any window gives back every key, the deployment's included.
 */
export function dollarLedgers(caps, { scope = null, project = null, other = null, models = [] } = {}) {
	const out = caps ? [{ keyPrefix: DOLLAR_KEY_PREFIX, caps }] : [];
	if (scope) out.push({ keyPrefix: scope.keyPrefix, caps: scope.caps });
	if (project) out.push({ keyPrefix: project.keyPrefix, caps: project.caps });
	if (other) out.push({ keyPrefix: other.keyPrefix, caps: other.caps });
	for (const m of models ?? []) out.push({ keyPrefix: m.keyPrefix, caps: m.caps });
	return out;
}

/** Every ACTIVE window of every ledger, in ledger order and day, week, month within each. A null cap is no window. */
function activeWindows(ledgers, now) {
	const out = [];
	for (const ledger of ledgers ?? []) {
		const { keyPrefix, caps } = ledger;
		for (const [name, key, ttl] of [
			["day", dayKey(now, keyPrefix), DAY_TTL_SECONDS],
			["week", weekKey(now, keyPrefix), WEEK_TTL_SECONDS],
			["month", monthKey(now, keyPrefix), MONTH_TTL_SECONDS],
		]) {
			const cap = caps?.[name];
			if (cap !== null && cap !== undefined) out.push({ ledger: keyPrefix, window: name, key, cap, ttl });
		}
	}
	return out;
}

function assertMicros(value, what, { positive }) {
	if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new TypeError(`${what} must be a ${positive ? "positive" : "non-negative"} safe integer of micro-dollars`);
}

/**
 * DECRBY every key already added to, BEST EFFORT PER KEY: each key is tried whatever happened to the one before it,
 * and a key whose DECRBY fails is logged (`dollar_giveback_error`, the error's code and the key, which is a date and
 * a fixed prefix, never a value) and left holding the amount. Never throws. Returns how many keys it could not give
 * back. One fault stranding every later key would leave a refused job's whole cap in windows it never ran in.
 */
async function giveBack(redis, touched, amountMicros, log) {
	let failed = 0;
	for (const w of touched) {
		try {
			await redis.decrby(w.key, amountMicros);
		} catch (error) {
			failed++;
			log("dollar_giveback_error", { code: typeof error?.code === "string" ? error.code : "error", key: w.key });
		}
	}
	return failed;
}

/**
 * Reserve `amountMicros` in every active window of every ledger, or refuse.
 *
 * Per window: `INCRBY key amount`, the TTL set when the result equals the amount (the first write; budget.mjs's
 * set-once idiom, so a busy window cannot push its own expiry forward), then the new total against the cap. A
 * total ABOVE the cap refuses (a total equal to it fits: five $2 jobs fill a $10 window exactly). INCRBY is atomic,
 * so concurrent reservations need no lock: each sees a total that includes every reservation before it.
 *
 * On refusal it tries to give back EVERY key it touched, the refusing one included, one key at a time and best
 * effort (`giveBack`), and returns `{ allowed: false, reason: "dollar-cap", ledger, window, reservedMicros, capMicros }`,
 * where `reservedMicros` is the total that went over, plus `stranded`, the number of keys whose give-back failed. On success it returns `{ allowed: true, hold }`: `hold` is
 * `{ amountMicros, keys: [key] }`, the exact keys it added to, which is all `settleDollars` and `releaseDollars`
 * ever touch. A settlement therefore lands on the reservation's own day, week and month, whenever it runs.
 *
 * An amount of 0 reserves NOTHING and touches no key: a job under a per-job cap of 0 cannot make a priced call, so
 * there is nothing to hold (`{ allowed: true, hold: { amountMicros: 0, keys: [] } }`). It is answered here, not only
 * by the caller, so a caller that forgets the case gets an empty hold rather than a TypeError, which the processor
 * would retry as never-started for ever.
 *
 * A Valkey fault part-way gives back what it had added (best effort, per key) and rethrows, so a fault strands
 * nothing it can avoid stranding. `ledgers` with no active window returns an empty hold.
 */
export async function reserveDollars(redis, { ledgers, amountMicros, now = new Date(), log = () => {} }) {
	assertMicros(amountMicros, "amountMicros", { positive: false });
	if (amountMicros === 0) return { allowed: true, hold: { amountMicros: 0, keys: [] } };
	const touched = [];
	let refusal = null;
	try {
		for (const w of activeWindows(ledgers, now)) {
			const total = Number(await redis.incrby(w.key, amountMicros));
			touched.push(w);
			if (total === amountMicros) await redis.expire(w.key, w.ttl);
			if (total > w.cap) {
				refusal = { allowed: false, reason: DOLLAR_CAP_REASON, ledger: w.ledger, window: w.window, reservedMicros: total, capMicros: w.cap };
				break;
			}
		}
	} catch (error) {
		await giveBack(redis, touched, amountMicros, log);
		throw error;
	}
	if (refusal) {
		// `stranded`: keys whose give-back failed and still hold the amount (0 normally), so the record can say so.
		const stranded = await giveBack(redis, touched, amountMicros, log);
		return { ...refusal, stranded };
	}
	return { allowed: true, hold: { amountMicros, keys: touched.map((w) => w.key), ledgers: holdLedgers(touched) } };
}

/**
 * The hold's keys grouped by ledger, `[{ keyPrefix, keys }]` in ledger order (issues #501 part 5, #502 part 6), so a
 * caller can settle each ledger to its own amount: the deployment and scope windows to the job's cost, a model window
 * to that model's. Grouped by the ledger each window came from, never by matching key text: the deployment's prefix
 * `budget:usd` is a prefix of every other dollar key.
 */
function holdLedgers(touched) {
	const out = [];
	for (const w of touched) {
		const last = out[out.length - 1];
		if (last && last.keyPrefix === w.ledger) last.keys.push(w.key);
		else out.push({ keyPrefix: w.ledger, keys: [w.key] });
	}
	return out;
}

/**
 * The part of `hold` that belongs to the ledgers `keep(keyPrefix)` selects, as a hold of its own
 * (`{ amountMicros, keys, ledgers }`) for `settleDollars`. A hold with no `ledgers` (built by hand, never by
 * `reserveDollars`) has no parts: every selection is empty, so a settlement through it adjusts nothing and its keys
 * keep the whole reservation, the money-safe side.
 */
export function holdPart(hold, keep) {
	const ledgers = (Array.isArray(hold?.ledgers) ? hold.ledgers : []).filter((l) => keep(l.keyPrefix));
	return { amountMicros: hold?.amountMicros, keys: ledgers.flatMap((l) => l.keys), ledgers };
}

/**
 * One key's settlement, ATOMIC in Valkey (a Lua script runs whole): a key that no longer EXISTS is skipped, never
 * recreated, and a result below 0 is clamped back to 0 (an INCRBY of its own negative, which keeps the key's TTL).
 * Returns `[status, total]`: 0 adjusted, 1 missing, 2 clamped.
 *
 * Why not a bare INCRBY: a key that expired or was evicted between the reserve and the settle (a clock jump, a hand
 * edit, `maxmemory` eviction) would be recreated by a negative INCRBY as a NEGATIVE counter with no TTL, or with a fresh
 * one, and every later job in that window would then fit under a cap it should not. Missing means the window's history
 * is gone; there is nothing true to subtract from.
 */
export const SETTLE_SCRIPT = `if redis.call('EXISTS', KEYS[1]) == 0 then return {1, 0} end
local total = redis.call('INCRBY', KEYS[1], ARGV[1])
if total < 0 then redis.call('INCRBY', KEYS[1], -total) return {2, 0} end
return {0, total}`;

/**
 * Apply one atomic `INCRBY(settled - reserved)` to each key of `hold` (`SETTLE_SCRIPT`: a missing key is skipped, a
 * negative result clamped at 0, each logged as `dollar_settle_key_missing` / `dollar_settle_clamped` with the key), and
 * NEVER throw. Returns `{ applied, of }`: how many of the hold's keys the step completed on. A Valkey fault logs
 * `dollar_settle_error` (the error's code and the counts, never a key's value) and stops there: the keys not yet
 * adjusted keep the whole reservation, which errs toward overcounting, the money-safe side.
 *
 * Exactly the hold's keys, never keys rebuilt from the clock: a job reserved at 23:59:59 UTC and settled after
 * midnight settles into the day it reserved. A settled amount ABOVE the reservation is charged in full (the delta
 * is positive).
 *
 * `settledMicros` must be a non-negative safe integer; anything else (a float, NaN, a negative) is refused here and
 * leaves the reservation standing, logged as `dollar_settle_error` with `code: "not-micros"`.
 */
export async function settleDollars(redis, hold, settledMicros, { log = () => {}, event = "dollar_settle_error" } = {}) {
	const keys = hold?.keys ?? [];
	if (!Number.isSafeInteger(settledMicros) || settledMicros < 0 || !Number.isSafeInteger(hold?.amountMicros)) {
		log(event, { code: "not-micros", applied: 0, of: keys.length });
		return { applied: 0, of: keys.length };
	}
	const delta = settledMicros - hold.amountMicros;
	if (delta === 0) return { applied: keys.length, of: keys.length };
	let applied = 0;
	try {
		for (const key of keys) {
			const [status] = await redis.eval(SETTLE_SCRIPT, 1, key, String(delta));
			applied++;
			if (Number(status) === 1) log("dollar_settle_key_missing", { key });
			else if (Number(status) === 2) log("dollar_settle_clamped", { key });
		}
	} catch (error) {
		log(event, { code: typeof error?.code === "string" ? error.code : "error", applied, of: keys.length });
	}
	return { applied, of: keys.length };
}

/**
 * Give the whole reservation back: a settlement at 0. For a job whose container never ran (never started, or
 * refused by configuration before it could). Never throws; a fault logs `dollar_release_error`.
 */
export function releaseDollars(redis, hold, { log = () => {} } = {}) {
	return settleDollars(redis, hold, 0, { log, event: "dollar_release_error" });
}

/**
 * The runner's metered cost (a float of US dollars off the exit line) as integer micro-dollars, rounded UP:
 * `Math.ceil(cost * 1e6)`. Rounding up is the money-safe direction, and the rule DES-DOLLAR-RESERVE-AND-SETTLE
 * names: the float product can sit a hair above the exact decimal (0.1 + 0.2 is 0.30000000000000004, which is
 * 300001 micro-dollars), so a cost may read up to one micro-dollar high, never low. `null` for anything that is
 * not a finite, non-negative number whose micro-dollars are a safe integer: the caller settles that at the floor.
 */
export function meteredMicros(costUsd) {
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) return null;
	const micros = Math.ceil(costUsd * MICROS_PER_USD);
	return Number.isSafeInteger(micros) ? micros : null;
}

/**
 * The exit-line counters that each say "some of this job's cost is not in the metered number" (issue #501 and
 * PR #534's review). Each must be PRESENT and 0 for a metered settlement: an ABSENT counter reads as non-zero,
 * because a runner that did not write it did not measure it, and an absent number read as 0 would settle a partial
 * count as a cheap job.
 *
 * `unmeteredChildren` (issue #500 part F) counts the job's pi child processes whose spend the runner could not count
 * (`DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY`). The same absent-means-floor rule holds for it, so a worker from part F
 * running an image from before issue #500 part E settles every capped job at the floor: such a runner never writes
 * the key. That is the `costUnjudged` precedent, an overcharge until the image is rebuilt, never an undercharge.
 *
 * `costUnreported` (issue #571) counts the calls on a priced model whose answer carried broken usage (pi fills a
 * missing usage block with zeros, so the metered cost holds about $0 for them); the runner's meter writes it on every
 * line. Absent means floor here too, so a worker from issue #571 running an older image settles every capped job at
 * the floor: upgrade the image before the worker.
 */
export const FLOOR_COUNTERS = Object.freeze(["unresolved", "unpriced", "boundExceeded", "longContext", "costUnjudged", "costUnanswered", "costUnreported", "unmeteredChildren"]);

/**
 * How a job's reservation settles, from what the container reported. PURE. Returns `{ settledMicros, basis }`.
 *
 * FIRST, whether the exit line may be believed at all (PR #542's review, round 3). The job's own tools can write to
 * the runner's stdout (a child reaches `/proc/<ppid>/fd/1`), so a forged `{"event":"exit",...}` with a $0 cost is a
 * line like any other in the tail. `trusted` is the processor's verdict that the exit line is the runner's own: the
 * worker did NOT stop the container (no timeout, cancel, shutdown or detach: a stopped runner writes no exit line, so
 * the last one in the tail can only be a forgery or a stale one), AND the line's own `code` equals the container's
 * real exit code. Not trusted is the floor, whatever the line says, the zero-call rule included.
 *
 *   - `metered`, `settledMicros = meteredMicros(tokens.cost)`, only when the line is trusted and ALL of these hold: `tokens` is an object with
 *     `metered: true`; `costCapMicros` is present and NOT above the reservation (a runner that ran under a wider cap
 *     than was reserved was not bounded by the reservation); every `FLOOR_COUNTERS` member is present and 0; the cost
 *     converts; and either the per-model `usage` ledger is not null, or the run made NO provider call (`calls: 0` and
 *     a cost of 0: the runner omits the ledger when it observed no call, and a call the cost guard refused is never
 *     sent, so `costRefused` may be above 0). A metered cost above the reservation is charged in full;
 *   - otherwise `floor`: AT LEAST the reservation, and never less than a metered cost the runner did report.
 *     `settledMicros = max(reservedMicros, meteredMicros(tokens.cost))` when that cost is a valid number, else the
 *     reservation. The floor means "the cost is not fully known", and a known part of it above the reservation is
 *     still known: discarding it would undercharge the window.
 * Floor cases: no exit line (`tokens: null`, a job killed before it wrote one), the fallback meter, a missing or
 * non-zero counter, a cap wider than the reservation, or calls with no ledger.
 */
export function dollarSettlement({ tokens, usage, reservedMicros, trusted = false }) {
	assertMicros(reservedMicros, "reservedMicros", { positive: false });
	const reported = tokens !== null && typeof tokens === "object" ? meteredMicros(tokens.cost) : null;
	const floor = { settledMicros: reported === null ? reservedMicros : Math.max(reservedMicros, reported), basis: "floor" };
	if (trusted !== true) return floor;
	if (tokens === null || typeof tokens !== "object" || tokens.metered !== true) return floor;
	if (typeof tokens.costCapMicros !== "number" || tokens.costCapMicros > reservedMicros) return floor;
	for (const key of FLOOR_COUNTERS) if (tokens[key] !== 0) return floor;
	if (reported === null) return floor;
	if (usage === null || usage === undefined) {
		// No ledger: complete only for a run that made no provider call at all.
		return tokens.calls === 0 && reported === 0 ? { settledMicros: 0, basis: "metered" } : floor;
	}
	return { settledMicros: reported, basis: "metered" };
}

/**
 * How ONE model window settles (issue #502 part 6). PURE. Returns `{ settledMicros, basis }`. A model window settles
 * from that model's own row in the exit line's `usage.models`, never from the job's total: a job that spent $1.80 on
 * one model and $0.20 on another charges each model window its own share.
 *
 * `basis` is the job's deployment basis (`dollarSettlement`), which already folds in the trusted exit line, every
 * floor counter and "calls with no ledger". The model window is at the FLOOR when ANY of these holds:
 *   - the deployment basis is not `metered`;
 *   - the exit line is not trusted (checked here too, so the rule does not rest on the caller's order);
 *   - `usage` is null while the run made calls (`tokens.calls` not 0, an absent count included): the per-model
 *     split is unknown;
 *   - `usage.truncated` is not PRESENT and 0: rows past the ledger's limit were folded together, so a model's own
 *     row may be missing part of its spend. Absent is not 0, the `FLOOR_COUNTERS` rule;
 *   - an `other/other` row has a cost above 0: some spend is attributed to no model.
 * At the floor it settles at least the reservation and never less than the model row's own reported cost. Metered,
 * it settles `ceil(row.cost x 1e6)`, 0 when the model has no row (it made no call), and an overshoot is charged in
 * full. `ref` is the lowercased `provider/model`; the ledger's ids are lowercased by `parseExitUsage`.
 */
export function modelDollarSettlement({ ref, basis, tokens, usage, reservedMicros, trusted = false }) {
	assertMicros(reservedMicros, "reservedMicros", { positive: false });
	const rows = usage !== null && typeof usage === "object" && Array.isArray(usage.models) ? usage.models : [];
	// EVERY row whose lowercased ref is this model's, summed (PR #549's review): the parser lowercases ids, so two rows
	// that differ only in case are one model, and charging the first alone would undercount it. Each row's cost is
	// turned into integer micro-dollars on its own, so the sum is integers; one unconvertible row makes it unknown.
	let reported = 0;
	for (const r of rows) {
		if (typeof r?.provider !== "string" || typeof r?.model !== "string" || `${r.provider}/${r.model}`.toLowerCase() !== ref) continue;
		const micros = meteredMicros(r.cost);
		reported = reported === null || micros === null ? null : reported + micros;
	}
	const floor = { settledMicros: reported === null ? reservedMicros : Math.max(reservedMicros, reported), basis: "floor" };
	if (basis !== "metered" || trusted !== true) return floor;
	if (usage === null || usage === undefined) return tokens?.calls === 0 ? { settledMicros: 0, basis: "metered" } : floor;
	if (typeof usage !== "object" || usage.truncated !== 0) return floor;
	if (rows.some((r) => r?.provider === "other" && r?.model === "other" && !(r.cost === 0))) return floor;
	if (reported === null) return floor;
	return { settledMicros: reported, basis: "metered" };
}

/** The `modelBasis` tokens a record may carry (INT-RUN-HISTORY-FILE-CONTRACT), or null when no model window applied. */
export const MODEL_BASIS = Object.freeze(["metered", "floor", "refunded"]);

/**
 * The run record's `dollars` object (INT-RUN-HISTORY-FILE-CONTRACT): an explicit literal of integers and fixed
 * tokens. `modelBasis` is how the job's MODEL windows settled (issue #502 part 6): `metered` when every one settled
 * to its own usage row, `floor` when any kept at least its reservation, `refunded` when they were given back, and
 * `null` when the job held no model window. `reservedIn` (issue #761) is `deploymentWindowsOf`'s answer, carried
 * only when it is one, so a record of a job that reserved in no deployment window keeps the shape it had.
 */
export function dollarsRecord({ reservedMicros, settledMicros, basis, modelBasis = null, reservedIn = null }) {
	return { reservedMicros, settledMicros, basis, modelBasis: MODEL_BASIS.includes(modelBasis) ? modelBasis : null, ...(reservedIn ? { reservedIn } : {}) };
}

// ---- which deployment windows a record's money is in (issue #761, the dollar window reset check) ----
//
// A dollar counter holds the history a cap is judged against, and Valkey is its only copy: a flushed, replaced or
// restored Valkey, an evicted key or a hand edit reopens the cap with nothing saying so. A record cannot be bucketed by
// its own times to find out (the reservation's clock is neither `startedAt` nor `endedAt`, and a window whose cap was
// set mid-window was never written by the records before it), so a record says which deployment windows its settled
// amount is in, `dollars.reservedIn`, and doctor sums this host's records per window against the counter
// (`dollarWindowFloors`). Only the deployment's day, week and month: a scoped, project or model window's key is a hash
// per ledger, and a job-count window holds no amount a record states.

/** The deployment's three dollar windows, in the order a hold reserves them (`activeWindows`). */
export const DEPLOYMENT_WINDOWS = Object.freeze(["day", "week", "month"]);

/** A Valkey endpoint tag: 16 lowercase hex characters (`valkeyEndpointTag`). */
export const VALKEY_TAG_RE = /^[0-9a-f]{16}$/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The inverse of budget.mjs's `dayKey`, `weekKey` and `monthKey` under the deployment's own prefix, exactly: a scoped
// or model key (`budget:usd:s:<hash>`, `budget:usd:mdl:<hash>`) starts with the same prefix and matches none of them.
const WINDOW_KEY_RES = Object.freeze({
	day: new RegExp(`^${escapeRe(DOLLAR_KEY_PREFIX)}:(\\d{4}-\\d{2}-\\d{2})$`),
	week: new RegExp(`^${escapeRe(DOLLAR_KEY_PREFIX)}:w:(\\d{4}-\\d{2}-\\d{2})$`),
	month: new RegExp(`^${escapeRe(DOLLAR_KEY_PREFIX)}:m:(\\d{4}-\\d{2})$`),
});

/** Which deployment window `key` is and its bucket id (`{ window, bucket }`, the text after the prefix), or null. */
export function deploymentWindowOfKey(key) {
	if (typeof key !== "string") return null;
	for (const window of DEPLOYMENT_WINDOWS) {
		const m = key.match(WINDOW_KEY_RES[window]);
		if (m) return { window, bucket: m[1] };
	}
	return null;
}

/**
 * The deployment's three windows at `now`, `{ day, week, month }`, each `{ key, bucket, startMs, endMs, ttlSeconds }`:
 * the key a reservation at `now` writes (budget.mjs's key functions, so a reader and the worker cannot disagree about a
 * boundary), its bucket id, when the bucket begins and ends (UTC: the day, the week from Monday, the month), and the
 * TTL the worker sets on the key's first write.
 */
export function deploymentWindowsAt(now) {
	const d = new Date(now);
	const y = d.getUTCFullYear();
	const mo = d.getUTCMonth();
	const day = Date.UTC(y, mo, d.getUTCDate());
	const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000;
	const at = (key, startMs, endMs, ttlSeconds) => ({ key, bucket: deploymentWindowOfKey(key)?.bucket ?? null, startMs, endMs, ttlSeconds });
	return {
		day: at(dayKey(d, DOLLAR_KEY_PREFIX), day, Date.UTC(y, mo, d.getUTCDate() + 1), DAY_TTL_SECONDS),
		week: at(weekKey(d, DOLLAR_KEY_PREFIX), monday, monday + 7 * 86_400_000, WEEK_TTL_SECONDS),
		month: at(monthKey(d, DOLLAR_KEY_PREFIX), Date.UTC(y, mo, 1), Date.UTC(y, mo + 1, 1), MONTH_TTL_SECONDS),
	};
}

/**
 * The tag of the Valkey a deployment's counters live in: the first 16 hex characters of SHA-256 over `host:port/db`, so
 * two deployments that share a logs directory and a worker name (the default per-account `~/.pi-dispatch/logs` and the
 * hostname) but not a Valkey never add up each other's records. `endpoint` is a VALKEY_URL or a client's connection
 * options (`{ host, port, db }`, connection.mjs `parseConnection`, which reads them off the URL by the rules below), so
 * the worker, which holds the options its clients connect with, and doctor, which holds the URL it talks to, compute the
 * same tag for the same endpoint. Both take the JUDGED address (`pinnedValkeyUrl`: the literal a local Valkey is pinned
 * to on Linux), the one the worker really dials. A unix socket (`{ path }`, which no client of this project builds
 * today) is tagged by its path. Credentials and the scheme are never part of it; the host is lowercased, an IPv6
 * literal's brackets dropped, and a missing host, port or database is ioredis's and `parseConnection`'s default
 * (127.0.0.1, 6379, 0). Null for anything else (a URL that does not parse, a database that is not a number). A tag that
 * differs where the endpoint is the same (`localhost` against `127.0.0.1` on a host that pins nothing) only leaves
 * records out of the floor, which can miss a reset and never invents one.
 */
export function valkeyEndpointTag(endpoint) {
	let host;
	let port;
	let db;
	if (typeof endpoint === "string") {
		let u;
		try {
			u = new URL(endpoint);
		} catch {
			return null;
		}
		host = u.hostname;
		port = u.port;
		db = u.pathname && u.pathname !== "/" ? u.pathname.slice(1) : "";
	} else if (endpoint !== null && typeof endpoint === "object") {
		if (typeof endpoint.path === "string" && endpoint.path !== "") return hash16(`unix:${endpoint.path}`);
		({ host, port, db } = endpoint);
	} else {
		return null;
	}
	const h = String(host ?? "").replace(/^\[(.*)\]$/, "$1").toLowerCase() || "127.0.0.1";
	const p = port === undefined || port === null || port === "" ? 6379 : Number(port);
	const n = db === undefined || db === null || db === "" ? 0 : Number(db);
	if (!Number.isSafeInteger(p) || p < 0 || !Number.isSafeInteger(n) || n < 0) return null;
	return hash16(`${h}:${p}/${n}`);
}

function hash16(text) {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The record's `dollars.reservedIn` for a hold (issue #761): `{ day?, week?, month?, valkey }`, the bucket of each
 * DEPLOYMENT window whose counter holds at least the amount the record states, and the endpoint tag of the Valkey it is
 * in (`valkeyEndpointTag`). Null when there is no such window: a zero hold (no `ledgers`), a hold with no deployment
 * ledger, a malformed tag, or every key below the record. PURE.
 *
 *   - `hold` is the hold the settlement or release WALKED (`settleDollars`' `hold`: the job's part for a settle, the
 *     whole hold for a release), so `applied` counts along its `keys`. The deployment ledger is the one whose
 *     `keyPrefix` is exactly `DOLLAR_KEY_PREFIX`, never a prefix match: every dollar key starts with it.
 *   - `applied` is how many of those keys the step completed (0 when no step ran); `target` what this job's share of an
 *     adjusted key now is (the settled amount, 0 for a release); `recorded` the record's `settledMicros`.
 *
 * A window is in only when its key holds at least `recorded` of this job's money: `target` for a key the step already
 * moved, the reservation otherwise. That is what keeps doctor's sum below the counter on a healthy deployment where a
 * step stopped part-way: a settle whose fault left later keys at the reservation while the record states a metered cost
 * ABOVE it (an overshoot is charged in full), and a release that gave back the first keys before the fault while the
 * record states the whole reservation. Both leave their window out, which only lowers the floor.
 */
export function deploymentWindowsOf(hold, { applied = 0, target, recorded, valkey } = {}) {
	if (typeof valkey !== "string" || !VALKEY_TAG_RE.test(valkey)) return null;
	const ledger = (Array.isArray(hold?.ledgers) ? hold.ledgers : []).find((l) => l?.keyPrefix === DOLLAR_KEY_PREFIX);
	if (!ledger || !Array.isArray(ledger.keys)) return null;
	const reserved = hold.amountMicros;
	if (!Number.isSafeInteger(reserved) || !Number.isSafeInteger(recorded) || !Number.isSafeInteger(applied)) return null;
	const walked = Array.isArray(hold.keys) ? hold.keys : [];
	const found = {};
	for (const key of ledger.keys) {
		const at = deploymentWindowOfKey(key);
		if (at === null) continue;
		const i = walked.indexOf(key);
		const holds = i >= 0 && i < applied ? target : reserved;
		if (Number.isSafeInteger(holds) && holds >= recorded) found[at.window] = at.bucket;
	}
	const windows = DEPLOYMENT_WINDOWS.filter((w) => Object.hasOwn(found, w));
	return windows.length === 0 ? null : { ...Object.fromEntries(windows.map((w) => [w, found[w]])), valkey };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** `text` as a real UTC calendar date (`2026-02-30` is none), or null. */
function calendarDate(text) {
	if (typeof text !== "string" || !DATE_RE.test(text)) return null;
	const d = new Date(`${text}T00:00:00.000Z`);
	return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text ? d : null;
}

/**
 * A record's `dollars.reservedIn` rebuilt from its own keys, or null (INT-RUN-HISTORY-FILE-CONTRACT): `day` a real
 * calendar date, `week` a real date that is a Monday, `month` a real month, at least one of them, and `valkey` a tag
 * (`VALKEY_TAG_RE`). Anything else, a member of the wrong shape included, is null as a whole: a record that carries one
 * no release wrote says nothing trustworthy about where its money is. Only OWN keys are read, so a value inherited
 * through the prototype is no member. The one rule the record writer and doctor's sum read it by.
 */
export function reservedInOf(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const own = (key) => (Object.hasOwn(value, key) ? value[key] : undefined);
	const valkey = own("valkey");
	if (typeof valkey !== "string" || !VALKEY_TAG_RE.test(valkey)) return null;
	const out = {};
	const day = own("day");
	if (day !== undefined) {
		if (calendarDate(day) === null) return null;
		out.day = day;
	}
	const week = own("week");
	if (week !== undefined) {
		if (calendarDate(week)?.getUTCDay() !== 1) return null;
		out.week = week;
	}
	const month = own("month");
	if (month !== undefined) {
		if (typeof month !== "string" || !MONTH_RE.test(month)) return null;
		out.month = month;
	}
	return Object.keys(out).length === 0 ? null : { ...out, valkey };
}

/**
 * Per deployment window in `buckets` (`{ day?, week?, month? }`, each the CURRENT bucket id), the micro-dollars this
 * host's own records settled into it: the sum of `dollars.settledMicros` over the records whose `host` is `host`, whose
 * `reservedIn` (`reservedInOf`) names that bucket for that window, and whose `valkey` is `valkey`. PURE.
 *
 * The counter is at least this sum on a healthy deployment: a reservation adds R, a settlement adds S - R and the record
 * carrying S is written after it, a refunded record is 0, and nothing else lowers a key (`reservedIn` already leaves out
 * a window a step stopped part-way in). Everything that is not counted (another host's records, a record from before
 * `reservedIn`, an earlier attempt a retry overwrote, a hold that crashed, a record over the read's size cap, retention
 * shorter than the window) makes the sum smaller, never larger. So a counter below it lost history.
 */
export function dollarWindowFloors(records, { host, valkey, buckets }) {
	const floors = {};
	for (const w of DEPLOYMENT_WINDOWS) if (typeof buckets?.[w] === "string") floors[w] = 0;
	for (const r of Array.isArray(records) ? records : []) {
		if (r === null || typeof r !== "object" || r.host !== host) continue;
		const d = r.dollars;
		if (d === null || typeof d !== "object" || !Number.isSafeInteger(d.settledMicros) || d.settledMicros < 0) continue;
		const at = reservedInOf(d.reservedIn);
		if (at === null || at.valkey !== valkey) continue;
		for (const w of Object.keys(floors)) {
			if (at[w] === buckets[w] && Number.isSafeInteger(floors[w] + d.settledMicros)) floors[w] += d.settledMicros;
		}
	}
	return floors;
}
