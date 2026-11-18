/**
 * A request the semantic window dropped against a job that has already ENDED (issue #932, REQ-DEDUP-BY-DELIVERY-GUID).
 *
 * The window joins every request for one flow on one item for 10 minutes from the first (`SEMANTIC_WINDOW_MS`,
 * queue.mjs), and a finished job keeps holding it (#899 releases only a policy refusal). So "label off, label on" a few
 * minutes after a quick run ended starts nothing, and until this issue it said so only in the receiver's log: a person,
 * or a dispatcher reading the forge, could not tell a dropped request from one still queued.
 *
 * The producer runs in the RECEIVER's process, which holds no forge write credential and must not gain one (its whole
 * edge is reads and a queue). So the producer adds a NOTICE job instead, and the worker, which already writes every
 * refusal comment, answers it at pickup as a free policy refusal: one fixed comment naming the ended job and when the
 * window closes, and a run record, so the console's runs list shows the dropped request too.
 *
 * Only an ENDED owner earns a notice. A request joined to a job still queued, held or running is being served by that
 * job, and a comment for each of those is the label spam the window exists to absorb.
 *
 * The notice's data is minimal on purpose: where to comment and what to call it, never a trigger's run fields, models,
 * secrets or instructions, so nothing in it could start a container even if it were misread. `duplicateOf` is a row
 * of `JOB_DATA_FIELD_VERSIONS`, so a worker older than this release DEFERS a notice (`newer-release`) instead of reading
 * it as a forge job and running its flow.
 *
 * REJECTED: a comment from the receiver (it holds no write credential, by design); a reaction (a second identical
 * reaction is a no-op, so it cannot tell two requests apart, and Azure work items have none); a comment on every swallow
 * (noise against a live job); releasing the window when its job finishes (it also coalesces a Forgejo replay, which
 * carries a new delivery id, and an Azure resend after a manual retry).
 */
// A leaf: the receiver loads it through queue.mjs, so it imports nothing.

/** The notice's own job id: the delivery's replica-free id and this suffix, so a replay of the delivery posts once. */
export const DUPLICATE_NOTICE_SUFFIX = "-dup";

/** The reason a notice's run record carries. */
export const DUPLICATE_REQUEST_REASON = "duplicate-request";

// A surviving job id is worker-minted (a delivery id behind a forge prefix, or a console or poller id), never payload,
// and this charset leaves it no markup, mention or link in a comment: it is named as it is, the id the console finds.
const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * The notice job's data for `data` (the dropped request's own job data), the job it was joined to, and the instant its
 * window closes (ms since the epoch, or null when the key has no expiry). Throws on a surviving id outside the job id
 * charset, which no producer writes.
 */
export function duplicateNoticeData(data, { survivingJobId, windowEndsAt }) {
	if (typeof survivingJobId !== "string" || !JOB_ID_RE.test(survivingJobId)) throw new TypeError("duplicate notice: invalid surviving job id");
	const trigger = data?.trigger ?? {};
	return {
		kind: data.kind,
		repo: data.repo,
		...(data.projectId !== undefined && { projectId: data.projectId }),
		...(data.azure !== undefined && { azure: data.azure }),
		// Where to comment, and nothing the item said: no title and no body.
		target: { type: data.target?.type, number: data.target?.number },
		...(data.command !== undefined ? { command: data.command } : { flow: data.flow }),
		trigger: {
			...(trigger.event !== undefined && { event: trigger.event }),
			...(trigger.action !== undefined && { action: trigger.action }),
			deliveryId: trigger.deliveryId,
			...(trigger.matched !== undefined && { matched: trigger.matched }),
		},
		duplicateOf: survivingJobId,
		windowEndsAt: Number.isSafeInteger(windowEndsAt) ? windowEndsAt : null,
	};
}

/** Whether `data` is a notice: any job carrying `duplicateOf` is one, and is never run. */
export const isDuplicateNotice = (data) => data !== null && typeof data === "object" && data.duplicateOf !== undefined;

/** The notice's surviving job id when it is one a producer writes, else null: the one form a comment or a log names. */
export const duplicateOfId = (data) => typeof data?.duplicateOf === "string" && JOB_ID_RE.test(data.duplicateOf) ? data.duplicateOf : null;

const pad = (n) => String(n).padStart(2, "0");

/**
 * The comment a notice posts, or null when its data is not one a producer writes (then the record alone says it). Fixed
 * words, the surviving job's id and a UTC time; no flow, label or text from the item.
 */
export function duplicateRequestComment(data) {
	const id = duplicateOfId(data);
	if (id === null) return null;
	const ends = Number.isSafeInteger(data.windowEndsAt) ? new Date(data.windowEndsAt) : null;
	const when = ends !== null && !Number.isNaN(ends.getTime()) ? `${pad(ends.getUTCHours())}:${pad(ends.getUTCMinutes())} UTC` : null;
	return `pi-dispatch did not start a job for this request. Job \`${id}\` took the same request on this item less than 10 minutes ago and has already ended, and requests for one flow on one item are joined for 10 minutes from the first. ${when !== null ? `Ask again after ${when}` : "Ask again later"}, or re-run job \`${id}\` from the console.`;
}
