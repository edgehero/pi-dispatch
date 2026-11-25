/** Model-callable writes use the console action planners and the same transition judge (#766). */
import * as fs from "node:fs";
import { publicToolRefusal } from "./tool-refusals.mjs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import * as rm from "./read-model.mjs";
import * as plans from "./write-plans.mjs";
import { agentReadProjection } from "./agent-read.mjs";
import { actionNamed, agentShortWord } from "./console/actions.mjs";
import { switchAnsweredSentence, switchShortCauseSentence } from "./words.mjs";
import { authorizeTransition } from "./action-policy.mjs";
import { agentActor, panelAudit, auditedWrite, AUDIT_REFUSAL } from "./audited-write.mjs";
import { readJobsData } from "./console/job-data.mjs";
import { allocRedis, allocNow, envelopeProblem } from "./insights-assembly.mjs";
import { gateDialogs } from "./dialog-gate.mjs";
import { builtinModel } from "@edgehero/pi-dispatch/model-catalog";
import { HOST_SET, hostKey } from "@edgehero/pi-dispatch/host-registry";

export const TOOL_ACTIONS = Object.freeze({
  dispatch_set: "setting-set", dispatch_trigger_add: "trigger-add", dispatch_trigger_edit: "trigger-edit", dispatch_trigger_delete: "trigger-delete", dispatch_trigger_fire: "trigger-fire",
  dispatch_pause_add: "pause-window-add", dispatch_pause_edit: "pause-window-edit", dispatch_pause_delete: "pause-window-delete",
  dispatch_limit_add: "limit-add", dispatch_limit_edit: "limit-edit", dispatch_limit_delete: "limit-delete",
  dispatch_project_add: "project-add", dispatch_project_edit: "project-edit", dispatch_project_delete: "project-delete",
  dispatch_envelope_set: "envelope-set", dispatch_priorities_set: "priorities-set", dispatch_allocation_revert: "allocation-revert",
  dispatch_wait_cancel: "cancel-held", dispatch_cancel: "cancel-active", dispatch_retry_failed: "retry-failed", dispatch_remove_failed: "remove-failed",
  dispatch_rerun: "rerun", dispatch_pause: "fleet-pause", dispatch_resume: "fleet-resume", dispatch_run: "run-enqueue",
});

/**
 * BullMQ's states of a job that is not running: not started (a paused queue's jobs read `waiting`), or ended. Each
 * goes to the queued job's planner, which cancels the first kind and says what the second is, as on the console.
 */
const NOT_RUNNING_STATES = Object.freeze(["waiting", "delayed", "prioritized", "waiting-children", "completed", "failed"]);

/**
 * `dispatch_cancel`'s action for a job that is in neither list the snapshot hands it, by the job's own state in the
 * queue that holds it (`jobStatus`, the by-id lookup over the registry's queues and the ones that exist): running
 * is `cancel-active`, any state that is not running is `cancel-queued`, whose planner judges the job again and refuses
 * one that ended. ALWAYS looked up, not only while the running list is not whole (issue #1036): the snapshot lists a
 * bounded number of running jobs per queue (one, for this tool's reader), so the second job running on a queue was in
 * no list, was planned as a queued job, and was refused by that planner for running.
 *
 * A job no queue that was read holds, or one whose state could not be read: while the running list is whole
 * (`activeUnreachable` not true) it is not running anywhere, and the queued job's planner says what it is, as before.
 * While the list is NOT whole it may be running on a queue that was not asked, so that is refused, in words that say
 * why. Over the registry's index answered with an error (`fleetError`), `host:live` and the code; over a host row
 * answered with one, the host, its key and the code; and for either what the code's class says to do first
 * (`erroredReadWords`), never "try again" for a cause that lasts. The index was said as "could not be read, try
 * again" with no key and no code, also while `host:live` held a string. Over anything else, the sentence as it was.
 */
async function cancelActionById(fleet, jobId, snapshot) {
  const status = typeof fleet?.jobStatus === "function" ? await fleet.jobStatus(jobId, { tellAbsent: false }).catch(() => null) : null;
  if (status?.found === true && status.state === "active") return "cancel-active";
  if (status?.found === true && NOT_RUNNING_STATES.includes(status.state)) return "cancel-queued";
  if (snapshot?.activeUnreachable !== true) return "cancel-queued";
  const close = (w) => (w.first !== null ? `${w.first}; nothing was changed` : `Nothing was changed${w.again ? "; try again" : ""}`);
  if (rm.replyCodeOf(snapshot?.queue?.fleetError) !== null) {
    const index = rm.erroredReadWords(HOST_SET, snapshot.queue.fleetError);
    throw publicToolRefusal(`whether this job is running is not known: no queue that was read says, and the hosts' queues were not asked, since ${index.said}. ${close(index)}`);
  }
  const unread = (Array.isArray(snapshot?.queue?.unreadHosts) ? snapshot.queue.unreadHosts : []).filter((u) => typeof u?.name === "string" && rm.replyCodeOf(u?.error) !== null);
  // The row that most needs a hand first: a key of another type, then a permission, then any other code.
  const words = unread.map((u) => ({ name: u.name, ...rm.erroredReadWords(hostKey(u.name), u.error) }));
  const named = ["key", "permission", "other", "passing"].flatMap((cls) => words.filter((w) => w.class === cls))[0];
  if (!named) throw publicToolRefusal("the running jobs could not be read, so whether this job is running is not known; nothing was changed, try again");
  throw publicToolRefusal(`whether this job is running is not known: no queue that was read says, and the queue of host ${named.name} was not asked, since ${named.said}. ${close(named)}`);
}

/**
 * THE FLEET READER'S METHODS A TOOL'S ACTION IS HANDED (issue #1036): every one that `toolActionRequest` and the
 * console's actions ask their fleet for, by name, and no other. The adapter below hands on exactly these, so a method
 * a planner asks for and this list lacks is simply not there, and the planner takes the branch it has for a reader
 * that cannot answer: `dispatch_cancel`'s lookup by id found no `jobStatus`, so over a host row Valkey answered with
 * an error every cancel of a job that was not seen running was refused, the fix for that never having run in the
 * registered tool; and a bulk retry found no `supersededOf`, so it retried, and paid for, the failed jobs whose work
 * a later run had already done, which the console leaves out. A test holds this list equal to what the two files ask
 * for (`ctx.a.fleet.<method>` there, `fleet.<method>` here). `knownSilent` (issue #1072) is the fleet switch's preview
 * asking what the reader already knows of its Valkey: a tool builds its reader on each call, so it answers false and
 * the preview reads, stopping at its own registry read when that gets no answer, as a console's does.
 */
export const TOOL_FLEET_METHODS = Object.freeze(["snapshot", "pause", "resume", "knownSilent", "cancelActive", "pauseQueue", "jobStatus", "supersededOf"]);

/** The tool's vocabulary is translated once; all validation and writes belong to the action. */
export async function toolActionRequest(name, params = {}, { fleet } = {}) {
  let action = TOOL_ACTIONS[name];
  if (!action) throw publicToolRefusal("this tool has no declared console action");
  if (["dispatch_retry_failed", "dispatch_remove_failed"].includes(name) && (params.all === true ? params.jobId !== undefined : params.repo !== undefined || params.jobId === undefined)) throw publicToolRefusal("send either jobId or all with optional queue/repo, never both");
  if (name === "dispatch_cancel" && (params.allHeld === true ? params.jobId !== undefined || params.queue !== undefined : params.jobId === undefined)) throw publicToolRefusal("send either jobId with optional queue or allHeld, never both");
  let body = { ...params };
  if (name === "dispatch_set" && (params.value === undefined || typeof params.value === "string" && params.value.trim() === "")) action = "setting-unset";
  if (action === "setting-unset") delete body.value;
  if (name === "dispatch_trigger_add") body = { trigger: { ...params } };
  if (["dispatch_limit_add", "dispatch_limit_edit"].includes(name)) { const { index, ...limit } = params; body = { ...(index !== undefined ? { index } : {}), limit }; }
  if (name === "dispatch_envelope_set") body = { envelope: { ...params } };
  if (name === "dispatch_pause" || name === "dispatch_resume") action = params.queue ? (name === "dispatch_pause" ? "queue-pause" : "queue-resume") : action;
  if (name === "dispatch_retry_failed" || name === "dispatch_remove_failed") action = params.all === true ? (name === "dispatch_retry_failed" ? "retry-all-failed" : "remove-all-failed") : action;
  if (name === "dispatch_cancel") {
    if (params.allHeld === true) action = "cancel-all-held";
    else {
      const snapshot = await fleet.snapshot({ waiting: true });
      if ((snapshot.active ?? []).some((r) => r.jobId === params.jobId)) action = "cancel-active";
      else if ((snapshot.held?.rows ?? []).some((r) => r.jobId === params.jobId)) action = "cancel-held";
      // An active list that is not whole cannot say this job is not running, and a cancel planned for a queued job
      // would be the wrong one for a running job (issue #962). So the job is looked up by its id, as the console's own
      // cancel does (issue #1036): one found in a queue that WAS read is running or waiting there whatever another
      // host's row says. Until this, one host row Valkey answers with an error refused every such cancel for as long
      // as the row stayed: this tool's reader is new on every call, so that host never has a last row and its queue
      // is never asked. Looked up over a whole list too, which names a bounded number of running jobs per queue.
      else action = await cancelActionById(fleet, params.jobId, snapshot);
    }
  }
  delete body.all; delete body.allHeld;
  return { action, body };
}

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter((key) => !["deliveryId", "enqueueNonce", "validUntil"].includes(key) && typeof value[key] !== "function").sort().map((key) => [key, stable(value[key])]));
};
// Planners mint reply delivery IDs and expiry times; checking the underlying authority must not make
// an unchanged confirmation fail just because those prospective identities are freshly generated.
const fingerprint = (out) => createHash("sha256").update(JSON.stringify(stable({ target: out.target, expect: out.expect, beforeDigest: out.beforeDigest, afterDigest: out.afterDigest, reserve: out.reserve, targets: out.targets, payload: out.payload, evidence: out.policyEvidence }))).digest("hex");

/** Only explicit machine facts leave this adapter; preview prose and diffs stay in the operator dialog. */
export function toolWriteResult(result, { action, out } = {}) {
  const value = { applied: result?.ok === true, action };
  for (const key of ["outcome", "reason", "field", "rule", "planId", "basis", "clamped", "kept", "before", "after"]) {
    const safe = agentReadProjection(result?.[key], key);
    if (safe !== undefined) value[key] = safe;
  }
  for (const key of ["jobId", "queue", "planId", "outcome"]) if (typeof result?.[key] === "string" && /^[A-Za-z0-9._:@/-]{1,200}$/.test(result[key])) value[key] = result[key];
  for (const key of ["done", "count"]) if (Number.isSafeInteger(result?.[key])) value[key] = result[key];
  if (out?.reserve) value.reserve = out.reserve;
  if (action === "envelope-set" && typeof out?.afterDigest === "string") value.digest = out.afterDigest;
  if (Array.isArray(result?.results)) {
    value.results = result.results.map((row) => ({ jobId: typeof row?.jobId === "string" && /^[A-Za-z0-9._:@/-]{1,200}$/.test(row.jobId) ? row.jobId : null, ok: row?.ok === true, ...(row?.partial === true ? { partial: true } : {}) }));
    value.done = value.results.filter((row) => row.ok).length;
    value.refused = value.results.length - value.done;
    value.applied = value.done > 0;
  }
  if (result?.warning || result?.touchWarning) value.warning = "tracking-incomplete";
  // Issue #964: a fleet pause or resume that switched every queue it knew over a set of queues that may be short.
  if (result?.queuesMayBeShort === true) value.queuesMayBeShort = true;
  // Issue #1035: where the set is short for a cause that waiting does not end, the class of Valkey's error reply.
  if (result?.queuesMayBeShort === true && ["key", "permission"].includes(result?.queuesShortLasting)) value.queuesShortLasting = result.queuesShortLasting;
  return value;
}

/**
 * A fleet pause or resume that reached part of the fleet (issue #964), in words a model may be handed: that part of the
 * fleet may have changed, so it never reads as "nothing happened", that Valkey answered a queue's switch with an error
 * that can follow a switch the script already made (`errored`, issue #1014), and that the list of queues may be short
 * when it may. "Once Valkey answers" only where a switch was sent and not answered (`sent`): a queue a Valkey that
 * answers refused, or answered with an error, is a matter of looking at the fleet. Never the console's own sentence,
 * which names a Valkey's address; the queues are named since issue #1064 (`lists`).
 *
 * `cause` (issue #1035, `switchShortCause`): where the list is short because Valkey answered a read with an error, a
 * sentence says which key and with what code, and what that code's class supports: what to put right first for a key
 * of another type or a permission, which waiting does not change; that a later read may succeed for a passing state;
 * nothing more for any other code. A cause that only waits adds nothing: the closing words already say what waits.
 *
 * `answeredCode` (issue #1064): the code of the reply where Valkey answered a queue's switch with a refusal or an
 * error (the first by class, `switchAnsweredCodes`). A sentence says the code and what its class supports
 * (`switchAnsweredSentence`), and where that class lasts the closing words no longer say to try the switch again,
 * which is the same answer again until the queue's key or the Valkey user is put right.
 *
 * `lists` (issue #1064): WHICH QUEUES, as the page and the CLI say it ("answered with an error for ...; not tried:
 * ...; confirmed resumed: ..."), one entry per Valkey (the action's `queueLists`), in a sentence of its own after the
 * first. A model was told only that some queues may be switched and others not, and could not say which to a person
 * who asked. Queue names and the console's closed words; an entry with any other character in it is left out, and a
 * Valkey's address is never part of one.
 */
export function switchPartialRefusal(paused, short, sent, errored = false, cause = null, answeredCode = null, lists = []) {
  const verb = paused ? "paused" : "resumed";
  const noun = paused ? "pause" : "resume";
  const answered = rm.replyCodeOf(answeredCode) !== null ? rm.erroredReadWords("", answeredCode) : null;
  const closing = sent ? `An operator can look at the fleet in the console and ${noun} it again once Valkey answers.` : answered?.lasting === true ? `An operator can look at the fleet in the console; the ${noun} is worth trying again only once that is put right.` : `An operator can look at the fleet in the console before trying the ${noun} again.`;
  const named = (Array.isArray(lists) ? lists : []).filter((entry) => typeof entry === "string" && /^[A-Za-z0-9 ._:@,;()-]{1,4000}$/.test(entry));
  const byQueue = named.length > 0 ? ` By queue: ${named.join("; and on another Valkey: ")}.` : "";
  return `The fleet ${noun} did not reach every queue, so some queues may be ${verb} and others not${errored ? `, and Valkey answered a ${noun} with an error, which can come after the queue was ${verb}` : ""}${short ? `, and the list of queues may be short, so other queues may exist and were not ${verb}` : ""}.${byQueue}${short ? switchShortCauseSentence(paused, cause) : ""}${answered !== null ? switchAnsweredSentence(paused, answeredCode) : ""} ${closing}`;
}

/** The grant is captured at extension registration, never reconstructed from deployment configuration. */
export async function executeToolAction(name, params, rawCtx, { paths, env, grantsEnv, granted = false, now = Date.now, fleet: injectedFleet, actionLookup = actionNamed, policy = authorizeTransition, audit: injectedAudit, actor: injectedActor, fs: files = fs, readModel = rm, writePlans = plans, deploymentDir = null, sizingNoteFn = null, ownQueueNamesFn = () => [] } = {}) {
  if (["priorities-set", "allocation-revert", "envelope-set"].includes(TOOL_ACTIONS[name]) && now === Date.now) now = () => allocNow().getTime();
  const allocationModel = { ...readModel };
  // `readAllocations` with them (issue #987): the envelope preview reads the expected digest, on the client its write uses.
  for (const method of ["applyPriorities", "revertAllocation", "writeEnvelope", "readAllocations"]) allocationModel[method] = (args) => readModel[method]({ ...args, ...allocRedis() });
  const toolCtx = gateDialogs(rawCtx);
  const interactive = toolCtx?.hasUI === true && typeof toolCtx?.ui?.confirm === "function";
  const actor = injectedActor ?? agentActor();
  const session = { name: actor.name, role: interactive ? "operator" : "agent" };
  const audit = injectedAudit ?? panelAudit(paths.logsDir);
  if (!interactive && !granted) {
    const refusal = "Headless writes require PI_DISPATCH_AGENT_WRITES=1 in the pi process's own environment.";
    try { audit.append({ actor, action: "write", kind: TOOL_ACTIONS[name] ?? "tool-refused", target: "tool", outcome: "refused", reason: refusal }); }
    catch { throw publicToolRefusal(AUDIT_REFUSAL); }
    throw publicToolRefusal(refusal);
  }
  let ownedFleet;
  // Explicit enumerable methods survive the action's origin wrapper. A Proxy with only get would lose
  // pauseQueue/resumeQueue when that wrapper copies its fleet adapter, despite reads working normally.
  const fleet = injectedFleet ?? Object.fromEntries(TOOL_FLEET_METHODS.map((method) => [method, (...args) => {
    // Issue #964: the kill switch's plan (the deployment's Valkey, and both on a disagreement, as the preview names them) and
    // this host's own queue from the deployment's `.env` (`deploymentOwnQueues`, which index.ts hands in), so a pause
    // reaches that queue on the Valkey its worker drains and on no other.
    ownedFleet ??= readModel.createFleetReader(paths, { readOnly: true, dollarEnvFn: () => env, nowFn: now, killSwitchPlanFn: ({ paused }) => readModel.killSwitchPlan({ paused, env }), ownQueueNamesFn });
    return ownedFleet[method](...args);
  }]));
  if (!injectedFleet) fleet.dispose = async () => ownedFleet?.dispose();
  try {
    // This refusal is derived solely from the request and a source-built tool name, before reading any
    // stored configuration. A file planner's later prose has no such provenance and stays local to UI.
    if (["dispatch_trigger_add", "dispatch_trigger_edit"].includes(name)) {
      const refusal = name === "dispatch_trigger_add" ? writePlans.triggerRequestRefusal(params, name) : writePlans.wideningFieldRefusal(params, name);
      if (refusal) throw publicToolRefusal(refusal);
    }
    const request = await toolActionRequest(name, params, { fleet });
    const action = actionLookup(request.action);
    if (!action) throw publicToolRefusal("this tool has no declared console action");
    const toolPlans = { ...writePlans };
    for (const fn of ["planTriggerEdit", "planTriggerDelete", "planPauseWindowEdit", "planPauseWindowDelete", "planLimitEdit", "planLimitDelete"]) toolPlans[fn] = (args) => writePlans[fn]({ ...args, surface: "tool", ...(fn === "planLimitEdit" && interactive && typeof sizingNoteFn === "function" ? { sizingNoteFn } : {}) });
    const ctx = { surface: "tool", interventionOrigin: interactive ? "human" : "agent", a: { interventionOrigin: interactive ? "human" : "agent", rm: allocationModel, plans: toolPlans, paths, env, grantsEnv, fleet, readJobsData, builtinModel, envelopeProblem, host: env.PI_WORKER_NAME || hostname(), killSwitchPlanFn: ({ paused }) => readModel.killSwitchPlan({ paused, env }) }, deps: { writePauseWindows: readModel.writePauseWindows }, fs: files, config: { pauseWindowsPath: paths.pauseWindowsPath, dir: deploymentDir }, now, session, log: () => {} };
    // Tool-proof fields remain refused even when a person would confirm a tool call. The console's add
    // planner uses its own caller label, so validate the model's request through the tool planner first.
    if (name === "dispatch_trigger_add" || name === "dispatch_trigger_edit") {
      const pre = name === "dispatch_trigger_add" ? writePlans.planTriggerAdd({ params, paths, env, fs: files }) : writePlans.planTriggerEdit({ params, paths, env, fs: files });
      if (pre.refusal) throw new Error(pre.refusal);
    }
    if (Object.keys(request.body).some((key) => !action.fields.includes(key))) throw publicToolRefusal(`${action.name} received a field it does not take`);
    const out = await action.preview(request.body, ctx);
    if (out?.refusal) throw new Error(out.refusal);
    if (out?.unchanged) return { applied: false, unchanged: true };
    const judge = (plan) => policy({ actor: session, action: action.name, transition: { ...(plan.policyEvidence ?? {}), plan: plan.plan, payload: plan.payload }, surface: "tool", granted, interactive });
    const allowed = judge(out);
    if (!allowed.ok) {
      audit.append({ actor, action: "write", kind: action.kind, target: out.target ?? action.name, outcome: "refused", reason: allowed.refusal });
      throw publicToolRefusal(allowed.refusal);
    }
    if (interactive) {
      const undo = action.undo?.(out);
      const undoText = typeof undo === "string" ? undo : undo?.bar ?? undo?.before ?? undo?.after ?? "review the resulting state";
      const title = out.plan?.title ?? out.summary?.[0] ?? action.name;
      const message = out.plan?.message ?? (out.summary ?? []).slice(1).join("\n");
      if (!(await toolCtx.ui.confirm(String(title), `${message}\nUndo: ${undoText}`))) return { applied: false, reason: "operator declined" };
    }
    // What may have changed since the preview, read again before the write: the action's own `recheck` where it has
    // one (issue #1035: the fleet's pause and resume reread the plan's refusal alone, where a second preview waited a
    // snapshot's whole bound again on a Valkey that does not answer, before the kill switch was sent), else a second
    // preview, compared with the first.
    const fresh = typeof action.recheck === "function" ? await action.recheck(out, request.body, ctx) : await action.preview(request.body, ctx);
    if (fresh?.refusal || fresh?.unchanged || fingerprint(fresh) !== fingerprint(out)) throw publicToolRefusal("the action changed since its preview; preview and confirm it again");
    const rechecked = judge(fresh);
    if (!rechecked.ok) throw publicToolRefusal(rechecked.refusal);
    // Human/agent origin comes from the UI outcome, never a model argument.
    ctx.interventionOrigin = interactive ? "human" : "agent";
    ctx.a.interventionOrigin = ctx.interventionOrigin;
    // `action-unconfirmed` (issue #961): a write that was sent and not confirmed is not one that was refused.
    const failure = (r) => r?.unreachable ? "action-unavailable" : r?.ok === true ? null : r?.partial === true ? "action-unconfirmed" : "action-refused";
    let bulkWarning = false;
    if (action.bulk) {
      const one = (method, args) => {
        const target = out.targets.find((row) => row.jobId === args.jobId);
        if (!target) return { invalid: "job was not in the confirmed action" };
        return auditedWrite({ audit, actor, kind: action.kind, target: target.jobId, reserve: target.reserve?.dollarsMicros ?? null, count: 1, failure }, () => readModel[method](args));
      };
      // The console action keeps its rechecks and partial-outcome behavior. Each actual job mutation gets
      // its own intent and receipt, so one refused job cannot make a whole batch look applied.
      ctx.a.rm = { ...ctx.a.rm, cancelHeldJob: async (args) => {
        const res = await one("cancelHeldJob", args); bulkWarning ||= Boolean(res?.warning); return res;
      } };
      for (const [many, single] of [["retryFailedJobs", "retryFailedJob"], ["removeFailedJobs", "removeFailedJob"]]) ctx.a.rm[many] = async ({ jobs, ...args }) => {
        const results = [];
        for (const { jobId, attemptsMade, finishedOn } of jobs) {
          const res = await one(single, { ...args, jobId, expect: { attemptsMade, finishedOn } });
          bulkWarning ||= Boolean(res?.warning);
          results.push({ ...res, jobId });
        }
        return { results };
      };
    }
    // Issue #964: a switch that landed over a set of queues that may be short gets its second `ok` row, the closed word.
    const note = (r) => (r?.queuesMayBeShort === true ? agentShortWord(r) : null);
    const result = action.bulk ? await action.apply(out, ctx) : await auditedWrite({ audit, actor, kind: action.kind, target: fresh.target, beforeDigest: fresh.beforeDigest, afterDigest: fresh.afterDigest, reserve: fresh.reserve?.dollarsMicros ?? null, failure, note }, () => action.apply(out, ctx));
    if (bulkWarning) result.warning = "tracking-incomplete";
    if (result?.invalid === AUDIT_REFUSAL) throw publicToolRefusal(AUDIT_REFUSAL);
    if (result?.partial === true && (action.name === "fleet-pause" || action.name === "fleet-resume")) throw publicToolRefusal(switchPartialRefusal(action.name === "fleet-pause", result.queuesMayBeShort === true, result.sentUnconfirmed === true, result.answeredWithError === true, result.shortCause ?? null, result.answeredCode ?? null, result.queueLists ?? []));
    if (!result?.ok && !(action.name === "priorities-set" && result?.outcome === "refused")) throw new Error(result?.invalid ?? result?.refused ?? "the action could not be applied");
    return toolWriteResult(result, { action: action.name, out: fresh });
  } finally {
    if (!injectedFleet) await fleet.dispose();
  }
}
