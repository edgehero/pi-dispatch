/**
 * The runs screen's panels (issue #737, the RunsScreen, RunsPhone and DataTable cards), split out of `../panels.mjs`,
 * which re-exports what this module exports. The rules every panel keeps (one pure, deterministic renderer per region,
 * every value through `html`, the role and run-text rule, the action controls and the PATHS rule) are stated once, in
 * `../panels.mjs`'s header. Drawn in the Pulse kit's markup: the screen left the legacy layer with this module.
 *
 * Three panels, in page order, each for both roles alike (the runs list holds no free text and no action):
 *   - `p-filters`, a plain GET form to the page itself, so a filtered view is a link like any other and needs no
 *     script: the one search pill, the project chips, a closed list per field and the repository as text, then the
 *     applied filters as chips, each removable. The browser script folds every control but the search behind one
 *     Filters toggle on a phone (`data-collapsible`); without it every filter shows.
 *   - `p-summary`, the last 24 hours by outcome, each count a link to those runs, and their settled spend: the fleet
 *     reader's `runsWindow`, a fold of the wide window it already caches, so it costs no read of its own.
 *   - `p-runs`, the runs themselves, newest first, 50 a page through the whole history (`readRunsPage`), grouped by UTC
 *     day, stacked on a phone, with where they were read from and the pager in the table's foot.
 *
 * THE LISTS OFFER WHAT THE WINDOW HOLDS. A select lists the values the last 24 hours' runs carry (`runsWindow.values`,
 * each held to its field's filter rule by the reader) and the one the query holds, so a person picks a value that finds
 * runs rather than typing one, and an old link's value is still shown as chosen. The outcome and forge lists are closed
 * in code (`OUTCOME_KEYS`, `RUN_KINDS`).
 *
 * EACH PANEL IS ITS MODEL, DRAWN. `runsFiltersModel`, `runsSummaryModel` and `runsTableModel` are pure and return the
 * arguments the panel hands the kit; `runsFilters`, `runsSummary` and `runsTable` draw them and add only fixed text and
 * the bar's own wrappers, so a test reads what a panel shows without parsing its markup, as `timeline.mjs` splits its
 * model from its drawing.
 */
import { DEFER_TIME_MAX_MS } from "@edgehero/pi-dispatch/defer-reasons";
import { RUN_KINDS } from "@edgehero/pi-dispatch/forges";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";
import { forgeLinkOf } from "../../read-model.mjs";
import { RUN_FILTER_FIELDS, runVenueOf } from "../../run-filter.mjs";
import { OUTCOME_KEYS, OUTCOME_KEY_WORDS, VENUE_LABEL, rowNumber } from "../../words.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { RUN_ID_RE, capMicrosOf, costText, count, moneyHtml, msOf, outcomeCell, runCost, utcText } from "./common.mjs";

// ---- the sentences ---------------------------------------------------------------------------------------------------

/** The runs table's foot when the history could not be read at all. */
export const RUNS_UNREADABLE = "The run history could not be read.";
/** This host's own run files could not be read: the rows are the mirror's alone. */
export const RUNS_HOST_UNREADABLE = "This host's run history could not be read.";
/** The fleet's run mirror is off (a single host, or a fleet below the mirror's floor). */
export const RUNS_MIRROR_OFF = "Showing this host's runs: the fleet's run mirror is off.";
/** The mirror could not be read this time. */
export const RUNS_MIRROR_DEGRADED = "Other hosts' runs could not be read; showing this host's.";
/** No run passes the filter. */
export const RUNS_EMPTY = "No run matches.";
/** What the summary and the project chips count: the last 24 hours, while the list pages through the whole history. */
export const RUNS_WINDOW_TEXT = "Counts are of the runs that ended in the last 24 hours.";
/** The summary when the last 24 hours could not be read. */
export const RUNS_WINDOW_UNREAD = "The last 24 hours could not be counted: the run history could not be read.";
/** The summary when a side of the window (this host's files or the mirror) was not read: each count is a floor. */
export const RUNS_WINDOW_PARTIAL = "Part of the run history could not be read, so each count is at least the number shown.";
/** The summary for a project the window counts no outcomes of by itself: more projects ran than it names. */
export const RUNS_WINDOW_EVERY_PROJECT = "These are every project's counts: more projects ran than the window counts one by one.";
/** A day group for runs whose record names no instant (`endedAt`, else `startedAt`) the page can draw. */
export const RUNS_DAY_UNKNOWN = "When they ended is not recorded";

/** The readRunsPage stop, said in the foot: how many runs it examined, and that Older goes on from there. */
export function runsTruncatedText(n) {
  return `Stopped after examining ${count(n)} runs; the next page continues from there.`;
}

/**
 * Where the page's runs came from when the fleet's run mirror was read: the distinct hosts that wrote the page's rows
 * ("read from 3 hosts through the fleet's run mirror"), or null when the mirror was not read or no row names a host.
 */
export function runsSourceText(page) {
  if (page?.mirror !== "ok") return null;
  const hosts = new Set((Array.isArray(page.runs) ? page.runs : []).map((r) => r?.host).filter((h) => typeof h === "string" && h !== ""));
  if (hosts.size === 0) return null;
  return `read from ${count(hosts.size)} ${hosts.size === 1 ? "host" : "hosts"} through the fleet's run mirror`;
}

// ---- links -----------------------------------------------------------------------------------------------------------

/** What each filter field is called on the form and on its chip. */
const FILTER_LABELS = Object.freeze({ repo: "Repository", kind: "Forge", flow: "Flow", trigger: "Trigger", project: "Project", host: "Host", backend: VENUE_LABEL, outcome: "Outcome", reason: "Reason", model: "Model", q: "Search", problems: "Show" });

/**
 * The runs page with `filter` (each set field, in `RUN_FILTER_FIELDS`' order) and `extra` (the pager's `before`). A
 * changed filter starts at the newest runs, so only the pager carries a cursor.
 */
function runsHref(filter, extra = {}) {
  const p = new URLSearchParams();
  for (const k of RUN_FILTER_FIELDS) if (typeof filter?.[k] === "string" && filter[k] !== "") p.set(k, filter[k]);
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const qs = p.toString();
  return qs === "" ? "/runs" : `/runs?${qs}`;
}

/** `filter` without the fields named. */
function without(filter, ...fields) {
  const out = { ...(filter ?? {}) };
  for (const k of fields) delete out[k];
  return out;
}

/** A trigger value as a person reads it: a triggers-file position by its row number ("row 2"), a scheduler id as itself. */
function triggerLabel(v) {
  return /^\d{1,4}$/.test(v) ? `row ${rowNumber(Number(v))}` : v;
}

/** A filter value as its chip shows it: an outcome key by its word, a trigger by `triggerLabel`, the rest as given. */
function chipValue(field, v) {
  if (field === "outcome") return Object.hasOwn(OUTCOME_KEY_WORDS, v) ? OUTCOME_KEY_WORDS[v].word : v;
  if (field === "trigger") return triggerLabel(v);
  if (field === "problems") return "only problems";
  return v;
}

// ---- p-filters -------------------------------------------------------------------------------------------------------

/** A window value list as the reader gives it: strings only (the reader holds each to its field's rule). */
const listOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : []);

/**
 * The filters (the RunsScreen card's bar, the RunsPhone card's fold), as the arguments the panel hands the kit: the
 * search pill's (`search`, `q`: a target, a repository or a job id); how many applied filters the Filters toggle folds
 * (`folded`, every one but the search); the project chips' (`projects`: All, then each project the window counts, the
 * most runs first, then the query's own project when the window does not name it, each keeping the rest of the filter);
 * a closed list each for outcome, forge, reason, flow, trigger, host, venue and model (`selects`: "Any", then the values
 * offered, then the query's own value when they do not hold it); the repository as text (`repo`); the fields the form
 * carries hidden (`hidden`: the project and Only problems are links, not controls, so Apply keeps them); and the applied
 * filters' chips (`applied`), each with the link that drops it. Pure, so a test reads exactly what is drawn.
 */
export function runsFiltersModel(view) {
  const f = view.query?.filter ?? {};
  const w = view.data?.runsWindow ?? null;
  const values = w?.values ?? {};
  const set = RUN_FILTER_FIELDS.filter((k) => typeof f[k] === "string" && f[k] !== "");
  const pick = (field, offered, labelOf = (v) => v) => {
    const opts = [...offered];
    if (typeof f[field] === "string" && !opts.includes(f[field])) opts.push(f[field]);
    const id = `rf-${field}`;
    return { label: FILTER_LABELS[field], id, select: { id, name: field, value: f[field] ?? "", options: [{ value: "", label: "Any" }, ...opts.map((v) => ({ value: v, label: labelOf(v) }))] } };
  };
  const outcomeLabel = (v) => (Object.hasOwn(OUTCOME_KEY_WORDS, v) ? OUTCOME_KEY_WORDS[v].word : v === "policy" ? "policy (the record's value)" : v);
  const listed = Array.isArray(w?.byProject) ? w.byProject.filter((p) => typeof p?.project === "string" && PROJECT_ID_RE.test(p.project)) : [];
  return {
    search: { id: "q", name: "q", value: f.q ?? null },
    folded: set.filter((k) => k !== "q").length,
    projects: [
      { label: "All", count: w ? windowTotal(w) : null, href: runsHref(without(f, "project")), on: f.project === undefined },
      ...listed.map((p) => ({ label: ui.ptag(p.project), count: Number.isSafeInteger(p.count) ? p.count : null, href: runsHref({ ...f, project: p.project }), on: f.project === p.project })),
      ...(typeof f.project === "string" && !listed.some((p) => p.project === f.project) ? [{ label: ui.ptag(f.project), count: null, href: runsHref(f), on: true }] : []),
    ],
    selects: [
      pick("outcome", OUTCOME_KEYS, outcomeLabel),
      pick("kind", RUN_KINDS),
      pick("reason", listOf(values.reason)),
      pick("flow", listOf(values.flow)),
      pick("trigger", listOf(values.trigger), triggerLabel),
      pick("host", listOf(values.host)),
      pick("backend", listOf(values.backend)),
      pick("model", listOf(values.model)),
    ],
    repo: { label: FILTER_LABELS.repo, id: "rf-repo", input: { id: "rf-repo", name: "repo", value: f.repo ?? null, placeholder: "owner/name", autocomplete: "off", spellcheck: false } },
    hidden: ["project", "problems"].filter((k) => typeof f[k] === "string").map((k) => [k, f[k]]),
    applied: set.map((k) => ({ label: FILTER_LABELS[k], value: chipValue(k, f[k]), href: runsHref(without(f, k)) })),
  };
}

/**
 * The filters panel (`runsFiltersModel`, drawn): a plain GET form, `data-collapsible`, so the browser script folds every
 * control but the search behind the Filters toggle on a phone; the toggle is drawn `hidden data-reveal`, so without the
 * script it never shows and every filter does. Under the form, the applied filters' chips and Clear filters.
 */
export function runsFilters(view) {
  const m = runsFiltersModel(view);
  const toggle = ui.filterToggle({ count: m.folded });
  const projects = ui.chipRow(m.projects.map((p) => ui.fpill(p)), { label: "Project" });
  const selects = m.selects.map((s) => ui.field({ label: s.label, id: s.id, control: ui.select(s.select) }));
  const repo = ui.field({ label: m.repo.label, id: m.repo.id, control: ui.input(m.repo.input) });
  const hidden = m.hidden.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);
  const form = html`<form class="filterbar" method="get" action="/runs" role="search" aria-label="Filter runs" data-collapsible>${ui.searchPill(m.search)}${toggle}${projects}${selects}${repo}${hidden}${ui.btn({ type: "submit", label: "Apply" })}</form>`;
  if (m.applied.length === 0) return form;
  return html`${form}${ui.chipRow([...m.applied.map((c) => ui.fchip(c)), ui.btn({ kind: ["sm", "ghost"], label: "Clear filters", href: "/runs" })], { label: "Applied filters" })}`;
}

// ---- p-summary -------------------------------------------------------------------------------------------------------

/** Every run the window counts: the five outcome keys and the outcomes this release does not know. */
function windowTotal(w) {
  const by = w?.byOutcome ?? {};
  return [...OUTCOME_KEYS, "other"].reduce((s, k) => s + (Number.isSafeInteger(by[k]) && by[k] > 0 ? by[k] : 0), 0);
}

/**
 * The counts and the spend the summary draws for the query's project, `{ by, spentMicros, unpriced, every }`: the
 * window's whole with no project chosen, the project's own where the window counts it (`byProject`), none at all where
 * the window names every project that ran and not this one, and the whole again, said so (`every`), where more projects
 * ran than it counts one by one.
 */
function countsFor(w, project) {
  const whole = { by: w.byOutcome ?? {}, spentMicros: w.spentMicros, unpriced: w.unpriced, every: false };
  if (project === undefined) return whole;
  const own = Array.isArray(w.byProject) ? w.byProject.find((p) => p?.project === project) : undefined;
  if (own) return { by: own.byOutcome ?? {}, spentMicros: own.spentMicros, unpriced: own.unpriced, every: false };
  if (Number.isSafeInteger(w.projectsMore) && w.projectsMore > 0) return { ...whole, every: true };
  return { by: {}, spentMicros: 0, unpriced: 0, every: false };
}

/**
 * The last 24 hours by outcome (the RunsScreen card's strip), as the arguments the panel hands the kit, or null when
 * the window could not be read: the five counts (`strip`), each a link to those runs (the chosen project kept), "at
 * least" where the window is a floor (it ended inside the day, or a side of it was not read), the runs of an outcome
 * this release does not know when there are any; then the settled spend and how many runs settled no amount (the
 * chosen project's, as the counts are), the Only problems switch (`show`), and what the counts count (`notes`). Pure.
 */
export function runsSummaryModel(view) {
  const w = view.data?.runsWindow ?? null;
  const f = view.query?.filter ?? {};
  if (!w) return null;
  const floor = w.floor === true || w.partial === true;
  const { by, spentMicros, unpriced, every } = countsFor(w, f.project);
  const n = (k) => (Number.isSafeInteger(by[k]) && by[k] > 0 ? by[k] : 0);
  // A phone draws the four counts that need a look (the RunsPhone card's), leaving out the completed runs.
  const items = OUTCOME_KEYS.map((key) => ({ n: n(key), label: OUTCOME_KEY_WORDS[key].word, status: OUTCOME_KEY_WORDS[key].status, href: runsHref({ project: f.project, outcome: key }), floor, hidePhone: key === "completed" }));
  // An outcome no key names has no filter to link to: counted, not linked, as every surface draws one, as a failure.
  if (n("other") > 0) items.push({ n: n("other"), label: "outcome not known", status: "failed", href: null, floor });
  return {
    strip: { items, label: "Runs that ended in the last 24 hours, by outcome" },
    spentMicros: Number.isSafeInteger(spentMicros) ? spentMicros : null,
    unpriced: Number.isSafeInteger(unpriced) && unpriced > 0 ? unpriced : 0,
    show: [
      { label: "All outcomes", href: runsHref(without(f, "problems")), on: f.problems === undefined },
      { label: "Only problems", href: runsHref({ ...f, problems: "1" }), on: f.problems !== undefined },
    ],
    notes: [RUNS_WINDOW_TEXT, ...(w.partial === true ? [RUNS_WINDOW_PARTIAL] : []), ...(every ? [RUNS_WINDOW_EVERY_PROJECT] : [])].join(" "),
  };
}

/** The summary panel (`runsSummaryModel`, drawn), or `RUNS_WINDOW_UNREAD` alone. */
export function runsSummary(view) {
  const m = runsSummaryModel(view);
  if (m === null) return ui.card({ body: html`<p class="muted">${RUNS_WINDOW_UNREAD}</p>` });
  const unpriced = m.unpriced > 0 ? html`<span class="muted">, ${count(m.unpriced)} ${m.unpriced === 1 ? "run" : "runs"} with no settled amount</span>` : null;
  const spend = html`<span><b>${moneyHtml(m.spentMicros)}</b> settled spend${unpriced}</span>`;
  return ui.card({ body: html`${ui.sumStrip(m.strip.items, { label: m.strip.label })}<div class="runs-sum">${spend}${ui.seg(m.show, { label: "Show" })}</div><p class="card__sub">${m.notes}</p>` });
}

// ---- p-runs ----------------------------------------------------------------------------------------------------------

/** A run's id as its Job cell: a link to its page, or the id as text when `/run?id=` would refuse it. */
function jobCell(jobId) {
  if (typeof jobId !== "string" || jobId === "") return { id: true, html: "-" };
  if (!RUN_ID_RE.test(jobId)) return { id: true, html: jobId };
  return { id: true, html: html`<a href="${`/run?${new URLSearchParams({ id: jobId })}`}">${jobId}</a>` };
}

/**
 * A run's target, linked out to its forge when `forgeLinkOf` builds a link from the deployment's own env, then its
 * project's tag. The kit draws only a link in its own canonical form (`outLink`), which every link `forgeLinkOf` builds
 * is; should one not be, the target is drawn as text rather than the whole page refused for one record.
 */
function targetCell(r, env) {
  const target = typeof r?.target === "string" && r.target !== "" ? r.target : null;
  let shown = target ?? "-";
  const url = target === null ? null : forgeLinkOf(r, env ?? {});
  if (typeof url === "string") {
    try {
      shown = ui.outLink({ href: url, label: target });
    } catch {
      shown = target;
    }
  }
  const project = typeof r?.project === "string" && PROJECT_ID_RE.test(r.project) ? ui.ptag(r.project) : null;
  return { tgt: true, html: project === null ? shown : html`${shown} ${project}` };
}

/** A run's instant in millis, as the history orders it: `endedAt`, else `startedAt`. */
const atOf = (r) => msOf(r?.endedAt ?? r?.startedAt);

/** The UTC day a run ended, as its group row says it ("2026-10-08 UTC"), or the undated group's words. */
function dayLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > DEFER_TIME_MAX_MS) return RUNS_DAY_UNKNOWN;
  return `${new Date(ms).toISOString().slice(0, 10)} UTC`;
}

/**
 * When a run ended, as its Ended cell says it under its day's row (the RunsScreen card's "15:30"): the UTC time alone
 * ("15:30 UTC"), since the row above names the UTC day, in a `<time>` whose `datetime` is the whole instant, which the
 * browser script shows in the reader's own time with the UTC text in `title` (`panels/common.mjs` `timeHtml`'s rule).
 * The day is the row's: every run is drawn under the group row of the day it ended (`dayLabel`), and one with no instant
 * to draw ("unknown") under the undated group's. `data-day` tells the script the row names this time's day, so it keeps
 * the time alone where the reader's day is that UTC day and gives it the reader's date where it is not (any `<time>`
 * without the mark it gives the reader's date always).
 */
export function endedHtml(ms) {
  const text = utcText(ms);
  if (text === "unknown") return text;
  return html`<time datetime="${new Date(ms).toISOString()}" data-day>${text.slice("YYYY-MM-DD ".length)}</time>`;
}

/**
 * A run's own value (its host, flow or model) as its cell holds it: a box (`val`) that keeps it on one line up to
 * `runs-css.mjs` `RUNS_TABLE.valueMaxCh` characters and breaks it inside itself past that, so a 64-character host or
 * a 128-character model id grows its own row and never widens the table; "-" when the record names none.
 */
function valueCell(v) {
  return v === null || v === undefined || v === "" ? "-" : html`<span class="val">${v}</span>`;
}

/**
 * The runs table's columns, as `kit.tbl` takes them. Flow, venue, model, tokens and the job cap (`hidePhone`) are the
 * run page's on a phone and on a desktop narrower than the RunsScreen card (`runs-css.mjs` `RUNS_TABLE.allMin`). On
 * a phone a run is stacked as the RunsPhone card stacks it, which names only the host and the cost: the end time, the
 * job, the target and the outcome stand with no label (`l: ""`, which writes none).
 */
export const RUNS_TABLE_HEADS = Object.freeze([
  Object.freeze({ label: "Ended", l: "" }),
  Object.freeze({ label: "Job", l: "" }),
  Object.freeze({ label: "Target", l: "" }),
  Object.freeze({ label: "Flow", hidePhone: true }),
  "Host",
  Object.freeze({ label: VENUE_LABEL, hidePhone: true }),
  Object.freeze({ label: "Outcome", l: "" }),
  Object.freeze({ label: "Model", hidePhone: true }),
  Object.freeze({ label: "Tokens", num: true, hidePhone: true }),
  Object.freeze({ label: "Cost", num: true }),
  Object.freeze({ label: "Job cap", num: true, hidePhone: true }),
]);

/** One run as a row of cells, in `RUNS_TABLE_HEADS`' order. */
function runCells(r, env, subscriptions) {
  return [
    { when: true, html: endedHtml(atOf(r)) },
    jobCell(r?.jobId),
    targetCell(r, env),
    valueCell(r?.flow),
    valueCell(r?.host),
    ui.vtag(runVenueOf(r)),
    { wide: true, html: outcomeCell(r) },
    valueCell(r?.model),
    Number.isFinite(r?.tokens?.total) ? count(r.tokens.total) : "-",
    costText(runCost(r, subscriptions)),
    moneyHtml(capMicrosOf(r)),
  ];
}

/**
 * The runs (the RunsScreen and DataTable cards), as the arguments the panel hands the kit: newest first, 50 a page, a
 * group row per UTC day, each run's when, id, target and project, flow, host, venue, outcome with its reason's sentence
 * (`outcomeCell`), model, tokens, cost and job cap (`table`, stacked on a phone with the host and the cost named, or
 * null with no run to show), the foot's sentences (`foot`: what the page shows and where it was read from, or why only
 * part of it, or why nothing), and Newest and Older (`pager`). Pure.
 */
export function runsTableModel(view) {
  const page = view.data?.runsPage ?? null;
  const filter = view.query?.filter ?? {};
  const before = view.query?.before;
  const newer = before !== null && before !== undefined ? runsHref(filter) : null;
  const card = { title: "Runs", sub: "newest first", flush: true };
  if (!page || typeof page.refusal === "string") return { card, table: null, foot: [page ? page.refusal : RUNS_UNREADABLE], pager: { newer, older: null, newerLabel: "Newest" } };
  const subs = Array.isArray(view.data?.subscriptions) ? view.data.subscriptions : [];
  const runs = Array.isArray(page.runs) ? page.runs : [];
  const foot = [];
  if (runs.length === 0) foot.push(RUNS_EMPTY);
  else {
    const source = runsSourceText(page);
    foot.push(`${count(runs.length)} ${runs.length === 1 ? "run" : "runs"}${source === null ? "" : `, ${source}`}.`);
  }
  if (page.unreachable) foot.push(RUNS_HOST_UNREADABLE);
  if (page.mirror === "off") foot.push(RUNS_MIRROR_OFF);
  else if (typeof page.mirror === "string" && page.mirror !== "ok") foot.push(RUNS_MIRROR_DEGRADED);
  if (page.truncated) foot.push(runsTruncatedText(page.examined));
  // A group row before each UTC day's first run: the history is newest first, so a day's runs stand together.
  const rows = [];
  let day = null;
  for (const r of runs) {
    const label = dayLabel(atOf(r));
    if (label !== day) rows.push({ group: label });
    day = label;
    rows.push({ cells: runCells(r, view.env, subs) });
  }
  const next = Number.isSafeInteger(page.next) && page.next >= 0 ? page.next : null;
  return {
    card,
    table: runs.length === 0 ? null : { caption: "Runs", heads: RUNS_TABLE_HEADS, rows, stack: true },
    foot,
    pager: { newer, older: next === null ? null : runsHref(filter, { before: next }), newerLabel: "Newest" },
  };
}

/** The runs panel (`runsTableModel`, drawn): a flush card, the table in its scrolling box, the foot under it. */
export function runsTable(view) {
  const m = runsTableModel(view);
  return ui.card({ ...m.card, body: html`${m.table === null ? null : ui.tbl(m.table)}${ui.tblFoot(html`<span>${m.foot.join(" ")}</span>`, ui.pager(m.pager))}` });
}
