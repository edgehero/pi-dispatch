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
 */

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
 * Remove a job that is held on a `run.waitFor` condition: hold keys first, then the job (issue #230's
 * sequence, issue #287's shared home). This is the inner body of the admin's `cancelHeldJob`, moved here
 * so the CLI's held path and the panel's are ONE sequence rather than two copies that can drift -- the
 * read-model's own rule is that key derivations are imported from the worker, never re-implemented.
 *
 * Returns `{ ok: true, jobId }` or `{ invalid: <reason> }`; never throws. Writes no run record: the job
 * never ran, and INT-RUN-HISTORY-FILE-CONTRACT records terminal states of runs.
 */
export async function removeHeldJob({ redis, queue, jobId }) {
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
		await redis.del(jobKey(jobId));
		await redis.srem(HELD_SET, jobId).catch(() => {});
		if (hash.dedupId) {
			const holder = await redis.get(leaseKey(hash.dedupId));
			if (holder === jobId) await redis.del(leaseKey(hash.dedupId));
		}
		await job.remove();
		return { ok: true, jobId };
	} catch (err) {
		return { invalid: err?.message ?? String(err) };
	}
}
