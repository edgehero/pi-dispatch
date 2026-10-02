/**
 * CONST-BUDGET-BEFORE-TOKENS. The ordering IS the mechanism.
 *
 * Reserve a slot against the spend caps BEFORE a container starts. Check-after-spend means fifty
 * junk triggers cost fifty jobs of real money before the cap engages -- the exact scenario the cap
 * exists for. So: atomically INCR each active window's counter, and only start the container if every
 * window is within its cap and outside its soft-hold band.
 *
 * INCR is atomic -- verified against a real Valkey under 20 parallel increments yielding exactly
 * 20, no lost updates -- so this needs no lock even at concurrency 3. Three jobs racing at count 9
 * with cap 10 reserve 10, 11, 12; exactly one proceeds, the others are refused, and no container
 * starts over budget.
 *
 * Three windows bound spend on different horizons: a mandatory DAY cap, plus OPTIONAL WEEK and MONTH
 * ceilings (REQ-SPEND-CAPS-MULTI-WINDOW). A window whose cap is null/absent is disabled -- not counted,
 * not evaluated. On top of the hard caps a single SOFT-HOLD percentage refuses new starts once any
 * window enters its band (e.g. >= 80% of that window's cap), a distinct operator-visible brake before
 * the hard wall; in-flight containers are untouched because the reservation happens pre-container.
 *
 * `redis` is any ioredis-compatible client (BullMQ bundles ioredis). Injected so the logic is
 * testable without a running server.
 */

/** UTC day key: `budget:YYYY-MM-DD`. */
export function dayKey(now = new Date(), prefix = "budget") {
	return `${prefix}:${now.toISOString().slice(0, 10)}`; // YYYY-MM-DD, UTC
}

/**
 * UTC week key, bucketed by the Monday of the run's week: `budget:w:YYYY-MM-DD` (that Monday's date).
 * Keying by an actual date sidesteps ISO week-number edge cases (week 53, year rollovers) while still
 * mapping every run in one Mon-Sun week to one key. The `w:` sub-namespace never collides with the day
 * key (`budget:YYYY-MM-DD`).
 */
export function weekKey(now = new Date(), prefix = "budget") {
	const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const sinceMonday = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
	d.setUTCDate(d.getUTCDate() - sinceMonday);
	return `${prefix}:w:${d.toISOString().slice(0, 10)}`;
}

/** UTC month key: `budget:m:YYYY-MM`. The `m:` sub-namespace never collides with the day/week keys. */
export function monthKey(now = new Date(), prefix = "budget") {
	return `${prefix}:m:${now.toISOString().slice(0, 7)}`; // YYYY-MM, UTC
}

/**
 * UTC day key for the daily TOKEN counter: `budget:t:YYYY-MM-DD`. The `t:` sub-namespace never collides
 * with the job-count day/week/month keys -- token spend and job count are separate ledgers.
 */
export function tokenDayKey(now = new Date(), prefix = "budget") {
	return `${prefix}:t:${now.toISOString().slice(0, 10)}`; // YYYY-MM-DD, UTC
}

// Each window's TTL outlives its bucket with slack, so a stale counter is reclaimed shortly after the
// window rolls over. Set once, on first reservation only (reserved === 1), so a busy window cannot push
// its own expiry forward indefinitely. EXPORTED for the dollar windows (dollar-budget.mjs, issue #501), so a
// dollar counter and a job-count counter for the same window live and expire on the same terms.
export const DAY_TTL_SECONDS = 2 * 24 * 60 * 60; // outlives the UTC day
export const WEEK_TTL_SECONDS = 9 * 24 * 60 * 60; // outlives the Mon-Sun week
export const MONTH_TTL_SECONDS = 40 * 24 * 60 * 60; // outlives the longest month

/**
 * Classify one window's reserved count against its cap and the soft-hold band. PURE, and exported so the
 * worker's `reserveBudget` and the admin panel compute the same state from the same inputs and cannot
 * drift on where the band and the wall begin (the read-model already imports `dayKey` for the same reason).
 *
 *   reserved > cap                      -> "over"       (hard cap exceeded; also fails closed for cap <= 0)
 *   reserved > floor(cap * pct / 100)   -> "soft-hold"  (inside the band; only when pct is set)
 *   otherwise                           -> "ok"
 *
 * `softHoldPct` null/absent disables the band. Callers only classify ACTIVE windows (cap is a real number);
 * a disabled window (cap null) is never passed here.
 */
export function windowState(reserved, cap, softHoldPct = null) {
	if (reserved > cap) return "over";
	if (Number.isInteger(softHoldPct) && reserved > Math.floor((cap * softHoldPct) / 100)) return "soft-hold";
	return "ok";
}

/** The active windows for a `caps` set: day plus week/month only when their cap is set (not null/undefined). */
function activeWindows(caps, now, keyPrefix) {
	return [
		{ name: "day", key: dayKey(now, keyPrefix), cap: caps?.day, ttl: DAY_TTL_SECONDS },
		{ name: "week", key: weekKey(now, keyPrefix), cap: caps?.week, ttl: WEEK_TTL_SECONDS },
		{ name: "month", key: monthKey(now, keyPrefix), cap: caps?.month, ttl: MONTH_TTL_SECONDS },
	].filter((w) => w.cap !== null && w.cap !== undefined);
}

/**
 * Atomically reserve one slot across every ACTIVE window. Returns
 * `{ allowed, reason, blockedWindow, windows }` where `windows[name]` is `{ reserved, cap, state }` for an
 * active window or `null` for a disabled one, and `reason` is the worst window state:
 *   any "over"       -> "over-budget"
 *   else any "soft-hold" -> "soft-hold"
 *   else                 -> "ok"  (allowed)
 * `blockedWindow` names the day>week>month-first window carrying that worst state, so the caller can say
 * WHICH ceiling blocked. Both refusals are pre-container, so a refused job spends nothing; a soft-hold is
 * refused exactly like over-budget, only under a distinct reason and an amber panel state.
 *
 * Every active window is INCR'd UNCONDITIONALLY -- the same "a refused reservation still counts, no
 * give-back" invariant the daily cap has always had, now per window. This is deliberate: conditional
 * increments would reintroduce the read-then-write race the atomic INCR design exists to avoid, and
 * unconditional INCR keeps `releaseBudget` a clean symmetric DECR of the same windows. It fails closed --
 * a burst that exhausts one window counts against the others too -- which is the money-safe direction.
 *
 * A cap of 0/negative on an ACTIVE window fails closed (every job "over") rather than meaning "unlimited";
 * a DISABLED window (cap null/absent) is not counted or evaluated at all.
 */
export async function reserveBudget(redis, { caps, softHoldPct = null, now = new Date(), keyPrefix = "budget" } = {}) {
	const windows = { day: null, week: null, month: null };
	for (const w of activeWindows(caps, now, keyPrefix)) {
		const reserved = Number(await redis.incr(w.key));
		// Set the TTL only when the key is first created, so a long window cannot push its expiry forward.
		if (reserved === 1) await redis.expire(w.key, w.ttl);
		windows[w.name] = { reserved, cap: w.cap, state: windowState(reserved, w.cap, softHoldPct) };
	}

	const order = ["day", "week", "month"];
	for (const [state, reason] of [
		["over", "over-budget"],
		["soft-hold", "soft-hold"],
	]) {
		const hit = order.find((name) => windows[name]?.state === state);
		if (hit) return { allowed: false, reason, blockedWindow: hit, windows };
	}
	return { allowed: true, reason: "ok", blockedWindow: null, windows };
}

/**
 * Give a reservation back in every window `reserveBudget` would have reserved. Used ONLY when the container
 * never started because of an INFRA fault AFTER reserving (e.g. the docker daemon was unreachable) -- an
 * infra failure that spent nothing should not permanently consume a slot. DECRs exactly the ACTIVE windows,
 * mirroring `reserveBudget` so the refund cannot drift from the reservation. NOT used for a completed run
 * (which really consumed its slot), an exit-1 infra retry (the container ran and spent), or an
 * over-budget/soft-hold refusal (which never gives back its slot, deliberately).
 */
export async function releaseBudget(redis, { caps, now = new Date(), keyPrefix = "budget" } = {}) {
	for (const w of activeWindows(caps, now, keyPrefix)) {
		await redis.decr(w.key);
	}
}

/**
 * The daily TOKEN cap check -- read-only, no increment. Returns `{ allowed, reason, spent, cap }`.
 *
 * This is the deliberate ASYMMETRY to `reserveBudget` (issue #25 / OQ-010). A job's token cost is
 * knowable only AFTER it runs, so a token cap cannot check-and-increment BEFORE the spend the way the
 * job-COUNT cap does (CONST-BUDGET-BEFORE-TOKENS, which governs only the ordering of the job-count cap
 * and stays unchanged). Instead the token count is a check-BEFORE read of PRIOR jobs' recorded spend
 * (this function) paired with a record-AFTER `INCRBY` (`recordTokenSpend`). It can only stop the NEXT
 * job once a day's accumulated spend has reached the cap -- a lagging backstop, not a before-the-spend
 * cap; `maxTurns` remains the one proactive per-job lever. Being read-only it consumes nothing, so it
 * safely precedes the job-count reservation and a refusal here spends no job-count slot.
 *
 * `cap` null/absent disables the cap (always allowed). A cap <= 0 fails closed (spent >= 0 always
 * blocks), matching `reserveBudget`'s fail-closed posture on a nonsensical cap.
 */
export async function checkTokenCap(redis, { cap, now = new Date(), keyPrefix = "budget" } = {}) {
	if (cap === null || cap === undefined) return { allowed: true, reason: "ok", spent: 0, cap: null };
	const spent = Number(await redis.get(tokenDayKey(now, keyPrefix))) || 0;
	if (spent >= cap) return { allowed: false, reason: "daily-token-cap", spent, cap };
	return { allowed: true, reason: "ok", spent, cap };
}

/**
 * Record a job's token spend against the daily counter -- the record-AFTER half of the lagging token cap
 * (see `checkTokenCap`). `INCRBY` by the job's total tokens; set the day TTL once, on first write, so a
 * busy day cannot push its own expiry forward (mirrors `reserveBudget`'s set-once TTL). Under concurrency
 * the counter is best-effort: N in-flight jobs each passed `checkTokenCap` before any recorded, so the
 * daily total can overshoot the cap by up to N per-job budgets -- expected and acceptable for a lagging
 * backstop (OQ-010). Returns the new counter value. `tokens` is assumed a non-negative integer (the
 * caller guards `> 0`), so the first-write TTL test `total === tokens` holds.
 */
export async function recordTokenSpend(redis, tokens, { now = new Date(), keyPrefix = "budget" } = {}) {
	const key = tokenDayKey(now, keyPrefix);
	const total = Number(await redis.incrby(key, tokens));
	if (total === tokens) await redis.expire(key, DAY_TTL_SECONDS);
	return total;
}
