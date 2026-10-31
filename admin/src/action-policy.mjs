/**
 * The operator's delegation is about a concrete transition, never a model's reason for wanting it (#766).
 * Keep this module independent of HTTP and pi so both surfaces judge exactly the same evidence.
 */
import { parseUsdMicros } from "@edgehero/pi-dispatch/money";
const rule = (mode, reason, ...tools) => Object.freeze({ mode, reason, tools: Object.freeze(tools) });
export const AGENT_MODES = Object.freeze(["unattended", "confirm", "person"]);
export const ACTION_AGENT_POLICIES = Object.freeze({
  "setting-set": rule("confirm", "Only a decrease of a cap explicitly present in the settings file is unattended.", "dispatch_set"),
  "setting-unset": rule("confirm", "Unsetting can restore a larger inherited limit.", "dispatch_set"),
  "trigger-add": rule("confirm", "A trigger acts later and can widen a reviewed narrowing.", "dispatch_trigger_add"),
  "trigger-edit": rule("confirm", "Only turning existing execution flags off is unattended.", "dispatch_trigger_edit"),
  "trigger-delete": rule("confirm", "Deleting and adding can remove a reviewed narrowing.", "dispatch_trigger_delete"),
  "pause-window-add": rule("unattended", "Adding a pause only prevents starts.", "dispatch_pause_add"),
  "pause-window-edit": rule("confirm", "Editing a pause can release work paused by a person.", "dispatch_pause_edit"),
  "pause-window-delete": rule("confirm", "Deleting a pause can release work paused by a person.", "dispatch_pause_delete"),
  "limit-add": rule("confirm", "A new restrictive row is unattended only without a size or reserved minimum.", "dispatch_limit_add"),
  "limit-edit": rule("confirm", "Only explicit cap decreases within the same scope are unattended.", "dispatch_limit_edit"),
  "limit-delete": rule("confirm", "Deleting a limit widens the work it bounds.", "dispatch_limit_delete"),
  "project-add": rule("confirm", "Project membership determines which limits apply.", "dispatch_project_add"),
  "project-edit": rule("confirm", "Project membership determines which limits apply.", "dispatch_project_edit"),
  "project-delete": rule("confirm", "Project membership determines which limits apply.", "dispatch_project_delete"),
  "envelope-set": rule("confirm", "The operator sets the allocation boundary.", "dispatch_envelope_set"),
  "priorities-set": rule("unattended", "Weights remain inside the current envelope and its delegation bounds.", "dispatch_priorities_set"),
  "allocation-revert": rule("confirm", "Reverting bypasses a new plan's delegation step and interval.", "dispatch_allocation_revert"),
  "fleet-pause": rule("unattended", "A pause prevents new starts.", "dispatch_pause"),
  "queue-pause": rule("unattended", "A pause prevents new starts.", "dispatch_pause"),
  "fleet-resume": rule("confirm", "A pause has no owner; resuming can release a person's pause.", "dispatch_resume"),
  "queue-resume": rule("confirm", "A pause has no owner; resuming can release a person's pause.", "dispatch_resume"),
  "cancel-active": rule("unattended", "Cancellation stops work without widening its authority.", "dispatch_cancel"),
  "cancel-queued": rule("unattended", "Removal prevents a queued start.", "dispatch_cancel"),
  "cancel-held": rule("unattended", "Removal prevents a held start.", "dispatch_cancel", "dispatch_wait_cancel"),
  "cancel-all-held": rule("unattended", "Removal prevents held starts.", "dispatch_cancel"),
  "remove-failed": rule("unattended", "Removal does not restart work.", "dispatch_remove_failed"),
  "remove-all-failed": rule("unattended", "Removal does not restart work.", "dispatch_remove_failed"),
  "retry-failed": rule("confirm", "Retry replays fields which the operator may since have narrowed.", "dispatch_retry_failed"),
  "retry-all-failed": rule("confirm", "Retry replays fields which the operator may since have narrowed.", "dispatch_retry_failed"),
  "trigger-fire": rule("unattended", "The current local flow and process grants are checked again before enqueue.", "dispatch_trigger_fire"),
  "rerun": rule("confirm", "Only a freshly admitted local or cron start is unattended.", "dispatch_rerun"),
  // dispatch_run has no separate console form; it still declares the policy of its tool entry point.
  "run-enqueue": rule("unattended", "Every local start passes the current process's six admission limits.", "dispatch_run"),
  "pause-windows": rule("person", "Replacing the whole list can release a person's pauses."),
  "model-role-edit": rule("person", "A person reviews role mappings and fallback changes; tools cannot adopt a model."),
  "secret-profile-add": rule("person", "Resolver declarations grant host execution."),
  "secret-profile-remove": rule("person", "Resolver declarations belong to the operator."),
  "secret-bundle-add": rule("person", "Bundle declarations grant credentials and host execution."),
  "secret-bundle-remove": rule("person", "Bundle declarations belong to the operator."),
  "parked-answer": rule("person", "Only a person sends an answer or decides an approval."),
  "standing-answer-add": rule("person", "Only a person adopts standing guidance."),
  "answer-draft-drop": rule("person", "Draft decisions belong to the person answering."),
  "steer": rule("person", "A message into a running agent must come from a person."),
  "steer-withdraw": rule("person", "A person owns the message being withdrawn."),
  "run-fork": rule("person", "A fork needs the operator's terminal."),
  "sandbox-prepare": rule("person", "Sandbox preparation is an attended operator action."),
  "sandbox-pin": rule("person", "Workspace retention belongs to the operator."),
  "sandbox-end": rule("person", "A sandbox shell belongs to its operator."),
  "sandbox-host-set": rule("person", "Terminal enrollment grants access on the operator's computer."),
  "zero-touch-group": rule("person", "Private question analysis is requested by an operator."),
  "zero-touch-name": rule("person", "A person supplies the group's name."),
  "zero-touch-instruction": rule("person", "Standing instructions are an operator's reviewed text."),
  "zero-touch-undo": rule("person", "Undo changes standing instructions."),
  "board-freeze": rule("person", "Board authority has no model tool."),
  "board-unfreeze": rule("person", "Board authority has no model tool."),
  "board-clear": rule("person", "Board authority has no model tool."),
  "board-revert": rule("person", "Board authority has no model tool."),
  "board-adopt": rule("person", "A person adopts a model's proposed board."),
});

export function actionAgentPolicy(name) {
  if (!Object.hasOwn(ACTION_AGENT_POLICIES, name)) throw new Error(`Action ${name} has no explicit agent policy`);
  return ACTION_AGENT_POLICIES[name];
}
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keysChanged = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !same(a[k], b[k]));
const SETTINGS_CAPS = new Set(["dailyCap", "weeklyCap", "monthlyCap", "maxTurns", "maxTokens", "dailyTokenCap", "concurrency", "softHoldPct", "maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]);
const LIMIT_CAPS = new Set(["day", "week", "month", "concurrent", "dayUsd", "weekUsd", "monthUsd", "hostShare"]);
const FLAGS = new Set(["recover", "steer", "progress", "statusComment"]);
const dollar = (key) => /Usd$/.test(key);
function amount(value, usd) {
  if (!usd) return Number.isSafeInteger(value) && value >= 0 ? value : null;
  try { return parseUsdMicros(value, "agent cap"); } catch { return null; }
}
function decreased(before, after, allowed) {
  if (!object(before) || !object(after)) return false;
  const changed = keysChanged(before, after);
  return changed.length > 0 && changed.every((key) => {
    if (!allowed.has(key) || !Object.hasOwn(before, key) || !Object.hasOwn(after, key)) return false;
    const old = amount(before[key], dollar(key)), next = amount(after[key], dollar(key));
    return old !== null && next !== null && next < old;
  });
}
function onlyRowChanged(before, after, key, index) {
  if (!object(before) || !object(after) || !Number.isSafeInteger(index) || index < 0) return false;
  const a = before[key], b = after[key];
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !object(a[index]) || !object(b[index])) return false;
  return keysChanged(before, after).every((k) => k === key) && a.every((row, i) => i === index || same(row, b[i]));
}
const unattended = (base, reason) => ({ ...base, mode: "unattended", reason });

/** Evidence comes from the planner's validated dry-run output, never request claims or context text. */
export function evaluateAgentAction(name, { before, after, plan = null, payload = null } = {}) {
  const base = actionAgentPolicy(name);
  if (name === "setting-set" && decreased(before, after, SETTINGS_CAPS)) return unattended(base, "Every changed cap is explicit in this file and decreases.");
  const index = plan?.index;
  if (name === "limit-edit" && onlyRowChanged(before, after, "limits", index) && decreased(before.limits[index], after.limits[index], LIMIT_CAPS)) return unattended(base, "Only explicit limits decrease; scope, size and reserved minimum are unchanged.");
  if (name === "limit-add" && object(before) && object(after) && Array.isArray(before.limits) && Array.isArray(after.limits) && after.limits.length === before.limits.length + 1 && keysChanged(before, after).every((k) => k === "limits" || k === "version") && before.limits.every((row, i) => same(row, after.limits[i]))) {
    const row = after.limits.at(-1);
    const fields = object(row) ? Object.keys(row).filter((key) => row[key] !== null && row[key] !== undefined) : [];
    if (fields.includes("scope") && fields.some((key) => LIMIT_CAPS.has(key)) && fields.every((key) => key === "scope" || LIMIT_CAPS.has(key)) && fields.filter((key) => key !== "scope").every((key) => amount(row[key], dollar(key)) !== null)) return unattended(base, "The added row only narrows ordinary limits and reserves no size or minimum.");
  }
  if (name === "trigger-edit" && onlyRowChanged(before, after, "triggers", index)) {
    const a = before.triggers[index], b = after.triggers[index];
    if (object(a.run) && object(b.run) && keysChanged(a, b).every((k) => k === "run")) {
      const changes = keysChanged(a.run, b.run);
      if (changes.length > 0 && changes.every((key) => FLAGS.has(key) && a.run[key] === true && b.run[key] === false)) return unattended(base, "Only existing execution flags are turned off.");
    }
  }
  if (name === "rerun") {
    const p = payload?.plan ?? plan;
    if (p?.agentAdmitted === true && ["local", "cron"].includes(p.kind)) return unattended(base, "The local or cron run passes fresh process-granted admission.");
    if (p?.kind === "forge") return { ...base, mode: "person", reason: "A forge rerun stays with a person at the console." };
  }
  return base;
}

export function authorizeTransition({ actor, action, transition = {}, surface = "api", granted = false, interactive = false } = {}) {
  const policy = evaluateAgentAction(typeof action === "string" ? action : action?.name, transition);
  const name = typeof action === "string" ? action : action?.name;
  const denied = (reason = policy.reason) => ({ ok: false, policy, refusal: `${name} is ${policy.mode}: ${reason}` });
  if (surface === "tool" && policy.mode === "person") return denied();
  if (actor?.role === "operator" && (surface !== "tool" || interactive)) return { ok: true, policy };
  if (actor?.role !== "agent") return denied("This action requires an operator or a delegated agent.");
  if (surface === "tool" && !granted) return denied("Headless writes require PI_DISPATCH_AGENT_WRITES=1 in the pi process's own environment.");
  return policy.mode === "unattended" ? { ok: true, policy } : denied();
}

export function evaluateActionPolicy(action, out) {
  return evaluateAgentAction(action.name, { ...out?.policyEvidence, plan: out?.plan, payload: out?.payload });
}
