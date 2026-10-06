import { DAEMON_APPLIES_BOUNDS, DEFAULT_BACKEND, DOCKER_ENDPOINT_LOCAL, DOCKER_NEVER_STARTED_EXITS, PODMAN_ADDS_NO_MOUNTS, PODMAN_BACKEND, PODMAN_BOUNDS_DELEGATED, PODMAN_CONF_WIDENS_JOB, PODMAN_SERVICE_LOCAL, RUNTIME_ADDS_NO_MOUNTS } from "./backends.mjs";
import { resolveBackendName } from "./backend-registry.mjs";
import { lstatSync } from "node:fs";
import { checkTokenCap, recordTokenSpend, releaseLedgers, reserveLedgers } from "./budget.mjs";
import { configError } from "./config.mjs";
import { unqualifiedScope } from "./pause-windows.mjs";
import { PROJECT_CAP_REASON } from "./scoped-limits.mjs";
import { DEFAULT_SECRETS_PROFILE, secretsArmed } from "./secrets.mjs";
import { RESERVED_ENV_NAMES } from "./triggers.mjs";
import { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "./exit-code.mjs";
import { COST_CAP_WHYS, EXIT_OOM_KILLED, RUNNER_POLICY_REASONS } from "./run-history.mjs";
import { DEFAULT_EGRESS_PROXY } from "./egress.mjs";
import { CAPABILITY_GATES, EXIT_AUTH_CAPABILITY } from "./image-preflight.mjs";
import { modelListProblem, modelOnList, splitModelEntry } from "./model-ref.mjs";
import { ALLOCATION_CAP_REASON, ENVELOPE_MISMATCH_REASON } from "./allocation.mjs";

/** The refusal of a local job whose resolved folder belongs to another project than the one decided at pickup (issue #504 part B). */
export const LOCAL_FOLDER_PROJECT_CHANGED = "local-folder-project-changed";
// Issue #505: a portfolio cron job refused before it spends, because this host could not apply the plan it would write.
export const PORTFOLIO_NO_ENVELOPE = "portfolio-no-envelope";
import { DOLLAR_CAP_REASON, DOLLAR_KEY_PREFIX, dollarLedgers, dollarSettlement, dollarsRecord, holdPart, meteredMicros, modelDollarSettlement, releaseDollars, reserveDollars, settleDollars } from "./dollar-budget.mjs";
import { zeroRatedVerdict } from "./model-endpoints.mjs";

/**
 * The forge comment's reason for each observation a floor refusal missed (issues #278 and #345), keyed like
 * `OBSERVATIONS` in `backends.mjs` and pinned to it. Fixed words only.
 */
export const OBSERVATION_COMMENT = Object.freeze({
	[DOCKER_ENDPOINT_LOCAL]: "the docker CLI is not observed sending containers to a daemon on this host, so the job's credentials could cross a network the deployment does not own",
	[DAEMON_APPLIES_BOUNDS]: "the container runtime is not observed applying a container's pid and memory bounds",
	[RUNTIME_ADDS_NO_MOUNTS]: "the container runtime is not observed adding no mounts of its own to a job container",
	// Issue #354: the podman venue's three, in the same fixed register. No path, no controller list and no service URL:
	// those are the evidence, which goes to the operator's log only.
	// Cause-neutral (issue #453): the observation misses both when a controller is not delegated and when no systemd user
	// manager runs for the account (measured: podman info then still lists every controller). Which one is the evidence's
	// to say, in the operator's log.
	[PODMAN_BOUNDS_DELEGATED]: "the worker's rootless Podman is not observed applying a container's pid, memory and cpu bounds",
	[PODMAN_ADDS_NO_MOUNTS]: "the worker's rootless Podman is not observed adding no mounts of its own to a job container",
	[PODMAN_SERVICE_LOCAL]: "the podman CLI is not observed running containers on this host rather than through a remote service, so the job's credentials could cross a network the deployment does not own",
});

/**
 * The forge comment's reason when a floor refusal names no observation this build has words for (issue #354): a
 * venue other than `local` that named none, or named one outside `OBSERVATIONS`. Venue-neutral on purpose. The
 * fallback used to be the docker endpoint's sentence, which is right only for `local`, whose preflight is the one
 * that could ever refuse without naming what it missed; told to a job on another runtime it blames a CLI that job
 * never touched. Not a key of `OBSERVATION_COMMENT`, which is pinned to the closed list one-for-one.
 */
export const OBSERVATION_COMMENT_UNNAMED = "the venue this job runs on did not confirm a guarantee the floor requires";

/**
 * The job orchestration. Deliberately a pure-ish function over INJECTED side-effecting deps, so
 * the money-safety ORDER can be tested without GitHub, Docker, or Redis.
 *
 * The order is the contract, and every step before `runContainer` must be free of provider spend:
 *
 *   0. refuse a job image this host does not have  -- INT-CONTAINER-RUNTIME-CONTRACT
 *   0a. refuse a job no non-root uid can run on this daemon, or whose image cannot run as the worker's uid
 *       (issue #341), and retry one whose job user could not be decided -- DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST
 *   0b. REFUSE a deployment with no usable credential for the job's provider, which costs nothing to
 *       ask and would otherwise be discovered with the budget already reserved -- CONST-BUDGET-BEFORE-TOKENS
 *       (gates 0 and 0b are not the first two: a one-shot already spent, a skewed wait, an unblessed
 *       backend and a backend floor this host is not observed to meet (#278, #345) are refused above them, and
 *       this ladder has never listed those)
 *   1. REFUSE an armed `run.resume` with no session store to persist into (the one fail-CLOSED case)
 *                                                 -- REQ-RESUMABLE-SESSION
 *   2. mint a scoped token (GitHub jobs, and local jobs opted in via `github: true`)
 *                                                 -- CONST-TOKEN-SCOPED-PER-JOB
 *   3. REFUSE an unprotected default branch (GitHub jobs only -- a local job has no repo)
 *                                                 -- REQ-BRANCH-PROTECTION-PRECONDITION
 *   4. resolve the default-branch SHA (fresh API), clone at it, materialise .pi/, write the prompt
 *   5. reserve a budget slot                      -- CONST-BUDGET-BEFORE-TOKENS
 *   6. ONLY NOW run the container (the only step that spends provider tokens)
 *   7. map the container exit code to retry-vs-success
 *
 * Budget is reserved as late as possible but strictly before the container, so a refusal from an
 * earlier free gate (unprotected repo, an armed resume with no store, clone failure) never consumes a
 * daily slot. The container is the only thing that spends money, so "before tokens" means "before this
 * line".
 *
 * Returns a result object on a non-retryable outcome; THROWS on a retryable (infra) one so BullMQ
 * retries per `attempts`. The caller (the BullMQ processor) turns the thrown/returned distinction
 * into the queue's retry behaviour -- that is INT-RUNNER-EXIT-CODE-PROTOCOL.
 */

/** The exit code of a container whose main process was SIGKILLed: a worker's stop or the kernel's OOM killer. */
const EXIT_SIGKILL = 137;

/**
 * Issue #596: whether a run's memory peak reached the container's own limit closely enough for its OOM kill to be the
 * job's own: `memPeak` (bytes, off the decisive exit line) at 90% of `limit` (bytes, the `--memory=` the worker passed)
 * or more. Both must be known; anything else is false, so the 137 stays infrastructure and retries.
 *
 * Why the check exists: `memory.events` `oom_kill` counts a kill by ANY OOM killer, the HOST's included, and the runner
 * tree's `oom_score_adj` of 1000 makes a job the host's first victim when the machine itself runs short. A kill of
 * that kind says nothing about the job's size, and a retry may well pass. A cgroup OOM happens only at the limit, so its
 * peak sits there: measured in the issue #596 lab, `memory.peak` read exactly the bound (64m, 80m) or just under it on
 * every venue. 90% and not 100% is the margin for that "just under"; nothing in between is read as a measurement.
 *
 * What it cannot see (the residual): a host OOM that strikes a job which is ALREADY at 90% of its own limit, page
 * cache included (a job that read large files counts that cache), reads as the job's own OOM. And the peak is a
 * high-water mark over the whole run, so a job that touched 90% early and was killed by the host later reads the same.
 */
export function peakReachedLimit(memPeak, limit) {
	if (!Number.isSafeInteger(memPeak) || !Number.isSafeInteger(limit) || memPeak < 0 || limit <= 0) return false;
	return memPeak >= Math.ceil((limit * 9) / 10);
}

// The post-spend terminal comments (issue #288). Every FREE refusal above the container already comments;
// these are the paths where money was spent and the run still ended without the agent's own status step,
// which used to tell the issue nothing (REQ-JOB-STATUS-COMMENTS' acceptance -- "exactly one completion or
// failure comment" -- held only below the spend line). Keyed by the reason token so a new abort
// classification adds a ROW here, never a re-plumb; sentences are FIXED and path-free, because for a
// local job the adapter logs the full text into a persistent service log (the "this folder" discipline
// at the scope-cap refusal). The completed path stays silent on purpose: exit 0 is where the AGENT'S own
// status comment lives (the prompt contract instructs it, including for "I cannot fix this"), and exit 2
// by construction means the agent was cut off before that step.
// EXPORTED only so a test can hold every RUNNER_POLICY_REASONS member to a row here (issue #437 review).
export const TERMINAL_COMMENTS = {
	"worker-abort": "Stopped: the worker ended this run before it finished (the 30-minute job limit, or a worker shutdown). Partial work may exist. Not retried.",
	"operator-cancel": "Stopped: the operator cancelled this run. Partial work may exist. Not retried.",
	"runner-policy": "Stopped: the run ended inside the container before finishing (a turn or token budget, or an in-container configuration refusal). Partial work may exist. Not retried.",
	// Issue #437. Names the cause but never the provider's own message, which may echo a key fragment. "Or
	// access" because a 403 is as often a key that works but may not use this model or route as a bad key.
	"provider-auth-refused": "Stopped: the AI provider refused this worker's credentials or access (an authentication or permission error). The operator needs to check the provider key and what it is allowed to use. Not retried.",
	// Issues #501, #502. The two stops name the policy, never the amount or the model: both are operator
	// configuration, and the comment's reader may be an issue author who can act on neither.
	"cost-cap": "Stopped: the next AI call could have taken this run past its cost limit, so it was not made. Partial work may exist. Not retried.",
	"model-not-allowed": "Stopped: the run tried to call an AI model this trigger does not allow, or to change an AI request in a way it does not allow, so the call was not made. Partial work may exist. Not retried.",
	"cost-cap-unenforceable": "Stopped: this run has a cost limit, and the job image could not enforce it before each AI call, so nothing was sent to the AI provider. The operator needs to update the job image. Not retried.",
	"model-policy-unenforceable": "Stopped: this run is limited to certain AI models, and the job image could not enforce that before each AI call, so nothing was sent to the AI provider. The operator needs to update the job image. Not retried.",
	// Issue #596. Never the size or the project: both are operator configuration, and the reader may be an issue author
	// who can act on neither. The worker log and the run record carry them.
	[EXIT_OOM_KILLED]: "Stopped: the job's container ran out of memory and was stopped. Partial work may exist. Not retried, because the same size would stop the same way. The operator can raise this job's memory size.",
};

// Issue #502: the `model-unknown` refusal's comment. Names no model: the reader may be an issue author.
export const MODEL_UNKNOWN_COMMENT = "Refused: this job names an AI model that this deployment does not know (it is in neither pi's model catalog nor the overlay models.json), so no container was started and nothing was spent. Ask the operator to check the trigger's model settings. Not run.";

// The `model-unknown` refusal whose `why` is `overlay-*` (PR #558, the end-of-round check of #501 and #502): the deployment's overlay
// models.json is the problem, not the job's model, so the generic text above would send the author to the wrong
// place. Fixed text naming no path and no model; the operator finds which file and why in the worker log.
export const OVERLAY_REFUSED_COMMENT = "Refused before starting: the deployment's model settings file (models.json in the overlay) cannot be used for this job, so no container was started and nothing was spent. The operator needs to fix that file. Not run.";

// Issue #341: the forge comments for a `job-user-unmappable` refusal, keyed by cause. Shorter than the operator
// texts in job-user.mjs on purpose: a comment's reader may be an issue author, who can act on none of it.
const JOB_USER_COMMENTS = Object.freeze({
	default: "Refused: the worker host's container runtime cannot give this job a non-root user that can read and write its own files. Not run.",
	"runtime-unreadable": "Refused: the worker host's container runtime answered in a form the worker cannot read, so which user this job may run as is unknown. Not run.",
});

/**
 * The runtime a venue's own preflights talk to, named in a retry's words (issue #354). The message is the job_failed log
 * line and BullMQ's failedReason, so `local`'s stays byte-identical ("docker unavailable, ..."), the native podman venue
 * names podman (an operator reading "docker unavailable" on a host with no docker would chase the wrong daemon), and a
 * venue this build has no runtime word for gets the neutral phrase rather than a guess. `Object.hasOwn`, so a venue
 * named like a prototype key is not a runtime.
 */
const VENUE_RUNTIME = Object.freeze({ [DEFAULT_BACKEND]: "docker", [PODMAN_BACKEND]: "podman" });

function runtimeUnavailable(venue, gate) {
	return Object.hasOwn(VENUE_RUNTIME, venue) ? `${VENUE_RUNTIME[venue]} unavailable, ${gate} could not run` : `the container runtime is unavailable, ${gate} could not run`;
}

/**
 * The remedy an egress-proxy refusal's comment names. The compose profile starts the proxy on the DOCKER daemon, which a
 * job on the native podman venue cannot reach: rootless podman's `--internal` network reaches nothing on the host
 * (measured, issue #354), so its proxy must run under the SAME rootless podman on a named bridge network, which is what
 * docs/podman.md sets up. Every other venue names `pi-dispatch up` from the deployment folder, and ONLY that (issue #480,
 * PR #488's review): it starts the proxy in any folder init made, and it knows the folder. A compose line printed from
 * here could not: a folder /dispatch setup laid out needs its project and override, and without them `--profile egress
 * up -d` also starts compose's unprofiled valkey under project `deploy`, a second Valkey on a fresh volume or a clash on
 * its port. A proxy PI_EGRESS_PROXY names is the operator's own, which `up` never starts, so that one is theirs to start.
 */
function egressProxyFix(venue, proxy = DEFAULT_EGRESS_PROXY) {
	if (venue === PODMAN_BACKEND) return "Start it under the worker account's own rootless podman, on a named bridge network (docs/podman.md)";
	if (proxy !== DEFAULT_EGRESS_PROXY) return `PI_EGRESS_PROXY names your own proxy, which \`pi-dispatch up\` does not start: start ${proxy} yourself`;
	return "Start it with `pi-dispatch up` from the deployment folder";
}

/**
 * Did the runtime never hand control to the runner (issue #227)? ONE answer for the two places that ask it (issue
 * #501): the exit-code switch, which refunds such an exit as `container-never-started`, and the dollar settlement,
 * which must not settle a container that never ran (the refund in the catch gives its reservation back instead).
 * Two answers could drift: a never-started exit settled at the floor AND refunded would give back twice, and one
 * neither settled nor refunded would leave its hold standing.
 *
 * A detached container (issue #345) DID start, and an aborted one is classified by its flag first, so neither is
 * never-started whatever its code. The runner's own three codes are never the venue's never-started set's to claim.
 */
export function isNeverStartedExit({ code, aborted, detached }, neverStartedCodes) {
	if (detached === true || aborted) return false;
	if (code === EXIT_COMPLETED || code === EXIT_POLICY || code === EXIT_INFRA) return false;
	return (neverStartedCodes ?? []).includes(code);
}

/** The key prefixes of a job's model dollar ledgers (`modelDollarRows`), to tell a model window's keys in a hold apart. */
function modelPrefixesOf(modelDollars) {
	return new Set((modelDollars ?? []).map((m) => m.keyPrefix));
}

/**
 * The models a job may call (issue #501, #503 part 7), as `{ provider, id }` refs: its main model, and every entry of
 * its effective allowed-model list when it has one. A list entry that does not split is kept as `null`, which the
 * zero-rated check reads as "not zero-rated" (fail closed).
 */
function callableModelRefs(job) {
	const refs = [{ provider: job.provider, id: job.model }];
	for (const entry of Array.isArray(job.models) ? job.models : []) {
		const ref = splitModelEntry(entry);
		refs.push(ref === null ? null : { provider: ref.provider, id: ref.model });
	}
	return refs;
}

export async function runJob(job, deps) {
	const {
		redis,
		caps, // { day, week, month }; week/month null when that window is disabled (REQ-SPEND-CAPS-MULTI-WINDOW)
		softHoldPct, // int 1-99 or null; the soft-hold band applied to every active window
		tokenCap = null, // int or null; the daily TOKEN cap (issue #25). Check-AFTER, so it gates the NEXT job on prior spend
		// [{ scope, keyPrefix, caps: { day, week, month }, reason }] -- this job's scoped job-count ledgers in reserve order
		// (issues #242 and #499 part B, INT-SCOPED-LIMITS-FILE-CONTRACT): its repo or folder row's, then its project row's,
		// from ONE builder (`scopedLedgers`) over the same watched-limits snapshot and pickup project the gate read. The
		// global ledger is appended here, last. Empty when no row carries a job-count window; the default keeps an
		// unwired processor byte-identical. The folder MUTEX and the `concurrent` slots do not live here -- they are the
		// pickup gate's, pre-everything; this is only the money half.
		scopedLedgers = [],
		recordSpend = recordTokenSpend, // injected so the post-container INCRBY is testable/stubbable
		// (job) => { ok } | { missing: <ref> } | { unavailable: <ref> }. The pre-spend check that the image
		// this job names is on this host (image-preflight.mjs). Default admits everything, so a wiring that
		// omits it behaves exactly as before -- the container's own failure stays the backstop.
		imagePreflight = async () => ({ ok: true }),
		// (job) => { ok } | { refused, at, jobId }. The one-shot pre-spend check (issue #231,
		// DES-ONE-SHOT-DISARM-IN-THE-FILE). Default admits everything -- an unwired processor behaves
		// exactly as before, and the gate below only calls it for a job whose matched rule was a
		// one-shot, so the default is never a probe running on every delivery.
		checkOnceSpent = async () => ({ ok: true }),
		// Issue #230. Admit-everything by default, like checkOnceSpent above and for its reason: an
		// unwired seam must not refuse, and the wiring is what turns the check on.
		checkWaitSkew = async () => ({ ok: true }),
		// () => { ok } | { message } | { unavailable } (issue #503: a transient overlay read, retried). Issue #310. Resolves this deployment's provider credential the way
		// buildContainerEnv will, and answers whether it exists AT ALL, so an unconfigured provider refuses
		// here rather than inside runContainer with the budget already reserved. Admit-everything by default,
		// like the two above and for their reason. A PROBE, deliberately: it discards whatever it resolves and
		// the real read happens where it always did, because threading a live credential through the processor
		// would put it in scope for every log line and record between here and the container.
		checkProviderCredential = () => ({ ok: true }),
		// (refs) => { ok } | { unknown: { provider, id }, why } | { unavailable: code } (issue #502). Is each of this
		// job's models, its main one and every listed one, a model pi knows (model-catalog.mjs `checkModelsKnown`,
		// the builtin catalog plus the overlay models.json)? Admit-everything by default, like the credential probe
		// above and for its reason: an unwired seam must not refuse, and the wiring is what turns the check on.
		checkModelsKnown = () => ({ ok: true }),
		// Issue #503: the pickup's endpoint snapshot `{ endpoints, models, set }` (index.mjs), read once per pickup. Null on
		// a wiring with no endpoint seam, which leaves the credential gate and the container env exactly as before.
		modelEndpoints = null,
		// REQ-EGRESS-ALLOWLIST. Default admits everything, so a wiring that omits it behaves exactly as a
		// deployment with no egress policy does -- which is also what the real factory returns when unarmed.
		egressPreflight = async () => ({ ok: true }),
		// Issue #278: a live read of something the backend's declaration holds only while observed (today, which
		// docker endpoint the CLI resolves), judged against the deployment's floor. `{ ok }`, `{ refused, message }`
		// or `{ unavailable }`. Defaults to ok, so a bare wiring gates nothing, like the two preflights above it.
		observationPreflight = async () => ({ ok: true }),
		// Issue #341: which uid this job's container runs as. `(job, { capabilities, observed }) =>` `{ user, home }`
		// (`user` null = the image's own USER), `{ refused, cause }` or `{ unavailable, reason }`. The default runs
		// every job as the image's user, exactly as before, so a wiring that omits it changes nothing. A non-refused answer
		// may also carry `relabel: true` (issue #355), which reaches `runContainer` beside the user it was decided with, and
		// `hostCpus` (issue #596), the runtime's CPU count from the same facts read, which sets the `--cpus` ceiling.
		jobUserPreflight = async () => ({ user: null, home: null }),
		// (session, { piVersion, context }) => { promoted, reason, bytes }. Promotes this job's transcript back into
		// the store, on a COMPLETED exit only. Never throws. The default is a no-op so a wiring that omits
		// it behaves exactly as before -- no store, no promotion, no session in the record.
		promoteSession = () => null,
		// The session store's root, or null when the feature is unavailable (REQ-RESUMABLE-SESSION). Read
		// ONLY to answer the fail-closed gate below -- nothing here opens it, and it never reaches the
		// container env (docker-run.mjs mounts a per-job COPY, never the store).
		//
		// The default is the env read config.mjs itself performs (`env.PI_SESSIONS_DIR || null`) rather than
		// a bare `null`, and the difference is not cosmetic. A `null` default would make the gate refuse
		// EVERY armed job under any wiring that does not pass this key -- a false refusal that looks exactly
		// like the true one -- whereas the env is the single source both readers derive from, so the two
		// cannot disagree about whether a store exists. A wiring may still pass `sessionsDir` explicitly to
		// make the seam visible; it resolves to the same value.
		sessionsDir = process.env.PI_SESSIONS_DIR || null,
		// REQ-PER-TRIGGER-SKILLS. Injected so the pre-spend gate is testable without a real directory, and
		// lstat rather than stat so a symlinked skillsDir is judged on its own inode -- the habit copy-tree.mjs,
		// outbox.mjs and sandbox-store.mjs all keep. A throw is a refusal: an unreadable path is still absent
		// as far as this job is concerned.
		isReadableDir = (p) => {
			try {
				return lstatSync(p).isDirectory();
			} catch {
				return false;
			}
		},
		// (job) => { ok: true, secrets } | { profileUnknown } | { unresolved, ... }. The wiring binds the
		// abort signal into it (index.mjs), the way it binds name+signal into runContainer.
		// REQ-TRIGGER-SECRETS. Resolves this trigger's `run.secrets` references through the operator's own
		// resolver, HOST-SIDE, before anything spends. Injected so the gate is testable without a real script.
		//
		// The default FAILS CLOSED, deliberately unlike imagePreflight's and egressPreflight's
		// admit-everything defaults, and for the reason the sessionsDir default states above: an admitting
		// default would let a job that armed run.secrets start with those variables UNSET under any wiring
		// that omits this key. That is a false success which looks exactly like the feature working, and it
		// is the inversion this whole gate exists to prevent. It can be UNCONDITIONALLY refusing because the
		// gate below only calls it when the job is armed -- putting the arming test in the default instead
		// would leave an INJECTED resolver running on every job, which is how a probe nobody wanted starts
		// spawning a subprocess per delivery to learn nothing.
		resolveSecrets = async (job) => ({ profileUnknown: job.secretsProfile ?? DEFAULT_SECRETS_PROFILE }),
		// #227. Which backends this deployment BLESSED (PI_BACKENDS). Defaults to the one name every
		// deployment already runs rather than to admit-everything: a wiring that says nothing blesses
		// `local` only, so a job naming anything else is refused instead of running somewhere the operator
		// never approved. That is the same fail-closed direction `resolveSecrets` above defaults in, and it
		// is safe to default at all only because the gate below fires ONLY when a job names a backend --
		// an unflagged job never consults this list.
		blessedBackends = [DEFAULT_BACKEND],
		// #227. The exit codes THIS JOB'S venue uses for "the runner never ran" -- a function of the job,
		// not of the wiring, because which venue ran it is a per-job fact and the registry resolves it per
		// job for every other backend function too. Docker's triple is the default because it is the only
		// runtime this repo ships, so a wiring that omits this keeps today's behaviour exactly; an adapter
		// that normalises to `container-never-started` itself returns an empty list.
		neverStartedExits = () => DOCKER_NEVER_STARTED_EXITS,
		// (job) => scoped short-lived token. Takes the JOB, not the repo: which forge mints -- and therefore
		// which credential the container gets -- is a property of `job.kind`, and only the wiring knows the
		// map. Called for forge-backed jobs and for local jobs opted in via `github: true`; unflagged local
		// jobs never mint (token stays null).
		mintToken,
		isDefaultBranchProtected, // (job, token) => boolean; same reason -- the forge is the job's, not the process's
		prepareWorkspace, // (job, token) => { workspaceDir, jobDir }  (clone+materialise+prompt)
		// runContainer({ job, token, prepared, secrets, name, signal, user, home, modelEndpoints?, size?, hostCpus? }) => { code, aborted, abortReason, turns, tokens, session, usage, context, exitReason }.
		// `size` (issue #596) is `jobSize` below; `hostCpus` the runtime's CPU count off the job-user gate's own facts read.
		// `exitReason` (issue #437) is parseExitReason's closed-set label, read only inside the exit-2 branch.
		// `resources` and `exitOomKilled` (issue #596) are the exit line's cgroup block and the supervisor's OOM report.
		// `user`/`home` are the job-user gate's answer (issue #341), null for the image's own USER.
		// `secrets` is the resolved map from the gate above: values, already fetched, host-side. It MUST honour
		// `signal`: stop the container on abort, and reject/exit promptly if `signal.aborted` is already
		// true at entry (the timeout can fire during a slow prepare). The wiring injects name + signal, and
		// on an aborted result it also maps `signal.reason` onto `abortReason` (issue #287) so the
		// classification below can tell an operator's cancel from the kill timer's; a bare wiring that
		// never sets it classifies every abort as worker-abort, exactly as before.
		runContainer,
		cleanup, // (dirs) => void
		comment, // (job, text) => void   (issue status; no-op for local jobs)
		log = () => {},
		// The outbox chain collector (INT-OUTBOX-CONTRACT). No-op default so a job whose wiring omits it --
		// or a github job with no /outbox -- chains nothing. It NEVER throws (outbox.mjs), so its counts are
		// additive telemetry that can never flip the parent's completed outcome (CONST-RETRY-INFRA-ONLY).
		collectChain = async () => ({ enqueued: 0, refused: 0 }),
		// The plan collector (issue #505, outbox-plan.mjs): a completed portfolio job's `/outbox/priorities.json`, handed to
		// applyPlan. Called on the completed branch only, after collectChain, with the pickup's `portfolio` decision. It
		// NEVER throws, so a refused plan is a recorded outcome of a completed job and never a retry. The default collects
		// nothing (null: no plan), so a wiring that omits it records `plan: null`.
		collectPlan = async () => null,
		// Issue #501: the deployment's dollar windows `{ day, week, month }` in micro-dollars (each null when unset), or
		// null when no window is set. Null is the default and the off switch: nothing is reserved or settled and no
		// `budget:usd:*` key is written, so a deployment with no dollar setting is byte-identical.
		dollarCaps = null,
		// Issues #501 part 5 and #502 part 6 (scoped-limits.json version 2): this job's repo or folder dollar windows,
		// `{ scope, keyPrefix, caps }` from `dollarCapsFor`, or null; and the model dollar windows it reserves in,
		// `[{ ref, keyPrefix, caps }]` from `modelDollarRows` over its effective list (every model row when it has
		// none). Both default to nothing, so an unwired processor reserves exactly what it did before.
		scopedDollars = null,
		// Issue #499 part B: this job's project row's dollar windows, `{ scope, keyPrefix, caps }` from
		// `projectDollarCapsFor` with the project resolved at pickup, or null. Reserved after the repo or folder row's.
		projectDollars = null,
		modelDollars = [],
		// Issue #504 part B (DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE): under an envelope, `governedDollars` narrows the
		// ledgers above by the applied split, and these three ride beside them. `otherDollars` is `_other`'s ledger
		// (`{ scope, keyPrefix, caps, capSource }`), for a job in no envelope project; `dollarCapSource` says, per window,
		// whether the deployment cap came from the operator or the envelope total (`scopedDollars` and `projectDollars`
		// carry their own `capSource`). `envelopeMismatch` is the pickup's verdict that this host's envelope is not the
		// applied split's (true), or that it has none while one is applied ("no-envelope"). All default to nothing, so a deployment with no envelope is byte-identical.
		otherDollars = null,
		dollarCapSource = null,
		envelopeMismatch = false,
		// Issue #505: whether the LIVE triggers file still flags this job's cron trigger `run.portfolio: true`, as
		// `(job) => boolean`, and this host's envelope `delegation` block (`{ enabled, writers }`), null with no envelope.
		// The flag on the job data is what the trigger said when the job was queued; the file is what the operator says
		// now, so removing the flag takes effect for a job already queued. The default answers "not flagged": an unwired
		// processor treats every job as an ordinary one, which is what a job with no confirmed flag is.
		checkPortfolioFlag = async () => false,
		envelopeDelegation = null,
		// Issue #504 part B: the project decided at pickup on the folder as named, and a function giving the project of a
		// folder from the same projects snapshot. A local job whose RESOLVED folder belongs to another project is refused
		// after prepare, before any reserve. Absent on a bare wiring, which checks nothing.
		pickupProject = null,
		folderProject = null,
		// Issue #596: the job's size `{ memMiB, cpuCenti, source }`, resolved at pickup from the same limits snapshot as
		// every other gate (index.mjs). Handed to `prepareWorkspace` (a retained run's manifest records it, so a sandbox
		// reopens the run at its size) and to `runContainer`, never through `job.data`. null on a bare wiring: neither call
		// then carries it, and the container gets the built-in 4g and 2.
		jobSize = null,
		// Issue #503 part 7: the builtin catalog's model object for (provider, id), or null (model-catalog.mjs
		// `builtinModel`). Read only by the zero-rated check; the default knows no builtin model, so an unwired
		// processor judges overlay models alone and reserves for every other.
		builtinModel = () => null,
		now = new Date(),
	} = deps;

	// "Forge-backed" is the negation of local, not an enumeration of forges: a job that is not editing a
	// folder on this host is working against a remote, and every gate below applies for the same reason
	// regardless of WHICH remote. Written this way so a new forge inherits the gates rather than having to
	// be added to them -- the failure mode of an enumeration is a forge that silently skips a money gate.
	const isForgeBacked = job.kind !== "local";
	// A local job opted in via `github: true` (cron trigger opt-in, INT-TRIGGERS-FILE-CONTRACT) mints the
	// same scoped per-job token the github path mints (CONST-TOKEN-SCOPED-PER-JOB). Unflagged local jobs
	// stay tokenless, exactly as before.
	const wantsForgeToken = isForgeBacked || job.github === true;
	let token = null;
	let prepared = null;
	// The job-count reservations still standing, in reserve order (issue #499 part B): what `reserveLedgers` took and
	// no refund has given back yet. EVERY refund below is `releaseLedgers` over this one list, last first, so no path
	// can give back one ledger and forget another, and none can give one back twice: a released ledger leaves the list.
	const held = [];
	// The global ledger's own entry, so `budgetReserved` can ask the list. ONE rule on every path (a count refusal, a
	// dollar-cap, config-refused, an InfraRetry): `budgetReserved` says whether the GLOBAL slot is still held after any
	// refund, global-only as INT-RUN-HISTORY-FILE-CONTRACT has it. A scoped or project slot a failed refund left behind
	// is in the `budget_release_failed` log line, not in this field.
	let globalLedger = null;
	const globalHeld = () => globalLedger !== null && held.includes(globalLedger);
	// Give back every held job-count slot, NEVER throwing: a refund that did not land must not replace the caller's
	// classification with a Redis message. Logged with `at`; returns whether the list is empty afterwards.
	const refundLedgers = async (at) => {
		try {
			await releaseLedgers(redis, held, { now });
			return true;
		} catch (releaseError) {
			log("budget_release_failed", { at, code: releaseError?.code ?? null });
			return false;
		}
	};
	// Set once `runContainer` has RESOLVED, which is the only moment a container is known to have run. The
	// config classifier in the catch refunds every job-count ledger, and its whole justification is that nothing was
	// spent; without a fact to test, that is a claim about where config throws happen to live today rather
	// than a property of the code. A config-tagged throw raised after a paid run would otherwise refund a slot
	// the container really spent AND tell the operator publicly that nothing was.
	//
	// AFTER the await and not before, deliberately: `runContainer` resolves the credential and assembles the
	// env before it spawns anything, so its config throws (an unconfigured provider, an unknown forge kind)
	// happen with no container started at all -- and those are exactly what the classifier exists to refund.
	// A spawn fault that fails between is an InfraRetry carrying `container-never-started`, refunded by the
	// arm below, which has a discriminator of its own.
	let containerRan = false;
	// Issue #501. `dollarHold` is the dollar reservation still standing (reserveDollars' hold), null when none was
	// taken or once it has been settled or given back, so no path can settle or refund it twice. `dollars` is what
	// the record says about it (INT-RUN-HISTORY-FILE-CONTRACT), null until the reservation step ran.
	let dollarHold = null;
	let dollars = null;
	// Issue #596: what the container used (`resources` off its exit line), null until a container ran and reported it.
	let resources = null;

	try {
		// The one-shot pre-spend check (issue #231), FIRST on the ladder: one file read, cheaper than
		// the docker inspect below, free, determinate, credential-less. Only a FOREIGN positive
		// disarmed mark refuses -- the check excuses this queue job's own id, so a retry of the
		// delivery that spent the trigger still runs (attempts:2 stays attempts:2) -- and anything
		// unreadable or changed means "run": fail-open, because the disarm writer owns the loud
		// refusals, and a broken read must never wedge every once job. In the compose topology the
		// receiver reads a dead inode until restart, so this check is the once-enforcement layer
		// there, not optional hardening.
		if (job.trigger?.matched?.once === true) {
			const spent = await checkOnceSpent(job);
			if (spent.refused) {
				// Commented like every sibling policy refusal: explainability is this refusal's whole
				// purpose, and only a DISTINCT re-close reaches it past the GUID dedup, so the noise
				// bound is the operator's own reopen-close rate. `at`/`jobId` are harness-written
				// provenance, never payload text.
				await comment(job, `Refused: this one-shot trigger was already spent${spent.at ? ` at ${spent.at}` : ""}${spent.jobId ? ` by job ${spent.jobId}` : ""}. The close that armed it has already produced a run; delete on.disarmed from the trigger entry to re-arm it. Not run.`);
				log("refused_once_already_spent", { triggerIndex: job.trigger?.matched?.index ?? null });
				return { outcome: "policy", reason: "once-already-spent", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		// The wait-skew check (issue #230), second on the ladder and for the first one's reasons: the same
		// file read, free, determinate, credential-less, and pre-spend. It answers a question no other layer
		// can: does the AUTHORED trigger carry wait conditions this job arrived without? That happens when a
		// service below the version floor dropped the field as an unknown key, and the resulting run is
		// byte-identical to a correct one everywhere it is recorded -- so this refusal is the only thing
		// standing between a stale receiver and a paid job that ran when the operator wrote "wait".
		{
			const skew = await checkWaitSkew(job);
			// Issue #502: an authored NARROWING field the job arrived without (`AUTHORED_NARROWING_FIELDS`, triggers-file.mjs),
			// today `run.models` and `run.maxCostUsd`. The same two causes as a dropped wait, and the same refusal shape; without it the job would
			// run on the deployment's list, or on none, while every record reads like a correct run. The FIELD is named,
			// never its value: the comment's reader may be an issue author.
			if (skew.skewed && typeof skew.field === "string") {
				// Three causes, the likeliest first (PR #536's review, round 3, made the check strict): the trigger gained the
				// field after this job was queued, a service is below the version that carries it, or one still reads an
				// older copy of the triggers file. The first is fixed by re-running the job, so the comment says so.
				await comment(job, `Refused: this trigger sets \`run.${skew.field}\`, but the job reached the worker without it, so it would have run without that limit. Either the trigger changed after this job was queued (re-run it), or a service in this deployment is stale: below the version that carries the field, or still reading an older copy of the triggers file and in need of a restart. Not run.`);
				log("refused_trigger_skew", { triggerIndex: job.trigger?.matched?.index ?? null, field: skew.field, causes: "trigger-changed-after-queue-or-stale-service" });
				return { outcome: "policy", reason: "trigger-skew", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false };
			}
			if (skew.skewed) {
				// Named for the operator, not the payload: how many conditions were authored, never what
				// they say. The fix is a version, so the comment says which one.
				// The message names BOTH causes, because the more likely one is not a version at all. In the
				// compose topology the receiver's single-file `:ro` mount pins a dead inode, so an operator
				// who ADDS `waitFor` to an existing rule gets this refusal on every delivery from a service
				// that is perfectly up to date and merely holding an older copy of the file. Naming only the
				// version would send them looking for an upgrade they do not need.
				await comment(job, `Refused: this trigger declares ${skew.conditions} wait condition${skew.conditions === 1 ? "" : "s"}, but the job reached the worker without them, which means it would have run immediately. Either a service in this deployment is below the version that carries the field, or one is still running against an older copy of the triggers file and needs restarting. Not run.`);
				log("refused_wait_skew", { triggerIndex: job.trigger?.matched?.index ?? null, conditions: skew.conditions });
				return { outcome: "policy", reason: "wait-skew", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false };
			}
		}

		// #227. WHERE this job wants to run, against what this deployment blessed. FREE, determinate and
		// credential-less, so it precedes the image inspect below for that gate's own stated reason: a job
		// that names a venue this host will not use must refuse before anything spawns, mints or clones.
		//
		// The LOADER already refused a name this build does not know; what it could not check is PI_BACKENDS,
		// which is a per-host setting a reviewed file must not be refused over -- the same split
		// `run.secretsProfile` draws between its charset check at load and `secret-profile-unknown` here.
		//
		// Enforced HERE and not only in the panel's picker, because `DES-PER-TRIGGER-SECRET-PROFILE` says the
		// overlay is not the reviewed artifact: a tool-side allowlist bounds what an operator can pick, and
		// this bounds what actually runs.
		if (job.backend !== undefined && !blessedBackends.includes(job.backend)) {
			await comment(job, `Refused: this trigger asks to run on the "${job.backend}" backend, which this deployment does not bless. Not run.`);
			// The backend NAME is operator-authored config, never payload, so naming it is PII-safe -- the
			// same class as the image ref below.
			log("refused_backend_unblessed", { backend: job.backend, blessed: blessedBackends });
			return { outcome: "policy", reason: "backend-unblessed", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// Issue #278. PI_BACKEND_FLOOR can ask for a guarantee a backend declares but EARNS only while something
		// about this host is observed -- `local`'s credentialTransit, which holds only while the docker CLI sends
		// containers to a daemon on this host. The read is repeated here, per job, because the CLI's context can
		// change after boot and every later job's provider key and forge token would follow it. FREE and
		// pre-spend: a refusal that will recur on every job must not cost each one a slot. Determinate is a
		// RETURN (CONST-RETRY-INFRA-ONLY); a CLI that could not be asked for a transient reason is a throw,
		// pre-reserve, so the refund is a no-op.
		//
		// AHEAD of the image and egress preflights, not beside them, because both of those talk to the daemon
		// this gate is about: on a redirected CLI an unreachable daemon made the image inspect throw a retry, and
		// a reachable one without the image refused as `job-image-missing` with a comment blaming the image --
		// the right refusal lost behind the wrong one. Issue #345 adds `isolation` (the daemon observed applying a
		// container's bounds) and `mountSet` (the runtime observed adding no mounts), read here from the same
		// `docker info` the job user is decided from, cached per endpoint once it answers, so this read now contacts the
		// daemon (after the endpoint check, which still refuses without it).
		// One refusal, reached from two places (the venue's own answer below, or the job user decided after the image
		// probe). Fixed text per cause class: the cause and anything the runtime said go to the operator's log, never a
		// forge comment.
		const refuseJobUserUnmappable = async (cause) => {
			await comment(job, JOB_USER_COMMENTS[cause] ?? JOB_USER_COMMENTS.default);
			log("refused_job_user_unmappable", { cause: cause ?? null });
			return { outcome: "policy", reason: "job-user-unmappable", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		};
		const observed = await observationPreflight(job);
		if (observed?.refused) {
			// Fixed text per observation: the endpoint (an internal host name or address) and the evidence go to the
			// operator's log, never to a forge comment. "Not observed" rather than "not on this host", because a CLI that
			// could not be asked for a determinate reason (no docker on PATH, a context that does not exist) refuses too.
			// A refusal naming nothing keeps the endpoint's words on `local` only (#278); elsewhere it is the neutral
			// sentence, and so is a name this build has no words for, on any venue (issue #354).
			const onLocal = resolveBackendName(job, blessedBackends[0]) === DEFAULT_BACKEND;
			const missed = Array.isArray(observed.observations) && observed.observations.length > 0 ? observed.observations : [onLocal ? DOCKER_ENDPOINT_LOCAL : null];
			const why = missed.map((o) => (Object.hasOwn(OBSERVATION_COMMENT, o ?? "") ? OBSERVATION_COMMENT[o] : OBSERVATION_COMMENT_UNNAMED));
			await comment(job, `Refused: this deployment's PI_BACKEND_FLOOR requires a guarantee this host is not observed to provide right now (${[...new Set(why)].join("; ")}). Not run.`);
			log("refused_backend_floor_unobserved", { message: observed.message });
			return {
				outcome: "policy",
				reason: "backend-floor-unobserved",
				exitCode: null,
				turns: null,
				tokens: null,
				provider: job.provider ?? null,
				model: job.model ?? null,
				budgetReserved: false,
			};
		}
		if (observed?.unavailable) {
			// The local venue's words stay what they were (they are its log line and BullMQ's failedReason); another venue
			// is not docker's to name.
			const localVenue = resolveBackendName(job, blessedBackends[0]) === DEFAULT_BACKEND;
			// A host FILE that could not be read for a moment (issue #428) is named as that, never as a runtime outage.
			const why = typeof observed.message === "string" && observed.message !== "" ? `a host file an observation the floor needs could not be read just now (${observed.message})` : localVenue ? "docker CLI or daemon unavailable, an observation the floor needs could not run" : "the container runtime or its CLI is unavailable, an observation the floor needs could not run";
			throw new InfraRetry(why, { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}

		// A venue that already knows no uid can run a job there says so HERE, before the image preflight asks that same
		// runtime (issue #354): behind it, a runtime that is not there is retried as unavailable and one that answers
		// without the image is refused as `job-image-missing`, both the wrong fix. Only an answer no image can change
		// comes this way; the per-image half (`anyUid`) stays below, after the probe that reads it.
		if (observed?.jobUserRefused?.refused === "job-user-unmappable") return refuseJobUserUnmappable(observed.jobUserRefused.cause);
		// Issue #428: the podman venue's account sets a containers.conf key that widens what every job reaches (the host's
		// loopback services, the account's groups) and no argv takes back. A VENUE refusal, not a floor miss: with egress
		// off no declared property covers what a job reaches on the host, so a floor would never ask on the deployments at
		// risk. Determinate (the account's own files), so a RETURN (CONST-RETRY-INFRA-ONLY), here for the identity's reason:
		// ahead of the image preflight and every spend. The file and key go to the operator's log; the comment is fixed,
		// and says the configuration widens a job only when a key was FOUND: a chain that could not be read whole is
		// refused for not being known, which is a different sentence. A read that failed for a moment (`transient`) is
		// infrastructure, so it throws and is retried, pre-reserve, exactly like an unanswered observation.
		if (observed?.podmanConfRefused?.transient) {
			// `evidence` names the file (`<path> could not be read (<errno>)`), so the retry says which one: a containers.conf,
			// or since issue #450 the /proc entry of the account's running rootless network. Issue #448: `rootful` is the local
			// venue's, a containers.conf or unit file of rootful Podman's service on this host.
			const what = observed.podmanConfRefused.rootful ? "rootful Podman's containers.conf or podman.service" : "the podman venue's containers.conf or running rootless network";
			throw new InfraRetry(`${what} could not be read just now, so whether it widens a job is not known (${observed.podmanConfRefused.evidence ?? "no file named"})`, { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}
		if (observed?.podmanConfRefused?.retry) {
			// Gate round 1 of PR #473: rootful Podman's service running since before its containers.conf changed (or a change
			// time ahead of the clock) heals by itself, once the service restarts or idles out or the clock passes, so it is
			// never a final `policy` outcome, pre-reserve. Gate round 2: a HOLD, not a retry (`PodmanRestartHold`), which the
			// processor moves back to the delayed set without spending an attempt, for up to `PODMAN_RESTART_HOLD_MAX_MS`.
			throw new PodmanRestartHold(`rootful Podman's service may still hold a containers.conf older than the files, so this job waits for it to restart (${observed.podmanConfRefused.evidence ?? "no file named"})`, { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}
		if (observed?.podmanConfRefused) {
			// Issue #450: `live` is the account's RUNNING rootless network, not a file, so it has its own two sentences: one
			// still carrying an option a removed key gave it (the fix is a restart, not a configuration change), and one
			// whose process could not be read.
			const { key, live, rootful } = observed.podmanConfRefused;
			// Issue #448: `rootful` is the LOCAL venue on rootful Podman's Docker API service, with its own sentences: a key
			// that reaches every local job, and a file it cannot read or does not decode. (A service older than its
			// configuration is a retry, above, since gate round 1 of PR #473.)
			await comment(
				job,
				rootful
					? key
						? "Refused: the worker host's Podman configuration adds to every job's container what this venue does not allow (variables, the Podman service's groups, looser limits and filters, or the programs that run it), so the operator must change it before local jobs run. Not run."
						: "Refused: the worker host's Podman configuration could not be read in full, or is written in a form the worker does not decode, so whether it adds to a job's container what this venue does not allow is not known, and the operator must fix that before local jobs run. Not run."
					: live
						? key
							? "Refused: the worker host's running Podman network still lets a job's container reach the host's own services, with an option from a configuration since changed, so the operator must restart that network before podman jobs run. Not run."
							: "Refused: the worker host's running Podman network could not be read, so whether it lets a job's container reach more than this venue allows is not known, and the operator must fix that before podman jobs run. Not run."
						: key
							? "Refused: the worker host's Podman configuration lets a job's container reach more than this venue allows (the host's own services, the worker account's groups, or looser limits and filters than the worker sets), so the operator must change it before podman jobs run. Not run."
							: "Refused: the worker host's Podman configuration could not be read in full, or is written in a form the worker does not decode, so whether it lets a job's container reach more than this venue allows is not known, and the operator must fix that before podman jobs run. Not run.",
			);
			log("refused_podman_conf_widens_job", { key: key ?? null, ...(live ? { live: true } : {}), ...(rootful ? { rootful: true } : {}), message: observed.podmanConfRefused.message });
			return { outcome: "policy", reason: PODMAN_CONF_WIDENS_JOB, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// The job image must exist on THIS host before anything else happens. Free, determinate and
		// credential-less, so it precedes the mint, the clone and the reservation: a host that cannot run the
		// image refuses without minting a credential it will not use, cloning a repo it will not read, or
		// burning a cap slot. Jobs run with --pull=never (docker-run.mjs), so an absent image is never
		// fetched -- this refusal IS the whole diagnosis, not a race with a background pull.
		const img = await imagePreflight(job);
		// The image's declared pi version, read on the inspect the preflight already ran. Needed BEFORE the
		// container starts, because a transcript written by a different pi may hold tool-call arguments the
		// current schema no longer accepts -- so the resume has to be refused, not repaired mid-run. Null
		// when the image declares none, which downstream means "never resume": the safe direction.
		const piVersion = img.piVersion ?? null;
		if (img.missing) {
			await comment(job, `Refused: the job image "${img.missing}" is not present on the worker host. Not run.`);
			log("refused_image_missing", { image: img.missing });
			// The image ref is operator-authored config (PI_JOB_IMAGE), never payload, so naming it is PII-safe
			// -- the same class as `repo` above.
			// exitCode/turns/tokens null and budgetReserved false: refused pre-container AND pre-reserve.
			// provider/model ride every terminal result from here down (INT-RUN-HISTORY-FILE-CONTRACT):
			// runJob's `job` IS the effectiveJob (index.mjs), so these are the HOST-effective,
			// overlay-resolved dispatch facts -- never anything a container printed -- and even a
			// pre-container refusal attributes which (provider, model) it was dispatched for. There is
			// deliberately NO `usage` key on the pre-container branches: no run, no ledger, and
			// buildRecord defaults the absent field to null.
			return { outcome: "policy", reason: "job-image-missing", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (img.forgeUnsupported) {
			// The image is present and says it cannot serve this forge -- it ships no CLI for it. Determinate,
			// so a refusal rather than a retry, and pre-spend, because the alternative is a paid container
			// that fails at step 3 on every single delivery with nothing to distinguish it from a bad run.
			//
			// The message names the LIKELY CAUSE rather than the label that detected it: a trigger that
			// forgot `run.image`. The failure is upstream of the thing that noticed it, and an operator
			// reading "the image does not declare azure" has further to walk than one reading "set run.image".
			await comment(
				job,
				`Refused: the job image "${img.forgeUnsupported}" does not support ${img.kind} jobs (it declares: ${img.declared.join(", ")}). Set this trigger's \`run.image\` to an image that does. Not run.`,
			);
			log("refused_image_forge_unsupported", { image: img.forgeUnsupported, kind: img.kind, declared: img.declared });
			return { outcome: "policy", reason: "job-image-forge-unsupported", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		// The image capability gates (one table, CAPABILITY_GATES in image-preflight.mjs): the image is present and
		// does not declare a feature this job carries, so its runner would silently ignore it. Determinate, so a
		// refusal rather than a retry, and pre-spend, because no version of this gets better by running. Like the
		// forge branch above, each row's comment names the FIX rather than the label that noticed it.
		const gate = CAPABILITY_GATES.find((row) => img[row.result]);
		if (gate) {
			const image = img[gate.result];
			await comment(job, gate.comment(image, img.declared.length > 0 ? `declares: ${img.declared.join(", ")}` : "is absent"));
			log(gate.event, { image, declared: img.declared });
			return { outcome: "policy", reason: gate.reason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (img.unavailable) {
			// docker itself did not answer -- transient infra, NOT a determinate refusal. THROWN so BullMQ
			// retries (CONST-RETRY-INFRA-ONLY). `container-never-started` is literally true here, and it reuses
			// the refund path below: a no-op pre-reserve, and still honest if this gate ever moves.
			// provider/model attribute even this pre-container death; no usage -- nothing ran to emit one.
			throw new InfraRetry(runtimeUnavailable(resolveBackendName(job, blessedBackends[0]), "image preflight"), { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}

		// Issue #341: WHO runs the container. On a daemon that enforces bind-mount ownership the job must run as the
		// uid that owns its job dir and mounts, or it cannot read its own inputs; where no uid works (a rootless
		// daemon, userns-remap, a root worker) nothing runs. After the image probe because the answer needs its
		// `anyUid` capability, and still FREE: one cached `docker info` per endpoint, no mint, no clone, no reserve.
		const jobUser = await jobUserPreflight(job, { capabilities: img.capabilities ?? [], observed });
		if (jobUser?.refused === "job-user-unmappable") return refuseJobUserUnmappable(jobUser.cause);
		if (jobUser?.refused === "job-image-any-uid-unsupported") {
			// The image ref is operator config, the same PII class as the refusals above.
			await comment(
				job,
				`Refused: the job image "${img.image}" does not declare \`anyUid\` (\`dev.pi-dispatch.capabilities\`), so it cannot run as this worker's own uid, which this host's container runtime requires. Rebuild the image from a version that has this feature. Not run.`,
			);
			log("refused_job_image_any_uid_unsupported", { image: img.image });
			return { outcome: "policy", reason: "job-image-any-uid-unsupported", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (jobUser?.unavailable) {
			// The reason is a fixed token (`daemon-unreachable`, `timeout`, `endpoint-unresolved`...), never CLI text.
			log("job_user_unavailable", { reason: jobUser.reason ?? null });
			throw new InfraRetry("the job user could not be decided", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}

		// Issue #502, two free gates on the job's models, BEFORE the credential gate so a typo in a model or provider
		// id is named as itself rather than as a missing key, and so before the egress probe, the secret resolvers,
		// the mint, the clone, the token-cap read and both reserves (CONST-BUDGET-BEFORE-TOKENS). Both read the
		// EFFECTIVE job (index.mjs `effectiveJobOf`): the main model after the `job.data > overlay > env` fill, and
		// the list as `job.data.models ?? PI_ALLOWED_MODELS`. Checking `job.data` alone would wave through a model
		// the overlay or the env supplied, which is the common case: most forge triggers name none.
		//
		// The model ids are operator configuration, so the log names them; the forge comment does not, for the
		// terminal comments' reason: its reader may be an issue author, who can act on neither.
		{
			// A list that is PRESENT but not a valid list (a string, `{}`, `0`, `false`, `""`, a bad entry) refuses here
			// rather than reading as "no list": the loader and the env parser both refuse such a value, so it is a
			// hand-built or foreign job, and treating it as absent would let it run unrestricted (or hide the
			// deployment's own list behind it). Same refusal as an unknown model, with its own `why`.
			if (job.models !== undefined && job.models !== null && modelListProblem(job.models) !== null) {
				await comment(job, MODEL_UNKNOWN_COMMENT);
				log("refused_model_unknown", { provider: job.provider ?? null, model: job.model ?? null, why: "list-malformed" });
				return { outcome: "policy", reason: "model-unknown", why: "list-malformed", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			const refs = [{ provider: job.provider, id: job.model, main: true }];
			for (const entry of Array.isArray(job.models) ? job.models : []) {
				const ref = splitModelEntry(entry);
				refs.push({ provider: ref.provider, id: ref.model });
			}
			const known = await checkModelsKnown(refs);
			if (known?.unavailable) {
				// The overlay models.json could not be READ just now (an errno, never file text). Retried, never
				// refused, the credential gate's rule for the same file below.
				log("model_catalog_unavailable", { provider: job.provider ?? null, model: job.model ?? null, reason: known.unavailable });
				throw new InfraRetry("whether this job's models exist could not be decided", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
			if (known?.unknown) {
				// An `overlay-*` why is the deployment's file, not the job's model: its own comment.
				const why = typeof known.why === "string" ? known.why : null;
				await comment(job, why?.startsWith("overlay-") ? OVERLAY_REFUSED_COMMENT : MODEL_UNKNOWN_COMMENT);
				// `why` is a fixed token: `overlay-unparseable` tells the operator the file is the problem, not the id.
				log("refused_model_unknown", { provider: known.unknown.provider ?? null, model: known.unknown.id ?? null, why: known.why ?? null });
				return { outcome: "policy", reason: "model-unknown", why, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			// The main model must be on the job's list. The loader refuses this when one trigger names all three, so
			// what reaches here is a model or provider the overlay or the env supplied: a `PI_ALLOWED_MODELS` that
			// does not list `PI_MODEL`, or a `dispatch_set model` that moved the default off a trigger's list. Both
			// halves are compared, exact (`modelOnList`), the runner guard's rule.
			if (Array.isArray(job.models) && !modelOnList(job.models, job.provider, job.model)) {
				await comment(job, "Refused: the AI model this job would run on is not on the list of models it is allowed to use, so no container was started and nothing was spent. Ask the operator to check the trigger's model settings. Not run.");
				log("refused_model_not_allowed", { provider: job.provider ?? null, model: job.model ?? null });
				return { outcome: "policy", reason: "model-not-allowed", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			// A listed model whose declared fallbacks are not all listed (model-catalog.mjs `declaredFallbacks`): on
			// anthropic-messages pi sends them with every call, so the runner's guard would refuse every call to it after
			// the container started; on any other api the worker is stricter than the runner, by decision. Refused here, free. The log names the listed model, the operator's own configuration; the
			// comment names none.
			if (known?.fallbackUnlisted) {
				await comment(job, "Refused: a model this job is allowed to use declares fallback models that are not on the job's list, so no container was started and nothing was spent. Ask the operator to list those models too, or remove that model. Not run.");
				log("refused_model_not_allowed", { provider: known.fallbackUnlisted.provider ?? null, model: known.fallbackUnlisted.id ?? null, why: "fallback-unlisted" });
				return { outcome: "policy", reason: "model-not-allowed", why: "fallback-unlisted", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		// Is there a credential to run this job with at all? FREE, determinate and I/O-light: a pure function
		// of the job's provider, the worker env, and (only when the env has no key) one small readFileSync of
		// pi's auth.json. So it goes here, with the other free gates, which is further than issue #310 asked
		// for: ahead of the image probe, the mint, the clone, the token-cap read and both reserves. That is
		// CONST-BUDGET-BEFORE-TOKENS in its own words, "every gate that costs nothing runs before every gate
		// that costs something".
		//
		// AFTER the image probe and not before, which is the one ordering choice here that costs something:
		// a `docker inspect` runs before a `readFileSync`. This file says twice that a missing image blocks
		// EVERY job of EVERY kind on this host, so it is the fault an operator must fix first either way, and
		// a missing credential is in exactly that class -- on a host with both, the reported reason should be
		// the one that was already the rule. Everything the gate is actually FOR is still below it: the egress
		// probe, the secret resolvers, the mint, the clone, the token-cap read and both reserves.
		//
		// It used to be discovered inside runContainer, where buildContainerEnv resolves the credential for
		// real -- AFTER both reserves -- and the throw fell through this function's catch to a bare rethrow.
		// The catch now classifies that too (below), so this gate is the cheap path and that is the backstop;
		// neither alone is enough, because the backstop cannot un-mint a token or un-clone a repository.
		//
		// The refusal names no path. `credentialFromPiAuth`'s messages carry auth.json's location, `comment`
		// posts publicly on the issue, and the reason an operator needs is the same either way: their
		// deployment has no usable provider credential and `doctor` will say exactly which variable.
		// `modelEndpoints` is the pickup's snapshot (issue #503), handed to the gate and to runContainer alike, so a
		// keyless provider passes here and gets its PI_DISPATCH_KEYLESS there from ONE read of the declaration. runContainer
		// is handed it only when an endpoint is declared, so with none its context is byte-identical to before.
		// THE ENVELOPE GATE (issue #504 part B, DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE): this host's envelope digest is not
		// the applied split's, so the split this job would be judged against was computed for another envelope. FREE and
		// determinate (the pickup read decided it), so it sits with the free gates, before the mint, the clone, the
		// token-cap read and every reserve (CONST-BUDGET-BEFORE-TOKENS), and it RETURNS: a retry meets the same envelope
		// until the operator makes the hosts agree (CONST-RETRY-INFRA-ONLY). Refusing is loud and money-safe; judging one
		// split against two envelopes is neither.
		// `envelopeMismatch` is true (this host's envelope is another one) or "no-envelope" (it has none while the fleet has
		// an applied split): one reason, two texts, since the fix differs.
		if (envelopeMismatch === true || envelopeMismatch === "no-envelope") {
			const absent = envelopeMismatch === "no-envelope";
			await comment(
				job,
				absent
					? "Refused: this worker has no budget envelope while the other workers share an applied budget split, so no container was started and nothing was spent. Ask the operator to install the envelope on this worker, or to turn delegated allocation off for every worker (`pi-dispatch doctor` says how). Not run."
					: "Refused: this worker's budget envelope differs from the one the current budget split was made for, so no container was started and nothing was spent. Ask the operator to run `pi-dispatch doctor`. Not run.",
			);
			log("refused_envelope_mismatch", absent ? { envelope: "none" } : {});
			return { outcome: "policy", reason: ENVELOPE_MISMATCH_REASON, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// THE PORTFOLIO GATE (issue #505, `portfolio-no-envelope`). A portfolio job exists to write a priorities plan, and a
		// plan applies only on a host whose envelope has delegation on with `portfolio-job` among its writers. Without
		// that the plan is refused after the job has paid to write it, so the job is refused here instead: FREE (the
		// envelope was read at boot or reload, the triggers file is one local read), before the mint, the clone, the
		// token-cap read and every reserve (CONST-BUDGET-BEFORE-TOKENS), and RETURNED, since a retry meets the same
		// envelope (CONST-RETRY-INFRA-ONLY). After the envelope gate, which names the host-wide fault first.
		//
		// The live flag comes FIRST. The job data says what the trigger said when it was queued; the live file says what
		// the operator says now. A job whose trigger no longer flags it (or whose file cannot be read) is an ordinary
		// cron job: it runs unflagged and passes this gate, rather than being refused for a flag nobody holds any more.
		// Only a job with a cron `trigger` and no chain fields is asked about at all: a manual run and a chained child can
		// never be a portfolio job, whatever their data says.
		const portfolio = job.portfolio === true && job.trigger !== undefined && job.parentJobId === undefined && job.chainDepth === undefined && (await Promise.resolve().then(() => checkPortfolioFlag(job)).catch(() => false)) === true;
		if (portfolio) {
			const delegation = envelopeDelegation;
			const why = delegation === null || delegation === undefined ? "no-envelope" : delegation.enabled !== true ? "delegation-off" : !Array.isArray(delegation.writers) || !delegation.writers.includes("portfolio-job") ? "writer-not-allowed" : null;
			if (why !== null) {
				// No comment: a portfolio job is always local, and a local job has no issue to comment on. `why` is a
				// fixed token, so the log says which of the three the operator has to change.
				log("refused_portfolio_no_envelope", { why });
				return { outcome: "policy", reason: PORTFOLIO_NO_ENVELOPE, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		const credential = await checkProviderCredential(job, { modelEndpoints });
		if (credential.unavailable) {
			// Issue #503: the overlay models.json could not be read at this pickup for a transient reason, so the gate has no
			// verdict for a provider that may be keyless. Retried, never refused: a refusal is permanent and public, and the
			// next attempt may read the file. The code is a fixed errno token, never file text.
			log("provider_credential_unavailable", { provider: job.provider ?? null, reason: credential.unavailable });
			throw new InfraRetry("the provider credential could not be decided", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}
		if (!credential.ok) {
			// The PROVIDER is named and the message is not. The provider is operator-authored config, already
			// on the record and the mirror, and named freely by the sibling refusals (`backend-unblessed` names
			// the backend, `job-image-missing` names the image), so withholding it would tell the operator less
			// than is safe. The message is withheld from BOTH surfaces: `credentialFromPiAuth`'s refusals carry
			// `auth.json`'s absolute path, which is an OS account name, and the scoped-budget refusal below
			// keeps a host path out of its own log line citing no-pii-in-logs. `doctor` prints the variable and
			// the path, on the operator's terminal, which is where that belongs.
			await comment(job, `Refused: this deployment has no usable credential for the "${job.provider}" provider, so no container was started and nothing was spent. Ask the operator to run \`pi-dispatch doctor\`. Not run.`);
			log("refused_provider_unconfigured", { provider: job.provider ?? null });
			return { outcome: "policy", reason: "provider-unconfigured", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}


		// REQ-EGRESS-ALLOWLIST. The egress policy this deployment claims must be able to serve this job
		// BEFORE the job costs anything. It is one `docker inspect` when the policy is armed and ZERO spawns
		// when it is not, so a deployment without one pays nothing at all.
		//
		// PLACEMENT, and it is the same ladder the image preflight sits at the top of. A missing proxy blocks
		// EVERY job of EVERY kind on this host -- like a missing image -- and unlike a missing image it blocks
		// them EXPENSIVELY: the container starts, the provider is unreachable, the runner exits 1, exit 1 is
		// the retryable class, `attempts: 2`, and `releaseBudget` refunds only `container-never-started` --
		// this container started. So each such job spends two job-count slots and buys nothing with either,
		// and a cron-driven deployment empties its daily cap before anyone reads the first failure. That cost
		// is what makes this a pre-spend gate rather than a doc: measured at three provider attempts,
		// `Request timed out.`, exit 1, ~40 seconds, zero tokens (docs/egress.md).
		//
		// A RETURN, never a throw (CONST-RETRY-INFRA-ONLY): retrying never makes an absent proxy appear.
		const egress = await egressPreflight(job);
		if (egress.proxyMissing || egress.proxyStopped) {
			const proxy = egress.proxyMissing ?? egress.proxyStopped;
			const state = egress.proxyMissing ? "is not on this host" : "is not running";
			await comment(job, `Refused: this deployment runs jobs behind an egress policy and its allowlist proxy "${proxy}" ${state}, so the job could not reach the provider and would burn its budget slot proving it. ${egressProxyFix(resolveBackendName(job, blessedBackends[0]), proxy)}, or set PI_EGRESS=0 to run without an egress policy. Not run.`);
			// The proxy's NAME is operator-authored deployment config, never payload -- the same PII class as
			// the image ref on the refusal above.
			log(egress.proxyMissing ? "refused_egress_proxy_missing" : "refused_egress_proxy_stopped", { proxy });
			return {
				outcome: "policy",
				reason: egress.proxyMissing ? "egress-proxy-missing" : "egress-proxy-stopped",
				exitCode: null,
				turns: null,
				tokens: null,
				provider: job.provider ?? null,
				model: job.model ?? null,
				budgetReserved: false, // refused before reserveBudget, so no job-count slot was consumed
			};
		}
		if (egress.unavailable && egress.keeper) {
			// Issue #458: the podman venue on Podman 4.x, proxy up, its rootless network keeper not holding. INFRA, not a
			// refusal: the keeper is one `systemctl --user` away, and a retry after it holds runs the job. Pre-reserve, so
			// nothing is refunded. Its OWN reason token (PR #463 round 2), so the run record, the failure hook and the
			// terminal comment can name the keeper rather than a generic never-started container; the full sentence rides
			// the error message and is logged whole here, where `job_failed` cuts it at 120 characters.
			// Issue #476: a keeper whose only fault is its age is HELD for, not failed on. `makeProcessor` moves the job to
			// the delayed set until the keeper is old enough, without an attempt, and names a crash loop if it keeps
			// restarting; a path that does not know the hold still retries it, since it is an `InfraRetry`.
			if (egress.young) throw new NetnsKeeperYoungHold(egress.keeper, { reason: NETNS_KEEPER_NOT_HOLDING, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false, young: egress.young, remedy: egress.remedy ?? null });
			log("egress_keeper_not_holding", { proxy: egress.unavailable, reason: egress.keeper });
			throw Object.assign(new InfraRetry(egress.keeper, { reason: NETNS_KEEPER_NOT_HOLDING, provider: job.provider ?? null, model: job.model ?? null }), { keeperProblem: egress.problem ?? null, keeperRemedy: egress.remedy ?? null });
		}
		if (egress.unavailable) {
			// The daemon did not answer, so this is indeterminate rather than a refusal -- the same
			// determinate/indeterminate split the image preflight draws one gate up, and thrown for the same
			// reason. Pre-reserve, so the refund below is a no-op and still honest if this gate ever moves.
			// With a proxy STATE (issue #453, gate round 3): the daemon answered and the proxy is on its way somewhere
			// (restarting, created, ...), so the words name the proxy and its state rather than blaming the runtime.
			const said = typeof egress.state === "string" ? `egress proxy "${egress.unavailable}" is ${egress.state}, not running; the job is retried once, then failed` : runtimeUnavailable(resolveBackendName(job, blessedBackends[0]), "egress preflight");
			throw new InfraRetry(said, { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}

		// REQ-RESUMABLE-SESSION's one fail-CLOSED case. Everything else in that feature fails OPEN and
		// NAMES itself -- absent, expired, too-large, unparseable, locked, promote-failed -- because a cold
		// start is a correct run. This one cannot be: with no `sessionsDir`, resolveSession returns null
		// (session-store.mjs), so nothing is staged, no /session is mounted, the transcript dies with the
		// container, and the NEXT job on that key cold-starts too. The job would exit 0 and look like the
		// feature worked. That is an operator who believes a disclosure is on while it is off, with a green
		// run to confirm the belief -- the inversion validatePackagesFlag's comment describes one flag over,
		// arriving from the other direction.
		//
		// PLACEMENT IS THE POINT. Free, determinate, credential-less and I/O-less -- the answer is two
		// values already in hand -- so it belongs among the free policy refusals and strictly before
		// anything that spends: before the mint (no credential is needed to know the answer, so none is
		// created only to be discarded), before the branch check's API call, before prepareWorkspace's
		// clone, before checkTokenCap's read and before reserveBudget's INCR -- hence `budgetReserved:
		// false`. It sits AFTER the image preflight for the reporting reason the token-cap comment below
		// already states: a missing image blocks EVERY job of EVERY kind on this host, so it is the one an
		// operator must fix first either way, while this blocks only the triggers that armed the flag.
		//
		// Strict `=== true`, the same test prepare-github.mjs uses to decide whether to resolve a session at
		// all, so the gate and the feature cannot disagree about what "armed" means. Kind-agnostic on
		// purpose: only forge jobs can arm the flag today (triggers.mjs refuses it on cron, and a CLI or
		// chained job has no trigger entry that could set it), but a gate written as an enumeration of kinds
		// is a gate the next kind skips silently.
		if (job.resume === true && !sessionsDir) {
			await comment(job, "Refused: this trigger set `run.resume` but PI_SESSIONS_DIR is unset, so there is nowhere to persist the transcript -- the job would run with no session and still report success. Set PI_SESSIONS_DIR to a private directory outside every repo, or drop `run.resume` from this trigger. Not run.");
			// The variable NAME, never a value: there is no path to print here (its absence IS the refusal),
			// and the store's path is the one setting SECURITY.md calls a PII store. `kind` is host-assigned,
			// the same PII class as the `repo` on the branch refusal below.
			log("refused_sessions_dir_unset", { kind: job.kind ?? null });
			// exitCode/turns/tokens null and budgetReserved false: refused pre-container AND pre-reserve,
			// exactly as the image refusals above. RETURNED, not thrown: an unset environment variable is
			// determinate, and no number of retries sets it (CONST-RETRY-INFRA-ONLY).
			return { outcome: "policy", reason: "sessions-dir-unset", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// REQ-PER-TRIGGER-SKILLS. A trigger that named a skills directory the worker cannot see would run
		// its flow WITHOUT the skills it was written against, produce a plausible report, and exit 0. Free
		// and determinate -- one lstat, no credential needed to know the answer -- so it belongs among the
		// free refusals and strictly before anything that spends: before the mint (no token is created only
		// to be discarded), before the clone, before the token-cap read and before reserveBudget
		// (CONST-BUDGET-BEFORE-TOKENS). Last among the free gates because it is the NARROWEST: a missing
		// image blocks every job on this host, an unset sessions dir blocks every armed trigger, a bad
		// skillsDir blocks one trigger.
		if (job.skillsDir && !isReadableDir(job.skillsDir)) {
			await comment(job, "Refused: this trigger set `run.skillsDir`, and that path is absent or is not a directory on the worker host. The job would have run without the skills the flow was written against. Not run.");
			// The FIELD name, never its value. `comment` posts publicly on the issue, so a host path here
			// would publish the operator's filesystem layout to anyone reading the thread; the log line is
			// the same restraint refused_sessions_dir_unset keeps.
			log("refused_skills_dir_missing", { kind: job.kind ?? null });
			return { outcome: "policy", reason: "skills-dir-missing", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// REQ-TRIGGER-SECRETS. A trigger that named secret references the worker cannot resolve would run its
		// flow with those variables UNSET, get a 401 from whatever it was meant to reach, write a plausible
		// report about why the integration is down, and exit 0.
		//
		// PLACEMENT. Strictly before the mint below, the clone in prepareWorkspace, the token-cap read and
		// reserveBudget, so a refusal here costs nothing (CONST-BUDGET-BEFORE-TOKENS). But it is NOT one of the
		// "free, determinate, credential-less and I/O-less" gates above, and this comment must not claim it is:
		// resolving spawns a subprocess per reference against the operator's manager, which is none of those
		// four things. The precedent it actually follows is one gate LATER -- prepareWorkspace already performs
		// a full network clone before the budget is reserved. An I/O-bound pre-budget step is established here;
		// a free one it is not. It sits last among the pre-mint gates because it is both the narrowest and the
		// only one that can block, so every cheaper answer is already in hand when it runs.
		//
		// There is deliberately no cheap "would this resolve?" probe. The reference grammar belongs to the
		// resolver (#206, #209: the seam is a command), so this project has nothing it could validate short of
		// asking -- the same shape the branch-protection check takes, where the check IS the real call.
		//
		// Guarded by `secretsArmed` at the CALL SITE, not inside the resolver: an unflagged job must not reach
		// it under ANY wiring, and a guard that lives in the default is a guard an injected resolver skips.
		//
		// The load-time reserved names are asked again HERE, of the job itself, for the same reason (issue
		// #511). parseTriggers refuses them when the file loads, but a job does not always come from a file
		// this worker loaded: one queued before an upgrade widened the set, a cron job-scheduler template
		// stored in Valkey (schedules.mjs keeps `run.secrets` in it), or a receiver older than the worker all
		// carry `secrets` the current set would refuse, and buildContainerEnv would write every one of them.
		// The same set the loader uses, imported, so the two cannot drift, and checked before the resolver so
		// no wiring of it can skip the check.
		const loadReserved = secretsArmed(job) ? Object.keys(job.secrets ?? {}).find((name) => RESERVED_ENV_NAMES.has(name)) : undefined;
		const resolved = loadReserved !== undefined ? { reserved: loadReserved, atLoad: true } : secretsArmed(job) ? await resolveSecrets(job) : { ok: true, secrets: {} };
		if (resolved.profileUnknown) {
			await comment(job, "Refused: this trigger set `run.secrets`, and the resolver profile it names is not usable on this worker host. No profile of that name is declared, or its resolver is absent or not executable. The job would have started with those variables unset, and an agent that gets a 401 writes a plausible report and exits 0. Run `pi-dispatch doctor` on the worker to see which profiles it has. Not run.");
			// The operator's own profile LABEL, and never a path, a reference, or a byte the resolver printed.
			// `comment` posts publicly on the issue: a resolver path there publishes the operator's filesystem
			// layout, and the DECLARED profile names would publish their vault topology -- which is why the
			// message points at doctor for the list instead of enumerating it. The label itself is
			// operator-authored trigger config, the same class as the image ref the job-image refusals name.
			log("refused_secret_profile_unknown", { kind: job.kind ?? null, profile: resolved.profileUnknown });
			return { outcome: "policy", reason: "secret-profile-unknown", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		if (resolved.ambiguous) {
			// Two sources declared one profile name. Neither wins, deliberately: runtime-settings documents the
			// overlay's precedence as overlay > env, so inverting it here would leave two rules disagreeing about
			// what an overlay is, while honouring it would let a settings file -- which PI_SETTINGS_FILE can put
			// anywhere -- redirect a profile the operator wrote in .env. This project already refuses ambiguity
			// rather than resolving it (PI_EGRESS: "a typo must never leave you believing you have a policy you
			// do not"), and an operator who sees this fixes it in seconds.
			await comment(job, "Refused: this trigger set `run.secrets`, and the resolver profile it names is declared twice on this worker host, once in the environment and once in the settings overlay. Neither wins, on purpose: the job would otherwise run against whichever one happened to be picked. Remove one of the two. Not run.");
			log("refused_secret_profile_ambiguous", { kind: job.kind ?? null, profile: resolved.ambiguous });
			return { outcome: "policy", reason: "secret-profile-ambiguous", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		if (resolved.reserved !== undefined) {
			// A key the worker itself writes OR that pi reads for this job's provider, and one parseTriggers
			// could not have caught: which variables the provider uses depends on this job's resolved provider,
			// and PI_FORWARD_ENV is an operator env list. Both are deployment state, so this is the same
			// load-time / pre-spend split run.resume makes against PI_SESSIONS_DIR.
			//
			// TWO failures, opposite in direction, which is why the message names neither (issue #309):
			//   - the worker WRITES the name: buildContainerEnv assigns the provider credential and
			//     PI_FORWARD_ENV before this feature's values, so the trigger's value replaces the operator's
			//     and every job of that trigger spends the trigger author's key;
			//   - the worker does NOT write the name but pi READS it first: the OAuth token variable, and from
			//     the 0.99.1 pin the bearer ANTHROPIC_AUTH_TOKEN (issue #509), are deliberately never written
			//     (apiKeyVariable skips both), so a trigger binding one lands beside the operator's key and
			//     outranks it in pi's own precedence.
			// The old message asserted the first for both, which is exactly backwards for the second.
			// A name the triggers file itself would refuse at load (issue #511) reaches here only from a job
			// queued before that refusal, a stored cron scheduler template, or an older receiver, so it says that.
			await comment(
				job,
				resolved.atLoad
					? `Refused: this job's \`run.secrets\` binds \`${resolved.reserved}\`, a name the triggers file refuses at load because this deployment writes it or pi reads it to configure a provider or itself. The job was queued before that refusal applied, by a stored cron schedule, or by an older receiver. Rename it in the triggers file. Not run.`
					: `Refused: this trigger's \`run.secrets\` binds \`${resolved.reserved}\`, which is a variable this deployment already uses for the job's own credentials. Whichever of the two values reached the container, one of them would be silently ignored. Rename it in the triggers file. Not run.`,
			);
			// The variable NAME only. It is the operator's own choice of name, not payload, and naming it is what
			// makes the refusal actionable -- but the REFERENCE behind it never appears.
			log("refused_secret_name_reserved", { kind: job.kind ?? null, name: resolved.reserved });
			return { outcome: "policy", reason: "secret-name-reserved", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		if (resolved.unresolved) {
			// DETERMINATE: the resolver said exit 2, printed nothing, overran the size cap, or returned a value
			// with a NUL in it. Retrying cannot change any of those, so this RETURNS (CONST-RETRY-INFRA-ONLY).
			const why = SECRET_FAILURES[resolved.failure] ?? "did not return a value";
			await comment(job, `Refused: this trigger set \`run.secrets\`, and the resolver for \`${resolved.unresolved}\` ${why}. The job would have started with that variable unset, and an agent that gets a 401 writes a plausible report and exits 0. Run your profile's resolver by hand against that reference to see why: this comment carries neither the reference, nor the resolver's path, nor a byte of what it printed. Not run.`);
			// The variable NAME, never a value -- the restraint refused_sessions_dir_unset keeps, and the name is
			// the operator's own choice rather than payload. `failure` is OUR enum, `code` the script's small
			// integer exit, `stderrBytes` a COUNT: never the resolver's words.
			log("refused_secret_unresolved", { kind: job.kind ?? null, name: resolved.unresolved, failure: resolved.failure ?? null, code: resolved.code ?? null, stderrBytes: resolved.stderrBytes ?? 0 });
			return { outcome: "policy", reason: "secret-unresolved", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		if (resolved.unreachable) {
			// INDETERMINATE: exit 1 ("could not reach my manager"), an exit code we do not recognise, a spawn
			// fault, or a timeout. THROWS, so BullMQ retries per `attempts` -- the determinate/indeterminate split
			// the image and egress preflights already draw, decided here by the resolver's own exit code rather
			// than by matching its stderr, which image-preflight.mjs forbids for good reason. Folding this into
			// the refusal above would permanently burn a delivery over a twenty-second vault blip, and a webhook
			// does not redeliver itself. Nothing has spent: `budgetReserved` computes false in the catch below
			// because no ledger is held yet.
			log("secret_resolver_unreachable", { kind: job.kind ?? null, name: resolved.unreachable, failure: resolved.failure ?? null, code: resolved.code ?? null, stderrBytes: resolved.stderrBytes ?? 0 });
			throw new InfraRetry(`secret resolver could not answer for ${resolved.unreachable}`, { reason: "secret-resolver-unreachable", provider: job.provider ?? null, model: job.model ?? null });
		}
		const secrets = resolved.secrets ?? {};

		if (wantsForgeToken) {
			token = await mintToken(job);

			// Defense-in-depth at the DI seam: mintToken is injected, so we cannot assume it routed
			// through get-token's own empty-token guard. An empty credential here would reach
			// env-allowlist's `if (githubToken)` as a falsy value -> GITHUB_TOKEN omitted -> an
			// anonymous paid run. Refuse before reserveBudget so a bad token burns no cap slot.
			if (typeof token !== "string" || token.trim() === "") {
				throw configError("mintToken returned an empty credential");
			}
		}

		if (isForgeBacked) {
			// REQ-BRANCH-PROTECTION-PRECONDITION. The agent's token can merge, so branch protection is the
			// only technical barrier to a self-merge. Refuse before spending anything. Forge-backed jobs
			// only: a local job has no remote branch to protect.
			if (!(await isDefaultBranchProtected(job, token))) {
				await comment(job, "Refused: the default branch is not protected. See SECURITY.md.");
				log("refused_unprotected", { repo: job.repo });
				// exitCode/turns/tokens null: refused pre-container, so no container exit, turn, or token count exists.
				return { outcome: "policy", reason: "unprotected-branch", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		// `podmanStore` (issue #429) only where the venue's job user carried one: the podman store the container ran in.
		// `portfolio` (issue #505) only for a job the gate above confirmed: prepare then writes /job/portfolio.json, after
		// asking the live file once more. Absent otherwise, so every other job's prepare call is unchanged.
		prepared = await prepareWorkspace(job, token, { piVersion, jobUser: { user: jobUser?.user ?? null, home: jobUser?.home ?? null }, ...(typeof jobUser?.store === "string" ? { podmanStore: jobUser.store } : {}), ...(portfolio ? { portfolio: true } : {}), ...(jobSize ? { size: jobSize } : {}) }); // resolves SHA, clones, materialises .pi/, writes prompt

		// A determinate prepare refusal -- sha-gone (the default branch advanced past the resolved tip),
		// or a `pi-*` materialiser cap breach (the repo's .pi/ is too large to place in /job, issue #60)
		// -- is POLICY: return before reserveBudget so it burns no cap slot and is never retried.
		// Mirrors the branch-protection policy return above. Spread-plus-attribution: the prepare
		// result keeps its own reason and fields, and the host-effective provider/model land beside
		// them exactly as on every other terminal result. `budgetReserved: false` like every pre-reserve refusal (issue
		// #507): nothing was reserved and no container started, so the record says so and the cost fold counts the run as
		// an exact $0 rather than a floor (REQ-COST-ANALYTICS (d)). After the spread, so no preparer can say otherwise.
		if (prepared?.outcome === "policy") {
			return { ...prepared, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false };
		}

		// THE RESOLVED FOLDER'S PROJECT (issue #504 part B). The pickup decided the project, and so the share a job reserves
		// against, from the folder AS NAMED; the container mounts the folder prepare RESOLVED. A link or a case variant
		// inside a run root that leads into ANOTHER project's member would bill that work to the named project's share.
		// Refused here, after prepare and before the token-cap read and every reserve: free, determinate, never retried. A
		// resolved folder in no project is not refused, because the named spelling is the operator's own membership
		// (a symlinked member is listed by the path the triggers use, docs/projects.md).
		if (job.kind === "local" && typeof folderProject === "function" && typeof prepared?.workspace === "string") {
			const resolvedProject = folderProject(prepared.workspace);
			if (resolvedProject !== null && resolvedProject !== pickupProject) {
				await comment(job, "Refused: this job's folder now leads into another project's folder, so no container was started and nothing was spent. Not run.");
				log("refused_local_folder_project_changed", { pickup: pickupProject, resolved: resolvedProject });
				return { outcome: "policy", reason: LOCAL_FOLDER_PROJECT_CHANGED, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		// Daily TOKEN cap (issue #25): the deliberate check-AFTER control. Token cost is only known
		// post-run, so this cannot check-and-increment before the spend the way the job-count cap does
		// (CONST-BUDGET-BEFORE-TOKENS). It is a read-only GET of prior jobs' recorded spend -- it consumes
		// nothing, so it precedes reserveBudget's INCR and a refusal here burns no job-count slot. It can
		// only stop the NEXT job once the day's accumulated spend has reached the cap; the actual INCRBY
		// happens post-container via recordSpend. Reported before the job-count cap only because both are
		// spend gates; the more-actionable branch-protection precondition is still reported first above --
		// behind only the image check, which outranks it because a missing image blocks EVERY job of EVERY
		// kind on this host, so it is the one the operator must fix first either way.
		const tokenGate = await checkTokenCap(redis, { cap: tokenCap, now });
		if (!tokenGate.allowed) {
			await comment(job, `Over the daily token cap (${tokenGate.spent}/${tokenGate.cap} tokens). Not run.`);
			log("over_token_budget", { spent: tokenGate.spent, cap: tokenGate.cap });
			// budgetReserved false: refused before reserveBudget, so no job-count slot was consumed.
			return { outcome: "policy", reason: "daily-token-cap", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// The JOB-COUNT ledgers (issues #242 and #499 part B, INT-SCOPED-LIMITS-FILE-CONTRACT), narrowest first: the repo
		// or folder row, the project row, then the global windows, reserved in that order by ONE helper. A narrow
		// ledger's refusal never consumes a slot in a wider one -- the global INCR runs only for jobs every scoped ledger
		// admitted, and a project's only for jobs their repo admitted. Same atomic INCR, same refused-still-counts
		// invariant per ledger, through budget.mjs's keyPrefix seam (budget:s:<hash16> of the row scope). softHoldPct is
		// deliberately GLOBAL-ONLY: the band is one operator brake on overall spend, not a per-row knob; scoped windows
		// are hard caps (DES-SCOPED-LIMITS-AND-FOLDER-MUTEX).
		//
		// A redis fault mid-walk gives back every LEDGER that landed whole (`held` is exact) and rethrows. Inside the
		// ledger that faulted, the windows INCRed before the fault stay counted (a week INCR that faults leaves that
		// ledger's day counted, an EXPIRE that faults leaves its key without a TTL): `reserveBudget` does not say which of
		// its windows landed, so giving them back could DECR a window that never rose. That is the pre-existing
		// mid-reserve posture of one ledger, unchanged.
		globalLedger = { scope: null, keyPrefix: null, caps, softHoldPct, reason: null };
		let counted;
		try {
			counted = await reserveLedgers(redis, [...(scopedLedgers ?? []), globalLedger], held, { now });
		} catch (error) {
			// Valkey failed mid-walk. No container can have started, and `held` lists exactly the reservations that
			// landed, so they go back (last first, never throwing) before the error escapes; otherwise a repo and a
			// project slot would stay counted for a job that never ran.
			await refundLedgers("reserve-fault");
			throw error;
		}
		if (!counted.allowed) {
			// Every ledger BEFORE the refusing one gives its slot back, last first: a ledger that did not issue the
			// refusal gives back. Without this, an exhausted global window drains every arriving scope's and project's own
			// counters with zero runs to show for it, and a full project drains its members' repo windows. The refusing
			// ledger keeps its own slot (refused-still-counts, per ledger).
			await refundLedgers(counted.refusedBy.reason ?? counted.result.reason);
			const result = counted.result;
			const w = result.blockedWindow;
			const win = result.windows[w];
			if (counted.refusedBy === globalLedger) {
				if (result.reason === "soft-hold") {
					await comment(job, `Soft-hold: ${w} spend ${win.reserved}/${win.cap} is inside the ${softHoldPct}% hold band. New starts paused; not run.`);
					log("soft_hold", { window: w, reserved: win.reserved, cap: win.cap, pct: softHoldPct });
				} else {
					await comment(job, `Over the ${w} budget cap (${win.cap}). Not run.`);
					log("over_budget", { window: w, reserved: win.reserved, cap: win.cap });
				}
				// budgetReserved true: the global slot is reserved and kept (a refused reservation still counts). Both
				// over-budget and soft-hold are POLICY, RETURNED (not retried) -- the agent never ran.
				return { outcome: "policy", reason: result.reason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: true }; // return => not retried
			}
			const isProject = counted.refusedBy.reason === PROJECT_CAP_REASON;
			// A local job's scope is a full host path and its "comment" is not dropped -- the wiring's local adapter LOGS
			// the text (start.mjs forgeFor fallthrough) -- so the path must never enter the message; "this folder" is enough
			// beside the jobId the adapter logs. A forge scope IS the repo the comment posts on, safe to name, and named
			// without a forge prefix (issue #498). A project is "this project": the comment's reader may be an issue
			// author, and which repos an operator groups is the operator's business, not theirs.
			const scopeLabel = isProject ? "this project" : job.kind === "local" ? "this folder" : unqualifiedScope(counted.refusedBy.scope);
			await comment(job, `Over the ${w} run cap for ${scopeLabel} (${win.cap}). Not run.`);
			// The scope rides the log as its 16-hex key, NEVER the raw string: a folder-scoped cap would put a full host
			// path in the worker log against no-pii-in-logs. The admin recomputes the key from the configured scope. A
			// project refusal adds `ledger: "project"`; a repo or folder one keeps the line it always had.
			log("over_scope_budget", { scopeKey: counted.refusedBy.keyPrefix, ...(isProject ? { ledger: "project" } : {}), window: w, reserved: win.reserved, cap: win.cap, kind: job.kind === "local" ? "local" : "forge" });
			// budgetReserved false: the GLOBAL slot was never touched (every scoped ledger reserves first).
			return { outcome: "policy", reason: counted.refusedBy.reason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// DOLLAR windows (issue #501, part 3), after EVERY job-count reserve and before the container: the last gate
		// before the spend line (CONST-BUDGET-BEFORE-TOKENS). Every free gate and every job-count ledger come first, so
		// a refusal anywhere above never touches a dollar counter. The amount is the job's per-job cost cap, which the
		// runner enforces before every call, so it bounds what the run can spend; the worker needs no prices.
		let containerJob = job;
		// Every dollar ledger this job reserves in: the deployment's windows, its repo or folder row's, and each model
		// row it may reach (scoped-limits.json version 2). ONE reservation over all of them, so a refusal in any window
		// gives back every key, the deployment's included.
		const ledgers = dollarLedgers(dollarCaps, { scope: scopedDollars, project: projectDollars, other: otherDollars, models: modelDollars });
		const modelPrefixes = new Map((modelDollars ?? []).map((m) => [m.keyPrefix, m.ref]));
		// The ledgers that settle to the JOB's cost (the deployment's, the repo or folder row's, the project row's), named
		// rather than derived as "not a model", so a ledger kind added later settles nowhere until it is put on a list.
		// `_other`'s ledger (issue #504 part B) settles to the job's cost too: its counter is what the unassigned work spent.
		const jobCostPrefixes = new Set([DOLLAR_KEY_PREFIX, scopedDollars?.keyPrefix, projectDollars?.keyPrefix, otherDollars?.keyPrefix].filter((p) => typeof p === "string"));
		if (ledgers.length > 0) {
			// A window needs a per-job cap (the settings invariant, `checkDollarInvariant`; for a scoped or model row, the
			// same rule), so a job with none here is a defect, a hand-built queue entry, or a dollar row in
			// scoped-limits.json on a deployment with no `maxCostUsd`: refused as configuration, before anything is
			// reserved, and the config arm below refunds every job-count slot.
			if (job.maxCostMicros === null || job.maxCostMicros === undefined) throw configError("a dollar window is set but this job has no per-job cost cap to reserve");
			// Issue #503 part 7: a job that CANNOT spend reserves nothing. Every model it may call is served by a declared
			// endpoint and zero-rated, so its container runs under a per-job cap of 0, which the runner's cost guard holds
			// before every call: a call whose bound is above 0 is refused, so the job's spend is 0 by construction, not
			// by trust in the cost table. The capability gate above already required `costCap` of this job's image (the
			// job carried a non-null cap), so an image that would ignore the 0 never gets here. A cap that is ALREADY 0
			// (a malformed queued value reads as 0, `effectiveCostCapMicros`) has nothing to reserve either.
			const refs = callableModelRefs(job);
			const zero = job.maxCostMicros === 0 ? { zeroRated: true } : zeroRatedVerdict({ models: modelEndpoints?.models ?? null, endpoints: modelEndpoints?.endpoints ?? [], refs, builtinModel });
			if (zero.zeroRated) {
				containerJob = { ...job, maxCostMicros: 0 };
				dollars = dollarsRecord({ reservedMicros: 0, settledMicros: 0, basis: "unreserved" });
				log("dollar_unreserved", { models: refs.length });
			} else {
				let reservation;
				try {
					reservation = await reserveDollars(redis, { ledgers, amountMicros: job.maxCostMicros, now, log });
				} catch (error) {
					// Valkey did not answer. reserveDollars tried to give back what it had added, key by key (a key it could
					// not is logged, dollar_giveback_error), so nothing is held by this job; the job-count
					// slots are refunded by the never-started arm below, and the job is retried: nothing started.
					log("dollar_reserve_error", { code: typeof error?.code === "string" ? error.code : "error" });
					throw new InfraRetry("the dollar windows could not be reserved", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
				}
				if (!reservation.allowed) {
					// Refused, and every dollar key it touched given back, best effort per key (the departure from the job-count
					// rule, see dollar-budget.mjs; a key that could not be is logged and the record says floor). Every held
					// job-count slot goes back too, last first: a ledger that did not issue the refusal gives back, the rule
					// the count ledgers follow among themselves above.
					// WHOSE NUMBER bound (issue #504 part B): `allocation-cap` when the refusing window's cap came from the applied split
					// or the envelope total (`capSource`), `dollar-cap` when it was the operator's own (a tie is the operator's). One
					// ledger and one window refused, and the reservation names both.
					const capSourceOf = (prefix) => (prefix === DOLLAR_KEY_PREFIX ? dollarCapSource : [scopedDollars, projectDollars, otherDollars].find((l) => l?.keyPrefix === prefix)?.capSource);
					const byAllocation = capSourceOf(reservation.ledger)?.[reservation.window] === "allocation";
					const refusalReason = byAllocation ? ALLOCATION_CAP_REASON : DOLLAR_CAP_REASON;
					const refunded = await refundLedgers(refusalReason);
					// The window is named and the amounts are not: the comment's reader may be an issue author, and the
					// amounts are the operator's, which the log carries. Which ledger refused is named too: the deployment,
					// the repo (a forge scope IS the repo the comment posts on), "this folder" (a local scope is a host path,
					// kept out of the comment and the log), or the model (operator configuration, never payload). The log
					// names a scoped or model ledger by its key prefix, a hash, never the scope string.
					const period = { day: "today's", week: "this week's", month: "this month's" }[reservation.window] ?? "a";
					// Two different states, told apart (PR #549's review): a window whose cap is BELOW one job's cap refuses every
					// such job until the operator changes a setting, which "no room left" would hide behind a wait that never ends.
					const capBelowJob = reservation.capMicros < job.maxCostMicros;
					// A project window (issue #499 part B) is "this project", for the job-count refusal's reason.
					const refusedBy = reservation.ledger === DOLLAR_KEY_PREFIX ? "deployment" : modelPrefixes.has(reservation.ledger) ? "model" : reservation.ledger === projectDollars?.keyPrefix ? "project" : reservation.ledger === otherDollars?.keyPrefix ? "other" : "scope";
					const whose = refusedBy === "deployment" ? "this deployment" : refusedBy === "model" ? `the model ${modelPrefixes.get(reservation.ledger)}` : refusedBy === "project" ? "this project" : refusedBy === "other" ? "the work outside the budget split's projects" : job.kind === "local" ? "this folder" : unqualifiedScope(scopedDollars.scope);
					// The allocation's own words (issue #504 part B): the number that bound is the split inside the operator's envelope,
					// which moves with the next priorities plan or an envelope edit, so this text never tells its reader to raise a budget.
					const adjective = { day: "daily", week: "weekly", month: "monthly" }[reservation.window] ?? "";
					const allocationText = capBelowJob
						? `Refused: the ${adjective} share of the budget split for ${whose} is smaller than this run's cost limit, so no container was started and nothing was spent. The split changes with the next priorities plan or an envelope change. Not run.`
						: `Refused: ${period} share of the budget split for ${whose} has no room left for this run's cost limit, so no container was started and nothing was spent. Not run.`;
					await comment(
						job,
						byAllocation
							? allocationText
							: capBelowJob
							? `Refused: the ${{ day: "daily", week: "weekly", month: "monthly" }[reservation.window] ?? ""} dollar budget for ${whose} is smaller than this run's cost limit, so no run with this limit can start until the operator raises the budget or lowers the limit. No container was started and nothing was spent. Not run.`
							: `Refused: ${period} dollar budget for ${whose} has no room left for this run's cost limit, so no container was started and nothing was spent. Not run.`,
					);
					log("over_dollar_budget", { ledger: refusedBy, ...(refusedBy === "deployment" ? {} : { key: reservation.ledger }), ...(refusedBy === "model" ? { model: modelPrefixes.get(reservation.ledger) } : {}), window: reservation.window, reservedMicros: reservation.reservedMicros, capMicros: reservation.capMicros, amountMicros: job.maxCostMicros, ...(capBelowJob ? { capBelowJob: true } : {}), ...(byAllocation ? { source: "allocation" } : {}), refunded });
					const stranded = reservation.stranded > 0;
					const modelBasis = modelPrefixes.size === 0 ? null : stranded ? "floor" : "refunded";
					return { outcome: "policy", reason: refusalReason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: globalHeld(), dollars: stranded ? dollarsRecord({ reservedMicros: job.maxCostMicros, settledMicros: job.maxCostMicros, basis: "floor", modelBasis }) : dollarsRecord({ reservedMicros: job.maxCostMicros, settledMicros: 0, basis: "refunded", modelBasis }) }; // return => not retried
				}
				dollarHold = reservation.hold;
				dollars = dollarsRecord({ reservedMicros: job.maxCostMicros, settledMicros: job.maxCostMicros, basis: "floor", modelBasis: modelPrefixes.size > 0 ? "floor" : null });
			}
		}

		// The user the gate above decided is the user that runs: one answer, never two call sites that agree.
		// Issue #545: an image that declares `exitAuth` is handed a per-job key on stdin and signs its exit line with it, and
		// then only a signed line is read (run-container.mjs, run-history.mjs `authenticExitLines`). An image that does not
		// declare it is read as before, under the #542 trust rule below alone.
		const exitAuth = (img.capabilities ?? []).includes(EXIT_AUTH_CAPABILITY);
		const { code, aborted, abortReason, turns, tokens, session, usage, context, detached, exitReason, exitWhy = null, exitLineCode = null, exitAuth: exitAuthResult = null, exitOomKilled = false, memoryLimit = null, resources: ranResources = null } = await runContainer({ job: containerJob, token, prepared, secrets, user: jobUser?.user ?? null, home: jobUser?.home ?? null, relabel: jobUser?.relabel === true, ...(modelEndpoints?.endpoints?.length > 0 ? { modelEndpoints } : {}), ...(exitAuth ? { exitAuth: true } : {}), ...(jobSize ? { size: jobSize } : {}), ...(Number.isSafeInteger(jobUser?.hostCpus) ? { hostCpus: jobUser.hostCpus } : {}) });
		containerRan = true;
		// Issue #596: what the container used, off its exit line, rebuilt by the sink (null from a runContainer that predates
		// the field). Every result and every throw below carries it, so a retried attempt's record says what it used too.
		resources = ranResources ?? null;
		// Issue #596: CONFIRMED killed for memory. The image's supervisor (image/runner/src/supervise.mjs) outlives the runner,
		// whose process tree it gives the highest OOM score, and when the runner dies of SIGKILL with the cgroup's
		// `oom_kill` above 0 it writes the signed line `code: 137, reason: "oom-killed"` (parseExitOomKilled). All three
		// facts must agree: that line, verified under this run's key (an unsigned line is a tool's), and the container's
		// own exit 137. Docker's `oom` event is not used: it fires also when only a child was killed and the job went on
		// to exit 0, and Podman has no such event at all (both measured in the issue #596 lab). And a fourth: the line's
		// `memPeak` at 90% of the `--memory` this container got (`memoryLimit`, from runContainer) or more, because
		// `oom_kill` counts the HOST's OOM killer too (`peakReachedLimit`). A report below it stays infrastructure.
		const oomReported = exitOomKilled === true && exitAuthResult === "verified" && code === EXIT_SIGKILL;
		const oomKilled = oomReported && peakReachedLimit(resources?.memPeak ?? null, memoryLimit);
		// Numbers only (bytes), never a path or a project: the operator's trace of a kill read as the host's. Never on a run
		// the worker stopped itself (a timeout, a cancel, a shutdown): that 137 is the worker's own, the abort decides it
		// below, and a line naming the host's OOM killer would send the operator after a kill that never happened.
		if (oomReported && !oomKilled && !aborted) log("oom_report_below_limit", { jobId: job.id ?? null, memPeak: resources?.memPeak ?? null, memoryLimit });
		// `exitAuth: "unverified"` is a run whose image signs its exit line and no signed line was found: the runner died
		// before writing one, or a line was forged or taken off the pipe. Its tokens read as unknown and its dollars settle
		// at the floor, the same as a container that wrote no exit line at all.
		log("container_exit", { exitCode: code, aborted, ...(detached === true ? { detached: true } : {}), ...(exitAuthResult !== null ? { exitAuth: exitAuthResult } : {}), ...(oomKilled ? { oomKilled: true } : {}) });

		// Record token spend post-run (the check-AFTER half of the lagging token cap). The container ran,
		// so it spent real tokens on EVERY path that reaches here -- abort, completed, policy, AND the infra
		// throws below (an exit-1 container still spent before failing). Record before classifying so all of
		// them are accounted. Only when the cap is enabled (nothing reads the counter otherwise) and the run
		// reported a positive total. NEVER throws: money is already spent, so a Redis blip here must not turn
		// a completed paid job into a failure (mirrors the sink/comment/cleanup fault-isolation posture).
		const tokensSpent = tokens?.total ?? 0;
		if (tokenCap !== null && tokenCap !== undefined && tokensSpent > 0) {
			await recordSpend(redis, tokensSpent, { now }).catch((err) => log("token_spend_error", { reason: err?.message }));
		}

		// SETTLE the dollar reservation (issue #501, part 4), ONCE, here, for every exit where the container ran:
		// completed, runner policy, a worker abort or cancel, exit 1, an unknown exit, and a detached container. A
		// never-started exit is not settled: the catch refunds it whole, and `isNeverStartedExit` is the one answer both
		// ask. Before any classification below, so every return and every throw carries the same `dollars`.
		const neverStarted = isNeverStartedExit({ code, aborted, detached }, neverStartedExits(job));
		if (dollarHold !== null && !neverStarted) {
			// The exit line is trusted only when the container exited ON ITS OWN (the worker did not abort, cancel, time
			// out or detach it, so the runner had the chance to write its genuine last line) AND that line's own `code` is
			// the container's real exit code (PR #542's review, round 3: a job's tool can forge a $0 line before a stop).
			const trusted = !aborted && detached !== true && Number.isSafeInteger(exitLineCode) && exitLineCode === code;
			const reservedMicros = dollarHold.amountMicros;
			const { settledMicros, basis } = dollarSettlement({ tokens, usage: usage ?? null, reservedMicros, trusted });
			// The deployment, the repo or folder and the project windows settle to the job's cost; each model window to its
			// own row of the usage ledger (`modelDollarSettlement`), never to the job's total.
			const jobPart = holdPart(dollarHold, (prefix) => jobCostPrefixes.has(prefix));
			const { applied, of } = await settleDollars(redis, jobPart, settledMicros, { log });
			let modelBasis = null;
			for (const part of dollarHold.ledgers ?? []) {
				const ref = modelPrefixes.get(part.keyPrefix);
				if (ref === undefined) continue;
				const m = modelDollarSettlement({ ref, basis, tokens, usage: usage ?? null, reservedMicros, trusted });
				const done = await settleDollars(redis, { amountMicros: reservedMicros, keys: part.keys }, m.settledMicros, { log });
				// The deployment rule below, per model window: a fault that adjusted none of its keys left the reservation.
				const mBasis = done.applied === 0 && done.of > 0 && m.settledMicros !== reservedMicros ? "floor" : m.basis;
				modelBasis = modelBasis === "floor" || mBasis === "floor" ? "floor" : "metered";
				// The model is operator configuration (a scoped-limits row), and the key a hash; no value but the amounts.
				log("dollar_model_settled", { model: ref, key: part.keyPrefix, settledMicros: m.settledMicros, basis: mBasis });
			}
			// A fault that adjusted no key leaves the whole reservation in every window, which is a floor whatever the
			// basis would have been, and the record says so. A partial one is logged (dollar_settle_error) and recorded
			// as computed: the keys that were adjusted hold the settled amount.
			dollars = applied === 0 && of > 0 && settledMicros !== reservedMicros ? dollarsRecord({ reservedMicros, settledMicros: reservedMicros, basis: "floor", modelBasis }) : dollarsRecord({ reservedMicros, settledMicros, basis, modelBasis });
			dollarHold = null;
			log("dollar_settled", { reservedMicros: dollars.reservedMicros, settledMicros: dollars.settledMicros, basis: dollars.basis, ...(modelBasis !== null ? { modelBasis } : {}) });
		} else if (dollars?.basis === "unreserved") {
			// Nothing was held, so nothing is written. A metered cost above 0 here would mean the runner's cap of 0 let a
			// priced call through, which it cannot by construction; it is logged so it cannot pass unseen.
			const spent = meteredMicros(tokens?.cost);
			if (spent !== null && spent > 0) log("dollar_unreserved_spent", { meteredMicros: spent });
		}

		// Issue #345: `docker run` exited with a never-started code, but THIS attempt's container was found by its cidfile,
		// still there, and was stopped and removed (run-container.mjs, measured on Podman with its API service killed
		// mid-job). It DID start, so this is never refunded as never-started: it keeps its slot and retries as infrastructure,
		// BEFORE the exit-code switch, where the same code would read as a free never-started exit.
		if (detached === true) {
			throw new InfraRetry(`the container outlived its docker run, exit ${code}`, { reason: "container-detached", exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), dollars, resources });
		}

		// A WORKER-initiated stop (30-min timeout via cancelJob, graceful-shutdown docker stop, or an
		// operator's cancel, issue #287) kills the container -> exit 143/137. That is our decision, not an
		// infra fault: it is POLICY and must NOT retry, or a wedged job re-runs into a second PR / double
		// spend. Keyed on the abort FLAG, not the code -- an unbidden 137 (kernel OOM) carries
		// `aborted: false`, and falls to the OOM branch below when the runtime confirmed it, else to the switch, where it
		// stays infra-retryable (issue #596).
		// WHO aborted is an exact-match on `abortReason` (the wiring maps it off `signal.reason`), and the
		// match is deliberately closed: "job-timeout-30m", "shutdown", undefined and any future garbage all
		// classify as worker-abort, so a pin bump that changes what rides the signal can widen nothing.
		// `abortReason` itself never reaches the record -- buildRecord copies named fields only.
		// exitCode/turns/tokens carry the container's own exit, turn count, and usage totals; budgetReserved true post-reserve.
		if (aborted) {
			const reason = abortReason === "operator-cancel" ? "operator-cancel" : "worker-abort";
			// Awaited bare like every determinate refusal above: the adapter never throws by contract, and
			// the one swallowed comment in this file (the catch's) justifies itself by its position.
			await comment(job, TERMINAL_COMMENTS[reason]);
			return { outcome: "policy", reason, exitCode: code, turns, tokens, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...(resources ? { resources } : {}) };
		}

		// Issue #596: a runner the kernel killed for memory, CONFIRMED (`oomKilled` above). After the abort branch, so a
		// worker's own stop is never relabelled, and before the switch, where the same 137 is an unknown exit and retries.
		// The same size would be killed the same way on every retry, so it is POLICY: returned, never retried, its slot
		// kept and its dollars settled above like any other paid stop. An UNCONFIRMED 137 (an image without the supervisor,
		// an unsigned line, a SIGKILL with no OOM kill in the cgroup, a peak short of the limit, which is how a kill by the
		// host's OOM killer reads) falls through and retries, exactly as before.
		//
		// When only a CHILD was killed, the runner survives and ends on its own code, so this branch is not taken: the
		// outcome is the runner's, and `resources.oomKills` in the record says a process was killed for memory.
		if (oomKilled) {
			// The project and the size go to the log and the record, never to the comment (the TERMINAL_COMMENTS rule).
			log("oom_killed", { jobId: job.id ?? null });
			await comment(job, TERMINAL_COMMENTS[EXIT_OOM_KILLED]);
			return { outcome: "policy", reason: EXIT_OOM_KILLED, exitCode: code, turns, tokens, usage: usage ?? null, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...(resources ? { resources } : {}) };
		}

		switch (code) {
			case EXIT_COMPLETED: {
				// The SOLE chain-collection point. Read the completed parent's /outbox and enqueue children
				// BEFORE the `finally` deletes jobDir -- the await resolves inside this case, so the read
				// finishes before control leaves to cleanup. NOT reached on any other branch (policy, abort,
				// over-budget, infra): an InfraRetry job is retried, so chaining there would double-enqueue.
				// collectChain never throws; chainEnqueued/chainRefused are additive telemetry only.
				const chain = await collectChain({ job, prepared });
				// Issue #505: the plan, after the chain and on this branch only, for the reason the chain is here: a policy or
				// infra exit collects nothing, and a retried job must not apply what its failed attempt wrote. `portfolio` is
				// the pickup's decision; the collector asks the live file again, and both must agree. Never throws.
				const plan = await collectPlan({ job, prepared, portfolio });
				// COMPLETED-ONLY PROMOTION, and the exclusivity is the point rather than an optimisation.
				// A policy or infra exit leaves the canonical transcript byte-identical to what it was
				// before this run, so a retry starts from exactly what the first attempt did -- promote on
				// every exit and "retry" quietly stops meaning re-run and starts meaning continue
				// (CONST-RETRY-INFRA-ONLY). Same completed-only rule INT-OUTBOX-CONTRACT already uses, and
				// it sits beside the chain collection for the same reason: both must happen before the
				// `finally` deletes jobDir. Never throws.
				const promoted = prepared.session ? promoteSession(prepared.session, { piVersion, context }) : null;
				return {
					outcome: "completed",
					exitCode: code,
					turns,
					tokens,
					// The validated per-model ledger the sink rebuilt off the exit line (parseExitUsage), or
					// null for a fallback-metered or pre-ledger runner. `?? null` keeps the result shape
					// stable under an injected runContainer that predates the field.
					usage: usage ?? null,
					provider: job.provider ?? null,
					model: job.model ?? null,
					session: mergeSession(prepared, session, promoted),
					budgetReserved: true,
					chainEnqueued: chain.enqueued,
					chainRefused: chain.refused,
					...(dollars ? { dollars } : {}),
					// Only when the collector returned a plan (a file, or a confirmed portfolio job with none, `plan-absent`): the
					// record's `plan` is null otherwise, and every other result is unchanged.
					...(plan ? { plan } : {}),
					...(resources ? { resources } : {}),
				};
			}
			case EXIT_POLICY: {
				// A policy exit still ran a paid container, so it carries the ledger like the completed
				// branch does -- the spend is real whichever way the runner classified itself.
				// The comment is UNCONDITIONAL (issue #288 asked for "when the agent did not already comment
				// its own refusal", and the discriminator already exists at the exit-code boundary): an agent
				// that composed its own refusal exits 0 -- github-prompt.mjs instructs the status comment,
				// including for "I cannot fix this" -- so exit 2 means it was cut off before that step.
				// Residual: an agent that posted a status and THEN blew its turn budget yields one extra
				// comment, bounded at one.
				//
				// The runner's exit-line reason is read for ONE purpose (issue #437): a provider that refused
				// the credential needs an operator, not a wait, and "runner-policy" hid that behind budget
				// wording. It picks a label INSIDE this branch and nothing else, which is why reading it is
				// safe where reading it to classify would not be: `code` has already placed the job in the
				// not-retried class, so a forged or stale line can at worst swap one not-retried label for
				// another from the closed RUNNER_POLICY_REASONS set. The `code === 2` guard is redundant with
				// the case label today and is kept so the label cannot follow this line if it is ever moved.
				// Every other reason the runner gives still reads as runner-policy.
				const reason = RUNNER_POLICY_REASONS.has(exitReason) && code === 2 ? exitReason : "runner-policy";
				await comment(job, TERMINAL_COMMENTS[reason]);
				// Issue #507: which rule of the cost guard refused (`unboundable`, `external`, `over-cap`), as the record's
				// `why`. parseExitWhy keeps only a member of the closed COST_CAP_WHYS off a `cost-cap` line that said code 2,
				// and it rides only beside a `cost-cap` reason, so a forged line can at worst name the wrong rule of three.
				const why = reason === "cost-cap" && COST_CAP_WHYS.includes(exitWhy) ? { why: exitWhy } : {};
				return { outcome: "policy", reason, exitCode: code, turns, tokens, usage: usage ?? null, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...why, ...(resources ? { resources } : {}) };
			}
			case EXIT_INFRA:
				// NO comment on any infra throw, here or in the catch: an InfraRetry may be retried and
				// recover, and a flaky daemon must not post three comments for one recovery. Once-ness for
				// the whole infra class lives at the terminal seam -- start.mjs's failed listener, guarded on
				// BullMQ's own finishedOn -- which also catches the stall-kill and wait-gate paths this
				// function never sees (issue #288).
				throw new InfraRetry(`infra failure, container exit ${code}`, { exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), dollars, resources });
			default:
				// THE RUNTIME NEVER HANDED CONTROL TO THE RUNNER, in whatever integers this venue spells that
				// (issue #227). For docker it is 125 (`docker run` itself failed), 126 (the entrypoint exists
				// but is not executable) and 127 (the entrypoint was not found). Nothing was spent -- which is
				// exactly what `container-never-started` means -- so this reuses the refund below rather than
				// keeping a slot the agent never used. They used to fall to the unknown-exit branch, which
				// kept the slot AND retried, burning a second one.
				//
				// ASKED OF THE BACKEND rather than hardcoded, because those integers are Docker's and they
				// COLLIDE with the runner's own channel (`INT-RUNNER-EXIT-CODE-PROTOCOL`). Assuming them is
				// silently wrong for any venue where 125 is a real runner exit, and the assumption was
				// invisible while there was one runtime. An adapter declares its own set, or declares none
				// and normalises to this outcome itself.
				if (neverStarted) {
					// No `dollars` here: the hold is still standing, and the catch refunds it whole with the job-count slots.
					throw new InfraRetry(`the runtime could not start the container, exit ${code}`, { reason: "container-never-started", exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), resources });
				}
				throw new InfraRetry(`unknown container exit ${code}`, { exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), dollars, resources });
		}
	} catch (e) {
		// A CONFIG-tagged throw is a determinate policy refusal wearing an exception, and issue #310 is the
		// bill for treating it as neither. `CONST-RETRY-INFRA-ONLY` says a determinate refusal RETURNS and only
		// infrastructure THROWS; every other gate in this function obeys that, and this class did not, because
		// nothing here read the tag that `cli.mjs` and `doctor` both already read.
		//
		// What it actually cost, corrected against the issue text: it was NOT retried. `index.mjs` wraps every
		// non-InfraRetry throw in BullMQ's `UnrecoverableError`, so the job failed once. What it did cost is
		// the reserve, kept and never refunded, on a fault an operator has to fix by hand -- so every later
		// delivery took another slot out of the same daily cap and the same scope, and the record said
		// `outcome: "failed"` with a null reason, which the panel paints red beside real infrastructure faults
		// and insights buckets as a failure. A determinate refusal that reads as an outage is the diagnosis
		// this project exists to make legible.
		//
		// Refunding is right BECAUSE no container started: identical to `container-never-started`, and the
		// same all-or-none refund of every held job-count ledger, through the same `releaseLedgers` list, so it still
		// cannot double-release. The gate above catches the provider case for free, before the mint and the clone;
		// this is the backstop for every other config throw that can still land here (an unknown forge kind in
		// `buildContainerEnv`, a prepare-time refusal), which would otherwise keep the same slot silently.
		// `!containerRan` is the discriminator, and it is what makes the refund and the sentence below TRUE
		// rather than merely true today. Every config-tagged throw site in the worker is pre-container, so this
		// changes nothing now; the day one is added after a paid run, that run keeps its slot and falls through
		// to the untagged path instead of being refunded and publicly declared free.
		// Issue #501: a dollar hold still standing here was neither settled nor refunded. Two kinds of throw give it back
		// whole, because no container ran: never-started (the arm below) and config-refused (the next arm). Any other
		// throw may have followed a container that ran (runContainer itself throwing, a defect), so the hold STAYS, the
		// floor, which errs toward overcounting, and `dollar_hold_unsettled` says so. Released FIRST and never throwing
		// (releaseDollars), so a Valkey fault cannot replace either arm's classification.
		if (dollarHold !== null) {
			const hold = dollarHold;
			dollarHold = null;
			if ((e?.piDispatchConfig === true && !containerRan) || isNeverStartedRetry(e)) {
				const { applied, of } = await releaseDollars(redis, hold, { log });
				const heldModel = (hold.ledgers ?? []).some((l) => modelPrefixesOf(modelDollars).has(l.keyPrefix));
				dollars = dollarsRecord({ reservedMicros: hold.amountMicros, settledMicros: applied === of ? 0 : hold.amountMicros, basis: applied === of ? "refunded" : "floor", modelBasis: heldModel ? (applied === of ? "refunded" : "floor") : null });
			} else {
				log("dollar_hold_unsettled", { reservedMicros: hold.amountMicros, error: e instanceof InfraRetry ? "infra-retry" : (e?.name ?? "error") });
				const heldModel = (hold.ledgers ?? []).some((l) => modelPrefixesOf(modelDollars).has(l.keyPrefix));
				dollars = dollarsRecord({ reservedMicros: hold.amountMicros, settledMicros: hold.amountMicros, basis: "floor", modelBasis: heldModel ? "floor" : null });
			}
		}
		// The record reads `dollars` off the error on every throw path (buildRecord), so a retried or failed attempt says
		// what its windows were charged.
		if (dollars !== null && e !== null && typeof e === "object") {
			try {
				e.dollars = dollars;
			} catch {
				// a frozen error keeps its own fields; the log lines above are the record of the hold
			}
		}

		if (e?.piDispatchConfig === true && !containerRan) {
			// GUARDED, and the `held` list is the record of what actually happened. `releaseLedgers` is a loop of
			// DECRs over the active windows and can reject part-way (a read-only replica, a dropped
			// connection), which would otherwise replace this determinate refusal with a Redis message: the
			// operator would be told their queue is broken when their deployment is misconfigured, and the
			// escaping error is untagged so it is not retried either. A refund that did not land must not be
			// reported as one, so `budgetReserved` follows the ledger and not the intent.
			const refunded = await refundLedgers("config-refused");
			// A FIXED sentence, and NO message in the log either. Two different reasons, both load-bearing:
			// `credentialFromPiAuth` puts `auth.json`'s location in its refusals and `prepare-local` puts the
			// operator's folder in its own, which `buildRecord` reduces to a basename precisely because a host
			// path carries an OS account name; and `branch.mjs`'s refusal interpolates a forge PAYLOAD field,
			// which no-pii-in-logs forbids anywhere. The scoped-budget refusal above keeps a host path out of
			// its log line for the first of those reasons, and this follows it. `doctor` is where the operator
			// reads the specific variable and the specific path, which is what both sentences point at.
			// SWALLOWED, and only here. Every other refusal in this function awaits `comment` bare, which is
			// right: they are on the happy path of a determinate decision, and a forge that cannot be told is
			// worth surfacing. This one is inside the catch, so a throw from `comment` would discard the
			// classification that has ALREADY released the budget, and the job would escape as whatever the
			// comment threw, with the ledger refunded and the record saying something else entirely. The
			// shipped adapter never throws; this makes that a property of the arm rather than of the wiring.
			await comment(job, "Refused: this deployment is misconfigured, so the job could not be started. Ask the operator to run `pi-dispatch doctor`. Not run.").catch(() => {});
			log("refused_config", { kind: job.kind ?? null, refunded });
			// budgetReserved reflects the LEDGER: whether the GLOBAL slot is still held after the refund (`globalHeld`).
			return { outcome: "policy", reason: "config-refused", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: globalHeld(), ...(dollars ? { dollars } : {}) }; // return => not retried
		}

		// A spawn fault (docker daemon down / binary missing) reserved a slot but never started a
		// container, so nothing was spent -- give the slot back before the retry. Every other throw
		// here (exit-1 infra, unknown exit) means the container ran and legitimately spent its slot,
		// so `reason` gates the release to the never-started case only. It releases only what `held` still
		// lists and run once per invocation; a BullMQ retry reserves afresh, so this cannot double-release.
		if (isNeverStartedRetry(e)) {
			// All-or-none (issues #242 and #499 part B): a never-started container follows EVERY job-count reserve, so
			// every held ledger refunds together, last first, through the one helper -- and a scoped or project refusal
			// returned above with the ledgers before it already given back.
			await refundLedgers("container-never-started");
		}
		// After the refund, so it says what the ledger holds: false when never-started gave the global slot back, true
		// for a real container that ran and spent (exit-1 infra / unknown exit) or a refund that did not land.
		if (e instanceof InfraRetry) e.budgetReserved = globalHeld();
		throw e;
	} finally {
		if (prepared) await cleanup(prepared).catch(() => {});
	}
}

/**
 * The reason a job retried for the podman venue's rootless network keeper carries (issue #458, PR #463 round 2): a
 * fixed token, as every run-record reason is, and the key the terminal comment is chosen by.
 */
export const NETNS_KEEPER_NOT_HOLDING = "netns-keeper-not-holding";
/** Issue #476: a job held on a young keeper that kept restarting, or stayed young past the hold's bound. */
export const NETNS_KEEPER_CRASH_LOOP = "netns-keeper-crash-loop";

/** Thrown for the retryable (infra) class only. The BullMQ processor lets this propagate to retry. */
/**
 * The one `session` object the run record carries, from the host's intent and the container's report
 * (INT-RUN-HISTORY-FILE-CONTRACT).
 *
 * Both halves matter and neither is sufficient. The host knows whether a key resolved and which gate
 * refused; only the container knows what pi actually did with the file it was handed. A host that staged
 * a transcript while the runner reports `resumed: false` is a real event -- a corrupt file, a degrade --
 * and with one number alone it is indistinguishable from an ordinary cold start.
 *
 * The runner's verdict WINS on `resumed`, because it is the one that observed the outcome. The host's
 * reason is kept when the runner has none to give (a container that died before its exit line), AND when
 * the host itself refused -- see the second precedence rule below.
 *
 * PII-free by construction: a boolean, a fixed enum, an integer. The key and the branch name are
 * deliberately absent -- this record holds no attacker-chosen string, and a branch name is one.
 */
function mergeSession(prepared, fromRunner, promoted = null) {
	const host = prepared?.session;
	if (!host && !fromRunner) return null;
	// A HOST GATE THAT REFUSED OUTRANKS THE RUNNER'S `absent`, and without this rule it never reached a
	// record at all. A refused read stages a 0-byte file rather than nothing (session-store.mjs, where the
	// reasoning is pi's EEXIST race), the container is handed that file either way, and pi opens it and
	// finds no messages -- so the runner reports `absent` on EVERY host refusal. Letting that win overwrote
	// the answer with a restatement of the question: `expired` and `pi-version-changed` reached no
	// completed record in the feature's whole life, and `docs/sessions.md`'s promise that every cold start
	// is nameable in the record was false for them.
	//
	// Narrow on purpose, `host.resume === false` and the runner's token exactly `absent`. When the host
	// DID stage a transcript and the runner still reports `absent`, the two genuinely disagree, and that
	// disagreement is the event this object exists to show; the runner keeps winning there. So does its
	// `unparseable`, which reports a degrade the host could not see.
	const hostRefused = host?.resume === false && typeof host.reason === "string";
	return {
		resumed: fromRunner ? fromRunner.resumed : false,
		// A promotion that was refused is the more useful reason to surface: "locked" or
		// "not-a-regular-file" says why the NEXT run will cold-start, which is the thing an operator
		// chasing "it never resumes" needs. It only ever replaces a reason on the completed path.
		reason:
			(promoted && !promoted.promoted ? promoted.reason : null) ??
			(hostRefused && fromRunner?.reason === "absent" ? host.reason : null) ??
			fromRunner?.reason ??
			host?.reason ??
			null,
		bytes: promoted?.bytes ?? host?.bytes ?? null,
	};
}

/**
 * Our own words for why a resolver did not produce a value, turned into a phrase at the refusal site --
 * the shape the egress refusal already uses for its `state` discriminator. The `??` fallback in the caller
 * is not decoration: a failure code added in secrets.mjs must degrade to a generic sentence rather than
 * print `undefined` on a public issue.
 */
const SECRET_FAILURES = {
	exit: "refused that reference",
	empty: "printed nothing",
	overflow: "printed more than the size cap allows",
	nul: "printed a value containing a NUL byte, which cannot survive the container's argv",
};

/**
 * Is this throw the "the runner never ran" retry (issue #227), whichever path raised it: a never-started exit
 * (`isNeverStartedExit`), a spawn fault, or a pre-start gate? The catch's refunds (the job-count slots and, issue
 * #501, the dollar hold) key off this one test.
 */
function isNeverStartedRetry(e) {
	return e instanceof InfraRetry && e.reason === "container-never-started";
}

export class InfraRetry extends Error {
	constructor(message, { cause, reason, exitCode, turns, tokens, session, usage, provider, model, budgetReserved, dollars, resources } = {}) {
		super(message, cause ? { cause } : undefined);
		this.name = "InfraRetry";
		this.piDispatchRetry = true;
		this.reason = reason ?? message;
		this.exitCode = exitCode ?? null;
		this.turns = turns ?? null;
		this.tokens = tokens ?? null;
		// A deliberate in-passing repair: the EXIT_INFRA throw has passed `session` since the resume
		// feature landed, but this destructure never read it, so every infra-retry record silently
		// recorded session:null and a degrade seen only on a retried attempt left no trace. Latent
		// because buildRecord's `?? null` made the drop indistinguishable from an honest absence.
		this.session = session ?? null;
		// The usage-ledger trio (INT-RUN-HISTORY-FILE-CONTRACT): carried on the throw path so a
		// catch-path record attributes exactly what the return path would have.
		this.usage = usage ?? null;
		this.provider = provider ?? null;
		this.model = model ?? null;
		this.budgetReserved = budgetReserved ?? null;
		// Issue #501: the dollar reservation's outcome (`dollarsRecord`), or null when no dollar window applied. Set by
		// the processor on a throw after the reservation, so a retried attempt's record says what its window was charged.
		this.dollars = dollars ?? null;
		// Issue #596: what the container used, off its exit line, or null; set on a throw after a container ran.
		this.resources = resources ?? null;
	}
}

/**
 * A local job held until rootful Podman's service restarts (issue #448, gate round 2 of PR #473). An `InfraRetry`, so
 * any path that does not know it still retries rather than failing the job for good; `makeProcessor` knows it, and
 * moves the job to the delayed set without spending an attempt until the hold has lasted `PODMAN_RESTART_HOLD_MAX_MS`.
 */
export class PodmanRestartHold extends InfraRetry {
	constructor(message, options) {
		super(message, options);
		this.name = "PodmanRestartHold";
		this.holdUntilRestart = true;
	}
}

/**
 * A job held on a rootless network keeper that is running on its own bridge but younger than the minimum age (issue
 * #476). An `InfraRetry`, so any path that does not know it still retries; `makeProcessor` knows it, and moves the job to
 * the delayed set for `young.waitMs` without spending an attempt, up to `NETNS_KEEPER_YOUNG_HOLD_MAX_MS`.
 */
export class NetnsKeeperYoungHold extends InfraRetry {
	constructor(message, { young, remedy = null, ...options } = {}) {
		super(message, options);
		this.name = "NetnsKeeperYoungHold";
		this.keeperYoung = young;
		this.keeperRemedy = remedy;
	}
}

export { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY };
