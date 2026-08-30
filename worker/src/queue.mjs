import { Queue } from "bullmq";
import { chainedJobId, localJobId, deliveryJobId, gitlabDeliveryJobId, forgeDeliveryJobId } from "./job-id.mjs";
import { targetSeparator } from "./forges.mjs";
import { PR_CLOSE_ACTIONS } from "./triggers.mjs";

// The close words in every forge's spelling, derived from the one table (never re-typed here): a
// matched PR action in this set marks a close job for the semantic-key discriminant below.
const PR_CLOSE_WORDS = new Set(Object.values(PR_CLOSE_ACTIONS));

export const QUEUE = "pi-jobs";

/**
 * The queue a HOST-AFFINE job goes to (issue #57): work only one machine can do, because the folder, the
 * secret resolver or the wait-check script lives there.
 *
 * `@` is the separator because it is outside the worker-name charset (`[A-Za-z0-9._-]`), so
 * `pi-jobs@<name>` decomposes unambiguously and a name can never contain one. A SUFFIX rather than a
 * prefix so `KEYS bull:pi-jobs*` still shows an operator the whole deployment.
 *
 * Deliberately a separate queue rather than a field the pickup gate filters on. BullMQ has no selective
 * pop, so filtering would mean taking a job and putting it back -- and promotion out of the delayed set is
 * gated on each worker's OWN `Date.now()` in two places, so the host whose clock runs fastest wins every
 * hop deterministically. A job that had to reach a different host might never get there, and jitter cannot
 * fix it: it randomises WHEN the wake is, not WHO wins it.
 */
export const hostQueueName = (worker) => `${QUEUE}@${worker}`;

export { chainedJobId, localJobId, deliveryJobId, gitlabDeliveryJobId, forgeDeliveryJobId };

/**
 * A queue handle. `name` defaults to the shared queue, so every existing caller is unchanged and a
 * single-host deployment never names anything else.
 */
export function makeQueue(connection, { name = QUEUE } = {}) {
	return new Queue(name, { connection });
}

/**
 * Enqueue a local-folder job. Returns the jobId. The data shape is what the processor's runJob
 * consumes (kind/folder/flow/task/provider/model/maxTurns).
 *
 * removeOnComplete keeps the dedup window ~= the retention. Unlike webhooks, local jobs are not
 * redelivered, so a modest window is enough.
 */
export async function enqueueLocalJob(queue, { folder, flow, task, command, provider, model, maxTurns, image, skillsDir, secrets, secretsProfile, chainDepth, parentJobId, jobId, now = new Date() }) {
	const minute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM -- the dedup window
	// A caller-supplied jobId (the outbox collector's retry-idempotent chainedJobId) wins; otherwise the
	// minute-windowed localJobId is the dedup key. A command job (issue #189) fills the flow slot with
	// `cmd:<command>` rather than leaving it empty: a command trigger carries no flow/task, so without it
	// two DIFFERENT commands on one folder in one minute would hash identically and the second would
	// vanish silently -- and the `cmd:` prefix keeps a command named X from colliding with a flow named X
	// (`:` is outside the skill-name charset, so no real flow can spell the prefixed form). A flow job's
	// key is byte-identical to before the feature.
	const id = jobId ?? localJobId({ folder, flow: command !== undefined ? `cmd:${command}` : flow, task, minute });
	// image/chainDepth/parentJobId land on `data` only when present, so a plain non-chained job's data is
	// byte-identical. `image` is the container image this job runs in (INT-TRIGGERS-FILE-CONTRACT); absent
	// resolves the deployment default at job start, never a value frozen here.
	const data = {
		kind: "local",
		folder,
		flow,
		task,
		// The registered pi command this job dispatches instead of a flow (issue #189). Conditional like
		// `image`, so a flow job's data keeps exactly the keys it has today; the parse-level XOR means a
		// job carrying it has flow/task undefined, which JSON serialization drops.
		...(command !== undefined && { command }),
		provider,
		model,
		maxTurns,
		...(image !== undefined && { image }),
		// The host directory of operator-authored skills this trigger injects (REQ-PER-TRIGGER-SKILLS).
		// Conditional like `image`, so an unflagged job's data stays byte-identical, and at JOB level rather
		// than inside `trigger` because a worker-host path is an execution knob, not a fact about the
		// delivery -- and `trigger` is the object copied into /job/event.json.
		...(skillsDir !== undefined && { skillsDir }),
		// REQ-TRIGGER-SECRETS, on the forge path's terms: references only, resolved by the worker at job
		// start. A cron trigger may bind secrets (a nightly deploy is the obvious user), which is where
		// this differs from `replicas` -- that one is refused on a local job and this one is not.
		...(secrets !== undefined && { secrets }),
		...(secretsProfile !== undefined && { secretsProfile }),
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
export async function enqueueForgeJob(queue, kind, { repo, projectId, azure, target, flow, command, trigger, provider, model, maxTurns, packages, image, skillsDir, instructions, resume, secrets, secretsProfile, waitFor, replica, replicas }) {
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
		// The registered pi command this trigger dispatches instead of a flow (issue #189). Conditional
		// like `packages`/`image` below, so an unflagged trigger's job data is byte-identical -- and at
		// JOB level, never inside `trigger`, for their reason too: an execution knob is not a fact about
		// the delivery, and `trigger` is copied verbatim into /job/event.json.
		...(command !== undefined && { command }),
		trigger,
		provider,
		model,
		maxTurns,
		...(packages !== undefined && { packages }),
		...(image !== undefined && { image }),
		// The host directory of operator-authored skills this trigger injects (REQ-PER-TRIGGER-SKILLS).
		// Conditional like `image`, so an unflagged job's data stays byte-identical, and at JOB level rather
		// than inside `trigger` because a worker-host path is an execution knob, not a fact about the
		// delivery -- and `trigger` is the object copied into /job/event.json.
		...(skillsDir !== undefined && { skillsDir }),
		// The operator's standing instruction for this trigger (REQ-PER-TRIGGER-INSTRUCTION). Conditional like
		// the rest, and at JOB level rather than inside `trigger`: it is operator config, not a fact about the
		// delivery, and `trigger` is what /job/event.json is built from.
		...(instructions !== undefined && { instructions }),
		...(resume !== undefined && { resume }),
		// REQ-TRIGGER-SECRETS. The env variables this trigger binds and the profile whose resolver reads
		// them. REFERENCES only: no value is ever enqueued, because a queued job is durable and a resolved
		// credential in Redis would outlive the container it was scoped to. The worker resolves them at job
		// start, pre-spend. At JOB level rather than inside `trigger` for image/skillsDir's reason: `trigger`
		// is copied verbatim into /job/event.json, which an agent reads.
		...(secrets !== undefined && { secrets }),
		...(secretsProfile !== undefined && { secretsProfile }),
		// Issue #230. The conditions the worker holds this job on, carried so the PICKUP gate can read them:
		// that gate runs above the per-job settings read and never re-parses the triggers file for its terms.
		// At JOB level, and here that placement is a correctness requirement rather than a convention --
		// `trigger` is copied VERBATIM into /job/event.json (prepare-local.mjs), so a `trigger.waitFor` would
		// hand the agent the operator's own gate. Conditional like every field above, so an unflagged job's
		// data keeps exactly the keys it has today. The dedup options below are deliberately NOT widened for
		// a waiting job: that key carries no trigger identity and outlives the job it was set for, so a
		// longer window would suppress an unflagged sibling's deliveries and go on suppressing them after
		// this job finished. Coalescing a held target is the worker's `wait:` keyspace's job instead.
		...(waitFor !== undefined && { waitFor }),
		// Conditional for the same reason packages/image/resume are: an unflagged job's data must keep
		// exactly the keys it has today. `replica` is this job's 1-based index and `replicas` the set size;
		// both are integers, so the run record they land in stays PII-free by construction.
		...(replica !== undefined && { replica }),
		...(replicas !== undefined && { replicas }),
	};
	// A close-triggered job (issue #231) leads the semantic key's flow slot with `closed:`. Without it,
	// a label/comment/PR job on the same target and flow inside the 10-minute window silently swallows
	// the close job -- and because a swallowed close job writes no run record, the once trigger it was
	// meant to spend never disarms: a permanently dead one-shot with nothing in the panel to say why.
	// The discriminant is DERIVED from the matched rule (`issue` type, or a PR close action word) rather
	// than carried as a job field: an execution detail of dedup is not a fact about the delivery, and
	// `data`/`event.json` stay byte-identical. `:` is outside the skill-name charset -- enforced at load
	// since #231 -- so no real flow can spell either prefixed form, and `closed:cmd:<name>` composes for
	// close-dispatched commands (outermost discriminant first, then the entry-point prefix).
	const matched = trigger?.matched;
	// `type === "issue"` reads as "close" only while the issue vocabulary is close-only (it is; the
	// tables say "one word each so far"). If that type ever grows a non-close action, this test must
	// narrow to the matched action word, like the PR half already does.
	const isCloseJob = matched?.type === "issue" || (matched?.type === "pull_request" && PR_CLOSE_WORDS.has(matched?.action));
	const flowSlot = `${isCloseJob ? "closed:" : ""}${command !== undefined ? `cmd:${command}` : flow}`;
	await queue.add(kind, data, {
		jobId,
		// A command job (issue #189) fills the semantic key's flow slot with `cmd:<command>`: a command
		// trigger carries no flow, so the slot would otherwise read `undefined` for every command and one
		// command's 10-minute window would swallow a different command's delivery on the same target. The
		// `cmd:` prefix keeps a command named X from coalescing against a flow named X -- `:` is outside
		// the skill-name charset, so no real flow can spell the prefixed form -- and a flow job's key
		// stays byte-identical to before the feature.
		deduplication: { id: `${repo}${targetSeparator(kind, target?.type)}${target.number}:${flowSlot}${replica !== undefined ? `:r${replica}` : ""}`, ttl: SEMANTIC_WINDOW_MS }, // ttl in ms
		attempts: 2,
		backoff: { type: "exponential", delay: 60_000 },
		removeOnComplete: { age: 31 * 24 * 3600 }, // age in seconds -- do not cross units with the ms ttl above
		removeOnFail: { age: 31 * 24 * 3600 },
	});
	return jobId;
}
