/**
 * The console's panels (issue #641, REQ-OPERATOR-CONSOLE-SCREENS): one pure renderer per region of a screen, each
 * `(view) -> SafeHtml` where `view` is `{ data, role, query, env, now }` and `data` is what `loadPageData` read. A screen
 * is a list of these (`pages.mjs`), and the SAME renderer serves the page load and every live update, so a panel the
 * stream swaps in is byte for byte the panel a reload would draw.
 *
 * PURE AND DETERMINISTIC: no I/O, no clock (`now` comes from the data, so a page is a function of `(data, now)`), no
 * randomness. Every value goes through the `html` template, which scrubs control bytes and escapes; the one exception is
 * the insights section renderers' output, admitted through `trustedRenderer` (see html.mjs).
 *
 * THE ROLE AND RUN-TEXT RULE (REQ-CONSOLE-SECURITY clause l). The run record holds no free text by construction; the
 * strings in it that a forge payload can shape (`jobId`, `target`, `parentJobId`) are escaped like every value and are
 * only ever placed as text or inside a URL this module encodes. BullMQ's `failedReason` IS free text (an error message),
 * so it is rendered only for the operator role, and only inside a per-job `<details>` element below the failed list,
 * never in a list row. A viewer's page carries none of it.
 *
 * THE ACTION CONTROLS (issue #642). A form per action (`<form data-action="<name>">`, `actions.mjs`'s table), drawn only
 * for an operator on a console that is not read-only (`canAct`), so a viewer's page and a read-only console's are what
 * they were. A form holds hidden fields and plain inputs, never a handler; `/static/console.js` posts it as JSON to
 * `/api/act/<name>/preview` and swaps the server's escaped preview into the form's own `[data-preview]` element. The
 * server refuses every write a viewer or a read-only console sends anyway; hiding the controls only spares the click.
 *
 * PATHS. A local folder, a skills directory or a folder scope is shown by its basename (the panel's and the insights
 * page's rule): a console page may be read on another machine, and a host's directory layout is not its business.
 */
import { formatMicros } from "@edgehero/pi-dispatch/money";
import { classifyRow } from "../costs.mjs";
import { bannersHtml, buildGraphScene } from "../graph-html.mjs";
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
} from "../insights-html.mjs";
import { fmtCost } from "../panel.mjs";
import { forgeLinkOf, secretProfileNames } from "../read-model.mjs";
import { RUN_FILTER_FIELDS } from "../run-filter.mjs";
import { html, trustedRenderer } from "./html.mjs";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- formatting ------------------------------------------------------------------------------------------------------

/** A value as cell text: `-` for nothing. */
function cell(v) {
  return v === null || v === undefined || v === "" ? "-" : v;
}

/** A duration in the panel's words (`45s`, `12m`, `3h 5m`, `2d 4h`), or "unknown" for a value that is not one. */
export function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < MIN) return `${Math.floor(ms / SEC)}s`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MIN)}m`;
  return `${Math.floor(ms / DAY)}d ${Math.floor((ms % DAY) / HOUR)}h`;
}

/** An instant as `YYYY-MM-DD HH:MM UTC` (never the reader's zone, so a page is the same bytes everywhere). */
export function utcText(ms) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "unknown";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A record's ISO instant as millis, or NaN. */
const msOf = (iso) => (typeof iso === "string" ? Date.parse(iso) : Number.NaN);

/** Micro-dollars as `$1.20`, `-` for a value that is not an amount. */
export function usdText(micros) {
  return Number.isSafeInteger(micros) && micros >= 0 ? `$${formatMicros(micros)}` : "-";
}

/** A whole number with thousands separators (fixed to `en-US`, so not the host's locale). */
function count(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-";
}

/** A path shown by its basename; anything that is not a path is shown as it is. */
export function shownPath(v) {
  if (typeof v !== "string" || !(v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v))) return v;
  // Either separator: a deployment on Windows writes its folders with backslashes, which `basename` here would not split.
  return `.../${v.split(/[\\/]/).filter(Boolean).pop() ?? ""}`;
}

/**
 * A run id as the worker mints them (`gh-…`, `repeat:<id>:<ms>`, a uuid), the read model's own charset, bounded: what
 * `/run?id=` takes (`parsePageQuery`) and so what a run link may carry.
 */
export const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * A link to one run's detail page. The id travels in the query string, encoded, and is escaped as text. An id outside
 * `RUN_ID_RE` (a hand-written or foreign mirror record) is shown as plain escaped text: `/run` would answer it 400.
 */
function runLink(jobId) {
  if (jobId === null || jobId === undefined || jobId === "") return "-";
  if (!RUN_ID_RE.test(String(jobId))) return html`<span class="mono">${cell(jobId)}</span>`;
  return html`<a class="mono" href="${`/run?${new URLSearchParams({ id: String(jobId) })}`}">${String(jobId)}</a>`;
}

/**
 * A record's target, linked to the forge when `forgeLinkOf` can build a link from the deployment's own env, else plain
 * text. `rel="noreferrer noopener"` with `target="_blank"`: the forge page gets no handle on this window and no Referer.
 */
function targetLink(record, env) {
  const target = record?.target;
  if (typeof target !== "string" || target === "") return "-";
  const url = forgeLinkOf(record, env ?? {});
  // forgeLinkOf only builds http(s) URLs; this belt keeps any other scheme out of an href whatever it returns.
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return html`<span class="mono">${target}</span>`;
  return html`<a class="mono" href="${url}" rel="noreferrer noopener" target="_blank">${target}</a>`;
}

/** A panel's heading plus body. */
const titled = (title, body) => html`<h2>${title}</h2>${body}`;

// ---- action forms (issue #642) ---------------------------------------------------------------------------------------

/** Whether this view draws write controls: an operator, on a console that is not read-only. */
export const canAct = (view) => view?.role === "operator" && !view?.readOnly;

/**
 * One action's form: hidden fields (`[name, value, type?]`), the visible controls, the submit button, and the
 * `[data-preview]` element the script fills with the server's preview. `type` is how the script reads a value
 * (`int`, `json`, `list`; text by default).
 */
function actForm(action, { hidden = [], fields = null, label, cls = "act" }) {
  return html`<form class="${cls}" data-action="${action}" autocomplete="off">${hidden.map(([k, v, type]) => html`<input type="hidden" name="${k}" value="${String(v)}"${type ? html` data-type="${type}"` : null}>`)}${fields}<button type="submit">${label}</button><div class="preview-area" data-preview hidden></div></form>`;
}

/** A labelled text input; `type` as `actForm`'s. */
function field(name, label, { type = null, input = "text", required = false, placeholder = null, max = 512 } = {}) {
  return html`<label>${label}<input name="${name}" type="${input}"${type ? html` data-type="${type}"` : null}${required ? html` required` : null}${placeholder ? html` placeholder="${placeholder}"` : null} maxlength="${max}" autocomplete="off" spellcheck="false"></label>`;
}

/** A labelled textarea (a JSON value, an answer, a list of members). */
function area(name, label, { type = null, rows = 4, required = false, placeholder = null, max = 16384 } = {}) {
  return html`<label>${label}<textarea name="${name}" rows="${rows}"${type ? html` data-type="${type}"` : null}${required ? html` required` : null}${placeholder ? html` placeholder="${placeholder}"` : null} maxlength="${max}" spellcheck="false"></textarea></label>`;
}

/** An index field: a whole number, 0 or more (the row number the list shows). */
const indexField = (label = "Row #") => field("index", label, { type: "int", input: "number", required: true, max: 6 });

/** A section's editor: the forms inside a closed `<details>`, so the panel reads as before until it is opened. */
function editor(summary, forms) {
  return html`<details class="editor"><summary>${summary}</summary><div class="forms">${forms}</div></details>`;
}

/** A `<table>` with a caption-free header row; `rows` are already-built `<tr>` fragments. */
function table(label, heads, rows, emptyText) {
  if (rows.length === 0) return html`<p class="note">${emptyText}</p>`;
  return html`<div class="scroll"><table class="grid" aria-label="${label}"><thead><tr>${heads.map((h) => (typeof h === "string" ? html`<th scope="col">${h}</th>` : html`<th scope="col" class="num">${h.num}</th>`))}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** A definition list of `[term, value]` pairs; a null value is left out. */
function facts(pairs) {
  return html`<dl class="facts">${pairs.filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

/** The sentence a panel shows when the snapshot could not be read at all. */
const SNAPSHOT_MISSING = "The deployment's Valkey could not be read, so this panel has nothing to show. The next refresh tries again.";

/** Wrap a snapshot panel: the fixed sentence when there is no snapshot, else the renderer. */
function fromSnapshot(title, render) {
  return (view) => {
    const snap = view.data?.snapshot;
    if (!snap) return titled(title, html`<p class="warn">${SNAPSHOT_MISSING}</p>`);
    return titled(title, render(snap, view));
  };
}

// ---- cost ------------------------------------------------------------------------------------------------------------

/**
 * One run's typed cost, `{ usd, class, floor, planId }`, by the cost fold's own classifier (`classifyRow`): per ledger
 * row when the record has a usage ledger, else one row from the host-effective provider and model. A run whose rows all
 * share a class keeps it; mixed classes read as an estimate. A fallback-metered run (`metered: false`) is a floor. Null
 * when the run measured nothing (no `tokens`). The pricing table is not consulted (`classifyRow` needs it only for a
 * cost that is not a number), so this needs no pi.
 */
export function runCost(record, subscriptions = []) {
  const tokens = record?.tokens;
  if (tokens === null || typeof tokens !== "object") return null;
  const ledger = Array.isArray(record.usage?.models) && record.usage.models.length > 0 ? record.usage.models : null;
  const models = ledger ?? [{ provider: record.provider ?? "unknown", model: record.model ?? "unknown", cost: tokens.cost }];
  const rows = models.map((m) => {
    const row = { provider: m?.provider ?? "unknown", model: m?.model ?? "unknown", cost: typeof m?.cost === "number" && Number.isFinite(m.cost) ? m.cost : 0 };
    return { ...row, ...classifyRow(row, subscriptions, null) };
  });
  const floor = tokens.metered === false;
  const usd = rows.reduce((s, r) => s + (r.class === "plan" ? 0 : r.cost), 0);
  const classes = [...new Set(rows.map((r) => r.class))];
  if (classes.length === 1 && classes[0] === "plan") {
    const ids = [...new Set(rows.map((r) => r.planId))];
    if (ids.length === 1 && !floor) return { usd: 0, class: "plan", floor: false, planId: ids[0] };
    return { usd, class: "estimated", floor };
  }
  if (classes.length === 1) return { usd, class: classes[0], floor, planId: null };
  return { usd, class: "estimated", floor, planId: null };
}

/** A typed cost as text (`fmtCost`'s shapes), or "not metered" for a run that measured nothing. */
function costText(cost) {
  return cost ? fmtCost(cost) : "not metered";
}

/** The per-job dollar cap a run was held to: what it reserved, else the cap its exit line names. */
function capMicrosOf(record) {
  const reserved = record?.dollars?.reservedMicros;
  if (Number.isSafeInteger(reserved)) return reserved;
  const cap = record?.tokens?.costCapMicros;
  return Number.isSafeInteger(cap) ? cap : null;
}

// ---- the page header -------------------------------------------------------------------------------------------------

/**
 * The navigation, with `aria-current="page"` on the screen shown (the run detail counts as Runs). The audit screen is
 * listed only for the operator: a viewer is refused it, and a link that answers 403 is a dead end.
 */
export function navHtml(pages, current, role) {
  const here = current === "run" ? "runs" : current;
  const items = Object.entries(pages).filter(([name, p]) => p.nav && (p.auth !== "operator" || role === "operator"));
  return html`<nav aria-label="Console screens"><ul>${items.map(([name, p]) => html`<li><a href="${p.path}"${name === here ? html` aria-current="page"` : null}>${p.nav}</a></li>`)}</ul></nav>`;
}

// ---- overview --------------------------------------------------------------------------------------------------------

/** Paused, partly paused or running, as words and a class. */
function pausedState(q) {
  if (q?.pausedState) return html`<span class="bad">paused (the kill switch is on)</span>`;
  if (q?.pausedPartial) return html`<span class="warn">partly paused: some hosts' queues are paused and others are not</span>`;
  return html`<span class="good">running</span>`;
}

export const overviewState = fromSnapshot("Fleet", (s) => {
  const q = s.queue ?? {};
  const c = q.counts ?? {};
  return html`${facts([
    ["Queue", pausedState(q)],
    ["Workers", cell(q.workers)],
    ["Queues", cell(q.queues)],
    ["Waiting", count(c.waiting ?? 0)],
    ["Active", count(c.active ?? 0)],
    ["Delayed", count(c.delayed ?? 0)],
    ["Failed (kept by the queue)", count(c.failed ?? 0)],
  ])}${q.fleetDegraded ? html`<p class="warn">The host registry could not be read; this shows the fleet as it was last seen.</p>` : null}`;
});

/** A host's last beat as an age, with a warning class once it is more than a minute old. */
function beatCell(staleMs) {
  if (!Number.isSafeInteger(staleMs)) return html`<td>unknown</td>`;
  return staleMs > MIN ? html`<td class="warn">${ageText(staleMs)} ago</td>` : html`<td>${ageText(staleMs)} ago</td>`;
}

export const overviewHosts = fromSnapshot("Hosts online", (s) => {
  const hosts = Array.isArray(s.hostBudgets) ? s.hostBudgets : [];
  return table(
    "Hosts online",
    ["Host", { num: "Slots" }, { num: "Running" }, "Last beat"],
    hosts.map((h) => html`<tr><td>${cell(h.name)}</td><td class="num">${cell(h.concurrency)}</td><td class="num">${Array.isArray(h.jobs) ? h.jobs.filter((j) => !j.o).length : "unknown"}</td>${beatCell(h.staleMs)}</tr>`),
    "No host is registered. A worker registers when it starts.",
  );
});

/** The count windows: `[label, reserved key, overlay cap key]`. */
const COUNT_WINDOWS = Object.freeze([
  ["Today", "day", "dailyCap"],
  ["This week", "week", "weeklyCap"],
  ["This month", "month", "monthlyCap"],
]);

/** A dollar window's name as a page shows it. */
function dollarWindowName(row) {
  if (row.ledger === "deployment") return "deployment";
  if (row.ledger === "model") return `model ${row.name}`;
  return shownPath(row.name);
}

/** The count and token caps against what is reserved, and every dollar window against its cap. */
function spendBody(s) {
  const overlay = s.settings?.overlay ?? {};
  const b = s.budget ?? {};
  const capOf = (v) => (Number.isInteger(v) ? count(v) : "not set");
  const countRows = COUNT_WINDOWS.map(([label, key, capKey]) => html`<tr><td>${label}</td><td class="num">${count(Number(b[key] ?? 0))}</td><td class="num">${capOf(overlay[capKey])}</td></tr>`);
  countRows.push(html`<tr><td>Tokens today</td><td class="num">${count(Number(b.tokensToday ?? 0))}</td><td class="num">${capOf(overlay.dailyTokenCap)}</td></tr>`);
  const counts = table("Job and token windows", ["Window", { num: "Reserved" }, { num: "Cap" }], countRows, "");
  const d = s.dollars;
  let dollars;
  if (!d) dollars = html`<p class="note">No dollar window is set.</p>`;
  else {
    const rows = (Array.isArray(d.rows) ? d.rows : []).map((r) => html`<tr${r.full ? html` class="warn"` : null}><td>${dollarWindowName(r)}</td><td>${cell(r.window)}</td><td class="num">${r.counterMicros === null ? "unread" : usdText(r.counterMicros)}</td><td class="num">${usdText(r.capMicros)}</td><td>${r.full ? "full" : "open"}</td></tr>`);
    dollars = html`${d.unreachable ? html`<p class="warn">The dollar counters could not be read.</p>` : null}${Array.isArray(d.invalid) && d.invalid.length > 0 ? html`<p class="warn">Not a dollar amount: ${d.invalid.join(", ")}</p>` : null}${table("Dollar windows", ["Window", "Period", { num: "Spent and held" }, { num: "Cap" }, "State"], rows, "No dollar window is set.")}`;
  }
  return html`${counts}<h3>Dollars</h3>${dollars}`;
}

export const overviewSpend = fromSnapshot("Spend against caps", (s) => spendBody(s));

export const overviewParked = fromSnapshot("Parked, waiting for a person", (s) => {
  if (s.parkedUnreachable) return html`<p class="warn">The parked runs could not be read (${s.parkedUnreachable}), so how many wait is unknown.</p>`;
  const n = Array.isArray(s.parked) ? s.parked.length : 0;
  return html`<p><span class="big">${count(n)}</span> ${n === 1 ? "run is" : "runs are"} waiting for an answer. <a href="/parked">Open the parked inbox</a></p>`;
});

export const overviewFailures = fromSnapshot("Failures in the last 24 hours", (s) => {
  if (s.failures24h === null || s.failures24h === undefined) return html`<p class="warn">The run history could not be read.</p>`;
  const n = s.failures24h;
  return html`<p><span class="big${n > 0 ? " warn" : ""}">${s.failures24hFloor ? "at least " : ""}${count(n)}</span> failed ${n === 1 ? "run" : "runs"}.${s.failures24hFloor ? html` <span class="note">Every run read was inside the day, so there may be more.</span>` : null} <a href="${`/runs?${new URLSearchParams({ outcome: "failed" })}`}">See failed runs</a></p>`;
});

/** The active jobs, newest start first, as the overview and the fleet screen list them; `act` adds a cancel per row. */
function activeTable(s, now, act = false) {
  const rows = (Array.isArray(s.active) ? [...s.active] : []).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const cancel = (j) => (act && typeof j.jobId === "string" && RUN_ID_RE.test(j.jobId) ? html`<td>${actForm("cancel-active", { hidden: [["jobId", j.jobId]], label: "Cancel" })}</td>` : act ? html`<td>-</td>` : null);
  return table(
    "Active jobs",
    ["Job", "Queue", "Host", "Started", "Running for", ...(act ? ["Action"] : [])],
    rows.map((j) => html`<tr><td>${runLink(j.jobId)}</td><td>${cell(j.queue)}</td><td>${cell(j.host)}</td><td>${j.startedAt ? utcText(j.startedAt) : "-"}</td><td>${j.startedAt ? ageText(now - j.startedAt) : "-"}</td>${cancel(j)}</tr>`),
    "Nothing is running.",
  );
}

export const overviewActive = fromSnapshot("Active jobs", (s, view) => activeTable(s, view.now));

// ---- runs ------------------------------------------------------------------------------------------------------------

/** What each filter field is called on the form. */
const FILTER_LABELS = Object.freeze({ repo: "Repository", kind: "Forge", flow: "Flow", trigger: "Trigger", project: "Project", host: "Host", outcome: "Outcome", reason: "Reason", model: "Model", q: "Target contains" });

/** The runs filter, a plain GET form: it works without the script, and its values are the query's, escaped. */
export function runsFilter(view) {
  const f = view.query?.filter ?? {};
  const set = RUN_FILTER_FIELDS.some((k) => f[k] !== undefined);
  return titled(
    "Filter",
    html`<form class="filters" method="get" action="/runs">${RUN_FILTER_FIELDS.map((k) => html`<label for="${`f-${k}`}">${FILTER_LABELS[k] ?? k}<input id="${`f-${k}`}" name="${k}" type="text" maxlength="200" autocomplete="off" spellcheck="false" value="${f[k] ?? ""}"></label>`)}<div class="actions"><button type="submit">Apply</button>${set ? html`<a href="/runs">Clear</a>` : null}</div></form>`,
  );
}

/** The query string of a runs page with `extra` set: the filter carried, so paging keeps it. */
function runsHref(filter, extra = {}) {
  const p = new URLSearchParams();
  for (const k of RUN_FILTER_FIELDS) if (filter?.[k] !== undefined) p.set(k, filter[k]);
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const qs = p.toString();
  return qs === "" ? "/runs" : `/runs?${qs}`;
}

/** One run as a table row. */
function runRow(r, env, subscriptions) {
  const at = msOf(r.endedAt ?? r.startedAt);
  const outcome = [r.outcome, r.reason].filter((x) => typeof x === "string" && x !== "").join(" / ");
  const failed = r.outcome === "failed";
  return html`<tr><td>${utcText(at)}</td><td>${runLink(r.jobId)}</td><td>${targetLink(r, env)}</td><td>${cell(r.flow)}</td><td>${cell(r.host)}</td><td${failed ? html` class="bad"` : null}>${cell(outcome)}</td><td>${cell(r.model)}</td><td class="num">${Number.isFinite(r.tokens?.total) ? count(r.tokens.total) : "-"}</td><td class="num">${costText(runCost(r, subscriptions))}</td><td class="num">${usdText(capMicrosOf(r))}</td></tr>`;
}

export function runsTable(view) {
  const page = view.data?.runsPage;
  const filter = view.query?.filter ?? {};
  if (!page) return titled("Runs", html`<p class="warn">The run history could not be read.</p>`);
  if (page.refusal) return titled("Runs", html`<p class="warn">${page.refusal}</p>`);
  const subs = Array.isArray(view.data.subscriptions) ? view.data.subscriptions : [];
  const runs = Array.isArray(page.runs) ? page.runs : [];
  const notes = [];
  if (page.unreachable) notes.push(html`<p class="warn">This host's run history could not be read.</p>`);
  if (page.mirror === "off") notes.push(html`<p class="note">Showing this host's runs: the fleet's run mirror is off.</p>`);
  else if (page.mirror && page.mirror !== "ok") notes.push(html`<p class="warn">Other hosts' runs could not be read; showing this host's.</p>`);
  if (page.truncated) notes.push(html`<p class="note">Stopped after examining ${count(page.examined)} runs; the next page continues from there.</p>`);
  const pager = html`<div class="pager">${view.query?.before !== undefined && view.query?.before !== null ? html`<a href="${runsHref(filter)}">Newest runs</a>` : null}${page.next !== null && page.next !== undefined ? html`<a href="${runsHref(filter, { before: page.next })}">Older runs</a>` : null}</div>`;
  return titled(
    "Runs",
    html`${notes}${table("Runs", ["When", "Job", "Target", "Flow", "Host", "Outcome", "Model", { num: "Tokens" }, { num: "Cost" }, { num: "Job cap" }], runs.map((r) => runRow(r, view.env, subs)), "No run matches.")}${pager}`,
  );
}

// ---- run detail ------------------------------------------------------------------------------------------------------

/** The run, or the sentence that replaces every run panel when there is none. */
function withRun(title, render) {
  return (view) => {
    const got = view.data?.run;
    if (!got?.record) {
      const why = got?.invalid ? "That is not a run id." : "No run with that id is in this host's history or the fleet's run mirror.";
      return titled(title, html`<p class="warn">${why}</p>`);
    }
    return titled(title, render(got.record, view, got.source));
  };
}

/**
 * The run detail's operator actions (issue #642): the command that reopens the run's retained workspace on the host
 * (`pi-dispatch sandbox <jobId>`, shown to copy and never run: a browser terminal was rejected, DES-OPERATOR-CONSOLE),
 * and the re-run form, whose preview shows the reserve the worker will hold. A job id outside the run-id charset gets
 * neither: it could not be typed back as one argument.
 */
function runActions(r, view) {
  if (view.role !== "operator" || typeof r.jobId !== "string" || !RUN_ID_RE.test(r.jobId)) return null;
  return html`<h3>Actions</h3><p>Open its retained workspace on the host: <code class="mono">${`pi-dispatch sandbox ${r.jobId}`}</code></p>${canAct(view) ? actForm("rerun", { hidden: [["jobId", r.jobId]], label: "Preview a re-run" }) : null}`;
}

export const runSummary = withRun("Run", (r, view, source) => {
  const started = msOf(r.startedAt);
  const ended = msOf(r.endedAt);
  return html`${facts([
    ["Job", html`<span class="mono">${cell(r.jobId)}</span>`],
    ["Target", targetLink(r, view.env)],
    ["Forge", cell(r.kind)],
    ["Flow", cell(r.flow)],
    ["Outcome", cell(r.outcome)],
    ["Reason", cell(r.reason)],
    ["Detail", r.why ?? null],
    ["Exit code", cell(r.exitCode)],
    ["Attempt", cell(r.attempt)],
    ["Host", cell(r.host)],
    ["Venue", cell(r.backend)],
    ["Project", cell(r.project)],
    ["Provider and model", [r.provider, r.model].filter(Boolean).join(" / ") || "-"],
    ["Turns", cell(r.turns)],
    ["Trigger", r.triggerIndex !== null && r.triggerIndex !== undefined ? `#${r.triggerIndex} (${cell(r.triggerType)})` : "-"],
    ["Replica", Number.isInteger(r.replica) ? `${r.replica} of ${cell(r.replicas)}` : null],
    ["Started", utcText(started)],
    ["Ended", utcText(ended)],
    ["Took", Number.isFinite(started) && Number.isFinite(ended) ? ageText(ended - started) : "-"],
    ["Read from", source === "mirror" ? "the fleet's run mirror" : "this host's run history"],
  ])}${runActions(r, view)}`;
});

export const runCostPanel = withRun("Tokens and dollars", (r, view) => {
  const t = r.tokens ?? null;
  const d = r.dollars ?? null;
  const cost = runCost(r, Array.isArray(view.data.subscriptions) ? view.data.subscriptions : []);
  return facts([
    ["Cost", costText(cost)],
    ["Cost class", cost ? `${cost.class}${cost.floor ? " (a floor: the meter could not see all of it)" : ""}` : "not metered"],
    ["Input tokens", t ? count(t.input) : "-"],
    ["Output tokens", t ? count(t.output) : "-"],
    ["Total tokens", t ? count(t.total) : "-"],
    ["Model calls", t ? cell(t.calls) : "-"],
    ["Job cap", usdText(capMicrosOf(r))],
    ["Reserved", d ? usdText(d.reservedMicros) : "no dollar window applied"],
    ["Settled", d ? `${usdText(d.settledMicros)} (${cell(d.basis)})` : null],
    ["Model window", d?.modelBasis ?? null],
  ]);
});

/** Bytes as MiB. */
const mib = (bytes) => (Number.isFinite(bytes) ? `${count(bytes / (1024 * 1024))} MiB` : "-");

export const runResources = withRun("Resources", (r) => {
  const x = r.resources ?? null;
  const size = r.size ?? null;
  return facts([
    ["Size given", size ? `${count(size.memMiB)} MiB, ${Number.isFinite(size.cpuCenti) ? (size.cpuCenti / 100).toFixed(2) : "-"} CPUs (${cell(size.source)})` : "-"],
    ["Peak memory", x ? mib(x.memPeak) : "not reported"],
    ["Out-of-memory kills", x ? cell(x.oomKills) : null],
    ["CPU time", x && Number.isFinite(x.cpuUsec) ? `${(x.cpuUsec / 1e6).toFixed(1)} s` : null],
    ["Throttled", x && Number.isFinite(x.throttledUsec) ? `${(x.throttledUsec / 1e6).toFixed(1)} s` : null],
    ["Peak processes", x ? cell(x.pidsPeak) : null],
  ]);
});

export const runSession = withRun("Session and plan", (r) => {
  const s = r.session ?? null;
  const p = r.plan ?? null;
  return facts([
    ["Session", s ? (s.resumed ? "resumed" : `fresh (${cell(s.reason)})`) : "this trigger keeps no session"],
    ["Transcript", s && Number.isFinite(s.bytes) ? `${count(s.bytes)} bytes` : null],
    ["Plan", p ? `${cell(p.outcome)}${p.reason ? ` (${p.reason})` : ""}${p.clamped ? ", clamped" : ""}` : "none"],
    ["Plan id", p?.planId ? html`<span class="mono">${p.planId}</span>` : null],
  ]);
});

export const runChain = withRun("Chain", (r, view) => {
  const kids = Array.isArray(view.data?.children) ? view.data.children : [];
  return html`${facts([
    ["Parent", r.parentJobId ? runLink(r.parentJobId) : "none"],
    ["Depth", cell(r.chainDepth)],
    ["Refused chain requests", cell(r.chainRefused)],
  ])}<h3>Children</h3>${kids.length === 0 ? html`<p class="note">No child run among the ${count(view.data?.childrenSearched ?? 0)} newest runs.</p>` : html`<ul class="plain">${kids.map((k) => html`<li>${runLink(k.jobId)} ${cell(k.outcome)}</li>`)}</ul>`}`;
});

// ---- parked ----------------------------------------------------------------------------------------------------------

export const parkedInbox = fromSnapshot("Parked runs", (s, view) => {
  if (s.parkedUnreachable) return html`<p class="warn">The parked runs could not be read (${s.parkedUnreachable}); this is not an empty inbox.</p>`;
  const rows = Array.isArray(s.parked) ? s.parked : [];
  // Issue #642: one answer form per parked run, below the list. The answer is the operator's own words, posted as the
  // reply a forge comment would have been; the preview shows it and the reserve, and the audit keeps only its digest.
  const answerable = canAct(view) ? rows.filter((p) => typeof p.jobId === "string" && RUN_ID_RE.test(p.jobId)) : [];
  const answers = answerable.length === 0 ? null : html`<h3>Answer a parked run</h3>${answerable.map((p) => editor(html`Answer ${cell(p.target)} (${p.jobId})`, actForm("parked-answer", { hidden: [["jobId", p.jobId]], fields: area("text", "Your answer, as the reply on the issue", { rows: 4, required: true, max: 8192 }), label: "Preview the answer" })))}`;
  return html`<p class="note">A parked run asked a question and ended; a reply on its issue or merge request resumes it, and an operator can answer it from here.</p>${table(
    "Parked runs",
    ["Target", "Forge", "Job", "Parked", "Waiting", { num: "Chain" }],
    rows.map((p) => html`<tr><td>${targetLink(p, view.env)}</td><td>${cell(p.kind)}</td><td>${runLink(p.jobId)}</td><td>${utcText(p.parkedAt)}</td><td>${ageText(p.ageMs)}</td><td class="num">${Number.isInteger(p.chainCount) ? p.chainCount : "unknown"}</td></tr>`),
    "Nothing is parked.",
  )}${answers}`;
});

// ---- insights --------------------------------------------------------------------------------------------------------

/** The spend window's choices, in the order the picker shows them. */
export const INSIGHTS_RANGES = Object.freeze(["7d", "30d", "mtd"]);

export function insightsRange(view) {
  const cur = view.query?.range ?? "7d";
  return titled("Spend window", html`<ul class="range">${INSIGHTS_RANGES.map((r) => html`<li><a href="${`/insights?${new URLSearchParams({ range: r })}`}"${r === cur ? html` aria-current="page"` : null}>${insightsWindowLabel(r)}</a></li>`)}</ul>`);
}

/** `fn()`, or `fallback` when it throws: a hostile slice takes its own section down and nothing else (buildInsightsHtml's rule). */
function guarded(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The insights page's sections, in `buildInsightsHtml`'s order, from the same section renderers and normalizers. The
 * page's header, its auto-reload and its script are not drawn: the console has its own header, and its range picker
 * replaces the reload. The topology is drawn STATIC (no pan, zoom or chip tooltip: those are the offline page's inline
 * script, which this CSP refuses); the scene fits its pane by its viewBox. The chart tooltips the renderers push onto
 * `tips` are listed, escaped, in a hidden `#insights-tips` list, which console.js turns into native tooltips.
 */
export function insightsBody(payload, nowMs) {
  const p = payload !== null && typeof payload === "object" ? payload : {};
  const scene = buildGraphScene(p.graph, { now: nowMs, fullPaths: false });
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
  const parts = [R(bannersHtml(scene.norm)), R(costBannersHtml(p, nf, nb, na))];
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
  return html`${parts}<ol id="insights-tips" class="hidden-tips" hidden>${tips.map((t) => html`<li>${t}</li>`)}</ol>`;
}

export function insightsPanel(view) {
  const d = view.data ?? {};
  if (d.insightsError) return titled("Spend and insights", html`<p class="warn">${d.insightsError}</p>`);
  return html`<h2>Spend and insights, ${insightsWindowLabel(view.query?.range ?? "7d")}</h2>${insightsBody(d.insights, view.now)}`;
}

// ---- fleet -----------------------------------------------------------------------------------------------------------

const COUNT_KEYS = Object.freeze(["waiting", "active", "delayed", "paused", "failed"]);

export const fleetQueues = fromSnapshot("Queues", (s, view) => {
  const rows = Array.isArray(s.queueCounts) ? s.queueCounts : [];
  const act = canAct(view);
  // The kill switch for the whole fleet: pause unless it is paused, resume unless it is running (both when partial).
  const q = s.queue ?? {};
  const fleet = act ? html`<div class="bar">${q.pausedState ? null : actForm("fleet-pause", { label: "Pause the fleet" })}${q.pausedState || q.pausedPartial ? actForm("fleet-resume", { label: "Resume the fleet" }) : null}</div>` : null;
  const one = (row) => (act && typeof row.queue === "string" ? html`<td>${actForm(row.paused ? "queue-resume" : "queue-pause", { hidden: [["queue", row.queue]], label: row.paused ? "Resume" : "Pause" })}</td>` : act ? html`<td>-</td>` : null);
  return html`${facts([["Fleet", pausedState(s.queue)]])}${fleet}${table(
    "Queues",
    ["Queue", "State", ...COUNT_KEYS.map((k) => ({ num: k[0].toUpperCase() + k.slice(1) })), ...(act ? ["Action"] : [])],
    rows.map((row) => html`<tr><td class="mono">${cell(row.queue)}</td><td>${row.paused ? "paused" : "running"}</td>${COUNT_KEYS.map((k) => html`<td class="num">${count(row.counts?.[k] ?? 0)}</td>`)}${one(row)}</tr>`),
    "No queue was read.",
  )}`;
});

export const fleetActive = fromSnapshot("Active jobs", (s, view) => activeTable(s, view.now, canAct(view)));

export const fleetHeld = fromSnapshot("Held on a wait", (s, view) => {
  const h = s.held;
  if (!h || h.unreachable) return html`<p class="warn">The held jobs could not be read.</p>`;
  const rows = Array.isArray(h.rows) ? h.rows : [];
  const act = canAct(view);
  const cancel = (r) => (act && typeof r.jobId === "string" && RUN_ID_RE.test(r.jobId) ? html`<td>${actForm("cancel-held", { hidden: [["jobId", r.jobId]], label: "Cancel" })}</td>` : act ? html`<td>-</td>` : null);
  return html`${act && rows.length > 0 ? html`<div class="bar">${actForm("cancel-all-held", { label: "Cancel every held job" })}</div>` : null}${table(
    "Held jobs",
    ["Job", "Target", "Waiting for", "Held for", ...(act ? ["Action"] : [])],
    rows.map((r) => html`<tr><td class="mono">${cell(r.jobId)}</td><td class="mono">${cell(r.target)}</td><td>${cell(r.label)}</td><td>${ageText(r.waitedMs)}</td>${cancel(r)}</tr>`),
    "No job is held.",
  )}${h.more > 0 ? html`<p class="note">${count(h.more)} more held.</p>` : null}${h.truncated ? html`<p class="note">The held set is larger than one read takes; not every member was read.</p>` : null}`;
});

/** A host budget dimension as `used / budget`, `off`, or `-`. */
function budgetText(used, budget, unit) {
  if (budget === "off") return "off";
  if (budget === "" || budget === undefined || budget === null) return "-";
  return unit ? `${cell(used)} / ${budget} ${unit}` : `${cell(used)} / ${budget}`;
}

export const fleetHosts = fromSnapshot("Hosts", (s, view) => {
  const hosts = Array.isArray(s.hostBudgets) ? s.hostBudgets : [];
  return table(
    "Hosts",
    ["Host", { num: "Slots" }, "Memory", "CPU (centi)", { num: "Waiting" }, "Running jobs", "Routes", "Last beat"],
    hosts.map((h) => {
      const jobs = Array.isArray(h.jobs) ? h.jobs : null;
      const list = jobs === null ? (h.jobsUnreadable ? "unreadable" : "-") : jobs.length === 0 ? "none" : html`${jobs.map((j, i) => html`${i > 0 ? ", " : ""}${runLink(j.id)}${j.o ? " (orphaned hold)" : ""}${j.at ? html` <span class="note">${ageText(view.now - j.at)}</span>` : null}`)}${h.jobsMore > 0 ? ` and ${h.jobsMore} more` : ""}`;
      return html`<tr><td>${cell(h.name)}</td><td class="num">${cell(h.concurrency)}</td><td>${budgetText(h.usedMemMiB, h.budgetMemMiB, "MiB")}</td><td>${budgetText(h.usedCpuCenti, h.budgetCpuCenti, null)}</td><td class="num">${cell(h.waiters)}</td><td>${list}</td><td>${h.routes === false || h.routes === "false" ? "no" : "yes"}</td>${beatCell(h.staleMs)}</tr>`;
    }),
    "No host is registered.",
  );
});

export const fleetSchedulers = fromSnapshot("Schedules", (s, view) => {
  const list = Array.isArray(s.schedulers) ? s.schedulers : [];
  const stalls = s.schedulerStalls ?? {};
  const max = s.schedulerStallMax;
  return table(
    "Schedules",
    ["Schedule", "Pattern", "Next", "Overdue", { num: "Stalls" }],
    list.map((x) => {
      const id = x.name ?? x.key;
      const n = Number(stalls[id] ?? 0);
      return html`<tr><td class="mono">${cell(id)}</td><td class="mono">${cell(x.pattern ?? (x.every ? `every ${x.every} ms` : null))}</td><td>${x.next !== null && x.next !== undefined ? utcText(x.next) : "-"}</td><td${x.overdueMs ? html` class="warn"` : null}>${x.overdueMs ? ageText(x.overdueMs) : "no"}</td><td class="num${n > 0 ? " warn" : ""}">${n}${Number.isInteger(max) ? ` / ${max}` : ""}</td></tr>`;
    }),
    "No schedule is registered.",
  );
});

export const fleetFailed = fromSnapshot("Failed jobs", (s, view) => {
  const f = s.failed;
  if (!f || f.unreachable) return html`<p class="warn">The failed jobs could not be read.</p>`;
  const rows = Array.isArray(f.rows) ? f.rows : [];
  const operator = view.role === "operator";
  // The list carries ids, queues, counts and instants only. The reason is free text (REQ-CONSOLE-SECURITY clause l):
  // the operator sees it in one detail element per job below the list, a viewer never.
  const details = operator && rows.length > 0 ? html`<h3>Why each failed</h3>${rows.map((r) => html`<details><summary class="mono">${cell(r.jobId)}</summary><p class="mono">${cell(r.failedReason)}</p></details>`)}` : null;
  const act = canAct(view);
  const jobForms = (r) => {
    if (!act) return null;
    if (typeof r.jobId !== "string" || !RUN_ID_RE.test(r.jobId)) return html`<td>-</td>`;
    const hidden = [["jobId", r.jobId], ...(typeof r.queue === "string" ? [["queue", r.queue]] : [])];
    return html`<td class="acts">${actForm("retry-failed", { hidden, label: "Retry" })}${actForm("remove-failed", { hidden, label: "Remove" })}</td>`;
  };
  // The bulk bar: every failed job (at most 100 per action), optionally one queue's or one repository's.
  const filters = html`${field("queue", "Only queue", { max: 200 })}${field("repo", "Only repository", { placeholder: "owner/name", max: 512 })}`;
  const bulk = act && rows.length > 0 ? editor("Retry or remove failed jobs in bulk", html`${actForm("retry-all-failed", { fields: filters, label: "Preview retry of all" })}${actForm("remove-all-failed", { fields: filters, label: "Preview removal of all" })}`) : null;
  return html`${table(
    "Failed jobs",
    ["Job", "Queue", { num: "Attempts" }, "Failed", ...(act ? ["Action"] : [])],
    rows.map((r) => html`<tr><td class="mono">${cell(r.jobId)}</td><td class="mono">${cell(r.queue)}</td><td class="num">${cell(r.attemptsMade)}</td><td>${r.endedAt ? utcText(r.endedAt) : "-"}</td>${jobForms(r)}</tr>`),
    "No failed job is kept by the queue.",
  )}${bulk}${f.more > 0 ? html`<p class="note">${count(f.more)} more failed.</p>` : null}${operator ? details : html`<p class="note">Failure reasons are shown to operators only.</p>`}`;
});

// ---- configuration ---------------------------------------------------------------------------------------------------

/** A file view's trouble as one sentence (no parser message: it names the host's path), or null when it loaded. */
function fileTrouble(v, what) {
  if (!v) return `The ${what} could not be read.`;
  if (v.unset) return `No ${what} is configured.`;
  if (v.missing) return `The ${what} does not exist.`;
  if (v.invalid) return `The ${what} does not load; run pi-dispatch doctor for the reason.`;
  if (v.unreadable) return `The ${what} cannot be read (${String(v.unreadable)}).`;
  return null;
}

/** A trigger's selector, in the triggers file's own words. */
function triggerOn(t) {
  const list = (name, v) => (Array.isArray(v) && v.length > 0 ? `${name} ${v.join(", ")}` : null);
  switch (t.type) {
    case "cron":
      return [`cron ${cell(t.id)}`, t.pattern].filter(Boolean).join(" ");
    case "label":
      return ["label", list("any", t.any), list("all", t.all), list("none", t.none)].filter(Boolean).join("; ");
    case "comment":
      return `comment ${JSON.stringify(t.phrase ?? "")}`;
    case "pull_request":
      return ["pull request", list("action", t.action), list("any", t.any), t.number ? `#${t.number}` : null, t.once ? "once" : null, t.disarmed ? "spent" : null].filter(Boolean).join("; ");
    case "issue":
      return ["issue", list("action", t.action), t.number ? `#${t.number}` : null, t.once ? "once" : null, t.disarmed ? "spent" : null].filter(Boolean).join("; ");
    default:
      return cell(t.type);
  }
}

/** What a trigger's jobs carry beyond the flow: each a short word or count, never a value. */
function triggerNotes(t) {
  return [
    t.resume ? "keeps a session" : null,
    t.replicas ? `${t.replicas} replicas` : null,
    t.secrets > 0 ? `${t.secrets} secrets${t.secretsProfile ? ` (profile ${t.secretsProfile})` : ""}` : null,
    Array.isArray(t.mcp) ? `mcp ${t.mcp.join(", ")}` : null,
    t.packages === false ? null : "staged packages",
    t.instructions ? "has instructions" : null,
    t.skillsDir ? `skills ${shownPath(t.skillsDir)}` : null,
    t.image ? `image ${t.image}` : null,
    t.backend ? `venue ${t.backend}` : null,
    t.maxCostUsd ? `job cap $${t.maxCostUsd}` : null,
    t.portfolio ? "writes the budget split" : null,
  ].filter(Boolean).join("; ");
}

/** The triggers editor: a JSON entry to add (the add tool's fields), the edit tool's fields, and a delete by row. */
function triggersEditor(view) {
  if (!canAct(view)) return null;
  return editor("Change the triggers", html`${actForm("trigger-add", { fields: area("trigger", "New trigger, as the add tool's fields (JSON)", { type: "json", rows: 6, required: true, placeholder: '{"kind": "label", "labels": ["pi"], "flow": "triage"}' }), label: "Preview the add" })}${actForm("trigger-edit", { fields: html`${indexField()}${field("flow", "Flow", { required: true })}${field("backend", "Venue (optional)")}${field("provider", "Provider (optional)")}${field("model", "Model (optional)")}`, label: "Preview the edit" })}${actForm("trigger-delete", { fields: indexField(), label: "Preview the delete" })}`);
}

export const configTriggers = fromSnapshot("Triggers", (s, view) => {
  const v = s.triggers;
  const trouble = fileTrouble(v, "triggers file");
  if (trouble) return html`<p class="warn">${trouble}</p>${triggersEditor(view)}`;
  const list = Array.isArray(v.triggers) ? v.triggers : [];
  return html`${table(
    "Triggers",
    [{ num: "#" }, "On", "Runs", "Model", "Notes"],
    list.map((t, i) => {
      const what = t.command ? `command ${t.command}` : `flow ${cell(t.flow)}`;
      const where = t.type === "cron" ? (t.folder ? ` in ${shownPath(t.folder)}` : "") : t.forge ? ` on ${t.forge}` : "";
      const model = [t.provider, t.model].filter(Boolean).join(" / ") || "deployment default";
      return html`<tr><td class="num">${i}</td><td>${triggerOn(t)}</td><td>${what}${where}</td><td>${model}</td><td>${triggerNotes(t) || "-"}</td></tr>`;
    }),
    "The triggers file declares no trigger.",
  )}${triggersEditor(view)}`;
});

/** Settings shown with their value; every other key the overlay sets is listed by name only. */
const SETTINGS_SHOWN = Object.freeze(["provider", "model", "maxTurns", "maxTokens", "concurrency", "dailyCap", "weeklyCap", "monthlyCap", "dailyTokenCap", "softHoldPct", "maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]);

/** The settings editor: set a key to a value, or unset it back to its default (the `dispatch_set` tool's two shapes). */
function settingsEditor(view) {
  if (!canAct(view)) return null;
  return editor("Change a setting", html`${actForm("setting-set", { fields: html`${field("key", "Key", { required: true, max: 64 })}${field("value", "Value", { required: true })}`, label: "Preview the change" })}${actForm("setting-unset", { fields: field("key", "Key", { required: true, max: 64 }), label: "Preview the unset" })}`);
}

export const configSettings = fromSnapshot("Settings overlay", (s, view) => {
  const v = s.settings;
  if (!v || v.invalid) return html`<p class="warn">The settings overlay does not load; run pi-dispatch doctor for the reason.</p>${settingsEditor(view)}`;
  const overlay = v.overlay ?? {};
  const shown = SETTINGS_SHOWN.filter((k) => ["string", "number", "boolean"].includes(typeof overlay[k]));
  const others = Object.keys(overlay).filter((k) => !SETTINGS_SHOWN.includes(k)).sort();
  return html`${shown.length === 0 ? html`<p class="note">The overlay sets nothing; every setting is the deployment's environment or its default.</p>` : facts(shown.map((k) => [k, String(overlay[k])]))}${others.length > 0 ? html`<p class="note">Also set: ${others.join(", ")}</p>` : null}${settingsEditor(view)}`;
});

/** A pause window's fields, as the add and edit tools take them (an edit leaves a blank field as it was). */
function pauseFieldsHtml(required) {
  return html`${field("scope", "Scope", { required, placeholder: "owner/name, a folder, or *", max: 4096 })}${field("from", "From (HH:MM)", { required, max: 5 })}${field("to", "To (HH:MM)", { required, max: 5 })}${field("tz", "Zone (IANA, default UTC)", { max: 64 })}${field("days", "Days (mon..sun)", { type: "list", max: 64 })}${field("dateFrom", "From date (YYYY-MM-DD)", { max: 10 })}${field("dateTo", "To date (YYYY-MM-DD)", { max: 10 })}`;
}

function pauseEditor(view) {
  if (!canAct(view)) return null;
  return editor("Change the pause windows", html`${actForm("pause-window-add", { fields: pauseFieldsHtml(true), label: "Preview the add" })}${actForm("pause-window-edit", { fields: html`${indexField()}${pauseFieldsHtml(false)}`, label: "Preview the edit" })}${actForm("pause-window-delete", { fields: indexField(), label: "Preview the delete" })}`);
}

export const configPauseWindows = fromSnapshot("Pause windows", (s, view) => {
  const v = s.pauseWindows;
  const trouble = fileTrouble(v, "pause-windows file");
  if (trouble) return html`<p class="note">${trouble}</p>${pauseEditor(view)}`;
  const list = Array.isArray(v.windows) ? v.windows : [];
  return html`${table(
    "Pause windows",
    ["Scope", "From", "To", "Zone", "Days", "Dates"],
    list.map((w) => html`<tr><td class="mono">${shownPath(cell(w.scope))}</td><td>${cell(w.from)}</td><td>${cell(w.to)}</td><td>${cell(w.tz)}</td><td>${Array.isArray(w.days) && w.days.length > 0 ? w.days.join(", ") : "every day"}</td><td>${w.dateFrom || w.dateTo ? `${cell(w.dateFrom)} to ${cell(w.dateTo)}` : "-"}</td></tr>`),
    "No pause window is set.",
  )}${pauseEditor(view)}`;
});

/** The scoped-limit fields a row may set, in the file's order, with how each reads. */
const LIMIT_FIELDS = Object.freeze([["day", "jobs a day"], ["week", "jobs a week"], ["month", "jobs a month"], ["concurrent", "at once"], ["dayUsd", "a day"], ["weekUsd", "a week"], ["monthUsd", "a month"], ["memory", "memory"], ["cpus", "CPUs"], ["hostShare", "host share"], ["minJobs", "min jobs"]]);

/** The scoped-limits editor: a row as the limit tools' fields (JSON), an edit of row N, a delete. */
function limitsEditor(view) {
  if (!canAct(view)) return null;
  const json = area("limit", "The row, as the limit tools' fields (JSON)", { type: "json", rows: 4, required: true, placeholder: '{"scope": "acme/web", "day": 10, "concurrent": 2}' });
  return editor("Change the scoped limits", html`${actForm("limit-add", { fields: json, label: "Preview the add" })}${actForm("limit-edit", { fields: html`${indexField()}${area("limit", "Fields to change (JSON)", { type: "json", rows: 3, required: true, placeholder: '{"day": 20}' })}`, label: "Preview the edit" })}${actForm("limit-delete", { fields: indexField(), label: "Preview the delete" })}`);
}

export const configScopedLimits = fromSnapshot("Scoped limits", (s, view) => {
  const v = s.scopedLimits;
  const trouble = fileTrouble(v, "scoped-limits file");
  if (trouble) return html`<p class="note">${trouble}</p>${limitsEditor(view)}`;
  const list = Array.isArray(v.limits) ? v.limits : [];
  return html`${table(
    "Scoped limits",
    ["Scope", "Limits"],
    list.map((l) => html`<tr><td class="mono">${shownPath(cell(l.scope))}</td><td>${LIMIT_FIELDS.filter(([k]) => l[k] !== null && l[k] !== undefined).map(([k, words]) => `${k.endsWith("Usd") ? `$${l[k]}` : l[k]} ${words}`).join("; ") || "-"}</td></tr>`),
    "No scoped limit is set.",
  )}${limitsEditor(view)}`;
});

/** The projects, envelope, priorities and revert editors. */
function projectsEditor(view) {
  if (!canAct(view)) return null;
  const members = (required) => area("members", "Members, one repository or folder per line", { rows: 3, required, max: 16384 });
  return editor("Change the projects and the allocation", html`${actForm("project-add", { fields: html`${field("id", "Id", { required: true, max: 64 })}${field("name", "Name (optional)")}${members(true)}`, label: "Preview the add" })}${actForm("project-edit", { fields: html`${field("id", "Id", { required: true, max: 64 })}${field("name", "Name (blank keeps it)")}${members(false)}`, label: "Preview the edit" })}${actForm("project-delete", { fields: field("id", "Id", { required: true, max: 64 }), label: "Preview the delete" })}${actForm("envelope-set", { fields: area("envelope", "Envelope fields to change, as the envelope tool takes them (JSON)", { type: "json", rows: 4, required: true, placeholder: '{"totalUsd": "100", "enabled": true}' }), label: "Preview the envelope" })}${actForm("priorities-set", { fields: html`${area("projects", "Weights (JSON list of {id, weight})", { type: "json", rows: 3, required: true, placeholder: '[{"id": "web", "weight": 3}]' })}${field("validDays", "Valid for days (optional)", { type: "int", input: "number", max: 4 })}`, label: "Preview the priorities" })}${actForm("allocation-revert", { fields: indexField("History row # (newest is 0)"), label: "Preview the revert" })}`);
}

export const configProjects = fromSnapshot("Projects", (s, view) => {
  const v = s.projects;
  const trouble = fileTrouble(v, "projects file");
  if (trouble) return html`<p class="note">${trouble}</p>${projectsEditor(view)}`;
  const list = Array.isArray(v.projects) ? v.projects : [];
  return html`${table(
    "Projects",
    ["Project", "Name", "Members"],
    list.map((p) => html`<tr><td class="mono">${cell(p.id)}</td><td>${cell(p.name)}</td><td class="mono">${Array.isArray(p.members) && p.members.length > 0 ? p.members.map(shownPath).join(", ") : "-"}</td></tr>`),
    "The projects file declares no project.",
  )}${facts([["Allocation envelope", s.envelopeSet ? "set" : "not set"]])}${projectsEditor(view)}`;
});

export const configMcp = fromSnapshot("MCP servers", (s) => {
  const v = s.overlayMcp ?? {};
  if (v.unreadable) return html`<p class="warn">The overlay's MCP file cannot be used (${String(v.unreadable)}).</p>`;
  const list = Array.isArray(v.servers) ? v.servers : [];
  return html`${table(
    "MCP servers",
    ["Server", "Transport", "Where", "Exposure", "On", "References"],
    list.map((m) => html`<tr><td class="mono">${cell(m.name)}</td><td>${cell(m.transport)}</td><td class="mono">${cell(m.where)}</td><td>${cell(m.exposure)}</td><td>${m.enabled ? "yes" : "no"}</td><td class="mono">${Array.isArray(m.refs) && m.refs.length > 0 ? m.refs.join(", ") : "-"}</td></tr>`),
    "The overlay declares no MCP server.",
  )}${Array.isArray(v.refused) && v.refused.length > 0 ? html`<p class="warn">Refused: ${v.refused.join(", ")}</p>` : null}`;
});

export const configPackages = fromSnapshot("Staged pi packages", (s) => {
  const v = s.stagedPackages ?? {};
  const list = Array.isArray(v.packages) ? v.packages : [];
  if (list.length === 0) return html`<p class="note">No pi package is staged.</p>`;
  return html`${v.stagedAt ? html`<p class="note">Staged ${v.stagedAt}.</p>` : null}<ul class="plain">${list.map((p) => html`<li class="mono">${p}</li>`)}</ul>`;
});

/** The secret profiles editor: a name and its resolver's absolute path, never a reference or a value. */
function profilesEditor(view) {
  if (!canAct(view)) return null;
  return editor("Change the secret profiles", html`${actForm("secret-profile-add", { fields: html`${field("name", "Name", { required: true, max: 64 })}${field("path", "Resolver (absolute path)", { required: true, max: 4096 })}`, label: "Preview the add" })}${actForm("secret-profile-remove", { fields: field("name", "Name", { required: true, max: 64 }), label: "Preview the removal" })}`);
}

export const configSecretProfiles = fromSnapshot("Secret profiles", (s, view) => {
  const names = secretProfileNames(s.settings);
  if (names.length === 0) return html`<p class="note">No secret profile is declared.</p>${profilesEditor(view)}`;
  return html`<p class="note">Names only: a profile's resolver and its references stay in the settings file.</p><ul class="plain">${names.map((n) => html`<li class="mono">${n}</li>`)}</ul>${profilesEditor(view)}`;
});

// ---- audit -----------------------------------------------------------------------------------------------------------

export function auditLog(view) {
  if (view.role !== "operator") return titled("Audit log", html`<p class="warn">The audit log is shown to operators only.</p>`);
  const a = view.data?.audit;
  if (!a) return titled("Audit log", html`<p class="warn">The audit log could not be read.</p>`);
  const rows = Array.isArray(a.rows) ? a.rows : [];
  const body = rows.map((r) => {
    if (r?.broken) {
      const where = r.line > 0 ? `line ${r.line} of ${cell(r.file)}` : `file ${cell(r.file)}`;
      return html`<tr class="warn"><td colspan="7">Not an audit row: ${where}${r.reason ? ` (${r.reason})` : ""}. Run pi-dispatch doctor to check the chain.</td></tr>`;
    }
    const actor = r.actor && typeof r.actor === "object" ? `${cell(r.actor.name)} (${cell(r.actor.role)})` : "-";
    return html`<tr><td class="num">${cell(r.seq)}</td><td>${utcText(msOf(r.at))}</td><td>${actor}</td><td>${cell(r.action)}${r.kind ? html` <span class="mono">${cell(r.kind)}</span>` : null}</td><td class="mono">${cell(r.target)}</td><td${r.outcome === "ok" ? null : html` class="warn"`}>${cell(r.outcome)}</td><td>${cell(r.reason)}${Number.isSafeInteger(r.reserve) ? html` reserve ${usdText(r.reserve)}` : null}${Number.isSafeInteger(r.count) ? html` (one of ${r.count})` : null}</td></tr>`;
  });
  const pager = html`<div class="pager">${view.query?.before !== undefined && view.query?.before !== null ? html`<a href="/audit">Newest rows</a>` : null}${a.next !== null && a.next !== undefined ? html`<a href="${`/audit?${new URLSearchParams({ before: String(a.next) })}`}">Older rows</a>` : null}</div>`;
  return titled("Audit log", html`${a.unreadable ? html`<p class="warn">${a.unreadable}</p>` : null}${table("Audit log", [{ num: "Seq" }, "At", "Who", "Action", "Target", "Outcome", "Reason"], body, "The audit log is empty.")}${pager}`);
}
