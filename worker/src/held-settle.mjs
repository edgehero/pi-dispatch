import { isFinalOutcome } from "./inbox-settle.mjs";
import { enqueueForgeJob, QUEUE } from "./queue.mjs";
import { runIdOf } from "./recovery-queue.mjs";
import { sanitizeJobId } from "./run-history.mjs";
import * as heldModule from "./held-replies.mjs";

/**
 * The worker's side of held replies (issue #638, DES-AWAIT-INPUT-ENDS-THE-JOB; the keys and the scripts are
 * held-replies.mjs's): a keeper that keeps an awaitInput run reachable while it runs, the take inside the park that
 * turns what it held into at most one resumed job, and the final settle that drops what a run that did not park held.
 *
 * WHY THE WORKER AND NOT THE RECEIVER DECIDES. The receiver only knows that a reply met a run that is still going; it
 * cannot know whether that run will park (the agent may finish, fail, or be cancelled after asking). The worker learns
 * it in the park sequence, or at the run's final outcome, so that is where a held reply becomes a job or is dropped. Dropping is today's
 * coalescing exactly: a reply that met a run which then did NOT park was always deduplicated against it, and still is.
 */

/** The keeper's refresh period, the steer relay's: 2 s against a 30 s open key. */
export const AWAIT_KEEPER_POLL_MS = 2_000;

/**
 * How far back before the park a held reply may have been written and still be taken as the answer (issue #638 review,
 * M1). The keeper registers the run for its whole pickup, so without a bound a phrase-free comment made ten minutes
 * into a long run, before the agent had asked anything, would be taken as "the answer" to a question posted later.
 * Five minutes covers the seconds between the agent's question and the park with a wide margin; an older entry is
 * dropped silently, which is the coalescing it always got. Residual, named: a comment written in the last five minutes
 * before the question and not meant as an answer is taken as one (the resumed agent reads it as a reply and may ask
 * again).
 */
export const HELD_LOOKBACK_MS = 5 * 60 * 1000;

/**
 * The one comment the replies after the first get, however many there are (fixed words, no mention, no quote of any
 * reply). The first reply is the answer the parked run resumes with; a run asks for one answer, and starting a second
 * resumed job from the same parked session would race the first for it.
 */
export const HELD_EXTRA_REPLY = "This run was waiting for one answer and took the first reply it was given. If this comment adds to it, comment again once the run has replied.";

/** The comment when the held answer could not be started (an enqueue that failed): the reply is answered, never lost silently. */
export const HELD_RESUME_FAILED_REPLY = "This run was waiting for an answer and could not start from the reply it was given. Comment again to answer it.";

const codeOf = (e) => (typeof e?.code === "string" && e.code !== "" ? e.code : typeof e?.error === "string" ? e.error : "error");
const targetNumber = (t) => (typeof t?.number === "number" ? t.number : typeof t?.number === "string" && /^[1-9][0-9]{0,15}$/.test(t.number) ? Number(t.number) : null);

/** Whether a processor result is a run that PARKED: the completed branch's `reason: "awaiting-input"` (processor.mjs). */
export function isParkedOutcome(result) {
	return result !== null && typeof result === "object" && result.outcome === "completed" && result.reason === "awaiting-input";
}

/**
 * `makeAwaitKeeper({ redis, job, host, now, log, pollMs, held })` -> `{ start(), stop() }`: keeps an awaitInput run
 * live on its await target for the whole pickup (registered at start, refreshed every `pollMs`), so a reply in the
 * seconds between the agent's question and the park can be held. Started by the processor only for a job whose
 * `data.awaitInput === true` and whose target a forge reply can reach; stopped by the park's take, else at the settle
 * (index.mjs).
 *
 * STOP LEAVES THE KEYS TO EXPIRE rather than deleting them: the settle's close removes them at a final outcome, and an
 * attempt that will be retried (an InfraRetry with attempts left) keeps taking a held reply for the open key's 30 s,
 * after which the receiver answers as it always did. Never throws; faults are logged once per step, by code.
 */
export function makeAwaitKeeper({ redis, job, host, now = Date.now, log = () => {}, pollMs = AWAIT_KEEPER_POLL_MS, held = heldModule } = {}) {
	const runId = runIdOf(job);
	const targetKey = held.awaitTargetKeyOf(job?.data ?? null);
	const jobId = sanitizeJobId(job?.id);
	let timer = null;
	let running = null;
	let stopped = false;
	const said = new Set();
	const fault = (step, code) => {
		if (said.has(step)) return;
		said.add(step);
		log("held_keeper_fault", { jobId, step, code });
	};
	const refresh = async (step) => {
		try {
			const r = await held.refreshAwaitLive({ redis, runId, targetKey, host, now });
			if (r?.error) fault(step, codeOf(r));
		} catch (e) {
			fault(step, codeOf(e));
		}
	};
	const tick = () => {
		if (running || stopped) return running ?? Promise.resolve();
		running = refresh("refresh").finally(() => {
			running = null;
		});
		return running;
	};
	return {
		targetKey,
		async start() {
			if (timer !== null || stopped || targetKey === null) return;
			// A closed list under this run id belongs to a run that already settled (a console retry keeps the job id).
			const reset = await held.resetClosedHeld({ redis, runId });
			if (reset?.error) fault("reset", codeOf(reset));
			await refresh("register");
			if (stopped) return;
			timer = setInterval(() => void tick(), pollMs);
			timer.unref?.();
		},
		async stop() {
			stopped = true;
			if (timer !== null) clearInterval(timer);
			timer = null;
			try {
				await running;
			} catch {}
		},
	};
}

/**
 * `makeHeldSettle({ redis, queues, comment, log, now, enqueue, held })` -> `settleHeld({ job, runId, result, error,
 * queueName })`, with `settleHeld.take({ job, runId, queueName })`: what an awaitInput run's held replies become.
 *
 * THE TAKE, INSIDE THE PARK (issue #638 review, H1). The processor's parked branch calls `take` after it has set the
 * marker and released the window and before its comment (processor.mjs, the park sequence). `closeHeld` first (one
 * script: no reply can be held after it, and every reply held before it is in its reply); only the FIRST close acts:
 *   - entries older than HELD_LOOKBACK_MS before now are dropped silently (`held_replies_dropped`, `stale`);
 *   - the first recent entry whose fallback names this run's forge, repo, target type and number (it was held under
 *     them; one that does not is skipped with `held_reply_mismatch` and the next is tried) is enqueued as the resumed job
 *     WITH the semantic window (`enqueueForgeJob`), on the queue that ran the run (a host queue stays on its host). The
 *     window is the point: the park released this run's window a moment before, so the taken reply now holds it, and
 *     every later answer (a phrase-free reply the marker routes, a phrase reply) is coalesced against that one job
 *     instead of starting a second resumed run from the same parked transcript. An add the window swallowed against
 *     ANOTHER job (an answer that came in between the release and the take, which is then the run) is not taken;
 *     against THIS run's own job (the release failed) it is not taken either, and is answered as not started;
 *   - every other recent entry gets ONE fixed comment, HELD_EXTRA_REPLY; when nothing could be started at all, one
 *     HELD_RESUME_FAILED_REPLY instead (also when the close itself failed: an answer may have been held and lost).
 * The take's close also raises the target's parked marker. Returns `{ resumed, answered, dropped, taken }`; the
 * processor posts HELD_TAKEN_COMMENT instead of the parked comment when `taken` is set ("here" or "other").
 *
 * THE SETTLE, AT THE FINAL OUTCOME (the inbox settle's three sites and `isFinalOutcome`), is the backstop. After a take
 * the list is closed and it acts on nothing (`first: false`), and when the take's own close failed it only drops
 * (`afterTake`). Otherwise: a parked outcome whose take never ran (an unwired seam) gets the take's logic; ANY other outcome drops every held reply, which is exactly the coalescing a reply
 * into a still-running run always got. That includes an operator cancel acknowledged before the result: the record says
 * the run was cancelled, not parked, so its held answers are dropped (review, L2).
 *
 * Logs, ids and counts only: `held_reply_resumed { jobId, runId, n, queue }`, `held_replies_dropped { runId, n,
 * stale? }`, `held_reply_mismatch { runId }`, `held_reply_not_taken { runId, survivingJobId }`, `held_reply_resume_failed
 * { runId, queue, code }`, `held_settle_failed { jobId, code }`. Never throws; the counts or null.
 */
export function makeHeldSettle({ redis, queues, comment = async () => {}, log = () => {}, now = Date.now, enqueue = enqueueForgeJob, held = heldModule } = {}) {
	const queueFor = (name) => {
		if (typeof name === "string" && name.startsWith(`${QUEUE}@`) && typeof queues?.host === "function") return { queue: queues.host(name), name };
		return { queue: queues?.shared?.(), name: QUEUE };
	};
	const answer = async (job, text) => {
		try {
			await comment({ ...job.data, id: job.id }, text);
		} catch {}
	};
	// The same forge, repo, target type and number, and (review round 2) the same flow and command: the held fallback was
	// held under this run's target, and one that would run different work is no answer to this run's question.
	const sameTarget = (fields, d) => !((fields?.kind !== undefined && fields.kind !== d.kind) || fields?.repo !== d.repo || typeof fields?.target?.type !== "string" || fields.target.type !== d.target?.type || targetNumber(fields.target) === null || targetNumber(fields.target) !== targetNumber(d.target) || fields.flow !== d.flow || fields.command !== d.command);
	const close = async (job, runId, { parked = false } = {}) => {
		const closed = await held.closeHeld({ redis, runId, targetKey: held.awaitTargetKeyOf(job.data), parked });
		if (!closed || closed.error) {
			log("held_settle_failed", { jobId: sanitizeJobId(job.id), code: codeOf(closed) });
			return null;
		}
		return { entries: Array.isArray(closed.entries) ? closed.entries : [], first: closed.first === true };
	};

	// The take's body, on entries a first close returned.
	const start = async ({ job, runId, entries, queueName }) => {
		// `taken`: "here" when this take started the resumed job, "other" when the window showed another job already is
		// the answer (one that got in between the release and the take), null otherwise. Either word means the run has
		// its resumed job, so the processor says so and a late steer message must not start a second one (review round 2).
		const counts = { resumed: 0, answered: 0, dropped: 0, taken: null };
		if (entries.length === 0) return counts;
		const rid = sanitizeJobId(runId);
		const t = typeof now === "function" ? now() : now;
		const recent = entries.filter((e) => Number.isSafeInteger(e?.at) && e.at >= t - HELD_LOOKBACK_MS);
		const stale = entries.length - recent.length;
		if (stale > 0) {
			counts.dropped = stale;
			log("held_replies_dropped", { runId: rid, n: stale, stale });
		}
		if (recent.length === 0) return counts;
		const route = queueFor(queueName ?? job.queueName);
		let takenAt = -1;
		let failed = false;
		let tried = false;
		for (let i = 0; i < recent.length; i++) {
			const fields = recent[i].fallback;
			if (!sameTarget(fields, job.data)) {
				log("held_reply_mismatch", { runId: rid });
				continue;
			}
			tried = true;
			try {
				if (!route.queue) throw Object.assign(new Error("no queue"), { code: "no-queue" });
				// The queue's enqueue timestamp is later than the receiver's trusted receipt. Keep that receipt
				// outside the payload so a held answer does not acquire artificial human waiting time.
				const r = await enqueue(route.queue, job.data.kind, { ...fields, replyReceivedAt: recent[i].at });
				if (r?.deduplicated === true) {
					// Swallowed by the window: another job holds it (an answer between the release and the take, which is
					// then the resumed run), or this run's own (its release failed, so nothing was started).
					log("held_reply_not_taken", { runId: rid, survivingJobId: sanitizeJobId(r.survivingJobId) });
					// The run's own job id, or its run id for a #645 recovery whose original holds the window.
					failed = r.survivingJobId === job.id || r.survivingJobId === runId;
					if (!failed) counts.taken = "other";
				} else {
					takenAt = i;
					counts.resumed = 1;
					counts.taken = "here";
					log("held_reply_resumed", { jobId: sanitizeJobId(r?.jobId), runId: rid, n: recent.length, queue: route.name });
				}
			} catch (e) {
				log("held_reply_resume_failed", { runId: rid, queue: route.name, code: codeOf(e) });
				failed = true;
			}
			break;
		}
		const rest = recent.length - (takenAt >= 0 ? 1 : 0);
		if (rest > 0) {
			// "Took the first reply" is true when one was taken here or by the job that holds the window; otherwise the
			// replies were not started at all and say so.
			await answer(job, takenAt >= 0 || (tried && !failed) ? HELD_EXTRA_REPLY : HELD_RESUME_FAILED_REPLY);
			counts.answered = rest;
		}
		return counts;
	};

	// `afterTake`: the park's take ran for this outcome (the processor says so). A take whose close FAILED already told the
	// person nothing was started (HELD_RESUME_FAILED_REPLY), so a backstop close that succeeds afterwards must not start a
	// job anyway and contradict it (review round 2): after a take, the backstop only ever drops.
	async function settleHeld({ job, runId = runIdOf(job), result = null, error = null, queueName = null, afterTake = false } = {}) {
		try {
			if (job?.data?.awaitInput !== true) return null;
			if (!isFinalOutcome({ job, result, error })) return null;
			if (runId === null || runId === undefined || runId === "") return null;
			const closed = await close(job, runId);
			if (closed === null) return null;
			if (!closed.first || closed.entries.length === 0) return { resumed: 0, answered: 0, dropped: 0, taken: null };
			if (isParkedOutcome(result) && afterTake !== true) return await start({ job, runId, entries: closed.entries, queueName });
			log("held_replies_dropped", { runId: sanitizeJobId(runId), n: closed.entries.length });
			return { resumed: 0, answered: 0, dropped: closed.entries.length, taken: null };
		} catch (e) {
			log("held_settle_failed", { jobId: sanitizeJobId(job?.id ?? ""), code: codeOf(e) });
			return null;
		}
	}

	settleHeld.take = async function takeHeld({ job, runId = runIdOf(job), queueName = null } = {}) {
		try {
			if (job?.data?.awaitInput !== true) return null;
			if (runId === null || runId === undefined || runId === "") return null;
			// `parked`: the close also raises the target's parked marker (held-replies.mjs), so a reply delivered after the run
			// left its target is routed as a parked reply rather than dropped for the label it raced.
			const closed = await close(job, runId, { parked: true });
			if (closed === null) {
				// L1: the close failed, so a reply may have been held and will never be seen: say so once.
				await answer(job, HELD_RESUME_FAILED_REPLY);
				return null;
			}
			if (!closed.first) return { resumed: 0, answered: 0, dropped: 0, taken: null };
			return await start({ job, runId, entries: closed.entries, queueName });
		} catch (e) {
			log("held_settle_failed", { jobId: sanitizeJobId(job?.id ?? ""), code: codeOf(e) });
			return null;
		}
	};
	return settleHeld;
}
