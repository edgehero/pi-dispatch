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
// text module (asserted so by panel.test.mjs), and fmtCost is THE single renderer of typed cost values,
// so the what-if below routes every dollar through it rather than grow a second money formatter here.
import { fmtCost } from "./panel.mjs";

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

/**
 * Render the scoped limits (issue #242) as plain text: one line per configured row with used/cap per
 * capped window (`-` when the counter read failed) and the config-only concurrency ceiling -- per-scope
 * in-flight is worker-process state, so no live count is ever invented here. Degrades in place on a
 * missing (no lines) or invalid (one error line) file, like renderTriggers.
 */
/**
 * The held-jobs block for the NO-COLOR / non-TTY path (issue #230). Returns null when nothing is held, so
 * the caller adds no empty section.
 *
 * It has to exist for `renderRunList`'s stated reason: this is the renderer a non-TTY panel uses, and "a
 * job is being held, and for how long" must not be a fact only the pretty one tells. Every cell is the same
 * host-chosen, PII-free set the framed row carries -- an id-only target, an operator-authored label, a
 * duration -- because both read the worker's own hashes rather than a delayed job's data.
 */
export function renderHeldJobs({ held } = {}) {
	if (!held) return null;
	if (held.unreachable) return `unreadable (${held.unreachable})`;
	const rows = Array.isArray(held.rows) ? held.rows : [];
	if (rows.length === 0) return null;
	const more = Number(held.more) || 0;
	const lines = rows.map((r) => `${r.target ?? r.jobId ?? "-"}  ${r.label ?? "-"}  waited ${plainDuration(r.waitedMs)}`);
	if (more > 0) lines.push(`... and ${more} more`);
	return lines.join("\n");
}

/** `?` rather than a fabricated zero when the worker recorded no hold clock. Mirrors the framed twin. */
function plainDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

export function renderScopedLimits({ limits, scopedBudget } = {}) {
  if (limits?.invalid) return `Scoped limits: file invalid (${limits.invalid})`;
  const list = Array.isArray(limits?.limits) ? limits.limits : [];
  if (list.length === 0) return null; // nothing configured: say nothing (the mutex needs no line)
  const lines = ["Scoped limits:"];
  list.forEach((l, i) => {
    const used = scopedBudget?.rows?.[i] ?? null;
    const bits = [];
    for (const key of ["day", "week", "month"]) {
      if (!Number.isInteger(l[key])) continue;
      const u = used && Number.isFinite(used[key]) ? used[key] : "-";
      bits.push(`${key} ${u}/${l[key]}`);
    }
    if (Number.isInteger(l.concurrent)) bits.push(`<=${l.concurrent} at once`);
    lines.push(`  ${l.scope}: ${bits.join(" · ")}`);
  });
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
  const flow = t?.flow ?? commandSlashLabel(t) ?? "-";
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
  // A trigger that puts operator standing text into every job's prompt says so. Same doctrine as the
  // badges above: a trigger that changes what the agent is told must never render like one that does not.
  const ins = t?.instructions === true ? "  [instructions]" : "";
  const res = t?.resume === true ? "  [resume]" : "";
  // A trigger that turns one delivery into N paid runs says so (REQ-REPLICA-RUNS). Same class of badge as
  // [resume]: not a preference an operator can skim past, but the field that multiplies the bill. Absent on
  // an unreplicated trigger, appended last, so every existing line is byte-identical.
  const rep = t?.replicas > 1 ? `  [x${t.replicas}]` : "";
  // A trigger that hands its job live vault credentials says so, and it is the badge with the strongest
  // claim to being here: [image] and [skills] change what the agent CAN DO, this changes what it can REACH.
  // The COUNT and the profile name, never the references -- the reference list is the map of the operator's
  // vault. Appended last, absent when unbound, so every existing line is byte-identical.
  const sec = t?.secrets > 0 ? `  [secrets ${t.secrets}${t.secretsProfile ? ` via ${t.secretsProfile}` : ""}]` : "";
  // The two sides of a one-shot's life (issue #231), on the close-capable kinds only -- they are the
  // only records that can carry the fields. [once] on an ARMED one-shot: like [x N] it changes what a
  // rule can spend, here narrowing it to a single future run, so it must not render like a standing
  // rule. [spent] on a disarmed one: the read model renders the RAW file on purpose ("why did nothing
  // fire" needs the spent row in front of the operator), and a spent rule rendering like an armed one
  // is the exact confusion that choice would otherwise buy. Mutually exclusive by construction -- the
  // worker only ever disarms a once rule -- and absent otherwise, so every existing line is
  // byte-identical.
  const shot = t?.disarmed ? "  [spent]" : t?.once === true ? "  [once]" : "";
  switch (t?.type) {
    case "cron":
      return `cron  ${t.id ?? "-"}  ${t.pattern ?? "-"} → ${t.folder ?? "-"}/${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}`;
    case "label":
      return `label  ${ruleClauses(t) || "(no selector)"} → ${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}`;
    case "comment":
      return `comment  "${t.phrase ?? "-"}" → ${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}`;
    case "pull_request": {
      const clauses = ruleClauses(t);
      const action = `action[${(t.action ?? []).join(",")}]`;
      // A close-only rule's `#<n>` narrowing renders exactly as the issue arm's does (issue #231): a
      // one-shot on PR #40 that renders like "every close" hides exactly what the operator armed.
      const num = Number.isInteger(t.number) ? ` #${t.number}` : "";
      return `pull_request  ${action}${num}${clauses ? ` ${clauses}` : ""} → ${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}${shot}`;
    }
    case "issue": {
      // pull_request's shape with `#<n>` in the clause slot (issue #231): this plain line and the colored
      // dashboard row must state the same facts -- renderRunList's rule, the monochrome surface must not
      // silently tell a different story than the colored one -- and an issue rule's only clause is the
      // item number it may be narrowed to.
      const action = `action[${(t.action ?? []).join(",")}]`;
      const num = Number.isInteger(t.number) ? ` #${t.number}` : "";
      return `issue  ${action}${num} → ${flow}${forge}${pkgs}${img}${skl}${ins}${res}${rep}${sec}${shot}`;
    }
    default:
      return "(unknown trigger)";
  }
}

/**
 * The `/name` display token for a command trigger (issue #189, `run.command`), or null when the entry
 * carries no command. It renders in the flow position: the shared parser makes flow and command mutually
 * exclusive, so the column never has to hold both, and the slash marks "dispatches a registered extension
 * command" apart from a flow at a glance. The NAME only (the first space-delimited token, pi's own
 * dispatch grammar) so the line stays skimmable, the [skills basename] doctrine restated; the args belong
 * in the detail view. Exported as the one vocabulary (issue #188): the list line here, the TUI's target
 * column and the drill-in header must not drift on what a command trigger is called.
 */
export function commandSlashLabel(t) {
  return typeof t?.command === "string" && t.command.trim() !== "" ? `/${t.command.trim().split(/\s+/)[0]}` : null;
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
