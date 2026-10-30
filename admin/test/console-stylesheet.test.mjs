import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { specificity } from "./helpers/css-specificity.mjs";
import { TRIGGERS_CSS } from "../src/console/triggers-css.mjs";
import { CONFIG_CSS } from "../src/console/config-css.mjs";
import { AUDIT_LAYOUT, OVERVIEW_LAYOUT, PAGE_CSS, SECONDARY_BTN, SHELL_CSS, TOP_BAR, cssBlocks, pageCss, scopeCss, selectorsOf, splitSelectors, stackRules } from "../src/console/page-css.mjs";
import { PULSE_CSS, PULSE_CSS_SHA256 } from "../src/console/pulse-css.mjs";
import { PULSE_TOKENS, PULSE_TOKENS_SHA256, colorOf, tokenCss } from "../src/console/pulse-tokens.mjs";
import { renderPage } from "../src/console/pages.mjs";
import { SPRITE } from "../src/console/pulse-icons.mjs";
import { BTN_KINDS, SPEND_DOTS } from "../src/console/kit.mjs";
import { CONFIRM_CLASSES } from "../src/console/confirm-view.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { LIVE_GLYPHS, LIVE_STATES } from "../src/console/shell.mjs";
import { CONSOLE_CSS } from "../src/console/style.mjs";
import { RUNS_CSS, RUNS_PHONE_MAX, RUNS_TABLE } from "../src/console/runs-css.mjs";
import { PARKED_CSS, PARKED_LAYOUT, PARKED_PHONE_MAX, QCARD_CSS } from "../src/console/parked-css.mjs";

// The console's one stylesheet (issue #737): the design's tokens and bundle.css, pinned to the design files by hash, the
// shell's own rules and page rules. The last converted configuration screen retires the compatibility layer (#750).

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Every custom property a stylesheet DECLARES (`--x:`), and every one it READS (`var(--x`, fallbacks included). */
const declared = (css) => new Set([...css.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)].map((m) => m[1]));
const read = (css) => new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));

/** `css`'s declarations with every attribute selector's value dropped, so a `[fill="#58a6ff"]` is not a colour. */
const declarationsOf = (css) => cssBlocks(css).flatMap(({ prelude, body }) => (prelude.startsWith("@") ? declarationsOf(body) : [body]));

test("bundle.css and tokens.json are pasted verbatim: each module's text hashes to the design file's", () => {
  assert.equal(PULSE_CSS_SHA256, "acd9426272c7960005ae17e7fdcbf636b8d7dd758f300b92841997ab9db10134", "the pin is the file's, measured when it was pasted");
  assert.equal(sha256(PULSE_CSS), PULSE_CSS_SHA256, "PULSE_CSS is bundle.css, every byte");
  assert.equal(PULSE_TOKENS_SHA256, "23a272327010840ed86e4138c3d2c904831b7a33a24d7a9dcb67a58cb1c1c868");
  assert.equal(sha256(JSON.stringify(PULSE_TOKENS, null, 1)), PULSE_TOKENS_SHA256, "PULSE_TOKENS is tokens.json, every value");
});

test("the stylesheet is the tokens, then bundle.css, the shell and pages, and it fetches nothing", () => {
  assert.equal(CONSOLE_CSS, [tokenCss(), PULSE_CSS, SHELL_CSS, pageCss(), CONFIG_CSS, TRIGGERS_CSS].join("\n"));
  assert.ok(CONSOLE_CSS.startsWith(tokenCss()), "the tokens come first, so every later rule reads them");
  assert.ok(CONSOLE_CSS.indexOf(PULSE_CSS) > tokenCss().length - 1, "bundle.css after the tokens");
  assert.ok(CONSOLE_CSS.endsWith(TRIGGERS_CSS), "the triggers rules follow the configuration, bundle and shell");
  assert.doesNotMatch(CONSOLE_CSS, /--pd-|\.legacy/);
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
  for (const name of read(CONFIG_CSS + TRIGGERS_CSS)) assert.ok(tokens.has(name) || own.has(name), `CONFIG_CSS reads ${name}, which is defined`);
  assert.doesNotMatch(CONSOLE_CSS, /--pd-/);

});

test("the shell and configuration declarations hold no colour literal: every colour is a token", () => {
  for (const [label, css] of [["SHELL_CSS", SHELL_CSS], ["CONFIG_CSS", CONFIG_CSS], ["TRIGGERS_CSS", TRIGGERS_CSS]]) {
    for (const body of declarationsOf(css)) assert.ok(!/#[0-9a-f]{3,8}\b/i.test(body), `${label}: ${body} names a colour by hex`);
  }
  assert.match(SHELL_CSS, /(?:^|\n)section\[data-panel\]:empty\{display:none\}/, "an empty panel is still not drawn");
  assert.match(SHELL_CSS, /(?:^|\n)\[hidden\]:not\(\[data-theme-toggle\]\)\{display:none!important\}/, "hidden wins over a component's display (the Copy button), the theme button aside");
  assert.match(SHELL_CSS, /(?:^|\n)main:focus\{outline:none\}/, "main is the skip link's target");
  assert.match(SHELL_CSS, /details\.more>summary\{/, "the More menu");
});

test("PAGE_CSS holds the converted pages' rules (PR 2: sign-in, error, audit; PR 3: the overview; PR 4: runs, parked), each served only under its own body", () => {
  assert.ok(Object.isFrozen(PAGE_CSS));
  assert.deepEqual(Object.keys(PAGE_CSS), ["insights", "insights-budget-split", "insights-capacity", "insights-breakdown", "insights-flows", "login", "login-code", "error", "audit", "overview", "run", "runs", "parked", "fleet", "host", "venue"]);
  assert.equal(PAGE_CSS.runs, RUNS_CSS);
  assert.equal(PAGE_CSS.parked, PARKED_CSS);
  assert.equal(PAGE_CSS.login, PAGE_CSS["login-code"], "the two sign-in pages are one card's rules");
  // The audit log's viewer refusal draws the error card inside the signed-in frame, on the audit page's body.
  assert.ok(PAGE_CSS.audit.endsWith(PAGE_CSS.error), "the audit page carries the error card's rules too");
  const served = pageCss();
  assert.ok(CONSOLE_CSS.includes(served));
  for (const sel of selectorsOf(served)) assert.match(sel, /^body\[data-page="(?:insights(?:-budget-split|-capacity|-breakdown|-flows)?|login|login-code|error|audit|overview|run|runs|parked|fleet|host|venue)"\](?:$|[ >])/, sel);
  for (const name of Object.keys(PAGE_CSS)) assert.ok(served.includes(`body[data-page="${name}"] `), name);
  assert.equal(scopeCss('body[data-page="runs"]', ".x .y{color:var(--ink)}\nbody{gap:0}"), 'body[data-page="runs"] .x .y{color:var(--ink)}\nbody[data-page="runs"]{gap:0}');
});

test("the run-id 404's search is the ErrorPage card's: 420 px at most, on the inset's ground on the card, ringed when its field has the focus", () => {
  const E = rulesOf(PAGE_CSS.error);
  assert.deepEqual(E.top[".er-search"], { width: "420px", "max-width": "100%", "margin-top": "var(--space-2)" });
  assert.deepEqual(E.top[".er-search .search"], { background: "var(--surface-2)" });
  assert.deepEqual(E.top[".er-search .search:focus-within"], { outline: "2px solid var(--focus)", "outline-offset": "2px" });
  assert.match(PULSE_CSS, /\n\.search \{[^}]*background: var\(--surface\);/, "bundle.css grounds the pill on a card's own surface");
  assert.match(PULSE_CSS, /\n\.card \{ background: var\(--surface\);/);
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
const NAV_BREAK = `${DESKTOP} @media (max-width: 1059px)`;
const ONE_ROW = "@media (min-width: 1600px)";
const ONE_ROW_RO = "@media (min-width: 1760px)";
/** The bands the Search button is left off a desktop bar in: just past each width where the bar's end is tightest. */
const SEARCH_OFF_RO = `${DESKTOP} @media not all and (min-width: 817px)`;
const SEARCH_OFF = `${ONE_ROW} @media not all and (min-width: 1656px)`;
const SEARCH_OFF_ONE_ROW_RO = `${ONE_ROW_RO} @media not all and (min-width: 1816px)`;
const SHELL = rulesOf(SHELL_CSS);

/** The write flow's markup, as written (the Undo row's parts). */
const CONFIRM_VIEW_SOURCE = readFileSync(new URL("../src/console/confirm-view.mjs", import.meta.url), "utf8");

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
  assert.deepEqual(TOP_BAR, { phoneMax: 760, navBreakMax: 1059, oneRowMin: 1600, oneRowReadOnlyMin: 1760, searchRoom: 56 });
  assert.ok(Object.isFrozen(TOP_BAR));
  // The phone is bundle.css's own: its breakpoint, its scrolling row; above it bundle.css's navigation is no scroll box.
  assert.ok(PULSE_CSS.includes(`@media (max-width: ${TOP_BAR.phoneMax}px) {`));
  assert.match(PULSE_CSS, /@media \(max-width: 760px\) \{[^]*\.pillnav \{ order: 3; width: 100%; overflow-x: auto;/, "bundle.css's phone row");
  assert.match(PULSE_CSS, /\n\.pillnav \{ display: flex; gap: 6px; min-width: 0; \}\n/, "and nothing else in it scrolls");
  // Exactly these media blocks, each named from TOP_BAR: no rule keyed to anything the script changes.
  assert.deepEqual(Object.keys(SHELL.media), [DESKTOP, NAV_BREAK, ONE_ROW, ONE_ROW_RO, SEARCH_OFF_RO, SEARCH_OFF, SEARCH_OFF_ONE_ROW_RO, PHONE]);
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
    assert.equal(on[SEARCH_OFF_RO], w > TOP_BAR.phoneMax && w < TOP_BAR.phoneMax + 1 + TOP_BAR.searchRoom, `${w}px: a read-only bar just above a phone`);
    assert.equal(on[SEARCH_OFF], w >= TOP_BAR.oneRowMin && w < TOP_BAR.oneRowMin + TOP_BAR.searchRoom, `${w}px: just past one row`);
    assert.equal(on[SEARCH_OFF_ONE_ROW_RO], w >= TOP_BAR.oneRowReadOnlyMin && w < TOP_BAR.oneRowReadOnlyMin + TOP_BAR.searchRoom, `${w}px: just past one row, read-only`);
  }
});

test("above a phone the bar is a grid: the pi-dispatch pill and the end, then the navigation wrapping across the width; one row from 1600 (1760 read-only)", () => {
  assert.deepEqual(SHELL.media[DESKTOP], {
    ".top": { display: "grid", "grid-template-columns": "max-content minmax(0,1fr)", gap: "var(--space-3)" },
    ".top>.brandpill": { "grid-row": "1", "grid-column": "1" },
    ".top__end": { "grid-row": "1", "grid-column": "2", "min-width": "0", "margin-left": "0", "justify-content": "flex-end" },
    ".pillnav": { "grid-row": "2", "grid-column": "1/-1", "flex-wrap": "wrap" },
  });
  // Below 1060 the navigation breaks after its fourth pill whatever the Parked count says: a count that appears cannot
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

test("the Search button is left off a desktop bar for its own width past each place the end is tightest, and off a phone's", async () => {
  // Its room is its own size and the end's gap between parts, both tokens bundle.css reads.
  assert.match(PULSE_CSS, /\n\.roundbtn \{[^}]*width: var\(--control-h\); height: var\(--control-h\);/);
  assert.match(PULSE_CSS, /\n\.top__end \{[^}]*gap: var\(--space-2\);/);
  const px = (name) => Number(new RegExp(`--${name}:(\\d+)px`).exec(tokenCss())[1]);
  assert.equal(TOP_BAR.searchRoom, px("control-h") + px("space-2"));
  assert.deepEqual(SHELL.media[SEARCH_OFF_RO], { ".top--ro .top__search": { display: "none" } });
  assert.deepEqual(SHELL.media[SEARCH_OFF], { ".top:not(.top--ro) .top__search": { display: "none" } });
  assert.deepEqual(SHELL.media[SEARCH_OFF_ONE_ROW_RO], { ".top--ro .top__search": { display: "none" } });
  // On a phone bundle.css hides it in the bar's end, by the class the card gives it.
  assert.match(PULSE_CSS, /\n {2}\.top__end \.live, \.top__end \.who > span:first-child, \.top__end \.hide-phone \{ display: none; \}/);
  const page = String((await renderPage("fleet", { query: {}, session: { name: "ops", role: "operator" }, readOnly: true, data: { now: 0, env: {} }, theme: null })).html);
  assert.ok(page.includes('<div class="top__end"><a class="roundbtn hide-phone top__search" href="/runs#q"'), "the class these rules key on, in the bar's end");
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
  // var(--line)}`) on each panel's card; no opacity and no
  // filter anywhere on a stale page, so every word keeps its contrast and every button its look.
  const STALE = "main.stale section[data-panel] .card:not(.card--tint)";
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
  assert.ok(!/--stale-ring:/.test(pageCss()) && !/--stale-ring:/.test(CONFIG_CSS), "the ring is declared on the flat panels alone");
  assert.ok(contrast(colorOf("ink-faint", "light"), colorOf("canvas", "light")) < 4.5, "the faint ink alone would miss AA on the light canvas");
  for (const [label, css] of [["SHELL_CSS", SHELL_CSS], ["pageCss()", pageCss()], ["CONFIG_CSS", CONFIG_CSS]]) {
    for (const rules of [rulesOf(css).top, ...Object.values(rulesOf(css).media)]) {
      for (const [sel, d] of Object.entries(rules)) if (/stale/.test(sel)) assert.ok(!("opacity" in d) && !("filter" in d), `${label} ${sel}: no dimming of the ink`);
    }
  }
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
  // The bar breaks every name in it as the page does: its title, its Undo line and that line's sentence, and its note
  // shrink and break anywhere (bundle.css breaks none of them, and the Undo's sentence is a flex item, which shrinks
  // below its content only when told); Resume fleet's Undo naming two 64-character queues ran to 624 px at 375 px.
  for (const sel of [".confirm__h", ".confirm__undo"]) assert.equal(bundleRule(sel)["overflow-wrap"], undefined, sel);
  assert.doesNotMatch(PULSE_CSS, /\.confirm__note/);
  assert.deepEqual(SHELL.top[".confirm__h,.confirm__undo,.confirm__undo>span,.confirm__note"], { "min-width": "0", "overflow-wrap": "anywhere" });
  // A button's label in the bar wraps inside the button (Confirm's names what it changes, a long host's queue
  // included): bundle.css keeps a button on one line 38 px high, and the button grows down from that one line.
  assert.match(CONFIRM_VIEW_SOURCE, /<div class="confirm__act">\$\{actBtn\(/, "the bar's buttons are its act row's children");
  assert.equal(bundleRule(".btn")["white-space"], "nowrap");
  assert.equal(bundleRule(".btn").height, "38px");
  assert.deepEqual(SHELL.top[".confirm__act>.btn"], { "max-width": "100%", height: "auto", "min-height": "38px", "padding-top": `${(38 - lineHeight) / 2}px`, "padding-bottom": `${(38 - lineHeight) / 2}px`, "white-space": "normal", "overflow-wrap": "anywhere", "text-align": "center" });
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









/** A declaration's value with the space after each comma dropped, as the console writes them and the cards do not. */
const tightDecls = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.replace(/,\s+/g, ",")]));

/** bundle.css's one rule for `selector` (outside its phone block unless `phone`), as `{property: value}`. */
function bundleRule(selector, { phone = false } = {}) {
  const at = PULSE_CSS.indexOf("@media (max-width: 760px) {");
  const text = phone ? PULSE_CSS.slice(at) : PULSE_CSS.slice(0, at);
  const m = new RegExp(`(?:^|\\n|\\} )\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{ ([^}]*) \\}`).exec(text);
  assert.ok(m, `bundle.css has a rule for ${selector}`);
  return declsOf(m[1]);
}

test("the overview's page rules: the first run's checklist as SetupScreen writes it, the running label at full ink, the chip row, the widths below the cards'", () => {
  assert.deepEqual(OVERVIEW_LAYOUT, { stackMax: 1199 });
  assert.ok(Object.isFrozen(OVERVIEW_LAYOUT));
  const O = rulesOf(PAGE_CSS.overview);
  const STACK = `@media (max-width: ${OVERVIEW_LAYOUT.stackMax}px)`;
  assert.deepEqual(Object.keys(O.media), [STACK, PHONE]);
  // The SetupScreen card's own style block, every rule as it writes it (the space after a comma aside), su- names kept.
  const SETUP = `.su-prog { display: grid; gap: 10px; padding: var(--space-4) var(--space-5); margin-bottom: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.su-prog p { font-size: 14px; color: var(--ink-muted); }
.su-prog p b { color: var(--ink); }
.su-big { font-size: 40px; line-height: 44px; font-weight: 800; letter-spacing: -0.02em; margin-right: 4px; font-variant-numeric: tabular-nums; }
.su-bar { width: 100%; display: block; overflow: visible; }
.su-seg { fill: var(--tone); }
.su-seg--todo { fill: var(--surface-3); }
.su-steps { display: grid; gap: 8px; }
.su-step { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-4); padding: var(--space-4); border-radius: var(--radius-md); background: var(--surface-2); }
.su-step--done { background: transparent; box-shadow: inset 0 0 0 1px var(--line); }
.su-step__b { display: grid; gap: 8px; min-width: 0; }
.su-step__t { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 15px; font-weight: 700; }
.su-step__t .chip { margin-left: auto; }
.su-n { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: var(--surface); color: var(--ink-muted); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
.su-step--done .su-n { background: var(--surface-2); }
.su-step__s { font-size: 13px; line-height: 20px; color: var(--ink-muted); }
.su-step__s b { color: var(--ink); }
.su-step .cmd { background: var(--surface); }
.su-step--done .cmd { background: var(--surface-2); }
.su-alt { font-size: 12px; color: var(--ink-muted); }
.su-act { display: flex; gap: 8px; flex-wrap: wrap; }
.su-p { font-size: 13px; margin-bottom: var(--space-3); }
.su-empties { gap: 8px; }
.su-empties .collapsed { background: var(--surface-2); }
@media (max-width: 760px) { .su-step { grid-template-columns: minmax(0, 1fr); gap: 10px; } .su-step__t .chip { margin-left: 0; } }`;
  const card = rulesOf(SETUP);
  assert.equal(Object.keys(card.top).length, 24);
  for (const [sel, decls] of Object.entries(card.top)) assert.deepEqual(O.top[sel], tightDecls(decls), sel);
  for (const [sel, decls] of Object.entries(card.media[PHONE])) assert.deepEqual(O.media[PHONE][sel], tightDecls(decls), `phone ${sel}`);
  // The timeline at least as wide as bundle.css holds it on a phone, at every width: its labels are fitted to lanes at
  // that width, and its box scrolls inside the card at every width.
  assert.deepEqual(O.top[".tl-wrap .tl"], bundleRule(".tl-wrap .tl", { phone: true }));
  assert.deepEqual(O.top[".tl-wrap .tl"], { "min-width": "720px" });
  assert.equal(bundleRule(".tl-wrap")["overflow-x"], "auto");
  // A running pill's host in full ink (console-contrast.test.mjs measures why, and holds this rule to winning).
  assert.deepEqual(O.top[".tp-l--run .tp-sub"], { "fill-opacity": "1" });
  // The four KPI cards one height: the grid stretches each panel's section, and the card inside fills it.
  assert.deepEqual(O.top["main>.cards-4>section>.card"], { height: "100%" });
  // The project chips: links drawn as bundle.css draws the card's buttons (less a button's own border, ground and
  // cursor), the current one as its pressed one, and the row scrolling inside itself as bundle.css lets it on a phone.
  const { border, background, cursor, ...look } = bundleRule(".projseg button");
  assert.deepEqual([border, background, cursor], ["0", "transparent", "pointer"]);
  for (const [k, v] of Object.entries(look)) assert.equal(O.top[".projseg a"][k], v, `.projseg a ${k}`);
  assert.deepEqual(O.top[".projseg a b"], bundleRule(".projseg button b"));
  assert.deepEqual(O.top['.projseg a[aria-current="page"]'], bundleRule('.projseg [aria-pressed="true"]'));
  assert.deepEqual(O.top['.projseg a[aria-current="page"] b'], bundleRule('.projseg [aria-pressed="true"] b'));
  // Grounded on the inset, as the card's segmented controls beside it are: bundle.css grounds the row on the card's
  // own colour, for the title bar over the canvas; in a card it was invisible and its 16 px lead read as an indent.
  assert.equal(bundleRule(".projseg").background, "var(--surface)");
  assert.equal(bundleRule(".seg").background, "var(--surface-2)");
  // Above a phone the row wraps onto as many lines as its chips need (scrolling with no scrollbar, a 1440 px card showed
  // four and a half chips and left the rest to a trackpad), one line as high as bundle.css's row, its corners the card's
  // (a pill's on one line). On a phone it is one line that scrolls inside itself, as bundle.css draws it there.
  const controlH = Number(/(?:^|;)--control-h:(\d+)px/.exec(tokenCss())[1]);
  const chipH = Number(/^(\d+)px$/.exec(bundleRule(".projseg button").height)[1]);
  assert.equal(bundleRule(".projseg").height, "var(--control-h)");
  assert.equal(bundleRule(".projseg").display, "inline-flex");
  assert.deepEqual(O.top["#p-timeline .projseg"], { "max-width": "100%", height: "auto", "min-height": "var(--control-h)", "padding-top": `${(controlH - chipH) / 2}px`, "padding-bottom": `${(controlH - chipH) / 2}px`, "flex-wrap": "wrap", "border-radius": "var(--radius-lg)", background: "var(--surface-2)" });
  assert.ok(Number(/(?:^|;)--radius-lg:(\d+)px/.exec(tokenCss())[1]) >= controlH / 2, "one line's corners are a pill's");
  assert.deepEqual(bundleRule(".projseg", { phone: true }), { "max-width": "100%", "overflow-x": "auto", "scrollbar-width": "none", flex: "none" });
  assert.deepEqual(O.media[PHONE]["#p-timeline .projseg"], { "flex-wrap": "nowrap" });
  assert.deepEqual(O.top["#p-timeline .projseg::-webkit-scrollbar"], { display: "none" });
  // The "+N more" after the chips is one word that never wraps ("+10" over "more" at 375 px), a chip's padding clear.
  assert.deepEqual(O.top["#p-timeline .projseg>.muted"], { flex: "none", "white-space": "nowrap", padding: `0 ${/^0 (\d+px)$/.exec(bundleRule(".projseg button").padding)[1]}` });
  // The focus ring (bundle.css's 2 px outline 2 px out) of a chip at the row's end or edge stays inside the scroll box
  // on a phone: the row is control-h high around its 38 px chips and padded 5 px at its right.
  const ring = /\n:focus-visible \{ outline: (\d+)px solid var\(--focus\); outline-offset: (\d+)px; \}/.exec(PULSE_CSS).slice(1).map(Number);
  assert.match(bundleRule(".projseg").padding, /^0 5px 0 /);
  assert.ok((controlH - chipH) / 2 >= ring[0] + ring[1] && 5 >= ring[0] + ring[1]);
  // Below stackMax the two-column rows are one column and the KPI cards two to a row; on a phone one to a row again
  // (this page's rule outweighs bundle.css's), and the layout's wrappers 12 px apart, as main stands them apart there.
  assert.deepEqual(O.media[STACK], { "main>.cols": { "grid-template-columns": "minmax(0,1fr)" }, "main>.cards-4": { "grid-template-columns": "repeat(2,minmax(0,1fr))" } });
  assert.equal(O.media[PHONE]["main>.cards-4"]["grid-template-columns"], "minmax(0,1fr)");
  assert.ok(PAGE_CSS.overview.indexOf(PHONE) > PAGE_CSS.overview.indexOf(STACK), "the phone's rule comes later, at the same weight");
  const phoneGap = /\n {2}\.page \{[^}]*gap: (\d+px); \}/.exec(PULSE_CSS)[1];
  assert.equal(phoneGap, "12px");
  assert.equal(SHELL.media[PHONE].main.gap, phoneGap);
  assert.deepEqual(O.media[PHONE]["main>.cards-4,main>.cols,main>.cols>.stack"], { gap: phoneGap });
  // Above a phone the wrappers' gap is main's, bundle.css's card gap, so the confirm slot the script puts after the
  // KPI cards' grid stands one card gap under it, as between any two cards; nothing sets a margin of the slot's own.
  for (const w of [".cards-4", ".cols", ".stack"]) assert.equal(bundleRule(w).gap, SHELL.top.main.gap, w);
  for (const css of [SHELL_CSS, pageCss()]) {
    const { top, media } = rulesOf(css);
    for (const rules of [top, ...Object.values(media)]) for (const [sel, d] of Object.entries(rules)) if (/\.cslot(?![\w-])/.test(sel)) assert.ok(!Object.keys(d).some((k) => k.startsWith("margin")), sel);
  }
  assert.deepEqual(SHELL.top[".cslot"], { display: "grid", gap: "var(--space-3)", "min-width": "0" });
  // The arithmetic stackMax stands on (OVERVIEW_LAYOUT): the page's 24 px sides, the 16 px gaps, the cards' 20 px
  // padding, --side-w beside the timeline; Needs you's rows measured 188 to 205 px over the cards' sample.
  const sideW = Number(/(?:^|;)--side-w:(\d+)px/.exec(tokenCss())[1]);
  const kpiInside = (w) => (w - 48 - 3 * 16) / 4 - 40;
  assert.ok(kpiInside(OVERVIEW_LAYOUT.stackMax + 1) >= 205 && kpiInside(1024) < 205);
  assert.ok(OVERVIEW_LAYOUT.stackMax + 1 - 48 - 16 - sideW >= 600, "the timeline's column from stackMax");
  assert.ok(OVERVIEW_LAYOUT.stackMax > TOP_BAR.phoneMax);
  assert.doesNotMatch(PAGE_CSS.overview, /@container|:has\(/, "nothing past the browser floor in the overview's layout");
});

test("the overview's spacing: notes 6 px apart, a banner a row gap above what follows, a host note's glyph on its first line, a waitlist's notes and rows", () => {
  const O = rulesOf(PAGE_CSS.overview);
  // A card's sentences one under another, and one under the key row, 6 px apart: bundle.css gives a sentence no
  // margin, and the key row space above it alone.
  assert.ok(!Object.keys(bundleRule(".card__sub")).some((k) => k.startsWith("margin")));
  assert.ok(!Object.keys(bundleRule(".keyrow")).some((k) => k.startsWith("margin-bottom")));
  assert.deepEqual(O.top[".card>.card__sub+.card__sub,.card>.keyrow+.card__sub"], { "margin-top": "6px" });
  // A banner in a card stands one row gap above what follows it, as a card's rows stand above its sentences.
  assert.ok(!Object.keys(bundleRule(".banner")).some((k) => k.startsWith("margin")));
  assert.deepEqual(O.top[".card>.banner+*"], { "margin-top": "var(--space-3)" });
  // A card's sentence under its rows, its dots or its big numbers, one row gap below them (Needs you with no row drew its
  // notes on its big numbers' words).
  assert.ok(!Object.keys(bundleRule(".bigpair")).some((k) => k.startsWith("margin")));
  assert.deepEqual(O.top[".card>.rows+.card__sub,.card>.axis+.card__sub,.card>.bigpair+.card__sub"], { "margin-top": "var(--space-3)" });
  // A host's tinted note keeps its glyph beside its first line when it wraps (bundle.css centres it on the whole note),
  // centred on that line: bundle.css's 20 px line, its 14 px small glyph.
  assert.equal(bundleRule(".hostrow__x > span")["align-items"], "center");
  assert.deepEqual(O.top[".hostrow__x>.tinted"], { "align-items": "flex-start" });
  const line = Number(/^(\d+)px$/.exec(bundleRule("body")["line-height"])[1]);
  const glyph = Number(/^(\d+)px$/.exec(bundleRule(".ic--sm").height)[1]);
  assert.equal(bundleRule(".hostrow__x")["line-height"], undefined, "the note's line is the body's");
  assert.deepEqual(O.top[".hostrow__x>.tinted>.ic"], { "margin-top": `${(line - glyph) / 2}px` });
  // A waitlist's notes under its rows indented as bundle.css indents the rows, on a phone too.
  assert.deepEqual(O.top[".wl__g>.card__sub"], { "padding-left": bundleRule(".wl__l")["padding-left"] });
  assert.deepEqual(O.media[PHONE][".wl__g>.card__sub"], { "padding-left": bundleRule(".wl__l", { phone: true })["padding-left"] });
  // Above a phone a row's sentence keeps 10em beside the tag and the id, else it wraps under them with the action:
  // bundle.css gives it what is left (flex 1 from nothing), and beside a cron run's id that was about 50 px. An id
  // wider than the row breaks (bundle.css keeps a code span on one line) rather than pushing the row out of its card.
  assert.equal(bundleRule(".wl__t").flex, "1");
  assert.equal(bundleRule(".code")["white-space"], "nowrap");
  assert.deepEqual(O.top[".wl__l li"], { "flex-wrap": "wrap" });
  assert.deepEqual(O.top[".wl__l li>.wl__t"], { flex: "1 1 10em", "min-width": "0" });
  assert.deepEqual(O.top[".wl__l li>.code"], { "min-width": "0", "white-space": "normal", "overflow-wrap": "anywhere" });
  // On a phone a waitlist row wraps (bundle.css), and its sentence takes a line of its own under the tag, the id and
  // the action. The action is at the row's right at every width, on a line of its own too: the rule was the phone's
  // alone, and a wrapped action sat at the left above a phone.
  assert.deepEqual(bundleRule(".wl__l li", { phone: true }), { "flex-wrap": "wrap" });
  assert.deepEqual(O.media[PHONE][".wl__l li>.wl__t"], { flex: "1 1 100%", order: "2" });
  assert.deepEqual(O.top[".wl__l li>.btn,.wl__l li>.act"], { "margin-left": "auto" });
  assert.equal(O.media[PHONE][".wl__l li>.btn,.wl__l li>.act"], undefined, "one rule, not a phone's copy");
});

test("the overview's long names: a host's, a queue's and a doctor note's break, a timeline row's name is cut, and a phone's timeline opens at now", () => {
  const O = rulesOf(PAGE_CSS.overview);
  // Every name in running text breaks anywhere, in the code face too: a host row's name and notes, a waitlist row's
  // sentence (a host, a stray host queue, the job holding a slot, a wait check's profiles), a card's sentence
  // (Scheduled's trigger ids) and a first run's step (the host its worker step names). bundle.css breaks none of them
  // and keeps a code span on one line, so a 64-character host name pushed a phone's page sideways (the worker step's to
  // 584 px), and a stray queue's sentence a 375 px page to 568 px.
  assert.equal(bundleRule(".code")["white-space"], "nowrap");
  for (const sel of [".hostrow__n", ".hostrow__x", ".qp", ".wl__t", ".card__sub"]) assert.equal(bundleRule(sel)["overflow-wrap"], undefined, sel);
  assert.equal(O.top[".su-step__s"]["overflow-wrap"], undefined, "the step's own rule is its type");
  assert.deepEqual(O.top[".hostrow__n,.hostrow__x,.wl__t,.card__sub,.su-step__s"], { "overflow-wrap": "anywhere" });
  // A name is a box of its own, as wide as its line at most: it moves whole to the next line where it fits there, and
  // breaks only where it is longer than a line. As text, "nightly-tidy" broke after its dash at the end of a line.
  assert.deepEqual(O.top[".hostrow__x .code,.qp .code,.wl__t .code,.card__sub .code,.su-step__s .code"], { display: "inline-block", "max-width": "100%", "white-space": "normal", "overflow-wrap": "anywhere" });
  // A queue's pill breaks its name alone, never its counts' words: anywhere on the whole pill let its flex items shrink
  // below their words ("paus/ed", "delaye/d"). The counts go under a name too long for the line, and the pill, 30 px
  // high in bundle.css, grows with its lines and keeps that height for one.
  assert.deepEqual(O.top[".hostrow__n,.hostrow__x,.qp"], { "min-width": "0" });
  assert.equal(bundleRule(".qp").display, "inline-flex");
  for (const [sel, d] of Object.entries(O.top)) if (/(?:^|,)\.qp(?:,|$)/.test(sel)) assert.equal(d["overflow-wrap"], undefined, sel);
  // A card head's end group (the Hosts head: a pause chip, Pause fleet and Resume fleet) wraps within the head, which
  // bundle.css wraps, rather than running past a phone's edge in one line.
  assert.equal(bundleRule(".card__head .end")["flex-wrap"], undefined);
  assert.deepEqual(O.top[".card__head>.end"], { "flex-wrap": "wrap", "justify-content": "flex-end", "min-width": "0" });
  // A name too long for its line takes it, and what follows goes under it (the venues beside the name, a queue line's
  // counts beside its queue), rather than being squeezed a letter a line beside it; a tinted note does not wrap, so its
  // glyph stays beside its text.
  assert.deepEqual(O.top[".hostrow__n,.hostrow__x>span:not(.tinted)"], { "flex-wrap": "wrap" });
  assert.equal(bundleRule(".qp").height, "30px");
  const line = Number(/^(\d+)px$/.exec(bundleRule("body")["line-height"])[1]);
  assert.deepEqual(O.top[".qp"], { height: "auto", "min-height": "30px", "padding-top": `${(30 - line) / 2}px`, "padding-bottom": `${(30 - line) / 2}px`, "flex-wrap": "wrap" });
  // A card head's chip (the Hosts head's pause state) is as wide as the head's end group at most, its words wrapping
  // inside it, one line keeping bundle.css's 26 px: a chip wider than the card ran out of it on the left.
  assert.equal(bundleRule(".chip")["white-space"], "nowrap");
  assert.equal(bundleRule(".chip").height, "26px");
  const chipLine = Number(/^(\d+)px$/.exec(bundleRule("body")["line-height"])[1]);
  assert.deepEqual(O.top[".card__head>.end>.chip"], { "min-width": "0", "max-width": "100%", height: "auto", "min-height": "26px", "padding-top": `${(26 - chipLine) / 2}px`, "padding-bottom": `${(26 - chipLine) / 2}px`, "white-space": "normal", "overflow-wrap": "anywhere" });
  // A timeline row's name is cut with an ellipsis 8 px short of the heads' column (bundle.css keeps a tag on one line,
  // and a long one ran over the lane), its repositories broken where they must; the name is whole in its title.
  assert.equal(/^(\d+px) /.exec(bundleRule(".tl")["grid-template-columns"])?.[1], "124px");
  assert.equal(bundleRule(".ptag")["white-space"], "nowrap");
  assert.deepEqual(O.top[".tl__h>.ptag,.tl__h>.code"], { display: "block", "max-width": "calc(100% - 8px)", overflow: "hidden", "text-overflow": "ellipsis" });
  assert.deepEqual(O.top[".tl__h>.tl__repo"], { "max-width": "calc(100% - 8px)", "overflow-wrap": "anywhere" });
  // The sentence that counts the rows left out is a card's, after the scroll box (timeline.mjs), with no rule here.
  assert.equal(O.top[".tl__cut"], undefined);
  // On a phone the timeline's scroll box runs right to left, so it opens at its end, where now and what is in line
  // are; the timeline inside it is drawn left to right.
  assert.equal(bundleRule(".tl-wrap")["overflow-x"], "auto");
  assert.deepEqual(O.media[PHONE][".tl-wrap"], { direction: "rtl" });
  assert.deepEqual(O.media[PHONE][".tl-wrap>.tl"], { direction: "ltr" });
  assert.equal(O.top[".tl-wrap"], undefined, "above a phone it opens at its start, the row heads in view");
});

test("the overview's kit marks in the shell's rules: a stack column, slot dots that wrap, an hour a column, a write in a row, an empty headline", () => {
  // A stack is one column that may shrink, as main is, so a card's timeline (720 px on a phone) scrolls in its card.
  assert.deepEqual(SHELL.top[".stack"], { "grid-template-columns": "minmax(0,1fr)" });
  assert.equal(SHELL.top.main["grid-template-columns"], "minmax(0,1fr)");
  assert.deepEqual(bundleRule(".tl-wrap .tl", { phone: true }), { "min-width": "720px" });
  // Slot dots wrap; a host row's eight to a line (the width of eight of bundle.css's dots and their gaps); a KPI row's
  // with room above and below once they wrap, which a one-line row's 32 px still holds.
  assert.deepEqual(SHELL.top[".sls"], { "flex-wrap": "wrap" });
  const dot = Number(/^(\d+)px$/.exec(bundleRule(".sl").width)[1]);
  const gap = Number(/^(\d+)px$/.exec(bundleRule(".sls").gap)[1]);
  assert.deepEqual(SHELL.top[".hostrow>.sls,.rowpill>.sls"], { "max-width": `${8 * dot + 7 * gap}px` });
  assert.equal(SHELL.top[".hostrow>.sls,.rowpill>.sls"]["max-width"], "132px");
  assert.deepEqual(SHELL.top[".rowpill>.sls"], { padding: "6px 0" });
  assert.ok(dot + 2 * 6 <= Number(/^(\d+)px$/.exec(bundleRule(".rowpill")["min-height"])[1]), "a row of one line keeps the card's height");
  // The spend dots: as many columns as hours, each the others' width; a column's 7 dots fit bundle.css's fixed height.
  assert.equal(bundleRule(".sd")["grid-template-columns"], "repeat(16, 1fr)");
  assert.deepEqual(SHELL.top[".sd"], { "grid-template-columns": "none", "grid-auto-flow": "column", "grid-auto-columns": "minmax(0,1fr)" });
  const sdDot = Number(/^(\d+)px$/.exec(bundleRule(".sd__c i").height)[1]);
  const sdGap = Number(/^(\d+)px$/.exec(bundleRule(".sd__c").gap)[1]);
  assert.ok(SPEND_DOTS * sdDot + (SPEND_DOTS - 1) * sdGap <= Number(/^(\d+)px$/.exec(bundleRule(".sd").height)[1]));
  // A write as a row's action: at the row's right, its button the card's 24 px action pill (a round button keeps its own).
  assert.deepEqual(SHELL.top[".rowpill>form.act"], { "margin-left": "auto" });
  const act = bundleRule(".rowpill__act");
  assert.deepEqual(SHELL.top[".rowpill>form.act .btn:not(.btn--round)"], { height: act.height, padding: act.padding, "font-size": act["font-size"] });
  assert.equal(act.height, "24px");
  // In a row pill only a name gives way: an id or a host's name is cut with an ellipsis where the row is short of room;
  // its words, its slot dots, its tag, its end and its action keep their width. When the words and the dots shrank
  // with the name, a 64-character host squeezed "doctor fails" to "d…" and stacked its dots one to a line.
  assert.deepEqual(SHELL.top[".rowpill>.code,.rowpill>b"], { "min-width": "0", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" });
  assert.deepEqual(SHELL.top[".rowpill>span:not([class]),.rowpill>.sls"], { flex: "none" });
  assert.deepEqual(SHELL.top[".rowpill>span:not([class])"], { "white-space": "nowrap" });
  for (const [sel, d] of Object.entries(SHELL.top)) if (/\.rowpill>(?:span|\.sls)/.test(sel)) assert.equal(d["min-width"], undefined, sel);
  assert.equal(bundleRule(".ptag").flex, "none");
  assert.equal(bundleRule(".rowpill .end").flex, "none");
  // The headline's line is not drawn while its panel is empty (where :has() is known; elsewhere it costs a 4 px gap).
  assert.deepEqual(SHELL.top[".titlebar__sub:has(>[data-panel]:empty)"], { display: "none" });
  assert.equal(bundleRule(".titlebar__lead").gap, "4px");
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

// ---- the runs and parked pages' rules (PR 4) --------------------------------------------------------------------------------

/** What every page's own rules keep: they scope, name no colour by hex, and read only tokens and bundle.css's tone set. */
function pageRulesHold(label, css, page) {
  const scoped = scopeCss(`body[data-page="${page}"]`, css);
  for (const sel of selectorsOf(scoped)) assert.match(sel, new RegExp(`^body\\[data-page="${page}"\\](?:$|[ >])`), `${label}: ${sel}`);
  for (const body of declarationsOf(css)) assert.ok(!/#[0-9a-f]{3,8}\b/i.test(body), `${label}: ${body} names a colour by hex`);
  const tokens = declared(tokenCss());
  const tones = declared(PULSE_CSS);
  for (const name of read(css)) assert.ok(tokens.has(name) || tones.has(name), `${label} reads ${name}, a token or bundle.css's tone set`);
  assert.deepEqual([...declared(css)], [], `${label} declares no property of its own`);
}

test("the runs page's rules: the filter bar's pills, a chip row that scrolls inside itself on a phone, the summary strip, the day rows, the RunsPhone card's stacked rows", () => {
  assert.equal(RUNS_PHONE_MAX, TOP_BAR.phoneMax, "bundle.css's phone breakpoint, as the shell names it");
  pageRulesHold("RUNS_CSS", RUNS_CSS, "runs");
  const R = rulesOf(RUNS_CSS);
  const NARROW = `@media not all and (min-width: ${RUNS_TABLE.allMin}px)`;
  assert.deepEqual(Object.keys(R.media), [DESKTOP, NARROW, PHONE]);
  // Every part of a filter bar's row stands on its bottom edge, where a labelled list's pill ends, and Apply is the
  // controls' height: bundle.css centres the row and draws a button 38 px high, which stood 8 px above the lists' edge.
  assert.match(PULSE_CSS, /\n\.filterbar \{ display: flex; flex-wrap: wrap; gap: 8px; align-items: center; \}/);
  assert.match(PULSE_CSS, /\n\.btn \{[^}]*height: 38px;/);
  assert.match(PULSE_CSS, /\n\.field \{ display: grid; gap: 6px; min-width: 0; \}/, "a field's label stands above its control");
  assert.deepEqual(R.top[".filterbar"], { "align-items": "flex-end" });
  assert.deepEqual(R.top[".filterbar>.btn"], { height: "var(--control-h)" });
  // The filter bar: the search pill grows from the card's 320 px to its 420, ringed when its bare field has the focus
  // (bundle.css draws the field with no outline); a list is a pill of its own width that never passes the row.
  assert.match(PULSE_CSS, /\n\.search input \{ flex: 1; min-width: 0; border: 0; background: transparent; outline: 0; \}/);
  assert.deepEqual(R.top[".filterbar .search"], { flex: "1 1 320px", "max-width": "420px" });
  assert.deepEqual(R.top[".filterbar .search:focus-within"], { outline: "2px solid var(--focus)", "outline-offset": "2px" });
  assert.deepEqual(R.top[".filterbar>.field"], { flex: "0 1 auto", "min-width": "0", "max-width": "100%", "grid-template-columns": "minmax(0,1fr)" });
  assert.equal(R.top[".filterbar .select"]["min-width"], "0");
  assert.equal(R.top[".filterbar .select"]["max-width"], "100%");
  assert.deepEqual(R.media[PHONE][".filterbar>.field,.filterbar>.select"], { flex: "1 1 100%" });
  // bundle.css folds the bar on a phone by the class the script sets, all but the search and the toggle, and shows the
  // toggle there alone; this page adds nothing to that.
  assert.match(PULSE_CSS, /\n {2}\.filterbar--collapsible > :not\(\.filterbar__toggle\):not\(\.search\) \{ display: none; \}/);
  assert.match(PULSE_CSS, /\n\.filterbar__toggle \{ display: none; \}/);
  assert.ok(CONSOLE_SCRIPT.includes('bar.classList.add("filterbar--collapsible")'), "the script's class");
  // A chip row wraps above a phone, and on one is a line scrolling inside itself, padded for a focus ring; a chip whose
  // value is wider than the row breaks it above a phone.
  assert.deepEqual(R.top[".chiprow"], { display: "flex", "flex-wrap": "wrap", "align-items": "center", gap: "8px", "min-width": "0", "max-width": "100%" });
  assert.equal(R.top[".chiprow>.chip"]["overflow-wrap"], "anywhere");
  assert.equal(R.top[".chiprow>.chip>.code"]["overflow-wrap"], "anywhere");
  assert.deepEqual(R.media[PHONE][".chiprow"], { flex: "1 1 100%", "flex-wrap": "nowrap", "overflow-x": "auto", "scrollbar-width": "none", margin: "-4px", padding: "4px" });
  assert.deepEqual(R.media[PHONE][".chiprow>*"], { flex: "none" });
  // The summary strip: equal columns, four or more to a phone's card, an item marked off a phone not drawn there; a
  // label wraps between its icon and its words before it breaks a word, and a count breaks only where it is wider than
  // its column (break-word, which unlike anywhere keeps a word's width as the least the item takes); the idle tone's
  // count in ink, as the card writes it.
  assert.equal(R.top[".sumstrip"]["grid-template-columns"], "repeat(auto-fit,minmax(120px,1fr))");
  assert.equal(R.media[PHONE][".sumstrip"]["grid-template-columns"], "repeat(auto-fit,minmax(72px,1fr))");
  assert.ok(4 * 72 <= 375 - 2 * 16 - 2 * 16, "four columns of 72 px in a 375 px phone's card");
  assert.deepEqual(R.media[PHONE][".sumstrip>.hide-phone"], { display: "none" });
  assert.equal(R.top[".sumstrip__i>b"]["overflow-wrap"], "break-word");
  assert.equal(R.top[".sumstrip__i>span"]["flex-wrap"], "wrap");
  assert.equal(R.top[".sumstrip__i>span"]["overflow-wrap"], "break-word");
  assert.equal(R.media[PHONE][".sumstrip__i"].padding, "10px 6px");
  assert.equal(R.top[".sumstrip__i>b"]["min-width"], "0");
  assert.deepEqual(R.top[".sumstrip__i.tone-idle>b"], { color: "var(--ink)" });
  // A day row: a header across the table on the inset's ground, never sticky as bundle.css makes a column head.
  assert.match(PULSE_CSS, /\n\.tbl th \{ position: sticky; top: 0;/);
  assert.equal(R.top[".tbl .tbl-group>th"].position, "static");
  assert.equal(R.top[".tbl .tbl-group>th"].background, "var(--surface-2)");
  assert.deepEqual(R.media[PHONE][".tbl--stack tr.tbl-group"], { display: "block", padding: "0" });
  // The table on a desktop, as the RunsScreen card draws it: the outcome's sentence at least 240 px, every other cell
  // but the target's on one line (a model or a flow never breaks at its hyphens), and a value of no fixed length a box
  // of its own, as wide as the value up to its bound and broken inside itself past it, so a long one grows its own row
  // and widens no column past the bound: a job id in its code face up to 22 characters, which holds a forge delivery's
  // id in two lines, and a host, a flow or a model (`.val`) up to 20, which hold the card's values (`build3`,
  // `claude-sonnet-5-5`) on their line.
  const box = (ch) => ({ display: "inline-block", width: "max-content", "max-width": `${ch}ch`, "white-space": "normal", "overflow-wrap": "anywhere" });
  assert.deepEqual(R.media[DESKTOP], {
    ".tbl td.wide": { "min-width": "240px" },
    ".tbl td:not(.wide):not(.tgt)": { "white-space": "nowrap" },
    ".tbl .id .code": box(22),
    ".tbl .val": box(20),
  });
  assert.deepEqual(RUNS_TABLE, { allMin: 1440, idMaxCh: 22, valueMaxCh: 20 });
  assert.ok(Object.isFrozen(RUNS_TABLE));
  for (const id of ["gh-e9a0", "gh-a91e", "gh-2f6a"]) assert.ok(id.length <= RUNS_TABLE.idMaxCh, `${id} stands on one line`);
  // A forge delivery's id (`gh-` and a GUID, a re-run's `-r2` too) in two lines of the box.
  for (const id of ["gh-1b2c3d4e-5f60-4718-9a0b-c1d2e3f4a5b6", "gh-1b2c3d4e-5f60-4718-9a0b-c1d2e3f4a5b6-r2"]) assert.ok(id.length <= 2 * RUNS_TABLE.idMaxCh, `${id} in two lines`);
  for (const v of ["build3", "mini2", "openshell", "triage", "portfolio-manager", "claude-sonnet-5-5", "claude-haiku-5-5"]) assert.ok(v.length <= RUNS_TABLE.valueMaxCh, `${v} stands on one line`);
  // Below the RunsScreen card's own width the columns a phone leaves to the run page (the kit marks their heads and
  // cells hide-phone) are left out on a desktop too, so the table fits a 1,280 px window; on a phone bundle.css already
  // hides them in a stacked table.
  assert.deepEqual(R.media[NARROW], { ".tbl .hide-phone": { display: "none" } });
  assert.match(PULSE_CSS, /\n {2}\.tbl--stack \.hide-phone \{ display: none; \}/);
  // The RunsPhone card's stacked row, by the kit's cell flags: the id, then when it ended at the right; the outcome; the
  // target and its tag across the row; the host and the cost at the right.
  const order = Object.fromEntries(Object.entries(R.media[PHONE]).filter(([, d]) => d.order !== undefined).map(([sel, d]) => [sel, Number(d.order)]));
  assert.deepEqual(order, { ".tbl--stack td": 5, ".tbl--stack td.id": 1, ".tbl--stack td.when": 2, ".tbl--stack td.wide": 3, ".tbl--stack td.tgt": 4, ".tbl--stack td.num": 6 });
  assert.equal(R.media[PHONE][".tbl--stack td.tgt"]["grid-column"], "1/-1");
  assert.equal(R.media[PHONE][".tbl--stack td.when"]["text-align"], "right");
  assert.equal(R.media[PHONE][".tbl--stack td.num"]["text-align"], "right");
  // A cell shrinks below its content and breaks where it must; an id is a box of its own as wide as its line at most
  // (bundle.css keeps an id cell and the code face on one line).
  assert.match(PULSE_CSS, /\n\.tbl \.id \{ white-space: nowrap; \}/);
  assert.deepEqual(R.media[PHONE][".tbl--stack td"], { order: "5", "min-width": "0", "overflow-wrap": "anywhere" });
  assert.deepEqual(R.media[PHONE][".tbl--stack .id .code"], { display: "inline-block", "max-width": "100%", "white-space": "normal", "overflow-wrap": "anywhere", "vertical-align": "top" }, "on its line's top, by the row's first line");
  // The RunsPhone card labels the host and the cost alone: the kit writes no data-l for a column whose label is "",
  // so no rule here switches a label off.
  assert.ok(!RUNS_CSS.includes("data-l"), "no rule keyed to a phone label");
  // A filter pill that is a link draws no underline: bundle.css draws the pill for a button.
  assert.deepEqual(R.top["a.fpill"], { "text-decoration": "none" });
});

test("the parked page's rules: the question card wherever it is drawn, the ApprovalRequest frame's two columns, one below 1200 px", () => {
  assert.equal(PARKED_PHONE_MAX, TOP_BAR.phoneMax);
  assert.deepEqual(PARKED_LAYOUT, { stackMax: OVERVIEW_LAYOUT.stackMax }, "the overview's breakpoint for its two columns, for the same side column");
  assert.ok(Object.isFrozen(PARKED_LAYOUT));
  pageRulesHold("PARKED_CSS", PARKED_CSS, "parked");
  pageRulesHold("QCARD_CSS", QCARD_CSS, "run");
  assert.ok(PARKED_CSS.startsWith(QCARD_CSS), "the parked page serves the card's rules first");
  const Q = rulesOf(QCARD_CSS);
  assert.deepEqual(Object.keys(Q.media), [], "the card's rules hold at every width");
  // "<id> asks" gives way, its id breaking only when wider than its line; the wait keeps its width, in the parked ink.
  assert.deepEqual(Q.top[".qcard__top>b"], { flex: "1 1 auto", "min-width": "0", "overflow-wrap": "anywhere" });
  assert.deepEqual(Q.top[".qcard__top .code"], { display: "inline-block", "max-width": "100%", "font-size": "14px", "font-weight": "700", "white-space": "normal", "overflow-wrap": "anywhere" });
  assert.equal(Q.top[".qcard__wait"].flex, "none");
  assert.equal(Q.top[".qcard__wait"].color, "var(--parked-ink)");
  assert.deepEqual(Q.top[".qcard__meta>*"], { "min-width": "0", "overflow-wrap": "anywhere" });
  assert.equal(Q.top[".qcard__body"].background, "var(--parked-tint)");
  assert.equal(Q.top[".qform__act>.btn--answer"].flex, "1 1 auto");
  const P = rulesOf(PARKED_CSS);
  assert.deepEqual(Object.keys(P.media), [`@media (max-width: ${PARKED_LAYOUT.stackMax}px)`, PHONE]);
  assert.deepEqual(P.media[`@media (max-width: ${PARKED_LAYOUT.stackMax}px)`][".cols"], { "grid-template-columns": "minmax(0,1fr)" });
  // bundle.css's two columns, the side one --side-w, and one column on a phone.
  assert.match(PULSE_CSS, /\n\.cols \{ display: grid; grid-template-columns: minmax\(0, 1fr\) var\(--side-w\);/);
  assert.match(PULSE_CSS, /\n {2}\.cards-4, \.cards-3, \.cards-2, \.cols, \.cols--wide-side \{ grid-template-columns: minmax\(0, 1fr\); \}/);
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
  for (const css of [pageCss(), CONFIG_CSS]) {
    for (const rules of [rulesOf(css).top, ...Object.values(rulesOf(css).media)]) {
      for (const [sel, d] of Object.entries(rules)) if (/\.cmd(?![\w-])/.test(sel)) assert.ok(!Object.keys(d).some((k) => k === "white-space" || k.startsWith("overflow")), sel);
    }
  }
});

test("the kept-still note keeps its space and its chip padding inside a panel", () => {
  assert.deepEqual(SHELL.top[".held"], { display: "flex", "flex-wrap": "wrap", "align-items": "center", gap: "6px var(--space-3)" });
  assert.deepEqual(SHELL.top["section[data-panel]>.held"], { margin: "0 0 var(--space-3)" });
  // The chip's padding is bundle.css's own, said again where the reset would take it.
  assert.equal(SHELL.top[".held>.chip"].padding, /\n\.chip \{[^}]*padding: ([^;]+);/.exec(PULSE_CSS)[1]);
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


test("the plain-selector specificity helper weighs ids, classes, attributes, pseudo-classes and types independently", () => {
  const tuple = (n) => [Math.floor(n / 10000), Math.floor(n / 100) % 100, n % 100];
  assert.deepEqual(tuple(specificity("#a .b c")), [1, 1, 1]);
  assert.deepEqual(tuple(specificity("a[href]:hover")), [0, 2, 1]);
  assert.ok(specificity(".x") > specificity("a b c d e"));
  assert.ok(specificity(".tbl tbody tr:target td") > specificity(".tbl td"));
  for (const selector of [":is(.a,.b)", ":not(.a)", ":where(.a)", ":has(.a)", "a::before"]) assert.throws(() => specificity(selector), /not a plain selector/);
});
