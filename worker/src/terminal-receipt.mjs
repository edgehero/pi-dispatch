import { forgeDeliveryJobId } from "./job-id.mjs";
import { textMayMatchPhrase } from "./artifacts-comment.mjs";

/**
 * Scheduling evidence, never a judgment of the work. Call ONLY from BullMQ's completed event: writing a run record
 * precedes the queue transition, which can still fail. Failed jobs can be retried under the same id, so they cannot
 * carry this receipt. Recoveries and replicas need a separate whole-run proof and are deliberately excluded.
 */
export function terminalReceipt({ job, result }) {
	const data = job?.data;
	const trigger = data?.trigger;
	if (result?.outcome !== "completed" || result.exitCode !== 0 || result.reason != null || result.aborted === true || result.detached === true || result.lingering === true) return null;
	if (!Number.isSafeInteger(job?.finishedOn) || job.finishedOn <= 0) return null;
	if (data?.kind !== "github" || data.answerDraft || data.purpose === "answer-draft" || data.recoveryOf !== undefined || data.recovery !== undefined || data.replica !== undefined || data.replicas !== undefined) return null;
	if (trigger?.action !== "labeled") return null;
	const issue = trigger.event === "issues" && trigger.matched?.type === "label" && data.target?.type === "issue";
	const pr = trigger.event === "pull_request" && trigger.matched?.type === "pull_request" && trigger.matched.action === "labeled" && data.target?.type === "pull_request";
	if ((!issue && !pr) || !Number.isSafeInteger(data.target?.number) || data.target.number <= 0) return null;
	const match = typeof trigger.deliveryId === "string" && /^poll-e([1-9][0-9]{0,15})$/.exec(trigger.deliveryId);
	if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
	if (job.id !== forgeDeliveryJobId(data.kind, trigger.deliveryId)) return null;
	const text = `<!-- pi-dispatch-terminal:v1 job=${job.id} -->\npi-dispatch finished this job. This receipt records scheduling completion only; it does not verify the work.`;
	return textMayMatchPhrase(trigger.matched?.phrase, text) ? null : text;
}
