import { Queue } from "bullmq";
import { chainedJobId, localJobId, deliveryJobId, gitlabDeliveryJobId, forgeDeliveryJobId } from "./job-id.mjs";
import { targetSeparator } from "./forges.mjs";

export const QUEUE = "pi-jobs";
export { chainedJobId, localJobId, deliveryJobId, gitlabDeliveryJobId, forgeDeliveryJobId };

export function makeQueue(connection) {
	return new Queue(QUEUE, { connection });
}

/**
 * Enqueue a local-folder job. Returns the jobId. The data shape is what the processor's runJob
 * consumes (kind/folder/flow/task/provider/model/maxTurns).
 *
 * removeOnComplete keeps the dedup window ~= the retention. Unlike webhooks, local jobs are not
 * redelivered, so a modest window is enough.
 */
export async function enqueueLocalJob(queue, { folder, flow, task, provider, model, maxTurns, image, chainDepth, parentJobId, jobId, now = new Date() }) {
	const minute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM -- the dedup window
	// A caller-supplied jobId (the outbox collector's retry-idempotent chainedJobId) wins; otherwise the
	// minute-windowed localJobId is the dedup key.
	const id = jobId ?? localJobId({ folder, flow, task, minute });
	// image/chainDepth/parentJobId land on `data` only when present, so a plain non-chained job's data is
	// byte-identical. `image` is the container image this job runs in (INT-TRIGGERS-FILE-CONTRACT); absent
	// resolves the deployment default at job start, never a value frozen here.
	const data = {
		kind: "local",
		folder,
		flow,
		task,
		provider,
		model,
		maxTurns,
		...(image !== undefined && { image }),
		...(chainDepth !== undefined && { chainDepth }),
		...(parentJobId !== undefined && { parentJobId }),
	};
	await queue.add("local", data, {
		jobId: id,
		attempts: 2,
		backoff: { type: "exponential", delay: 60_000 },
		removeOnComplete: { age: 24 * 3600 },
		removeOnFail: { age: 7 * 24 * 3600 },
	});
	return id;
}

// Coalesces rapid re-label spam; the GUID jobId + 31d retention handle exact redelivery, so this
// window only needs to absorb burst re-labels, not the full redelivery window.
const SEMANTIC_WINDOW_MS = 10 * 60 * 1000;

/**
 * Enqueue a GitHub-triggered job. Returns the jobId. The data shape is what prepare/runJob consumes
 * for the github kind. No `sha` field: the commit is resolved fresh in prepare (C1), so baking a
 * possibly-stale sha here would only race the branch head.
 *
 * `target` is the discriminated subject of the job -- `{ type:"issue"|"pull_request", number, title,
 * body, ... }` -- built by the receiver's filter from the INT-WEBHOOK-PAYLOAD-SUBSET fields. Its `number`
 * keys the semantic dedup window; GitHub issues and PRs share one per-repo number sequence, so the key is
 * collision-free without encoding the type. That is a fact about GitHub, not about forges -- see
 * `enqueueGitLabJob`, where they are separate sequences and the type has to be in the key.
 *
 * Two dedup layers, ADDITIVE and independent:
 *   - `jobId` (the delivery GUID) is exact-per-delivery: a redelivered webhook resolves to the same
 *     id and BullMQ's `EXISTS jobId` rejects it -- REQ-DEDUP-BY-DELIVERY-GUID.
 *   - `deduplication` keys on `repo#number:flow` for SEMANTIC_WINDOW_MS: distinct GUIDs from rapid
 *     re-labels or repeated PR pushes coalesce to one active job. It coexists with jobId; it does not
 *     replace it.
 */
export async function enqueueGitHubJob(queue, fields) {
	return await enqueueForgeJob(queue, "github", fields);
}

/**
 * Enqueue a GitLab-triggered job. Structurally the twin of `enqueueGitHubJob` -- and now literally the
 * same body, because everything that differs between them turned out to be two table entries.
 *
 * `projectId` rides the data because every GitLab API path the worker needs takes the numeric project id.
 * A GitLab project path is `group/subgroup/project` with no fixed segment count, so the `owner/name` split
 * the GitHub path uses does not merely fail on one, it SUCCEEDS wrongly: both halves come back non-empty
 * and the project silently becomes its own parent group. Carrying the id sidesteps the grammar entirely;
 * `repo` stays as the human-readable label for logs, run history and pause-window scopes.
 */
export async function enqueueGitLabJob(queue, fields) {
	return await enqueueForgeJob(queue, "gitlab", fields);
}

/**
 * Enqueue a forge-triggered job of any kind. Returns the jobId.
 *
 * The two named wrappers above are spellings of this. They were separate bodies until a third and fourth
 * forge made that four copies of the retention window, the retry policy, the backoff and BOTH dedup
 * layers -- four places for one of them to be quietly weakened while every test stayed green.
 *
 * The semantic dedup key encodes the TARGET TYPE through `targetSeparator`, which GitHub alone does not
 * need: it numbers issues and pull requests from one per-repo sequence, so `repo#7` names exactly one
 * thing. GitLab numbers them separately, so issue #5 and merge request !5 would collide on `project#5:flow`
 * -- one silently coalescing into the other's 10-minute window and never running. The separator is each
 * forge's own notation, and it lives in the table because it is a fact about the forge.
 *
 * Forge-specific data fields are listed EXPLICITLY rather than collected with a rest spread. A spread
 * would persist whatever a caller happened to pass into durable job data, and this object is copied
 * verbatim into `/job/event.json` -- a place where an unreviewed field has no business.
 *
 * REPLICAS (REQ-REPLICA-RUNS) are the one case where one delivery becomes more than one job, and BOTH dedup
 * layers have to be told, not just the id. The caller loops and passes `replica` 1..N; each pass is an
 * ordinary enqueue with a distinct id and a distinct semantic key. The `replica` suffix on the dedup id is
 * added ONLY when a replica is set, so re-deliveries of each replica still coalesce within the 10-minute
 * window, replicas never coalesce against each other, and an unflagged job's dedup id is the same string it
 * has always been.
 */
export async function enqueueForgeJob(queue, kind, { repo, projectId, azure, target, flow, trigger, provider, model, maxTurns, packages, image, resume, replica, replicas }) {
	const jobId = forgeDeliveryJobId(kind, trigger?.deliveryId, replica);
	// `packages` (whether to load the operator-staged pi packages) and `image` (which container image to run)
	// come off the MATCHED trigger (INT-TRIGGERS-FILE-CONTRACT / REQ-GLOBAL-PI-OVERLAY) and land on `data`
	// only when the filter resolved one, exactly like chainDepth/parentJobId above, so an unflagged trigger's
	// job data is byte-identical. Both sit at JOB level, never inside `trigger` -- that object is descriptive
	// and is copied verbatim into /job/event.json, where an execution knob has no business.
	const data = {
		kind,
		repo,
		...(projectId !== undefined && { projectId }),
		// Azure's org/project/repository triple, alongside the human-readable `repo` -- the same split gitlab
		// makes with `projectId`, and for the same reason: every Azure API path takes ids and names this label
		// cannot be reassembled into without guessing.
		...(azure !== undefined && { azure }),
		target,
		flow,
		trigger,
		provider,
		model,
		maxTurns,
		...(packages !== undefined && { packages }),
		...(image !== undefined && { image }),
		...(resume !== undefined && { resume }),
		// Conditional for the same reason packages/image/resume are: an unflagged job's data must keep
		// exactly the keys it has today. `replica` is this job's 1-based index and `replicas` the set size;
		// both are integers, so the run record they land in stays PII-free by construction.
		...(replica !== undefined && { replica }),
		...(replicas !== undefined && { replicas }),
	};
	await queue.add(kind, data, {
		jobId,
		deduplication: { id: `${repo}${targetSeparator(kind, target?.type)}${target.number}:${flow}${replica !== undefined ? `:r${replica}` : ""}`, ttl: SEMANTIC_WINDOW_MS }, // ttl in ms
		attempts: 2,
		backoff: { type: "exponential", delay: 60_000 },
		removeOnComplete: { age: 31 * 24 * 3600 }, // age in seconds -- do not cross units with the ms ttl above
		removeOnFail: { age: 31 * 24 * 3600 },
	});
	return jobId;
}
