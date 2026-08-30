/**
 * The insights page (issue #175): ONE self-contained file:// document that unifies the trigger/flow
 * topology (the graph.html scene, embedded whole) with a cost-analytics half rendered as hand-rolled
 * inline SVG charts. Same doctrines as the sibling artifact: one document, inline CSS + SVG + one
 * script element, zero external references, byte-deterministic (total sorts, injected `now`, no clock
 * reads and no randomness), allowlist normalization (never a spread), and every string escaped on its
 * way into markup or the embedded JSON.
 *
 * Dependency posture: exactly two imports, both pure. graph-html.mjs is the scene/escaping/theme
 * source of truth (buildGraphScene lays out the topology; PAGE_JS owns pan/zoom/tooltip/selection;
 * PAGE_THEME is the palette), and panel.mjs is THE money renderer -- fmtCost/fmtUsd are the only
 * functions allowed to turn a dollar into text, because the typed-cost class system is what keeps an
 * estimate structurally distinguishable behind every figure on this page. costs.mjs is deliberately
 * NOT loaded: it reaches into the worker for its day bucketing, and one worker coupling would drag
 * the queue stack into an artifact builder. Its class list is duplicated below and pinned
 * byte-for-byte by a parity test in insights-html.test.mjs.
 *
 * Chart encoding rule the file:// posture forces: "estimated" is drawn with fill-opacity plus a
 * dashed outline, never an SVG hatch pattern -- a pattern fill would need a paint-server reference,
 * and the posture test bans that whole reference syntax as a substring.
 */

import { buildGraphScene, escapeHtml, embedJson, fmt, PAGE_JS, legendHtml, bannersHtml, PAGE_THEME } from "./graph-html.mjs";
import { fmtCost, fmtUsd } from "./panel.mjs";

// Must equal costs.mjs's COST_CLASSES; the parity test compares the two literals. Duplicated rather
// than re-exported because loading costs.mjs is exactly the worker coupling this module refuses.
export const INSIGHTS_COST_CLASSES = Object.freeze(["metered", "plan", "zero-rated", "estimated", "seeded", "unknown"]);

// The verdict vocabulary buildPlans emits; anything else degrades to NO_BASELINE, which renders a
// sentence and never a number -- the safe direction for a malformed verdict to fail in.
const VERDICT_KINDS = Object.freeze(["SAVING", "LOSING", "WOULD_SAVE", "WOULD_LOSE", "NO_BASELINE"]);

// The fold pins its honesty buckets to the table's tail whatever the dollars say (a bucket named
// "(unattributed)" sorting above real triggers would read as the biggest spender when it is really
// the biggest unknown); re-sorting here must preserve that or a permuted payload changes the story.
const TRIGGER_TAIL = Object.freeze(["chained", "manual", "unattributed"]);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- chart geometry (values, not CSS: the layout helpers are exported and tested as numbers) ----
const DAILY_W = 920;
const DAILY_H = 160;
const DAILY_ML = 46; // room for fmtUsd axis labels
const DAILY_MR = 10;
const DAILY_MT = 16; // room for the floor marker above a full-height bar
const DAILY_MB = 20; // room for the MM-DD tick labels
const DAILY_BAR_MAX = 26;
const LIST_W = 430;
const LIST_ROW_H = 22;
const LIST_LABEL_W = 150;
const LIST_VALUE_W = 110;
const LIST_TOP = 8; // rows per breakdown list before the "(+K more)" tail takes over
// The per-flow small multiples (issue #181): half the daily chart's width so two panels share a row,
// a short panel (two gridlines, not four -- four in 96px is noise), and the top-N cut before the
// aggregate tail line takes over. One panel per flow because series identity must be carried by
// TEXT (the panel title): the palette has one non-reserved data hue, and dashes already mean
// "estimated", so N overlaid lines could only be told apart by a channel this page refuses to load.
const FLOW_W = 452;
const FLOW_H = 96;
const FLOW_ML = 46;
const FLOW_MR = 8;
const FLOW_MT = 12;
const FLOW_MB = 16;
const LINES_TOP = 4;
// The cumulative mini-chart under the daily columns: its OWN plot with its OWN scale -- a running
// total dwarfs daily bars, and a second y-axis on one plot is the classic dual-axis lie.
const CUM_H = 84;
// Budget meter geometry: the panel `meter` idiom in SVG -- a fixed track the fill clamps inside
// (overflow is carried by the state WORD, never by geometry past the track).
const METER_W = 220;

// The states the worker's own windowState emits; junk degrades to "ok" -- toward SILENCE, the
// NO_BASELINE direction: a malformed payload may hide an alarm but can never invent one.
const BUDGET_STATES = Object.freeze(["ok", "soft-hold", "over"]);

function finOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function intOr(v, fallback) {
  return Number.isInteger(v) ? v : fallback;
}

function posInt(v) {
  return Number.isInteger(v) && v > 0 ? v : 0;
}

function strOr(v, fallback) {
  return typeof v === "string" && v !== "" ? v : fallback;
}

function clip(s, max) {
  const t = String(s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The typed-cost allowlist: usd finite-or-0, class from the known list else "unknown", floor only on
 * an exact true, coverage clamped into 0..1 or null, planId clipped or null. Nullish input stays null
 * so fmtCost renders the em dash -- inventing a zero here would be the exact mislabeling the class
 * system exists to prevent.
 */
function normCost(v) {
  if (v === null || v === undefined || typeof v !== "object") return null;
  return {
    usd: finOr(v.usd, 0),
    class: INSIGHTS_COST_CLASSES.includes(v.class) ? v.class : "unknown",
    floor: v.floor === true,
    coverage: Number.isFinite(v.coverage) ? Math.min(1, Math.max(0, v.coverage)) : null,
    planId: typeof v.planId === "string" ? clip(v.planId, 40) : null,
  };
}

function unknownCost() {
  return { usd: 0, class: "unknown", floor: false, coverage: null, planId: null };
}

/** `limit` verbatim shapes only: null (vendor undisclosed, first-class), a finite number, or a
 * finite [low, high] pair. Anything else collapses to null, the honest "we do not know" shape. */
function normLimit(v) {
  if (Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])) return [v[0], v[1]];
  return null;
}

function normVerdict(v) {
  const kind = v !== null && v !== undefined && typeof v === "object" && VERDICT_KINDS.includes(v.kind) ? v.kind : "NO_BASELINE";
  // NO_BASELINE never carries a number, even when a malformed payload smuggles one in: the whole
  // point of the kind is that no comparable figure exists.
  return { kind, usd: kind === "NO_BASELINE" ? null : normCost(v.usd) };
}

/** Daily entries: the day string must be a bare UTC date or the entry is dropped whole -- a day
 * label is an axis coordinate here, and a non-date coordinate has nowhere truthful to draw. */
function normDailyEntries(daily) {
  const out = [];
  for (const d of Array.isArray(daily) ? daily : []) {
    if (d === null || typeof d !== "object" || typeof d.day !== "string" || !DAY_RE.test(d.day)) continue;
    out.push({ day: d.day, cost: normCost(d.cost) ?? unknownCost(), runs: posInt(d.runs) });
  }
  // Total sort (day, then the tie fields) so a permuted payload cannot move a byte of the chart.
  out.sort((a, b) => cmpStr(a.day, b.day) || a.runs - b.runs || a.cost.usd - b.cost.usd);
  return out;
}

/**
 * The fold allowlist, mirroring normalizeModel's approach: explicit fields, clipped strings, and a
 * total re-sort of every array with the fold's OWN comparators -- "top 8 by the fold's order" must
 * survive a shuffled payload, so the order is re-derived here rather than trusted.
 */
function normFold(fold) {
  if (fold === null || fold === undefined || typeof fold !== "object") return null;
  const win = fold.window !== null && typeof fold.window === "object" ? fold.window : {};
  const window = {
    fromMs: finOr(win.fromMs, null),
    toMs: finOr(win.toMs, null),
    days: posInt(win.days),
    firstRunMs: finOr(win.firstRunMs, null),
  };

  const byFlow = [];
  for (const r of Array.isArray(fold.byFlow) ? fold.byFlow : []) {
    if (r === null || typeof r !== "object") continue;
    byFlow.push({
      flow: clip(strOr(r.flow, "(no flow)"), 60),
      flowKey: typeof r.flowKey === "string" ? clip(r.flowKey, 60) : null,
      runs: posInt(r.runs),
      tokens: posInt(r.tokens),
      cost: normCost(r.cost) ?? unknownCost(),
      apiEquiv: normCost(r.apiEquiv),
    });
  }
  byFlow.sort((a, b) => b.cost.usd - a.cost.usd || cmpStr(a.flow, b.flow));

  const byModel = [];
  for (const r of Array.isArray(fold.byModel) ? fold.byModel : []) {
    if (r === null || typeof r !== "object") continue;
    byModel.push({
      provider: clip(strOr(r.provider, "?"), 40),
      model: clip(strOr(r.model, "?"), 40),
      runs: posInt(r.runs),
      tokens: posInt(r.tokens),
      cost: normCost(r.cost) ?? unknownCost(),
    });
  }
  byModel.sort((a, b) => b.cost.usd - a.cost.usd || cmpStr(a.provider, b.provider) || cmpStr(a.model, b.model));

  // null stays null: "not computed" and "nothing attributed" are different sentences, and the
  // breakdown panel says which one it is.
  let byTrigger = null;
  if (Array.isArray(fold.byTrigger)) {
    byTrigger = [];
    for (const r of fold.byTrigger) {
      if (r === null || typeof r !== "object") continue;
      const o = r.outcomes !== null && r.outcomes !== undefined && typeof r.outcomes === "object" ? r.outcomes : {};
      byTrigger.push({
        key: clip(strOr(r.key, "?"), 40),
        index: intOr(r.index, null),
        type: typeof r.type === "string" ? clip(r.type, 20) : null,
        label: clip(strOr(r.label, "(trigger)"), 60),
        runs: posInt(r.runs),
        tokens: posInt(r.tokens),
        cost: normCost(r.cost) ?? unknownCost(),
        outcomes: { completed: posInt(o.completed), policy: posInt(o.policy), failed: posInt(o.failed) },
        failedCost: normCost(r.failedCost),
      });
    }
    byTrigger.sort((a, b) => {
      const ta = TRIGGER_TAIL.indexOf(a.key);
      const tb = TRIGGER_TAIL.indexOf(b.key);
      if (ta !== -1 || tb !== -1) return ta === -1 ? -1 : tb === -1 ? 1 : ta - tb;
      return b.cost.usd - a.cost.usd || cmpStr(a.label, b.label) || cmpStr(a.key, b.key);
    });
  }

  const byRepo = [];
  for (const r of Array.isArray(fold.byRepo) ? fold.byRepo : []) {
    if (r === null || typeof r !== "object") continue;
    byRepo.push({
      key: typeof r.key === "string" ? clip(r.key, 60) : null,
      label: clip(strOr(r.label, "(no target)"), 60),
      kind: typeof r.kind === "string" ? clip(r.kind, 20) : null,
      runs: posInt(r.runs),
      tokens: posInt(r.tokens),
      cost: normCost(r.cost) ?? unknownCost(),
    });
  }
  byRepo.sort((a, b) => b.cost.usd - a.cost.usd || cmpStr(a.label, b.label) || cmpStr(a.key ?? "", b.key ?? ""));

  const plans = [];
  for (const r of Array.isArray(fold.plans) ? fold.plans : []) {
    if (r === null || typeof r !== "object") continue;
    const price = r.price !== null && r.price !== undefined && typeof r.price === "object" ? r.price : {};
    plans.push({
      id: clip(strOr(r.id, "?"), 40),
      vendor: clip(strOr(r.vendor, "?"), 60),
      hypothetical: r.hypothetical === true,
      price: { amount: finOr(price.amount, 0), per: clip(strOr(price.per, "month"), 10) },
      attributedRuns: posInt(r.attributedRuns),
      attributedTokens: posInt(r.attributedTokens),
      amortizedPerRun: normCost(r.amortizedPerRun),
      apiEquiv: normCost(r.apiEquiv),
      verdict: normVerdict(r.verdict),
      windows: (Array.isArray(r.windows) ? r.windows : [])
        .flatMap((w) => (w !== null && typeof w === "object"
          ? [{
              per: clip(strOr(w.per, "?"), 10),
              rolling: w.rolling === true,
              unit: clip(strOr(w.unit, "units"), 20),
              limit: normLimit(w.limit),
              peakRuns: posInt(w.peakRuns),
              peakTokens: posInt(w.peakTokens),
            }]
          : []))
        .sort((a, b) => cmpStr(a.per, b.per) || (a.rolling ? 1 : 0) - (b.rolling ? 1 : 0) || cmpStr(a.unit, b.unit)),
    });
  }
  // Owned plans first (a bill that exists outranks a thought experiment), id order within each band.
  plans.sort((a, b) => (a.hypothetical ? 1 : 0) - (b.hypothetical ? 1 : 0) || cmpStr(a.id, b.id));

  const prov = fold.provenance !== null && fold.provenance !== undefined && typeof fold.provenance === "object" ? fold.provenance : {};
  const provenance = {
    total: normCost(prov.total),
    runsTotal: posInt(prov.runsTotal),
    runsUnmetered: posInt(prov.runsUnmetered),
    runsUnledgered: posInt(prov.runsUnledgered),
    runsLedgerTruncated: posInt(prov.runsLedgerTruncated),
    ratesDrifted: posInt(prov.ratesDrifted),
    piAiPin: typeof prov.piAiPin === "string" ? clip(prov.piAiPin, 20) : null,
  };

  return {
    window,
    daily: normDailyEntries(fold.daily),
    // null when the fold predates the series (absence, never an empty grid that looks exhaustive).
    dailyByFlow: Array.isArray(fold.dailyByFlow) ? normFlowSeries(fold.dailyByFlow) : null,
    byFlow,
    byModel,
    byTrigger,
    byRepo,
    plans,
    provenance,
  };
}

/** The per-flow daily series rows, allowlisted like every fold arm: label clipped, machine key kept
 * beside it, days through the same normDailyEntries the global series uses (day-regex drop, total
 * sort), rows re-sorted by window total so "top N flows" survives a permuted payload byte-identically. */
function normFlowSeries(v) {
  const rows = [];
  for (const r of Array.isArray(v) ? v : []) {
    if (r === null || typeof r !== "object") continue;
    rows.push({
      flow: clip(strOr(r.flow, "(no flow)"), 60),
      flowKey: typeof r.flowKey === "string" ? clip(r.flowKey, 60) : null,
      days: normDailyEntries(r.days),
    });
  }
  rows.sort((a, b) => {
    const sum = (x) => x.days.reduce((s, d) => s + d.cost.usd, 0);
    return sum(b) - sum(a) || cmpStr(a.flow, b.flow);
  });
  return rows;
}

/** One budget window's allowlist: reserved a non-negative integer or null (never an invented zero --
 * an unreachable queue rides as null), cap a positive integer or null (an overlay-unset cap is
 * UNKNOWN, the no-invented-denominator rule), state one of the worker's own words else "ok". */
function normBudgetWindow(v) {
  const o = v !== null && v !== undefined && typeof v === "object" ? v : {};
  return {
    reserved: Number.isInteger(o.reserved) && o.reserved >= 0 ? o.reserved : null,
    cap: Number.isInteger(o.cap) && o.cap > 0 ? o.cap : null,
    state: BUDGET_STATES.includes(o.state) ? o.state : "ok",
  };
}

/** The budget slice's allowlist. Null payload -> null section ("no budget data in this payload"),
 * the stated-absence idiom every other missing slice uses. States arrive as WORDS the assembler
 * computed with the worker's own classifier; this page never re-derives a threshold. */
function normBudget(v) {
  if (v === null || v === undefined || typeof v !== "object") return null;
  const t = v.tokens !== null && v.tokens !== undefined && typeof v.tokens === "object" ? v.tokens : {};
  return {
    unreachable: typeof v.unreachable === "string" && v.unreachable !== "" ? clip(v.unreachable, 160) : null,
    softHoldPct: Number.isInteger(v.softHoldPct) && v.softHoldPct >= 1 && v.softHoldPct <= 100 ? v.softHoldPct : null,
    day: normBudgetWindow(v.day),
    week: normBudgetWindow(v.week),
    month: normBudgetWindow(v.month),
    tokens: {
      spent: Number.isInteger(t.spent) && t.spent >= 0 ? t.spent : null,
      cap: Number.isInteger(t.cap) && t.cap > 0 ? t.cap : null,
      state: BUDGET_STATES.includes(t.state) ? t.state : "ok",
      maxTokens: Number.isInteger(t.maxTokens) && t.maxTokens > 0 ? t.maxTokens : null,
    },
    // The scoped rows (issue #242): a pre-1.5 payload simply lacks the key and renders nothing.
    scoped: Array.isArray(v.scoped) ? v.scoped.map(normScopedRow).filter((r) => r !== null) : [],
    scopedInvalid: typeof v.scopedInvalid === "string" && v.scopedInvalid !== "" ? clip(v.scopedInvalid, 160) : null,
  };
}

/** One scoped-limit row's allowlist: scope a non-empty string (clipped), each window `{ used, cap,
 * state }` with used a non-negative integer or null (an unreadable counter cell, never an invented
 * zero), concurrent a positive integer or null. Config-only concurrency: no in-flight count exists
 * here to display, and the page never invents one. */
function normScopedRow(v) {
  if (v === null || typeof v !== "object" || typeof v.scope !== "string" || v.scope === "") return null;
  const win = (w) => {
    if (w === null || w === undefined || typeof w !== "object") return null;
    return {
      used: Number.isInteger(w.used) && w.used >= 0 ? w.used : null,
      cap: Number.isInteger(w.cap) && w.cap > 0 ? w.cap : null,
      state: BUDGET_STATES.includes(w.state) ? w.state : "ok",
    };
  };
  return {
    scope: clip(v.scope, 60),
    day: win(v.day),
    week: win(v.week),
    month: win(v.month),
    concurrent: Number.isInteger(v.concurrent) && v.concurrent > 0 ? v.concurrent : null,
  };
}

/** costByTrigger: keys are the graph's own trigger ids -- server-side join vocabulary only, they
 * never reach the page (the badge is text at a chip's coordinates, joined via the scene layout). */
function normSpendMap(v) {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return null;
  const out = new Map();
  for (const key of Object.keys(v)) {
    if (!key.startsWith("trigger:")) continue;
    const e = v[key];
    if (e === null || e === undefined || typeof e !== "object") continue;
    const cost = normCost(e.cost);
    if (cost === null) continue;
    out.set(key, { cost, runs: posInt(e.runs) });
  }
  return out;
}

// 1/2/5 ladder for the y gridlines: the axis must land on amounts fmtUsd renders cleanly, and a
// step derived raw off the maximum draws labels like $0.7750 that read as false precision.
function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const base = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return base * mag;
}

/**
 * Pure geometry for the daily column chart, exported so the invariants (bars inside the plot,
 * monotone x, gap days present, all-zero windows safe) are testable as numbers instead of parsed
 * back out of SVG. Gap days arrive as zero-run entries and KEEP their slot: skipping them would
 * compress history, which for spend is a lie of omission. Bars scale against the top gridline
 * (4 x the nice step), never the raw maximum, so the tallest bar still sits under the axis frame.
 */
export function layoutDailyChart(daily, { width, height } = {}) {
  const w = Number.isFinite(width) && width > 100 ? width : DAILY_W;
  const h = Number.isFinite(height) && height > 60 ? height : DAILY_H;
  const entries = normDailyEntries(daily);
  const plot = { x: DAILY_ML, y: DAILY_MT, w: w - DAILY_ML - DAILY_MR, h: h - DAILY_MT - DAILY_MB };
  const maxUsd = entries.reduce((m, e) => Math.max(m, e.cost.usd), 0);
  const step = niceStep(maxUsd / 4);
  const scaleMax = step * 4;
  const yTicks = [];
  if (scaleMax > 0) {
    for (let k = 1; k <= 4; k += 1) {
      yTicks.push({ y: plot.y + plot.h - (k / 4) * plot.h, label: fmtUsd(step * k) });
    }
  }
  const n = entries.length;
  const slot = n > 0 ? plot.w / n : plot.w;
  const barW = Math.max(1, Math.min(DAILY_BAR_MAX, slot * 0.7));
  const bars = entries.map((e, i) => {
    const cx = plot.x + i * slot + slot / 2;
    let bh;
    let cls;
    if (e.runs === 0) {
      // The zero-run baseline tick: a day that ran nothing is a fact with a place on the axis,
      // drawn as a 1px sliver so it can never be mistaken for spend.
      bh = 1;
      cls = "zero";
    } else {
      bh = scaleMax > 0 ? Math.max(1, (Math.max(0, e.cost.usd) / scaleMax) * plot.h) : 1;
      cls = e.cost.class;
    }
    return {
      x: cx - barW / 2,
      y: plot.y + plot.h - bh,
      w: barW,
      h: bh,
      cls,
      floor: e.cost.floor === true && e.runs > 0,
      runs: e.runs,
      day: e.day,
      usd: e.cost.usd,
    };
  });
  const every = n > 0 ? Math.ceil(n / 8) : 1;
  const xLabels = [];
  for (let i = 0; i < n; i += every) {
    xLabels.push({ x: plot.x + i * slot + slot / 2, label: entries[i].day.slice(5) });
  }
  return { bars, yTicks, xLabels, width: w, height: h, plot };
}

/**
 * Pure geometry for one horizontal bar list. The class encoding is the row's whole honesty story:
 * metered draws a solid bar, estimated a translucent dashed one, plan draws NO bar at all (a chip --
 * a covered run has no per-run dollar, and a zero-width bar would still claim the dollar axis),
 * zero-rated a hairline tick, unknown nothing but the em dash. `nodeId` rides through only when it
 * is already a minted ordinal, so an original (path-bearing) id can never reach a DOM attribute.
 */
export function layoutBarList(rows, { width } = {}) {
  const w = Number.isFinite(width) && width > 200 ? width : LIST_W;
  const span = w - LIST_LABEL_W - LIST_VALUE_W;
  const items = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r !== null && r !== undefined && typeof r === "object") items.push(r);
  }
  // One scale per section, api-equivalents included: two bars in one list at two scales would make
  // every visual comparison between rows meaningless.
  let max = 0;
  for (const r of items) {
    const c = normCost(r.cost);
    if (c !== null && (c.class === "metered" || c.class === "estimated" || c.class === "seeded") && c.usd > max) max = c.usd;
    const a = normCost(r.apiEquiv);
    if (a !== null && a.usd > max) max = a.usd;
  }
  return items.map((r, i) => {
    const c = normCost(r.cost);
    const cls = c === null ? "unknown" : c.class;
    const label = clip(strOr(r.label, "(unnamed)"), 60);
    const runs = posInt(r.runs);
    let barW = null;
    let chipText = null;
    if (cls === "metered" || cls === "estimated" || cls === "seeded") {
      // "seeded" cannot appear on this page (only the what-if emits it), but a total function
      // still draws SOMETHING if it ever does: the ~~ text already carries the class.
      barW = max > 0 ? Math.max(1, (Math.max(0, c.usd) / max) * span) : 1;
    } else if (cls === "plan") {
      chipText = fmtCost(c);
    } else if (cls === "zero-rated") {
      barW = 1;
    }
    const a = normCost(r.apiEquiv);
    const failed = posInt(r.failed);
    let tip = `${label} · ${fmtCost(c)} · ${fmt(runs)} runs`;
    if (failed > 0) tip += ` · ${fmt(failed)} failed (${fmtCost(normCost(r.failedCost))})`;
    if (a !== null) tip += ` · ${fmtCost(a)} @ API`;
    return {
      y: i * LIST_ROW_H,
      barW,
      chipText,
      labelText: clip(label, 20),
      valueText: fmtCost(c),
      cls,
      nodeId: typeof r.nodeId === "string" && /^n\d+$/.test(r.nodeId) ? r.nodeId : null,
      tip,
      apiW: a !== null && max > 0 ? Math.max(1, (Math.max(0, a.usd) / max) * span) : null,
      apiText: a !== null ? `${fmtCost(a)} @ API` : null,
    };
  });
}

/**
 * Pure geometry for the per-flow small multiples (issue #181). ONE scale across every panel -- the
 * shared-scale rule that makes multiples comparable -- with the same band-center x math as the daily
 * columns, so a flow panel and the global chart place the same day at the same relative position.
 * A segment is dashed when EITHER endpoint day is non-metered: the line touching an estimated day
 * wears the estimate (a zero-run gap day folds to metered $0, so quiet days stay solid at the
 * baseline -- a $0 day is a measured fact here). Exported so the invariants are testable as numbers.
 */
export function layoutFlowLines(dailyByFlow, { width, height, top } = {}) {
  const w = Number.isFinite(width) && width > 100 ? width : FLOW_W;
  const h = Number.isFinite(height) && height > 40 ? height : FLOW_H;
  const rows = normFlowSeries(dailyByFlow);
  const take = Number.isInteger(top) && top > 0 ? top : LINES_TOP;
  const chosen = rows.slice(0, take);
  const rest = rows.slice(take);
  const plot = { x: FLOW_ML, y: FLOW_MT, w: w - FLOW_ML - FLOW_MR, h: h - FLOW_MT - FLOW_MB };
  let maxUsd = 0;
  for (const r of chosen) for (const d of r.days) maxUsd = Math.max(maxUsd, d.cost.usd);
  const step = niceStep(maxUsd / 4);
  const scaleMax = step * 4;
  const panels = chosen.map((r) => {
    const n = r.days.length;
    const slot = n > 0 ? plot.w / n : plot.w;
    const points = r.days.map((d, i) => ({
      x: plot.x + i * slot + slot / 2,
      y: plot.y + plot.h - (scaleMax > 0 ? (Math.max(0, d.cost.usd) / scaleMax) * plot.h : 0),
      day: d.day,
      usd: d.cost.usd,
      runs: d.runs,
      cls: d.cost.class,
      floor: d.cost.floor === true && d.runs > 0,
    }));
    const segments = [];
    for (let i = 1; i < points.length; i += 1) {
      segments.push({
        x1: points[i - 1].x,
        y1: points[i - 1].y,
        x2: points[i].x,
        y2: points[i].y,
        dashed: points[i - 1].cls !== "metered" || points[i].cls !== "metered",
      });
    }
    const yTicks = scaleMax > 0 ? [2, 4].map((k) => ({ y: plot.y + plot.h - (k / 4) * plot.h, label: fmtUsd(step * k) })) : [];
    const every = n > 0 ? Math.ceil(n / 4) : 1;
    const xLabels = [];
    for (let i = 0; i < n; i += every) {
      xLabels.push({ x: plot.x + i * slot + slot / 2, label: r.days[i].day.slice(5) });
    }
    return { flow: r.flow, flowKey: r.flowKey, plot, points, segments, yTicks, xLabels };
  });
  const restAgg =
    rest.length > 0
      ? {
          usd: rest.reduce((s, r) => s + r.days.reduce((a, d) => a + d.cost.usd, 0), 0),
          class: "estimated",
          floor: rest.some((r) => r.days.some((d) => d.cost.floor === true)),
        }
      : null;
  return { panels, restCount: rest.length, restAgg, scaleMax, width: w, height: h };
}

/**
 * Pure geometry for the cumulative window-spend line. Its OWN plot with its OWN nice scale under the
 * daily columns -- never a second axis on the columns plot. A prefix sum is demoted PERMANENTLY by
 * its first non-metered day (once an estimate enters a running total it never leaves), so the line
 * is dashed from that day onward and the end label is the running TYPED total -- which converges, by
 * construction, to the provenance total the KPI tile shows.
 */
export function layoutCumulative(daily, { width, height } = {}) {
  const w = Number.isFinite(width) && width > 100 ? width : DAILY_W;
  const h = Number.isFinite(height) && height > 40 ? height : CUM_H;
  const entries = normDailyEntries(daily);
  const plot = { x: DAILY_ML, y: 8, w: w - DAILY_ML - DAILY_MR, h: h - 8 - DAILY_MB };
  let running = 0;
  let demoted = false;
  let floor = false;
  const raw = entries.map((e) => {
    running += Math.max(0, e.cost.usd);
    if (e.runs > 0 && e.cost.class !== "metered") demoted = true;
    if (e.cost.floor === true) floor = true;
    return { day: e.day, total: running, demoted, floor, runs: e.runs };
  });
  const step = niceStep(running / 2);
  const scaleMax = step * 2;
  const n = raw.length;
  const slot = n > 0 ? plot.w / n : plot.w;
  const points = raw.map((r, i) => ({
    x: plot.x + i * slot + slot / 2,
    y: plot.y + plot.h - (scaleMax > 0 ? (r.total / scaleMax) * plot.h : 0),
    day: r.day,
    total: r.total,
    demoted: r.demoted,
    floor: r.floor,
  }));
  const segments = [];
  for (let i = 1; i < points.length; i += 1) {
    segments.push({ x1: points[i - 1].x, y1: points[i - 1].y, x2: points[i].x, y2: points[i].y, dashed: points[i].demoted });
  }
  const yTicks = scaleMax > 0 ? [1, 2].map((k) => ({ y: plot.y + plot.h - (k / 2) * plot.h, label: fmtUsd(step * k) })) : [];
  const endTotal = n > 0 ? { usd: points[n - 1].total, class: points[n - 1].demoted ? "estimated" : "metered", floor } : null;
  return { points, segments, yTicks, endTotal, scaleMax, width: w, height: h, plot };
}

// ---- HTML emission (server-side strings; the page script only ever assigns them as text) ----

function dailyChartHtml(daily, tips) {
  if (daily.length === 0) return '<div class="dim">no runs in the spend window</div>';
  const lay = layoutDailyChart(daily, { width: DAILY_W, height: DAILY_H });
  const costByDay = new Map(daily.map((d) => [d.day, d.cost]));
  const p = lay.plot;
  const parts = [`<svg width="${fmt(DAILY_W)}" height="${fmt(DAILY_H)}" role="img" aria-label="daily spend">`];
  parts.push(`<line x1="${fmt(p.x)}" y1="${fmt(p.y)}" x2="${fmt(p.x)}" y2="${fmt(p.y + p.h)}" stroke="${PAGE_THEME.border}"/>`);
  parts.push(`<line x1="${fmt(p.x)}" y1="${fmt(p.y + p.h)}" x2="${fmt(p.x + p.w)}" y2="${fmt(p.y + p.h)}" stroke="${PAGE_THEME.border}"/>`);
  for (const t of lay.yTicks) {
    parts.push(`<line x1="${fmt(p.x)}" y1="${fmt(t.y)}" x2="${fmt(p.x + p.w)}" y2="${fmt(t.y)}" stroke="${PAGE_THEME.border}" stroke-width="0.5"/>`);
    parts.push(`<text x="${fmt(p.x - 6)}" y="${fmt(t.y + 3)}" text-anchor="end" font-size="9" fill="${PAGE_THEME.dim}">${escapeHtml(t.label)}</text>`);
  }
  for (const b of lay.bars) {
    const idx = tips.push(`${b.day} · ${fmtCost(costByDay.get(b.day) ?? null)} · ${fmt(b.runs)} runs`) - 1;
    if (b.cls === "zero") {
      parts.push(`<rect data-tip="${fmt(idx)}" x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" fill="${PAGE_THEME.dim}"/>`);
    } else if (b.cls === "metered") {
      parts.push(`<rect data-tip="${fmt(idx)}" x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="2" fill="${PAGE_THEME.accent}"/>`);
    } else {
      parts.push(`<rect data-tip="${fmt(idx)}" x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="2" fill="${PAGE_THEME.accent}" fill-opacity=".45" stroke="${PAGE_THEME.accent}" stroke-dasharray="4,3"/>`);
    }
    if (b.floor && b.cls !== "zero") {
      parts.push(`<text x="${fmt(b.x + b.w / 2)}" y="${fmt(b.y - 3)}" text-anchor="middle" font-size="9" fill="${PAGE_THEME.amber}">≥</text>`);
    }
  }
  for (const xl of lay.xLabels) {
    parts.push(`<text x="${fmt(xl.x)}" y="${fmt(p.y + p.h + 14)}" text-anchor="middle" font-size="9" fill="${PAGE_THEME.dim}">${escapeHtml(xl.label)}</text>`);
  }
  if (lay.yTicks.length === 0) {
    parts.push(`<text x="${fmt(p.x + p.w / 2)}" y="${fmt(p.y + p.h / 2)}" text-anchor="middle" font-size="11" fill="${PAGE_THEME.dim}">no spend recorded</text>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

/** Group consecutive same-dash segments into <path> runs -- one element per run, `d` built from
 * fmt output alone so the well-formedness path grammar holds by construction. */
function segmentPaths(points, segments, stroke) {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `<circle cx="${fmt(points[0].x)}" cy="${fmt(points[0].y)}" r="2" fill="${stroke}"/>`;
  }
  const parts = [];
  let i = 0;
  while (i < segments.length) {
    const dashed = segments[i].dashed;
    let d = `M ${fmt(segments[i].x1)} ${fmt(segments[i].y1)}`;
    while (i < segments.length && segments[i].dashed === dashed) {
      d += ` L ${fmt(segments[i].x2)} ${fmt(segments[i].y2)}`;
      i += 1;
    }
    parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5"${dashed ? ' stroke-dasharray="4,3"' : ""}/>`);
  }
  return parts.join("");
}

/** The chart frame every line panel shares: spine, baseline, gridlines with fmtUsd labels. */
function axisFrame(plot, yTicks) {
  const parts = [];
  parts.push(`<line x1="${fmt(plot.x)}" y1="${fmt(plot.y)}" x2="${fmt(plot.x)}" y2="${fmt(plot.y + plot.h)}" stroke="${PAGE_THEME.border}"/>`);
  parts.push(`<line x1="${fmt(plot.x)}" y1="${fmt(plot.y + plot.h)}" x2="${fmt(plot.x + plot.w)}" y2="${fmt(plot.y + plot.h)}" stroke="${PAGE_THEME.border}"/>`);
  for (const t of yTicks) {
    parts.push(`<line x1="${fmt(plot.x)}" y1="${fmt(t.y)}" x2="${fmt(plot.x + plot.w)}" y2="${fmt(t.y)}" stroke="${PAGE_THEME.border}" stroke-width="0.5"/>`);
    parts.push(`<text x="${fmt(plot.x - 6)}" y="${fmt(t.y + 3)}" text-anchor="end" font-size="9" fill="${PAGE_THEME.dim}">${escapeHtml(t.label)}</text>`);
  }
  return parts.join("");
}

function cumulativeHtml(daily, tips) {
  const lay = layoutCumulative(daily, {});
  if (lay.points.length === 0) return "";
  const parts = [`<svg width="${fmt(lay.width)}" height="${fmt(lay.height)}" role="img" aria-label="cumulative window spend">`];
  parts.push(axisFrame(lay.plot, lay.yTicks));
  if (lay.scaleMax === 0) {
    parts.push(`<text x="${fmt(lay.plot.x + lay.plot.w / 2)}" y="${fmt(lay.plot.y + lay.plot.h / 2)}" text-anchor="middle" font-size="11" fill="${PAGE_THEME.dim}">no spend recorded</text>`);
  } else {
    parts.push(segmentPaths(lay.points, lay.segments, PAGE_THEME.accent));
    for (const pt of lay.points) {
      const idx = tips.push(`${pt.day} · cumulative ${fmtCost({ usd: pt.total, class: pt.demoted ? "estimated" : "metered", floor: pt.floor })}`) - 1;
      parts.push(`<circle data-tip="${fmt(idx)}" cx="${fmt(pt.x)}" cy="${fmt(pt.y)}" r="2" fill="${PAGE_THEME.accent}"${pt.demoted ? ' fill-opacity=".45" stroke="' + PAGE_THEME.accent + '"' : ""}/>`);
    }
    const last = lay.points[lay.points.length - 1];
    // Direct end-of-line label: the running typed total, which converges to the KPI's provenance total.
    parts.push(`<text x="${fmt(Math.min(last.x + 6, lay.width - 4))}" y="${fmt(Math.max(10, last.y - 4))}" font-size="9" fill="${PAGE_THEME.dim}">${escapeHtml(fmtCost(lay.endTotal))}</text>`);
  }
  parts.push("</svg>");
  return `<div class="dim small">cumulative</div>${parts.join("")}`;
}

function flowLinesHtml(nf, tips) {
  if (nf.dailyByFlow === null) return null; // absence: the fold predates the series, so no section at all
  const lay = layoutFlowLines(nf.dailyByFlow, {});
  if (lay.panels.length === 0) return '<div class="dim">no runs in the spend window</div>';
  const totalsByFlow = new Map(nf.byFlow.map((r) => [r.flow, r.cost]));
  const panels = lay.panels.map((panel) => {
    const parts = [`<div class="bl"><h3>${escapeHtml(panel.flow)} <span class="dim">${escapeHtml(fmtCost(totalsByFlow.get(panel.flow) ?? null))}</span></h3>`];
    parts.push(`<svg width="${fmt(lay.width)}" height="${fmt(lay.height)}" role="img" aria-label="daily spend · ${escapeHtml(panel.flow)}">`);
    parts.push(axisFrame(panel.plot, panel.yTicks));
    if (lay.scaleMax === 0) {
      parts.push(`<text x="${fmt(panel.plot.x + panel.plot.w / 2)}" y="${fmt(panel.plot.y + panel.plot.h / 2)}" text-anchor="middle" font-size="11" fill="${PAGE_THEME.dim}">no spend recorded</text>`);
    } else {
      parts.push(segmentPaths(panel.points, panel.segments, PAGE_THEME.accent));
      for (const pt of panel.points) {
        const idx = tips.push(`${pt.day} · ${panel.flow} · ${fmtCost({ usd: pt.usd, class: pt.cls, floor: pt.floor })} · ${fmt(pt.runs)} runs`) - 1;
        const estim = pt.runs > 0 && pt.cls !== "metered";
        parts.push(`<circle data-tip="${fmt(idx)}" cx="${fmt(pt.x)}" cy="${fmt(pt.y)}" r="2" fill="${PAGE_THEME.accent}"${estim ? ' fill-opacity=".45" stroke="' + PAGE_THEME.accent + '"' : ""}/>`);
        if (pt.floor) {
          parts.push(`<text x="${fmt(pt.x)}" y="${fmt(pt.y - 5)}" text-anchor="middle" font-size="9" fill="${PAGE_THEME.amber}">≥</text>`);
        }
      }
      for (const xl of panel.xLabels) {
        parts.push(`<text x="${fmt(xl.x)}" y="${fmt(panel.plot.y + panel.plot.h + 12)}" text-anchor="middle" font-size="8" fill="${PAGE_THEME.dim}">${escapeHtml(xl.label)}</text>`);
      }
    }
    parts.push("</svg></div>");
    return parts.join("");
  });
  let tail = "";
  if (lay.restCount > 0) {
    tail = `<div class="dim small">(+${fmt(lay.restCount)} more flows · ${escapeHtml(fmtCost(lay.restAgg))})</div>`;
  }
  return `<div id="flows">${panels.join("")}</div>${tail}`;
}

/** The decorative used-vs-cap bar beside a budget row's text facts: drawn ONLY when both numbers are
 * known, fill clamped inside the track (overflow is the WORD's job), the soft-hold band as an amber
 * tick. aria-hidden -- the text row beside it carries every fact. */
function budgetBarSvg(reserved, cap, state, pct) {
  const fillW = reserved > 0 ? Math.max(1, Math.round((Math.min(reserved, cap) / cap) * METER_W)) : 0;
  const fill = state === "over" ? PAGE_THEME.danger : state === "soft-hold" ? PAGE_THEME.amber : PAGE_THEME.accent;
  const parts = [`<svg width="${fmt(METER_W)}" height="12" aria-hidden="true">`];
  parts.push(`<rect x="0" y="2" width="${fmt(METER_W)}" height="8" rx="2" fill="none" stroke="${PAGE_THEME.border}"/>`);
  if (fillW > 0) parts.push(`<rect x="0" y="2" width="${fmt(fillW)}" height="8" rx="2" fill="${fill}"/>`);
  if (pct !== null) {
    const tx = Math.round((Math.floor((cap * pct) / 100) / cap) * METER_W);
    parts.push(`<rect x="${fmt(tx)}" y="0" width="1" height="12" fill="${PAGE_THEME.amber}"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

/** A budget state as a WORD (omitted when "ok"): monochrome must still say soft-hold or over. */
function stateWord(state) {
  if (state === "ok") return "";
  return ` <span class="state${state === "over" ? " over" : ""}">${escapeHtml(state)}</span>`;
}

/**
 * The budget panel (issue #181): the caps are the operator's ONE real lever on cost, so the page
 * that prices everything shows the dial beside the spend and names how to turn it. FACTS ONLY, the
 * meter doctrine throughout: an overlay-unset cap is unknown (day) or off (week/month with nothing
 * reserved) -- no bar, no percentage, no derived room; an unreachable queue leaves the caps as facts
 * and states the absence; slots and tokens are counts, never dollars, so nothing here touches
 * fmtCost. Renders even when the cost fold is null: the lever does not depend on the spend scan.
 */
function budgetSectionHtml(nb) {
  if (nb === null) return '<div class="dim">no budget data in this payload</div>';
  const rows = [];
  const slotRow = (label, wdw) => {
    if (wdw.cap === null && (wdw.reserved === null || wdw.reserved === 0) && label !== "day") {
      rows.push(`<div class="row"><span class="wl">${escapeHtml(label)}</span><span class="dim">off · no cap set</span></div>`);
      return;
    }
    if (nb.unreachable !== null) {
      const capText = wdw.cap !== null ? `cap ${fmt(wdw.cap)} (overlay)` : "cap unknown (worker env/default)";
      rows.push(`<div class="row"><span class="wl">${escapeHtml(label)}</span><span class="dim">${escapeHtml(capText)} · reserved unavailable (queue unreachable)</span></div>`);
      return;
    }
    const reserved = wdw.reserved ?? 0;
    if (wdw.cap === null) {
      rows.push(`<div class="row"><span class="wl">${escapeHtml(label)}</span><span>${escapeHtml(`reserved ${fmt(reserved)} / cap unknown (worker env/default)`)}</span></div>`);
      return;
    }
    rows.push(
      `<div class="row"><span class="wl">${escapeHtml(label)}</span><span>${escapeHtml(`reserved ${fmt(reserved)} / cap ${fmt(wdw.cap)} (overlay)`)}</span>${stateWord(wdw.state)}${budgetBarSvg(reserved, wdw.cap, wdw.state, nb.softHoldPct)}</div>`,
    );
  };
  slotRow("day", nb.day);
  slotRow("week", nb.week);
  slotRow("month", nb.month);

  const t = nb.tokens;
  const perJob = t.maxTokens !== null ? ` · per-job maxTokens ${fmt(t.maxTokens)}` : " · per-job budget off";
  if (nb.unreachable !== null) {
    const capText = t.cap !== null ? `cap ${fmt(t.cap)} tok (overlay)` : "daily cap off";
    rows.push(`<div class="row"><span class="wl">tokens today</span><span class="dim">${escapeHtml(capText + " · spent unavailable (queue unreachable)" + perJob)}</span></div>`);
  } else if (t.cap === null) {
    rows.push(`<div class="row"><span class="wl">tokens today</span><span>${escapeHtml(`${fmt(t.spent ?? 0)} tok · daily cap off${perJob}`)}</span></div>`);
  } else {
    rows.push(
      `<div class="row"><span class="wl">tokens today</span><span>${escapeHtml(`${fmt(t.spent ?? 0)} / cap ${fmt(t.cap)} tok`)}</span>${stateWord(t.state)}${budgetBarSvg(t.spent ?? 0, t.cap, t.state, nb.softHoldPct)}<span class="dim small">${escapeHtml(perJob)}</span></div>`,
    );
  }

  if (nb.softHoldPct !== null) {
    rows.push(`<div class="dim small">soft-hold band: ${fmt(nb.softHoldPct)}% of each cap (the amber tick)</div>`);
  }
  // The scoped rows (issue #242): configured limits with their used counts, states as the assembler's
  // words. Concurrency renders as config only -- in-flight is worker state no payload carries.
  if (nb.scopedInvalid !== null) {
    rows.push(`<div class="dim small">scoped limits: file invalid (${escapeHtml(nb.scopedInvalid)})</div>`);
  } else if (nb.scoped.length > 0) {
    rows.push('<div class="dim small">scoped limits (scoped-limits.json)</div>');
    for (const s of nb.scoped) {
      const bits = [];
      let worst = "ok";
      for (const key of ["day", "week", "month"]) {
        const w = s[key];
        if (w === null || w.cap === null) continue;
        bits.push(`${key} used ${w.used !== null ? fmt(w.used) : "?"} / cap ${fmt(w.cap)}`);
        if (w.state !== "ok") worst = w.state;
      }
      if (s.concurrent !== null) bits.push(`concurrent ≤${fmt(s.concurrent)} (config; in-flight not shown)`);
      rows.push(`<div class="row"><span class="wl">${escapeHtml(s.scope)}</span><span>${escapeHtml(bits.join(" · "))}</span>${worst !== "ok" ? stateWord(worst) : ""}</div>`);
    }
    rows.push('<div class="lever">scoped: dispatch_limit_add/edit/delete · or press m in the /dispatch panel</div>');
  }
  // The lever, named: what the whole panel exists to point at.
  rows.push('<div class="lever">adjust: /dispatch set dailyCap|weeklyCap|monthlyCap|dailyTokenCap|softHoldPct &lt;n&gt; · or press s in the /dispatch panel</div>');
  return `<div id="budget">${rows.join("")}</div>`;
}

function barListSvg(rows, aria, tips) {
  const laid = layoutBarList(rows, { width: LIST_W });
  const height = laid.length * LIST_ROW_H + 6;
  const parts = [`<svg width="${fmt(LIST_W)}" height="${fmt(height)}" role="img" aria-label="${escapeHtml(aria)}">`];
  for (const row of laid) {
    const idx = tips.push(row.tip) - 1;
    const link = row.nodeId !== null ? ` data-node="${row.nodeId}" class="rowlink"` : "";
    parts.push(`<g data-tip="${fmt(idx)}"${link}>`);
    const base = row.y + 14;
    const bx = LIST_LABEL_W;
    parts.push(`<text x="0" y="${fmt(base)}" font-size="11" fill="${PAGE_THEME.fg}">${escapeHtml(row.labelText)}</text>`);
    if (row.chipText !== null) {
      const cw = Math.min(row.chipText.length * 6 + 12, LIST_W - bx - 8);
      parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 3)}" width="${fmt(cw)}" height="15" rx="7" fill="none" stroke="${PAGE_THEME.chipStroke}"/>`);
      parts.push(`<text x="${fmt(bx + 7)}" y="${fmt(base)}" font-size="10" fill="${PAGE_THEME.dim}">${escapeHtml(row.chipText)}</text>`);
    } else if (row.barW !== null) {
      if (row.cls === "metered") {
        parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 5)}" width="${fmt(row.barW)}" height="11" rx="2" fill="${PAGE_THEME.accent}"/>`);
      } else if (row.cls === "zero-rated") {
        parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 5)}" width="1" height="11" fill="${PAGE_THEME.dim}"/>`);
      } else {
        parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 5)}" width="${fmt(row.barW)}" height="11" rx="2" fill="${PAGE_THEME.accent}" fill-opacity=".45" stroke="${PAGE_THEME.accent}" stroke-dasharray="4,3"/>`);
      }
      parts.push(`<text x="${fmt(bx + row.barW + 6)}" y="${fmt(base)}" font-size="10" fill="${PAGE_THEME.dim}">${escapeHtml(row.valueText)}</text>`);
    } else {
      parts.push(`<text x="${fmt(bx)}" y="${fmt(base)}" font-size="10" fill="${PAGE_THEME.dim}">${escapeHtml(row.valueText)}</text>`);
    }
    if (row.apiW !== null) {
      parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 18)}" width="${fmt(row.apiW)}" height="2" fill="none" stroke="${PAGE_THEME.dim}" stroke-dasharray="3,2"/>`);
      parts.push(`<text x="${fmt(bx + row.apiW + 6)}" y="${fmt(row.y + 21)}" font-size="8" fill="${PAGE_THEME.dim}">${escapeHtml(row.apiText)}</text>`);
    }
    parts.push("</g>");
  }
  parts.push("</svg>");
  return parts.join("");
}

function listSection(title, rows, aria, tips) {
  const head = rows.slice(0, LIST_TOP);
  const rest = rows.slice(LIST_TOP);
  let tail = "";
  if (rest.length > 0) {
    // The tail is an aggregate, and an aggregate over heterogeneous rows is at best an estimate --
    // hence the forced class. Totals never silently truncate: K rows fold into one stated line.
    const agg = {
      usd: rest.reduce((s, r) => s + r.cost.usd, 0),
      class: "estimated",
      floor: rest.some((r) => r.cost.floor === true),
    };
    tail = `<div class="dim small">(+${fmt(rest.length)} more · ${escapeHtml(fmtCost(agg))})</div>`;
  }
  const body = head.length === 0 ? '<div class="dim small">none in window</div>' : barListSvg(head, aria, tips);
  return `<div class="bl"><h3>${escapeHtml(title)}</h3>${body}${tail}</div>`;
}

function breakdownHtml(nf, minted, tips) {
  const secs = [];
  secs.push(listSection("by flow", nf.byFlow.map((r) => ({ label: r.flow, cost: r.cost, runs: r.runs, apiEquiv: r.apiEquiv })), "spend by flow", tips));
  if (nf.byTrigger === null) {
    // Absence, not an empty table: an empty list would read as "nothing spent", which is a claim
    // the caller explicitly did not compute.
    secs.push('<div class="bl"><h3>by trigger</h3><div class="dim small">not computed (no trigger join wired)</div></div>');
  } else {
    secs.push(listSection(
      "by trigger",
      nf.byTrigger.map((r) => ({
        label: r.label,
        cost: r.cost,
        runs: r.runs,
        failed: r.outcomes.failed,
        failedCost: r.failedCost,
        nodeId: minted.get(r.key) ?? null,
      })),
      "spend by trigger",
      tips,
    ));
  }
  secs.push(listSection("by model", nf.byModel.map((r) => ({ label: `${r.provider}/${r.model}`, cost: r.cost, runs: r.runs })), "spend by model", tips));
  secs.push(listSection("by repo", nf.byRepo.map((r) => ({ label: r.label, cost: r.cost, runs: r.runs })), "spend by repo", tips));
  return `<div id="grid">${secs.join("")}</div>`;
}

function kpisHtml(nf) {
  const p = nf.provenance;
  const ledgered = Math.max(0, p.runsTotal - p.runsUnmetered - p.runsUnledgered);
  const top = nf.byFlow.length > 0 ? nf.byFlow[0] : null;
  const tiles = [
    [fmtCost(p.total), "window spend"],
    [fmt(p.runsTotal), "runs"],
    [`${fmt(ledgered)} of ${fmt(p.runsTotal)}`, "runs fully ledgered"],
    [fmt(nf.plans.length), "plans declared"],
    [top !== null ? fmtCost(top.cost) : "—", top !== null ? `top flow · ${top.flow}` : "top flow"],
  ];
  return `<div id="kpis">${tiles.map(([v, l]) => `<div class="kpi"><div class="v">${escapeHtml(v)}</div><div class="l">${escapeHtml(l)}</div></div>`).join("")}</div>`;
}

// FACTS ONLY, like the fold's peakWindow: a null limit renders as undisclosed and nothing here
// derives a remaining amount or a burn-down -- room "left" against a number the vendor never
// published would be an invented fact wearing the vendor's name.
function limitLine(w) {
  if (w.limit === null) return "limit undisclosed by vendor";
  if (Array.isArray(w.limit)) return `limit ${fmt(w.limit[0])}–${fmt(w.limit[1])} ${w.unit}`;
  return `limit ${fmt(w.limit)} ${w.unit}`;
}

function planCardsHtml(plans) {
  const cards = plans.map((pl) => {
    const parts = [`<div class="plan${pl.hypothetical ? " hypo" : ""}">`];
    parts.push(`<div><span class="pid">${escapeHtml(pl.id)}</span> <span class="pv">${escapeHtml(pl.vendor)}</span> · ${escapeHtml(`${fmtUsd(pl.price.amount)}/${pl.price.per}`)}${pl.hypothetical ? " (hypothetical)" : ""}</div>`);
    if (pl.verdict.kind === "NO_BASELINE") {
      parts.push('<div class="dim small">no API-rate baseline declared, set counterfactualModel to compare</div>');
    } else {
      // The WORD carries the verdict; color only reinforces it -- a monochrome print of this page
      // must still say SAVING or LOSING in so many letters.
      const saving = pl.verdict.kind === "SAVING" || pl.verdict.kind === "WOULD_SAVE";
      parts.push(`<div><span class="badge ${saving ? "good" : "bad"}">${escapeHtml(pl.verdict.kind.replace("_", " "))}</span> ${escapeHtml(fmtCost(pl.verdict.usd))}</div>`);
    }
    parts.push(`<div class="small dim">attributed ${fmt(pl.attributedRuns)} runs · ${fmt(pl.attributedTokens)} tok</div>`);
    parts.push(`<div class="small dim">amortized ${escapeHtml(fmtCost(pl.amortizedPerRun))}/run · api-equiv ${escapeHtml(fmtCost(pl.apiEquiv))}</div>`);
    for (const w of pl.windows) {
      parts.push(`<div class="small dim">${escapeHtml(`peak ${w.per}${w.rolling ? " rolling" : ""}: ${fmt(w.peakRuns)} runs · ${fmt(w.peakTokens)} tok · ${limitLine(w)}`)}</div>`);
    }
    parts.push("</div>");
    return parts.join("");
  });
  return `<div id="plans">${cards.join("")}</div>`;
}

// The dollars legend beside the reused graph legend. "seeded" is deliberately absent: only the
// what-if command emits it and this page never renders a what-if, so listing it would promise an
// encoding no bar here can carry (it stays in INSIGHTS_COST_CLASSES because the class exists).
function dollarsLegendHtml() {
  const sw = (inner) => `<svg width="20" height="12" aria-hidden="true">${inner}</svg>`;
  const rows = [];
  const row = (sample, text) => rows.push(`<div class="row">${sample}<span>${escapeHtml(text)}</span></div>`);
  rows.push("<h2>dollars</h2>");
  row(sw(`<rect x="1" y="2" width="18" height="8" rx="2" fill="${PAGE_THEME.accent}"/>`), "metered: pi-ai computed price");
  row(sw(`<rect x="1" y="2" width="18" height="8" rx="2" fill="${PAGE_THEME.accent}" fill-opacity=".45" stroke="${PAGE_THEME.accent}" stroke-dasharray="4,3"/>`), "estimated (~): partly measured");
  row(sw(`<rect x="1" y="2" width="18" height="8" rx="4" fill="none" stroke="${PAGE_THEME.chipStroke}"/>`), "plan: covered by a subscription, never a dollar");
  row(sw(`<rect x="9" y="2" width="1" height="8" fill="${PAGE_THEME.dim}"/>`), "zero-rated: a rate table priced it $0");
  row(sw(`<text x="6" y="10" font-size="10" fill="${PAGE_THEME.dim}">—</text>`), "unknown: not measured, not guessed");
  rows.push('<div class="caps">≥ marks a floor: the window holds spend the meter could not fully price</div>');
  return `<div id="dollars">${rows.join("")}</div>`;
}

function utcDateStr(ms) {
  // toISOString throws outside the representable range, and a junk payload must not be able to
  // reach a throw through a date field.
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "?";
  return new Date(ms).toISOString().slice(0, 10);
}

function footerHtml(nf, windowLabel) {
  const p = nf.provenance;
  const lines = [];
  lines.push(`~ marks estimates · metered = pi-ai computed prices, not invoices · pi-ai ${p.piAiPin ?? "—"}`);
  // The always-on pair states how much of the window was measured at all; the bracketed counters
  // appear only when nonzero because "rates drifted 0" reads as an accusation retracted.
  let counters = `unmetered ${fmt(p.runsUnmetered)} · no ledger (not re-priceable) ${fmt(p.runsUnledgered)}`;
  if (p.ratesDrifted > 0) counters += ` · rates drifted ${fmt(p.ratesDrifted)}`;
  if (p.runsLedgerTruncated > 0) counters += ` · ledgers truncated ${fmt(p.runsLedgerTruncated)}`;
  lines.push(counters);
  lines.push(`spend window ${utcDateStr(nf.window.fromMs)} – ${utcDateStr(nf.window.toMs)} UTC (${windowLabel})`);
  return `<div id="prov">${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>`;
}

function costBannersHtml(p, nf, nb) {
  const banners = [];
  if (typeof p.costsUnreachable === "string" && p.costsUnreachable !== "") banners.push(`costs unreachable: ${clip(p.costsUnreachable, 160)}`);
  if (nb !== null && nb !== undefined && nb.unreachable !== null) banners.push(`budget unreachable: ${nb.unreachable}`);
  if (nf !== null && nf.provenance.runsTotal === 0) banners.push("no runs in the spend window");
  // Only with the caller's explicit flag: an empty plans array alone also means "operator declared
  // nothing", and accusing a missing file on that evidence would be wrong half the time.
  if (nf !== null && nf.plans.length === 0 && p.subscriptionsInvalid) banners.push("subscriptions file missing or invalid: plans not scored");
  if (banners.length === 0) return "";
  return `<div id="cost-banners">${banners.map((b) => `<div class="banner">${escapeHtml(b)}</div>`).join("")}</div>`;
}

// ---- page chrome ----

const INSIGHTS_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:${PAGE_THEME.canvas};color:${PAGE_THEME.fg};font:14px/1.4 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:60px 16px 40px}
#hdr{position:fixed;top:0;left:0;right:0;height:46px;display:flex;align-items:center;gap:12px;padding:0 14px;background:${PAGE_THEME.panel};border-bottom:1px solid ${PAGE_THEME.border};z-index:3}
#hdr h1{font-size:14px;font-weight:600}
#stamp{color:${PAGE_THEME.dim};font-size:12px}
#stamp.stale{color:${PAGE_THEME.amber}}
#hdr button,#hdr select{background:#21262d;color:${PAGE_THEME.fg};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:3px 10px;font-size:12px}
#windows{color:${PAGE_THEME.dim};font-size:11px;margin-left:auto}
section{margin:18px auto;max-width:960px}
h2{font-size:13px;color:${PAGE_THEME.fg};margin:0 0 8px}
h3{font-size:12px;color:${PAGE_THEME.dim};margin:0 0 4px}
.dim{color:${PAGE_THEME.dim}}
.small{font-size:11px}
#banners,#cost-banners{max-width:960px;margin:8px auto}
.banner{background:#2d1517;border:1px solid ${PAGE_THEME.danger};color:${PAGE_THEME.danger};border-radius:6px;padding:6px 10px;margin-bottom:6px;font-size:12px}
#kpis{display:flex;gap:10px;flex-wrap:wrap}
.kpi{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:8px 14px;min-width:120px}
.kpi .v{font-size:16px}
.kpi .l{font-size:11px;color:${PAGE_THEME.dim}}
#plans{display:flex;gap:10px;flex-wrap:wrap}
.plan{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:10px 12px;min-width:280px;font-size:12px}
.plan.hypo{border-style:dashed}
.pid{font-weight:600}
.pv{color:${PAGE_THEME.dim}}
.badge{font-weight:700;font-size:11px}
.badge.good{color:${PAGE_THEME.green}}
.badge.bad{color:${PAGE_THEME.amber}}
#grid,#flows{display:grid;grid-template-columns:1fr 1fr;gap:14px}
#budget{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:10px 12px;font-size:12px;max-width:820px}
#budget .row{display:flex;align-items:center;gap:8px;margin:3px 0}
#budget .row span{white-space:nowrap}
#budget .wl{color:${PAGE_THEME.dim};min-width:86px}
#budget .state{color:${PAGE_THEME.amber};font-weight:600}
#budget .state.over{color:${PAGE_THEME.danger}}
#budget .lever{margin-top:8px;color:${PAGE_THEME.dim};font-size:11px}
.bl{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:8px 10px;overflow:hidden}
.rowlink{cursor:pointer}
#wrap{position:relative;border:1px solid ${PAGE_THEME.border};border-radius:6px}
svg.canvas{display:block;width:100%;height:auto;min-height:220px;max-height:75vh;cursor:grab;touch-action:none}
#tip{position:absolute;display:none;max-width:340px;background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:8px 10px;font-size:12px;color:${PAGE_THEME.fg};white-space:pre-line;pointer-events:none;z-index:4}
#legend,#dollars{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:10px 12px;font-size:11px;color:${PAGE_THEME.dim};margin-top:10px;max-width:440px}
#legend h2,#dollars h2{font-size:11px;color:${PAGE_THEME.fg};margin:6px 0 4px}
#legend .row,#dollars .row{display:flex;align-items:center;gap:6px;margin:2px 0}
#legend .caps,#dollars .caps{margin-top:8px;color:${PAGE_THEME.fg}}
#legend .honesty{margin-top:4px;color:${PAGE_THEME.amber}}
#prov{max-width:960px;margin:16px auto;color:${PAGE_THEME.dim};font-size:11px}
.gnode{cursor:pointer}
.dim .gnode,.dim .gwire{opacity:.15}
.dim .hi{opacity:1}
`;

// The insights half of the page behaviour, ES5-flavoured like PAGE_JS (it sits inside a template
// string) and under the same three rules the tests pin: nothing is retrieved over any transport,
// nothing assembles markup on the client (textContent only), and selection is NOT reimplemented --
// a breakdown row replays a plain DOM click at its chip so PAGE_JS's own handler stays the single
// owner of the dim/highlight state.
const INSIGHTS_JS = `
(function () {
  "use strict";
  var tip = document.getElementById("tip");
  var wrap = document.getElementById("wrap");
  if (!tip || !wrap) return;
  var mine = false;

  function showTip(el, e) {
    var raw = el.getAttribute("data-tip");
    if (raw === null) return;
    var i = parseInt(raw, 10);
    var tipsArr = INSIGHTS.tips;
    // The index rides a DOM attribute, so it is untrusted by the time it comes back even though
    // this page wrote it; a failed parse compares false here and falls through to nothing.
    if (!(i >= 0 && i < tipsArr.length)) return;
    var text = tipsArr[i];
    if (typeof text !== "string") return;
    tip.textContent = text;
    tip.style.display = "block";
    var wr = wrap.getBoundingClientRect();
    tip.style.left = e.clientX - wr.left + 14 + "px";
    tip.style.top = e.clientY - wr.top + 14 + "px";
    mine = true;
  }
  function hideTip() {
    // Only hide what this half showed: PAGE_JS drives the same #tip for graph chips, and a chart
    // handler that blanks it on every stray move would fight that code mid-hover.
    if (!mine) return;
    mine = false;
    tip.textContent = "";
    tip.style.display = "none";
  }
  document.addEventListener("pointermove", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
    if (el) showTip(el, e);
    else hideTip();
  });
  // pointerleave does not bubble, so delegation needs the capture phase to see a bar's exit.
  document.addEventListener("pointerleave", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-tip]") : null;
    if (el) hideTip();
  }, true);

  document.addEventListener("click", function (e) {
    var row = e.target && e.target.closest ? e.target.closest("[data-node]") : null;
    if (!row) return;
    var id = row.getAttribute("data-node");
    // Minted ordinals only: anything else (a prototype-chain key, a stray attribute) dies here
    // rather than at a DOM lookup.
    if (id === null || !/^n\\d+$/.test(id)) return;
    var chip = document.getElementById(id);
    if (!chip) return;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
})();
`;

/**
 * Build the complete insights page. Total function like the sibling: no arguments, a junk payload,
 * a null fold -- all yield a valid page with banners saying what is wrong, never a throw. `now` is
 * the injected generation instant; `fullPaths` is the operator's opt-in for absolute folder labels
 * and rides through to buildGraphScene untouched -- nothing on the cost side ever renders a path.
 */
export function buildInsightsHtml(payload, { now, fullPaths } = {}) {
  const p = payload !== null && payload !== undefined && typeof payload === "object" ? payload : {};
  const scene = buildGraphScene(p.graph, { now, fullPaths });
  let nf;
  let spend;
  try {
    nf = normFold(p.fold);
    spend = normSpendMap(p.costByTrigger);
  } catch {
    // A hostile getter in a junk payload lands the same place as a null fold: a stated absence.
    nf = null;
    spend = null;
  }
  let nb;
  try {
    // Its own try: the budget slice is independent of the spend scan (the lever does not depend on
    // the fold), so a hostile fold must not take the budget panel down with it, or vice versa.
    nb = normBudget(p.budget);
  } catch {
    nb = null;
  }

  const windowLabel = p.window === "7d" ? "last 7d" : p.window === "30d" ? "last 30d" : p.window === "mtd" ? "month to date" : "—";
  const windowDays = scene.norm.caps.windowDays ?? "?";
  const dualWindow = `spend window: ${windowLabel} · topology: fixed ${windowDays}d record window · series bounded by retention (PI_LOG_RETENTION_DAYS) and the 92-day scan cap`;

  // Server-side join table: original trigger id -> minted ordinal. The originals stay in this
  // scope; only the ordinal ever reaches a data attribute or the spend layer's coordinates.
  const minted = new Map();
  const spendParts = [];
  for (const pl of scene.layout.nodes) {
    const orig = pl.node.id;
    if (typeof orig !== "string" || !orig.startsWith("trigger:")) continue;
    minted.set(orig, pl.id);
    const entry = spend !== null && spend !== undefined ? spend.get(orig) : undefined;
    if (!entry) continue;
    const cls = entry.cost.class;
    const fill = cls === "estimated" || cls === "seeded" ? PAGE_THEME.amber : PAGE_THEME.dim;
    spendParts.push(`<text x="${fmt(pl.x + 16)}" y="${fmt(pl.y + pl.h + 23)}" font-size="10" fill="${fill}">${escapeHtml(fmtCost(entry.cost))}</text>`);
  }

  const tips = [];
  const bodyParts = [];
  bodyParts.push('<div id="hdr">');
  bodyParts.push("<h1>pi-dispatch insights</h1>");
  bodyParts.push('<span id="stamp"></span>');
  bodyParts.push('<button id="reload" type="button">Reload</button>');
  bodyParts.push('<select id="auto" aria-label="auto reload"><option value="0">off</option><option value="5">5s</option><option value="30">30s</option></select>');
  bodyParts.push(`<span id="windows">${escapeHtml(dualWindow)}</span>`);
  bodyParts.push("</div>");
  bodyParts.push(bannersHtml(scene.norm));
  bodyParts.push(costBannersHtml(p, nf, nb));

  if (nf !== null) bodyParts.push(`<section>${kpisHtml(nf)}</section>`);
  // Budget sits SECOND, beside the headline spend and above everything it can act on: the caps are
  // the operator's one real lever on cost, and it renders whether or not the spend scan was readable.
  bodyParts.push(`<section><h2>budget</h2>${budgetSectionHtml(nb)}</section>`);
  if (nf !== null) {
    if (nf.plans.length > 0) bodyParts.push(`<section><h2>plans</h2>${planCardsHtml(nf.plans)}</section>`);
    bodyParts.push(`<section><h2>daily spend</h2>${dailyChartHtml(nf.daily, tips)}${cumulativeHtml(nf.daily, tips)}</section>`);
    const flows = flowLinesHtml(nf, tips);
    if (flows !== null) bodyParts.push(`<section><h2>daily spend by flow</h2>${flows}</section>`);
    bodyParts.push(`<section><h2>breakdown</h2>${breakdownHtml(nf, minted, tips)}</section>`);
  } else {
    bodyParts.push('<section><div class="dim">no cost data in this payload</div></section>');
  }

  const vb = scene.viewBox;
  bodyParts.push(`<section><h2>topology (fixed ${escapeHtml(String(windowDays))}d window)</h2>`);
  bodyParts.push('<div class="dim small">chip run counts use the topology window; spend badges use the spend window</div>');
  bodyParts.push([
    '<div id="wrap">',
    // The pane takes the scene's own aspect ratio (clamped by the stylesheet's max-height): a fixed
    // pane height letterboxes a wide flat topology into a mostly-empty band under "meet", and the
    // headless-screenshot pass caught exactly that. Height stays fluid; pan/zoom covers a tall scene.
    `<svg id="graph" class="canvas" style="aspect-ratio:${fmt(Math.max(1, vb.w))}/${fmt(Math.max(1, vb.h))}" viewBox="${fmt(vb.x)} ${fmt(vb.y)} ${fmt(vb.w)} ${fmt(vb.h)}" role="img" aria-label="pi-dispatch trigger and flow topology" preserveAspectRatio="xMidYMid meet">`,
    `<g id="root">${scene.svgBody}</g>`,
    `<g id="spend">${spendParts.join("")}</g>`,
    "</svg>",
    '<div id="tip"></div>',
    "</div>",
  ].join(""));
  bodyParts.push(dollarsLegendHtml());
  bodyParts.push(legendHtml(scene.norm));
  bodyParts.push("</section>");
  if (nf !== null) bodyParts.push(footerHtml(nf, windowLabel));

  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<title>pi-dispatch insights</title>",
    `<style>${INSIGHTS_CSS}</style>`,
    "<body>",
    ...bodyParts,
    `<script>\n"use strict";\nvar GENERATED_AT = ${fmt(scene.nowMs)};\nvar GRAPH = ${embedJson(scene.graphData)};\nvar INSIGHTS = ${embedJson({ tips })};\n${PAGE_JS}${INSIGHTS_JS}</script>`,
    "</body>",
  ].join("\n");
}
