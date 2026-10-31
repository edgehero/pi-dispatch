/** Human-only answer adoption. These planners are never registered as model tools. */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { writeTriggers } from "@edgehero/pi-dispatch/triggers-file";
import { validateStandingAnswers } from "@edgehero/pi-dispatch/answerer";

const digest = text => createHash("sha256").update(text).digest("hex");
const RUN_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const SHA_RE = /^[a-f0-9]{64}$/;

export function planStandingAnswerAdd({ params, paths, fs = nodeFs, surface = "console", now = Date.now, adoptedAt = null } = {}) {
  if (surface !== "console") return { refusal: "Only a person in the operator console may adopt a standing answer." };
  if (typeof params?.title !== "string" || !params.title.trim() || typeof params?.text !== "string" || !params.text.trim() || !Array.isArray(params?.projects) || !params.projects.length) return { refusal: "Name the standing answer, write its text and select its projects and forge-qualified repository." };
  let text, raw;
  try { text = fs.readFileSync(paths.triggersPath, "utf8"); parseTriggersDocument(text, paths.triggersPath); raw = JSON.parse(text); }
  catch { return { refusal: "The reviewed triggers file could not be read and validated. Nothing was changed." }; }
  const answer = { id: `sa-${digest(JSON.stringify([params.title.trim(), params.text, params.projects, params.repo])).slice(0, 24)}`, title: params.title.trim(), text: params.text, projects: [...params.projects], repo: params.repo, adoptedAt: adoptedAt ?? new Date(now()).toISOString() };
  const standingAnswers = [...(raw.standingAnswers ?? []), answer];
  if ((raw.standingAnswers ?? []).some(a => a.id === answer.id)) return { unchanged: "This standing answer is already adopted for these projects." };
  try { validateStandingAnswers(standingAnswers); parseTriggersDocument(JSON.stringify({ ...raw, standingAnswers }), paths.triggersPath); }
  catch { return { refusal: "The standing answer must have a bounded title and text, valid project ids, and no control characters. Nothing was changed." }; }
  const afterText = `${JSON.stringify({ ...raw, standingAnswers }, null, 2)}\n`;
  return { plan: { kind: "standing-answer-add", answer, target: paths.triggersPath, expect: [{ path: paths.triggersPath, text }], beforeText: text, afterText, beforeDigest: digest(text), afterDigest: digest(afterText), title: "Adopt this standing answer?", summary: [`Add ${answer.title} for projects ${answer.projects.join(", ")} in ${answer.repo}.`, "Future draft jobs may cite these exact words. This does not change the answer rule or send an answer."], mutate: entries => entries, mutateDocument: doc => ({ ...doc, standingAnswers }) } };
}

export function applyStandingAnswerAdd({ plan, paths, fs = nodeFs } = {}) {
  if (plan?.kind !== "standing-answer-add") return { invalid: "This is not a standing-answer adoption plan." };
  return writeTriggers({ triggersPath: paths.triggersPath, mutate: plan.mutate, mutateDocument: plan.mutateDocument, expect: plan.expect, fs });
}

export function planAnswerDraftDrop({ params, draft, surface = "console" } = {}) {
  if (surface !== "console") return { refusal: "Only a person in the operator console may drop a draft." };
  if (!RUN_RE.test(params?.runId ?? "") || !RUN_RE.test(params?.draftRunId ?? "") || !SHA_RE.test(params?.digest ?? "") || !draft || draft.meta?.runId !== params.runId || draft.meta?.draftRunId !== params.draftRunId || draft.digest !== params.digest || !draft.draft) return { refusal: "The retained draft changed or expired. Reload its run page before dropping it." };
  return { plan: { kind: "answer-draft-drop", target: params.runId, runId: params.runId, draftRunId: params.draftRunId, digest: params.digest, title: "Drop this answer draft?", summary: [`Drop the draft from ${params.draftRunId}.`, "The parked question is unchanged. You can answer it yourself; no comment is sent and no new draft is started."] } };
}
