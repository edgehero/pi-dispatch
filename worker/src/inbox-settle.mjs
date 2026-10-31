import { InfraRetry, RECOVERY_ENQUEUED, RECOVERY_SUPERSEDED } from "./processor.mjs";
import { enqueueLateForgeJob, QUEUE, releaseSemanticWindow } from "./queue.mjs";
import { runIdOf } from "./recovery-queue.mjs";
import { sanitizeJobId } from "./run-history.mjs";
import { steerTargetOf } from "./inbox-relay.mjs";
import * as inboxModule from "./steer-inbox.mjs";

/**
 * The run's inbox at its FINAL outcome (issue #646, DES-STEER-LATE-MESSAGE-RESUME-OR-REPLY): close it, so nothing more
 * can be pushed, and count what became of every message for the record's `steered`.
 *
 * WHEN. At a final outcome only, immediately before the record write (index.mjs; a bolt test holds every record site to
 * it). A FINAL outcome is every RETURNED result except a #645 handoff (`recovery-enqueued`: the run goes on in a
 * recovery job that keeps the run id and must find its inbox open; `recovery-superseded`: the run already settled
 * elsewhere), and a THROWN error that ends the job: an UnrecoverableError, anything that is not an InfraRetry, or an
 * InfraRetry on the job's last attempt. An InfraRetry with attempts left is NOT final: the next attempt re-registers
 * the run and writes the waiting messages again, so closing here would turn each of them into `late` for a run that
 * is still going to happen.
 *
 * WHAT. `closeInbox` (one Lua script: sets closed, drops the open key and the target member, turns every `queued` or
 * `written` message into `late`, returns every entry and state). After it every push is refused, and everything pushed
 * before it is in its reply, so no message is accepted and then silently never answered. Operator-source late messages
 * are reported only (the console and the CLI show `late`). Forge-source late messages go to `onLateForge(entries,
 * context)`, which a wired worker builds with `makeLateForge` below (a resumed job, or one fixed reply); unwired it is a
 * logging no-op. It is awaited, so what it does happens before the record is written, and it is called at the FIRST
 * successful close only (with no entries too, because the wired `makeLateForge` also releases the run's semantic
 * window; the unwired default releases nothing). A second settle of the same outcome (the processor's, then BullMQ's
 * failed listener for the same thrown failure) gets the same late entries back with `first: false` and must not
 * answer them twice (review round 1, F2): it only counts.
 *
 * Never throws: a Valkey fault is logged by code and answers null, and the record is then written without `steered`
 * (the run's outcome must never wait on, or be rewritten by, its inbox).
 */

/** Whether this outcome ends the run: see the header. `result` for a returned outcome, `error` for a thrown one. */
export function isFinalOutcome({ job, result = null, error = null } = {}) {
	if (result !== null && result !== undefined) return result.reason !== RECOVERY_ENQUEUED && result.reason !== RECOVERY_SUPERSEDED;
	if (error === null || error === undefined) return false;
	// Anything but an InfraRetry ends the job: index.mjs rethrows it as an UnrecoverableError (or it already is one), and
	// BullMQ never retries that. Decided on the class alone, so this module needs no queue library.
	if (!(error instanceof InfraRetry)) return true;
	const made = Number.isSafeInteger(job?.attemptsMade) && job.attemptsMade >= 0 ? job.attemptsMade : 0;
	const attempts = Number.isSafeInteger(job?.opts?.attempts) && job.opts.attempts >= 1 ? job.opts.attempts : 1;
	// `attemptsMade` counts the attempts FINISHED before this one while the job is processing (run-history.mjs
	// `buildRecord` reads it the same way), so this attempt is the last when one more reaches the limit.
	return made + 1 >= attempts;
}

const defaultLateForge = (log) => (entries) => {
	if (entries.length > 0) log("steer_late_forge_unanswered", { count: entries.length });
};

/** The one reply a late forge message gets (branch B): no mention, no quote of the message, fixed words. */
export const STEER_LATE_REPLY = "This run had already finished when your message arrived, so it did not see it. Comment again with the trigger phrase to start a new run.";

const codeOf = (e) => (typeof e?.code === "string" && e.code !== "" ? e.code : typeof e?.error === "string" ? e.error : "error");
const hopOf = (entry) => (Number.isSafeInteger(entry?.hop) && entry.hop >= 0 ? entry.hop : 0);
const targetNumber = (t) => (typeof t?.number === "number" ? t.number : typeof t?.number === "string" && /^[1-9][0-9]{0,15}$/.test(t.number) ? Number(t.number) : null);

/**
 * `makeLateForge({ redis, queues, comment, log, now })` -> `onLateForge(entries, { job, runId, result, error, queueName })`,
 * what a late forge message becomes at a steer-armed run's final outcome (DES-STEER-LATE-MESSAGE-RESUME-OR-REPLY).
 *
 * FIRST, whatever the entries: the run's semantic window is released (`releaseSemanticWindow`), because a comment after
 * the run is no longer a steer (the run is gone from its target) and must start a job of its own, which the window the
 * run still holds would otherwise swallow for the rest of its ten minutes.
 *
 * THEN, the forge-source late entries in inbox order, split by hop. A message with `hop >= 1` was carried once already,
 * so it is only ever answered: that is what ends a chain of runs. Of the rest (hop 0), the FIRST decides:
 *   (A) the outcome is not `operator-cancel` or `agent-cancel` (the caller stopped this work; starting it again is
 *       the one thing the cancel promised not to do), its stored fallback job (the job the receiver would have enqueued,
 *       `readFallbacks`) has `resume === true`, and that job names this run's forge, repo, target type and number: the job is enqueued on the
 *       queue that ran this run (`job.queueName`: a host queue stays on its host, anything else goes to the shared one;
 *       the host-lost sweep passes `queueName` to send it to the shared queue, since that host is gone), under its own
 *       delivery-GUID id, with NO deduplication option (`enqueueLateForgeJob`). The other hop-0 messages are pre-seeded
 *       into that job's inbox with `hop: 1` (`preseedInbox`), so its relay writes them as steers at its loop start. Only
 *       when that job is steer-armed itself: an unarmed job has no relay and no settle, so a carried message would wait
 *       unread and never be answered; those are answered instead.
 *   (B) otherwise (no fallback, no resume, a cancel, a fallback for another target, a failed read or enqueue): answered.
 * Everything answered gets ONE fixed comment on the run's target (`STEER_LATE_REPLY`), however many messages it covers.
 * At most one extra job per run end. A failure along branch A falls back to the answer, logged by code: a message is
 * either carried or answered, never neither. Operator-source late messages never reach here (reported only).
 *
 * Why pre-seed the inbox rather than carry the messages in the new job's data: the relay already writes every `queued`
 * message of its run's inbox at its start, through the same framing, acks and settle as any steer, and a retry, a
 * recovery and the console all see them there. In job data they would need a second delivery path into the relay, and
 * would be durable job data holding attacker-chosen text the record and the console must never show.
 *
 * Logs `steer_late_resumed { jobId, runId, n }` (n: the messages the new job carries, its own first one included) and
 * `steer_late_replied { runId, n }`; ids and counts, never text. Never throws.
 */
export function makeLateForge({ redis, queues, comment = async () => {}, log = () => {}, now = Date.now, inbox = inboxModule, enqueue = enqueueLateForgeJob, release = releaseSemanticWindow, canPublish = async () => true } = {}) {
	const queueFor = (name) => {
		if (typeof name === "string" && name.startsWith(`${QUEUE}@`) && typeof queues?.host === "function") return { queue: queues.host(name), name };
		return { queue: queues?.shared?.(), name: QUEUE };
	};

	// Branch A for `first`: the new job's id, or null (the caller answers instead). Never throws.
	const resume = async ({ job, runId, first, queueName }) => {
		const read = await inbox.readFallbacks({ redis, runId });
		if (!read || read.error) {
			log("steer_late_fallback_unread", { runId: sanitizeJobId(runId), code: codeOf(read) });
			return null;
		}
		const fields = read.jobs?.[first.id];
		if (!fields || fields.resume !== true) return null;
		if ((fields.kind !== undefined && fields.kind !== job.data.kind) || fields.repo !== job.data.repo || typeof fields.target?.type !== "string" || fields.target.type !== job.data.target?.type || targetNumber(fields.target) === null || targetNumber(fields.target) !== targetNumber(job.data.target)) {
			log("steer_late_fallback_mismatch", { runId: sanitizeJobId(runId) });
			return null;
		}
		const route = queueFor(queueName ?? job.queueName);
		try {
			if (!route.queue) throw Object.assign(new Error("no queue"), { code: "no-queue" });
			const { jobId } = await enqueue(route.queue, job.data.kind, fields);
			return { jobId, fields, queue: route.name };
		} catch (e) {
			log("steer_late_resume_failed", { runId: sanitizeJobId(runId), queue: route.name, code: codeOf(e) });
			return null;
		}
	};

	return async function onLateForge(entries, { job, runId = runIdOf(job), result = null, error = null, queueName = null, heldResumed = false } = {}) {
		try {
			if (job?.data?.steer !== true) return;
			await release(job, log);
			const late = Array.isArray(entries) ? entries.filter((e) => e?.source === "forge") : [];
			if (late.length === 0) return;
			// Closing the old inbox must not carry its private fallback to a newly configured forge.
			// The trusted worker checks the original draft's source again, including terminal retries.
			if (await canPublish(job.data) !== true) { log("steer_late_source_unavailable", { runId: sanitizeJobId(runId), count: late.length }); return; }
			const fresh = late.filter((e) => hopOf(e) === 0);
			const answer = late.filter((e) => hopOf(e) >= 1);
			const cancelled = ["operator-cancel", "agent-cancel"].includes(result?.reason) || ["operator-cancel", "agent-cancel"].includes(error?.reason);
			// Issue #638: a held reply already became this parked run's resumed job, so a late message is answered, never
			// a second resumed job for the same run.
			const started = fresh.length > 0 && !cancelled && heldResumed !== true ? await resume({ job, runId, first: fresh[0], queueName }) : null;
			if (started === null) {
				answer.push(...fresh);
			} else {
				const carry = fresh.slice(1);
				let carried = 0;
				if (carry.length > 0 && started.fields.steer !== true) {
					answer.push(...carry);
				} else if (carry.length > 0) {
					const seeded = await inbox.preseedInbox({ redis, runId: started.jobId, entries: carry.map((e) => ({ ...e, hop: 1 })), now });
					if (!seeded || seeded.error) {
						log("steer_late_preseed_failed", { jobId: sanitizeJobId(started.jobId), runId: sanitizeJobId(runId), code: codeOf(seeded) });
						answer.push(...carry);
					} else {
						carried = carry.length;
					}
				}
				log("steer_late_resumed", { jobId: sanitizeJobId(started.jobId), runId: sanitizeJobId(runId), n: 1 + carried, queue: started.queue });
			}
			if (answer.length > 0) {
				try {
					await comment({ ...job.data, id: job.id }, STEER_LATE_REPLY);
				} catch {}
				log("steer_late_replied", { runId: sanitizeJobId(runId), n: answer.length });
			}
		} catch (e) {
			log("steer_late_failed", { runId: sanitizeJobId(runId ?? ""), code: codeOf(e) });
		}
	};
}

/**
 * `settleInbox({ redis, job, runId, result, error, log, onLateForge, inbox })` -> `{ delivered, late, withdrawn }` or
 * null (not a steer job, not final, or the close failed). `job` is the BullMQ job (its `data.steer`, its attempts).
 */
export async function settleInbox({ redis, job, runId = runIdOf(job), result = null, error = null, log = () => {}, onLateForge = null, inbox = inboxModule, lateContext = {} } = {}) {
	try {
		if (job?.data?.steer !== true) return null;
		if (!isFinalOutcome({ job, result, error })) return null;
		if (runId === null || runId === undefined || runId === "") return null;
		const { targetKey } = steerTargetOf(job.data);
		const closed = await inbox.closeInbox({ redis, runId, targetKey });
		if (!closed || closed.error) {
			log("steer_settle_failed", { jobId: sanitizeJobId(job.id), code: typeof closed?.error === "string" ? closed.error : "error", ...(closed?.reason ? { reason: closed.reason } : {}) });
			return null;
		}
		const counts = { delivered: 0, late: 0, withdrawn: 0 };
		for (const st of Object.values(closed.state ?? {})) if (Object.hasOwn(counts, st)) counts[st] += 1;
		const lateForge = (closed.entries ?? []).filter((e) => e?.source === "forge" && closed.state?.[e.id] === "late");
		if (closed.first === true) {
			try {
				await (typeof onLateForge === "function" ? onLateForge : defaultLateForge(log))(lateForge, { ...lateContext, job, runId, result, error });
			} catch {}
		}
		if (counts.late > 0) log("steer_settled_late", { jobId: sanitizeJobId(job.id), ...counts });
		return counts;
	} catch (e) {
		log("steer_settle_failed", { jobId: sanitizeJobId(job?.id ?? ""), code: typeof e?.code === "string" ? e.code : "error" });
		return null;
	}
}
