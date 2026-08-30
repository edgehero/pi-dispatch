import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DelayedError, UnrecoverableError, Worker } from "bullmq";
import { InfraRetry, runJob } from "./processor.mjs";
import { targetFor } from "./run-history.mjs";
import { budgetCapsFor, canonicalScope, concurrencyFor, makeInFlight } from "./scoped-limits.mjs";
import { WAIT_AFTER_MAX_DEFAULT_MS, WAIT_INTERVAL_FLOOR_MS, afterMs, unreadableConditions, waitArmed, waitBackoffMs, waitLabel, waitProfileNames } from "./wait-for.mjs";
import { makeWaitState } from "./wait-state.mjs";

const exec = promisify(execFile);

export const QUEUE = "pi-jobs";

/** The key the host-wide in-flight count lives under. One machine, one counter, whatever the queue. */
export const HOST_SLOT_KEY = "host";
export const JOB_TIMEOUT_MS = 30 * 60 * 1000; // REQ-JOB-TIMEOUT-30M
// The scope-busy re-check (issue #242): a held scope has no natural "until" (the holder may run to
// JOB_TIMEOUT_MS), so a deferred job re-tests on a fixed cadence. 5s keeps the worst case trivial
// (<=360 wakes across a 30-minute hold, each ~1ms of synchronous predicate briefly occupying a slot)
// while a same-folder CHAINED job -- enqueued by its parent before the parent's finally releases the
// folder -- pays exactly one re-check, not fifteen seconds of dead air. No jitter: one worker per
// docker daemon bounds any herd by its own concurrency, and a contended wake just re-defers.
export const SCOPE_BUSY_RECHECK_MS = 5_000;

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
 * Build the BullMQ processor.
 *
 * It MUST declare exactly three parameters (job, token, signal). BullMQ only allocates an
 * AbortController when `processor.length >= 3` (it inspects the function's arity at construction),
 * so dropping the unused `token` would silently disable BOTH the 30-minute timeout and the shutdown
 * abort -- with no error. A test asserts the arity precisely because the failure is silent.
 *
 * Dependencies are injected so this is testable without a live queue: `cancelJob` (fired by the
 * timeout), `stopContainer` (fired by the abort), and the orchestration deps.
 *
 * Once per job, before runJob, it resolves the runtime-settings overlay via `getSettings`
 * (INT-CONFIG-OVERLAY-CONTRACT). A present-but-invalid overlay resolves to a POLICY refusal RETURNED
 * (never thrown), so BullMQ marks the job completed without a retry (CONST-RETRY-INFRA-ONLY). A valid
 * overlay fills the effective `provider`/`model`/`maxTurns`/`dailyCap`/`weeklyCap`/`monthlyCap`/`softHoldPct`
 * under `job.data > overlay > env` precedence and re-binds the worker slot count via `applyConcurrency`.
 * The overlay changes which values the spend caps take, never when they are checked -- reserveBudget still
 * runs inside runJob against the freshly passed caps (CONST-BUDGET-BEFORE-TOKENS).
 */
export function makeProcessor({ cancelJob, stopContainer, redis, getSettings, applyConcurrency = () => {}, pauseUntil = () => null, scopedLimits = () => [], inFlight = makeInFlight(), hostBound = null, deps, recordRun = () => {}, timeoutMs = JOB_TIMEOUT_MS, now = () => Date.now(), waitState = makeWaitState({ redis, now }), afterMaxMs = () => WAIT_AFTER_MAX_DEFAULT_MS, checkSlots = makeInFlight(), checkSlotCount = () => 1, concurrencyNow = () => 3, intervalMs = () => WAIT_INTERVAL_FLOOR_MS * 2, maxWaitMs = () => 24 * 3600 * 1000, maxChecks = () => 96, maxFaults = () => 5, random = Math.random }) {
	return async function processor(job, token, signal) {
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
		// INT-SCOPED-LIMITS-FILE-CONTRACT). LAST of the three gates, after the pause gate (a paused job must
		// not burn re-check wakes) and after the wait gate (a job holding until tomorrow must not sit on a
		// folder while it does), and STRICTLY above the `try` below, like the pause gate and for the same two
		// reasons: a DelayedError thrown inside the try would be converted to UnrecoverableError by the
		// catch, and a moveToDelayed rejection here must escape RAW into BullMQ's normal failed-attempt
		// handling exactly as the pause gate's does (inside the try it would become a permanent failure
		// plus a failure record for what was a transient blip). The limits snapshot is read ONCE here and
		// shared with `scopedCaps` below, so the gate and the money ledger cannot disagree mid-job.
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
		const scope = canonicalScope(job.data);
		let held = false;
		if (scope) {
			if (!inFlight.tryAcquire(scope, concurrencyFor(job.data, limits))) {
				// Optional-chained: makeProcessor gives `deps` no default and bare wirings pass deps: {}.
				// The scope itself stays out of the log line (no-pii-in-logs -- a local scope is a full
				// host path); the delayed count and the job id are what an operator needs to see it.
				deps?.log?.("scope_busy_deferred", { jobId: job.id, kind: job.data?.kind === "local" ? "local" : "forge", delayMs: SCOPE_BUSY_RECHECK_MS });
				// The host slot goes back before we defer: `makeInFlight().release` is not idempotent, so a slot
				// held across a deferral would be a slot this machine never gets back.
				if (hostHeld) {
					hostBound.slots.release(HOST_SLOT_KEY);
					hostHeld = false;
				}
				await job.moveToDelayed(nowMs + SCOPE_BUSY_RECHECK_MS, token);
				throw new DelayedError();
			}
			held = true;
		}

		let startedAt;
		let name;
		let timer;
		let onAbort;
		try {
			// Nothing between the acquire above and the main `try` below may throw unguarded: the releasing
			// finally belongs to THAT try, so an unguarded throw here would leak the hold and wedge the
			// scope until a worker restart. Nothing in this block CAN throw today (setTimeout and
			// addEventListener on the bullmq-allocated controller are total at processor arity 3); the
			// guard is structural, not observational.
			startedAt = new Date().toISOString();
			name = `pi-job-${job.id}`;
			timer = setTimeout(() => {
				// BullMQ has no per-job kill timer; this is ours. cancelJob raises the AbortSignal.
				Promise.resolve(cancelJob(job.id, "job-timeout-30m")).catch(() => {});
			}, timeoutMs);

			// Abort (timeout OR shutdown) => stop the container. docker stop sends SIGTERM then SIGKILL
			// after the grace period; the runner exits and runContainer returns/throws.
			onAbort = () => {
				Promise.resolve(stopContainer(name)).catch(() => {});
			};
			signal.addEventListener("abort", onAbort, { once: true });
		} catch (error) {
			// Release and CLEAR the flag: this throw never reaches the main finally below, but a shared
			// scope must never be releasable twice -- a double release frees another holder's slot.
			if (held) {
				inFlight.release(scope);
				held = false;
			}
			if (hostHeld) {
				hostBound.slots.release(HOST_SLOT_KEY);
				hostHeld = false;
			}
			clearTimeout(timer);
			throw error;
		}

		try {
			const settings = await getSettings();
			if (settings.invalid) {
				// A present-but-invalid overlay is a POLICY refusal, RETURNED (never thrown) so BullMQ marks the
				// job completed and does not retry a file that can never parse (CONST-RETRY-INFRA-ONLY). Resolved
				// before runJob, so no budget slot is reserved and no container starts (CONST-BUDGET-BEFORE-TOKENS).
				// recordRun leaves the durable settings-overlay-invalid trace for the admin extension.
				// No provider/model here, as in every result this function returns from ABOVE the try (the wait gate's
				// refusals are the others): each is decided before or during the settings read, so no honest effective
				// value exists yet -- buildRecord defaults both null.
				const result = { outcome: "policy", reason: "settings-overlay-invalid", exitCode: null, turns: null, tokens: null, budgetReserved: false };
				recordRun({ job, result, startedAt, endedAt: new Date().toISOString() });
				return result;
			}

			// Re-bind the worker slot count to the effective concurrency before the run (no-op default when
			// unwired, e.g. a bare makeProcessor under test).
			applyConcurrency(settings.concurrency);

			// Fill the effective job settings under `job.data > overlay > env` precedence: an explicit per-job
			// field wins; an omitted one takes the overlay value, else env, resolved at this job's start
			// (INT-CONFIG-OVERLAY-CONTRACT). Receiver GitHub jobs carry no provider/model/maxTurns, so this fill
			// supplies the provider the container env allowlist requires -- absent it, the allowlist refuses a job
			// only after its budget slot is reserved. The `caps`/`softHoldPct` passed to runJob change which
			// values reserveBudget checks, never when it runs.
			const effectiveJob = {
				...job.data,
				provider: job.data.provider ?? settings.provider,
				model: job.data.model ?? settings.model,
				maxTurns: job.data.maxTurns ?? settings.maxTurns,
				maxTokens: job.data.maxTokens ?? settings.maxTokens, // optional per-job token budget (issue #25); null => runner meter only
			};

			const result = await runJob(effectiveJob, {
				redis,
				// The three spend windows (week/month null when disabled) and the soft-hold band, resolved this
				// job-start under overlay > env. reserveBudget checks them before the container.
				caps: { day: settings.dailyCap, week: settings.weeklyCap, month: settings.monthlyCap },
				softHoldPct: settings.softHoldPct,
				// The daily TOKEN cap (issue #25), same overlay > env resolution. Check-AFTER, so it gates the
				// NEXT job on prior recorded spend; null => the daily token counter is disabled.
				tokenCap: settings.dailyTokenCap,
				// This job's scoped budget windows (issue #242), from the SAME limits snapshot the pickup
				// gate above read -- one read per pickup, so gate and ledger agree for this job's whole
				// life. Null when no row carries a money window for this scope.
				scopedCaps: budgetCapsFor(job.data, limits),
				...deps,
				runContainer: (ctx) => deps.runContainer({ ...ctx, name, signal }),
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
				// prepareWorkspace needs the REAL BullMQ job's `.id` to derive a cron job's scheduled-for
				// instant from the deterministic repeat:<id>:<millis> jobId (DES-CRON-VIA-BULLMQ-SCHEDULER)
				// for the local /job/event.json. runJob's own `job` is the effectiveJob -- a spread of
				// job.data with no `.id` -- and the real wrapper is only in scope here, so inject it as
				// `queueJobId`, mirroring the collectChain injection above. Omitted when unwired so a bare
				// processor keeps runJob's plain (job, token) call.
				...(deps.prepareWorkspace ? { prepareWorkspace: (j, t) => deps.prepareWorkspace(j, t, { queueJobId: job.id }) } : {}),
				// The one-shot pre-spend check (issue #231) needs the REAL BullMQ job's `.id` to excuse this
				// delivery's own earlier attempt -- runJob's effectiveJob has no `.id`, prepareWorkspace's
				// own injection above states why, and this one mirrors it. Omitted when unwired so a bare
				// processor keeps runJob's admit-everything default.
				...(deps.checkOnceSpent ? { checkOnceSpent: (j) => deps.checkOnceSpent(j, { queueJobId: job.id }) } : {}),
			});
			recordRun({ job, result, startedAt, endedAt: new Date().toISOString() });
			return result;
		} catch (error) {
			recordRun({ job, error, startedAt, endedAt: new Date().toISOString() });
			if (error instanceof InfraRetry) throw error; // retryable: BullMQ retries per attempts
			// A non-retryable, non-infra error (our bug) must not retry forever. UnrecoverableError
			// records it as failed-and-distinct in the queue's failed set without a retry.
			throw new UnrecoverableError(error.message);
		} finally {
			// Release FIRST and never throw (release clamps at zero by construction): a throw here would
			// mask the job's real error, and a missed release wedges the scope until a worker restart.
			if (held) inFlight.release(scope);
			if (hostHeld) hostBound.slots.release(HOST_SLOT_KEY);
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	};
}

export function createWorker({ connection, name, hostQueue = null, concurrency, getSettings, redis, deps, recordRun, limiter, pauseUntil, scopedLimits, inFlight = makeInFlight(), waitState, afterMaxMs, checkSlots = makeInFlight(), checkSlotCount, concurrencyNow, intervalMs, maxWaitMs, maxChecks, maxFaults, hostSlots = makeInFlight(), extraClosers = [] }) {
	// One Worker per queue name (issue #57). A host-affine job -- one whose folder, secret resolver or wait
	// check lives on THIS machine -- is enqueued to `pi-jobs@<name>` rather than filtered for at pickup,
	// because BullMQ has no selective pop and the put-it-back alternative does not work: promotion out of
	// the delayed set is gated on each worker's own `Date.now()`, so the fastest clock wins every hop and a
	// job that had to reach another host might never get there.
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
			stopContainer: (name) => exec("docker", ["stop", "-t", "5", name]),
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
			inFlight,
			hostBound,
			// Issue #230. Undefined pass-throughs take makeProcessor's own defaults (a wait state over the same
			// redis client, and the shared 30-day `after` ceiling), so a bare wiring behaves like a wired one.
			waitState,
			afterMaxMs,
			// Issue #230, the polled tier. `concurrencyNow` reads the LIVE slot count rather than the boot value,
			// because the overlay can lower it through `dispatch_set` and a check must never take the last free
			// slot from a paid job.
			checkSlots,
			checkSlotCount,
			concurrencyNow: concurrencyNow ?? liveConcurrency,
			intervalMs,
			maxWaitMs,
			maxChecks,
			maxFaults,
			deps,
			recordRun,
		});

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
		workers.push(worker);
	}

	const primary = workers[0];
	// The host-queue worker, for the caller that must register listeners on both. Attached rather than
	// returned as a pair so every existing caller keeps receiving exactly what it received before.
	primary.hostWorker = workers[1] ?? null;

	const shutdown = async () => {
		// Abort active jobs (=> docker stop via onAbort), then close. Without the cancel,
		// worker.close() would wait up to 30 minutes for the container. ONE shutdown for every queue: two
		// registrations would mean two `process.exit(0)` racing, and the second worker's containers would
		// outlive the handler that was meant to stop them.
		for (const w of workers) await Promise.resolve(w.cancelAllJobs?.("shutdown")).catch(() => {});
		for (const w of workers) await w.close().catch(() => {});
		// Close auxiliary resources (e.g. a cron scheduler) after the worker drains. Per-item catch
		// so one failing or absent closer never strands the others or blocks exit -- matches the
		// swallow posture on cancelAllJobs above.
		await Promise.all(extraClosers.map((c) => Promise.resolve(c.close?.()).catch(() => {})));
		process.exit(0);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
	// Windows never delivers an external SIGTERM. nssm's console-stop delivers Ctrl-C => SIGINT
	// (handled above); SIGBREAK covers console-close. Route it to the same shutdown so a stopped
	// worker still aborts in-flight jobs and docker-stops their containers rather than orphaning them.
	if (process.platform === "win32") process.once("SIGBREAK", shutdown);

	return primary;
}
