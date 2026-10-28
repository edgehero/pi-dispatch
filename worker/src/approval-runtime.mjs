/** Host orchestration of durable approvals. No queue field can manufacture a system expiry decision: it must match
 * the private store and the one deterministic expiry job. All refusals happen before the caller's spend gates. */
import { approvalActor, approvalAudit, approvalReply, approvalRequestId, validateApprovalConfig } from "./approval-policy.mjs";

export const APPROVAL_EXPIRED_COMMENT = "The approval request expired and was declined. The run will continue with that decision.";
export const APPROVAL_REVOKED_COMMENT = "The approval request was withdrawn because its trigger policy changed. No continuation was started.";
export const approvalExpiryJobId = (requestId) => `approval-expiry-${requestId}`;
const failed = (out) => out?.error ? { error: out.error } : { refused: typeof out?.refused === "string" && out.refused.startsWith("approval-") ? out.refused : "approval-state-conflict" };

/** checkPolicy(job) returns {ok:true,digest}; enqueueExpiry(request) must use approvalExpiryJobId(request.requestId).
 * The comment hook receives (request, fixedText); it owns forge delivery/idempotence, never a model summary. */
export function makeApprovalRuntime({ store, checkPolicy, now = () => Date.now(), host, hostQueue = null, requireSessionDigest = false, enqueueExpiry, comment = async () => {} } = {}) {
	if (!store || typeof checkPolicy !== "function" || typeof host !== "string" || !host) throw new TypeError("approval runtime needs store, checkPolicy and host");
	const policy = async (job, request = null) => {
		let out;
		try { out = await checkPolicy(job); } catch { return { refused: "approval-policy-unavailable" }; }
		if (!out?.ok) return failed(out);
		if (request && (out.digest !== request.configDigest || !job?.gates?.includes(request.action))) return { refused: "approval-policy-changed" };
		return out;
	};
	return {
		finish: ({ requestId, jobId } = {}) => store.finish({ requestId, jobId }),
		async before(job) {
			let configInvalid = false;
			if (job.gates !== undefined || job.gateTimeout !== undefined || job.gateBudgetRaiseUsd !== undefined) {
				try { validateApprovalConfig(job); } catch { configInvalid = true; }
			}
			const found = await store.find(job);
			if (!found.ok) return failed(found);
			let request = found.request;
			if (!request) {
				if (job.approvalRequestId) return { refused: "approval-request-stale" };
				if (configInvalid) return { refused: "approval-config-invalid" };
				return job.gates !== undefined ? policy(job) : { ok: true };
			}
			if (request.host !== host) return { refused: "approval-host-mismatch" };
			if (requireSessionDigest && !/^[a-f0-9]{64}$/.test(request.sessionDigest ?? "")) return { refused: "approval-session-unavailable" };
			if (job.approvalRequestId && job.approvalRequestId !== request.requestId) return { refused: "approval-request-stale" };
			if (typeof job.id !== "string" || !job.id) return { refused: "approval-job-id-missing" };
			if (job.approvalRequestId !== request.requestId) return { refused: job.trigger?.comment ? "approval-request-unbound" : "approval-pending" };
			// The reply and the initiating trigger are independent declarations. Keeping the comment rule must
			// not preserve an approval whose original label/PR rule was revoked, including requests without a deadline.
			const initiating = await policy(request.resumeJob, request);
			const checked = initiating.ok ? await policy(job, request) : initiating;
			if (!checked.ok) {
				if (checked.refused !== "approval-policy-changed") return checked;
				const cancelled = await store.cancel({ requestId: request.requestId, jobId: job.id });
				return cancelled.ok ? { refused: "approval-policy-changed", request: cancelled.request, audit: approvalAudit(cancelled.request) } : failed(cancelled);
			}
			if (configInvalid) return { refused: "approval-config-invalid" };
			const expiryJob = job.id === approvalExpiryJobId(request.requestId) && job.approvalRequestId === request.requestId && job.trigger?.deliveryId === `expiry-${request.requestId}`;
			if (expiryJob) {
				if (request.decision?.actor?.kind !== "system" || request.decision?.actor?.id !== "expiry" || request.decision?.decision !== "declined") return { refused: "approval-expiry-invalid" };
			} else {
				if (request.decision?.actor?.kind === "system") return { refused: "approval-expired" };
				if (!job.trigger?.comment || typeof job.trigger.comment.body !== "string") return { refused: "approval-pending" };
				if (job.approvalRequestId !== request.requestId) return { refused: "approval-request-unbound" };
				const actor = approvalActor(job);
				if (!actor) return { refused: "approval-author-missing" };
				const decided = await store.decide({ requestId: request.requestId, decisionId: job.id, ...approvalReply(job.trigger.comment.body, { phrase: job.trigger?.matched?.phrase }), actor });
				if (!decided.ok) return failed(decided);
				request = decided.request;
				// A human racing the exact deadline may cause the store to persist an expiry decline. Only its own
				// synthetic job may consume it; otherwise both the human job and the sweep could start containers.
				if (request.decision.actor.kind === "system") return { refused: "approval-expired" };
			}
			const claimed = await store.claim({ requestId: request.requestId, jobId: job.id });
			if (!claimed.ok) return failed(claimed);
			request = claimed.request;
			return {
				ok: true,
				decision: { requestId: request.requestId, action: request.action, toolCallId: request.toolCallId, decision: request.decision.decision, text: request.decision.text },
				request,
				audit: approvalAudit(request),
				...(request.action === "budget-raise" && request.decision.decision === "approved" ? { budgetCapUsd: job.gateBudgetRaiseUsd } : {}),
			};
		},
		async afterPark({ job, session, metadata, rawJob = job } = {}) {
			if (!metadata || !job?.gates?.includes(metadata.action) || typeof metadata.toolCallId !== "string" || !session?.key || typeof job.id !== "string") return { refused: "approval-park-invalid" };
			if (requireSessionDigest && !/^[a-f0-9]{64}$/.test(session.digest ?? "")) return { refused: "approval-session-unavailable" };
			const checked = await policy(job);
			if (!checked.ok) return checked;
			const requestId = approvalRequestId(job.id, metadata.toolCallId);
			const prior = await store.read(requestId);
			if (!prior.ok) return failed(prior);
			if (prior.request) {
				if (prior.request.runId !== job.id || prior.request.action !== metadata.action || prior.request.configDigest !== checked.digest || prior.request.sessionKey !== session.key || prior.request.host !== host || prior.request.sessionDigest !== session.digest) return { refused: "approval-request-conflict" };
				return { ...prior, audit: approvalAudit(prior.request) };
			}
			const createdAt = now();
			const resumeJob = { ...rawJob };
			for (const field of ["id", "maxCostMicros", "approvalDecision", "approvalRequestId"]) delete resumeJob[field];
			const out = await store.publish({
				requestId, runId: job.id, kind: job.kind, repo: job.repo,
				target: job.target, action: metadata.action, toolCallId: metadata.toolCallId,
				configDigest: checked.digest, sessionKey: session.key, host, ...(hostQueue !== null ? { hostQueue } : {}), createdAt,
				...(session.digest !== undefined ? { sessionDigest: session.digest } : {}),
				...(job.gateTimeout !== undefined ? { expiresAt: createdAt + job.gateTimeout * 86400_000 } : {}),
				resumeJob,
			});
			return out.ok ? { ...out, audit: approvalAudit(out.request) } : failed(out);
		},
		async sweep(limit = 100) {
			const due = await store.due(limit, host);
			if (!due.ok) return failed(due);
			let enqueued = 0;
			const failures = [];
			for (const id of due.requestIds) {
				const read = await store.read(id);
				if (!read.ok) { failures.push({ requestId: id, ...failed(read) }); continue; }
				if (!read.request || read.request.host !== host) continue;
				const checked = await policy(read.request.resumeJob, read.request);
				if (!checked.ok) {
					if (checked.refused === "approval-policy-changed") {
						const cancelled = await store.cancel({ requestId: id, jobId: approvalExpiryJobId(id) });
						if (!cancelled.ok) failures.push({ requestId: id, ...failed(cancelled) });
						else {
							try { await comment(cancelled.request, APPROVAL_REVOKED_COMMENT); } catch { failures.push({ requestId: id, error: "approval-expiry-comment-failed" }); }
						}
					} else failures.push({ requestId: id, ...checked });
					continue;
				}
				const expired = await store.expire(id);
				if (!expired.ok) {
					if (expired.refused !== "already-decided" && expired.refused !== "request-stale") failures.push({ requestId: id, ...failed(expired) });
					continue;
				}
				try {
					if (typeof enqueueExpiry !== "function") { failures.push({ requestId: id, refused: "approval-expiry-queue-unavailable" }); continue; }
					const queued = await enqueueExpiry(expired.request);
					if (queued?.error || queued?.refused || queued?.ok === false) { failures.push({ requestId: id, ...failed(queued) }); continue; }
					enqueued++;
					await comment(expired.request, APPROVAL_EXPIRED_COMMENT);
				} catch { failures.push({ requestId: id, error: "approval-expiry-enqueue-failed" }); }
			}
			return { ok: failures.length === 0, enqueued, failures };
		},
	};
}
