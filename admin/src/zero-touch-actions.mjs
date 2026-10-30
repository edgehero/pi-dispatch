/** Console-only human writes. This module is deliberately absent from the extension's model tool registrations. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { writeTriggers } from "@edgehero/pi-dispatch/triggers-file";
import { validateZeroTouchConfig, GROUP_ID_RE, QUESTION_RUN_RE, QUESTION_SCOPE_RE } from "@edgehero/pi-dispatch/question-groups";
import { questionGroupConfigDigest } from "@edgehero/pi-dispatch/question-group-runtime";
import { REASONS } from "@edgehero/pi-dispatch/reason-catalog";
const digest = text => createHash("sha256").update(text).digest("hex");
const refusal = message => ({ refusal: message });
const consoleOnly = surface => surface === "console" ? null : refusal("This change is available only to a person in the operator console.");
function readDocument(paths, fs) {
  const text = fs.readFileSync(paths.triggersPath, "utf8");
  const loaded = parseTriggersDocument(text, paths.triggersPath);
  return { text, loaded, raw: JSON.parse(text), expect: [{ path: paths.triggersPath, text }] };
}
function sourceContext(record, groupId) {
  if (!record || !QUESTION_RUN_RE.test(record.jobId ?? "") || !QUESTION_SCOPE_RE.test(record.touchScopeId ?? record.scopeId ?? "")) return null;
  if (GROUP_ID_RE.test(groupId ?? "") && ["awaiting-input", "awaiting-approval"].includes(record.reason)) return { runId: record.jobId, scopeId: record.touchScopeId ?? record.scopeId, project: record.project ?? null, groupId, reason: null };
  if (record.outcome === "policy" && Object.hasOwn(REASONS, record.reason)) return { runId: record.jobId, scopeId: record.touchScopeId ?? record.scopeId, project: record.project ?? null, groupId: null, reason: record.reason };
  return null;
}
export function planZeroTouchGroup({ params, config, meta, surface = "console" } = {}) {
  const denied = consoleOnly(surface); if (denied) return denied;
  let checked; try { checked = validateZeroTouchConfig(config); } catch { return refusal("The zeroTouch configuration is invalid; correct it before grouping questions."); }
  if (!checked?.capture) return refusal("Private question capture is not enabled in the reviewed zeroTouch configuration.");
  if (!QUESTION_RUN_RE.test(params?.runId ?? "") || !meta || meta.runId !== params.runId || !["unassigned", "failed", "stale", "refused", "pending"].includes(meta.status) || !/^[a-f0-9]{64}$/.test(meta.digest ?? "")) return refusal("The question has no available, unassigned private source. Read its grouping status and try again.");
  return { plan: { kind: "question-grouping", runId: meta.runId, digest: meta.digest, configDigest: questionGroupConfigDigest(checked), model: checked.model, maxCostUsd: checked.maxCostUsd, title: "Group this question?", summary: [`Classify the meaning of ${meta.runId} with ${checked.model}, capped at $${checked.maxCostUsd}.`, "The job returns a group id only. It cannot answer a question or name a group.", ...(meta.status === "pending" ? ["A previous grouping is pending or its result could not be confirmed. Confirming this request can pay for another classification."] : [])], target: meta.runId, expect: null } };
}
export function planZeroTouchName({ params, paths, fs = nodeFs, surface = "console" } = {}) {
  const denied = consoleOnly(surface); if (denied) return denied;
  if (!GROUP_ID_RE.test(params?.groupId ?? "")) return refusal("The group id is not valid.");
  let doc; try { doc = readDocument(paths, fs); } catch { return refusal("The triggers file could not be read and validated."); }
  if (!doc.loaded.zeroTouch) return refusal("The reviewed zeroTouch configuration is absent.");
  const config = { ...doc.loaded.zeroTouch, names: { ...doc.loaded.zeroTouch.names, [params.groupId]: params.name } };
  try { validateZeroTouchConfig(config); } catch { return refusal("A group name must have 1 to 120 characters without control or direction-changing characters."); }
  const before = doc.loaded.zeroTouch.names[params.groupId] ?? null;
  if (before === params.name) return { unchanged: "The group already has that name." };
  return { plan: { kind: "question-group-name", groupId: params.groupId, name: params.name, before, target: paths.triggersPath, expect: doc.expect, beforeText: doc.text, afterText: `${JSON.stringify({ ...doc.raw, zeroTouch: config }, null, 2)}\n`, mutate: entries => entries, mutateDocument: raw => ({ ...raw, zeroTouch: config }), title: "Name this question group?", summary: ["Use the name you wrote for this group. The model never writes a group name."] } };
}
export function planZeroTouchInstruction({ params, paths, sourceRecord, group = null, binding = null, fs = nodeFs, surface = "console" } = {}) {
  const denied = consoleOnly(surface); if (denied) return denied;
  if (!Number.isSafeInteger(params?.index) || params.index < 0 || typeof params.sentence !== "string" || !params.sentence.trim() || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(params.sentence)) return refusal("Choose a trigger and enter an instruction sentence without control characters.");
  if (sourceRecord?.jobId !== params.runId || sourceRecord?.triggerIndex !== params.index) return refusal("The source run does not identify that trigger; no instruction can be linked to it.");
  const cause = sourceContext(sourceRecord, params.groupId);
  if (!cause || cause.groupId && (!group || group.id !== cause.groupId || group.scopeId !== cause.scopeId || !group.runIds?.includes(params.runId))) return refusal("The fix needs its retained refusal or question group as an explicit source.");
  let doc; try { doc = readDocument(paths, fs); } catch { return refusal("The triggers file could not be read and validated."); }
  const entry = doc.raw.triggers[params.index];
  if (!entry || entry.on?.type === "cron" || entry.on?.type === "watch") return refusal("This trigger cannot take run.instructions; cron instructions belong in its task. Open its configuration instead.");
  if (!binding?.ok || binding.runId !== params.runId || binding.index !== params.index || binding.triggerDigest !== digest(JSON.stringify(entry))) return refusal("The source trigger identity is unavailable or changed. Open the current trigger configuration and review it first.");
  if (sourceRecord.kind !== entry.run?.kind) return refusal("The trigger changed since this run; open its configuration and review it first.");
  const before = entry.run?.instructions;
  const sentence = params.sentence.trim();
  const after = `${before ? `${before}\n` : ""}${sentence}`;
  if (after.length > 2000) return refusal("The existing instructions plus this sentence exceed 2,000 characters. Shorten the sentence first.");
  const next = structuredClone(doc.raw); next.triggers[params.index].run.instructions = after;
  const afterText = `${JSON.stringify(next, null, 2)}\n`;
  try { parseTriggersDocument(afterText, paths.triggersPath); } catch { return refusal("The amended trigger would not pass the loader's validation."); }
  return { plan: { kind: "instructions", ...cause, index: params.index, triggerIndex: params.index, before, after, sentence, sourceDigest: digest(JSON.stringify(entry)), target: paths.triggersPath, expect: doc.expect, beforeText: doc.text, afterText, mutate: entries => { const next = structuredClone(entries); if (digest(JSON.stringify(next[params.index])) !== digest(JSON.stringify(entry))) throw new Error("trigger changed"); next[params.index].run.instructions = after; return next; }, title: `Add instructions to trigger ${params.index + 1}?`, summary: [`Append the sentence to trigger ${params.index + 1}'s instructions.`, "The exact file diff is below. Undo removes this change only while the instructions still match."], privateUndo: { index: params.index, before: before ?? null, after, triggerDigest: digest(JSON.stringify(next.triggers[params.index])) } } };
}
export function planZeroTouchInstructionUndo({ params, paths, fix, fs = nodeFs, surface = "console" } = {}) {
  const denied = consoleOnly(surface); if (denied) return denied;
  if (!fix || fix.id !== params?.fixId || fix.kind !== "instructions" || fix.undoneAt || !fix.undo) return refusal("This instruction fix has expired or cannot be undone here.");
  let doc; try { doc = readDocument(paths, fs); } catch { return refusal("The triggers file could not be read and validated."); }
  const index = fix.undo.index, entry = doc.raw.triggers[index];
  if (!entry || entry.run?.instructions !== fix.undo.after || digest(JSON.stringify(entry)) !== fix.undo.triggerDigest) return refusal("The instructions changed after this fix. Review the current trigger; Undo will not overwrite that change.");
  const mutate = entries => { const next = structuredClone(entries); if (next[index]?.run?.instructions !== fix.undo.after) throw new Error("instructions changed"); if (fix.undo.before === null) delete next[index].run.instructions; else next[index].run.instructions = fix.undo.before; return next; };
  const next = { ...doc.raw, triggers: mutate(doc.raw.triggers) };
  return { plan: { kind: "instruction-undo", fixId: fix.id, index, target: paths.triggersPath, expect: doc.expect, beforeText: doc.text, afterText: `${JSON.stringify(next, null, 2)}\n`, mutate, title: "Remove the instruction sentence?", summary: [`Restore trigger ${index + 1}'s instructions to their value before this fix.`] } };
}
export function applyZeroTouchFilePlan({ plan, paths, fs = nodeFs } = {}) {
  if (!plan || !["question-group-name", "instructions", "instruction-undo"].includes(plan.kind)) return { invalid: "not a Zero touch file plan" };
  return writeTriggers({ triggersPath: paths.triggersPath, mutate: plan.mutate, mutateDocument: plan.mutateDocument, expect: plan.expect, fs });
}
