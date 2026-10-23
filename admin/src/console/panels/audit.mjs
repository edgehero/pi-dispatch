/**
 * The audit screen's panel, split out of `../panels.mjs` (issue #737), which re-exports what this module exports. The
 * rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the role and
 * run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { html } from "../html.mjs";
import { cell, timeHtml, msOf, usdText, titled, table } from "./common.mjs";

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
    return html`<tr><td class="num">${cell(r.seq)}</td><td>${timeHtml(msOf(r.at))}</td><td>${actor}</td><td>${cell(r.action)}${r.kind ? html` <span class="mono">${cell(r.kind)}</span>` : null}</td><td class="mono">${cell(r.target)}</td><td${r.outcome === "ok" ? null : html` class="warn"`}>${cell(r.outcome)}</td><td>${cell(r.reason)}${Number.isSafeInteger(r.reserve) ? html` reserve ${usdText(r.reserve)}` : null}${Number.isSafeInteger(r.count) ? html` (one of ${r.count})` : null}</td></tr>`;
  });
  const pager = html`<div class="pager">${view.query?.before !== undefined && view.query?.before !== null ? html`<a href="/audit">Newest rows</a>` : null}${a.next !== null && a.next !== undefined ? html`<a href="${`/audit?${new URLSearchParams({ before: String(a.next) })}`}">Older rows</a>` : null}</div>`;
  return titled("Audit log", html`${a.unreadable ? html`<p class="warn">${a.unreadable}</p>` : null}${table("Audit log", [{ num: "Seq" }, "At", "Who", "Action", "Target", "Outcome", "Reason"], body, "The audit log is empty.")}${pager}`);
}
