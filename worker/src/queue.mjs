import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { assertJudgedConnection, onValkeyError } from "./connection.mjs";
import { chainedJobId, localJobId, deliveryJobId, gitlabDeliveryJobId, forgeDeliveryJobId, manualTriggerJobId } from "./job-id.mjs";
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

/**
 * Every queue name this deployment drains: the shared one, plus one per named host (issue #57).
 *
 * Derived from the REGISTRY rather than from configuration, because the reader is usually the admin or
 * the CLI, which know their own host at best and the fleet not at all. A deployment with no named worker
 * that declared NO name yields exactly `[QUEUE]`, so every existing caller is unchanged. Note that this
 * is derived from `routes`, not from a row existing: every worker publishes a row, named or not.
 *
 * This exists because a host queue that no reader knows about is worse than no host queue: the panel
 * would show zero schedulers while cron ran, and `pi-dispatch pause` would stop half a deployment while
 * reporting success -- the silent no-op its own comment already warns about for a mistyped name.
 */
export function fleetQueueNames(hosts) {
	const seen = new Set();
	for (const h of hosts ?? []) {
		// A host has a queue only when it DECLARED a name. Every worker publishes a registry row -- that is
		// what lets an unnamed fleet be seen at all -- but an undeclared one drains only the shared queue,
		// so deriving queue names from every row would invent `pi-jobs@<hostname>` for a queue nothing
		// reads: pausing it would create a real key for a phantom, and the counts would be a queue that can
		// never have jobs.
		if (h?.routes !== true && h?.routes !== "true") continue;
		const name = h?.name;
		// VALIDATED, because this is peer-written data crossing a trust boundary. `hostQueueName`'s own
		// contract leans on the charset -- `@` is the separator precisely because a name cannot contain one
		// -- and nothing else re-checks it. A name with a `:` makes `new Queue` throw, which would take the
		// kill switch out entirely; one with an `@` would not decompose.
		if (typeof name !== "string" || !WORKER_NAME_RE.test(name)) continue;
		seen.add(name);
	}
	// Deduped: two rows naming one host would double-count its jobs in a summed status.
	return [QUEUE, ...[...seen].sort().map(hostQueueName)];
}

/** The name charset, duplicated from `config.mjs` deliberately: this module imports nothing. */
const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export { chainedJobId, localJobId, deliveryJobId, gitlabDeliveryJobId, forgeDeliveryJobId, manualTriggerJobId };

/**
 * A queue handle. `name` defaults to the shared queue, so every existing caller is unchanged and a
 * single-host deployment never names anything else.
 */
export function makeQueue(connection, { name = QUEUE } = {}) {
	// Issue #464: only a connection `parseConnection` built, which judges and pins the Valkey it dials.
	assertJudgedConnection(connection);
	const queue = new Queue(name, { connection });
	// Issue #468: an error of this queue is one line, its message, never BullMQ's console.error of the whole object.
	onValkeyError(queue, `queue ${name}`);
	return queue;
}

/**
 * Enqueue a local-folder job. Returns the jobId. The data shape is what the processor's runJob
 * consumes (kind/folder/flow/task/provider/model/maxTurns).
 *
 * removeOnComplete keeps the dedup window ~= the retention. Unlike webhooks, local jobs are not
 * redelivered, so a modest window is enough.
 */
export async function enqueueLocalJob(queue, fields) {
	return (await addLocalJob(queue, fields)).id;
}

/**
 * `enqueueLocalJob` for a caller that must SAY whether anything was queued (issue #524): the operator's
 * `pi-dispatch run`. Returns `{ id, existing }`, where `existing` is null for a job this call created, and
 * `{ queuedAt, state }` when the one-minute dedup answered with a job an identical earlier call made.
 *
 * The CLI printed "queued <id>" either way, so a second `run` inside the same minute announced a job while
 * running nothing, under the id of one that had already finished. The dedup itself is deliberate and stays.
 *
 * How a duplicate is told apart, and why not by asking first. BullMQ answers a jobId that already exists by
 * returning the existing id inside a Job object it built LOCALLY for this call, so the return value says nothing
 * about whether anything was stored. Each call therefore puts a random nonce of its own on the job's data
 * (`enqueueNonce`) and reads the stored job back AFTER the add: the stored nonce is this call's exactly when
 * this call's add is the one BullMQ kept. Exactly one of any number of concurrent identical calls finds its own.
 * The first version compared the add's timestamp instead, and PR #528's review refuted it: calls in the same
 * millisecond share a timestamp, and ten in parallel all reported "created" while one job existed. A lookup
 * BEFORE the add has the same flaw by construction, since every concurrent caller can see nothing.
 *
 * The nonce is on job data, never inside `trigger`, which is the object copied into /job/event.json: it is the
 * producer's bookkeeping and the agent has no use for it. Only the two reporting producers add it (this one and
 * `enqueueTriggerRunReporting`), so a job from the outbox collector or a cron tick keeps exactly the data it had.
 *
 * A separate function rather than a change to `enqueueLocalJob`'s return, because the outbox collector consumes
 * that as a bare id and prints nothing to a person. It also keeps its one Valkey round trip: only this function
 * pays for the read back.
 *
 * `state` is BullMQ's own word for where the job is (`waiting`, `active`, `completed`, `failed`, `delayed`
 * and the rest), or null when the state could not be read; the caller then says it is already queued or
 * done rather than inventing one. A read that fails outright returns `existing: undefined`: whether this
 * call queued anything is then unknown, and the caller says so instead of guessing either way.
 */
export async function enqueueLocalJobReporting(queue, fields) {
	return addReporting(queue, (enqueueNonce) => addLocalJob(queue, { ...fields, enqueueNonce }));
}

/**
 * Fire one cron trigger by hand (`pi-dispatch run --trigger <id>`, issue #505), reporting like
 * `enqueueLocalJobReporting` and through the same nonce and read back, so a second call in the same minute says
 * the first job was already queued instead of announcing one it did not make.
 *
 * `schedule` is the trigger's own scheduler entry from `loadSchedules`, and its `data` is passed through WHOLE, with
 * only the nonce added: the folder, the flow or command, the task, `github`, `packages`, `resume`, the model fields,
 * `trigger: { id, pattern }` and a job-level `portfolio`. Field by field through `addLocalJob` was the other way, and
 * it is the one that drops a field the next issue adds to the schedule. The options are the schedule's too, so the
 * job is not retried, as a scheduled tick is not (a scheduler job carries no `attempts`). The id is
 * `manualTriggerJobId`'s, so `localEventContext` reports `source: "cron"` with `scheduledFor: null`.
 */
export async function enqueueTriggerRunReporting(queue, schedule, { now = new Date() } = {}) {
	const jobId = manualTriggerJobId({ triggerId: schedule.schedulerId, now });
	return addReporting(queue, async (enqueueNonce) => {
		await queue.add(schedule.name, { ...schedule.data, enqueueNonce }, { ...schedule.opts, jobId });
		return { id: jobId };
	});
}

/** The add, then the read back that says whether THIS call's add is the one stored (see `enqueueLocalJobReporting`). */
async function addReporting(queue, add) {
	const enqueueNonce = randomUUID();
	const { id } = await add(enqueueNonce);
	let stored;
	try {
		stored = await queue.getJob(id);
	} catch {
		return { id, existing: undefined };
	}
	// No stored job: it was removed between the add and this read (a `cancel` racing it). Nothing says it was
	// a duplicate, so it reads as created, which is what the add itself answered.
	if (!stored || stored.data?.enqueueNonce === enqueueNonce) return { id, existing: null };
	let state = null;
	try {
		const s = await stored.getState();
		state = typeof s === "string" && s !== "unknown" ? s : null;
	} catch {}
	return { id, existing: { queuedAt: Number.isFinite(stored.timestamp) ? stored.timestamp : null, state } };
}

/**
 * The one sentence for a swallowed local enqueue (issue #524), shared by `pi-dispatch run` and the admin's
 * `/dispatch run` so the two producers an operator types cannot drift apart. `existing` is
 * `enqueueLocalJobReporting`'s: the time is the first job's own, in this process's local time, and a state the
 * queue could not give is said as "already queued or done" rather than guessed.
 */
export function swallowedRunSentence(jobId, existing) {
	const at = Number.isFinite(existing?.queuedAt) ? new Date(existing.queuedAt) : null;
	const hhmm = at ? ` at ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "";
	return `an identical run was queued${hhmm} as ${jobId} (${existing?.state ?? "already queued or done"}); nothing new was queued.`;
}

async function addLocalJob(queue, { folder, flow, task, command, provider, model, maxTurns, models, maxCostUsd, image, backend, excludeTools, skillsDir, secrets, secretsProfile, chainDepth, parentJobId, jobId, enqueueNonce, now = new Date() }) {
	const minute = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM -- the dedup window
	// A caller-supplied jobId (the outbox collector's retry-idempotent chainedJobId) wins; otherwise the
	// minute-windowed localJobId is the dedup key. A command job (issue #189) fills the flow slot with
	// `cmd:<command>` rather than leaving it empty: a command trigger carries no flow/task, so without it
	// two DIFFERENT commands on one folder in one minute would hash identically and the second would
	// vanish silently -- and the `cmd:` prefix keeps a command named X from colliding with a flow named X
	// (`:` is outside the skill-name charset, so no real flow can spell the prefixed form). A flow job's
	// key is byte-identical to before the feature.
	const id = jobId ?? localJobId({ folder, flow: command !== undefined ? `cmd:${command}` : flow, task, minute, provider, model, models });
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
		// Issue #502: the allowed-model list, conditional like `image`, so a job whose trigger named none keeps its
		// data byte-identical. An outbox child carries its parent's (outbox.mjs), never one its request file names.
		...(models !== undefined && { models }),
		// Issue #501: the per-job dollar cap, passed through for the outbox child that inherits its parent's.
		...(maxCostUsd !== undefined && { maxCostUsd }),
		...(image !== undefined && { image }),
		// #227. WHERE this job's container is built. Conditional like `image`, so a trigger that named no
		// venue produces byte-identical job data -- and at JOB level, never inside `trigger`, for the reason
		// `image` and `skillsDir` are: `trigger` is copied VERBATIM into `/job/event.json`, so a key added
		// there becomes agent-visible input, and where the box was built is the worker's business rather
		// than the agent's.
		...(backend !== undefined && { backend }),
		// #291. WHAT the session's agent may not do. Conditional like `backend`, and at JOB level for the
		// same reason: `trigger` is copied verbatim into /job/event.json, and a permission boundary is the
		// worker's business, never agent-visible input to reason about.
		...(excludeTools !== undefined && { excludeTools }),
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
		// Issue #524: `enqueueLocalJobReporting`'s own mark, so it can tell whether ITS add is the one stored.
		...(enqueueNonce !== undefined && { enqueueNonce }),
	};
	await queue.add("local", data, {
		jobId: id,
		attempts: 2,
		backoff: { type: "exponential", delay: 60_000 },
		removeOnComplete: { age: 24 * 3600 },
		removeOnFail: { age: 7 * 24 * 3600 },
	});
	return { id };
}

// Coalesces rapid re-label spam; the GUID jobId + 31d retention handle exact redelivery, so this
// window only needs to absorb burst re-labels, not the full redelivery window.
const SEMANTIC_WINDOW_MS = 10 * 60 * 1000;

/**
 * Enqueue a GitHub-triggered job. Returns `{ jobId, deduplicated, survivingJobId? }` -- the computed
 * per-delivery id, plus whether the SEMANTIC window swallowed this delivery (issue #289; the GUID
 * layer's replays are deliberately invisible, see the comparison below). `enqueueLocalJob` keeps its
 * plain string return: it carries no `deduplication` option, so there is nothing the comparison could
 * see, and its return is consumed as a bare id by the CLI and the outbox. The data shape is what
 * prepare/runJob consumes for the github kind. No `sha` field: the commit is resolved fresh in prepare
 * (C1), so baking a possibly-stale sha here would only race the branch head.
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
export async function enqueueForgeJob(queue, kind, { repo, projectId, azure, target, flow, command, trigger, provider, model, maxTurns, models, maxCostUsd, packages, image, backend, excludeTools, skillsDir, instructions, resume, secrets, secretsProfile, waitFor, replica, replicas }) {
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
		// Issue #502: the allowed-model list, conditional like `packages` below so an unflagged trigger's job data is
		// byte-identical, and at JOB level, never inside `trigger` (copied verbatim into /job/event.json).
		...(models !== undefined && { models }),
		...(packages !== undefined && { packages }),
		...(image !== undefined && { image }),
		// #227. WHERE this job's container is built. Conditional like `image`, so a trigger that named no
		// venue produces byte-identical job data -- and at JOB level, never inside `trigger`, for the reason
		// `image` and `skillsDir` are: `trigger` is copied VERBATIM into `/job/event.json`, so a key added
		// there becomes agent-visible input, and where the box was built is the worker's business rather
		// than the agent's.
		...(backend !== undefined && { backend }),
		// #291. WHAT the session's agent may not do. Conditional like `backend`, and at JOB level for the
		// same reason: `trigger` is copied verbatim into /job/event.json, and a permission boundary is the
		// worker's business, never agent-visible input to reason about.
		...(excludeTools !== undefined && { excludeTools }),
		// #501. The trigger's per-job dollar cap, as written. Conditional like `excludeTools`, at JOB level for its
		// reason, and a narrowing like it: the worker runs the job under the smaller of this and the deployment cap.
		...(maxCostUsd !== undefined && { maxCostUsd }),
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
	const added = await queue.add(kind, data, {
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
	// Issue #289: WHICH of the two dedup layers spoke is readable off `queue.add`'s return, and only one
	// of them is. Verified at bullmq 5.80.4's own Lua: a jobId collision (the GUID shield,
	// REQ-DEDUP-BY-DELIVERY-GUID) returns THE SAME id -- structurally invisible here, and correctly so,
	// because a forge retry of a delivery that IS queued deserves the answer "queued" -- while the
	// `deduplication` option (the 10-minute semantic window) returns the EXISTING job's DIFFERENT id.
	// So `added.id !== jobId` means this delivery was swallowed by the window and created nothing, which
	// the receiver used to log as `enqueued` and answer as success. A defensive undefined (a fake queue
	// predating the comparison) reads as not-deduplicated, today's behaviour exactly.
	if (added?.id && added.id !== jobId) return { jobId, deduplicated: true, survivingJobId: added.id };
	return { jobId, deduplicated: false };
}

/**
 * Every host queue that EXISTS, read from BullMQ's own keyspace rather than from the host registry.
 *
 * The registry answers "who is alive", and for a kill switch that is the wrong question. A host whose
 * registry writes fail for ninety seconds loses its row while its BullMQ worker -- a separate connection,
 * built with `maxRetriesPerRequest: null` precisely to ride out blips -- keeps draining. Pausing "the
 * fleet" would then miss it and report success. The same gap opens for the ~15s before a booting worker's
 * first beat lands, and on every `service restart`, since a clean shutdown DELs the row.
 *
 * Worse is the direction with no recovery path: pause while a host is live durably pauses its queue, and a
 * later resume while that host is DOWN enumerates nothing for it. The queue stays paused permanently, and
 * no surface can see it, because every surface was reading the registry too.
 *
 * A queue's meta key is durable and outlives its worker, so this asks the only authority that cannot go
 * stale: the queues themselves. It also restores what `host-registry.mjs` claims about itself -- delete the
 * whole `host:*` keyspace and nothing decides differently -- which the registry-derived kill switch had
 * quietly made false.
 *
 * SCAN, not KEYS, and it is why this is NOT on the panel's per-tick path: it is for the rare command where
 * being wrong costs money, not for a reader that runs every second. Fails open to `[]`, so an unreadable
 * keyspace degrades to the registry's answer rather than refusing.
 */
export async function discoverHostQueues(redis, { timeoutMs = 2_000, count = 500 } = {}) {
	const prefix = `bull:${QUEUE}@`;
	const names = new Set();
	try {
		const deadline = Date.now() + timeoutMs;
		let cursor = "0";
		do {
			// BOUNDED, because BullMQ's connections carry `maxRetriesPerRequest: null` and a command against
			// an unreachable server therefore QUEUES FOREVER rather than rejecting -- so an unguarded await
			// here would hang the kill switch instead of failing it open. The same trap the registry's
			// `bounded` exists for.
			//
			// CLEARED on the way out, and NOT `unref`'d. Leaving it pending held the event loop open for the
			// rest of the budget after the work was done, so `pi-dispatch pause` sat for two seconds having
			// already paused everything; unref'ing instead would stop it firing when the hang is the last
			// thing on the loop, which is the one case it exists for.
			let timer;
			const [next, keys] = await Promise.race([
				redis.scan(cursor, "MATCH", `${prefix}*:meta`, "COUNT", count),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("scan timed out")), Math.max(1, deadline - Date.now()));
				}),
			]).finally(() => clearTimeout(timer));
			cursor = next;
			for (const key of keys ?? []) {
				const name = String(key).slice(prefix.length, -":meta".length);
				// Validated like every other peer-derived name: a key an operator hand-created could hold
				// anything, and `new Queue` throws on a `:`, which would take the kill switch out entirely.
				if (WORKER_NAME_RE.test(name)) names.add(name);
			}
		} while (cursor !== "0" && Date.now() < deadline);
	} catch {
		// Fail open: the registry's answer alone is still better than refusing to pause.
		return [];
	}
	return [...names].sort().map(hostQueueName);
}

/**
 * The union of what is LIVE (the registry) and what EXISTS (the keyspace), which is the set a kill switch
 * must act on: a live host with no queue yet has nothing to pause, and a dead host's queue still holds
 * jobs and still has a paused flag somebody has to be able to clear.
 */
export function unionQueueNames(fromRegistry, fromKeyspace) {
	const seen = new Set([...(fromRegistry ?? []), ...(fromKeyspace ?? [])]);
	seen.delete(QUEUE);
	return [QUEUE, ...[...seen].sort()];
}
