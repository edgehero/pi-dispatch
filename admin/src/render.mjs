/**
 * Pure text renderers for the admin extension: a read-model record (or array) in, a display string out.
 * No I/O, no clock, no process.env -- every input is a value the caller already fetched, so these are
 * testable with plain fixtures.
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): a renderer only ever sees the PII-free
 * record fields (`target` is `repo#issue` / `local:<basename>` only), the ten settings keys, scheduler
 * keys, and flow labels. Raw `.log` bytes are untrusted, PII-bearing container output and NEVER reach a
 * renderer -- the logs overlay in index.ts is their only surface, so there is deliberately no code path
 * from here to a `.log` file (asserted by render.test.mjs).
 */

import { windowState } from "@edgehero/pi-dispatch/budget";
// Pure-to-pure, the same standing as the windowState import above: panel.mjs is the admin's other no-I/O
// text module (asserted so by panel.test.mjs), so borrowing its sparkline/fmtUsd/fmtCost adds no I/O
// surface here -- and fmtCost is THE single renderer of typed cost values, so the costs view below must
// route every dollar through it rather than grow a second money formatter in this file.
import { fmtCost, fmtUsd, sparkline } from "./panel.mjs";

const SETTINGS_KEYS = ["model", "provider", "maxTurns", "dailyCap", "weeklyCap", "monthlyCap", "maxTokens", "dailyTokenCap", "concurrency", "softHoldPct"];

// The three spend windows and the overlay cap key each reads. Order is day -> week -> month.
const BUDGET_WINDOWS = [
  { key: "day", label: "day", capKey: "dailyCap" },
  { key: "week", label: "week", capKey: "weeklyCap" },
  { key: "month", label: "month", capKey: "monthlyCap" },
];

const RUN_COLUMNS = [
  { key: "jobId", header: "JOB ID" },
  { key: "target", header: "TARGET" },
  { key: "flow", header: "FLOW" },
  { key: "outcome", header: "OUTCOME" },
  { key: "reason", header: "REASON" },
  { key: "turns", header: "TURNS" },
  // Per-job token accounting (issue #25). `tokens` is `{ input, output, total, cost }` | null; a derive
  // reaches into it so a null record still reads "-", and cost renders as a $-prefixed fixed-decimal.
  { key: "tokens", header: "TOKENS", derive: (r) => cell(r?.tokens?.total) },
  { key: "cost", header: "COST", derive: (r) => (typeof r?.tokens?.cost === "number" ? `$${r.tokens.cost.toFixed(4)}` : "-") },
  // Derived: a `d<n>` chain-depth marker for an outbox-chained child, "-" for a root run. A custom
  // derive is needed because `cell()` would render depth 0 as "0"; here depth 0/null/absent all read "-".
  { key: "chain", header: "CHAIN", derive: (r) => (r?.chainDepth > 0 ? `d${r.chainDepth}` : "-") },
  // Derived like CHAIN, and for the same reason: an unreplicated run must read "-" rather than "0". The
  // set size is shown alongside the index because `r2` alone does not say whether the sibling exists --
  // `r2/2` is what makes the pair legible in a list where the two rows need not be adjacent.
  { key: "replica", header: "REPLICA", derive: (r) => (r?.replica > 0 ? `r${r.replica}/${r?.replicas ?? "?"}` : "-") },
  { key: "endedAt", header: "ENDED" },
];

/** A nullish record field renders as "-" so a stable record shape reads cleanly. */
function cell(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

/** Render the queue slice of `status`: paused state, the five job counts, and the worker count. */
export function renderStatus(queue) {
  if (!queue || queue.unreachable) {
    return `Queue: unreachable (${queue?.unreachable ?? "unknown"})`;
  }
  const counts = queue.counts ?? {};
  const line = ["waiting", "active", "paused", "delayed", "failed"]
    .map((k) => `${k} ${counts[k] ?? 0}`)
    .join("  ");
  const workers = queue.workers === undefined ? "unknown" : queue.workers;
  return [`Queue: ${queue.pausedState ? "paused" : "running"}`, `  ${line}`, `  workers: ${workers}`].join("\n");
}

/** Render the run history as aligned columns; a null field is "-", an unreachable/empty set degrades. */
export function renderRuns(runs) {
  if (runs && runs.unreachable) return `Runs: unreachable (${runs.unreachable})`;
  const list = Array.isArray(runs) ? runs : [];
  if (list.length === 0) return "No runs recorded.";

  const headers = RUN_COLUMNS.map((c) => c.header);
  const rows = list.map((r) => RUN_COLUMNS.map((c) => (c.derive ? c.derive(r) : cell(r?.[c.key]))));
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmt = (cells) => cells.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

/**
 * Render the budget across the day/week/month windows, each `reserved / cap [state]`. A cap is only known
 * to the admin when the overlay sets it; otherwise the worker resolves it from its own env/default, which
 * this process cannot read authoritatively, so it renders as unknown rather than a guessed number. The
 * per-window state ("soft-hold" / "over") is computed via the worker's own `windowState` -- the same
 * classifier `reserveBudget` uses -- so the panel and the enforcement cannot drift.
 *
 * The day line always shows (parity with the single-window view). Week/month lines show only when they are
 * actually in play -- the overlay sets their cap, or the window has a non-zero reserved count (an
 * env-configured window the admin can see reserving but whose cap it cannot read). The soft-hold line shows
 * only when the overlay sets `softHoldPct`.
 */
export function renderBudget({ budget, settings } = {}) {
  if (!budget || budget.unreachable) {
    return `Budget: unreachable (${budget?.unreachable ?? "unknown"})`;
  }
  const overlay = (settings && settings.overlay) ?? {};
  const pct = Number.isInteger(overlay.softHoldPct) ? overlay.softHoldPct : null;
  const lines = ["Budget:"];
  for (const w of BUDGET_WINDOWS) {
    const reserved = Number(budget[w.key] ?? 0);
    const cap = overlay[w.capKey];
    if (w.key !== "day" && !Number.isInteger(cap) && reserved === 0) continue; // window not in play
    lines.push(`  ${w.label}: reserved ${reserved} / cap ${capLabel(cap, reserved, pct)}`);
  }
  if (pct !== null) lines.push(`  soft-hold band: ${pct}%`);
  return lines.join("\n");
}

/** One window's cap + state suffix: the overlay cap and its classified state, or the unknown-cap notice. */
function capLabel(cap, reserved, pct) {
  if (!Number.isInteger(cap)) return "unknown (worker env/default)";
  const state = windowState(reserved, cap, pct);
  return state === "ok" ? `${cap} (overlay)` : `${cap} (overlay) [${state}]`;
}

/**
 * Render just the schedulers block: a header and one line per resident scheduler with its next fire time
 * and next-drift. `overdueMs` surfaces the silent under-firing BullMQ's no-overlap scheduler can hide
 * (design.md:249). An unreachable read or an empty set degrades in place rather than throwing.
 */
export function renderSchedulers(schedulers) {
  const out = ["Schedulers:"];
  if (schedulers && schedulers.unreachable) {
    out.push(`  unreachable (${schedulers.unreachable})`);
  } else {
    const list = Array.isArray(schedulers) ? schedulers : [];
    if (list.length === 0) out.push("  (none configured)");
    else for (const s of list) out.push(`  ${schedulerLine(s)}`);
  }
  return out.join("\n");
}

/**
 * Render triggers display-only (OQ-008): the schedulers block, then the committed unified `triggers.json`
 * as a discriminated list -- cron, label, comment, and pull_request entries each on their own line.
 */
export function renderTriggers({ schedulers, triggers } = {}) {
  const out = [renderSchedulers(schedulers), "", "Triggers:"];
  if (triggers && triggers.missing) {
    out.push("  (triggers file not found)");
  } else if (triggers && triggers.invalid) {
    out.push(`  (triggers file invalid: ${triggers.invalid})`);
  } else {
    const list = (triggers && triggers.triggers) ?? [];
    if (list.length === 0) out.push("  (no triggers)");
    else for (const t of list) out.push(`  ${triggerLine(t)}`);
  }
  return out.join("\n");
}

/**
 * One trigger's display line, discriminated on `type`. A null field reads as "-".
 *
 * A webhook trigger listening to a forge other than github names it. GitHub is unmarked, so an existing
 * deployment's lines are byte-identical -- but the marker is not cosmetic: two rules can select the same
 * label on two forges, and which one a line describes is otherwise unreadable.
 *
 * A trigger that loads the operator-staged third-party pi packages carries a trailing `[packages]` marker:
 * it must never read the same as one that does not. Loading is the DEFAULT (`run.packages` is an opt-out),
 * so the marker is the common case once the operator has staged anything, and its absence means the trigger
 * carries an explicit `run.packages: false`. Lines without it are byte-identical to before -- the marker is
 * purely additive.
 *
 * A trigger running a non-default image carries its tag too, for a sharper reason than packages: which image
 * a job runs IS which code it runs. A trigger on the deployment default renders byte-identically -- the
 * suffix is empty and appended last.
 */
function triggerLine(t) {
  const flow = t?.flow ?? "-";
  const forge = t?.forge && t.forge !== "github" ? `  [${t.forge}]` : "";
  const pkgs = t?.packages === true ? "  [packages]" : "";
  const img = t?.image ? `  [image ${t.image}]` : "";
  // A trigger that PERSISTS the agent's working history to disk says so. Without this badge it renders
  // identically to one that does not, which is the defect 0.1.4 fixed for [packages] arriving in a new
  // field -- and a transcript is a bigger disclosure than staged packages are.
  // A trigger whose jobs load operator-authored skills from the host says which directory (issue #60).
  // Same doctrine as [resume] and [image]: it must never render the same as one that does not, because
  // choosing the skills IS choosing what the agent can do. The BASENAME only, so the line stays skimmable;
  // the full path lives in the trigger detail view, where the panel is the operator's own session on their
  // own host and a path discloses nothing new.
  const skl = t?.skillsDir ? `  [skills ${String(t.skillsDir).split(/[\\/]/).filter(Boolean).pop()}]` : "";
  const res = t?.resume === true ? "  [resume]" : "";
  // A trigger that turns one delivery into N paid runs says so (REQ-REPLICA-RUNS). Same class of badge as
  // [resume]: not a preference an operator can skim past, but the field that multiplies the bill. Absent on
  // an unreplicated trigger, appended last, so every existing line is byte-identical.
  const rep = t?.replicas > 1 ? `  [x${t.replicas}]` : "";
  switch (t?.type) {
    case "cron":
      return `cron  ${t.id ?? "-"}  ${t.pattern ?? "-"} → ${t.folder ?? "-"}/${flow}${forge}${pkgs}${img}${skl}${res}${rep}`;
    case "label":
      return `label  ${ruleClauses(t) || "(no selector)"} → ${flow}${forge}${pkgs}${img}${skl}${res}${rep}`;
    case "comment":
      return `comment  "${t.phrase ?? "-"}" → ${flow}${forge}${pkgs}${img}${skl}${res}${rep}`;
    case "pull_request": {
      const clauses = ruleClauses(t);
      const action = `action[${(t.action ?? []).join(",")}]`;
      return `pull_request  ${action}${clauses ? ` ${clauses}` : ""} → ${flow}${forge}${pkgs}${img}${skl}${res}${rep}`;
    }
    default:
      return "(unknown trigger)";
  }
}

function ruleClauses(rule) {
  const clauses = [];
  for (const key of ["any", "all", "none"]) {
    const members = rule?.[key] ?? [];
    if (members.length > 0) clauses.push(`${key}[${members.join(",")}]`);
  }
  return clauses.join(" ");
}

function schedulerLine(s) {
  const id = s?.key ?? s?.name ?? "-";
  const next = typeof s?.next === "number" ? new Date(s.next).toISOString() : "no next";
  const drift =
    typeof s?.overdueMs === "number" && s.overdueMs > 0 ? `  overdue by ${Math.round(s.overdueMs / 1000)}s` : "";
  return `${id}  next ${next}${drift}`;
}

// ---- the costs view (issue #53) ----

// Human labels for the three windows `/dispatch costs` offers. An unknown key falls through verbatim so a
// future window renders as itself rather than as a wrong claim about its span.
const COSTS_WINDOW_LABELS = { "7d": "last 7 days", "30d": "last 30 days", mtd: "month to date" };

/**
 * Render the costs fold (costs.mjs `foldCosts`) as the plain-text `/dispatch costs` view, mirroring the
 * dashboard's section order: header with the window total, per-plan verdict lines, the daily sparkline,
 * the by-flow and by-model tables, the plans block, and the provenance footer. Every dollar goes through
 * the panel's `fmtCost` -- the single renderer of typed cost values -- so a bare money number cannot
 * appear here: a plan-covered row reads `plan:<id>` and never `$0.00`, a zero-rated one reads
 * `$0 (unrated)`, and the word "free" appears nowhere because the fold has no class that could claim it.
 *
 * The plans block reports per-window peak FACTS only -- what was observed, never remaining/burn-down --
 * and a `null` window limit reads `limit undisclosed by vendor`, first-class per the subscriptions schema.
 */
export function renderCosts(fold, { window } = {}) {
  const label = COSTS_WINDOW_LABELS[window] ?? window ?? `${fold?.window?.days ?? 0}d`;
  const prov = fold?.provenance ?? {};
  const plans = Array.isArray(fold?.plans) ? fold.plans : [];
  const runsTotal = prov.runsTotal ?? 0;

  const out = [runsTotal > 0 ? `Costs (${label}): ${fmtCost(prov.total)} · ${runsTotal} runs` : `Costs (${label}):`];
  // Verdicts up top: the one line per plan an operator opened this view for. A run-less window still
  // shows them (every verdict is then NO_BASELINE -- nothing was attributed).
  for (const p of plans) out.push(`  ${planVerdictLine(p)}`);
  if (runsTotal === 0) {
    out.push("No runs in window.");
    return out.join("\n");
  }

  const daily = Array.isArray(fold.daily) ? fold.daily : [];
  if (daily.length > 0) {
    out.push("", `Daily: ${sparkline(daily.map((d) => d?.cost?.usd), 30)}  (${daily[0].day} → ${daily[daily.length - 1].day})`);
  }

  const byFlow = Array.isArray(fold.byFlow) ? fold.byFlow : [];
  if (byFlow.length > 0) {
    out.push("", "By flow:");
    const rows = byFlow.map((f) => [cell(f.flow), cell(f.runs), cell(f.tokens), fmtCost(f.cost), fmtCost(f.apiEquiv)]);
    for (const line of tableLines(["FLOW", "RUNS", "TOKENS", "COST", "API-EQUIV"], rows)) out.push(`  ${line}`);
  }

  // The model grain is where the class system pays off: a uniform plan/zero-rated bucket KEEPS its class
  // (costs.mjs combineRowCosts), so this is the one table where `plan:<id>` and `$0 (unrated)` render.
  const byModel = Array.isArray(fold.byModel) ? fold.byModel : [];
  if (byModel.length > 0) {
    out.push("", "By model:");
    const rows = byModel.map((m) => [`${m.provider}/${m.model}`, cell(m.runs), cell(m.tokens), fmtCost(m.cost)]);
    for (const line of tableLines(["MODEL", "RUNS", "TOKENS", "COST"], rows)) out.push(`  ${line}`);
  }

  if (plans.length > 0) {
    out.push("", "Plans:");
    for (const p of plans) {
      const name = p.hypothetical ? `${p.id} (hypothetical)` : p.id;
      out.push(`  ${name} — ${p.vendor}, ${fmtUsd(p.price?.amount)}/${p.price?.per ?? "month"}`);
      const amortized = p.amortizedPerRun ? `${fmtCost(p.amortizedPerRun)}/run amortized` : "amortized —";
      out.push(`    runs ${p.attributedRuns} · tokens ${p.attributedTokens} · ${amortized} · API-equiv ${fmtCost(p.apiEquiv)}`);
      for (const w of p.windows ?? []) out.push(`    peak ${windowFacts(w)}`);
    }
  }

  out.push(
    "",
    `~ marks estimates · metered = pi-ai computed prices, not invoices · pi-ai ${prov.piAiPin ?? "unknown"}`,
    provenanceCounts(prov),
  );
  return out.join("\n");
}

/** One plan's verdict line. NO_BASELINE spells out the fix rather than showing an invented number. */
function planVerdictLine(p) {
  const name = p?.hypothetical ? `${p?.id} (hypothetical)` : p?.id;
  const v = p?.verdict ?? {};
  switch (v.kind) {
    case "SAVING":
      return `${name}: SAVING ${fmtCost(v.usd)} vs API rates`;
    case "LOSING":
      return `${name}: LOSING ${fmtCost(v.usd)} vs API rates`;
    case "WOULD_SAVE":
      return `${name}: WOULD_SAVE ${fmtCost(v.usd)} if bought`;
    case "WOULD_LOSE":
      return `${name}: WOULD_LOSE ${fmtCost(v.usd)} if bought`;
    default:
      // NO_BASELINE (and, fail-soft, anything malformed): no counterfactual, so no number to show.
      return `${name}: no API-rate baseline declared — set counterfactualModel to compare`;
  }
}

/** One declared window's observed peak, FACTS only: runs/tokens seen, and the limit verbatim. */
function windowFacts(w) {
  const shape = `${w.per}${w.rolling ? " rolling" : ""}`;
  const unit = w.unit ? ` ${w.unit}` : "";
  const limit =
    w.limit === null || w.limit === undefined
      ? "limit undisclosed by vendor"
      : Array.isArray(w.limit)
        ? `limit ${w.limit[0]}–${w.limit[1]}${unit}`
        : `limit ${w.limit}${unit}`;
  return `${shape}: ${w.peakRuns} runs · ${w.peakTokens} tokens · ${limit}`;
}

/** The honesty counts beside the numbers: how much of the window was measured and re-priceable. */
function provenanceCounts(prov) {
  const parts = [`unmetered ${prov.runsUnmetered ?? 0}`, `no ledger (not re-priceable) ${prov.runsUnledgered ?? 0}`];
  if ((prov.ratesDrifted ?? 0) > 0) parts.push(`rates drifted ${prov.ratesDrifted}`);
  return parts.join(" · ");
}

/**
 * Render one `whatIfFlow` estimate (costs.mjs) as a compact block. The measured path shows the estimate
 * through `fmtCost` with its coverage/excluded honesty and the rates version; the zero-knowledge path
 * shows the seeded band verbatim -- both bounds through `fmtCost`'s seeded shape, plus the fold's own
 * note -- so an unmeasured flow can never read like a measurement.
 */
export function renderWhatIf(result, { flow, target } = {}) {
  const head = `What-if ${flow} @ ${target}:`;
  if (!result || typeof result !== "object") return `${head}\n  no estimate`;
  if (result.class === "seeded") {
    return [
      head,
      `  no ledgered run to measure from — seeded band ${fmtCost({ usd: result.low, class: "seeded" })} to ${fmtCost({ usd: result.high, class: "seeded" })} · ${result.note}`,
    ].join("\n");
  }
  const pct = Math.round((result.coverage ?? 0) * 100);
  return [
    head,
    `  estimate ${fmtCost({ usd: result.usd, class: "estimated" })} total · ${fmtCost({ usd: result.perRun, class: "estimated" })} per run`,
    `  coverage ${pct}% of observed runs ledgered · excluded ${result.excluded} (no ledger)`,
    `  rates pi-ai ${result.ratesVersion ?? "unknown"}`,
  ].join("\n");
}

/** Aligned columns with two-space gaps (the renderRuns convention), trailing space trimmed per row. */
function tableLines(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const fmt = (cells) => cells.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)];
}

/** Render the settings overlay view: every overlay key, unset ones marked, or the fail-closed invalid reason. */
export function renderSettingsView(settings) {
  const path = settings?.path ?? "(unknown path)";
  if (settings && settings.invalid) return `Settings (${path}): invalid: ${settings.invalid}`;
  const overlay = (settings && settings.overlay) ?? {};
  const out = [`Settings (${path}):`];
  for (const key of SETTINGS_KEYS) {
    const v = overlay[key];
    out.push(`  ${key}: ${v === undefined ? "(unset)" : v}`);
  }
  return out.join("\n");
}
