/**
 * Shared trigger-file schema + validator (issue #20). One `triggers.json` of `{ on, run }` entries is
 * the single reviewed source of standing triggers for BOTH services: the worker owns `on.type:"cron"`
 * (local jobs), the receiver owns the webhook types (`label|comment|pull_request|issue` -> a forge job). Each
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

import { EGRESS_ENV_VARS, WORKER_ONLY_SECRET_VARS, configError } from "./config.mjs";
// SKILL_NAME_RE is the single-sourced skill charset (flow-gate exports it for exactly this reason:
// materialize.mjs and the admin already import it, and a keep-in-sync copy would drift where a
// traversal guard cannot). flow-gate's module body is import-inert, so this keeps parseTriggers pure.
import { SKILL_NAME_RE } from "./flow-gate.mjs";
import { FORGE_HOST_VARS, FORGE_KINDS, MINTED_TOKEN_VARS, RUN_KINDS, forgeSpec, isForgeKind } from "./forges.mjs";
import { CONTAINER_ENV_NAMES } from "./reserved-env.mjs";

const ON_TYPES = new Set(["cron", "label", "comment", "pull_request", "issue"]);

/**
 * The `on.type` a DISARMED one-shot normalizes to (issue #231). Producible only by this validator:
 * `ON_TYPES` excludes it, so an authored `on.type: "disarmed"` refuses like any unknown type. The
 * sentinel keeps the entry's raw array position (deleting it would shift `triggerIndex` attribution
 * for every later entry) while making it unmatchable BY CONSTRUCTION -- it carries no selectors, no
 * actions, no run.kind and no flow, so no receiver group, no schedule and no flow allowlist can ever
 * pick it up. A marker flag on the original type was rejected: one consumer forgetting to check it
 * is a spent one-shot firing again, and this shape makes that bug unwritable.
 */
export const DISARMED_TYPE = "disarmed";

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
 * `changes.labels` diff, and `open`/`reopen` are its spellings of `opened`/`reopened`.
 *
 * The close words (issue #231) carry a distinction the old "nothing left to act on" wording folded
 * flat. A job ABOUT the closed thing still has nothing left to act on, and `run.replicas`' neighbour
 * refusal still stands; what a close CAN do is release separately-armed work -- an operator wrote
 * "when this closes, run that" into this file, and the close is the starting gun, not the subject.
 * So `closed`/`close` are close-ONLY action lists (mixing them with other actions is refused below:
 * the two families gate on different actors), while `merge` stays omitted everywhere -- GitHub and
 * Forgejo emit `closed` for a merged PR so close rules cover merges there, and GitLab's `merge` is
 * its own action no rule takes (an explicit close is what fires a GitLab close rule; the spec names
 * the gap).
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
	github: new Set(["labeled", "opened", "synchronize", "reopened", "review_submitted", "closed"]),
	// GitLab's `approved` is its review gate (a member approved the MR). It is NOT github's
	// `review_submitted` renamed: `approved` is one verdict, `review_submitted` is every verdict, which is
	// what `on.reviewState` below exists to narrow. `close` is GitLab's own spelling of the close action.
	gitlab: new Set(["open", "update", "reopen", "approved", "close"]),
	// Forgejo's own spellings. `label_updated` is its `labeled` and `synchronized` its `synchronize` -- a
	// one-letter difference that an operator would otherwise discover as a trigger that loads clean and
	// never fires. `label_cleared` is deliberately ABSENT and always will be: REMOVING a label must never
	// start a paid run, and it has no GitHub counterpart to inherit that rule from.
	forgejo: new Set(["label_updated", "opened", "synchronized", "reopened", "closed"]),
	// Azure's Service Hook events reduced to the two that leave something to act on. `git.pullrequest.merged`
	// is omitted for the reason the close words' own comment above records, and there is no close word here at
	// all: an abandon arrives as `git.pullrequest.updated` with nothing in the projected subset to tell it from
	// any other update, so an azure close rule could only ever fire on the wrong events or never. Widening
	// INT-AZURE-PAYLOAD-SUBSET (a PR status field) is the gap to close before this set can grow. There is no
	// label action either -- Azure attaches tags to WORK ITEMS, never to pull requests -- which is why azure's
	// `prLabelAction` is null and a predicated PR rule is refused below.
	azure: new Set(["created", "updated"]),
};

/**
 * The one action per forge that closes a pull request, in that forge's own words (issue #231). Spelled
 * once because three places turn on it: the close-only refusal in `normalizePullRequest` (a close rule
 * gates on the CLOSER's write access, every other PR rule gates on the author's association or a
 * collaborator's label, and one rule cannot gate on two different actors), the `capable` switch that
 * admits `on.number`/`on.once` there, and the queue's semantic-key discriminant. Azure is absent for
 * the subset reason the table above records, so `PR_ACTIONS.azure` simply never grows the word and the
 * existing vocabulary refusal names azure on its own.
 *
 * EXPORTED for the two consumers that must never re-derive it: the receiver's grouping (a close-only
 * rule routes through the close gate, every other PR rule through the author gate, and the split must
 * be THIS table's) and the queue's semantic-key discriminant (a matched close action word is what
 * marks a close job).
 */
export const PR_CLOSE_ACTIONS = { github: "closed", gitlab: "close", forgejo: "closed" };

/**
 * The `issue` action vocabulary, per forge, in each forge's own words (issue #231). One word each so
 * far: the type exists for "when issue #40 closes, run deploy", and every other issue event already
 * has a home (`label` for label predicates, `comment` for phrases). GitLab's word is `close` (its
 * `object_attributes.action`), GitHub's and Forgejo's is `closed`.
 *
 * Azure is REFUSED rather than absent-and-unhandled, with its own message: a work item's close is a
 * `System.State` transition whose terminal names vary by process template (Agile "Closed", Scrum
 * "Done", plus "Resolved"), and the projected subset carries only `System.Tags` -- so matching a
 * close needs both an INT-AZURE-PAYLOAD-SUBSET widening and a state vocabulary this version does not
 * guess at. Not yet covered, not impossible -- validateResumeFlag's distinction, kept for the same
 * reason.
 */
const ISSUE_ACTIONS = {
	github: new Set(["closed"]),
	gitlab: new Set(["close"]),
	forgejo: new Set(["closed"]),
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

/**
 * The ceiling on how many references one trigger may name (issue #225). Not tidiness: the worker resolves
 * them SEQUENTIALLY, before the container, each with its own timeout, so N references hold a
 * `PI_CONCURRENCY` slot for up to N x PI_SECRET_RESOLVE_TIMEOUT_MS inside the job's own 30-minute kill
 * timer. A cap at load turns an unbounded slot occupancy into a bounded one for free, before anything
 * runs. It bounds the host argv too: every resolved value is pushed as `-e NAME=VALUE` (docker-run.mjs).
 *
 * Sixteen rather than three: unlike `REPLICAS_MAX` this multiplies no spend, and a deploy job legitimately
 * wants a handful of credentials. A literal for REPLICAS_MAX's reason -- this validator is pure and fs-free.
 */
const SECRETS_MAX = 16;

/**
 * A POSIX environment variable name. Nothing in this repo validated one before `run.secrets` (checked), so
 * this is the definition rather than a copy of one. Deliberately stricter than what `execve` would accept:
 * a name is `-e NAME=VALUE` in the docker argv, so `=` would split in the wrong place, and the leading
 * digit is excluded because a shell cannot expand `$1FOO` as that variable.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The env variable names a trigger may NOT bind, and why each set is here.
 *
 * These are the STATICALLY KNOWABLE half. `parseTriggers` is pure, fs-free and env-free, so it cannot see
 * the resolved provider's credential variable names (they come from `findEnvKeys(provider, hostEnv)`) or
 * the deployment's `PI_FORWARD_ENV` list. Those two are refused PRE-SPEND in the processor, where both are
 * in hand -- the same load-time / deployment-state split `run.resume` already makes against
 * `PI_SESSIONS_DIR`. Refusing here what can be answered here keeps the file's own mistakes in the file's
 * own error.
 *
 * Every set is IMPORTED, never retyped, which is the rule `sandbox.test.mjs` keeps for the same reason: a
 * forge added to the table later must not need a second edit here to stay covered.
 */
const RESERVED_ENV_NAMES = new Set([...MINTED_TOKEN_VARS, ...FORGE_HOST_VARS, ...WORKER_ONLY_SECRET_VARS, ...EGRESS_ENV_VARS, ...CONTAINER_ENV_NAMES]);

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
	// Joined from the set for the joined-vocabulary rule stated over the run.kind check below -- a type
	// added to the vocabulary can never be
	// refused by a message that does not mention it. This is also what keeps `DISARMED_TYPE` refused
	// when authored: it is deliberately not in ON_TYPES, so it reads here as any other unknown type.
	if (!ON_TYPES.has(on.type)) {
		throw configError(`${at}: on.type must be one of ${[...ON_TYPES].join("|")} (got ${JSON.stringify(on.type)}): ${path}`);
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
	let normalized;
	if (on.type === "label") normalized = normalizeLabel(on, run, index, path);
	else if (on.type === "comment") normalized = normalizeComment(on, run, index, path, state);
	else if (on.type === "issue") normalized = normalizeIssue(on, run, index, path);
	else normalized = normalizePullRequest(on, run, index, path);

	// A disarmed one-shot has validated IN FULL above (a disarmed entry with a malformed run still
	// refuses the file -- writeTriggers' fail-closed contract needs the whole file valid, and the
	// worker's disarm only ever ADDS one key to an entry that already passed). Only then does it
	// normalize to the sentinel, so its raw index survives and nothing downstream can match it.
	if (on.disarmed !== undefined) return { on: { type: DISARMED_TYPE }, run: {} };
	return normalized;
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

	// FIRST among the run checks (all four normalizers do this), so a command-only entry is never told to
	// add the flow it deliberately does not have, and a flow+command entry gets the exclusion message
	// rather than whichever single-field check happens to run first.
	const command = validateCommand(run, `cron trigger "${id}"`, path, { onType: "cron" });

	if (!isNonEmptyString(run.folder)) {
		throw configError(`cron trigger "${id}": run.folder must be a non-empty string: ${path}`);
	}
	if (command === undefined && !isNonEmptyString(run.flow)) {
		throw configError(`cron trigger "${id}": run.flow must be a non-empty string (or use run.command): ${path}`);
	}
	// Gated on the flow path only: a command job's prompt IS the command line, and validateCommand has
	// already refused any run.task written beside one.
	if (command === undefined && !isNonEmptyString(run.task)) {
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
	// Same posture for the close-trigger fields (issue #231): none has a legal value on cron.
	validateNumber(on, `cron trigger "${id}"`, path, { onType: "cron" });
	validateOnce(on, run, `cron trigger "${id}"`, path, { onType: "cron" });
	validateDisarmed(on, `cron trigger "${id}"`, path, { onType: "cron" });
	const secrets = validateSecrets(run, `cron trigger "${id}"`, path);
	const secretsProfile = validateSecretsProfile(run, `cron trigger "${id}"`, path);

	// provider/model/maxTurns stay absent when omitted so the value resolves at job start against the
	// settings overlay/env, not a default frozen here (INT-CONFIG-OVERLAY-CONTRACT). github/packages/image stay
	// absent the same way -- and that matters more for `packages` now that absent means LOAD: writing a
	// `true` in here would make the schedule payload claim an opt-in the operator never wrote, and would
	// freeze today's default into every stored repeatable.
	return {
		on: { type: "cron", id, pattern },
		run: { kind: "local", folder: run.folder, flow: run.flow, task: run.task, provider: run.provider, model: run.model, maxTurns: run.maxTurns, github: run.github, packages, image, resume, ...(command !== undefined && { command }), ...(skillsDir !== undefined && { skillsDir }), ...(secrets !== undefined && { secrets }), ...(secretsProfile !== undefined && { secretsProfile }) },
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
 * "NOT YET COVERED", not impossible -- a distinction this file keeps because the two are different facts
 * and an operator planning work needs the right one. `run.replicas` carried the same wording for the same
 * reason until #187 closed its gap; this one is still open, which is why the phrasing outlived it. The local key already exists and is
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
 * REFUSED on cron, and it is a DIFFERENT refusal from the "not yet covered" shape (run.resume's, since
 * #187 retired run.replicas'): cron already has an operator-authored free-text field landing in the same
 * region of the same file. A local job's prompt
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
 * `run.command` (issue #189): dispatch a REGISTERED pi extension command headlessly, instead of a flow.
 * The runner half is already merged: it exports the name via PI_COMMAND, refuses pre-spend when
 * `getCommand` does not know it, and prompts with the exact `/name args` line and nothing else, so the
 * arguments reach the command handler precisely as written here. Shared by all four normalizers so both
 * services refuse the same file identically; the runner re-validates at the paid boundary regardless.
 *
 * EXACTLY ONE of run.flow / run.command, and the exclusion is checked BEFORE every normalizer's
 * flow-required check on purpose: the two mistakes need their own messages. A flow+command entry no
 * longer says which one runs and must hear that, not whichever single-field complaint fires first; a
 * command-only entry must never be told to add the flow it deliberately does not have.
 *
 * The value rules each refuse something specific:
 *   - no leading "/": the runner PREPENDS the slash when it builds the prompt, so a written one would
 *     dispatch "//name" -- a command no registry holds, refused only after review already passed it.
 *   - surrounding whitespace is REFUSED, never trimmed (validateImageRef's rule): the arguments pass to
 *     the handler verbatim, so a silent trim is the reviewed file disagreeing with what runs.
 *   - no control characters. A newline would smuggle a SECOND line into what the operator reviewed as
 *     one command line, and the whole class is refused rather than the newline alone because every
 *     member is invisible in review, which is the hazard. The regex is spelled in \u escapes for the
 *     same reason: a literal ESC in this source would be exactly the unreviewable byte it refuses.
 *
 * Cross-field refusals, validateReplicas' posture (a field accepted where it does nothing is one an
 * operator sets and then trusts):
 *   - run.task on cron: a command job's prompt IS the `/name args` line, so there is no task text for
 *     the runner to render -- two prompts written for one job, with only one ever sent.
 *   - run.instructions on the webhook kinds: instructions land in the prompt ENVELOPE, which a command
 *     job bypasses entirely, so nothing would render them. (Cron refuses instructions already, with its
 *     own run.task message, and that refusal stays the one a cron entry gets.)
 *   - run.resume: true on any kind: what a resumed session should do with a re-dispatched command is
 *     UNDESIGNED -- "not yet covered", validateResumeFlag's own vocabulary, because it is a gap to
 *     close and not a limit. Only `true` is refused; `false` is the documented default and refusing it
 *     would refuse an operator for writing down the behaviour they already have.
 *
 * Everything else stays orthogonal on purpose -- replicas, image, packages, skillsDir, repository,
 * github. Those gate the CONTAINER a job runs in, and a command job runs in the same container a flow
 * job does.
 *
 * A COMMENT command trigger has no default flow, which leaves the receiver's `<phrase> <flow>` comment
 * override with nothing to override. That token is made inert by the receiver's FILTER, not refused
 * here: the override lives in adversarial comment text, which this file-shape validator never sees.
 *
 * `at` is the caller's message prefix, `onType` selects the cross-field set. Returns the command,
 * undefined when absent, and the callers spread it conditionally: a flow trigger must not grow the key
 * at all, so an unflagged file normalizes byte-identically to today's (deepEqual pins depend on it).
 */
function validateCommand(run, at, path, { onType }) {
	const raw = run.command;
	if (run.flow !== undefined && raw !== undefined) {
		throw configError(`${at}: exactly one of run.flow or run.command must be set -- a trigger dispatches either a flow or a registered command, and with both present the file does not say which one runs: ${path}`);
	}
	if (raw === undefined) return undefined;
	if (!isNonEmptyString(raw)) {
		throw configError(`${at}: run.command must be a non-empty string -- the registered command name, optionally followed by its arguments: ${path}`);
	}
	if (raw !== raw.trim()) {
		throw configError(`${at}: run.command must not have leading or trailing whitespace -- the arguments reach the command handler verbatim, so trimming here would make the reviewed file disagree with what runs (got ${JSON.stringify(raw)}): ${path}`);
	}
	if (raw.startsWith("/")) {
		throw configError(`${at}: run.command must not start with "/" -- the runner prepends the slash when it builds the /name args prompt, so a written one would dispatch "//name" (got ${JSON.stringify(raw)}): ${path}`);
	}
	// The class is the RUNNER's (parseCommand, image/runner/src/config.mjs), DEL included: the two
	// must refuse identically, or a value that loads here refuses in-container with the budget
	// slot already burned -- the drift INT-TRIGGERS-FILE-CONTRACT promises cannot happen.
	if (/[\u0000-\u001F\u007F]/.test(raw)) {
		throw configError(`${at}: run.command must not contain control characters -- a newline would smuggle a second line into what the operator reviewed as one command line (got ${JSON.stringify(raw)}): ${path}`);
	}
	if (onType === "cron" && run.task !== undefined) {
		throw configError(`${at}: run.command and run.task cannot be combined -- a command job's prompt IS the /name args line, so there is no task text for the runner to render; put the arguments in run.command: ${path}`);
	}
	if (onType !== "cron" && run.instructions !== undefined) {
		throw configError(`${at}: run.command and run.instructions cannot be combined -- instructions render into the prompt envelope, and a command job's prompt is the exact /name args line with no envelope, so nothing would render them: ${path}`);
	}
	if (run.resume === true) {
		throw configError(`${at}: combining run.command and run.resume is not yet covered -- what a resumed session should do with a re-dispatched command is undesigned, so this is a gap to close, not a limit: ${path}`);
	}
	return raw;
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
 * `on.number` -- narrow a close-capable trigger to ONE item, by the number the forge itself assigns
 * (issue #231). Legal with or without `on.once`: a standing "every close of #40" rule is coherent
 * narrowing, exactly as `on.reviewState` narrows without changing what the rule is. Called from ALL
 * normalizers, `validateReplicas`' posture -- where it cannot apply it refuses, never ignores.
 * `capable` is passed only by the close-capable paths (the `issue` normalizer, and a `pull_request`
 * rule whose only action is the forge's close word).
 */
function validateNumber(on, at, path, { capable = false, onType } = {}) {
	const number = on.number;
	if (number === undefined) return undefined;
	if (!capable) {
		if (onType === "cron") {
			throw configError(`${at}: on.number is not available on a cron trigger -- a schedule fires on time, not on an item, so there is no delivery for a number to narrow: ${path}`);
		}
		throw configError(`${at}: on.number is not yet covered for ${onType} triggers here -- only the close routes read it, so on a rule they never serve it would sit in the file looking configured; narrowing labels, comments or non-close pull_request rules is a gap to close, not a limit: ${path}`);
	}
	if (!Number.isInteger(number) || number < 1) {
		throw configError(`${at}: on.number must be an integer >= 1 when present -- the item number the forge itself assigns (on GitLab, the iid) (got ${JSON.stringify(number)}): ${path}`);
	}
	return number;
}

/**
 * `on.once` -- a one-shot: the trigger fires, produces a run record, and the worker disarms it by
 * adding `on.disarmed` to this entry (issue #231, DES-ONE-SHOT-DISARM-IN-THE-FILE). Strictly boolean
 * and fail-loud, the house rule; `false` is legal and carried, validateResumeFlag's argument -- an
 * operator who wrote down today's default must not be refused for stating present behaviour.
 *
 * `once: true` REQUIRES `on.number`, and the requirement is a race analysis, not taste: a numberless
 * one-shot matched by two different items' closes inside one dedup window enqueues both before either
 * disarm lands, and which item "spent" the trigger is a coin flip. With a number, concurrent
 * duplicates are duplicates of the SAME item, which is what the delivery GUID and the semantic window
 * actually bound -- and the number is the identity the disarm re-checks before it writes, so a file
 * edited between enqueue and disarm refuses loudly instead of disarming a stranger.
 *
 * `once: true` is refused beside `run.replicas` (`false`, the written-down default, is not): "exactly
 * one run" and "N sandboxes race" contradict on their face,
 * and with N run records the disarm no longer says which one spent the trigger.
 */
function validateOnce(on, run, at, path, { capable = false, onType } = {}) {
	const once = on.once;
	if (once === undefined) return undefined;
	if (!capable) {
		if (onType === "cron") {
			throw configError(`${at}: on.once is not available on a cron trigger -- a one-shot that can re-arm is a schedule, and a cron job carries no matched delivery for the disarm to name; delete the entry when the work is done: ${path}`);
		}
		// The close-word hint is JOINED from the table (the same rule the vocabulary messages follow), so a
		// forge gaining a close word later can never be pointed away from it by a stale sentence here.
		const closeWords = Object.entries(PR_CLOSE_ACTIONS).map(([k, w]) => `${k} has ${JSON.stringify(w)}`).join(", ");
		throw configError(`${at}: on.once is not yet covered here -- the disarm writes back to the one entry a delivery matched, and only a close delivery names the single item that spends it; use on.type "issue", or a pull_request rule whose only action is the close word (${closeWords}; azure has no close trigger yet): ${path}`);
	}
	if (typeof once !== "boolean") {
		throw configError(`${at}: on.once must be true or false when present -- a truthy string arming a one-shot is exactly the drift this validator exists to refuse (got ${JSON.stringify(once)}): ${path}`);
	}
	if (once === true && on.number === undefined) {
		throw configError(`${at}: on.once requires on.number -- a one-shot without a named item is spent by whichever close arrives first, and two different items closing inside one dedup window would race for it; the number is also the identity the disarm re-checks before it writes: ${path}`);
	}
	if (once === true && run.replicas !== undefined) {
		throw configError(`${at}: on.once and run.replicas cannot be combined -- "exactly one run" and "N sandboxes race" contradict, and with N run records the disarm no longer says which one spent the trigger: ${path}`);
	}
	return once;
}

/**
 * `on.disarmed` -- the mark the worker writes when a one-shot fires: `{ at, jobId? }`, provenance an
 * operator can read a year later when the run record is long reaped (issue #231). Hand-writable too
 * (jobId optional), which is how an operator disarms deliberately; deleting the key is how they
 * re-arm. The entry it sits on normalizes to the DISARMED_TYPE sentinel -- see normalizeTrigger --
 * but only AFTER this shape check and the full entry validation pass, so a corrupted disarm mark is
 * a load refusal, never a silently-still-armed rule.
 */
function validateDisarmed(on, at, path, { capable = false, onType } = {}) {
	const disarmed = on.disarmed;
	if (disarmed === undefined) return undefined;
	if (!capable) {
		throw configError(`${at}: on.disarmed marks a spent one-shot, and on.once is not ${onType === "cron" ? "available on a cron trigger" : "yet covered here"}, so there is nothing this entry could have spent: ${path}`);
	}
	if (disarmed === null || typeof disarmed !== "object" || Array.isArray(disarmed)) {
		throw configError(`${at}: on.disarmed must be an object with a non-empty string "at" (and optionally a non-empty string "jobId") -- the worker writes it when the one-shot fires, and a hand-written one disarms the entry deliberately (got ${JSON.stringify(disarmed)}): ${path}`);
	}
	for (const key of Object.keys(disarmed)) {
		if (key !== "at" && key !== "jobId") {
			throw configError(`${at}: on.disarmed has an unsupported key ${JSON.stringify(key)} (expected at|jobId): ${path}`);
		}
	}
	if (!isNonEmptyString(disarmed.at)) {
		throw configError(`${at}: on.disarmed.at must be a non-empty string (the time the one-shot fired): ${path}`);
	}
	if (disarmed.jobId !== undefined && !isNonEmptyString(disarmed.jobId)) {
		throw configError(`${at}: on.disarmed.jobId must be a non-empty string when present (the run record it joins to): ${path}`);
	}
	if (on.once !== true) {
		throw configError(`${at}: on.disarmed is only meaningful beside on.once: true -- an entry that was never a one-shot has nothing to spend: ${path}`);
	}
	return disarmed;
}

/**
 * `run.flow` charset for the WEBHOOK kinds (issue #231). materialize.mjs refuses a name outside
 * SKILL_NAME_RE at job start, AFTER the budget slot is reserved -- so until now a charset-invalid
 * forge flow loaded clean and could only ever fail in-container (graph-model already renders it as
 * the `charset-invalid` defect). Refusing at load turns that paid failure into a free one, and it is
 * also what keeps `:` out of the flow slot of the queue's semantic dedup key, where the command jobs'
 * `cmd:` prefix lives and the close jobs' discriminant sits beside it once close routing lands.
 * Deliberately NOT called on cron:
 * a local flow resolves inside the operator's own folder by pi itself, and the semantic key does not
 * apply to repeat jobs -- narrowing there would refuse deployments this hazard cannot reach.
 */
function validateFlowName(run, at, path) {
	if (run.flow === undefined) return;
	if (!SKILL_NAME_RE.test(run.flow)) {
		throw configError(`${at}: run.flow ${JSON.stringify(run.flow)} fails the skill-name charset (lowercase letters, digits, dash and underscore, 1-64 chars, starting and ending alphanumeric) -- a name outside it can never materialise, so this trigger could only ever fail after the budget slot was reserved: ${path}`);
	}
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
 *     in place, so two replicas would stomp each other's working tree with no gate and no undo. A forge
 *     job gets its own `mkdtemp`'d clone, which is the entire reason this is safe there and not here.
 *     Checked FIRST, and since #187 that ordering carries the whole kind gate rather than merely picking
 *     which reason a cron trigger hears. Every forge mints its branch through the same `issueBranch`, so
 *     anything that is not `local` is now allowed; move this below the range check and a cron entry
 *     carrying `replicas: 2` would be ACCEPTED, not refused with a different message.
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
	if (!Number.isInteger(replicas) || replicas < 2 || replicas > REPLICAS_MAX) {
		throw configError(`${at}: run.replicas must be an integer between 2 and ${REPLICAS_MAX} when present -- ${REPLICAS_MAX} is the ceiling because PI_CONCURRENCY defaults to 3, so a further replica would queue instead of racing, and 1 is refused because a one-member replica set is a flag that does nothing (got ${JSON.stringify(replicas)}): ${path}`);
	}
	if (run.resume === true) {
		throw configError(`${at}: run.replicas and run.resume cannot be combined -- a resumed run continues one lineage and replicas exist to fork it, so every replica would resolve the same session key and share one transcript: ${path}`);
	}
	return replicas;
}

/**
 * `run.secrets` -- the env variables this trigger's job receives, and the opaque references an operator's
 * own resolver turns into values (REQ-TRIGGER-SECRETS, issue #225).
 *
 * THE GRAMMAR OF THE VALUES IS NOT OURS. `op://vault/item/field`, `secret/data/ci#stripe` and a bare name
 * are all valid here, because what parses them is a script the operator wrote and named in
 * `PI_SECRET_PROFILES`. This file validates the SHAPE of the map and never the meaning of a reference --
 * the posture #206 and #209 already set ("the seam is a command"), and the same one
 * `DES-SERVICE-ENV-SETUP-SEAM` implements one layer up. A regex over `op://` here would bless a vendor.
 *
 * WHY EACH REFUSAL:
 *   - not a plain object, or a value that is not a non-empty string. An array or a nested object is an
 *     operator writing a different feature than the one that exists.
 *   - more than SECRETS_MAX entries -- see that constant: it bounds a worker slot, not a preference.
 *   - a key that is not an environment variable name. There is no downstream check: `-e NAME=VALUE` goes
 *     into the docker argv as written, so a key with an `=` in it silently binds a different variable.
 *   - a key in RESERVED_ENV_NAMES. The mint, the egress policy and the closed map all write AFTER this
 *     feature does, so such a key would be accepted, overwritten, and the job would run without the value
 *     it named on a clean exit 0. Ordering is the backstop; this is the refusal, which is the same
 *     division of labour `PI_FORWARD_ENV` already keeps (config.mjs refuses the names, env-allowlist.mjs
 *     orders the assignments so a slip cannot matter).
 *   - a reference starting with `-`. It is passed as `argv[1]` of the resolver, where a leading dash
 *     parses as a flag -- exactly `validateImageRef`'s reason for the same refusal on `run.image`. We do
 *     NOT pass `--` before it instead: that would be a claim about the resolver's option parser, and the
 *     option parser is the operator's.
 *   - `run.resume: true`. `assertResumeAllowedOnGhSource` (get-token.mjs) already refuses the `gh` token
 *     source for a resumed job, and states the argument this inherits whole: every property
 *     CONST-TOKEN-SCOPED-PER-JOB relies on assumes the credential is an ENV VALUE that dies with the
 *     container, while a persisted transcript is a FILE on host disk, replayed into the next job on that
 *     key. A resolved vault value is an env value the agent can echo, and nothing here redacts a
 *     transcript. Refused with NO escape hatch, unlike that one's PI_SESSIONS_ALLOW_GH_SOURCE: a pure
 *     validator cannot read an env var to find one, and the reason is stronger anyway, since that refusal
 *     complains a `gh` login is "full-scope and NON-EXPIRING" and a vault password does not expire either.
 *
 * Called from ALL FOUR normalizers, cron included. Unlike `run.replicas` this is NOT refused on a local
 * job: nothing about resolving a secret is forge-specific, and a nightly deploy is the obvious user. The
 * replica refusal turns on a local `/workspace` being the operator's own folder with no clone, which is a
 * fact about two agents sharing a working tree, not about a credential. That folder does bring its own
 * hazard (an agent that writes a credential into `.env` writes it into the operator's real repository),
 * and `doctor` warns about exactly that rather than this validator refusing the use case outright.
 *
 * Returns the map, undefined when absent, so an unflagged trigger normalizes byte-identically.
 */
function validateSecrets(run, at, path) {
	const secrets = run.secrets;
	if (secrets === undefined) return undefined;
	if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
		throw configError(`${at}: run.secrets must be an object mapping environment variable names to references when present (got ${JSON.stringify(secrets)}): ${path}`);
	}
	const names = Object.keys(secrets);
	if (names.length === 0) {
		throw configError(`${at}: run.secrets is empty -- an empty map is a field that does nothing, and this trigger reads as though it binds a secret: ${path}`);
	}
	if (names.length > SECRETS_MAX) {
		throw configError(`${at}: run.secrets names ${names.length} variables, over the ${SECRETS_MAX} cap -- each one is resolved before the container starts, holding a concurrency slot while it runs: ${path}`);
	}
	for (const name of names) {
		if (!ENV_NAME.test(name)) {
			throw configError(`${at}: run.secrets key ${JSON.stringify(name)} is not an environment variable name (letters, digits and underscore, not starting with a digit): ${path}`);
		}
		if (RESERVED_ENV_NAMES.has(name)) {
			throw configError(`${at}: run.secrets key ${JSON.stringify(name)} is a variable the worker sets itself -- the job container would receive the worker's value, not this trigger's, and the trigger would look like it worked: ${path}`);
		}
		const reference = secrets[name];
		if (!isNonEmptyString(reference)) {
			throw configError(`${at}: run.secrets.${name} must be a non-empty string reference for your resolver to read (got ${JSON.stringify(reference)}): ${path}`);
		}
		if (reference !== reference.trim()) {
			throw configError(`${at}: run.secrets.${name} must not have leading or trailing whitespace -- the file is the reviewed artifact and silently trimming it would make the file disagree with what the resolver is asked for: ${path}`);
		}
		if (reference.startsWith("-")) {
			throw configError(`${at}: run.secrets.${name} must not start with "-" -- it is passed as the resolver's first argument, where a leading dash parses as a flag: ${path}`);
		}
	}
	if (run.resume === true) {
		throw configError(`${at}: run.secrets and run.resume cannot be combined -- a resumed job replays a transcript kept on host disk, and any command the agent ran that echoed a resolved value wrote it into that transcript, which is then prefilled into every later job on the same key: ${path}`);
	}
	return { ...secrets };
}

/**
 * `run.secretsProfile` -- WHICH of the operator's declared resolvers reads this trigger's references.
 *
 * A NAME, never a path, and that distinction is the whole reason this field is allowed to exist.
 * `DES-SERVICE-ENV-SETUP-SEAM` rejected "making this reachable from configuration, which would turn a
 * boot-time root-adjacent exec into something a trigger file could name". A profile name selects among
 * execs the operator already declared in `PI_SECRET_PROFILES`; it cannot introduce one, cannot name a
 * path, and cannot reach a script nobody wired. The rejected thing is a trigger file NAMING an exec.
 *
 * The charset is `ID_CHARSET`, shared with cron ids, for two reasons that both bite: the name is echoed in
 * a refusal that `comment` posts PUBLICLY on the issue, and `PI_SECRET_PROFILES` is a `,`-separated list
 * of `name:path` pairs, so a name containing either separator could not round-trip through the very
 * variable that declares it.
 *
 * WHETHER the named profile exists is NOT checked here and cannot be: which profiles a deployment declares
 * is env and overlay state, and this validator is pure and fs-free. That is refused pre-spend, per
 * delivery, as `secret-profile-unknown` -- the same split `run.resume` makes against `PI_SESSIONS_DIR`,
 * where the file answers what the file knows and `doctor` plus a per-delivery refusal carry the rest.
 *
 * Absent selects the profile named `default`, so a single-manager deployment never writes the field.
 */
function validateSecretsProfile(run, at, path) {
	const profile = run.secretsProfile;
	if (profile === undefined) return undefined;
	if (!isNonEmptyString(profile)) {
		throw configError(`${at}: run.secretsProfile must be a non-empty string naming one of the resolver profiles this deployment declares (got ${JSON.stringify(profile)}): ${path}`);
	}
	if (!ID_CHARSET.test(profile)) {
		throw configError(`${at}: run.secretsProfile ${JSON.stringify(profile)} may use letters, digits, dot, dash and underscore only -- PI_SECRET_PROFILES is a comma-separated list of name:path pairs, so a name carrying either separator cannot be declared: ${path}`);
	}
	if (run.secrets === undefined) {
		throw configError(`${at}: run.secretsProfile is set but run.secrets names nothing -- a profile that resolves no references is a field that does nothing: ${path}`);
	}
	return profile;
}

function normalizeLabel(on, run, index, path) {
	const at = `trigger at index ${index}`;
	const predicate = validatePredicate(on, index, path, true);
	validateNumber(on, at, path, { onType: "label" });
	validateOnce(on, run, at, path, { onType: "label" });
	validateDisarmed(on, at, path, { onType: "label" });
	// First among the run checks, before the flow-required check -- validateCommand says why.
	const command = validateCommand(run, at, path, { onType: "label" });
	if (command === undefined && !isNonEmptyString(run.flow)) {
		throw configError(`${at}: label trigger run.flow must be a non-empty string (or use run.command): ${path}`);
	}
	validateFlowName(run, at, path);
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	const skillsDir = validateSkillsDir(run, at, path);
	const instructions = validateInstructions(run, at, path);
	const resume = validateResumeFlag(run, at, path);
	const repository = validateRepository(run, "label", at, path);
	const replicas = validateReplicas(run, at, path);
	const secrets = validateSecrets(run, at, path);
	const secretsProfile = validateSecretsProfile(run, at, path);
	return {
		on: { type: "label", any: predicate.any, all: predicate.all, none: predicate.none },
		run: { kind: run.kind, flow: run.flow, packages, image, resume, replicas, ...(command !== undefined && { command }), ...(skillsDir !== undefined && { skillsDir }), ...(instructions !== undefined && { instructions }), ...(repository !== undefined && { repository }), ...(secrets !== undefined && { secrets }), ...(secretsProfile !== undefined && { secretsProfile }) },
	};
}

function normalizeComment(on, run, index, path, state) {
	const at = `trigger at index ${index}`;
	if (!isNonEmptyString(on.phrase)) {
		throw configError(`${at}: comment trigger on.phrase must be a non-empty string: ${path}`);
	}
	validateNumber(on, at, path, { onType: "comment" });
	validateOnce(on, run, at, path, { onType: "comment" });
	validateDisarmed(on, at, path, { onType: "comment" });
	// First among the run checks, before the flow-required check -- validateCommand says why. A command
	// trigger has NO default flow for the `<phrase> <flow>` comment override to replace; making that
	// token inert is the receiver filter's job, not a shape this validator can see.
	const command = validateCommand(run, at, path, { onType: "comment" });
	if (command === undefined && !isNonEmptyString(run.flow)) {
		throw configError(`${at}: comment trigger run.flow (the default flow) must be a non-empty string (or use run.command): ${path}`);
	}
	validateFlowName(run, at, path);
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
	const secrets = validateSecrets(run, at, path);
	const secretsProfile = validateSecretsProfile(run, at, path);
	return {
		on: { type: "comment", phrase: on.phrase },
		run: { kind: run.kind, flow: run.flow, packages, image, resume, replicas, ...(command !== undefined && { command }), ...(skillsDir !== undefined && { skillsDir }), ...(instructions !== undefined && { instructions }), ...(repository !== undefined && { repository }), ...(secrets !== undefined && { secrets }), ...(secretsProfile !== undefined && { secretsProfile }) },
	};
}

/**
 * `on.type: "issue"` (issue #231): fire when an ISSUE's lifecycle action happens -- one word so far,
 * the close. The type exists because every other issue event already has a home (`label` for label
 * predicates, `comment` for phrases) and neither of those shapes fits a close: there is no label diff
 * to match and no phrase to read, only an action, an item number, and the actor who performed it.
 * A PULL REQUEST's close is deliberately NOT this type -- it rides `on.type: "pull_request"` as an
 * action, the #66 rule (one forge's PR lifecycle must not be a type while another's is an action),
 * and because GitLab and Azure number issues and merge/pull requests from SEPARATE sequences, a
 * both-kinds type narrowed by `on.number` would be ambiguous exactly where a one-shot spending
 * itself on the wrong #5 hurts most. Under the split, the type IS the discriminator.
 */
function normalizeIssue(on, run, index, path) {
	const at = `trigger at index ${index}`;

	// Kind first: on azure the whole TYPE is unsupported, and hearing that beats hearing that one
	// action word is. See ISSUE_ACTIONS for why, and validateResumeFlag for the "not yet covered"
	// vocabulary this reuses.
	if (run.kind === "azure") {
		throw configError(`${at}: an issue trigger is not yet covered for azure -- a work item's close is a System.State transition whose terminal names vary by process template (Agile "Closed", Scrum "Done"), and the projected subset carries only System.Tags, so nothing in the delivery says the item closed; widening the payload subset is the gap to close, not a limit: ${path}`);
	}

	const actions = on.action;
	if (!Array.isArray(actions) || actions.length === 0) {
		throw configError(`${at}: issue on.action must be a non-empty array: ${path}`);
	}
	// Validated against THIS entry's forge, in that forge's own words -- normalizePullRequest's rule.
	const allowed = ISSUE_ACTIONS[run.kind];
	const expected = [...allowed].join("|");
	for (const a of actions) {
		if (!allowed.has(a)) {
			throw configError(`${at}: issue on.action has an unsupported ${run.kind} action ${JSON.stringify(a)} (expected ${expected}): ${path}`);
		}
	}

	// The close route matches action and number alone, so a predicate here would be accepted-and-
	// ignored -- the exact thing validateRepository's posture forbids. Refused, not dropped.
	if (on.any !== undefined || on.all !== undefined || on.none !== undefined) {
		throw configError(`${at}: an issue trigger cannot carry a label predicate -- it fires on a lifecycle action, not a label diff, so any/all/none could never match; a label-predicated rule is on.type "label": ${path}`);
	}

	const number = validateNumber(on, at, path, { capable: true, onType: "issue" });
	const once = validateOnce(on, run, at, path, { capable: true, onType: "issue" });
	validateDisarmed(on, at, path, { capable: true, onType: "issue" });

	// First among the run checks, before the flow-required check -- validateCommand says why.
	const command = validateCommand(run, at, path, { onType: "issue" });
	if (command === undefined && !isNonEmptyString(run.flow)) {
		throw configError(`${at}: issue trigger run.flow must be a non-empty string (or use run.command): ${path}`);
	}
	validateFlowName(run, at, path);
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	const skillsDir = validateSkillsDir(run, at, path);
	const instructions = validateInstructions(run, at, path);
	const resume = validateResumeFlag(run, at, path);
	validateRepository(run, "issue", at, path);
	const replicas = validateReplicas(run, at, path);
	const secrets = validateSecrets(run, at, path);
	const secretsProfile = validateSecretsProfile(run, at, path);
	return {
		on: {
			type: "issue",
			action: [...actions],
			// Absent rather than present-and-undefined, reviewState's rule below: an unnarrowed rule's
			// normalized shape must not grow keys.
			...(number !== undefined && { number }),
			...(once !== undefined && { once }),
		},
		run: { kind: run.kind, flow: run.flow, packages, image, resume, replicas, ...(command !== undefined && { command }), ...(skillsDir !== undefined && { skillsDir }), ...(instructions !== undefined && { instructions }), ...(secrets !== undefined && { secrets }), ...(secretsProfile !== undefined && { secretsProfile }) },
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

	// The close-only split (issue #231). A close rule gates on the CLOSER's write access; every other
	// PR action gates on the author's association or a collaborator-applied label. One rule cannot
	// gate on two different actors, so a list mixing the close word with anything else is refused --
	// which is also what lets the receiver group close rules separately without re-deriving this.
	const closeWord = PR_CLOSE_ACTIONS[run.kind];
	const isClose = closeWord !== undefined && actions.includes(closeWord);
	if (isClose && actions.some((a) => a !== closeWord)) {
		throw configError(`${at}: pull_request on.action cannot mix ${JSON.stringify(closeWord)} with other actions -- a close rule is gated on the closer's write access and every other action on the author's, and one rule cannot gate on two different actors; split it into two entries: ${path}`);
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
	// A close-only rule reads no label diff either -- its route matches action and number alone -- so
	// a predicate on it is normalizeIssue's refusal arriving on the PR side.
	if (isClose && (on.any !== undefined || on.all !== undefined || on.none !== undefined)) {
		throw configError(`${at}: a close pull_request rule cannot carry a label predicate -- the close route matches the action and on.number alone, so any/all/none would sit in the file looking configured and never match anything: ${path}`);
	}
	const predicate = validatePredicate(on, index, path, requirePositive);
	const number = validateNumber(on, at, path, { capable: isClose, onType: "pull_request" });
	const once = validateOnce(on, run, at, path, { capable: isClose, onType: "pull_request" });
	validateDisarmed(on, at, path, { capable: isClose, onType: "pull_request" });
	// First among the run checks, before the flow-required check -- validateCommand says why.
	const command = validateCommand(run, at, path, { onType: "pull_request" });
	if (command === undefined && !isNonEmptyString(run.flow)) {
		throw configError(`${at}: pull_request trigger run.flow must be a non-empty string (or use run.command): ${path}`);
	}
	validateFlowName(run, at, path);
	const packages = validatePackagesFlag(run, at, path);
	const image = validateImageRef(run, at, path);
	const skillsDir = validateSkillsDir(run, at, path);
	const instructions = validateInstructions(run, at, path);
	const resume = validateResumeFlag(run, at, path);
	validateRepository(run, "pull_request", at, path);
	const replicas = validateReplicas(run, at, path);
	const secrets = validateSecrets(run, at, path);
	const secretsProfile = validateSecretsProfile(run, at, path);
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
			// Same rule for the close-narrowing pair (issue #231): only a close-only rule can carry them.
			...(number !== undefined && { number }),
			...(once !== undefined && { once }),
		},
		run: { kind: run.kind, flow: run.flow, packages, image, resume, replicas, ...(command !== undefined && { command }), ...(skillsDir !== undefined && { skillsDir }), ...(instructions !== undefined && { instructions }), ...(secrets !== undefined && { secrets }), ...(secretsProfile !== undefined && { secretsProfile }) },
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
