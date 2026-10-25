import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LEGACY_CSS, NEUTRALISED, SVG_EXTRA, insightsFont, specificity } from "../src/console/compat-css.mjs";
import { AUDIT_LAYOUT, PAGE_CSS, SECONDARY_BTN, SHELL_CSS, TOP_BAR, cssBlocks, pageCss, scopeCss, selectorsOf, splitSelectors, stackRules } from "../src/console/page-css.mjs";
import { PULSE_CSS, PULSE_CSS_SHA256 } from "../src/console/pulse-css.mjs";
import { PULSE_TOKENS, PULSE_TOKENS_SHA256, colorOf, tokenCss } from "../src/console/pulse-tokens.mjs";
import { renderPage } from "../src/console/pages.mjs";
import { SPRITE } from "../src/console/pulse-icons.mjs";
import { BTN_KINDS } from "../src/console/kit.mjs";
import { CONFIRM_CLASSES } from "../src/console/confirm-view.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
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
  // The shell re-points one token, the faint ink, on a stale page's flat panels (where its words sit on the canvas, on
  // which the token promises no contrast), and declares one property of its own there, the ring those panels hand their
  // secondary controls (SHELL_CSS's header). Nothing else.
  assert.deepEqual([...declared(SHELL_CSS)], ["--ink-faint", "--stale-ring"]);
  assert.ok(tokens.has("--ink-faint") && !tokens.has("--stale-ring"));
  const shellOwn = new Set(["--stale-ring"]);
  for (const [label, css] of [["bundle.css", PULSE_CSS], ["SHELL_CSS", SHELL_CSS], ["pageCss()", pageCss()]]) {
    for (const name of read(css)) assert.ok(tokens.has(name) || own.has(name) || (label === "SHELL_CSS" && shellOwn.has(name)), `${label} reads ${name}, which tokenCss() defines`);
  }
  // The legacy layer reads tokens, its own `--pd-*` set, which it defines from tokens on the wrapper, and the shell's
  // ring.
  const legacyOwn = declared(LEGACY_CSS);
  for (const name of legacyOwn) assert.match(name, /^--pd-/, `${name}: the legacy layer declares only the old --pd-* names`);
  for (const name of read(LEGACY_CSS)) assert.ok(tokens.has(name) || legacyOwn.has(name) || shellOwn.has(name), `the legacy layer reads ${name}, which is defined`);
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

test("PAGE_CSS holds the converted pages' rules (PR 2: sign-in, error, audit), each served only under its own body", () => {
  assert.ok(Object.isFrozen(PAGE_CSS));
  assert.deepEqual(Object.keys(PAGE_CSS), ["login", "login-code", "error", "audit"]);
  assert.equal(PAGE_CSS.login, PAGE_CSS["login-code"], "the two sign-in pages are one card's rules");
  // The audit log's viewer refusal draws the error card inside the signed-in frame, on the audit page's body.
  assert.ok(PAGE_CSS.audit.endsWith(PAGE_CSS.error), "the audit page carries the error card's rules too");
  const served = pageCss();
  assert.ok(CONSOLE_CSS.includes(served));
  for (const sel of selectorsOf(served)) assert.match(sel, /^body\[data-page="(?:login|login-code|error|audit)"\](?:$|[ >])/, sel);
  for (const name of Object.keys(PAGE_CSS)) assert.ok(served.includes(`body[data-page="${name}"] `), name);
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
  const other = {};
  const walk = (text, at) => {
    for (const { prelude, body } of cssBlocks(text)) {
      if (prelude.startsWith("@media")) walk(body, at === null ? prelude : `${at} ${prelude}`);
      else if (prelude.startsWith("@")) other[prelude] = body;
      else if (at === null) top[prelude] = declsOf(body);
      else (media[at] ??= {})[prelude] = declsOf(body);
    }
  };
  walk(css, null);
  return { top, media, other };
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

/** The write flow's markup, as written (the Undo row's parts). */
const CONFIRM_VIEW_SOURCE = readFileSync(new URL("../src/console/confirm-view.mjs", import.meta.url), "utf8");
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
  assert.match(await draw(true, LONG), new RegExp(`<header class="top top--ro">[^]*<span class="who" data-name="${LONG}" data-role="operator" title="${LONG}, Operator"><span><b>${LONG}</b><small>Operator</small></span>`));
  assert.match(await draw(false, "ops"), /<header class="top"><a class="brandpill"[^]*<span class="who" data-name="ops" data-role="operator" title="ops, Operator"><span><b>ops<\/b><small>Operator<\/small><\/span>/);
  assert.match(await draw(false, "watcher", "viewer"), /<span class="who" data-name="watcher" data-role="viewer" title="watcher, Viewer">/);
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
        // (`.live-note` is the notes' region, no part of the pill.)
        if (!/\.(?:live(?:--[a-z]+|__[a-z]+)?|dot|ic)(?![\w-])/.test(sel) || !picks(sel, [end, pill, mark])) continue;
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

test("the phone's Live dot pulses inside its 16px slot: its own keyframes, a 4px ring, only the name changed", () => {
  // bundle.css's pulse grows the 8px dot's ring from 3px to 6px: 20px across, 2px past the 16px slot on each side.
  const dot = /\n\.dot \{[^}]*width: (\d+)px; height: (\d+)px;/.exec(PULSE_CSS);
  assert.deepEqual([dot[1], dot[2]], ["8", "8"]);
  const ringOf = (text) => Number(/box-shadow:\s*0 0 0 (\d+)px/.exec(text)[1]);
  assert.equal(ringOf(/@keyframes pulse \{([^]*?)\}\s*\}/.exec(PULSE_CSS)[1]), 6);
  assert.ok(8 + 2 * 6 > 16, "the bundle's ring spills past the phone's slot");
  // The shell's own keyframes, at the top level (a scoped block refuses one), cap the ring at the slot.
  assert.deepEqual(Object.keys(SHELL.other), ["@keyframes live-phone"]);
  assert.equal(SHELL.other["@keyframes live-phone"], "50%{box-shadow:0 0 0 4px var(--ok-tint)}");
  assert.equal(8 + 2 * ringOf(SHELL.other["@keyframes live-phone"]), 16, "exactly the slot");
  assert.equal(ringOf(PULSE_CSS.slice(PULSE_CSS.indexOf(".live .dot { background: var(--ok);"))), 3, "the still ring, inside the slot already");
  // Only the name changes on a phone: the duration stays bundle.css's, which is set under no-preference alone, so a
  // reader who asked for less motion gets none; the rule names the dot, never a state, and sets nothing else.
  assert.deepEqual(SHELL.media[PHONE][".top__end .live>.dot"], { "animation-name": "live-phone" });
  for (const rules of [SHELL.top, ...Object.values(SHELL.media)]) {
    for (const [sel, d] of Object.entries(rules)) if (Object.keys(d).some((k) => k.startsWith("animation"))) assert.ok(sel === ".top__end .live>.dot" || sel === ".live--retry .dot,.live--off .dot", sel);
  }
  assert.doesNotMatch(SHELL_CSS, /animation-duration|animation:\s*live-phone/);
});

test("the parts a page draws hidden take no space until they show; a page shown as last seen draws its panels flat, its ink kept", () => {
  // A polite live region stays rendered (one that is not is not watched), out of the grid's flow while it shows nothing.
  assert.deepEqual(SHELL.top[".live-note:not(:has(>:not([hidden])))"], { position: "absolute" });
  assert.deepEqual(SHELL.top[".live-note"], { display: "grid", gap: "var(--space-3)", "min-width": "0" });
  for (const rules of [SHELL.top, ...Object.values(SHELL.media)]) {
    for (const [sel, d] of Object.entries(rules)) if (/live-note(?![\w-])/.test(sel)) assert.notEqual(d.display, "none", `${sel}: the region itself is never display:none`);
  }
  assert.deepEqual(SHELL.top[".live-note__at:has(>time:empty)"], { display: "none" }, "the stale note says at only once it has a time");
  // The LiveStates card's dimmed row (`.ls-dim .hostrow{background:transparent;box-shadow:inset 0 0 0 1px
  // var(--line)}`) on each panel's card, the converted one and the legacy panel that is its own card; no opacity and no
  // filter anywhere on a stale page, so every word keeps its contrast and every button its look.
  const STALE = "main.stale section[data-panel] .card:not(.card--tint),main.stale .legacy>section[data-panel]";
  assert.deepEqual(SHELL.top[STALE], { "--ink-faint": "var(--ink-muted)", "--stale-ring": "inset 0 0 0 1px var(--line-strong)", background: "transparent", "box-shadow": "inset 0 0 0 1px var(--line)" });
  // A secondary button (drawn by its surface-3 fill alone, 1.04:1 on the light canvas) keeps an edge there: the flat
  // panel hands down a line-strong ring (3:1 on the canvas in both themes, console-contrast.test.mjs), which every
  // control with that fill wears, and nothing else. The kit's secondary is a .btn with no act: each act's bundle rule
  // draws a fill or a ring of its own (or, the ghost, nothing by design), each size draws neither, read from bundle.css.
  assert.equal(SHELL.top[SECONDARY_BTN]["box-shadow"], "var(--stale-ring,none)");
  const ownLook = (kind) => new RegExp(`\\n\\.btn--${kind} \\{[^}]*(?:background|box-shadow):`).test(PULSE_CSS);
  const acts = BTN_KINDS.filter(ownLook);
  assert.deepEqual(BTN_KINDS.filter((k) => !acts.includes(k)), ["sm", "lg", "round"], "the sizes set no fill and no ring");
  assert.equal(SECONDARY_BTN, `.btn${acts.map((k) => `:not(.btn--${k})`).join("")}`);
  assert.match(PULSE_CSS, /\n\.btn \{[^}]*background: var\(--surface-3\);/, "the plain button's fill");
  // The legacy controls drawn with that fill wear it too; the legacy layer's other surface-3 rules are no control.
  const legacyFill = cssBlocks(LEGACY_CSS).filter((b) => !b.prelude.startsWith("@") && /(?:^|;)background:var\(--surface-3\)/.test(b.body));
  assert.deepEqual(legacyFill.filter((b) => /box-shadow:var\(--stale-ring,none\)/.test(b.body)).map((b) => b.prelude), [".legacy button", ".legacy details.editor>summary", ".legacy .pager a,.legacy .range a"]);
  assert.deepEqual(legacyFill.filter((b) => !/--stale-ring/.test(b.body)).map((b) => b.prelude), [".legacy .badge"], "a badge is a mark, not a control");
  assert.ok(!/--stale-ring:/.test(LEGACY_CSS) && !/--stale-ring:/.test(pageCss()), "the ring is declared on the flat panels alone");
  assert.ok(contrast(colorOf("ink-faint", "light"), colorOf("canvas", "light")) < 4.5, "the faint ink alone would miss AA on the light canvas");
  for (const [label, css] of [["SHELL_CSS", SHELL_CSS], ["pageCss()", pageCss()], ["LEGACY_CSS", LEGACY_CSS]]) {
    for (const rules of [rulesOf(css).top, ...Object.values(rulesOf(css).media)]) {
      for (const [sel, d] of Object.entries(rules)) if (/stale/.test(sel)) assert.ok(!("opacity" in d) && !("filter" in d), `${label} ${sel}: no dimming of the ink`);
    }
  }
  // It outweighs the legacy layer's own panel ground (the layer comes last in the stylesheet, so weight must win).
  assert.match(LEGACY_CSS, /\n\.legacy>section\[data-panel\],\.legacy>section\.transcript-section\{[^}]*background:var\(--surface\)/);
  assert.ok(specificity("main.stale .legacy>section[data-panel]") > specificity(".legacy>section[data-panel]"));
  assert.deepEqual(SHELL.top[".titlebar__end .drawn"], { display: "inline-flex", "align-items": "center", gap: "8px", "font-size": "13px", color: "var(--ink-muted)" });
  // On a phone the drawn note takes its own line, and Reload (the ghost button shellHtml draws right after it, as
  // console-shell.test.mjs pins) starts the next, pulled back by the ghost's own side padding so its icon stands under
  // the clock.
  const ghostPad = /\n\.btn--ghost \{[^}]*padding: 0 (\d+)px;/.exec(PULSE_CSS)[1];
  assert.deepEqual(SHELL.media[PHONE][".titlebar__end>.drawn"], { "flex-basis": "100%" });
  assert.deepEqual(SHELL.media[PHONE][".titlebar__end>.drawn+.btn--ghost"], { "margin-left": `-${ghostPad}px` });
  // The sign-in notices, the same way, inside their card.
  assert.match(PAGE_CSS.login, /\n\.signin:not\(:has\(#notice>:not\(\[hidden\]\)\)\) #notice\{position:absolute\}\n/);
  assert.doesNotMatch(PAGE_CSS.login, /#notice[^{]*\{[^}]*display:none/);
});

test("every class the write flow's markup names has a rule: bundle.css's or the shell's", () => {
  assert.ok(CONFIRM_CLASSES.length > 15);
  for (const c of CONFIRM_CLASSES) {
    const rule = new RegExp(`\\.${c.replace(/[-_]/g, "\\$&")}(?![\\w-])`);
    assert.ok(rule.test(PULSE_CSS) || selectorsOf(SHELL_CSS).some((sel) => rule.test(sel)), `.${c} is styled`);
  }
  // The card's own demo rules, under the names confirm-view.mjs writes (its cs- names were the card's alone).
  assert.deepEqual(SHELL.top[".confirm__ghost li"], { "list-style": "none", "margin-left": "-18px" });
  assert.deepEqual(SHELL.top[".confirm__ghost li>span"], { display: "block", width: "80%", height: "12px", "border-radius": "6px", background: "var(--surface-3)" });
  assert.deepEqual(SHELL.top[".confirm--none"], { "box-shadow": "inset 0 0 0 1px var(--line-strong)" });
  assert.deepEqual(SHELL.top[".cslot"], { display: "grid", gap: "var(--space-3)", "min-width": "0" });
  assert.doesNotMatch(SHELL_CSS, /\.cs-/);
  // A bar's lines are a grid in bundle.css, whose track a line with no space in it (a pause window's JSON, an edit's
  // "to {...}") sized to its own width, pushing a 375 px page sideways: each line may shrink to its track and breaks
  // anywhere once a word is wider than the bar.
  assert.match(PULSE_CSS, /\n\.confirm__list \{ display: grid; gap: 4px; padding-left: 18px; list-style: disc;/);
  assert.deepEqual(SHELL.top[".confirm__list li"], { "min-width": "0", "overflow-wrap": "anywhere" });
  // The Undo line's icon stands at the top of its sentence, centred on the first line (bundle.css centres it on the whole
  // paragraph: a "No undo:" of three to five lines at 375 px had it floating beside the middle). The arithmetic is
  // bundle.css's: the line's height is the body's (the row sets a size, no height), the icon is the kit's small one.
  assert.match(PULSE_CSS, /\n\.confirm__undo \{ display: flex; align-items: center; gap: 8px; font-size: 13px; color: var\(--ink-muted\); \}/);
  assert.match(CONFIRM_VIEW_SOURCE, /<p class="confirm__undo">\$\{ui\.icon\("rerun", \{ size: "sm" \}\)\}<span>/, "the row is the small icon, then the sentence");
  const lineHeight = Number(/\nbody \{[^}]*line-height: (\d+)px;/.exec(PULSE_CSS)[1]);
  const icon = Number(/\n\.ic--sm \{ width: (\d+)px; height: \1px; \}/.exec(PULSE_CSS)[1]);
  assert.deepEqual(SHELL.top[".confirm__undo"], { "align-items": "flex-start" });
  assert.deepEqual(SHELL.top[".confirm__undo>.ic"], { "margin-top": `${(lineHeight - icon) / 2}px` });
  assert.equal(SHELL.top[".confirm__undo>.ic"]["margin-top"], "3px");
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

test("the legacy layer: a card per wrapper, the charts' own font, readable fields and table cells, and the phone's spacing", () => {
  // The sign-in pages left the layer (PR 2): no rule of it names their form any more.
  assert.doesNotMatch(LEGACY_CSS, /login-form/);
  // Each old panel is a wrapper of its own, a cell of main's grid, so the card has no margin: the grid's gap
  // spaces the cards, 16px (12px on a phone, main's own), what one wrapper's margins gave them.
  assert.deepEqual(LEGACY.top[".legacy>section[data-panel],.legacy>section.transcript-section"], { "max-width": "none", "min-width": "0", margin: "0", padding: "var(--space-5)", border: "0", "border-radius": "var(--radius-lg)", background: "var(--surface)" });
  assert.equal(LEGACY.top[".legacy>:last-child"], undefined, "no last-child margin to take back");
  assert.deepEqual([SHELL.top.main.gap, SHELL.media[PHONE].main.gap], ["var(--space-4)", "12px"]);
  // The charts keep the insights font their labels were sized for (label-fit-check.mjs measured cuts without it).
  assert.equal(INSIGHTS_CSS.match(/(?:^|\n)body\{[^}]*?font:([^;}]+)/)[1], LEGACY.top[".legacy svg"].font);
  assert.equal(LEGACY.top[".legacy"].font, "inherit", "the old panels' text takes the console's font");
  assert.equal(LEGACY.top[".legacy textarea,.legacy form.act textarea"]["font-weight"], "400", "a field's text is not its label's bold");
  assert.deepEqual(LEGACY.top[".legacy button[disabled]"], { opacity: ".45", cursor: "not-allowed" });
  const phone = LEGACY.media[PHONE];
  assert.deepEqual(phone[".legacy>section[data-panel],.legacy>section.transcript-section"], { padding: "var(--space-4)", "border-radius": "22px" });
  assert.deepEqual(phone[".legacy table.grid td:not([colspan]):not(:has(br))"], { "white-space": "nowrap" }, "a model or an id never breaks at its hyphens in a cell");
  assert.deepEqual([4, 6, 9].map((n) => phone[`.legacy table.grid:has(thead th:nth-child(${n}))`]["min-width"]), ["520px", "720px", "960px"]);
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

test("a command in a copy box wraps, everywhere the kit draws one, its one-line box as tall as bundle.css's", () => {
  // bundle.css keeps the command on one line and scrolls it inside its box: a box narrower than its command cut it.
  assert.match(PULSE_CSS, /\n\.cmd \{ min-width: 0; max-width: 100%; display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 4px 4px 4px 14px;/);
  assert.match(PULSE_CSS, /\n\.cmd code \{ flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; \}/);
  // The shell's override, unscoped, after the bundle: it wraps at spaces and anywhere in an argument with none, from the
  // box's top, the Copy button at its top right.
  assert.deepEqual(SHELL.top[".cmd"], { "align-items": "flex-start" });
  assert.deepEqual(SHELL.top[".cmd code"], { "white-space": "pre-wrap", "overflow-wrap": "anywhere", padding: "6px 0" });
  // Each argument a box of its own (kit.mjs cmd draws a span per argument): a line breaks between arguments, and inside
  // one only when it is wider than the box. As one text, Chrome broke after the dashes of `--name` (measured at 260 px,
  // with every word-break, line-break and hyphens value tried: none stops a break after a hyphen).
  assert.deepEqual(SHELL.top[".cmd code>span"], { display: "inline-block", "max-width": "100%" });
  assert.ok(CONSOLE_CSS.indexOf("\n.cmd code{white-space:pre-wrap") > CONSOLE_CSS.indexOf(PULSE_CSS) + PULSE_CSS.length - 1, "after the bundle, so it wins");
  // A one-line box keeps its 40 px: the box's 4 px, the code's 6 px and the body's 20 px line, top and bottom; the
  // text's middle (20 px) one pixel from the 30 px Copy button's (4 + 15).
  assert.match(PULSE_CSS, /\nbody \{[^}]*line-height: 20px;/);
  assert.match(PULSE_CSS, /\n\.btn--sm \{ height: 30px;/);
  assert.equal(4 + 6 + 20 + 6 + 4, 40);
  // Nothing on a page sets the code back to one line.
  for (const css of [pageCss(), LEGACY_CSS]) {
    for (const rules of [rulesOf(css).top, ...Object.values(rulesOf(css).media)]) {
      for (const [sel, d] of Object.entries(rules)) if (/\.cmd(?![\w-])/.test(sel)) assert.ok(!Object.keys(d).some((k) => k === "white-space" || k.startsWith("overflow")), sel);
    }
  }
});

test("the kept-still note keeps its space and its chip's padding inside a legacy panel, whose layer resets both", () => {
  // The legacy layer's reset (the insights page's `*`, confined): as heavy as a class, and later than the shell.
  assert.ok(LEGACY_CSS.includes("\n.legacy *{box-sizing:border-box;margin:0;padding:0}"));
  assert.deepEqual(SHELL.top[".held"], { display: "flex", "flex-wrap": "wrap", "align-items": "center", gap: "6px var(--space-3)" });
  assert.deepEqual(SHELL.top["section[data-panel]>.held"], { margin: "0 0 var(--space-3)" });
  // The chip's padding is bundle.css's own, said again where the reset would take it.
  assert.equal(SHELL.top[".held>.chip"].padding, /\n\.chip \{[^}]*padding: ([^;]+);/.exec(PULSE_CSS)[1]);
  for (const sel of ["section[data-panel]>.held", ".held>.chip"]) assert.ok(specificity(sel) > specificity(".legacy *"), `${sel} outweighs .legacy *`);
  // The script puts the note as the held panel's first child (script.mjs hold), the panel itself the section.
  assert.match(CONSOLE_SCRIPT, /el\.insertBefore\(copy, el\.firstChild\)/);
});

test("the audit log: the side card beside the log from 1600 px and under it below; the log's rows stacked up to 1119 px by bundle.css's own rules", () => {
  assert.deepEqual(AUDIT_LAYOUT, { stackMax: 1119, sideMin: 1600, atWidth: 110, whoMax: 100, kindMax: 120, targetMax: 160, reasonMin: 200 });
  assert.ok(Object.isFrozen(AUDIT_LAYOUT));
  const A = rulesOf(PAGE_CSS.audit);
  const SIDE = `@media (min-width: ${AUDIT_LAYOUT.sideMin}px)`;
  const STACK = `@media (max-width: ${AUDIT_LAYOUT.stackMax}px)`;
  assert.deepEqual(Object.keys(A.media), [SIDE, STACK, PHONE]);
  assert.deepEqual(A.media[SIDE], {
    main: { "grid-template-columns": "minmax(0,1fr) var(--side-w)", "align-items": "start" },
    "main>*": { "grid-column": "1/-1" },
    "main>#p-audit": { "grid-column": "1" },
    "main>#p-audit-about": { "grid-column": "2" },
  });
  // Nothing else gives main a second column: below sideMin it is the shell's one column, the side card under the log.
  for (const [where, rules] of [["top", A.top], ...Object.entries(A.media).filter(([m]) => m !== SIDE)]) assert.equal(rules.main?.["grid-template-columns"], undefined, where);
  // The arithmetic the breakpoints stand on (see AUDIT_LAYOUT): with every cell bounded, the table measured 1,040 px at its
  // narrowest in the macOS font and 1,052 px in DejaVu Sans, CI's, over the widest rows the console can write (a
  // seven-digit row, a 64-character name, a 40-character kind, a 200-character target, a damaged row). From
  // sideMin the log's card is the viewport less the page's 48 px of sides, the 16 px gap and --side-w; above stackMax,
  // with the side card under it, the viewport less the sides and a classic scrollbar's 15 px. Both hold the table, and
  // the card's own 1440 px would not (906 px), which is why the side card stands beside the log only from 1600.
  const sideW = Number(/(?:^|;)--side-w:(\d+)px/.exec(tokenCss())[1]);
  const table = 1052;
  assert.ok(1440 - 48 - 16 - sideW < table, "at the card's 1440 px the widest rows would not fit beside the side card");
  assert.ok(AUDIT_LAYOUT.sideMin - 48 - 16 - sideW >= table, "the log beside the side card holds the table");
  assert.ok(AUDIT_LAYOUT.stackMax + 1 - 48 - 15 >= table, "the first unstacked width holds the table");
  assert.ok(AUDIT_LAYOUT.stackMax > TOP_BAR.phoneMax && AUDIT_LAYOUT.stackMax < AUDIT_LAYOUT.sideMin);
  // The stacked rows are bundle.css's phone rules for `.tbl--stack`, every one and nothing else, read from the pasted
  // bundle (stackRules), then the rows' sides as the card's head pads them (space-5, space-4 on a phone).
  const phone = PULSE_CSS.slice(PULSE_CSS.indexOf("@media (max-width: 760px) {"));
  const bundleStack = phone.split("\n").filter((l) => /^\s+\.tbl--stack/.test(l)).map((l) => /^\s+(.*?) \{ (.*) \}$/.exec(l).slice(1));
  assert.equal(bundleStack.length, 11);
  assert.equal(stackRules(), bundleStack.map(([sel, body]) => `${sel}{${body}}`).join("\n"));
  assert.ok(PAGE_CSS.audit.includes(`\n${STACK}{${stackRules()}\n.tbl--stack tr{padding-left:var(--space-5);padding-right:var(--space-5)}\n`));
  // The row a link opened (`#seq-41`): its cells are tinted in the table, and a stacked row is tinted whole, its cells
  // left clear, so the mark is one block and not one per cell with the grid's gaps between (the patchwork at 375 px).
  // The cells' rule outweighs the table's by its place: the same weight, later in the sheet.
  assert.deepEqual(A.top[".tbl tbody tr:target td"], { background: "var(--running-tint)" });
  assert.deepEqual(A.media[STACK][".tbl--stack tbody tr:target"], { background: "var(--running-tint)" });
  assert.deepEqual(A.media[STACK][".tbl--stack tbody tr:target td"], { background: "transparent" });
  assert.ok(specificity(".tbl--stack tbody tr:target td") >= specificity(".tbl tbody tr:target td"));
  assert.ok(PAGE_CSS.audit.indexOf(".tbl--stack tbody tr:target td{") > PAGE_CSS.audit.indexOf(".tbl tbody tr:target td{"));
  // A stacked cell's label is inline before its value (bundle.css's `td[data-l]::before`), and an inline box's baseline
  // is its last line, so a time or a target that wraps is set by its first line instead: the label stays at its top,
  // not beside the ninth line of a long target.
  assert.match(stackRules(), /\.tbl--stack td\[data-l\]::before\{content: attr\(data-l\) " ";/);
  assert.deepEqual(A.media[STACK][".tbl--stack .au-at,.tbl--stack .au-tgt"], { "vertical-align": "top" });
  for (const box of [".au-at", ".au-tgt"]) assert.equal(A.top[box].display, "inline-block", `${box}: an inline box, whose baseline is its last line`);
  // A damaged row's sentence is as wide as its reason cell, so a file name in it breaks only where the cell ends (a cap
  // of its own broke "2026-10.jsonl" after "2026-" in a wide cell).
  assert.deepEqual(A.top[".au-dmg"], { display: "block", "font-size": "12px", "line-height": "17px", color: "var(--ink)", "white-space": "normal" });
  // The command a banner names is a word a box (panels/audit.mjs draws each word in its own span): a line breaks
  // between its words, and inside one only when it is wider than the line, never after the dash of "pi-".
  assert.deepEqual(A.top[".banner__s .code>span"], { display: "inline-block", "max-width": "100%" });
  // On a phone each filter select is as wide as its longest choice (and the row at most), wrapping to a row of its own
  // when two do not fit, so the choice it shows is never cut ("Outcome: refuse" at 375 px).
  assert.deepEqual(A.media[PHONE][".filterbar .select"], { flex: "1 1 auto", "min-width": "0" });
  // The bounded cells: the reason never narrower than its minimum; the time two lines in its width; a name,
  // a kind and a target at their own width up to their bound (max-content, so the table never squeezes one below it and
  // breaks "anonymous" mid-word), wrapping inside it past that. The time's width holds the date and the time with a whole-hour zone,
  // and not the date with the time, so the line breaks after the date in both fonts (measured at 13 px, macOS / DejaVu
  // Sans: "2026-10-08" 77 / 75.6, "01:58 UTC-10" 88.6 / 88.6, "2026-10-08 15:39" 116.8 / 117.2).
  assert.deepEqual(A.top[".au-why"], { display: "block", "min-width": `${AUDIT_LAYOUT.reasonMin}px` });
  assert.deepEqual(A.top[".au-at"], { display: "inline-block", width: `${AUDIT_LAYOUT.atWidth}px`, "white-space": "normal" });
  assert.ok(AUDIT_LAYOUT.atWidth >= 89 && AUDIT_LAYOUT.atWidth < 116);
  assert.deepEqual(A.top[".au-who"], { display: "inline-flex", "flex-direction": "column", width: "max-content", "max-width": `${AUDIT_LAYOUT.whoMax}px`, "line-height": "16px", "overflow-wrap": "anywhere" });
  assert.deepEqual(A.top[".au-kind"], { width: "max-content", "max-width": `${AUDIT_LAYOUT.kindMax}px`, "overflow-wrap": "anywhere" });
  assert.deepEqual(A.top[".au-tgt"], { display: "inline-block", width: "max-content", "max-width": `${AUDIT_LAYOUT.targetMax}px`, "white-space": "normal", "overflow-wrap": "anywhere" });
  // Every bound fits a phone's stacked row (the 375 px card less its sides), so a stacked row keeps them.
  for (const k of ["atWidth", "whoMax", "kindMax", "targetMax", "reasonMin"]) assert.ok(AUDIT_LAYOUT[k] <= 375 - 32 - 40, k);
  // The kind's bound outweighs bundle.css's own for the note it is drawn as (`.tbl .reason`'s 360 px).
  assert.match(PULSE_CSS, /\n\.tbl \.reason \{[^}]*max-width: 360px; \}/);
  assert.ok(specificity('body[data-page="audit"] .au-kind') > specificity(".tbl .reason"));
  assert.deepEqual(A.media[PHONE][".tbl--stack tr"], { "padding-left": "var(--space-4)", "padding-right": "var(--space-4)" });
  assert.match(PULSE_CSS, /\n\.card--flush > \.card__head \{ padding: var\(--space-5\) var\(--space-5\) 0; \}/);
  // The audit log's table is the one a stack rule can reach on this page (kit.tbl with stack: true).
  // stackRules reads only rules whose every selector is a stacked table's, and refuses a bundle with none.
  assert.equal(stackRules("@media (max-width: 760px) {\n.x { a: b; }\n.tbl--stack td, .x { c: d; }\n.tbl--stack tr { e: f; }\n}"), ".tbl--stack tr{e: f;}");
  assert.throws(() => stackRules(".tbl--stack tr { e: f; }"), /no phone block/);
  assert.throws(() => stackRules("@media (max-width: 760px) { .x { a: b; } }"), /stacks no table/);
  // The filter bar's selects are the 48 px pill, the caret centred in it; bundle.css's is 19 px down, the middle of
  // its own 42 px field.
  assert.match(PULSE_CSS, /\n\.input, \.select, \.textarea \{ width: 100%; height: 42px;/);
  assert.match(PULSE_CSS, /background-position: right 18px top 19px, right 13px top 19px;/);
  assert.equal(A.top[".filterbar .select"].height, "var(--control-h)");
  assert.equal(A.top[".filterbar .select"]["background-position"], "right 18px center,right 13px center");
  // At the console's browser floor (Chrome 88, Safari 14, Firefox 78): no container query and no :has() in the page's
  // layout, whose rules a browser that does not know them would drop.
  assert.doesNotMatch(PAGE_CSS.audit, /@container|:has\(/);
});
