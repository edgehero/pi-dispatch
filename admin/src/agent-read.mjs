import { recordedModelSelection } from "@edgehero/pi-dispatch/model-selection-record";
import { recordedMainCredential, recordedSecretFiles } from "@edgehero/pi-dispatch/run-history";
/** Model-facing reads are rebuilt before rendering or caching. New prose fields are withheld by default (#766). */
import { basename } from "node:path";
import { REASONS, SESSION_REASON_TEXT, PLAN_REASON_TEXT } from "@edgehero/pi-dispatch/reason-catalog";
import { DEFER_WHYS } from "@edgehero/pi-dispatch/defer-reasons";
import { MEMORY_REASONS, CPU_REASONS } from "@edgehero/pi-dispatch/size-suggest";
import { NEWER_RECORD_MODEL_NOTE, NEWER_RECORD_SENTENCE } from "./newer-release.mjs";
import { isOutcomeNote, outcomeNote } from "./loaded-words.mjs";
// These are source enums, not a grammar claiming that arbitrary single-word prose is safe.
const REASON_TOKENS = new Set([...Object.keys(REASONS), ...Object.keys(SESSION_REASON_TEXT), ...Object.keys(PLAN_REASON_TEXT), ...Object.keys(DEFER_WHYS), ...MEMORY_REASONS, ...CPU_REASONS]);
const WHY_TOKENS = new Set([...REASON_TOKENS, "fallback-unlisted", "unboundable", "external", "over-cap", "final-payload", "turn"]);
export const agentReasonToken = (value) => typeof value === "string" && REASON_TOKENS.has(value) ? value : null;
const ID = /^[A-Za-z0-9_][A-Za-z0-9._:@/+#!~-]{0,299}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STRINGS = new Set(["class", "basis", "field", "rule", "ref", "scopeId", "touchScopeId", "digest", "envelopeDigest", "afterDigest", "beforeDigest", "models", "fallbackModels", "auxiliaryModels", "kept", "members", "memory", "cpus", "hostShare", "modelRole", "role", "property", "word", "assertedBy", "armedBy", "observedBy", "blessed", "default", "format", "sourcesSeen", "sourceStatus", "readStatus", "served", "floor", "coverage", "mirror", "capture", "providerFailure", "modelWhy", "whyKnown", "reasonKey", "stat", "unit", "maxCostUsd", "maxSubscriptionUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd", "dayUsd", "weekUsd", "monthUsd", "totalUsd","class", "role", "page", "id", "jobId", "runId", "draftRunId", "sourceRunId", "queue", "unavailableQueues", "host", "worker", "version", "piVersion", "kind", "runKind", "type", "mode", "status", "state", "outcome", "reason", "why", "provider", "model", "backend", "venue", "project", "projectId", "repo", "repository", "target", "flow", "key", "scope", "ledger", "window", "source", "writer", "name", "planId", "action", "cause", "classification", "vocabulary", "triggerType", "cron", "expression", "from", "to", "tz", "date", "at", "startedAt", "endedAt", "finishedAt", "createdAt", "updatedAt", "next", "keptUntil", "retainedUntil"]);
// The only `note` values a model or an agent is handed: this build's own sentences beside a run record a newer
// pi-dispatch wrote (issue #761), the one `dispatch_runs` gives and the one the run page and `/api/run` give, and
// `outcomeNote`'s closed sentences beside a run that lacked its flow or an extension (issue #800, `isOutcomeNote`).
const OWN_NOTES = new Set([NEWER_RECORD_MODEL_NOTE, NEWER_RECORD_SENTENCE]);
const PRIVATE = new Set(["closeActors", "reviewAuthors", "text", "body", "task", "title", "description", "summary", "instructions", "note", "notes", "phase", "phases", "progress", "recoveryProgress", "failedReason", "reasonText", "whyText", "fix", "fixes", "command", "argv", "path", "paths", "root", "roots", "resolver", "secretProfiles", "secretBundles", "secretReferences", "secrets", "headers", "args", "url", "href", "html", "transcript", "entries", "privateDraft", "draft", "question", "sources", "probabilities", "standing", "standingAnswers", "answerRules", "rules", "groups", "questionGroups", "triggerEditor", "forkPoints", "sandboxHosts", "sandboxHostsProblem", "configLocations", "barLines", "classification", "draftRunId", "sourceRunId", "loaded", "outcomeNote", "hostLoads", "loads", "sandboxRun", "triggerGets", "modelChoices", "history"]);

/**
 * The maps of a name to the code of Valkey's error reply for its read: `queueErrors`, a queue's (issue #1064), and
 * `hostErrors`, a host row's (issue #1036). Their fields are names, not keys this table knows, so the string rule
 * dropped every one and a reader got `{}`: that something was answered with an error, and neither what nor with what.
 * A name passes as an id and a code as one word of letters, digits and `_` (the reply's first word, never its
 * sentence); any other entry is left out.
 *
 * The same code in its two other places in the state document (issue #1036): `fleetError`, the registry's own, and
 * the `error` of each entry of `unreadHosts`. Both are strings under keys this table does not know, so an agent's copy
 * had no `fleetError` at all and its `unreadHosts` named hosts without saying which of them Valkey had answered with
 * an error: the one fact that tells a row to repair from a row to wait for. Each passes as a code or is null.
 */
const ERROR_MAPS = new Set(["queueErrors", "hostErrors"]);

/**
 * THE UNREAD MARKS THAT HOLD A READER'S OWN WORDS (issue #1036): `queue.fleetDegraded`, why the host registry was not
 * read whole, and `parkedUnreachable`, why the parked runs were not. Each is a sentence that can quote a client (a
 * host name, an address), so the string rule dropped it, and with it the FACT: an agent's copy had no mark at all, and
 * its pages drew the hosts and the parked runs as read, under a pill that said Live. The fact is kept and the words
 * are not: each arrives as the one closed word below, a string, since the pages that draw these marks test for one.
 * What Valkey answered, where it answered with an error, is beside it as a code (`fleetError`, `unreadHosts`).
 */
const UNREAD_WORDS = new Set(["fleetDegraded", "parkedUnreachable"]);
export const AGENT_UNREAD_WORD = "unread";

/**
 * The lists whose entries name something not read with the code of Valkey's error reply for it (`error`): a host's
 * row (`unreadHosts`), and a queue's paused flag or one of its lists in the waiting read (`pausedUnread`,
 * `listsUnread`). The code passes as one word or is null; without this it was a string under a key this table does
 * not know, and the entry arrived naming the queue and not what it was answered.
 */
const CODED_LISTS = new Set(["unreadHosts", "pausedUnread", "listsUnread"]);
const REPLY_CODE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const replyCode = (value) => (typeof value === "string" && REPLY_CODE.test(value) ? value : null);

export function agentReadProjection(value, key = "", depth = 0) {
  if (depth > 16 || value === undefined) return undefined;
  if (ERROR_MAPS.has(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 5000).filter(([name, code]) => ID.test(name) && typeof code === "string" && REPLY_CODE.test(code)));
  }
  if (key === "modelSelection") return recordedModelSelection(value);
  // Console APIs also project raw records, without passing through modelRunRecord first. Keep its count-only rule
  // here too, and preserve an already projected count without exposing a malformed map's reference values.
  if (key === "secretFiles") return Number.isSafeInteger(value) && value >= 0 && value <= 80 ? value : recordedSecretFiles(value)?.length;
  // Issue #998: where a run's main credential came from, as its closed word alone: never the declared variable's name,
  // as a model reads secret names as counts. `modelRunRecord` (dispatch_runs) keeps the same rule.
  if (key === "mainCredential") { const c = recordedMainCredential(value); return c === null ? undefined : { source: c.source }; }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (key === "fleetError") return replyCode(value);
    if (UNREAD_WORDS.has(key)) return value === "" ? undefined : AGENT_UNREAD_WORD;
    // Issue #1035: beside `queuesMayBeShort` in a fleet pause's or resume's answer, the class of the error reply that
    // makes the list short for a cause waiting does not end. One of two closed words, anything else left out.
    if (key === "queuesShortLasting") return value === "key" || value === "permission" ? value : undefined;
    if (key === "mirror") return value === "off" ? "off" : /unreachable/.test(value) ? "unreachable" : "bounded";
    if (key === "folder" || ["scope", "members"].includes(key) && /^(?:\/|[A-Za-z]:[\\/])/.test(value)) { const name = basename(value); return ID.test(name) ? name : null; }
    if (/Usd$/.test(key) || key === "cap") return /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) ? value : null;
    if (["model", "models", "fallbackModels", "auxiliaryModels"].includes(key)) return /^[A-Za-z0-9@~][A-Za-z0-9_./:@~+-]{0,299}$/.test(value) ? value : null;
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
    // `note` stays withheld, except the sentences this build itself adds beside a run record a newer pi-dispatch wrote
    // (`OWN_NOTES`: `modelRunRecord`'s and `safeRunOf`'s). Matched by VALUE, not by field: they are this build's
    // constants, so nothing a record or a file holds reaches the reader through them, while every other `note` (an
    // operator's or a job's prose) is still dropped. Without them a record cut to its core arrives with nothing saying
    // why the rest is gone.
    if (field === "note" && (OWN_NOTES.has(v) || isOutcomeNote(v))) { out.note = v; continue; }
    // Issue #800: a model reads what the run lacked in the words a person does, and none of the list behind them. The sentence is
    // fixed words and a count, so it holds no name; the field holds a tool's name that only its shape vouches for, so it goes.
    if (field === "outcomeNote" && isOutcomeNote(v)) { out.note = v; continue; }
    if (field === "loaded") { const note = outcomeNote(value); if (note !== null) out.note = note; continue; }
    if (CODED_LISTS.has(key) && field === "error") { out.error = replyCode(v); continue; }
    if (PRIVATE.has(field)) continue;
    if (field === "invalid" && Array.isArray(v)) { out.invalid = v.filter((name) => ["maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"].includes(name)); continue; }
    // A yes or no about a read, in place of what it said. `unreadable` holds an OS code or a sentence about a record, and with it dropped a file that
    // could not be read arrived as an empty object, which a page read as a file with nothing wrong and nothing in it.
    // `costsUnreachable` (the Insights payload's costs) and `readInPart` (a registry read in part, in the reader's
    // words) joined the list with issue #1036: each was dropped whole, the fact with the words.
    if (["invalid", "unreachable", "unreadable", "refusal", "refused", "countersUnreachable", "recordsUnreachable", "costsUnreachable", "readInPart"].includes(field) && typeof v === "string") { out[field] = true; continue; }
    const projected = agentReadProjection(v, field, depth + 1);
    if (projected !== undefined) out[field] = projected;
  }
  return out;
}
