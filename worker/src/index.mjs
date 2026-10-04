import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import { assertJudgedConnection, onValkeyError } from "./connection.mjs";
import { jobContainerName } from "./backend-local.mjs";
import { scrubCredentials } from "./redact.mjs";
import { BACKEND_NOT_REGISTERED } from "./backend-registry.mjs";
import { CANCEL_ACK_TTL_MS, cancelAckKey, cancelReqKey } from "./cancel-state.mjs";
import { InfraRetry, NETNS_KEEPER_CRASH_LOOP, NETNS_KEEPER_NOT_HOLDING, TERMINAL_COMMENTS, runJob } from "./processor.mjs";
import { NETNS_KEEPER_YOUNG_HOLD_MAX_MS, netnsKeeperCrashLoopSentence, netnsKeeperLoopAgainSentence } from "./netns-keeper.mjs";
import { PODMAN_RESTART_HOLD_EXPIRED, PODMAN_RESTART_HOLD_MAX_MS, PODMAN_RESTART_HOLD_RECHECK_MS } from "./runtime-observations.mjs";
import { targetFor } from "./run-history.mjs";
import { isPerMachineHost } from "./backends.mjs";
import { hash16 } from "./fleet-lease.mjs";
import { endpointsForModel } from "./model-endpoints.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { effectiveCostCapMicros } from "./money.mjs";
import { dollarWindowCaps } from "./dollar-budget.mjs";
import { concurrencyFor, dollarCapsFor, makeInFlight, modelDollarRows, projectDollarCapsFor, projectRowFor, rowScopeFor, scopedLedgers } from "./scoped-limits.mjs";
import { memberScopeOf, projectOf } from "./projects.mjs";
import { governedDollars } from "./allocation.mjs";
import { WAIT_AFTER_MAX_DEFAULT_MS, WAIT_INTERVAL_FLOOR_MS, afterMs, unreadableConditions, waitArmed, waitBackoffMs, waitLabel, waitProfileNames } from "./wait-for.mjs";
import { makeWaitState } from "./wait-state.mjs";


export const QUEUE = "pi-jobs";

/** The key the host-wide in-flight count lives under. One machine, one counter, whatever the queue. */
export const HOST_SLOT_KEY = "host";
export const JOB_TIMEOUT_MS = 30 * 60 * 1000; // REQ-JOB-TIMEOUT-30M

/**
 * The failed reason BullMQ gives a job its stall check failed (`maxStalledCount: 0` below): the literal in the pinned
 * bullmq's `moveStalledJobsToWait`, stored as the job's deferred failure and thrown as an UnrecoverableError at the
 * next pickup. Matched EXACTLY by start.mjs's failed listener, and pinned against the installed bullmq source by a
 * test, so a bullmq bump that rewords it fails that test rather than silently turning the lost-lock check off.
 */
export const STALLED_FAILED_REASON = "job stalled more than allowable limit";

/** How many (job, stall count, attempt, source) keys the processor remembers having logged a refused record for. */
export const REJECTED_SEEN_MAX = 1000;
// The scope-busy re-check (issue #242): a held scope has no natural "until" (the holder may run to
// JOB_TIMEOUT_MS), so a deferred job re-tests on a fixed cadence. 5s keeps the worst case trivial
// (<=360 wakes across a 30-minute hold, each ~1ms of synchronous predicate briefly occupying a slot)
// while a same-folder CHAINED job -- enqueued by its parent before the parent's finally releases the
// folder -- pays exactly one re-check, not fifteen seconds of dead air. No jitter: one worker per
// docker daemon bounds any herd by its own concurrency, and a contended wake just re-defers.
export const SCOPE_BUSY_RECHECK_MS = 5_000;

// The endpoint-busy re-check (issue #503): a job whose model server has every slot held re-tests on a fixed
// cadence, for the scope re-check's reason (a held slot has no natural "until"). Its own value rather than a
// borrow of 5s, because nothing records WHY a job sits in the delayed set and the wake instant is the only
// evidence an operator has: 7s is distinct from the scope re-check, the wait throttle floor and the supersede
// re-ask, and a test keeps all four apart. Short, because a local model run is often short too.
export const ENDPOINT_BUSY_RECHECK_MS = 7_000;

// How long a job waits before re-asking whether a target's holder is still alive (issue #230). Reached only
// when the liveness probe could not answer, which is a redis or queue fault rather than a normal state, so
// this is a short retry rather than a cadence: the job is deciding nothing and holding nothing while it
// waits, and the fault it is waiting out is usually seconds long.
export const SUPERSEDE_RECHECK_MS = 15_000;

// The one key the check lease counts under. A single global counter rather than one per profile: what it
// bounds is this worker's wall-clock spent answering questions, and that is shared whatever is being asked.
const WAIT_CHECK_KEY = "wait-check";

// How many consecutive lease denials one job absorbs before the deployment is told its checking capacity is
// short. Logged ONCE per run of denials rather than per wake: an alarm that repeats every re-check is the
// always-on amber this project rejects elsewhere, and the operator only needs telling once per episode.
const THROTTLE_ALARM = 5;

// The floor under a throttled or aborted re-ask. Its own constant rather than a borrow of
// SUPERSEDE_RECHECK_MS, which documents an unrelated concern. Deliberately NOT 5s: that is
// SCOPE_BUSY_RECHECK_MS, and INT-WAIT-PROFILES-CONTRACT rests on wait deferrals being distinguishable from
// scope deferrals by wake instant -- nothing records WHY a job sits in the delayed set, so the instants are
// the only evidence there is. A test pins the two apart.
const THROTTLE_FLOOR_MS = 11_000;

/**
 * How long a container gets to actually die after the abort's `docker stop` before the worker stops waiting.
 *
 * `docker stop -t 5` is SIGTERM then an unignorable SIGKILL five seconds later, so a reachable daemon ends
 * the container well inside this. The margin is for the daemon being slow, not for the container being
 * stubborn -- a container cannot outlive SIGKILL.
 */
const ABORT_GRACE_MS = 30_000;

/**
 * Resolve `run` normally, but stop waiting once the abort has fired and the grace has passed.
 *
 * See the call site for why this exists. Returns the same `{ code: 137, aborted: true }` shape a killed
 * container produces, so nothing downstream needs to know the difference -- the processor's abort
 * classification, the run record and the refund all behave exactly as they do for a stop that worked.
 */
function boundAfterAbort(run, signal, job, log, graceMs = ABORT_GRACE_MS) {
	if (!signal) return run;
	return new Promise((resolve, reject) => {
		let timer = null;
		let settled = false;
		const done = (fn) => (v) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(v);
		};
		const onAbort = () => {
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				log("stop_did_not_take", { job: job.id, graceMs });
				resolve({ code: 137, aborted: true, turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null });
			}, graceMs);
			// A boot-blocking handle is not wanted here: the worker should be able to exit if everything else
			// has finished, and this timer only matters while a job is still in flight.
			timer.unref?.();
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		run.then(done(resolve), done(reject));
	});
}

/**
 * Build the BullMQ processor.
 *
 * It MUST declare exactly three parameters (job, token, signal). BullMQ only allocates an
 * AbortController when `processor.length >= 3` (it inspects the function's arity at construction),
 * so dropping the unused `token` would silently disable BOTH the 30-minute timeout and the shutdown
 * abort -- with no error. A test asserts the arity precisely because the failure is silent.
 *
 * Dependencies are injected so this is testable without a live queue: `cancelJob` (fired by the
 * timeout), `stopContainer` (fired by the abort, and INJECTED so the venue that built the container is
 * the one that stops it), and the orchestration deps.
 *
 * Once per job, before runJob, it resolves the runtime-settings overlay via `getSettings`
 * (INT-CONFIG-OVERLAY-CONTRACT). A present-but-invalid overlay resolves to a POLICY refusal RETURNED
 * (never thrown), so BullMQ marks the job completed without a retry (CONST-RETRY-INFRA-ONLY). A valid
 * overlay fills the effective `provider`/`model`/`maxTurns`/`dailyCap`/`weeklyCap`/`monthlyCap`/`softHoldPct`
 * under `job.data > overlay > env` precedence and re-binds the worker slot count via `applyConcurrency`.
 * The overlay changes which values the spend caps take, never when they are checked -- reserveBudget still
 * runs inside runJob against the freshly passed caps (CONST-BUDGET-BEFORE-TOKENS).
 *
 * The read happens once per pickup, right after the scope gate and before the model endpoint gate (issue #503),
 * because that gate needs the effective provider and model, which the overlay can supply.
 */
/**
 * A job's endpoint set (issues #503, #502): the endpoints its main model AND every model on its effective allowed
 * list are served by, so a job that may switch to a listed model on another local server holds that server's slot
 * too. The caller deduplicates by endpoint id. With no list it is the main model's alone, and the residual stays
 * as #503 named it: an unrestricted job's mid-run switch to an undeclared model takes no slot. The keyless verdict
 * is a different question ("every model of the provider", `keylessVerdict`) and does not read this set.
 *
 * `models` here is the parsed overlay models.json (the endpoint module's name for it); the list is `job.models`.
 */
export function mainModelEndpoints({ models, job, endpoints }) {
	const set = endpointsForModel({ models, provider: job.provider, modelId: job.model, endpoints });
	for (const entry of Array.isArray(job.models) ? job.models : []) {
		const ref = splitModelEntry(entry);
		if (ref !== null) set.push(...endpointsForModel({ models, provider: ref.provider, modelId: ref.model, endpoints }));
	}
	return set;
}

/**
 * The job runJob is handed: `job.data > overlay > env` precedence, field by field (INT-CONFIG-OVERLAY-CONTRACT).
 * ONE function for the two readers (the endpoint gate at pickup and the runJob call), so the gate can never lease
 * for a model other than the one the container is started with.
 */
export function effectiveJobOf(data, settings, allowedModels = null, log = () => {}) {
	// Issue #502: the allowed-model list is the trigger's, else the deployment's PI_ALLOWED_MODELS, else none. The
	// env list arrives as its own argument and never through `settings`, which the overlay (and so `dispatch_set`)
	// writes. Absent stays absent, so an unrestricted job's effective job has no `models` key at all.
	const models = data.models ?? allowedModels ?? null;
	return {
		...data,
		provider: data.provider ?? settings.provider,
		model: data.model ?? settings.model,
		maxTurns: data.maxTurns ?? settings.maxTurns,
		maxTokens: data.maxTokens ?? settings.maxTokens, // optional per-job token budget (issue #25); null => runner meter only
		...(models !== null ? { models } : {}),
		// Issue #501: the per-job dollar cap in integer micro-dollars, or null for none. NOT `??` like the fields
		// above: a trigger's `run.maxCostUsd` may only NARROW, so this is the smaller of the trigger's and the
		// deployment's, each counted only when set (`effectiveCostCapMicros` says why a trigger-only cap applies
		// and what a malformed job value reads as). buildContainerEnv sends it as PI_MAX_COST_MICROS, and the
		// image preflight requires `costCap` of any job that carries one.
		// A malformed queued value is logged by KEY only (`job_cost_cap_malformed`), never by value.
		maxCostMicros: effectiveCostCapMicros(data.maxCostUsd, settings.maxCostUsd, (key) => log("job_cost_cap_malformed", { key })),
	};
}

export function makeProcessor({ cancelJob, stopContainer, containerName = (job) => jobContainerName(job.id), redis, getSettings, applyConcurrency = () => {}, pauseUntil = () => null, scopedLimits = () => [], projects = () => [], allocation = null, inFlight = makeInFlight(), hostBound = null, checkLease = null, scopeLease = null, endpointSlots = makeInFlight(), endpointLease = null, modelEndpoints = null, overlayModels = () => null, endpointSetFor = mainModelEndpoints, deps, recordRun = () => {}, settledRecord = null, timeoutMs = JOB_TIMEOUT_MS, cancelPollMs = 2_000, cancelStopBoundMs = CANCEL_STOP_BOUND_MS, hostName = "", now = () => Date.now(), waitState = makeWaitState({ redis, now }), afterMaxMs = () => WAIT_AFTER_MAX_DEFAULT_MS, checkSlots = makeInFlight(), checkSlotCount = () => 1, checkTimeoutMs = () => 10_000, concurrencyNow = () => 3, intervalMs = () => WAIT_INTERVAL_FLOOR_MS * 2, maxWaitMs = () => 24 * 3600 * 1000, maxChecks = () => 96, maxFaults = () => 5, random = Math.random }) {
	// The lost-lock gate's rejection lines, said ONCE per job id, stall count and attempt. The gate runs before every
	// deferral (pause window, wait, scope or endpoint busy), and BullMQ never resets a job's stall count, so a stalled
	// scheduled job whose record is refused meets the gate again on every deferred pickup: a 30-minute scope-busy hold
	// is about 360 of them. The verdict cannot change between them (same record, same attempt), so one line says it.
	// Bounded, oldest out first, so a long-lived worker holds at most REJECTED_SEEN_MAX keys.
	const rejectedSeen = new Set();
	const firstRejection = (key) => {
		if (rejectedSeen.has(key)) return false;
		rejectedSeen.add(key);
		if (rejectedSeen.size > REJECTED_SEEN_MAX) rejectedSeen.delete(rejectedSeen.values().next().value);
		return true;
	};
	return async function processor(job, token, signal) {
		// THE LOST-LOCK GATE, first because it is free and because it can only ever stop a run (CONST-RETRY-INFRA-ONLY).
		// BullMQ hands a job to the processor again after its stall check took it back. That happens to a job whose
		// processor FINISHED when Valkey was unreachable for longer than the lock renewal window: the record was
		// written, the completion was refused ("Missing lock"), and the job stayed active without a lock. A plain job
		// then carries a deferred failure and never reaches here (start.mjs's failed listener handles it), but a
		// scheduled job is moved back to wait and would run again, PAID, with its second record overwriting the
		// first. So a job that has stalled (`stalledCounter > 0`) and whose record says this same attempt finished
		// without failing ends as that record says, without a container. `budgetReserved` is the record's own: the
		// completed listener then pages exactly when it would have for the first finish, which never reached it.
		// No record (a worker that died mid-run, a lookup fault) keeps today's path: the job runs, and the stall
		// guard bounds how often.
		if (Number(job.stalledCounter) > 0 && typeof settledRecord === "function") {
			const attempt = (Number.isInteger(job.attemptsMade) && job.attemptsMade >= 0 ? job.attemptsMade : 0) + 1;
			// A record found and refused is said, with its fixed reason, because the job then RUNS again (paid).
			const onReject = (reason, source) => {
				if (firstRejection(`${job.id}\u0000${job.stalledCounter}\u0000${attempt}\u0000${source}`)) deps?.log?.("job_lost_lock_record_rejected", { jobId: job.id, reason, source });
			};
			const record = await settledRecord(job.id, { attempt, since: job.timestamp, onReject });
			if (record) {
				deps?.log?.("job_lost_lock_after_completion", { jobId: job.id, outcome: record.outcome, ...(record.reason ? { reason: record.reason } : {}) });
				return { outcome: record.outcome, reason: record.reason ?? null, exitCode: record.exitCode ?? null, turns: record.turns ?? null, tokens: record.tokens ?? null, budgetReserved: record.budgetReserved ?? null };
			}
		}

		// Scoped pause windows (REQ-SCOPED-PAUSE-WINDOWS): if this job's folder/repo is inside an active pause
		// window, DEFER it to the window end via BullMQ's delayed set -- the job keeps its identity/dedup and
		// auto-resumes when re-picked. This is FIRST, before the kill timer, the settings read, and the budget
		// reservation, so a deferred job arms no timer, reserves no slot, and spends nothing
		// (CONST-BUDGET-BEFORE-TOKENS). `moveToDelayed` needs the worker's `token`; the `> now + 1s` guard keeps
		// a boundary tick from busy-deferring. A thrown `DelayedError` is how BullMQ learns the job was deferred
		// (worker.js recognises it) rather than completed or failed.
		// One clock snapshot for both the window lookup and the guard, so they cannot disagree across the
		// call (and a test can inject a fixed clock). `now` defaults to the real wall clock in production.
		const nowMs = now();
		const until = pauseUntil(job.data, nowMs);
		if (until && until > nowMs + 1000) {
			await job.moveToDelayed(until, token);
			throw new DelayedError();
		}

		// The wait gate (issue #230, REQ-WAIT-FOR). THIRD: after the pause gate, because a paused job must
		// not burn a wait evaluation any more than it burns a scope re-check, and BEFORE the scope acquire,
		// because a job that is going to sit until tomorrow morning must not hold the folder mutex while it
		// does. Strictly above the `try` for the two reasons the gates below it document.
		//
		// The order WITHIN the gate is determinate-refusals-then-holds, which is CONST-BUDGET-BEFORE-TOKENS'
		// shape applied to time rather than to money: a condition this deployment can never answer must be
		// refused now, not after a day of waiting.
		//
		// On throwing above the `try`: an exception here escapes into BullMQ's normal failed-attempt handling,
		// which is WANTED for `moveToDelayed` (the scope gate below gives the argument: a transient rejection
		// must stay a transient failure rather than becoming a permanent one) and unwanted everywhere else. So
		// the state and comment seams fail open by construction, and `recordRun` is relied on not to throw --
		// its writer swallows fs errors by contract, which is the same reliance the settings-overlay refusal
		// below already makes.
		if (waitArmed(job.data)) {
			// The supersede identity: the queue's semantic key PLUS the trigger that produced this job.
			// The semantic key alone is `repo<sep>number:flow`, which two DIFFERENT triggers on one target and
			// flow legitimately share -- a label rule that waits a day and a comment rule that waits a minute
			// would coalesce, and the second would be refused with a message claiming they wait on "the same
			// conditions" when they do not. Adding the raw trigger index makes the key mean one intent.
			const matchedIndex = job.data?.trigger?.matched?.index;
			const dedupId = job.deduplicationId ? `${job.deduplicationId}#${Number.isInteger(matchedIndex) ? matchedIndex : "?"}` : null;
			const refuseWait = async (reason, logEvent, fields, sentence) => {
				// The INJECTED clock, like both gates above: a record whose timestamps ignore the test clock
				// is a record no test of this gate can assert about.
				const at = new Date(now()).toISOString();
				await waitState.release(job.id, { dedupId });
				deps?.log?.(logEvent, { jobId: job.id, ...fields });
				// The comment names the FIELD and the operator's own words for the condition, never a
				// resolver path or a vault topology -- `secret-profile-unknown` sets that rule.
				if (sentence && deps?.comment) await Promise.resolve(deps.comment(job.data, sentence)).catch(() => {});
				const result = { outcome: "policy", reason, exitCode: null, turns: null, tokens: null, budgetReserved: false };
				recordRun({ job, result, startedAt: at, endedAt: new Date().toISOString() });
				return result;
			};

			// EVERY condition must be one this worker understands, checked before anything else. The loader
			// refuses an unknown condition, but the loader is a DIFFERENT PROCESS: `job.data.waitFor` arrives
			// over Redis from the receiver, and this whole feature exists because receiver-worker version
			// skew is real. `makeCheckWaitSkew` closes the backward direction (the file has conditions the
			// job arrived without); this closes the forward one (a newer receiver enqueues a condition shape
			// this worker cannot read). Without it the gate would fall through, log `wait_cleared`, and run
			// the job -- asserting in the log that conditions cleared which it never evaluated, which is the
			// same undetectable paid run the backward check exists to stop.
			// A sibling that was held on this same target may already have cleared it. Checked FIRST, because
			// it is free and determinate, and because the window it closes is one no lease can: two jobs
			// holding through an outage that outlives their leases would each wake, find no holder, and run.
			if (dedupId) {
				const satisfiedBy = await waitState.satisfiedBy(dedupId);
				if (satisfiedBy && satisfiedBy !== job.id) {
					return await refuseWait("wait-superseded", "wait_superseded", { satisfiedBy }, "Another delivery for this target already finished waiting on the same conditions. Not run.");
				}
			}

			const unreadable = unreadableConditions(job.data);
			if (unreadable.length > 0) {
				// Its OWN token, not `wait-skew`. Both are version skew, and the REMEDIES are opposites --
				// upgrade the receiver there, upgrade the worker here -- so one token in a durable record
				// would tell an operator that something is out of step and not which way to move.
				return await refuseWait("wait-unreadable", "refused_wait_unreadable", { conditions: unreadable.length }, `Refused: this job carries ${unreadable.length} wait condition${unreadable.length === 1 ? "" : "s"} this worker cannot read, so it cannot honour them. The worker is older than the service that enqueued this job. Not run.`);
			}

			// A `profile` condition needs a checker, and with none wired NOTHING can answer it. Refused rather
			// than ignored: a wait the deployment cannot perform must not read as a wait that passed.
			const profiles = waitProfileNames(job.data);
			// Declared-ness is a table lookup, so it belongs with the other free refusals rather than inside
			// the check. Without it here, `[{after: "<tomorrow>"}, {profile: "typo"}]` holds for a day and
			// THEN refuses -- which is the exact sentence the ordering rule above promises will not happen.
			const undeclared = deps?.waitProfileDeclared ? profiles.find((name) => !deps.waitProfileDeclared(name)) : undefined;
			if (undeclared !== undefined) {
				return await refuseWait("wait-profile-unknown", "wait_profile_unknown", { profile: undeclared }, `Waiting on \`${undeclared}\` is not something this deployment can answer: no such wait profile is declared here. Not run.`);
			}
			if (profiles.length > 0 && !deps?.checkWait) {
				return await refuseWait("wait-profile-unknown", "wait_profile_unknown", { profile: profiles[0] }, `Waiting on \`${profiles[0]}\` is not something this deployment can answer. Not run.`);
			}

			const holdUntil = afterMs(job.data); // named apart from the pause gate's `until` above, which it would otherwise shadow
			// An instant further out than the ceiling is refused at FIRST pickup rather than held toward:
			// holding for a month to then refuse tells the operator nothing they could not have been told now.
			if (holdUntil !== null && holdUntil - nowMs > afterMaxMs()) {
				return await refuseWait("wait-after-beyond-max", "wait_after_beyond_max", { delayMs: holdUntil - nowMs }, `The \`after\` instant is further out than this deployment allows a job to wait. Not run.`);
			}

			// The pause gate's boundary guard, for its reason: a tick landing on the instant must run rather
			// than busy-defer to a moment already past.
			if (holdUntil !== null && holdUntil > nowMs + 1000) {
				// `isJobLive` is what stops a vanished holder's lease becoming a tombstone that refuses this
				// target for the rest of the hold. Optional: an unwired probe means the holder cannot be
				// checked, which ADMITS and says so -- one duplicate run beats one dropped delivery, which is
				// `OQ-027`'s call ("one wasted vault read beats one dropped job") on this feature's terms.
				const claim = await waitState.claim(job.id, { dedupId, untilMs: holdUntil, isLive: deps?.isJobLive });
				if (claim.heldBy) {
					// Another delivery for this same target and flow is already holding. Both would clear
					// together and both would be paid, which is the accumulation the acceptance forbids.
					return await refuseWait("wait-superseded", "wait_superseded", { heldBy: claim.heldBy }, "Another delivery for this target is already waiting on the same conditions. Not run.");
				}
				if (claim.retry) {
					// The holder could not be checked. Holding anyway would put two jobs on one target and pay
					// for both; refusing would drop a delivery over a holder that may be gone. So decide
					// nothing: re-defer briefly and ask again once the probe can answer.
					deps?.log?.("wait_supersede_unverified", { jobId: job.id, heldBy: claim.holder ?? null, delayMs: SUPERSEDE_RECHECK_MS });
					await job.moveToDelayed(nowMs + SUPERSEDE_RECHECK_MS, token);
					throw new DelayedError();
				}
				if (claim.tookOverFrom) deps?.log?.("wait_lease_taken_over", { jobId: job.id, from: claim.tookOverFrom });
				await waitState.hold(job.id, { dedupId, target: targetFor(job.data?.kind, job.data), label: waitLabel(job.data), untilMs: holdUntil });
				deps?.log?.("wait_deferred", { jobId: job.id, until: new Date(holdUntil).toISOString(), label: waitLabel(job.data) });
				await job.moveToDelayed(holdUntil, token);
				throw new DelayedError();
			}

			// TIER 2: the polled conditions. Last, because it is the only part of this gate that spawns a
			// process -- the free refusals above it are free, and the free hold above it is free.
			if (profiles.length > 0) {
				const held = (await waitState.heldForMs(job.id)) ?? 0;
				const counted = await waitState.counters(job.id);

				// One check at a time, process-wide, and never the worker's last free slot. This is the bound
				// that keeps a wait from starving the paid work it is waiting for: slots x timeout is the most
				// wall-clock a worker can spend answering questions instead of running jobs. Computed against
				// the LIVE concurrency rather than the boot value, because the overlay can lower it.
				const slots = Math.min(checkSlotCount(), Math.max(1, concurrencyNow() - 1));
				if (!checkSlots.tryAcquire(WAIT_CHECK_KEY, slots)) {
					// Denials are counted, and a run of them is the ONE symptom the capacity bound has. The
					// lease deliberately caps how much wall-clock this worker spends checking; being at that
					// cap constantly means demand exceeds it, which the issue's own economics say arrives
					// silently -- paid jobs starve behind checks that spend nothing and nothing says why.
					const denials = await waitState.noteThrottle(job.id, { denied: true });
					if (denials === THROTTLE_ALARM) deps?.log?.("wait_capacity_exceeded", { jobId: job.id, denials, slots, hint: "raise PI_WAIT_CHECK_SLOTS or PI_CONCURRENCY, lengthen PI_WAIT_INTERVAL_MS, or hold fewer jobs" });
					// A starved job still needs a CLOCK and a CEILING, or the lease turns into the very
					// starvation it exists to bound: without this the hold is stamped only on a wake that won
					// the lease, so a job that never wins one has no `since`, never reaches the maximum, and
					// re-wakes forever with no record and no bound. There is no deciding check to run first
					// here -- that is the whole condition -- so the bound applies directly.
					await waitState.hold(job.id, { dedupId, target: targetFor(job.data?.kind, job.data), label: waitLabel(job.data), untilMs: nowMs + maxWaitMs() });
					if (held >= maxWaitMs()) {
						return await refuseWait("wait-expired", "wait_expired", { reason: "max-wait-unchecked", denials, heldForMs: held }, `Gave up waiting: this deployment could not run the check often enough to answer within the maximum wait. Not run.`);
					}
					// Denied. Re-ask at a fraction of the cadence rather than the full backoff (which would
					// turn one lost coin-flip into a fifteen-minute penalty) or a flat few seconds (which at
					// scale is a herd). Jittered, so a fleet of denied jobs does not return together.
					const wait = Math.max(THROTTLE_FLOOR_MS, Math.floor(waitBackoffMs(intervalMs(), held) / 4));
					const delay = wait + Math.floor(wait * 0.1 * random());
					deps?.log?.("wait_check_throttled", { jobId: job.id, delayMs: delay, slots });
					await job.moveToDelayed(nowMs + delay, token);
					throw new DelayedError();
				}

				// Declared outside the try below because the branches AFTER it read both.
				let verdict = null;
				let checked = null;
				// A SECOND LAYER BENEATH THE FIRST, never a replacement (issue #57). The in-process map above
				// stays exactly as it was and remains the correct per-host duty-cycle bound -- slots x timeout
				// is the most wall-clock THIS worker spends answering questions instead of running jobs. What it
				// cannot bound is the fleet: a held job's wakes land on any host, so `PI_WAIT_CHECK_SLOTS`
				// silently multiplied by host count, and the one symptom the bound has gets QUIETER as you
				// scale out, because multiplication produces fewer denials per host.
				//
				// Null when no peer could exist, so a single-host deployment issues no command at all.
				let fleetSlot = null;
				if (checkLease) {
					// The TTL is DERIVED from what the lease actually guards: the gate holds it across every profile
					// in turn, each bounded by `PI_WAIT_CHECK_TIMEOUT_MS`, so it is one timeout per PROFILE plus one
					// for the overhead between them. Deriving it from the SLOT COUNT instead -- an unrelated
					// quantity -- made a three-profile job at the shipped defaults hold 30s against a 20s lease,
					// so the slot expired mid-check and another host took it while this one was still using it.
					fleetSlot = await checkLease.acquire(job.id, { slots: checkSlotCount(), ttlMs: (profiles.length + 1) * checkTimeoutMs() });
					if (!fleetSlot) {
						// The same outcome as a local denial and the same remedy, so the same cadence and the same
						// event -- with one conditional field, which is what keeps an unarmed deployment's log line
						// byte-identical.
						checkSlots.release(WAIT_CHECK_KEY);
						const denials = await waitState.noteThrottle(job.id, { denied: true });
						if (denials === THROTTLE_ALARM) deps?.log?.("wait_capacity_exceeded", { jobId: job.id, denials, slots: checkSlotCount(), where: "fleet", hint: "raise PI_WAIT_CHECK_SLOTS or PI_CONCURRENCY, lengthen PI_WAIT_INTERVAL_MS, or hold fewer jobs" });
						await waitState.hold(job.id, { dedupId, target: targetFor(job.data?.kind, job.data), label: waitLabel(job.data), untilMs: nowMs + maxWaitMs() });
						const wait = Math.max(THROTTLE_FLOOR_MS, Math.floor(waitBackoffMs(intervalMs(), held) / 4));
						const delay = wait + Math.floor(wait * 0.1 * random());
						deps?.log?.("wait_check_throttled", { jobId: job.id, delayMs: delay, slots: checkSlotCount(), where: "fleet" });
						await job.moveToDelayed(nowMs + delay, token);
						throw new DelayedError();
					}
				}
				// THE LEASE IS HELD FROM THE `tryAcquire` ABOVE, so every exit from here down must release it.
				// The try opens here and not at the check loop, which is where it used to open: the supersede
				// claim sits between the two, and BOTH of its exits leave -- one returns `wait-superseded`,
				// the other re-defers and throws -- so a claim that refused or could not be verified walked
				// out holding the slot. At the shipped default of one slot that wedged every wait check on
				// the worker until it restarted, and the symptom was silent in the worst way: held jobs kept
				// throttling and eventually recorded `wait-expired` with `max-wait-unchecked`, which blames
				// the deployment's capacity for a slot this gate leaked.
				try {
					// Claimed BEFORE the check, not after: a second delivery for an already-held target is a free
					// determinate refusal, and paying for a subprocess first inverts the free-before-costly rule
					// this gate's own header invokes. Tier 1 already claims in this order.
					const claim = await waitState.claim(job.id, { dedupId, untilMs: nowMs + waitBackoffMs(intervalMs(), held), isLive: deps?.isJobLive });
					if (claim.heldBy) {
						return await refuseWait("wait-superseded", "wait_superseded", { heldBy: claim.heldBy }, "Another delivery for this target is already waiting on the same conditions. Not run.");
					}
					if (claim.retry) {
						deps?.log?.("wait_supersede_unverified", { jobId: job.id, heldBy: claim.holder ?? null, delayMs: SUPERSEDE_RECHECK_MS });
						await job.moveToDelayed(nowMs + SUPERSEDE_RECHECK_MS, token);
						throw new DelayedError();
					}

					await waitState.noteThrottle(job.id, { denied: false }); // granted: the run of denials ends here
					// Sequential, in the operator's writing order: the resolver's reason applies unchanged --
					// naming the first condition that did not clear is what makes a held row readable, and a
					// parallel fan-out would blame whichever lost the race on any given wake.
					for (const profile of profiles) {
						checked = profile;
						verdict = await deps.checkWait(profile, targetFor(job.data?.kind, job.data), { signal });
						if (verdict?.profileUnknown || verdict?.verdict !== "go") break;
					}
				} finally {
					await fleetSlot?.release?.();
					checkSlots.release(WAIT_CHECK_KEY);
				}

				if (verdict?.unusableTarget) {
					// Determinate and unfixable by waiting: the job's own target is a shape no check can be
					// handed. It belongs with the refusals, not the holds -- holding would spend the fault
					// budget and then blame the operator's script for a value it was never given.
					return await refuseWait("wait-unreadable", "refused_wait_unreadable", { profile: checked }, `Refused: this job's target cannot be handed to a wait check, so \`${checked}\` can never be asked. Not run.`);
				}
				if (verdict?.profileUnknown) {
					return await refuseWait("wait-profile-unknown", "wait_profile_unknown", { profile: verdict.profileUnknown }, `Waiting on \`${verdict.profileUnknown}\` is not something this deployment can answer: no such wait profile is declared here. Not run.`);
				}
				if (verdict?.verdict === "refuse") {
					// Exit 2: the check says this will NEVER clear. Terminal by the protocol's own words, and
					// distinct from every "not yet" above it.
					return await refuseWait("wait-refused", "wait_refused", { profile: checked, heldForMs: held }, `The check \`${checked}\` reports this will never clear. Not run.`);
				}

				if (verdict?.aborted) {
					// The worker is stopping or this job was cancelled. Nothing was learned and nothing is
					// owed: re-defer at once rather than at the full backoff, and count neither a check nor a
					// fault, or a rolling deploy would spend a job's whole budget on its own restarts and then
					// blame the operator's script for it.
					deps?.log?.("wait_check_aborted", { jobId: job.id, profile: checked });
					await job.moveToDelayed(nowMs + THROTTLE_FLOOR_MS, token);
					throw new DelayedError();
				}

				if (verdict?.verdict === "hold") {
					const fault = verdict.fault === true;
					await waitState.noteCheck(job.id, { fault });
					const faults = fault ? counted.faults + 1 : 0;

					// A check that never answers is a broken script, not a slow condition, and OQ-030 is why
					// this bound exists: most CLIs exit 1 for everything, so without it a typo would hold for
					// the whole maximum wait and then blame the CONDITION rather than the check.
					if (faults >= maxFaults()) {
						return await refuseWait("wait-unanswerable", "wait_unanswerable", { profile: checked, faults }, `The check \`${checked}\` could not answer ${faults} times in a row. Not run.`);
					}

					// BOTH terminal bounds are tested AFTER the check and never before it, so a condition that
					// cleared on the deciding wake runs instead of being recorded as never having cleared.
					// Without that ordering the backoff's own quantisation makes "cleared at t+1s, declared
					// never-cleared at t+900s" a structural lie in the durable record and in a public comment.
					//
					// The count bound reads `checks + 1` because this wake's check has just run: the job gets
					// exactly `maxChecks` checks, the last of which is the deciding one. Putting it before the
					// check instead -- so the act of testing the bound could not exceed it -- was the obvious
					// spelling, and it silently made this whole guarantee untrue at every shipped default,
					// because the count bound is the one that fires first there.
					if (counted.checks + 1 >= maxChecks()) {
						return await refuseWait("wait-expired", "wait_expired", { reason: "max-checks", checks: counted.checks + 1, profile: checked, heldForMs: held }, `Gave up waiting on \`${checked}\` after ${counted.checks + 1} checks. Not run.`);
					}
					if (held >= maxWaitMs()) {
						return await refuseWait("wait-expired", "wait_expired", { reason: "max-wait", profile: checked, heldForMs: held }, `Gave up waiting on \`${checked}\`. Not run.`);
					}

					// Clamped to what is LEFT of the budget, never just the cadence. Without this an hourly
					// interval under a fifteen-minute maximum holds for the full hour -- 400% of the bound the
					// operator configured -- because the ceiling is only tested when a wake arrives, and the
					// cadence decides when that is. The two knobs are independent `positiveInt`s and nothing
					// cross-validates them, so the clamp is what makes the smaller one actually bind.
					const base = waitBackoffMs(intervalMs(), held);
					const jittered = base + Math.floor(base * 0.1 * random());
					const remaining = Math.max(0, maxWaitMs() - held);
					const delay = Math.max(1000, Math.min(jittered, remaining));
					await waitState.hold(job.id, { dedupId, target: targetFor(job.data?.kind, job.data), label: waitLabel(job.data), untilMs: nowMs + delay });
					deps?.log?.("wait_deferred", { jobId: job.id, profile: checked, fault, heldForMs: held, delayMs: delay });
					await job.moveToDelayed(nowMs + delay, token);
					throw new DelayedError();
				}

				// FAIL CLOSED on anything that is not literally go. Everything above tests for a specific
				// shape and falls through otherwise, and "otherwise" at this gate means STARTING A PAID
				// CONTAINER -- so an `undefined`, a `null`, a `{}`, a mis-cased "GO" or a bare string from a
				// checker would run the job silently, with no record field and no log line to distinguish it
				// from a job whose check said yes. The shipped checker is total, and that is exactly the
				// reasoning `unreadableConditions` above rejects: this is a dependency-injection seam, and a
				// seam's guarantees are the caller's to enforce.
				if (verdict?.verdict !== "go") {
					deps?.log?.("wait_check_unintelligible", { jobId: job.id, profile: checked });
					await waitState.noteCheck(job.id, { fault: true });
					const base = waitBackoffMs(intervalMs(), held);
					await job.moveToDelayed(nowMs + base + Math.floor(base * 0.1 * random()), token);
					throw new DelayedError();
				}

				// Every profile answered go. Record the last check so the count bound sees it.
				await waitState.noteCheck(job.id, { fault: false });
			}

			// Only a job that actually HELD has cleared. Without the check this line fires on the first
			// pickup of a job whose instant had already passed, and again on every scope-busy re-check
			// afterwards -- asserting a wait ended that never began.
			const heldForMs = await waitState.heldForMs(job.id);
			// Say so before releasing: a sibling held on this target must find the answer, not an empty lease.
			if (heldForMs !== null) await waitState.markSatisfied(job.id, { dedupId });
			await waitState.release(job.id, { dedupId });
			if (heldForMs !== null) deps?.log?.("wait_cleared", { jobId: job.id, label: waitLabel(job.data), heldForMs });
		}

		// Per-scope concurrency and the one-job-per-folder mutex (issue #242,
		// INT-SCOPED-LIMITS-FILE-CONTRACT). After the pause gate (a paused job must
		// not burn re-check wakes) and after the wait gate (a job holding until tomorrow must not sit on a
		// folder while it does), and STRICTLY above the `try` below, like the pause gate and for the same two
		// reasons: a DelayedError thrown inside the try would be converted to UnrecoverableError by the
		// catch, and a moveToDelayed rejection here must escape RAW into BullMQ's normal failed-attempt
		// handling exactly as the pause gate's does (inside the try it would become a permanent failure
		// plus a failure record for what was a transient blip). The limits snapshot is read ONCE here and
		// shared with `scopedLedgers` below, so the gate and the money ledger cannot disagree mid-job.
		// tryAcquire is a synchronous check-and-increment -- no await between read and take, so Node's
		// single thread makes it atomic at any concurrency -- and the local-folder limit is a structural 1
		// (concurrencyFor) with no file and no off-switch: the scheduler mints a cron trigger's next
		// occurrence at pickup and promotes it on time alone, so a slow run overlaps its own successor
		// (measured: 301ms of live container overlap through this very processor) unless this gate holds.
		// Infinity-limited scopes still acquire, so release stays uniform for every scoped job.
		// THE HOST-WIDE SLOT (issue #57), taken before the scope slot and released in the same finally.
		//
		// It exists only when this worker drains a second, host-affine queue. BullMQ's concurrency is per
		// Worker, so two queues at `PI_CONCURRENCY` would run twice the containers -- and that knob bounds a
		// MACHINE (its RAM, its share of the provider's concurrent-stream budget), not a queue. Deferral
		// rather than refusal, at the scope gate's own cadence and for its reason: a full host is transient
		// state, never a verdict about the job (CONST-RETRY-INFRA-ONLY).
		//
		// Before the scope acquire, so a job that cannot run on this machine at all never takes a folder
		// mutex it would immediately have to give back, and so the two releases nest rather than interleave.
		let hostHeld = false;
		if (hostBound) {
			if (!hostBound.slots.tryAcquire(HOST_SLOT_KEY, hostBound.limit())) {
				deps?.log?.("host_busy_deferred", { jobId: job.id, delayMs: SCOPE_BUSY_RECHECK_MS });
				await job.moveToDelayed(nowMs + SCOPE_BUSY_RECHECK_MS, token);
				throw new DelayedError();
			}
			hostHeld = true;
		}

		const limits = scopedLimits();
		// The job's project (issue #499, INT-PROJECTS-FILE-CONTRACT), resolved ONCE here from one read of the projects ref,
		// beside the limits snapshot and for its reason: the gate, the ledger and the record agree for this attempt,
		// whatever an operator does to projects.json mid-run. A retry or a deferral is a new pickup and resolves again.
		// Every record below this line carries it (through `recordAfterGate`); a record written before this gate carries
		// none and is resolved from the live ref (start.mjs). An id or null, never a name.
		const pickupProjects = projects();
		const project = projectOf(job.data, pickupProjects);
		// THE ONE RECORDER BELOW THE GATE, bound once, so the pickup project is a property of the path and not of each call
		// site: every record from here on goes through it, and none can drop the field and fall back to the live ref in
		// start.mjs, which would disagree with the pickup value exactly when projects.json was edited mid-run. A bolt in
		// project-pickup.test.mjs refuses a bare `recordRun(` call below this line.
		const recordAfterGate = (args) => recordRun({ ...args, project });
		// The MATCHED ROW's scope keys both the in-process slot and the fleet lease (issue #498), the same string
		// `budgetCapsFor` hashes below and the boot sweeper hashes from the file: a qualified `github:acme/web` row holds
		// GitHub jobs only, a bare `acme/web` row holds every forge's under the key it always had. With no row it is the
		// job's canonical scope, so the folder mutex is keyed exactly as before.
		const scope = rowScopeFor(job.data, limits);
		// THE SCOPE HOLDS, in acquire order (issue #499 part B): the repo or folder slot, then the project slot. Each is
		// `{ key, fleet }`: the in-process slot under `key` (the row scope) and its fleet claim, or null. ONE drain gives
		// every hold back, last first, at every exit (a deferral, the setup guard, the finally), the endpoint holds' shape:
		// a release site that lists slots by hand is the one that forgets the slot added after it was written.
		const scopeHolds = [];
		// Drains the holds, so a second call releases nothing: the in-process map's release is not idempotent. The
		// in-process half goes back synchronously, so a caller that cannot await (the setup guard) still frees every local
		// slot before it rethrows; the fleet half is release-if-mine and awaited where it can be.
		const releaseScopeHolds = () => {
			const taken = scopeHolds.splice(0).reverse();
			for (const hold of taken) inFlight.release(hold.key);
			return Promise.all(taken.map((hold) => hold.fleet?.release?.()));
		};
		// Give every hold back (scope and host), then defer. Every scope-gate deferral goes through here.
		const deferScope = async (fields) => {
			await releaseScopeHolds();
			// The host slot goes back before we defer: `makeInFlight().release` is not idempotent, so a slot
			// held across a deferral would be a slot this machine never gets back.
			if (hostHeld) {
				hostBound.slots.release(HOST_SLOT_KEY);
				hostHeld = false;
			}
			deps?.log?.(fields.event, { jobId: job.id, kind: job.data?.kind === "local" ? "local" : "forge", delayMs: SCOPE_BUSY_RECHECK_MS, ...fields.extra });
			await job.moveToDelayed(nowMs + SCOPE_BUSY_RECHECK_MS, token);
			throw new DelayedError();
		};
		if (scope) {
			const ceiling = concurrencyFor(job.data, limits);
			if (!inFlight.tryAcquire(scope, ceiling)) {
				// Optional-chained: makeProcessor gives `deps` no default and bare wirings pass deps: {}.
				// The scope itself stays out of the log line (no-pii-in-logs -- a local scope is a full
				// host path); the delayed count and the job id are what an operator needs to see it.
				await deferScope({ event: "scope_busy_deferred" });
			}
			const repoHold = { key: scope, fleet: null };
			scopeHolds.push(repoHold);

			// THE FLEET-WIDE HALF of a scoped ceiling (issue #57). A `scoped-limits.json` row's day/week/month
			// caps are already atomic INCRs on shared keys; its `concurrent` was a per-process Map, so it
			// multiplied by host count -- a MONEY bound silently widened by the operator's deployment shape,
			// which `INT-SCOPED-LIMITS-FILE-CONTRACT` calls out as the failure its version rule exists for.
			//
			// LOCAL scopes deliberately never claim, and the reason is not economy. The key is a hash of a
			// PATH STRING, which carries no identity: `/srv/site` on two machines is, in the common case, two
			// different repositories that share a layout convention. A shared claim keyed on that would
			// serialise two genuinely independent working trees and break exactly the deployments this feature
			// exists to enable. Local folders are answered by ROUTING instead -- a folder exists on one host,
			// so its in-process mutex already spans everything it needs to.
			//
			// And an unlimited forge scope never claims either: `concurrencyFor` returns Infinity with no
			// matching row, so a deployment with no scoped-limits file issues no command at all.
			if (scopeLease && job.data?.kind !== "local" && Number.isFinite(ceiling)) {
				repoHold.fleet = await scopeLease.acquire(job.id, { slots: ceiling, keyArgs: [hash16(scope)] });
				if (!repoHold.fleet) await deferScope({ event: "scope_busy_deferred", extra: { where: "fleet" } });
			}
		}

		// THE PROJECT SLOT (issue #499 part B): a project row's `concurrent` bounds every member of the project together.
		// Taken AFTER the repo slot, in the same order for every job, so two jobs cannot each hold one and wait on the
		// other; given back with it, last first, by the one drain above. Keyed by the project ROW's scope
		// (`project:<id>`): the in-process slot under that string, the fleet lease under `slot:s:<hash16(project:<id>)>`,
		// which is exactly the key the boot sweeper hashes from the row. A LOCAL member takes the fleet half too, where
		// its own folder slot does not: a folder path carries no identity across hosts, but a project id does (every
		// host carries the same projects.json, INT-PROJECTS-FILE-CONTRACT). A deferral, never a refusal, like the repo's.
		const projectRow = projectRowFor(limits, project);
		if (projectRow && Number.isSafeInteger(projectRow.concurrent)) {
			if (!inFlight.tryAcquire(projectRow.scope, projectRow.concurrent)) {
				await deferScope({ event: "scope_busy_deferred", extra: { ledger: "project" } });
			}
			const projectHold = { key: projectRow.scope, fleet: null };
			scopeHolds.push(projectHold);
			if (scopeLease) {
				projectHold.fleet = await scopeLease.acquire(job.id, { slots: projectRow.concurrent, keyArgs: [hash16(projectRow.scope)] });
				if (!projectHold.fleet) await deferScope({ event: "scope_busy_deferred", extra: { ledger: "project", where: "fleet" } });
			}
		}

		// THE ONE SETTINGS READ (issue #503), hoisted here from the top of the main `try` below because the
		// endpoint gate after it needs the effective provider and model, which the overlay can supply. Still ONE
		// call per pickup: two reads could straddle an overlay edit, and the gate would then lease for one model
		// while the container ran another. A throw is CAPTURED, never raised here: it is re-raised at the old spot
		// inside the main `try`, so its record, its retry decision and the releases are exactly what they were.
		let settings = null;
		let settingsError = null;
		let settingsThrew = false;
		try {
			settings = await getSettings();
		} catch (error) {
			settingsThrew = true;
			settingsError = error;
		}

		// THE MODEL ENDPOINT GATE (issue #503, INT-MODEL-ENDPOINTS-FILE-CONTRACT). A declared local model server
		// has a fixed number of parallel slots, and nothing else bounds how many jobs pile onto it: three per host
		// on several hosts, each metering $0. So a job whose main model, or any model on its effective allowed-model
		// list (issue #502: `run.models`, else PI_ALLOWED_MODELS), is served by a declared endpoint takes one of each
		// such endpoint's slots here and holds it until its container is gone (`endpointSetFor`). An UNRESTRICTED job's
		// set is its main model's alone, so its mid-run switch to another declared model is not counted, a named residual.
		//
		// LOCAL JOBS TAKE IT TOO, where they skip the fleet scope lease: a folder path carries no identity across
		// hosts, but an endpoint is one physical server whoever calls it.
		//
		// Two halves, like the scope's: the in-process bound (`endpointSlots`, shared by both Workers like the host
		// slot) and the fleet lease, which exists only with a declared worker name. A Valkey fault fails the fleet
		// half OPEN, and the in-process bound underneath is then the whole bound for this host, said in the log.
		//
		// In ID ORDER, so two jobs on two shared endpoints cannot each hold one and wait on the other: every job
		// asks in the same order, which is what rules the cycle out. On any miss EVERYTHING taken so far goes back
		// (endpoint holds, the scope's fleet claim, its in-process slot, the host slot) before the deferral: an
		// in-process release is not idempotent, so a slot kept across a deferral is one this host never gets back,
		// and a deferred job holding slots would starve the jobs that could run.
		//
		// A deferral, never a refusal: a full server is transient state (CONST-RETRY-INFRA-ONLY), and it is free,
		// decided before any token, clone or reservation (CONST-BUDGET-BEFORE-TOKENS). Skipped when the settings
		// are unreadable or invalid: that job is refused or retried below without starting anything.
		//
		// One snapshot per pickup (the endpoints, the overlay models, the derived set), handed to runJob as
		// `modelEndpoints` so a later gate reads the same declaration this one leased against. With no endpoints
		// declared the overlay is not even read, and the job touches nothing new: no command, no key, no field.
		const endpointHolds = [];
		let endpointSnapshot = null;
		// Drains the holds, so a second call releases nothing: the in-process map's release is not idempotent.
		// The in-process half goes back synchronously, so a caller that cannot await (the setup guard) still frees
		// every local slot before it rethrows; the fleet half is release-if-mine and awaited where it can be.
		const releaseEndpointHolds = () => {
			const taken = endpointHolds.splice(0).reverse();
			for (const hold of taken) endpointSlots.release(hold.id);
			return Promise.all(taken.map((hold) => hold.fleet?.release?.()));
		};
		if (modelEndpoints && !settingsThrew && !settings?.invalid) {
			let endpoints = [];
			let models = null;
			let set = [];
			// A failure to READ the overlay (any errno `readOverlayModels` rethrows), carried in the snapshot with its code,
			// so the credential gate gives no keyless verdict on it. The model gate runs first and reads the file too: it
			// refuses every job on a permanent errno (EACCES, EISDIR...) or a models.json that is a link, and retries a
			// transient errno (issue #552), so the credential gate sees this only when the read failed here and not there.
			// Absent, or not valid JSON, is determinate.
			let modelsUnreadable = null;
			try {
				endpoints = modelEndpoints() ?? [];
				if (endpoints.length > 0) {
					try {
						models = overlayModels();
					} catch (err) {
						// FAIL OPEN, and say so: an overlay models.json that does not parse names no endpoint for any model, and
						// refusing here would refuse every job on a hosted model too. The job runs without an endpoint slot.
						// A FIXED reason, never the error's message: a JSON.parse message quotes the file's text around the fault,
						// and models.json holds keys (PR #518's gate measured one in this line). The settings reader's posture.
						// An fs error is named by its code: `readOverlayModels` returns null for absence and rethrows every other
						// errno as-is (PR #520 round 2), carried for the gate, which retries rather than calling the provider keyless.
						// A configError is determinate: the file was read and is not JSON, or not an object (`[]`), and is named as
						// such, never as "unreadable", which is the fs-error wording.
						const reason = typeof err?.code === "string" ? err.code : err?.overlayLink === true ? "overlay models.json is a link" : err?.overlayNotAFile === true ? "overlay models.json is not a regular file" : /not valid JSON/.test(String(err?.message)) ? "overlay models.json is not valid JSON" : err?.piDispatchConfig === true ? "overlay models.json is not a valid models.json" : "overlay models.json is unreadable";
						deps?.log?.("endpoint_models_unreadable", { jobId: job.id, reason });
						if (typeof err?.code === "string") modelsUnreadable = { code: err.code };
					}
					// ONE hold per endpoint id: a set naming an endpoint twice would take its slot and then wait on itself,
					// forever on `slots: 1`. Deduplicated before the sort, so the order rule sees each endpoint once.
					const byId = new Map();
					for (const e of endpointSetFor({ models, job: effectiveJobOf(job.data, settings, deps?.allowedModels ?? null), endpoints })) if (!byId.has(e.id)) byId.set(e.id, e);
					set = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
				}
			} catch (err) {
				// The derivation reads data only, so this is a defect, not a state: the job runs unbounded and the log says so.
				deps?.log?.("endpoint_gate_unavailable", { jobId: job.id, reason: scrubCredentials(err?.message) });
				set = [];
			}
			endpointSnapshot = { endpoints, models, set, ...(modelsUnreadable ? { modelsUnreadable } : {}) };
			for (const endpoint of set) {
				let where = null;
				let fleet = null;
				if (!endpointSlots.tryAcquire(endpoint.id, endpoint.slots)) {
					where = "host";
				} else if (endpointLease && !isPerMachineHost(endpoint.host)) {
					// A host alias NAME is a DIFFERENT server on every machine (PR #518's gate: two Macs each declaring
					// host.docker.internal shared one fleet bound), so every other host, any address included, takes the
					// fleet half; the in-process bound above is exact for a server only this host reaches.
					fleet = await endpointLease.acquire(job.id, { slots: endpoint.slots, keyArgs: [hash16(endpoint.id)] });
					if (!fleet) {
						endpointSlots.release(endpoint.id);
						where = "fleet";
					} else if (fleet.degraded) {
						deps?.log?.("endpoint_lease_degraded", { jobId: job.id, endpoint: endpoint.id });
					}
				}
				if (where !== null) {
					await releaseEndpointHolds();
					await releaseScopeHolds();
					if (hostHeld) {
						hostBound.slots.release(HOST_SLOT_KEY);
						hostHeld = false;
					}
					deps?.log?.("endpoint_busy_deferred", { jobId: job.id, endpoint: endpoint.id, where, delayMs: ENDPOINT_BUSY_RECHECK_MS });
					await job.moveToDelayed(nowMs + ENDPOINT_BUSY_RECHECK_MS, token);
					throw new DelayedError();
				}
				endpointHolds.push({ id: endpoint.id, fleet });
			}
		}

		let startedAt;
		let name;
		let timer;
		let cancelPoll;
		let cancelPolling = false;
		// The poll tick in flight, KEPT (gate round 2 of PR #479), so the error handler can stop the poll and wait for it
		// before it asks whether the job was cancelled: a flag says a tick runs, only its promise says when it is done.
		let cancelTick = null;
		// THE ONE STOP (gate rounds 2 to 4 of PR #479), used wherever this job's outcome is about to be decided: at the
		// container's observed exit, when runJob returns, and in the error handler. `pollStopped` is set first and read by
		// the tick synchronously right before it aborts and acknowledges, so after a stop no cancel is ever acknowledged;
		// a tick already past that point has aborted the signal and writes its ack before the stop's await returns. So
		// "acknowledged" and "the signal says operator-cancel" are the same fact by the time anything is decided.
		//
		// BOUNDED (gate round 4 of PR #479): the worker's Valkey client queues commands while offline, so a tick's read can
		// hang for a whole outage, and an unbounded await held the job's outcome (its record, comment and slot) with it: a
		// restart in that window lost the record. The bound is safe because the flag is set FIRST: a read still hanging
		// returns without acknowledging, and a tick already past the flag check aborted the signal synchronously, so the
		// decision sees the cancel even while its ack write waits. Said once per job when the bound is hit.
		let pollStopped = false;
		let stopBoundSaid = false;
		const stopCancelPoll = async () => {
			pollStopped = true;
			clearInterval(cancelPoll);
			if (!cancelTick) return;
			let bound;
			const hit = await Promise.race([
				Promise.resolve(cancelTick).then(
					() => false,
					() => false,
				),
				new Promise((resolve) => {
					bound = setTimeout(() => resolve(true), cancelStopBoundMs);
					bound.unref?.();
				}),
			]);
			clearTimeout(bound);
			if (hit && !stopBoundSaid) {
				stopBoundSaid = true;
				deps?.log?.("cancel_poll_stop_bounded", { jobId: job.id, boundMs: cancelStopBoundMs });
			}
		};
		let onAbort;
		let venue;
		try {
			// Nothing between the acquire above and the main `try` below may throw unguarded: the releasing
			// finally belongs to THAT try, so an unguarded throw here would leak the hold and wedge the
			// scope until a worker restart. Nothing in this block throws past its own guards (setTimeout,
			// setInterval and addEventListener on the bullmq-allocated controller are total at processor arity
			// 3, and the cancel poll's redis reads happen inside its own guarded ticks). `containerName` is the
			// exception, and it is named: the registry's refusal of an unheld venue is caught at the call, and
			// anything else it throws propagates to the catch below, which releases what was acquired.
			startedAt = new Date().toISOString();
			// The producer of the name both boot reapers sweep by substring. Built from the shared prefix
			// rather than typed here, so a rename cannot land in the producer and not in the sweeps (#227).
			// From the VENUE that will build the container, not from the local adapter reached for directly:
			// the abort stops this name, so the name and the stop have to come from the same backend. The
			// default keeps every wiring that predates the seam building it exactly as before.
			//
			// `job.data`, NOT `job`. This function's `job` is the BullMQ WRAPPER -- its own keys are `id` and
			// `data` -- so `job.backend` is always undefined and the registry's resolution would fall to
			// `?? defaultName` for every job, silently, on the one path where the fail-closed throw can never
			// fire because "names nothing" is exactly the case it permits. `runJob` is handed `effectiveJob`,
			// a spread of `job.data`, which is why `runContainer` and the two preflights dispatch correctly
			// while these two did not.
			// One object carrying BOTH halves: the id is the BullMQ wrapper's (it always was) and the venue is
			// the trigger's, which lives in `data`. Built once so the name and the stop cannot resolve
			// different backends -- the whole reason the name moved onto the registry in the first place.
			venue = { ...job.data, id: job.id };
			// The registry REFUSES a venue it does not hold (#277), and that one refusal is caught here.
			// Unguarded, it skipped `runJob` and every `recordRun` below, so a job naming a venue this worker
			// never built -- a producer on a newer build that knows a venue this one does not -- left NO
			// record, no refusal comment, and was retried as if the infrastructure had failed. Such a venue is
			// never blessed here (the registry refuses a blessed name it does not hold, at boot), so `runJob`
			// refuses it pre-spend -- as `backend-unblessed`, or by an earlier refusal that happens to win --
			// and records it; nothing starts, so there is no container for this name to stop. A null name
			// reaches the abort path's stop only if an abort lands in that window, and that stop fails into
			// its own log line.
			//
			// ONLY that refusal, by its code. Any other throw is a REGISTERED venue's own `containerName`
			// failing, a broken adapter: swallowing it would reserve the budget and start a container under a
			// null name that the timeout could not stop and no reaper sweeps, so it propagates as before.
			try {
				name = containerName(venue);
			} catch (err) {
				if (err?.code !== BACKEND_NOT_REGISTERED) throw err;
				name = null;
			}
			timer = setTimeout(() => {
				// BullMQ has no per-job kill timer; this is ours. cancelJob raises the AbortSignal.
				Promise.resolve(cancelJob(job.id, "job-timeout-30m")).catch(() => {});
			}, timeoutMs);

			// Abort (timeout OR shutdown) => stop the container. docker stop sends SIGTERM then SIGKILL
			// after the grace period; the runner exits and runContainer returns/throws.
			onAbort = () => {
				// The JOB'S DATA goes with the name -- `job.data`, not `job`. A container name alone cannot say
				// which runtime holds it once there is more than one venue, and this call is the only thing
				// standing between a runaway job and the 30-minute bound (REQ-JOB-TIMEOUT-30M). Passing the
				// BullMQ wrapper sent every abort to the DEFAULT venue: `docker stop` on a host that never
				// held the container, rejecting into a log line while the real one kept running and kept
				// spending, with the local reaper unable to see it either.
				// The whole call is inside the try, not just its promise. `Promise.resolve(f())` evaluates `f()`
				// FIRST, so a missing or throwing `stopContainer` raises synchronously, inside an
				// AbortSignal listener, where it surfaces as an uncaughtException and takes the worker
				// process down 30 minutes into a runaway job -- killing every other in-flight job on the
				// host. Losing the kill for one job is bad; losing the process is worse.
				const note = deps.log ?? (() => {});
				try {
					Promise.resolve(stopContainer(name, venue)).catch((err) => note("stop_container_failed", { job: job.id, reason: scrubCredentials(err?.message) }));
				} catch (err) {
					note("stop_container_failed", { job: job.id, reason: scrubCredentials(err?.message) });
				}
			};
			signal.addEventListener("abort", onAbort, { once: true });

			// The operator-cancel poll (issue #287). `cancelJob` is reachable only from THIS process, so the
			// CLI and the panel leave a `cancel:req:<jobId>` key instead, and the worker that holds the job
			// answers. Polled beside the kill timer rather than subscribed, for the reasons cancel-state.mjs
			// records; one GET per 2s per active job is invisible against the 30s abort grace. Guarded on
			// `redis.get` because bare test wirings pass a redis with only `incr`/`expire` -- they arm
			// nothing and stay byte-identical. Each tick is re-entrancy-guarded and swallows redis faults:
			// a blip may cost the ack, never the job.
			if (typeof redis?.get === "function") {
				cancelPoll = setInterval(() => {
					if (cancelPolling) return;
					cancelPolling = true;
					cancelTick = (async () => {
						try {
							const req = await redis.get(cancelReqKey(job.id));
							if (req === null || req === undefined) return;
							// Stopped while this read was in flight: the outcome is being decided, so this request is left
							// unanswered (its requester's timeout re-reads the job), never acknowledged after the fact.
							if (pollStopped) return;
							// Bound to this worker (the injection comment in createWorker): `false` means the job
							// left the tracked map in this same instant, in which case the finally below clears
							// this interval anyway and the request's TTL reaps the key.
							const took = await Promise.resolve(cancelJob(job.id, "operator-cancel")).catch(() => false);
							if (took === false) return;
							// Ack first, then consume the request: losing the DEL to a blip costs one redundant
							// re-read, losing the ack costs the operator a false "nobody answered".
							await redis.set(cancelAckKey(job.id), hostName, "PX", CANCEL_ACK_TTL_MS).catch(() => {});
							await redis.del(cancelReqKey(job.id)).catch(() => {});
							clearInterval(cancelPoll);
						} catch {
							// Fail open: the next tick re-asks.
						} finally {
							cancelPolling = false;
						}
					})();
				}, cancelPollMs);
				// Like the abort-grace timer: this must never keep an otherwise-finished worker alive.
				cancelPoll.unref?.();
			}
		} catch (error) {
			// Release and DRAIN: this throw never reaches the main finally below, but a shared scope must never be
			// releasable twice -- a double release frees another holder's slot. Last taken, first given back.
			void releaseEndpointHolds();
			void releaseScopeHolds();
			if (hostHeld) {
				hostBound.slots.release(HOST_SLOT_KEY);
				hostHeld = false;
			}
			clearTimeout(timer);
			clearInterval(cancelPoll);
			throw error;
		}

		try {
			// The read itself happened once, above the endpoint gate; its throw lands HERE, where it always did.
			if (settingsThrew) throw settingsError;
			if (settings.invalid) {
				// A present-but-invalid overlay is a POLICY refusal, RETURNED (never thrown) so BullMQ marks the
				// job completed and does not retry a file that can never parse (CONST-RETRY-INFRA-ONLY). Resolved
				// before runJob, so no budget slot is reserved and no container starts (CONST-BUDGET-BEFORE-TOKENS).
				// recordRun leaves the durable settings-overlay-invalid trace for the admin extension.
				// No provider/model here, as in every result this function returns from ABOVE the try (the wait gate's
				// refusals are the others): each is decided before or during the settings read, so no honest effective
				// value exists yet -- buildRecord defaults both null.
				const result = { outcome: "policy", reason: "settings-overlay-invalid", exitCode: null, turns: null, tokens: null, budgetReserved: false };
				recordAfterGate({ job, result, startedAt, endedAt: new Date().toISOString() });
				return result;
			}

			// Re-bind the worker slot count to the effective concurrency before the run (no-op default when
			// unwired, e.g. a bare makeProcessor under test).
			applyConcurrency(settings.concurrency);

			// Fill the effective job settings under `job.data > overlay > env` precedence: an explicit per-job
			// field wins; an omitted one takes the overlay value, else env, resolved at this job's start
			// (INT-CONFIG-OVERLAY-CONTRACT). A forge job carries provider/model/maxTurns only when its trigger
			// named them (#502), so for most jobs this fill supplies the provider the container env allowlist
			// requires -- absent it, the allowlist refuses a job only after its budget slot is reserved. The `caps`/`softHoldPct` passed to runJob change which
			// values reserveBudget checks, never when it runs.
			// The one call that logs a malformed queued cap (#501): the endpoint gate above computes the same job and
			// stays quiet, so it is reported once per pickup.
			const effectiveJob = effectiveJobOf(job.data, settings, deps?.allowedModels ?? null, (event, fields) => deps?.log?.(event, { jobId: job.id, ...fields }));

			// THE ENVELOPE (issue #504 part B, DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE). With one loaded, every job is governed:
			// its project's, or `_other`'s, share of the applied split narrows the dollar ledgers below, read ONCE here
			// beside the limits snapshot and the pickup project, so the gate and the reservation judge one split. The read
			// also brings the state in line (the neutral seed, expiry, a re-base) and says when this host's envelope is not
			// the applied split's, which the processor refuses as `envelope-mismatch` before anything is spent. A Valkey
			// fault throws here, inside the try, and is retried like any reserve fault: nothing has started.
			const operatorDollars = { dollarCaps: dollarWindowCaps(settings), scopedDollars: dollarCapsFor(job.data, limits), projectDollars: projectDollarCapsFor(limits, project) };
			let dollarInputs = { ...operatorDollars };
			const governing = allocation?.current?.() ?? null;
			try {
				if (governing?.envelope) {
					const { state, mismatch } = await allocation.reconcile({ envelope: governing.envelope, digest: governing.digest, now: new Date(nowMs) });
					dollarInputs = mismatch ? { ...operatorDollars, envelopeMismatch: true } : governedDollars({ envelope: governing.envelope, state, member: project === null ? null : { id: project, member: memberScopeOf(job.data) }, operator: operatorDollars });
				} else if (typeof allocation?.fleetGoverned === "function" && (await allocation.fleetGoverned())) {
					// A host with no envelope in a fleet with an applied split: ungoverned, so refused like a differing envelope.
					dollarInputs = { ...operatorDollars, envelopeMismatch: "no-envelope" };
				}
			} catch (error) {
				// INFRASTRUCTURE, never a verdict (CONST-RETRY-INFRA-ONLY): Valkey did not answer, replied with an error, or the
				// audit file could not be written. Nothing has been reserved or started, so the job is retried rather than
				// dropped as the UnrecoverableError a plain throw would become below.
				deps?.log?.("allocation_read_failed", { jobId: job.id, code: typeof error?.code === "string" ? error.code : "error" });
				throw new InfraRetry("the allocation state could not be read", { cause: error, reason: "container-never-started", provider: effectiveJob.provider ?? null, model: effectiveJob.model ?? null, budgetReserved: false });
			}

			const result = await runJob(effectiveJob, {
				redis,
				// The three spend windows (week/month null when disabled) and the soft-hold band, resolved this
				// job-start under overlay > env. reserveBudget checks them before the container.
				caps: { day: settings.dailyCap, week: settings.weeklyCap, month: settings.monthlyCap },
				softHoldPct: settings.softHoldPct,
				// The daily TOKEN cap (issue #25), same overlay > env resolution. Check-AFTER, so it gates the
				// NEXT job on prior recorded spend; null => the daily token counter is disabled.
				tokenCap: settings.dailyTokenCap,
				// This job's scoped job-count ledgers in reserve order (issues #242 and #499 part B): its repo or folder
				// row's, then its project row's, from the SAME limits snapshot and the SAME pickup project the gate above
				// read -- one read per pickup, so gate, ledger and record agree for this attempt. Empty when no row carries
				// a job-count window for this job.
				scopedLedgers: scopedLedgers(job.data, limits, project),
				// Issue #501: the deployment's dollar windows in micro-dollars, resolved this job-start under overlay > env
				// like the caps above, or null when none is set (then nothing is reserved and no dollar key is written).
				dollarCaps: dollarInputs.dollarCaps,
				// Issues #501 part 5 and #502 part 6: this job's repo or folder dollar windows and the model dollar windows it
				// reserves in, from the SAME limits snapshot. The model rows follow the job's EFFECTIVE list (the trigger's,
				// else PI_ALLOWED_MODELS); a job with none reserves in every model row (`modelDollarRows` says why).
				scopedDollars: dollarInputs.scopedDollars,
				// Issue #499 part B: the project row's dollar windows, keyed by the project row's scope, for the pickup project.
				projectDollars: dollarInputs.projectDollars,
				// Issue #504 part B: the project was decided on the folder AS NAMED; prepare mounts the
				// folder it RESOLVES. The processor asks which project the resolved folder belongs to, from the same projects
				// snapshot, and refuses before any reserve when it is another project's.
				pickupProject: project,
				folderProject: (folder) => projectOf({ kind: "local", folder }, pickupProjects),
				// Issue #504 part B: `_other`'s ledger, the deployment cap's source and the envelope verdict, under an envelope;
				// absent without one, so the processor's defaults keep such a deployment byte-identical.
				...(dollarInputs.otherDollars ? { otherDollars: dollarInputs.otherDollars } : {}),
				...(dollarInputs.dollarCapSource ? { dollarCapSource: dollarInputs.dollarCapSource } : {}),
				...(dollarInputs.envelopeMismatch ? { envelopeMismatch: dollarInputs.envelopeMismatch } : {}),
				// Issue #505: this host's envelope delegation block, for the `portfolio-no-envelope` gate; absent without an
				// envelope, where the processor's default (null, no envelope) is the truth.
				...(governing?.envelope ? { envelopeDelegation: governing.envelope.delegation ?? null } : {}),
				modelDollars: modelDollarRows(limits, effectiveJob.models ?? null),
				// The endpoint gate's snapshot (issue #503): the declared endpoints, the overlay models and this job's
				// derived set, read once at pickup. Absent on a wiring with no endpoint seam, so a bare processor's
				// runJob context is unchanged.
				...(endpointSnapshot ? { modelEndpoints: endpointSnapshot } : {}),
				...deps,
				// Issue #502: the skew check must see `models` as the job ARRIVED, not as `effectiveJobOf` filled it from
				// PI_ALLOWED_MODELS, or a trigger list a stale receiver dropped would read as present and the job would run on
				// the deployment's list. Only when the wiring supplies the check, so a bare processor keeps the default.
				// The same for `maxCostUsd` (#501): `effectiveJobOf` keeps the arrived value under its own key and writes the
				// resolved cap as `maxCostMicros`, but it is read off `job.data` here too, so no later fill can hide a drop.
				...(deps?.checkWaitSkew ? { checkWaitSkew: (j, ...rest) => deps.checkWaitSkew({ ...j, models: job.data?.models, maxCostUsd: job.data?.maxCostUsd }, ...rest) } : {}),
				// #227. BOUNDED AFTER THE ABORT, and this is what makes `abortable` an honest declaration.
				//
				// `makeRunContainer`'s promise settles ONLY on the docker child's `close` or `error`. Nothing
				// else ends that await -- the signal is read at entry and captured at close, never passed to
				// the spawn. So `stopContainer` is the sole kill channel, and if it does not take (an
				// unreachable daemon, a wiring whose stop is a no-op) the container keeps running, `docker
				// run` never exits, and the processor awaits FOREVER: an active job renewing its lock and
				// holding its in-flight slot, its host slot, its scope lease and its budget reservation, with
				// nothing in the log and nothing in the record. REQ-JOB-TIMEOUT-30M's Acceptance says "the
				// slot is freed", and it was not.
				//
				// So once the abort has fired, the wait is bounded. On expiry this resolves the SAME shape a
				// killed container returns -- `{ code: 137, aborted: true }`, which `run-container.mjs`
				// already uses for "aborted before it could start" -- so the processor classifies it as
				// POLICY and does not retry. That is deliberate: the container may still be running, and a
				// retry would pay for a second one alongside it. What is leaked is the container, which the
				// next boot reaper sweeps; what is NOT leaked is the slot, the lease and the reservation.
				// The `stop_did_not_take` line is the loud half, because a host whose daemon ignores a stop
				// is a fact an operator has to learn from somewhere.
				// Issue #287: WHO aborted rides the result, read off the signal at the one seam both abort
				// paths flow through (a real stop resolves through here, and boundAfterAbort's synthesised
				// `{ code: 137, aborted: true }` does too). `cancelJob(id, reason)` becomes `signal.reason`,
				// so the processor can classify an operator's cancel apart from the kill timer's without
				// this file growing a second channel. Mapped only when `aborted` -- an unaborted result
				// stays byte-identical -- and only a STRING rides: a non-string reason (AbortError objects,
				// future bullmq surprises) collapses to null, which classifies as worker-abort, the
				// conservative direction.
				// Gate round 4 of PR #479: the poll STOPS at the container's observed exit, since after it there is nothing
				// left for a cancel to stop. A cancel acknowledged before that moment raced the exit and lost nothing it was
				// promised: the run is recorded as that cancel (the existing path, "partial work may exist") even when the
				// container happened to exit on its own, because the operator was told the record would say operator-cancel.
				runContainer: (ctx) =>
					boundAfterAbort(deps.runContainer({ ...ctx, name, signal }), signal, job, deps.log ?? (() => {})).then(async (r) => {
						await stopCancelPoll();
						const raced = r && r.aborted !== true && signal.aborted === true && signal.reason === "operator-cancel";
						if (raced) deps.log?.("cancel_acked_as_container_exited", { jobId: job.id, exitCode: r.code ?? null });
						const run = raced ? { ...r, aborted: true } : r;
						return run?.aborted ? { ...run, abortReason: typeof signal.reason === "string" ? signal.reason : null } : run;
					}),
				// REQ-TRIGGER-SECRETS. The resolver runs INSIDE the 30-minute kill timer armed above, so it has
				// to be abortable for the same reason runContainer does: a resolver blocking on an unreachable
				// vault would otherwise hold its slot until its own timeout, and an abort landing mid-resolution
				// would neither stop it nor keep the job from going on to mint, clone and reserve budget for a
				// container that runContainer will refuse at entry anyway. Injected here, mirroring runContainer,
				// because `signal` exists only in this scope. Omitted when unwired so a bare processor keeps
				// runJob's own fail-closed default.
				// `secretProfiles` is the OVERLAY half of the resolver table, read this job-start with the ten
				// tunables above. It is bound here rather than at construction for the reason the overlay exists:
				// an operator who declares a profile in the panel must not have to restart the worker.
				...(deps.resolveSecrets ? { resolveSecrets: (j) => deps.resolveSecrets(j, { signal, overlayProfiles: settings.secretProfiles ?? {} }) } : {}),
				// collectChain (INT-OUTBOX-CONTRACT) reads the completed parent's REAL BullMQ job: its `.id`
				// (the parent id children carry) and `.data` (kind/chainDepth). runJob's own `job` is the
				// effectiveJob -- a spread of job.data with no `.id`/`.data` -- so inject the real wrapper here,
				// mirroring the name/signal injection above. Omitted when unwired so a bare processor falls back
				// to runJob's no-op default (a chain fault can never flip a completed outcome either way).
				...(deps.collectChain ? { collectChain: (ctx) => deps.collectChain({ ...ctx, job }) } : {}),
				// The plan collector (issue #505) the same way and for the same reason: the writer it records is the REAL job's
				// `.id`, and the authority it checks is `.data` as queued. The pickup's `portfolio` decision rides in `ctx`.
				...(deps.collectPlan ? { collectPlan: (ctx) => deps.collectPlan({ ...ctx, job }) } : {}),
				// prepareWorkspace needs the REAL BullMQ job's `.id` to derive a cron job's scheduled-for
				// instant from the deterministic repeat:<id>:<millis> jobId (DES-CRON-VIA-BULLMQ-SCHEDULER)
				// for the local /job/event.json. runJob's own `job` is the effectiveJob -- a spread of
				// job.data with no `.id` -- and the real wrapper is only in scope here, so inject it as
				// `queueJobId`, mirroring the collectChain injection above. Omitted when unwired so a bare
				// processor keeps runJob's plain (job, token) call.
				// The third argument is EXTENDED, never replaced. `runJob` calls this as
				// `prepareWorkspace(job, token, { piVersion })`, so a wrapper passing only `{ queueJobId }`
				// dropped it -- and `piVersion` defaults to `null`, which `readCanonical` treats as
				// "never resume": `if (piVersion === null) return COLD("pi-version-changed")`. So EVERY
				// `run.resume` cold-started, on every wired worker, while reporting success. The stamp
				// `promoteSession` writes was correct the whole time; the comparison simply never happened.
				// The processor tests inject `prepareWorkspace` directly and never see this wrapper, which is
				// why nothing caught it (REQ-RESUMABLE-SESSION).
				...(deps.prepareWorkspace ? { prepareWorkspace: (j, t, opts) => deps.prepareWorkspace(j, t, { ...opts, queueJobId: job.id }) } : {}),
				// The one-shot pre-spend check (issue #231) needs the REAL BullMQ job's `.id` to excuse this
				// delivery's own earlier attempt -- runJob's effectiveJob has no `.id`, prepareWorkspace's
				// own injection above states why, and this one mirrors it. Omitted when unwired so a bare
				// processor keeps runJob's admit-everything default.
				// Same extend-don't-replace shape as `prepareWorkspace` above, for its reason: `runJob` passes
				// this one no options today, so there is nothing to lose yet -- and the day it does, a
				// replacing wrapper would lose it in the same silence.
				...(deps.checkOnceSpent ? { checkOnceSpent: (j, opts) => deps.checkOnceSpent(j, { ...opts, queueJobId: job.id }) } : {}),
			});
			// Gate round 4 of PR #479: stopped again as runJob returns, before anything is recorded (a result with no
			// container never passed the exit stop above). A cancel that lands after is never acknowledged, and its
			// requester's re-read says the job finished. One acknowledged before, on a result that is not the cancel (a
			// pre-spend refusal that finished after the ack, since a container would have seen the abort), is recorded as
			// the cancel the operator was told of, the result it replaced named in the log.
			await stopCancelPoll();
			let outcome = result;
			if (signal.aborted === true && signal.reason === "operator-cancel" && result?.reason !== "operator-cancel") {
				deps.log?.("cancel_acked_before_result", { jobId: job.id, was: `${result?.outcome}/${result?.reason ?? ""}` });
				outcome = { ...result, outcome: "policy", reason: "operator-cancel" };
			}
			recordAfterGate({ job, result: outcome, startedAt, endedAt: new Date().toISOString() });
			return outcome;
		} catch (error) {
			// Issue #448 (gate round 2 of PR #473): a local job held until rootful Podman's service restarts goes back to the
			// delayed set WITHOUT spending an attempt, the pause gate's move, since a service held up past one retry backoff
			// failed a job that heals by itself (measured). Bounded by the hold's own start, stored on the job because a
			// deferral leaves `attemptsMade` alone and a worker restart must not reset it; past the bound it fails for good
			// with its own reason token, whose comment names the restart. Nothing is recorded per deferral: the job never
			// started, and one record a minute for an hour would bury the run history.
			//
			// Gate round 3: the hour counts only while the worker kept checking. A check that comes more than two recheck
			// periods after the last one (the queue was paused, `pi-dispatch pause`, or no worker ran) starts the hold
			// afresh, since the time between was no evidence that the service stayed up; the last check's time is stored
			// beside the start. And the expired hold is RECORDED with its own token, the one its comment and the failure
			// hook carry, never the `container-never-started` of the throw it ends.
			// A CANCELLED JOB IS NEVER RUN AGAIN (gate of PR #479). The operator-cancel poll runs from pickup to the finally
			// below, so a cancel can be acknowledged (the signal aborted with "operator-cancel") after the job was picked up
			// and before this handler hands it back to the queue: a hold's `moveToDelayed`, or an `InfraRetry` BullMQ
			// retries after its backoff. Either ran the job later, with the request key already consumed, so nothing
			// cancelled it again. So every error this handler would hand back (every `InfraRetry`, the two holds' included,
			// since both are one) is asked ONE question first, in ONE place, so the three paths cannot drift apart: was this
			// job cancelled? A request not yet polled is read too, and acknowledged and consumed as the poll would. Either
			// ends the job as the operator's cancel, the policy result the aborted-container path already returns, recorded,
			// one fixed comment, never retried. A shutdown's abort is not a cancel: that job is held or retried as before,
			// so it survives the restart.
			// `readPending: false` asks only whether the poll ALREADY acknowledged a cancel (the signal), and leaves a request it
			// had not read unanswered.
			const operatorCancelled = async ({ readPending = true } = {}) => {
				if (signal?.aborted === true) return signal.reason === "operator-cancel";
				if (!readPending) return false;
				if (typeof redis?.get !== "function") return false;
				let req = null;
				try {
					req = await redis.get(cancelReqKey(job.id));
				} catch {
					return false;
				}
				if (req === null || req === undefined) return false;
				await Promise.resolve(redis.set?.(cancelAckKey(job.id), hostName, "PX", CANCEL_ACK_TTL_MS)).catch(() => {});
				await Promise.resolve(redis.del?.(cancelReqKey(job.id))).catch(() => {});
				return true;
			};
			// A retry that already spent (a container that ran and exited as infra) keeps what it spent on the record, and
			// says the processor's own operator-cancel sentence; one that never started says it was cancelled before it did.
			// The session rides along as the aborted-container path keeps it (`mergeSession`, already applied to the throw).
			// A NON-retryable error (gate round 3) is not known to have started nothing, so it says the processor's own
			// operator-cancel sentence, keeps whatever `budgetReserved` it carried, and its own words go to the log, never lost.
			const endCancelled = async ({ retryable }) => {
				const spent = error?.budgetReserved === true;
				const beforeStart = retryable && !spent;
				const result = { outcome: "policy", reason: "operator-cancel", exitCode: spent ? (error.exitCode ?? null) : null, turns: spent ? (error.turns ?? null) : null, tokens: spent ? (error.tokens ?? null) : null, ...(spent && error.usage ? { usage: error.usage } : {}), provider: error?.provider ?? null, model: error?.model ?? null, session: error?.session ?? null, budgetReserved: retryable ? spent : (error?.budgetReserved ?? null), ...(error?.dollars ? { dollars: error.dollars } : {}) };
				deps?.log?.("job_cancelled_instead_of_retry", { jobId: job.id, spent, retryable, ...(retryable ? {} : { failure: scrubCredentials(String(error?.message ?? error)).slice(0, 300) }) });
				if (deps?.comment) await Promise.resolve(deps.comment(job.data, beforeStart ? CANCELLED_BEFORE_START_COMMENT : TERMINAL_COMMENTS["operator-cancel"])).catch(() => {});
				recordAfterGate({ job, result, startedAt, endedAt: new Date().toISOString() });
				return result;
			};
			// STOP THE POLL BEFORE ASKING (gate round 2 of PR #479). The poll ran until the finally below, so a request that
			// landed after the question was still acknowledged by it (ack written, request consumed, the CLI saying "cancel
			// accepted") while the job went on to its hold or its retry and ran again. So the poll is stopped first and any
			// tick already in flight awaited, and only then is the question asked: a cancel the poll took is seen on the
			// signal, one it had not read is read here, and one that lands after is never acknowledged, so its requester
			// truthfully says nothing was changed while the job is held or retried, and a second cancel removes it.
			//
			// EVERY ERROR, NOT ONLY A RETRY (gate round 3 of PR #479). On a non-retryable error the still-running poll could
			// acknowledge a cancel, so the CLI said the record would say operator-cancel while it said failed. The poll is
			// stopped the same way before the terminal path, and the question differs by one thing only. A cancel the poll
			// ALREADY acknowledged (the signal) ends the job as operator-cancel: the requester was told that, so the record
			// must agree, and the failure's own words go to the log. A request it had NOT read is left unanswered: the job
			// has failed for its own reason, the record says so, and the requester's re-read then says the job finished
			// before its worker read the cancel and nothing was changed. Consistent either way, never one said and the
			// other recorded. A retryable error reads that request too, since the job would otherwise run again.
			await stopCancelPoll();
			const retryable = error instanceof InfraRetry;
			if (await operatorCancelled({ readPending: retryable })) return await endCancelled({ retryable });
			if (error?.holdUntilRestart === true) {
				const heldAt = now();
				const last = job.data?.podmanRestartHoldLastMs;
				const resumed = !Number.isFinite(last) || heldAt - last > 2 * PODMAN_RESTART_HOLD_RECHECK_MS;
				const since = !resumed && Number.isFinite(job.data?.podmanRestartHoldSinceMs) ? job.data.podmanRestartHoldSinceMs : heldAt;
				if (heldAt - since < PODMAN_RESTART_HOLD_MAX_MS) {
					await job.updateData({ ...job.data, podmanRestartHoldSinceMs: since, podmanRestartHoldLastMs: heldAt });
					deps?.log?.("podman_restart_hold", { jobId: job.id, heldForMs: heldAt - since, delayMs: PODMAN_RESTART_HOLD_RECHECK_MS, reason: String(error.message).slice(0, 300) });
					await job.moveToDelayed(heldAt + PODMAN_RESTART_HOLD_RECHECK_MS, token);
					throw new DelayedError();
				}
				const expired = Object.assign(new UnrecoverableError(`held ${Math.round((heldAt - since) / 60_000)} min for rootful Podman's service to restart, and it did not: ${error.message}`), { reason: PODMAN_RESTART_HOLD_EXPIRED, provider: error.provider ?? null, model: error.model ?? null, budgetReserved: false });
				recordAfterGate({ job, error: expired, startedAt, endedAt: new Date().toISOString() });
				throw expired;
			}
			// Issue #476: a job whose egress preflight found the rootless network keeper running on its own bridge but younger
			// than the minimum age is HELD until it is old enough (one `moveToDelayed`, no attempt), the move the hold above
			// makes, since a keeper merely young is not a keeper that does not hold: every joint start of the stack read it
			// at under a second and spent a queued job's attempt (measured on 4.9.3). A crash loop is young at every start,
			// so the hold is BOUNDED, and ends early on the evidence of one: the keeper the job waited on is gone, or another
			// start has taken its place. Either ends in an ordinary retry (an attempt, as any keeper that does not hold
			// costs) with its own reason token naming the loop. The hold's state is stored on the job, as the podman.service
			// hold's is, and read only while the checks come within the bound of each other: a later one starts afresh.
			const keeperHold = keeperHoldState(job, now());
			if (error?.keeperYoung && typeof error.keeperYoung === "object") {
				const young = error.keeperYoung;
				const restarted = keeperHold.startedMs !== null && keeperHold.startedMs !== young.startedMs;
				const heldMs = keeperHold.at - keeperHold.since;
				if (!restarted && heldMs < NETNS_KEEPER_YOUNG_HOLD_MAX_MS) {
					await job.updateData({ ...job.data, netnsKeeperHoldSinceMs: keeperHold.since, netnsKeeperHoldLastMs: keeperHold.at, netnsKeeperHoldStartedMs: young.startedMs });
					deps?.log?.("netns_keeper_young_hold", { jobId: job.id, keeperAgeMs: young.ageMs, heldForMs: heldMs, delayMs: young.waitMs });
					await job.moveToDelayed(keeperHold.at + young.waitMs, token);
					throw new DelayedError();
				}
				const was = keeperHold.startedMs ?? young.startedMs;
				await markKeeperLoop(job, was === young.startedMs ? [was] : [was, young.startedMs]);
				const loop = new InfraRetry(netnsKeeperCrashLoopSentence({ was, now: young.startedMs, heldMs, remedy: error.keeperRemedy }), { reason: NETNS_KEEPER_CRASH_LOOP, provider: error.provider ?? null, model: error.model ?? null, budgetReserved: false });
				recordAfterGate({ job, error: loop, startedAt, endedAt: new Date().toISOString() });
				throw loop;
			}
			if (error?.reason === NETNS_KEEPER_NOT_HOLDING && keeperHold.startedMs !== null) {
				// The keeper this job was waiting on is no longer running on its bridge: it died young, the loop's other face.
				await markKeeperLoop(job, [keeperHold.startedMs]);
				const loop = new InfraRetry(netnsKeeperCrashLoopSentence({ was: keeperHold.startedMs, now: null, problem: error.keeperProblem ?? null, heldMs: keeperHold.at - keeperHold.since, remedy: error.keeperRemedy }), { reason: NETNS_KEEPER_CRASH_LOOP, provider: error.provider ?? null, model: error.model ?? null, budgetReserved: false });
				recordAfterGate({ job, error: loop, startedAt, endedAt: new Date().toISOString() });
				throw loop;
			}
			// A LATER ATTEMPT OF A JOB THAT SAW THE LOOP (gate of PR #479). The loop's retry comes after the queue's 60 s
			// backoff, when the hold's 30 s window has closed, and it meets a keeper that restarted out of order against the
			// proxy, or none: measured, it failed as `netns-keeper-not-holding`, and that attempt's record and terminal
			// comment replaced the loop's. The marker (the keeper starts seen) is not reset by the window, so any keeper
			// failure of this job after it is still named the loop.
			const loopSeen = job.data?.netnsKeeperLoopSeen;
			if (error?.reason === NETNS_KEEPER_NOT_HOLDING && Array.isArray(loopSeen) && loopSeen.length > 0) {
				const loop = new InfraRetry(netnsKeeperLoopAgainSentence({ seen: loopSeen, problem: error.keeperProblem ?? null, remedy: error.keeperRemedy }), { reason: NETNS_KEEPER_CRASH_LOOP, provider: error.provider ?? null, model: error.model ?? null, budgetReserved: false });
				recordAfterGate({ job, error: loop, startedAt, endedAt: new Date().toISOString() });
				throw loop;
			}
			recordAfterGate({ job, error, startedAt, endedAt: new Date().toISOString() });
			if (error instanceof InfraRetry) throw error; // retryable: BullMQ retries per attempts
			// A non-retryable, non-infra error (our bug) must not retry forever. UnrecoverableError
			// records it as failed-and-distinct in the queue's failed set without a retry.
			throw new UnrecoverableError(error.message);
		} finally {
			// Release FIRST and never throw (release clamps at zero by construction): a throw here would
			// mask the job's real error, and a missed release wedges the scope until a worker restart.
			// The in-process halves go back synchronously inside each drain, before its first await.
			// AWAITED, not fire-and-forget. Two reasons, and the second is the one that bites: an unawaited
			// DEL is dropped by `shutdown`'s `process.exit(0)`, stranding the claim for its whole TTL on a
			// restart -- and the next same-scope job would otherwise race the release, be denied, and sit out a
			// full re-check interval while the slot it wanted went free behind it. The finally is already inside
			// an async function, and `release` never throws. Last taken, first given back: the endpoint holds
			// (issue #503), then the scope holds (project, then repo), then the host slot.
			const endpointsReleased = releaseEndpointHolds();
			const scopesReleased = releaseScopeHolds();
			if (hostHeld) hostBound.slots.release(HOST_SLOT_KEY);
			await endpointsReleased;
			await scopesReleased;
			clearTimeout(timer);
			clearInterval(cancelPoll);
			signal.removeEventListener("abort", onAbort);
		}
	};
}

/**
 * How long the stop of a job's cancel poll waits for a tick already in flight (gate round 4 of PR #479). About one Valkey
 * round trip under load, and far under the 30 s abort grace; past it a read still hanging cannot acknowledge anything.
 */
export const CANCEL_STOP_BOUND_MS = 1_000;

/** The comment for a job the operator cancelled before it started, where it would have been held or retried (gate of PR #479). */
export const CANCELLED_BEFORE_START_COMMENT = "Stopped: the operator cancelled this run before it started. Nothing was spent. Not retried.";

/**
 * Store the keeper starts a crash loop was seen at on the job (gate of PR #479), outside the hold's 30 s window, so a
 * later attempt that fails on the keeper is still named the loop. Fail open: a lost marker costs only the name.
 */
async function markKeeperLoop(job, seen) {
	try {
		await job.updateData({ ...job.data, netnsKeeperLoopSeen: seen.filter((ms) => Number.isFinite(ms)) });
	} catch {
		// The loop is still named on this attempt; only a later attempt's name depends on the marker.
	}
}

/**
 * A job's young-keeper hold as stored on it (issue #476): `{ at, since, startedMs }`, `at` being now. The stored start
 * and the keeper start it waited on count only while the last check was within `NETNS_KEEPER_YOUNG_HOLD_MAX_MS` of
 * now; an older one (a retry after its backoff, a paused queue) is a fresh hold with no keeper start seen.
 */
export function keeperHoldState(job, at) {
	const last = job?.data?.netnsKeeperHoldLastMs;
	const current = Number.isFinite(last) && at - last >= 0 && at - last <= NETNS_KEEPER_YOUNG_HOLD_MAX_MS;
	const since = current && Number.isFinite(job.data.netnsKeeperHoldSinceMs) ? job.data.netnsKeeperHoldSinceMs : at;
	const startedMs = current && Number.isFinite(job.data.netnsKeeperHoldStartedMs) ? job.data.netnsKeeperHoldStartedMs : null;
	return { at, since, startedMs };
}

export function createWorker({ connection, name, stopContainer, containerName, hostQueue = null, checkLease = null, scopeLease = null, checkTimeoutMs, concurrency, getSettings, redis, deps, recordRun, settledRecord = null, limiter, pauseUntil, scopedLimits, projects, allocation = null, inFlight = makeInFlight(), waitState, afterMaxMs, checkSlots = makeInFlight(), checkSlotCount, concurrencyNow, intervalMs, maxWaitMs, maxChecks, maxFaults, hostSlots = makeInFlight(), endpointSlots = makeInFlight(), endpointLease = null, modelEndpoints = null, overlayModels, extraClosers = [] }) {
	// One Worker per queue name (issue #57). A host-affine job -- one whose folder, secret resolver or wait
	// check lives on THIS machine -- is enqueued to `pi-jobs@<name>` rather than filtered for at pickup,
	// because BullMQ has no selective pop and the put-it-back alternative does not work: promotion out of
	// the delayed set is gated on each worker's own `Date.now()`, so the fastest clock wins every hop and a
	// job that had to reach another host might never get there.
	// #227. REFUSED AT CONSTRUCTION, because the alternative is discovering it 30 minutes into a runaway
	// job. `stopContainer` is the only thing that enforces REQ-JOB-TIMEOUT-30M, and it is what the backend
	// table declares as `abortable: enforced` -- a wiring that omits it would make that declaration false
	// while every test that never aborts stayed green.
	if (typeof stopContainer !== "function") {
		throw new Error("createWorker: stopContainer is required -- it is the only thing that enforces the 30-minute job timeout");
	}
	const names = hostQueue ? [QUEUE, hostQueue] : [QUEUE];
	const workers = [];

	// THE HOST-WIDE BOUND, and the reason it has to exist at all. `PI_CONCURRENCY` bounds a HOST -- its RAM
	// and its share of the provider's concurrent-stream budget (DES-CONCURRENCY-3) -- but BullMQ's own
	// concurrency is per Worker, so two Workers at 3 would run six containers. This semaphore restores the
	// bound as a property of the machine. Process memory is still the correct store, for this entry's own
	// unchanged reason: it counts THIS host's containers, and the boot reaper clears survivors before
	// draining. Armed only when a host queue exists, so a single-host deployment builds one Worker and
	// never reaches the acquire.
	const hostBound = hostQueue ? { slots: hostSlots, limit: () => liveConcurrency() } : null;
	const liveConcurrency = () => workers[0]?.concurrency ?? concurrency;

	for (const queueName of names) {
		let worker; // referenced by cancelJob/applyConcurrency before assignment; only called later, so the TDZ is fine
		const processor = makeProcessor({
			// Bound to THIS worker: a job on the host queue is cancelled by the worker draining that queue,
			// and the shared handle could not reach it.
			cancelJob: (id, reason) => worker.cancelJob(id, reason),
			// Issue #287: the name the cancel poll writes into its ack, so the operator's terminal can say
			// WHICH host took the cancel. `name` is already the registry/client identity; "" for a
			// deployment that never declared one, and the ack's reader prints it as such.
			hostName: name ?? "",
			// #227. INJECTED, not built here. This was a one-line `docker stop` literal, which meant the abort
			// path -- the only thing that can end a runaway job -- was the one backend function unreachable
			// from `startWorker`. The wiring now passes the registry's per-job stop, so the container is
			// stopped by whatever venue built it.
			stopContainer,
			containerName,
			redis,
			getSettings,
			// Late-bound over EVERY worker: an overlay concurrency change re-binds the live slot count at the
			// next job start, and with two queues both have to move or the host bound and the queue bounds
			// stop agreeing. Guarded so only an integer that actually differs touches the property.
			applyConcurrency: (n) => {
				if (!Number.isInteger(n)) return;
				for (const w of workers) if (w.concurrency !== n) w.concurrency = n;
			},
			pauseUntil,
			// SHARED across both workers, and that sharing is the point rather than an optimisation: the
			// folder mutex, the per-scope ceiling and the wait-check lease all bound the HOST, so two
			// independent maps would double every one of them exactly as two Workers double concurrency.
			scopedLimits,
			projects,
			allocation,
			inFlight,
			hostBound,
			scopeLease,
			// Issue #503: the model endpoint bound. `endpointSlots` is SHARED across both Workers for the host
			// slot's reason: it bounds this host's calls on one server, and two maps would double it.
			endpointSlots,
			endpointLease,
			modelEndpoints,
			overlayModels,
			// Issue #230. Undefined pass-throughs take makeProcessor's own defaults (a wait state over the same
			// redis client, and the shared 30-day `after` ceiling), so a bare wiring behaves like a wired one.
			waitState,
			afterMaxMs,
			// Issue #230, the polled tier. `concurrencyNow` reads the LIVE slot count rather than the boot value,
			// because the overlay can lower it through `dispatch_set` and a check must never take the last free
			// slot from a paid job.
			checkSlots,
			checkLease,
			checkSlotCount,
			checkTimeoutMs,
			concurrencyNow: concurrencyNow ?? liveConcurrency,
			intervalMs,
			maxWaitMs,
			maxChecks,
			maxFaults,
			deps,
			recordRun,
			// The run-record lookup a stalled job is checked against before it can run again (see the processor's
			// first gate). `null` in a bare wiring, which keeps today's behaviour: the job runs.
			settledRecord,
		});

		// Issue #464: only a connection `parseConnection` built, which judges and pins the Valkey it dials.
		assertJudgedConnection(connection);
		worker = new Worker(queueName, processor, {
			// maxRetriesPerRequest: null is REQUIRED for BullMQ's blocking connections, or it throws.
			connection: { ...connection, maxRetriesPerRequest: null },
			concurrency,
			maxStalledCount: 0, // a stalled paid job FAILS, never silently re-runs (verified live)
			// Issue #57. Conditional, so a bare createWorker builds a byte-identical options object -- and because
			// bullmq's own matcher accepts both the named and unnamed client-name spellings, naming costs nothing.
			...(name ? { name } : {}),
			...(limiter ? { limiter } : {}),
		});
		// Issue #468: an error of this worker is one line, its message, never BullMQ's console.error of the whole object
		// (which carried a failed AUTH's password in `command.args` before connection.mjs scrubbed it).
		onValkeyError(worker, `worker ${queueName}`);
		workers.push(worker);
	}

	const primary = workers[0];
	// The host-queue worker, for the caller that must register listeners on both. Attached rather than
	// returned as a pair so every existing caller keeps receiving exactly what it received before.
	primary.hostWorker = workers[1] ?? null;

	const stop = async () => {
		// Abort active jobs (=> docker stop via onAbort), then close. Without the cancel,
		// worker.close() would wait up to 30 minutes for the container. ONE shutdown for every queue: two
		// registrations would mean two `process.exit(0)` racing, and the second worker's containers would
		// outlive the handler that was meant to stop them.
		for (const w of workers) await Promise.resolve(w.cancelAllJobs?.("shutdown")).catch(() => {});
		for (const w of workers) await w.close().catch(() => {});
		// Close auxiliary resources (a cron scheduler, the live-edit file watchers) after the worker drains.
		// Per-item catch so one failing or absent closer never strands the others or blocks exit -- matches
		// the swallow posture on cancelAllJobs above. The try/catch is NOT redundant with the `.catch`:
		// `Promise.resolve(x)` does not catch a SYNCHRONOUS throw from `x`, and `c.close` on a null entry
		// throws before `Promise.resolve` is ever reached. Either would escape this callback, reject the whole
		// shutdown and skip the `process.exit(0)` below. Jobs and containers are already stopped by then, so
		// what a stranded loop leaks is the rest of the list: `registry.close()` is the DEL that keeps a
		// stopped host from lingering as a ghost peer for its full TTL, and a ghost peer with a stale
		// `fpCron` is what makes a later `reconcileGated` refuse a legitimate reconcile. The comment above
		// promised this isolation before the code delivered it (issue #295). It bounds nothing, though: a
		// closer that never settles still blocks exit, which no closer here does.
		//
		// Read LATE and deliberately: `start.mjs` pushes its live-edit watchers into this array AFTER handing
		// it over, because they are armed after the boot reconcile. Anything here that snapshots or copies
		// the array un-registers them in silence.
		await Promise.all(
			extraClosers.map((c) => {
				try {
					return Promise.resolve(c?.close?.()).catch(() => {});
				} catch {
					return Promise.resolve();
				}
			}),
		);
		// Release the shared ioredis client LAST (issue #300). Eight consumers ride it -- the budget, the
		// wait state, the leases, the run mirror, the host registry, the stall guard, the scope-claim sweep
		// -- and until here nothing in the product ever closed it; only the test harness did, reaching into
		// the captured wiring, which was the tell.
		//
		// SEQUENCED AFTER the drain above, never inside it. The raw client has no `.close`, so pushing it
		// into `extraClosers` is a silent no-op -- and the natural wrapper, `{ close: () => redis.disconnect() }`,
		// is worse than nothing: drained CONCURRENTLY by the Promise.all, it takes the connection down beside
		// `registry.close()`, and a recording server then received NO commands at all where this ordering
		// delivers the registry's DEL and SREM -- the DEL being what keeps a stopped host from lingering as
		// a ghost peer for its full TTL.
		//
		// `disconnect()`, not `quit()`, for a MEASURED reason rather than the plausible one. `quit()` answers
		// OK in 0ms against a REFUSED port; the hang it can suffer is a server that accepts the TCP
		// connection and never answers, where the client sits in status "connect" awaiting its ready check --
		// independent of `maxRetriesPerRequest` and of `enableOfflineQueue`, both measured. `disconnect()`
		// returns immediately in every case, and everything whose replies matter has already drained above.
		// Guarded, because the wiring tests hand createWorker a bare `redis: {}`. And wrapped, on the loop's
		// own rule stated above: a SYNCHRONOUS throw from this line would skip the `process.exit(0)` below
		// and hang the stop. The real client's disconnect does not throw; a test-injected one is one edit
		// away from doing so.
		try {
			redis?.disconnect?.();
		} catch {
			// A release that failed has already stopped mattering; the exit that follows is what a stop owes.
		}
	};
	// The signal path is `stop()` then exit, and the split is issue #299's: a boot that refuses AFTER the
	// Worker exists must be able to undo what it built WITHOUT exiting, because the refusal's own error --
	// not a 0 -- has to reach `cli.mjs`'s entryExitCode, and with every handle released above the process
	// drains to that code on its own. The closure keeps the name `shutdown` because the source pin in
	// `wiring.test.mjs` reads the registration lines below, deliberately, rather than constructing a
	// Worker to observe them.
	const shutdown = async () => {
		await stop();
		process.exit(0);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	// Windows never delivers an external SIGTERM. nssm's console-stop delivers Ctrl-C => SIGINT
	// (handled above); SIGBREAK covers console-close. Route it to the same shutdown so a stopped
	// worker still aborts in-flight jobs and docker-stops their containers rather than orphaning them.
	if (process.platform === "win32") process.once("SIGBREAK", shutdown);

	// Beside `hostWorker` and for the same reason it rides the return value rather than changing it:
	// every existing caller keeps receiving exactly what it received before, and the one new caller --
	// `startWorker`'s post-handoff catch (issue #299) -- reaches the teardown through the worker it was
	// handed. `stop` is the shutdown minus the exit; it is safe to call more than once, because every
	// step it takes is idempotent by that step's own contract.
	primary.stop = stop;

	return primary;
}

/**
 * `boundAfterAbort` with a zero grace, for tests only. The real bound is 30 seconds, which no test can wait
 * for, and the behaviour under test is what happens WHEN the grace expires -- not how long it is.
 */
export const __boundAfterAbortForTests = (run, signal, job, log) => boundAfterAbort(run, signal, job, log, 0);
