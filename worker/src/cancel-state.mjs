/**
 * The `cancel:` keyspace: how an operator's cancel reaches the worker that owns a running job (issue #287).
 *
 * BullMQ's `cancelJob` aborts an entry in ONE process's tracked-job map -- it is unreachable from another
 * process, returns `false` silently for a job it does not hold, and nothing anywhere maps a jobId to the
 * host draining it. So the CLI and the panel cannot call it; they can only ask. This keyspace is the ask:
 *
 *   cancel:req:<jobId>        STRING "operator-cancel", TTL 60s -- the request. Written by the CLI or the
 *                             panel; consumed (DEL) by the worker that holds the job; deleted by the
 *                             requester itself when it gives up, so a request the operator was told failed
 *                             cannot fire a minute later. The TTL is the backstop for a requester that died.
 *   cancel:ack:<jobId>        STRING <workerName> -- the answer, written by the worker AFTER it raised the
 *                             abort. A name, possibly "", never a path (INT-HOST-REGISTRY-CONTRACT's content
 *                             rule). TTL 5m: long enough for a requester that polls slowly, gone before the
 *                             id could plausibly be reused.
 *
 * WHY A DURABLE KEY AND NOT PUB/SUB. A subscriber is a dedicated connection type this repo has zero of, and
 * fire-and-forget loses a cancel across a worker restart or a blip with no error anywhere -- the silent
 * no-op this project refuses. The key survives until someone answers or the TTL says nobody will, it is
 * operator-inspectable (`KEYS cancel:*`, the wait-state doctrine), and the ack the acceptance requires
 * ("a cancel of a job this host does not own says so") needs a readable key regardless.
 *
 * WHY THIS IS NOT THE REDIS STATE OQ-008 REFUSED. That refusal is about durable CONFIG whose deletion
 * silently loses an operator's edit. This is a transient, attended, TTL-bounded one-shot whose loss is
 * REPORTED: the requester is watching the ack poll, and a request that reaches nobody comes back as a
 * named timeout, never as silence.
 *
 * BESIDE IT, THE `defer:` KEYSPACE (issue #737), which this module deletes from and never writes:
 *
 *   defer:job:<jobId>         HASH, why the worker put a waiting job back on the delayed set
 *                             (`defer-reasons.mjs` holds the fields and their rules, `defer-write.mjs` writes
 *                             it, with its own TTL). `removeQueuedJob` deletes it once the job is removed, so a
 *                             removed job leaves no reason behind. The TTL is the backstop for a delete that
 *                             fails, and a record without its job is never shown: every reader starts from
 *                             the queue's own sets.
 */

import { deferKey } from "./defer-reasons.mjs";
import { HELD_SET, jobKey, leaseKey } from "./wait-state.mjs";

/** How long an unanswered request may sit before redis reaps it (the requester deletes it sooner). */
export const CANCEL_REQ_TTL_MS = 60_000;

/** How long the worker's answer stays readable. Generous: an ack outliving its poller costs nothing. */
export const CANCEL_ACK_TTL_MS = 5 * 60_000;

export const cancelReqKey = (jobId) => `cancel:req:${jobId}`;
export const cancelAckKey = (jobId) => `cancel:ack:${jobId}`;

/**
 * Ask whichever worker holds `jobId` to cancel it, and wait briefly for the answer.
 *
 * Resolves `{ ack: host }` when a worker acknowledged (host may be ""), or `{ timeout: true }` when nobody
 * did within `ackTimeoutMs` -- in which case the request key is deleted first, so the operator's "nothing
 * was changed" stays true after they walk away. Redis errors propagate: the callers (CLI, panel deps) each
 * already own a could-not-reach-Valkey message, and swallowing here would turn an unreachable Valkey into
 * a lying "no worker acknowledged".
 *
 * `pollMs`/`sleep` are injectable so tests never wait on a wall clock.
 */
export async function requestCancel({ redis, jobId, ackTimeoutMs = 10_000, pollMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
	await redis.set(cancelReqKey(jobId), "operator-cancel", "PX", CANCEL_REQ_TTL_MS);
	for (let waited = 0; ; waited += pollMs) {
		const host = await redis.get(cancelAckKey(jobId));
		if (host !== null && host !== undefined) return { ack: host };
		if (waited + pollMs > ackTimeoutMs) break;
		await sleep(pollMs);
	}
	// Best-effort: losing this DEL to a blip leaves the 60s TTL as the backstop, and the worker-side GET
	// racing it by one tick is a named residual (the operator is told to re-check `status`).
	await redis.del(cancelReqKey(jobId)).catch(() => {});
	return { timeout: true };
}

/**
 * What a removed job had done before a cancel removed it, in the CLI's and the panel's words (issue #477), from BullMQ's
 * own counter. `attemptsMade` counts the attempts that FINISHED (moveToFinished/moveToFailed, bullmq 5.80.4). Most of
 * them wrote a run record, but not all: a gate above the processor's `try` (a `moveToDelayed` or a wait-state read that
 * rejects) fails the attempt with nothing recorded, by design (index.mjs). So the sentence says an attempt was made and
 * that whatever it recorded stays, never that a record exists. NOT `attemptsStarted`: a hold on run.waitFor, a
 * pause-gate move and a rootful-Podman deferral each take the job and hand it back to the delayed set with
 * `skipAttempt`, which counts a start and no attempt (moveToDelayed), so that counter is non-zero on jobs that never
 * ran. Cancel itself writes no record in any case.
 */
export function ranBefore(job) {
	const made = Number.isInteger(job?.attemptsMade) && job.attemptsMade > 0 ? job.attemptsMade : 0;
	if (made === 0) return "it never ran; no record written";
	return made === 1
		? "it made 1 attempt before and was waiting to retry; whatever that attempt recorded stays, and cancel writes none"
		: `it made ${made} attempts before and was waiting to retry; whatever those attempts recorded stays, and cancel writes none`;
}

/**
 * Whether the hold is still there, read back after its delete failed: its CLOCK (`since`), the field that makes the hash
 * a hold, since the worker's own counters can re-create the key without it. False when it cannot be read.
 */
async function holdInPlace(redis, jobId) {
	if (typeof redis?.hexists !== "function") return false;
	try {
		return (await redis.hexists(jobKey(jobId), "since")) === 1;
	} catch {
		return false;
	}
}

/**
 * Remove a job that is held on a `run.waitFor` condition: hold keys first, then the job (issue #230's
 * sequence, issue #287's shared home). This is the inner body of the admin's `cancelHeldJob`, moved here
 * so the CLI's held path and the panel's are ONE sequence rather than two copies that can drift -- the
 * read-model's own rule is that key derivations are imported from the worker, never re-implemented.
 *
 * Returns `{ ok: true, jobId, attemptsMade }`, `{ invalid: <reason> }` (refused, or failed before anything was
 * deleted: nothing was changed), or `{ invalid: <reason>, cleared: true }` when it failed once the hold's first key had
 * been sent for deletion (most often `remove` refusing a job a worker locked in between): the hold is gone, or partly
 * gone, while the job's own removal failed, which a caller must never word as "nothing was changed". A first delete
 * that failed answers `{ invalid }` only when the hold is read back in place afterwards (Valkey refused the command:
 * NOPERM, READONLY, MISCONF); a hold not read back, or a read that fails, keeps the mark, since a refusal can answer a
 * resend of a delete that already ran. Never throws.
 * Writes no run record of its own (INT-RUN-HISTORY-FILE-CONTRACT records terminal states of runs, and a removed hold
 * is none); `attemptsMade` is what the job had done before, for the caller's sentence (`ranBefore`, issue #477): a job
 * held again on a retry has made attempts, and whatever they recorded stays.
 */
export async function removeHeldJob({ redis, queue, jobId }) {
	// Set as the first hold key's delete is sent, before it is answered: a delete lost in transit may still have landed.
	let cleared = false;
	try {
		const hash = await redis.hgetall(jobKey(jobId));
		// A hold is a hash with a CLOCK, not merely a non-empty hash: the worker's own counters create this
		// key before anything is held, so "non-empty" would let this tool reach a job that is not waiting.
		if (!hash || !hash.since) return { invalid: `job ${jobId} is not waiting on a condition` };
		const job = await queue.getJob(jobId);
		if (!job) return { invalid: `job ${jobId} is no longer in the queue` };
		// STATE, not existence. `release` is fail-open by design, so a redis blip can leave the hash behind
		// while the job wakes, runs and completes -- and bullmq will happily `remove()` a completed job. That
		// would answer `applied: true` to an operator who approved a dialog reading "It will never run", for
		// a job whose run record is already on disk.
		const state = await job.getState().catch(() => null);
		if (state !== "delayed" && state !== "waiting" && state !== "prioritized") {
			return { invalid: `job ${jobId} is ${state ?? "in an unknown state"}, not waiting -- it has already left the hold` };
		}
		// The hold goes FIRST. If `remove` throws (an active job is locked) or a caller's timeout fires
		// mid-sequence, an orphaned hash would keep a row on the panel for a job that no longer exists; an
		// orphaned JOB is merely a job that still runs, which is the state the operator was already in.
		cleared = true;
		try {
			await redis.del(jobKey(jobId));
		} catch (err) {
			// A failed DEL may still have run: ioredis resends an unanswered command after a reconnect, and the refusal
			// (an ACL without DEL, a read-only replica, a failed save) can be the answer to that resend. So the hold is
			// read back, and only a hold still in place makes "nothing was changed" true; a read that fails keeps the mark.
			if (await holdInPlace(redis, jobId)) cleared = false;
			throw err;
		}
		await redis.srem(HELD_SET, jobId).catch(() => {});
		if (hash.dedupId) {
			const holder = await redis.get(leaseKey(hash.dedupId));
			if (holder === jobId) await redis.del(leaseKey(hash.dedupId));
		}
		await job.remove();
		// Issue #477: what the job had done, for the caller's sentence (`ranBefore`); read off the job just removed.
		return { ok: true, jobId, attemptsMade: Number.isInteger(job.attemptsMade) && job.attemptsMade > 0 ? job.attemptsMade : 0 };
	} catch (err) {
		const invalid = err?.message ?? String(err);
		return cleared ? { invalid, cleared: true } : { invalid };
	}
}

/**
 * The states a job that has not started waits in, by the names `job.getState()` answers with: what `removeQueuedJob`
 * removes. `paused` is the CLI's own list since issue #287; BullMQ 5.80.4 reads a job in a paused queue's list as
 * `waiting`, so on it that job is removed under that word.
 */
export const QUEUED_STATES = Object.freeze(["delayed", "waiting", "prioritized", "paused"]);

/**
 * Remove a job that waits to start (issue #737): the ONE sequence `pi-dispatch cancel` and the console's cancel-queued
 * run, so the two cannot drift. Who may be removed is the caller's rule, not this function's: the CLI removes a job
 * waiting to retry too, and the console refuses one that has ever started. `job` is the job the caller found on `queue`.
 *
 *   held on run.waitFor (its `wait:job` hash has `since`)  -> `removeHeldJob`, hold keys first, then the job;
 *   delayed, waiting, prioritized or paused (`QUEUED_STATES`) -> `job.remove()`;
 *   any other state                                      -> nothing is changed.
 *
 * A HOLD IS JUDGED FIRST: a held job IS delayed, and the plain path would strand its `wait:*` keys as a panel row for a
 * job that no longer exists. A hash that cannot be read is not a hold, as the CLI has always read it. `state` is the
 * state the caller already read, or null to read it here.
 *
 * `guard` (optional; the CLI passes none) is a caller's last check, asked with `job` right before the removal is sent:
 * before `removeHeldJob` for a held job, and after the state check, before `remove()`, otherwise. It answers null to go
 * on, or what to refuse with; a guard that throws refuses too. BullMQ's remove checks only the job's lock and its
 * scheduler, so a caller whose rule is about what the job has DONE (the console's never-started rule) reads that again
 * here, one round trip before the remove (for a held job, before `removeHeldJob`'s own reads and deletes), rather than
 * at its own earlier check.
 *
 * Once the job is removed, its defer record (`defer:job:<jobId>`) is deleted too: bounded by `timeoutMs`, best-effort,
 * and only after a removal that succeeded, so a job that stays keeps its reason. Returns, and never throws:
 *   `{ ok: true, held: true, jobId, attemptsMade }`         a held job, removed;
 *   `{ invalid }`                                            `removeHeldJob`'s own refusal of a held job, nothing changed;
 *   `{ invalid, cleared: true }`                             `removeHeldJob` failed after its hold's keys were deleted: the
 *                                                            hold is gone and the job's own removal failed (never "nothing
 *                                                            was changed");
 *   `{ refused, error? }`                                    the guard's answer (`refused`), or its throw (`refused` null,
 *                                                            `error` the throw); nothing was sent;
 *   `{ notQueued: true, state }`                             not waiting to start (`active`, `completed`, `unknown`...);
 *   `{ ok: true, held: false, jobId, state, attemptsMade }`  a waiting job, removed;
 *   `{ raced: true, state, error }`                          `remove()` threw (most often: a worker took the job between
 *                                                            the read and the remove, or it is a job scheduler's next
 *                                                            run, which BullMQ refuses to remove); `state` is read again.
 * `attemptsMade` is the job's own count for the caller's sentence (`ranBefore`), 0 when it is not a positive whole number.
 */
export async function removeQueuedJob({ redis, queue, job, jobId, state = null, timeoutMs = 2_000, guard = null }) {
	const hash = await Promise.resolve()
		.then(() => redis.hgetall(jobKey(jobId)))
		.catch(() => null);
	if (hash?.since) {
		const stop = await guarded(guard, job);
		if (stop !== null) return stop;
		const res = await removeHeldJob({ redis, queue, jobId });
		if (!res.ok) return res.cleared === true ? { invalid: res.invalid, cleared: true } : { invalid: res.invalid };
		await dropDeferRecord(redis, jobId, timeoutMs);
		return { ok: true, held: true, jobId: res.jobId, attemptsMade: res.attemptsMade };
	}
	if (!job) return { notQueued: true, state: "unknown" };
	const current = typeof state === "string" ? state : await stateOf(job);
	if (!QUEUED_STATES.includes(current)) return { notQueued: true, state: current };
	const stop = await guarded(guard, job);
	if (stop !== null) return stop;
	try {
		await job.remove();
	} catch (error) {
		return { raced: true, state: await stateOf(job), error };
	}
	await dropDeferRecord(redis, jobId, timeoutMs);
	return { ok: true, held: false, jobId, state: current, attemptsMade: Number.isInteger(job.attemptsMade) && job.attemptsMade > 0 ? job.attemptsMade : 0 };
}

/** `removeQueuedJob`'s guard asked: null to go on (no guard, or a null answer), else `{ refused }`, or `{ refused: null, error }` for a throw. */
async function guarded(guard, job) {
	if (typeof guard !== "function") return null;
	try {
		const answer = await guard(job);
		return answer === null || answer === undefined ? null : { refused: answer };
	} catch (error) {
		return { refused: null, error };
	}
}

/** A job's state, "unknown" where it cannot be read, as the CLI has always read it. */
function stateOf(job) {
	return Promise.resolve()
		.then(() => job.getState())
		.catch(() => "unknown");
}

/**
 * Delete a removed job's defer record, bounded and best-effort: the record's own TTL is the backstop, and a record whose
 * job is gone is never read. The bound's timer is cleared when the delete wins, so a CLI that sets its exit code rather
 * than exiting is not held open by it.
 */
async function dropDeferRecord(redis, jobId, timeoutMs) {
	if (typeof redis?.del !== "function") return;
	let timer;
	try {
		await Promise.race([
			Promise.resolve().then(() => redis.del(deferKey(jobId))),
			new Promise((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} catch {
		// A delete that fails leaves the record to its TTL.
	} finally {
		clearTimeout(timer);
	}
}
