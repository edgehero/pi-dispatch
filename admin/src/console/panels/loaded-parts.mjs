/**
 * Drawing what `loaded-words.mjs` says (issue #800): its lines' parts as markup, each value through the template's escaper,
 * and the pieces the run page, a sandbox and a project page share. The words are that module's; nothing here decides what a
 * record means.
 */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { runLink, timeHtml } from "./common.mjs";

/** A line's parts: text, `{ code }`, `{ b }`, `{ muted }`, `{ run }`, `{ time }`, and `{ repository }`, a link where the forge gives one. */
export function wordsHtml(parts, { repositoryHref = null } = {}) {
  return html`${(Array.isArray(parts) ? parts : [parts]).map((part) => {
    if (part === null || part === undefined) return null;
    if (typeof part !== "object") return String(part);
    if (typeof part.code === "string") return html`<span class="code">${part.code}</span>`;
    if (typeof part.b === "string") return html`<b>${part.b}</b>`;
    if (typeof part.muted === "string") return html`<span class="muted">${part.muted}</span>`;
    if (typeof part.run === "string") return runLink(part.run, { pulse: true });
    if (Number.isFinite(part.time)) return timeHtml(part.time);
    if (typeof part.repository === "string") return repositoryHref === null ? part.repository : ui.outLink({ href: repositoryHref, label: part.repository });
    return null;
  })}`;
}

/** The status line: its icon and words in its tone. */
export const stateLine = (status, icon, body) => html`<span class="ld-st tone-${ui.STATUS[status].tone}">${ui.icon(icon, { size: "sm" })}<span>${body}</span></span>`;

/** One line per kind: `{ icon, label, value, more }`. */
export function loadedList(rows, options = {}) {
  return html`<ul class="ld-list">${rows.map((row) => html`<li class="ld-row"><span class="ld-k">${ui.icon(row.icon, { size: "sm" })}${row.label}</span><span class="ld-v">${wordsHtml(row.value, options)}${row.more === null || row.more === undefined || row.more.length === 0 ? null : html`<small>${wordsHtml(row.more, options)}</small>`}</span></li>`)}</ul>`;
}

/** The note under a card or a list, with its icon. */
export const loadedFoot = (text) => html`<p class="ld-foot">${ui.icon("info", { size: "sm" })}<span>${text}</span></p>`;

/**
 * Where a problem is fixed, as a button. A link to a page or the forge, so never a write; still an operator's, because the
 * card gives a viewer the same words and no button. A repository with no forge link (a local run) has nothing to open.
 */
export function fixButton(fix, { repositoryHref = null } = {}) {
  if (fix === null || fix === undefined) return null;
  if (fix.kind === "repository") return repositoryHref === null ? null : ui.outLink({ href: repositoryHref, label: html`${ui.icon(fix.icon, { size: "sm" })}${fix.label}`, btn: ["sm"] });
  return ui.btn({ href: fix.href, label: fix.label, kind: "sm", icon: fix.icon });
}
