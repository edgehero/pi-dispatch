/**
 * Fire now (#750): rebuild the cron schedule through the worker's loader, keep its entire template,
 * and apply dispatch_run's admission rules on every surface. A saved preview is no grant: the file,
 * queue membership and HEAD are checked again immediately before enqueue.
 */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { makeQueue, QUEUE, closeWithin, consoleQueueConnection, hostQueueName, manualCanaryJobId, manualTriggerJobId, enqueueTriggerRunReporting, swallowedRunSentence } from "@edgehero/pi-dispatch/queue";
import { parseConnection, makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { loadSchedules } from "@edgehero/pi-dispatch/schedules";
import { estimateReserve } from "@edgehero/pi-dispatch/reserve-estimate";
import { withJobDataVersion } from "@edgehero/pi-dispatch/job-data-version";
import { ALLOWANCE_UNREAD, checkDispatchRun, QUEUE_CLOSE_TIMEOUT_MS } from "./read-model.mjs";
import { ADD_NOT_SENT_WHY, addNeverLeft, ALREADY_MATCH, dropDeadQueue, boundedClient, connectedQueue, CONFIRM_READ_TIMEOUT_MS, LOOK_FIRST, PAID_PLAN_TIMEOUT_MS, queuedAlready, within } from "./job-actions.mjs";
import { FILE_WORDS, fileCaseOfError } from "./file-case.mjs";

const digest = (s) => createHash("sha256").update(s).digest("hex");
const changed = "The triggers file changed since the preview. Preview Fire now again. Nothing was queued.";

/**
 * What a Fire now says when its queue did not answer before anything was sent. For its allowance the sentence is the
 * read model's `ALLOWANCE_UNREAD` (issue #987), which the console's `run-enqueue` preview says too.
 */
const QUEUE_UNREAD = "The deployment's queue could not be read. Nothing was queued.";
/** What it says once the hour's allowance has counted this fire and a later step sent nothing: the count is not given back. */
const ALLOWANCE_USED = "One start of this hour's dispatch_run allowance was used.";
/**
 * What a fire says when its add was started and not confirmed. The facts come first: an audit row keeps 200 characters
 * of a reason, and cut at the end it lost that the start was used.
 */
// Spelled whole, not built from `LOOK_FIRST`: this module can be read before `job-actions.mjs` has run (they import
// each other through the read model), and a test holds the two to the same words.
export const FIRE_UNCONFIRMED = "A run may have been queued and one start of this hour was used: Fire now got no queue acknowledgement. Preview it again first: the preview says when one is already queued or running";
/**
 * The same for an extension canary (issue #987), which is queued through this module with one more field and said
 * "Fire now got no queue acknowledgement" of an action its person never named. Every answer below that names who was
 * stopped after the allowance was counted names the canary for one (`firedAs`); Fire now's own words are unchanged.
 */
export const CANARY_UNCONFIRMED = "A run may have been queued and one start of this hour was used: the canary got no queue acknowledgement. Preview it again first: the preview says when one is already queued or running";
/** Who an answer names: `[the name that starts a clause, the name after "this minute's"]`. */
const firedAs = (canary) => (canary ? ["the canary", "canary"] : ["Fire now", "Fire now"]);

/**
 * `{ plan } | { refusal } | { unreachable }`; no hourly counter is changed by this read.
 *
 * Its two Valkey reads (the queue's scheduler, the hour's count) are ONE step that ends at `planTimeoutMs` (issue #961):
 * the queue is the console's bounded kind, so a read that was sent ends at the command bound, and a queue built while
 * Valkey takes connections and answers none has no such end. The queue's close is started and never waited for.
 */
export async function planTriggerFire({
  index, triggersPath, url, env = {}, grantsEnv = process.env, overlay = {}, modelEndpoints = null,
  builtinModel = () => null, notional = null, fs = nodeFs, queueFn = makeQueue, parseConnectionFn = parseConnection,
  loadSchedulesFn = loadSchedules, admissionFn = checkDispatchRun, now = Date.now, planTimeoutMs = PAID_PLAN_TIMEOUT_MS, lookAlready = false,
} = {}) {
  if (!Number.isSafeInteger(index) || index < 0) return { refusal: "index must be a non-negative trigger index. Nothing was queued." };
  if (typeof triggersPath !== "string" || triggersPath === "") return { refusal: "The triggers file is not known here (PI_TRIGGERS_FILE). Nothing was queued." };
  let source, raw, schedule;
  try {
    source = fs.readFileSync(triggersPath, "utf8");
    raw = JSON.parse(source)?.triggers?.[index];
    // Validate the WHOLE file before selecting its raw index. A malformed sibling must not turn an
    // invalid deployment into a partial list of runnable schedules.
    const schedules = loadSchedulesFn({ triggersFile: triggersPath, maxCostUsd: env.PI_MAX_COST_USD || null }, { readFileSync: () => source, existsSync: (p) => fs.existsSync(p), fleet: Boolean(env.PI_WORKER_NAME) });
    if (!raw) return { refusal: `There is no trigger at row ${index + 1}. Nothing was queued.` };
    if (raw.on?.type !== "cron") return { refusal: "Only a cron trigger can be fired now. Nothing was queued." };
    schedule = schedules.find((s) => s.schedulerId === raw.on.id);
  } catch (error) {
    // The loader's raw message includes absolute paths. Doctor carries the named diagnosis; this
    // action's result, also returned to a model, must not expose an account's home or prompt text.
    // One word per case (issue #988, `file-case.mjs`): "does not load" was said of a file that is not there and of one
    // nobody could read as well.
    const fileCase = fileCaseOfError(error);
    if (fileCase === "absent") return { refusal: `The triggers file ${FILE_WORDS.absent}. Nothing was queued.` };
    if (fileCase === "unreadable") return { refusal: `The triggers file ${FILE_WORDS.unreadable}. Nothing was queued.` };
    return { refusal: `The triggers file ${FILE_WORDS.refused}. Run pi-dispatch doctor and fix its named check. Nothing was queued.` };
  }
  if (!schedule || schedule.unserved) return { refusal: "This cron trigger is served on another host. Fire it from that host's console. Nothing was queued." };
  if (schedule.data?.command !== undefined) return { refusal: "A run.command trigger cannot be fired from the console or a tool. Nothing was queued." };
  if (schedule.data?.portfolio === true) return { refusal: "A portfolio trigger can only be fired by a person with pi-dispatch run --trigger. Nothing was queued." };
  const queueName = env.PI_WORKER_NAME ? hostQueueName(env.PI_WORKER_NAME) : QUEUE;
  let queue = null;
  let already = null;
  const release = () => {
    if (queue) void closeWithin(queue, QUEUE_CLOSE_TIMEOUT_MS);
    queue = null;
  };
  const reads = (async () => {
    try {
      queue = queueFn(consoleQueueConnection(url, parseConnectionFn), { name: queueName, metaWrite: false });
      const scheduler = await queue.getJobScheduler(schedule.schedulerId);
      if (!scheduler) return { refusal: "This cron trigger's schedule is not in this deployment's queue. Nothing was queued." };
      // A hand-fired run of this trigger that is already queued or running (issue #961): said beside the plan, never
      // a refusal. By the hand fire's own id prefix, so the scheduler's next tick, which always waits, is not one.
      // Asked for by a preview alone (`lookAlready`): the trigger page and a confirm's re-plan have no use for it.
      if (lookAlready) already = await queuedAlready([queue], ALREADY_MATCH.manual(schedule.schedulerId));
    } catch {
      return { unreachable: QUEUE_UNREAD };
    } finally {
      release();
    }
    // Capability grants come from the caller process only, never the deployment's .env/pointer.
    const admission = await admissionFn({ folder: schedule.data.folder, flow: schedule.data.flow, aiInvoked: true, consumeRate: false, env: { ...grantsEnv, VALKEY_URL: url }, now });
    if (admission.refused) return { refusal: admission.refused };
    if (admission.unreachable) return { unreachable: ALLOWANCE_UNREAD };
    return null;
  })();
  let stopped;
  try {
    stopped = await within(reads, planTimeoutMs, () => ({ unreachable: QUEUE_UNREAD }));
  } catch {
    stopped = { unreachable: QUEUE_UNREAD };
  } finally {
    // Started, never awaited; a read still in flight when the bound fired is released when it settles.
    release();
    reads.then(release, release);
  }
  if (stopped) return stopped;
  // Issue #1008: `notional`, the providers the hosts publish as bound to a subscription with no paid extra usage.
  const reserve = estimateReserve(schedule.data, { overlay, env, modelEndpoints, builtinModel, notional });
  const summary = [`Fire cron trigger row ${index + 1} (${schedule.schedulerId}) now, once`, `Flow ${schedule.data.flow}, on queue ${queueName}; its schedule stays unchanged`];
  return { plan: { index, schedulerId: schedule.schedulerId, queue: queueName, schedule, reserve, fileDigest: digest(source), title: "Fire cron trigger now", summary, message: summary.join("\n") }, already };
}

/**
 * Revalidate rather than enqueue a stale ticket's template. The queue's minute ID arbitrates concurrent fires.
 *
 * In this order (issue #961): the plan again (reads), then a CONNECTED queue under a bound (`connectedQueue`), and only
 * then what a fire uses up, the hour's allowance and the minute's latch, so a queue that cannot be reached costs
 * neither. The add has no timer of its own: its client's command bound decides alone, and whatever it throws once it
 * was started reads as "a run may have been queued". Each answer says what was used: nothing is given back.
 */
export async function enqueueTriggerFire(plan, options = {}) {
  if (!plan || !Number.isSafeInteger(plan.index) || typeof plan.fileDigest !== "string") return { refusal: "Not a Fire now plan. Nothing was queued." };
  const { fs = nodeFs, triggersPath, url, grantsEnv = process.env, admissionFn = checkDispatchRun, queueFn = makeQueue, redisFn = makeRedisClient, parseConnectionFn = parseConnection, now = Date.now, connectTimeoutMs = CONFIRM_READ_TIMEOUT_MS } = options;
  try {
    if (digest(fs.readFileSync(triggersPath, "utf8")) !== plan.fileDigest) return { refusal: changed };
  } catch { return { refusal: changed }; }
  const fresh = await planTriggerFire({ ...options, index: plan.index });
  if (!fresh.plan) return fresh;
  const current = fresh.plan;
  if (options.packageCanary != null && current.schedule.data.modelSelection !== undefined) return { refusal: "An extension canary requires a fixed model trigger. Random model selection is not supported for canaries." };
  if (current.fileDigest !== plan.fileDigest || current.queue !== plan.queue || current.schedulerId !== plan.schedulerId) return { refusal: changed };
  const connected = await connectedQueue({ url, options: { name: current.queue }, queueFn, parseConnectionFn, connectTimeoutMs });
  if (!connected.queue) return { unreachable: "The deployment's queue could not be reached. Nothing was queued." };
  const { queue } = connected;
  let redis;
  // What this fire has reached: the latch's SET, then the add. A throw says what may have happened by where it fell.
  let admitted = false;
  let latching = false;
  let sent = false;
  // A canary (issue #796) has an identity of its own, so a hand fire in the same minute cannot swallow it, nor it the fire: they are different jobs with different code.
  const canary = options.packageCanary ?? null;
  const [who, minutes] = firedAs(canary);
  try {
    const admission = await admissionFn({ folder: current.schedule.data.folder, flow: current.schedule.data.flow, aiInvoked: true, consumeRate: true, env: { ...grantsEnv, VALKEY_URL: url }, now });
    if (admission.allowanceMayBeUsed) return { invalid: "Nothing was queued and one start of this hour may have been used: the dispatch_run hourly allowance was sent this fire and did not answer.", partial: true };
    if (admission.refused) return { refusal: admission.refused };
    if (admission.unreachable) return { unreachable: ALLOWANCE_UNREAD };
    admitted = true;
    try {
      if (digest(fs.readFileSync(triggersPath, "utf8")) !== plan.fileDigest) return { refusal: `${changed} ${ALLOWANCE_USED}` };
    } catch { return { refusal: `${changed} ${ALLOWANCE_USED}` }; }
    // The queue's deterministic ID also deduplicates against CLI fires. A separate minute latch keeps
    // two console/tool fires from racing even after a person cancels/removes the first job. Keep the
    // latch on infrastructure failure: releasing it could double-start an enqueue whose reply was lost.
    const instant = new Date(now());
    const id = (canary ? manualCanaryJobId : manualTriggerJobId)({ triggerId: current.schedulerId, now: instant });
    redis = boundedClient(redisFn, url);
    latching = true;
    if (await redis.set(`trigger-fire:${current.queue}:${id}`, "1", "EX", 120, "NX") !== "OK") return { refusal: `This cron trigger was already fired this minute. Nothing was queued. ${ALLOWANCE_USED}`, deduplicated: true };
    latching = false;
    // Stamped by the same rule as every builder (`DES-STORE-VERSION-WHEN-NEEDED`), so a worker from before canaries waits for an upgrade instead of paying for a plain run.
    const schedule = canary ? { ...current.schedule, data: withJobDataVersion({ ...current.schedule.data, packageCanary: canary }) } : current.schedule;
    sent = true;
    const { id: jobId, existing } = await enqueueTriggerRunReporting(queue, schedule, { now: instant, ...(canary ? { jobId: id } : {}) });
    if (existing === undefined) return { invalid: `A run may have been queued and one start of this hour was used: ${who} could not verify the queued job. ${LOOK_FIRST}`, partial: true, jobId, queue: current.queue };
    if (existing) return { refusal: `${swallowedRunSentence(jobId, existing)} ${ALLOWANCE_USED}`, deduplicated: true, jobId };
    return { ok: true, jobId, queue: current.queue };
  } catch (err) {
    // Issue #1072: the add was refused by its client before it left, on a connection that died after the connect. The
    // start was counted and the minute's latch is set, so this says what was used and when to try again.
    if (sent && addNeverLeft(err)) {
      dropDeadQueue(queue);
      return { invalid: `Nothing was queued and one start of this hour was used: ${ADD_NOT_SENT_WHY}, and this minute's ${minutes} is taken. Try again next minute.`, partial: true };
    }
    if (sent) return { invalid: canary ? CANARY_UNCONFIRMED : FIRE_UNCONFIRMED, partial: true };
    // The latch's SET was sent and not answered: nothing was queued, and the minute may be taken now or when Valkey wakes.
    if (latching && err?.valkeyMayStillRun === true) return { invalid: `Nothing was queued, one start of this hour was used, and this minute's ${minutes} may be taken: its latch was sent and did not answer. Try again next minute.`, partial: true };
    if (latching) return { invalid: `Nothing was queued and one start of this hour was used: ${who}'s latch for this minute could not be set.`, partial: true };
    if (admitted) return { invalid: `Nothing was queued and one start of this hour was used: ${who} stopped before it queued anything.`, partial: true };
    return { unreachable: QUEUE_UNREAD };
  } finally {
    // Started, never awaited: the answer does not wait for a QUIT.
    void closeWithin(queue, QUEUE_CLOSE_TIMEOUT_MS);
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
  }
}
