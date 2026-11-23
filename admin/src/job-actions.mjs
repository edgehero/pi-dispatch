import { mergePolicyDigest } from "@edgehero/pi-dispatch/merge-policy";
import { makeTouchStore, touchScopeOf } from "@edgehero/pi-dispatch/touch-state";
import { validLocalEvent } from "@edgehero/pi-dispatch/local-event";
import { makeLocalEventStore } from "@edgehero/pi-dispatch/local-event-store";
import { trackTouchAction } from "@edgehero/pi-dispatch/touch-outbox";
/**
 * The job actions the operator console adds to what the `/dispatch` TUI and the tools can do (issue #642): retry and
 * remove a failed job, the same in bulk, re-run a finished run, and answer a parked run from the browser.
 *
 * Reached through `read-model.mjs`, which re-exports every name here, so "the read model is the admin's one data-access
 * surface" stays true for every caller; this file exists only because that one had grown past the point where a new
 * family of functions could be reviewed inside it. Issue #646 adds one more: a message into a running,
 * steer-armed job (`planSteer`/`enqueueSteer`) and taking one back (`planSteerWithdraw`/`withdrawSteerMessage`).
 * Issue #737 adds cancelling a queued job that never started (`planCancelQueued`/`cancelQueuedJob`).
 *
 * THE SHAPE OF EVERY ACTION. A PLAN, then an APPLY, so the console can show an operator exactly what will happen before
 * they confirm, and bind its ticket to it:
 *   - a plan is free and writes nothing: `{ plan }` or `{ refusal }`, the refusal naming why in words an operator can act
 *     on (expired data, a `/command` run, a run that is not parked, ...);
 *   - the apply re-checks what can have changed since (a failed job's attempt count and finish time, a folder's tree)
 *     and refuses "it changed since the preview" rather than acting on something the operator did not see.
 *
 * REUSE, NEVER RE-DERIVE (this package's rule): the queue's own producers (`enqueueLocalJobReporting`,
 * `enqueueTriggerRunReporting`, `enqueueForgeJob`), the worker's cron loader (`loadSchedules`), the receiver's routing
 * rule (`jobNeeds`/`routeForgeJob`, capabilities.mjs, which `receiver/src/route.mjs` also calls), the worker's reserve
 * rule (`estimateReserve`) and the console answer's bound (`boundAnswerText`). Nothing here spells a key, a job id or a
 * routing decision of its own.
 */

import * as nodeFs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { parseConnection, makeRedisClient, VALKEY_COMMAND_TIMEOUT_MS } from "@edgehero/pi-dispatch/connection";
import { makeAnswerDraftStore } from "@edgehero/pi-dispatch/answerer";
import { makeApprovalStore } from "@edgehero/pi-dispatch/approval-state";
import { QUEUE, makeQueue, closeWithin, consoleQueueConnection, enqueueForgeJob, enqueueLocalJobReporting, enqueueTriggerRunReporting, forgeDeliveryJobId, hostQueueName, swallowedRunSentence } from "@edgehero/pi-dispatch/queue";
import { jobNeeds, routeForgeJob } from "@edgehero/pi-dispatch/capabilities";
import { loadSchedules } from "@edgehero/pi-dispatch/schedules";
import { parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { forgeTriggerMismatch } from "@edgehero/pi-dispatch/trigger-identity";
import { targetFor } from "@edgehero/pi-dispatch/run-history";
import { isForgeKind } from "@edgehero/pi-dispatch/forges";
import { mergeRuns, readMirroredRuns } from "@edgehero/pi-dispatch/run-mirror";
import { gitDirty, localRepoProblem } from "@edgehero/pi-dispatch/git-dirty";
import { estimateReserve } from "@edgehero/pi-dispatch/reserve-estimate";
import { boundAnswerText, consoleAnswerBy, PANEL_ANSWER_BY } from "@edgehero/pi-dispatch/console-answer";
import { runIdOf } from "@edgehero/pi-dispatch/recovery-queue";
import * as steerInbox from "@edgehero/pi-dispatch/steer-inbox";
import { parkedVerdictOf } from "@edgehero/pi-dispatch/chat-mode";
import { removeQueuedJob } from "@edgehero/pi-dispatch/cancel-state";
import { identityForModelSelection, keepModelSelection } from "@edgehero/pi-dispatch/model-selection-state";
import { keepModelAttempt, modelAttemptIdOf } from "@edgehero/pi-dispatch/model-attempts";
import { jobKey } from "@edgehero/pi-dispatch/wait-state";
import { MANUAL_JOB_PREFIX, QUEUE_KEY, SCHEDULER_ID_RE, SCHEDULER_JOB_PREFIX, cronRunOf, isSchedulerNext, queueKeyOf } from "@edgehero/pi-dispatch/bullmq-internals";
import { scrubControls } from "./panel.mjs";
import { activeJobOfRun, makeLocalRunIndex, PENDING_SCAN_BUDGET, QUEUE_CLOSE_TIMEOUT_MS, readFleetQueues, readPendingAnswer, readRunById, readWaitingRow, RUN_RECORD_UNREAD, targetKeyOf, WAITING_STATES } from "./read-model.mjs";
import { RECORD_REASON_RE, recordReason } from "./words.mjs";
import { fromNewerRelease, shownRecord } from "./newer-release.mjs";
import { jobDataNewer } from "@edgehero/pi-dispatch/job-data-version";
import { FORGE_JOB_RETENTION_DAYS, FORGE_JOB_RETENTION_MS, LOCAL_JOB_KEPT_COMPLETED_S, LOCAL_JOB_KEPT_FAILED_S } from "@edgehero/pi-dispatch/retention";

/** The most jobs one bulk action names, and so the most one preview lists (issue #642). */
export const BULK_MAX = 100;

/** How many failed jobs a bulk plan examines per queue at most, so a deployment with a huge failed set stays bounded. */
const FAILED_EXAMINE_MAX = 2000;
const FAILED_PAGE = 200;

/**
 * How long a failed-job preview's reads may take in all (issue #842). Larger than a one-job plan's (`timeoutMs`): with a
 * repository filter it may page `FAILED_EXAMINE_MAX` jobs out of every queue, which a healthy deployment takes seconds
 * over. The same ten seconds the fleet snapshot's previews wait.
 */
export const FAILED_PLAN_TIMEOUT_MS = 10_000;

/**
 * How long a steer preview's reads (the job, its state, its inbox) may take in all (issue #842): each is one small
 * read, so this is the command bound of the clients they go through.
 */
export const STEER_PLAN_TIMEOUT_MS = VALKEY_COMMAND_TIMEOUT_MS;

/**
 * How long a failed-job confirm's reads of one job (the lookup and its state) may take before its write (issue #842).
 * Past the queue client's command bound on purpose: a read that was sent ends at that bound by itself, and this decides
 * only a queue that is not connected yet.
 */
export const CONFIRM_READ_TIMEOUT_MS = VALKEY_COMMAND_TIMEOUT_MS + 1_000;

/**
 * How long the preview of a paid start (a re-run, a parked answer, Fire now) may take in all (issue #961): its reads
 * have a bound each, and a queue built while Valkey takes connections and answers none takes over half a minute to give
 * up, so the preview is one step with this end (`planCancelQueued`'s pattern).
 */
export const PAID_PLAN_TIMEOUT_MS = CONFIRM_READ_TIMEOUT_MS;

/** The newest runs a parked-answer plan reads to judge "already answered": the fleet reader's wide window. */
const ANSWERED_WINDOW = 1000;

/** How a job id is spelled in a run record and a queue (read-model's RUN_ID_RE). */
const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * A comment delivery as each forge's receiver arm spells it in `trigger` (issue #642): the event and action words the
 * filter copies off the delivery, and whether the comment carries an author association (GitHub alone sends one). The
 * receiver's own tests pin these words (filter*.test.mjs); admin/test/job-actions.test.mjs builds a receiver reply and a
 * console one for the same issue and compares them field for field, which is what holds this table to the filters.
 */
const COMMENT_DELIVERY = Object.freeze({
  github: { event: "issue_comment", action: "created", association: true },
  forgejo: { event: "issue_comment", action: "created", association: false },
  gitlab: { event: "note", action: "create", association: false },
  azure: { event: "workitem.commented", action: "commented", association: false },
});

/**
 * The association a console answer carries on GitHub. The receiver admits a comment only from OWNER, MEMBER or
 * COLLABORATOR (its comment gate), and an operator holding a console token is the deployment's own authority, the
 * strongest of the three; who it really was rides beside it as `console.by` and in the trail comment the worker posts.
 */
const CONSOLE_ASSOCIATION = "OWNER";

/** A fresh delivery id for a job the console makes: never a forge's, so `forgeDeliveryJobId` cannot collide with one. */
function consoleDeliveryId(random = randomBytes) {
  return `console-${random(8).toString("hex")}`;
}

/**
 * Open the fleet's queues lazily over one discovery (`readFleetQueues`: the live registry unioned with the queues that
 * exist, the kill switch's set). `find(jobId)` asks each queue in turn, the first that knows the id owning it, as
 * `pi-dispatch cancel` does: ids are unique across queues by construction. `close()` closes every queue opened since the
 * last `close()`, all at once, and resolves once each has settled (never rejects). BullMQ's close QUITs each connection
 * and waits for the answer, which a Valkey that stopped answering on an open socket never sends, so each close has
 * `QUEUE_CLOSE_TIMEOUT_MS` and its connection is dropped past it (`closeWithin`, issue #842); a caller that owes its
 * answer within a bound starts the close and does not wait on it even so.
 *
 * Every queue is the console's bounded kind (`consoleQueueConnection`): a command a Valkey took and never answered ends
 * at the bound, with `valkeyMayStillRun` on its error. A READ's error carries that mark as a write's does, so only the
 * step that writes may read it as "may or may not have been made".
 */
async function openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs }) {
  const { names, blind, blindPartial, hosts, incomplete } = await readFleetQueues({ url, redisFn, timeoutMs });
  const opened = new Map();
  const queueOf = (name) => {
    if (!opened.has(name)) opened.set(name, queueFn(consoleQueueConnection(url, parseConnectionFn), { name }));
    return opened.get(name);
  };
  return {
    names,
    blind,
    // Whether `blind` is a registry read in part (issue #1062): some host rows not read in time, the rest read.
    blindPartial: blindPartial === true,
    // Whether the keyspace scan behind `names` did not finish (`readFleetQueues`): a host queue may be missing from them.
    incomplete: incomplete ?? null,
    hosts,
    queueOf,
    // `getJob` by id, never a scan of a listing, so a job is found however far down its queue's failed set it sits (the
    // bulk preview's newest-100 window bounds what a PREVIEW lists, never what an id can act on). `hint` (a fleet
    // queue, e.g. the preview's `queue`) is asked first; the rest follow, so a stale hint costs a lookup, not a miss.
    async find(jobId, hint = null) {
      const order = typeof hint === "string" && names.includes(hint) ? [hint, ...names.filter((n) => n !== hint)] : names;
      for (const name of order) {
        const job = await queueOf(name).getJob(jobId);
        if (job) return { job, queue: name };
      }
      return null;
    },
    close() {
      const queues = [...opened.values()];
      opened.clear();
      return Promise.all(queues.map((q) => closeWithin(q, QUEUE_CLOSE_TIMEOUT_MS)));
    },
  };
}

/**
 * The words for a job no fleet queue knows, naming a blind registry when there is one, or one read in part (issue
 * #1062, `blindPartial`). The registry read's own error is never in them: it is a client's, which can name a host, and
 * this sentence reaches a page and the audit.
 */
function notInFleet(jobId, fleet, action = null) {
  const blind = !fleet.blind ? "" : fleet.blindPartial ? " (the host registry was read in part; a host whose row was not read may still hold it)" : " (the host registry could not be read; a host that is not registered may still hold it)";
  if (action !== null) return `${action}: no job in ${fleet.names.length} ${fleet.names.length === 1 ? "queue" : "queues"}${blind}; job ${jobId}`;
  return `no job ${jobId} in ${fleet.names.length} ${fleet.names.length === 1 ? "queue" : "queues"}${blind}`;
}

/** A failed job's identity for a preview and a re-check: the attempts made and the finish instant. */
function failedFingerprint(job) {
  return { attemptsMade: Number.isInteger(job?.attemptsMade) ? job.attemptsMade : 0, finishedOn: Number.isFinite(job?.finishedOn) ? job.finishedOn : null };
}

/** `targetFor` that never throws (a hand-built queue entry with no kind has none). */
function targetOf(data) {
  try {
    return targetFor(data?.kind, data ?? {});
  } catch {
    return null;
  }
}

/**
 * Re-check one failed job against its preview and act on it: the shared body of the single and bulk actions. `found` is
 * `fleet.find`'s answer and `state` the job's state as `failedBulk` read it. A state that could not be read never gets
 * here (issue #842): it used to read as "unknown", which answered "it is unknown now, not failed; it changed since the
 * preview" of a job nothing was known about. Refuses unless the job is still `failed` with the previewed `attemptsMade` and `finishedOn`
 * ("it changed since the preview": retried, removed, or failed again since).
 */
async function actOnFailed(found, state, jobId, expect, act) {
  if (!found) return { invalid: `Nothing was done: it changed since the preview (it was removed or retried and finished); job ${jobId}` };
  if (state !== "failed") return { invalid: `Nothing was done: it is ${state} now, not failed; it changed since the preview; job ${jobId}` };
  const now = failedFingerprint(found.job);
  if (now.attemptsMade !== expect.attemptsMade || now.finishedOn !== expect.finishedOn) {
    return { invalid: `Nothing was done: it failed again since the preview (it changed since the preview); look again; job ${jobId}` };
  }
  const result = await act(found.job);
  if (result?.invalid) return result;
  return { ok: true, jobId, queue: found.queue, ...(result?.touchWarning ? { touchWarning: result.touchWarning } : {}) };
}

/** The `expect` a retry or remove must carry, or the refusal for one that does not. */
function expectProblem(expect) {
  if (expect === null || typeof expect !== "object") return "the preview's attemptsMade and finishedOn are required";
  if (!Number.isInteger(expect.attemptsMade) || expect.attemptsMade < 0) return "expect.attemptsMade must be a non-negative integer";
  if (expect.finishedOn !== null && !Number.isFinite(expect.finishedOn)) return "expect.finishedOn must be a number or null";
  return null;
}

/**
 * Retry ONE failed job (issue #642), wherever in the fleet it is: BullMQ's own `job.retry()`, which moves it back to
 * waiting, so the worker runs it again with every pre-spend gate (it is a paid action, and the console says so). The job
 * KEEPS the attempts it made: bullmq 5.80.4's `reprocessJob` drops `atm` only when asked to (`resetAttemptsMade`), and
 * this asks for nothing. That is why a retried job is never one `cancel-queued` removes (`planCancelQueued` refuses a job
 * that has made an attempt), and why Retry's Undo is a sentence rather than an action (issue #737).
 * `expect` is `{ attemptsMade, finishedOn }` from the preview. Returns `{ ok: true, jobId, queue }`,
 * `{ invalid }` (not found, not failed, changed since the preview), or `{ unreachable }`.
 *
 * The residual, stated: between the re-check and the call, the job can only leave `failed` by another operator's
 * retry or remove, and BullMQ's retry itself refuses a job no longer in the failed set (its Lua checks), which comes back
 * as `{ unreachable }` with BullMQ's words.
 *
 * Found by id with `getJob` on every fleet queue, `queue` (the preview's, optional) first: a job far below the bulk
 * preview's newest-100 window is still found and acted on.
 *
 * The job's model attempt key (issue #812) keeps no expiry after the retry: `retryKeepingAttempt`.
 */
export async function retryFailedJob({ url, jobId, expect, queue = null, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500, readTimeoutMs = CONFIRM_READ_TIMEOUT_MS, touchStore = null, touchOutbox = null, now = Date.now } = {}) {
  return (await failedBulk({ url, jobs: [{ jobId, ...(expect ?? {}), queue, expectGiven: expect }], redisFn, queueFn, parseConnectionFn, timeoutMs, readTimeoutMs, touchStore, touchOutbox, now, touchCause: "rerun", what: "retry", act: (job, redis) => retryKeepingAttempt(job, redis, timeoutMs) })).single;
}

/**
 * BullMQ's retry of a failed job, then its model attempt key kept (issue #812, worker model-attempts.mjs). The failure
 * gave the key an expiry (`MODEL_ATTEMPT_FINISHED_TTL_MS`), and only the processor's next model selection writes it
 * again without one; until then the retried job can wait for any time (a paused queue or pause window, a busy scope, a
 * hold for a newer release), and a key that expired meanwhile refuses it `model-failover-no-candidate`. So the expiry is
 * taken off (`PERSIST`, bounded by `timeoutMs`, never a throw) once BullMQ has put the job back, never before: a retry
 * BullMQ refuses leaves the failed job's key to its expiry. The id is the processor's, the job's queue name and id. The
 * client is the job's queue's own, the one the retry was sent on, so the `PERSIST` follows it. The residuals, stated: a
 * `PERSIST` that fails leaves the expiry, as before this; one the processor's selection beats is a no-op (that write
 * already kept none); and a job that ran and finished inside the one round trip between the two is left without the
 * expiry its finish gave it.
 */
export const LOCAL_EVENT_RETRY_REFUSAL = "A finished local event generation cannot be retried. Wait for a fresh matching forge event or use a reviewed cron fallback.";

async function retryKeepingAttempt(job, redis, timeoutMs) {
  await job.retry("failed");
  if (typeof job?.queueName !== "string" || job.queueName === "") return;
  await keepModelAttempt(redis, modelAttemptIdOf(job.queueName, job.id), timeoutMs);
  const selectionId = identityForModelSelection(job, { queueName: job.queueName });
  if (selectionId !== null) {
    // The retry is already queued. Keeping evidence is best effort as for the legacy attempt key;
    // missing evidence still refuses at pickup, it never authorizes another draw.
    await within(keepModelSelection(redis, selectionId).catch(() => false), timeoutMs, () => false);
  }
}

/**
 * Remove ONE failed job (issue #642): BullMQ's `job.remove()`, after the same re-check as `retryFailedJob`. The run
 * records its attempts wrote stay (INT-RUN-HISTORY-FILE-CONTRACT: a record is a terminal state, and removing the queue's
 * copy does not unmake it). Returns `retryFailedJob`'s shapes.
 *
 * The residual, stated: `remove` does not check the state itself, so a retry by another session in the microseconds
 * between the re-check and the call would be removed as waiting. Two sessions acting on one job at once is the case,
 * and the audit log names both.
 */
export async function removeFailedJob({ url, jobId, expect, queue = null, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500, readTimeoutMs = CONFIRM_READ_TIMEOUT_MS, localEventStoreFn = makeLocalEventStore } = {}) {
  return (await failedBulk({ url, jobs: [{ jobId, ...(expect ?? {}), queue, expectGiven: expect }], redisFn, queueFn, parseConnectionFn, timeoutMs, readTimeoutMs, what: "removal", act: (job, redis) => removeFailedSettled(job, redis, timeoutMs, localEventStoreFn) })).single;
}

/** The reconciler needs the terminal queue entry until its generation is settled. Deleting first strands an active
 * signal as a missing queue job. Settlement is idempotent by generation; an uncertain reply leaves the entry for the
 * reconciler or another removal, and reports that the successor may already have been released. */
async function removeFailedSettled(job, redis, timeoutMs, localEventStoreFn) {
  const meta = job.data?.localEvent;
  if (meta === undefined) return job.remove();
  if (!validLocalEvent(meta)) return { invalid: "The local event identity is unreadable; reconcile its signal state before removing the failed job." };
  if (!redis) return { invalid: "The local event signal store is unavailable; the failed job was kept. Try again when Valkey is reachable." };
  let settled;
  try {
    settled = await within(Promise.resolve().then(() => localEventStoreFn({ redis }).finish(meta, { discard: meta.once === true })), timeoutMs, () => null);
  } catch {
    settled = null;
  }
  if (settled?.ok !== true && settled?.stale !== true) return { invalid: jobLast("signal settlement is unconfirmed; failed job kept; its successor may be ready; try removal again", job.id), partial: true };
  try {
    const removed = await within(Promise.resolve().then(() => job.remove()).then(() => true), timeoutMs, () => false);
    if (removed) return;
  } catch {
    // Settlement has already changed state, even when the queue's removal did not answer.
  }
  return { invalid: jobLast("signal settled; queue removal is unconfirmed; look at the fleet and try removal again", job.id), partial: true };
}

/**
 * Retry every job a bulk preview listed (issue #642): `jobs` is `planFailedBulk`'s list (`[{ jobId, attemptsMade,
 * finishedOn }]`, at most `BULK_MAX`). Each is re-checked and acted on alone, so one that changed is refused and the rest
 * still go: `{ results: [{ jobId, ok: true, queue } | { jobId, invalid }] }`, in the list's order, or `{ invalid }` for a
 * list that is not one, or `{ unreachable }` when the fleet could not be read at all.
 */
export async function retryFailedJobs({ url, jobs, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500, readTimeoutMs = CONFIRM_READ_TIMEOUT_MS, touchStore = null, touchOutbox = null, now = Date.now } = {}) {
  return bulkOf(await failedBulk({ url, jobs: listOf(jobs), redisFn, queueFn, parseConnectionFn, timeoutMs, readTimeoutMs, touchStore, touchOutbox, now, touchCause: "rerun", what: "retry", act: (job, redis) => retryKeepingAttempt(job, redis, timeoutMs) }));
}

/** Remove every job a bulk preview listed (issue #642), `retryFailedJobs`' shapes and per-job re-check. */
export async function removeFailedJobs({ url, jobs, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500, readTimeoutMs = CONFIRM_READ_TIMEOUT_MS, localEventStoreFn = makeLocalEventStore } = {}) {
  return bulkOf(await failedBulk({ url, jobs: listOf(jobs), redisFn, queueFn, parseConnectionFn, timeoutMs, readTimeoutMs, what: "removal", act: (job, redis) => removeFailedSettled(job, redis, timeoutMs, localEventStoreFn) }));
}

/** A bulk list as `failedBulk` takes it, every entry's expect given; a non-array or an oversized one is refused there. */
function listOf(jobs) {
  if (!Array.isArray(jobs)) return null;
  return jobs.map((j) => ({ jobId: j?.jobId, attemptsMade: j?.attemptsMade, finishedOn: j?.finishedOn, queue: j?.queue ?? null, expectGiven: j }));
}

function bulkOf(res) {
  if (res.invalid || res.unreachable) return res.invalid ? { invalid: res.invalid } : { unreachable: res.unreachable };
  return { results: res.results };
}

/**
 * A failed job's retry or removal (`what`) that was sent and not answered within the queue client's bound (issue #842):
 * Valkey may run it when it wakes, or ran it before its answer was lost, so `partial`, the outcome first and the id last,
 * and never the client's own words.
 */
export const failedActUnconfirmed = (what, jobId) => ({ invalid: jobLast(`the ${what} may or may not have been made: Valkey took it and did not answer within the bound; look at the fleet once Valkey answers`, jobId), partial: true });

/** A bulk list's job that was left alone because Valkey stopped answering at a job before it (issue #842). */
export const failedActNotTried = (jobId) => ({ jobId, invalid: jobLast("not tried: Valkey stopped answering at an earlier job of this action, so this one was left alone; nothing was changed for it", jobId) });

/** Whether `err` is an answer Valkey never gave: the bounded client's timeout, or a command lost on its connection. */
const answerLost = (err) => err?.valkeyMayStillRun === true || err?.code === "ETIMEDOUT";

/**
 * The one body behind the four failed-job actions: one fleet discovery, one re-check and one act per job, every queue
 * closed after. `single` is the first result for the single-job spellings. Retries and local event removals receive
 * the job's queue's client beside the job.
 *
 * No timer of its own around the write (issue #842): the queues' clients bound each command, and a timer that fired
 * first could only say less. A job whose answer was lost says which step lost it: a read before the act changed
 * nothing (`unreachable`), the act itself may or may not have been made (`failedActUnconfirmed`). Either way the list
 * STOPS there and the rest is reported not tried: on a Valkey that stopped answering every further job would wait out
 * the same bound, and each one sent is one more change that may land unobserved when it wakes.
 */
async function failedBulk({ url, jobs, redisFn, queueFn, parseConnectionFn, timeoutMs, readTimeoutMs = CONFIRM_READ_TIMEOUT_MS, act, what = "change", touchCause = null, touchStore = null, touchOutbox = null, now = Date.now }) {
  if (!Array.isArray(jobs)) return { invalid: "jobs must be the preview's list", single: { invalid: "jobs must be the preview's list" } };
  if (jobs.length > BULK_MAX) return { invalid: `at most ${BULK_MAX} jobs per action; this list has ${jobs.length}`, single: { invalid: "too many jobs" } };
  const results = [];
  let fleet = null;
  let stopped = false;
  try {
    for (const entry of jobs) {
      const { jobId } = entry;
      if (stopped) {
        results.push(failedActNotTried(typeof jobId === "string" ? jobId : null));
        continue;
      }
      if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
        results.push({ jobId: typeof jobId === "string" ? jobId : null, invalid: "a job id is letters, digits and . _ : -, at most 200 characters" });
        continue;
      }
      const problem = expectProblem(entry.expectGiven === undefined || entry.expectGiven === null ? null : { attemptsMade: entry.attemptsMade, finishedOn: entry.finishedOn ?? null });
      if (problem) {
        results.push({ jobId, invalid: problem });
        continue;
      }
      fleet ??= await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
      // Whether this job's write was started: until then a lost answer was a read's, and nothing changed.
      let sent = false;
      const acting = (job, redis) => {
        sent = true;
        return act(job, redis);
      };
      try {
        // The READS before the write, as one step with its own end (issue #842): nothing has been sent yet, so a bound
        // here is safe and says nothing was changed. Without it a queue built while Valkey takes connections and
        // answers none held the confirm until its connection gave up (36 to 39 s measured). The write below has no
        // such timer. A read that answers after the bound is dropped: this job is never acted on from it.
        const reading = (async () => {
          const got = await fleet.find(jobId, entry.queue);
          return { found: got, state: got ? await got.job.getState() : null };
        })();
        const read = await within(reading, readTimeoutMs, () => null);
        if (read === null) {
          // The list stops here, so the fleet is used no more: whatever the late read opens after the close below
          // has started (the next queue of its lookup) is closed when it settles, and its rejection is nobody's.
          const release = () => void fleet.close();
          reading.then(release, release);
          throw Object.assign(new Error(`the job did not answer within ${readTimeoutMs / 1000} seconds`), { code: "ETIMEDOUT" });
        }
        const { found, state } = read;
        // Not found in a fleet that could not be read whole (the registry or the keyspace scan): the queue that holds
        // the job may be one the discovery missed, so nothing is known of it. That is no "it changed since the
        // preview", which a bulk action then wrote for every job on a host queue; the list stops, nothing changed.
        if (!found && (fleet.blind || fleet.incomplete)) {
          throw Object.assign(new Error("the deployment's queues could not all be read, so the job was not looked for in every queue"), { code: "ETIMEDOUT" });
        }
        const trackedAct = async (job) => {
          const q = fleet.queueOf(found.queue);
          const redis = (touchCause || job.data?.localEvent !== undefined) && q.client ? await q.client : null;
          if (!touchCause) return acting(job, redis);
          const store = touchStore ?? (redis ? makeTouchStore({ redis, now }) : null);
          return trackTouchAction({ store, outbox: touchOutbox, event: { runId: jobId, cause: touchCause, at: now(), endedAt: entry.finishedOn ?? undefined, scopeId: touchScopeOf(job.data), nonce: `retry:${jobId}:${entry.attemptsMade}:${entry.finishedOn}` }, act: async () => { await acting(job, redis); return { ok: true }; } });
        };
        // Issue #796: a canary is third-party code a person chose to run once, after a preview that said so. A retry would install it again, its tree resolved again, behind a
        // dialog about retrying a job, and a model holds the retry tool. A person starts another from the Updates page.
        const canary = touchCause === "rerun" && found?.job?.data?.packageCanary !== undefined;
        const localEvent = touchCause === "rerun" && found?.job?.data?.localEvent !== undefined;
        const res = localEvent ? { invalid: LOCAL_EVENT_RETRY_REFUSAL } : canary ? { invalid: "This job was a canary of an extension version. Start another from the Updates page rather than retrying it." } : found ? await actOnFailed(found, state, jobId, { attemptsMade: entry.attemptsMade, finishedOn: entry.finishedOn ?? null }, trackedAct) : { invalid: notInFleet(jobId, fleet, "Nothing was done; it changed since the preview") };
        results.push(res.ok ? res : { jobId, invalid: res.invalid, ...(res.partial === true ? { partial: true } : {}) });
      } catch (err) {
        // One job's Valkey error is that job's result; a bulk action reports per job and goes on, unless the answer
        // was lost (above).
        results.push(sent && err?.valkeyMayStillRun === true ? { jobId, ...failedActUnconfirmed(what, jobId) } : { jobId, unreachable: err?.message ?? String(err) });
        stopped = answerLost(err);
      }
    }
    return { results, single: results[0] ?? { invalid: "a job id is required" } };
  } catch (err) {
    return { unreachable: err?.message ?? String(err), single: { unreachable: err?.message ?? String(err) } };
  } finally {
    // Started, never awaited: a queue that never connected does not settle its close within any bound of this answer.
    void fleet?.close();
  }
}

/**
 * The failed jobs a bulk retry or remove would act on (issue #642): the NEWEST failed jobs across every fleet queue, at
 * most `limit` (and never above `BULK_MAX`), optionally only one queue (`filter.queue`, refused when it is not a fleet
 * queue) or one repository (`filter.repo`, a forge job's `repo`). Returns `{ jobs: [{ jobId, queue, attemptsMade,
 * finishedOn, target? }], more, examinedAll }`, newest first by `finishedOn` across queues (ties by queue then id, so the
 * order is stable), where `more` counts the matching jobs past the limit and `examinedAll` is false when a repo-filtered
 * queue's failed set was longer than this reads (`more` is then a floor). `target` is the run record's own spelling
 * (`targetFor`), present when the job's data says. `{ invalid }` / `{ unreachable }`.
 *
 * NEWEST ACROSS THE FLEET, not per queue in discovery order: each queue gives its newest `limit` matching jobs (BullMQ
 * keeps the failed set ordered by finish time, newest first), the union is ordered by `finishedOn` and cut to `limit`.
 * Filling from the queues in discovery order made the list one queue's backlog whenever that queue came first, and the
 * newest failure on a host queue, the one an operator is looking at, never appeared. What is left over is counted:
 * without a repo filter from each queue's failed count (exact), with one by reading on, at most `FAILED_EXAMINE_MAX`
 * per queue.
 *
 * The list IS the ticket's content: the console binds every job's `attemptsMade` and `finishedOn`, and the apply refuses
 * a job that changed.
 */
export async function planFailedBulk({ url, filter = {}, limit = BULK_MAX, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500, planTimeoutMs = FAILED_PLAN_TIMEOUT_MS } = {}) {
  const cap = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), BULK_MAX) : BULK_MAX;
  const onlyQueue = filter?.queue ?? null;
  const onlyRepo = filter?.repo ?? null;
  if (onlyQueue !== null && typeof onlyQueue !== "string") return { invalid: "filter.queue must be a queue name" };
  if (onlyRepo !== null && (typeof onlyRepo !== "string" || onlyRepo === "")) return { invalid: "filter.repo must be a repository" };
  let fleet = null;
  // ONE step with its own end (issue #842, `planCancelQueued`'s pattern): the reads below have a bound each, and a
  // queue built while Valkey takes connections and answers none takes 36 to 39 s to give up (measured), so without this a
  // preview stayed open for as long.
  const release = releaseOf(() => fleet, () => null);
  const work = (async () => {
    fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
    if (onlyQueue !== null && !fleet.names.includes(onlyQueue)) return { invalid: `${JSON.stringify(onlyQueue)} is not a queue this deployment drains (${fleet.names.join(", ")})` };
    const candidates = [];
    let leftover = 0;
    let examinedAll = true;
    for (const name of fleet.names) {
      if (onlyQueue !== null && name !== onlyQueue) continue;
      const q = fleet.queueOf(name);
      let taken = 0;
      let read = 0;
      let exhausted = false;
      // Without a repo filter a queue gives at most `cap`, so it is read in pages of `cap`; with one, in full pages.
      const pageSize = onlyRepo === null ? Math.min(FAILED_PAGE, cap) : FAILED_PAGE;
      for (let start = 0; ; start += pageSize) {
        if (start >= FAILED_EXAMINE_MAX) {
          if (onlyRepo !== null) examinedAll = false;
          break;
        }
        // Without a repo filter every job matches, so this queue's newest `cap` are all it can contribute: stop there.
        if (onlyRepo === null && taken >= cap) break;
        const page = await q.getFailed(start, start + pageSize - 1);
        if (!Array.isArray(page) || page.length === 0) {
          exhausted = true;
          break;
        }
        read += page.length;
        for (const job of page) {
          if (!job || typeof job.id !== "string") continue;
          if (onlyRepo !== null && job.data?.repo !== onlyRepo) continue;
          if (taken >= cap) {
            leftover += 1; // a match past this queue's own cut: counted, never listed
            continue;
          }
          taken += 1;
          const target = targetOf(job.data);
          candidates.push({ jobId: job.id, queue: name, ...failedFingerprint(job), ...(job.data?.localEvent !== undefined ? { retryRefusal: LOCAL_EVENT_RETRY_REFUSAL } : {}), ...(target !== null ? { target } : {}) });
        }
        if (page.length < pageSize) {
          exhausted = true;
          break;
        }
      }
      // Without a repo filter the rest of this queue is counted exactly from its failed count, never read.
      if (onlyRepo === null && !exhausted) {
        const total = await q.getFailedCount();
        leftover += Math.max(0, (Number.isSafeInteger(total) ? total : 0) - read);
      }
    }
    candidates.sort((a, b) => (b.finishedOn ?? -Infinity) - (a.finishedOn ?? -Infinity) || (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    const jobs = candidates.slice(0, cap);
    return { jobs, more: candidates.length - jobs.length + leftover, examinedAll };
  })();
  try {
    return await within(work, planTimeoutMs, () => ({ unreachable: "timed out reading the failed jobs" }));
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    // Started, never awaited (`releaseOf`); a read still in flight when the bound fired is released when it settles.
    release();
    work.then(release, release);
  }
}

/** The queue a forge job goes on: the receiver's rule (capabilities.mjs) over the live hosts, else the shared queue. */
function forgeQueueName(kind, data, hosts) {
  const needs = jobNeeds(data);
  if (needs.length === 0) return QUEUE;
  try {
    const name = routeForgeJob({ hosts, needs, jobId: forgeDeliveryJobId(kind, data?.trigger?.deliveryId, data?.replica) });
    return name ? hostQueueName(name) : QUEUE;
  } catch {
    return QUEUE; // an unroutable id or a bad row: the shared queue, route.mjs's fail-open answer
  }
}

/** This host's queue for a local or cron job: its own host queue when the deployment declares a worker name. */
function localQueueName(env) {
  const name = env?.PI_WORKER_NAME;
  return typeof name === "string" && name !== "" ? hostQueueName(name) : QUEUE;
}

/** The folder rule `/dispatch run` and `pi-dispatch run` apply (issue #524): a repository root with a commit, clean. */
function folderRefusal(folder, { localRepoProblemFn, gitDirtyFn, cron = false }) {
  const notARepo = localRepoProblemFn(folder);
  if (notARepo) return notARepo;
  // A scheduled tick runs over uncommitted changes (cron triggers allow them, `pi-dispatch run --trigger`'s rule); a
  // manual run refuses them, `enqueueDispatchRun`'s operator path: it edits the folder in place with no undo.
  if (cron) return null;
  const dirty = gitDirtyFn(folder);
  if (dirty === null) return "not a usable git repository";
  if (dirty) return "uncommitted changes in the folder; commit or stash them, or run it from the CLI with `pi-dispatch run --force`";
  return null;
}

/**
 * A cron run's trigger id, from its job id (`repeat:<id>:<millis>` from the scheduler, `manual:<id>:<minute>` by hand),
 * of any length: the run is a record of this deployment's, and every release before issue #761 took any length.
 */
function cronTriggerId(jobId) {
  return cronRunOf(jobId)?.id ?? null;
}

/**
 * The run fields of a forge job built from a trigger entry's normalized `run` (parseTriggers' shape), exactly as the
 * receiver's filters spread them onto the job (receiver/src/filter*.mjs: one conditional spread per field, absent stays
 * absent, `awaitInput`, `progress`, `statusComment`, `recover` and `steer` only when armed), with `flow` the flow that runs. ONE builder for the two console paths that make
 * a forge job from the triggers file (a parked answer and a forge re-run), so they cannot drift from each other; the
 * parked-answer test builds a receiver job and a console job for the same issue and compares them field for field,
 * which is what holds this builder to the filters.
 */
function runFieldsOf(entry, flow) {
  const { run } = entry;
  return {
    flow,
    ...(run.packages !== undefined ? { packages: run.packages } : {}),
    ...(run.image !== undefined ? { image: run.image } : {}),
    ...(run.backend !== undefined ? { backend: run.backend } : {}),
    ...(run.excludeTools !== undefined ? { excludeTools: run.excludeTools } : {}),
    ...(run.excludeExtensions !== undefined ? { excludeExtensions: run.excludeExtensions } : {}),
    ...(run.excludeExtensionTools !== undefined ? { excludeExtensionTools: run.excludeExtensionTools } : {}),
    ...(run.mcp !== undefined ? { mcp: run.mcp } : {}),
    // Issue #918: the private endpoints the trigger grants, as the filters carry them; the worker confirms the grant
    // against the live file before the run, so a console job is granted no more than a receiver one.
    ...(run.privateEndpoints !== undefined ? { privateEndpoints: run.privateEndpoints } : {}),
    ...(run.provider !== undefined ? { provider: run.provider } : {}),
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.maxTurns !== undefined ? { maxTurns: run.maxTurns } : {}),
    ...(run.models !== undefined ? { models: run.models } : {}),
    ...(run.fallbackModels !== undefined ? { fallbackModels: run.fallbackModels } : {}),
    ...(run.modelSelection !== undefined ? { modelSelection: run.modelSelection } : {}), ...(run.auxiliaryModels !== undefined ? { auxiliaryModels: run.auxiliaryModels } : {}),
    ...(run.maxCostUsd !== undefined ? { maxCostUsd: run.maxCostUsd } : {}),
    // Issue #1008: the list-price allowance for subscription calls, by the cap's rule, as the filters carry it.
    ...(run.maxSubscriptionUsd !== undefined ? { maxSubscriptionUsd: run.maxSubscriptionUsd } : {}),
    // Issue #888: the trigger's limits, by the cap's rule.
    ...(run.idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes: run.idleTimeoutMinutes } : {}),
    ...(run.stallTimeoutMinutes !== undefined ? { stallTimeoutMinutes: run.stallTimeoutMinutes } : {}),
    ...(run.maxMinutes !== undefined ? { maxMinutes: run.maxMinutes } : {}),
    ...(run.skillsDir !== undefined ? { skillsDir: run.skillsDir } : {}),
    ...(run.secrets !== undefined ? { secrets: run.secrets } : {}),
    ...(run.secretFiles !== undefined ? { secretFiles: run.secretFiles } : {}),
    ...(run.secretsProfile !== undefined ? { secretsProfile: run.secretsProfile } : {}),
    ...(run.waitFor !== undefined ? { waitFor: run.waitFor } : {}),
    ...(run.instructions !== undefined ? { instructions: run.instructions } : {}),
    ...(run.mayMerge === true ? { mayMerge: true, mayMergePolicy: mergePolicyDigest(entry) } : {}),
    ...(run.resume !== undefined ? { resume: run.resume } : {}),
    ...(run.awaitInput === true ? { awaitInput: true } : {}),
    ...(run.gates !== undefined ? { gates: run.gates } : {}),
    ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}),
    ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}),
    ...(run.progress === true ? { progress: true } : {}),
    ...(run.statusComment === true ? { statusComment: true } : {}),
    ...(run.recover === true ? { recover: true } : {}),
    ...(run.steer === true ? { steer: true } : {}),
    ...(run.replicas !== undefined ? { replicas: run.replicas } : {}),
  };
}

/**
 * What a forge plan shows an operator of the run it will start (issue #642): `{ flow, model, models, maxCostUsd,
 * secretsProfile, image, backend, packages?, mcp? }` off the job to enqueue, null where the job leaves the deployment's
 * default. NAMES ONLY: the secret profile's name, never a secret, and not even the `secrets` reference map (a
 * reference is a path into a vault, which an operator reading a preview does not need and a screenshot should not carry).
 */
// An ad-hoc re-run normally uses deployment defaults. Reviewed random and auxiliary grants keep
// their ceiling and cap; the old random generation and physical selection cannot follow them.
// Issue #1008: a subscription allowance the job carried is kept on every re-run. No deployment value stands behind it,
// so a re-run without it would run the job's subscription calls with no dollar limit at all.
function randomRerunFields(data) {
  const allowance = data.maxSubscriptionUsd !== undefined ? { maxSubscriptionUsd: data.maxSubscriptionUsd } : {};
  if (data.modelSelection === undefined && data.auxiliaryModels === undefined) return allowance;
  return { ...(data.modelSelection !== undefined ? { modelSelection: data.modelSelection } : {}), ...(data.auxiliaryModels !== undefined ? { auxiliaryModels: data.auxiliaryModels } : {}), ...(data.models !== undefined ? { models: data.models } : {}), ...(data.maxCostUsd !== undefined ? { maxCostUsd: data.maxCostUsd } : {}), ...allowance };
}

function runFieldsSummary(job) {
  return {
    flow: job.flow ?? null,
    model: job.model === undefined ? null : job.provider !== undefined ? `${job.provider}/${job.model}` : job.model,
    models: job.models ?? null,
    ...(job.fallbackModels !== undefined ? { fallbackModels: job.fallbackModels } : {}),
    ...(job.modelSelection !== undefined ? { modelSelection: job.modelSelection } : {}), ...(job.auxiliaryModels !== undefined ? { auxiliaryModels: job.auxiliaryModels } : {}),
    maxCostUsd: job.maxCostUsd ?? null,
    // Issue #1008: only when the job carries one, so a preview of every other run says what it always said.
    ...(job.maxSubscriptionUsd !== undefined ? { maxSubscriptionUsd: job.maxSubscriptionUsd } : {}),
    secretsProfile: job.secretsProfile ?? null,
    image: job.image ?? null,
    backend: job.backend ?? null,
    ...(job.packages !== undefined ? { packages: job.packages } : {}),
    ...(job.mcp !== undefined ? { mcp: job.mcp } : {}),
    // Issue #918: the devices the job may reach, by id (never a host), as the trigger names them.
    ...(Array.isArray(job.privateEndpoints) && job.privateEndpoints.length > 0 ? { privateEndpoints: job.privateEndpoints } : {}),
    ...(job.mayMerge === true ? { mayMerge: true } : {}),
  };
}

/** The triggers file through the loaders' own parser: the entries, or `{ refusal }` when it does not load. */
function loadTriggerEntries(triggersPath, fs) {
  try {
    return { entries: parseTriggers(fs.readFileSync(triggersPath, "utf8"), triggersPath) };
  } catch (e) {
    return { refusal: `the triggers file does not load (${e?.message ?? e}); nothing was queued` };
  }
}

/** The words for a forge re-run whose trigger no longer says what it said when the run started. */
const TRIGGER_CHANGED = "the trigger that started this run changed or is gone; start it again from the forge";

/**
 * The trigger entry a retained forge job's `trigger.matched` still names, judged against the triggers file NOW, or a
 * refusal (`TRIGGER_CHANGED` plus why, and `reason`, the part that changed). Whether the entry at `matched.index` is the
 * job's trigger is the worker's one reading (`forgeTriggerMismatch`, issue #933), shared with every pre-spend check: the
 * same forge, the type that matched (a gitlab merge request's label match is a `pull_request` entry with a label
 * selector), still the matched action, label and phrase, and the same flow (a comment's `<phrase> <flow>` override may
 * name a flow the receiver could route it to, `routableFlows`). This function adds only the words for each part, and
 * its own rule that a re-run is never of a command trigger. An index is a position in the file, so an entry deleted
 * above it moves another trigger under the same index: these checks are what keep a re-run from borrowing that other
 * trigger's authority, and the worker's trigger-skew check from being defeated by it.
 */
function currentTriggerFor(entries, kind, data) {
  const matched = data?.trigger?.matched;
  const index = matched?.index;
  if (!Number.isInteger(index) || index < 0) return { refusal: `${TRIGGER_CHANGED} (the run names no trigger index)` };
  const entry = entries[index];
  if (!entry) return { refusal: `${TRIGGER_CHANGED} (no trigger at index ${index} any more)` };
  const { on, run } = entry;
  const reason = forgeTriggerMismatch(entries, entry, { ...data, kind });
  const refuse = (why) => ({ refusal: `${TRIGGER_CHANGED} (${why})`, reason });
  if (reason === "kind") return refuse(`the trigger at index ${index} is a ${String(run.kind)} trigger now, not ${kind}`);
  if (reason === "type") return refuse(`the trigger at index ${index} is a ${String(on.type)} trigger now, not ${String(matched.type)}`);
  if (reason === "action") return refuse(`the trigger at index ${index} no longer fires on ${matched.action}`);
  if (reason === "label") return refuse(`the trigger at index ${index} no longer selects the label ${matched.label}`);
  // The phrase too (issue #918's review): the worker's merge and private endpoint checks hold a comment job to it, so a
  // re-run planned past a changed phrase would only be refused there, under a reason that names the wrong change.
  if (reason === "phrase") return refuse(`the trigger at index ${index} no longer answers the phrase it matched`);
  if (run.command !== undefined) return { refusal: `${TRIGGER_CHANGED} (the trigger at index ${index} runs a command now)`, reason: "lane" };
  if (reason !== null) return refuse(`the trigger at index ${index} runs ${JSON.stringify(run.flow)} now, not ${JSON.stringify(data.flow)}`);
  return { run, entry };
}

/** What a fix's source check answers when it could not look: nothing was read, so nothing is said to be gone or changed. */
export const TRIGGER_FIX_UNCHECKED = "The source trigger identity could not be checked. Reload and try again; nothing was changed.";

/**
 * A fix must retain the source trigger's identity, not merely reuse its array position and forge kind.
 *
 * "The queue no longer holds" is a claim that every queue was asked and none had the job (issue #844). A lookup that
 * ran out of time, or found nothing over a queue list the registry or the keyspace scan could not vouch for (`blind`,
 * `incomplete`), did not ask them all, and answers `TRIGGER_FIX_UNCHECKED`. A lookup that outlives the bound still
 * closes the queues it opened, when it settles.
 */
export async function checkTriggerFixSource({ url, jobId, index, triggersPath, fs = nodeFs, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500, readRetainedJob = null } = {}) {
  if (!JOB_ID_RE.test(jobId ?? "") || !Number.isSafeInteger(index) || index < 0) return { refusal: "The source run and trigger index are not valid." };
  let fleet;
  try {
    const text = fs.readFileSync(triggersPath, "utf8");
    const entries = parseTriggers(text, triggersPath);
    const raw = JSON.parse(text);
    const unchecked = Symbol("not checked");
    const lookup = (async () => {
      if (readRetainedJob) return readRetainedJob(jobId);
      fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
      const data = (await fleet.find(jobId))?.job?.data ?? null;
      return data === null && (fleet.blind || fleet.incomplete) ? unchecked : data;
    })();
    // The bound below may answer first: the queues the lookup opens after that are closed here, once it settles.
    void lookup.catch(() => {}).finally(() => { if (fleet) void fleet.close(); });
    const found = await within(lookup, timeoutMs, () => unchecked);
    if (found === unchecked) return { refusal: TRIGGER_FIX_UNCHECKED };
    if (!found) return { refusal: "The queue no longer holds the source run's trigger identity. Open the current trigger configuration instead." };
    const current = found.trigger?.matched?.index === index ? currentTriggerFor(entries, found.kind, found) : null;
    if (current?.reason === "phrase") return { refusal: "The comment trigger phrase changed. Review the current trigger before adding instructions." };
    if (current === null || current.refusal || !raw.triggers?.[index]) return { refusal: "The trigger that started this run changed or moved. Review the current trigger before adding instructions." };
    return { ok: true, runId: jobId, index, triggerDigest: createHash("sha256").update(JSON.stringify(raw.triggers[index])).digest("hex") };
  } catch { return { refusal: TRIGGER_FIX_UNCHECKED }; }
  finally { if (fleet) void fleet.close(); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cancel a job that never started (issue #737): `cancel-queued`. The sequence (a held job's keys, then the job, then its
// defer record) is the worker's `removeQueuedJob`, the one `pi-dispatch cancel` runs; the RULES are the console's, here.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A cancel answer's sentence with its job named once, LAST, as "(job <id>)" (issue #737): the one way every sentence a
 * cancel answers with names its job (`cancelQueuedRefusal`, `heldClearedAnswer`, `removalUnknown`, `heldRefused` and
 * the rest below). The sentence is also the audit row's `reason`, which the log cuts at `CONSOLE_AUDIT_FIELD_MAX` (200)
 * code points, and a job id may be up to 200 characters: with the id first, a long one pushed what happened past the
 * cut, so the row kept the id and lost the outcome. The row's `target` names the job already, so the id is the part a
 * cut may take. Another module's words in such a sentence (`theirWords`) come after the console's own, before the id.
 */
const jobLast = (sentence, jobId) => `${sentence} (job ${jobId})`;

/**
 * Another module's words as a cancel answer carries them (BullMQ's, a client's, the worker's `removeHeldJob`'s):
 * `boundedText`'s, with the job they name said as "the job", since the answer names it last (`jobLast`). Read before the
 * bound, so a 200-character id is replaced whole rather than cut part-way.
 */
function theirWords(text, jobId) {
  const said = String(text ?? "no reason given");
  return boundedText(typeof jobId === "string" && jobId !== "" ? said.replaceAll(`Job ${jobId}`, "the job").replaceAll(`job ${jobId}`, "the job") : said);
}

/**
 * The console's sentence for each reason it does not cancel a queued job (issue #737), every one saying "nothing was
 * changed" and then naming the job (`jobLast`). `kind` is one of `retried`, `stalled`, `recovery`, `scheduled`,
 * `notQueued`, `started`, `changed`; any other kind throws (every caller names its kind by a literal). The facts:
 * `jobId`, `attempts` (made), `run` (the run a recovery continues), `scheduler` (the cron trigger) and `state` (BullMQ's).
 *
 * WHY "NEVER STARTED" IS THE RULE, and not "not running". A job that made an attempt and waits to retry still owns that
 * run's steer inbox and held replies, which stay open for its next attempt (they are per run); one handed back after a
 * stall may have run to the end of an attempt whose record is still being written; a recovery owes the run it continues
 * that run's final record. Removing any of them from the queue strands state no surface would clean up, so the console
 * cancels only a job that has done nothing yet, and a job that runs is stopped by Cancel on its run page. `pi-dispatch
 * cancel` keeps its wider reach (it removes a retry too): an operator at the CLI sees `ranBefore`'s words.
 */
export function cancelQueuedRefusal(kind, { jobId, attempts, run, scheduler, state } = {}) {
  return jobLast(cancelQueuedWords(kind, { attempts, run, scheduler, state }), jobId);
}

/** `cancelQueuedRefusal`'s words before the job is named. */
function cancelQueuedWords(kind, { attempts, run, scheduler, state }) {
  switch (kind) {
    case "retried": {
      const n = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
      return `the job has made ${n} ${n === 1 ? "attempt" : "attempts"} and waits to retry: a retry keeps its run's steer and held replies open for the next attempt, so the console cancels only a job that never started; once it runs, Cancel on its run page stops it; nothing was changed`;
    }
    case "stalled":
      return "the job was handed back after a stall, so an attempt of it may have finished; nothing was changed";
    case "recovery":
      return `the job recovers run ${run} and owes that run its final record; nothing was changed`;
    case "scheduled":
      return `the job is cron trigger ${scheduler}'s next run: pause the trigger or edit its schedule; BullMQ refuses to remove a scheduler's next job; nothing was changed`;
    case "notQueued":
      return `the job is ${state}, not waiting to start; nothing was changed`;
    case "started":
      return "the job started since the preview; nothing was changed";
    case "changed":
      return "the job changed since the preview; nothing was changed";
    default:
      throw new RangeError(`cancelQueuedRefusal: unknown kind ${JSON.stringify(kind)}`);
  }
}

/** The states BullMQ moves a job to once a worker has taken it: a job found in one of these has started. */
const STARTED_STATES = Object.freeze(["active", "completed", "failed"]);

/** A count off a Job (`attemptsMade`, `stalledCounter`): a non-negative integer, or null for anything else. */
function countOf(n) {
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A job's kind as BullMQ's job name carries it (`local`, `github`, ...), or null. */
const JOB_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The run a recovery continues, as a sentence may name it: a job id, else words that name none. */
function recoveryRunOf(data) {
  const of = data?.recoveryOf;
  if (typeof of !== "string" || of === "") return null;
  return JOB_ID_RE.test(of) ? of : "an earlier run";
}

/** The scheduler's current next instant for `rjk` in `queueName` (`ZSCORE <queue>:repeat <rjk>`), or null. */
async function schedulerNextOf(redis, q, rjk) {
  const got = await redis.zscore(queueKeyOf(q, QUEUE_KEY.repeat), rjk);
  return got === null || got === undefined ? null : got;
}

/**
 * The never-started rules, in the order their sentences are the most useful: the scheduler's next run (BullMQ refuses
 * to remove it anyway), a recovery (it owes a record), a job that made an attempt, a job handed back after a stall.
 * Returns the refusal sentence, or null when the job is one the console cancels. Reads `.data` for `recoveryOf` alone.
 */
async function neverStartedRefusal(job, jobId, { redis, q }) {
  // The scheduler key as every reader of one in Valkey bounds it (`SCHEDULER_ID_RE`), the console's read model included.
  const rjk = typeof job?.repeatJobKey === "string" && SCHEDULER_ID_RE.test(job.repeatJobKey) ? job.repeatJobKey : null;
  if (rjk !== null && isSchedulerNext(jobId, rjk, await schedulerNextOf(redis, q, rjk))) return cancelQueuedRefusal("scheduled", { jobId, scheduler: rjk });
  const run = recoveryRunOf(job?.data);
  if (run !== null) return cancelQueuedRefusal("recovery", { jobId, run });
  const attempts = countOf(job?.attemptsMade);
  if (attempts !== 0) return cancelQueuedRefusal("retried", { jobId, attempts });
  if (countOf(job?.stalledCounter) !== 0) return cancelQueuedRefusal("stalled", { jobId });
  return null;
}

/** `promise` within `ms`, else `fallback()`'s answer; a late rejection is the race's, never unhandled. */
export function within(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The release of a bounded action's clients: the raw client disconnected (synchronous) and the fleet's queues' close
 * STARTED, never awaited, so the answer leaves within its bound whatever Valkey does. A close BullMQ cannot finish (a
 * socket that stopped answering) settles when the socket ends; a later call releases what a late read opened since.
 */
function releaseOf(fleetOf, redisOf) {
  return () => {
    try {
      redisOf()?.disconnect?.();
    } catch {
      // already closed
    }
    void fleetOf()?.close();
  };
}

/**
 * A raw client the console reads or writes with on a person's request (issues #842, #961): each command bound, so one a
 * Valkey took and never answered ends at the bound with `valkeyMayStillRun`, and one that timed out before it was sent
 * is never sent later (`makeRedisClient`'s `commandTimeoutMs`). WITH its offline queue, the cancel probe's shape: a
 * client without one refuses its first command before it has connected. Its socket is dropped at once on disconnect.
 */
export function boundedClient(redisFn, url) {
  const redis = redisFn(url, { commandTimeoutMs: VALKEY_COMMAND_TIMEOUT_MS, disconnectTimeoutMs: 0 });
  redis.on?.("error", () => {});
  return redis;
}

/** Whether `err` is Valkey's own answer (a reply that is an error, or a refusal this project raised): nothing ran. */
export const refusedByValkey = (err) => err?.name === "ReplyError" || err?.valkeyRefused === true;

/**
 * The sentence of a write that was asked for and that Valkey did not answer (issue #987), which a confirm answers as
 * `{ invalid: <the sentence>, partial: true }`: never "nothing was changed" and never done. One shape for every write
 * the console makes through a store or a helper that ends a command by a timer of its own (the answer drafts, the fix
 * accounting, the sandbox requests): such a timer fires before the client's bound, with an error that cannot say
 * whether the command was sent, so the command may land when Valkey answers again. `what` is the thing as a sentence
 * starts ("The draft"), `done` what may have become of it ("dropped"), `asked` what was asked for ("the drop"), and
 * `next` what to do, a whole sentence. The rule beside it: while only reads had left, Valkey unreachable and nothing
 * changed (`writeTracking` says which); Valkey's own reply is an answer and is handed on as it is.
 */
export const unconfirmedWrite = ({ what, done, asked, next }) => `${what} may or may not have been ${done}: ${asked} was asked for and Valkey did not answer. ${next}`;

/**
 * The one word each store's own timer rejects with (the worker's question groups, fixes and answer drafts). Such a
 * timer ends a read before the client's bound does, and its error carries no code and no name, so the word is the only
 * handle; a test holds each store to its word.
 */
const STORE_TIMEOUTS = Object.freeze(["question-store-timeout", "fix-store-timeout", "answer-store-timeout"]);
/** What a client rejects a command with when no Valkey answered it: its own bound, and a connection refused, reset or broken under the command. */
const SILENT_CODES = Object.freeze(["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EPIPE"]);
/** ioredis' words for the same, where it gives no code: a command its bound ended, one on a connection that closed, one on a client with no connection and no offline queue. */
const SILENT_WORDS = Object.freeze(["Command timed out", "Connection is closed.", "Stream isn't writeable and enableOfflineQueue options is false"]);

/**
 * Whether `err` is KNOWN to be Valkey's silence (issue #987): a mark this project set (`valkeyNotSent`,
 * `valkeyMayStillRun`), a client's timeout or lost connection (`SILENT_CODES`, `SILENT_WORDS`, ioredis' retries run
 * out), or a store's own timer (`STORE_TIMEOUTS`). An allowlist on purpose: anything else a read throws (a row that is
 * not a record, a file that is not there, a configuration that does not load, a fault of the code, a rejection that is
 * no error at all) is not Valkey out of reach, and neither is Valkey's own reply.
 */
export function valkeySilence(err) {
  if (err === null || typeof err !== "object" || refusedByValkey(err)) return false;
  if (err.valkeyNotSent === true || err.valkeyMayStillRun === true) return true;
  if (typeof err.code === "string" && SILENT_CODES.includes(err.code)) return true;
  if (err.name === "MaxRetriesPerRequestError") return true;
  return typeof err.message === "string" && (SILENT_WORDS.includes(err.message) || STORE_TIMEOUTS.includes(err.message));
}

/**
 * A read of Valkey on a path that WRITES NOTHING (a preview, issue #987): `reading`'s answer, or, where it rejected
 * with what is known to be Valkey's silence (`valkeySilence`), that thrown on as a new error marked `valkeyNotSent`,
 * which the console's preview answers as Valkey unreachable, with Try again, where it said the preview failed and to
 * read the console's log. The mark is set HERE, where the read is asked: a store's own timer ends its read before the
 * client's bound does, with an error that names no Valkey. The mark of a command that may still run is dropped, as
 * `writeTracking`'s `unsent` drops it: a read changes nothing whenever it runs. Everything else is handed on as it is,
 * the same value, for the caller's own answer and the console's log. NEVER for a read on a path that also writes:
 * there the client's own mark has to reach the confirm.
 */
export function valkeyRead(reading) {
  return Promise.resolve(reading).catch((err) => {
    if (!valkeySilence(err) || err.valkeyNotSent === true) throw err;
    throw Object.assign(new Error(boundedText(err.message ?? String(err))), { valkeyNotSent: true, ...(typeof err.code === "string" ? { code: err.code } : {}) });
  });
}

const CONNECT_LATE = Symbol("connect-late");

/** What `connectedQueue` answers for a queue whose connection ended before it was ever ready (issue #987). */
export const CONNECT_ENDED = "the queue's connection closed before it was ready; nothing was queued";

/**
 * The first phase of a paid enqueue (issue #961): one queue of the console's bounded kind (`consoleQueueConnection`),
 * CONNECTED, or `{ unreachable }`. BullMQ connects inside the queue, and on a Valkey that takes the connection and
 * answers nothing that takes over half a minute to give up (`SWITCH_STEP_TIMEOUT_MS` says how it was measured), with
 * whatever was asked of the queue meanwhile sent when a connection comes up. So the connection is awaited here, under
 * `connectTimeoutMs`, BEFORE anything is asked of the queue: past it nothing was sent, the queue is closed so nothing
 * is sent later, and "nothing was queued" is true. The add that follows then needs no timer of its own, and must not
 * have one: it goes out on a connected client at once, and that client's command bound says whether it was answered.
 *
 * A client that settled ENDED is a connect that failed too (issue #987). BullMQ's wait for a ready client resolves
 * when the client ended with no error event (read at 5.80.4, `RedisConnection.waitUntilReady`), which is what a
 * connection that is taken and then closed leaves once the retries ran out: a forwarder in front of a Valkey that is
 * gone. Taken as connected, the add that followed was refused by the client itself with nothing on the wire, and read
 * as sent and not confirmed.
 *
 * Returns `{ queue, client }` (`client` null for a queue that has none to wait for, a test's) or `{ unreachable }`.
 * `options` is the queue's own (`{ name }`).
 */
export async function connectedQueue({ url, options = {}, queueFn = makeQueue, parseConnectionFn = parseConnection, connectTimeoutMs = CONFIRM_READ_TIMEOUT_MS, closeTimeoutMs = QUEUE_CLOSE_TIMEOUT_MS } = {}) {
  let queue = null;
  try {
    queue = queueFn(consoleQueueConnection(url, parseConnectionFn), options);
    if (queue.client === undefined) return { queue, client: null };
    const client = await within(Promise.resolve(queue.client), connectTimeoutMs, () => CONNECT_LATE);
    if (client !== CONNECT_LATE && client?.status !== "end") return { queue, client };
    void closeWithin(queue, closeTimeoutMs);
    return { unreachable: client === CONNECT_LATE ? `the queue did not connect within ${connectTimeoutMs / 1000} seconds; nothing was queued` : CONNECT_ENDED };
  } catch (err) {
    if (queue) void closeWithin(queue, closeTimeoutMs);
    return { unreachable: `${boundedText(err?.message ?? String(err))}; nothing was queued` };
  }
}

/**
 * A paid enqueue that was sent and not confirmed (issue #961): `partial`, never "nothing was queued". It says to look
 * first because a second try is only taken as a duplicate for a while (a local or cron run and a `dispatch_run` within
 * the same minute, a forge run within the semantic window), so a retry after that can pay for the same run twice.
 *
 * `counted` (issue #987): the start was counted against the hour's `dispatch_run` allowance before the add, which is
 * never given back, so the sentence says so, as Fire now's does (`FIRE_UNCONFIRMED`). Right after what may have been
 * queued, before the pointer: an audit row keeps 200 code points of a reason, and "the run", a dispatch run's `what`,
 * fits whole.
 */
export const enqueueUnconfirmed = (what, { counted = false } = {}) => ({ invalid: `${what} may or may not have been queued${counted ? " and one start of this hour was used" : ""}: the queue did not confirm it. ${LOOK_FIRST}`, partial: true });

/**
 * What an answer to an approval says when its request is not the pending one for its run any more, and when the
 * request could not be read: the preview's two refusals (`planParkedAnswer`), and since issue #987 the confirm's too,
 * for what `enqueueForgeJob` finds when it reads the request again right before its add. The two do not ask the same:
 * the preview asks that the request is pending and this run's, the helper only that it is still the item's active
 * request, by its id. So a request decided since the preview under the same id is queued, as it always was, and the
 * worker judges that decision.
 */
export const APPROVAL_NOT_PENDING = "the approval request is no longer pending for this run; nothing was queued";
export const APPROVAL_UNREAD = "the durable approval request could not be read; nothing was queued, try again";

/**
 * The routed queue of one forge enqueue, opened and closed by the console (issue #987). `enqueueForgeJob` sends a
 * decision on a durable approval to the queue of the host that owns its session, and unless it is handed a `routeFn`
 * it builds that queue itself, after the caller's connect phase: built while Valkey takes connections and answers
 * none, the add waited for as long as that connection took to give up (30.4 s measured), and the queue's close was
 * awaited. `open` is that `routeFn`: the routed queue through `connectedQueue`, under the same connect bound as the
 * first, or a throw tagged `routeUnreached` whose message is `connectedQueue`'s own sentence. The throw carries no
 * `valkeyMayStillRun`: nothing was asked of the routed queue, so nothing was sent. `close()` starts the close of the
 * queue that was opened and never waits for it, as every close of a paid enqueue.
 */
function routedQueueOf({ url, queueFn, parseConnectionFn, connectTimeoutMs }) {
  const opened = [];
  return {
    async open(name) {
      const connected = await connectedQueue({ url, options: { name }, queueFn, parseConnectionFn, connectTimeoutMs });
      if (!connected.queue) throw Object.assign(new Error(connected.unreachable), { routeUnreached: true });
      opened.push(connected.queue);
      return connected.queue;
    },
    close() {
      for (const queue of opened.splice(0)) void closeWithin(queue, QUEUE_CLOSE_TIMEOUT_MS);
    },
  };
}

/**
 * What a forge enqueue that threw BEFORE any add was started answers (issue #987): nothing was queued, and why.
 * `enqueueForgeJob` checks before it adds, and each check throws with nothing sent: the routed queue that did not
 * connect is Valkey's (`{ unreachable }`); an approval whose request is not the item's active one any more, or whose
 * state could not be read, is a refusal in the preview's own words; anything else is a builder that refused the
 * job's fields, a refusal that names what it threw. Each of these read as "may or may not have been queued" while
 * the mark was set before the helper was called, and a builder's refusal as Valkey unreachable before that. Never
 * called once an add was started: from there only Valkey's own reply says nothing was queued.
 */
function forgeUnsent(err) {
  if (err?.routeUnreached === true) return { unreachable: err.message };
  if (err?.message === "approval-request-stale") return { refusal: APPROVAL_NOT_PENDING };
  if (err?.message === "approval-state-unavailable") return { refusal: APPROVAL_UNREAD };
  return { refusal: `the job could not be built (${boundedText(err?.message ?? String(err))}); nothing was queued` };
}

/**
 * Whether a forge enqueue's throw before any add came of a Valkey that did not answer (issue #987): the routed queue
 * that did not connect, and an approval state that could not be read (a read that failed or was not answered; a state
 * Valkey answered and the store could not use throws the same, and is taken the same way). After one of these no
 * further Valkey command is waited for, as after a lost answer. Its one caller is a re-run (a fork with it), for whose
 * job every other throw there is a builder's refusal, which Valkey had no part in: a command after it is answered as
 * any other. A stale approval is not among them: a re-run and a fork carry no `approvalRequestId`, so that throw is the
 * parked answer's alone, which has no touch intent to take back and does not ask this.
 */
const unansweredBeforeAdd = (err) => err?.routeUnreached === true || err?.message === "approval-state-unavailable";

/**
 * A local or cron enqueue whose add was answered and whose read back was not (`enqueueLocalJobReporting`'s
 * `existing: undefined`, issue #961): a job with this id is there, and whether this request made it or met an identical
 * one from the same minute is not known. Never `ok`, which says this request queued it.
 */
export const enqueueUnread = (what, jobId) => ({ invalid: `${what} was taken as ${jobId}; whether it is new or an identical one from this minute was not read back. ${LOOK_FIRST}`, partial: true, jobId });

/**
 * What a person does before a second try: preview again. No page lists every waiting job (the overview names the
 * first five of each reason, oldest first, and Fleet counts them), so a job that was just lost is found by the look
 * the preview itself makes (`queuedAlready`), which says when a run like it is already queued or running.
 */
export const LOOK_FIRST = "Preview it again first: the preview says when one is already queued or running";

/** The states of a job that has not ended, and the most of each one queue is asked for in a preview's look. */
const ALREADY_STATES = Object.freeze(["active", "waiting", "prioritized", "delayed", "paused"]);
export const ALREADY_PER_STATE = 200;

/** What a preview's look answers when it could not tell, and why: a queue it could not read, or a state with more jobs than it asks for. */
export const ALREADY_UNCHECKED = Object.freeze({ unchecked: true, why: "unread" });
export const ALREADY_CUT = Object.freeze({ unchecked: true, why: "cut" });

/**
 * Whether a run like the one a paid preview is about is already queued or running on `queues` (issue #961): the newest
 * job `match(job, state)` accepts as `{ jobId, queuedAt }`, null for none, `ALREADY_UNCHECKED` when a queue could not
 * be read, or `ALREADY_CUT` when no match was read and one state of a queue holds more than `ALREADY_PER_STATE` jobs.
 * Each state is asked for by itself, one more than the bound, so "more than were read" is said of a state that has
 * more and never of a queue whose states only add up to it. A paid start whose answer was lost says to preview again,
 * and a second try after the dedup window queues a second run with nothing to say so: this is what the preview says
 * instead. Never a refusal: a person may want a second run. Never throws; its caller's one-step timer is its bound.
 */
export async function queuedAlready(queues, match) {
  try {
    let cut = false;
    const hits = [];
    for (const q of queues) {
      if (typeof q?.getJobs !== "function") return ALREADY_UNCHECKED;
      const lists = await Promise.all(ALREADY_STATES.map((state) => q.getJobs([state], 0, ALREADY_PER_STATE)));
      lists.forEach((list, i) => {
        const jobs = (Array.isArray(list) ? list : []).filter(Boolean);
        if (jobs.length > ALREADY_PER_STATE) cut = true;
        for (const job of jobs.slice(0, ALREADY_PER_STATE)) if (match(job, ALREADY_STATES[i])) hits.push(job);
      });
    }
    hits.sort((x, y) => (Number(y.timestamp) || 0) - (Number(x.timestamp) || 0));
    if (hits.length > 0) return { jobId: String(hits[0].id), queuedAt: Number.isFinite(hits[0].timestamp) ? hits[0].timestamp : null };
    return cut ? ALREADY_CUT : null;
  } catch {
    return ALREADY_UNCHECKED;
  }
}

/** The matches a preview looks for, each by what the job's own data or id says (never by a job id's digest, which carries the minute). */
export const ALREADY_MATCH = Object.freeze({
  /**
   * A local run (a `dispatch_run`, a re-run of one, a cron trigger's run) of this flow in this folder, whatever its
   * task. Never a scheduler's run that is still delayed: a cron trigger always has its next tick waiting for its time,
   * so counting it made the warning permanent for every folder and flow a cron trigger names. A tick whose time has
   * come is waiting or active, and is a run like any other.
   */
  local: ({ folder, flow }) => (job, state) => job?.data?.kind === "local" && job.data.folder === folder && job.data.flow === flow && !(state === "delayed" && cronRunOf(job.id)?.kind === SCHEDULER_JOB_PREFIX),
  /** A hand-fired run of this cron trigger (Fire now, a canary, `pi-dispatch run --trigger`): never its scheduler's next tick, which always waits. */
  manual: (triggerId) => (job) => typeof job?.id === "string" && job.id.startsWith(`${MANUAL_JOB_PREFIX}:${triggerId}:`),
  /** A forge run of this flow on this item. */
  forge: ({ kind, repo, target, flow }) => (job) => job?.data?.kind === kind && job.data.repo === repo && job.data.flow === flow && job.data.target?.type === target?.type && job.data.target?.number === target?.number,
});

/**
 * The line a preview adds for `queuedAlready`'s answer about `what` ("a run of flow fix for this folder"), or null for
 * none. `counts`: whether a confirm of this action counts against the hour's allowance, which a refused duplicate
 * still does.
 */
export function alreadyQueuedLine(what, already, { counts = false } = {}) {
  if (!already) return null;
  if (already.unchecked === true) {
    return already.why === "cut"
      ? `Whether ${what} is already queued or running could not be checked: its queue holds more than ${ALREADY_PER_STATE} jobs of one state, and none of those read was one.`
      : `Whether ${what} is already queued or running could not be checked: its queue could not be read. Preview again before confirming.`;
  }
  const at = Number.isFinite(already.queuedAt) ? new Date(already.queuedAt) : null;
  const hhmm = at ? `, queued at ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` : "";
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} is already queued or running (${already.jobId}${hhmm}). Confirming asks for another: the queue refuses it while it takes it as a duplicate, and queues a second run after that.${counts ? " A refused one still uses a start of this hour." : ""}`;
}

/**
 * `queuedAlready` for a `dispatch_run`'s preview, which opens no queue of its own: this host's queue, the console's
 * bounded kind, one step under `timeoutMs`, its close started and never waited for.
 */
export async function dispatchRunAlready({ url, folder, flow, env = {}, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = PAID_PLAN_TIMEOUT_MS } = {}) {
  let queue = null;
  const release = () => {
    if (queue) void closeWithin(queue, QUEUE_CLOSE_TIMEOUT_MS);
    queue = null;
  };
  const work = (async () => {
    queue = queueFn(consoleQueueConnection(url, parseConnectionFn), { name: localQueueName(env) });
    return queuedAlready([queue], ALREADY_MATCH.local({ folder, flow }));
  })();
  try {
    return await within(work, timeoutMs, () => ALREADY_UNCHECKED);
  } catch {
    return ALREADY_UNCHECKED;
  } finally {
    release();
    work.then(release, release);
  }
}

/**
 * Plan a cancel of a job that never started (issue #737, `cancel-queued`). Free and writes nothing: one fleet discovery
 * and one `getJob` per queue asked (`openFleet`, `queue` first when given), the job's state, the scheduler's next instant
 * when it names a scheduler, and its waiting row (`readWaitingRow`, so the preview can say why it waits). The job's
 * `.data` is read inside this function for `recoveryOf` and `targetFor` alone, and never leaves it.
 *
 * Returns `{ plan: { jobId, queue, state, held, attemptsMade, stalledCounter, kind, target, waiting } }`, where `held`
 * is whether the worker holds it on `run.waitFor` (its `wait:job` hash has a clock: the hold's keys go with it),
 * `waiting` its waiting row or null when that could not be read, and `target` the record's spelling (`targetFor`) or
 * null; `{ refusal, status }` (400 an id outside the charset, 404 a job no fleet queue holds, 409 a job the rules do
 * not cancel: `cancelQueuedRefusal`'s words); or `{ unreachable }` when Valkey did not answer within `timeoutMs`.
 * `projects`/`triggers` (the projects list and the triggers view, optional) name the row's project as `readWaiting` does.
 */
export async function planCancelQueued({ url, jobId, queue = null, projects = null, triggers = null, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 } = {}) {
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return { refusal: "a job id is letters, digits and . _ : -, at most 200 characters", status: 400 };
  if (queue !== null && (typeof queue !== "string" || queue === "")) return { refusal: "queue must be a queue name", status: 400 };
  let fleet = null;
  let redis = null;
  const release = releaseOf(() => fleet, () => redis);
  const work = (async () => {
    fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
    const found = await fleet.find(jobId, queue);
    if (!found) return { refusal: `${notInFleet(jobId, fleet)}; nothing was changed`, status: 404 };
    // The console's bounded client (issue #987): no read of this preview waits past its bound for a Valkey that stopped
    // answering, and its socket is dropped at once when the preview's own timer fires first.
    redis = boundedClient(redisFn, url);
    const state = await found.job.getState().catch(() => "unknown");
    if (!WAITING_STATES.includes(state)) return { refusal: cancelQueuedRefusal("notQueued", { jobId, state }), status: 409 };
    const q = fleet.queueOf(found.queue);
    const refusal = await neverStartedRefusal(found.job, jobId, { redis, q });
    if (refusal !== null) return { refusal, status: 409 };
    const hold = await redis.hget(jobKey(jobId), "since");
    const row = await readWaitingRow(redis, { q, jobId, state, timeoutMs, projects, triggers });
    return {
      plan: {
        jobId,
        queue: found.queue,
        state,
        held: typeof hold === "string" && hold !== "",
        attemptsMade: 0,
        stalledCounter: 0,
        kind: typeof found.job.name === "string" && JOB_KIND_RE.test(found.job.name) ? found.job.name : null,
        target: targetOf(found.job.data),
        waiting: row?.row ?? null,
      },
    };
  })();
  try {
    return await within(work, timeoutMs, () => ({ unreachable: "timed out reaching the queue" }));
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    // Started, never awaited (`releaseOf`). A read still in flight when the bound fired may open a client or a queue
    // after this; it is released when it settles.
    release();
    work.then(release, release);
  }
}

/** The `expect` a cancel-queued apply must carry (the plan's queue and counts), or the refusal for one that does not. */
function cancelExpectProblem(expect) {
  if (expect === null || typeof expect !== "object") return "the preview's queue, attemptsMade and stalledCounter are required";
  if (typeof expect.queue !== "string" || expect.queue === "") return "expect.queue must be the preview's queue";
  if (countOf(expect.attemptsMade) === null) return "expect.attemptsMade must be a non-negative integer";
  if (countOf(expect.stalledCounter) === null) return "expect.stalledCounter must be a non-negative integer";
  return null;
}

/**
 * Whether a job moved since the preview, by the never-started rule's moving parts (issue #737): its state, and the
 * attempts, stall count and finish instant on BullMQ's own `Job` (which reads them as the worker writes them). The
 * refusal sentence, or null when nothing moved: `started` for a job a worker took (an active or finished state, a finish
 * instant, counts that grew), `notQueued` for a state no waiting job is in, `changed` for a job gone or counts that moved
 * otherwise. Asked of the job the confirm re-found, and again of a fresh read right before the removal is sent.
 */
function movedSince(jobId, expect, job, state) {
  if (!job) return cancelQueuedRefusal("changed", { jobId });
  if (STARTED_STATES.includes(state)) return cancelQueuedRefusal("started", { jobId });
  if (!WAITING_STATES.includes(state)) return cancelQueuedRefusal("notQueued", { jobId, state });
  // BullMQ writes `finishedOn` only when a job finishes, and clears it when one is moved back to wait: a waiting job
  // that carries one finished an attempt since the preview.
  if (job.finishedOn !== undefined && job.finishedOn !== null) return cancelQueuedRefusal("started", { jobId });
  const attempts = countOf(job.attemptsMade);
  const stalled = countOf(job.stalledCounter);
  if (attempts !== expect.attemptsMade || stalled !== expect.stalledCounter) {
    const grew = (attempts ?? 0) > expect.attemptsMade || (stalled ?? 0) > expect.stalledCounter;
    return cancelQueuedRefusal(grew ? "started" : "changed", { jobId });
  }
  return null;
}

/**
 * The console's answer for a held job whose removal failed once its hold was cleared (`removeHeldJob`'s `cleared`: most
 * often a worker locked the job between the state read and the remove), from its state read again (`state`, "unknown"
 * when it could not be). Always `partial`, since the hold's keys are gone, and never the error's own words (BullMQ's,
 * or a client's, which can name a host): a job a worker took (an active or a finished state) started while its hold was
 * being cleared; any other is said to have lost its hold and stayed. Shared by `cancel-queued` and `cancelHeldJob`, so
 * neither sentence names a preview: the TUI's panel and the model's tool, which reach `cancelHeldJob`, show none.
 *
 * THE OUTCOME FIRST AND THE JOB ID LAST (`jobLast`), and NO OTHER MODULE'S WORDS in an answer that is `partial`: what
 * happened is the part of the audit row that matters most when part of the change may have been made, and an error's
 * words (up to 200 characters) could push it past the row's cut. With a 64-character id every partial sentence fits the
 * row's field whole (a test drives `cancelQueuedJob` and `cancelHeldJob` through every answer and holds each to it).
 */
export function heldClearedAnswer(jobId, state) {
  if (STARTED_STATES.includes(state)) return { invalid: jobLast("the job was not removed: it started while its hold was being cleared, and its hold's record is gone; look at the fleet", jobId), partial: true };
  return { invalid: jobLast("the job was not removed, though its hold was cleared: it may still be queued without one; cancel it again if the fleet shows it", jobId), partial: true };
}

/**
 * The answer for a held job's removal that `removeHeldJob` refused before anything was deleted (or after a first delete
 * that failed with the hold read back in place): nothing was changed, in its words (`theirWords`), the job named last.
 * Shared by `cancel-queued` and `cancelHeldJob`.
 */
export const heldRefused = (jobId, text) => ({ invalid: jobLast(theirWords(text, jobId), jobId) });

/** The refusal when the job could not be read again right before its removal: nothing was sent, so nothing changed. */
const unreadBeforeRemoval = (jobId) => jobLast("the job could not be read again right before its removal, so it was not removed; nothing was changed", jobId);

/**
 * The answer for a removal BullMQ refused (`raced`) whose job could not be read back: the remove may have landed, so
 * `partial`, in the console's words alone (`heldClearedAnswer`'s rule).
 */
const removalUnreadBack = (jobId) => ({ invalid: jobLast("the job may or may not have been removed: its removal failed and it could not be read back; look at the fleet", jobId), partial: true });

/**
 * The answer for a removal whose outcome is not known: asked for and not answered within the bound (`unanswered`), or
 * answered in a way this console cannot read. True whatever was or was not sent, since the bound covers the removal's
 * first reads as well as its writes: it never says the removal was sent, nor that it was not. `held` (the re-checks
 * read a hold) names the hold too, whose keys go first; a hold that came after that read is still covered, since "may
 * or may not have been removed" claims nothing about one. The outcome first and the id last (`heldClearedAnswer`).
 */
export function removalUnknown(jobId, held, unanswered) {
  const gone = held ? "the job or its hold may or may not be gone: their removal" : "the job may or may not have been removed: its removal";
  const how = unanswered ? "was asked for and not answered within the bound" : "answered in a way this console cannot read";
  return { invalid: jobLast(`${gone} ${how}; look at the fleet`, jobId), partial: true };
}

/**
 * A held job's cancel that was asked for and not answered within its bound (`cancelHeldJob`'s, and `cancel-queued`'s
 * for a held job): `removalUnknown`'s held sentence, so the two doors say one thing of one outcome, `{ invalid, partial }`.
 */
export const heldRemovalUnanswered = (jobId) => removalUnknown(jobId, true, true);

/**
 * A sentence another module wrote, as an answer may carry it: control bytes made spaces, at most 200 characters. The
 * way a cancel's or a planner's answer carries an error's own words (BullMQ's, a client's, a parse of a job's data);
 * the file funnels' validation sentences, the console's own words about the operator's file, stay whole.
 */
export function boundedText(text) {
  return scrubControls(String(text ?? "no reason given")).slice(0, 200);
}

/**
 * Cancel a job that never started (issue #737), after the preview `planCancelQueued` made. `expect` is the plan's `{
 * queue, attemptsMade, stalledCounter }`. Re-finds the job (the preview's queue first) and refuses, in
 * `cancelQueuedRefusal`'s words, a job that moved to another queue or moved since the preview (`movedSince`), and any
 * job the never-started rules now refuse (re-checked, the scheduler's next run included). Then the worker's
 * `removeQueuedJob` (its held keys first, then the job, then its defer record), with a guard that reads the job's state
 * and hash again right before the removal is sent and refuses by `movedSince` once more: BullMQ's remove checks only the
 * lock and the scheduler, and would remove a job a worker took and finished, or failed back to the delayed set, in the
 * round trips since the re-check. What remains is the one round trip between that read and the remove; for a held job,
 * `removeHeldJob`'s own steps (its state read again, then the hold's deletes) come between, and a worker that takes the
 * job there is refused by its lock after the hold was cleared (`heldClearedAnswer`).
 *
 * ONE RULE for what it answers: "nothing was changed" only when nothing was. The re-checks change nothing, so that is
 * each of their refusals, and `{ unreachable }` (Valkey did not answer them within `timeoutMs`). Then the removal is
 * asked for, and bounded by `timeoutMs` as ONE step: its own reads (the hold's hash, the guard's, `removeHeldJob`'s) and
 * its writes alike. Of its answers, nothing was changed after the guard's refusal (nothing was sent), `removeHeldJob`'s
 * refusal before its first delete or after a first delete that failed with the hold read back in place (`{ invalid }`
 * without `cleared`), and a removal BullMQ refused while the job was read back in place (`{ raced }` with
 * a state: its remove is one script, so a job still there was not removed; a worker's lock is `started`). Every other
 * answer is `{ invalid, partial: true }`: a bound that fired (which can be before anything was sent or after, so it says
 * only that the removal was asked for and may have landed: `removalUnknown`), a throw or an answer this does not know,
 * a job not read back, and a held job whose removal failed after its hold was cleared (`heldClearedAnswer`, from its
 * state read again).
 *
 * Returns `{ ok: true, jobId, queue, held }`, `{ invalid }`, `{ invalid, partial: true }` or `{ unreachable }`. Answers
 * within `timeoutMs` for each phase whatever Valkey does: its queues' close is started, never awaited (`releaseOf`).
 * `removeQueuedJobFn` is a seam (the worker's `removeQueuedJob` by default).
 */
export async function cancelQueuedJob({ url, jobId, expect, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, removeQueuedJobFn = removeQueuedJob, timeoutMs = 2500, touchStore = undefined, touchOutbox = null, now = Date.now, interventionOrigin = "human" } = {}) {
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return { invalid: "a job id is letters, digits and . _ : -, at most 200 characters" };
  const problem = cancelExpectProblem(expect);
  if (problem) return { invalid: problem };
  let fleet = null;
  let redis = null;
  const release = releaseOf(() => fleet, () => redis);
  // The re-checks: everything before the removal, which changes nothing and so may answer unreachable on a timeout.
  const check = (async () => {
    fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
    const found = await fleet.find(jobId, expect.queue);
    if (!found || found.queue !== expect.queue) return { invalid: cancelQueuedRefusal("changed", { jobId }) };
    const state = await found.job.getState().catch(() => "unknown");
    const moved = movedSince(jobId, expect, found.job, state);
    if (moved !== null) return { invalid: moved };
    // The console's bounded client (issue #987): the removal writes through it (the hold's keys, the defer record), so a
    // command a Valkey took and never answered ends at the bound, and one that was not sent by then is never sent later.
    redis = boundedClient(redisFn, url);
    const q = fleet.queueOf(found.queue);
    const refusal = await neverStartedRefusal(found.job, jobId, { redis, q });
    if (refusal !== null) return { invalid: refusal };
    // Whether a hold's keys go with it, for an answer that cannot say what landed. Only words: the removal's own read of
    // the hash decides the path, and a read that fails here is no hold named.
    const hold = await Promise.resolve()
      .then(() => redis.hget(jobKey(jobId), "since"))
      .catch(() => null);
    return { found, q, state, held: typeof hold === "string" && hold !== "" };
  })();
  try {
    const checked = await within(check, timeoutMs, () => ({ unreachable: "timed out reaching the queue" }));
    if (!checked.found) return checked;
    const { found, q, state, held } = checked;
    // The state first, then the job's hash (a fresh `getJob`, BullMQ's own reading of `atm`, `stc` and `finishedOn`): a
    // job that finishes or fails back between the two reads is caught by the hash, and one a worker takes after it is
    // locked, which the remove refuses. A read that fails refuses: nothing has been sent yet.
    const guard = async () => {
      try {
        const now = await found.job.getState();
        const fresh = await q.getJob(jobId);
        return movedSince(jobId, expect, fresh ?? null, now);
      } catch {
        return unreadBeforeRemoval(jobId);
      }
    };
    let res;
    try {
      res = await within(Promise.resolve().then(() => removeQueuedJobFn({ redis, queue: q, job: found.job, jobId, state, guard, touchStore, touchOutbox, now, interventionOrigin })), timeoutMs, () => ({ timedOut: true }));
    } catch {
      return removalUnknown(jobId, held, false);
    }
    // `partial`: the removal was asked for, so the job may be gone or its hold may be. The console's bar then says it did
    // not finish, never "nothing was changed" (actions.mjs `funnelResult`, the confirm's `partial` state).
    if (res?.timedOut) return removalUnknown(jobId, held, true);
    if (res?.ok) return { ok: true, jobId, queue: found.queue, held: res.held === true, ...(res.touchWarning ? { touchWarning: res.touchWarning } : {}) };
    // The guard refused: nothing was sent.
    if (res !== null && typeof res === "object" && Object.hasOwn(res, "refused")) return { invalid: typeof res.refused === "string" ? res.refused : unreadBeforeRemoval(jobId) };
    if (typeof res?.invalid === "string" && res.cleared === true) {
      const after = await within(Promise.resolve().then(() => found.job.getState()).catch(() => "unknown"), timeoutMs, () => "unknown");
      return heldClearedAnswer(jobId, after);
    }
    // `removeHeldJob`'s refusal before anything was deleted (or a first delete that failed with the hold read back in
    // place): its own sentence, or a client's error, bounded either way, the job named last.
    if (typeof res?.invalid === "string") return heldRefused(jobId, res.invalid);
    if (res?.notQueued) return { invalid: STARTED_STATES.includes(res.state) ? cancelQueuedRefusal("started", { jobId }) : cancelQueuedRefusal("notQueued", { jobId, state: String(res.state ?? "in an unknown state") }) };
    if (res?.localSignalChanged) return { invalid: jobLast(`local event cancellation ${res.localSignalChanged === "yes" ? "was stored" : "may be stored"}; queue removal is unconfirmed; cancel again; later events stay eligible`, jobId), partial: true };
    if (res?.raced) {
      // Not read back: BullMQ's own "unknown" (in no list) or a read that failed. The remove may have landed.
      if (typeof res.state !== "string" || res.state === "unknown") return removalUnreadBack(jobId);
      if (STARTED_STATES.includes(res.state)) return { invalid: cancelQueuedRefusal("started", { jobId }) };
      // What happened first, then BullMQ's words, then the job: a long error is what the audit row's cut may take.
      return { invalid: jobLast(`the job could not be removed: it is ${res.state} now; nothing was changed; the remove failed with: ${theirWords(res.error?.message ?? res.error, jobId)}`, jobId) };
    }
    return removalUnknown(jobId, held, false);
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    release();
    check.then(release, release);
  }
}

/** What a re-run says of a run id outside the run-id charset: the planner's first refusal, and `rerunRefusalOf`'s. */
export const RERUN_BAD_ID = "a run id is letters, digits and . _ : -, at most 200 characters";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long the queue keeps a finished job's data, by kind, at the LONGEST it can, from the queue's own values
 * (`@edgehero/pi-dispatch/retention`, issue #761): a local job's `removeOnComplete` is `LOCAL_JOB_KEPT_COMPLETED_S` and
 * its `removeOnFail` `LOCAL_JOB_KEPT_FAILED_S`; a forge job's, and a recovery job's, `FORGE_JOB_RETENTION_*` either way.
 * The record does not say which of BullMQ's two ends a local job met (a policy refusal or a failure the worker returned
 * is BullMQ's "completed", a thrown one its "failed"), so a record alone may only infer the data gone past the longer.
 * A recovery job (a record with `recoveryOf`, `<runId>.r<n>`) is kept the forge retention whatever its kind
 * (recovery-queue.mjs adds it with the forge jobs' retention), so a local run's recovery is judged by that window, not
 * the local one.
 *
 * Inlined into the admin's build (`admin/build.mjs`), so a console built one release behind a changed value judges by
 * its old one; that inference is made only when the data was not read, and `RERUN_KEPT_SLACK_MS` gives it a day.
 */
export const RERUN_DATA_KEPT_MS = Object.freeze({ local: LOCAL_JOB_KEPT_FAILED_S * 1000, forge: FORGE_JOB_RETENTION_MS, recovery: FORGE_JOB_RETENTION_MS });

/**
 * What each re-run and reply refusal says of `RERUN_DATA_KEPT_MS`, worded from the same values, so the sentence cannot
 * state a retention the queue does not keep. The local one names both of BullMQ's ends, for the reason above.
 */
export const RERUN_DATA_KEPT_TEXT = Object.freeze({
  local: `a local job's data is kept ${LOCAL_JOB_KEPT_COMPLETED_S / 3600} hours after it completes and ${LOCAL_JOB_KEPT_FAILED_S / 86_400} days after it fails`,
  forge: `a forge job's data is kept ${FORGE_JOB_RETENTION_DAYS} days`,
  recovery: `a recovery job's data is kept ${FORGE_JOB_RETENTION_DAYS} days`,
});

/**
 * The slack past `RERUN_DATA_KEPT_MS` before a record alone says the data is gone. The window runs from BullMQ's
 * `finishedOn`, and the record's `endedAt` can be earlier: the record of an attempt a later attempt retried without
 * writing its own (last-write-wins), or another host's clock. BullMQ also removes by age only when a later job finishes,
 * so data can outlive its window on a quiet queue; a day is room for both. Too little slack would hide a re-run that
 * works; too much only shows a form whose click refuses, which the planner then says.
 */
export const RERUN_KEPT_SLACK_MS = DAY_MS;

/**
 * The re-run refusals that need neither git nor the triggers file (issue #710): what the console's run page asks to
 * decide whether to offer the re-run form at all, and what `planRerun` asks FIRST, so the two cannot disagree. Pure.
 * `record` is the run record (its `jobId` and `kind`, and `endedAt` for the inference below); `now` the instant in
 * millis; `data` the retained job's data as the queue holds it: an object, `null` when the queue holds none, or
 * `undefined` when it was not read. Returns the refusal sentence, byte for byte the planner's, or null.
 *
 * In the planner's order:
 *   - a run id outside the run-id charset;
 *   - a record a newer pi-dispatch wrote (`fromNewerRelease`), which reaches here as its stable core alone;
 *   - a cron run (`repeat:`/`manual:` ids) is rebuilt from its trigger, never from data, so nothing here refuses it;
 *   - data a newer pi-dispatch queued (`jobDataNewer`: a `dataVersion` this build cannot read), whose fields the copy
 *     would drop, refused as a record a newer release wrote is;
 *   - the data gone: `data === null`, or, NOT READ, a record that ended longer ago than its kind's longest retention
 *     (`RERUN_DATA_KEPT_MS` plus `RERUN_KEPT_SLACK_MS`; a recovery record's is the forge one), which is the one refusal a
 *     record alone can make;
 *   - a `/command` run, and a forge run that answered a parked run (both facts of the data, which the record does not
 *     carry: unread data refuses neither);
 *   - a kind the console cannot re-run (judged on the data's kind, the planner's, so only with the data read).
 * Everything after (a local folder's rule, the cron trigger, the forge trigger now, a replica) is the planner's alone.
 */
export function rerunRefusalOf(record, now, data) {
  const jobId = record?.jobId;
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return RERUN_BAD_ID;
  // Issue #761: a record a newer pi-dispatch wrote is read here as its stable core alone, and that release's job may
  // carry fields this build would drop on the copy, so the run is re-run from a console of that release.
  if (fromNewerRelease(record)) return `${jobId} was recorded by a newer pi-dispatch, whose run this console cannot rebuild, so it cannot be re-run from here; re-run it from a console of that release`;
  const kind = typeof data?.kind === "string" ? data.kind : record.kind;
  if (kind === "local" && cronTriggerId(jobId) !== null) return null;
  // Issue #761: a job a newer pi-dispatch queued may carry a field this build's copy below drops, so the re-run would be
  // wider than the job it copies (and would be stamped with this build's version, erasing the evidence). A cron run,
  // above, is rebuilt from its trigger alone and copies nothing of the data, so only a copied job's version refuses.
  if (jobDataNewer(data)) return `${jobId} was queued by a newer pi-dispatch, whose job this console cannot rebuild, so it cannot be re-run from here; re-run it from a console of that release`;
  const forge = isForgeKind(kind);
  const ended = typeof record.endedAt === "string" ? Date.parse(record.endedAt) : Number.NaN;
  const recovery = typeof record.recoveryOf === "string" && record.recoveryOf !== "";
  const windowed = kind === "local" || forge;
  const keptMs = !windowed ? null : recovery ? RERUN_DATA_KEPT_MS.recovery : kind === "local" ? RERUN_DATA_KEPT_MS.local : RERUN_DATA_KEPT_MS.forge;
  const inferredGone = data === undefined && keptMs !== null && Number.isFinite(ended) && Number.isFinite(now) && now - ended > keptMs + RERUN_KEPT_SLACK_MS;
  if (data === null || inferredGone) {
    const kept = recovery ? RERUN_DATA_KEPT_TEXT.recovery : kind === "local" ? RERUN_DATA_KEPT_TEXT.local : RERUN_DATA_KEPT_TEXT.forge;
    return `the queue no longer holds ${jobId}'s data (${kept}), and the run record cannot rebuild it, so it cannot be re-run from here`;
  }
  if (data === undefined || data === null || typeof data !== "object") return null;
  if (data.command !== undefined) return `${jobId} ran the command /${data.command}, and a /command run is not re-run from the console; it runs from its reviewed trigger`;
  if (kind === "local") return null;
  if (forge) return data.parkedReply === true ? `${jobId} answered a parked run; answer the parked run again from the parked inbox instead of re-running the answer` : null;
  return `${jobId} is a ${String(kind)} run, which the console cannot re-run`;
}

/**
 * A planner's refusal for a run whose record `readRunById` did not hand it (issue #737), the re-run's and the answer's
 * alike: its `invalid` as it is; "no run record" only where the reader says both places were read and hold none
 * (`missing`); and for any other answer the read that failed (`unreadable`, else `RUN_RECORD_UNREAD`) and that nothing
 * was queued, never that the run has no record. `act` is what could not be done ("re-run", "answered").
 */
export function recordReadRefusal(read, jobId, act) {
  if (typeof read?.invalid === "string") return read.invalid;
  if (read?.missing === true) return `no run record for ${jobId} on this host or in the fleet mirror`;
  return `${typeof read?.unreadable === "string" ? read.unreadable : RUN_RECORD_UNREAD}, so ${jobId} cannot be ${act} now; nothing was queued, try again`;
}

/**
 * A parked answer's refusal for a run that is not parked: how it ended, its outcome and its reason each only as a token
 * (`recordReason`'s rule, the record's reason as every surface carries it: a value that is no token is shown to nobody,
 * and a mirrored record can hold any value), "unknown" for an outcome that is none.
 */
function notParkedRefusal(jobId, record) {
  const outcome = typeof record?.outcome === "string" && RECORD_REASON_RE.test(record.outcome) ? record.outcome : "unknown";
  const reason = recordReason(record);
  return `${jobId} is not parked (it ended ${outcome}${reason === null ? "" : `, ${reason}`}), so there is no question to answer`;
}

/**
 * Plan a RE-RUN of a finished run (issue #642). Free: reads the run record, the retained BullMQ job and the triggers
 * file, writes nothing. `{ plan }` or `{ refusal }`.
 *
 *   - LOCAL (a `/dispatch run`, `pi-dispatch run` or a chained child): the retained job's folder, flow and task, queued
 *     as `/dispatch run` queues them (`enqueueLocalJobReporting`, this host's queue), after its folder rule (a
 *     repository root with a commit, no uncommitted changes). A local job's data is kept `LOCAL_JOB_KEPT_COMPLETED_S`
 *     after it completes and `LOCAL_JOB_KEPT_FAILED_S` after it fails; past that the run cannot be rebuilt (the record
 *     holds no folder, by design).
 *   - CRON (`repeat:` or `manual:` ids): the trigger as the triggers file says NOW, fired once by hand
 *     (`enqueueTriggerRunReporting`, `pi-dispatch run --trigger`'s path and refusals: gone from the file, another
 *     host's folder, not a repository).
 *   - FORGE: the WHERE from the retained job's data (kept `FORGE_JOB_RETENTION_DAYS`: repo, target, projectId, azure,
 *     the trigger context), the WHAT from the triggers file NOW: the trigger at the retained `matched.index` must still
 *     be the one that matched (same forge, type, action or label, and flow; `currentTriggerFor`), else refused "the
 *     trigger that started this run changed or is gone; start it again from the forge". Its run fields are copied as the
 *     receiver copies them (`runFieldsOf`), so a narrowed trigger re-runs narrowed and a deleted one does not re-run. A
 *     fresh delivery id (`console-<hex>`) makes the job id new, and it is routed as the receiver routes it (a host queue
 *     when a secret or wait profile needs one).
 *
 * Refused by name: no record, data expired, a `/command` run (commands run only from their reviewed trigger), an answer
 * to a parked run (answer the parked run again instead), a record or a job a newer pi-dispatch wrote (issue #761), and
 * whatever the original path refuses. The cheap ones of these (the id, a newer record or job, the data gone, a
 * `/command`, a parked answer, an unsupported kind) are `rerunRefusalOf`'s, asked first (issue #710), which is also
 * what the console's run page asks before it offers the form. The 10-minute semantic window can still swallow a forge
 * re-run; only the enqueue can tell, so `enqueueRerun` reports it.
 *
 * `plan`: `{ kind: "local" | "cron" | "forge", jobId (the run re-run), queue, job (the data to enqueue), reserve,
 * schedule? (cron), forge? (the forge kind), deliveryId? (forge), runFields? (forge: `runFieldsSummary`, names only) }`.
 * `reserve` is `estimateReserve`'s over the deployment's `overlay`, `env` (its PI_MAX_COST_USD, PI_PROVIDER, PI_MODEL
 * and PI_ALLOWED_MODELS) and the worker's pickup inputs `modelEndpoints` (`{ models, endpoints }`) and `builtinModel`;
 * without the last two a job is judged not zero-rated, so the figure is never below what the worker holds. `notional`
 * (issue #1008) names the providers the hosts publish as bound to a subscription with no paid extra usage, so a job
 * that reaches only those is estimated to hold nothing in the dollar windows; null keeps the cap's figure.
 */
export async function planRerun({
  url,
  logsDir,
  jobId,
  triggersPath = null,
  overlay = {},
  env = {},
  modelEndpoints = null,
  builtinModel = () => null,
  notional = null,
  redisFn = makeRedisClient,
  queueFn = makeQueue,
  parseConnectionFn = parseConnection,
  localRepoProblemFn = localRepoProblem,
  gitDirtyFn = gitDirty,
  loadSchedulesFn = loadSchedules,
  random = randomBytes,
  fs = nodeFs,
  timeoutMs = 2500,
  planTimeoutMs = PAID_PLAN_TIMEOUT_MS,
  lookAlready = true,
  now = Date.now,
} = {}) {
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return { refusal: RERUN_BAD_ID };
  // The look for a run like this one is the preview's (`lookAlready`): a confirm's re-plan has no use for it, and on a
  // Valkey that stopped answering it added its list reads' bound to the confirm's.
  const look = (queue, match) => (lookAlready ? queuedAlready([queue], match) : null);
  let redis = null;
  let fleet = null;
  const release = releaseOf(() => fleet, () => redis);
  // ONE step with its own end (issue #961, `planCancelQueued`'s pattern): each read below has a bound, and a queue that
  // never connects has none, so without this the preview stayed open for as long as that queue took to give up.
  const work = (async () => {
    redis = boundedClient(redisFn, url);
    const read = await readRunById(redis, { logsDir, jobId, fs, timeoutMs });
    // `unread` (issue #961): the record was not read, which is no fact about the run. A confirm that re-plans says
    // Valkey could not be reached for it, never that the run changed.
    if (!read.record) return { refusal: recordReadRefusal(read, jobId, "re-run"), ...(read.missing !== true && typeof read.invalid !== "string" ? { unread: true } : {}) };
    const record = read.record;
    const touchSource = ["policy", "failed"].includes(record.outcome) ? { runId: jobId, cause: "rerun", ...(Number.isSafeInteger(Date.parse(record.endedAt)) ? { endedAt: Date.parse(record.endedAt) } : {}), scopeId: record.touchScopeId ?? touchScopeOf(record, record.host), ...(record.project ? { project: record.project } : {}) } : null;
    fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
    const found = await fleet.find(jobId);
    // Not found among queues that could not all be asked is not "its data expired".
    if (!found && (fleet.blind || fleet.incomplete)) return { refusal: `the deployment's queues could not all be read, so ${jobId}'s job was not looked for in every queue; nothing was queued, try again`, unread: true };
    const data = found?.job?.data ?? null;
    const kind = typeof data?.kind === "string" ? data.kind : record.kind;
    const reserveOf = (jobData) => estimateReserve(jobData, { overlay, env, modelEndpoints, builtinModel, notional });
    // Issue #710: the cheap refusals first, through the very function the run page asks before it offers the form, so
    // the page never offers a re-run this refuses on the record and the data alone, and never hides one this would plan.
    // The record under the id asked for, so each sentence names it as before.
    const cheap = rerunRefusalOf({ ...record, jobId }, now(), data);
    if (cheap !== null) return { refusal: cheap };

    const triggerId = kind === "local" ? cronTriggerId(jobId) : null;
    if (triggerId !== null) {
      if (typeof triggersPath !== "string" || triggersPath === "") return { refusal: "the triggers file is not known here (PI_TRIGGERS_FILE), so a cron run cannot be rebuilt from its trigger" };
      let schedule;
      try {
        schedule = loadSchedulesFn({ triggersFile: triggersPath, maxCostUsd: env.PI_MAX_COST_USD === "" ? null : (env.PI_MAX_COST_USD ?? null) }, { fleet: Boolean(env.PI_WORKER_NAME) }).find((s) => s.schedulerId === triggerId);
      } catch (e) {
        return { refusal: `${e?.message ?? e}. Nothing was queued` };
      }
      if (!schedule) return { refusal: `no cron trigger with id "${triggerId}" in ${triggersPath} any more, so there is nothing to re-run` };
      if (schedule.unserved) return { refusal: `cron trigger "${triggerId}" runs on another host: its folder is not on this machine. Re-run it from that host's console` };
      if (schedule.data?.command !== undefined) return { refusal: `cron trigger "${triggerId}" runs the command /${schedule.data.command}, and a /command run is not re-run from the console; it runs from its reviewed trigger` };
      const folder = folderRefusal(schedule.data.folder, { localRepoProblemFn, gitDirtyFn, cron: true });
      if (folder) return { refusal: `cron trigger "${triggerId}": ${folder}` };
      const queue = localQueueName(env);
      return { plan: { kind: "cron", jobId, ...(touchSource ? { touchSource } : {}), queue, schedule, job: schedule.data, reserve: reserveOf(schedule.data) }, already: await look(fleet.queueOf(queue), ALREADY_MATCH.manual(triggerId)) };
    }

    if (kind === "local") {
      if (typeof data.flow !== "string" || data.flow.trim() === "") return { refusal: `${jobId} named no flow, and a run needs one` };
      if (typeof data.folder !== "string" || data.folder === "") return { refusal: `${jobId}'s data names no folder` };
      const folder = folderRefusal(data.folder, { localRepoProblemFn, gitDirtyFn });
      if (folder) return { refusal: folder };
      const job = { folder: data.folder, flow: data.flow, task: data.task, ...randomRerunFields(data) };
      const queue = localQueueName(env);
      return { plan: { kind: "local", jobId, ...(touchSource ? { touchSource } : {}), queue, job, reserve: reserveOf(job) }, already: await look(fleet.queueOf(queue), ALREADY_MATCH.local(job)) };
    }

    if (isForgeKind(kind)) {
      // WHERE comes from the retained job, WHAT RUNS from the triggers file now. The retained run fields are what the
      // trigger said up to `FORGE_JOB_RETENTION_DAYS` ago: replaying them would run a cap, a model list, a secret profile
      // or an image the operator has since narrowed or removed, under a trigger that may be gone. So the trigger at the
      // retained index must still be the one that matched, and the run fields are copied from it as the receiver would
      // copy them.
      if (typeof triggersPath !== "string" || triggersPath === "") return { refusal: "the triggers file is not known here (PI_TRIGGERS_FILE), so a forge run cannot be rebuilt from its trigger" };
      const loaded = loadTriggerEntries(triggersPath, fs);
      if (loaded.refusal) return { refusal: loaded.refusal };
      const current = currentTriggerFor(loaded.entries, kind, data);
      if (current.refusal) return { refusal: current.refusal };
      // A replica re-runs as itself (its id and semantic slot keep their `:r<n>`), and only while the trigger still races
      // that many: a replica the trigger no longer makes is a run the file no longer asks for.
      if (data.replica !== undefined && !(Number.isInteger(current.run.replicas) && current.run.replicas >= data.replica)) return { refusal: `${TRIGGER_CHANGED} (it no longer runs replica ${String(data.replica)})` };
      const deliveryId = consoleDeliveryId(random);
      // Never the retained `console` provenance or any other retained field: a re-run is not an answer (and the trail
      // would name an answer nobody gave again), and every run field is the current trigger's.
      const job = {
        repo: data.repo,
        ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
        ...(data.azure !== undefined ? { azure: data.azure } : {}),
        target: data.target,
        ...runFieldsOf(current.entry, data.flow),
        ...(data.replica !== undefined ? { replica: data.replica } : {}),
        trigger: { ...(data.trigger ?? {}), deliveryId },
      };
      const forgePlan = { kind: "forge", forge: kind, jobId, ...(touchSource ? { touchSource } : {}), deliveryId, queue: forgeQueueName(kind, job, fleet.hosts), job, runFields: runFieldsSummary(job), reserve: reserveOf(job) };
      return { plan: forgePlan, already: await look(fleet.queueOf(forgePlan.queue), ALREADY_MATCH.forge({ kind, repo: job.repo, target: job.target, flow: job.flow })) };
    }
    // Unreachable: `rerunRefusalOf` refused every kind that is neither local nor a forge's. Kept so a kind added to one
    // and not the other still refuses rather than returning nothing.
    return { refusal: `${jobId} is a ${String(kind)} run, which the console cannot re-run` };
  })();
  try {
    return await within(work, planTimeoutMs, () => ({ refusal: `could not read the run or its job (no answer within ${planTimeoutMs / 1000} seconds); nothing was queued`, unread: true }));
  } catch (err) {
    return { refusal: `could not read the run or its job (${boundedText(err?.message ?? String(err))}); nothing was queued`, unread: true };
  } finally {
    // Started, never awaited (`releaseOf`); a read still in flight when the bound fired is released when it settles.
    release();
    work.then(release, release);
  }
}

/**
 * Queue a re-run that `planRerun` planned (issue #642). A local plan re-checks its folder first (it can have changed
 * since the preview). Returns `{ ok: true, jobId, queue }` for a job created, or, when a dedup answered and NOTHING was
 * queued, `{ refusal, deduplicated: true, jobId, survivingJobId? }` naming why: the local one-minute window, the cron
 * minute's, or a forge job's 10-minute semantic window (the same target and flow ran or is running). `{ refusal }` for a
 * plan that is not one, and for a forge job its helper refused before any add (`forgeUnsent`, issue #987);
 * `{ unreachable }` for Valkey, with nothing sent; `{ invalid, partial }` once an add was started and not confirmed.
 * A fork of a run is queued through here as a forge plan (`enqueueRunFork`), so all of it holds for a fork. `queue` is
 * the queue the job is on: the plan's, or the queue of an approval's owner host when the helper routed the job there.
 * `counted` (issue #987): the caller counted this start against the hour's `dispatch_run` allowance (an agent's
 * re-run), so an add that was not confirmed says the start was used (`enqueueUnconfirmed`).
 */
export async function enqueueRerun(plan, { url, queueFn = makeQueue, parseConnectionFn = parseConnection, localRepoProblemFn = localRepoProblem, gitDirtyFn = gitDirty, now = () => Date.now(), touchStore = null, touchOutbox = null, interventionOrigin = "human", connectTimeoutMs = CONFIRM_READ_TIMEOUT_MS, counted = false } = {}) {
  const kind = plan?.kind;
  if (kind !== "local" && kind !== "cron" && kind !== "forge") return { refusal: "not a re-run plan" };
  if (typeof plan.queue !== "string" || !(plan.queue === QUEUE || plan.queue.startsWith(`${QUEUE}@`))) return { refusal: "the plan names no queue" };
  if (kind === "local") {
    const folder = folderRefusal(plan.job?.folder, { localRepoProblemFn, gitDirtyFn });
    if (folder) return { refusal: `${folder} (it changed since the preview). Nothing was queued` };
  }
  const what = `the re-run of ${String(plan.jobId)}`;
  // Phase one, timed: a connected queue, or nothing was sent (`connectedQueue`).
  const connected = await connectedQueue({ url, options: { name: plan.queue }, queueFn, parseConnectionFn, connectTimeoutMs });
  if (!connected.queue) return { unreachable: connected.unreachable };
  const { queue, client } = connected;
  const route = routedQueueOf({ url, queueFn, parseConnectionFn, connectTimeoutMs });
  let intent = null;
  let tracker = null;
  // Whether the add was started, and whether an answer was lost: after the first no error says "nothing was queued"
  // but Valkey's own, and after the second no further command is waited for. `forging` is a forge job handed to its
  // helper, whose own checks come before its add (issue #987).
  let sent = false;
  let lost = false;
  let forging = false;
  const done = async (result) => {
    if (!intent) return result;
    const pending = intent;
    intent = null;
    let tracked = null;
    try {
      tracked = await tracker.applied(pending);
    } catch {
      // the run is queued; only its accounting is not
    }
    return tracked?.ok ? result : { ...result, touchWarning: "touch-tracking-incomplete" };
  };
  try {
    const store = touchStore ?? (client ? makeTouchStore({ redis: client, now }) : null);
    if (interventionOrigin !== "agent" && plan.touchSource && (store || touchOutbox)) {
      tracker = touchOutbox ?? { begin: (event) => store.begin(event), applied: (pending) => store.write(pending.event), abort: (pending) => store.abort(pending.event) };
      intent = await tracker.begin({ ...plan.touchSource, at: now(), nonce: `rerun:${plan.jobId}:${plan.deliveryId ?? now()}` });
    }
    // Phase two, NOT timed (issue #961): the queue's client bounds each command, and a timer that fired first could
    // only say less than its error does.
    if (kind === "local" || kind === "cron") {
      sent = true;
      const { id, existing } = kind === "local"
        ? await enqueueLocalJobReporting(queue, { folder: plan.job.folder, flow: plan.job.flow, task: plan.job.task, ...randomRerunFields(plan.job), now: new Date(now()) })
        : await enqueueTriggerRunReporting(queue, plan.schedule, { now: new Date(now()) });
      if (existing === undefined) {
        lost = true;
        return enqueueUnread(what, id);
      }
      if (existing) return { refusal: swallowedRunSentence(id, existing), deduplicated: true, jobId: id };
      return await done({ ok: true, jobId: id, queue: plan.queue });
    }
    // A forge job's mark is set by the helper, right before each add (issue #987): its builder, its read of a durable
    // approval and its routed queue's connect come first, and each throws with nothing sent (`forgeUnsent`).
    forging = true;
    const res = await enqueueForgeJob(queue, plan.forge, plan.job, { routeFn: route.open, onAdd: () => { sent = true; } });
    if (res.deduplicated) return { refusal: `the same target and flow ran or is running within the last 10 minutes (job ${res.survivingJobId}), so the queue's semantic window took this re-run as a duplicate and nothing was queued. Try again once that window has passed`, deduplicated: true, jobId: res.jobId, survivingJobId: res.survivingJobId };
    // The queue the job is on: the routed one where the helper sent it to an approval's owner host, which is where its
    // cancel (the banner's Undo) has to look.
    return await done({ ok: true, jobId: res.jobId, queue: res.queue ?? plan.queue });
  } catch (err) {
    if (forging && !sent) {
      // A forge job refused before any add (issue #987). A builder's refusal, which Valkey had no part in, asks for
      // its intent's abort and waits for it before the answer leaves, so the refusal leaves no tracker begun behind it
      // (left begun, it is what makes the Zero touch page read unavailable) unless that abort itself gets no answer:
      // the touch store gives it 2 seconds and hands back its failure, and the intent then stays pending. Where Valkey
      // did not answer, the abort is started and not waited for, as after a lost answer.
      lost = unansweredBeforeAdd(err);
      return forgeUnsent(err);
    }
    // Only Valkey's own reply is an answer: after any other throw no further command is waited for.
    lost = !refusedByValkey(err);
    if (sent && lost) return enqueueUnconfirmed(what, { counted });
    return { unreachable: `${boundedText(err?.message ?? String(err))}; nothing was queued` };
  } finally {
    // The intent of a run that was not queued is taken back. After a lost answer that is started and not waited for:
    // its command would wait out the same bound on the Valkey that just did not answer.
    if (intent) {
      const aborting = Promise.resolve().then(() => tracker.abort(intent)).catch(() => {});
      if (!lost) await aborting;
    }
    // Started, never awaited: the answer does not wait for a QUIT.
    route.close();
    void closeWithin(queue, QUEUE_CLOSE_TIMEOUT_MS);
  }
}

/** A run's instant in millis, `endedAt` else `startedAt` (the mirror's score). */
function runAt(r) {
  const t = Date.parse(r?.endedAt ?? r?.startedAt ?? "");
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * The comment trigger for `kind` as the receiver groups it (`receiver/src/config.mjs`: `group.comment`), read from the
 * triggers file through the loaders' own parser: `{ index, phrase, run }` (the normalized run fields), null when the
 * file names none for that forge, or `{ refusal }` when the file does not load.
 */
function commentTriggerFor(triggersPath, kind, fs) {
  const loaded = loadTriggerEntries(triggersPath, fs);
  if (loaded.refusal) return loaded;
  for (const [index, { on, run }] of loaded.entries.entries()) {
    if (on.type !== "comment" || run.kind !== kind) continue;
    return { index, phrase: on.phrase, run, entry: { on, run } };
  }
  return null;
}

/**
 * Whether a parked run's RETAINED JOB can take an answer typed into the console (issues #642, #647): `{ kind, delivery,
 * rule }` or `{ refusal }`. The planner's refusals that the job's data and the triggers file decide, in its order: the
 * data expired (`data` null), data a newer pi-dispatch queued (`jobDataNewer`, issue #761), not a forge issue's run, a
 * pull request's park, and a comment trigger the receiver would not route a reply through (absent, a command, without
 * `run.resume`, without a flow). ONE predicate, so the run page's Chat panel offers the reply form exactly where
 * `planParkedAnswer` would plan it, and shows this sentence where it would not; whether the run is parked and still
 * unanswered is the caller's (the record and `chatModeOf`).
 */
export function parkedAnswerRefusalOf({ jobId, data, triggersPath, approval = false, fs = nodeFs }) {
  if (data === null || data === undefined) return { refusal: `the queue no longer holds ${jobId}'s data (${RERUN_DATA_KEPT_TEXT.forge}), so the reply cannot be built; answer on the forge instead` };
  // Issue #761: the reply copies its repo, project and target (and an approval's match) from this job, and is stamped
  // with this build's version: a newer pi-dispatch's job may carry a field that copy drops, so it is answered from a
  // console of that release, in the words a re-run of such a job uses.
  if (jobDataNewer(data)) return { refusal: `${jobId} was queued by a newer pi-dispatch, whose job this console cannot rebuild, so the reply cannot be built here; answer it from a console of that release` };
  const kind = data.kind;
  const delivery = COMMENT_DELIVERY[kind];
  if (!isForgeKind(kind) || !delivery) return { refusal: `${jobId} is a ${String(kind)} run; only a forge issue's parked run is answered this way` };
  if (approval && !Array.isArray(data.gates)) return { refusal: "the approval's retained job has no gate declaration; nothing was queued" };
  if (approval && Array.isArray(data.gates)) {
    const loaded = loadTriggerEntries(triggersPath, fs);
    if (loaded.refusal) return loaded;
    const index = data.trigger?.matched?.index;
    const entry = loaded.entries[index];
    if (!entry || entry.run.kind !== kind || entry.on.type !== data.trigger?.matched?.type || !entry.run.gates || entry.run.resume !== true) return { refusal: "the approval's original trigger no longer declares resumable gates; nothing was queued" };
    return { kind, delivery, rule: { index, run: entry.run, entry }, approval: true };
  }
  if (data.target?.type !== "issue") return { refusal: `${jobId} parked on a pull request, whose reply must carry the trigger phrase (the receiver's rule: its key needs the head branch); answer on the forge` };
  if (typeof triggersPath !== "string" || triggersPath === "") return { refusal: "the triggers file is not known here (PI_TRIGGERS_FILE), so the reply cannot be built as the receiver builds it" };
  const rule = commentTriggerFor(triggersPath, kind, fs);
  if (rule?.refusal) return { refusal: rule.refusal };
  if (!rule) return { refusal: `the triggers file has no ${kind} comment trigger, so the receiver would not route a reply either` };
  if (rule.run.command !== undefined) return { refusal: `the ${kind} comment trigger runs a command, and a parked reply resumes only a flow (the receiver's rule)` };
  if (rule.run.resume !== true) return { refusal: `the ${kind} comment trigger does not set run.resume, so a reply cannot resume the parked transcript (the receiver's rule)` };
  if (typeof rule.run.flow !== "string" || rule.run.flow === "") return { refusal: `the ${kind} comment trigger names no flow` };
  return { kind, delivery, rule };
}

/**
 * Plan an ANSWER to a parked run, typed into the console (issue #642, REQ-AWAIT-INPUT). Free; `{ plan }` or `{ refusal }`.
 *
 * The job is the one the RECEIVER builds for a phrase-free reply on that forge (`routeComment`'s parked-reply path),
 * field for field: the comment trigger's run fields as the triggers file says now, `parkedReply: true`, `matched` naming
 * the comment trigger, and `trigger.comment.body` the answer. Only four things differ, by design: the delivery id (a
 * fresh `console-<hex>`), the sender (`{ id: null }`: no forge account sent it), the GitHub author association
 * (`CONSOLE_ASSOCIATION`) and `console: { by }`, the token's name, which the worker prints in its trail comment.
 * `repo`, `projectId`, `azure` and the target come from the parked run's retained job, so the reply lands on the
 * transcript that parked. Then the worker's own gates apply as for any reply, the `not-parked` check first.
 *
 * Refused by name: a `by` that is not a token name; an empty or oversized answer (`boundAnswerText`: control characters
 * scrubbed, newlines kept, at most 8 KiB, never cut); no record; a run that is not parked (not `completed` with
 * `awaiting-input`); already answered (a later run on the same target, `targetKeyOf`'s comparison); being answered (a
 * job on its target queued or running, which has no record yet: `readPendingAnswer`, issue #647), or that queue scan
 * unreadable or unable to tell (a queue deeper than its budget: `parkedVerdictOf`'s sentence, the Chat panel's); and `parkedAnswerRefusalOf`'s: expired job data, a job a newer pi-dispatch queued, a pull request's park (its reply needs the
 * head branch, so it keeps the phrase, the receiver's rule), and a comment trigger the receiver would not route a reply
 * through (absent, a command, or without `run.resume`).
 *
 * `plan`: `{ kind: "parked-answer", jobId (the parked run), forge, deliveryId, queue, job, runFields, reserve }`, the
 * reserve over the same inputs as `planRerun`'s (`overlay`, `env`, `modelEndpoints`, `builtinModel`).
 *
 * `from` is who answers: `"console"` (a token, `by` its name) or `"panel"` (the panel's `/dispatch chat`, issue #647
 * part 2, which has no token: `by` is then the reserved `PANEL_ANSWER_BY` whatever is passed, and the worker's trail says
 * the answer came from the panel). A console token NAMED `panel` is refused, so no token can sign as the panel.
 */
export async function planParkedAnswer({
  url,
  logsDir,
  jobId,
  text,
  by,
  draftRunId = null,
  draftDigest = null,
  answerStoreFn = makeAnswerDraftStore,
  from = "console",
  triggersPath = null,
  overlay = {},
  env = {},
  modelEndpoints = null,
  builtinModel = () => null,
  notional = null,
  redisFn = makeRedisClient,
  queueFn = makeQueue,
  parseConnectionFn = parseConnection,
  runsFn = null,
  random = randomBytes,
  fs = nodeFs,
  now = () => Date.now(),
  timeoutMs = 2500,
  planTimeoutMs = PAID_PLAN_TIMEOUT_MS,
  pendingBudget = PENDING_SCAN_BUDGET,
} = {}) {
  const who = from === "panel" ? PANEL_ANSWER_BY : consoleAnswerBy({ by });
  if (who === null) return { refusal: "the answer needs the console token's name (lowercase letters, digits, . _ -)" };
  if (from !== "panel" && who === PANEL_ANSWER_BY) return { refusal: `this console token is named "${PANEL_ANSWER_BY}", the name the /dispatch panel's answers are signed with, so the forge would say the panel answered; answer with a token of another name` };
  const bounded = boundAnswerText(text);
  if (bounded.refusal) return { refusal: bounded.refusal };
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return { refusal: "a run id is letters, digits and . _ : -, at most 200 characters" };
  if (typeof triggersPath !== "string" || triggersPath === "") return { refusal: "the triggers file is not known here (PI_TRIGGERS_FILE), so the reply cannot be built as the receiver builds it" };
  let redis = null;
  let fleet = null;
  const release = releaseOf(() => fleet, () => redis);
  // ONE step with its own end (issue #961), as `planRerun` is.
  const work = (async () => {
    redis = boundedClient(redisFn, url);
    const read = await readRunById(redis, { logsDir, jobId, fs, timeoutMs });
    if (!read.record) return { refusal: recordReadRefusal(read, jobId, "answered") };
    const record = read.record;
    let draftBinding = null;
    if (draftRunId !== null || draftDigest !== null) {
      if (record.reason === "awaiting-approval" || !JOB_ID_RE.test(draftRunId ?? "") || !/^[a-f0-9]{64}$/.test(draftDigest ?? "")) return { refusal: "A draft source needs its retained run id and digest, and cannot answer an approval." };
      const source = await within(answerStoreFn({ redis, now }).privateDraft(jobId), timeoutMs, () => null);
      if (!source?.draft || source.meta?.runId !== jobId || source.meta?.draftRunId !== draftRunId || source.digest !== draftDigest) return { refusal: "The draft changed or expired. Reload its run page and preview the answer again." };
      draftBinding = { draftRunId, draftDigest, draftSourceRunId: jobId };
    }
    if (record.outcome !== "completed" || !["awaiting-input", "awaiting-approval"].includes(record.reason)) return { refusal: notParkedRefusal(jobId, record) };
    // Answered = a LATER run on the same kind and target (readParkedRuns' rule): the newest runs of this host and the
    // mirror, the fleet reader's wide window, which holds any run newer than this one.
    const runs = runsFn ? await runsFn() : await answeredWindow(redis, { logsDir, fs, now, timeoutMs });
    const at = runAt(record);
    const key = targetKeyOf(record.kind, record.target);
    const later = (Array.isArray(runs) ? runs : []).find((r) => r?.purpose !== "answer-draft" && key !== null && targetKeyOf(r?.kind, r?.target) === key && runAt(r) > at);
    if (later) return { refusal: `${jobId} was already answered: ${String(later.jobId ?? "a later run")} ran on ${String(record.target)} after it` };
    fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
    const found = await fleet.find(jobId);
    const data = found?.job?.data ?? null;
    const approval = record.reason === "awaiting-approval";
    if (approval && !/^[a-f0-9]{64}$/.test(record.approval?.requestId ?? "")) return { refusal: "the approval request has no valid durable identifier; nothing was queued" };
    const judged = parkedAnswerRefusalOf({ jobId, data, triggersPath, approval, fs });
    if (judged.refusal) return { refusal: judged.refusal };
    const { kind, delivery, rule } = judged;
    let approvalQueue = null;
    if (approval) {
      const current = await within(makeApprovalStore({ redis, now }).read(record.approval.requestId), timeoutMs, () => ({ error: "timeout" }));
      if (!current.ok) return { refusal: APPROVAL_UNREAD };
      if (!current.request || current.request.state !== "pending" || current.request.runId !== jobId) return { refusal: APPROVAL_NOT_PENDING };
      // Only the worker's private request knows where its canonical session lives. A host name in a public record
      // is display data, not a routing declaration; inferring a queue from it could resume on the wrong filesystem.
      approvalQueue = current.request.hostQueue ?? null;
    }
    // Issue #647: an answer already queued or running has no record yet, so the later-run check above cannot see it.
    const pending = await readPendingAnswer({ queues: fleet.names.map((n) => fleet.queueOf(n)), kind: record.kind, target: record.target, runId: jobId, budget: pendingBudget, timeoutMs });
    if (pending.jobId) return { refusal: `${jobId} is being answered: ${pending.jobId} is queued or running on ${String(record.target)}` };
    // A scan that could not tell refuses (chat-mode's FAIL LOUDLY rule for `pendingTooMany`: on a queue too deep to
    // check, a queued answer can outlast the ten-minute semantic window that would swallow a second one), with the
    // sentence the Chat panel and the parked inbox show for the same scan.
    if (pending.jobId !== null) {
      const verdict = parkedVerdictOf(pending);
      return { refusal: verdict.mode === null && pending.tooMany === true ? `${verdict.says} Nothing was queued.` : `whether an answer to ${jobId} is already queued or running could not be told (the queue could not be read); nothing was queued, try again` };
    }
    const deliveryId = consoleDeliveryId(random);
    // The receiver's routeComment, field for field and in its spreads (`runFieldsOf`): absent stays absent, so the job's
    // data is the one a forge reply would have made. NO FAN-OUT: the loader refuses `run.replicas` beside `run.resume`
    // (a resumed run continues one lineage), and a reply needs resume, so a parked answer is always exactly one job.
    // The fan-out this used to carry for replicas could not be reached, and dead code that multiplies spend is the
    // kind a later change revives by accident; `replicas` still rides `runFieldsOf` as the receiver's job has it.
    const job = {
      repo: data.repo,
      ...(data.projectId !== undefined ? { projectId: data.projectId } : {}),
      ...(data.azure !== undefined ? { azure: data.azure } : {}),
      target: approval ? { ...data.target } : { type: "issue", number: data.target.number, title: data.target.title, body: data.target.body },
      ...runFieldsOf(rule.entry, rule.run.flow),
      parkedReply: !(approval && data.target.type !== "issue"),
      ...(rule.run.modelSelection !== undefined ? { replyReceivedAt: now() } : {}),
      ...(approval ? { approvalRequestId: record.approval.requestId } : {}),
      console: { by: who, ...(draftBinding ?? {}) },
      trigger: {
        event: delivery.event,
        action: delivery.action,
        deliveryId,
        sender: { id: null },
        matched: approval ? { ...data.trigger.matched } : { index: rule.index, type: "comment", phrase: rule.phrase },
        comment: { body: bounded.text, ...(delivery.association ? { author_association: CONSOLE_ASSOCIATION } : {}) },
      },
    };
    return { plan: { kind: "parked-answer", jobId, forge: kind, deliveryId, queue: approvalQueue ?? forgeQueueName(kind, job, fleet.hosts), job, runFields: runFieldsSummary(job), ...(approval ? { approval: { requestId: record.approval.requestId, action: record.approval.action, cap: rule.run.gateBudgetRaiseUsd ?? null } } : {}), reserve: estimateReserve(approval && record.approval.action === "budget-raise" && bounded.text.trim() === "/approve" ? { ...job, maxCostUsd: rule.run.gateBudgetRaiseUsd } : job, { overlay, env, modelEndpoints, builtinModel, notional }) } };
  })();
  try {
    return await within(work, planTimeoutMs, () => ({ refusal: `could not read the parked run or its job (no answer within ${planTimeoutMs / 1000} seconds); nothing was queued` }));
  } catch (err) {
    return { refusal: `could not read the parked run or its job (${boundedText(err?.message ?? String(err))}); nothing was queued` };
  } finally {
    release();
    work.then(release, release);
  }
}

/** The newest runs of this host and the fleet mirror, merged (the fleet reader's wide window), never pruning. */
async function answeredWindow(redis, { logsDir, fs, now, timeoutMs }) {
  const local = makeLocalRunIndex({ logsDir, fs, now, ttlMs: 0 }).records();
  const { runs: fromMirror } = await readMirroredRuns(redis, { limit: ANSWERED_WINDOW, prune: false, timeoutMs });
  // A newer release's mirrored record as its stable core (issue #761), as the local index hands it out.
  const mirrored = Array.isArray(fromMirror) ? fromMirror.map(shownRecord) : fromMirror;
  return mergeRuns(Array.isArray(local?.records) ? local.records : [], mirrored, { limit: ANSWERED_WINDOW });
}

/**
 * Queue an answer `planParkedAnswer` planned (issue #642): exactly one job (a reply resumes one lineage, so it never
 * fans out; see `planParkedAnswer`). Returns `{ ok: true, jobIds: [id], queue }` when it was created, or `{ refusal,
 * deduplicated: true, jobId, survivingJobId }` when the 10-minute semantic window took it (an answer to this issue is
 * already queued or running), `{ refusal }` for a plan that is not one, `{ unreachable }`.
 *
 * What it says is what was sent (issue #987). Before any add: `{ unreachable }` for a queue that did not connect, its
 * own or the one an approval is routed to, and `{ refusal }` for an approval that is no longer the pending one
 * (`APPROVAL_NOT_PENDING`), one whose state could not be read (`APPROVAL_UNREAD`) and a job its builder refused, each
 * ending "nothing was queued". Once an add was started only Valkey's own reply says that; anything else is
 * `enqueueUnconfirmed`.
 */
export async function enqueueParkedAnswer(plan, { url, queueFn = makeQueue, parseConnectionFn = parseConnection, connectTimeoutMs = CONFIRM_READ_TIMEOUT_MS } = {}) {
  if (plan?.kind !== "parked-answer" || !(plan.job?.parkedReply === true || /^[a-f0-9]{64}$/.test(plan.job?.approvalRequestId ?? "")) || !COMMENT_DELIVERY[plan.forge]) return { refusal: "not a parked-answer plan" };
  if (typeof plan.queue !== "string" || !(plan.queue === QUEUE || plan.queue.startsWith(`${QUEUE}@`))) return { refusal: "the plan names no queue" };
  // Two phases, as `enqueueRerun`: a connected queue under a bound, then the add under the client's bound alone.
  const connected = await connectedQueue({ url, options: { name: plan.queue }, queueFn, parseConnectionFn, connectTimeoutMs });
  if (!connected.queue) return { unreachable: connected.unreachable };
  const { queue } = connected;
  const route = routedQueueOf({ url, queueFn, parseConnectionFn, connectTimeoutMs });
  // Whether an add was started (issue #987). The helper sets it, right before each add: its builder, its read of the
  // approval and its routed queue's connect come first, and each throws with nothing sent (`forgeUnsent`). Set before
  // the helper was called, a stale approval read as "may or may not have been queued".
  let sent = false;
  try {
    const res = await enqueueForgeJob(queue, plan.forge, plan.job, { routeFn: route.open, onAdd: () => { sent = true; } });
    if (res.deduplicated) return { refusal: `an answer to this issue is already queued or running (job ${res.survivingJobId}), so the queue's semantic window took this one as a duplicate and nothing was queued`, deduplicated: true, jobId: res.jobId, survivingJobId: res.survivingJobId };
    return { ok: true, jobIds: [res.jobId], queue: res.queue ?? plan.queue };
  } catch (err) {
    if (!sent) return forgeUnsent(err);
    if (refusedByValkey(err)) return { unreachable: `${boundedText(err?.message ?? String(err))}; nothing was queued` };
    return enqueueUnconfirmed(`the answer to ${String(plan.jobId)}`);
  } finally {
    // Started, never awaited: the routed queue the console opened, and its first.
    route.close();
    void closeWithin(queue, QUEUE_CLOSE_TIMEOUT_MS);
  }
}

// ---- steering a running job (issue #646, REQ-STEER-RUNNING-JOB, INT-STEER-INBOX-CONTRACT) -----------------------------

/** The surfaces an operator's message may come from here: the console (`by` its token name) and the panel. */
const STEER_SOURCES_HERE = Object.freeze(["console", "panel"]);

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The raw client a steer plan or confirm reads and writes the inbox with (issue #842): the console's bounded one.
 */
function steerClient(redisFn, url) {
  return boundedClient(redisFn, url);
}

/** A message's push or withdrawal that was sent and not answered (issue #842): `partial`, the outcome first. */
export const steerUnconfirmed = (what, id, jobId) => ({ invalid: jobLast(`message ${id} may or may not have been ${what}: Valkey took it and did not answer within the bound; the run's inbox shows it once Valkey answers`, jobId), partial: true });

/**
 * Find `jobId` across the fleet's queues and judge whether it can take a message now (free reads only, nothing written):
 * `{ job, queue, runId, redis, fleet }` or `{ refusal }`. Shared by the send plan; the withdraw plan needs the job but
 * not its being open (a run that just ended still holds its inbox, and the withdraw script answers for it).
 */
async function findSteerJob({ url, jobId, redisFn, queueFn, parseConnectionFn, timeoutMs, fleetHolder }) {
  const fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
  fleetHolder.fleet = fleet;
  const found = await fleet.find(jobId);
  if (!found) return { refusal: notInFleet(jobId, fleet, "Nothing was sent") };
  return { job: found.job, queue: found.queue, runId: runIdOf(found.job), fleet };
}

/**
 * Plan a MESSAGE into a running job (issue #646, REQ-STEER-RUNNING-JOB), typed into the console or the panel. Free;
 * `{ plan }` or `{ refusal }`, with `status: 503` where Valkey did not answer a read (issue #965). The CLI's
 * `pi-dispatch steer` (worker/src/steer-cli.mjs) on the same footing, with the same order of refusals, each one sentence
 * an operator can act on:
 *
 *   - a `source` other than `console` or `panel`, then a `by` that is not a token-name word (the console's session
 *     name; the panel's `panel`), then a mode other than `steer` or `followUp`;
 *   - the text, bounded by the inbox's own rule (`boundSteerText`: control and invisible characters removed, at most
 *     8 KiB, refused and NEVER cut, since a truncated message is one the person did not send);
 *   - a job id outside the run-id charset; then the whole entry through `normalizeSteerEntry`, so a message whose
 *     framed inbox file would pass its own cap is refused HERE, at the preview, not after the operator confirmed;
 *   - no such job in any fleet queue; a job that is not ACTIVE (a queued job has no run to steer, and a message waiting
 *     for it would arrive as the opening of a run nobody started it for: refused, never parked); a job whose data does
 *     not arm `run.steer`; and a run whose `run:steer:open:<runId>` key is absent (only the worker's relay sets it, for
 *     an armed run on a venue that can deliver, so its absence names all three causes in one sentence, as the CLI does).
 *
 * `runId` is `job.data.recoveryOf ?? job.id` (`runIdOf`), so a recovery job steers the run it continues; and a job
 * that is not active whose run goes on under another id (a #645 recovery, review F4) is steered through that ACTIVE job
 * (`activeJobOfRun`), so the base run's page works: the plan then names the active job. The message id
 * is minted HERE, so the ticket binds the one message the preview showed and a replayed confirm could only ever be
 * `dup`. `plan`: `{ kind: "steer", jobId, queue, runId, id, mode, source, by, text (the bounded text, exactly what the
 * push stores), bytes, digest (its sha256, the only form of it an audit row carries) }`.
 */
export async function planSteer({
  url,
  jobId,
  text,
  mode = "steer",
  by,
  source = "console",
  redisFn = makeRedisClient,
  queueFn = makeQueue,
  parseConnectionFn = parseConnection,
  random = randomBytes,
  now = () => Date.now(),
  timeoutMs = 2500,
  planTimeoutMs = STEER_PLAN_TIMEOUT_MS,
} = {}) {
  if (!STEER_SOURCES_HERE.includes(source)) return { refusal: `the source is not one of ${STEER_SOURCES_HERE.join(", ")}` };
  const who = consoleAnswerBy({ by });
  if (who === null) return { refusal: "the message needs the sender's name (a console token's name: lowercase letters, digits, . _ -)" };
  if (!steerInbox.STEER_MODES.includes(mode)) return { refusal: `the mode is not one of ${steerInbox.STEER_MODES.join(", ")}` };
  const bounded = steerInbox.boundSteerText(text);
  if (bounded.refusal) return { refusal: bounded.refusal };
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return { refusal: "a job id is letters, digits and . _ : -, at most 200 characters" };
  const id = steerInbox.operatorMessageId(random);
  const entry = { v: 1, id, mode, source, author: { kind: "operator", by: who }, text: bounded.text, at: now() };
  const norm = steerInbox.normalizeSteerEntry(entry, now);
  if (norm.refusal) return { refusal: norm.refusal };
  let redis = null;
  const holder = { fleet: null };
  // ONE step with its own end (issue #842, `planCancelQueued`'s pattern), so a preview on a Valkey that stopped
  // answering says so within the bound rather than staying open until it wakes.
  const release = releaseOf(() => holder.fleet, () => redis);
  const work = (async () => {
    let found = await findSteerJob({ url, jobId, redisFn, queueFn, parseConnectionFn, timeoutMs, fleetHolder: holder });
    if (found.refusal) return found;
    const state = await found.job.getState().catch(() => "unknown");
    if (state !== "active") {
      const next = await activeJobOfRun((id) => found.fleet.find(id), found.runId, jobId);
      if (!next) return { refusal: `Nothing was sent: it is ${state}; only a running job takes messages; job ${jobId}` };
      found = { job: next.job, queue: next.queue, runId: runIdOf(next.job), fleet: found.fleet };
    }
    const target = String(found.job.id);
    if (found.job.data?.steer !== true) return { refusal: `Nothing was sent: it is not steer-armed (its trigger does not set run.steer), so it takes no messages; job ${target}` };
    redis = steerClient(redisFn, url);
    const open = await steerInbox.isOpen({ redis, runId: found.runId });
    if (open !== true) {
      if (open === false) return { refusal: "Nothing was sent: the run is not accepting messages; it is not steer-armed, not running, or its venue cannot deliver" };
      // A read refused before it was sent (`refused`, a run id the inbox does not take) says its own reason, as the
      // withdraw plan does, and stays 400; a read Valkey failed is Valkey's refusal (issue #965), 503.
      if (open?.error === "refused") return { refusal: `Nothing was sent: ${String(open.reason)}` };
      return { refusal: `Nothing was sent: the run's inbox could not be read (Valkey said ${String(open?.error ?? "nothing")})`, status: 503 };
    }
    const kept = norm.entry.text;
    return { plan: { kind: "steer", jobId: target, queue: found.queue, runId: String(found.runId), id, mode, source, by: who, text: kept, bytes: Buffer.byteLength(kept, "utf8"), digest: sha256Hex(kept) } };
  })();
  // Issue #965: a read that did not answer within the bound, or that threw, answers 503, the bar's Valkey state with Try
  // again, as a failed job's preview does for the same condition (`failedJob`, console/actions.mjs). The refusals above
  // are the run's own answers and stay the 400 of a change refused.
  try {
    return await within(work, planTimeoutMs, () => ({ refusal: `Nothing was sent: the job or its inbox did not answer within ${planTimeoutMs / 1000} seconds`, status: 503 }));
  } catch (err) {
    return { refusal: `Nothing was sent: could not read the job or its inbox (${boundedText(err?.message ?? String(err))})`, status: 503 };
  } finally {
    // Started, never awaited (`releaseOf`); a read still in flight when the bound fired is released when it settles.
    release();
    work.then(release, release);
  }
}

/**
 * Push a message `planSteer` planned (issue #646): the inbox's own script (`pushSteer`), so a run that closed or went
 * quiet since the preview refuses it (`closed`/`gone`) instead of swallowing it. Returns `{ ok: true, jobId, id, mode,
 * state: "queued" }`, `{ refusal }` with the CLI's sentence for `gone`, `closed`, `full` and `dup`, `{ unreachable }`
 * for a push that was never sent, or `{ invalid, partial: true }` for one that was sent and not answered within the
 * client's bound (`steerUnconfirmed`, issue #842; no timer of its own, which could only say less).
 * It does not wait for the relay's write: the run page's inbox panel and `/api/state` show the message's state move.
 */
export async function enqueueSteer(plan, { url, redisFn = makeRedisClient, now = () => Date.now() } = {}) {
  if (plan?.kind !== "steer" || typeof plan.runId !== "string" || typeof plan.id !== "string" || !STEER_SOURCES_HERE.includes(plan.source)) return { refusal: "not a steer plan" };
  let redis = null;
  try {
    redis = steerClient(redisFn, url);
    const entry = { v: 1, id: plan.id, mode: plan.mode, source: plan.source, author: { kind: "operator", by: plan.by }, text: plan.text, at: now() };
    const pushed = await steerInbox.pushSteer({ redis, runId: plan.runId, entry, now });
    if (pushed?.error === "refused") return { refusal: `${pushed.reason}` };
    // Sent and not answered (issue #842): the run may get the message when Valkey wakes, so never "nothing was sent".
    if (pushed?.error && pushed.mayStillRun === true) return steerUnconfirmed("sent", plan.id, plan.jobId);
    if (pushed?.error) return { unreachable: `Valkey said ${pushed.error}` };
    if (pushed === "ok") return { ok: true, jobId: plan.jobId, id: plan.id, mode: plan.mode, state: "queued" };
    if (pushed === "gone") return { refusal: "Nothing was sent: the run stopped accepting messages before this one arrived (it ended, or its worker stopped refreshing it)" };
    if (pushed === "closed") return { refusal: "Nothing was sent: the run has finished and its inbox is closed" };
    if (pushed === "full") return { refusal: `Nothing was sent: the run's inbox is full (at most ${steerInbox.STEER_MAX_MESSAGES} messages and ${steerInbox.STEER_TOTAL_MAX_BYTES} bytes per run, withdrawn ones included)` };
    if (pushed === "dup") return { refusal: `Nothing new was sent: the message is already in the run's inbox; message ${plan.id}` };
    return { refusal: `Nothing was sent: the inbox answered ${String(pushed)}` };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
  }
}

/**
 * The audit row's `target` for a message (review F2): `<job id>#<message id>`, so a row names the one message it wrote
 * or withdrew (32 hex, never the text) beside the job, and a reader groups by job with the part before the `#`. `#` is
 * outside the job-id charset, so the split on the last `#` is exact. A row's strings are capped at 200 characters
 * (INT-CONSOLE-AUDIT-LOG), so a job id past 166 characters is cut there, keeping the message id whole.
 */
export function steerAuditTarget(jobId, id) {
  const job = String(jobId ?? "");
  return `${[...job].length > 166 ? [...job].slice(0, 166).join("") : job}#${String(id ?? "")}`;
}

/** What withdrawing a message in `prior` state means, in one sentence (the CLI's words): guaranteed or best effort. */
export function steerWithdrawSentence(prior, id) {
  if (prior === "queued") return `message ${id} was queued, so the run never sees it (guaranteed)`;
  if (prior === "written") return `message ${id} was already written into the run's inbox, so the withdrawal is best effort: the agent may have read it before the worker removed it. Its transcript says whether it did`;
  if (prior === "withdrawn") return `message ${id} was already withdrawn; nothing was changed`;
  return null;
}

/** The refusal for a message that cannot be withdrawn from `prior`, or null when it can. */
function unwithdrawable(prior, id, jobId) {
  if (prior === "delivered") return `message ${id} was already delivered: the agent has received it, so it cannot be withdrawn. Nothing was changed`;
  if (prior === "late") return `message ${id} arrived after the run had ended (late): the agent never saw it, and there is nothing to withdraw`;
  if (prior === null) return `no message ${id} in the inbox of ${jobId}`;
  return null;
}

/**
 * Plan taking a message BACK (issue #646). Free; `{ plan }`, `{ unchanged }` (already withdrawn) or `{ refusal }` (with
 * `status: 503` where Valkey did not answer a read, issue #965). The job is found across the fleet (any state: a run
 * that just ended still holds its inbox for an hour), and the message's state is read now: `queued` is withdrawn for
 * certain, `written` only best effort (the relay may already have handed the file to the agent), `delivered` and `late`
 * cannot be, and an unknown id is refused. `plan`: `{ kind: "steer-withdraw", jobId, runId, id, prior }`, where `prior`
 * is the state the preview saw; the confirm's answer names the state the withdraw script actually met, which can have
 * moved on.
 */
export async function planSteerWithdraw({ url, jobId, id, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500, planTimeoutMs = STEER_PLAN_TIMEOUT_MS } = {}) {
  if (typeof id !== "string" || !steerInbox.STEER_ID_RE.test(id)) return { refusal: "the message id is 32 lowercase hex characters, as the inbox lists it" };
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return { refusal: "a job id is letters, digits and . _ : -, at most 200 characters" };
  let redis = null;
  const holder = { fleet: null };
  // ONE step with its own end (issue #842), as `planSteer`.
  const release = releaseOf(() => holder.fleet, () => redis);
  const work = (async () => {
    const found = await findSteerJob({ url, jobId, redisFn, queueFn, parseConnectionFn, timeoutMs, fleetHolder: holder });
    if (found.refusal) return { refusal: found.refusal.replace(/^Nothing was sent:/, "Nothing was changed:") };
    redis = steerClient(redisFn, url);
    const prior = await steerInbox.messageState({ redis, runId: found.runId, id });
    // A read Valkey failed is Valkey's refusal (issue #965), 503; a state no release writes (`bad-reply`) is not.
    if (prior !== null && typeof prior === "object") return prior.error === "refused" ? { refusal: `Nothing was changed: ${String(prior.reason)}` } : { refusal: `the run's inbox could not be read (Valkey said ${String(prior.error)}); nothing was changed`, ...(prior.error === "bad-reply" ? {} : { status: 503 }) };
    const no = unwithdrawable(prior, id, jobId);
    if (no) return { refusal: no };
    if (prior === "withdrawn") return { unchanged: steerWithdrawSentence(prior, id) };
    return { plan: { kind: "steer-withdraw", jobId, runId: String(found.runId), id, prior } };
  })();
  // 503 for a read that did not answer or threw (issue #965), as `planSteer`.
  try {
    return await within(work, planTimeoutMs, () => ({ refusal: `the job or its inbox did not answer within ${planTimeoutMs / 1000} seconds; nothing was changed`, status: 503 }));
  } catch (err) {
    return { refusal: `could not read the job or its inbox (${boundedText(err?.message ?? String(err))}); nothing was changed`, status: 503 };
  } finally {
    release();
    work.then(release, release);
  }
}

/**
 * Withdraw the message `planSteerWithdraw` planned: the inbox's `STEER_WITHDRAW` script, one compare and set. Returns
 * `{ ok: true, jobId, id, prior, guaranteed, said }` (`prior` the state the script met: `queued` is guaranteed,
 * `written` best effort, `withdrawn` a no-op someone else already made), `{ refusal }` for `delivered`, `late` or an id
 * the inbox does not hold, `{ unreachable }` for a withdrawal that was never sent, or `{ invalid, partial: true }` for
 * one that was sent and not answered (`steerUnconfirmed`, issue #842).
 */
export async function withdrawSteerMessage(plan, { url, redisFn = makeRedisClient } = {}) {
  if (plan?.kind !== "steer-withdraw" || typeof plan.runId !== "string" || typeof plan.id !== "string") return { refusal: "not a steer-withdraw plan" };
  let redis = null;
  try {
    redis = steerClient(redisFn, url);
    const res = await steerInbox.withdrawSteer({ redis, runId: plan.runId, id: plan.id });
    if (res?.error === "refused") return { refusal: String(res.reason) };
    // Sent and not answered (issue #842): the message may be withdrawn when Valkey wakes.
    if (res?.error && res.mayStillRun === true) return steerUnconfirmed("withdrawn", plan.id, plan.jobId);
    if (res?.error) return { unreachable: `Valkey said ${res.error}` };
    const no = unwithdrawable(res.prior, plan.id, plan.jobId);
    if (no) return { refusal: no };
    return { ok: true, jobId: plan.jobId, id: plan.id, prior: res.prior, guaranteed: res.prior === "queued", said: steerWithdrawSentence(res.prior, plan.id) };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
  }
}
