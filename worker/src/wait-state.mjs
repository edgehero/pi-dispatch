/**
 * The `wait:` keyspace: what the worker remembers about a job it is holding (issue #230).
 *
 * Four things need remembering, and none of them can be derived from the delayed set alone:
 *
 *   1. WHEN THE HOLD STARTED. `job.timestamp` is the ENQUEUE instant, so it counts pause-window time,
 *      scope-mutex time and retry backoff as "waited": a job enqueued into a 22:00-08:00 quiet window would
 *      burn ten hours of its wait budget before the first check existed, then terminate having actually
 *      waited fourteen. The panel would report the wrong number for the same reason.
 *   2. WHICH JOB HOLDS A TARGET. A second delivery for the same repo/issue/flow while the first is held
 *      would otherwise hold too, and both would run when the condition cleared -- two paid runs for one
 *      intent, which the acceptance criteria refuse. The obvious fix, widening the queue's dedup window,
 *      is worse: that key carries no trigger identity (so it would suppress an unflagged sibling on the
 *      same target) and it OUTLIVES completion (so it would go on suppressing after this job finished).
 *   3. HOW MANY TIMES A CHECK HAS FAILED TO ANSWER (the enforcement slice writes it; the field is
 *      reserved here so both writers agree on the shape).
 *   4. WHAT TO SHOW AN OPERATOR: an id-only target and an operator-authored condition label, chosen by
 *      the worker rather than projected out of a delayed job's `.data`, which holds the issue title and
 *      body.
 *
 * WHY THIS IS NOT THE REDIS STATE `OQ-008` AND #242 REFUSED. That refusal is about a claim that would
 * survive a crash WRONGLY -- an in-flight count asserting a container the boot reaper had just killed.
 * This describes DELAYED JOBS, which are themselves Redis-persisted, so it is the same source of truth
 * rather than a second one. Every key carries a TTL sized to the hold it describes; a polled holder also
 * refreshes its own lease on each wake, while an `after` holder has no wakes to refresh on, which is
 * exactly why the supersede path VERIFIES the holder is still in the queue before it refuses anyone. A
 * holder it cannot verify admits rather than refuses. So the worst a leak costs is a duplicate run or a
 * stale panel row, never work that is dropped.
 *
 * The keys, all under one prefix so an operator can see the whole feature with one `KEYS wait:*`:
 *   wait:job:<jobId>          HASH { since, faults, throttles, target, label, dedupId }, TTL sized to the hold
 *   wait:done:<dedupId>       STRING jobId -- this target's wait was satisfied, briefly remembered
 *   wait:key:<dedupId>        STRING jobId -- the supersede lease, TTL sized to the expected hold
 */

/** Slack added to every lease so a hold that wakes exactly on time never races its own key's expiry. */
const LEASE_SLACK_MS = 60 * 60 * 1000;

/** The floor on a lease, so a short hold still leaves a trace long enough for a panel refresh to see it. */
const LEASE_MIN_MS = 5 * 60 * 1000;

// Deliberately NO index set. A SET cannot expire its members, so a `wait:held` would be the one structure
// here that leaks permanently: every hold ending by any route except the clean one would leave a member
// nothing can remove. A reader enumerates `wait:job:*` instead, which is self-cleaning because every hash
// carries a TTL, and which cannot disagree with itself about who is held.
export const jobKey = (jobId) => `wait:job:${jobId}`;
export const leaseKey = (dedupId) => `wait:key:${dedupId}`;
export const satisfiedKey = (dedupId) => `wait:done:${dedupId}`;

// How long "this target's wait has been satisfied" is remembered. The backoff ceiling, because that is the
// longest two jobs that cleared together can wake apart.
const SATISFIED_MS = 15 * 60 * 1000;

/**
 * Build the state accessor. `redis` is the same client the budget uses; nothing here is on the paid path,
 * so every method is written to FAIL OPEN: a redis blip must never refuse a job or wedge a hold, it may
 * only cost the panel a row. The one exception is `claim`, whose failure mode is spelled out on it.
 */
export function makeWaitState({ redis, now = () => Date.now(), counterTtlMs = 25 * 3600 * 1000 }) {
	const leaseMs = (untilMs) => Math.max(LEASE_MIN_MS, (untilMs ?? 0) - now() + LEASE_SLACK_MS);

	return {
		/**
		 * Record (or refresh) a hold. `since` is written ONCE with HSETNX so a re-pick does not restart the
		 * clock -- that is the whole point of not using `job.timestamp`, and a plain HSET here would
		 * reintroduce the bug from the other side by resetting the wait on every wake.
		 */
		async hold(jobId, { dedupId, target, label, untilMs }) {
			try {
				const key = jobKey(jobId);
				const ttl = leaseMs(untilMs);
				await redis.hsetnx(key, "since", String(now()));
				await redis.hset(key, "target", target ?? "", "label", label ?? "", "dedupId", dedupId ?? "");
				await redis.pexpire(key, ttl);
				// Refresh OUR lease only, and re-read to find out whether it IS ours: `hold` is no longer
				// reached solely after a successful claim (the throttle path holds to stamp a clock without
				// ever winning a lease), so ownership is a question rather than an assumption.
				// Extending a lease this job LOST would hand the winner a longer deafening window than its own
				// hold asked for, which is the failure the three-way claim exists to avoid.
				if (dedupId && (await redis.get(leaseKey(dedupId))) === jobId) await redis.pexpire(leaseKey(dedupId), ttl);
			} catch {
				// Fail open: an unrecorded hold is an invisible row, not a wrong decision.
			}
		},

		/**
		 * Take the supersede lease for a target, or say what to do instead. Returns `{ ok: true }` when this
		 * job may hold, `{ heldBy }` when another job verifiably still does, or `{ retry: true }` when the
		 * holder could not be checked.
		 *
		 * `SET NX PX` is the coalescing mechanism: atomic, so two deliveries arriving together cannot both win.
		 *
		 * THE THREE-WAY ANSWER IS THE POINT, and a two-way one is wrong in both directions. Admitting an
		 * unverified holder means two jobs hold the same target and BOTH are paid when it clears -- the exact
		 * accumulation `REQ-WAIT-FOR` promises will not happen. Refusing one means a holder that is gone
		 * deafens the target for the rest of its lease, and a refused forge delivery is gone for good. So a
		 * holder we cannot check produces neither: the caller re-defers and asks again, which costs one wake
		 * and decides nothing until the answer is known.
		 *
		 * `isLive` returns true, false, or null/undefined for "cannot tell" (no probe wired, or it threw).
		 */
		async claim(jobId, { dedupId, untilMs, isLive }) {
			if (!dedupId) return { ok: true }; // no semantic identity to coalesce on (a job id is unique already)
			try {
				const key = leaseKey(dedupId);
				const won = await redis.set(key, jobId, "PX", leaseMs(untilMs), "NX");
				if (won) return { ok: true };
				const holder = await redis.get(key);
				if (!holder || holder === jobId) return { ok: true }; // expired between the two calls, or it is us

				let live = null;
				if (typeof isLive === "function") {
					try {
						live = await isLive(holder);
					} catch {
						live = null; // a probe that threw has not told us the holder is alive
					}
				}
				if (live === false) {
					// The holder can no longer wake. Take the lease over rather than leaving a key that
					// refuses every later delivery for this target until it expires.
					await redis.set(key, jobId, "PX", leaseMs(untilMs));
					return { ok: true, tookOverFrom: holder };
				}
				if (live !== true) return { retry: true, holder };
				return { heldBy: holder };
			} catch {
				// A redis fault reached us before any decision was made. Ask again rather than guess: both
				// guesses are wrong in a way an operator cannot see.
				return { retry: true, holder: null };
			}
		},

		/**
		 * Mark a target as SATISFIED by this job, and read who satisfied it.
		 *
		 * The lease alone cannot close one window. Two deliveries can both be holding when a worker outage
		 * outlives the lease TTL -- the delayed jobs survive, being Redis-persisted, while the lease does not
		 * -- and if the condition cleared during that outage each one wakes, finds no holder, claims cleanly,
		 * and runs. Two paid runs for one intent, which is the accumulation `REQ-WAIT-FOR` promises against.
		 *
		 * So the job that clears a target says so, and a sibling waking after it refuses. The marker lives for
		 * `SATISFIED_MS` because that is the longest two jobs which cleared TOGETHER can wake apart: the
		 * backoff ceiling. It is deliberately not longer -- a delivery arriving well after a wait completed is
		 * a genuinely new intent, and coalescing it would be the dedup-window mistake this design already
		 * refused once.
		 */
		async markSatisfied(jobId, { dedupId }) {
			if (!dedupId) return;
			try {
				await redis.set(satisfiedKey(dedupId), jobId, "PX", SATISFIED_MS);
			} catch {
				// Fail open: the cost is the duplicate this marker exists to prevent, not a wrong refusal.
			}
		},

		async satisfiedBy(dedupId) {
			if (!dedupId) return null;
			try {
				return await redis.get(satisfiedKey(dedupId));
			} catch {
				return null;
			}
		},

		/** Drop a hold: the job is running, refusing, or expiring. Only clears a lease this job actually owns. */
		async release(jobId, { dedupId } = {}) {
			try {
				await redis.del(jobKey(jobId));
				if (dedupId) {
					const holder = await redis.get(leaseKey(dedupId));
					if (holder === jobId) await redis.del(leaseKey(dedupId));
				}
			} catch {
				// Fail open: the TTLs are the backstop, and every field here is advisory.
			}
		},

		/**
		 * The two per-job counters the polled tier keeps: how many checks have run, and how many of them in a
		 * ROW could not answer. Both live beside `since` so one hash carries the whole hold, and both come
		 * back 0 when nothing was written -- an unrecorded hold must read as a fresh one rather than as a
		 * job that has already exhausted its budget.
		 */
		async counters(jobId) {
			try {
				const h = await redis.hget(jobKey(jobId), "checks");
				const f = await redis.hget(jobKey(jobId), "faults");
				const t = await redis.hget(jobKey(jobId), "throttles");
				return { checks: Number(h) || 0, faults: Number(f) || 0, throttles: Number(t) || 0 };
			} catch {
				return { checks: 0, faults: 0, throttles: 0 };
			}
		},

		/**
		 * Count a wake that was denied the check lease, or clear the count when one is granted.
		 *
		 * This is the only observable the capacity bound has. The lease caps how much wall-clock a worker
		 * spends checking, which is what it is for -- but a cap that is being hit constantly means demand
		 * exceeds it, and the plan's own economics say that arrives quietly: paid jobs starve behind checks
		 * that spend nothing, and nothing in the product explains why. A consecutive-denial count is the
		 * symptom an operator can actually see, so it is kept and its overflow is logged rather than absorbed.
		 */
		async noteThrottle(jobId, { denied }) {
			try {
				if (!denied) return void (await redis.hset(jobKey(jobId), "throttles", "0"));
				const n = Number(await redis.hincrby(jobKey(jobId), "throttles", 1)) || 0;
				await redis.pexpire(jobKey(jobId), counterTtlMs); // see noteCheck: a counter may CREATE this hash
				return n;
			} catch {
				return 0;
			}
		},

		/**
		 * Record what a check answered. `checks` only ever grows; `faults` is a CONSECUTIVE count, so a check
		 * that answered resets it -- a script that works after an outage has not accumulated a debt.
		 */
		async noteCheck(jobId, { fault }) {
			try {
				await redis.hincrby(jobKey(jobId), "checks", 1);
				if (fault) await redis.hincrby(jobKey(jobId), "faults", 1);
				else await redis.hset(jobKey(jobId), "faults", "0");
				// A counter can CREATE this hash: on a job's first polled wake nothing has held yet, and a path
				// that exits before `hold` (a lease denial, an unverified supersede) would otherwise leave a
				// key with NO expiry at all. That breaks the invariant this whole keyspace rests on -- "every
				// hash carries a TTL", which is why there is no index set to leak instead -- and the panel
				// would render a held row nothing could ever remove.
				await redis.pexpire(jobKey(jobId), counterTtlMs);
			} catch {
				// Fail open: a lost counter costs a longer wait, never a wrong verdict.
			}
		},

		/** How long this job has been held, in ms, or null when nothing was recorded. */
		async heldForMs(jobId) {
			try {
				const since = await redis.hget(jobKey(jobId), "since");
				// ABSENT IS NOT ZERO, and conflating them is not a rounding error: `Number(null)` is 0, so a
				// job with no recorded hold would read as held since the epoch and every bound measured from
				// here -- the maximum hold above all -- would fire on its first check.
				if (typeof since !== "string" || since.trim() === "") return null;
				const ms = Number(since);
				return Number.isFinite(ms) && ms > 0 ? Math.max(0, now() - ms) : null;
			} catch {
				return null;
			}
		},
	};
}
