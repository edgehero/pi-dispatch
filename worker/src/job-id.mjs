import { createHash } from "node:crypto";
import { configError } from "./config.mjs";
import { forgeSpec } from "./forges.mjs";

/**
 * A deterministic jobId for a local job. BullMQ's dedup is `EXISTS jobId`, so a double-invoke of
 * the same task within the same minute produces the same id and the duplicate is ignored -- the
 * local equivalent of REQ-DEDUP-BY-DELIVERY-GUID, guarding against a hasty second Enter
 * double-spending, without blocking a deliberate re-run a minute later.
 *
 * Kept free of any bullmq import so the dedup logic is testable everywhere, not only where the
 * queue's dependencies are installed.
 */
export function localJobId({ folder, flow, task, minute }) {
	// NUL-delimited so {folder:'a',task:'bc'} and {folder:'ab',task:'c'} cannot collide.
	const digest = createHash("sha256").update([folder, flow ?? "", task ?? "", minute].join("\0")).digest("hex");
	return `local-${digest.slice(0, 16)}`;
}

/**
 * The retry-idempotent jobId for a chained (outbox-requested) child job: `parent id + content-hash of
 * (flow, task)`, with NO time component. BullMQ's dedup is `EXISTS jobId`, so a retried parent
 * re-collects its outbox and re-enqueues IDENTICAL child ids -- the duplicate follow-up is rejected,
 * so a retry cannot fan out extra paid jobs (INT-OUTBOX-CONTRACT, DES-JOB-OUTBOX-CHAINING).
 *
 * localJobId's minute component is deliberately ABSENT here: a retry crossing a minute boundary would
 * otherwise mint a fresh id and double-chain. `parentJobId` is folded INTO the hash so two different
 * parents requesting the same flow+task resolve to distinct ids and cannot collide; the `chain-`
 * prefix carries no parent info of its own because the hash already binds it.
 *
 * Kept free of any bullmq import (mirrors localJobId/deliveryJobId) so the dedup key is derivable
 * everywhere, not only where the queue's dependencies are installed.
 */
export function chainedJobId({ parentJobId, flow, task }) {
	// NUL-delimited (localJobId's idiom) so distinct field splits cannot collide.
	const digest = createHash("sha256").update([String(parentJobId), flow ?? "", task ?? ""].join("\0")).digest("hex");
	return `chain-${digest.slice(0, 16)}`;
}

/**
 * The deterministic jobId for a GitHub-triggered job: the `X-GitHub-Delivery` GUID, prefixed.
 * BullMQ's dedup is `EXISTS jobId`, so a redelivered webhook (GitHub retries on timeout) carries
 * the same GUID, resolves to the same id, and the duplicate paid run is rejected --
 * REQ-DEDUP-BY-DELIVERY-GUID.
 *
 * Kept free of any bullmq import (mirrors localJobId) so the dedup key is derivable everywhere, not
 * only where the queue's dependencies are installed. A missing GUID is a caller bug -- the receiver
 * rejects a missing deliveryId before enqueue (D2) -- so this throws rather than inventing a random
 * id, which would silently defeat dedup and let a redelivery double-spend.
 */
export function deliveryJobId(guid) {
	return forgeDeliveryJobId("github", guid);
}

/**
 * The same thing for a GitLab-triggered job: the `webhook-id` (or its older name `Idempotency-Key`),
 * prefixed `gl-`. GitLab keeps that value CONSTANT across its own retries, which is the exact property
 * REQ-DEDUP-BY-DELIVERY-GUID needs, so the guarantee is the same one -- and retention-bounded in the same
 * way.
 */
export function gitlabDeliveryJobId(id) {
	return forgeDeliveryJobId("gitlab", id);
}

/**
 * The general form the two above are now spellings of: a forge kind plus that forge's own per-delivery
 * id, prefixed from the forge table.
 *
 * The prefix is not decoration -- it keeps every forge's id space disjoint, so a delivery id that happened
 * to collide across two forges could never silently suppress the other's job. One body rather than one per
 * forge because the *policy* here (a missing id throws rather than inventing a random one, which would
 * defeat dedup and let a redelivery double-spend) is a property of REQ-DEDUP-BY-DELIVERY-GUID, not of any
 * one forge, and four copies of a policy is four chances to weaken it in three places.
 *
 * An unknown kind throws for a different reason than an empty id, and says so: reaching here with one
 * means a forge was added to the trigger schema and not to the table.
 *
 * `replica` is the ONE seam that lets a single delivery become more than one job (REQ-REPLICA-RUNS). It is
 * appended, so `gh-<guid>` becomes `gh-<guid>-r2`, and the dedup guarantee above survives intact: a
 * REDELIVERY of that same GUID still resolves `-r2` for replica 2 and is still rejected, while replica 1
 * and replica 2 can never suppress each other. Everything the harness keys off the jobId -- the container
 * name, `PI_JOB_ID`, the `.log` and `.json` sidecars -- becomes replica-distinct for free. `-` is inside
 * `sanitizeJobId`'s `[A-Za-z0-9._-]` allowlist (run-history.mjs) and inside docker's container-name
 * grammar, so the longer id needs no new escaping anywhere. Absent leaves the id byte-identical.
 */
export function forgeDeliveryJobId(kind, id, replica) {
	const spec = forgeSpec(kind);
	if (!spec) {
		throw configError(`forgeDeliveryJobId: ${JSON.stringify(kind)} is not a known forge -- add it to FORGES in worker/src/forges.mjs`);
	}
	if (typeof id !== "string" || id === "") {
		throw configError(`forgeDeliveryJobId requires a non-empty ${spec.deliveryIdName} for a ${kind} delivery`);
	}
	const base = `${spec.jobIdPrefix}${id}`;
	if (replica === undefined) return base;
	if (!Number.isInteger(replica) || replica <= 0) {
		throw configError(`forgeDeliveryJobId: replica must be a positive integer when present (got ${JSON.stringify(replica)})`);
	}
	return `${base}-r${replica}`;
}
