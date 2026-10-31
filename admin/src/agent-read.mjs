/** Model-facing reads are rebuilt before rendering or caching. New prose fields are withheld by default (#766). */
import { basename } from "node:path";
import { REASONS, SESSION_REASON_TEXT, PLAN_REASON_TEXT } from "@edgehero/pi-dispatch/reason-catalog";
import { DEFER_WHYS } from "@edgehero/pi-dispatch/defer-reasons";
import { MEMORY_REASONS, CPU_REASONS } from "@edgehero/pi-dispatch/size-suggest";
// These are source enums, not a grammar claiming that arbitrary single-word prose is safe.
const REASON_TOKENS = new Set([...Object.keys(REASONS), ...Object.keys(SESSION_REASON_TEXT), ...Object.keys(PLAN_REASON_TEXT), ...Object.keys(DEFER_WHYS), ...MEMORY_REASONS, ...CPU_REASONS]);
const WHY_TOKENS = new Set([...REASON_TOKENS, "fallback-unlisted", "unboundable", "external", "over-cap"]);
export const agentReasonToken = (value) => typeof value === "string" && REASON_TOKENS.has(value) ? value : null;
const ID = /^[A-Za-z0-9_][A-Za-z0-9._:@/+#!~-]{0,299}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STRINGS = new Set(["class", "basis", "field", "rule", "ref", "scopeId", "touchScopeId", "digest", "envelopeDigest", "afterDigest", "beforeDigest", "models", "fallbackModels", "kept", "members", "memory", "cpus", "hostShare", "modelRole", "role", "property", "word", "assertedBy", "armedBy", "observedBy", "blessed", "default", "format", "sourcesSeen", "sourceStatus", "readStatus", "served", "floor", "coverage", "mirror", "capture", "providerFailure", "modelWhy", "whyKnown", "reasonKey", "stat", "unit", "maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd", "dayUsd", "weekUsd", "monthUsd", "totalUsd","class", "role", "page", "id", "jobId", "runId", "draftRunId", "sourceRunId", "queue", "host", "worker", "version", "piVersion", "kind", "type", "mode", "status", "state", "outcome", "reason", "why", "provider", "model", "backend", "venue", "project", "projectId", "repo", "repository", "target", "flow", "key", "scope", "ledger", "window", "source", "writer", "name", "planId", "action", "cause", "classification", "vocabulary", "triggerType", "cron", "expression", "from", "to", "tz", "date", "at", "startedAt", "endedAt", "createdAt", "updatedAt", "next", "keptUntil", "retainedUntil"]);
const PRIVATE = new Set(["text", "body", "task", "title", "description", "summary", "instructions", "note", "notes", "phase", "phases", "progress", "recoveryProgress", "failedReason", "reasonText", "whyText", "fix", "fixes", "command", "argv", "path", "paths", "root", "roots", "resolver", "secretProfiles", "secretBundles", "secretReferences", "secrets", "headers", "args", "url", "href", "html", "transcript", "entries", "privateDraft", "draft", "question", "sources", "probabilities", "standing", "standingAnswers", "answerRules", "rules", "groups", "questionGroups", "triggerEditor", "forkPoints", "sandboxHosts", "sandboxHostsProblem", "configLocations", "barLines", "classification", "draftRunId", "sourceRunId"]);

export function agentReadProjection(value, key = "", depth = 0) {
  if (depth > 16 || value === undefined) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (key === "mirror") return value === "off" ? "off" : /unreachable/.test(value) ? "unreachable" : "bounded";
    if (key === "folder" || ["scope", "members"].includes(key) && /^(?:\/|[A-Za-z]:[\\/])/.test(value)) { const name = basename(value); return ID.test(name) ? name : null; }
    if (/Usd$/.test(key) || key === "cap") return /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) ? value : null;
    if (["model", "models", "fallbackModels"].includes(key)) return /^[A-Za-z0-9@~][A-Za-z0-9_./:@~+-]{0,299}$/.test(value) ? value : null;
    if (!STRINGS.has(key)) return undefined;
    if (key === "reason") return agentReasonToken(value);
    if (key === "why") return WHY_TOKENS.has(value) ? value : null;
    return ID.test(value) || TIME.test(value) ? value : null;
  }
  if (Array.isArray(value)) return value.slice(0, 5000).map((v) => agentReadProjection(v, key, depth + 1)).filter((v) => v !== undefined);
  if (typeof value !== "object") return undefined;
  const out = {};
  for (const [field, v] of Object.entries(value)) {
    if (field === "name" && ["project", "projects"].includes(key)) continue;
    if (["variables", "placeholderNames", "shadowed"].includes(field)) {
      if (Array.isArray(v)) out[`${field}Count`] = v.length;
      else if (Number.isSafeInteger(v) && v >= 0) out[field] = v;
      continue;
    }
    if (PRIVATE.has(field)) continue;
    if (field === "invalid" && Array.isArray(v)) { out.invalid = v.filter((name) => ["maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"].includes(name)); continue; }
    if (["invalid", "unreachable", "refusal", "refused", "countersUnreachable", "recordsUnreachable"].includes(field) && typeof v === "string") { out[field] = true; continue; }
    const projected = agentReadProjection(v, field, depth + 1);
    if (projected !== undefined) out[field] = projected;
  }
  return out;
}
