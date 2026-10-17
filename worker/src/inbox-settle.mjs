import { InfraRetry, RECOVERY_ENQUEUED, RECOVERY_SUPERSEDED } from "./processor.mjs";
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
 * are reported only (the console and the CLI show `late`). Forge-source late messages are PR 2's (a resumed job, or one
 * fixed reply): `onLateForge(entries)` is that seam, a logging no-op here.
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

/**
 * `settleInbox({ redis, job, runId, result, error, log, onLateForge, inbox })` -> `{ delivered, late, withdrawn }` or
 * null (not a steer job, not final, or the close failed). `job` is the BullMQ job (its `data.steer`, its attempts).
 */
export async function settleInbox({ redis, job, runId = runIdOf(job), result = null, error = null, log = () => {}, onLateForge = null, inbox = inboxModule } = {}) {
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
		try {
			(typeof onLateForge === "function" ? onLateForge : defaultLateForge(log))(lateForge);
		} catch {}
		if (counts.late > 0) log("steer_settled_late", { jobId: sanitizeJobId(job.id), ...counts });
		return counts;
	} catch (e) {
		log("steer_settle_failed", { jobId: sanitizeJobId(job?.id ?? ""), code: typeof e?.code === "string" ? e.code : "error" });
		return null;
	}
}
