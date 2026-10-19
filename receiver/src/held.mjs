/**
 * Held replies, the receiver's side (issue #638, DES-AWAIT-INPUT-ENDS-THE-JOB; keys and scripts in the worker's
 * held-replies.mjs): an answer to a run that is parking right now is held for that run's settle instead of being lost.
 *
 * TWO WAYS A REPLY USED TO BE LOST, two entry points here, both shared by the four webhook arms and the poller so no
 * forge can weaken one alone (the four-copies doctrine of receiver.mjs):
 *   (a) `holdAfterDedup`: a resume comment for an awaitInput trigger that the semantic window deduplicated against a
 *       run still going (the parked run finishing, or a resumed run). Held under the SURVIVING job's id, which is the
 *       run id the worker registered: the window is keyed per target and flow, so the survivor is that run.
 *   (b) `holdBeforeLabel`: a phrase-free reply on an issue that the filter dropped ONLY because the parked marker was
 *       not set yet (the filter's `heldCandidate`). Held under every awaitInput run live on the target.
 * A run is live only while its worker's keeper refreshes it (held-settle.mjs), and the hold script refuses once the run
 * has settled, so `ok` or `dup` means the run's settle will see the reply; anything else (no live run, `gone`,
 * `closed`, `full`, a refusal, a Valkey fault) returns null and the caller answers EXACTLY as it did before this
 * feature: a hold is a rescue for a reply that was going to be lost, never a way to lose one that was not.
 *
 * WHAT THE HELD REPLY BECOMES is the worker's call at the run's final outcome: the first one started as a resumed job if
 * the run parked, dropped (today's coalescing) if it did not. The fallback stored is `fallbackJobOf`, the object the
 * late steer stores, so "the job this comment would have been" has one spelling.
 *
 * Not the steer inbox, deliberately, and never consulted by `trySteer`: see held-replies.mjs for why the keys are apart.
 * Logs carry the delivery, the kind, the target in the arm's grammar and run ids, never the comment. Never throws.
 */

import { awaitTargetKeyOf, holdReply, liveAwaitRunsForTarget, recentlyParked } from "@edgehero/pi-dispatch/held-replies";
import { forgeMessageId } from "@edgehero/pi-dispatch/steer-inbox";
import { fallbackJobOf } from "./steer.mjs";

/** At most this many live awaitInput runs of one target take a pre-label reply: the steer fanout's bound. */
export const HELD_FANOUT_LIMIT = 4;

const nowOf = (now) => (typeof now === "function" ? now() : now);

/**
 * Whether a fanout outcome may hold anything: a COMMENT-matched job armed with both `run.resume` (it continues the
 * parked session) and `run.awaitInput` (the trigger whose runs park), at least one replica of which the window
 * swallowed. Free, so the caller asks it before it asks for a Valkey client.
 */
export function wantsHoldAfterDedup(job, outcome) {
	return job?.trigger?.matched?.type === "comment" && job.resume === true && job.awaitInput === true && Array.isArray(outcome?.deduplicated) && outcome.deduplicated.length > 0;
}

async function holdUnder({ redis, runIds, job, kind, route, now, log, delivery, target }) {
	const id = forgeMessageId(job?.trigger?.deliveryId);
	if (id === null) {
		log({ event: "held_fell_through", delivery, kind, route, reason: "no-delivery-id" });
		return null;
	}
	const entry = { id, at: nowOf(now), route, fallback: fallbackJobOf(job, kind) };
	const held = [];
	const outcomes = {};
	for (const runId of runIds) {
		const r = await holdReply({ redis, runId, entry, now });
		const outcome = typeof r === "string" ? r : (r?.error ?? "error");
		outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
		if (r === "ok" || r === "dup") {
			held.push(runId);
			log({ event: "held", delivery, repo: job.repo, target, route, runId });
		}
	}
	if (held.length > 0) return { held: held.length, runIds: held };
	log({ event: "held_fell_through", delivery, kind, route, reason: Object.keys(outcomes).length === 1 ? Object.keys(outcomes)[0] : "mixed", outcomes });
	return null;
}

/**
 * (a) `{ held, runIds }` when at least one surviving run took the reply, else null. `outcome` is `fanout`'s, `job` the
 * job that was enqueued (no `steerMode`), `target` the arm's own grammar for the log.
 */
export async function holdAfterDedup({ redis, job, kind, outcome, now = Date.now, log = () => {}, delivery, target } = {}) {
	try {
		if (!wantsHoldAfterDedup(job, outcome)) return null;
		if (!redis) {
			log({ event: "held_fell_through", delivery, kind, route: "dedup", reason: "no-client" });
			return null;
		}
		const runIds = [...new Set(outcome.deduplicated.map((d) => d?.survivingJobId).filter((r) => typeof r === "string" && r !== ""))];
		if (runIds.length === 0) return null;
		return await holdUnder({ redis, runIds, job, kind, route: "dedup", now, log, delivery, target });
	} catch {
		return null;
	}
}

/**
 * (b) `{ held, runIds }` when at least one live awaitInput run on the candidate's target took the reply; `{ enqueue:
 * true }` when none did but a run PARKED on the target within the last minute (its take raised the parked marker,
 * held-replies.mjs): the reply was posted before the label and delivered after the take, and is enqueued as the ordinary
 * parked reply it would have been a moment later (it coalesces against the taken job, or resumes the parked session),
 * never dropped for the label it raced (review round 2); else null. `candidate` is the filter's `heldCandidate` (the
 * parked-reply job, `parkedReply: true`).
 */
export async function holdBeforeLabel({ redis, candidate, kind, now = Date.now, log = () => {}, delivery, target } = {}) {
	try {
		if (!candidate || typeof candidate !== "object" || candidate.parkedReply !== true) return null;
		const targetKey = awaitTargetKeyOf({ ...candidate, kind });
		if (targetKey === null) return null;
		if (!redis) {
			log({ event: "held_fell_through", delivery, kind, route: "pre-label", reason: "no-client" });
			return null;
		}
		const runs = await liveAwaitRunsForTarget({ redis, targetKey, now, limit: HELD_FANOUT_LIMIT });
		if (!Array.isArray(runs)) {
			log({ event: "held_fell_through", delivery, kind, route: "pre-label", reason: runs?.error ?? "error" });
			return null;
		}
		const held = runs.length > 0 ? await holdUnder({ redis, runIds: runs, job: candidate, kind, route: "pre-label", now, log, delivery, target }) : null;
		if (held !== null) return held;
		const parked = await recentlyParked({ redis, targetKey });
		if (parked === true) {
			log({ event: "held_after_park", delivery, kind, repo: candidate.repo, target });
			return { enqueue: true };
		}
		// No live run and no park is the ordinary case (a phrase-free comment on an issue nothing is parking on), so it
		// logs nothing: the caller's `dropped` line is exactly today's.
		return null;
	} catch {
		return null;
	}
}
