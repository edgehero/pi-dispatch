/**
 * The parked page's own rules (issue #737, PR 4: the ParkedPhone card, and the desktop Parked page in the
 * ApprovalRequest card's frame, its Questions tab alone), unscoped as written: `page-css.mjs` serves them as
 * `PAGE_CSS.parked`, which `pageCss()` confines to `body[data-page="parked"]`. A string module for `style.mjs`'s reason.
 * It imports nothing from `page-css.mjs`, which imports it.
 *
 * Two parts, so the question card can be served wherever it is drawn:
 *
 * - `QCARD_CSS`, the question card and its answer form (`kit.mjs` `questionCard`, `answerForm`), the ParkedPhone card's
 *   own rules under the kit's names: the card a grid of its rows; its first row the parked tile, "<id> asks" (the one
 *   part that gives way, its id a box of its own that breaks anywhere only when it is wider than its line: a run id
 *   can be 200 characters) and the wait in the parked ink at its right; the meta line wrapping, a target or a chain
 *   note breaking anywhere rather than widening the card; the body on the parked tint; the form a grid, its buttons one
 *   row that wraps, Preview the answer taking the room Open run leaves. Only the parked page draws the card yet; the
 *   rules are a part of their own so that a run page drawing it for a run that waits (the RunParked card) can serve
 *   them beside its own;
 * - the page's layout: the tabs, then the questions beside the side column ("how answers work"), the ApprovalRequest
 *   card's two columns (bundle.css's `.cols`), one column below `PARKED_LAYOUT.stackMax` (the side column is
 *   `--side-w`, 470 px: at 1,024 px it would leave the questions 490), and on a phone, as bundle.css draws `.cols`
 *   there.
 */

/** bundle.css's phone breakpoint, as `page-css.mjs` `TOP_BAR.phoneMax` names it (the stylesheet test holds the two). */
export const PARKED_PHONE_MAX = 760;

/**
 * The parked page's layout breakpoint: up to here the questions and the side column are one column, as the overview's
 * two-column rows are (`page-css.mjs` `OVERVIEW_LAYOUT.stackMax`, the same 1,199 px and for the same reason).
 */
export const PARKED_LAYOUT = Object.freeze({ stackMax: 1199 });

/** The question card and its answer form, wherever they are drawn (see the header). */
export const QCARD_CSS = `
.qcard{display:grid;gap:var(--space-3);min-width:0}
.qcard__top{display:flex;align-items:center;gap:10px;min-width:0;font-size:15px}
.qcard__top>b{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.qcard__top .code{display:inline-block;max-width:100%;font-size:14px;font-weight:700;white-space:normal;overflow-wrap:anywhere}
.qcard__wait{flex:none;font-size:12px;font-weight:700;color:var(--parked-ink)}
.qcard__meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;font-size:12px;color:var(--ink-muted)}
.qcard__meta>*{min-width:0;overflow-wrap:anywhere}
.qcard__body{padding:12px 14px;border-radius:var(--radius-md);background:var(--parked-tint);color:var(--ink);font-size:14px;line-height:20px;overflow-wrap:anywhere}
.qform{display:grid;gap:var(--space-3);min-width:0}
.qform__act{display:flex;flex-wrap:wrap;gap:6px}
.qform__act>.btn{max-width:100%}
.qform__act>.btn--answer{flex:1 1 auto}
`;

/** The parked page's rules: the card's, then the layout (see the header). */
export const PARKED_CSS = `${QCARD_CSS}
.tabs+.cols{margin-top:var(--space-4)}
@media (max-width: ${PARKED_LAYOUT.stackMax}px){.cols{grid-template-columns:minmax(0,1fr)}}
@media (max-width: ${PARKED_PHONE_MAX}px){.tabs+.cols{margin-top:12px}}
`;
