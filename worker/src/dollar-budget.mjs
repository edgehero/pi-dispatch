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
 * row's (`dollarCapsFor`), then its project row's (`projectDollarCapsFor`, issue #499 part B), then each model row it
 * reserves in (`modelDollarRows`). One `reserveDollars` call over all of them, so a refusal in any window gives back
 * every key, the deployment's included.
 */
export function dollarLedgers(caps, { scope = null, project = null, models = [] } = {}) {
	const out = caps ? [{ keyPrefix: DOLLAR_KEY_PREFIX, caps }] : [];
	if (scope) out.push({ keyPrefix: scope.keyPrefix, caps: scope.caps });
	if (project) out.push({ keyPrefix: project.keyPrefix, caps: project.caps });
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
 * `null` when the job held no model window.
 */
export function dollarsRecord({ reservedMicros, settledMicros, basis, modelBasis = null }) {
	return { reservedMicros, settledMicros, basis, modelBasis: MODEL_BASIS.includes(modelBasis) ? modelBasis : null };
}
