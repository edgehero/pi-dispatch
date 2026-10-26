/**
 * The runs screen's filter (issue #641): `parseRunFilter` turns a query string into a filter or a refusal, and
 * `runMatches` decides whether one run record passes it. PURE: no I/O, no clock, nothing read from a deployment, so the
 * console's route, its tests and any later caller judge a filter the same way.
 *
 * EVERY VALUE IS BOUNDED AND CHARSET-CHECKED BEFORE IT IS USED, and a value that fails is REFUSED, never trimmed or
 * stripped into something that passes. A filter value comes from a URL anyone with a viewer session can type, and it
 * travels from here into a page (the "filtered by" line) and into a comparison; a charset per field is what keeps a
 * control byte, a quote or a 10 MB string out of both. Each charset is the shape the WORKER writes into that record
 * field (imported where the worker exports it), so a refusal can never hide a run that actually exists. For `model`
 * that holds through the worker's sources rather than an import (issue #673): the worker holds every source of a run's
 * model (a trigger's run.model, PI_MODEL, the settings overlay's `model`, `pi-dispatch run --model`) to one model-id
 * shape, `modelIdProblem` in worker/src/model-ref.mjs, and every id that shape accepts passes RUN_MODEL_RE, held by
 * admin/test/run-model-bolt.test.mjs. The refusal names the field and its rule, never the value: echoing hostile input
 * back is the mistake a refusal exists to avoid.
 *
 * Matching is EXACT per field (a record with no `backend` reads as `local`, see `runMatches`), with three exceptions.
 * `q` is a case-insensitive substring of the record's `target` or its `jobId` (issue #737): the target is the one field
 * an operator half-remembers (`web#12`), and the runs page's one search pill takes a repository, a target or a job id
 * (`gh-2f6a`), so a fragment of either finds its run. `outcome` reads the console's words (issue #737): a person filters
 * by what a row says, so `failed` finds a recovery end the record writes as `policy`. `problems=1` keeps every run that
 * did not complete.
 */
import { RUN_KINDS } from "@edgehero/pi-dispatch/forges";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { HOST_VENUE_NAME_RE, UNATTRIBUTED_BACKEND } from "@edgehero/pi-dispatch/backends";
import { repoOfTarget } from "./costs.mjs";
import { OUTCOME_KEYS, RECORD_REASON_RE, outcomeKey } from "./words.mjs";

/** The query parameters this filter reads, in the order a page states them. Anything else in the query is not its. */
export const RUN_FILTER_FIELDS = Object.freeze(["repo", "kind", "flow", "trigger", "project", "host", "backend", "outcome", "reason", "model", "q", "problems"]);

/**
 * What `outcome` takes (issue #737): the five outcome keys a row's badge says (words.mjs `OUTCOME_KEYS`: completed,
 * refused, failed, awaiting-input, cancelled), then `policy`, the record's own value, which a link written before the
 * keys still carries and which keeps meaning the record's value: refused, cancelled and the recovery failures alike.
 */
export const RUN_OUTCOME_VALUES = Object.freeze([...OUTCOME_KEYS, "policy"]);

// A trigger is either the raw triggers-array position a forge run records (`triggerIndex`) or a cron scheduler id,
// which a scheduled run carries in its job id (`repeat:<id>:<millis>`, `manual:<id>:<millis>`); the id charset is the
// triggers loader's `ID_CHARSET`, bounded.
const TRIGGER_INDEX_RE = /^\d{1,4}$/;
const TRIGGER_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * A run record's `model`: the bare host-effective model id (no provider prefix), as the runs filter and `/api/run`
 * both check it (issue #668). One optional leading `@` or `~` (the priced catalog's `@cf/...` and `~anthropic/...`
 * ids carry one; the usage ledger's allowlist, `MODEL_REF_PATTERN`, admits it too), then a letter or digit, then
 * letters, digits and . _ : / @ + -, at most 128 characters in all. A lone `@` or `~`, a `~` past the first character
 * and a first character of `.`, `/` or `:` are refused.
 */
export const RUN_MODEL_RE = /^(?=.{1,128}$)[~@]?[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/**
 * A run record's `provider`, as `/api/run` checks it (console/run-api.mjs): a letter or digit, then letters, digits and
 * . _ -, at most 64 characters, case allowed. Every source of a run's provider (a trigger's run.provider, PI_PROVIDER,
 * the settings overlay's `provider`) is held by the worker to `providerIdProblem` (worker/src/model-ref.mjs), and every id
 * that accepts, in the case the worker keeps, passes this: held by admin/test/run-model-bolt.test.mjs (issue #673).
 */
export const RUN_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Each field's rule: a test and the words a refusal uses. */
const RULES = Object.freeze({
  // A repository path as the forges spell one: GitLab subgroups and Azure's `project/repo` have more than one slash,
  // and an Azure project name may hold a space (never at either end).
  repo: { ok: (v) => v.length <= 200 && /^[A-Za-z0-9._/-](?:[A-Za-z0-9._/ -]*[A-Za-z0-9._/-])?$/.test(v), says: "a repository path of letters, digits, '.', '_', '-', '/' and inner spaces, at most 200 characters" },
  kind: { ok: (v) => RUN_KINDS.includes(v), says: `one of ${RUN_KINDS.join(", ")}` },
  flow: { ok: (v) => SKILL_NAME_RE.test(v), says: "a flow name (lowercase letters, digits, '_' and '-', at most 64 characters)" },
  trigger: { ok: (v) => TRIGGER_INDEX_RE.test(v) || TRIGGER_ID_RE.test(v), says: "a trigger's index or a scheduler id (letters, digits, '.', '_', '-', at most 128 characters)" },
  project: { ok: (v) => PROJECT_ID_RE.test(v), says: "a project id (lowercase letters, digits and '-', at most 32 characters)" },
  host: { ok: (v) => WORKER_NAME_RE.test(v), says: "a worker name (letters, digits, '.', '_', '-', at most 64 characters)" },
  // A venue name (issue #712), by the shape a host row carries one (HOST_VENUE_NAME_RE), not this build's table: a
  // newer worker can bless and record a venue this console does not know, the Venues view lists it by name, and a
  // filter refusing it would hide runs that exist.
  backend: { ok: (v) => HOST_VENUE_NAME_RE.test(v), says: "a venue name (lowercase letters, digits and '-', starting with a letter, at most 32 characters)" },
  // A closed list, not a shape: a shape check let `outcome=refused` match nothing at all, silently (#710). Issue
  // #710 took the record's three values and refused the console's words, so a filter matched exactly what the record
  // held; issue #737 reverses that. The page's counts, links and select say the words (a recovery end is "failed", an
  // operator's cancel "cancelled", a run awaiting input is not "completed"), and a filter that took only the record's
  // values could not find what its own summary counted. `policy` stays, meaning the record's value, so an old link
  // keeps its rows. The refusal names the six values.
  outcome: { ok: (v) => RUN_OUTCOME_VALUES.includes(v), says: `one of ${OUTCOME_KEYS.join(", ")} (or policy, the record's value for refused, cancelled and recovery failures)` },
  // The record's reason token (words.mjs `RECORD_REASON_RE`, the worker's own leaf).
  reason: { ok: (v) => RECORD_REASON_RE.test(v), says: "a reason (lowercase letters, digits and '-', at most 64 characters)" },
  // The record's `model` is the bare host-effective model id; the usage ledger's allowlist admits a leading `@` or `~`,
  // so this is the same shape with case allowed, bounded (RUN_MODEL_RE).
  model: { ok: (v) => RUN_MODEL_RE.test(v), says: "a model id (an optional leading @ or ~, then letters, digits and . _ : / @ + -, at most 128 characters)" },
  // A target's or a job id's fragment: the job id charset (`RUN_ID_RE`'s letters, digits and . _ : -) is inside it, and
  // so is its length (200, issue #737), so every id the run page takes is a search the runs page takes whole, and the
  // run-not-found page's search field can hold the id it was asked for.
  q: { ok: (v) => /^[A-Za-z0-9._:/#!-](?:[A-Za-z0-9._:/#! -]{0,198}[A-Za-z0-9._:/#!-])?$/.test(v), says: "a target or job id fragment (letters, digits, inner spaces and . _ : / # ! -, at most 200 characters)" },
  problems: { ok: (v) => v === "1", says: "1 (only problems)" },
});

/**
 * The filter in a query: `{ filter }` (only the fields that are set, frozen; `{}` filters nothing) or `{ refusal }`.
 * Takes a `URLSearchParams` or a plain object of strings. An empty value is unset. A field given twice is refused
 * rather than one of them silently winning, and a value is never trimmed: `" acme/web"` is refused, not read as
 * `acme/web`.
 */
export function parseRunFilter(searchParams) {
  const all = (name) => {
    if (searchParams && typeof searchParams.getAll === "function") return searchParams.getAll(name);
    const v = searchParams?.[name];
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
  };
  const filter = {};
  for (const field of RUN_FILTER_FIELDS) {
    const values = all(field);
    if (values.length === 0) continue;
    if (values.length > 1) return { refusal: `${field} is given more than once` };
    const value = values[0];
    if (typeof value !== "string") return { refusal: `${field} must be text` };
    if (value === "") continue;
    if (value.length > 256 || !RULES[field].ok(value)) return { refusal: `${field} must be ${RULES[field].says}` };
    filter[field] = value;
  }
  return { filter: Object.freeze(filter) };
}

/** A record's scheduler id from its cron job id (`repeat:<id>:<millis>` or `manual:<id>:<millis>`), or null. */
function schedulerIdOf(jobId) {
  if (typeof jobId !== "string") return null;
  const m = /^(?:repeat|manual):(.+):\d+$/.exec(jobId);
  return m ? m[1] : null;
}

/**
 * The venue a run used (issue #712): its record's `backend`, or `local` for a record that names none, which was written
 * before venues were recorded (`UNATTRIBUTED_BACKEND`, the worker's own reading). The one reading the filter, the runs
 * table and the runs window share.
 */
export function runVenueOf(record) {
  return typeof record?.backend === "string" && record.backend !== "" ? record.backend : UNATTRIBUTED_BACKEND;
}

/**
 * The `trigger` value that finds `record` (issue #737), as the runs page lists one: a forge run's triggers-array
 * position (`triggerIndex`) as a string, else a cron run's scheduler id, else null. Not yet held to the filter's rule:
 * a caller that lists it checks it with `parseRunFilter`, as it does every value it lists.
 */
export function triggerValueOf(record) {
  if (Number.isSafeInteger(record?.triggerIndex) && record.triggerIndex >= 0) return String(record.triggerIndex);
  return schedulerIdOf(record?.jobId);
}

/**
 * Whether `record` passes `filter` (a `parseRunFilter` result's `filter`): every set field must hold. A null or empty
 * filter passes everything. A record field that is absent never matches a set filter field, with one exception:
 * `backend`, where a record with no venue is a `local` run from before venues were recorded (UNATTRIBUTED_BACKEND), so
 * `backend=local` matches it and every other venue does not.
 */
export function runMatches(record, filter) {
  if (!filter) return true;
  if (record === null || typeof record !== "object") return false;
  const f = filter;
  if (f.repo !== undefined && repoOfTarget(record.target) !== f.repo) return false;
  if (f.kind !== undefined && record.kind !== f.kind) return false;
  if (f.flow !== undefined && record.flow !== f.flow) return false;
  if (f.trigger !== undefined) {
    const byIndex = TRIGGER_INDEX_RE.test(f.trigger) && record.triggerIndex === Number(f.trigger);
    if (!byIndex && schedulerIdOf(record.jobId) !== f.trigger) return false;
  }
  if (f.project !== undefined && record.project !== f.project) return false;
  if (f.host !== undefined && record.host !== f.host) return false;
  // A record that names no venue is a `local` run from before venues were recorded (UNATTRIBUTED_BACKEND), so
  // `backend=local` finds it: the one field whose absence has a meaning, which is the worker's own reading.
  if (f.backend !== undefined && runVenueOf(record) !== f.backend) return false;
  // `policy` is the record's own value; every other value is a key of what the row says (`outcomeKey`, the raw
  // outcome and reason), so `failed` finds a recovery end and `completed` leaves out a run awaiting input.
  if (f.outcome !== undefined && (f.outcome === "policy" ? record.outcome !== "policy" : outcomeKey(record.outcome, record.reason) !== f.outcome)) return false;
  if (f.reason !== undefined && record.reason !== f.reason) return false;
  if (f.model !== undefined && record.model !== f.model) return false;
  if (f.q !== undefined) {
    const needle = f.q.toLowerCase();
    const has = (v) => typeof v === "string" && v.toLowerCase().includes(needle);
    if (!has(record.target) && !has(record.jobId)) return false;
  }
  // Every run that did not complete, an outcome this release does not know included (its key is null).
  if (f.problems !== undefined && outcomeKey(record.outcome, record.reason) === "completed") return false;
  return true;
}
