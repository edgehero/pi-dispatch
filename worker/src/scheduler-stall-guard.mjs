/**
 * Per-scheduler stall accounting -- the money backstop for cron (CONST-RETRY-INFRA-ONLY).
 *
 * BullMQ's `maxStalledCount` does not cover scheduler jobs: `moveStalledJobsToWait` derives
 * `isRepeatableJob` from the job's `rjk` field and skips the stall-fail for a live scheduler, so a
 * wedged scheduled run is re-processed -- paid -- on every stall, indefinitely. `maxStalledCount: 0`
 * bounds ordinary jobs; nothing in BullMQ bounds scheduler jobs. This guard counts stalls per
 * scheduler over a rolling window and tears the scheduler down once the count exceeds a threshold.
 *
 * Injected `redis` (ioredis-compatible), `removeJobScheduler`, and `log` keep the logic testable with
 * no queue, no bullmq import, and no real Valkey.
 *
 * Custom: per-scheduler stall accounting; BullMQ's maxStalledCount does not cover scheduler jobs -- CONST-RETRY-INFRA-ONLY carve-out ("BullMQ will never do this for us")
 */

// The prefix every stall counter lives under, so `KEYS pi-dispatch:sched-stalls*` still shows an operator
// the whole feature -- the affordance `wait:`, `slot:` and `budget:` all assume. Exported alongside the
// builder so the admin panel and the integration teardown compose keys through one definition and cannot
// drift from the writer.
export const STALL_KEY = "pi-dispatch:sched-stalls";

/**
 * One scheduler's counter. The id is VALIDATED upstream rather than hashed here: it is operator-declared in
 * `triggers.json`, `triggers.mjs` already refuses a `:` in it precisely to protect this parse, and the value
 * of a readable keyspace is that `GET pi-dispatch:sched-stalls:nightly` answers the question directly.
 */
export const stallKey = (schedulerId) => `${STALL_KEY}:${schedulerId}`;

// ONE KEY PER SCHEDULER, so the window is per scheduler.
//
// This was one HASH with a field per scheduler and a single `EXPIRE` on the whole key, which meant any
// scheduler's stall pushed the TTL forward for EVERY scheduler's count. The window never reset on a
// deployment where anything stalled regularly, so the guard silently degraded from "sustained stalling
// inside one window" to "cumulative stalling ever": three stalls ninety days apart tore a scheduler down
// if a neighbour was stalling twice a day, and did not if the deployment was quiet. Same scheduler, same
// stalls, opposite outcome, decided by an unrelated trigger (issue #267).
//
// Per-field TTLs would have fixed it in place and are not available: `HEXPIRE` does not exist on the pinned
// `valkey/valkey:8` (verified, `ERR unknown command`, recorded under DES-HOST-REGISTRY). A key per entity is
// the only shape that gets per-entity expiry.
//
// The EXPIRE still ROLLS on every stall, deliberately, and that is not `budget.mjs`'s set-once rule being
// broken. A budget window is a CALENDAR window and must not be pushed forward by traffic or a busy day
// never resets. This is a STREAK detector -- "is this scheduler wedged right now" -- and quiet for a day
// genuinely should forget. `poll:<repo>:close-gate:<deliveryId>` is the in-repo precedent, a bounded
// consecutive-failure counter given its own key and TTL for exactly this reason: it must decay with the
// thing it measures rather than with a larger family.
const STALL_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Build the `stalled` listener. `threshold` is how many stalls a single scheduler may accrue before
 * teardown, compared STRICT `>` to mirror BullMQ's own `stalledCount > maxStalledJobCount`.
 * `removeJobScheduler(schedulerId)` tears a scheduler down; `log(event, fields)` records stable ids
 * only, never task or body content.
 *
 * The returned `onStalled` never rejects: BullMQ's `stalled` event is fire-and-forget (void-invoked),
 * so a rejection here would surface as an unhandled rejection with no handler to catch it.
 */
export function makeStallGuard({ redis, threshold, removeJobScheduler, log }) {
	return async function onStalled(jobId) {
		try {
			// Ordinary jobs are bounded by `maxStalledCount: 0`; only scheduler jobs reach this accounting.
			if (!jobId.startsWith("repeat:")) return;

			const schedulerId = jobId.slice("repeat:".length, jobId.lastIndexOf(":"));
			if (schedulerId === "") {
				// Degenerate `repeat:<n>` / `repeat::<n>` with no scheduler segment: an empty hash field would
				// pool every such id into one counter, so log and skip rather than hincrby an empty key.
				log("scheduler_stall_unparsed", { jobId });
				return;
			}

			const key = stallKey(schedulerId);
			const count = Number(await redis.incr(key));
			await redis.expire(key, STALL_WINDOW_SECONDS);

			if (count > threshold) {
				try {
					await removeJobScheduler(schedulerId);
				} catch (error) {
					// A scheduler already gone (removed concurrently, or between the stall and now) is the goal
					// state, not an error -- swallow it so hdel and the teardown alert still run.
					log("scheduler_teardown_remove_failed", { schedulerId, error: error?.message });
				}
				await redis.del(key);
				// The loud log is the "alert" half of the constitution's "removeJobScheduler -- or alert".
				log("scheduler_torn_down", { schedulerId, stalls: count });
			}
		} catch (error) {
			log("scheduler_stall_guard_error", { jobId, error: error?.message });
		}
	};
}
