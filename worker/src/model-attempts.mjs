/**
 * A job's model attempt key (`INT-MODEL-COOLDOWN-KEY`): `dispatch:model-attempt:<sha256(queueName:jobId)>`, the model the
 * job's last attempt ran on and whether its retry may switch away from it. The processor writes it before each attempt
 * (model-failover.mjs `writeModelAttempt`); this module names it, ends it and keeps it. Light on purpose, `node:crypto`
 * and the retention leaf only, because `cancel-state.mjs`, which the admin imports, deletes it too, and the admin's retry
 * keeps it.
 *
 * ITS LIFE FOLLOWS THE JOB'S (issue #812), the rule the approval requests keep (`run:approval:request:*`):
 *   - while a retry may still come it has no expiry. A retry can wait for any time (a paused queue, a backoff, a hold),
 *     so an expiry set when the key is written could take the evidence away from a retry that still comes;
 *   - once the queue says the job finished (the worker's `completed` event, or `failed` with `finishedOn` set, start.mjs)
 *     it gets `MODEL_ATTEMPT_FINISHED_TTL_MS`, a day past a forge job's retention, so it outlives the finished job's own
 *     hash, from which a console retry can still bring the job back. Never when a run record is written: the record is
 *     written before the queue acknowledges the job, and a job whose acknowledgement is lost can still run again;
 *   - when a cancel or the host-lost sweep removes the job, it is deleted;
 *   - when the console retries a failed job, the expiry is taken off again (`keepModelAttempt`), as the job is back
 *     where a retry may come for any time.
 * A retry's write is a plain `SET`, which clears the expiry again.
 */
import { createHash } from "node:crypto";
import { MODEL_ATTEMPT_FINISHED_TTL_MS } from "./retention.mjs";

/** The key of the attempt kept under `id` (`modelAttemptIdOf`). */
export const modelAttemptKey = (id) => `dispatch:model-attempt:${createHash("sha256").update(id).digest("hex")}`;

/** The id a job's attempt is kept under: its queue's name and its job id, as the processor names it. */
export const modelAttemptIdOf = (queueName, jobId) => `${queueName}:${jobId}`;

/**
 * Give a finished job's attempt its expiry. `PEXPIRE` sets nothing on a key that is absent, so a job that never chose a
 * model (no `fallbackModels`) creates nothing here. Rejects as the client does; the caller logs it.
 */
export async function finishModelAttempt(redis, id) {
	await redis.pexpire(modelAttemptKey(id), MODEL_ATTEMPT_FINISHED_TTL_MS);
}

/**
 * Send one `command` on the key `keyOf()` names, bounded by `timeoutMs` and best-effort: it never throws (a client
 * without the command, a key that cannot be named, a throw, a rejection and a reply that never comes all leave the key as
 * it was), and the bound's timer is cleared when the command answers first, so a CLI that sets its exit code rather than
 * exiting is not held open by it. The one body behind every bounded write below and cancel-state.mjs's defer record.
 */
async function bestEffort(redis, command, keyOf, timeoutMs) {
	if (typeof redis?.[command] !== "function") return;
	let timer;
	try {
		await Promise.race([
			Promise.resolve().then(() => redis[command](keyOf())),
			new Promise((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} catch {
		// Left as it was: see above.
	} finally {
		clearTimeout(timer);
	}
}

/** Delete `key`, bounded and best-effort (`bestEffort`): cancel-state.mjs deletes a removed job's defer record with it. */
export function dropKey(redis, key, timeoutMs = 2_000) {
	return bestEffort(redis, "del", () => key, timeoutMs);
}

/**
 * Delete a removed job's attempt, bounded and best-effort (`bestEffort`). A delete that fails leaves the key as the job
 * left it, without expiry.
 */
export function dropModelAttempt(redis, id, timeoutMs = 2_000) {
	return bestEffort(redis, "del", () => modelAttemptKey(id), timeoutMs);
}

/**
 * Take a retried job's attempt's expiry off again, bounded and best-effort (`bestEffort`): the console's retry of a
 * failed job (admin job-actions.mjs) calls it once BullMQ has put the job back. The failure gave the key
 * `MODEL_ATTEMPT_FINISHED_TTL_MS`, and only the processor's next selection writes it again without one; the retried job
 * can wait longer than what is left of it before that write (a paused queue or pause window, a busy scope, a hold for a
 * newer release), and would then find no evidence and be refused `model-failover-no-candidate`. `PERSIST` on an absent
 * key creates nothing, so a job without fallbacks, or one whose key already expired, is left as it was; so is a key a
 * `PERSIST` that fails could not reach, which keeps its expiry.
 */
export function keepModelAttempt(redis, id, timeoutMs = 2_000) {
	return bestEffort(redis, "persist", () => modelAttemptKey(id), timeoutMs);
}
