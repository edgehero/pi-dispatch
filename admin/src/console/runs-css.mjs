/**
 * The runs page's own rules (issue #737, PR 4: the RunsScreen, RunsPhone and DataTable cards), unscoped as written:
 * `page-css.mjs` serves them as `PAGE_CSS.runs`, which `pageCss()` confines to `body[data-page="runs"]`. A string
 * module for `style.mjs`'s reason (`dist/console.mjs` ships as one file). It imports nothing from `page-css.mjs`, which
 * imports it: the phone's width is written here (`RUNS_PHONE_MAX`) and the stylesheet test holds it to the shell's.
 *
 * WHAT IT DRAWS THAT bundle.css DOES NOT (each card draws these in its own style block, under its own names):
 *
 * - THE FILTER BAR (`panels/runs.mjs` `runsFilters`, a `form.filterbar` on the page's canvas): every part of a row
 *   stands on the row's bottom edge, where a labelled list's pill ends, so the search pill, the project chips, the
 *   lists, the repository and Apply line up (bundle.css centres a row, and the search pill and the chips stood 13 px
 *   above the lists' pills beside them); Apply is the controls' 48 px (bundle.css draws a button 38 px high, which
 *   stood 8 px above the pills' tops and 18 px above their bottoms); a filter pill
 *   that is a link draws no underline (bundle.css draws the pill as a button); the search pill as wide
 *   as the card's (320 px to grow from, 420 at most), with the focus ring its bare field gives up (bundle.css draws the
 *   field with no outline), and each closed list as a pill of its own width on the canvas, as the audit log draws its
 *   selects (`ui.select`, alone or inside a `ui.field`, whose label then stands above it), its caret centred in the
 *   48 px pill. A field and its select may shrink below their content and never past the row: a select is as wide as
 *   its longest choice, and a model id or a host name of 64 to 128 characters would push a phone's page sideways. On a
 *   phone each takes a row's whole width. bundle.css folds the bar on a phone (`filterbar--collapsible`, the browser
 *   script's class) behind its toggle, all but the search;
 * - A ROW OF CHIPS (`ui.chipRow`: the project pills, the applied filters): wrapping above a phone, where a mouse has no
 *   sideways scroll, and on a phone one line that scrolls inside itself with no scrollbar, as bundle.css draws a
 *   project row there (`.projseg`), padded by 4 px and pulled back by the same margin so a scroll box does not cut a
 *   focus ring. Above a phone a chip whose value is wider than the row (a 200-character repository) breaks it anywhere
 *   and grows down from its one-line 26 px, rather than running past the card. An applied chip's remove link is a
 *   circle 18 px across, as the card's;
 * - THE SUMMARY STRIP (`ui.sumStrip`, the card's counts by outcome): one row of equal columns, each a count in bold in
 *   its status's ink (the idle tone's in ink, as the card writes it) over its label with the status's icon, a link
 *   grounded on hover; "at least" in the label's size and ink before a count that is a lower bound. On a phone the
 *   columns are at least 72 px (four to a 375 px card) and an item marked `hidePhone` is not drawn: the RunsPhone
 *   card's four counts that matter. A label wraps between its icon and its words before it breaks a word, and a count
 *   breaks only where it is wider than its column ("refused" broke as "refus/ed" in a phone's 66 px column when
 *   either could break anywhere);
 * - A TABLE'S DAY ROWS (`ui.tbl`'s `{ group }` rows, `tr.tbl-group`): a header across the table on the inset's ground,
 *   in the muted ink, as the card's day rows; never sticky (bundle.css makes every `th` sticky for the column heads);
 * - THE RUNS TABLE ON A DESKTOP, as the RunsScreen card draws it: the outcome cell (`wide`) at least 240 px, so its
 *   reason reads as a sentence and not a column of words; every other cell but the target's on one line (the card's
 *   `white-space: nowrap`), so a model or a flow never breaks at its hyphens ("claude-/sonnet-/5-5" stood three lines
 *   high in a 71 px column); the target and its project tag may stack where the row is short of room. A value of no
 *   fixed length is a box of its own, as wide as the value up to a bound and broken inside itself (at a hyphen first)
 *   past it, so a long one grows its own row and no other: a job id in its code face up to `RUNS_TABLE.idMaxCh`
 *   characters, which holds a forge delivery's id (`gh-` and a GUID, 39 to 42 characters) in two lines (a box of the
 *   card's 12 broke it into four or five, rows of about 103 px for 66), and a host, a flow or a model
 *   (`panels/runs.mjs` `valueCell`, `.val`) up to `RUNS_TABLE.valueMaxCh`, which holds a model id such as
 *   `claude-sonnet-5-5` on its line (a 64-character host on one line widened the table by 221 px at 1,440). The Ended
 *   cell is the time alone (`panels/runs.mjs` `endedHtml`) under its day's row, as the card writes it: the date and the
 *   zone repeated on every row made it 179 px for the card's 69. Below the card's own width (`RUNS_TABLE.allMin`,
 *   1440 px) a desktop leaves out the columns a phone does (flow, venue, model, tokens, job cap, which the kit marks
 *   `hide-phone`, head and cells), which the RunsPhone card leaves to the run page: with every column the fixture's
 *   runs need a table of about 1,365 px in the macOS font and 1,404 in DejaVu Sans, which scrolled sideways by 136 px
 *   in a 1,280 px window, and without them about 935;
 * - THE RUNS TABLE ON A PHONE, stacked by bundle.css (`tbl--stack`): each run as the RunsPhone card stacks it, by the
 *   kit's cell flags: the job id and, at the right, when it ended; the outcome across the width; the target with its
 *   project tag across the width; the host and, at the right, the cost. Only the host and the cost are labelled, as
 *   the card labels them (the kit writes no `data-l` for a column whose phone label is ""). A cell may shrink below its
 *   content and breaks anywhere where it must: an id is a box of its own as wide as its line at most, so one that fits
 *   moves to the next line whole and only a longer one breaks (a cron run's `repeat:<trigger>:<slot>` can be 140
 *   characters), and a target with no space in it breaks too; the box stands on its line's top, by the row's first
 *   line. A day row is a block of its own there. The reason sentence takes the row's width (bundle.css caps it at
 *   360 px for a table column).
 */

/** bundle.css's phone breakpoint (`@media (max-width: 760px)`), as `page-css.mjs` `TOP_BAR.phoneMax` names it. */
export const RUNS_PHONE_MAX = 760;

/**
 * The runs table on a desktop (see the header): every column from `allMin`, the RunsScreen card's own width, and the
 * phone's columns below it; a job id's box at most `idMaxCh` characters of the code face wide, and a host's, a flow's
 * or a model's (`.val`) at most `valueMaxCh` characters.
 */
export const RUNS_TABLE = Object.freeze({ allMin: 1440, idMaxCh: 22, valueMaxCh: 20 });

const PHONE = `(max-width: ${RUNS_PHONE_MAX}px)`;
const DESKTOP = `not all and ${PHONE}`;

/** The runs page's rules (see the header). */
export const RUNS_CSS = `
.filterbar{align-items:flex-end}
.filterbar>.btn{height:var(--control-h)}
.filterbar .search{flex:1 1 320px;max-width:420px}
.filterbar .search:focus-within{outline:2px solid var(--focus);outline-offset:2px}
.filterbar>.field{flex:0 1 auto;min-width:0;max-width:100%;grid-template-columns:minmax(0,1fr)}
.filterbar .select{flex:0 1 auto;width:auto;min-width:0;max-width:100%;height:var(--control-h);padding-left:18px;border-radius:var(--radius-pill);background-color:var(--surface);background-position:right 18px center,right 13px center;box-shadow:none}
.filterbar>.field>.input{height:var(--control-h);padding:0 18px;border-radius:var(--radius-pill);background:var(--surface);box-shadow:none}
.filterbar>.field>.input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.chiprow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;max-width:100%}
.chiprow>.chip{max-width:100%;height:auto;min-height:26px;padding-top:3px;padding-bottom:3px;white-space:normal;overflow-wrap:anywhere}
.chiprow>.chip>.code{min-width:0;white-space:normal;overflow-wrap:anywhere}
a.fpill{text-decoration:none}
.chip__x{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;margin-right:-4px;border-radius:50%;color:var(--ink-muted)}
.chip__x:hover{color:var(--ink)}
.sumstrip{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
.sumstrip>li{min-width:0}
.sumstrip__i{display:flex;flex-direction:column;gap:2px;height:100%;padding:12px 16px;border-radius:18px;text-decoration:none}
a.sumstrip__i:hover{background:var(--surface-2)}
.sumstrip__i>b{min-width:0;font-size:28px;line-height:32px;font-weight:800;letter-spacing:-0.02em;color:var(--tone-ink,var(--ink));overflow-wrap:break-word}
.sumstrip__i.tone-idle>b{color:var(--ink)}
.sumstrip__i>b>small{font-size:12px;line-height:16px;font-weight:650;letter-spacing:0;color:var(--ink-muted)}
.sumstrip__i>span{display:inline-flex;flex-wrap:wrap;align-items:center;gap:2px 6px;min-width:0;font-size:12px;font-weight:650;color:var(--ink-muted);overflow-wrap:break-word}
.sumstrip__i>span>.ic{color:var(--tone-ink,var(--ink-muted))}
.runs-sum{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;min-width:0;margin-top:var(--space-4)}
.tbl .tbl-group>th{position:static;padding:14px var(--space-5) 8px;background:var(--surface-2);font-size:12px;font-weight:700;color:var(--ink-muted);text-align:left;white-space:normal}
@media ${DESKTOP}{.tbl td.wide{min-width:240px}.tbl td:not(.wide):not(.tgt){white-space:nowrap}.tbl .id .code{display:inline-block;width:max-content;max-width:${RUNS_TABLE.idMaxCh}ch;white-space:normal;overflow-wrap:anywhere}.tbl .val{display:inline-block;width:max-content;max-width:${RUNS_TABLE.valueMaxCh}ch;white-space:normal;overflow-wrap:anywhere}}
@media not all and (min-width: ${RUNS_TABLE.allMin}px){.tbl .hide-phone{display:none}}
@media ${PHONE}{.filterbar>.field,.filterbar>.select{flex:1 1 100%}.chiprow{flex:1 1 100%;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:-4px;padding:4px}.chiprow::-webkit-scrollbar{display:none}.chiprow>*{flex:none}.chiprow>.chip{white-space:nowrap}.chiprow>.chip>.code{white-space:nowrap}.sumstrip{grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:0}.sumstrip>.hide-phone{display:none}.sumstrip__i{padding:10px 6px}.sumstrip__i>b{font-size:22px;line-height:26px}.tbl--stack td{order:5;min-width:0;overflow-wrap:anywhere}.tbl--stack td.id{order:1}.tbl--stack td.when{order:2;text-align:right}.tbl--stack td.wide{order:3}.tbl--stack td.tgt{order:4;grid-column:1/-1}.tbl--stack td.num{order:6;text-align:right}.tbl--stack .id .code{display:inline-block;max-width:100%;white-space:normal;overflow-wrap:anywhere;vertical-align:top}.tbl--stack .reason{max-width:none}.tbl--stack tr.tbl-group{display:block;padding:0}.tbl--stack tr.tbl-group>th{display:block;padding:10px var(--space-4)}}
`;
