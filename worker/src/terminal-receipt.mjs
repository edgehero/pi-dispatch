import { forgeDeliveryJobId } from "./job-id.mjs";
import { textMayMatchPhrase } from "./artifacts-comment.mjs";
import { recordReasonOf } from "./record-reason.mjs";
import { REASONS } from "./reason-catalog.mjs";

/**
 * The binding both receipts share (`INT-FORGE-TERMINAL-RECEIPT`, `INT-FORGE-ENDED-RECEIPT`): an ORIGINAL GitHub polling
 * label delivery whose queue job is exactly the one that delivery made, after the queue's terminal transition. Returns
 * `{ phrase }` (the source trigger's phrase, for the collision guard) or null. Recoveries and replicas need a separate
 * whole-run proof and are deliberately excluded; answer drafts never post.
 */
function labelDelivery(job) {
	const data = job?.data;
	const trigger = data?.trigger;
	if (!Number.isSafeInteger(job?.finishedOn) || job.finishedOn <= 0) return null;
	if (data?.kind !== "github" || data.answerDraft || data.purpose === "answer-draft" || data.recoveryOf !== undefined || data.recovery !== undefined || data.replica !== undefined || data.replicas !== undefined) return null;
	if (trigger?.action !== "labeled") return null;
	const issue = trigger.event === "issues" && trigger.matched?.type === "label" && data.target?.type === "issue";
	const pr = trigger.event === "pull_request" && trigger.matched?.type === "pull_request" && trigger.matched.action === "labeled" && data.target?.type === "pull_request";
	if ((!issue && !pr) || !Number.isSafeInteger(data.target?.number) || data.target.number <= 0) return null;
	const match = typeof trigger.deliveryId === "string" && /^poll-e([1-9][0-9]{0,15})$/.exec(trigger.deliveryId);
	if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
	if (job.id !== forgeDeliveryJobId(data.kind, trigger.deliveryId)) return null;
	return { phrase: trigger.matched?.phrase };
}

/**
 * Scheduling evidence, never a judgment of the work. Call ONLY from BullMQ's completed event: writing a run record
 * precedes the queue transition, which can still fail. Failed jobs can be retried under the same id, so they cannot
 * carry this receipt. Recoveries and replicas need a separate whole-run proof and are deliberately excluded.
 */
export function terminalReceipt({ job, result }) {
	if (result?.outcome !== "completed" || result.exitCode !== 0 || result.reason != null || result.aborted === true || result.detached === true || result.lingering === true) return null;
	const bound = labelDelivery(job);
	if (bound === null) return null;
	const text = `<!-- pi-dispatch-terminal:v1 job=${job.id} -->\npi-dispatch finished this job. This receipt records scheduling completion only; it does not verify the work.`;
	return textMayMatchPhrase(bound.phrase, text) ? null : text;
}

/** The fixed sentence under an ended receipt's marker: how the job ended is the marker's, why is the comment before it. */
export const ENDED_RECEIPT_SENTENCE = "pi-dispatch ended this job without completing it. The label that started it stays on this item: to ask again, remove the label and add it again. This receipt records how the job ended only; it does not explain or verify anything.";

/**
 * Issue #971: the receipt for a label job that ended WITHOUT completing, so a consumer that asked for the job can bind
 * its end to its request without parsing English. `refused` is a returned policy outcome that reserved nothing (a
 * refusal before spend), `stopped` one that did (a paid stop: `cost-cap`, `max-minutes`, a cancel), `failed` the queue's
 * final failure (`error`, from the failed listener with `finishedOn` set). The class names the reservation exactly as
 * the record's `budgetReserved` does, so a refusal whose refund failed reads `stopped`. `reason=` is the record's token,
 * and only a token the reason catalog explains (`docs/reasons.md`), else it is left out: a consumer looks a written
 * reason up, and never meets one no page names.
 *
 * Call ONLY after the queue's terminal transition: from the completed event with the returned `result`, or from the
 * failed event's terminal branch with the `error`. A failed job an operator retries runs again under the same id and
 * may end with a later receipt; the newest receipt for a job id is its end. Everything else is null: a completion (the
 * v1 receipt's), a park, a returned failure (`recovery-enqueued`: the run goes on), a result whose reservation is
 * unknown (a lost-lock replay of a newer worker's record), and every job `labelDelivery` does not bind.
 */
export function endedReceipt({ job, result = null, error = null } = {}) {
	let end;
	let reason;
	if (error !== null && error !== undefined) {
		end = "failed";
		reason = recordReasonOf({ error });
	} else {
		if (result === null || typeof result !== "object" || result.outcome !== "policy") return null;
		if (result.budgetReserved === false) end = "refused";
		else if (result.budgetReserved === true) end = "stopped";
		else return null;
		reason = recordReasonOf({ result });
	}
	const bound = labelDelivery(job);
	if (bound === null) return null;
	const named = typeof reason === "string" && Object.hasOwn(REASONS, reason) ? ` reason=${reason}` : "";
	const text = `<!-- pi-dispatch-ended:v1 job=${job.id} end=${end}${named} -->\n${ENDED_RECEIPT_SENTENCE}`;
	return textMayMatchPhrase(bound.phrase, text) ? null : text;
}
