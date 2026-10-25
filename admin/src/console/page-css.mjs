/**
 * The console's own rules after the Pulse stylesheet (issue #737): what the shell needs that `components/bundle.css`
 * does not draw (`SHELL_CSS`), each page's own rules (`PAGE_CSS`), and the one function that confines a block of rules
 * to a part of the document (`scopeCss`).
 *
 * WHY A SCOPER AND NOT HAND-PREFIXED RULES. A page's rules must not reach another page, and the compatibility layer's
 * must not reach the shell or a converted panel. Both are written as plain CSS and confined by one function: a rule
 * that forgets its prefix cannot exist, and a rule the function cannot confine (a selector that names the document
 * below its start, an `@import`, a nested at-rule, `@keyframes`, whose names are global) THROWS when the module loads,
 * so it fails the build instead of leaking. `html`, `body` and `:root` at a selector's start stand for the scope
 * itself, which is how a page's "whole page" rule (`body{...}`) reads once confined.
 *
 * PAGE CSS. A page PR adds `PAGE_CSS[<page>]`, the card's own small style, and `pageCss()` serves it under
 * `body[data-page="<page>"]`, the attribute every page's body carries. PR 1 added none; PR 2 adds the sign-in pages',
 * the error pages' and the audit log's.
 *
 * THE BROWSER FLOOR (`docs/console.md`: Chrome 88, Safari 14, Firefox 78). A rule that needs a newer feature (`:has()`,
 * a container query) must leave the page readable where it is not understood: a browser drops the whole rule, so the
 * rule may only add to a layout that already works without it.
 */
import { BTN_KINDS } from "./kit.mjs";
import { PULSE_CSS } from "./pulse-css.mjs";

/** A selector's start that names the document itself: replaced by the scope. */
const ROOT_START = /^(?:html|body|:root)(?![\w-])/;

/** The document named anywhere after a selector's start: a rule the scope cannot confine. */
const ROOT_LATER = /(?:^|[\s>+~(,])(?:html|body)(?![\w-])|:root(?![\w-])/;

/** A page name `PAGE_CSS` may key: the `PAGES` names' charset. */
const PAGE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * `css` as its top-level blocks, `{ prelude, body }`, with comments dropped. A brace or a semicolon inside a quoted
 * string is not structure. Throws on a statement that has no block (`@import x;`, `@charset`), on a stray `}` and on an
 * unclosed block, so nothing the caller cannot see passes through.
 */
export function cssBlocks(css) {
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let depth = 0;
  let quote = null;
  let mark = 0;
  let prelude = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "{") {
      if (depth === 0) {
        prelude = text.slice(mark, i).trim();
        mark = i + 1;
      }
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth < 0) throw new Error("css: a } with no block to close");
      if (depth === 0) {
        blocks.push({ prelude, body: text.slice(mark, i).trim() });
        mark = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      throw new Error(`css: a statement with no block cannot be scoped: ${text.slice(mark, i + 1).trim()}`);
    }
  }
  if (quote !== null || depth !== 0 || text.slice(mark).trim() !== "") throw new Error("css: an unclosed block or a rule with no body");
  return blocks;
}

/** `text` with each run of white space outside a quoted string as one space, trimmed. */
function squash(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote !== null) {
      out += c;
      if (c === "\\" && i + 1 < text.length) out += text[(i += 1)];
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (/\s/.test(c)) {
      if (!out.endsWith(" ")) out += " ";
    } else {
      out += c;
    }
  }
  return out.trim();
}

/** A selector list as its selectors: split at the commas outside a bracket, a parenthesis or a quoted string. */
export function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let mark = 0;
  for (let i = 0; i < prelude.length; i += 1) {
    const c = prelude[i];
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(squash(prelude.slice(mark, i)));
      mark = i + 1;
    }
  }
  parts.push(squash(prelude.slice(mark)));
  return parts;
}

/** Every selector in `css`, those inside an `@media` block included, in order. A `@keyframes` step is not one. */
export function selectorsOf(css) {
  return cssBlocks(css).flatMap(({ prelude, body }) => {
    if (!prelude.startsWith("@")) return splitSelectors(prelude);
    return /^@media[\s(]/.test(prelude) ? selectorsOf(body) : [];
  });
}

/** One selector confined to `prefix`, or a throw naming why it cannot be. */
function scopeSelector(prefix, selector) {
  if (selector === "") throw new Error("css: an empty selector");
  if (/^[>+~]/.test(selector)) throw new Error(`css: a selector that starts with a combinator: ${selector}`);
  const root = ROOT_START.exec(selector);
  const rest = root ? selector.slice(root[0].length) : selector;
  if (ROOT_LATER.test(rest)) throw new Error(`css: a selector that names the document after its start: ${selector}`);
  return root ? `${prefix}${rest}` : `${prefix} ${selector}`;
}

/** A rule confined to `prefix`. Its declarations pass as written; a nested rule inside them throws. */
function scopeRule(prefix, { prelude, body }) {
  if (prelude === "") throw new Error("css: a block with no selector");
  if (body.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "").includes("{")) throw new Error(`css: a nested rule inside ${prelude}`);
  return `${splitSelectors(prelude).map((s) => scopeSelector(prefix, s)).join(",")}{${body}}`;
}

/**
 * `css` with every selector confined to `prefix` (`.legacy`, `body[data-page="runs"]`): one rule per line, `@media`
 * kept around its own rules (one level), `html`, `body` and `:root` at a selector's start mapped to the prefix itself.
 * Throws on anything it cannot confine (see the header): any other at-rule, a nested `@media`, a selector that names
 * the document after its start or starts with a combinator, an empty selector, a nested rule.
 */
export function scopeCss(prefix, css) {
  if (typeof prefix !== "string" || squash(prefix) !== prefix || prefix === "" || /[{},;]/.test(prefix)) throw new Error(`css: not a scope prefix: ${prefix}`);
  return cssBlocks(css)
    .map((block) => {
      if (!block.prelude.startsWith("@")) return scopeRule(prefix, block);
      if (!/^@media[\s(]/.test(block.prelude)) throw new Error(`css: an at-rule that cannot be scoped: ${block.prelude}`);
      const inner = cssBlocks(block.body);
      for (const r of inner) if (r.prelude.startsWith("@")) throw new Error(`css: an at-rule inside ${block.prelude}: ${r.prelude}`);
      return `${squash(block.prelude)}{${inner.map((r) => scopeRule(prefix, r)).join("")}}`;
    })
    .join("\n");
}

/**
 * The top bar's breakpoints, in CSS pixels of viewport width (issue #737's second review). They depend on the viewport
 * and on `top--ro` (a read-only console, a class the SERVER sets) and on nothing the browser script changes, so the
 * bar never changes its height when the live word changes or the theme button appears:
 *
 * - `phoneMax`: bundle.css's own phone breakpoint (`@media (max-width: 760px)`, pinned by the stylesheet test). At and
 *   below it the navigation is a row of its own that scrolls sideways inside itself, as the bundle draws it. The
 *   desktop's rules apply exactly where that query does not (`not all and (max-width: 760px)`), not from 761 px: a
 *   window's width in CSS pixels can be fractional (browser zoom, a display scaled by 125%), and a width of 760.5 px
 *   matched neither a `max-width: 760px` nor a `min-width: 761px` block, so it drew the bundle's bare row (issue #737's
 *   third review). The ranges inside the desktop (the navigation's break below) are nested in that same query.
 * - `navBreakMax`: from 761 px up to here the navigation, on its own row, always breaks after its fourth pill
 *   (Overview, Runs, Parked, Fleet, then the rest). The operator's navigation measures 773 px in the macOS system font
 *   and 825 px in DejaVu Sans (Linux's, wider, where CI measures) with a one-digit Parked count, 842 px with three
 *   digits: below about 873 px it cannot be one line, and where it just can, a count that appears or gains a digit
 *   (the live stream moves it) would push its last pill onto a second line and the page down by 54 px. A break at a
 *   fixed pill holds both lines short of the width whatever the count says. From 940 px the navigation is one line
 *   with a 3-digit count and 50 px to spare in DejaVu Sans.
 * - `oneRowMin`: from here the bar is one row (pi-dispatch, the navigation, the end), as the Shell card draws it at
 *   1440. Measured at 1440 in DejaVu Sans: the pi-dispatch pill 171 px, the navigation 825, the live pill at its widest
 *   word (Reconnecting) 147, the theme button, the avatar and sign-out, with the gaps and the page's 24 px sides, leave
 *   37 px for the signed-in name and role (the macOS font leaves 112). Name and role are the one part that gives way:
 *   the longer of the two is cut first with an ellipsis (the block's `title` holds both) rather than the bar wrapping,
 *   and only with the widest word do they lose that much. Below this the bar is two rows: the pi-dispatch pill and the end, then the navigation.
 * - `oneRowReadOnlyMin`: the same for a read-only console, whose end also holds the read-only chip (150 px in the macOS
 *   font, 163 in DejaVu Sans). At 1600 DejaVu Sans leaves 27 px for the name with Reconnecting.
 *
 * At 761 px a read-only console's first row is the tightest place: 25 px for the name with Reconnecting in DejaVu Sans.
 */
export const TOP_BAR = Object.freeze({ phoneMax: 760, navBreakMax: 939, oneRowMin: 1440, oneRowReadOnlyMin: 1600 });

/**
 * What the shell draws that `bundle.css` has no rule for, or draws in a way the console cannot use:
 *
 * - an empty panel is not drawn (the live stream empties a panel that has nothing to say; the rule predates Pulse);
 * - `hidden` wins over a component's `display` (the command box's Copy button is a `btn`, `hidden` until the script
 *   reveals it, and an author `display` beats the browser's own `[hidden]`), except on the theme button: drawn `hidden`
 *   and revealed by the script, it KEEPS ITS SPACE meanwhile (`visibility: hidden`: not drawn, not focusable, not read
 *   out, not clickable), so revealing it moves nothing on any width. The third review measured the reveal pushing a
 *   phone's top bar down a row, and on any width it pushed the parts before it sideways. Without a script it stays an
 *   empty gap;
 * - `main` is the skip link's focus target (`tabindex="-1"`), so it takes focus without a ring around the page, and it
 *   stacks the title bar and the cards with the bundle's card gap (12px on a phone, as `.page` has it there), in one
 *   column that may shrink below its content (`minmax(0,1fr)`, `min-width:0`), so nothing in it widens a phone page;
 * - THE TOP BAR NEVER OVERLAPS, NEVER WIDENS THE PAGE, NEVER HIDES A PILL ABOVE A PHONE AND NEVER JUMPS. bundle.css
 *   lays the bar out as one flex row, and between 761 px and about 1,300 px its pills ran under the end of the bar.
 *   The first fix (a navigation that scrolled inside itself at every width) hid pills from a mouse, which has no
 *   sideways scroll there, clipped focus rings and made the bar 60 px taller or shorter whenever the live word or the
 *   revealed theme button crossed a content-dependent wrap. So, by `TOP_BAR`'s breakpoints:
 *   - on a PHONE the bundle's layout stands: the pi-dispatch pill and the end on the first row (the end wraps below it
 *     when it does not fit), the navigation on its own full-width row that scrolls inside itself with no scrollbar.
 *     Its pills keep their size, it is padded by 4 px and pulled back by the same margin (a scroll box clips what it
 *     holds and the focus ring is drawn 4 px outside a pill), and the script scrolls a focused pill into view;
 *   - ABOVE IT the bar is a grid, and the navigation never scrolls: two rows (the pi-dispatch pill with the end, then
 *     the navigation across the whole width, wrapping, broken after its fourth pill below `navBreakMax`), then one
 *     row from `oneRowMin` (`oneRowReadOnlyMin` for `top--ro`). The pi-dispatch pill and the navigation take their
 *     full width (`max-content`), the end takes the rest and is right-aligned in it, and inside the end only the
 *     signed-in name and role give way, cut with an ellipsis down to nothing (the avatar and the block's title, "ops,
 *     Operator", keep who it is), so a bar short of room cuts them instead of wrapping into another row. The two share
 *     one column as wide as the wider of them, so the longer is cut first: a role is cut only where its column is
 *     narrower than the role itself, and then a longer name is cut too. A grid and not the bundle's wrapping row:
 *     a wrapping flex row decides its lines from each part's full width BEFORE anything shrinks, so the end wrapped
 *     onto a row of its own instead of the name giving way, and when it did depended on the live word;
 *   - every pill contains its own visually hidden text (the count's `.sr`, positioned, would otherwise escape the scroll
 *     box and widen a phone page by its offset). The name's 160 px cap is on its column (the name and the role), so the
 *     column is never wider than what it shows;
 * - the Parked count is a panel inside its nav pill: drawn inline, and gone with no gap when it has nothing to count;
 * - the More menu (Audit, for operators) is a `<details class="more">` at the end of the navigation: its summary is a
 *   round nav pill. Above a phone the details is the list's containing block and CSS alone opens the list under its
 *   button, right edges aligned, 6 px below it, so it is right with no script. On a phone the navigation scrolls, and a
 *   scroll box clips every descendant positioned against itself or anything inside it, so there `.top` is the list's
 *   containing block (`position:relative` there, `position:static` on the `details`) and the list escapes the clip;
 *   CSS opens it below the whole bar at its right edge, and the script, on every opening, first scrolls the button
 *   whole into view (ring included), then moves the list under it, and closes it only when a later scroll of the
 *   navigation (or a resize) leaves no part of the button in view (`script.mjs`, which reads the details' computed
 *   position to know which case holds). When the current page is one of its links the summary takes the current
 *   pill's look, so the bar always shows where the reader is, and the link itself reads in ink on its pale ground (the
 *   nav's current-pill colour is white text, which could not be read there);
 * - THE LIVE PILL (the LiveStates card): only Live pulses. bundle.css pulses every `.live .dot` whatever its state (and
 *   only under `prefers-reduced-motion: no-preference`, which stays so); Reconnecting and Not live hold still here.
 *   Above a phone the pill is the card's: the dot and the word, and Signed out draws the sign-out glyph in place of the
 *   dot. The server draws the dot and every state's glyph (`shell.mjs` `LIVE_GLYPHS`, each `live__<state>`) and the
 *   state's classes pick one, so the script only switches a class. On a phone bundle.css hides the pill, and its
 *   `role="status"` region with it, so a phone never learned that the page had stopped updating. Here THE PHONE'S PILL
 *   NEVER CHANGES SIZE: it is one 16 px slot, on the canvas, holding one mark whose SHAPE says the state (Live the dot,
 *   Reconnecting a retry arrow, Not live the stop square, Signed out the sign-out arrow), in the state's ink, and its
 *   word is hidden from view and kept for assistive technology in every state. No rule keyed to a state touches the
 *   slot's own box, only which mark it shows. The second review's phone pill showed every word but Live's, so the first
 *   load (drawn Not live, Live a moment later) and every reconnect moved the page by a row (the third review measured
 *   50 px); and a dot alone in another colour was the state by colour only (Reconnecting's 1.71:1 and Not live's 2.29:1
 *   on the light canvas). Recorded as a deviation from the card, which hides the pill on a phone;
 * - a page title wraps anywhere: a run's id has no hyphen or space to break at and would push a phone page sideways;
 * - THE PARTS A PAGE DRAWS HIDDEN FOR THE SCRIPT (PR 2 of issue #737), each laid out so that drawing it costs no space
 *   until it shows: a page drawn once says when in its title bar (`.drawn`; on a phone the note takes its own line and
 *   Reload starts the next, pulled back by the ghost button's own padding so its icon stands under the clock, where
 *   the wrap used to leave it indented 10 px); the live notes (`.live-note`) and the
 *   sign-in notices are polite live regions, so they stay in the page while every note in them is hidden (a region
 *   that is not rendered is not watched, and the note the script reveals would not be read out), and are taken out of
 *   the grid's flow instead (`position: absolute`, zero size), so an empty one adds no gap between the cards; the stale
 *   note says "at" only once the script has written a time;
 * - A PAGE SHOWN AS LAST SEEN (`main.stale`, the LiveStates card's "dimmed") draws each panel's card flat: no ground of
 *   its own (the canvas shows through) and a hairline ring, as the card draws its dimmed rows
 *   (`.ls-dim .hostrow{background:transparent;box-shadow:inset 0 0 0 1px var(--line)}`). The ink is kept, so every
 *   word reads as it did and every button looks as live as it is (each still works). The opacity it replaced (.55)
 *   took the light theme's ink to 4.23:1 and its muted ink to 2.45:1, under AA, and drew working buttons as disabled
 *   ones. On the canvas the ink, the muted ink, the link colour and every status ink keep
 *   4.5:1 (`console-contrast.test.mjs`, the stale ground's pairs); the faint ink, whose 4.5:1 the tokens promise only
 *   on `surface` and `surface-2` (4.36:1 on the light canvas), is re-pointed to the muted ink inside such a card, so a
 *   hint or an axis stays readable too (the one token the shell declares). A tinted card keeps its tint, which is what
 *   it says.
 *   A secondary button (the kit's `.btn` with no act, the legacy layer's `button`) is drawn by its fill alone,
 *   `surface-3`, which on the light canvas is 1.04:1: on a flat panel it was a word with no shape. Such a panel hands
 *   its controls a ring (`--stale-ring`, `line-strong`, 3:1 on the canvas in both themes, the contrast test's pair),
 *   and every control drawn with that fill wears it (`SECONDARY_BTN` here, the legacy controls in `compat-css.mjs`);
 *   anywhere else the property is unset and the control draws no ring. An act draws its own fill or ring, and a ghost
 *   button none by design, so neither takes it.
 *   A legacy panel is its own card (`compat-css.mjs`), so it is named here beside the converted card: that half goes
 *   with the legacy layer (the compat test holds the shell to naming `.legacy` only while a page is legacy);
 * - the write flow (the ConfirmStates card, `confirm-view.mjs`): the slot (`.cslot`), the previewing skeleton's muted
 *   hourglass and grey ghost lines (and, once the script has dropped its busy mark to say why nothing was previewed,
 *   the skeleton's attention icon in the hourglass's place: `confirm-view.mjs` draws both, `data-slot-icon`), the
 *   no-change bar's quieter ring, a bar's note line, the bulk results' list, and the
 *   note a panel the script keeps still carries (`.held`), each the card's own demo rule under the class
 *   `confirm-view.mjs` `CONFIRM_CLASSES` names. The kept-still note is the one piece of Pulse markup the script puts
 *   INSIDE a panel, and on a legacy page that panel is old markup whose layer resets every margin and padding in it
 *   (`.legacy *`, from the insights page's own reset, as specific as a class and later): the note's space under it and
 *   its chip's padding are said again at the panel (`section[data-panel]>.held`, `.held>.chip`), which outranks that
 *   reset, or the note sat flush on the panel's heading with its chip's words touching the pill's edges; and the
 *   Undo line's icon at the top of its sentence, centred on the first line (bundle.css centres it on the whole
 *   paragraph, so a "No undo:" sentence of three to five lines at 375 px had its icon floating beside the middle). A
 *   bar's lines (`.confirm__list`, a grid in bundle.css) shrink to the bar and break anywhere once a word is wider than
 *   it: the grid's track took the width of a line with no space in it (a pause window's JSON, an edit's "to {...}"),
 *   which pushed a 375 px page sideways by up to 250 px;
 * - A COMMAND IN A COPY BOX WRAPS (`.cmd`, everywhere the kit draws one): bundle.css keeps it on one line and scrolls
 *   it inside its box, and a box narrower than its command showed a cut line with no sign of the rest (the sign-in
 *   help's `token add ... --role operator` at 375 px lost its last word). Here it wraps between
 *   its arguments (each a box of its own, `kit.mjs` `cmd`, so a line never breaks after the dashes of `--name`), and
 *   anywhere inside one only when it is wider than the box (a long path or id), the box growing down from its top with
 *   the Copy button at the top right; the code's 6 px above and below keep a one-line box at bundle.css's 40 px, its
 *   text centred on the button. Copying is unchanged: the button copies the `<code>`'s text, which a wrap does not
 *   touch;
 * - the phone's Live dot pulses inside its 16 px slot. bundle.css's pulse grows the dot's 8 px by a 6 px ring each
 *   side (20 px), 2 px past the slot on each side, over the bar's neighbours; on a phone the dot pulses on its own
 *   keyframes to a 4 px ring, exactly the slot. `SHELL_CSS` is not scoped, so a keyframe name is allowed here (a
 *   scoped block refuses one, whose names are global), and the name is the shell's own (`live-phone`). Only the name
 *   changes: the duration stays bundle.css's, set only under `prefers-reduced-motion: no-preference`, so a reader who
 *   asked for less motion still gets none.
 */
const PHONE = `(max-width: ${TOP_BAR.phoneMax}px)`;
const DESKTOP = `not all and ${PHONE}`;
const ONE_ROW = "grid-template-columns:max-content max-content minmax(0,1fr)";
const VISUALLY_HIDDEN = "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";

/** The kit's sizes, which combine with an act; every other `kit.mjs` `BTN_KINDS` entry is an act. */
const BTN_SIZES = Object.freeze(["sm", "lg", "round"]);

/** A button the kit draws with the secondary fill: a `.btn` with no act (see the header's flat panel). */
export const SECONDARY_BTN = `.btn${BTN_KINDS.filter((k) => !BTN_SIZES.includes(k)).map((k) => `:not(.btn--${k})`).join("")}`;

export const SHELL_CSS = `
section[data-panel]:empty{display:none}
[hidden]:not([data-theme-toggle]){display:none!important}
[data-theme-toggle][hidden]{visibility:hidden}
main{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-4);min-width:0;align-content:start}
main:focus{outline:none}
.top{position:relative}
.pillnav>a{position:relative;flex:none}
.pillnav [data-panel]{display:inline-flex}
.pillnav [data-panel]:empty{display:none}
.top__end>*{flex:none}
.top__end>.who{flex:0 1 auto;min-width:0}
.who>span:first-child{flex:0 1 auto;min-width:0;max-width:160px}
.who b,.who small{max-width:100%;overflow:hidden;text-overflow:ellipsis}
details.more{position:relative;flex:none}
details.more>summary{display:inline-flex;align-items:center;justify-content:center;width:var(--control-h);height:var(--control-h);padding:0;border-radius:var(--radius-pill);background:var(--surface);color:var(--ink-muted);list-style:none;cursor:pointer}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary:hover,details.more[open]>summary{color:var(--ink)}
details.more>:not(summary){position:absolute;top:calc(100% + 6px);right:0;z-index:5;display:grid;gap:2px;min-width:180px;padding:6px;border-radius:var(--radius-md);background:var(--surface);box-shadow:inset 0 0 0 1px var(--line),0 8px 24px rgba(0,0,0,.14)}
details.more a{display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;border-radius:var(--radius-pill);background:transparent;color:var(--ink);font-weight:600;text-decoration:none;white-space:nowrap}
details.more a:hover{background:var(--surface-2)}
details.more:has(a[aria-current="page"])>summary{background:var(--primary);color:var(--on-primary)}
details.more a[aria-current="page"]{background:var(--surface-2);color:var(--ink)}
.live>.ic{display:none}
.live--out>.dot{display:none}
.live--out>.live__out{display:block}
.live--retry .dot,.live--off .dot{animation:none}
.titlebar h1{overflow-wrap:anywhere;min-width:0}
.titlebar__end .drawn{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--ink-muted)}
.live-note{display:grid;gap:var(--space-3);min-width:0}
.live-note:not(:has(>:not([hidden]))){position:absolute}
.live-note__at:has(>time:empty){display:none}
main.stale section[data-panel] .card:not(.card--tint),main.stale .legacy>section[data-panel]{--ink-faint:var(--ink-muted);--stale-ring:inset 0 0 0 1px var(--line-strong);background:transparent;box-shadow:inset 0 0 0 1px var(--line)}
${SECONDARY_BTN}{box-shadow:var(--stale-ring,none)}
.cmd{align-items:flex-start}
.cmd code{white-space:pre-wrap;overflow-wrap:anywhere;padding:6px 0}
.cmd code>span{display:inline-block;max-width:100%}
.cslot{display:grid;gap:var(--space-3);min-width:0}
.confirm--busy .confirm__h .ic{color:var(--ink-muted)}
.confirm__h>[data-slot-icon]{display:inline-flex}
.confirm--busy [data-slot-icon="said"],.confirm:not(.confirm--busy) [data-slot-icon="busy"]{display:none}
.confirm__ghost li{list-style:none;margin-left:-18px}
.confirm__ghost li>span{display:block;width:80%;height:12px;border-radius:6px;background:var(--surface-3)}
.confirm__ghost li+li>span{width:55%}
.confirm--none{box-shadow:inset 0 0 0 1px var(--line-strong)}
.confirm__list li{min-width:0;overflow-wrap:anywhere}
.confirm__note{font-size:13px;color:var(--ink-muted)}
.confirm__note b{color:var(--ink)}
.confirm__results{display:grid;gap:4px;margin:6px 0;font-size:13px}
.confirm__results li{display:flex;align-items:flex-start;gap:8px}
.confirm__results .ic{flex:none;margin-top:2px}
.confirm__undo{align-items:flex-start}
.confirm__undo>.ic{margin-top:3px}
.held{display:flex;flex-wrap:wrap;align-items:center;gap:6px var(--space-3)}
section[data-panel]>.held{margin:0 0 var(--space-3)}
.held>.chip{padding:0 10px}
.held__s{font-size:13px;color:var(--ink-muted)}
@keyframes live-phone{50%{box-shadow:0 0 0 4px var(--ok-tint)}}
@media ${DESKTOP}{.top{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-3)}.top>.brandpill{grid-row:1;grid-column:1}.top__end{grid-row:1;grid-column:2;min-width:0;margin-left:0;justify-content:flex-end}.pillnav{grid-row:2;grid-column:1/-1;flex-wrap:wrap}}
@media ${DESKTOP}{@media (max-width: ${TOP_BAR.navBreakMax}px){.pillnav{row-gap:0}.pillnav>:nth-child(-n+4){order:1}.pillnav::after{content:"";order:2;flex-basis:100%;height:6px}.pillnav>:nth-child(n+5){order:3}}}
@media (min-width: ${TOP_BAR.oneRowMin}px){.top:not(.top--ro){${ONE_ROW}}.top:not(.top--ro)>.pillnav{grid-row:1;grid-column:2}.top:not(.top--ro)>.top__end{grid-column:3}}
@media (min-width: ${TOP_BAR.oneRowReadOnlyMin}px){.top--ro{${ONE_ROW}}.top--ro>.pillnav{grid-row:1;grid-column:2}.top--ro>.top__end{grid-column:3}}
@media ${PHONE}{main{gap:12px}.titlebar__end>.drawn{flex-basis:100%}.titlebar__end>.drawn+.btn--ghost{margin-left:-10px}.pillnav{flex:0 0 auto;margin:-4px calc(var(--space-4) * -1);padding:4px var(--space-4);overflow-y:hidden}.pillnav::-webkit-scrollbar{display:none}details.more{position:static}details.more>summary{width:40px;height:40px}.top__end{flex:0 1 auto;min-width:0;flex-wrap:wrap;justify-content:flex-end;gap:6px}.top__end .live{display:inline-flex;position:relative;justify-content:center;width:16px;height:16px;padding:0;gap:0;background:transparent}.top__end .live>.ic{width:16px;height:16px}.top__end .live--retry>.dot,.top__end .live--off>.dot{display:none}.top__end .live--retry>.live__retry,.top__end .live--off:not(.live--out)>.live__off{display:block}.top__end .live [data-live-word]{${VISUALLY_HIDDEN}}.top__end .live>.dot{animation-name:live-phone}}
`.trim();

/**
 * The sign-in pages (the SignIn and AccessStates cards): one card, centred, 560 px at most, under the sign-in bar, its
 * heading the card's (the page's `<h1>` is for a screen reader alone, `shell.mjs` `frameHtml`). The help is an inset
 * with its copy boxes on the card's ground; the token field and Sign in are the card's pills. The notice region is out
 * of the card's flow while it shows nothing (see `SHELL_CSS`: an empty live region must stay rendered).
 */
const SIGN_IN_CSS = `
main{justify-items:center}
main>section[data-panel]{width:100%;max-width:560px;margin-top:var(--space-6)}
.signin{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-4);padding:40px;border-radius:var(--radius-xl)}
.signin>*{min-width:0}
.signin__mark{width:52px;height:52px;font-size:18px}
.signin h2{font-size:32px;line-height:38px;font-weight:800;letter-spacing:-0.02em}
.signin:not(:has(#notice>:not([hidden]))) #notice{position:absolute}
.signin__notice{display:grid;gap:var(--space-2)}
.signin__form{display:grid;gap:var(--space-3)}
.signin__form .input{height:var(--control-h);padding:0 20px;border-radius:var(--radius-pill)}
.signin__form .btn{width:100%}
.signin__help{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;padding:var(--space-4);border-radius:var(--radius-md);background:var(--surface-2);font-size:13px}
.signin__help .cmd{background:var(--surface)}
.signin__help-h{font-weight:650}
.signin__foot{font-size:12px}
.signin__state{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-3)}
.signin__state>*{min-width:0}
.signin__top{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3)}
.signin__state .signin__mark{width:40px;height:40px;font-size:15px}
.signin__state h2{font-size:24px;line-height:30px}
.signin__state .muted{font-size:13px;line-height:20px}
.signin__alt{justify-self:start;font-size:13px}
@media ${PHONE}{main>section[data-panel]{margin-top:0}.signin{padding:var(--space-5)}.signin h2{font-size:26px;line-height:32px}.signin__state h2{font-size:22px;line-height:28px}}
`;

/**
 * The error card (the ErrorPage card, `error-pages.mjs`): centred, its tile large, the status code in the code face,
 * the heading, the sentence and the way back; the 421's card is a tile beside its text, the tunnel command under it.
 * The refused Host is in the code face, which the bundle keeps on one line (`.code`'s nowrap); a Host is up to 64
 * characters and an ellipsis with no space to break at, so inside the 421's card it wraps anywhere instead of widening
 * a phone's page.
 * Served on the error pages and on the audit log's, whose refusal for a viewer (`pages.mjs` `renderPage`'s belt) draws
 * the same card in the signed-in frame.
 */
const ERROR_CSS = `
.er-card{display:flex;flex-direction:column;align-items:center;gap:var(--space-3);padding:56px var(--space-6);text-align:center}
.er-card .cmd{width:100%;max-width:420px;text-align:left}
.er-tile{width:64px;height:64px;border-radius:20px}
.er-code{font-family:var(--font-mono);font-size:13px;font-weight:700;color:var(--ink-muted)}
.er-h{font-size:36px;line-height:42px;font-weight:800;letter-spacing:-0.02em}
.er-s{max-width:560px;color:var(--ink-muted);font-size:15px;line-height:22px}
.er-act{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
.er-421{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start;gap:var(--space-4);max-width:760px;margin:0 auto}
.er-421__t{display:grid;gap:8px;min-width:0}
.er-421 h2{font-size:20px;line-height:26px;font-weight:750}
.er-421 .muted{font-size:14px}
.er-421 .code{white-space:normal;overflow-wrap:anywhere}
@media ${PHONE}{.er-card{padding:var(--space-8) var(--space-4)}.er-h{font-size:28px;line-height:34px}.er-421{grid-template-columns:minmax(0,1fr)}}
`;

/**
 * The audit log's layout: its two breakpoints, in CSS pixels of viewport width, and the bounds of its cells.
 *
 * THE CELLS ARE BOUNDED, SO THE TABLE'S WIDTH HAS A CEILING WHATEVER THE ROWS SAY. The reason column is never narrower
 * than `reasonMin` (its cell's content is a block of that minimum, `.au-why`); the time is two lines in `atWidth` (the
 * date over the time and zone; the card draws the time over the date, but the browser script rewrites the whole
 * `<time>` to the reader's zone as one text, so the line can only break where that text has a space); a name, a write's
 * kind and a target keep their own width up to `whoMax`, `kindMax` and `targetMax` and wrap inside it past that. Why,
 * as measured: at exactly 1440 px the log's card was 906 px, the time took 171 of them on one line,
 * a refusal's target (`/api/act/fleet-pause/preview`, in the code face, which never wrapped) took 240, and the reason
 * column was left 55 to 70 px, a damaged row's sentence 16 lines; a 200-character target (a refused Host's path) would
 * have scrolled the table in its box at any width. Letting those cells shrink below their own width instead (wrapping
 * anywhere) gave the reason its room but broke "anonymous" and a run's id mid-word. Bounded, the table's narrowest is
 * measured at 1,040 px in the macOS system font and 1,052 px in DejaVu Sans (CI's) over the widest rows the console can
 * write: a seven-digit row number, a 64-character name, a 40-character kind, a 200-character target and a damaged row's
 * sentence (`console-stylesheet.test.mjs` holds the arithmetic). The fixture's own rows need 936 px.
 *
 * - `sideMin`: from here the log and its side card stand side by side, as the AuditScreen card draws them. The side card
 *   is `--side-w` (470) and the gap and the page's sides 64 more, so at 1600 the log's card is 1,066 px, which holds
 *   the table's 1,052. At the card's own 1440 it would be 906, which only the card's short sample rows fit; the first
 *   version stood them side by side from there and starved the reason column. Two columns from the desktop's 761 px,
 *   as PR 2 first drew it, left the log 227 to 746 px wide. Below this the side card stands under the log, at the
 *   log's full width.
 * - `stackMax`: up to here the log's rows are stacked blocks (the kit's `tbl--stack`, each cell named by its column),
 *   as bundle.css stacks them on a phone. With the side card under it the log's card is the viewport less the page's
 *   48 px of sides, so at 1120 px it is 1,072 px, which holds the table's 1,052 with a classic scrollbar's 15 px beside
 *   it. Below that a table would scroll inside its box, which hides the columns that say what happened.
 *
 * WHY A MEDIA QUERY AND NOT A CONTAINER QUERY. The log's card is as wide as the viewport less fixed parts on this page
 * (the sides, and from `sideMin` the gap and `--side-w`), so a query on the viewport says what one on the card would,
 * and it works at the console's browser floor; a container query needs Chrome 105, Safari 16 or Firefox 110, and below
 * them the table would scroll inside its box again.
 */
export const AUDIT_LAYOUT = Object.freeze({ stackMax: 1119, sideMin: 1600, atWidth: 110, whoMax: 100, kindMax: 120, targetMax: 160, reasonMin: 200 });

/**
 * bundle.css's stacked-table rules (`.tbl--stack`, in its phone block), as it writes them: the audit log applies them
 * up to `AUDIT_LAYOUT.stackMax`, not only on a phone. DERIVED from the pasted bundle rather than copied, so the two
 * cannot drift; `bundle` is a parameter for the test, which shows the read.
 */
export function stackRules(bundle = PULSE_CSS) {
  const phone = cssBlocks(bundle).find((b) => b.prelude === `@media (max-width: ${TOP_BAR.phoneMax}px)`);
  if (!phone) throw new Error("css: bundle.css has no phone block to take the stacked table from");
  const rules = cssBlocks(phone.body).filter(({ prelude }) => splitSelectors(prelude).every((s) => /^\.tbl--stack(?![\w-])/.test(s)));
  if (rules.length === 0) throw new Error("css: bundle.css's phone block stacks no table");
  return rules.map(({ prelude, body }) => `${prelude}{${body}}`).join("\n");
}

/**
 * The audit log (the AuditScreen card): the chain's banner and the filters across the page, then the log, and the side
 * card beside it from `AUDIT_LAYOUT.sideMin` (`.cols`'s two columns, which `<main>` takes itself, since each panel is a
 * direct child of it), under it below that; the log's rows stacked up to `AUDIT_LAYOUT.stackMax` (see there, and
 * `stackRules`), their sides padded as the card's head is there (`--space-5`, `--space-4` on a phone). The who cell is
 * the name over the role; each cell is bounded as `AUDIT_LAYOUT` says (see there; a stacked row keeps the bounds, which
 * fit a phone's card); a damaged row's sentence is as wide as its reason cell (a cap of its own broke a file name
 * after "2026-" in a wide cell) and leads in the failed ink; the filter bar's selects are pills of their own width,
 * not a field's full one, their caret centred in the 48 px pill (bundle.css places it 19 px down, the middle of its
 * 42 px field), on a phone each as wide as its longest choice and the row at most, so the choice it shows is never
 * cut (two to a row at 40% each cut "Outcome: refused" at 375 px), and its search shows the focus ring the bare input
 * inside it gives up; the row a link opened (`#seq-41`) is marked. The command a banner names in its sentence (the
 * chain banner's `pi-dispatch-console audit verify`, in the code face, which the bundle keeps on one line) wraps with
 * the sentence, so it cannot widen a 320 px phone's page, and only between its words: each word is a box of its own
 * (`panels/audit.mjs`), so no line ends after the dash of "pi-".
 */
const AUDIT_CSS = `
@media (min-width: ${AUDIT_LAYOUT.sideMin}px){main{grid-template-columns:minmax(0,1fr) var(--side-w);align-items:start}main>*{grid-column:1/-1}main>#p-audit{grid-column:1}main>#p-audit-about{grid-column:2}}
.au-at{display:inline-block;width:${AUDIT_LAYOUT.atWidth}px;white-space:normal}
.au-who{display:inline-flex;flex-direction:column;width:max-content;max-width:${AUDIT_LAYOUT.whoMax}px;line-height:16px;overflow-wrap:anywhere}
.au-who small{font-size:11px;color:var(--ink-muted)}
.au-kind{width:max-content;max-width:${AUDIT_LAYOUT.kindMax}px;overflow-wrap:anywhere}
.au-tgt{display:inline-block;width:max-content;max-width:${AUDIT_LAYOUT.targetMax}px;white-space:normal;overflow-wrap:anywhere}
.au-why{display:block;min-width:${AUDIT_LAYOUT.reasonMin}px}
.au-dmg{display:block;font-size:12px;line-height:17px;color:var(--ink);white-space:normal}
.au-dmg b{color:var(--failed-ink)}
.au-empty{padding:0 var(--space-5) var(--space-5)}
.filterbar .search{flex:1 1 260px}
.filterbar .search:focus-within{outline:2px solid var(--focus);outline-offset:2px}
.filterbar .select{flex:0 1 auto;width:auto;max-width:100%;height:var(--control-h);padding-left:18px;border-radius:var(--radius-pill);background-color:var(--surface);background-position:right 18px center,right 13px center;box-shadow:none}
.tbl tbody tr:target td{background:var(--running-tint)}
.banner__s .code{white-space:normal;overflow-wrap:anywhere}
.banner__s .code>span{display:inline-block;max-width:100%}
@media (max-width: ${AUDIT_LAYOUT.stackMax}px){${stackRules()}
.tbl--stack tr{padding-left:var(--space-5);padding-right:var(--space-5)}}
@media ${PHONE}{.filterbar .select{flex:1 1 auto;min-width:0}.filterbar .btn{flex:1 1 auto}.tbl--stack tr{padding-left:var(--space-4);padding-right:var(--space-4)}}
`;

/** Each page's own rules, by page name, unscoped as written; `pageCss()` confines them. */
export const PAGE_CSS = Object.freeze({ login: SIGN_IN_CSS, "login-code": SIGN_IN_CSS, error: ERROR_CSS, audit: `${AUDIT_CSS}${ERROR_CSS}` });

/**
 * Every page's rules, each confined to `body[data-page="<page>"]`, in the table's order. `table` is `PAGE_CSS`; a test
 * passes its own, to show the confinement on rules of its choosing.
 */
export function pageCss(table = PAGE_CSS) {
  return Object.entries(table)
    .map(([name, css]) => {
      if (!PAGE_NAME.test(name)) throw new Error(`css: not a page name: ${name}`);
      return scopeCss(`body[data-page="${name}"]`, css);
    })
    .join("\n");
}
