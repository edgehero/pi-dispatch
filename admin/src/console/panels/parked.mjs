/**
 * The Parked page's panel (issue #737: the ParkedPhone card, and on a wide screen the Parked frame the ApprovalRequest
 * card draws, with its Questions tab alone), split out of `../panels.mjs`, which re-exports what this module exports.
 * The rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the role and
 * run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header. Drawn in the
 * Pulse kit's markup: the screen left the legacy layer with this module.
 *
 * ONE PANEL, `p-questions` (`parkedQuestions`): the Questions tab with its count, then a card per parked run nobody has
 * answered (`ui.questionCard`), newest first as the snapshot lists them, and beside them how answers work. Approvals
 * are issue #649's, so the page has no Approvals tab and no approval card.
 *
 * NO QUESTION TEXT (REQ-CONSOLE-SECURITY clause l). The question is the run's last assistant message, which is
 * transcript text, and transcript text is shown only in the run page's transcript section. The parked fold reads run
 * records, and a record holds no free text by construction, so a card has no question to show: it says where the
 * question is read instead (`PARKED_QUESTION_WHERE`), for both roles.
 *
 * EACH CARD'S ANSWER, in this order:
 *   1. a run queued or running on its target takes the answer (`parkedVerdictOf`'s `answeringJobId`): that run, linked;
 *   2. the pending-answer scan could not tell (`parkedVerdictOf`'s sentence, the run page's Chat panel's own): said;
 *   3. a viewer, or a console that takes no changes: nothing more (cards without forms);
 *   4. the planner's own check (`data.parkedChecks[jobId]`, `parkedAnswerCheckOf`'s answer, which the page reads for
 *      the first `PARKED_CHECKS_MAX` rows `parkedCheckRows` names): ok draws the answer form (`ui.answerForm`); a
 *      refusal draws the attention banner (`PARKED_ELSEWHERE_TITLE`) with the planner's sentence; a check that could
 *      not be read, or none read, says so and leaves the answer to the run page, whose Chat panel checks again.
 * The form follows an ok alone: a pull request's park, expired job data or a comment trigger without `run.resume` is
 * refused by the planner whatever the page draws, and a box that refuses after the answer is typed wastes the typing.
 *
 * THE BANNER'S SENTENCE IS THE PLANNER'S, whole. Each of `parkedAnswerRefusalOf`'s sentences already says what to do
 * where something can be done ("answer on the forge instead"), and for the trigger's refusals (no comment trigger, a
 * command, no `run.resume`) a reply on the forge would not resume the run either (the receiver's rule), so the banner
 * adds no "answer on the forge" of its own.
 */
import { parkedVerdictOf } from "@edgehero/pi-dispatch/chat-mode";
import { DEFER_PROJECT_RE } from "@edgehero/pi-dispatch/defer-reasons";
import { forgeLinkOf } from "../../read-model.mjs";
import { capitalised } from "../../words.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { RUN_ID_RE, ageText, canAct, count } from "./common.mjs";
import { OVERVIEW_LINKS, OVERVIEW_UNREAD_TEXT } from "./overview.mjs";

// ---- the sentences -----------------------------------------------------------------------------------------------------

/** Where a parked run's question is read: never on this page (see the header). */
export const PARKED_QUESTION_WHERE = "The question is the run's last message: read it on its issue or pull request, or on its run page while its live transcript is kept (24 hours after the run).";

/** The banner's title over the planner's refusal, where the answer form would be. */
export const PARKED_ELSEWHERE_TITLE = "This question cannot be answered here";

/**
 * How answers work, the side column's card. One sentence true on every console, so it names the console that can take
 * an answer rather than saying "here": a read-only console draws the same card, and no answer can be given from it.
 */
export const PARKED_HOW = "A parked run asked a question and ended; a reply on its issue or merge request resumes it, and an operator can answer it on the Parked page of a console that takes changes.";

/** The empty state: no parked run waits for an answer. */
export const PARKED_EMPTY = "Nothing is parked.";

/** The line under the answer box: what happens after the preview. */
export const PARKED_ANSWER_HINT = "Nothing is sent until you confirm. The answer resumes the run as a reply on its issue would, and is posted there as a comment.";

/** Before the link to the run that takes the answer now. */
export const PARKED_ANSWERING = "Being answered by the run queued or running on its target now:";

/** The planner's check of this question could not be read this time. */
export const PARKED_CHECK_UNREAD = "Whether this question can be answered here could not be read; the next refresh checks again.";

/** No planner check was read for this question (past the page's first `PARKED_CHECKS_MAX`, or no reader for it). */
export const PARKED_CHECK_SKIPPED = "Whether an answer can be built here was not checked on this page; its run page checks, and takes the answer there.";

/** The parked fold that could not be read, with the reader's reason: never an empty inbox. */
export const parkedUnreadText = (reason) => `The parked runs could not be read (${reason}); this is not an empty inbox.`;

// ---- the planner checks the page reads -----------------------------------------------------------------------------------

/**
 * The most rows a Parked page asks the planner's check for (`pages.mjs`, through `parkedAnswerCheckOf`, cached per run
 * for its `PARK_CHECK_CACHE_MS`): each is a read of one job's data and the triggers file, so a page of a hundred parks
 * does not read a hundred jobs a tick. A row past it gets `PARKED_CHECK_SKIPPED` and its run page.
 */
export const PARKED_CHECKS_MAX = 20;

/** A parked row's verdict, from its pending-answer scan (`parkedVerdictOf`, the Chat panel's rule). */
const verdictOf = (p) => parkedVerdictOf(p?.pendingScan);

/** Whether a row's job id is one `/run?id=` and the answer action take. */
const idOk = (p) => typeof p?.jobId === "string" && RUN_ID_RE.test(p.jobId);

/**
 * The rows whose planner check the page reads (`data.parkedChecks`): the snapshot's parked rows that could take an
 * answer now (a run id, and `parkedVerdictOf` says reply), in its order, at most `PARKED_CHECKS_MAX`. ONE rule, so the
 * page reads a check for exactly the rows whose card asks for one.
 */
export function parkedCheckRows(snapshot) {
  const rows = Array.isArray(snapshot?.parked) ? snapshot.parked : [];
  return rows.filter((p) => idOk(p) && verdictOf(p).mode === "reply").slice(0, PARKED_CHECKS_MAX);
}

// ---- the panel ---------------------------------------------------------------------------------------------------------

/** A page's link from the caller's page table (`view.pages`, `pages.mjs`' `PAGES`), else the overview's copy of it. */
function hrefTo(view, name, query = null) {
  const pages = view?.pages !== null && typeof view?.pages === "object" ? view.pages : OVERVIEW_LINKS;
  return ui.pageHref(pages, name, query) ?? ui.pageHref(OVERVIEW_LINKS, name, query);
}

/** A project id as the projects file spells one, or null. */
const projectOf = (p) => (typeof p?.project === "string" && DEFER_PROJECT_RE.test(p.project) ? p.project : null);

/**
 * A row's target, linked to its issue on the forge where `forgeLinkOf` builds a link from the deployment's own env
 * (`ui.outLink`, the one shape of a link out of the console), else in the code face; null for a row with none.
 */
function targetOf(p, env) {
  if (typeof p?.target !== "string" || p.target === "") return null;
  const href = forgeLinkOf(p, env ?? {});
  if (typeof href === "string") {
    try {
      return ui.outLink({ href, label: p.target, code: true });
    } catch {
      // A link the kit would not write as a browser reads it back: the target as text instead.
    }
  }
  return html`<span class="code">${p.target}</span>`;
}

/** How many times the row's session was resumed (the session store's count), or nothing where it is not known here. */
function chainText(n) {
  if (!Number.isSafeInteger(n) || n < 0) return null;
  if (n === 0) return "not resumed yet";
  return n === 1 ? "resumed once" : `resumed ${count(n)} times`;
}

/** The meta line's last part: the forge and how often the session was resumed. */
function whereOf(p) {
  const parts = [typeof p?.kind === "string" && p.kind !== "" ? p.kind : null, chainText(p?.chainCount)].filter((x) => x !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** A card's answer slot (see the header's order), or null. */
function answerOf(p, i, view) {
  const v = verdictOf(p);
  if (v.answeringJobId !== null) {
    const href = hrefTo(view, "run", { id: v.answeringJobId });
    return html`<p class="muted">${PARKED_ANSWERING} ${href === null ? html`<span class="code">${v.answeringJobId}</span>` : html`<a class="link code" href="${href}">${v.answeringJobId}</a>`}.</p>`;
  }
  if (v.mode !== "reply") return html`<p class="muted">${v.says}</p>`;
  if (!canAct(view) || !idOk(p)) return null;
  // Its own key only: a run id may be `__proto__`, which a plain object's lookup would answer with its prototype.
  const checks = view.data?.parkedChecks;
  const check = checks !== null && typeof checks === "object" && Object.hasOwn(checks, p.jobId) ? checks[p.jobId] : null;
  if (check?.ok === true) return ui.answerForm({ jobId: p.jobId, id: `answer-${i + 1}`, hint: PARKED_ANSWER_HINT, runHref: hrefTo(view, "run", { id: p.jobId }) });
  if (typeof check?.refusal === "string") {
    const said = check.refusal.trim();
    return ui.banner({ status: "attention", title: PARKED_ELSEWHERE_TITLE, body: `${capitalised(said)}${/[.!?]$/.test(said) ? "" : "."}` });
  }
  return html`<p class="muted">${check?.unreachable ? PARKED_CHECK_UNREAD : PARKED_CHECK_SKIPPED}</p>`;
}

/** One parked row as its card (`ui.questionCard`). */
function cardOf(p, i, view) {
  const jobId = typeof p?.jobId === "string" && p.jobId !== "" ? p.jobId : "-";
  return ui.questionCard({
    jobId,
    runHref: idOk(p) ? hrefTo(view, "run", { id: p.jobId }) : null,
    waited: Number.isFinite(p?.ageMs) && p.ageMs >= 0 ? ageText(p.ageMs) : null,
    project: projectOf(p),
    target: targetOf(p, view.env),
    where: whereOf(p),
    body: PARKED_QUESTION_WHERE,
    answer: answerOf(p, i, view),
  });
}

/**
 * `p-questions`: the Questions tab, the cards (or the fold's unread sentence, the snapshot's, or the empty state) in the
 * main column, and how answers work in the side one. A count is drawn on the tab only where the list was read whole.
 */
export function parkedQuestions(view) {
  const s = view?.data?.snapshot ?? null;
  const unread = s === null ? OVERVIEW_UNREAD_TEXT : typeof s.parkedUnreachable === "string" && s.parkedUnreachable !== "" ? parkedUnreadText(s.parkedUnreachable) : null;
  const rows = s !== null && unread === null && Array.isArray(s.parked) ? s.parked : [];
  const tabs = ui.tabs([{ label: "Questions", count: unread === null ? rows.length : null, href: hrefTo(view, "parked"), current: true }], { label: "Parked" });
  const main = unread !== null
    ? ui.banner({ status: "attention", title: unread })
    : rows.length === 0
      ? ui.card({ body: ui.empty({ status: "ok", icon: "done", title: PARKED_EMPTY }) })
      : rows.map((p, i) => cardOf(p, i, view));
  const how = ui.card({ title: "How answers work", body: html`<p class="muted">${PARKED_HOW}</p>` });
  return html`${tabs}<div class="cols"><div class="stack">${main}</div><div class="stack">${how}</div></div>`;
}
