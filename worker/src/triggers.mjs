/**
 * Shared trigger-file schema + validator (issue #20). One `triggers.json` of `{ on, run }` entries is
 * the single reviewed source of standing triggers for BOTH services: the worker owns `on.type:"cron"`
 * (local jobs), the receiver owns the webhook types (`label|comment|pull_request` -> a forge job). Each
 * service validates the WHOLE file, then selects the `on.type` it owns, so a malformed file fails both
 * identically and the two cannot drift.
 *
 * The on x run MATRIX is the trust boundary (DES-TRIGGERS-UNIFIED-FILE): a cron trigger carries no
 * webhook delivery id, issue/PR number, title, or body, so it can only produce a `local` run; a webhook
 * trigger is adversarial input and always produces a FORGE run, never a local one. Off-matrix is
 * rejected fail-loud at load, exactly as the old schedules loader refused a `kind:"github"` schedule.
 *
 * Which forge is `run.kind` (issue #42): the `on.type` vocabulary is shared, because a label is a label
 * and a comment is a comment on every forge, while the ACTION vocabulary is not -- GitHub says
 * `opened`/`synchronize`, GitLab says `open`/`update`. So actions are validated against the vocabulary of
 * whichever forge the entry names. That refusal matters more than it looks: an action word from the wrong
 * forge does not crash anything downstream, it simply never matches an event, and the trigger silently
 * never fires. Refusing it at load is what turns a silent no-op into a message.
 *
 * Pure and fs-free (mirrors job-id.mjs): takes the file TEXT, returns a normalized array, throws
 * `configError` on any problem. Folder existence (fs-dependent) is layered on by the worker, not here.
 *
 * Custom: triggers validated inline per config.mjs/schedules.mjs precedent; zod not in deps
 */

import { configError } from "./config.mjs";
import { FORGE_KINDS, RUN_KINDS, forgeSpec, isForgeKind } from "./forges.mjs";

const ON_TYPES = new Set(["cron", "label", "comment", "pull_request"]);

// `RUN_KINDS` and `FORGE_KINDS` come from the forge table (forges.mjs) rather than being written out
// here. They differ by exactly `local`, and that difference IS the on x run matrix below: a webhook
// trigger produces a forge job, a cron trigger produces a local one. Re-exported because the receiver's
// config builds one trigger group per forge and a group it forgot would throw inside a reload that keeps
// the previous rules -- so the two have to be derived from one list, and a test asserts they are.
export { FORGE_KINDS };

/**
 * The `pull_request` action vocabulary, per forge, in each forge's OWN words -- so an operator writes
 * what their forge's documentation says and can grep for it there.
 *
 * GitLab has no `labeled`: adding a label to a merge request arrives as `update` carrying a
 * `changes.labels` diff, and `open`/`reopen` are its spellings of `opened`/`reopened`. `merge` and
 * `close` are omitted on purpose: a job started by a merge or a close has nothing left to act on.
 *
 * `review_submitted` (issue #66) is github's fifth and the one compound word here. It names the
 * `pull_request_review` event's `submitted` action, so both halves are greppable in GitHub's own docs, the
 * same reason Forgejo's `label_updated` is spelled Forgejo's way. It is also the first case where ONE
 * `on.type` covers TWO GitHub event names: a review is an event about a pull request, and GitLab's
 * analogue `approved` already rides `on.type: "pull_request"`, so making GitHub's a fifth `on.type` would
 * have made one forge's review a type and the other's an action. The gate on it is the REVIEWER's
 * `author_association`, never the PR author's -- see filter.mjs and CONST-TRIGGER-AUTHOR-GATE.
 */
const PR_ACTIONS = {
	github: new Set(["labeled", "opened", "synchronize", "reopened", "review_submitted"]),
	// GitLab's `approved` is its review gate (a member approved the MR). It is NOT github's
	// `review_submitted` renamed: `approved` is one verdict, `review_submitted` is every verdict, which is
	// what `on.reviewState` below exists to narrow.
	gitlab: new Set(["open", "update", "reopen", "approved"]),
	// Forgejo's own spellings. `label_updated` is its `labeled` and `synchronized` its `synchronize` -- a
	// one-letter difference that an operator would otherwise discover as a trigger that loads clean and
	// never fires. `label_cleared` is deliberately ABSENT and always will be: REMOVING a label must never
	// start a paid run, and it has no GitHub counterpart to inherit that rule from.
	forgejo: new Set(["label_updated", "opened", "synchronized", "reopened"]),
	// Azure's Service Hook events reduced to the two that leave something to act on. `git.pullrequest.merged`
	// is omitted for the same reason GitLab's `merge` and `close` are: a job started by a merge has nothing
	// left to do. There is no label action at all -- Azure attaches tags to WORK ITEMS, never to pull
	// requests -- which is why azure's `prLabelAction` is null and a predicated PR rule is refused below.
	azure: new Set(["created", "updated"]),
};

/**
 * The verdicts a submitted GitHub review can carry, in the webhook's own (lower-case) spelling, and the
 * vocabulary of the optional `on.reviewState` narrowing (issue #66).
 *
 * The narrowing exists because `review_submitted` is a WIDER paid surface than any other GitHub trigger:
 * an approve, a request-changes and a drive-by "lgtm thanks" all submit a review, and unlike a comment
 * trigger there is no phrase in the way and unlike a label trigger there is no label. `["changes_requested"]`
 * is the arming most operators actually want. Omitted means all three, so the default is the issue's own
 * shape and the narrowing only ever subtracts.
 *
 * `dismissed` is absent because it is an ACTION on the `pull_request_review` event, not a state a
 * submitted review carries.
 */
const REVIEW_STATES = new Set(["approved", "changes_requested", "commented"]);

/** The one action `on.reviewState` can narrow. Spelled once, read by the validator and named in its error. */
const REVIEW_ACTION = "review_submitted";

// A cron id flows into BullMQ's deterministic `repeat:<id>:<nextMillis>` jobId, so a `:` corrupts that
// parse; the charset also excludes `:` and the dedicated check names the reason.
const ID_CHARSET = /^[A-Za-z0-9._-]+$/;

/**
 * The ceiling on `run.replicas` (REQ-REPLICA-RUNS). Three, because `PI_CONCURRENCY` defaults to 3
 * (config.mjs) and replicas above the default concurrency would queue rather than race -- a cap that
 * promised a comparison the deployment could not deliver. A literal here rather than a read of the
 * concurrency setting: this validator is pure and fs-free, and the operator who raises concurrency to 10
 * is the operator who can raise this line too, in a reviewed commit.
 */
const REPLICAS_MAX = 3;

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * Parse, validate, and normalize the unified triggers file text. Returns an array of normalized
 * `{ on, run }` entries (unknown fields dropped, so consumers only ever read validated fields). Throws
 * `configError` (fail-loud) on any malformed entry. The `path` is for error messages only.
 */
export function parseTriggers(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`triggers file is not valid JSON: ${path} (${error.message})`);
	}

	const entries = parsed?.triggers;
	if (!Array.isArray(entries)) {
		throw configError(`triggers file must have a "triggers" array: ${path}`);
	}

	const state = { seenCronIds: new Set(), commentCounts: {} };
	return entries.map((entry, index) => normalizeTrigger(entry, index, path, state));
}

function normalizeTrigger(entry, index, path, state) {
	const at = `trigger at index ${index}`;

	if (entry === null || typeof entry !== "object") {
		throw configError(`${at}: must be an object: ${path}`);
	}
	const { on, run } = entry;
	if (on === null || typeof on !== "object") {
		throw configError(`${at}: "on" must be an object: ${path}`);
	}
	if (run === null || typeof run !== "object") {
		throw configError(`${at}: "run" must be an object: ${path}`);
	}
	if (!ON_TYPES.has(on.type)) {
		throw configError(`${at}: on.type must be one of cron|label|comment|pull_request (got ${JSON.stringify(on.type)}): ${path}`);
	}
	// The legal-values half of every message below is JOINED from the table rather than typed out, so a
	// forge added to the table can never be refused by a message that does not mention it -- which reads
	// to an operator as a bug in their file rather than in ours.
	if (!RUN_KINDS.includes(run.kind)) {
		throw configError(`${at}: run.kind must be one of ${RUN_KINDS.join("|")} (got ${JSON.stringify(run.kind)}): ${path}`);
	}

	// The on x run matrix -- the trust boundary, fail-loud (mirrors the old schedules kind:github refusal).
	if (on.type === "cron") {
		if (run.kind !== "local") {
			throw configError(`${at}: a cron trigger has no webhook delivery, issue/PR number, title, or body; run.kind must be "local" (got ${JSON.stringify(run.kind)}): ${path}`);
		}
		return normalizeCron(on, run, index, path, state);
	}
	if (!isForgeKind(run.kind)) {
		throw configError(`${at}: a ${on.type} trigger is webhook-driven and produces a forge job; run.kind must be one of ${FORGE_KINDS.join("|")} (got ${JSON.stringify(run.kind)}): ${path}`);
	}
	if (on.type === "label") return normalizeLabel(on, run, index, path);
	if (on.type === "comment") return normalizeComment(on, run, index, path, state);
	return normalizePullRequest(on, run, index, path);
}

function normalizeCron(on, run, index, path, state) {
	const at = `trigger at index ${index}`;

	const id = on.id;
	if (!isNonEmptyString(id)) {
		throw configError(`${at}: cron on.id must be a non-empty string: ${path}`);
	}
	if (id.includes(":")) {
		throw configError(`cron trigger "${id}": on.id must not contain ":" -- it corrupts the repeat:<id>:<millis> jobId parsing in the stall guard: ${path}`);
	}
	if (!ID_CHARSET.test(id)) {
		throw configError(`cron trigger "${id}": on.id must match [A-Za-z0-9._-]+: ${path}`);
	}
	if (state.seenCronIds.has(id)) {
		throw configError(`cron trigger "${id}": duplicate on.id (cron ids must be unique): ${path}`);
	}
	state.seenCronIds.add(id);

	const pattern = on.pattern;
	if (!isNonEmptyString(pattern)) {
		throw configError(`cron trigger "${id}": on.pattern must be a non-empty string: ${path}`);
	}
	const fieldCount = pattern.trim().split(/\s+/).length;
	if (fieldCount !== 5 && fieldCount !== 6) {
		throw configError(`cron trigger "${id}": on.pattern must have 5 or 6 space-separated fields, got ${fieldCount}: ${path}`);
	}

	if (!isNonEmptyString(run.folder)) {
		throw configError(`cron trigger "${id}": run.folder must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.flow)) {
		throw configError(`cron trigger "${id}": run.flow must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.task)) {
		throw configError(`cron trigger "${id}": run.task must be a non-empty string: ${path}`);
	}

	// Cron jobs are the zero-GitHub path by default; `run.github: true` is the per-trigger opt-in that
	// makes the worker mint the same scoped per-job token the github path mints, so the container can use
	// the gh CLI (INT-TRIGGERS-FILE-CONTRACT). Strictly boolean, fail-loud: a truthy string like "true"
	// silently opting a trigger into a credential is exactly the drift this validator exists to refuse.
	if (run.github !== undefined && typeof run.github !== "boolean") {
		throw configError(`cron trigger "${id}": run.github must be true or false when present: ${path}`);
	}

	const packages = validatePackagesFlag(run, `cron trigger "${id}"`, path);
	const image = validateImageRef(run, `cron trigger "${id}"`, path);
	const skillsDir = validateSkillsDir(run, `cron trigger "${id}"`, path);
	validateInstructions(run, `cron trigger "${id}"`, path, { cron: true });
	// RETURNED, not discarded like validateReplicas below, because `resume` still has a legal value on a
	// cron entry: only `true` is refused (the local path has nothing to resume with), so what survives is
	// `false` or absent. Both must keep reaching the job payload unchanged -- an operator who wrote down
	// today's default must not get a `data` that disagrees with the file they reviewed.
	const resume = validateResumeFlag(run, `cron trigger "${id}"`, path);
	// Called and DISCARDED: on a cron trigger this can only refuse, and the refusal is the point. The
	// returned `run` below deliberately grows no `replicas` key -- a cron entry can never carry one.
	validateReplicas(run, `cron trigger "${id}"`, path);

	// provider/model/maxTurns stay absent when omitted so the value resolves at job start against the
	// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT). github/packages/image stay
	// absent the same way -- and that matters more for `packages` now that absent means LOAD: writing a
	// `true` in here would make the schedule payload claim an opt-in the operator never wrote, and would
	// freeze today's default into every stored repeatable.
	return {
		on: { type: "cron", id, pattern },
		run: { kind: "local", folder: run.folder, flow: run.flow, task: run.task, provider: run.provider, model: run.model, maxTurns: run.maxTurns, github: run.github, packages, image, resume, ...(skillsDir !== undefined && { skillsDir }) },
	};
}

/**
 * Validate the per-trigger `run.packages` flag, shared by all four normalizers. It is an opt-OUT: the pi
 * packages an operator pinned into the global overlay load for every job, and `run.packages: false` is how a
 * single trigger withholds them (INT-TRIGGERS-FILE-CONTRACT, REQ-GLOBAL-PI-OVERLAY). Absent and `true` both
 * mean load; the default is resolved by the worker (run-container.mjs), never frozen into the file here.
 *
 * Still strictly boolean and still fail-loud, because the failure mode a loose parse produces has flipped
 * rather than gone away: `"false"` as a string is a trigger whose operator believes it runs no third-party
 * code while it loads all of it. A validator that accepted the string would make that belief undetectable.
 *
 * `at` is the caller's message prefix -- cron names its id, the webhook normalizers name their file index --
 * so every rejection still points at the entry the operator actually wrote. Returns the flag, undefined
 * when absent, so an unflagged trigger normalizes byte-identically to today's.
 */
function validatePackagesFlag(run, at, path) {
	if (run.packages !== undefined && typeof run.packages !== "boolean") {
		throw configError(`${at}: run.packages must be true or false when present: ${path}`);
	}
	return run.packages;
}

/**
 * Validate the per-trigger `run.resume` flag, shared by all four normalizers (REQ-RESUMABLE-SESSION).
 *
 * An opt-IN, and the POLARITY IS THE OPPOSITE of `run.packages` above -- deliberately, because the two
 * flags gate different kinds of thing. Staging a pi package is an operator act already performed, so the
 * set they staged is the set their jobs get and a trigger opts out. Persisting a session transcript is a
 * DISCLOSURE: the agent's full working history -- tool output, file contents, its own reasoning -- written
 * to host disk and replayed into a later job on the same key. Disclosures default off. Absent and `false`
 * both mean today's behaviour, with not one byte written to disk and no /session mount in the argv.
 *
 * REFUSED on a CRON trigger, and the refusal is the honest half of this validator rather than a limit of
 * the feature. `resolveSession` is handed to the FORGE preparers only (prepare.mjs); the local branch
 * returns before it is ever in scope, and prepare-local.mjs contains no session code at all -- so an armed
 * cron trigger stages no transcript, mounts no /session, promotes nothing, and then exits 0 as though it
 * had. `validateReplicas` states the argument in one line and it applies verbatim here: a field accepted
 * where it does nothing is how an operator comes to trust one that does nothing.
 *
 * "NOT YET COVERED", not impossible -- validateReplicas' own distinction, kept because the two are
 * different facts and an operator planning work needs the right one. The local key already exists and is
 * the strongest key in this feature: session-key.mjs keys a cron job on its scheduler id, which is
 * operator-authored, unique across the file, stable across fires, and chosen by nobody untrusted. Nothing
 * reaches it. Wiring `resolveSession` into the local path is a feature, and this line is what stops the
 * flag from pretending that feature landed in the meantime.
 *
 * Only `true` is refused, and the asymmetry with validateReplicas -- which refuses ANY value on cron -- is
 * deliberate. `run.replicas: 1` is refused because a one-member replica set is a flag that does nothing,
 * so the field has no legal no-op value; `run.resume: false` IS the documented default, so refusing it
 * would refuse an operator for writing down the behaviour they already have, and would change a normalized
 * shape that has to stay byte-identical.
 *
 * Strictly boolean and fail-loud, the house rule -- and here the damaging misreading is a truthy `"false"`
 * string, which reads to an operator as an opt-out and would arm the disclosure instead. That is the exact
 * inversion validatePackagesFlag's own comment describes, arriving from the other direction.
 *
 * Type here, reality at job start, exactly as `run.image` splits it: this cannot know whether
 * PI_SESSIONS_DIR is set, whether a key resolves, or whether a transcript exists. Those are the worker's
 * to answer, and all but the first degrade to a cold start rather than refusing -- the first is the one
 * pre-spend policy refusal, `sessions-dir-unset` in processor.mjs (REQ-RESUMABLE-SESSION fails CLOSED
 * there and only there).
 *
 * `at` is the caller's message prefix. Returns the flag, undefined when absent, so an unflagged trigger
 * normalizes byte-identically to today's.
 */
function validateResumeFlag(run, at, path) {
	if (run.resume !== undefined && typeof run.resume !== "boolean") {
		throw configError(`${at}: run.resume must be true or false when present: ${path}`);
	}
	// `run.kind === "local"` IS "this is a cron trigger": normalizeTrigger has already refused every other
	// pairing of on.type and run.kind, so the matrix makes the two synonyms. The same test validateReplicas
	// keys its first refusal on, for the same reason -- neither wants to be re-taught the matrix.
	if (run.resume === true && run.kind === "local") {
		throw configError(
			`${at}: run.resume is not yet covered for cron triggers (forge triggers only in this version) -- resolveSession is handed to the forge preparers only, so a local job would stage no transcript, mount no /session and promote nothing, then exit 0 as though it had; the local session key exists in session-key.mjs and nothing reaches it, so this is a gap to close, not a limit: ${path}`,
		);
	}
	return run.resume;
}

/**
 * Validate the per-trigger `run.image` reference, shared by all four normalizers. It selects the Docker image
 * this trigger's job containers run in, overriding the deployment-wide `PI_JOB_IMAGE` for this trigger only;
 * absent means the deployment default, resolved by the worker (image-preflight.mjs) and never frozen into the
 * file here. Carried on all four kinds rather than cron only, for the same reason `run.packages` is: a
 * toolchain is a capability of the FLOW, and a label/comment/PR trigger runs the flows a cron trigger runs.
 *
 * Deliberately NOT a shape check. `run.folder` -- also an operator-authored host reference -- is validated
 * here as a non-empty string only, with existence deferred to the one place that can actually know; run.image
 * gets exactly that split: type here, reality at job start via a pre-spend `docker image inspect`. A regex
 * over the OCI reference grammar would refuse the rarer half of the problem (a malformed name) while missing
 * the common half (a well-formed name for an image nobody built), and an over-strict one would refuse a
 * legitimate `registry.internal:5000/team/img:1.2@sha256:...` and take the whole worker down at boot for a
 * valid deployment. Docker validates its own grammar; we do not.
 *
 * A floating tag is likewise accepted, not warned. CONST-PI-VERSION-PINNED fears UNATTENDED drift, and that
 * mechanism does not exist here: with `--pull=never` a local tag can only move when a human runs `docker
 * pull` or `docker build` on this host, which is the explicit act the constraint asks for. Refusing `:latest`
 * would also make `run.image: "pi-job:latest"` illegal while `PI_JOB_IMAGE=pi-job:latest` is the shipped
 * default -- an incoherence an operator would rightly file as a bug.
 *
 * The three refusals below are not grammar. Each names a value that would corrupt something on OUR side: a
 * non-string reaches `args.push(image)` and becomes a garbage argv token; an empty string is falsy and throws
 * inside buildDockerRunArgs AFTER the budget slot is reserved; and a leading `-` lands in the image positional
 * where docker's flag parser reads it as a flag, which is the one value that stops docker-run.mjs's
 * explicit-array argv from being injection-free by inspection. Whitespace is refused rather than trimmed
 * because the file is the reviewed artifact: it must not disagree with what runs.
 *
 * `at` is the caller's message prefix, exactly as validatePackagesFlag's is. Returns the reference, undefined
 * when absent, so an unflagged trigger normalizes byte-identically to today's.
 */
function validateImageRef(run, at, path) {
	const image = run.image;
	if (image === undefined) return undefined;
	if (typeof image !== "string" || image.trim() === "") {
		throw configError(`${at}: run.image must be a non-empty string when present: ${path}`);
	}
	if (image !== image.trim()) {
		throw configError(`${at}: run.image must not have leading or trailing whitespace (got ${JSON.stringify(image)}): ${path}`);
	}
	if (image.startsWith("-")) {
		throw configError(`${at}: run.image must not start with "-" -- it is passed as the image positional in the docker argv, where a leading dash parses as a flag (got ${JSON.stringify(image)}): ${path}`);
	}
	return image;
}

/**
 * `run.skillsDir` (issue #60): a directory of operator-authored skills on the WORKER host, copied into
 * this trigger's jobs and layered between the repo's own `.pi/skills` and the global overlay.
 *
 * Accepted on all four run kinds, for `run.image`'s reason restated: a skill set is a capability of the
 * FLOW, and a label/comment/PR trigger runs the flows a cron trigger runs. The copy site in prepare.mjs
 * is shared by every kind, so accepting it everywhere accepts it where it works.
 *
 * TWO checks are deliberately NOT here, and both would be bugs if they were.
 *
 * EXISTENCE is not checked, because BOTH services parse this file and the receiver may run on a
 * different host entirely, where a worker-side path means nothing. That is `run.folder`'s split
 * exactly: type here, reality where it can be known -- at worker boot for cron (schedules.mjs) and
 * pre-spend per job for every kind (processor.mjs).
 *
 * ABSOLUTENESS is not checked either, and this one is subtler. `path.isAbsolute` is OS-DEPENDENT:
 * `"C:\\skills"` is absolute on win32 and relative on posix. This worker is cross-platform (see
 * materialize.mjs's safeJoin, written with path.relative for that reason), so enforcing it in the
 * SHARED validator would let a Windows worker and a Linux receiver disagree about whether the same
 * reviewed file is valid -- a file that loads on one service and refuses on the other is worse than a
 * late refusal. The worker enforces it where the answer is knowable.
 *
 * No charset either: this is an absolute host path chosen by an operator who can already name any path
 * in `run.folder`, so traversal is not a threat model here. Containment is enforced where it can be, on
 * the DESTINATION side, by copy-tree.mjs's validated-segment rebuild and safeJoin.
 */
function validateSkillsDir(run, at, path) {
	const dir = run.skillsDir;
	if (dir === undefined) return undefined;
	if (typeof dir !== "string" || dir.trim() === "") {
		throw configError(`${at}: run.skillsDir must be a non-empty string when present: ${path}`);
	}
	// Whitespace is refused rather than trimmed, for validateImageRef's reason: the file is the reviewed
	// artifact and must not disagree with what runs.
	if (dir !== dir.trim()) {
		throw configError(`${at}: run.skillsDir must not have leading or trailing whitespace (got ${JSON.stringify(dir)}): ${path}`);
	}
	return dir;
}

/**
 * The ceiling on `run.instructions` (REQ-PER-TRIGGER-INSTRUCTION, issue #60).
 *
 * NOT a caching bound, and the entry says so rather than letting a reader assume it. The text is written
 * once into /job/prompt.md and `session.prompt()` is called once, so the pattern
 * CONST-PERSONA-IN-CACHED-PREFIX names -- injecting a persistent user message on every prompt -- is not
 * what this is; and at the pin, pi-ai attaches cache_control to the LAST USER MESSAGE as well as the
 * system prompt, so after turn one this sits in the cached prefix at roughly the persona's rate anyway.
 *
 * What the cap is actually for is two other things. A field with no bound invites a 200 KB style guide
 * pasted in, which overflows context inside a PAID container on every delivery of that trigger, with no
 * pre-spend signal -- a cap turns that into a free load-time refusal in both services. And it keeps the
 * field in its lane: a standing instruction is a sentence or two, and anything longer belongs in the
 * flow's own SKILL.md (versioned, reviewed) or in the overlay persona (deploy-time, system prompt). The
 * refusal message names both destinations, so the cap teaches rather than merely blocks.
 */
const INSTRUCTIONS_MAX = 2000;

/**
 * `run.instructions` (issue #60): one line of operator standing text, rendered into the USER prompt's
 * envelope above the fenced data region.
 *
 * REFUSED on cron, and it is a DIFFERENT refusal from run.replicas' "not yet covered": cron already has
 * an operator-authored free-text field landing in the same region of the same file. A local job's prompt
 * is `flow hint + pointer + run.task` with no envelope, no data heading and no fence (prepare.mjs), so
 * there is no "standing" region distinct from the task for a second field to occupy. Two fields writing
 * one region with an undefined combination order is worse than a field that does nothing, because both
 * would appear to work.
 *
 * Whitespace is NOT refused here, unlike run.image, and the divergence is deliberate: that rule exists
 * because whitespace changes what an image REFERENCE means, and it does not change what prose means. A
 * trailing newline in a multi-line JSON string is a papercut, not a hazard. A whitespace-ONLY value is
 * refused, because that is a field the operator believes they set.
 *
 * Refused rather than truncated at the cap, for validateImageRef's reason: the file is the reviewed
 * artifact and must not disagree with what runs.
 */
function validateInstructions(run, at, path, { cron = false } = {}) {
	const text = run.instructions;
	if (text === undefined) return undefined;
	if (cron) {
		throw configError(`${at}: run.instructions is not accepted on a cron trigger -- a local job's prompt IS run.task, the same operator-authored text in the same place. Put the standing instruction at the top of run.task: ${path}`);
	}
	if (typeof text !== "string" || text.trim() === "") {
		throw configError(`${at}: run.instructions must be a non-empty string when present: ${path}`);
	}
	if (text.length > INSTRUCTIONS_MAX) {
		throw configError(`${at}: run.instructions is ${text.length} characters, over the ${INSTRUCTIONS_MAX} cap -- a standing instruction is a sentence or two. Anything longer belongs in the flow's own SKILL.md, or in the global overlay's APPEND_SYSTEM.md if it applies to every job: ${path}`);
	}
	return text;
}

/**
 * Validate an `{any, all, none}` label predicate. Selectors are validated as arrays of non-empty strings
 * BEFORE the positive-selector count, because `.length` is truthy on a string too -- a string selector
 * that reached the pure `matchesRule` in the receiver would throw there, breaking the gate's never-throw
 * invariant. Returns the normalized `{any, all, none}`.
 */
function validatePredicate(on, index, path, requirePositive) {
	const at = `trigger at index ${index}`;
	for (const key of ["any", "all", "none"]) {
		const selector = on[key];
		if (selector === undefined) continue;
		if (!Array.isArray(selector) || selector.some((s) => typeof s !== "string" || s.trim() === "")) {
			throw configError(`${at}: on.${key} must be an array of non-empty strings: ${path}`);
		}
	}
	// A `none`-only rule matches every event lacking the excluded labels -- wider than a single-label
	// allowlist, which would weaken CONST-TRIGGER-AUTHOR-GATE. Require a positive selector where the
	// predicate IS the approval gate (label triggers, and `labeled` PR triggers).
	if (requirePositive && (on.any?.length ?? 0) + (on.all?.length ?? 0) === 0) {
		throw configError(`${at}: needs at least one positive selector (on.any or on.all): ${path}`);
	}
	return { any: on.any, all: on.all, none: on.none };
}


/**
 * `run.repository` -- WHICH repository a job clones, for a forge whose trigger subject does not name one.
 *
 * Azure DevOps is the only such forge so far, and the gap is real rather than cosmetic: a work item belongs
 * to a PROJECT, and a project may hold many repositories, so `workitem.updated` says nothing about where
 * the agent should work. A pull request names its own repository and needs none.
 *
 * REQUIRED on exactly the azure trigger types a work item can fire (`label`, `comment`) and REFUSED on the
 * others, rather than accepted-and-ignored. A field that is silently unused is a field an operator will set
 * and then trust; refusing it is how they find out it does nothing here.
 */
function validateRepository(run, onType, at, path) {
	const needed = run.kind === "azure" && (onType === "label" || onType === "comment");
	const raw = run.repository;
	if (raw === undefined) {
		if (!needed) return undefined;
		throw configError(`${at}: an azure ${onType} trigger must set run.repository -- a work item belongs to a project, not a repository, so nothing in the delivery says where to clone: ${path}`);
	}
	if (!needed) {
		throw configError(`${at}: run.repository is only meaningful on an azure label or comment trigger (a pull request names its own repository): ${path}`);
	}
	if (!isNonEmptyString(raw) || raw !== raw.trim() || raw.includes("/")) {
		throw configError(`${at}: run.repository must be a non-empty repository NAME within the project, with no slashes and no surrounding whitespace (got ${JSON.stringify(raw)}): ${path}`);
	}
	return raw;
}

/**
 * `run.replicas` -- how many independent sandboxes race this trigger's flow (REQ-REPLICA-RUNS).
 *
 * The one field in this file that MULTIPLIES SPEND, so every refusal below is deliberate and none of them
 * is accepted-and-ignored. It is the second kind-conditional field, after `run.repository`, and it takes
 * that one's posture: a field that is silently unused is a field an operator will set and then trust.
 *
 * WHY EACH REFUSAL:
 *   - a LOCAL (cron) trigger: its `/workspace` IS the operator's folder, bind-mounted read-write and edited
 *     in place, so two replicas would stomp each other's working tree with no gate and no undo. A github
 *     job gets its own `mkdtemp`'d clone, which is the entire reason this is safe there and not here.
 *     Checked FIRST so a cron trigger gets that reason rather than the forge-coverage one below.
 *   - a non-github forge: every forge mints its branch through the same `issueBranch`, so extending this is
 *     mechanical -- but it is not done, and the message says "not yet covered" rather than "impossible"
 *     because those are different facts and an operator planning work needs the right one.
 *   - a non-integer, `< 2`, or `> REPLICAS_MAX`. `1` is REFUSED rather than accepted: a one-member replica
 *     set is a field that does nothing, and this validator's whole job is to make sure nothing does nothing.
 *   - `run.resume: true`. A resumed run continues ONE lineage; replicas exist to fork it. This is the
 *     refusal `session-key.mjs` depends on to keep calling `issueBranch` with a single argument -- without
 *     it every replica of an issue resolves the same session key, shares one transcript, and fights the
 *     store's one-writer lock. Stated in all three files, because the coupling is invisible from any one.
 *
 * Called from ALL FOUR normalizers -- including `normalizeCron`, which discards the result because there it
 * can only ever refuse. That is `validateRepository`'s idiom and it exists for the same reason: a field
 * accepted where it does nothing is how an operator comes to trust one that does nothing. Deliberately NOT
 * `run.github`'s by-placement asymmetry, which lets a webhook trigger drop the field in silence.
 *
 * `at` is the caller's message prefix. Returns the count, undefined when absent, so an unflagged trigger
 * normalizes byte-identically to today's.
 */
function validateReplicas(run, at, path) {
	const replicas = run.replicas;
	if (replicas === undefined) return undefined;
	if (run.kind === "local") {
		throw configError(`${at}: run.replicas is not available on a cron trigger -- a local job's /workspace IS the operator's folder, bind-mounted read-write, so two replicas would edit one working tree with no gate and no undo: ${path}`);
	}
	if (run.kind !== "github") {
		throw configError(`${at}: run.replicas is not yet covered for ${run.kind} triggers (github only in this version); every forge mints its branch the same way, so this is a gap to close, not a limit: ${path}`);
	}
	if (!Number.isInteger(replicas) || replicas < 2 || replicas > REPLICAS_MAX) {
		throw configError(`${at}: run.replicas must be an integer between 2 and ${REPLICAS_MAX} when present -- ${REPLICAS_MAX} is the ceiling because PI_CONCURRENCY defaults to 3, so a further replica would queue instead of racing, and 1 is refused because a one-member replica set is a flag that does nothing (got ${JSON.stringify(replicas)}): ${path}`);
	}
	if (run.resume === true) {
		throw configError(`${at}: run.replicas and run.resume cannot be combined -- a resumed run continues one lineage and replicas exist to fork it, so every replica would resolve the same session key and share one transcript: ${path}`);
	}
	return replicas;
}

function normalizeLabel(on, run, index, path) {
	const at = `trigger at index ${index}`;
	const predicate = validatePredicate(on, index, path, true);
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: label trigger run.flow must be a non-empty string: ${path}`);
	}
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	const skillsDir = validateSkillsDir(run, at, path);
	const instructions = validateInstructions(run, at, path);
	const resume = validateResumeFlag(run, at, path);
	const repository = validateRepository(run, "label", at, path);
	const replicas = validateReplicas(run, at, path);
	return {
		on: { type: "label", any: predicate.any, all: predicate.all, none: predicate.none },
		run: { kind: run.kind, flow: run.flow, packages, image, resume, replicas, ...(skillsDir !== undefined && { skillsDir }), ...(instructions !== undefined && { instructions }), ...(repository !== undefined && { repository }) },
	};
}

function normalizeComment(on, run, index, path, state) {
	const at = `trigger at index ${index}`;
	if (!isNonEmptyString(on.phrase)) {
		throw configError(`${at}: comment trigger on.phrase must be a non-empty string: ${path}`);
	}
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: comment trigger run.flow (the default flow) must be a non-empty string: ${path}`);
	}
	// At most one comment trigger PER FORGE. The cap exists because the receiver holds one comment rule
	// per forge and a second would be silently unreachable -- so it is a cap on ambiguity, not on count,
	// and a deployment serving GitHub and GitLab is entitled to the same `@pi` phrase on each.
	state.commentCounts[run.kind] = (state.commentCounts[run.kind] ?? 0) + 1;
	if (state.commentCounts[run.kind] > 1) {
		throw configError(`${at}: at most one ${run.kind} comment trigger is allowed: ${path}`);
	}
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	const skillsDir = validateSkillsDir(run, at, path);
	const instructions = validateInstructions(run, at, path);
	const resume = validateResumeFlag(run, at, path);
	const repository = validateRepository(run, "comment", at, path);
	const replicas = validateReplicas(run, at, path);
	return {
		on: { type: "comment", phrase: on.phrase },
		run: { kind: run.kind, flow: run.flow, packages, image, resume, replicas, ...(skillsDir !== undefined && { skillsDir }), ...(instructions !== undefined && { instructions }), ...(repository !== undefined && { repository }) },
	};
}

function normalizePullRequest(on, run, index, path) {
	const at = `trigger at index ${index}`;

	const actions = on.action;
	if (!Array.isArray(actions) || actions.length === 0) {
		throw configError(`${at}: pull_request on.action must be a non-empty array: ${path}`);
	}
	// Validated against THIS entry's forge, in that forge's own words. A GitHub word on a GitLab trigger
	// (or the reverse) is refused here rather than left to never match at run time.
	const allowed = PR_ACTIONS[run.kind];
	const expected = [...allowed].join("|");
	for (const a of actions) {
		if (!allowed.has(a)) {
			throw configError(`${at}: pull_request on.action has an unsupported ${run.kind} action ${JSON.stringify(a)} (expected ${expected}): ${path}`);
		}
	}

	const reviewState = validateReviewState(on, actions, run, at, path);

	// A `labeled` PR trigger is gated by its label predicate (the collaborator-applied label is the
	// approval), so it MUST carry a positive selector -- exactly as a label trigger does. Auto actions
	// (opened/synchronize/reopened) are gated by author_association in the filter, so a predicate is
	// optional there and only narrows scope when present.
	//
	// WHICH word that is, and whether the forge has one at all, lives in the forge table rather than being
	// tested by name here. GitLab's is null: a label added to a merge request arrives as a plain `update`,
	// so there is no action for the rule to attach to. Forgejo's is `label_updated`.
	const labelAction = forgeSpec(run.kind)?.prLabelAction;
	const requirePositive = typeof labelAction === "string" && actions.includes(labelAction);

	// Azure attaches tags to WORK ITEMS and never to pull requests, so a predicate on an azure pull_request
	// rule cannot match anything. Refusing it is the same fail-loud call the action vocabulary gets: a rule
	// that loads clean and can never fire reads to an operator as a harness that is broken.
	if (run.kind === "azure" && (on.any !== undefined || on.all !== undefined || on.none !== undefined)) {
		throw configError(`${at}: an azure pull_request trigger cannot carry a label predicate -- Azure DevOps attaches tags to work items, never to pull requests, so any/all/none could never match: ${path}`);
	}
	const predicate = validatePredicate(on, index, path, requirePositive);
	if (!isNonEmptyString(run.flow)) {
		throw configError(`${at}: pull_request trigger run.flow must be a non-empty string: ${path}`);
	}
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	const skillsDir = validateSkillsDir(run, at, path);
	const instructions = validateInstructions(run, at, path);
	const resume = validateResumeFlag(run, at, path);
	validateRepository(run, "pull_request", at, path);
	const replicas = validateReplicas(run, at, path);
	return {
		on: {
			type: "pull_request",
			action: [...actions],
			// Absent rather than present-and-undefined: an unnarrowed rule's normalized shape must stay
			// byte-identical to the one every pre-#66 trigger file produces.
			...(reviewState !== undefined && { reviewState }),
			any: predicate.any,
			all: predicate.all,
			none: predicate.none,
		},
		run: { kind: run.kind, flow: run.flow, packages, image, resume, replicas, ...(skillsDir !== undefined && { skillsDir }), ...(instructions !== undefined && { instructions }) },
	};
}

/**
 * The optional `on.reviewState` narrowing (issue #66). Returns the normalized array, or `undefined` when
 * unset, which means every verdict fires.
 *
 * All four refusals are the same call the action vocabulary makes at the top of `normalizePullRequest`: a
 * narrowing that can never apply does not crash anything downstream, it simply sits in the file looking
 * configured while the trigger either fires on everything or on nothing. Refusing at load is what turns
 * that into a message. The `review_submitted` requirement is the sharpest of the four -- a `reviewState`
 * beside `["opened","synchronize"]` reads as "only run for these verdicts" and does the exact opposite.
 */
function validateReviewState(on, actions, run, at, path) {
	if (on.reviewState === undefined) return undefined;
	if (run.kind !== "github") {
		throw configError(`${at}: on.reviewState is github-only (got ${run.kind}), no other forge reports a review verdict: ${path}`);
	}
	if (!actions.includes(REVIEW_ACTION)) {
		throw configError(`${at}: on.reviewState requires on.action to include ${JSON.stringify(REVIEW_ACTION)}, otherwise it narrows nothing: ${path}`);
	}
	if (!Array.isArray(on.reviewState) || on.reviewState.length === 0) {
		throw configError(`${at}: on.reviewState must be a non-empty array: ${path}`);
	}
	const expected = [...REVIEW_STATES].join("|");
	for (const s of on.reviewState) {
		if (!REVIEW_STATES.has(s)) {
			throw configError(`${at}: on.reviewState has an unsupported review state ${JSON.stringify(s)} (expected ${expected}): ${path}`);
		}
	}
	return [...on.reviewState];
}
