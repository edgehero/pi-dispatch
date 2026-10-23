/**
 * The overview screen's panels, split out of `../panels.mjs` (issue #737), which re-exports what this module exports.
 * The rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the role and
 * run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { parseRunFilter } from "../../run-filter.mjs";
import { NO_EXPLANATION, reasonWords } from "../../words.mjs";
import { html } from "../html.mjs";
import { cell, moneyHtml, count, shownPath, table, facts, fromSnapshot, pausedState, workersOnline, beatCell, blessedText, activeTable, ODD_TOKEN_MAX } from "./common.mjs";

// ---- overview --------------------------------------------------------------------------------------------------------

/** The sentence the overview leads with when no worker drains the queue (issue #710). */
export const NO_WORKER_TEXT = "No worker online: jobs queue but nothing runs them.";

/**
 * The softer note when BullMQ sees more workers than beat freshly (review round 1). It claims only what both sources say:
 * a clock out of step is the likely cause, and a wedged worker (which keeps its connection) the other one, so it never
 * says jobs are being run.
 */
export const STALE_BEATS_TEXT = "Host beats look stale (clock skew?), but the queue still sees its workers connected.";

export const overviewState = fromSnapshot("Fleet", (s) => {
  const q = s.queue ?? {};
  const c = q.counts ?? {};
  const w = workersOnline(s);
  const none = w.none;
  // A count BullMQ could not give ("unknown", no registry row either) is not printed as a number of hosts registered.
  const workers =
    w.online === null || (w.online === w.count && !w.staleBeats)
      ? cell(w.count)
      : typeof w.count === "number"
        ? `${count(w.count)} registered, ${count(w.online)} online (a beat in the last minute)${w.staleBeats ? `, ${count(w.connected)} connected to the queue` : ""}`
        : w.online === 0
          ? "none online"
          : `${count(w.online)} online`;
  return html`${none ? html`<p class="warn">${NO_WORKER_TEXT}</p>` : w.staleBeats ? html`<p class="note">${STALE_BEATS_TEXT}</p>` : null}${facts([
    ["Queue", pausedState(q, !none)],
    ["Workers", workers],
    ["Queues", cell(q.queues)],
    ["Waiting", count(c.waiting ?? 0)],
    ["Active", count(c.active ?? 0)],
    ["Delayed", count(c.delayed ?? 0)],
    ["Failed jobs awaiting retry", count(c.failed ?? 0)],
  ])}${q.fleetDegraded ? html`<p class="warn">The host registry could not be read; this shows the fleet as it was last seen.</p>` : null}`;
});

export const overviewHosts = fromSnapshot("Hosts online", (s) => {
  const hosts = Array.isArray(s.hostBudgets) ? s.hostBudgets : [];
  return table(
    "Hosts online",
    ["Host", { num: "Slots" }, { num: "Running" }, "Venues", "Last beat"],
    hosts.map((h) => html`<tr><td>${cell(h.name)}</td><td class="num">${cell(h.concurrency)}</td><td class="num">${Array.isArray(h.jobs) ? h.jobs.filter((j) => !j.o).length : "unknown"}</td><td>${blessedText(h)}</td>${beatCell(h.staleMs)}</tr>`),
    "No host is registered. A worker registers when it starts.",
  );
});

/** The count windows: `[label, counter key, overlay cap key]`. Each counter is the jobs the budget let start. */
const COUNT_WINDOWS = Object.freeze([
  ["Jobs started today", "day", "dailyCap"],
  ["Jobs started this week", "week", "weeklyCap"],
  ["Jobs started this month", "month", "monthlyCap"],
]);

/** The line under the spend windows: they reset on UTC boundaries, not on the reader's local ones. */
export const COUNT_WINDOWS_UTC_TEXT = "Days, weeks (Monday to Sunday) and months here are UTC, as the budget counts them.";

/** A dollar window's name as a page shows it. */
function dollarWindowName(row) {
  if (row.ledger === "deployment") return "deployment";
  if (row.ledger === "model") return `model ${row.name}`;
  return shownPath(row.name);
}

/**
 * The count and token caps against what the windows used (the jobs started, the tokens spent), and every dollar window
 * against its cap, money in `moneyHtml`'s fixed form with the exact amount on hover (issue #710).
 */
function spendBody(s) {
  const overlay = s.settings?.overlay ?? {};
  const b = s.budget ?? {};
  const capOf = (v) => (Number.isInteger(v) ? count(v) : "no cap");
  const countRows = COUNT_WINDOWS.map(([label, key, capKey]) => html`<tr><td>${label}</td><td class="num">${count(Number(b[key] ?? 0))}</td><td class="num">${capOf(overlay[capKey])}</td></tr>`);
  countRows.push(html`<tr><td>Tokens used today</td><td class="num">${count(Number(b.tokensToday ?? 0))}</td><td class="num">${capOf(overlay.dailyTokenCap)}</td></tr>`);
  const counts = table("Job and token windows", ["Window", { num: "Used" }, { num: "Cap" }], countRows, "");
  const d = s.dollars;
  let dollars;
  if (!d) dollars = html`<p class="note">No dollar window is set.</p>`;
  else {
    const rows = (Array.isArray(d.rows) ? d.rows : []).map((r) => html`<tr${r.full ? html` class="warn"` : null}><td>${dollarWindowName(r)}</td><td>${cell(r.window)}</td><td class="num">${r.counterMicros === null ? "unread" : moneyHtml(r.counterMicros, { spent: true })}</td><td class="num">${moneyHtml(r.capMicros)}</td><td>${r.full ? "full" : "open"}</td></tr>`);
    dollars = html`${d.unreachable ? html`<p class="warn">The dollar counters could not be read.</p>` : null}${Array.isArray(d.invalid) && d.invalid.length > 0 ? html`<p class="warn">Not a dollar amount: ${d.invalid.join(", ")}</p>` : null}${table("Dollar windows", ["Window", "Period", { num: "Spent and held" }, { num: "Cap" }, "State"], rows, "No dollar window is set.")}`;
  }
  // Both kinds of window are the budget's own keys (worker/src/budget.mjs, dollar-budget.mjs): UTC days, Monday-to-Sunday
  // UTC weeks and UTC months, whatever zone the page's times are shown in (review round 1).
  return html`${counts}<h3>Dollars</h3>${dollars}<p class="note">${COUNT_WINDOWS_UTC_TEXT}</p>`;
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

/**
 * One of the day's most frequent refusal reasons (issue #710): its catalog sentence cut for a row (`reasonWords`), linked
 * to the runs it refused, with the token in the link's `title` and the count after it. The link only for a pair the
 * runs filter accepts (`parseRunFilter`, the runs row's rule); a token the catalog does not know is printed as itself,
 * cut to `ODD_TOKEN_MAX`, with "no explanation yet". Only the record's closed `reason` enum comes here.
 */
function refusalItem({ reason, count: n }) {
  const said = reasonWords(reason);
  const query = { outcome: "policy", reason };
  const chars = [...String(reason)];
  const words = said.known ? said.short : `${chars.length > ODD_TOKEN_MAX ? `${chars.slice(0, ODD_TOKEN_MAX).join("")}…` : reason}, ${NO_EXPLANATION}`;
  const link = parseRunFilter(query).filter ? html`<a href="${`/runs?${new URLSearchParams(query)}`}" title="${reason}">${words}</a>` : words;
  return html`<li>${link} <span class="note">(${count(n)})</span></li>`;
}

/**
 * The overview's day of trouble (issue #710): the failed runs and the refused ones of the last 24 hours, the refusals
 * with their five most frequent reasons. A refusal is what both surfaces call "refused" (`refusalsIn`): an operator's
 * cancel is a `policy` record too, and it is not counted, which the line says, since the runs list it links to shows
 * every `policy` record. Both counts come from the one wide window, so both are floors together.
 */
export const overviewFailures = fromSnapshot("Problems (24h)", (s) => {
  if (s.failures24h === null || s.failures24h === undefined) return html`<p class="warn">The run history could not be read.</p>`;
  const floor = s.failures24hFloor ? "at least " : "";
  const n = s.failures24h;
  const failed = html`<p><span class="big${n > 0 ? " warn" : ""}">${floor}${count(n)}</span> failed ${n === 1 ? "run" : "runs"}. <a href="${`/runs?${new URLSearchParams({ outcome: "failed" })}`}">See failed runs</a></p>`;
  const r = s.refusals24h;
  const refused =
    r && Number.isSafeInteger(r.count)
      ? html`<p><span class="big${r.count > 0 ? " warn" : ""}">${floor}${count(r.count)}</span> refused ${r.count === 1 ? "run" : "runs"}, not counting runs an operator cancelled. <a href="${`/runs?${new URLSearchParams({ outcome: "policy" })}`}">See refused runs</a></p>${Array.isArray(r.top) && r.top.length > 0 ? html`<ul class="plain">${r.top.map(refusalItem)}</ul>` : null}`
      : null;
  return html`${failed}${refused}${s.failures24hFloor ? html`<p class="note">Every run read was inside the day, so there may be more.</p>` : null}`;
});

export const overviewActive = fromSnapshot("Active jobs", (s, view) => activeTable(s, view.now));
