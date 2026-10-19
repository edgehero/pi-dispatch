/**
 * Comment steering (issue #646, INT-STEER-INBOX-CONTRACT, DES-STEER-TARGET-POINTER-IS-LIVENESS-NOT-INDEX): before the
 * receiver enqueues a phrase comment from a steer-armed trigger, it asks whether any steer-armed run is already going on
 * the same issue or pull request, and if one is, it hands the comment to that run's inbox instead of starting a second
 * paid job.
 *
 * PER TARGET, NOT PER TRIGGER. The worker's relay registers every armed run under its target alone (kind, repo, target
 * type, number), so a phrase comment reaches whatever steer-armed run is live on that issue or pull request, whichever
 * trigger started it: a label-triggered run takes a comment from the comment trigger. The comment trigger's own arm
 * (`run.steer`, required for `steerMode`) is what lets its comments steer at all; the run's arm is what lets it take one.
 *
 * `trySteer` is the one body the four webhook arms and the poller's gate share, so no forge can weaken it alone. It is
 * the receiver's only I/O beyond the queue, and it is NOT in a filter: the filters stay pure and only say THAT a
 * comment may steer (`job.steerMode`); whether a run is live is a Valkey question asked here.
 *
 * WHAT IT DOES, in order, every free refusal before any Valkey call:
 *   1. the comment body is bounded and scrubbed with the worker's own rule (`boundSteerText`), and the entry the
 *      inbox would store is validated (`normalizeSteerEntry`), so a refusal costs nothing and names no text;
 *   2. the target pointer is the worker relay's own derivation (`steerTargetOf`, imported, never re-spelled): a key
 *      computed two ways is a key that one day differs, and then every comment silently starts a second job;
 *   3. the target's live runs (`liveRunsForTarget`, at most STEER_FANOUT_LIMIT);
 *   4. for each run, the fallback job FIRST, then the push.
 *
 * WHY THE FALLBACK IS STORED BEFORE THE PUSH, not after an `ok`. The run's final close (settle) can land between the
 * two calls. Push then close then store would leave a `late` message whose fallback is not there yet when settle reads
 * it, and the comment would be neither run nor answered: the silent loss the push and close pair exists to rule out.
 * Store then push has no such gap. Its cost is a fallback entry under a run that then refused the push (`gone`,
 * `closed`, `full`): an orphan with the inbox's hour, read by nothing, because settle only looks up the ids it closed.
 * A failed store skips that run's push for the same reason: a message accepted without a fallback could go late with
 * nothing to start.
 *
 * A STEERED COMMENT IS NEVER ENQUEUED, so the queue's delivery-GUID shield (REQ-DEDUP-BY-DELIVERY-GUID) never sees its
 * id. Without a stand-in, a redelivery of the same GUID after its run ended (a forge redelivery, a poller cycle
 * retried after a crash) would find no live run, fall through and start the paid job the steer replaced. So a steer
 * sets `steer:steered:<delivery job id>` (NX, 31 days, the GUID job id's own retention), and every fall-through that
 * reached Valkey asks for it first: present, the delivery is answered as steered (`redelivered`) and never enqueued.
 * Set AFTER a push succeeded, never before: a marker for a comment that was then enqueued would be harmless while the
 * enqueue holds, but one whose enqueue failed (a 503 the forge redelivers) would swallow the redelivery, a lost job.
 *
 * WHAT COUNTS AS STEERED. Any `ok` or `dup`. `dup` is a redelivered webhook GUID the run already holds (the id is the
 * GUID's digest), so the comment was handled the first time and enqueueing it now would double it. Everything else
 * (no live run, every run `gone`, `closed` or `full`, a refusal, a Valkey fault) returns null and the caller enqueues
 * exactly as it did before this feature: steering is an optimisation over a job, never a way to lose one.
 *
 * NO TIMEOUT on the Valkey calls, deliberately. The enqueue that follows a null uses the same Valkey with no timeout
 * either, so a bound here would buy no availability; and a push that succeeded but answered after a timeout would
 * fall through to an enqueue as well: one comment, a steer AND a new job.
 *
 * Logs carry the delivery, the kind, run ids and counts, never the body (no-pii-in-logs). Never throws.
 */

import { forgeDeliveryJobId } from "@edgehero/pi-dispatch/job-id";
import { steerTargetOf } from "@edgehero/pi-dispatch/inbox-relay";
import { STEER_MODES, boundSteerText, forgeMessageId, liveRunsForTarget, normalizeSteerEntry, pushSteer, scrubSteerText, storeFallback } from "@edgehero/pi-dispatch/steer-inbox";

/** How long a steered delivery's marker lives: the GUID job id's own 31-day retention (`enqueueForgeJob`). */
export const STEER_MARKER_TTL_S = 31 * 24 * 3600;

/** The marker a steered delivery leaves, keyed by the job id the comment would have been enqueued under; null without one. */
export function steeredMarkerKey(kind, deliveryId) {
	try {
		return `steer:steered:${forgeDeliveryJobId(kind, deliveryId)}`;
	} catch {
		return null;
	}
}

/** At most this many live runs of one target take a comment: the plan's fanout bound (replicas and parallel jobs). */
export const STEER_FANOUT_LIMIT = 4;

/**
 * The association a non-GitHub forge's author is framed with. GitLab, Forgejo and Azure carry no author_association;
 * their gate is the receiver's resolved write-access verdict (`authorized === true`), so that verdict is what the
 * framing states. A fixed word rather than a guessed role: the receiver knows the person cleared the gate, not which
 * role they hold.
 */
export const FORGE_GATE_ASSOCIATION = "WRITE_ACCESS";

const nowOf = (now) => (typeof now === "function" ? now() : now);

/** The entry's author: the sender's id (numeric, or Azure DevOps's GUID or `azid-` digest) and the association the author gate judged. */
export function steerAuthorOf(job, kind) {
	const association = kind === "github" ? job?.trigger?.comment?.author_association : FORGE_GATE_ASSOCIATION;
	return { kind: "forge", id: job?.trigger?.sender?.id, association };
}

/** Why a body cannot be steered, as a fixed token for a log line (never the refusal's words, never the text). */
function skipReason(body) {
	if (typeof body !== "string") return "no-body";
	if (typeof body.isWellFormed === "function" && !body.isWellFormed()) return "malformed";
	if (scrubSteerText(body).trim() === "") return "empty";
	return "too-large";
}

/**
 * The job the receiver would have enqueued, as late branch A starts it: the job, its kind and its delivery job id. Exported
 * for held replies (issue #638, held.mjs), whose fallback is the same object for the same reason: one spelling of "the job
 * this comment would have been".
 */
export function fallbackJobOf(job, kind) {
	const { steerMode: _mode, ...rest } = job;
	let jobId = null;
	try {
		jobId = forgeDeliveryJobId(kind, job.trigger?.deliveryId);
	} catch {}
	return { ...rest, kind, jobId };
}

/**
 * `trySteer({ redis, job, kind, now, log })` -> `{ steered, runIds }` when at least one live run took the comment
 * (`ok` or `dup`); `{ steered: 0, runIds: [], redelivered: true }` when no run took it but this delivery was steered
 * before (answer it, never enqueue it); else null and the caller enqueues. `job` is the filter's job (carrying `steerMode`); `kind` the forge.
 */
export async function trySteer({ redis, job, kind, now = Date.now, log = () => {} } = {}) {
	if (!job || typeof job !== "object" || !STEER_MODES.includes(job.steerMode)) return null;
	const delivery = job.trigger?.deliveryId;
	const fellThrough = (reason, extra = {}) => {
		log({ event: "steer_fell_through", delivery, kind, reason, ...extra });
		return null;
	};

	const id = forgeMessageId(delivery);
	if (id === null) return fellThrough("no-delivery-id");
	const body = job.trigger?.comment?.body;
	const bounded = boundSteerText(body);
	if (bounded.refusal) {
		// Not `steer_skipped`: that is runContainer's line for a run that could not be armed (`{ container, reason }`).
		log({ event: "steer_comment_skipped", delivery, kind, reason: skipReason(body) });
		return null;
	}
	const at = nowOf(now);
	const entry = { id, mode: job.steerMode, source: "forge", author: steerAuthorOf(job, kind), text: bounded.text, at, deliveryId: delivery };
	// The push validates this too; asking first makes a refusal free and one log line rather than one per run.
	if (normalizeSteerEntry(entry, now).refusal) return fellThrough("entry-refused");

	// The repo is the job's own spelling. For the poller that is POLL_REPOS's spelling, not GitHub's canonical one: it
	// is also the spelling the poller's own runs registered under (the relay derives from the queued job), so the two
	// agree for a poller deployment, and canonicalising here alone would break exactly that case. Only a deployment
	// running BOTH the webhook and the poller, with a POLL_REPOS entry cased unlike GitHub's name, keys the two apart;
	// its comments then fall through to an ordinary job, never get lost.
	const { targetKey } = steerTargetOf({ ...job, kind });
	if (targetKey === null) return fellThrough("no-target");
	if (!redis) {
		log({ event: "steer_lookup_failed", delivery, kind, reason: "no-client" });
		return null;
	}

	const runs = await liveRunsForTarget({ redis, targetKey, now, limit: STEER_FANOUT_LIMIT });
	if (!Array.isArray(runs)) {
		log({ event: "steer_lookup_failed", delivery, kind, reason: runs?.error ?? "error" });
		return null;
	}
	const marker = steeredMarkerKey(kind, delivery);
	// A fall-through that reached Valkey: a delivery already steered once is answered as steered, never enqueued.
	const redeliveredOr = async (reason, extra = {}) => {
		if (marker !== null) {
			try {
				if (Number(await redis.exists(marker)) === 1) {
					log({ event: "steer_redelivered", delivery, kind, reason });
					return { steered: 0, runIds: [], redelivered: true };
				}
			} catch (error) {
				log({ event: "steer_marker_failed", delivery, kind, op: "read", reason: typeof error?.code === "string" ? error.code : "valkey" });
			}
		}
		return fellThrough(reason, extra);
	};
	if (runs.length === 0) return redeliveredOr("no-live-run");

	const fallback = fallbackJobOf(job, kind);
	const runIds = [];
	const outcomes = {};
	let errored = null;
	for (const runId of runs) {
		const stored = await storeFallback({ redis, runId, id, job: fallback });
		if (stored?.ok !== true) {
			errored ??= stored?.error ?? "error";
			outcomes.error = (outcomes.error ?? 0) + 1;
			log({ event: "steer_fallback_failed", delivery, kind, runId, reason: stored?.error ?? "refused" });
			continue;
		}
		const r = await pushSteer({ redis, runId, entry, now });
		const outcome = typeof r === "string" ? r : "error";
		outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
		if (r === "ok" || r === "dup") runIds.push(runId);
		else if (typeof r !== "string") errored ??= r?.error ?? "error";
	}
	if (runIds.length > 0) {
		// A run that missed while another took the comment is named, so a fanout that half worked is visible.
		if (runIds.length < runs.length) log({ event: "steer_partial", delivery, kind, runs: runs.length, steered: runIds.length, outcomes });
		if (marker !== null) {
			try {
				await redis.set(marker, "1", "EX", STEER_MARKER_TTL_S, "NX");
			} catch (error) {
				// Still steered: the comment is in the run. Only a redelivery after the run ends is unshielded, and says so here.
				log({ event: "steer_marker_failed", delivery, kind, op: "write", reason: typeof error?.code === "string" ? error.code : "valkey" });
			}
		}
		return { steered: runIds.length, runIds };
	}
	if (errored !== null && Object.keys(outcomes).every((o) => o === "error")) {
		log({ event: "steer_lookup_failed", delivery, kind, reason: errored });
		return null;
	}
	const kinds = Object.keys(outcomes);
	return redeliveredOr(kinds.length === 1 ? kinds[0] : "mixed", { runs: runs.length, outcomes });
}
