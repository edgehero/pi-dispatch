/**
 * The dollar windows as the operator sees them (issue #501, part 7): one row per ACTIVE window, the deployment's
 * first, then each repo or folder row of `scoped-limits.json`, then each model row, in file order. Pure: no
 * filesystem, no Valkey, no clock of its own. The panel and the tools read the counters and the records and hand
 * them in; this module only lines them up.
 *
 * Two sources, and each number says which one it came from, because they answer different questions:
 *   - the COUNTER (`counterMicros`) is the window's Valkey key, the one the worker reserves against. It holds what
 *     settled runs were charged PLUS what running jobs still hold, so it is "spent and held". It is fleet-wide and
 *     it is the truth the next job is admitted against. Read under the worker's own key functions (`dayKey`,
 *     `weekKey`, `monthKey` with the shared prefixes), so the two sides cannot disagree on which key is today's;
 *   - the RECORDS (`settledMicros`, the `basis` counts, `boundExceeded`) are the run records this panel can read,
 *     whose run started in the window. They say how each run settled. They are not the counter's other half: a
 *     retried job keeps only its last attempt's record, retention can drop a record, and another host's records
 *     are here only on a shared `PI_LOGS_DIR`. So `held` is never derived as counter minus settled.
 *
 * Attribution from a record is honest about what a record can name. A repo row's runs are the forge records whose
 * target is that repo. A folder row's are not attributable (a record names a local folder by its basename only),
 * and neither are a model row's (a record keeps each model's cost, but not which model windows the job reserved
 * in: an unrestricted job holds a cap in every model row, a listed one only in its listed models'): those rows
 * carry the counter and `records: null` with the reason, never a guess.
 *
 * Only numbers, fixed tokens, and the operator's own scope and model names leave this module. No task text, no
 * target beyond the repo name the operator already wrote in their own limits file.
 */

import { dayKey, monthKey, weekKey } from "@edgehero/pi-dispatch/budget";
import { isAbsolute } from "node:path";
import { DOLLAR_BASIS, DOLLAR_KEY_PREFIX, MODEL_BASIS } from "@edgehero/pi-dispatch/dollar-budget";
import { DOLLAR_ENV_NAMES, formatMicros, optionalUsdMicros } from "@edgehero/pi-dispatch/money";
import { dollarKeyPrefixFor, isModelScope, MODEL_SCOPE_PREFIX } from "@edgehero/pi-dispatch/scoped-limits";
import { repoOfTarget } from "./costs.mjs";

const WINDOWS = [
  { window: "day", keyOf: dayKey, setting: "dailyCostUsd", field: "dayUsd" },
  { window: "week", keyOf: weekKey, setting: "weeklyCostUsd", field: "weekUsd" },
  { window: "month", keyOf: monthKey, setting: "monthlyCostUsd", field: "monthUsd" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a row's records are not shown, as fixed sentences. */
export const UNATTRIBUTED = Object.freeze({
  folder: "a run record names a local folder by its basename only",
  model: "a run record does not say which model windows the job reserved in",
});

/**
 * The deployment's dollar window caps in micro-dollars, `{ day, week, month }` (each null when unset), from the
 * overlay and the env the admin can see, merged per key the worker's way: the overlay value wins, else a non-empty
 * env variable. A value that does not parse is null here and `invalid` names its key: the worker refuses it, and a
 * display that guessed a cap would be worse than one that says it could not read one.
 */
export function deploymentDollarCaps(overlay, env) {
  const caps = { day: null, week: null, month: null };
  const invalid = [];
  const merged = (setting) => {
    const own = overlay?.[setting];
    const fromEnv = env?.[DOLLAR_ENV_NAMES[setting]];
    return own !== undefined && own !== null ? own : typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null;
  };
  for (const w of WINDOWS) {
    try {
      caps[w.window] = optionalUsdMicros(merged(w.setting), w.setting);
    } catch {
      invalid.push(w.setting);
    }
  }
  // The per-job cap every job reserves (PR #550's review): what tells a window that still has room from one that
  // has room for no job. Null when unset or unreadable, and then the row is judged on its counter alone.
  let jobCapMicros = null;
  try {
    jobCapMicros = optionalUsdMicros(merged("maxCostUsd"), "maxCostUsd");
  } catch {
    // Not named in `invalid`: that line is about the windows shown, and the worker refuses a malformed cap anyway.
  }
  return { caps, jobCapMicros, invalid };
}

/**
 * Every active dollar window, in display order: the deployment's (day, week, month), then each scoped-limits row
 * that carries a dollar field, each with its own windows in the same order. `{ ledger, name, index, window,
 * capMicros, keyPrefix, key }`: `ledger` is `deployment`, `scope` or `model`, `name` the row's scope or the model's
 * `provider/model` (null for the deployment), `index` the row's index in the limits file (null for the deployment).
 * `limits` are normalized rows (the shared parser's output), whose dollar fields are canonical decimal strings.
 */
export function dollarWindowSpecs({ caps, limits, now = new Date() }) {
  const out = [];
  for (const w of WINDOWS) {
    const cap = caps?.[w.window];
    if (cap === null || cap === undefined) continue;
    out.push({ ledger: "deployment", name: null, index: null, window: w.window, capMicros: cap, keyPrefix: DOLLAR_KEY_PREFIX, key: w.keyOf(now, DOLLAR_KEY_PREFIX) });
  }
  (Array.isArray(limits) ? limits : []).forEach((row, index) => {
    if (!WINDOWS.some((w) => row?.[w.field] !== null && row?.[w.field] !== undefined)) return;
    const model = isModelScope(row.scope);
    const keyPrefix = dollarKeyPrefixFor(row);
    for (const w of WINDOWS) {
      let cap;
      try {
        cap = optionalUsdMicros(row[w.field], w.field);
      } catch {
        continue; // the shared parser already refused such a file; a hand-built row is skipped, never guessed
      }
      if (cap === null) continue;
      out.push({
        ledger: model ? "model" : "scope",
        name: model ? row.scope.slice(MODEL_SCOPE_PREFIX.length) : row.scope,
        index,
        window: w.window,
        capMicros: cap,
        keyPrefix,
        key: w.keyOf(now, keyPrefix),
      });
    }
  });
  return out;
}

/**
 * The earliest instant any of `specs` covers: the start of the oldest active window (a month starts before the week
 * and day in it; a week can start in the month before). The records scan begins here. Null when there is no spec.
 */
export function dollarWindowsSinceMs(specs, now = new Date()) {
  if (!Array.isArray(specs) || specs.length === 0) return null;
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const starts = {
    day,
    week: day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS,
    month: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  };
  return Math.min(...specs.map((s) => starts[s.window] ?? day));
}

/** Is `value` a non-negative safe integer (a micro-dollar amount or a count)? */
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Does this record belong to this window? Its run's START falls in the window (the window key the worker would
 * have reserved under, recomputed from `startedAt` with the same key function), it carries a `dollars` object, and
 * for a repo row its target is that repo. Null when the row cannot be attributed at all.
 */
function belongs(record, spec) {
  if (!record || typeof record !== "object" || !record.dollars || typeof record.dollars !== "object") return false;
  const at = Date.parse(record.startedAt ?? record.endedAt ?? "");
  if (!Number.isFinite(at)) return false;
  const keyOf = WINDOWS.find((w) => w.window === spec.window)?.keyOf;
  if (!keyOf || keyOf(new Date(at), spec.keyPrefix) !== spec.key) return false;
  if (spec.ledger === "scope") {
    if (record.kind === "local") return false;
    const repo = repoOfTarget(record.target);
    return typeof repo === "string" && repo.normalize("NFC") === String(spec.name).normalize("NFC");
  }
  return true;
}

/**
 * The records' side of one window: `{ runs, settledMicros, basis: { metered, floor, refunded, unreserved },
 * boundExceeded }`, or null with the reason (`UNATTRIBUTED`) for a row a record cannot be matched to. `settledMicros`
 * sums `dollars.settledMicros`; a malformed amount is skipped and counted in `malformed`, never read as 0.
 * `boundExceeded` sums the exit line's counter of settled calls that cost more than their bound, over the runs that
 * reported it. The bound assumes one token is at least one byte for every catalogued tokenizer; a non-zero count
 * anywhere is the evidence that reopens it, which is why the panel shows it at all.
 */
export function foldWindowRecords(records, spec) {
  if (spec.ledger === "model") return { records: null, unattributed: UNATTRIBUTED.model };
  if (spec.ledger === "scope" && typeof spec.name === "string" && isAbsolute(spec.name)) return { records: null, unattributed: UNATTRIBUTED.folder };
  const basis = Object.fromEntries(DOLLAR_BASIS.map((b) => [b, 0]));
  let runs = 0;
  let settledMicros = 0;
  let boundExceeded = 0;
  let malformed = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (!belongs(record, spec)) continue;
    runs++;
    const d = record.dollars;
    if (isCount(d.settledMicros)) settledMicros += d.settledMicros;
    else malformed++;
    if (Object.hasOwn(basis, d.basis)) basis[d.basis]++;
    const be = record.tokens?.boundExceeded;
    if (isCount(be)) boundExceeded += be;
  }
  return { records: { runs, settledMicros, basis, boundExceeded, malformed } };
}

/**
 * One row per spec: `{ ledger, name, window, capMicros, counterMicros, records, unattributed? }`. `counters` maps a
 * spec's `key` to its counter value (a number, or null when that read failed), or is `{ unreachable }` for a queue
 * that could not be read: then every `counterMicros` is null, never an invented 0. An absent key is an honest 0 (a
 * window nothing has reserved in yet), the posture `readScopedBudget` takes.
 */
export function dollarWindowRows({ specs, counters, records, jobCapMicros = null }) {
  const unreachable = counters && typeof counters === "object" && "unreachable" in counters;
  return (Array.isArray(specs) ? specs : []).map((spec) => {
    let counterMicros = null;
    if (!unreachable && counters && typeof counters === "object") {
      const raw = counters[spec.key];
      counterMicros = raw === undefined ? 0 : raw === null ? null : Number(raw);
      if (counterMicros !== null && !Number.isFinite(counterMicros)) counterMicros = null;
    }
    const fold = foldWindowRecords(records, spec);
    // FULL when the next job at the deployment's per-job cap would not fit (PR #550's review): a reservation adds the
    // whole cap, so `counter + cap > window` already refuses every such job while the counter is still below the
    // window. A trigger with a smaller `run.maxCostUsd` may still fit; the row says "full", not "refusing all".
    const full = counterMicros !== null && (counterMicros >= spec.capMicros || (isCount(jobCapMicros) && counterMicros + jobCapMicros > spec.capMicros));
    return { ledger: spec.ledger, name: spec.name, index: spec.index, window: spec.window, capMicros: spec.capMicros, counterMicros, full, ...fold };
  });
}

/**
 * The per-run dollars, newest first, for `dispatch_costs`: `{ jobId, startedAt, endedAt, flow, outcome, dollars,
 * boundExceeded }` for each record that carries a `dollars` object. `dollars` is rebuilt from its named fields, so
 * nothing else a hand-edited record holds rides along. At most `limit` rows; `more` counts the rest.
 */
export function runDollars(records, { limit = 50 } = {}) {
  const rows = [];
  for (const r of Array.isArray(records) ? records : []) {
    const d = r?.dollars;
    if (!d || typeof d !== "object") continue;
    rows.push({
      jobId: typeof r.jobId === "string" ? r.jobId : null,
      startedAt: typeof r.startedAt === "string" ? r.startedAt : null,
      endedAt: typeof r.endedAt === "string" ? r.endedAt : null,
      flow: typeof r.flow === "string" ? r.flow : null,
      outcome: typeof r.outcome === "string" ? r.outcome : null,
      dollars: {
        reservedMicros: isCount(d.reservedMicros) ? d.reservedMicros : null,
        settledMicros: isCount(d.settledMicros) ? d.settledMicros : null,
        basis: DOLLAR_BASIS.includes(d.basis) ? d.basis : null,
        modelBasis: MODEL_BASIS.includes(d.modelBasis) ? d.modelBasis : null,
      },
      boundExceeded: isCount(r.tokens?.boundExceeded) ? r.tokens.boundExceeded : null,
    });
  }
  rows.sort((a, b) => Date.parse(b.endedAt ?? b.startedAt ?? "") - Date.parse(a.endedAt ?? a.startedAt ?? "") || 0);
  return { runs: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/** `$1.20`, or `-` for a number that is not a micro-dollar amount. */
function usd(micros) {
  return isCount(micros) ? `$${formatMicros(micros)}` : "-";
}

/**
 * The dollar windows as plain text (the panel's narrow-terminal path), or null when there is none to show, so a
 * deployment without a dollar window renders exactly what it always did. The same facts as the framed rows.
 */
export function renderDollarWindows(dollars) {
  if (!dollars) return null;
  const out = [];
  if (dollars.unreachable) out.push(`  dollar windows unreadable (${dollars.unreachable})`);
  if (Array.isArray(dollars.invalid) && dollars.invalid.length > 0) out.push(`  not a dollar amount: ${dollars.invalid.join(", ")}`);
  for (const r of Array.isArray(dollars.rows) ? dollars.rows : []) {
    const name = r.ledger === "deployment" ? "deployment" : r.ledger === "model" ? `model:${r.name}` : r.name;
    let tail = "records n/a";
    if (r.records) {
      const counts = DOLLAR_BASIS.filter((k) => r.records.basis?.[k] > 0).map((k) => `${r.records.basis[k]} ${k}`);
      tail = `settled ${usd(r.records.settledMicros)} from ${r.records.runs} run${r.records.runs === 1 ? "" : "s"}${counts.length > 0 ? ` (${counts.join(", ")})` : ""}, boundExceeded ${r.records.boundExceeded}`;
    }
    out.push(`  ${String(r.window).padEnd(6)}${name}  spent+held ${usd(r.counterMicros)} of ${usd(r.capMicros)}${r.full ? " (full)" : ""}  ${tail}`);
  }
  return out.length > 0 ? out.join("\n") : null;
}
