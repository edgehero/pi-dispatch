/** Model-callable writes use the console action planners and the same transition judge (#766). */
import * as fs from "node:fs";
import { publicToolRefusal } from "./tool-refusals.mjs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import * as rm from "./read-model.mjs";
import * as plans from "./write-plans.mjs";
import { agentReadProjection } from "./agent-read.mjs";
import { actionNamed } from "./console/actions.mjs";
import { authorizeTransition } from "./action-policy.mjs";
import { agentActor, panelAudit, auditedWrite, AUDIT_REFUSAL } from "./audited-write.mjs";
import { readJobsData } from "./console/job-data.mjs";
import { allocRedis, allocNow, envelopeProblem } from "./insights-assembly.mjs";
import { gateDialogs } from "./dialog-gate.mjs";
import { builtinModel } from "@edgehero/pi-dispatch/model-catalog";

export const TOOL_ACTIONS = Object.freeze({
  dispatch_set: "setting-set", dispatch_trigger_add: "trigger-add", dispatch_trigger_edit: "trigger-edit", dispatch_trigger_delete: "trigger-delete", dispatch_trigger_fire: "trigger-fire",
  dispatch_pause_add: "pause-window-add", dispatch_pause_edit: "pause-window-edit", dispatch_pause_delete: "pause-window-delete",
  dispatch_limit_add: "limit-add", dispatch_limit_edit: "limit-edit", dispatch_limit_delete: "limit-delete",
  dispatch_project_add: "project-add", dispatch_project_edit: "project-edit", dispatch_project_delete: "project-delete",
  dispatch_envelope_set: "envelope-set", dispatch_priorities_set: "priorities-set", dispatch_allocation_revert: "allocation-revert",
  dispatch_wait_cancel: "cancel-held", dispatch_cancel: "cancel-active", dispatch_retry_failed: "retry-failed", dispatch_remove_failed: "remove-failed",
  dispatch_rerun: "rerun", dispatch_pause: "fleet-pause", dispatch_resume: "fleet-resume", dispatch_run: "run-enqueue",
});

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
      else action = "cancel-queued";
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
  return value;
}

/** The grant is captured at extension registration, never reconstructed from deployment configuration. */
export async function executeToolAction(name, params, rawCtx, { paths, env, grantsEnv, granted = false, now = Date.now, fleet: injectedFleet, actionLookup = actionNamed, policy = authorizeTransition, audit: injectedAudit, actor: injectedActor, fs: files = fs, readModel = rm, writePlans = plans, deploymentDir = null, sizingNoteFn = null } = {}) {
  if (["priorities-set", "allocation-revert", "envelope-set"].includes(TOOL_ACTIONS[name]) && now === Date.now) now = () => allocNow().getTime();
  const allocationModel = { ...readModel };
  for (const method of ["applyPriorities", "revertAllocation", "writeEnvelope"]) allocationModel[method] = (args) => readModel[method]({ ...args, ...allocRedis() });
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
  const fleet = injectedFleet ?? Object.fromEntries(["snapshot", "pause", "resume", "cancelActive", "pauseQueue"].map((method) => [method, (...args) => {
    ownedFleet ??= readModel.createFleetReader(paths, { readOnly: true, dollarEnvFn: () => env, nowFn: now });
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
    const fresh = await action.preview(request.body, ctx);
    if (fresh?.refusal || fresh?.unchanged || fingerprint(fresh) !== fingerprint(out)) throw publicToolRefusal("the action changed since its preview; preview and confirm it again");
    const rechecked = judge(fresh);
    if (!rechecked.ok) throw publicToolRefusal(rechecked.refusal);
    // Human/agent origin comes from the UI outcome, never a model argument.
    ctx.interventionOrigin = interactive ? "human" : "agent";
    ctx.a.interventionOrigin = ctx.interventionOrigin;
    const failure = (r) => r?.unreachable ? "action-unavailable" : r?.ok === true ? null : "action-refused";
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
    const result = action.bulk ? await action.apply(out, ctx) : await auditedWrite({ audit, actor, kind: action.kind, target: fresh.target, beforeDigest: fresh.beforeDigest, afterDigest: fresh.afterDigest, reserve: fresh.reserve?.dollarsMicros ?? null, failure }, () => action.apply(out, ctx));
    if (bulkWarning) result.warning = "tracking-incomplete";
    if (result?.invalid === AUDIT_REFUSAL) throw publicToolRefusal(AUDIT_REFUSAL);
    if (!result?.ok && !(action.name === "priorities-set" && result?.outcome === "refused")) throw new Error(result?.invalid ?? result?.refused ?? "the action could not be applied");
    return toolWriteResult(result, { action: action.name, out: fresh });
  } finally {
    if (!injectedFleet) await fleet.dispose();
  }
}
