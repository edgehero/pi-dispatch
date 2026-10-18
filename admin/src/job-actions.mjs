/**
 * The job actions the operator console adds to what the `/dispatch` TUI and the tools can do (issue #642): retry and
 * remove a failed job, the same in bulk, re-run a finished run, and answer a parked run from the browser.
 *
 * Reached through `read-model.mjs`, which re-exports every name here, so "the read model is the admin's one data-access
 * surface" stays true for every caller; this file exists only because that one had grown past the point where a new
 * family of functions could be reviewed inside it. Issue #646 adds one more: a message into a running,
 * steer-armed job (`planSteer`/`enqueueSteer`) and taking one back (`planSteerWithdraw`/`withdrawSteerMessage`).
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
import { parseConnection, makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { QUEUE, makeQueue, enqueueForgeJob, enqueueLocalJobReporting, enqueueTriggerRunReporting, forgeDeliveryJobId, hostQueueName, swallowedRunSentence } from "@edgehero/pi-dispatch/queue";
import { jobNeeds, routeForgeJob } from "@edgehero/pi-dispatch/capabilities";
import { loadSchedules } from "@edgehero/pi-dispatch/schedules";
import { parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { targetFor } from "@edgehero/pi-dispatch/run-history";
import { isForgeKind } from "@edgehero/pi-dispatch/forges";
import { mergeRuns, readMirroredRuns } from "@edgehero/pi-dispatch/run-mirror";
import { gitDirty, localRepoProblem } from "@edgehero/pi-dispatch/git-dirty";
import { estimateReserve } from "@edgehero/pi-dispatch/reserve-estimate";
import { boundAnswerText, consoleAnswerBy, PANEL_ANSWER_BY } from "@edgehero/pi-dispatch/console-answer";
import { runIdOf } from "@edgehero/pi-dispatch/recovery-queue";
import * as steerInbox from "@edgehero/pi-dispatch/steer-inbox";
import { parkedVerdictOf } from "@edgehero/pi-dispatch/chat-mode";
import { activeJobOfRun, makeLocalRunIndex, PENDING_SCAN_BUDGET, readFleetQueues, readPendingAnswer, readRunById, targetKeyOf } from "./read-model.mjs";

/** The most jobs one bulk action names, and so the most one preview lists (issue #642). */
export const BULK_MAX = 100;

/** How many failed jobs a bulk plan examines per queue at most, so a deployment with a huge failed set stays bounded. */
const FAILED_EXAMINE_MAX = 2000;
const FAILED_PAGE = 200;

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
 * `pi-dispatch cancel` does: ids are unique across queues by construction. `close()` closes every queue opened.
 */
async function openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs }) {
  const { names, blind, hosts } = await readFleetQueues({ url, redisFn, timeoutMs });
  const opened = new Map();
  const queueOf = (name) => {
    if (!opened.has(name)) opened.set(name, queueFn(parseConnectionFn(url, { failFast: true }), { name }));
    return opened.get(name);
  };
  return {
    names,
    blind,
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
    async close() {
      for (const q of opened.values()) await q.close().catch(() => {});
    },
  };
}

/** The words for a job no fleet queue knows, naming a blind registry when there is one. */
function notInFleet(jobId, fleet) {
  return `no job ${jobId} in ${fleet.names.length} queue(s)${fleet.blind ? ` (the host registry could not be read: ${fleet.blind}; a host that is not registered may still hold it)` : ""}`;
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
 * `fleet.find`'s answer. Refuses unless the job is still `failed` with the previewed `attemptsMade` and `finishedOn`
 * ("it changed since the preview": retried, removed, or failed again since).
 */
async function actOnFailed(found, jobId, expect, act) {
  if (!found) return { invalid: `no job ${jobId}: it changed since the preview (it was removed or retried and finished)` };
  const state = await found.job.getState().catch(() => "unknown");
  if (state !== "failed") return { invalid: `job ${jobId} is ${state} now, not failed: it changed since the preview. Nothing was done` };
  const now = failedFingerprint(found.job);
  if (now.attemptsMade !== expect.attemptsMade || now.finishedOn !== expect.finishedOn) {
    return { invalid: `job ${jobId} failed again since the preview (it changed since the preview). Nothing was done; look again` };
  }
  await act(found.job);
  return { ok: true, jobId, queue: found.queue };
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
 * waiting with its attempts reset, so the worker runs it again with every pre-spend gate (it is a paid action, and the
 * console says so). `expect` is `{ attemptsMade, finishedOn }` from the preview. Returns `{ ok: true, jobId, queue }`,
 * `{ invalid }` (not found, not failed, changed since the preview), or `{ unreachable }`.
 *
 * The residual, stated: between the re-check and the call, the job can only leave `failed` by another operator's
 * retry or remove, and BullMQ's retry itself refuses a job no longer in the failed set (its Lua checks), which comes back
 * as `{ unreachable }` with BullMQ's words.
 *
 * Found by id with `getJob` on every fleet queue, `queue` (the preview's, optional) first: a job far below the bulk
 * preview's newest-100 window is still found and acted on.
 */
export async function retryFailedJob({ url, jobId, expect, queue = null, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 } = {}) {
  return (await failedBulk({ url, jobs: [{ jobId, ...(expect ?? {}), queue, expectGiven: expect }], redisFn, queueFn, parseConnectionFn, timeoutMs, act: (job) => job.retry("failed") })).single;
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
export async function removeFailedJob({ url, jobId, expect, queue = null, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 } = {}) {
  return (await failedBulk({ url, jobs: [{ jobId, ...(expect ?? {}), queue, expectGiven: expect }], redisFn, queueFn, parseConnectionFn, timeoutMs, act: (job) => job.remove() })).single;
}

/**
 * Retry every job a bulk preview listed (issue #642): `jobs` is `planFailedBulk`'s list (`[{ jobId, attemptsMade,
 * finishedOn }]`, at most `BULK_MAX`). Each is re-checked and acted on alone, so one that changed is refused and the rest
 * still go: `{ results: [{ jobId, ok: true, queue } | { jobId, invalid }] }`, in the list's order, or `{ invalid }` for a
 * list that is not one, or `{ unreachable }` when the fleet could not be read at all.
 */
export async function retryFailedJobs({ url, jobs, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 } = {}) {
  return bulkOf(await failedBulk({ url, jobs: listOf(jobs), redisFn, queueFn, parseConnectionFn, timeoutMs, act: (job) => job.retry("failed") }));
}

/** Remove every job a bulk preview listed (issue #642), `retryFailedJobs`' shapes and per-job re-check. */
export async function removeFailedJobs({ url, jobs, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 } = {}) {
  return bulkOf(await failedBulk({ url, jobs: listOf(jobs), redisFn, queueFn, parseConnectionFn, timeoutMs, act: (job) => job.remove() }));
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
 * The one body behind the four failed-job actions: one fleet discovery, one re-check and one act per job, every queue
 * closed after. `single` is the first result for the single-job spellings.
 */
async function failedBulk({ url, jobs, redisFn, queueFn, parseConnectionFn, timeoutMs, act }) {
  if (!Array.isArray(jobs)) return { invalid: "jobs must be the preview's list", single: { invalid: "jobs must be the preview's list" } };
  if (jobs.length > BULK_MAX) return { invalid: `at most ${BULK_MAX} jobs per action; this list has ${jobs.length}`, single: { invalid: "too many jobs" } };
  const results = [];
  let fleet = null;
  try {
    for (const entry of jobs) {
      const { jobId } = entry;
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
      try {
        const found = await fleet.find(jobId, entry.queue);
        const res = found ? await actOnFailed(found, jobId, { attemptsMade: entry.attemptsMade, finishedOn: entry.finishedOn ?? null }, act) : { invalid: `${notInFleet(jobId, fleet)}: it changed since the preview` };
        results.push(res.ok ? res : { jobId, invalid: res.invalid });
      } catch (err) {
        // One job's Valkey error is that job's result; a bulk action reports per job and goes on.
        results.push({ jobId, unreachable: err?.message ?? String(err) });
      }
    }
    return { results, single: results[0] ?? { invalid: "a job id is required" } };
  } catch (err) {
    return { unreachable: err?.message ?? String(err), single: { unreachable: err?.message ?? String(err) } };
  } finally {
    await fleet?.close();
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
export async function planFailedBulk({ url, filter = {}, limit = BULK_MAX, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 } = {}) {
  const cap = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), BULK_MAX) : BULK_MAX;
  const onlyQueue = filter?.queue ?? null;
  const onlyRepo = filter?.repo ?? null;
  if (onlyQueue !== null && typeof onlyQueue !== "string") return { invalid: "filter.queue must be a queue name" };
  if (onlyRepo !== null && (typeof onlyRepo !== "string" || onlyRepo === "")) return { invalid: "filter.repo must be a repository" };
  let fleet = null;
  try {
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
          candidates.push({ jobId: job.id, queue: name, ...failedFingerprint(job), ...(target !== null ? { target } : {}) });
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
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    await fleet?.close();
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

/** A cron run's trigger id, from its job id (`repeat:<id>:<millis>` from the scheduler, `manual:<id>:<minute>` by hand). */
function cronTriggerId(jobId) {
  const m = typeof jobId === "string" ? /^(?:repeat|manual):(.+):\d+$/.exec(jobId) : null;
  return m ? m[1] : null;
}

/**
 * The run fields of a forge job built from a trigger entry's normalized `run` (parseTriggers' shape), exactly as the
 * receiver's filters spread them onto the job (receiver/src/filter*.mjs: one conditional spread per field, absent stays
 * absent, `awaitInput`, `progress`, `statusComment`, `recover` and `steer` only when armed), with `flow` the flow that runs. ONE builder for the two console paths that make
 * a forge job from the triggers file (a parked answer and a forge re-run), so they cannot drift from each other; the
 * parked-answer test builds a receiver job and a console job for the same issue and compares them field for field,
 * which is what holds this builder to the filters.
 */
function runFieldsOf(run, flow) {
  return {
    flow,
    ...(run.packages !== undefined ? { packages: run.packages } : {}),
    ...(run.image !== undefined ? { image: run.image } : {}),
    ...(run.backend !== undefined ? { backend: run.backend } : {}),
    ...(run.excludeTools !== undefined ? { excludeTools: run.excludeTools } : {}),
    ...(run.mcp !== undefined ? { mcp: run.mcp } : {}),
    ...(run.provider !== undefined ? { provider: run.provider } : {}),
    ...(run.model !== undefined ? { model: run.model } : {}),
    ...(run.maxTurns !== undefined ? { maxTurns: run.maxTurns } : {}),
    ...(run.models !== undefined ? { models: run.models } : {}),
    ...(run.maxCostUsd !== undefined ? { maxCostUsd: run.maxCostUsd } : {}),
    ...(run.skillsDir !== undefined ? { skillsDir: run.skillsDir } : {}),
    ...(run.secrets !== undefined ? { secrets: run.secrets } : {}),
    ...(run.secretsProfile !== undefined ? { secretsProfile: run.secretsProfile } : {}),
    ...(run.waitFor !== undefined ? { waitFor: run.waitFor } : {}),
    ...(run.instructions !== undefined ? { instructions: run.instructions } : {}),
    ...(run.resume !== undefined ? { resume: run.resume } : {}),
    ...(run.awaitInput === true ? { awaitInput: true } : {}),
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
function runFieldsSummary(job) {
  return {
    flow: job.flow ?? null,
    model: job.model === undefined ? null : job.provider !== undefined ? `${job.provider}/${job.model}` : job.model,
    models: job.models ?? null,
    maxCostUsd: job.maxCostUsd ?? null,
    secretsProfile: job.secretsProfile ?? null,
    image: job.image ?? null,
    backend: job.backend ?? null,
    ...(job.packages !== undefined ? { packages: job.packages } : {}),
    ...(job.mcp !== undefined ? { mcp: job.mcp } : {}),
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
 * refusal (`TRIGGER_CHANGED` plus why). The entry at `matched.index` must be a trigger for the same forge, of the type
 * that matched (a gitlab merge request's label match is a `pull_request` entry with a label selector, so a `label` match
 * may also be that), still listing the matched action or label, and running the same flow (a comment's `<phrase> <flow>`
 * override may name any flow the file still routes, the receiver's `knownFlows`), not a command. An index is a position
 * in the file, so an entry deleted above it moves another trigger under the same index: these checks are what keep a
 * re-run from borrowing that other trigger's authority, and the worker's trigger-skew check from being defeated by it.
 */
function currentTriggerFor(entries, kind, data) {
  const matched = data?.trigger?.matched;
  const index = matched?.index;
  if (!Number.isInteger(index) || index < 0) return { refusal: `${TRIGGER_CHANGED} (the run names no trigger index)` };
  const entry = entries[index];
  if (!entry) return { refusal: `${TRIGGER_CHANGED} (no trigger at index ${index} any more)` };
  const { on, run } = entry;
  if (run.kind !== kind) return { refusal: `${TRIGGER_CHANGED} (the trigger at index ${index} is a ${String(run.kind)} trigger now, not ${kind})` };
  const typeOk = on.type === matched.type || (matched.type === "label" && on.type === "pull_request" && data?.target?.type === "pull_request");
  if (!typeOk) return { refusal: `${TRIGGER_CHANGED} (the trigger at index ${index} is a ${String(on.type)} trigger now, not ${String(matched.type)})` };
  if (typeof matched.action === "string" && !(Array.isArray(on.action) && on.action.includes(matched.action))) return { refusal: `${TRIGGER_CHANGED} (the trigger at index ${index} no longer fires on ${matched.action})` };
  if (typeof matched.label === "string" && ![...(on.any ?? []), ...(on.all ?? [])].includes(matched.label)) return { refusal: `${TRIGGER_CHANGED} (the trigger at index ${index} no longer selects the label ${matched.label})` };
  if (run.command !== undefined) return { refusal: `${TRIGGER_CHANGED} (the trigger at index ${index} runs a command now)` };
  if (data.flow !== run.flow) {
    const routed = matched.type === "comment" && entries.some((e) => e.on.type !== "cron" && e.run.flow === data.flow);
    if (!routed) return { refusal: `${TRIGGER_CHANGED} (the trigger at index ${index} runs ${JSON.stringify(run.flow)} now, not ${JSON.stringify(data.flow)})` };
  }
  return { run };
}

/**
 * Plan a RE-RUN of a finished run (issue #642). Free: reads the run record, the retained BullMQ job and the triggers
 * file, writes nothing. `{ plan }` or `{ refusal }`.
 *
 *   - LOCAL (a `/dispatch run`, `pi-dispatch run` or a chained child): the retained job's folder, flow and task, queued
 *     as `/dispatch run` queues them (`enqueueLocalJobReporting`, this host's queue), after its folder rule (a
 *     repository root with a commit, no uncommitted changes). A local job's data is kept 24 hours after it completes
 *     and 7 days after it fails; past that the run cannot be rebuilt (the record holds no folder, by design).
 *   - CRON (`repeat:` or `manual:` ids): the trigger as the triggers file says NOW, fired once by hand
 *     (`enqueueTriggerRunReporting`, `pi-dispatch run --trigger`'s path and refusals: gone from the file, another
 *     host's folder, not a repository).
 *   - FORGE: the WHERE from the retained job's data (kept 31 days: repo, target, projectId, azure, the trigger context),
 *     the WHAT from the triggers file NOW: the trigger at the retained `matched.index` must still be the one that matched
 *     (same forge, type, action or label, and flow; `currentTriggerFor`), else refused "the trigger that started this
 *     run changed or is gone; start it again from the forge". Its run fields are copied as the receiver copies them
 *     (`runFieldsOf`), so a narrowed trigger re-runs narrowed and a deleted one does not re-run. A fresh delivery id
 *     (`console-<hex>`) makes the job id new, and it is routed as the receiver routes it (a host queue when a secret or
 *     wait profile needs one).
 *
 * Refused by name: no record, data expired, a `/command` run (commands run only from their reviewed trigger), an answer
 * to a parked run (answer the parked run again instead), and whatever the original path refuses. The 10-minute
 * semantic window can still swallow a forge re-run; only the enqueue can tell, so `enqueueRerun` reports it.
 *
 * `plan`: `{ kind: "local" | "cron" | "forge", jobId (the run re-run), queue, job (the data to enqueue), reserve,
 * schedule? (cron), forge? (the forge kind), deliveryId? (forge), runFields? (forge: `runFieldsSummary`, names only) }`.
 * `reserve` is `estimateReserve`'s over the deployment's `overlay`, `env` (its PI_MAX_COST_USD, PI_PROVIDER, PI_MODEL
 * and PI_ALLOWED_MODELS) and the worker's pickup inputs `modelEndpoints` (`{ models, endpoints }`) and `builtinModel`;
 * without the last two a job is judged not zero-rated, so the figure is never below what the worker holds.
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
  redisFn = makeRedisClient,
  queueFn = makeQueue,
  parseConnectionFn = parseConnection,
  localRepoProblemFn = localRepoProblem,
  gitDirtyFn = gitDirty,
  loadSchedulesFn = loadSchedules,
  random = randomBytes,
  fs = nodeFs,
  timeoutMs = 2500,
} = {}) {
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return { refusal: "a run id is letters, digits and . _ : -, at most 200 characters" };
  let redis = null;
  let fleet = null;
  try {
    redis = redisFn(url);
    redis.on?.("error", () => {});
    const read = await readRunById(redis, { logsDir, jobId, fs, timeoutMs });
    if (!read.record) return { refusal: read.invalid ?? `no run record for ${jobId} on this host or in the fleet mirror` };
    const record = read.record;
    fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
    const found = await fleet.find(jobId);
    const data = found?.job?.data ?? null;
    const kind = typeof data?.kind === "string" ? data.kind : record.kind;
    const reserveOf = (jobData) => estimateReserve(jobData, { overlay, env, modelEndpoints, builtinModel });

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
      return { plan: { kind: "cron", jobId, queue: localQueueName(env), schedule, job: schedule.data, reserve: reserveOf(schedule.data) } };
    }

    if (data === null) {
      const kept = kind === "local" ? "a local job's data is kept 24 hours after it completes and 7 days after it fails" : "a forge job's data is kept 31 days";
      return { refusal: `the queue no longer holds ${jobId}'s data (${kept}), and the run record cannot rebuild it, so it cannot be re-run from here` };
    }
    if (data.command !== undefined) return { refusal: `${jobId} ran the command /${data.command}, and a /command run is not re-run from the console; it runs from its reviewed trigger` };

    if (kind === "local") {
      if (typeof data.flow !== "string" || data.flow.trim() === "") return { refusal: `${jobId} named no flow, and a run needs one` };
      if (typeof data.folder !== "string" || data.folder === "") return { refusal: `${jobId}'s data names no folder` };
      const folder = folderRefusal(data.folder, { localRepoProblemFn, gitDirtyFn });
      if (folder) return { refusal: folder };
      const job = { folder: data.folder, flow: data.flow, task: data.task };
      return { plan: { kind: "local", jobId, queue: localQueueName(env), job, reserve: reserveOf(job) } };
    }

    if (isForgeKind(kind)) {
      if (data.parkedReply === true) return { refusal: `${jobId} answered a parked run; answer the parked run again from the parked inbox instead of re-running the answer` };
      // WHERE comes from the retained job, WHAT RUNS from the triggers file now. The retained run fields are what the
      // trigger said 31 days ago at most: replaying them would run a cap, a model list, a secret profile or an image the
      // operator has since narrowed or removed, under a trigger that may be gone. So the trigger at the retained index
      // must still be the one that matched, and the run fields are copied from it as the receiver would copy them.
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
        ...runFieldsOf(current.run, data.flow),
        ...(data.replica !== undefined ? { replica: data.replica } : {}),
        trigger: { ...(data.trigger ?? {}), deliveryId },
      };
      return { plan: { kind: "forge", forge: kind, jobId, deliveryId, queue: forgeQueueName(kind, job, fleet.hosts), job, runFields: runFieldsSummary(job), reserve: reserveOf(job) } };
    }
    return { refusal: `${jobId} is a ${String(kind)} run, which the console cannot re-run` };
  } catch (err) {
    return { refusal: `could not read the run or its job (${err?.message ?? String(err)}); nothing was queued` };
  } finally {
    await fleet?.close();
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
  }
}

/**
 * Queue a re-run that `planRerun` planned (issue #642). A local plan re-checks its folder first (it can have changed
 * since the preview). Returns `{ ok: true, jobId, queue }` for a job created, or, when a dedup answered and NOTHING was
 * queued, `{ refusal, deduplicated: true, jobId, survivingJobId? }` naming why: the local one-minute window, the cron
 * minute's, or a forge job's 10-minute semantic window (the same target and flow ran or is running). `{ refusal }` for a
 * plan that is not one, `{ unreachable }` for Valkey.
 */
export async function enqueueRerun(plan, { url, queueFn = makeQueue, parseConnectionFn = parseConnection, localRepoProblemFn = localRepoProblem, gitDirtyFn = gitDirty, now = () => Date.now() } = {}) {
  const kind = plan?.kind;
  if (kind !== "local" && kind !== "cron" && kind !== "forge") return { refusal: "not a re-run plan" };
  if (typeof plan.queue !== "string" || !(plan.queue === QUEUE || plan.queue.startsWith(`${QUEUE}@`))) return { refusal: "the plan names no queue" };
  if (kind === "local") {
    const folder = folderRefusal(plan.job?.folder, { localRepoProblemFn, gitDirtyFn });
    if (folder) return { refusal: `${folder} (it changed since the preview). Nothing was queued` };
  }
  let queue = null;
  try {
    queue = queueFn(parseConnectionFn(url, { failFast: true }), { name: plan.queue });
    if (kind === "local") {
      const { id, existing } = await enqueueLocalJobReporting(queue, { folder: plan.job.folder, flow: plan.job.flow, task: plan.job.task });
      if (existing) return { refusal: swallowedRunSentence(id, existing), deduplicated: true, jobId: id };
      return { ok: true, jobId: id, queue: plan.queue };
    }
    if (kind === "cron") {
      const { id, existing } = await enqueueTriggerRunReporting(queue, plan.schedule, { now: new Date(now()) });
      if (existing) return { refusal: swallowedRunSentence(id, existing), deduplicated: true, jobId: id };
      return { ok: true, jobId: id, queue: plan.queue };
    }
    const res = await enqueueForgeJob(queue, plan.forge, plan.job);
    if (res.deduplicated) return { refusal: `the same target and flow ran or is running within the last 10 minutes (job ${res.survivingJobId}), so the queue's semantic window took this re-run as a duplicate and nothing was queued. Try again once that window has passed`, deduplicated: true, jobId: res.jobId, survivingJobId: res.survivingJobId };
    return { ok: true, jobId: res.jobId, queue: plan.queue };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
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
    return { index, phrase: on.phrase, run };
  }
  return null;
}

/**
 * Whether a parked run's RETAINED JOB can take an answer typed into the console (issues #642, #647): `{ kind, delivery,
 * rule }` or `{ refusal }`. The planner's refusals that the job's data and the triggers file decide, in its order: the
 * data expired (`data` null), not a forge issue's run, a pull request's park, and a comment trigger the receiver would
 * not route a reply through (absent, a command, without `run.resume`, without a flow). ONE predicate, so the run page's
 * Chat panel offers the reply form exactly where `planParkedAnswer` would plan it, and shows this sentence where it
 * would not; whether the run is parked and still unanswered is the caller's (the record and `chatModeOf`).
 */
export function parkedAnswerRefusalOf({ jobId, data, triggersPath, fs = nodeFs }) {
  if (data === null || data === undefined) return { refusal: `the queue no longer holds ${jobId}'s data (a forge job's data is kept 31 days), so the reply cannot be built; answer on the forge instead` };
  const kind = data.kind;
  const delivery = COMMENT_DELIVERY[kind];
  if (!isForgeKind(kind) || !delivery) return { refusal: `${jobId} is a ${String(kind)} run; only a forge issue's parked run is answered this way` };
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
 * unreadable or unable to tell (a queue deeper than its budget: `parkedVerdictOf`'s sentence, the Chat panel's); and `parkedAnswerRefusalOf`'s: expired job data, a pull request's park (its reply needs the
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
  from = "console",
  triggersPath = null,
  overlay = {},
  env = {},
  modelEndpoints = null,
  builtinModel = () => null,
  redisFn = makeRedisClient,
  queueFn = makeQueue,
  parseConnectionFn = parseConnection,
  runsFn = null,
  random = randomBytes,
  fs = nodeFs,
  now = () => Date.now(),
  timeoutMs = 2500,
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
  try {
    redis = redisFn(url);
    redis.on?.("error", () => {});
    const read = await readRunById(redis, { logsDir, jobId, fs, timeoutMs });
    if (!read.record) return { refusal: read.invalid ?? `no run record for ${jobId} on this host or in the fleet mirror` };
    const record = read.record;
    if (record.outcome !== "completed" || record.reason !== "awaiting-input") return { refusal: `${jobId} is not parked (it ended ${String(record.outcome)}${record.reason ? `, ${String(record.reason)}` : ""}), so there is no question to answer` };
    // Answered = a LATER run on the same kind and target (readParkedRuns' rule): the newest runs of this host and the
    // mirror, the fleet reader's wide window, which holds any run newer than this one.
    const runs = runsFn ? await runsFn() : await answeredWindow(redis, { logsDir, fs, now, timeoutMs });
    const at = runAt(record);
    const key = targetKeyOf(record.kind, record.target);
    const later = (Array.isArray(runs) ? runs : []).find((r) => key !== null && targetKeyOf(r?.kind, r?.target) === key && runAt(r) > at);
    if (later) return { refusal: `${jobId} was already answered: ${String(later.jobId ?? "a later run")} ran on ${String(record.target)} after it` };
    fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
    const found = await fleet.find(jobId);
    const data = found?.job?.data ?? null;
    const judged = parkedAnswerRefusalOf({ jobId, data, triggersPath, fs });
    if (judged.refusal) return { refusal: judged.refusal };
    const { kind, delivery, rule } = judged;
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
      target: { type: "issue", number: data.target.number, title: data.target.title, body: data.target.body },
      ...runFieldsOf(rule.run, rule.run.flow),
      parkedReply: true,
      console: { by: who },
      trigger: {
        event: delivery.event,
        action: delivery.action,
        deliveryId,
        sender: { id: null },
        matched: { index: rule.index, type: "comment", phrase: rule.phrase },
        comment: { body: bounded.text, ...(delivery.association ? { author_association: CONSOLE_ASSOCIATION } : {}) },
      },
    };
    return { plan: { kind: "parked-answer", jobId, forge: kind, deliveryId, queue: forgeQueueName(kind, job, fleet.hosts), job, runFields: runFieldsSummary(job), reserve: estimateReserve(job, { overlay, env, modelEndpoints, builtinModel }) } };
  } catch (err) {
    return { refusal: `could not read the parked run or its job (${err?.message ?? String(err)}); nothing was queued` };
  } finally {
    await fleet?.close();
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
  }
}

/** The newest runs of this host and the fleet mirror, merged (the fleet reader's wide window), never pruning. */
async function answeredWindow(redis, { logsDir, fs, now, timeoutMs }) {
  const local = makeLocalRunIndex({ logsDir, fs, now, ttlMs: 0 }).records();
  const { runs: mirrored } = await readMirroredRuns(redis, { limit: ANSWERED_WINDOW, prune: false, timeoutMs });
  return mergeRuns(Array.isArray(local?.records) ? local.records : [], mirrored, { limit: ANSWERED_WINDOW });
}

/**
 * Queue an answer `planParkedAnswer` planned (issue #642): exactly one job (a reply resumes one lineage, so it never
 * fans out; see `planParkedAnswer`). Returns `{ ok: true, jobIds: [id], queue }` when it was created, or `{ refusal,
 * deduplicated: true, jobId, survivingJobId }` when the 10-minute semantic window took it (an answer to this issue is
 * already queued or running), `{ refusal }` for a plan that is not one, `{ unreachable }`.
 */
export async function enqueueParkedAnswer(plan, { url, queueFn = makeQueue, parseConnectionFn = parseConnection } = {}) {
  if (plan?.kind !== "parked-answer" || plan.job?.parkedReply !== true || !COMMENT_DELIVERY[plan.forge]) return { refusal: "not a parked-answer plan" };
  if (typeof plan.queue !== "string" || !(plan.queue === QUEUE || plan.queue.startsWith(`${QUEUE}@`))) return { refusal: "the plan names no queue" };
  let queue = null;
  try {
    queue = queueFn(parseConnectionFn(url, { failFast: true }), { name: plan.queue });
    const res = await enqueueForgeJob(queue, plan.forge, plan.job);
    if (res.deduplicated) return { refusal: `an answer to this issue is already queued or running (job ${res.survivingJobId}), so the queue's semantic window took this one as a duplicate and nothing was queued`, deduplicated: true, jobId: res.jobId, survivingJobId: res.survivingJobId };
    return { ok: true, jobIds: [res.jobId], queue: plan.queue };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}

// ---- steering a running job (issue #646, REQ-STEER-RUNNING-JOB, INT-STEER-INBOX-CONTRACT) -----------------------------

/** The surfaces an operator's message may come from here: the console (`by` its token name) and the panel. */
const STEER_SOURCES_HERE = Object.freeze(["console", "panel"]);

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Find `jobId` across the fleet's queues and judge whether it can take a message now (free reads only, nothing written):
 * `{ job, queue, runId, redis, fleet }` or `{ refusal }`. Shared by the send plan; the withdraw plan needs the job but
 * not its being open (a run that just ended still holds its inbox, and the withdraw script answers for it).
 */
async function findSteerJob({ url, jobId, redisFn, queueFn, parseConnectionFn, timeoutMs, fleetHolder }) {
  const fleet = await openFleet({ url, redisFn, queueFn, parseConnectionFn, timeoutMs });
  fleetHolder.fleet = fleet;
  const found = await fleet.find(jobId);
  if (!found) return { refusal: `${notInFleet(jobId, fleet)}; nothing was sent` };
  return { job: found.job, queue: found.queue, runId: runIdOf(found.job), fleet };
}

/**
 * Plan a MESSAGE into a running job (issue #646, REQ-STEER-RUNNING-JOB), typed into the console or the panel. Free;
 * `{ plan }` or `{ refusal }`. The CLI's `pi-dispatch steer` (worker/src/steer-cli.mjs) on the same footing, with the
 * same order of refusals, each one sentence an operator can act on:
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
  try {
    let found = await findSteerJob({ url, jobId, redisFn, queueFn, parseConnectionFn, timeoutMs, fleetHolder: holder });
    if (found.refusal) return found;
    const state = await found.job.getState().catch(() => "unknown");
    if (state !== "active") {
      const next = await activeJobOfRun((id) => found.fleet.find(id), found.runId, jobId);
      if (!next) return { refusal: `job ${jobId} is ${state}: only a running job takes messages. Nothing was sent` };
      found = { job: next.job, queue: next.queue, runId: runIdOf(next.job), fleet: found.fleet };
    }
    const target = String(found.job.id);
    if (found.job.data?.steer !== true) return { refusal: `job ${target} is not steer-armed (its trigger does not set run.steer), so it takes no messages. Nothing was sent` };
    redis = redisFn(url);
    redis.on?.("error", () => {});
    const open = await steerInbox.isOpen({ redis, runId: found.runId });
    if (open !== true) {
      if (open === false) return { refusal: "the run is not accepting messages: it is not steer-armed, not running, or its venue cannot deliver. Nothing was sent" };
      return { refusal: `the run's inbox could not be read (Valkey said ${String(open?.error ?? "nothing")}); nothing was sent` };
    }
    const kept = norm.entry.text;
    return { plan: { kind: "steer", jobId: target, queue: found.queue, runId: String(found.runId), id, mode, source, by: who, text: kept, bytes: Buffer.byteLength(kept, "utf8"), digest: sha256Hex(kept) } };
  } catch (err) {
    return { refusal: `could not read the job or its inbox (${err?.message ?? String(err)}); nothing was sent` };
  } finally {
    await holder.fleet?.close();
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
  }
}

/**
 * Push a message `planSteer` planned (issue #646): the inbox's own script (`pushSteer`), so a run that closed or went
 * quiet since the preview refuses it (`closed`/`gone`) instead of swallowing it. Returns `{ ok: true, jobId, id, mode,
 * state: "queued" }`, `{ refusal }` with the CLI's sentence for `gone`, `closed`, `full` and `dup`, or `{ unreachable }`.
 * It does not wait for the relay's write: the run page's inbox panel and `/api/state` show the message's state move.
 */
export async function enqueueSteer(plan, { url, redisFn = makeRedisClient, now = () => Date.now() } = {}) {
  if (plan?.kind !== "steer" || typeof plan.runId !== "string" || typeof plan.id !== "string" || !STEER_SOURCES_HERE.includes(plan.source)) return { refusal: "not a steer plan" };
  let redis = null;
  try {
    redis = redisFn(url);
    redis.on?.("error", () => {});
    const entry = { v: 1, id: plan.id, mode: plan.mode, source: plan.source, author: { kind: "operator", by: plan.by }, text: plan.text, at: now() };
    const pushed = await steerInbox.pushSteer({ redis, runId: plan.runId, entry, now });
    if (pushed?.error === "refused") return { refusal: `${pushed.reason}` };
    if (pushed?.error) return { unreachable: `Valkey said ${pushed.error}` };
    if (pushed === "ok") return { ok: true, jobId: plan.jobId, id: plan.id, mode: plan.mode, state: "queued" };
    if (pushed === "gone") return { refusal: "the run stopped accepting messages before this one arrived (it ended, or its worker stopped refreshing it). Nothing was sent" };
    if (pushed === "closed") return { refusal: "the run has finished and its inbox is closed. Nothing was sent" };
    if (pushed === "full") return { refusal: `the run's inbox is full (at most ${steerInbox.STEER_MAX_MESSAGES} messages and ${steerInbox.STEER_TOTAL_MAX_BYTES} bytes per run, withdrawn ones included). Nothing was sent` };
    if (pushed === "dup") return { refusal: `message ${plan.id} is already in the run's inbox; nothing new was sent` };
    return { refusal: `the inbox answered ${String(pushed)}; nothing was sent` };
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
 * Plan taking a message BACK (issue #646). Free; `{ plan }`, `{ unchanged }` (already withdrawn) or `{ refusal }`. The
 * job is found across the fleet (any state: a run that just ended still holds its inbox for an hour), and the message's
 * state is read now: `queued` is withdrawn for certain, `written` only best effort (the relay may already have handed
 * the file to the agent), `delivered` and `late` cannot be, and an unknown id is refused. `plan`: `{ kind:
 * "steer-withdraw", jobId, runId, id, prior }`, where `prior` is the state the preview saw; the confirm's answer names
 * the state the withdraw script actually met, which can have moved on.
 */
export async function planSteerWithdraw({ url, jobId, id, redisFn = makeRedisClient, queueFn = makeQueue, parseConnectionFn = parseConnection, timeoutMs = 2500 } = {}) {
  if (typeof id !== "string" || !steerInbox.STEER_ID_RE.test(id)) return { refusal: "the message id is 32 lowercase hex characters, as the inbox lists it" };
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) return { refusal: "a job id is letters, digits and . _ : -, at most 200 characters" };
  let redis = null;
  const holder = { fleet: null };
  try {
    const found = await findSteerJob({ url, jobId, redisFn, queueFn, parseConnectionFn, timeoutMs, fleetHolder: holder });
    if (found.refusal) return { refusal: found.refusal.replace(/; nothing was sent$/, "; nothing was changed") };
    redis = redisFn(url);
    redis.on?.("error", () => {});
    const prior = await steerInbox.messageState({ redis, runId: found.runId, id });
    if (prior !== null && typeof prior === "object") return { refusal: prior.error === "refused" ? String(prior.reason) : `the run's inbox could not be read (Valkey said ${String(prior.error)}); nothing was changed` };
    const no = unwithdrawable(prior, id, jobId);
    if (no) return { refusal: no };
    if (prior === "withdrawn") return { unchanged: steerWithdrawSentence(prior, id) };
    return { plan: { kind: "steer-withdraw", jobId, runId: String(found.runId), id, prior } };
  } catch (err) {
    return { refusal: `could not read the job or its inbox (${err?.message ?? String(err)}); nothing was changed` };
  } finally {
    await holder.fleet?.close();
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
  }
}

/**
 * Withdraw the message `planSteerWithdraw` planned: the inbox's `STEER_WITHDRAW` script, one compare and set. Returns
 * `{ ok: true, jobId, id, prior, guaranteed, said }` (`prior` the state the script met: `queued` is guaranteed,
 * `written` best effort, `withdrawn` a no-op someone else already made), `{ refusal }` for `delivered`, `late` or an id
 * the inbox does not hold, or `{ unreachable }`.
 */
export async function withdrawSteerMessage(plan, { url, redisFn = makeRedisClient } = {}) {
  if (plan?.kind !== "steer-withdraw" || typeof plan.runId !== "string" || typeof plan.id !== "string") return { refusal: "not a steer-withdraw plan" };
  let redis = null;
  try {
    redis = redisFn(url);
    redis.on?.("error", () => {});
    const res = await steerInbox.withdrawSteer({ redis, runId: plan.runId, id: plan.id });
    if (res?.error === "refused") return { refusal: String(res.reason) };
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
