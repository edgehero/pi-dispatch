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
 * page's rule): a console page may be read on another machine, and a host's directory layout is not its business. The
 * one exception is the spend screen's `?paths=full`, which an OPERATOR may ask for (`insightsFullPaths`).
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
import { renderWhatIf } from "../render.mjs";
import { recordedProgress } from "@edgehero/pi-dispatch/run-history";
import { UNATTRIBUTED_BACKEND } from "@edgehero/pi-dispatch/backends";
import { BUNDLE_SKIPPED_TEXT, GATEWAY_TEXT, OPENSHELL_UNPUBLISHED_TEXT, LIVE_SKIPPED_TEXT, STEER_SKIPPED_TEXT, VENUE_MAY_NOT_STREAM, venuesView, liveAbsentCause, progressAbsentText, recordSkips, sandboxShellRefusal, bundleCountsText, bundleDeclaredText, bundleEndpointsText, bundleReceivedText, checkpointsText, forgeLinkOf, isProgressSnapshot, overlayBundleProfiles, progressStaleFor, recordBundle, recordRecovery, recoveredText, secretProfileNames, triggerBundleOf, PROFILE_ROOTS_TEXT, PROFILE_SOURCE_TEXT, profileHostsText, profileLastText, openshellCountsText, openshellHostsText, recordOpenshell, recordSecretsProfile } from "../read-model.mjs";
import { RUN_FILTER_FIELDS, parseRunFilter } from "../run-filter.mjs";
// The one vocabulary the panel reads too (issue #710): outcome words and tones, the venue label, the Spend and Held titles.
import { HELD_LABEL, NO_EXPLANATION, OUTCOME_WORD_OF, SPEND_TITLE, TONE_CLASS, VENUE_LABEL, outcomeWord, reasonWords } from "../words.mjs";
import { sessionKeyOfRecord } from "@edgehero/pi-dispatch/session-key";
import { parkedVerdictOf } from "@edgehero/pi-dispatch/chat-mode";
import { html, trustedRenderer } from "./html.mjs";
import { DOCTOR_CHECKS_SHOWN, DOCTOR_FILE_CHECKS, doctorByText, doctorCountsText, doctorHostsOf, doctorProblems, doctorQuote, doctorStale } from "../doctor-view.mjs";

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

/**
 * A host's blessed venues, compact (issue #712): `local (default), openshell`, the first the default as PI_BACKENDS reads
 * it; "not published" for a worker from before the registry's `backends` field, never a guessed `local`.
 */
function blessedText(h) {
  const blessed = Array.isArray(h?.backends?.blessed) ? h.backends.blessed : null;
  if (blessed === null) return html`<span class="note">not published</span>`;
  if (blessed.length === 0) return "none";
  return blessed.map((n, i) => (i === 0 ? `${n} (default)` : n)).join(", ");
}

export const overviewHosts = fromSnapshot("Hosts online", (s) => {
  const hosts = Array.isArray(s.hostBudgets) ? s.hostBudgets : [];
  return table(
    "Hosts online",
    ["Host", { num: "Slots" }, { num: "Running" }, "Venues", "Last beat"],
    hosts.map((h) => html`<tr><td>${cell(h.name)}</td><td class="num">${cell(h.concurrency)}</td><td class="num">${Array.isArray(h.jobs) ? h.jobs.filter((j) => !j.o).length : "unknown"}</td><td>${blessedText(h)}</td>${beatCell(h.staleMs)}</tr>`),
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
  // Issue #647: a park whose answer is queued or running (`answering`, a job id) no longer waits for a person.
  const rows = Array.isArray(s.parked) ? s.parked : [];
  const answering = rows.filter((p) => typeof p?.answering === "string").length;
  const n = rows.length - answering;
  return html`<p><span class="big">${count(n)}</span> ${n === 1 ? "run is" : "runs are"} waiting for an answer${answering > 0 ? `, and ${count(answering)} ${answering === 1 ? "is" : "are"} being answered now` : ""}. <a href="/parked">Open the parked inbox</a></p>`;
});

export const overviewFailures = fromSnapshot("Failures in the last 24 hours", (s) => {
  if (s.failures24h === null || s.failures24h === undefined) return html`<p class="warn">The run history could not be read.</p>`;
  const n = s.failures24h;
  return html`<p><span class="big${n > 0 ? " warn" : ""}">${s.failures24hFloor ? "at least " : ""}${count(n)}</span> failed ${n === 1 ? "run" : "runs"}.${s.failures24hFloor ? html` <span class="note">Every run read was inside the day, so there may be more.</span>` : null} <a href="${`/runs?${new URLSearchParams({ outcome: "failed" })}`}">See failed runs</a></p>`;
});

/** The words a stale snapshot carries (`progressStaleFor`): whole minutes since the last write. */
export function staleText(ms) {
  return `no update for ${Math.floor(ms / MIN)} min; the worker may be gone`;
}

/**
 * An active row's progress (issue #644) as one cell: "turn 7, 12 steps (1 failed), bash running 40s, phase 2/4". Built
 * from the snapshot's integer projection alone (`activeProgressOf`): integers and a tool name in the live stream's
 * charset, never a phase name or a note, so the same cell is right for a viewer. `-` when the row has none, and for an
 * ENDED snapshot: the job is active, so an ended key is an earlier attempt's (an infra retry keeps the job id) and
 * this attempt has not written yet. A stale snapshot (no write for `PROGRESS_STALE_MS`) says so, and its running
 * step gets no age: the clock would keep counting for a step nobody is watching.
 */
export function progressText(p, now) {
  if (p === null || typeof p !== "object" || p.ended === true) return "-";
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const stale = progressStaleFor(p, now);
  const parts = [];
  if (n(p.turn) !== null) parts.push(`turn ${p.turn}`);
  if (n(p.steps) !== null) parts.push(`${count(p.steps)} ${p.steps === 1 ? "step" : "steps"}${n(p.failed) ? ` (${count(p.failed)} failed)` : ""}`);
  const r = p.running;
  if (r && typeof r.tool === "string") parts.push(`${r.tool} running${stale === null && n(r.since) !== null && Number.isFinite(now) && now >= r.since ? ` ${ageText(now - r.since)}` : ""}`);
  const f = p.phase;
  if (f && n(f.index) !== null) parts.push(`phase ${f.index + 1}/${n(f.count) ?? "?"}`);
  if (stale !== null) parts.push(staleText(stale));
  return parts.length > 0 ? parts.join(", ") : "-";
}

/** The active jobs, newest start first, as the overview and the fleet screen list them; `act` adds a cancel per row. */
function activeTable(s, now, act = false) {
  const rows = (Array.isArray(s.active) ? [...s.active] : []).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const cancel = (j) => (act && typeof j.jobId === "string" && RUN_ID_RE.test(j.jobId) ? html`<td>${actForm("cancel-active", { hidden: [["jobId", j.jobId]], label: "Cancel" })}</td>` : act ? html`<td>-</td>` : null);
  return table(
    "Active jobs",
    ["Job", "Queue", "Host", "Started", "Running for", "Progress", ...(act ? ["Action"] : [])],
    rows.map((j) => html`<tr><td>${runLink(j.jobId)}</td><td>${cell(j.queue)}</td><td>${cell(j.host)}</td><td>${j.startedAt ? utcText(j.startedAt) : "-"}</td><td>${j.startedAt ? ageText(now - j.startedAt) : "-"}</td><td>${progressText(j.progress, now)}</td>${cancel(j)}</tr>`),
    "Nothing is running.",
  );
}

export const overviewActive = fromSnapshot("Active jobs", (s, view) => activeTable(s, view.now));

// ---- runs ------------------------------------------------------------------------------------------------------------

/** What each filter field is called on the form. */
const FILTER_LABELS = Object.freeze({ repo: "Repository", kind: "Forge", flow: "Flow", trigger: "Trigger", project: "Project", host: "Host", backend: VENUE_LABEL, outcome: "Outcome", reason: "Reason", model: "Model", q: "Target contains" });

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

/**
 * The venue a run used (issue #712): its record's `backend`, or `local` for a record that names none, which was written
 * before venues were recorded (`UNATTRIBUTED_BACKEND`, the worker's own reading, and the runs filter's).
 */
function runVenue(r) {
  return typeof r?.backend === "string" && r.backend !== "" ? r.backend : UNATTRIBUTED_BACKEND;
}

/**
 * A record's outcome in the console's words (words.mjs, the panel's too): completed, refused, failed, awaiting input or
 * cancelled; an outcome this release does not know is shown as it is (escaped, like every record string).
 */
function outcomeText(r) {
  const w = outcomeWord(r?.outcome, r?.reason);
  return w.known ? w.word : cell(r?.outcome);
}

/**
 * The reason part of a runs row (issue #710): `· <short sentence>`, linked to every run with the same outcome and
 * reason, with the token itself in the link's `title`. ONLY THE RECORD'S CLOSED `reason` ENUM comes here, never a job's
 * free-text `failedReason` (REQ-CONSOLE-SECURITY (l)); the sentence is the reason catalog's own fixed text, cut by
 * `shortSentence`. A token the catalog does not know (a newer worker's) is shown as it is with "no explanation yet". The
 * link is built only for a pair the runs filter accepts (`parseRunFilter`), so it never leads to a refusal; a reason
 * that is one of the outcome's words (awaiting input, cancelled) says nothing more, since the word already says it.
 * A token the filter REFUSES is not one this release can write (the filter takes the record's reason charset and
 * length), so it is printed once, cut to `ODD_TOKEN_MAX` characters, with no `title` copy: a malformed record's
 * reason could otherwise put an unbounded string into the row twice.
 */
function reasonPart(r) {
  if (typeof r?.reason !== "string" || r.reason === "") return null;
  const w = outcomeWord(r.outcome, r.reason);
  if (w.qualified) return null;
  const said = reasonWords(r.reason, typeof r.why === "string" ? r.why : null);
  const query = w.known ? { outcome: r.outcome, reason: r.reason } : { reason: r.reason };
  const href = parseRunFilter(query).filter ? `/runs?${new URLSearchParams(query)}` : null;
  if (href === null) {
    if (said.known) return html` · <span title="${r.reason}">${said.short}</span>`;
    const chars = [...r.reason];
    const token = chars.length > ODD_TOKEN_MAX ? `${chars.slice(0, ODD_TOKEN_MAX).join("")}…` : r.reason;
    return html` · ${token}, ${NO_EXPLANATION}`;
  }
  return html` · <a href="${href}" title="${r.reason}">${said.known ? said.short : `${r.reason}, ${NO_EXPLANATION}`}</a>`;
}

/** The most of a reason token the runs filter refuses that a row prints, in code points, before its ellipsis. */
const ODD_TOKEN_MAX = 64;

/** One run as a table row. The outcome cell takes its tone's class (`warn` for refused, awaiting input and cancelled, `bad` for failed). */
function runRow(r, env, subscriptions) {
  const at = msOf(r.endedAt ?? r.startedAt);
  const tone = TONE_CLASS[outcomeWord(r.outcome, r.reason).tone] ?? null;
  return html`<tr><td>${utcText(at)}</td><td>${runLink(r.jobId)}</td><td>${targetLink(r, env)}</td><td>${cell(r.flow)}</td><td>${cell(r.host)}</td><td>${runVenue(r)}</td><td${tone !== null ? html` class="${tone}"` : null}>${outcomeText(r)}${reasonPart(r)}</td><td>${cell(r.model)}</td><td class="num">${Number.isFinite(r.tokens?.total) ? count(r.tokens.total) : "-"}</td><td class="num">${costText(runCost(r, subscriptions))}</td><td class="num">${usdText(capMicrosOf(r))}</td></tr>`;
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
    html`${notes}${table("Runs", ["When", "Job", "Target", "Flow", "Host", VENUE_LABEL, "Outcome", "Model", { num: "Tokens" }, { num: "Cost" }, { num: "Job cap" }], runs.map((r) => runRow(r, view.env, subs)), "No run matches.")}${pager}`,
  );
}

// ---- run detail ------------------------------------------------------------------------------------------------------

/** The run, or the sentence that replaces every run panel when there is none. */
function withRun(title, render) {
  return (view) => {
    const got = view.data?.run;
    if (!got?.record) {
      // A running job has no record yet (it is written at the end); its live transcript or progress says it exists.
      const running = view.data?.transcript?.exists === true || (isProgressSnapshot(view.data?.progress) && !view.data.progress.ended);
      // A snapshot the worker stopped rewriting (its heartbeat is 30 s) may be a run that will never write a record.
      const stale = isProgressSnapshot(view.data?.progress) ? progressStaleFor(view.data.progress, view.now) : null;
      const why = got?.invalid ? "That is not a run id." : running ? `This run has no record yet: a run's record is written when it ends.${stale !== null ? ` Its progress has had ${staleText(stale)}.` : ""}` : "No run with that id is in this host's history or the fleet's run mirror.";
      return titled(title, html`<p class="${running && !got?.invalid ? "note" : "warn"}">${why}</p>`);
    }
    return titled(title, render(got.record, view, got.source));
  };
}

// ---- run progress (issue #644) ---------------------------------------------------------------------------------------

/** A step's duration: `1.2 s`, `40s`-style past a minute, or `-` when pi recorded none (the tool never ran). */
function stepDuration(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return "-";
  return ms < MIN ? `${(ms / SEC).toFixed(1)} s` : ageText(ms);
}

/** The run record's `progress`, rebuilt by the worker's own rule (`recordedProgress`): integers and closed keys only. */
function recordProgressBody(r) {
  const p = recordedProgress(r?.progress);
  if (p === undefined) return null;
  const z = (v) => (Number.isSafeInteger(v) ? count(v) : "0");
  const tools = p.tools ? Object.entries(p.tools) : [];
  return html`${facts([
    ["Turns", z(p.turns)],
    ["Steps", z(p.steps)],
    ["Failed steps", z(p.failed)],
    ["Interrupted steps", z(p.interrupted)],
    // A sum, not wall time: steps the model ran in parallel overlap, so this can exceed the run's own duration.
    ["Sum of step durations", Number.isSafeInteger(p.toolMs) ? stepDuration(p.toolMs) : "-"],
    ["Longest step", Number.isSafeInteger(p.longestStepMs) ? stepDuration(p.longestStepMs) : "-"],
    ["Longest interrupted step", Number.isSafeInteger(p.longestInterruptedMs) ? stepDuration(p.longestInterruptedMs) : null],
    ["Phases declared", z(p.phasesDeclared)],
    ["Last phase", Number.isSafeInteger(p.lastPhaseIndex) ? `${p.lastPhaseIndex + 1} of ${count(p.phasesDeclared)}` : null],
  ])}${tools.length > 0 ? table("Steps by tool", ["Tool", { num: "Steps" }], tools.map(([name, n]) => html`<tr><td class="mono">${name}</td><td class="num">${count(n)}</td></tr>`), "") : null}`;
}

/**
 * The live snapshot's phase section. The integers (which phase of how many, done of total) are a list's own facts and
 * every role gets them; the NAMES, the bar and the note are the model's words and go to an operator alone, escaped by
 * the template (the worker already escaped the control class; this is the second belt). A `phase.index` past the list
 * (the worker's size cut) shows no name rather than a neighbour's.
 */
function phaseBody(g, operator) {
  if (!g.phase && g.phases.length === 0) return html`<p class="note">This run declared no phase.</p>`;
  const f = g.phase;
  const total = f ? Math.max(g.phases.length, f.index + 1) : g.phases.length;
  const where = f ? html`<p>Phase ${f.index + 1} of ${count(total)}${f.done !== null ? `: ${count(f.done)}${f.total !== null ? ` of ${count(f.total)}` : ""} done` : ""}</p>` : null;
  if (!operator) return html`${where}<p class="note">Phase names and the run's note are shown to operators only.</p>`;
  const name = f && f.index < g.phases.length ? g.phases[f.index] : null;
  const bar = f && f.done !== null && f.total !== null ? html`<progress value="${String(f.done)}" max="${String(f.total)}">${`${f.done} of ${f.total}`}</progress>` : null;
  const list = g.phases.length > 0 ? html`<ol class="phases">${g.phases.map((p, i) => html`<li${f && i === f.index ? html` aria-current="step"` : null}>${p}</li>`)}</ol>` : null;
  return html`${where}${name !== null ? html`<p>Current phase: <strong>${name}</strong> ${bar}</p>` : bar}${list}${g.note !== null ? html`<h3>Note</h3><p class="run-note">${g.note}</p>` : null}`;
}

/**
 * The live snapshot's counters and steps, for every role: integers, UTC times and charset-checked tool names. A STALE
 * snapshot (`progressStaleFor`: no write past the worker's heartbeat) leads with a warning, and its open steps read as
 * open at the last update, never as running now with an age the console's clock keeps growing.
 */
function liveProgressBody(g, view) {
  const now = view.now;
  const operator = view.role === "operator";
  const stale = progressStaleFor(g, now);
  const open = (r) => (stale === null ? `running ${Number.isFinite(now) && now >= r.since ? ageText(now - r.since) : "-"}` : `open ${g.updatedAt >= r.since ? ageText(g.updatedAt - r.since) : "-"} at the last update`);
  const running = g.running.length === 0 ? html`<p class="note">${g.ended ? `The run has ended (${typeof g.outcome === "string" ? (outcomeWord(g.outcome).word ?? g.outcome) : "unknown"}).` : "No step is running."}</p>` : html`<ul class="plain">${g.running.map((r) => html`<li><span class="mono">${r.tool}</span> ${open(r)}</li>`)}</ul>`;
  const recent = [...g.recent].reverse();
  return html`${stale !== null ? html`<p class="warn">Stale: ${staleText(stale)}.</p>` : null}${facts([
    ["Turn", count(g.turn)],
    ["Steps", `${count(g.steps)}${g.failed > 0 ? ` (${count(g.failed)} failed)` : ""}`],
    ["Interrupted steps", g.interrupted > 0 ? count(g.interrupted) : null],
    // The resume prior: what the session's earlier runs did before this run resumed it, not this job's retries.
    ["Earlier runs of this session", g.prior ? `${count(g.prior.turns)} turns, ${count(g.prior.steps)} steps before this run resumed the session` : null],
    ["Started", utcText(g.startedAt)],
    ["Updated", utcText(g.updatedAt)],
  ])}<h3>Running now</h3>${running}<h3>Phase</h3>${phaseBody(g, operator)}<h3>Recent steps</h3>${table("Recent steps", ["Tool", "Status", { num: "Took" }, "At"], recent.map((r) => html`<tr${r.status === "ok" ? null : html` class="warn"`}><td class="mono">${r.tool}</td><td>${r.status}</td><td class="num">${stepDuration(r.durationMs)}</td><td>${utcText(r.at)}</td></tr>`), "No step has finished yet.")}`;
}

/**
 * Why a run on a venue that streams has no progress snapshot: the key cannot tell these apart, so the panel names all
 * three. Issue #712: the panel says `progressAbsentText(record)`, `TRANSCRIPT_ABSENT`'s rule (progress is read off the
 * live transcript), so a run on a venue that does not stream it is not blamed on the switch alone.
 */
export const PROGRESS_ABSENT = progressAbsentText({ backend: "local" });

/**
 * The run page's "Progress" panel (issue #644). A run with a record shows the record's `progress` (and, while the key
 * is still kept, an operator also gets the phase names it declared); a running job shows the live snapshot, counters
 * and recent steps for everyone, phase names, the done/total bar and the note for an operator alone. The page is live
 * (the hub re-renders this panel by digest), so a running job's counters move without a reload.
 *
 * An infra retry keeps the job id: attempt 1 writes its record and attempt 2 then rewrites the key. So the key is set
 * beside the record only when the two are the SAME attempt, judged by time: a key that started after the record ended
 * is a later attempt's, and the panel shows that live body (saying an earlier attempt ended, with the record's
 * outcome); the key's phase names join the record only when the key has ended and started inside the record's
 * attempt (no earlier than the record started, no later than it ended). A record whose start or end cannot be read
 * pairs with no key.
 *
 * Issue #662: the key is read by the job's RUN id (pages.mjs, `readRunProgress`), so a recovery's page pairs with its
 * own live key, and an attempt whose record says its run continues as a recovery (`data.progressContinues`) pairs with
 * nothing: it shows its own record's progress and links the recovery job.
 */
export function runProgress(view) {
  const title = "Progress";
  const record = view.data?.run?.record ?? null;
  const g = view.data?.progress ?? null;
  // Issue #662: an attempt whose run went on as a #645 recovery (its record says `recovery-enqueued`). The key is the
  // RUN's, so it now holds the recovery's progress: pairing it here would show another job's live steps as this
  // attempt's. The attempt shows its own record's progress, and names the job that continues it (its own page reads the
  // key live). A BullMQ retry keeps the job id and keeps the pairing below.
  const cont = view.data?.progressContinues ?? null;
  if (record && cont) {
    const next = typeof cont.as === "string" && RUN_ID_RE.test(cont.as) ? cont.as : null;
    const line = html`<p class="note">This run continues as ${next !== null ? runLink(next) : "a recovery job"}.</p>`;
    return titled(title, html`${line}${recordProgressBody(record) ?? html`<p class="note">This attempt's record holds no progress.</p>`}`);
  }
  const live = isProgressSnapshot(g) ? g : null;
  const recordEnd = typeof record?.endedAt === "string" ? Date.parse(record.endedAt) : Number.NaN;
  if (record && live && Number.isFinite(recordEnd) && live.startedAt > recordEnd) {
    const outcome = typeof record.outcome === "string" && /^[a-z-]{1,40}$/.test(record.outcome) ? record.outcome : "unknown";
    return titled(title, html`<p class="note">An earlier attempt of this run ended (${outcome}); this is the attempt after it.</p>${liveProgressBody(live, view)}`);
  }
  if (record) {
    const body = recordProgressBody(record);
    // Both bounds: a key that started before this record's attempt did is an EARLIER attempt's (attempt 2 refused before
    // its container leaves attempt 1's ended key in place), and its phase names are not this record's. An unreadable
    // start pairs with nothing, as an unreadable end does.
    const recordStart = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : Number.NaN;
    const same = live && live.ended && Number.isFinite(recordEnd) && Number.isFinite(recordStart) && live.startedAt >= recordStart && live.startedAt <= recordEnd;
    const names = same && view.role === "operator" && live.phases.length > 0 ? html`<h3>Phases</h3>${phaseBody(live, true)}` : null;
    // Issue #712: a record that names its live skip says it; one on a venue that does not always stream adds that cause.
    if (body === null && names === null) {
      const cause = liveAbsentCause(record);
      const why = cause?.skipped ? `it had no live transcript to read it from: ${cause.skipped}` : cause?.venue ? `an older worker, PI_RUN_PROGRESS=0, ${VENUE_MAY_NOT_STREAM}` : "an older worker, or PI_RUN_PROGRESS=0";
      return titled(title, html`<p class="note">This run's record holds no progress (${why}).</p>`);
    }
    return titled(title, html`${body ?? html`<p class="note">This run's record holds no progress.</p>`}${names}`);
  }
  if (live) return titled(title, liveProgressBody(live, view));
  if (g?.unreachable) return titled(title, html`<p class="warn">The run's progress could not be read (is Valkey reachable?).</p>`);
  if (g?.invalid) return titled(title, html`<p class="warn">The run's progress key is not one this console reads (a newer or older worker?).</p>`);
  return titled(title, html`<p class="note">${progressAbsentText(record)}</p>`);
}

// ---- run inbox (issue #646) ------------------------------------------------------------------------------------------

/** Why an active, steer-armed job's run takes no message: the open key cannot tell these apart, so all are named. */
export const INBOX_NOT_OPEN = "The run is not accepting messages: it has not started its loop yet, it has finished, or its venue cannot deliver (bind mounts, an exit key and an image with the steer capability).";

const MODE_WORD = Object.freeze({ steer: "steer", followUp: "follow-up" });
/** A message id as the inbox mints it (INT-STEER-INBOX-CONTRACT): only such an id gets a withdraw button. */
const MESSAGE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The run page's "Inbox" panel (issue #646, REQ-STEER-RUNNING-JOB): the messages sent into a steer-armed job, as
 * `readJobInbox` reads them, WITHOUT TEXT for every role (id, mode, source, state, time, size): the text is the
 * sender's words for one run, and a list is no place for them (the audit row keeps only their sha256 too). A job that
 * is not steer-armed, or not found, draws nothing at all (its empty section is hidden by the stylesheet's
 * `section[data-panel]:empty`), so every other run page reads as it did.
 *
 * The controls (`canAct`: an operator on a console that is not read-only): one form to steer and one to send a
 * follow-up, drawn only while the job is ACTIVE and its run takes messages (`open`), and a Withdraw button on each
 * message still `queued` (withdrawn for certain) or `written` (best effort; the preview says which). A viewer sees the
 * list and the run's status, never a control, which is the parked answer form's and the cancel button's rule. The page
 * is live, so a message's state moves from queued to written to delivered without a reload; a form being typed into is
 * not swapped (the script's `inUse`).
 */
export function runInbox(view) {
  const box = view.data?.inbox ?? null;
  if (box === null || typeof box !== "object" || box.invalid || box.found === false || (box.found === true && box.steer !== true)) return html``;
  const title = "Inbox";
  if (box.unreachable) return titled(title, html`<p class="warn">The run's inbox could not be read (is Valkey reachable?).</p>`);
  const jobId = view.query?.id;
  // Review F4: a job that is not active whose run goes on as a recovery job (`continuesAs`, same run, same inbox): the
  // forms stay, since the planner sends through the active job, and the panel names that job with a link.
  const next = typeof box.continuesAs === "string" && RUN_ID_RE.test(box.continuesAs) ? box.continuesAs : null;
  const running = box.state === "active" || next !== null;
  const takes = running && box.open === true;
  const status = takes
    ? "The run takes messages. A steer reaches the agent after its current tool calls, before its next model call; a follow-up once the agent would otherwise stop. Either one spends from the run's existing reservation."
    : running
      ? box.open === null
        ? "Whether the run takes messages could not be read."
        : INBOX_NOT_OPEN
      : `The job is ${cell(box.state)}, not running, so it takes no message; its inbox is kept for an hour after its run.`;
  const act = canAct(view) && typeof jobId === "string" && RUN_ID_RE.test(jobId);
  const withdraw = (e) => {
    if (!act) return null;
    if ((e.state !== "queued" && e.state !== "written") || typeof e.id !== "string" || !MESSAGE_ID_RE.test(e.id)) return html`<td>-</td>`;
    return html`<td>${actForm("steer-withdraw", { hidden: [["jobId", jobId], ["id", e.id]], label: "Withdraw" })}</td>`;
  };
  const entries = Array.isArray(box.entries) ? box.entries : null;
  const list =
    entries === null
      ? html`<p class="warn">The messages could not be read this time; the next refresh tries again.</p>`
      : table(
          "Inbox",
          ["Message", "Mode", "Source", "State", "Sent", { num: "Bytes" }, ...(act ? ["Action"] : [])],
          entries.map((e) => html`<tr><td class="mono">${cell(e.id)}</td><td>${cell(MODE_WORD[e.mode])}</td><td>${cell(e.source)}</td><td>${cell(e.state)}</td><td>${Number.isSafeInteger(e.at) ? utcText(e.at) : "-"}</td><td class="num">${count(e.bytes)}</td>${withdraw(e)}</tr>`),
          "No message has been sent to this run.",
        );
  // Issue #647: when the Chat panel draws the message forms (a live run an operator can steer), they are drawn THERE and
  // not here, so the page holds one steer form per mode, never two copies of the same action.
  const forms = act && takes && !chatDrawsSteer(view) ? steerForms(jobId) : null;
  const cont = next !== null ? html`<p class="note">This job is ${cell(box.state)}; its run continues as ${runLink(next)}, and a message sent here goes to that job.</p>` : null;
  return titled(title, html`${cont}<p class="note">${status}</p>${list}${forms}<p class="note">A message's text is never listed: the run reads it, and the audit log keeps its sha256.</p>`);
}

// ---- run chat (issue #647) -------------------------------------------------------------------------------------------

/** What each run state is called in the Chat panel's status line (`RUN_STATES`, chat-mode.mjs). */
const CHAT_STATE_WORD = Object.freeze({ active: "running", queued: "queued", parked: "parked, waiting for an answer", answered: "answered by a later run", finished: "finished", unknown: "unknown" });

/** The Chat panel's line for a run that cannot chat because another job holds it: a link to that job, or null. */
function chatHeldBy(chat) {
  if (typeof chat.answeringJobId === "string" && RUN_ID_RE.test(chat.answeringJobId)) return html`<p class="note">The run taking the answer is ${runLink(chat.answeringJobId)}.</p>`;
  if (typeof chat.queuedJobId === "string" && RUN_ID_RE.test(chat.queuedJobId)) return html`<p class="note">The queued recovery job is ${runLink(chat.queuedJobId)}.</p>`;
  return null;
}

/**
 * The run page's "Chat" panel (issue #647, REQ-TERMINAL-CHAT): the chat this run can have now (`data.chat`, from
 * `chatModeOf` through `run-api.mjs`'s `chatFactsOf`, the rule `/api/run` and `pi-dispatch chat` share), composed of what
 * the console already has, never a second copy of an action:
 *
 *   - live: the live transcript section below (issue #643, an operator's) and the steer and follow-up forms, which move
 *     here from the Inbox panel while this panel shows them (`chatDrawsSteer`);
 *   - reply: the parked answer form, the very one the parked inbox draws (`parkedAnswerForm`);
 *   - fork: the exact `pi-dispatch chat <id>` command to fork the run's session on a host that holds the session store
 *     (shown to copy, never run, like the sandbox command), or why its session cannot be found from the record.
 *
 * A VIEWER SEES STATUS ONLY (REQ-CONSOLE-SECURITY clause l): the state, the mode and a refusal's sentence, never a form
 * or a command; a read-only console draws no form for anyone. Nothing here is free text: the state words are this
 * module's, `says` is one of `chatModeOf`'s fixed sentences, and the id is charset-checked. A page whose fleet has no
 * job-state reader draws nothing (the empty section is hidden), so an older reader's page reads as it did.
 */
export function runChat(view) {
  const chat = view.data?.chat ?? null;
  if (chat === null || typeof chat !== "object") return html``;
  const title = "Chat";
  if (chat.unreachable) return titled(title, html`<p class="warn">The queue could not be read (is Valkey reachable?), so whether this run can chat is unknown. The next refresh tries again.</p>`);
  const jobId = typeof view.query?.id === "string" && RUN_ID_RE.test(view.query.id) ? view.query.id : null;
  const answering = chat.state === "answered" && typeof chat.answeringJobId === "string";
  const status = html`<p>This run is ${answering ? "being answered" : Object.hasOwn(CHAT_STATE_WORD, chat.state) ? CHAT_STATE_WORD[chat.state] : "unknown"}.</p>`;
  if (chat.mode !== "live" && chat.mode !== "reply" && chat.mode !== "fork") return titled(title, html`${status}<p class="note">${typeof chat.says === "string" ? chat.says : "This run has no chat."}</p>${chatHeldBy(chat)}`);
  if (view.role !== "operator" || jobId === null) return titled(title, html`${status}<p class="note">Chat is for operators; a viewer sees the run's status only.</p>`);
  const terminal = (id) => html`<p>From a terminal: <code class="mono">${`pi-dispatch chat ${id}`}</code></p>`;
  const readOnly = view.readOnly ? html`<p class="note">This console is read-only, so it sends nothing.</p>` : null;
  if (chat.mode === "live") {
    const active = typeof chat.activeJobId === "string" && RUN_ID_RE.test(chat.activeJobId) ? chat.activeJobId : jobId;
    const via = active !== jobId ? html`<p class="note">The run goes on as ${runLink(active)}; its transcript is on that job's page, and a message sent here reaches it.</p>` : html`<p class="note">Its live transcript is <a href="#transcript">below</a>.</p>`;
    const box = view.data?.inbox ?? null;
    // An inbox that could not be read says so: "not steer-armed" about a run whose inbox was never read would be a guess.
    const boxRead = box !== null && typeof box === "object" && !box.unreachable && !box.invalid;
    const armed = boxRead && box.found === true && box.steer === true;
    const send = chatDrawsSteer(view)
      ? steerForms(jobId)
      : canAct(view)
        ? !boxRead
          ? html`<p class="warn">The run's inbox could not be read (is Valkey reachable?), so whether it takes a message is unknown. The next refresh tries again.</p>`
          : html`<p class="note">${!armed ? "This run is not steer-armed (its trigger sets no run.steer), so it takes no message; watch it instead." : "The run takes no message right now; the Inbox panel says why."}</p>`
        : null;
    return titled(title, html`${status}${via}${send}${readOnly}${terminal(jobId)}`);
  }
  if (chat.mode === "reply") {
    const link = view.data?.run?.record ? targetLink(view.data.run.record, view.env) : "-";
    // Issue #647: the form only where the planner would plan the answer (`parkedAnswerCheck`, its own predicate): a pull
    // request's park, a forge without a reply route or expired job data shows the planner's sentence instead. A check that
    // could not be read keeps the form and says so (the planner checks again before anything is queued).
    const check = view.data?.chatAnswer ?? null;
    const refusal = typeof check?.refusal === "string" ? check.refusal : null;
    const form = refusal === null && canAct(view) ? parkedAnswerForm(jobId) : null;
    const why = refusal !== null ? html`<p class="note">It cannot be answered from here: ${refusal}.</p>` : check?.unreachable ? html`<p class="warn">Whether it can be answered from here could not be read; the preview checks again.</p>` : null;
    return titled(title, html`${status}<p class="note">Its question is the last assistant entry of its transcript <a href="#transcript">below</a> (kept 24 hours), and on ${link}. An answer resumes it, as a reply there would.</p>${why}${form}${readOnly}${refusal === null ? terminal(jobId) : null}`);
  }
  // fork: whether the record names a session the host-local fork can find, said before the command is offered.
  const record = view.data?.run?.record ?? null;
  const kept = record?.session !== null && typeof record?.session === "object";
  const why = !kept ? "This run's trigger keeps no session (no run.resume), so there is no transcript to fork." : sessionKeyOfRecord(record) === null ? "This run's session cannot be found from its record (a pull or merge request's session is keyed by its head branch, which the record does not carry), so a fork would refuse." : null;
  if (why !== null) return titled(title, html`${status}<p class="note">${why}</p>`);
  return titled(title, html`${status}<p class="note">Continue it in your own pi, as a fork of its session: run this on a host that holds the session store (PI_SESSIONS_DIR). The session's transcript is not redacted and goes to your pi's provider; the run's own transcript is never written.</p>${terminal(jobId)}`);
}

/**
 * The two message forms of a steer-armed run that takes messages (issue #646): a steer and a follow-up, both the `steer`
 * action with a `mode`. Drawn by the Inbox panel, or by the Chat panel when it shows a live run (issue #647), never by
 * both (`chatDrawsSteer`).
 */
function steerForms(jobId) {
  const text = (label) => area("text", label, { rows: 3, required: true, max: 8192 });
  return html`<h3>Send a message</h3>${actForm("steer", { hidden: [["jobId", jobId], ["mode", "steer"]], fields: text("Steer: read after the agent's current tool calls"), label: "Preview the steer" })}${actForm("steer", { hidden: [["jobId", jobId], ["mode", "followUp"]], fields: text("Follow-up: read once the agent would otherwise stop"), label: "Preview the follow-up" })}`;
}

/**
 * Whether the run's inbox takes a message now and this view may send one: the Inbox panel's own rule (an operator on a
 * writable console, a steer-armed job that is active or continues as an active recovery, and an open inbox).
 */
function inboxTakes(view) {
  const box = view.data?.inbox ?? null;
  if (box === null || typeof box !== "object" || box.found !== true || box.steer !== true || box.unreachable) return false;
  const next = typeof box.continuesAs === "string" && RUN_ID_RE.test(box.continuesAs) ? box.continuesAs : null;
  return (box.state === "active" || next !== null) && box.open === true;
}

/** Whether the Chat panel draws the message forms (so the Inbox panel does not): a live run an operator can steer now. */
function chatDrawsSteer(view) {
  const jobId = view.query?.id;
  return view.data?.chat?.mode === "live" && canAct(view) && typeof jobId === "string" && RUN_ID_RE.test(jobId) && inboxTakes(view);
}

/**
 * The run detail's operator actions (issue #642): the command that reopens the run's retained workspace on the host
 * (`pi-dispatch sandbox <jobId>`, shown to copy and never run: a browser terminal was rejected, DES-OPERATOR-CONSOLE),
 * and the re-run form, whose preview shows the reserve the worker will hold. A job id outside the run-id charset gets
 * neither: it could not be typed back as one argument.
 */
function runActions(r, view) {
  if (view.role !== "operator" || typeof r.jobId !== "string" || !RUN_ID_RE.test(r.jobId)) return null;
  // Issue #712: the command only for a venue with a sandbox shell (`serves.sandboxShell`, held to the worker's
  // SANDBOX_LAUNCHERS), and otherwise the reason the panel's sandbox pane gives, in its words (`sandboxShellRefusal`). A
  // record with no `backend` is a `local` run from before attribution (`UNATTRIBUTED_BACKEND`), as the sandbox reads it.
  const venue = typeof r.backend === "string" && r.backend !== "" ? r.backend : UNATTRIBUTED_BACKEND;
  const refused = sandboxShellRefusal(venue);
  const reopen = refused === null ? html`<p>Open its retained workspace on the host: <code class="mono">${`pi-dispatch sandbox ${r.jobId}`}</code></p>` : html`<p class="note">Its workspace is ${refused}.</p>`;
  return html`<h3>Actions</h3>${reopen}${canAct(view) ? actForm("rerun", { hidden: [["jobId", r.jobId]], label: "Preview a re-run" }) : null}`;
}

/**
 * The run summary's skip rows (issue #712): "Steering" (why a steer-armed run took no message, the record's
 * `steerSkipped`) and "Live transcript" (why it had none, `liveSkipped`), each the closed enum and its sentence; no row
 * for a record that carries neither, so every other run renders byte-identical.
 */
function skipRows(r) {
  const { liveSkipped, steerSkipped } = recordSkips(r);
  return [
    ["Steering", steerSkipped !== null ? `skipped (${steerSkipped}): ${STEER_SKIPPED_TEXT[steerSkipped]}` : null],
    ["Live transcript", liveSkipped !== null ? `none (${liveSkipped}): ${LIVE_SKIPPED_TEXT[liveSkipped]}` : null],
  ];
}

/**
 * The run summary's OpenShell rows (issue #712): "Sandbox policy" (the mode, the credential providers and placeholders
 * the sandbox was given) and "Rule hosts" (the hosts its policy admitted, with the count of any the record does not
 * list), the worker's rebuild (`recordOpenshell`: hosts held to the host-name charset), escaped by the renderer; and
 * "Secrets profile", the profile NAME run.secrets resolved through. No row for a record without the keys, so every
 * other run renders byte-identical. MCP connection state is not recorded on any venue, so no row claims it.
 */
function openshellRows(r) {
  const o = recordOpenshell(r);
  return [
    ["Sandbox policy", o !== null ? openshellCountsText(o) : null],
    ["Rule hosts", o !== null ? openshellHostsText(o) : null],
    ["Secrets profile", recordSecretsProfile(r)],
  ];
}

/**
 * The run summary's durable-run rows (issue #645): "Recovery of" (the base run, linked), "Recovery" (where it came from
 * and the runner's counts, or why an armed job ran without recovery) and "Checkpoints". Every value is `recordRecovery`'s
 * rebuild (integers, closed enums and a charset-checked id), so both roles see them; each row is null, and so not drawn,
 * when the record holds nothing for it, which keeps every record of a job that never armed `run.recover` byte-identical.
 */
function recoveryRows(r) {
  const rec = recordRecovery(r);
  if (rec === null) return [];
  const said = [rec.recovered ? recoveredText(rec.recovered) : null, rec.recoverSkipped ? `recovery skipped: ${rec.recoverSkipped}` : null].filter(Boolean);
  return [
    ["Recovery of", rec.recoveryOf !== null ? runLink(rec.recoveryOf) : null],
    ["Recovery", said.length > 0 ? said.join("; ") : null],
    ["Checkpoints", rec.checkpoints ? checkpointsText(rec.checkpoints) : null],
  ];
}

/**
 * The run summary's secret-bundle rows (issue #704): "Secret bundle" (the variable NAMES the run received and the bundle
 * they came from, the names a trigger's own run.secrets shadowed, and on an openshell venue how many were placeholders),
 * or why the run went without its project's bundle. `recordBundle`'s rebuild (names held to the environment-name
 * charset, a closed enum), escaped by the renderer like every record string; no row for a record that carries neither
 * key, so every run outside a bundled project renders byte-identical.
 */
function bundleRows(r) {
  const got = recordBundle(r);
  if (got === null) return [];
  const b = got.bundle;
  const said = b ? [bundleReceivedText(b), b.shadowed.length > 0 ? `shadowed by the trigger's own run.secrets: ${b.shadowed.join(", ")}` : null, bundleCountsText(b) || null].filter(Boolean) : [];
  return [
    ["Secret bundle", said.length > 0 ? said.join("; ") : null],
    ["Bundle skipped", got.bundleSkipped !== null ? `${got.bundleSkipped}: ${BUNDLE_SKIPPED_TEXT[got.bundleSkipped]}` : null],
  ];
}

export const runSummary = withRun("Run", (r, view, source) => {
  const started = msOf(r.startedAt);
  const ended = msOf(r.endedAt);
  return html`${facts([
    ["Job", html`<span class="mono">${cell(r.jobId)}</span>`],
    ["Target", targetLink(r, view.env)],
    ["Forge", cell(r.kind)],
    ["Flow", cell(r.flow)],
    ["Outcome", outcomeText(r)],
    ["Reason", cell(r.reason)],
    ["Detail", r.why ?? null],
    ["Exit code", cell(r.exitCode)],
    ["Attempt", cell(r.attempt)],
    ...recoveryRows(r),
    ["Host", cell(r.host)],
    [VENUE_LABEL, cell(r.backend)],
    ...skipRows(r),
    ...openshellRows(r),
    ["Project", cell(r.project)],
    ...bundleRows(r),
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
  ])}<h3>Children</h3>${kids.length === 0 ? html`<p class="note">No child run among the ${count(view.data?.childrenSearched ?? 0)} newest runs.</p>` : html`<ul class="plain">${kids.map((k) => html`<li>${runLink(k.jobId)} ${outcomeText(k)}</li>`)}</ul>`}`;
});

// ---- parked ----------------------------------------------------------------------------------------------------------

/**
 * One parked run's answer form (issue #642): the `parked-answer` action, whose preview shows the answer and the reserve
 * and whose server refuses a pull request's park, expired job data and a trigger without `resume`. The parked inbox and
 * the run page's Chat panel (issue #647) draw this one form.
 */
function parkedAnswerForm(jobId) {
  return actForm("parked-answer", { hidden: [["jobId", jobId]], fields: area("text", "Your answer, as the reply on the issue", { rows: 4, required: true, max: 8192 }), label: "Preview the answer" });
}

export const parkedInbox = fromSnapshot("Parked runs", (s, view) => {
  if (s.parkedUnreachable) return html`<p class="warn">The parked runs could not be read (${s.parkedUnreachable}); this is not an empty inbox.</p>`;
  const rows = Array.isArray(s.parked) ? s.parked : [];
  // Issue #642: one answer form per parked run, below the list. The answer is the operator's own words, posted as the
  // reply a forge comment would have been; the preview shows it and the reserve, and the audit keeps only its digest.
  // Issue #647: a form only where the Chat panel would draw one: the shared verdict over the row's pending-answer scan
  // (`parkedVerdictOf`, chat-mode's table, review round 2). A park whose answer is queued or running gets no form and
  // its row links that job; a scan that could not tell (unreadable, or a queue too deep to check) gets no form either,
  // and its sentence is said once under the table.
  const verdictOf = (p) => parkedVerdictOf(p.pendingScan);
  const answerable = canAct(view) ? rows.filter((p) => typeof p.jobId === "string" && RUN_ID_RE.test(p.jobId) && verdictOf(p).mode === "reply") : [];
  const answers = answerable.length === 0 ? null : html`<h3>Answer a parked run</h3>${answerable.map((p) => editor(html`Answer ${cell(p.target)} (${p.jobId})`, parkedAnswerForm(p.jobId)))}`;
  const unknownSays = [...new Set(rows.map(verdictOf).filter((v) => v.mode === null && v.answeringJobId === null).map((v) => v.says))];
  const unknownNote = unknownSays.length === 0 ? null : unknownSays.map((says) => html`<p class="warn">${says}</p>`);
  const answerCell = (p) => {
    const v = verdictOf(p);
    if (v.answeringJobId !== null) return html`being answered by ${runLink(v.answeringJobId)}`;
    if (v.mode === "reply") return "waiting";
    return p.pendingScan?.tooMany === true ? "unknown (too many queued jobs to check)" : "unknown (the queue could not be fully read)";
  };
  return html`<p class="note">A parked run asked a question and ended; a reply on its issue or merge request resumes it, and an operator can answer it from here.</p>${table(
    "Parked runs",
    ["Target", "Forge", "Job", "Parked", "Waiting", { num: "Chain" }, "Answer"],
    rows.map((p) => html`<tr><td>${targetLink(p, view.env)}</td><td>${cell(p.kind)}</td><td>${runLink(p.jobId)}</td><td>${utcText(p.parkedAt)}</td><td>${ageText(p.ageMs)}</td><td class="num">${Number.isInteger(p.chainCount) ? p.chainCount : "unknown"}</td><td>${answerCell(p)}</td></tr>`),
    "Nothing is parked.",
  )}${unknownNote}${answers}`;
});

// ---- insights --------------------------------------------------------------------------------------------------------

/** The spend window's choices, in the order the picker shows them, and the one a bare `/insights` shows. */
export const INSIGHTS_RANGES = Object.freeze(["7d", "30d", "mtd"]);
export const INSIGHTS_DEFAULT_RANGE = "30d";

/**
 * Whether this view draws full local folder paths: `?paths=full`, and the OPERATOR role. A viewer always gets
 * basenames, whatever the query says: a host's directory layout is host detail (the PATHS rule in this file's header),
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
  return html`<ol id="graph-nodes" class="hidden-tips" hidden>${ids.map((id) => html`<li data-id="${id}" data-nb="${list(nodes[id].nb, NODE_ID_RE)}" data-w="${list(nodes[id].w, WIRE_ID_RE)}">${linesHtml(nodes[id].tip)}</li>`)}</ol>`;
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

export const fleetHeld = fromSnapshot(HELD_LABEL, (s, view) => {
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
    ["Host", { num: "Slots" }, "Memory", "CPU (centi)", { num: "Waiting" }, "Running jobs", "Venues", "Routes", "Last beat"],
    hosts.map((h) => {
      const jobs = Array.isArray(h.jobs) ? h.jobs : null;
      const list = jobs === null ? (h.jobsUnreadable ? "unreadable" : "-") : jobs.length === 0 ? "none" : html`${jobs.map((j, i) => html`${i > 0 ? ", " : ""}${runLink(j.id)}${j.o ? " (orphaned hold)" : ""}${j.at ? html` <span class="note">${ageText(view.now - j.at)}</span>` : null}`)}${h.jobsMore > 0 ? ` and ${h.jobsMore} more` : ""}`;
      return html`<tr><td>${cell(h.name)}</td><td class="num">${cell(h.concurrency)}</td><td>${budgetText(h.usedMemMiB, h.budgetMemMiB, "MiB")}</td><td>${budgetText(h.usedCpuCenti, h.budgetCpuCenti, null)}</td><td class="num">${cell(h.waiters)}</td><td>${list}</td><td>${blessedText(h)}</td><td>${h.routes === false || h.routes === "false" ? "no" : "yes"}</td>${beatCell(h.staleMs)}</tr>`;
    }),
    "No host is registered.",
  );
});

/**
 * The Doctor panel (issue #712, `DES-DOCTOR-RESULTS-PUBLISHED`): each host's last published `pi-dispatch doctor` run, its
 * age and counts, then its failing and warning checks with their fix, failing first. A result older than two of its
 * host's doctor intervals is flagged stale; a live host that has published nothing is named, so "no problems listed"
 * never reads as "healthy" for a host that was never checked. The labels are doctor's redacted sentences (no path, no
 * URL beyond its host, secret-named values and token shapes redacted, file content quoted by a parse error cut), shown
 * to both roles and escaped like every value here.
 */
export const fleetDoctor = fromSnapshot("Doctor", (s, view) => {
  const d = s.doctor;
  if (!d || d.unreachable) return html`<p class="warn">The published doctor results could not be read.</p>`;
  const rows = doctorHostsOf(s);
  const published = new Set(rows.map((r) => r.name));
  const silent = (Array.isArray(s.hostBudgets) ? s.hostBudgets : []).map((h) => h?.name).filter((n) => typeof n === "string" && !published.has(n));
  const block = (r) => {
    if (r.unreadable) return html`<h3>${r.name}</h3><p class="warn">Its published result cannot be read (a worker of another version may have written it).</p>`;
    const problems = doctorProblems(r);
    const shown = problems.slice(0, DOCTOR_CHECKS_SHOWN);
    const hidden = problems.length - shown.length + (Number.isSafeInteger(r.more) ? r.more : 0);
    const stale = doctorStale(r);
    const head = html`<p${r.counts?.fail > 0 ? html` class="bad"` : r.counts?.warn > 0 ? html` class="warn"` : null}>Doctor ran ${ageText(r.ageMs)} ago${r.version ? ` (version ${r.version})` : ""}, ${doctorByText(r)}: ${doctorCountsText(r)}.${r.openshell ? " The openshell venue was judged." : ""}</p>`;
    // A run by another account over the worker's (sudo, a second login) is published like any run, and said: it shows
    // that account's view of the host, not the worker's.
    const replaced = r.workerRun && r.by?.worker !== true ? html`<p class="warn">It replaced the worker's own run of ${ageText(view.now - r.workerRun.at)} ago${Number.isSafeInteger(r.workerRun.uid) ? ` (uid ${r.workerRun.uid})` : ""}, so it shows another account's view of the host.</p>` : null;
    const staleNote = stale ? html`<p class="warn">Stale: older than two of this host's doctor runs (every ${r.every}h), so it may no longer describe the host.</p>` : null;
    const list = table(
      `Doctor checks on ${r.name}`,
      ["Level", "Check", "What doctor said", "Fix"],
      shown.map((c) => html`<tr><td class="${c.level === "fail" ? "bad" : "warn"}">${c.level === "fail" ? "failing" : "warning"}</td><td class="mono">${c.id}</td><td>${cell(c.label)}</td><td>${cell(c.fix)}</td></tr>`),
      "Every check passed.",
    );
    return html`<h3>${r.name}</h3>${head}${replaced}${staleNote}${list}${hidden > 0 ? html`<p class="note">${count(hidden)} more not shown here; pi-dispatch doctor on that host prints them all.</p>` : null}`;
  };
  return html`${rows.length === 0 ? html`<p class="note">No host has published doctor results yet. Each worker runs doctor a minute after it starts and then every PI_DOCTOR_INTERVAL_HOURS (24 by default), and pi-dispatch doctor publishes too.</p>` : rows.map(block)}${silent.length > 0 ? html`<p class="note">No doctor result published by: ${silent.join(", ")}.</p>` : null}${d.more > 0 ? html`<p class="note">${count(d.more)} more hosts published results; not every one is read.</p>` : null}`;
});

/**
 * The Venues panel (issue #712, `DES-OPERATOR-CONSOLE`): every venue this build's table holds, with which live hosts
 * bless it and default to it (their registry rows' `backends` field), each declared property in words (its question,
 * the word and what the word means, the switch or the observation it holds under, and which hosts' floors ask for it),
 * what it serves and who holds its credentials, and per host the OpenShell engine, modes and gateway word. The hosts'
 * published facts plus the static table (`venuesView`); nothing is resolved live, so a word is the DECLARED one.
 */
export const fleetVenues = fromSnapshot("Venues", (s) => {
  const v = venuesView(Array.isArray(s.hostBudgets) ? s.hostBudgets : []);
  const names = (list) => (list.length === 0 ? "no live host" : list.join(", "));
  const floorText = (floor) => Object.entries(floor ?? {}).map(([p, w]) => `${p}=${w}`).join(", ");
  const means = (p) => html`${p.wordText}${p.armedBy ? html`<br><span class="note">Only while ${p.armedBy} is on.</span>` : null}${p.observedText ? html`<br><span class="note">Holds on a host where ${p.observedText}; elsewhere it counts as asserted.</span>` : null}`;
  const floored = (p) => (p.flooredOn.length === 0 ? "-" : p.flooredOn.map((f) => `${f.want} on ${f.host}`).join(", "));
  const venue = (x) => {
    const summary = `${x.name}: ${x.blessedOn.length === 0 ? "blessed on no live host" : `blessed on ${x.blessedOn.join(", ")}`}${x.defaultOn.length > 0 ? `, the default on ${x.defaultOn.join(", ")}` : ""}`;
    const openshell = x.openshell && x.openshell.length > 0
      ? table(`${x.name} OpenShell setup`, ["Host", "Engine", "Modes", "Gateway"], x.openshell.map((o) => (o.unpublished ? html`<tr><td>${cell(o.host)}</td><td colspan="3">${OPENSHELL_UNPUBLISHED_TEXT}</td></tr>` : html`<tr><td>${cell(o.host)}</td><td>${cell(o.engine)}</td><td>${o.modes.length > 0 ? o.modes.join(", ") : "-"}</td><td>${GATEWAY_TEXT[o.gateway] ?? GATEWAY_TEXT.unknown}</td></tr>`)), "")
      : null;
    return html`<details><summary>${summary}</summary><p>Runs in ${x.describe}.</p>${facts([
      ["Blessed on", names(x.blessedOn)],
      ["Default on", names(x.defaultOn)],
      ["Credentials", x.custody === "layer" ? html`held by the venue's egress layer: ${x.custodyText}` : html`in the job's container: ${x.custodyText}`],
    ])}<ul class="plain">${x.serves.map((sv) => html`<li>It ${sv.text ?? `${sv.key}: ${sv.word}`}.</li>`)}</ul>${openshell}${table(
      `${x.name} properties`,
      ["Property", "Word", "What the word means", "Asked for by a floor"],
      x.properties.map((p) => html`<tr><td>${p.question}<br><span class="note mono">${p.property}</span></td><td>${p.word}</td><td>${means(p)}</td><td>${floored(p)}</td></tr>`),
      "",
    )}</details>`;
  };
  return html`<p class="note">What each venue declares is this build's table; which hosts bless it, their floors and their OpenShell setup are what each host's worker published when it started. Nothing here is read live from a host.</p>${
    v.unpublished.length > 0 ? html`<p class="note">Not published by ${v.unpublished.join(", ")} (a worker older than this console).</p>` : null
  }${v.floors.length > 0 ? table("Floors", ["Host", "PI_BACKEND_FLOOR"], v.floors.map((f) => html`<tr><td>${cell(f.host)}</td><td class="mono">${floorText(f.floor)}</td></tr>`), "") : html`<p class="note">No live host published a floor (PI_BACKEND_FLOOR).</p>`}${v.venues.map(venue)}${
    v.others.length > 0 ? html`<p class="warn">Blessed by a host and not in this console's table: ${v.others.map((o) => `${o.name} (${o.blessedOn.join(", ")})`).join("; ")}.</p>` : null
  }`;
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

/**
 * Why a file does not load, as one sentence: the newest published doctor check about that file where one was published
 * (issue #712, `doctorQuote`), naming the host and its age, else the pointer to run doctor. Never the parser's own
 * message, which names this host's path; a published label had its paths cut before it left the host that wrote it.
 */
function doctorReason(s, what) {
  const id = DOCTOR_FILE_CHECKS[what];
  const q = id ? doctorQuote(s, id) : null;
  if (!q) return `The ${what} does not load; run pi-dispatch doctor for the reason.`;
  const where = q.own ? `on this host (${q.host}, ${ageText(q.ageMs)} ago)` : `on ${q.host} (its own copy of the file, ${ageText(q.ageMs)} ago)`;
  return `The ${what} does not load. pi-dispatch doctor ${where} says: ${q.label}${q.fix ? `. Fix: ${q.fix}` : ""}`;
}

/** A file view's trouble as one sentence (no parser message: it names the host's path), or null when it loaded. */
function fileTrouble(v, what, s = null) {
  if (!v) return `The ${what} could not be read.`;
  if (v.unset) return `No ${what} is configured.`;
  if (v.missing) return `The ${what} does not exist.`;
  if (v.invalid) return doctorReason(s, what);
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

/** A trigger's project secret bundle (issue #704) in words: the bundle a cron trigger's jobs hold, or its opt-out. */
function triggerBundleNote(t, bundles) {
  const at = triggerBundleOf(t, bundles);
  if (at === null) return null;
  return at.optedOut ? `opted out of ${at.id !== null ? `bundle ${at.id}` : "every project's bundle"}` : `bundle ${at.id}`;
}

/** What a trigger's jobs carry beyond the flow: each a short word or count, never a value. */
function triggerNotes(t, bundles = null) {
  return [
    t.resume ? "keeps a session" : null,
    t.replicas ? `${t.replicas} replicas` : null,
    t.secrets > 0 ? `${t.secrets} secrets${t.secretsProfile ? ` (profile ${t.secretsProfile})` : ""}` : null,
    triggerBundleNote(t, bundles),
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
  return editor("Change the triggers", html`${actForm("trigger-add", { fields: area("trigger", "New trigger, as the add tool's fields (JSON)", { type: "json", rows: 6, required: true, placeholder: '{"kind": "label", "labels": ["pi"], "flow": "triage"}' }), label: "Preview the add" })}${actForm("trigger-edit", { fields: html`${indexField()}${field("flow", "Flow", { required: true })}${field("backend", `${VENUE_LABEL} (optional)`)}${field("provider", "Provider (optional)")}${field("model", "Model (optional)")}`, label: "Preview the edit" })}${actForm("trigger-delete", { fields: indexField(), label: "Preview the delete" })}`);
}

export const configTriggers = fromSnapshot("Triggers", (s, view) => {
  const v = s.triggers;
  const trouble = fileTrouble(v, "triggers file", s);
  if (trouble) return html`<p class="warn">${trouble}</p>${triggersEditor(view)}`;
  const list = Array.isArray(v.triggers) ? v.triggers : [];
  return html`${table(
    "Triggers",
    [{ num: "#" }, "On", "Runs", "Model", "Notes"],
    list.map((t, i) => {
      const what = t.command ? `command ${t.command}` : `flow ${cell(t.flow)}`;
      const where = t.type === "cron" ? (t.folder ? ` in ${shownPath(t.folder)}` : "") : t.forge ? ` on ${t.forge}` : "";
      const model = [t.provider, t.model].filter(Boolean).join(" / ") || "deployment default";
      return html`<tr><td class="num">${i}</td><td>${triggerOn(t)}</td><td>${what}${where}</td><td>${model}</td><td>${triggerNotes(t, s.secretBundles) || "-"}</td></tr>`;
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
  if (!v || v.invalid) return html`<p class="warn">${doctorReason(s, "settings overlay")}</p>${settingsEditor(view)}`;
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
  const trouble = fileTrouble(v, "pause-windows file", s);
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
  const trouble = fileTrouble(v, "scoped-limits file", s);
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
  const trouble = fileTrouble(v, "projects file", s);
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
  // Issue #712: the PI_SECRET_PROFILES names too (the snapshot's `secretProfilesEnv`), since the worker merges both; a
  // name in both is the worker's ambiguity, which refuses every secrets job, and is marked so.
  const env = s.secretProfilesEnv ?? null;
  const fromEnv = Array.isArray(env?.names) ? env.names : [];
  const envNote = env?.malformed ? html`<p class="warn">PI_SECRET_PROFILES does not parse, so the worker refuses to boot until it is fixed.</p>` : null;
  // "None" only where the console can see both sources; otherwise it names the one it read.
  if (names.length === 0 && fromEnv.length === 0) return html`<p class="note">No secret profile is declared${env?.seen === true ? "" : " in the settings overlay"}.</p>${envNote}${profileUse(s.secretProfiles)}${profilesEditor(view)}`;
  const overlayItem = (n) => (fromEnv.includes(n) ? html`<li class="mono warn">${n} (AMBIGUOUS: also in PI_SECRET_PROFILES, so the worker refuses every secrets job)</li>` : html`<li class="mono">${n}</li>`);
  return html`<p class="note">Names only: a profile's resolver and its references stay in the settings file${fromEnv.length > 0 ? " or the .env" : ""}.</p><ul class="plain">${fromEnv.map((n) => html`<li class="mono">${n} (PI_SECRET_PROFILES)</li>`)}${names.map(overlayItem)}</ul>${envNote}${profileUse(s.secretProfiles)}${profilesEditor(view)}`;
});

/**
 * Each profile's use (issue #712, the snapshot's `secretProfiles`, `secretProfilesView`): its source, where its resolver
 * stands against PI_SECRET_RESOLVER_ROOTS on this host, the triggers and projects that use it, the last resolve a run in
 * view recorded, and the live hosts that advertise it. Words and names only: the view carries no resolver path, so the
 * page cannot (REQ-OPERATOR-CONSOLE-SCREENS (g)). Nothing when no profile is declared or named.
 */
function profileUse(v) {
  const rows = Array.isArray(v?.profiles) ? v.profiles : [];
  if (rows.length === 0) return null;
  return table(
    "Secret profiles in use",
    ["Profile", "Source", "Resolver roots", "Triggers", "Projects", "Last resolve", "Served by"],
    rows.map((row) => {
      const trig = row.triggers.length > 0 ? `${row.triggers.map((i) => `#${i}`).join(", ")}${row.triggersMore > 0 ? ` and ${row.triggersMore} more` : ""}` : "none";
      const proj = [...row.projects, ...(row.projectsMore > 0 ? [`${row.projectsMore} more`] : []), ...(row.anyRepo ? ["any (a webhook trigger)"] : [])].join(", ") || "-";
      const last = row.last ? html`${profileLastText(row.last).replace(/^last resolve: /, "")}${row.last.jobId ? html` (${runLink(row.last.jobId)})` : null}` : "no run in view";
      const warnSource = row.source === "ambiguous" || row.source === "undeclared";
      const warnRoots = row.roots === "outside" || row.roots === "empty";
      return html`<tr><td class="mono">${row.name}</td><td${warnSource ? html` class="warn"` : null}>${PROFILE_SOURCE_TEXT[row.source] ?? "-"}</td><td${warnRoots ? html` class="warn"` : null}>${row.roots !== null ? (PROFILE_ROOTS_TEXT[row.roots] ?? "-") : "not bounded (an env resolver)"}</td><td>${trig}</td><td class="mono">${proj}</td><td${row.last?.outcome === "refused" ? html` class="warn"` : null}>${last}</td><td class="mono">${profileHostsText(row, v).replace(/^served by: /, "")}</td></tr>`;
    }),
    "",
  );
}

/** The bundle resolvers editor (issue #704): a name, its resolver's absolute path and the format it prints. */
function bundleProfilesEditor(view) {
  if (!canAct(view)) return null;
  return editor("Change the bundle resolvers", html`${actForm("secret-bundle-add", { fields: html`${field("name", "Name", { required: true, max: 64 })}${field("path", "Resolver (absolute path)", { required: true, max: 4096 })}${field("format", "Format it prints (dotenv or json)", { required: true, max: 16, placeholder: "dotenv" })}`, label: "Preview the add" })}${actForm("secret-bundle-remove", { fields: field("name", "Name", { required: true, max: 64 }), label: "Preview the removal" })}`);
}

/**
 * The project secret bundles (issue #704): the overlay's bundle resolvers (names and formats), then each bundle the
 * triggers file binds, with its project, its profile and whether this deployment declares it, fork reviews, the
 * endpoints, the triggers that opt out and the variable NAMES the newest run in view received. Never a reference or a
 * value, and nothing is resolved to draw it: `pi-dispatch doctor --secrets` does that on the host that runs the jobs.
 */
export const configSecretBundles = fromSnapshot("Secret bundles", (s, view) => {
  const resolvers = overlayBundleProfiles(s.settings);
  const names = Object.keys(resolvers).sort();
  const rows = Array.isArray(s.secretBundles?.bundles) ? s.secretBundles.bundles : [];
  const declared = names.length === 0 ? html`<p class="note">No bundle resolver is declared in the settings overlay.</p>` : html`<p class="note">Bundle resolvers in the settings overlay (names and formats; the path stays in the file):</p><ul class="plain">${names.map((n) => html`<li class="mono">${n} (${cell(resolvers[n].format)})</li>`)}</ul>`;
  return html`${declared}${table(
    "Secret bundles",
    ["Bundle", "Project", "Profile", "Fork reviews", "Endpoints", "Opted out", "Last received"],
    rows.map((b) => {
      // Under the column headers, so each cell holds the value alone (final review: no repeated label).
      const project = `${b.project ?? "-"}${b.projectKnown === false ? " (not in projects.json)" : ""}`;
      const profile = `${b.profile ?? "-"} (${bundleDeclaredText(b)})`;
      const fork = b.forkReviews ? "yes" : "no";
      const ends = Array.isArray(b.endpoints) && b.endpoints.length > 0 ? bundleEndpointsText(b) : "none";
      const opted = Array.isArray(b.optedOut) && b.optedOut.length > 0 ? b.optedOut.map((i) => `#${i}`).join(", ") : "none";
      const last = b.last ? html`${b.last.variables.length > 0 ? b.last.variables.join(", ") : "none"} (${b.last.jobId ? runLink(b.last.jobId) : "-"})` : "no run in view";
      return html`<tr><td class="mono">${cell(b.id)}</td><td>${project}</td><td${b.declared === "env" || b.declared === "overlay" ? null : html` class="warn"`}>${profile}</td><td>${fork}</td><td class="mono">${ends}</td><td>${opted}</td><td class="mono">${last}</td></tr>`;
    }),
    "The triggers file binds no secret bundle.",
  )}${bundleProfilesEditor(view)}`;
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
