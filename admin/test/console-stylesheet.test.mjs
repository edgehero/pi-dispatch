import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { LEGACY_CSS, NEUTRALISED, SVG_EXTRA, insightsFont, specificity } from "../src/console/compat-css.mjs";
import { PAGE_CSS, SHELL_CSS, TOP_BAR, cssBlocks, pageCss, scopeCss, selectorsOf, splitSelectors } from "../src/console/page-css.mjs";
import { PULSE_CSS, PULSE_CSS_SHA256 } from "../src/console/pulse-css.mjs";
import { PULSE_TOKENS, PULSE_TOKENS_SHA256, colorOf, tokenCss } from "../src/console/pulse-tokens.mjs";
import { renderPage } from "../src/console/pages.mjs";
import { SPRITE } from "../src/console/pulse-icons.mjs";
import { LIVE_GLYPHS, LIVE_STATES } from "../src/console/shell.mjs";
import { CONSOLE_CSS } from "../src/console/style.mjs";
import { PAGE_THEME } from "../src/graph-html.mjs";
import { INSIGHTS_CSS } from "../src/insights-html.mjs";

// The console's one stylesheet (issue #737): the design's tokens and bundle.css, pinned to the design files by hash, the
// shell's own rules, each page's rules confined to it, and the legacy layer last. `console-compat.test.mjs` ratchets the
// legacy layer itself.

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Every custom property a stylesheet DECLARES (`--x:`), and every one it READS (`var(--x`, fallbacks included). */
const declared = (css) => new Set([...css.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((m) => m[1]));
const read = (css) => new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));

/** `css`'s declarations with every attribute selector's value dropped, so a `[fill="#58a6ff"]` is not a colour. */
const declarationsOf = (css) => cssBlocks(css).flatMap(({ prelude, body }) => (prelude.startsWith("@") ? declarationsOf(body) : [body]));

test("bundle.css and tokens.json are pasted verbatim: each module's text hashes to the design file's", () => {
  assert.equal(PULSE_CSS_SHA256, "22564c875ed87b0c5af350d31770f995486737e2fe814a4e7458c031f2391ae6", "the pin is the file's, measured when it was pasted");
  assert.equal(sha256(PULSE_CSS), PULSE_CSS_SHA256, "PULSE_CSS is bundle.css, every byte");
  assert.equal(PULSE_TOKENS_SHA256, "23a272327010840ed86e4138c3d2c904831b7a33a24d7a9dcb67a58cb1c1c868");
  assert.equal(sha256(JSON.stringify(PULSE_TOKENS, null, 1)), PULSE_TOKENS_SHA256, "PULSE_TOKENS is tokens.json, every value");
});

test("the stylesheet is the tokens, then bundle.css, the shell, the pages and the legacy layer, and it fetches nothing", () => {
  assert.equal(CONSOLE_CSS, [tokenCss(), PULSE_CSS, SHELL_CSS, pageCss(), LEGACY_CSS].join("\n"));
  assert.ok(CONSOLE_CSS.startsWith(tokenCss()), "the tokens come first, so every later rule reads them");
  assert.ok(CONSOLE_CSS.indexOf(PULSE_CSS) > tokenCss().length - 1, "bundle.css after the tokens");
  assert.ok(CONSOLE_CSS.endsWith(LEGACY_CSS), "the legacy layer last: it wins inside .legacy, where it alone applies");
  // Plain rules: no element a page could be broken out by, nothing loaded, no remote font or image.
  for (const needle of ["<", "@import", "url(", "expression(", "@font-face", "javascript:"]) assert.ok(!CONSOLE_CSS.includes(needle), `no ${needle}`);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(CONSOLE_CSS), "no control byte");
  assert.match(PULSE_CSS, /\nbody \{ margin: 0; background: var\(--canvas\);/, "the body background is explicit, from a token");
});

test("every custom property the bundle, the shell and the pages read is a token or one they declare themselves", () => {
  const tokens = declared(tokenCss());
  // bundle.css declares its tone properties (`.tone-ok{--tone:...}`); everything else it reads is a token.
  const own = declared(PULSE_CSS);
  assert.deepEqual([...own].sort(), ["--on-tone", "--tone", "--tone-ink", "--tone-tint"], "bundle.css declares the tone set and nothing else");
  for (const [label, css] of [["bundle.css", PULSE_CSS], ["SHELL_CSS", SHELL_CSS], ["pageCss()", pageCss()]]) {
    for (const name of read(css)) assert.ok(tokens.has(name) || own.has(name), `${label} reads ${name}, which tokenCss() defines`);
  }
  assert.ok(declared(SHELL_CSS).size === 0, "the shell declares no property of its own");
  // The legacy layer reads tokens and its own `--pd-*` set, which it defines from tokens on the wrapper.
  const legacyOwn = declared(LEGACY_CSS);
  for (const name of legacyOwn) assert.match(name, /^--pd-/, `${name}: the legacy layer declares only the old --pd-* names`);
  for (const name of read(LEGACY_CSS)) assert.ok(tokens.has(name) || legacyOwn.has(name), `the legacy layer reads ${name}, which is defined`);
  // The old palette lives only in the legacy layer, which PR 7a deletes.
  assert.ok(!/--pd-/.test(CONSOLE_CSS.slice(0, CONSOLE_CSS.length - LEGACY_CSS.length)), "no --pd-* outside the legacy layer");
});

test("the shell's rules and the legacy layer's declarations hold no colour literal: every colour is a token", () => {
  for (const [label, css] of [["SHELL_CSS", SHELL_CSS], ["LEGACY_CSS", LEGACY_CSS]]) {
    for (const body of declarationsOf(css)) assert.ok(!/#[0-9a-f]{3,8}\b/i.test(body), `${label}: ${body} names a colour by hex`);
  }
  assert.match(SHELL_CSS, /(?:^|\n)section\[data-panel\]:empty\{display:none\}/, "an empty panel is still not drawn");
  assert.match(SHELL_CSS, /(?:^|\n)\[hidden\]:not\(\[data-theme-toggle\]\)\{display:none!important\}/, "hidden wins over a component's display (the Copy button), the theme button aside");
  assert.match(SHELL_CSS, /(?:^|\n)main:focus\{outline:none\}/, "main is the skip link's target");
  assert.match(SHELL_CSS, /details\.more>summary\{/, "the More menu");
});

test("PAGE_CSS is empty until a page converts, and a page's rules are served only under its own body", () => {
  assert.ok(Object.isFrozen(PAGE_CSS));
  assert.deepEqual(Object.keys(PAGE_CSS), []);
  assert.equal(pageCss(), "");
  assert.equal(scopeCss('body[data-page="runs"]', ".x .y{color:var(--ink)}\nbody{gap:0}"), 'body[data-page="runs"] .x .y{color:var(--ink)}\nbody[data-page="runs"]{gap:0}');
});

test("scopeCss confines every selector, maps the document to the scope and refuses what it cannot confine", () => {
  const css = `
/* a comment */
html,body , :root{margin:0}
.a,  .b > p ,[title="x, y"] {color:red}
body.dark   .c{color:blue}
@media (max-width: 760px) { .a{x:1} p{y:2} }
*{box-sizing:border-box}
`;
  assert.equal(scopeCss(".legacy", css), [
    ".legacy,.legacy,.legacy{margin:0}",
    '.legacy .a,.legacy .b > p,.legacy [title="x, y"]{color:red}',
    ".legacy.dark .c{color:blue}",
    "@media (max-width: 760px){.legacy .a{x:1}.legacy p{y:2}}",
    ".legacy *{box-sizing:border-box}",
  ].join("\n"));
  assert.equal(scopeCss(".legacy", ""), "");
  assert.equal(scopeCss(".legacy", "a::before{content:\"{;}\"}"), '.legacy a::before{content:"{;}"}', "a brace or semicolon in a string is not structure");
  const refused = [
    ["@import 'x.css';", /statement with no block/],
    ["@charset \"utf-8\"; a{b:c}", /statement with no block/],
    ["@keyframes spin{from{x:1}to{x:2}}", /at-rule that cannot be scoped/],
    ["@supports (x:y){a{b:c}}", /at-rule that cannot be scoped/],
    ["@media (x){@media (y){a{b:c}}}", /at-rule inside/],
    [".x body{a:b}", /names the document after its start/],
    ["html body{a:b}", /names the document after its start/],
    [".x :root{a:b}", /names the document after its start/],
    ["p:not(body){a:b}", /names the document after its start/],
    ["> p{a:b}", /starts with a combinator/],
    [".a,,.b{c:d}", /empty selector/],
    ["{a:b}", /no selector/],
    [".a{.b{c:d}}", /nested rule/],
    [".a{b:c", /unclosed/],
    [".a{b:c}}", /no block to close/],
    [".a", /unclosed|no body/],
  ];
  for (const [bad, why] of refused) assert.throws(() => scopeCss(".legacy", bad), why, bad);
  for (const prefix of ["", " .x", ".x{", ".a,.b", null]) assert.throws(() => scopeCss(prefix, "a{b:c}"), /not a scope prefix/, String(prefix));
  // A class named like the document, or the document in an attribute value, is not the document.
  assert.equal(scopeCss(".s", ".body,#html,[data-x=\"body\"]{a:b}"), '.s .body,.s #html,.s [data-x="body"]{a:b}');
});

test("selectorsOf and splitSelectors read a stylesheet's selectors, inside @media too", () => {
  assert.deepEqual(splitSelectors(' .a , :is(.b,.c) d,[x="1,2"]'), [".a", ":is(.b,.c) d", '[x="1,2"]']);
  assert.deepEqual(selectorsOf(".a,.b{x:y}@media (z){.c{x:y}}"), [".a", ".b", ".c"]);
  assert.deepEqual(selectorsOf("@media (x){a{b:c}@keyframes k{50%{d:e}}}@font-face{f:g}"), ["a"], "a keyframes step is no selector");
  // bundle.css parses whole, its one @keyframes inside its motion @media.
  const all = selectorsOf(PULSE_CSS);
  assert.ok(all.length > 300 && all.every((s) => s !== "" && !/^\d|%$/.test(s)), "every selector is one");
});

// ---- the rules themselves (issue #737's review): each one a reviewer measured broken, or a mutant survived without ----

/** A declaration block as `{property: value}`. */
const declsOf = (body) => Object.fromEntries(body.split(";").filter((d) => d.trim() !== "").map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));

/**
 * `css`'s rules by selector list, the top level's and each `@media` block's apart: `{top, media: {<prelude>: ...}}`. A
 * block nested in another is keyed by both preludes, outer first ("@media A @media B"), and two blocks with one prelude
 * are one.
 */
function rulesOf(css) {
  const top = {};
  const media = {};
  const walk = (text, at) => {
    for (const { prelude, body } of cssBlocks(text)) {
      if (prelude.startsWith("@media")) walk(body, at === null ? prelude : `${at} ${prelude}`);
      else if (at === null) top[prelude] = declsOf(body);
      else (media[at] ??= {})[prelude] = declsOf(body);
    }
  };
  walk(css, null);
  return { top, media };
}

/**
 * Whether a viewport `width` px wide (fractional: a zoomed or scaled window) matches `prelude`, as `rulesOf` keys it.
 * Reads the forms the shell writes (`(min-width: Npx)`, `(max-width: Npx)`, `and`, `not all and`, one block nested in
 * another) and throws on any other, so a new form cannot pass unread.
 */
function mediaMatches(prelude, width) {
  return prelude.split(/\s*@media\s+/).filter((q) => q !== "").every((q) => {
    const not = q.startsWith("not all and ");
    const met = q.slice(not ? "not all and ".length : 0).split(/\s+and\s+/).every((feature) => {
      const m = /^\((min|max)-width: (\d+)px\)$/.exec(feature);
      if (!m) throw new Error(`a media feature this test does not read: ${feature}`);
      return m[1] === "min" ? width >= Number(m[2]) : width <= Number(m[2]);
    });
    return not ? !met : met;
  });
}

const PHONE = "@media (max-width: 760px)";
const DESKTOP = "@media not all and (max-width: 760px)";
const NAV_BREAK = `${DESKTOP} @media (max-width: 939px)`;
const ONE_ROW = "@media (min-width: 1440px)";
const ONE_ROW_RO = "@media (min-width: 1600px)";
const SHELL = rulesOf(SHELL_CSS);
const LEGACY = rulesOf(LEGACY_CSS);

/** WCAG 2 contrast of two `#rrggbb` colours (the formula console-contrast.test.mjs measures every token pair with). */
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("the top bar's breakpoints follow the viewport and the read-only class alone: phone, two rows, one row", () => {
  assert.deepEqual(TOP_BAR, { phoneMax: 760, navBreakMax: 939, oneRowMin: 1440, oneRowReadOnlyMin: 1600 });
  assert.ok(Object.isFrozen(TOP_BAR));
  // The phone is bundle.css's own: its breakpoint, its scrolling row; above it bundle.css's navigation is no scroll box.
  assert.ok(PULSE_CSS.includes(`@media (max-width: ${TOP_BAR.phoneMax}px) {`));
  assert.match(PULSE_CSS, /@media \(max-width: 760px\) \{[^]*\.pillnav \{ order: 3; width: 100%; overflow-x: auto;/, "bundle.css's phone row");
  assert.match(PULSE_CSS, /\n\.pillnav \{ display: flex; gap: 6px; min-width: 0; \}\n/, "and nothing else in it scrolls");
  // Exactly these media blocks, each named from TOP_BAR: no rule keyed to anything the script changes.
  assert.deepEqual(Object.keys(SHELL.media), [DESKTOP, NAV_BREAK, ONE_ROW, ONE_ROW_RO, PHONE]);
  assert.ok(SHELL_CSS.includes(`\n${DESKTOP}{@media (max-width: ${TOP_BAR.navBreakMax}px){`), "the navigation's break nested inside the desktop's own query");
  // Above the phone the navigation never scrolls: no overflow on it anywhere but the phone block.
  for (const [where, rules] of [["top", SHELL.top], ...Object.entries(SHELL.media).filter(([m]) => m !== PHONE)]) {
    for (const [sel, d] of Object.entries(rules)) if (sel.includes("pillnav")) assert.ok(!Object.keys(d).some((p) => p.startsWith("overflow") || p === "scrollbar-width"), `${where} ${sel}: no scroll box above a phone`);
  }
});

test("the media queries cover every width, fractional ones too: the desktop's rules apply exactly where the phone's do not", () => {
  // The third review's gap: a window 760.5 CSS px wide (a zoomed or scaled display) matched neither a max-width: 760px
  // nor a min-width: 761px block, and drew the bundle's bare row.
  assert.deepEqual([mediaMatches(PHONE, 760.5), mediaMatches("@media (min-width: 761px)", 760.5)], [false, false], "the old pair's gap, as this reader sees it");
  for (let tenths = 3000; tenths <= 20000; tenths += 1) {
    const w = tenths / 10;
    const on = Object.fromEntries(Object.keys(SHELL.media).map((m) => [m, mediaMatches(m, w)]));
    assert.notEqual(on[PHONE], on[DESKTOP], `${w}px: the phone's or the desktop's, never both or neither`);
    assert.equal(on[NAV_BREAK], on[DESKTOP] && w <= TOP_BAR.navBreakMax, `${w}px: the navigation breaks on a desktop up to ${TOP_BAR.navBreakMax}px`);
    assert.equal(on[ONE_ROW], w >= TOP_BAR.oneRowMin, `${w}px: one row`);
    assert.equal(on[ONE_ROW_RO], w >= TOP_BAR.oneRowReadOnlyMin, `${w}px: one row, read-only`);
  }
  // The legacy layer's own phone block is the same query, so it switches with the shell's.
  assert.ok(Object.hasOwn(LEGACY.media, PHONE));
});

test("above a phone the bar is a grid: the pi-dispatch pill and the end, then the navigation wrapping across the width; one row from 1440 (1600 read-only)", () => {
  assert.deepEqual(SHELL.media[DESKTOP], {
    ".top": { display: "grid", "grid-template-columns": "max-content minmax(0,1fr)", gap: "var(--space-3)" },
    ".top>.brandpill": { "grid-row": "1", "grid-column": "1" },
    ".top__end": { "grid-row": "1", "grid-column": "2", "min-width": "0", "margin-left": "0", "justify-content": "flex-end" },
    ".pillnav": { "grid-row": "2", "grid-column": "1/-1", "flex-wrap": "wrap" },
  });
  // Below 940 the navigation breaks after its fourth pill whatever the Parked count says: a count that appears cannot
  // push a pill onto a new line. The break is a full-width zero-height item between the two orders, 6px tall, the gap.
  assert.deepEqual(SHELL.media[NAV_BREAK], {
    ".pillnav": { "row-gap": "0" },
    ".pillnav>:nth-child(-n+4)": { order: "1" },
    ".pillnav::after": { content: '""', order: "2", "flex-basis": "100%", height: "6px" },
    ".pillnav>:nth-child(n+5)": { order: "3" },
  });
  const oneRow = { "grid-template-columns": "max-content max-content minmax(0,1fr)" };
  assert.deepEqual(SHELL.media[ONE_ROW], {
    ".top:not(.top--ro)": oneRow,
    ".top:not(.top--ro)>.pillnav": { "grid-row": "1", "grid-column": "2" },
    ".top:not(.top--ro)>.top__end": { "grid-column": "3" },
  });
  assert.deepEqual(SHELL.media[ONE_ROW_RO], {
    ".top--ro": oneRow,
    ".top--ro>.pillnav": { "grid-row": "1", "grid-column": "2" },
    ".top--ro>.top__end": { "grid-column": "3" },
  });
  // Inside the end only the name gives way: every other part keeps its size, the name's column shrinks to nothing and
  // its two lines are cut with an ellipsis, never wider than 160px.
  assert.deepEqual(SHELL.top[".top__end>*"], { flex: "none" });
  assert.deepEqual(SHELL.top[".top__end>.who"], { flex: "0 1 auto", "min-width": "0" });
  assert.deepEqual(SHELL.top[".who>span:first-child"], { flex: "0 1 auto", "min-width": "0", "max-width": "160px" });
  assert.deepEqual(SHELL.top[".who b,.who small"], { "max-width": "100%", overflow: "hidden", "text-overflow": "ellipsis" });
  assert.match(PULSE_CSS, /\.who \{[^}]*white-space: nowrap; \}/, "on one line each, as the ellipsis needs");
  assert.deepEqual(SHELL.top[".top"], { position: "relative" });
  assert.deepEqual(SHELL.top[".pillnav>a"], { position: "relative", flex: "none" }, "a pill keeps its size and contains its own visually hidden text");
  assert.deepEqual(SHELL.top[".pillnav [data-panel]:empty"], { display: "none" }, "an empty Parked count leaves no gap in its pill");
  assert.deepEqual(SHELL.top[".pillnav [data-panel]"], { display: "inline-flex" });
});

test("the classes those rules key on are the shell's: top--ro on a read-only console's bar alone, and the cut name and role's title", async () => {
  const draw = async (readOnly, name, role = "operator") => String((await renderPage("fleet", { query: {}, session: { name, role }, readOnly, data: { now: 0, env: {} }, theme: null })).html);
  const LONG = "Wilhelmina Featherstonehaugh-Smy";
  // Name and role share one column as wide as the wider of the two, so the longer is cut first; the block's title holds both.
  assert.match(await draw(true, LONG), new RegExp(`<header class="top top--ro">[^]*<span class="who" title="${LONG}, Operator"><span><b>${LONG}</b><small>Operator</small></span>`));
  assert.match(await draw(false, "ops"), /<header class="top"><a class="brandpill"[^]*<span class="who" title="ops, Operator"><span><b>ops<\/b><small>Operator<\/small><\/span>/);
  assert.match(await draw(false, "watcher", "viewer"), /<span class="who" title="watcher, Viewer">/);
  assert.match(PULSE_CSS, /\.who > span:first-child \{ display: flex; flex-direction: column; align-items: flex-end; \}/, "name over role, one column");
  assert.ok(SHELL_CSS.includes(".top--ro{") && SHELL_CSS.includes(".top:not(.top--ro){"));
});

test("on a phone the navigation is bundle.css's own row, scrolling inside itself, with room for the focus ring", () => {
  const phone = SHELL.media[PHONE];
  assert.deepEqual(phone[".pillnav"], { flex: "0 0 auto", margin: "-4px calc(var(--space-4) * -1)", padding: "4px var(--space-4)", "overflow-y": "hidden" });
  assert.deepEqual(phone[".pillnav::-webkit-scrollbar"], { display: "none" });
  assert.deepEqual(phone[".top__end"], { flex: "0 1 auto", "min-width": "0", "flex-wrap": "wrap", "justify-content": "flex-end", gap: "6px" });
});

test("the More menu: a round button whose list opens under it, by CSS above a phone and against the bar on one", () => {
  // The button (mutants X01, X06: its radius and its display, the whole rule pinned).
  assert.deepEqual(SHELL.top["details.more>summary"], { display: "inline-flex", "align-items": "center", "justify-content": "center", width: "var(--control-h)", height: "var(--control-h)", padding: "0", "border-radius": "var(--radius-pill)", background: "var(--surface)", color: "var(--ink-muted)", "list-style": "none", cursor: "pointer" });
  assert.deepEqual(SHELL.top["details.more>summary::-webkit-details-marker"], { display: "none" });
  assert.deepEqual(SHELL.media[PHONE]["details.more>summary"], { width: "40px", height: "40px" }, "round on a phone too, the nav pills' height");
  // Above a phone the details is the list's containing block: right edges aligned, 6px below, with no script.
  assert.deepEqual(SHELL.top["details.more"], { position: "relative", flex: "none" });
  assert.deepEqual(SHELL.top["details.more>:not(summary)"], { position: "absolute", top: "calc(100% + 6px)", right: "0", "z-index": "5", display: "grid", gap: "2px", "min-width": "180px", padding: "6px", "border-radius": "var(--radius-md)", background: "var(--surface)", "box-shadow": "inset 0 0 0 1px var(--line),0 8px 24px rgba(0,0,0,.14)" });
  // On a phone the scrolling navigation would clip it: unpositioned there, so the bar is its containing block.
  assert.deepEqual(SHELL.media[PHONE]["details.more"], { position: "static" });
  for (const rules of [SHELL.top, ...Object.values(SHELL.media)]) {
    for (const [sel, d] of Object.entries(rules)) assert.ok(!(sel.includes("more") && d.position === "fixed"), `${sel}: no fixed list, which floated away on a scrolled page`);
  }
  assert.doesNotMatch(SHELL_CSS, /112px/);
  // The current page inside More: the button takes the current pill's look, and the link reads in ink on its ground.
  assert.deepEqual(SHELL.top['details.more:has(a[aria-current="page"])>summary'], { background: "var(--primary)", color: "var(--on-primary)" });
  assert.deepEqual(SHELL.top['details.more a[aria-current="page"]'], { background: "var(--surface-2)", color: "var(--ink)" });
  for (const theme of ["light", "dark"]) assert.ok(contrast(colorOf("ink", theme), colorOf("surface-2", theme)) >= 4.5, `${theme}: ink on surface-2 reads`);
  assert.match(PULSE_CSS, /\.pillnav a\[aria-current="page"\] \{ background: var\(--primary\); color: var\(--on-primary\); \}/, "what the link would otherwise take, white on a pale ground");
});

/**
 * A selector's compounds from the left with the combinator before each (" " or ">"), each as its classes and the classes
 * it refuses (`:not(.x)`). Reads the forms the live pill's rules use; throws on any other part, so none is misread.
 */
function compoundsOf(selector) {
  return selector.split(/\s*(>)\s*|\s+/).filter((x) => x !== undefined && x !== "").reduce((out, tok) => {
    if (tok === ">") out.next = ">";
    else {
      const rest = tok.replace(/\.([\w-]+)|:not\(\.([\w-]+)\)|\[data-live-word\]/g, "");
      if (rest !== "") throw new Error(`a selector part this test does not read: ${tok} in ${selector}`);
      out.list.push({ by: out.next, has: [...tok.matchAll(/(?<!:not\()\.([\w-]+)/g)].map((m) => m[1]), not: [...tok.matchAll(/:not\(\.([\w-]+)\)/g)].map((m) => m[1]), word: tok.includes("[data-live-word]") });
      out.next = " ";
    }
    return out;
  }, { list: [], next: " " }).list;
}

/** Whether `selector` picks the last element of `chain` (outermost first: `{cls, word}` each). */
function picks(selector, chain) {
  const want = compoundsOf(selector);
  const fits = (c, el) => c.has.every((x) => el.cls.includes(x)) && c.not.every((x) => !el.cls.includes(x)) && (!c.word || el.word === true);
  const from = (ci, ei) => {
    if (ci < 0) return true;
    if (ei < 0 || !fits(want[ci], chain[ei])) return false;
    if (ci === 0) return true;
    if (want[ci].by === ">") return from(ci - 1, ei - 1);
    for (let up = ei - 1; up >= 0; up -= 1) if (from(ci - 1, up)) return true;
    return false;
  };
  return from(want.length - 1, chain.length - 1);
}

/** `.top__end`, the live pill in `state`'s classes, and its marks (the dot and each state's glyph) as the shell draws them. */
const pillChain = (state) => {
  const end = { cls: ["top__end"] };
  const pill = { cls: LIVE_STATES[state].cls.split(" ") };
  const marks = { dot: { cls: ["dot"] }, ...Object.fromEntries(Object.keys(LIVE_GLYPHS).map((g) => [g, { cls: ["ic", "ic--sm", `live__${g}`] }])) };
  return { end, pill, marks };
};

/**
 * Which of the pill's marks show in `state`, from the shell's rules (top level, and `media`'s when given) that set
 * `display` on a mark: the most specific wins, then the last. A mark no rule hides shows (bundle.css draws the dot and an
 * icon visible).
 */
function marksShown(state, media) {
  const { end, pill, marks } = pillChain(state);
  const rules = [...Object.entries(SHELL.top), ...(media ? Object.entries(SHELL.media[media]) : [])];
  return Object.entries(marks).filter(([, mark]) => {
    let best = null;
    rules.forEach(([list, d], order) => {
      if (!("display" in d)) return;
      for (const sel of splitSelectors(list)) {
        // Only a rule naming the pill, a mark or an icon can pick one (the others name panels, the navigation, More).
        if (!/\.live\b|\.dot\b|\.ic\b/.test(sel) || !picks(sel, [end, pill, mark])) continue;
        // Classes, attributes and :not()'s class each weigh one class; these selectors name no id and no type.
        const weight = compoundsOf(sel).reduce((n, c) => n + c.has.length + c.not.length + (c.word ? 1 : 0), 0);
        if (best === null || weight > best.weight || (weight === best.weight && order >= best.order)) best = { weight, order, display: d.display };
      }
    });
    return best === null || best.display !== "none";
  }).map(([name]) => name);
}

test("the live pill: only Live pulses; above a phone the dot and the word (Signed out its glyph), on a phone ONE fixed 16px mark whose shape says the state", () => {
  // bundle.css pulses every live dot, under no-preference only; the shell stills the other states.
  assert.match(PULSE_CSS, /@media \(prefers-reduced-motion: no-preference\) \{\n {2}\.live \.dot \{ animation: pulse/);
  assert.deepEqual(SHELL.top[".live--retry .dot,.live--off .dot"], { animation: "none" });
  assert.deepEqual(SHELL.top[".live>.ic"], { display: "none" }, "every glyph is drawn hidden");
  assert.deepEqual(SHELL.top[".live--out>.dot"], { display: "none" });
  assert.deepEqual(SHELL.top[".live--out>.live__out"], { display: "block" });
  // The mark each state shows, read from the rules: above a phone the dot but for Signed out; on a phone a shape each.
  const desktop = Object.fromEntries(Object.keys(LIVE_STATES).map((s) => [s, marksShown(s, null)]));
  assert.deepEqual(desktop, { start: ["dot"], on: ["dot"], retry: ["dot"], off: ["dot"], out: ["out"] });
  const phone = Object.fromEntries(Object.keys(LIVE_STATES).map((s) => [s, marksShown(s, PHONE)]));
  assert.deepEqual(phone, { start: ["off"], on: ["dot"], retry: ["retry"], off: ["off"], out: ["out"] }, "Not live (the server's first state too) the stop square, Reconnecting the retry arrow, Signed out the sign-out arrow");
  assert.deepEqual(LIVE_GLYPHS, { retry: "rerun", off: "cancel", out: "logout" });
  assert.equal(new Set(Object.values(LIVE_GLYPHS)).size, 3, "three shapes, and the dot a fourth");
  // On a phone bundle.css hides the pill and its status region; the shell keeps it as one 16px slot on the canvas.
  assert.match(PULSE_CSS, /\.top__end \.live, \.top__end \.who > span:first-child, \.top__end \.hide-phone \{ display: none; \}/);
  const P = SHELL.media[PHONE];
  assert.deepEqual(P[".top__end .live"], { display: "inline-flex", position: "relative", "justify-content": "center", width: "16px", height: "16px", padding: "0", gap: "0", background: "transparent" });
  assert.deepEqual(P[".top__end .live>.ic"], { width: "16px", height: "16px" }, "each glyph fills the slot");
  assert.deepEqual(SHELL.top[".top__end>*"], { flex: "none" }, "and the slot never shrinks");
  // THE SLOT NEVER CHANGES SIZE: no rule that names a state sets anything on the pill itself but its colour (bundle.css's
  // ink per state); the states pick only which mark shows inside it (the third review measured the phone bar moving by
  // 50px when the word appeared and went).
  const stateRules = [];
  for (const [label, css] of [["bundle.css", PULSE_CSS], ["SHELL_CSS", SHELL_CSS]]) {
    const { top, media } = rulesOf(css);
    for (const [where, rules] of [["top", top], ...Object.entries(media).filter(([m]) => m === PHONE || m === "@media (max-width: 760px)")]) {
      for (const [list, d] of Object.entries(rules)) {
        for (const sel of splitSelectors(list)) {
          const parts = sel.split(/\s*>\s*|\s+/);
          const subject = parts.at(-1);
          if (!/(?:^|\.)live(?:--[a-z]+)?(?![\w-])/.test(subject) || !/live--/.test(subject)) continue;
          assert.deepEqual(Object.keys(d), ["color"], `${label} ${where} ${sel}: a state's rule on the pill itself sets its colour alone`);
          stateRules.push(`${label} ${sel}`);
        }
      }
    }
  }
  assert.deepEqual(stateRules, ["bundle.css .live--retry", "bundle.css .live--off"], "the rules that read: bundle.css's ink per state");
  // Its word is hidden from view in every state and kept for assistive technology; no other rule touches it.
  assert.deepEqual(P[".top__end .live [data-live-word]"], { position: "absolute", width: "1px", height: "1px", margin: "-1px", overflow: "hidden", "clip-path": "inset(50%)", "white-space": "nowrap" });
  for (const rules of [SHELL.top, ...Object.values(SHELL.media)]) {
    for (const sel of Object.keys(rules)) if (sel.includes("data-live-word")) assert.equal(sel, ".top__end .live [data-live-word]", sel);
  }
  // Each mark in its state's ink on the bar's ground (the canvas: the bar and the slot draw none), 3:1 or more in both
  // themes. The glyphs are drawn in currentColor, the dot in the ok colour.
  assert.match(PULSE_CSS, /\n\.live \.dot \{ background: var\(--ok\);/);
  assert.match(PULSE_CSS, /\n\.live--retry \{ color: var\(--attention-ink\); \}/);
  assert.match(PULSE_CSS, /\n\.live--off \{ color: var\(--ink-muted\); \}/);
  for (const glyph of Object.values(LIVE_GLYPHS)) assert.match(String(SPRITE), new RegExp(`<symbol id="i-${glyph}"(?:(?!</symbol>)[^])*currentColor`), `${glyph} is drawn in currentColor`);
  for (const rule of ["\n.top {", "\n.page {", "\n.top__end {"]) {
    const at = PULSE_CSS.indexOf(rule);
    assert.ok(at >= 0 && !PULSE_CSS.slice(at, PULSE_CSS.indexOf("}", at)).includes("background"), `${rule.trim()} draws no ground of its own`);
  }
  assert.match(PULSE_CSS, /\nbody \{ margin: 0; background: var\(--canvas\);/);
  const INK = { on: "ok", retry: "attention-ink", off: "ink-muted", out: "ink-muted", start: "ink-muted" };
  for (const theme of ["light", "dark"]) {
    for (const [state, ink] of Object.entries(INK)) assert.ok(contrast(colorOf(ink, theme), colorOf("canvas", theme)) >= 3, `${theme} ${state}: ${ink} on the canvas, ${contrast(colorOf(ink, theme), colorOf("canvas", theme)).toFixed(2)}:1`);
    // Above a phone the words are bundle.css's colours on the pill's surface, and read as text.
    for (const ink of ["attention-ink", "ink-muted"]) assert.ok(contrast(colorOf(ink, theme), colorOf("surface", theme)) >= 4.5, `${theme}: ${ink} on surface`);
  }
});

test("the theme button keeps its space while hidden: laid out but not drawn, focusable or clickable, so showing it moves nothing", () => {
  assert.deepEqual(SHELL.top["[hidden]:not([data-theme-toggle])"], { display: "none!important" });
  assert.deepEqual(SHELL.top["[data-theme-toggle][hidden]"], { visibility: "hidden" });
  // Its display stays the round button's (an author rule beats the browser's own [hidden]), and nothing else sets one.
  assert.match(PULSE_CSS, /\n\.roundbtn \{ display: inline-flex;/);
  assert.doesNotMatch(PULSE_CSS, /data-theme-toggle|\[hidden\]/);
  for (const rules of [SHELL.top, ...Object.values(SHELL.media)]) {
    for (const [sel, d] of Object.entries(rules)) if (sel.includes("data-theme-toggle") && sel !== "[hidden]:not([data-theme-toggle])") assert.deepEqual(d, { visibility: "hidden" }, sel);
  }
});

test("main stacks the title bar and the cards in one column that never widens a phone, 12px apart there; a title wraps anywhere", () => {
  assert.deepEqual(SHELL.top.main, { display: "grid", "grid-template-columns": "minmax(0,1fr)", gap: "var(--space-4)", "min-width": "0", "align-content": "start" });
  assert.deepEqual(SHELL.media[PHONE].main, { gap: "12px" });
  assert.deepEqual(SHELL.top[".titlebar h1"], { "overflow-wrap": "anywhere", "min-width": "0" }, "a run id has nowhere else to break");
});

test("the legacy layer: the sign-in card, the charts' own font, readable fields and table cells, and the phone's spacing", () => {
  // The sign-in form is a card with the primary pill (its grey button read as disabled on the bare canvas).
  assert.deepEqual(LEGACY.top[".legacy #login-form"], { display: "grid", gap: "var(--space-3)", "max-width": "480px", padding: "var(--space-8)", "border-radius": "var(--radius-xl)", background: "var(--surface)" });
  assert.deepEqual(LEGACY.top['.legacy #login-form button[type="submit"]'], { width: "100%", height: "var(--control-h)", background: "var(--primary)", color: "var(--on-primary)", "font-size": "15px" });
  // Its label and its field, whole (mutants Z07, Z08): the label muted and bold, the field a pill in the code font.
  assert.deepEqual(LEGACY.top[".legacy #login-form label"], { "font-size": "13px", "font-weight": "650", color: "var(--ink-muted)" });
  assert.deepEqual(LEGACY.top[".legacy #login-form input"], { height: "var(--control-h)", "border-radius": "var(--radius-pill)", padding: "0 20px", "font-family": "var(--font-mono)" });
  // The charts keep the insights font their labels were sized for (label-fit-check.mjs measured cuts without it).
  assert.equal(INSIGHTS_CSS.match(/(?:^|\n)body\{[^}]*?font:([^;}]+)/)[1], LEGACY.top[".legacy svg"].font);
  assert.equal(LEGACY.top[".legacy"].font, "inherit", "the old panels' text takes the console's font");
  assert.equal(LEGACY.top[".legacy textarea,.legacy form.act textarea"]["font-weight"], "400", "a field's text is not its label's bold");
  assert.deepEqual(LEGACY.top[".legacy button[disabled]"], { opacity: ".45", cursor: "not-allowed" });
  const phone = LEGACY.media[PHONE];
  assert.deepEqual(phone[".legacy>section[data-panel],.legacy>section.transcript-section"], { "margin-bottom": "12px", padding: "var(--space-4)", "border-radius": "22px" });
  assert.deepEqual(phone[".legacy table.grid td:not([colspan]):not(:has(br))"], { "white-space": "nowrap" }, "a model or an id never breaks at its hyphens in a cell");
  assert.deepEqual([4, 6, 9].map((n) => phone[`.legacy table.grid:has(thead th:nth-child(${n}))`]["min-width"]), ["520px", "720px", "960px"]);
  assert.deepEqual(phone[".legacy #login-form"], { padding: "var(--space-5)" }, "the sign-in card's phone padding, the bundle's card padding there (mutant Z09)");
});

test("the neutraliser keeps each selector's own specificity: one :is() per specificity, every member of a rule alike", () => {
  const rules = cssBlocks(LEGACY_CSS).filter((b) => b.prelude.startsWith(":where(.legacy) :is("));
  assert.ok(rules.length > 1, "more than one specificity among the collisions");
  const seen = [];
  for (const { prelude } of rules) {
    const members = splitSelectors(/^:where\(\.legacy\) :is\((.*)\)$/.exec(prelude)[1]);
    const levels = new Set(members.map(specificity));
    assert.equal(levels.size, 1, `${prelude}: one specificity`);
    seen.push(...levels);
  }
  assert.equal(new Set(seen).size, rules.length, "one rule per specificity");
  assert.deepEqual(rules.flatMap(({ prelude }) => splitSelectors(/^:where\(\.legacy\) :is\((.*)\)$/.exec(prelude)[1])).sort(), [...NEUTRALISED].sort());
  assert.ok(specificity(".kpi b") > specificity(".kpi") && specificity(".phases .bar i") > specificity(".phases .bar"));
  // Each selector's [ids, classes, types], pinned: a weighting that lets types reach a class's weight (mutant Z03) or
  // drops attributes and pseudo-classes (Z06) changes a tuple.
  const tuple = (n) => [Math.floor(n / 10000), Math.floor(n / 100) % 100, n % 100];
  assert.deepEqual(Object.fromEntries(NEUTRALISED.map((s) => [s, tuple(specificity(s))])), {
    ".badge": [0, 1, 0],
    ".banner": [0, 1, 0],
    ".big": [0, 1, 0],
    ".cap": [0, 1, 0],
    ".confirm": [0, 1, 0],
    ".diff": [0, 1, 0],
    ".facts": [0, 1, 0],
    ".kpi": [0, 1, 0],
    ".kpi b": [0, 1, 1],
    ".kpi span": [0, 1, 1],
    ".note": [0, 1, 0],
    ".pager": [0, 1, 0],
    ".phases": [0, 1, 0],
    ".phases .bar": [0, 2, 0],
    ".phases .bar i": [0, 2, 1],
    ".phases li": [0, 1, 1],
    ".wl": [0, 1, 0],
  });
  assert.ok(specificity(".x") > specificity("a b c d e"), "one class outweighs any run of types");
  assert.deepEqual(tuple(specificity("#a .b c")), [1, 1, 1]);
  assert.deepEqual(tuple(specificity("a[href]:hover")), [0, 2, 1], "an attribute and a pseudo-class weigh as classes");
});

test("insightsFont reads the insights page's own font from its body rule, and throws when the rule names none", () => {
  assert.equal(insightsFont(), LEGACY.top[".legacy svg"].font, "the charts' font is the insights page's");
  assert.equal(insightsFont("p{font:9px x}\nbody{margin:0;font:13px/1.4 Menlo, monospace}"), "13px/1.4 Menlo, monospace");
  // A silent fallback (mutant Z01) would draw the charts in the console's font, which cuts their labels.
  for (const bad of ["body{margin:0}", "p{font:13px x}", ".body{margin:0;font:13px x}", ""]) assert.throws(() => insightsFont(bad), /body rule names no font/, bad);
});

test("the charts' colours are re-pointed to the right tokens: status keeps its status, text reads, a meter track is a bed", () => {
  assert.deepEqual(SVG_EXTRA, {
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
  assert.deepEqual(LEGACY.top['.legacy svg [fill="#ff5f57"]'], { fill: "var(--failed)" }, "a failed square stays failed");
  assert.deepEqual(LEGACY.top['.legacy svg [fill="#6e7681"]'], { fill: "var(--idle)" });
  assert.deepEqual(LEGACY.top['.legacy svg [stroke="#6e7681"]'], { stroke: "var(--ink-muted)" });
  // Chart text in a colour that is a chip's ground elsewhere is drawn in ink, after the fills, so it wins.
  for (const hex of ["#999", "#a6bbcf"]) assert.deepEqual(LEGACY.top[`.legacy svg text[fill="${hex}"],.legacy svg tspan[fill="${hex}"]`], { fill: "var(--ink-muted)" }, hex);
  assert.ok(LEGACY_CSS.indexOf('.legacy svg text[fill="#a6bbcf"]') > LEGACY_CSS.indexOf('.legacy svg [fill="#a6bbcf"]'));
  assert.deepEqual(LEGACY.top[`.legacy svg rect[fill="none"][stroke="${PAGE_THEME.border}"]`], { fill: "var(--dot-off)", stroke: "none" }, "a meter's outlined track is a filled bed");
});

test("pageCss confines each page's rules to its own body, and refuses a key that is not a page name", () => {
  assert.equal(pageCss({ runs: ".x{a:b}\n@media (max-width: 760px){p{c:d}}", fleet: "body{e:f}" }), [
    'body[data-page="runs"] .x{a:b}',
    '@media (max-width: 760px){body[data-page="runs"] p{c:d}}',
    'body[data-page="fleet"]{e:f}',
  ].join("\n"));
  assert.equal(pageCss(), pageCss(PAGE_CSS), "the default table is PAGE_CSS");
  for (const bad of ["Runs", "a b", "x{", "__proto__x;"]) assert.throws(() => pageCss({ [bad]: "a{b:c}" }), /not a page name/, bad);
});

test("cssBlocks reads a backslash escape inside a quoted string as part of the string", () => {
  const css = 'a::before{content:"\\"}"}b{c:d}';
  assert.deepEqual(cssBlocks(css), [{ prelude: "a::before", body: 'content:"\\"}"' }, { prelude: "b", body: "c:d" }]);
  assert.equal(scopeCss(".s", css), '.s a::before{content:"\\"}"}\n.s b{c:d}');
  assert.deepEqual(cssBlocks("a{content:'\\'{'}"), [{ prelude: "a", body: "content:'\\'{'" }]);
});
