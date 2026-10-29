/**
 * What more than one screen's panels use (issue #737 split `../panels.mjs` by screen): the formatters, the action form
 * builders, the table and facts builders, the snapshot wrapper and a run's typed cost, then the helpers a screen's
 * section held that another screen reads too, each under a marker naming who shares it. The rules every
 * panel keeps (one pure, deterministic renderer per region, every value through `html`, the role and run-text rule, the
 * action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header. The names exported at the end of
 * this module are shared between the screens' modules only; `../panels.mjs` does not re-export them.
 */
import { DEFER_TIME_MAX_MS } from "@edgehero/pi-dispatch/defer-reasons";
import { formatMicros } from "@edgehero/pi-dispatch/money";
import { classifyRow } from "../../costs.mjs";
import { beatAgeOf } from "../../doctor-view.mjs";
import { fmtCost, usd2 } from "../../panel.mjs";
import { resolveWorkerCount, forgeLinkOf, progressStaleFor } from "../../read-model.mjs";
import { parseRunFilter } from "../../run-filter.mjs";
// The one vocabulary the panel reads too (issue #710): outcome words and tones, the venue label, the Spend and Held titles.
import { NO_EXPLANATION, NO_REASON_FAILED, outcomeKey, outcomeWord, reasonWords, recordReason, shortSentence } from "../../words.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";

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

/**
 * An instant as `YYYY-MM-DD HH:MM UTC` (never the reader's zone, so a page is the same bytes everywhere). Only from 0 to
 * the defer leaf's `DEFER_TIME_MAX_MS`, the year 9999's last instant: outside it the ISO string's year is not four
 * digits, and its first sixteen characters are a date that is not the instant's, so it is "unknown".
 */
export function utcText(ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > DEFER_TIME_MAX_MS) return "unknown";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * An instant as a `<time>` element (issue #710): `utcText`'s bytes as its text, so a page without the script reads UTC
 * exactly as before, and the instant in `datetime` (ISO 8601, UTC), which the browser script (`script.mjs`) rewrites to
 * the reader's local time, keeping the UTC text in `title`. The server never formats a zone it does not know: a page is
 * the same bytes for every reader, and only the reader's own browser knows the reader's zone. "unknown" stays plain text.
 */
export function timeHtml(ms) {
  const text = utcText(ms);
  if (text === "unknown") return text;
  return html`<time datetime="${new Date(ms).toISOString()}">${text}</time>`;
}

/** A record's ISO instant as millis, or NaN. */
const msOf = (iso) => (typeof iso === "string" ? Date.parse(iso) : Number.NaN);

/** Micro-dollars as `$1.20`, `-` for a value that is not an amount. */
export function usdText(micros) {
  return Number.isSafeInteger(micros) && micros >= 0 ? `$${formatMicros(micros)}` : "-";
}

/**
 * Micro-dollars for a list row or an overview line (issue #710): `usd2`'s one fixed form, `$1,234.56`, with the exact
 * amount (`usdText`, every digit the counter holds) in the `title`, so a reader sees a number they can read at a glance
 * and can still hover for the one the ledger holds. `spent: true` for an amount read against a cap, which `usd2` rounds
 * DOWN, so a window one micro-dollar short of its cap never reads as the cap. `-` for a value that is not an amount.
 * Review round 1: the panel's `fmtUsd` was here first, and its ladder printed `$99.99`, `$412` and `$4.1k` in one
 * column, so two rows of a table were not comparable at a glance.
 */
export function moneyHtml(micros, { spent = false } = {}) {
  const full = usdText(micros);
  if (full === "-") return full;
  return html`<span title="${full}">${usd2(micros, { spent })}</span>`;
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
function runLink(jobId, { pulse = false } = {}) {
  const cls = pulse ? "code" : "mono";
  if (jobId === null || jobId === undefined || jobId === "") return "-";
  if (!RUN_ID_RE.test(String(jobId))) return html`<span class="${cls}">${cell(jobId)}</span>`;
  return html`<a class="${cls}" href="${`/run?${new URLSearchParams({ id: String(jobId) })}`}">${String(jobId)}</a>`;
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

// ---- the queue and its hosts (the overview's and the fleet's) --------------------------------------------------------

/**
 * Paused, partly paused or running, as words and a class. A queue no worker drains (`online === false`) is never green
 * (issue #710): "running" there means only that nothing paused it, and jobs pile up behind it.
 */
function pausedState(q, online = true) {
  if (q?.pausedState) return html`<span class="bad">paused (the kill switch is on)</span>`;
  if (q?.pausedPartial) return html`<span class="warn">partly paused: some hosts' queues are paused and others are not</span>`;
  if (online === false) return html`<span class="warn">not paused, but no worker is online</span>`;
  return html`<span class="good">running</span>`;
}

/**
 * How old a host's last beat may be for the host to count as online (issue #710): a minute, four of the worker's 15 s
 * beats. The hosts tables mark an older beat amber by the same bound (`beatCell`). Not the registry row's 90 s TTL,
 * past which the row is gone anyway: a row that still lives with no beat for a minute is a worker that is wedged or
 * dying, and an overview that called it online would say jobs are being run when none is.
 */
export const BEAT_FRESH_MS = MIN;

/**
 * Who drains the queue (issue #710): `{ count, online, connected, staleBeats, none }`.
 *
 * - `count` is the registry-aware worker count (`resolveWorkerCount`, the status line's rule: the registry's rows when it
 *   has any, else BullMQ's `getWorkers`, else "unknown").
 * - `online` is how many registry rows beat within `BEAT_FRESH_MS`, or BullMQ's count for a deployment whose registry
 *   holds no row (a fallback that cannot see beats), or null when the registry could not be read (the page then says it
 *   shows the fleet as last seen, and judges nothing).
 * - `connected` is BullMQ's own worker list for the shared queue (`queue.workers`, 0 where it is "unknown"), and
 *   `staleBeats` is true when it sees more workers than there are fresh beats.
 * - `none` is the overview's warning: no fresh beat AND no worker BullMQ can see.
 *
 * WHY BULLMQ CAN OVERRULE THE BEATS (review round 1). A beat's age is the console's clock minus the worker's own `beatAt`
 * (`readLiveHosts`), so a worker whose clock runs 50 s behind reads 50 s staler than it is and, with a 15 s beat, drops
 * past the minute for part of every minute. BullMQ's list is read from Valkey's client connections and holds no clock at
 * all, so while it sees a worker the page never says "no worker online" nor turns the queue amber; it says the beats look
 * stale instead. The price, taken knowingly: a wedged worker keeps its connection too, so a fleet whose every worker is
 * wedged reads as the note rather than the warning, while the hosts tables still mark each stale beat amber. The other
 * way round is kept: a fresh beat with no BullMQ worker is online, because `getWorkers` rests on
 * CLIENT SETNAME, which some providers do not support (`resolveWorkerCount`'s reason for preferring the registry).
 *
 * A ROW'S AGE ON VALKEY'S CLOCK (issue #737) is now `readLiveHosts`' too: `ttlAgeMs`, the row's TTL minus its PTTL,
 * and `skewMs`, the console's clock against the host's measured from it, beside `staleMs`, which stays the wall-clock
 * difference doctor's skew check needs. The overview's hosts panel says a host's clock is out of step from those
 * (`hostSkewText`, past `HOST_SKEW_CLAIM_MS`). This rule still judges by the beats and BullMQ's list, a beat's age
 * taken as `beatAgeOf` gives it: Valkey's own measure of the row's last refresh where the reader had it (every beat
 * refreshes the row, so it is how long ago the host last beat, whatever the host's clock says), else the wall-clock
 * `staleMs`. A host whose clock runs behind is then beating when it beats, and says so, never "late".
 */
export function workersOnline(s) {
  const q = s?.queue ?? {};
  const hosts = Array.isArray(s?.hostBudgets) ? s.hostBudgets : [];
  const { count: n } = resolveWorkerCount({ hosts, workerCount: q.workers });
  const connected = Number.isSafeInteger(q.workers) && q.workers > 0 ? q.workers : 0;
  if (q.fleetDegraded) return { count: n, online: null, connected, staleBeats: false, none: false };
  if (hosts.length === 0) return { count: n, online: connected, connected, staleBeats: false, none: connected === 0 };
  const online = hosts.filter((h) => beatFresh(h)).length;
  return { count: n, online, connected, staleBeats: connected > online, none: online === 0 && connected === 0 };
}

export { beatAgeOf };

/** Whether a host row beat within `BEAT_FRESH_MS`, by `beatAgeOf` (doctor-view.mjs). */
export function beatFresh(h) {
  const age = beatAgeOf(h);
  return age !== null && age <= BEAT_FRESH_MS;
}

/** A host's last beat as an age, with a warning class once it is older than `BEAT_FRESH_MS`. */
function beatCell(staleMs) {
  if (!Number.isSafeInteger(staleMs)) return html`<td>unknown</td>`;
  return staleMs > BEAT_FRESH_MS ? html`<td class="warn">${ageText(staleMs)} ago</td>` : html`<td>${ageText(staleMs)} ago</td>`;
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

// ---- the active jobs (the overview's and the fleet's; the stale words the run page's too) ----------------------------

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
    // The job id keeps to one line (`keep`): first on the overview, it was broken a character a line on a phone.
    rows.map((j) => html`<tr><td class="keep">${runLink(j.jobId)}</td><td>${cell(j.queue)}</td><td>${cell(j.host)}</td><td>${j.startedAt ? timeHtml(j.startedAt) : "-"}</td><td>${j.startedAt ? ageText(now - j.startedAt) : "-"}</td><td>${progressText(j.progress, now)}</td>${cancel(j)}</tr>`),
    "Nothing is running.",
  );
}

// ---- a run's outcome in a row (the runs list's and the run page's) ---------------------------------------------------

/**
 * A record's outcome in the console's words (words.mjs, the panel's too): completed, refused, failed, awaiting input or
 * cancelled; an outcome this release does not know is shown as it is (escaped, like every record string).
 */
function outcomeText(r) {
  const w = outcomeWord(r?.outcome, r?.reason);
  return w.known ? w.word : cell(r?.outcome);
}

/**
 * What a row says for a run that did not complete and whose record names no reason token (issue #737): the short form
 * of `NO_REASON_FAILED`, derived (`shortSentence`), so the row cannot drift from that sentence. The run page does not
 * draw it: its banner says its own words for a record that names no reason (`run.mjs` `NO_REASON_TEXT`).
 * Outcome-neutral once the verdict is dropped, so a refused record with no token says it too.
 */
export const NO_REASON_SHORT = shortSentence(NO_REASON_FAILED);

/**
 * A run's outcome as a list cell (issue #737, the DataTable and RunsScreen cards): the outcome's badge, then for a run
 * that did not complete why, in one short sentence (`<span class="reason">`). The runs table's Outcome column and the
 * run page's chain draw this one cell.
 *   - A completed run is quiet: the badge in the idle tone with its check, and nothing more, so the runs that need a
 *     person stand out of a list that is mostly completed ones.
 *   - A word that says why (awaiting input, cancelled: `outcomeWord(...).says`) draws the badge alone.
 *   - Otherwise the reason's short catalog sentence (`reasonWords`, its `why` variant included), linked to every run
 *     with the same outcome key and reason where the runs filter accepts the pair (`link`), with the token in the
 *     link's title; a token the catalog does not know is shown as itself, in the code face, with `NO_EXPLANATION`; and
 *     a record with no token says `NO_REASON_SHORT`.
 * ONLY A TOKEN IS EVER PRINTED (words.mjs `recordReason`, the record's own charset), and a job's free-text
 * `failedReason` never comes here (REQ-CONSOLE-SECURITY (l)): an older worker recorded an infrastructure error's
 * message as the reason (an API path, a repository, a library's words), and a record from another host is that host's
 * text, so a reason that is no token is shown to nobody, in either role. Every other string is the catalog's own.
 */
export function outcomeCell(record, { link = true } = {}) {
  const outcome = record?.outcome;
  const raw = record?.reason;
  const w = outcomeWord(outcome, raw);
  const key = outcomeKey(outcome, raw);
  if (key === "completed") return ui.badge("idle", w.word.charAt(0).toUpperCase() + w.word.slice(1), { icon: ui.STATUS.ok.icon });
  const badge = ui.outcomeBadge(outcome, raw);
  if (w.says) return badge;
  const token = recordReason(record);
  if (token === null) return html`${badge}<span class="reason">${NO_REASON_SHORT}</span>`;
  const said = reasonWords(token, typeof record.why === "string" ? record.why : null);
  const text = said.known ? said.short : html`<span class="code">${token}</span>, ${NO_EXPLANATION}`;
  // An outcome this release does not know has no key: its link names the reason alone, which the filter takes.
  const query = key === null ? { reason: token } : { outcome: key, reason: token };
  const href = link && parseRunFilter(query).filter ? `/runs?${new URLSearchParams(query)}` : null;
  return html`${badge}<span class="reason">${href === null ? text : html`<a href="${href}" title="${token}">${text}</a>`}</span>`;
}

// ---- a token cut (the outcome banner's and the failed jobs list's) ---------------------------------------------------

/**
 * The most of a token the catalog or the words do not know (a reason, or an outcome word from a newer worker) that the
 * banner prints, in code points, before its ellipsis.
 */
const BANNER_TOKEN_MAX = 64;

/** `token` cut to `BANNER_TOKEN_MAX` code points with an ellipsis (code points, so a surrogate pair is never split). */
function bannerCut(token) {
  const chars = [...String(token)];
  return chars.length > BANNER_TOKEN_MAX ? `${chars.slice(0, BANNER_TOKEN_MAX).join("")}…` : String(token);
}

// ---- the parked answer form (the parked inbox's and the run page's Chat panel) ---------------------------------------

/**
 * One parked run's answer form (issue #642): the `parked-answer` action, whose preview shows the answer and the reserve
 * and whose server refuses a pull request's park, expired job data and a trigger without `resume`. The parked inbox and
 * the run page's Chat panel (issue #647) draw this one form.
 */
function parkedAnswerForm(jobId) {
  return actForm("parked-answer", { hidden: [["jobId", jobId]], fields: area("text", "Your answer, as the reply on the issue", { rows: 4, required: true, max: 8192 }), label: "Preview the answer" });
}

// Shared with the screens' modules only; `../panels.mjs` does not re-export these.
export {
  SEC, MIN, cell, msOf, count, runLink, targetLink, titled, actForm, field, area, indexField, editor, table, facts,
  fromSnapshot, costText, capMicrosOf, pausedState, beatCell, blessedText, activeTable, outcomeText, bannerCut,
  parkedAnswerForm
};
