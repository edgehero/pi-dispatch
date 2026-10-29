/**
 * The spend screen's panels (the window picker, the insights and the what-if), split out of `../panels.mjs` (issue
 * #737), which re-exports what this module exports. The rules every panel keeps (one pure, deterministic renderer per
 * region, every value through `html`, the role and run-text rule, the action controls and the PATHS rule) are stated
 * once, in `../panels.mjs`'s header.
 */
import { bannersHtml, buildGraphScene } from "../../graph-html.mjs";
import {
  breakdownHtml,
  budgetSectionHtml,
  capacitySectionHtml,
  costBannersHtml,
  cumulativeHtml,
  dailyChartHtml,
  flowLinesHtml,
  footerHtml,
  insightsWindowLabel,
  INSIGHTS_CAPACITY_JOBS_ONLY,
  kpisHtml,
  normAllocation,
  normBudget,
  normCapacity,
  normFold,
  normProjectNames,
  normSizing,
  normSpendMap,
  planCardsHtml,
  sizingSectionHtml,
  splitSectionHtml,
  topologySectionHtml,
  topologySpend,
} from "../../insights-html.mjs";
import { renderWhatIf } from "../../render.mjs";
import { OUTCOME_WORD_OF, SPEND_TITLE } from "../../words.mjs";
import { html, trustedRenderer } from "../html.mjs";
import { titled } from "./common.mjs";

// ---- insights --------------------------------------------------------------------------------------------------------

/** The spend window's choices, in the order the picker shows them, and the one a bare `/insights` shows. */
export const INSIGHTS_RANGES = Object.freeze(["7d", "30d", "mtd"]);
export const INSIGHTS_DEFAULT_RANGE = "30d";

/**
 * Whether this view draws full local folder paths: `?paths=full`, and the OPERATOR role. A viewer always gets
 * basenames, whatever the query says: a host's directory layout is host detail (`../panels.mjs`'s PATHS rule),
 * and the console reads the data once for both roles (`loadPageData` asks the assembly for full paths only on an
 * operator's request, so a viewer's page never even holds them).
 */
export function insightsFullPaths(view) {
  return view?.role === "operator" && view?.query?.paths === "full";
}

/** An `/insights` link for this view's query with `over` laid on it (a null value drops the key). */
function insightsHref(view, over) {
  const q = view?.query ?? {};
  const merged = { range: q.range ?? INSIGHTS_DEFAULT_RANGE, whatif: q.whatif ?? null, flow: q.flow ?? null, paths: q.paths ?? null, ...over };
  const p = new URLSearchParams();
  for (const k of ["range", "whatif", "flow", "paths"]) if (merged[k] !== null && merged[k] !== undefined) p.set(k, merged[k]);
  return `/insights?${p}`;
}

export function insightsRange(view) {
  const cur = view.query?.range ?? INSIGHTS_DEFAULT_RANGE;
  const ranges = html`<ul class="range">${INSIGHTS_RANGES.map((r) => html`<li><a href="${insightsHref(view, { range: r })}"${r === cur ? html` aria-current="page"` : null}>${insightsWindowLabel(r)}</a></li>`)}</ul>`;
  // The paths toggle is drawn for an operator alone; a viewer who asked for full paths is told why they are not shown.
  let paths = null;
  if (view.role === "operator") paths = insightsFullPaths(view) ? html`<p class="note">Folder labels show full local paths. <a href="${insightsHref(view, { paths: null })}">Show folder names only</a></p>` : html`<p class="note">Folder labels show folder names only. <a href="${insightsHref(view, { paths: "full" })}">Show full local paths</a></p>`;
  else if (view.query?.paths === "full") paths = html`<p class="note">Full local paths are shown to operators only; folder labels show folder names.</p>`;
  return titled("Spend window", html`${ranges}${paths}`);
}

/** `fn()`, or `fallback` when it throws: a hostile slice takes its own section down and nothing else. */
function guarded(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Multi-line text as a fragment that keeps its newlines: `html` scrubs a newline inside a value like any control byte,
 * so each line is its own value and the newline between two is the template's own.
 */
function linesHtml(text) {
  return typeof text === "string" ? text.split("\n").map((line, i) => (i === 0 ? html`${line}` : html`\n${line}`)) : null;
}

/**
 * The minted scene ids the node list may carry: a chip (`n3`) as an item's own id and in its neighbours, a wire (`w12`)
 * in its wires. The page script applies the same two rules again on reading, so the list and its reader agree.
 */
const NODE_ID_RE = /^n\d{1,6}$/;
const WIRE_ID_RE = /^w\d{1,6}$/;

/**
 * The topology's per-node data as a hidden list, one `<li>` per chip: its minted id, its neighbours and wires, and its
 * tooltip as escaped text. The offline page embedded this as a JSON literal in an inline script; the console's CSP
 * refuses inline script, and an escaped list is data no browser executes, so console.js reads it with `textContent`
 * and `getAttribute` (the `#insights-tips` rule). An id outside its rule is left out, though the scene mints nothing
 * else. Exported for its tests.
 */
export function graphNodesHtml(scene) {
  const nodes = scene?.graphData?.nodes ?? {};
  const ids = Object.keys(nodes).filter((id) => NODE_ID_RE.test(id)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const list = (xs, re) => (Array.isArray(xs) ? xs.filter((x) => typeof x === "string" && re.test(x)).join(" ") : "");
  // A tooltip is several lines (the box keeps them, `white-space:pre-line`).
  return html`<ol id="graph-nodes" class="hidden-tips" hidden>${ids.map((id) => html`<li data-id="${id}"${Number.isSafeInteger(nodes[id].triggerIndex) && nodes[id].triggerIndex >= 0 ? html` data-trigger-index="${nodes[id].triggerIndex}"` : null} data-nb="${list(nodes[id].nb, NODE_ID_RE)}" data-w="${list(nodes[id].w, WIRE_ID_RE)}">${linesHtml(nodes[id].tip)}</li>`)}</ol>`;
}

/**
 * The line that states both windows (the offline page's header line): the spend window, the topology's fixed record
 * window, and what bounds every series. A page that showed one window's numbers beside the other's chips without
 * saying so would let a reader add them up.
 */
function windowsLineHtml(windowLabel, scene) {
  const days = scene?.norm?.caps?.windowDays ?? "?";
  return html`<p id="windows" class="note">spend window: ${windowLabel} · topology: fixed ${String(days)}d record window · series bounded by retention (PI_LOG_RETENTION_DAYS) and the 92-day scan cap</p>`;
}

/**
 * The insights sections, in the offline page's order, from the same section renderers and normalizers: the window
 * line, the banners, the KPIs, budget, split, sizes, capacity, plans, the daily charts, the breakdown, the topology and
 * the footer. The topology is INTERACTIVE (pan, zoom, chip tooltips, label fitting, a breakdown row selecting its
 * chip): console.js does that from `#graph-nodes` and the scene's own markup, never from an inline script. The chart
 * tooltips the renderers push onto `tips` are listed, escaped, in a hidden `#insights-tips` list, which console.js shows
 * in the page's tooltip box. `fullPaths` widens the topology's folder labels (`insightsFullPaths` decides it).
 */
export function insightsBody(payload, nowMs, { fullPaths = false } = {}) {
  const p = payload !== null && typeof payload === "object" ? payload : {};
  const scene = buildGraphScene(p.graph, { now: nowMs, fullPaths: fullPaths === true, outcomeWords: OUTCOME_WORD_OF });
  const nf = guarded(() => normFold(p.fold), null);
  const spend = nf === null ? null : guarded(() => normSpendMap(p.costByTrigger), null);
  const nb = guarded(() => normBudget(p.budget), null);
  const na = guarded(() => normAllocation(p.allocation), null);
  const names = guarded(() => normProjectNames(p.projects), new Map());
  const ns = guarded(() => normSizing(p.sizing), null);
  const nc = guarded(() => normCapacity(p.capacity), { unreachable: "the capacity slice is not readable" });
  const windowLabel = insightsWindowLabel(p.window);
  const { minted, html: spendHtml } = topologySpend(scene, spend);
  const tips = [];
  const R = trustedRenderer;
  const parts = [windowsLineHtml(windowLabel, scene), R(bannersHtml(scene.norm)), R(costBannersHtml(p, nf, nb, na))];
  if (nf !== null) parts.push(html`<section>${R(kpisHtml(nf))}</section>`);
  parts.push(html`<section><h2>budget</h2>${R(budgetSectionHtml(nb))}</section>`);
  if (na !== null) parts.push(html`<section><h2>budget split</h2>${R(splitSectionHtml(na, tips, names, windowLabel))}</section>`);
  if (ns !== null) parts.push(html`<section><h2>job sizes</h2>${R(sizingSectionHtml(ns, tips, scene.nowMs))}</section>`);
  if (nc !== null) {
    const capacity = guarded(() => capacitySectionHtml(nc, tips, scene.nowMs, windowLabel), null);
    parts.push(html`<section><h2>capacity</h2>${capacity === null ? html`<p class="note">capacity not drawn: the slice is not readable. ${INSIGHTS_CAPACITY_JOBS_ONLY}</p>` : R(capacity)}</section>`);
  }
  if (nf !== null) {
    if (nf.plans.length > 0) parts.push(html`<section><h2>plans</h2>${R(planCardsHtml(nf.plans))}</section>`);
    parts.push(html`<section><h2>daily spend</h2>${R(dailyChartHtml(nf.daily, tips))}${R(cumulativeHtml(nf.daily, tips))}</section>`);
    const flows = flowLinesHtml(nf, tips);
    if (flows !== null) parts.push(html`<section><h2>daily spend by flow</h2>${R(flows)}</section>`);
    parts.push(html`<section><h2>breakdown</h2>${R(breakdownHtml(nf, minted, tips, names))}</section>`);
  } else {
    parts.push(html`<section><p class="note">No cost data could be read for this window.</p></section>`);
  }
  parts.push(R(topologySectionHtml(scene, spendHtml)));
  if (nf !== null) parts.push(R(footerHtml(nf, windowLabel)));
  return html`${parts}${graphNodesHtml(scene)}<ol id="insights-tips" class="hidden-tips" hidden>${tips.map((t) => html`<li>${t}</li>`)}</ol>`;
}

export function insightsPanel(view) {
  const d = view.data ?? {};
  if (d.insightsError) return titled(SPEND_TITLE, html`<p class="warn">${d.insightsError}</p>`);
  return html`<h2>${SPEND_TITLE}, ${insightsWindowLabel(view.query?.range ?? INSIGHTS_DEFAULT_RANGE)}</h2>${insightsBody(d.insights, view.now, { fullPaths: insightsFullPaths(view) })}`;
}

/** The flows the what-if form suggests: the window's flows from the fold, in the skill-name charset, sorted. */
function whatIfFlows(payload) {
  const rows = Array.isArray(payload?.fold?.byFlow) ? payload.fold.byFlow : [];
  const out = new Set();
  for (const r of rows) if (typeof r?.flow === "string" && WHATIF_FLOW_RE.test(r.flow)) out.add(r.flow);
  return [...out].sort();
}

/** A flow name, the worker's skill charset (`SKILL_NAME_RE`), restated for the datalist and held to it by a test. */
export const WHATIF_FLOW_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/**
 * The what-if panel (REQ-COST-ANALYTICS): a GET form back to `/insights` (the range and the paths choice ride along as
 * hidden fields), with the priced model ids and the window's flows as datalists, and the answer for the page's
 * `whatif` and `flow`. A read for every role, so no `data-action` and no ticket: the browser submits it as a plain
 * navigation. The answer is the old command's text (`renderWhatIf`), escaped in a `<pre>`; an unknown model lists the
 * closest priced ids as links that ask again.
 */
export function insightsWhatIf(view) {
  const d = view.data ?? {};
  const q = view.query ?? {};
  const models = Array.isArray(d.pricedModels) ? d.pricedModels : [];
  const flows = whatIfFlows(d.insights);
  const hidden = [["range", q.range ?? INSIGHTS_DEFAULT_RANGE], ...(q.paths === "full" ? [["paths", "full"]] : [])];
  const form = html`<form class="filters" method="get" action="/insights">${hidden.map(([n, v]) => html`<input type="hidden" name="${n}" value="${v}">`)}<label>Model (provider/model)<input name="whatif" list="whatif-models" required maxlength="193" spellcheck="false" autocomplete="off" value="${q.whatif ?? ""}"></label><label>Flow<input name="flow" list="whatif-flows" required maxlength="64" spellcheck="false" autocomplete="off" value="${q.flow ?? ""}"></label><div class="actions"><button type="submit">Estimate</button></div></form><datalist id="whatif-models">${models.map((m) => html`<option value="${m}">`)}</datalist><datalist id="whatif-flows">${flows.map((f) => html`<option value="${f}">`)}</datalist>`;
  const w = d.whatIf;
  let answer = null;
  if (w && typeof w === "object") {
    if (w.unknown) {
      const near = Array.isArray(w.near) ? w.near : [];
      answer = html`<p class="warn">Unknown model: <span class="mono">${w.model}</span>. The pricing tables cannot price it.</p>${near.length > 0 ? html`<p class="note">Closest priced ids:</p><ul class="plain">${near.map((m) => html`<li><a class="mono" href="${insightsHref(view, { whatif: m })}">${m}</a></li>`)}</ul>` : html`<p class="note">No priced id resembles it.</p>`}`;
    } else if (typeof w.unreachable === "string") {
      answer = html`<p class="warn">The run records could not be read, so there is nothing to estimate from. The console's log has the reason.</p>`;
    } else if (w.result) {
      answer = html`<pre class="answer">${linesHtml(renderWhatIf(w.result, { flow: w.flow, target: w.model }))}</pre>`;
    }
  }
  return titled("What if", html`<p class="note">What would one flow cost per run on another model? The median of the flow's ledgered runs in the last 92 days, re-priced at the model's rates, whatever the window above.</p>${form}${answer}`);
}
