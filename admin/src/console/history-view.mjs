import { outcomeWord } from "../words.mjs";
import { timeHtml } from "./panels/common.mjs";
import { html } from "./html.mjs";
import * as ui from "./kit.mjs";
import { TIMELINE_ROWS, TIMELINE_ZOOMS, timelineHtml, timelineLegend, timelineModel } from "./timeline.mjs";

export function historyHref(q, over = {}) {
  const next = { ...q, ...over };
  const params = new URLSearchParams();
  for (const key of ["rows", "zoom", "project", "anchor"]) if (next[key] != null) params.set(key, next[key]);
  return "/" + (params.size ? "?" + params : "");
}

export function historyFrame({ model, query, runHref, note = null, runs = null, next = null, olderAt = null }) {
  const span = TIMELINE_ZOOMS[model.zoom].pastMs;
  const anchor = query.anchor ?? model.now;
  const older = historyHref(query, { anchor: Math.max(span, anchor - span) });
  const newer = historyHref(query, { anchor: Math.min(model.now, anchor + span) });
  const navLink = (href, label) => html`<a class="btn btn--sm btn--ghost" data-history-nav href="${href}">${label}</a>`;
  const list = runs === null ? null : html`<details open><summary>Every run on this page (${runs.length})</summary><ol class="history-list">${runs.map((r) => html`<li><a href="${runHref(r.jobId)}">${r.jobId}</a> · ${r.project ?? "no project"} · ${r.target ?? "target not recorded"} · ${outcomeWord(r.outcome, r.reason).word ?? "outcome not known"}<br>${r.startedAt === null ? "Start not recorded" : timeHtml(r.startedAt)} to ${r.endedAt === null ? "End not recorded" : timeHtml(r.endedAt)}</li>`)}</ol></details>`;
  return html`<div data-history-frame data-history-anchor="${anchor}" data-history-zoom="${model.zoom}" data-history-next="${next}" data-history-older="${olderAt}">
    <nav class="history-nav" aria-label="Run history">${navLink(older, "Older")}${navLink(newer, "Newer")}${navLink(historyHref(query, { anchor: null }), "Return to now")}
${runs === null ? null : Object.keys(TIMELINE_ZOOMS).map((zoom) => navLink(historyHref(query, { zoom, anchor }), zoom))}
${runs === null ? null : TIMELINE_ROWS.map((rows) => navLink(historyHref(query, { rows, anchor }), "By " + rows))}
    <span>${timeHtml(model.start)} to ${timeHtml(model.end)}</span></nav>
    <form class="history-nav" data-history-project method="get" action="/">
      <label>Project <input name="project" value="${query.project ?? ""}" placeholder="All projects" pattern="[a-z][a-z0-9-]{0,31}" maxlength="32"></label>
      <input type="hidden" name="zoom" value="${model.zoom}"><input type="hidden" name="rows" value="${model.by}"><input type="hidden" name="anchor" value="${anchor}"><button class="btn btn--sm" type="submit">Show</button>
    </form>
    <p class="card__sub" data-history-zone>UTC. Scroll sideways to browse time, or use Older and Newer.</p>
    <div class="history-window" tabindex="0" role="region" aria-label="Scrollable run history"><div class="history-track">
      <div class="history-edge">${navLink(older, "Older")}</div>${timelineHtml(model, { label: model.by === "host" ? "Runs by host" : "Runs by project", runHref })}<div class="history-edge">${navLink(newer, "Newer")}</div>
    </div></div>
    <aside class="history-preview" data-history-preview hidden aria-live="polite"></aside>
    <p class="card__sub history-status" role="status" data-history-status>${note ?? "Open a run for details. Browse retained history to inspect every run and project."}</p>
${list}
    <div class="history-nav">${runs === null ? null : html`<button class="btn btn--sm" type="button" data-history-restart>Read window again</button>`}${next || runs === null ? html`<button class="btn btn--sm" type="button" data-history-load>${next ? "More runs in this window" : "Browse retained history"}</button>` : null}${olderAt !== null ? navLink(historyHref(query, { anchor: olderAt }), "Previous run") : null}</div>
  </div>`;
}

export function historyPageHtml({ query, now, page, runHref }) {
  const model = timelineModel({ now, anchor: query.anchor ?? now, recorded: true, zoom: query.zoom, rows: query.rows, project: query.project, runs: page.runs });
  const state = page.error ? "Run history could not be read. Try this window again." : page.next ? "More history is available. Continue reading to inspect the remaining runs." : page.partial ? "History is incomplete: a host or some records could not be read. Try again when every worker is online." : page.olderAt !== null ? "This window has been read. Older retained runs are available." : "This window has been read; no older run was found on the hosts read.";
  return ui.card({ title: model.by === "host" ? "Runs by host" : "Runs by project", sub: "Retained run history", body: html`${historyFrame({ model, query, runHref, note: state, runs: page.runs, next: page.next, olderAt: page.olderAt })}<p class="card__sub">Each page is bounded. Offline hosts can hold history that this console cannot read.</p>${timelineLegend()}` });
}
