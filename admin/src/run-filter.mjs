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
 * Matching is EXACT per field (a record with no `backend` reads as `local`, see `runMatches`), except `q`, a case-insensitive substring of the record's `target`: the target is the one
 * field an operator half-remembers (`web#12`), and every other field is a closed vocabulary or an id they can copy.
 */
import { RUN_KINDS } from "@edgehero/pi-dispatch/forges";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { HOST_VENUE_NAME_RE, UNATTRIBUTED_BACKEND } from "@edgehero/pi-dispatch/backends";
import { repoOfTarget } from "./costs.mjs";
import { OUTCOME_WORDS } from "./words.mjs";

/** The query parameters this filter reads, in the order a page states them. Anything else in the query is not its. */
export const RUN_FILTER_FIELDS = Object.freeze(["repo", "kind", "flow", "trigger", "project", "host", "backend", "outcome", "reason", "model", "q"]);

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
  // The record's closed outcome enum (INT-RUN-HISTORY-FILE-CONTRACT, words.mjs's keys), not a shape: the console SAYS
  // "refused" for `policy` (#710), so `outcome=refused` is the filter an operator types, and a shape check let it
  // match nothing at all, silently (round 2). The refusal names the three values and which one a refused run is.
  outcome: { ok: (v) => Object.hasOwn(OUTCOME_WORDS, v), says: `one of ${Object.keys(OUTCOME_WORDS).join(", ")} (the record's values: a refused or cancelled run is policy)` },
  reason: { ok: (v) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(v), says: "a reason (lowercase letters, digits and '-', at most 64 characters)" },
  // The record's `model` is the bare host-effective model id; the usage ledger's allowlist admits a leading `@` or `~`,
  // so this is the same shape with case allowed, bounded (RUN_MODEL_RE).
  model: { ok: (v) => RUN_MODEL_RE.test(v), says: "a model id (an optional leading @ or ~, then letters, digits and . _ : / @ + -, at most 128 characters)" },
  q: { ok: (v) => /^[A-Za-z0-9._:/#!-](?:[A-Za-z0-9._:/#! -]{0,98}[A-Za-z0-9._:/#!-])?$/.test(v), says: "a target fragment (letters, digits, inner spaces and . _ : / # ! -, at most 100 characters)" },
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
  if (f.backend !== undefined && (typeof record.backend === "string" && record.backend !== "" ? record.backend : UNATTRIBUTED_BACKEND) !== f.backend) return false;
  if (f.outcome !== undefined && record.outcome !== f.outcome) return false;
  if (f.reason !== undefined && record.reason !== f.reason) return false;
  if (f.model !== undefined && record.model !== f.model) return false;
  if (f.q !== undefined && !(typeof record.target === "string" && record.target.toLowerCase().includes(f.q.toLowerCase()))) return false;
  return true;
}
