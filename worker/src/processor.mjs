import { ABSENT, OPENSHELL_BIND_LINGERING, backendFor, DAEMON_APPLIES_BOUNDS, DEFAULT_BACKEND, DOCKER_ENDPOINT_LOCAL, DOCKER_NEVER_STARTED_EXITS, PODMAN_ADDS_NO_MOUNTS, PODMAN_BACKEND, PODMAN_BOUNDS_DELEGATED, PODMAN_CONF_WIDENS_JOB, OPENSHELL_GATEWAY_LOCAL, PODMAN_SERVICE_LOCAL, RUNTIME_ADDS_NO_MOUNTS } from "./backends.mjs";
import { resolveBackendName } from "./backend-registry.mjs";
import { lstatSync } from "node:fs";
import { checkTokenCap, recordTokenSpend, releaseLedgers, reserveLedgers } from "./budget.mjs";
import { configError } from "./config.mjs";
import { unqualifiedScope } from "./pause-windows.mjs";
import { PROJECT_CAP_REASON } from "./scoped-limits.mjs";
import { DEFAULT_SECRETS_PROFILE, secretsArmed } from "./secrets.mjs";
import { mergeBundleSecrets } from "./secret-bundles.mjs";
import { RESERVED_ENV_NAMES } from "./triggers.mjs";
import { mcpRefusalComment } from "./mcp-preflight.mjs";
import { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "./exit-code.mjs";
import { COST_CAP_WHYS, EXIT_OOM_KILLED, RUNNER_POLICY_REASONS, recoveryCounts, recoveryCountsFromProgress } from "./run-history.mjs";
import { baseHasExtensions as baseHasExtensionsDefault, resetTrustPaths as resetTrustPathsDefault } from "./trust-paths.mjs";
import { normalizeHost, removeCheckpointPointer as removePointerDefault } from "./run-checkpoint.mjs";
import { DEFAULT_EGRESS_PROXY } from "./egress.mjs";
import { CAPABILITY_GATES, EXIT_AUTH_CAPABILITY, STEER_STDIN_CAPABILITY, TRANSCRIPT_STDERR_CAPABILITY } from "./image-preflight.mjs";
import { modelListProblem, modelOnList, splitModelEntry } from "./model-ref.mjs";
import { ALLOCATION_CAP_REASON, ENVELOPE_MISMATCH_REASON } from "./allocation.mjs";

/** The refusal of a local job whose resolved folder belongs to another project than the one decided at pickup (issue #504 part B). */
export const LOCAL_FOLDER_PROJECT_CHANGED = "local-folder-project-changed";
// Issue #505: a portfolio cron job refused before it spends, because this host could not apply the plan it would write.
export const PORTFOLIO_NO_ENVELOPE = "portfolio-no-envelope";
import { DOLLAR_CAP_REASON, DOLLAR_KEY_PREFIX, dollarLedgers, dollarSettlement, dollarsRecord, holdPart, meteredMicros, modelDollarSettlement, releaseDollars, reserveDollars, settleDollars } from "./dollar-budget.mjs";
import { callableModelRefs, zeroRatedFor } from "./reserve-estimate.mjs";
import { outputCapView } from "./output-cap.mjs";
import { answerTrailComment, consoleAnswerBy } from "./console-answer.mjs";
import { forgeDeliveryJobId } from "./job-id.mjs";
// The forge-comment tables (issue #710): every fixed sentence this file posts, in one leaf the reason catalog can import
// without the job path. Re-exported below under the names they always had here.
import { BUNDLE_COMMENTS, ENVELOPE_MISMATCH_COMMENTS, HELD_TAKEN_COMMENT, JOB_USER_COMMENTS, MODEL_NOT_ALLOWED_COMMENTS, MODEL_UNKNOWN_COMMENT, modelUnknownComment, NETNS_KEEPER_CRASH_LOOP, NETNS_KEEPER_NOT_HOLDING, OVERLAY_REFUSED_COMMENT, PARKED_COMMENT, PARKED_COMMENT_PR, PODMAN_CONF_COMMENTS, RECOVERY_COMMENTS, REFUSAL_COMMENTS, TERMINAL_COMMENTS, VENUE_BUNDLE_REFUSED_COMMENT, VENUE_REFUSED_COMMENT, parkedComment } from "./comment-tables.mjs";

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
	// Issue #683. Never reached through a floor alone: the openshell venue refuses a gateway it does not observe local
	// whatever the floor says (`venueRefused`), and this sentence is the floor's half for a deployment that also asks.
	[OPENSHELL_GATEWAY_LOCAL]: "the OpenShell gateway is not observed listening on this host, so the job's credentials could cross a network the deployment does not own",
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

// The post-spend terminal comments (TERMINAL_COMMENTS, issue #288), the park's, the model and job-user refusals', the
// durable-run refusals' and the bundle refusals' live in comment-tables.mjs since issue #710, with the rule each follows.
export { HELD_TAKEN_COMMENT, MODEL_UNKNOWN_COMMENT, NETNS_KEEPER_CRASH_LOOP, NETNS_KEEPER_NOT_HOLDING, OVERLAY_REFUSED_COMMENT, PARKED_COMMENT, PARKED_COMMENT_PR, RECOVERY_COMMENTS, TERMINAL_COMMENTS, parkedComment };

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

/** How long a console answer's trail claim lives: a forge job's retained data (31 days), the longest the same id can return. */
export const CONSOLE_TRAIL_CLAIM_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * Claim the one trail comment of a console answer (issue #642): true when this attempt set `console:trail:<jobId>` and
 * so must post, false when an earlier attempt of the same job already did, when the job's id cannot be derived, or when
 * Valkey did not answer (each logged by its kind, never the text). The id is the queue's own (`forgeDeliveryJobId` over
 * the job's kind, delivery id and replica), so a retry of the same job, which keeps its data, reaches the same key.
 * Never throws.
 */
async function claimConsoleTrail(redis, job, log) {
	let jobId;
	try {
		jobId = forgeDeliveryJobId(job.kind, job.trigger?.deliveryId, job.replica);
	} catch {
		log("console_trail_skipped", { kind: job.kind ?? null, reason: "no-job-id" });
		return false;
	}
	try {
		const set = await redis.set(`console:trail:${jobId}`, "1", "PX", CONSOLE_TRAIL_CLAIM_MS, "NX");
		if (set === "OK") return true;
		log("console_trail_skipped", { kind: job.kind ?? null, reason: "already-posted" });
		return false;
	} catch (error) {
		log("console_trail_skipped", { kind: job.kind ?? null, reason: "valkey-error", code: typeof error?.code === "string" ? error.code : "error" });
		return false;
	}
}

// `callableModelRefs` (the models a job may call) moved to reserve-estimate.mjs (issue #642) with the zero-rated test
// it feeds, so the console's reserve estimate and this processor's reserve judge one rule (`zeroRatedFor`).

// ── Durable runs (issue #645) ───────────────────────────────────────────────────────────────────────────────────────

/** How many times one run may be continued from its checkpoint: a recovery job numbered past this is `recovery-cap`. */
export const RECOVERY_CAP = 2;
/** The reason an armed run's attempt RETURNS with when its continuation was queued instead of a retry thrown. */
export const RECOVERY_ENQUEUED = "recovery-enqueued";
/** A recovery job whose run already reached its final outcome elsewhere: refused silently, never commented. */
export const RECOVERY_SUPERSEDED = "recovery-superseded";
/** How long a recovery job waits before asking again whether its base run's container is still running here. */
export const RECOVERY_WAIT_MS = 30_000;
/** How long a recovery job waits before trying again after a never-started fault (it has no attempt to retry with). */
export const RECOVERY_RETRY_WAIT_MS = 60_000;

/**
 * The run this attempt belongs to, decided from the job data alone (issue #645): `{ armed, runId, isRecovery, recovery,
 * recoverSkipped, seq, recovered, checkpoints }`. The last three are filled in as the attempt goes, so the record can say
 * them on every exit.
 *
 * `runId` is `job.recoveryOf` for a recovery job, else the queue's own id, DERIVED like the console trail's
 * (`forgeDeliveryJobId` over kind, delivery id and replica: queue.mjs `enqueueForgeJob` names every forge job so). The
 * processor is handed the effective job, which has no `.id`, and a derivation from data the queue itself keyed on is one
 * answer for every attempt, retries and recoveries included; a new wiring argument would be a second. A recovery job's
 * id (`<runId>.r<n>`) is never parsed: `recoveryOf` and `recovery` carry it.
 *
 * Not armed, with the reason the record names (fail open and say which): a local job (`local`, v1 recovers forge jobs
 * only, so it runs exactly as it did before #645) and a forge job whose id cannot be derived (`no-run-id`).
 */
function durableOf(job) {
	const d = { armed: false, runId: null, isRecovery: false, recovery: null, recoverSkipped: null, seq: null, recovered: null, checkpoints: null };
	if (job?.recover !== true) return d;
	if (job.kind === "local") {
		d.recoverSkipped = "local";
		return d;
	}
	if (typeof job.recoveryOf === "string" && job.recoveryOf !== "") {
		d.runId = job.recoveryOf;
		d.isRecovery = true;
		d.recovery = job.recovery;
	} else {
		try {
			d.runId = forgeDeliveryJobId(job.kind, job.trigger?.deliveryId, job.replica);
		} catch {
			d.recoverSkipped = "no-run-id";
			return d;
		}
	}
	d.armed = true;
	return d;
}

/** The durable-run facts the record carries, added to a result only when there are any (so every other is unchanged). */
function withDurable(result, d) {
	if (result === null || typeof result !== "object") return result;
	if (d.recoverSkipped === null && d.recovered === null && d.checkpoints === null) return result;
	return { ...result, ...(d.recoverSkipped !== null ? { recoverSkipped: d.recoverSkipped } : {}), ...(d.recovered !== null ? { recovered: d.recovered } : {}), ...(d.checkpoints !== null ? { checkpoints: d.checkpoints } : {}) };
}

/** The same on a throw, so a retried or failed attempt's record says them too (buildRecord reads the error). */
function tagDurable(e, d) {
	if (e === null || typeof e !== "object") return;
	try {
		if (d.recoverSkipped !== null && e.recoverSkipped === undefined) e.recoverSkipped = d.recoverSkipped;
		if (d.recovered !== null && e.recovered === undefined) e.recovered = d.recovered;
		if (d.checkpoints !== null && e.checkpoints === undefined) e.checkpoints = d.checkpoints;
	} catch {
		// a frozen error keeps its own fields
	}
}

/**
 * The run reached its final outcome (a completed or policy result): remove its checkpoint store entry, its Valkey
 * pointer and its budget ledger. Each best effort and logged by name, never thrown: every one has a TTL or a sweep
 * behind it, and a cleanup fault must not turn a finished run into a failure.
 */
async function endDurableRun(d, deps) {
	const log = typeof deps.log === "function" ? deps.log : () => {};
	const quietly = async (what, fn) => {
		try {
			const r = await fn();
			if (r && typeof r === "object" && (r.error || r.skipped)) log("durable_cleanup_failed", { what, code: String(r.error ?? r.skipped).slice(0, 40) });
		} catch (error) {
			log("durable_cleanup_failed", { what, code: typeof error?.code === "string" ? error.code : "error" });
		}
	};
	if (deps.workspaceCheckpointer) await quietly("store", () => deps.workspaceCheckpointer.remove(d.runId));
	// The wiring's seam when it hands one over; else run-checkpoint.mjs's own delete on this processor's client, so a bare
	// wiring cannot leave a pointer that makes a later recovery think the run is still live. It answers false, never a
	// throw, when Valkey did not answer: logged, and the pointer's 7-day expiry is the backstop.
	await quietly("pointer", async () => {
		const done = typeof deps.removeCheckpointPointer === "function" ? await deps.removeCheckpointPointer({ runId: d.runId }) : await removePointerDefault({ redis: deps.redis, runId: d.runId });
		return done === false ? { error: "unanswered" } : null;
	});
	if (deps.runBudgetLedger) await quietly("ledger", () => deps.runBudgetLedger.remove(d.runId));
}

export async function runJob(job, deps) {
	const durable = durableOf(job);
	// Issue #704: what this attempt did with the project's secret bundle, for the record (`bundle` or `bundleSkipped`).
	const bundleFacts = { bundle: null, bundleSkipped: null };
	let result;
	try {
		result = await runAttempt(job, deps, durable, bundleFacts);
	} catch (e) {
		tagDurable(e, durable);
		tagBundle(e, bundleFacts);
		// A RECOVERY job has one attempt (recovery-queue.mjs), so a never-started retry would fail it for good over a
		// blip (a pointer read, a ledger write, a restore that met a lock). Every such throw becomes a wait hold instead:
		// `makeProcessor` delays it without spending the attempt, and the run's recovery deadline (`recoverBy`, the
		// host-lost sweep) bounds how long it can wait. Nothing was started, so nothing is lost by asking again.
		if (durable.isRecovery && e instanceof InfraRetry && e.reason === "container-never-started" && !(e instanceof RecoveryWaitHold)) {
			const hold = new RecoveryWaitHold(e.message, { cause: e, reason: e.reason, provider: e.provider, model: e.model, budgetReserved: e.budgetReserved, dollars: e.dollars, resources: e.resources, exitCode: e.exitCode, turns: e.turns, tokens: e.tokens, session: e.session, usage: e.usage, waitMs: RECOVERY_RETRY_WAIT_MS });
			tagDurable(hold, durable);
			tagBundle(hold, bundleFacts);
			deps?.log?.("recovery_retry_held", { delayMs: RECOVERY_RETRY_WAIT_MS });
			throw hold;
		}
		throw e;
	}
	// The run's FINAL outcome cleans up after it. Not a queued recovery (its checkpoint is what the recovery restores),
	// and not `recovery-superseded`: that one is decided on a pointer read that came back empty, and an empty read must
	// never be the reason another run's store is deleted; the run that settled cleaned up after itself.
	if (durable.armed && result?.reason !== RECOVERY_ENQUEUED && result?.reason !== RECOVERY_SUPERSEDED) await endDurableRun(durable, deps);
	return withBundle(withDurable(result, durable), bundleFacts);
}

/**
 * The secret-bundle facts the record carries (issue #704), added to a result only when there are any, so every other
 * result is unchanged. NAMES only: `bundle` is `{ id, variables, shadowed }`, never a value.
 */
function withBundle(result, b) {
	if (result === null || typeof result !== "object") return result;
	if (b.bundle === null && b.bundleSkipped === null) return result;
	return { ...result, ...(b.bundle !== null ? { bundle: b.bundle } : {}), ...(b.bundleSkipped !== null ? { bundleSkipped: b.bundleSkipped } : {}) };
}

/** The same on a throw, so a retried or failed attempt's record says what it held (buildRecord reads the error). */
function tagBundle(e, b) {
	if (e === null || typeof e !== "object") return;
	try {
		if (b.bundle !== null && e.bundle === undefined) e.bundle = b.bundle;
		if (b.bundleSkipped !== null && e.bundleSkipped === undefined) e.bundleSkipped = b.bundleSkipped;
	} catch {
		// a frozen error keeps its own fields
	}
}

async function runAttempt(job, deps, durable, bundleFacts = { bundle: null, bundleSkipped: null }) {
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
		// (job) => boolean (issue #625): whether the job's session key holds a `parked` mark. Free and never throws. The
		// default answers no, so a wiring without a store refuses every phrase-free reply rather than running one.
		isParked = () => false,
		// (job, on) => Promise<void> (issue #625): add or remove the forge's parked marker. Never throws; the marker is a
		// hint for the receiver, and the sidecar decides. The default does nothing.
		parkedLabel = async () => {},
		// () => Promise<unknown> (DES-AWAIT-INPUT-ENDS-THE-JOB): close this job's semantic dedup window once it has parked,
		// so the answer is not swallowed against it. Takes no job: the key belongs to the REAL BullMQ job, which only the
		// wiring holds (index.mjs binds queue.mjs's `releaseSemanticWindow` to it). Never throws. The default does nothing.
		releaseParkedWindow = async () => {},
		// () => Promise<{ resumed } | null> (issue #638, DES-AWAIT-INPUT-ENDS-THE-JOB): take the replies held for this run
		// while it was parking, after the window is released: the first recent one is enqueued as the resumed job, the
		// rest answered once (held-settle.mjs `takeHeld`). Bound by the wiring to the REAL job, like the release. Never
		// throws. The default takes nothing, so a wiring without it parks exactly as before.
		takeHeldReplies = async () => null,
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
		// Issue #704, project secret bundles. `findSecretBundle(job, { project })` is the worker's own read of the triggers
		// file's `secretBundles` (triggers-file.mjs `makeFindSecretBundle`); the default finds none, so a bare processor
		// and every deployment without the key run exactly as before. `secretBundles` is the bundle seam
		// (secret-bundles.mjs `makeBundleResolver`, its overlay and signal bound by the wiring): `lookup(profile)` with
		// no spawn, `resolve(job, binding)` with one. Its default FAILS CLOSED, `resolveSecrets`' posture and reason:
		// a wiring that finds a bundle and cannot resolve one must refuse, never start the job without the environment.
		findSecretBundle = () => ({ none: true }),
		secretBundles = { lookup: (profile) => ({ profileUnknown: profile }), resolve: async (_job, binding) => ({ profileUnknown: binding?.profile ?? null }) },
		// `(job, token) => { headRef, headRepo }` for a pull-request target, the forge host's own (prepare-github.mjs reads
		// the same seam for run.resume): whether the head lives in the base repository, answered by the FORGE, never the
		// payload. Asked only for a job whose project has a bundle without `forkReviews`. Null on a bare wiring, which
		// can confirm no head and so grants no bundle to a pull request (`bundleSkipped: "fork"`, the direction that
		// grants nothing).
		resolvePullRequestHead = null,
		// Issue #704 review: whether a profile this host lacks DEFERS the job rather than refusing it: true only for a job
		// on a multi-host worker's shared queue (index.mjs, the never-fits gate's predicate), where another host may serve
		// it. False by default, so a single host refuses, as it always did.
		bundleProfileDeferrable = false,
		// Issue #704 part 3: the job's venue's judgement of its project secret bundle (the registry's `bundleGate`,
		// backend-openshell.mjs's for both OpenShell venues), `(job, { endpoints, vars, shadowed })` => `{ ok, placeholders?,
		// plain? }`, `{ venueRefused: { reason, comment } }` or `{ unavailable }`. The default admits, which is every venue
		// that holds its env as values: there a bundle's variables simply join the env.
		bundleGate = async () => ({ ok: true }),
		// (job) => { ok, document } | { refused, name, why } | { unavailable: code } (REQ-MCP-OPERATOR-SERVERS,
		// mcp-preflight.mjs). The default passes a job that names no server and refuses one that does, so a wiring that
		// forgot the check can never run a job without the servers its trigger names.
		checkMcp = (job) => (job?.mcp !== undefined ? { refused: "mcp-config-invalid", name: null, why: "this worker reads no MCP servers" } : { ok: true, document: null }),
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
		// runContainer({ job, token, prepared, secrets, name, signal, user, home, modelEndpoints?, size?, hostCpus?, unenforced? }) => { code, aborted, abortReason, turns, tokens, session, usage, context, exitReason }.
		// `size` (issue #596) is `jobSize` below; `hostCpus` the runtime's CPU count off the job-user gate's own facts read.
		// `unenforced` (issue #596) is the size flags that same read says the runtime drops, passed only when there are some.
		// `exitReason` (issue #437) is parseExitReason's closed-set label, read only inside the exit-2 branch, and in the
		// exit-0 branch for `awaiting-input` alone (issue #625).
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
		// Issue #596, phase 2: the host's CPU budget at pickup in hundredths (`host-budget.mjs`), or null when it is off or
		// unknown. It becomes every job's `--cpus` (capped at the runtime's count), so no job can use the reserve.
		cpuBudgetCenti = null,
		// Issue #503 part 7: the builtin catalog's model object for (provider, id), or null (model-catalog.mjs
		// `builtinModel`). Read only by the zero-rated check; the default knows no builtin model, so an unwired
		// processor judges overlay models alone and reserves for every other.
		builtinModel = () => null,
		// Issue #645, durable runs. Every one defaults to inert, and none is read unless the job armed `run.recover`, so an
		// unwired processor runs every other job exactly as before. `workspaceCheckpointer` is workspace-checkpoint.mjs's
		// (null when PI_CHECKPOINTS_DIR is unset), `runBudgetLedger` run-budget-ledger.mjs's, `readCheckpointPointer`
		// `({ runId }) => pointer | null` and `enqueueRecovery` `({ job, cause, pointer }) => { enqueued, jobId, n } |
		// { enqueued: false, reason }` (recovery-queue.mjs, bound to the real BullMQ job by the wiring). `stageRecovered`
		// is the session store's (session-store.mjs). `resetTrustPaths` is trust-paths.mjs's. `runningJobs` is the
		// processor's `{ list() }` of the jobs running on this host, and `hostName` this worker's name, as the checkpoint
		// manifest records it.
		workspaceCheckpointer = null,
		runBudgetLedger = null,
		readCheckpointPointer = null,
		enqueueRecovery = null,
		stageRecovered = null,
		resetTrustPaths = resetTrustPathsDefault,
		runningJobs = null,
		hostName = null,
		// `({ runId, pointer, attempt }) => { seq } | { skipped }` (start.mjs): a salvage checkpoint from a crashed attempt's
		// job directory still on this host, asked for a recovery job before its manifest is read. Null takes none.
		salvageCheckpoint = null,
		// `(jobId) => record | null` (run-history.mjs `makeReadRecord`): the settled-run check a recovery asks first. Null
		// skips it, and the pointer and store logic below still decide.
		readRecord = null,
		// `({ workspace, baseSha }) => boolean` (trust-paths.mjs): whether the base commit holds anything under
		// `.pi/extensions/`, which makes a run unrecoverable (see its use).
		baseHasExtensions = baseHasExtensionsDefault,
		now = new Date(),
	} = deps;
	// `armed` can still drop to false for a fresh attempt whose base holds `.pi/extensions/` (below), before anything durable.
	let { armed } = durable;
	const { runId, isRecovery } = durable;
	// The checkpoint a recovery job restores, read and judged among the free gates below.
	let manifest = null;
	let transcriptPath = null;
	// Whether this attempt's dollar hold has a durable record (`recordHold`): only then do its settle and release go through
	// the ledger's compare-and-set. A hold that failed to be recorded is given back directly, since no one else can see it.
	let holdRecorded = false;
	// Issue #645: the job-count slot an armed run carries from an earlier attempt (`claimSlot` answered "carried"). It is
	// still counted, by the attempt that reserved it, so this attempt reserves none and refunds none.
	let slotCarried = false;
	// Whether an armed run's slot belongs to the RUN rather than to this attempt (any successful claim). Such a slot is not
	// refunded by a never-started retry: the retry carries it (`claimSlot` answers "carried"), so refunding it here would
	// let the retry run on a slot nothing counts. Only the run's final outcome gives a slot back (a refusal or
	// config-refused, exactly as before).
	let slotOwnedByRun = false;

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
	// A carried slot (issue #645) is held too: by the run, under the attempt that reserved it.
	const globalHeld = () => (globalLedger !== null && held.includes(globalLedger)) || slotCarried;
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
	// Issue #644: the run's progress summary (run-progress.mjs `summary`), null until a container ran with the reducer on.
	// Display only: carried to the record like `resources`, and never read by any decision below.
	let progress = null;

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
				await comment(job, `Refused: this trigger sets \`run.${skew.field}\`, but the job reached the worker without it, so it would have run as though the trigger did not set it. Either the trigger changed after this job was queued (re-run it), or a service in this deployment is stale: below the version that carries the field, or still reading an older copy of the triggers file and in need of a restart. Not run.`);
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
		// Issue #683: a folder job (a local run, a cron trigger's folder) on a venue that declares `localFolders` absent.
		// The loader refuses a trigger that NAMES such a venue (`refusesLocalWorkspace`); this is the one it could not
		// see, a trigger with no `run.backend` on a deployment whose DEFAULT is such a venue. A copy is edited elsewhere
		// and written back afterwards, racing every edit the operator makes meanwhile (`DES-OPENSHELL-VENUE`).
		const venueName = resolveBackendName(job, blessedBackends[0]);
		if (job.kind === "local" && backendFor(venueName)?.declares?.localFolders === ABSENT) {
			await comment(job, `Refused: this job runs against a folder on this machine, and its venue "${venueName}" copies a job's files instead of editing a folder in place. Run it on a venue that mounts folders (local or podman). Not run.`);
			log("refused_venue_local_folders", { backend: venueName });
			return { outcome: "policy", reason: "venue-local-folders-unsupported", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
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
		// Issue #683: a venue's own refusal, made before spend whatever the floor says: the openshell venue's gateway is not
		// on this host, has a gateway-wide policy in force, or the host has no Landlock (`CONST-VENUE-EGRESS-LAYER`'s third
		// and fourth conditions). Determinate, so a RETURN (CONST-RETRY-INFRA-ONLY), ahead of the image preflight and the
		// mint. The comment is the venue's fixed sentence for its reason, never anything the runtime said.
		if (observed?.venueRefused && typeof observed.venueRefused.reason === "string") {
			const { reason, comment: text } = observed.venueRefused;
			await comment(job, typeof text === "string" && text !== "" ? text : VENUE_REFUSED_COMMENT);
			log("refused_venue", { reason });
			return { outcome: "policy", reason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
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
						? PODMAN_CONF_COMMENTS["rootful-widens"]
						: PODMAN_CONF_COMMENTS["rootful-unread"]
					: live
						? key
							? PODMAN_CONF_COMMENTS["live-widens"]
							: PODMAN_CONF_COMMENTS["live-unread"]
						: key
							? PODMAN_CONF_COMMENTS.widens
							: PODMAN_CONF_COMMENTS.unread,
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
				await comment(job, modelUnknownComment(why));
				// `why` is a fixed token: `overlay-unparseable` tells the operator the file is the problem, not the id.
				log("refused_model_unknown", { provider: known.unknown.provider ?? null, model: known.unknown.id ?? null, why: known.why ?? null });
				return { outcome: "policy", reason: "model-unknown", why, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			// The main model must be on the job's list. The loader refuses this when one trigger names all three, so
			// what reaches here is a model or provider the overlay or the env supplied: a `PI_ALLOWED_MODELS` that
			// does not list `PI_MODEL`, or a `dispatch_set model` that moved the default off a trigger's list. Both
			// halves are compared, exact (`modelOnList`), the runner guard's rule.
			if (Array.isArray(job.models) && !modelOnList(job.models, job.provider, job.model)) {
				await comment(job, MODEL_NOT_ALLOWED_COMMENTS.main);
				log("refused_model_not_allowed", { provider: job.provider ?? null, model: job.model ?? null });
				return { outcome: "policy", reason: "model-not-allowed", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			// A listed model whose declared fallbacks are not all listed (model-catalog.mjs `declaredFallbacks`): on
			// anthropic-messages pi sends them with every call, so the runner's guard would refuse every call to it after
			// the container started; on any other api the worker is stricter than the runner, by decision. Refused here, free. The log names the listed model, the operator's own configuration; the
			// comment names none.
			if (known?.fallbackUnlisted) {
				await comment(job, MODEL_NOT_ALLOWED_COMMENTS["fallback-unlisted"]);
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
					? ENVELOPE_MISMATCH_COMMENTS["no-envelope"]
					: ENVELOPE_MISMATCH_COMMENTS.mismatch,
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
		// A reply that reached this job WITHOUT the trigger phrase (issue #625) was routed only because the forge said the
		// issue carries the parked marker, and anyone who may label an issue can set that. The truth is the key's `parked`
		// mark beside its transcript, and it is free to read, so it is asked here, before the mint and before any spend.
		// Without it the reply is ordinary conversation on an issue: refused, silently (no comment, since the person was
		// talking to people), and the stale marker is cleared so the next comment is not routed here again.
		if (job.parkedReply === true && !isParked(job)) {
			log("refused_not_parked", { kind: job.kind ?? null });
			await parkedLabel(job, false);
			return { outcome: "policy", reason: "not-parked", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (job.resume === true && !sessionsDir) {
			await comment(job, REFUSAL_COMMENTS["sessions-dir-unset"]);
			// The variable NAME, never a value: there is no path to print here (its absence IS the refusal),
			// and the store's path is the one setting SECURITY.md calls a PII store. `kind` is host-assigned,
			// the same PII class as the `repo` on the branch refusal below.
			log("refused_sessions_dir_unset", { kind: job.kind ?? null });
			// exitCode/turns/tokens null and budgetReserved false: refused pre-container AND pre-reserve,
			// exactly as the image refusals above. RETURNED, not thrown: an unset environment variable is
			// determinate, and no number of retries sets it (CONST-RETRY-INFRA-ONLY).
			return { outcome: "policy", reason: "sessions-dir-unset", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// Issue #645, durable runs: `run.recover`'s free refusals, here beside run.resume's and for its reasons. Free (a
		// value in hand, a Valkey GET, a manifest read off this host's disk), determinate, and strictly before the mint,
		// the clone, the token-cap read and every reserve (CONST-BUDGET-BEFORE-TOKENS).
		//
		// The store's absence is run.resume's one fail-CLOSED case again: without a checkpoint store nothing is kept, a
		// lost run is retried from scratch, and the job still looks protected. A wiring that has a store but not the
		// rest of the machinery (a ledger, the pointer read, the enqueuer) is a defect of this build, not of the operator's
		// settings, so it is a config refusal: refunded, `doctor`-pointed, never run half-armed.
		if (armed && !workspaceCheckpointer) {
			await comment(job, RECOVERY_COMMENTS["recover-store-unset"]);
			log("refused_checkpoints_dir_unset", { kind: job.kind ?? null });
			return { outcome: "policy", reason: "recover-store-unset", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}
		if (armed && (!runBudgetLedger || typeof readCheckpointPointer !== "function" || typeof enqueueRecovery !== "function")) {
			throw configError("run.recover is armed, and this worker was built without the run budget ledger, the checkpoint pointer read or the recovery enqueuer");
		}
		if (isRecovery) {
			const n = durable.recovery;
			// SETTLED, first of all: the run (its base attempt or an earlier recovery) already wrote a completed or policy
			// record, so it reached its final outcome and there is nothing to continue. Silent, and cleans nothing (that
			// outcome cleaned up after itself). Asked BEFORE the pointer and the store, because those can disagree after a
			// cleanup that half failed (a store removal that failed beside a pointer delete that landed), and that
			// disagreement must never put a failure comment under a run that completed.
			if (typeof readRecord === "function") {
				const ids = [runId, ...Array.from({ length: Number.isSafeInteger(n) && n > 1 ? Math.min(n, RECOVERY_CAP + 1) - 1 : 0 }, (_, k) => `${runId}.r${k + 1}`)];
				for (const id of ids) {
					let rec = null;
					try {
						rec = await readRecord(id);
					} catch {
						rec = null;
					}
					if (rec && typeof rec === "object" && rec.jobId === id && (rec.outcome === "completed" || rec.outcome === "policy")) {
						log("recovery_superseded", { n: Number.isSafeInteger(n) ? n : null, by: "record" });
						return { outcome: "policy", reason: RECOVERY_SUPERSEDED, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
					}
				}
			}
			// THE CAP: a run continued twice is not continued a third time, whatever its checkpoint holds.
			if (!Number.isSafeInteger(n) || n < 1 || n > RECOVERY_CAP) {
				await comment(job, RECOVERY_COMMENTS["recovery-cap"]);
				log("refused_recovery_cap", { n: Number.isSafeInteger(n) ? n : null, cap: RECOVERY_CAP });
				return { outcome: "policy", reason: "recovery-cap", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			// SUPERSEDED: the base run reached its final outcome after this recovery was queued (a completed or policy result
			// removes the pointer), so there is nothing left to continue. Silent: that outcome already said what it had to.
			// A read that THROWS is not an answer, so it is retried, never taken for "settled".
			let pointer;
			try {
				pointer = await readCheckpointPointer({ runId });
			} catch {
				throw new InfraRetry("the run's checkpoint pointer could not be read", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
			// The pointer read answers null for "no pointer" AND for "Valkey did not answer in time" (run-checkpoint.mjs never
			// throws), so null alone must not decide: a silent refusal would drop a live run's continuation over a blip. A
			// run's final outcome removes its STORE ENTRY before its pointer (`endDurableRun`), so superseded is a missing
			// pointer AND a missing store. A missing pointer beside a store that is still there is ambiguous, and is
			// retried loudly rather than guessed either way (continuing could re-run a run that completed).
			if (pointer === null || pointer === undefined) {
				const still = await workspaceCheckpointer.readManifest(runId);
				if (still?.absent === true) {
					log("recovery_superseded", { n });
					return { outcome: "policy", reason: RECOVERY_SUPERSEDED, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
				}
				log("recovery_pointer_unread", { n });
				throw new InfraRetry("the run's checkpoint pointer is missing while its checkpoint is still there", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
			// THE BASE STILL RUNNING HERE: its container may still be alive and spending, so this recovery must neither
			// settle its hold as crashed nor start a second agent on the same branch. It waits, without an attempt
			// (`RecoveryWaitHold`), until that container is gone. Asked of this host only: the recovery is queued to the
			// host the checkpoint is on, which is the host the base ran on.
			// THIS job is in that list too (the processor admits a job before it runs it), under the id the recovery queue
			// gave it (`<runId>.r<n>`, recovery-queue.mjs), so its own entry is excluded: without that every recovery would
			// find itself running and wait for ever.
			const ownId = `${runId}.r${n}`;
			const live = typeof runningJobs?.list === "function" ? runningJobs.list() : [];
			if (live.some((e) => typeof e?.id === "string" && e.id !== ownId && (e.id === runId || e.id.startsWith(`${runId}.r`)))) {
				log("recovery_waits_for_base", { n, delayMs: RECOVERY_WAIT_MS });
				throw new RecoveryWaitHold("the run this recovery continues is still running on this host", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false, waitMs: RECOVERY_WAIT_MS });
			}
			// SALVAGE, before the manifest is read: a crashed attempt whose job directory is still on this host (the worker
			// died, the directory did not) gets one last checkpoint taken from it (`kind: "salvage"`), so the recovery
			// continues from where the run really got to rather than from its last live checkpoint. The wiring's
			// (start.mjs); it never throws by contract, and is guarded anyway: a failed salvage leaves the last committed
			// checkpoint, which is still a correct place to continue from.
			if (typeof salvageCheckpoint === "function") {
				const salvaged = await Promise.resolve()
					.then(() => salvageCheckpoint({ runId, pointer, attempt: pointer.attempt }))
					.catch(() => ({ skipped: "error" }));
				log("recovery_salvage", Number.isSafeInteger(salvaged?.seq) ? { seq: salvaged.seq } : { skipped: typeof salvaged?.skipped === "string" ? salvaged.skipped.slice(0, 40) : "unknown" });
			}
			// THE CHECKPOINT, judged before anything spends: valid (readManifest hashes the transcript against its
			// manifest), taken on THIS host, by THIS image's pi version, in THIS job's venue. A transcript from another pi
			// may hold tool-call arguments the current schema refuses (the run.resume rule), and a checkpoint from another
			// venue was quiesced under another runtime's pause.
			const read = await workspaceCheckpointer.readManifest(runId);
			const m = read?.ok === true ? read.manifest : null;
			const venue = resolveBackendName(job, blessedBackends[0]);
			const why = m === null ? (read?.absent ? "absent" : "invalid") : typeof hostName === "string" && hostName !== "" && m.host !== normalizeHost(hostName) ? "host" : piVersion === null || m.piVersion !== piVersion ? "pi-version" : m.venue !== venue ? "venue" : null;
			if (why !== null) {
				await comment(job, RECOVERY_COMMENTS["recovery-checkpoint-absent"]);
				// `why` is a fixed token, and `invalid`'s detail is the store's own fixed reason (`field:seq`, `transcript-mismatch`).
				log("refused_recovery_checkpoint_absent", { n, why, ...(why === "invalid" && typeof read?.reason === "string" ? { detail: read.reason.slice(0, 40) } : {}) });
				return { outcome: "policy", reason: "recovery-checkpoint-absent", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			manifest = m;
			transcriptPath = read.transcriptPath;
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
			await comment(job, REFUSAL_COMMENTS["skills-dir-missing"]);
			// The FIELD name, never its value. `comment` posts publicly on the issue, so a host path here
			// would publish the operator's filesystem layout to anyone reading the thread; the log line is
			// the same restraint refused_sessions_dir_unset keeps.
			log("refused_skills_dir_missing", { kind: job.kind ?? null });
			return { outcome: "policy", reason: "skills-dir-missing", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// REQ-MCP-OPERATOR-SERVERS. A trigger that named MCP servers its job cannot use would run its flow without them,
		// or hand a server the job's own credentials, or open a connection the egress proxy refuses at its first call:
		// each a plausible report and a clean exit. One read of the overlay's mcp.json, no credential and no network, so
		// it sits with the free refusals before the secrets resolver (the one gate that spawns) and before anything that
		// spends (CONST-BUDGET-BEFORE-TOKENS). Its answer carries the per-job document prepare writes, so the servers the
		// job connects are exactly the ones this passed.
		const mcpChecked = checkMcp(job);
		if (mcpChecked.unavailable) {
			throw new InfraRetry(`an overlay file the MCP check reads (mcp.json, models.json or egress-allowlist.conf) could not be read just now (${mcpChecked.unavailable})`, { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
		}
		if (mcpChecked.refused) {
			// The server NAME is the operator's own configuration, the same class as the image ref on the image refusal.
			// `why` can name an internal host or a variable (never a value, a url's path or its query), so it goes to the
			// worker's log and the public comment says only which rule refused.
			await comment(job, mcpRefusalComment(mcpChecked.refused, mcpChecked.name));
			log("refused_mcp", { kind: job.kind ?? null, reason: mcpChecked.refused, server: mcpChecked.name ?? null, why: mcpChecked.why });
			return { outcome: "policy", reason: mcpChecked.refused, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
		}

		// PROJECT SECRET BUNDLES, the free half (issue #704, REQ-TRIGGER-SECRETS, DES-PROJECT-SECRET-BUNDLES). WHICH jobs
		// get their project's bundle is decided here, before the mint, the clone and every reserve, from one cached read
		// of the triggers file and the host's declarations: no spawn, no network (CONST-BUDGET-BEFORE-TOKENS). The read
		// itself comes after the run.secrets resolver and, like it, before the mint, except for a pull request that needs
		// the fork check: that one needs the forge and the job's token, so its read follows the mint (below).
		//
		// TRIGGER-MADE JOBS ONLY, and the predicate is the portfolio gate's: a chained `/outbox` child and every manual
		// run (`pi-dispatch run`, `/dispatch run`, `dispatch_run`) hold none, each recorded as `bundleSkipped`. The
		// operator's grant was to the triggers they reviewed, not to what a job queues next or what a model asks for
		// (outbox.mjs keeps `run.secrets` off children for the same reason). Chained is asked first: a child may carry
		// its parent's trigger context, and it must never read as manual. A trigger's `run.secretBundle: false` is
		// `opted-out`, read from the live file rather than the job data (triggers-file.mjs says why).
		//
		// Every refusal RETURNS (CONST-RETRY-INFRA-ONLY): an undeclared or doubly declared profile, a resumed job
		// (`run.resume` would replay a transcript that may hold an echoed value into every later job on its key, the
		// rule that refuses `run.secrets` beside it at load, which cannot be applied at load here because the file
		// cannot know a job's project), and a trigger the file no longer holds. A file that has never been read and
		// validated in this process RETRIES a job with a project (the finder answers from its last good read otherwise),
		// and a profile this host lacks is DEFERRED on a multi-host worker's shared queue, the never-fits gate's rule,
		// since another host may serve it. A venue's refusal of the bundle itself comes with the read (`readBundle`).
		const bundleChained = job.parentJobId !== undefined || job.chainDepth !== undefined;
		const bundleManual = job.trigger === undefined || job.trigger === null;
		let bundleBinding = null;
		const bundleFound = await Promise.resolve()
			.then(() => findSecretBundle(job, { project: pickupProject }))
			.catch(() => ({ unreadable: "read-error", transient: true }));
		if (bundleFound?.unreadable !== undefined) {
			// Never a good read in this process, and the job has a project: which bundle it would hold is unknown. RETRIED,
			// never refused (a refused webhook delivery is gone, and the fix is the operator's next save) and never run
			// without (the silent no-op). A chained or manual job could hold none whatever the file says, so it runs.
			if (!bundleChained && !bundleManual) {
				// The errno or our own word (`invalid`), never a path or file text.
				log("secret_bundles_unreadable", { kind: job.kind ?? null, why: String(bundleFound.unreadable).slice(0, 40) });
				throw new InfraRetry("the triggers file's secretBundles could not be read, and has not been in this process", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
		} else if (bundleFound && bundleFound.none !== true) {
			if (bundleChained) bundleFacts.bundleSkipped = "chained";
			else if (bundleManual) bundleFacts.bundleSkipped = "manual";
			else if (bundleFound.triggerChanged === true) {
				await comment(job, BUNDLE_COMMENTS["secret-bundle-trigger-changed"]);
				log("refused_secret_bundle_trigger_changed", { kind: job.kind ?? null, bundle: bundleFound.id });
				return { outcome: "policy", reason: "secret-bundle-trigger-changed", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			} else if (bundleFound.optedOut === true) bundleFacts.bundleSkipped = "opted-out";
			else {
				if (job.resume === true) {
					await comment(job, BUNDLE_COMMENTS["secret-bundle-resume"]);
					log("refused_secret_bundle_resume", { kind: job.kind ?? null, bundle: bundleFound.id });
					return { outcome: "policy", reason: "secret-bundle-resume", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
				}
				const looked = secretBundles.lookup(bundleFound.bundle.profile);
				if (looked?.ok !== true && bundleProfileDeferrable === true) {
					// A multi-host worker's SHARED queue: another host may declare the profile, and routing does not steer a
					// bundled job there (DES-PROJECT-SECRET-BUNDLES says why). So this host does not refuse a job it merely
					// cannot serve: it hands it back, the never-fits gate's deferral, without spending an attempt.
					log("secret_bundle_profile_deferred", { kind: job.kind ?? null, bundle: bundleFound.id, profile: bundleFound.bundle.profile, ambiguous: looked?.ambiguous !== undefined });
					throw new SecretBundleProfileHold("this host cannot serve the job's secret bundle profile; another host may", { reason: looked?.ambiguous !== undefined ? "secret-bundle-profile-ambiguous" : "secret-bundle-profile-unknown", provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false });
				}
				if (looked?.ok !== true) {
					// The profile LABEL in the log only, and the bundle id: both operator config. The comment names neither,
					// the run.secrets refusals' restraint (the declared names would publish the operator's vault topology).
					const reason = looked?.ambiguous !== undefined ? "secret-bundle-profile-ambiguous" : "secret-bundle-profile-unknown";
					await comment(job, BUNDLE_COMMENTS[reason]);
					log(reason === "secret-bundle-profile-ambiguous" ? "refused_secret_bundle_profile_ambiguous" : "refused_secret_bundle_profile_unknown", { kind: job.kind ?? null, bundle: bundleFound.id, profile: bundleFound.bundle.profile });
					return { outcome: "policy", reason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
				}
				// Issue #704 part 3: no venue refusal here any more. Part 2 refused a bundled job on both OpenShell venues at
				// this point, which was AHEAD of the fork check, so a fork's job that would have run without the bundle was
				// refused for it. The venue's own judgement of the bundle (`bundleGate`) now runs inside the read below,
				// which a fork's job never reaches.
				bundleBinding = { id: bundleFound.id, ...bundleFound.bundle };
			}
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
			await comment(job, REFUSAL_COMMENTS["secret-profile-unknown"]);
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
			await comment(job, REFUSAL_COMMENTS["secret-profile-ambiguous"]);
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
		// `let`: a project bundle's variables join it after the mint (below), under the trigger's own values.
		let secrets = resolved.secrets ?? {};
		// Issue #704 part 3: the bundle's `{ endpoints, plain }` split, for the venue (null: no bundle reached this job).
		let bundleKeys = null;

		// Issue #704 part 3: the venue's answer, the same handling for both of its asks below. A refusal RETURNS with the
		// venue's fixed sentence (its log names the variable and host, never the comment); a source it could not read
		// RETRIES, as the observation preflight's does.
		// The hosts this job's OWN credentials are sent to beyond the forge's (issue #704 part 3, review round 1, H2), which a
		// bundle endpoint may not claim on a venue that binds one provider per host: the composed `baseUrl` of every model
		// the job may call (the overlay's models.json over pi's catalog, `outputCapView`, the composition the output cap and
		// the zero-rated check read), every declared model endpoint's host (keyed or not: the simple rule), and every
		// HTTP MCP server's host (its headers may carry a run.secrets value). A model whose baseUrl cannot be composed adds
		// nothing, and is said so in DES-OPENSHELL-VENUE.
		const credentialHosts = () => {
			const hosts = new Set();
			const add = (url) => {
				try {
					if (typeof url === "string" && url !== "") hosts.add(new URL(url).hostname.toLowerCase());
				} catch {}
			};
			for (const ref of callableModelRefs(job)) {
				if (ref === null) continue;
				try {
					add(outputCapView({ models: modelEndpoints?.models ?? null, provider: ref.provider, modelId: ref.id, builtinModel })?.baseUrl);
				} catch {}
			}
			for (const ep of modelEndpoints?.endpoints ?? []) if (typeof ep?.host === "string") hosts.add(ep.host.toLowerCase());
			for (const server of Object.values(mcpChecked?.document?.servers ?? {})) add(server?.url);
			return [...hosts].sort();
		};
		const askBundleGate = async (ask) => {
			const judged = await bundleGate(job, { ...ask, credentialHosts: credentialHosts(), capabilities: img.capabilities ?? [] });
			if (judged?.venueRefused && typeof judged.venueRefused.reason === "string") {
				const { reason, comment: text } = judged.venueRefused;
				await comment(job, typeof text === "string" && text !== "" ? text : VENUE_BUNDLE_REFUSED_COMMENT);
				log("refused_venue", { reason, bundle: bundleBinding.id });
				return { refused: { outcome: "policy", reason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false } }; // return => not retried
			}
			if (judged?.unavailable) throw new InfraRetry("the job's venue could not judge its secret bundle", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			return { judged };
		};
		// PROJECT SECRET BUNDLES, the read (issue #704). ONE resolver call, then the strict parse, the reserved names and
		// the merge. BEFORE the mint for every job that needs no fork check (CONST-BUDGET-BEFORE-TOKENS: its determinate
		// refusals spend nothing, not even a token), and right after the mint for a pull request whose head must be asked
		// of the forge first; either way before branch protection, the clone, the token-cap read and every reserve.
		// Returns null, or the result to return.
		const readBundle = async () => {
			if (bundleBinding === null) return null;
			// Issue #704 part 3: the hosts first, before the resolver runs, so a file naming a host this job's venue cannot
			// bind costs no read of the operator's manager. Here rather than among the free gates above (where part 2
			// refused every OpenShell bundle), because only here is the fork check behind it: a fork's job runs without
			// the bundle, so nothing about the bundle may refuse it.
			const endpoints = bundleBinding.endpoints ?? {};
			if (Object.keys(endpoints).length > 0) {
				const pre = await askBundleGate({ endpoints, vars: null });
				if (pre.refused) return pre.refused;
			}
			const bundleRead = await secretBundles.resolve(job, bundleBinding);
			if (bundleRead?.ok !== true) {
				if (bundleRead?.unreachable) {
					// INDETERMINATE (exit 1, an unknown exit, a spawn fault, a timeout): retried, the run.secrets rule. A
					// rate-limited manager read lands here, which is why its documented resolvers exit 1 for one.
					log("secret_bundle_resolver_unreachable", { kind: job.kind ?? null, bundle: bundleBinding.id, failure: bundleRead.failure ?? null, code: bundleRead.code ?? null, stderrBytes: bundleRead.stderrBytes ?? 0 });
					throw new InfraRetry(`the secret bundle's resolver could not answer for bundle ${bundleBinding.id}`, { reason: "secret-resolver-unreachable", provider: job.provider ?? null, model: job.model ?? null });
				}
				if (bundleRead?.reserved !== undefined) {
					// The variable NAME, in the log, so the operator can rename it in their manager. Not in the public
					// comment: a bundle's names are the contents of the operator's manager, not of the reviewed file.
					await comment(job, BUNDLE_COMMENTS["secret-name-reserved"]);
					log("refused_secret_bundle_name_reserved", { kind: job.kind ?? null, bundle: bundleBinding.id, name: bundleRead.reserved });
					return { outcome: "policy", reason: "secret-name-reserved", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
				}
				if (bundleRead?.profileUnknown !== undefined || bundleRead?.ambiguous !== undefined) {
					// Only if the declarations changed between the lookup above and this read: refused as there.
					const reason = bundleRead.ambiguous !== undefined ? "secret-bundle-profile-ambiguous" : "secret-bundle-profile-unknown";
					await comment(job, BUNDLE_COMMENTS[reason]);
					log(reason === "secret-bundle-profile-ambiguous" ? "refused_secret_bundle_profile_ambiguous" : "refused_secret_bundle_profile_unknown", { kind: job.kind ?? null, bundle: bundleBinding.id, profile: bundleBinding.profile });
					return { outcome: "policy", reason, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
				}
				// DETERMINATE: exit 2, an empty, oversized or malformed output, a bad name or value. `name` and `line`
				// ride the log only, for the reason above; the comment says which rule, in our words.
				const why = BUNDLE_FAILURES[bundleRead?.failure] ?? "did not return a usable environment";
				await comment(job, `Refused: this job's project has a secret bundle, and its resolver ${why}. The job would have started without the project's environment, and an agent that gets a 401 writes a plausible report and exits 0. Run the bundle's resolver by hand against its reference to see why: this comment carries neither the reference, nor the resolver's path, nor a byte of what it printed. Not run.`);
				log("refused_secret_bundle_unresolved", { kind: job.kind ?? null, bundle: bundleBinding.id, failure: bundleRead?.failure ?? null, name: bundleRead?.name ?? null, line: bundleRead?.line ?? null, code: bundleRead?.code ?? null, stderrBytes: bundleRead?.stderrBytes ?? 0 });
				return { outcome: "policy", reason: "secret-unresolved", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			// THE MERGE: the trigger's own run.secrets win a clash (secret-bundles.mjs `mergeBundleSecrets`), and the
			// shadowed names are recorded. The values join `secrets`, so every path that already treats a run.secrets
			// value as a secret treats these alike: buildContainerEnv injects them, the redaction covers every
			// non-NON_SECRET_ENV_KEYS name (run-container.mjs), and a checkpoint refuses to store any of them.
			const merged = mergeBundleSecrets(bundleRead.vars, secrets);
			// Issue #704 part 3: which received variables the bundle binds to a host (`endpoints`) and which go in plain; a
			// variable a run.secrets value shadowed is in neither unless `endpoints` names it (below). Said to every
			// venue (`bundleKeys` on the call bag); only a venue whose layer holds credentials reads it, and it judges the
			// split first, now with the values (`bundleGate`): a value its gateway would refuse is a refusal here, before
			// spend, never a create that fails as infrastructure and is retried into the same answer.
			const received = Object.fromEntries(Object.entries(bundleRead.vars).filter(([name]) => !merged.shadowed.includes(name)));
			const post = await askBundleGate({ endpoints, vars: received, shadowed: merged.shadowed });
			if (post.refused) return post.refused;
			// Review round 1, M2: a declared endpoint name a run.secrets value shadowed stays on that host's provider, now with
			// the trigger's value (the one that wins), so it resolves at the host the reviewed file binds the name to.
			bundleKeys = {
				endpoints: Object.fromEntries([...Object.keys(received), ...merged.shadowed].filter((name) => Object.hasOwn(endpoints, name)).map((name) => [name, endpoints[name]])),
				plain: Object.keys(received).filter((name) => !Object.hasOwn(endpoints, name)).sort(),
			};
			secrets = merged.secrets;
			bundleFacts.bundle = { id: bundleBinding.id, variables: Object.keys(bundleRead.vars).sort(), shadowed: merged.shadowed };
			// On a venue whose own layer holds the credentials, the record says how many reached the agent as placeholders
			// and how many as values (INT-RUN-HISTORY-FILE-CONTRACT), the venue's own counts.
			if (backendFor(resolveBackendName(job, blessedBackends[0]))?.credentialCustody === "layer" && Number.isSafeInteger(post.judged?.placeholders) && Number.isSafeInteger(post.judged?.plain)) {
				bundleFacts.bundle.placeholders = post.judged.placeholders;
				bundleFacts.bundle.plain = post.judged.plain;
			}
			log("secret_bundle_applied", { kind: job.kind ?? null, bundle: bundleBinding.id, count: bundleFacts.bundle.variables.length, shadowed: merged.shadowed.length });
			return null;
		};
		const bundleHeadCheck = bundleBinding !== null && job.target?.type === "pull_request" && bundleBinding.forkReviews !== true;
		if (bundleBinding !== null && !bundleHeadCheck) {
			const refused = await readBundle();
			if (refused !== null) return refused;
		}

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

		// PROJECT SECRET BUNDLES, the fork check (issue #704). AFTER the mint, because it needs the job's own token, and
		// BEFORE branch protection, the clone, the token-cap read and every reserve, so a refusal of the read that follows
		// still spends nothing but the minted token (CONST-BUDGET-BEFORE-TOKENS: every free refusal stays above the mint,
		// and so does the read of every job that needs no fork check). A refusal past the mint leaves that token to
		// expire, exactly as the unprotected-branch refusal below does: it is scoped to this job's repository and
		// short-lived (CONST-TOKEN-SCOPED-PER-JOB), and no path in this project revokes one, so this adds no second rule.
		//
		// A job on a pull request whose head lives in another repository reads a stranger's text (CONST-TRIGGER-AUTHOR-GATE
		// admits a collaborator's review of a fork), and must not hold every project secret while it does, so it runs
		// WITHOUT the bundle (`bundleSkipped: "fork"`) unless the bundle opted in with `forkReviews: true`. Answered by the
		// forge's own `resolvePullRequestHead`, the seam run.resume's fork gate already uses: the head repository must
		// EQUAL the job's, case-insensitively on GitHub and Forgejo, whose repository names are (GitLab and Azure answer by
		// project or repository id and report the job's own name back, so their comparison is exact). A webhook's
		// `head.repo` is attacker-supplied, and an `issue_comment` on a pull request carries no head at all, so the
		// payload cannot answer. A DETERMINATE forge answer (401, 403, 404: the token cannot see the pull request, or it
		// is gone) cannot become a yes by retrying, so the job runs without the bundle (`bundleSkipped:
		// "head-unverified"`); a network fault, a 5xx or a timeout RETRIES (InfraRetry), so a blip neither grants a bundle
		// nor drops one.
		if (bundleHeadCheck) {
			let head = null;
			let unverified = false;
			if (typeof resolvePullRequestHead === "function") {
				try {
					head = (await resolvePullRequestHead(job, token)) ?? {};
				} catch (error) {
					const status = headReadStatus(error);
					// A GitHub rate limit answers 403 (or 429) with `x-ratelimit-remaining: 0` or a `retry-after`: not a
					// determinate "you cannot see this pull request", so it RETRIES like any other transient answer.
					const rateLimited = headReadRateLimited(error);
					log("secret_bundle_head_unreadable", { kind: job.kind ?? null, status, rateLimited });
					if (rateLimited || (status !== 401 && status !== 403 && status !== 404)) throw new InfraRetry("the pull request's head could not be read to decide whether it is a fork", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
					unverified = true;
				}
			}
			const fold = job.kind === "github" || job.kind === "forgejo" ? (v) => v.toLowerCase() : (v) => v;
			const same = !unverified && typeof head?.headRepo === "string" && typeof job.repo === "string" && fold(head.headRepo) === fold(job.repo);
			if (!same) {
				bundleFacts.bundleSkipped = unverified ? "head-unverified" : "fork";
				log("secret_bundle_skipped", { kind: job.kind ?? null, bundle: bundleBinding.id, reason: bundleFacts.bundleSkipped });
				bundleBinding = null;
			}
		}
		if (bundleHeadCheck) {
			const refused = await readBundle();
			if (refused !== null) return refused;
		}

		if (isForgeBacked) {
			// REQ-BRANCH-PROTECTION-PRECONDITION. The agent's token can merge, so branch protection is the
			// only technical barrier to a self-merge. Refuse before spending anything. Forge-backed jobs
			// only: a local job has no remote branch to protect.
			if (!(await isDefaultBranchProtected(job, token))) {
				await comment(job, REFUSAL_COMMENTS["unprotected-branch"]);
				log("refused_unprotected", { repo: job.repo });
				// exitCode/turns/tokens null: refused pre-container, so no container exit, turn, or token count exists.
				return { outcome: "policy", reason: "unprotected-branch", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		// `podmanStore` (issue #429) only where the venue's job user carried one: the podman store the container ran in.
		// `portfolio` (issue #505) only for a job the gate above confirmed: prepare then writes /job/portfolio.json, after
		// asking the live file once more. Absent otherwise, so every other job's prepare call is unchanged.
		prepared = await prepareWorkspace(job, token, { piVersion, jobUser: { user: jobUser?.user ?? null, home: jobUser?.home ?? null }, ...(typeof jobUser?.store === "string" ? { podmanStore: jobUser.store } : {}), ...(portfolio ? { portfolio: true } : {}), ...(jobSize ? { size: jobSize } : {}), ...(mcpChecked.document ? { mcp: mcpChecked.document } : {}), ...(isRecovery ? { pin: { sha: manifest.workspace.baseSha, from: workspaceCheckpointer.baseSourceUrl(runId) } } : {}) }); // resolves SHA, clones, materialises .pi/, writes prompt

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
				await comment(job, REFUSAL_COMMENTS["local-folder-project-changed"]);
				log("refused_local_folder_project_changed", { pickup: pickupProject, resolved: resolvedProject });
				return { outcome: "policy", reason: LOCAL_FOLDER_PROJECT_CHANGED, exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
		}

		// Issue #645: A BASE WITH `.pi/extensions/` IS NOT RECOVERABLE. A merge-gated extension may import a file outside
		// `.pi/` (`../lib/x.js`) or a bare package resolved from the workspace's `node_modules`, and in a recovered run
		// those come from the restored tree, which the agent wrote. The trust reset puts `.pi/` back but cannot enumerate
		// what an extension imports, so the only sound answer is not to recover such a run at all. Decided here, at arm
		// time, from the fresh clone's own `.git` (the worker's, before any container), so the run is simply not armed:
		// no ledger claim, no checkpoints, no pointer, and it runs exactly as it did before #645, the record saying
		// `recoverSkipped: "workspace-extensions"`. A base that could not be read is not armed either, fail closed, and
		// says `base-unprimed`. The recovery side asks again before it restores (defence in depth).
		if (armed && !isRecovery) {
			let unsafe;
			try {
				unsafe = await baseHasExtensions({ workspace: prepared.workspace, baseSha: prepared.sha });
			} catch {
				unsafe = null;
			}
			if (unsafe !== false) {
				armed = false;
				durable.armed = false;
				durable.recoverSkipped = unsafe === true ? "workspace-extensions" : "base-unprimed";
				log("recover_not_armed", { reason: durable.recoverSkipped });
			}
		}

		// Issue #645: A RECOVERY JOB'S WORKSPACE. The preparer cloned the checkpoint's base commit from the checkpoint store
		// (`pin`), so the checkout is exactly the tree the checkpoint is a diff against; the restore applies the crashed
		// run's work on top. All of it local and free, before the token-cap read and every reserve.
		if (isRecovery) {
			const baseSha = manifest.workspace.baseSha;
			// The arm-time rule, again, on the base the store just handed over: a checkpoint of such a base can only exist
			// from a worker that armed it before this rule, and is refused rather than restored. Unreadable: retried.
			let unsafe;
			try {
				unsafe = await baseHasExtensions({ workspace: prepared.workspace, baseSha });
			} catch {
				unsafe = null;
			}
			if (unsafe === true) {
				await comment(job, RECOVERY_COMMENTS["recovery-unsafe-extensions"]);
				log("refused_recovery_unsafe_extensions", { n: durable.recovery });
				return { outcome: "policy", reason: "recovery-unsafe-extensions", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			if (unsafe !== false) throw new InfraRetry("whether the recovered base holds .pi/extensions could not be read", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			const restored = await workspaceCheckpointer.restore({ runId, manifest, intoWorkspace: prepared.workspace });
			if (restored?.refused) {
				// Determinate: the store refused its own checkpoint (tampered, another run's, a base that does not match).
				await comment(job, RECOVERY_COMMENTS["recovery-checkpoint-absent"]);
				log("refused_recovery_checkpoint_absent", { n: durable.recovery, why: "restore-refused", detail: String(restored.refused).slice(0, 40) });
				return { outcome: "policy", reason: "recovery-checkpoint-absent", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: false }; // return => not retried
			}
			if (!restored || restored.skipped || !Number.isSafeInteger(restored.written)) {
				log("recovery_restore_skipped", { reason: typeof restored?.skipped === "string" ? restored.skipped.slice(0, 40) : "error" });
				throw new InfraRetry("the checkpoint could not be restored", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
			// THE TRUST PATHS: what pi loads as the repository's own code and instructions (`.pi/`, `.agents/`, the root
			// AGENTS/CLAUDE files) goes back to the base commit's content, since the restored tree was written by the agent.
			// A reset that failed means the recovery would start on the agent's configuration, so it does not start.
			try {
				await resetTrustPaths({ workspace: prepared.workspace, baseSha });
			} catch (error) {
				log("recovery_trust_reset_failed", { code: typeof error?.code === "string" ? error.code : "error" });
				throw new InfraRetry("the recovered workspace's trust paths could not be reset", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
			// THE CONVERSATION: the checkpoint's transcript, staged where every job's transcript file is. A resume job's is a
			// session with its key (promoted on completion as before); any other job's is its live file.
			const staged = typeof stageRecovered === "function" ? await stageRecovered({ jobDir: prepared.jobDir, transcriptPath, piVersion, job, resolved: prepared.recoveryResolved ?? {} }) : null;
			if (!staged || typeof staged.hostDir !== "string") {
				throw new InfraRetry("the checkpoint's transcript could not be staged", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
			prepared = staged.key ? { ...prepared, session: staged } : { ...prepared, live: { hostDir: staged.hostDir } };
			durable.recovered = { from: manifest.kind, n: durable.recovery, fromAttempt: manifest.attempt, checkpointSeq: manifest.seq, orphans: null, replayed: null, interrupted: null, notStarted: null };
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
		// Issue #645: an armed run's job-count slot is the RUN's, claimed once in its budget ledger. "new": this attempt
		// reserves the ledgers below, exactly as every job did before. "carried": an earlier attempt (a retry's first try,
		// or the attempt a recovery continues) reserved it and is still counted in it, so nothing is reserved again. A
		// ledger that did not answer leaves the question open, so nothing is reserved and the attempt is retried.
		if (armed) {
			const claim = await runBudgetLedger.claimSlot(runId);
			if (claim !== "new" && claim !== "carried") {
				log("run_budget_claim_failed", { code: typeof claim?.error === "string" ? claim.error : "unknown" });
				throw new InfraRetry("the run's budget ledger could not be read", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
			slotCarried = claim === "carried";
			slotOwnedByRun = true;
		}
		globalLedger = { scope: null, keyPrefix: null, caps, softHoldPct, reason: null };
		let counted;
		try {
			counted = slotCarried ? { allowed: true } : await reserveLedgers(redis, [...(scopedLedgers ?? []), globalLedger], held, { now });
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

		// Issue #645: THIS CONTAINER'S NUMBER in the run (`nextSeq`: attempt 1 is 1, its retry 2, a recovery's container the
		// next), which addresses its dollar hold in the run's ledger and names its checkpoints' attempt. Before the dollar
		// reserve, because a hold is recorded under it: without a number there is no record, and without a record there is
		// no hold. A recovery then settles AT THE FLOOR every hold of the run's earlier containers still `held`: those
		// containers are dead (the base-still-running gate above holds this job until none of the run's is alive here),
		// and their real spend is unknown, so the reservation already in every window is what they are charged
		// (`settleCrashed`, bookkeeping only, no window key moves). A settle that failed is logged and the run goes on: the
		// holds stay `held` and in the windows at the floor, which is the safe side, and nothing releases an earlier
		// container's hold but that container itself.
		if (armed) {
			const seq = await runBudgetLedger.nextSeq(runId);
			if (!Number.isSafeInteger(seq) || seq < 1) {
				log("run_budget_seq_failed", { code: typeof seq?.error === "string" ? seq.error : "unknown" });
				throw new InfraRetry("the run's container number could not be taken", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
			}
			durable.seq = seq;
			if (isRecovery) {
				const crashed = await runBudgetLedger.settleCrashed(runId, seq);
				if (Array.isArray(crashed?.settled)) log("run_budget_settled_crashed", { holds: crashed.settled.length });
				else log("run_budget_settle_crashed_failed", { code: typeof crashed?.error === "string" ? crashed.error : "unknown" });
			}
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
			const zero = zeroRatedFor(job, { modelEndpoints, builtinModel });
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
				// Issue #645: an armed run never runs a container without a DURABLE record of its hold (run-budget-ledger.mjs's
				// contract), so a recovery after a crash can see it and settle it exactly once. A record that did not land
				// throws a never-started retry before any container; the catch gives the hold back directly (`holdRecorded`
				// false: no one else can see it to settle or release it).
				if (armed) {
					const rec = await runBudgetLedger.recordHold(runId, durable.seq, dollarHold);
					if (rec?.ok !== true) {
						log("run_budget_hold_unrecorded", { code: typeof rec?.error === "string" ? rec.error : "unknown" });
						throw new InfraRetry("the run's dollar hold could not be recorded", { reason: "container-never-started", provider: job.provider ?? null, model: job.model ?? null });
					}
					holdRecorded = true;
				}
			}
		}

		// Issue #642: ONE trail comment says who answered from the operator console and quotes what (console-answer.mjs:
		// mentions neutralised, no control byte). Posted HERE, after every pre-spend gate and every reserve has passed and
		// just before the container starts, so the issue never reads "answered" above a refusal that then dropped the
		// answer (a `not-parked`, a missing session store, a cap); and still before the provider is called, so it spends
		// nothing (CONST-BUDGET-BEFORE-TOKENS). The `comment` adapter posts as the deployment's own identity, which the
		// receiver's self-guard drops as `self`, so the trail never starts a job. A `console` field whose name is not a
		// console token's (a hand-built queue entry; enqueueForgeJob refuses one) posts nothing.
		//
		// ONCE PER JOB, not once per attempt: a forge job has `attempts: 2`, so an InfraRetry after this point re-runs every
		// gate and would reach here again, and a console retry of a failed answer job is the same job id again. The claim
		// is `SET console:trail:<jobId> 1 NX PX <31 days>` (the retention of a forge job's data, so the claim outlives every
		// way the same id can come back), and only the attempt that set it posts. On a Valkey error the trail is SKIPPED
		// and logged, never posted blind: at most once is the promise, because a duplicate trail reads on the forge as a
		// second answer, while a missing one leaves the answer in the job and the audit log. Never throws: the trail is
		// provenance, and a failed claim is no reason to refuse a job every gate has admitted.
		if (job.parkedReply === true && job.console !== undefined) {
			const by = consoleAnswerBy(job.console);
			if (by === null) log("console_answer_by_invalid", { kind: job.kind ?? null });
			else if (await claimConsoleTrail(redis, job, log)) await comment(job, answerTrailComment(by, job.trigger?.comment?.body));
		}

		// The user the gate above decided is the user that runs: one answer, never two call sites that agree.
		// Issue #545: an image that declares `exitAuth` is handed a per-job key on stdin and signs its exit line with it, and
		// then only a signed line is read (run-container.mjs, run-history.mjs `authenticExitLines`). An image that does not
		// declare it is read as before, under the #542 trust rule below alone.
		const exitAuth = (img.capabilities ?? []).includes(EXIT_AUTH_CAPABILITY);
		// Issue #686: an image whose runner can mirror its transcript over stderr. Handed as a fact; runContainer arms it only
		// on a venue that copies (`transcript: "stdio"`) and only beside a key, so every other run is called as before.
		const transcriptStderr = (img.capabilities ?? []).includes(TRANSCRIPT_STDERR_CAPABILITY);
		// Issue #686, part 2: an image whose runner reads steer frames on stdin. Handed as a fact, like the one above;
		// runContainer arms it only for a steer job on a venue that copies, so every other run is called as before.
		const steerStdin = (img.capabilities ?? []).includes(STEER_STDIN_CAPABILITY);
		// Issue #645: a FRESH armed run seeds the checkpoint store from its clone, now, before the container: the one moment
		// the workspace's `.git` is still the worker's own (workspace-checkpoint.mjs `primeBase`). After every reserve, so a
		// refused job never writes to the store. A recovery's base is already there. A base that could not be primed means
		// no checkpoint of this run can ever be restored: the run goes on unprotected and the record says so.
		let checkpointArgs = null;
		if (armed) {
			const baseSha = isRecovery ? manifest.workspace.baseSha : prepared.sha;
			if (!isRecovery) {
				const objectFormat = typeof baseSha === "string" && baseSha.length === 64 ? "sha256" : "sha1";
				let primed = null;
				try {
					primed = await workspaceCheckpointer.primeBase({ runId, workspace: prepared.workspace, baseSha, objectFormat });
				} catch {
					primed = null;
				}
				if (primed?.ok !== true) {
					durable.recoverSkipped = "base-unprimed";
					log("recover_base_unprimed", { reason: typeof primed?.skipped === "string" ? primed.skipped.slice(0, 40) : "error" });
				}
			}
			// The live checkpointer's open arguments (run-checkpoint.mjs): the run, this container's number, the base, and
			// the values a snapshot must refuse to store (the job's token and its resolved secrets). `attempt` IS the
			// container number: unique across retries and recoveries, which a BullMQ attempt count is not. `meta` is what the
			// manifest records and a recovery judges above: never a string the job chose.
			const secretValues = [token, ...Object.values(secrets ?? {})].filter((v) => typeof v === "string" && v !== "");
			checkpointArgs = { runId, attempt: durable.seq, baseSha, branch: null, secretValues, meta: { piVersion, imageDigest: img.imageDigest ?? null, venue: resolveBackendName(job, blessedBackends[0]), provider: job.provider ?? null, model: job.model ?? null } };
		}
		const { code, aborted, abortReason, turns, tokens, session, usage, context, detached, exitReason, exitWhy = null, exitLineCode = null, exitAuth: exitAuthResult = null, exitOomKilled = false, memoryLimit = null, resources: ranResources = null, progress: ranProgress = null, checkpoint: ranCheckpoint = null, recovery: ranRecovery = null, lingering = false } = await runContainer({ job: containerJob, token, prepared, secrets, ...(bundleKeys !== null ? { bundleKeys } : {}), user: jobUser?.user ?? null, home: jobUser?.home ?? null, relabel: jobUser?.relabel === true, ...(modelEndpoints?.endpoints?.length > 0 ? { modelEndpoints } : {}), ...(exitAuth ? { exitAuth: true } : {}), ...(transcriptStderr ? { transcriptStderr: true } : {}), ...(steerStdin ? { steerStdin: true } : {}), ...(jobSize ? { size: jobSize } : {}), ...(Number.isSafeInteger(jobUser?.hostCpus) ? { hostCpus: jobUser.hostCpus } : {}), ...(Number.isSafeInteger(cpuBudgetCenti) ? { cpuBudgetCenti } : {}), ...(Array.isArray(jobUser?.unenforced) && jobUser.unenforced.length > 0 ? { unenforced: jobUser.unenforced } : {}), ...(checkpointArgs !== null ? { recover: true, recovering: isRecovery, checkpoint: checkpointArgs } : {}) });
		containerRan = true;
		// Issue #596: what the container used, off its exit line, rebuilt by the sink (null from a runContainer that predates
		// the field). Every result and every throw below carries it, so a retried attempt's record says what it used too.
		resources = ranResources ?? null;
		progress = ranProgress ?? null;
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
		// Issue #645: what the runner says it did with the crashed attempt's orphaned tool calls (the exit line's `recovery`).
		// Issue #662: a recovery whose own container was killed writes no exit line, so its counts come from the transcript
		// instead (the reducer's recovery marks, this attempt's lines only), labelled `countsFrom: "transcript"`. The marks
		// are in an agent-writable file, so the exit line's counts win whenever the exit line CARRIES a `recovery` block
		// (`recoveryCounts` not null); an exit line without one (a verified line whose recovery step threw, say) falls back
		// to the transcript like a missing line. Neither feeds any decision.
		if (durable.recovered !== null) {
			const counts = recoveryCounts(ranRecovery);
			const fromTranscript = counts === null ? recoveryCountsFromProgress(progress) : null;
			if (counts !== null) durable.recovered = { ...durable.recovered, ...counts, countsFrom: "exit-line" };
			else if (fromTranscript !== null) durable.recovered = { ...durable.recovered, ...fromTranscript, countsFrom: "transcript" };
		}
		// A container the checkpointer stopped because it could not unpause it (`checkpointStopped`, code 137, not aborted)
		// is an infrastructure exit like any other here: not the worker's abort, not an OOM (no supervisor report), so it
		// reaches the unknown-exit arm below and recovers from the checkpoint that was committed before the pause.
		// Issue #645: THE EXIT CHECKPOINT, then the checkpointer's close, before anything below can return or throw. Taken
		// only on an exit this attempt may recover from: infrastructure (exit 1, an unknown code, a detached container),
		// never a worker's abort, an OOM kill, a completed or policy exit (none of those recovers) nor a never-started one
		// (nothing ran, and today's retry is cheaper). The container is dead, so nothing is paused. B1's handle is read
		// defensively: absent, or without `exit`, means no exit checkpoint, never a failure. Neither call may throw out of here.
		const neverStartedExit = isNeverStartedExit({ code, aborted, detached }, neverStartedExits(job));
		const recoverable = armed && !aborted && !oomKilled && code !== EXIT_COMPLETED && code !== EXIT_POLICY && !neverStartedExit;
		// Issue #686 part 3, review round 2 of #714: a venue whose box was not confirmed gone after the run (`lingering`,
		// `openshell-bind`) takes NO exit checkpoint: the host tree may still be written, so a snapshot of it is not a state
		// the run reached. A recovery then continues from the last committed checkpoint.
		if (ranCheckpoint !== null && typeof ranCheckpoint === "object") {
			if (recoverable && lingering !== true && typeof ranCheckpoint.exit === "function") {
				const taken = await Promise.resolve().then(() => ranCheckpoint.exit({ kind: "exit" })).catch(() => ({ skipped: "error" }));
				log("checkpoint_exit", taken && Number.isSafeInteger(taken.seq) ? { seq: taken.seq } : { skipped: typeof taken?.skipped === "string" ? taken.skipped.slice(0, 40) : "unknown" });
			}
			const closed = typeof ranCheckpoint.close === "function" ? await Promise.resolve().then(() => ranCheckpoint.close()).catch(() => null) : null;
			// `close()` answers the counts; `stats()` (a function on B1's handle) is the fallback when close did not.
			const stats = closed ?? (typeof ranCheckpoint.stats === "function" ? await Promise.resolve().then(() => ranCheckpoint.stats()).catch(() => null) : null);
			const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
			if (stats && count(stats.written) !== null && count(stats.failed) !== null && count(stats.skipped) !== null) durable.checkpoints = { written: stats.written, failed: stats.failed, skipped: stats.skipped };
		}
		// An infrastructure exit of an armed run: queue its continuation from the checkpoint instead of throwing a retry
		// (CONST-RETRY-INFRA-ONLY holds: nothing is returned as success, and the queued recovery IS the retry, one that
		// keeps the work). RETURNED, so BullMQ spends no second attempt that would start from scratch beside it. Not
		// queued (no checkpoint, the cap, a claim already taken, Valkey) -> today's InfraRetry, unchanged.
		// A RECOVERY job has one attempt, so a throw here would fail it with the generic failure comment and nothing else:
		// when its container ran, ended infra and no further recovery was queued, it RETURNS `recovery-failed` with its own
		// comment instead (the run's final outcome, so its checkpoint, pointer and ledger are cleaned up).
		const notQueued = async (err) => {
			if (!isRecovery) throw err;
			await comment(job, RECOVERY_COMMENTS["recovery-failed"]);
			return { outcome: "failed", reason: "recovery-failed", exitCode: code, turns, tokens, usage: usage ?? null, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...(resources ? { resources } : {}), ...(progress ? { progress } : {}) };
		};
		const recoverOrThrow = async (err) => {
			if (!recoverable) return notQueued(err);
			let pointer = null;
			try {
				pointer = await readCheckpointPointer({ runId });
			} catch {
				pointer = null;
			}
			if (pointer === null || pointer === undefined) {
				log("recovery_not_enqueued", { cause: "infra", reason: "no-checkpoint" });
				return notQueued(err);
			}
			let queued;
			try {
				queued = await enqueueRecovery({ job, cause: "infra", pointer });
			} catch {
				queued = { enqueued: false, reason: "error" };
			}
			if (queued?.enqueued !== true) {
				log("recovery_not_enqueued", { cause: "infra", reason: typeof queued?.reason === "string" && /^[a-z0-9-]{1,40}$/.test(queued.reason) ? queued.reason : "unknown" });
				return notQueued(err);
			}
			log("recovery_enqueued_after_exit", { cause: "infra", n: Number.isSafeInteger(queued.n) ? queued.n : null, exitCode: code });
			return { outcome: "failed", reason: RECOVERY_ENQUEUED, exitCode: code, turns, tokens, usage: usage ?? null, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...(resources ? { resources } : {}), ...(progress ? { progress } : {}) };
		};
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
		const neverStarted = neverStartedExit;
		if (dollarHold !== null && !neverStarted) {
			// The exit line is trusted only when the container exited ON ITS OWN (the worker did not abort, cancel, time
			// out or detach it, so the runner had the chance to write its genuine last line) AND that line's own `code` is
			// the container's real exit code (PR #542's review, round 3: a job's tool can forge a $0 line before a stop).
			const trusted = !aborted && detached !== true && Number.isSafeInteger(exitLineCode) && exitLineCode === code;
			const reservedMicros = dollarHold.amountMicros;
			const { settledMicros, basis } = dollarSettlement({ tokens, usage: usage ?? null, reservedMicros, trusted });
			// The deployment, the repo or folder and the project windows settle to the job's cost; each model window to its
			// own row of the usage ledger (`modelDollarSettlement`), never to the job's total.
			// Issue #645: a recorded hold is settled through the run's ledger first, `held` -> `settled`, and only the call
			// that MOVED it adjusts a window key. Anything else ("not-held": someone already finished it; a ledger error)
			// leaves the reservation in every window, the floor, which is the safe side and what the record then says.
			let ledgerMoved = true;
			if (holdRecorded) {
				const moved = await runBudgetLedger.settle(runId, durable.seq);
				ledgerMoved = moved === "moved";
				if (!ledgerMoved) log("run_budget_settle_skipped", { result: typeof moved === "string" ? moved : typeof moved?.error === "string" ? moved.error : "unknown" });
			}
			const jobPart = holdPart(dollarHold, (prefix) => jobCostPrefixes.has(prefix));
			const { applied, of } = ledgerMoved ? await settleDollars(redis, jobPart, settledMicros, { log }) : { applied: 0, of: 1 };
			let modelBasis = null;
			for (const part of ledgerMoved ? (dollarHold.ledgers ?? []) : []) {
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
			if (!ledgerMoved && modelPrefixes.size > 0) modelBasis = "floor";
			dollars = applied === 0 && of > 0 && (settledMicros !== reservedMicros || !ledgerMoved) ? dollarsRecord({ reservedMicros, settledMicros: reservedMicros, basis: "floor", modelBasis }) : dollarsRecord({ reservedMicros, settledMicros, basis, modelBasis });
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
			return await recoverOrThrow(new InfraRetry(`the container outlived its docker run, exit ${code}`, { reason: "container-detached", exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), dollars, resources }));
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
			return { outcome: "policy", reason, exitCode: code, turns, tokens, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...(resources ? { resources } : {}), ...(progress ? { progress } : {}) };
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
			return { outcome: "policy", reason: EXIT_OOM_KILLED, exitCode: code, turns, tokens, usage: usage ?? null, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...(resources ? { resources } : {}), ...(progress ? { progress } : {}) };
		}
		// Issue #686 part 3, review round 2 of #714 (CONST-RETRY-INFRA-ONLY): a box not confirmed gone after the run. Exit 2
		// keeps its own reason below, and a worker's abort stays the abort. A COMPLETED run is not thrown away as a retry,
		// and a FOLDER job is not retried while the first sandbox may still write the folder: both RETURN the venue's named
		// result, never retried, spend kept and settled above. The completed run's work stays where the agent put it (a
		// pushed branch, a folder's edits), but nothing more is done with its result: no session promotion, no chained
		// child, no completion comment, since the tree it would read may still change. Any other exit of a forge job is
		// infrastructure as before (its retry gets a fresh clone; its recovery the last committed checkpoint).
		if (lingering === true && !aborted && code !== EXIT_POLICY && (code === EXIT_COMPLETED || job.kind === "local")) {
			log("venue_box_lingering", { exitCode: code, kind: job.kind ?? null });
			await comment(job, OPENSHELL_BIND_LINGERING.comment);
			return { outcome: "policy", reason: OPENSHELL_BIND_LINGERING.reason, exitCode: code, turns, tokens, usage: usage ?? null, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...(resources ? { resources } : {}), ...(progress ? { progress } : {}) };
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
				// A run that asked a person a question and ended (issue #625, REQ-AWAIT-INPUT) is still a completed run: it is
				// promoted like any other, with the key marked parked, and the one fixed comment says how it continues.
				// exitReason is RUNNER_COMPLETED_REASONS-filtered and read only here, on code 0, so it cannot move a job
				// between retry classes. Only a job armed with run.awaitInput may park: a line that says so on any other
				// job is ignored, since that runner was never offered the tool.
				const parked = exitReason === "awaiting-input" && job.awaitInput === true;
				const promoted = prepared.session ? promoteSession(prepared.session, { piVersion, context, parked }) : null;
				// THE PARK SEQUENCE (issue #638 reordered it): promote, marker ON, release the window, take the held replies,
				// then the comment. Every step closes a gap the one before it leaves open:
				//   - the marker AFTER the promotion (a reply it routes must find the `parked` mark and the transcript) and
				//     BEFORE the release: a phrase-free reply in between routes as a parked reply, meets the window this run
				//     still holds, and is HELD (the keeper still registers the run), so no reply slips past both;
				//   - the release before the take, so the taken reply is enqueued WITH the window (held-settle.mjs) and becomes
				//     the one job every later answer is coalesced against, never a second resumed run beside it;
				//   - the comment LAST, because it invites an answer: with a reply taken it says the run continues
				//     (HELD_TAKEN_COMMENT) instead of asking for one.
				// The marker stays on when a reply was taken; the resumed run clears it when it ends without parking, as any
				// run on the key does. Every park takes this path, a resumed run that parks again included. Each seam never
				// throws and is guarded anyway: a fault must not cost the person the comment that says how to continue. The
				// marker: set on a park, cleared when a run on a key that could park ends without parking; it decides nothing,
				// the sidecar the promotion just wrote does.
				if (parked) await parkedLabel(job, true);
				else if (job.awaitInput === true || job.parkedReply === true) await parkedLabel(job, false);
				if (parked) await Promise.resolve().then(releaseParkedWindow).catch(() => {});
				const taken = parked ? await Promise.resolve().then(takeHeldReplies).catch(() => null) : null;
				// `taken` "other": a reply that got in between the release and the take already is the resumed job, so the
				// comment says the run continues there too, never "Reply here" (review round 2).
				if (parked) await comment(job, taken?.taken === "here" || taken?.taken === "other" || Number(taken?.resumed) > 0 ? HELD_TAKEN_COMMENT : parkedComment(job.target));
				return {
					outcome: "completed",
					...(parked ? { reason: "awaiting-input" } : {}),
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
					...(progress ? { progress } : {}),
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
				return { outcome: "policy", reason, exitCode: code, turns, tokens, usage: usage ?? null, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), budgetReserved: true, ...(dollars ? { dollars } : {}), ...why, ...(resources ? { resources } : {}), ...(progress ? { progress } : {}) };
			}
			case EXIT_INFRA:
				// NO comment on any infra throw, here or in the catch: an InfraRetry may be retried and
				// recover, and a flaky daemon must not post three comments for one recovery. Once-ness for
				// the whole infra class lives at the terminal seam -- start.mjs's failed listener, guarded on
				// BullMQ's own finishedOn -- which also catches the stall-kill and wait-gate paths this
				// function never sees (issue #288).
				return await recoverOrThrow(new InfraRetry(`infra failure, container exit ${code}`, { exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), dollars, resources }));
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
				return await recoverOrThrow(new InfraRetry(`unknown container exit ${code}`, { exitCode: code, turns, tokens, usage, provider: job.provider ?? null, model: job.model ?? null, session: mergeSession(prepared, session), dollars, resources }));
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
				// Issue #645: a RECORDED hold is given back only by the call that moves it `held` -> `released` in the run's
				// ledger; any other answer means someone else finished it or the ledger cannot say, and giving it back again
				// could refund money twice, so it stays at the floor. An unrecorded hold (its record failed) is given back
				// directly, as every hold was before: no one else can see it.
				const releasable = !holdRecorded || (await runBudgetLedger.release(runId, durable.seq)) === "moved";
				if (!releasable) log("run_budget_release_skipped", { seq: durable.seq });
				const { applied, of } = releasable ? await releaseDollars(redis, hold, { log }) : { applied: 0, of: 1 };
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
		// Issue #644: the same for the run's progress, so a retried or failed attempt's record says where it got to.
		if (progress !== null && e !== null && typeof e === "object" && e.progress === undefined) {
			try {
				e.progress = progress;
			} catch {
				// a frozen error keeps its own fields; progress is display only
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
			await comment(job, REFUSAL_COMMENTS["config-refused"]).catch(() => {});
			log("refused_config", { kind: job.kind ?? null, refunded });
			// budgetReserved reflects the LEDGER: whether the GLOBAL slot is still held after the refund (`globalHeld`).
			return { outcome: "policy", reason: "config-refused", exitCode: null, turns: null, tokens: null, provider: job.provider ?? null, model: job.model ?? null, budgetReserved: globalHeld(), ...(dollars ? { dollars } : {}) }; // return => not retried
		}

		// A spawn fault (docker daemon down / binary missing) reserved a slot but never started a
		// container, so nothing was spent -- give the slot back before the retry. Every other throw
		// here (exit-1 infra, unknown exit) means the container ran and legitimately spent its slot,
		// so `reason` gates the release to the never-started case only. It releases only what `held` still
		// lists and run once per invocation; a BullMQ retry reserves afresh, so this cannot double-release.
		if (isNeverStartedRetry(e) && !slotOwnedByRun) {
			// All-or-none (issues #242 and #499 part B): a never-started container follows EVERY job-count reserve, so
			// every held ledger refunds together, last first, through the one helper -- and a scoped or project refusal
			// returned above with the ledgers before it already given back.
			// NOT for an armed run's slot (issue #645, `slotOwnedByRun`): the run's ledger says the slot is held, so the
			// retry carries it instead of reserving; refunding it here would let that retry run on a slot nothing counts.
			// The cost: a run whose every attempt never started keeps one slot counted, the safe side.
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
	// Issue #643: a job that is not a resume job now runs on a live transcript file (`prepared.live`), which the runner
	// opens empty and reports as `absent`. That is a fact about the live file, not about resuming, and this object
	// describes resuming: such a job's record says `disabled`, exactly what the runner said for it before the live file
	// existed, so its record is byte-identical to one written before the feature. Narrow on purpose, the live file and
	// the runner's token exactly `absent`: any other report is carried as it always was, and resume jobs (`host`
	// present) never reach this line.
	if (!host && prepared?.live && fromRunner?.resumed === false && fromRunner.reason === "absent") return { resumed: false, reason: "disabled", bytes: null };
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
 * The bundle resolver's failures (issue #704, secret-bundles.mjs), our words, the `SECRET_FAILURES` rule: an unknown
 * code degrades to the caller's generic sentence. None names a variable or a value: this text is posted publicly.
 */
const BUNDLE_FAILURES = {
	exit: "refused the bundle's reference",
	empty: "printed no variable",
	overflow: "printed more than the bundle size cap allows",
	nul: "printed output containing a NUL byte",
	malformed: "printed output that is not in the format its profile declares",
	quoted: "printed a quoted dotenv value, and the dotenv grammar takes no quotes (declare the profile as json instead)",
	"not-string": "printed a JSON value that is not a string",
	"bad-name": "printed a name that is not an environment variable name",
	duplicate: "printed one variable twice",
	"empty-value": "printed a variable with an empty value",
	"value-too-large": "printed a value larger than one secret may be",
	"too-many": "printed more variables than one bundle may carry",
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

/**
 * A recovery job held while the run it continues still has a container running on this host (issue #645). An
 * `InfraRetry` with `container-never-started`, so any path that does not know it still retries and refunds nothing it did
 * not take; `makeProcessor` knows it by `recoveryWaitMs`, and moves the job to the delayed set for that long without
 * spending an attempt (a recovery job has one), the move the two holds above make.
 */
/**
 * A job whose project's secret bundle names a profile this host does not serve, on a multi-host worker's SHARED queue
 * (issue #704 review). An `InfraRetry`, so any path that does not know it still retries; `makeProcessor` knows it by
 * `bundleProfileHold`, and moves the job to the delayed set for the never-fits gate's recheck without spending an
 * attempt, so a host that declares the profile can take it.
 */
export class SecretBundleProfileHold extends InfraRetry {
	constructor(message, options) {
		super(message, options);
		this.name = "SecretBundleProfileHold";
		this.bundleProfileHold = true;
	}
}

/**
 * The HTTP status of a failed pull-request head read, or null: octokit's `status`, else the `returned <code>` the
 * fetch-based forge hosts put in their InfraRetry message (status only, never the body). Read only to tell a
 * determinate 401/403/404 from a fault worth retrying.
 */
function headReadStatus(error) {
	if (Number.isInteger(error?.status)) return error.status;
	const m = /\breturned (\d{3})\b/.exec(String(error?.message ?? ""));
	return m ? Number(m[1]) : null;
}

/**
 * Whether a failed head read is a RATE LIMIT (issue #704 review round 2): octokit's error carries the response headers,
 * and GitHub's primary limit answers 403 with `x-ratelimit-remaining: 0`, its secondary limit 403 or 429 with a
 * `retry-after`. A header is read by name only, never echoed. The fetch-based hosts surface no headers, and their
 * 429 is already outside the determinate set.
 */
function headReadRateLimited(error) {
	const headers = error?.response?.headers;
	if (headers === null || typeof headers !== "object") return false;
	const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name]);
	const remaining = get("x-ratelimit-remaining");
	return String(remaining ?? "") === "0" || (get("retry-after") !== undefined && get("retry-after") !== null);
}

export class RecoveryWaitHold extends InfraRetry {
	constructor(message, { waitMs = RECOVERY_WAIT_MS, ...options } = {}) {
		super(message, options);
		this.name = "RecoveryWaitHold";
		this.recoveryWaitMs = waitMs;
	}
}

export { EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY };
