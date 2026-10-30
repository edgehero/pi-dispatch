/**
 * Fire now (#750): rebuild the cron schedule through the worker's loader, keep its entire template,
 * and apply dispatch_run's admission rules on every surface. A saved preview is no grant: the file,
 * queue membership and HEAD are checked again immediately before enqueue.
 */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { makeQueue, QUEUE, hostQueueName, manualTriggerJobId, enqueueTriggerRunReporting, swallowedRunSentence } from "@edgehero/pi-dispatch/queue";
import { parseConnection, makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { loadSchedules } from "@edgehero/pi-dispatch/schedules";
import { estimateReserve } from "@edgehero/pi-dispatch/reserve-estimate";
import { checkDispatchRun } from "./read-model.mjs";

const digest = (s) => createHash("sha256").update(s).digest("hex");
const changed = "The triggers file changed since the preview. Preview Fire now again. Nothing was queued.";

/** `{ plan } | { refusal } | { unreachable }`; no hourly counter is changed by this read. */
export async function planTriggerFire({
  index, triggersPath, url, env = {}, grantsEnv = process.env, overlay = {}, modelEndpoints = null,
  builtinModel = () => null, fs = nodeFs, queueFn = makeQueue, parseConnectionFn = parseConnection,
  loadSchedulesFn = loadSchedules, admissionFn = checkDispatchRun, now = Date.now,
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
  } catch {
    // The loader's raw message includes absolute paths. Doctor carries the named diagnosis; this
    // action's result, also returned to a model, must not expose an account's home or prompt text.
    return { refusal: "The triggers file does not load. Run pi-dispatch doctor and fix its named check. Nothing was queued." };
  }
  if (!schedule || schedule.unserved) return { refusal: "This cron trigger is served on another host. Fire it from that host's console. Nothing was queued." };
  if (schedule.data?.command !== undefined) return { refusal: "A run.command trigger cannot be fired from the console or a tool. Nothing was queued." };
  if (schedule.data?.portfolio === true) return { refusal: "A portfolio trigger can only be fired by a person with pi-dispatch run --trigger. Nothing was queued." };
  const queueName = env.PI_WORKER_NAME ? hostQueueName(env.PI_WORKER_NAME) : QUEUE;
  let queue;
  try {
    queue = queueFn(parseConnectionFn(url, { failFast: true }), { name: queueName });
    const scheduler = await queue.getJobScheduler(schedule.schedulerId);
    if (!scheduler) return { refusal: "This cron trigger's schedule is not in this deployment's queue. Nothing was queued." };
  } catch {
    return { unreachable: "The deployment's queue could not be read. Nothing was queued." };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
  // Capability grants come from the caller process only, never the deployment's .env/pointer.
  const admission = await admissionFn({ folder: schedule.data.folder, flow: schedule.data.flow, aiInvoked: true, consumeRate: false, env: { ...grantsEnv, VALKEY_URL: url }, now });
  if (admission.refused) return { refusal: admission.refused };
  if (admission.unreachable) return { unreachable: "The dispatch_run hourly allowance could not be read. Nothing was queued." };
  const reserve = estimateReserve(schedule.data, { overlay, env, modelEndpoints, builtinModel });
  const summary = [`Fire cron trigger row ${index + 1} (${schedule.schedulerId}) now, once`, `Flow ${schedule.data.flow}, on queue ${queueName}; its schedule stays unchanged`];
  return { plan: { index, schedulerId: schedule.schedulerId, queue: queueName, schedule, reserve, fileDigest: digest(source), title: "Fire cron trigger now", summary, message: summary.join("\n") } };
}

/** Revalidate rather than enqueue a stale ticket's template. The queue's minute ID arbitrates concurrent fires. */
export async function enqueueTriggerFire(plan, options = {}) {
  if (!plan || !Number.isSafeInteger(plan.index) || typeof plan.fileDigest !== "string") return { refusal: "Not a Fire now plan. Nothing was queued." };
  const { fs = nodeFs, triggersPath, url, grantsEnv = process.env, admissionFn = checkDispatchRun, queueFn = makeQueue, redisFn = makeRedisClient, parseConnectionFn = parseConnection, now = Date.now } = options;
  try {
    if (digest(fs.readFileSync(triggersPath, "utf8")) !== plan.fileDigest) return { refusal: changed };
  } catch { return { refusal: changed }; }
  const fresh = await planTriggerFire({ ...options, index: plan.index });
  if (!fresh.plan) return fresh;
  const current = fresh.plan;
  if (current.fileDigest !== plan.fileDigest || current.queue !== plan.queue || current.schedulerId !== plan.schedulerId) return { refusal: changed };
  const admission = await admissionFn({ folder: current.schedule.data.folder, flow: current.schedule.data.flow, aiInvoked: true, consumeRate: true, env: { ...grantsEnv, VALKEY_URL: url }, now });
  if (admission.refused) return { refusal: admission.refused };
  if (admission.unreachable) return { unreachable: "The dispatch_run hourly allowance could not be read. Nothing was queued." };
  try {
    if (digest(fs.readFileSync(triggersPath, "utf8")) !== plan.fileDigest) return { refusal: changed };
  } catch { return { refusal: changed }; }
  let queue, redis;
  try {
    // The queue's deterministic ID also deduplicates against CLI fires. A separate minute latch keeps
    // two console/tool fires from racing even after a person cancels/removes the first job. Keep the
    // latch on infrastructure failure: releasing it could double-start an enqueue whose reply was lost.
    const instant = new Date(now());
    const id = manualTriggerJobId({ triggerId: current.schedulerId, now: instant });
    redis = redisFn(url);
    if (await redis.set(`trigger-fire:${current.queue}:${id}`, "1", "EX", 120, "NX") !== "OK") return { refusal: "This cron trigger was already fired this minute. Nothing was queued.", deduplicated: true };
    queue = queueFn(parseConnectionFn(url, { failFast: true }), { name: current.queue });
    const { id: jobId, existing } = await enqueueTriggerRunReporting(queue, current.schedule, { now: instant });
    if (existing === undefined) return { invalid: "Fire now could not verify the queued job. A run may have been queued; check Runs before trying again next minute.", partial: true, jobId, queue: current.queue };
    if (existing) return { refusal: swallowedRunSentence(jobId, existing), deduplicated: true, jobId };
    return { ok: true, jobId, queue: current.queue };
  } catch {
    return { invalid: "Fire now did not receive a queue acknowledgement. A run may have been queued; check Runs before trying again next minute.", partial: true };
  } finally {
    if (queue) await queue.close().catch(() => {});
    redis?.disconnect();
  }
}
