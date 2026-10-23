/**
 * The runs screen's panels, split out of `../panels.mjs` (issue #737), which re-exports what this module exports. The
 * rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the role and
 * run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { UNATTRIBUTED_BACKEND } from "@edgehero/pi-dispatch/backends";
import { RUN_FILTER_FIELDS, parseRunFilter } from "../../run-filter.mjs";
import { NO_EXPLANATION, TONE_CLASS, VENUE_LABEL, outcomeWord, reasonWords } from "../../words.mjs";
import { html } from "../html.mjs";
import { cell, timeHtml, msOf, moneyHtml, count, runLink, targetLink, titled, table, runCost, costText, capMicrosOf, outcomeText, ODD_TOKEN_MAX } from "./common.mjs";

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

/** One run as a table row. The outcome cell takes its tone's class (`warn` for refused, awaiting input and cancelled, `bad` for failed). */
function runRow(r, env, subscriptions) {
  const at = msOf(r.endedAt ?? r.startedAt);
  const tone = TONE_CLASS[outcomeWord(r.outcome, r.reason).tone] ?? null;
  return html`<tr><td>${timeHtml(at)}</td><td>${runLink(r.jobId)}</td><td>${targetLink(r, env)}</td><td>${cell(r.flow)}</td><td>${cell(r.host)}</td><td>${runVenue(r)}</td><td${tone !== null ? html` class="${tone}"` : null}>${outcomeText(r)}${reasonPart(r)}</td><td>${cell(r.model)}</td><td class="num">${Number.isFinite(r.tokens?.total) ? count(r.tokens.total) : "-"}</td><td class="num">${costText(runCost(r, subscriptions))}</td><td class="num">${moneyHtml(capMicrosOf(r))}</td></tr>`;
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
