/**
 * The parked inbox's panel, split out of `../panels.mjs` (issue #737), which re-exports what this module exports. The
 * rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the role and
 * run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { parkedVerdictOf } from "@edgehero/pi-dispatch/chat-mode";
import { html } from "../html.mjs";
import { cell, ageText, timeHtml, RUN_ID_RE, runLink, targetLink, canAct, editor, table, fromSnapshot, parkedAnswerForm } from "./common.mjs";

// ---- parked ----------------------------------------------------------------------------------------------------------

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
    rows.map((p) => html`<tr><td>${targetLink(p, view.env)}</td><td>${cell(p.kind)}</td><td>${runLink(p.jobId)}</td><td>${timeHtml(p.parkedAt)}</td><td>${ageText(p.ageMs)}</td><td class="num">${Number.isInteger(p.chainCount) ? p.chainCount : "unknown"}</td><td>${answerCell(p)}</td></tr>`),
    "Nothing is parked.",
  )}${unknownNote}${answers}`;
});
