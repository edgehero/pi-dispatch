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
 * `body[data-page="<page>"]`, the attribute every page's body carries. PR 1 adds none.
 */

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
 * - a page title wraps anywhere: a run's id has no hyphen or space to break at and would push a phone page sideways.
 */
const PHONE = `(max-width: ${TOP_BAR.phoneMax}px)`;
const DESKTOP = `not all and ${PHONE}`;
const ONE_ROW = "grid-template-columns:max-content max-content minmax(0,1fr)";
const VISUALLY_HIDDEN = "position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
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
@media ${DESKTOP}{.top{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-3)}.top>.brandpill{grid-row:1;grid-column:1}.top__end{grid-row:1;grid-column:2;min-width:0;margin-left:0;justify-content:flex-end}.pillnav{grid-row:2;grid-column:1/-1;flex-wrap:wrap}}
@media ${DESKTOP}{@media (max-width: ${TOP_BAR.navBreakMax}px){.pillnav{row-gap:0}.pillnav>:nth-child(-n+4){order:1}.pillnav::after{content:"";order:2;flex-basis:100%;height:6px}.pillnav>:nth-child(n+5){order:3}}}
@media (min-width: ${TOP_BAR.oneRowMin}px){.top:not(.top--ro){${ONE_ROW}}.top:not(.top--ro)>.pillnav{grid-row:1;grid-column:2}.top:not(.top--ro)>.top__end{grid-column:3}}
@media (min-width: ${TOP_BAR.oneRowReadOnlyMin}px){.top--ro{${ONE_ROW}}.top--ro>.pillnav{grid-row:1;grid-column:2}.top--ro>.top__end{grid-column:3}}
@media ${PHONE}{main{gap:12px}.pillnav{flex:0 0 auto;margin:-4px calc(var(--space-4) * -1);padding:4px var(--space-4);overflow-y:hidden}.pillnav::-webkit-scrollbar{display:none}details.more{position:static}details.more>summary{width:40px;height:40px}.top__end{flex:0 1 auto;min-width:0;flex-wrap:wrap;justify-content:flex-end;gap:6px}.top__end .live{display:inline-flex;position:relative;justify-content:center;width:16px;height:16px;padding:0;gap:0;background:transparent}.top__end .live>.ic{width:16px;height:16px}.top__end .live--retry>.dot,.top__end .live--off>.dot{display:none}.top__end .live--retry>.live__retry,.top__end .live--off:not(.live--out)>.live__off{display:block}.top__end .live [data-live-word]{${VISUALLY_HIDDEN}}}
`.trim();

/** Each page's own rules, by page name, unscoped as written; `pageCss()` confines them. Empty until a page converts. */
export const PAGE_CSS = Object.freeze({});

/**
 * Every page's rules, each confined to `body[data-page="<page>"]`, in the table's order. `table` is `PAGE_CSS`; a test
 * passes its own, since `PAGE_CSS` stays empty until a page converts and an empty table proves no confinement.
 */
export function pageCss(table = PAGE_CSS) {
  return Object.entries(table)
    .map(([name, css]) => {
      if (!PAGE_NAME.test(name)) throw new Error(`css: not a page name: ${name}`);
      return scopeCss(`body[data-page="${name}"]`, css);
    })
    .join("\n");
}
