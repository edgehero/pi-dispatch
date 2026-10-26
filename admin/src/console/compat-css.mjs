/**
 * TEMPORARY: the look of the panels no page PR has converted yet (issue #737). Delete this file with the last legacy
 * page; nothing else is meant to outlive it.
 *
 * WHY IT EXISTS. PR 1 gives every page the Pulse shell, but each page's panels convert in their own PR, and until then
 * their markup stays byte-identical inside `<div class="legacy">` (the goldens prove it), one wrapper per panel since
 * PR 2 (the write flow's slot is placed between two wrappers, never inside one, so it keeps the Pulse look: inside one,
 * this layer's `button` and `ul` rules would outrank the bar's own). That markup was styled by
 * the insights CSS and the old layout, on a dark palette of literal colours. Served beside `bundle.css` unchanged, it
 * would break three ways: the old rules would reach the shell and the converted cards (they style bare `button`,
 * `section`, `h2`); bundle.css styles a dozen class names the old markup also uses for something else (`.kpi`,
 * `.banner`, `.note`, `.cap`...), so the old panels would be laid out by the new components' rules; and the old colours
 * would ignore the theme. So everything here applies ONLY inside `.legacy`, in this order:
 *
 *   1. the collision neutraliser (`NEUTRALISED`): every bundle.css selector that names a class and whose every class
 *      the old markup can emit, reverted to the browser's own style. Written `:where(.legacy) X` so it carries X's own
 *      specificity exactly: it beats bundle.css by coming later, and every old rule below (one class more specific,
 *      `.legacy X`) beats it back. The obvious `.legacy :is(...)` would outrank `.legacy *` and `.legacy p`, the old
 *      margins, and every old note would gain the browser's paragraph margin. One rule per specificity, because `:is()`
 *      takes its most specific member's (`specificity`). It covers selectors that name a CLASS only: bundle.css's
 *      element rules (`body`, `button`, `table`, `a`...) reach the old markup too and are not reverted, because the
 *      legacy rules below restyle those elements themselves, inside `.legacy`, after them;
 *   2. the old `--pd-*` custom properties, each defined from a Pulse token (`PD_TOKENS`), so they follow the theme;
 *   3. `INSIGHTS_CSS` with each palette colour rewritten to its property, and the old layout (`LAYOUT_CSS`, the
 *      shell's rules gone with the old header);
 *   4. the Pulse look over both: each panel a card, its heading a card title, tables, buttons as pills, inputs as Pulse
 *      inputs, the insights boxes as insets;
 *   5. the charts' SVG colours, which are presentation attributes a custom property cannot reach, re-pointed at tokens
 *      (`svgPaint`: the palette's roles, and `SVG_EXTRA` for the topology's own colours): an author rule beats a
 *      presentation attribute;
 *   6. the phone rules that keep `/insights` inside 375 px.
 *
 * HOW ITS DELETION IS FORCED. `console-compat.test.mjs` ratchets it: every class a rule here names must still be
 * emitted by the old markup (a converted page takes its classes with it, and the dead rule fails the test until it is
 * removed), the neutraliser must cover exactly the selectors that can still collide, a converted page's golden may not
 * carry `.legacy` or a class only this layer styles, and once `LEGACY_PAGES` is empty `LEGACY_CSS` must be `""`. The
 * dead-rule check has a blind spot it cannot close: it reads some files whatever is legacy (`html.mjs`, `pages.mjs`,
 * the transcript, the insights renderers), so a class only those emit always counts as emitted, and its rule can never
 * fail as dead. The empty-set rule is the backstop: the last converted page deletes this whole file, dead rules and
 * all. (The action previews left that list in PR 2: their bars are `confirm-view.mjs`'s Pulse markup, outside every
 * wrapper, and the rules that drew the old ones went with them. The overview left it in PR 3, and no rule went with
 * it: every class its old panels drew is still drawn by another old page or by `common.mjs`, and the ratchet holds the
 * neutraliser and the dead-rule check to that. The runs and parked pages left it in PR 4, and the old pager went with
 * them: the runs table's Newer and Older links were the last old markup to draw `.pager`, so its two rules and its
 * collision went too.)
 */
import { PAGE_THEME } from "../graph-html.mjs";
import { INSIGHTS_CSS } from "../insights-html.mjs";
import { scopeCss, selectorsOf } from "./page-css.mjs";

/**
 * The bundle.css selectors that can match old markup: each one whose every class the old panels, the insights
 * renderers or the script still emit. Pinned, not trusted: `console-compat.test.mjs` derives the set from bundle.css
 * and the old sources and requires this list to equal it.
 */
export const NEUTRALISED = Object.freeze([
  ".badge",
  ".banner",
  ".big",
  ".cap",
  ".code",
  ".facts",
  ".kpi",
  ".kpi b",
  ".kpi span",
  ".note",
  ".phases",
  ".phases .bar",
  ".phases .bar i",
  ".phases li",
  ".wl",
]);

/** The colliding classes: those a neutralised selector starts with, which bundle.css styles wherever they appear. */
export const COLLISIONS = Object.freeze([...new Set(NEUTRALISED.map((s) => /^\.([\w-]+)/.exec(s)[1]))].sort());

/**
 * A plain selector's specificity as one comparable number (ids, then classes and attributes, then types). Exported for
 * the stylesheet test, which holds every member of one neutraliser rule to one specificity.
 */
export function specificity(selector) {
  if (/:(?:is|not|where|has)\(|::/.test(selector)) throw new Error(`compat: not a plain selector: ${selector}`);
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length;
  const types = (selector.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + types;
}

/** The neutraliser: one `:where(.legacy) :is(...)` rule per specificity, so each rule carries its members' own. */
function neutraliser() {
  const groups = new Map();
  for (const s of NEUTRALISED) groups.set(specificity(s), [...(groups.get(specificity(s)) ?? []), s]);
  return [...groups.keys()]
    .sort((a, b) => a - b)
    .map((k) => `:where(.legacy) :is(${groups.get(k).join(",")}){all:revert}`)
    .join("\n");
}

/** The old palette by role: the insights page's (`PAGE_THEME`) and the banner fill `INSIGHTS_CSS` writes literally. */
const OLD_PALETTE = Object.freeze({ ...PAGE_THEME, bannerBg: "#2d1517" });

/** The Pulse token behind each old role, the old layout's control ground included. Every `OLD_PALETTE` role has one. */
export const PD_TOKENS = Object.freeze({
  canvas: "canvas",
  panel: "surface",
  border: "line",
  fg: "ink",
  dim: "ink-muted",
  accent: "focus",
  amber: "attention-ink",
  danger: "failed-ink",
  green: "ok-ink",
  chipStroke: "line-strong",
  bannerBg: "failed-tint",
  control: "surface-3",
});

/** A role's custom property: `chipStroke` is `--pd-chip-stroke`. */
const pdOf = (role) => `--pd-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * `css` with each old palette colour replaced by its role's property. Longest first, and never inside a longer hex
 * literal (the lookahead), so `#999` cannot rewrite part of `#9999aa`.
 */
function themed(css) {
  let out = css;
  for (const [role, hex] of Object.entries(OLD_PALETTE).sort((a, b) => b[1].length - a[1].length)) {
    out = out.replace(new RegExp(`${hex}(?![0-9a-fA-F])`, "gi"), `var(${pdOf(role)})`);
  }
  return out;
}

/**
 * The old console layout, moved here from `style.mjs` as it was, minus the old header's rules (`html`, `body`, `.top`,
 * `.brand`, `.who`, `#live-status`, `main`: the shell draws those now) and the tile rules no panel emits any more.
 */
const LAYOUT_CSS = `
a{color:var(--pd-accent)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--pd-accent);outline-offset:2px}
button,input,select{font:inherit;color:var(--pd-fg);background:var(--pd-control);border:1px solid var(--pd-border);border-radius:6px;padding:4px 10px}
section[data-panel]{max-width:none;margin:0 0 16px;padding:12px 14px;background:var(--pd-panel);border:1px solid var(--pd-border);border-radius:6px}
section[data-panel] section{margin:12px 0;max-width:none}
section[data-panel] h2{font-size:14px;margin:0 0 8px}
p{margin:4px 0}
.note{color:var(--pd-dim);font-size:12px}
.warn{color:var(--pd-amber)}
.bad{color:var(--pd-danger)}
.good{color:var(--pd-green)}
.big{font-size:22px;font-weight:600}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;font-size:13px}
.facts dt{color:var(--pd-dim)}
.facts dd{margin:0;overflow-wrap:anywhere}
.scroll{overflow-x:auto}
table.grid{border-collapse:collapse;width:100%;font-size:13px}
table.grid th,table.grid td{text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid var(--pd-border);vertical-align:top}
table.grid th{color:var(--pd-dim);font-weight:500}
table.grid td.num,table.grid th.num{text-align:right}
table.grid tr.warn td{color:var(--pd-amber)}
table.grid td.keep,table.grid td.keep .mono{white-space:nowrap;overflow-wrap:normal}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}
form.filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px 12px;align-items:end}
form.filters label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--pd-dim)}
form.filters .actions{display:flex;gap:8px;align-items:center}
.range{display:flex;gap:8px;list-style:none}
.range a{padding:3px 10px;border:1px solid var(--pd-border);border-radius:6px;text-decoration:none}
.range a[aria-current="page"]{background:var(--pd-control);font-weight:600}
details{margin:6px 0}
details summary{cursor:pointer}
details p{margin:4px 0 4px 16px}
ul.plain{list-style:none}
ul.plain li{margin:2px 0}
.hidden-tips{display:none}
form.act{display:inline-flex;flex-wrap:wrap;gap:6px 10px;align-items:end;margin:2px 4px 2px 0}
form.act label{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--pd-dim)}
form.act textarea{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--pd-fg);background:var(--pd-canvas);border:1px solid var(--pd-border);border-radius:6px;padding:4px 8px;min-width:280px}
.forms form.act{display:flex;margin:8px 0;padding:8px 0;border-top:1px solid var(--pd-border)}
td.acts form.act{margin:0 4px 0 0}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
details.editor{margin:10px 0}
details.editor>summary{font-size:13px;color:var(--pd-accent)}
.preview-area{flex-basis:100%;margin-top:6px;padding:8px;border:1px solid var(--pd-border);border-radius:6px;background:var(--pd-canvas);font-size:12px}
pre.answer{margin:6px 0;overflow-x:auto;font-size:12px;line-height:1.4}
code.mono{padding:1px 4px;border:1px solid var(--pd-border);border-radius:4px;background:var(--pd-canvas)}
section.transcript-section{margin:0 0 16px;padding:12px 14px;background:var(--pd-panel);border:1px solid var(--pd-border);border-radius:6px}
section.transcript-section h2{font-size:14px;margin:0 0 8px}
.t-status{font-size:12px;color:var(--pd-dim)}
.t-status.on{color:var(--pd-green)}
.t-status.off{color:var(--pd-amber)}
.transcript{max-height:70vh;overflow-y:auto;padding:4px 8px;border:1px solid var(--pd-border);border-radius:6px;background:var(--pd-canvas)}
.t-entry{padding:6px 0;border-bottom:1px solid var(--pd-border)}
.t-entry header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-size:12px;color:var(--pd-dim)}
.t-entry .t-kind{font-weight:600;color:var(--pd-fg)}
.t-entry pre{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.4}
@media (max-width:640px){.facts{grid-template-columns:1fr}}
`;

/**
 * The insights page's own font (`css` is `INSIGHTS_CSS`; its `body` rule), read from that rule rather than restated, or
 * a throw when the rule no longer says one: a silent fallback would draw the charts in the console's font, which cuts
 * their labels (see `PULSE_LOOK`). Exported, with the stylesheet as a parameter, so the test can show the throw.
 */
export function insightsFont(css = INSIGHTS_CSS) {
  const m = /(?:^|\n)body\{[^}]*?(?:^|[{;])font:([^;}]+)/.exec(css);
  if (!m) throw new Error("compat: INSIGHTS_CSS's body rule names no font");
  return m[1].trim();
}

/**
 * The Pulse look over the old rules. Here and in the phone block, `body` is the legacy wrapper itself (`scopeCss` maps
 * a selector's leading `body` to the scope, as it does for `INSIGHTS_CSS`'s own `body` rule), so `body>section` is each
 * old panel.
 *
 * The old panels' text takes the console's font (`font:inherit`), but the charts and the topology keep the insights
 * font (`svg`): their renderers size every box and cut every label by a column estimate made for that font, and the
 * label fitter (`.github/scripts/label-fit-check.mjs`) measured needless cuts and a label on a wire once they were drawn
 * in the console's (another family, and tabular figures).
 *
 * Each old panel is a card with no margin of its own: since PR 2 every panel is in a wrapper of its own, and the grid's
 * gap spaces the cards (16 px, 12 px on a phone, the margin they had in one wrapper).
 *
 * THE WRAPPER DRAWS NO BOX (`display: contents`): its one section (`console-compat.test.mjs` holds each wrapper to
 * exactly one) is the grid's cell itself. A panel with nothing to say is empty and not drawn (`SHELL_CSS`'s
 * `section[data-panel]:empty`), and with no box around it it takes no cell and no gap; as a block, every wrapper of an
 * empty panel was a cell of no height with the grid's 16 px gap after it (the run page drew a 112 px hole). `:has()` could hide such a wrapper instead, but needs Chrome 105, Safari 15.4 and Firefox 121, past the
 * console's floor; `display: contents` is in all three of the floor's versions. The wrapper only carried what its
 * children inherit (the `--pd-*` properties, the ink and the font, which a box-less element still passes down) and a
 * ground of its own that drew nothing, so there is no box to lose.
 *
 * A CONTROL DRAWN WITH THE SECONDARY FILL WEARS THE STALE RING: a button, the editor's summary and a range
 * link are pills of `surface-3` and nothing else, which on a page shown as last seen (its panels flat on the canvas,
 * `page-css.mjs` `SHELL_CSS`) left a word with no shape. The flat panel hands down `--stale-ring`; anywhere else it is
 * unset, and the control draws no ring.
 */
const PULSE_LOOK = `
body{display:contents;color:var(--ink);font:inherit}
svg{font:${insightsFont()}}
body>section[data-panel],body>section.transcript-section{max-width:none;min-width:0;margin:0;padding:var(--space-5);border:0;border-radius:var(--radius-lg);background:var(--surface)}
section[data-panel] h2,section.transcript-section h2{margin:0 0 var(--space-3);font-size:17px;line-height:24px;font-weight:650;color:var(--ink)}
section[data-panel] section{margin:var(--space-5) 0 0;padding-top:var(--space-4);border-top:1px solid var(--line)}
section[data-panel] section:first-of-type{margin-top:var(--space-3);padding-top:0;border-top:0}
section[data-panel] section h2{margin-bottom:var(--space-2);font-size:15px;line-height:20px}
h3{margin:var(--space-4) 0 var(--space-2);font-size:13px;line-height:18px;font-weight:650;color:var(--ink)}
h3:first-child{margin-top:0}
p{margin:6px 0}
a{color:var(--focus);font-weight:600;text-decoration:none}
a:hover{text-decoration:underline}
.note,.dim{color:var(--ink-muted)}
.note{font-size:12px;line-height:16px}
.big{font-size:28px;line-height:34px;font-weight:800;letter-spacing:-0.02em}
.mono,code.mono,form.act textarea{font-family:var(--font-mono)}
.mono{font-size:13px}
code.mono{padding:1px 6px;border:0;border-radius:6px;background:var(--surface-2)}
ul:not(.plain):not(.range),ol{padding-left:20px;list-style:revert}
.facts{gap:0}
.facts dt,.facts dd{padding:8px 0;border-bottom:1px solid var(--line)}
.facts dt{padding-right:var(--space-5);color:var(--ink-muted)}
.facts dt:last-of-type,.facts dd:last-of-type{border-bottom:0}
table.grid{border-collapse:separate;border-spacing:0}
table.grid th,table.grid td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
table.grid time,table.grid .mono{white-space:nowrap;overflow-wrap:normal}
table.grid th:first-child,table.grid td:first-child{padding-left:0}
table.grid th:last-child,table.grid td:last-child{padding-right:0}
table.grid th{font-size:12px;font-weight:650;color:var(--ink-muted);white-space:nowrap}
table.grid tbody tr:last-child td{border-bottom:0}
button{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 18px;border:0;border-radius:var(--radius-pill);background:var(--surface-3);box-shadow:var(--stale-ring,none);color:var(--ink);font-size:14px;font-weight:650;white-space:nowrap;cursor:pointer}
button[disabled]{opacity:.45;cursor:not-allowed}
td button,.preview-area button{height:30px;padding:0 13px;font-size:13px}
form.filters button[type="submit"]{background:var(--primary);color:var(--on-primary)}
input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select,textarea{min-width:0;height:42px;padding:0 14px;border:0;border-radius:var(--radius-md);background:var(--surface-2);box-shadow:inset 0 0 0 1.5px var(--line-strong);color:var(--ink);font-size:14px;font-weight:400}
textarea,form.act textarea{height:auto;min-height:92px;padding:12px 14px;border:0;border-radius:var(--radius-md);background:var(--surface-2);font-size:13px;font-weight:400;line-height:20px;resize:vertical}
select{appearance:none;padding-right:36px;background-image:linear-gradient(45deg,transparent 50%,var(--ink-muted) 50%),linear-gradient(135deg,var(--ink-muted) 50%,transparent 50%);background-position:right 18px top 19px,right 13px top 19px;background-size:5px 5px;background-repeat:no-repeat}
input::placeholder,textarea::placeholder{color:var(--ink-faint)}
form.filters{gap:var(--space-3)}
form.filters label,form.act label{gap:6px;font-size:12px;font-weight:650;color:var(--ink-muted)}
.forms form.act{gap:var(--space-3);margin:var(--space-3) 0 0;padding:var(--space-3) 0 0;border-top:1px solid var(--line)}
details.editor{margin:var(--space-3) 0 0}
details.editor>summary{display:inline-flex;align-items:center;height:30px;padding:0 13px;border-radius:var(--radius-pill);background:var(--surface-3);box-shadow:var(--stale-ring,none);color:var(--ink);font-size:13px;font-weight:650;list-style:none}
details.editor>summary::-webkit-details-marker{display:none}
details.editor[open]>summary{background:var(--primary);color:var(--on-primary)}
.range a{display:inline-flex;align-items:center;height:30px;padding:0 13px;border:0;border-radius:var(--radius-pill);background:var(--surface-3);box-shadow:var(--stale-ring,none);color:var(--ink);font-size:13px;font-weight:650;text-decoration:none;white-space:nowrap}
.range{flex-wrap:wrap;gap:6px}
.range a[aria-current="page"]{background:var(--primary);color:var(--on-primary)}
.preview-area{margin-top:var(--space-2);padding:var(--space-3) var(--space-4);border:0;border-radius:var(--radius-md);background:var(--surface);box-shadow:inset 0 0 0 2px var(--primary);font-size:13px}
pre.answer{padding:8px 14px;border-radius:var(--radius-md);background:var(--surface-2);font-family:var(--font-mono);font-size:12.5px;line-height:20px}
.transcript{padding:4px 14px;border:0;border-radius:var(--radius-md);background:var(--surface-2)}
.t-entry{border-bottom-color:var(--line)}
.t-entry:last-child{border-bottom:0}
#windows{margin:0 0 var(--space-3)}
#kpis{gap:var(--space-3)}
.kpi,.plan,#budget,#split,.bl,#legend,#dollars{border:0;border-radius:var(--radius-md);background:var(--surface-2)}
.kpi{padding:12px 16px;min-width:140px}
.kpi .v{font-size:22px;line-height:28px;font-weight:750;letter-spacing:-0.02em}
.kpi .l{font-size:12px;font-weight:600;color:var(--ink-muted)}
.plan,#budget,#split,.bl,#legend,#dollars{padding:12px 16px}
.lever{overflow-wrap:anywhere}
.plan.hypo{box-shadow:inset 0 0 0 1.5px var(--line-strong)}
.badge{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:var(--radius-pill);background:var(--surface-3)}
.badge.good{background:var(--ok-tint)}
.badge.bad{background:var(--attention-tint)}
.banner{padding:10px 14px;border:0;border-radius:var(--radius-md);font-size:13px;font-weight:600}
#grid,#flows,#sizes{grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3)}
#grid>*,#flows>*,#sizes>*{min-width:0}
.bl{overflow-x:auto}
progress{width:140px;height:8px;border:0;border-radius:var(--radius-pill);background:var(--dot-off);vertical-align:middle;appearance:none}
progress::-webkit-progress-bar{border-radius:var(--radius-pill);background:var(--dot-off)}
progress::-webkit-progress-value{border-radius:var(--radius-pill);background:var(--running)}
progress::-moz-progress-bar{border-radius:var(--radius-pill);background:var(--running)}
#wrap{border:0;border-radius:var(--radius-md);background:var(--surface-2)}
#tip{border:0;border-radius:var(--radius-md);background:var(--surface);box-shadow:inset 0 0 0 1px var(--line),0 8px 24px rgba(0,0,0,.14)}
`;

/** Text in a colour that is a ground elsewhere: drawn in ink, so a label never takes a chip's pale fill. */
const SVG_TEXT = Object.freeze({ "#999": "ink-muted", "#a6bbcf": "ink-muted" });

/**
 * The fill and stroke token for each colour literal the renderers draw that is not an `OLD_PALETTE` role
 * (`graph-html.mjs`: chip labels and pale chip fills, ports, group boxes, status squares, wires, badges). Category
 * hues become one neutral ground, as Pulse draws categories; status keeps its status colour. Pinned: the test requires
 * these keys plus the palette's to be exactly the hex literals the two renderers hold.
 */
export const SVG_EXTRA = Object.freeze({
  "#333": ["ink", "ink"],
  "#d9d9d9": ["surface", "line-strong"],
  "#a6bbcf": ["surface-3", "ink-faint"],
  "#d8bfd8": ["surface-3", "line-strong"],
  "#e7e7ae": ["surface-3", "line-strong"],
  "#c0deed": ["surface-3", "line-strong"],
  "#c7e9c0": ["surface-3", "line-strong"],
  "#fdd0a2": ["surface-3", "line-strong"],
  "#E6E0F8": ["ink-faint", "ink-faint"],
  "#ff5f57": ["failed", "failed"],
  "#6e7681": ["idle", "ink-muted"],
  "#db6d28": ["attention", "attention"],
});

/** Every SVG paint rule: the palette's roles by their properties, the extras by token, then the text overrides. */
function svgPaint() {
  const rules = [];
  for (const [role, hex] of Object.entries(OLD_PALETTE)) rules.push(`svg [fill="${hex}"]{fill:var(${pdOf(role)})}`, `svg [stroke="${hex}"]{stroke:var(${pdOf(role)})}`);
  for (const [hex, [fill, stroke]] of Object.entries(SVG_EXTRA)) rules.push(`svg [fill="${hex}"]{fill:var(--${fill})}`, `svg [stroke="${hex}"]{stroke:var(--${stroke})}`);
  for (const [hex, token] of Object.entries(SVG_TEXT)) rules.push(`svg text[fill="${hex}"],svg tspan[fill="${hex}"]{fill:var(--${token})}`);
  // A meter's track is an outline in the border colour (the budget rows, the split): Pulse draws a filled bed instead.
  rules.push(`svg rect[fill="none"][stroke="${OLD_PALETTE.border}"]{fill:var(--dot-off);stroke:none}`);
  return rules.join("\n");
}

/**
 * The phone: a card's padding as bundle.css draws it there, and `/insights` inside 375 px: the side-by-side chart grids
 * one column, the budget rows wrapping instead of running off the page, and a chart wider than its box scrolling inside
 * it. Only the topology, which has a `viewBox`, shrinks to fit: the other charts are drawn in pixels with no `viewBox`,
 * so `max-width:100%` would not scale them but crop them, and the cut is their right edge, which is today. A wide
 * table keeps a readable width by its column count and scrolls in its `.scroll` box, as bundle.css's wide tables do.
 * A table cell does not wrap there: an id, a model (`claude-sonnet-5-5`), a queue (`pi-jobs@mini1`) or a trigger name
 * broke at its hyphens into two lines that read as two values. A cell of prose (a sentence, then a `<br>` and its note)
 * and a row-wide note (`colspan`) still wrap, as does code in prose outside a table. (The scoped limits table, a long
 * scope beside its limits, so takes the width at which its limits read on one line, and scrolls.) The cards stand
 * 12px apart, as bundle.css spaces them there: `<main>`'s gap on a phone, between the wrappers.
 */
const PHONE_CSS = `
@media (max-width: 760px){
body>section[data-panel],body>section.transcript-section{padding:var(--space-4);border-radius:22px}
#grid,#flows,#sizes{grid-template-columns:minmax(0,1fr)}
section[data-panel] section{overflow-x:auto}
svg[viewBox]{max-width:100%;height:auto}
.facts{grid-template-columns:minmax(0,1fr)}
.facts dt{padding:8px 0 0;border-bottom:0}
.facts dd{padding-top:2px}
.plan{min-width:0;flex:1 1 100%}
.kpi{flex:1 1 140px;min-width:0}
#budget .row,#split .row{flex-direction:column;align-items:flex-start;gap:2px}
#budget .row span{white-space:normal}
#legend,#dollars{max-width:none}
form.act textarea{min-width:0;width:100%}
form.act label{flex:1 1 100%}
form.filters{grid-template-columns:repeat(2,minmax(0,1fr))}
table.grid:has(thead th:nth-child(4)){min-width:520px}
table.grid:has(thead th:nth-child(6)){min-width:720px}
table.grid:has(thead th:nth-child(9)){min-width:960px}
table.grid td:not([colspan]):not(:has(br)){white-space:nowrap}
}
`;

/** The old `--pd-*` properties on the legacy wrapper, each from its Pulse token (resolved there, so per theme). */
const PD_VARS = `:root{${Object.entries(PD_TOKENS).map(([role, token]) => `${pdOf(role)}:var(--${token})`).join(";")}}`;

/** The compatibility stylesheet, every rule inside `.legacy`, the neutraliser first (see the header). */
export const LEGACY_CSS = [neutraliser(), ...[PD_VARS, themed(INSIGHTS_CSS), LAYOUT_CSS, PULSE_LOOK, svgPaint(), PHONE_CSS].map((css) => scopeCss(".legacy", css))].join("\n");

/** Every class a rule here names (the wrapper's own aside), for the ratchet that fails a rule once nothing emits it. */
export const LEGACY_CLASSES = Object.freeze(
  [...new Set(selectorsOf(LEGACY_CSS).flatMap((s) =>[...s.replace(/\[[^\]]*\]/g, "").matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])))]
    .filter((c) => c !== "legacy")
    .sort(),
);
