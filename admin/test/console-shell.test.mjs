import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_PAGES, PAGES, panelIds, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { ICON_NAMES, SPRITE } from "../src/console/pulse-icons.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { confirmSlotHtml, doneBannerHtml, heldNoteHtml } from "../src/console/confirm-view.mjs";
import { forbiddenContent } from "../src/console/error-pages.mjs";
import { html } from "../src/console/html.mjs";
import { STREAMS_TOTAL_MAX } from "../src/console/server.mjs";
import { ENDED_REASONS, SIGN_IN_NOTICES, endedNotices } from "../src/console/session-ends.mjs";
import { LINK_NOTICES, LINK_STATES, LISTEN_FOOTERS, NO_SCRIPT_TEXT, linkContent, signInContent } from "../src/console/signin.mjs";
import { HEADLINE_ID, LINK_PAGE_TITLE, LIVE_GLYPHS, LIVE_NOTES, LIVE_STATES, LIVE_STREAMS_TOTAL, NAV, NAV_MORE, NAV_PARKED_ID, READ_ONLY_TITLE, SEARCH_HREF, SHELL_PANEL_IDS, frameHtml, legacyWrap, liveNoteHtml, loginCodePage, loginPage, navParkedCount, navParkedHtml, shellHtml } from "../src/console/shell.mjs";
import { RESERVED_IDS, SEARCH_ID } from "../src/console/kit.mjs";
import { SYSTEM_SCHEME, THEME_COOKIE, THEME_COOKIE_MAX_AGE_SEC, THEME_COOKIE_SAME_SITE, THEME_LABELS, THEMES } from "../src/console/theme.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";

/** What both sign-in pages say first without a script: the sentence, as one of the card's notices. */
const NO_SCRIPT = `<noscript><div class="banner banner--sm tone-attention" role="status"><span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-info"></use></svg></span><div><p class="banner__t">${NO_SCRIPT_TEXT}</p></div></div></noscript>`;

// The Pulse shell (issue #737, `shell.mjs`): the top bar, the navigation, the live pill, the theme button and the title
// bar every page is drawn in, and the browser script's side of them. Pure renders over hand-made page data; the goldens
// (`console-pages.test.mjs`) hold the same frame over the canned deployment.

// Control bytes are built, never typed.
const ESC = String.fromCharCode(27);
const HOSTILE = `<img src=x onerror=alert(1)>"'${ESC}`;
const ROLES = ["viewer", "operator"];

/** Page `name` drawn for `role` over `data` (empty by default: every panel says what it could not read). */
async function draw(name, { role = "operator", data = {}, readOnly = false, theme = null, sessionName = role === "operator" ? "ops" : "watcher", flash = null, maxStreams = 4, slot = undefined, query = null } = {}) {
  const q = query ?? parsePageQuery(name, name === "run" ? "id=gh-1" : "").query;
  const out = await renderPage(name, { query: q, session: { name: sessionName, role }, data: { now: 0, env: {}, ...data }, readOnly, theme, flash, maxStreams, slot });
  return { status: out.status, html: String(out.html) };
}

/** The `[start, end)` of each `.legacy` box in a page, its nested divs balanced. */
function boxSpans(html) {
  const spans = [];
  for (let at = html.indexOf('<div class="legacy">'); at !== -1; at = html.indexOf('<div class="legacy">', at + 1)) {
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = at;
    let depth = 0;
    for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        spans.push([at, m.index + m[0].length]);
        break;
      }
    }
  }
  return spans;
}

const count = (text, needle) => text.split(needle).length - 1;
const navOf = (page) => /<nav class="pillnav"[^>]*>([^]*?)<\/nav>/.exec(page)?.[1] ?? null;

test("the navigation is Overview, Runs, Parked, Fleet, Spend, Configuration, then More with Audit, and names every page that has a label", () => {
  assert.deepEqual(NAV, ["overview", "runs", "parked", "fleet", "insights", "config"]);
  assert.deepEqual(NAV_MORE, ["audit"]);
  assert.ok(Object.isFrozen(NAV) && Object.isFrozen(NAV_MORE));
  const labelled = Object.keys(PAGES).filter((n) => PAGES[n].nav !== null).sort();
  assert.deepEqual([...NAV, ...NAV_MORE].sort(), labelled, "NAV and NAV_MORE are exactly the pages with a nav label");
  assert.equal(new Set([...NAV, ...NAV_MORE]).size, NAV.length + NAV_MORE.length, "each once");
  assert.ok(NAV.every((n) => PAGES[n].auth === "viewer"), "the pills are every role's");
  assert.ok(NAV_MORE.every((n) => PAGES[n].auth === "operator"), "More holds what only an operator may open");
  for (const [name, p] of Object.entries(PAGES)) assert.ok(ICON_NAMES.includes(p.icon), `${name}'s icon ${p.icon} is in the sprite`);
});

test("every page, both roles: the pills in order, aria-current on the screen shown, More for an operator alone", async () => {
  for (const name of Object.keys(PAGES)) {
    for (const role of ROLES) {
      const { html } = await draw(name, { role });
      const nav = navOf(html);
      assert.ok(nav !== null, `${name}.${role} has the pill nav`);
      const hrefs = [...nav.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
      const want = [...NAV, ...(role === "operator" ? NAV_MORE : [])].map((n) => PAGES[n].path);
      assert.deepEqual(hrefs, want, `${name}.${role}: the links, in order`);
      assert.equal(nav.includes('<details class="more">'), role === "operator", `${name}.${role}: More is the operator's`);
      if (role === "viewer") assert.ok(!html.includes('href="/audit"'), `${name}: a viewer is never offered the audit log`);
      const current = [...nav.matchAll(/<a href="([^"]*)" aria-current="page">/g)].map((m) => m[1]);
      const here = name.startsWith("insights") ? "insights" : name === "run" ? "runs" : ["host", "venue"].includes(name) ? "fleet" : name === "watch" || name === "watch-board" ? "config" : name;
      if (PAGES[here].auth === "operator" && role !== "operator") assert.deepEqual(current, [], `${name}.${role}: the refused page has no pill to mark`);
      else assert.deepEqual(current, [PAGES[here].path], `${name}.${role}: the one current pill`);
    }
  }
  assert.match(navOf((await draw("audit")).html), /<details class="more"><summary aria-label="More: Audit" title="More"><svg class="ic" aria-hidden="true"><use href="#i-more"><\/use><\/svg><\/summary><div><a href="\/audit" aria-current="page">/);
});

test("every page, both roles: one h1, one sprite, a skip link to the focusable main, unique ids, and every icon resolves", async () => {
  const symbols = new Set([...String(SPRITE).matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  for (const name of Object.keys(PAGES)) {
    for (const role of ROLES) {
      for (const readOnly of [false, true]) {
        const key = `${name}.${role}${readOnly ? ".read-only" : ""}`;
        const { html } = await draw(name, { role, readOnly });
        assert.equal(count(html, "<h1"), 1, `${key}: one h1`);
        assert.equal(count(html, '<svg class="sprite"'), 1, `${key}: one sprite`);
        assert.ok(html.indexOf('<a class="skip" href="#main">Skip to content</a>') < html.indexOf("<header"), `${key}: the skip link comes first`);
        assert.equal(count(html, '<main id="main" tabindex="-1">'), 1, `${key}: its target, focusable`);
        const ids = [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
        assert.equal(new Set(ids).size, ids.length, `${key}: ids are unique (${ids.filter((id, i) => ids.indexOf(id) !== i)})`);
        for (const m of html.matchAll(/<use href="#([^"]+)"/g)) assert.ok(symbols.has(m[1]), `${key}: #${m[1]} is a symbol in the sprite`);
        assert.equal(count(html, "<header"), 1, `${key}: one top bar`);
        assert.equal(count(html, 'id="logout"'), 1, `${key}: sign-out`);
        assert.equal(html.includes('id="live-status"'), PAGES[name].live, `${key}: the live pill on a live page alone`);
        assert.equal(html.includes('<span class="chip tone-attention"><svg class="ic" aria-hidden="true"><use href="#i-shield"></use></svg>Read-only console</span>'), readOnly, `${key}: the read-only chip`);
      }
    }
  }
});

test("the Search button: a round link to the runs page's search field, first in the bar's end, on every page for both roles, off a phone", async () => {
  // The Shell card's round button, as a link (it opens a page; the card's is a placeholder `button`), with a title for
  // a pointer, `hide-phone` as the card draws it, and the class the shell's width rules name it by.
  const card = `<button class="roundbtn hide-phone" type="button" aria-label="Search runs"><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg></button>`;
  const want = card.replace(`<button `, `<a `).replace(`hide-phone"`, `hide-phone top__search"`).replace(` type="button"`, ` href="/runs#q"`).replace(`aria-label="Search runs">`, `aria-label="Search runs" title="Search runs">`).replace(`<use href="#i-search"/>`, `<use href="#i-search"></use>`).replace(`</button>`, `</a>`);
  assert.equal(SEARCH_HREF, `${PAGES.runs.path}#${SEARCH_ID}`, "the runs page's search field");
  assert.ok(SEARCH_ID === "q" && RESERVED_IDS.includes(SEARCH_ID), "an id the kit reserves for it");
  for (const name of Object.keys(PAGES)) {
    for (const role of ROLES) {
      for (const readOnly of [false, true]) {
        const { html: page } = await draw(name, { role, readOnly });
        assert.equal(count(page, want), 1, `${name}.${role}${readOnly ? ".read-only" : ""}: the Search button, once`);
        assert.ok(page.includes(`<div class="top__end">${want}`), `${name}.${role}: first in the bar's end, as the card draws it`);
      }
    }
  }
  // The error pages that keep the navigation keep it too, and the sign-in pages, with nobody signed in, have none.
  assert.ok(String(frameHtml({ name: "error", title: "Page not found", nav: true, session: { name: "ops", role: "viewer" } }, html``)).includes(want));
  assert.ok(!String(loginPage()).includes(SEARCH_HREF) && !String(loginCodePage()).includes(SEARCH_HREF));
});

test("frameHtml marks a screen's pill current only where the page stands for one, and only one the role may open", () => {
  const nav = (here, role = "operator") => navOf(String(frameHtml({ name: "error", title: "Run not found", nav: true, session: { name: "ops", role }, here }, html``)));
  assert.deepEqual([...nav("runs").matchAll(/<a href="([^"]*)" aria-current="page">/g)].map((m) => m[1]), ["/runs"]);
  assert.ok(!nav(null).includes('aria-current="page"'), "by default none");
  for (const bad of ["run", "nope", "__proto__"]) assert.ok(!nav(bad).includes('aria-current="page"'), `${bad}: not a screen in the navigation`);
  assert.ok(!nav("audit", "viewer").includes('aria-current="page"'), "not a page the role may open");
});

test("the title bar: the page's title, and the run detail's back link to Runs with the run named", async () => {
  assert.match((await draw("runs")).html, /<div class="titlebar"><div class="titlebar__lead"><h1>Runs<\/h1><\/div><\/div>/);
  // The overview's title has its headline under it (PR 3), a panel the stream fills; see the headline's own test.
  assert.match((await draw("overview")).html, /<div class="titlebar"><div class="titlebar__lead"><h1>Overview<\/h1><p class="titlebar__sub"><span id="p-headline" data-panel>[^<]*(?:<(?!\/span>)[^<]*)*<\/span><\/p><\/div><\/div>/);
  // A viewer refused the audit log: its title, the operators-only card, no wrapper, no audit panel, and no Reload to it.
  const refused = (await draw("audit", { role: "viewer" })).html;
  assert.match(refused, /<h1>Audit log<\/h1><\/div><\/div>\n/);
  assert.ok(refused.includes(String(forbiddenContent())), "the operators-only card");
  for (const absent of ['class="legacy"', 'id="p-audit', 'class="titlebar__end"', "Drawn at"]) assert.ok(!refused.includes(absent), absent);
  const run = (await draw("run")).html;
  assert.match(run, /<div class="titlebar__lead"><a class="back" href="\/runs"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-chev-l"><\/use><\/svg>Runs<\/a><h1>gh-1<\/h1><div class="titlebar__sub">/);
  for (const name of Object.keys(PAGES).filter((n) => !["run", "host", "venue"].includes(n))) assert.ok(!(await draw(name)).html.includes('class="back"'), `${name} has no back link`);
});

test("the headline: a panel span in the title bar's sub line, drawn for a page that has one, its id and data-panel alone", () => {
  assert.equal(HEADLINE_ID, "p-headline");
  assert.deepEqual(SHELL_PANEL_IDS, [NAV_PARKED_ID, HEADLINE_ID]);
  assert.ok(Object.isFrozen(SHELL_PANEL_IDS));
  const ctx = { session: { name: "ops", role: "operator" }, data: { now: 0, env: {} }, query: {} };
  const lead = (page) => /<div class="titlebar"><div class="titlebar__lead">([^]*?)<\/div>(?:<div class="titlebar__end">|<\/div>)/.exec(String(page))[1];
  assert.equal(lead(shellHtml("overview", ctx, html``, { headline: "All clear. 4 jobs running, nothing needs you." })), `<h1>Overview</h1><p class="titlebar__sub"><span id="p-headline" data-panel>All clear. 4 jobs running, nothing needs you.</span></p>`);
  assert.equal(lead(shellHtml("overview", ctx, html``, { headline: html`<b>1</b> question` })), `<h1>Overview</h1><p class="titlebar__sub"><span id="p-headline" data-panel><b>1</b> question</span></p>`, "a fragment as it is");
  // Empty, it is still drawn, for the stream to fill (the stylesheet hides the empty line); without one, no line.
  assert.equal(lead(shellHtml("overview", ctx, html``, { headline: html`` })), `<h1>Overview</h1><p class="titlebar__sub"><span id="p-headline" data-panel></span></p>`);
  assert.equal(lead(shellHtml("overview", ctx, html``)), "<h1>Overview</h1>");
  assert.equal(lead(shellHtml("overview", ctx, html``, { headline: null })), "<h1>Overview</h1>");
  // Text is escaped; the run detail keeps its back link before the title; a page drawn once keeps its end.
  const hostile = String(shellHtml("overview", ctx, html``, { headline: HOSTILE }));
  assert.ok(hostile.includes(`<span id="p-headline" data-panel>&lt;img src=x onerror=alert(1)&gt;&quot;&#39; </span>`), hostile.slice(0, 200));
  assert.match(String(shellHtml("run", { ...ctx, query: { id: "gh-1" } }, html``, { headline: "x" })), /<a class="back" href="\/runs">[^]*<\/a><h1>gh-1<\/h1><div class="titlebar__sub"><span id="p-headline" data-panel>x<\/span><\/div>/);
  assert.match(String(shellHtml("config", ctx, html``, { headline: "x" })), /<h1>Configuration<\/h1><p class="titlebar__sub"><span id="p-headline" data-panel>x<\/span><\/p><\/div><div class="titlebar__end">/);
  // One per page, its element carrying exactly its id and data-panel (a panel element is the stream's to swap).
  const page = String(shellHtml("overview", ctx, html``, { headline: "x" }));
  assert.equal(page.split('id="p-headline"').length - 1, 1);
  assert.deepEqual(Array.from(page.matchAll(/<span ([^>]*\bdata-panel\b[^>]*)>/g), (m) => m[1]), ['id="p-nav-parked" data-panel', 'id="p-headline" data-panel']);
});

test("the live pill: drawn not live until the script connects, its states the LiveStates card's words, every state's mark drawn once", async () => {
  assert.deepEqual(Object.fromEntries(Object.entries(LIVE_STATES).map(([k, v]) => [k, v.word])), { start: "Not live", on: "Live", retry: "Reconnecting", off: "Not live", out: "Signed out" });
  for (const s of Object.values(LIVE_STATES)) assert.match(s.cls, /^live(?: live--(?:retry|off))?(?: live--out)?$/);
  // Signed out is Not live's colours with the sign-out glyph for the dot: the pill holds both, the stylesheet shows one.
  assert.equal(LIVE_STATES.out.cls, "live live--off live--out");
  assert.deepEqual(Object.entries(LIVE_STATES).filter(([, v]) => v.cls.includes("live--out")).map(([k]) => k), ["out"]);
  // The dot and a glyph for each state that is not Live (a phone shows one mark, picked by the state's classes alone, so
  // the script never touches them): Reconnecting's retry arrow, Not live's stop square, Signed out's sign-out arrow.
  assert.deepEqual(LIVE_GLYPHS, { retry: "rerun", off: "cancel", out: "logout" });
  assert.ok(Object.isFrozen(LIVE_GLYPHS));
  for (const glyph of Object.values(LIVE_GLYPHS)) assert.ok(ICON_NAMES.includes(glyph), `${glyph} is in the sprite`);
  for (const state of Object.keys(LIVE_GLYPHS)) assert.ok(Object.values(LIVE_STATES).some((s) => s.cls.split(" ").includes(`live--${state}`)), `live__${state} is named for a state class`);
  const glyph = (state, name) => `<svg class="ic ic--sm live__${state}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  const pill = `<span id="live-status" class="live live--off" role="status" aria-live="polite" title="Not live until this page&#39;s script connects to the console&#39;s stream."><span class="dot"></span>${glyph("retry", "rerun")}${glyph("off", "cancel")}${glyph("out", "logout")}<span data-live-word>Not live</span></span>`;
  for (const name of Object.keys(PAGES)) {
    const { html } = await draw(name);
    assert.equal(count(html, pill), PAGES[name].live ? 1 : 0, `${name}: the pill, once, on a live page`);
  }
  // The script switches between the other four, written in from the same table.
  const { start: _first, ...switched } = LIVE_STATES;
  assert.ok(CONSOLE_SCRIPT.includes(`var LIVE = ${JSON.stringify(switched)};`));
  for (const state of ["on", "retry", "off", "out"]) assert.ok(CONSOLE_SCRIPT.includes(`mark("${state}")`), `the script marks ${state}`);
});

test("the theme button: hidden until the script shows it, named for the choice the page was drawn in", async () => {
  for (const theme of [null, ...THEMES]) {
    const label = THEME_LABELS[theme ?? "system"];
    const { html } = await draw("overview", { theme });
    assert.ok(html.includes(`<button class="roundbtn" type="button" data-theme-toggle hidden aria-label="${label}" title="${label}"><svg class="ic" aria-hidden="true"><use href="#i-theme"></use></svg></button>`), String(theme));
    assert.match(html, theme === null ? /<html lang="en">\n/ : new RegExp(`<html lang="en" data-theme="${theme}">\n`));
  }
  assert.deepEqual(THEME_LABELS, { system: "Theme: follows the system", light: "Theme: light", dark: "Theme: dark" });
  // A value that is not a theme draws the system's, never its own bytes, and a name every object inherits (review
  // mutant H7: a label looked up through the prototype) draws no label from Object.prototype.
  for (const odd of ["DARK", "system", HOSTILE, 7, {}, "constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
    const { html } = await draw("overview", { theme: odd });
    assert.match(html, /<html lang="en">\n/, String(odd));
    assert.ok(html.includes('aria-label="Theme: follows the system" title="Theme: follows the system"'), String(odd));
    assert.doesNotMatch(html, /native code|\[object Object\]/, `${String(odd)}: nothing of the prototype on the page`);
  }
});

test("who is signed in: the name and role, escaped, with two letters for the avatar; a hostile name is text", async () => {
  // The block's title holds both (an ellipsis cuts the longer of name and role first, and a phone shows the avatar alone).
  // data-name and data-role (issue #737): the session's own, for the script's same-person check before a reload.
  assert.match((await draw("overview", { role: "viewer" })).html, /<span class="who" data-name="watcher" data-role="viewer" title="watcher, Viewer"><span><b>watcher<\/b><small>Viewer<\/small><\/span><span class="avatar">wa<\/span><\/span>/);
  assert.match((await draw("overview")).html, /<span class="who" data-name="ops" data-role="operator" title="ops, Operator"><span><b>ops<\/b><small>Operator<\/small><\/span><span class="avatar">op<\/span><\/span>/);
  const { html } = await draw("overview", { sessionName: HOSTILE });
  assert.ok(!html.includes("<img src=x") && !html.includes(ESC), "no live markup and no control byte from the name");
  // The full name rides in the block's `title` too, escaped the same way, with the role after it.
  assert.match(html, /<span class="who" data-name="&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39; ?" data-role="operator" title="&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39; ?, Operator"><span><b>&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39; ?<\/b>/);
  assert.match(html, /<span class="avatar">im<\/span>/, "the avatar takes letters only");
  // Lower case, as the Shell card's "op" and "wa" (review mutant H8): a name's case says nothing about who it is.
  assert.match((await draw("overview", { sessionName: "Rob Boerman" })).html, /<span class="avatar">ro<\/span>/);
  assert.match((await draw("overview", { sessionName: "ÉLodie" })).html, /<span class="avatar">él<\/span>/, "any script's letters");
  assert.match((await draw("overview", { sessionName: "7Ops" })).html, /<span class="avatar">7o<\/span>/, "digits count as letters");
  assert.match((await draw("overview", { sessionName: "<>!" })).html, /<span class="avatar">-<\/span>/);
  // A role the console does not know names none, and opens no operator page.
  const odd = String((await renderPage("overview", { query: {}, session: { name: "x", role: "__proto__" }, data: { now: 0, env: {} } })).html);
  assert.match(odd, /<span class="who" title="x"><span><b>x<\/b><small>-<\/small>/, "and its title names no role");
  assert.ok(!odd.includes('href="/audit"'));
});

test("the Parked count: from the snapshot or the reader's count, drawn only when known and above zero, a panel the stream swaps", async () => {
  const parked = (n) => Array.from({ length: n }, (_, i) => ({ jobId: `gh-${i}`, target: `acme/web#${i}`, kind: "github" }));
  assert.equal(navParkedCount({ snapshot: { parked: parked(2), parkedUnreachable: null } }), 2);
  assert.equal(navParkedCount({ snapshot: { parked: parked(2), parkedUnreachable: "the run mirror could not be read" } }), null, "a partial list is not a count");
  assert.equal(navParkedCount({ snapshot: null }), null, "an unread snapshot is not zero");
  assert.equal(navParkedCount({ snapshot: {} }), null);
  // A page that read a snapshot takes its count from it, whatever else the data holds.
  assert.equal(navParkedCount({ snapshot: null, parkedCount: 4 }), null);
  assert.equal(navParkedCount({ parkedCount: 4 }), 4);
  for (const bad of [null, undefined, -1, 1.5, "3", Number.NaN]) assert.equal(navParkedCount({ parkedCount: bad }), null, String(bad));
  assert.equal(navParkedCount(null), null);
  // The number is shown and hidden from a screen reader, which reads the visually hidden sentence instead (review N14).
  const bubble = (shown, said) => `<span class="count tone-parked"><span aria-hidden="true">${shown}</span><span class="sr">${said}</span></span>`;
  assert.equal(String(navParkedHtml({ parkedCount: 3 })), bubble("3", "3 unanswered"));
  assert.equal(String(navParkedHtml({ parkedCount: 1204 })), bubble("1,204", "1204 unanswered"));
  assert.equal(String(navParkedHtml({ parkedCount: 0 })), "", "nobody waiting: no bubble");
  assert.equal(String(navParkedHtml({})), "", "unknown: no bubble, never a 0");

  const pill = (html) => /<a href="\/parked"[^>]*>([^]*?)<\/a>/.exec(html)?.[1];
  const icon = '<svg class="ic" aria-hidden="true"><use href="#i-parked"></use></svg>Parked';
  // A live page always holds the panel, so the stream can fill it; it is empty while the count is unknown.
  assert.equal(pill((await draw("overview", { data: { snapshot: { parked: parked(2), parkedUnreachable: null } } })).html), `${icon}<span id="p-nav-parked" data-panel>${bubble("2", "2 unanswered")}</span>`);
  assert.equal(pill((await draw("runs", { data: { parkedCount: null } })).html), `${icon}<span id="p-nav-parked" data-panel></span>`);
  assert.equal(pill((await draw("runs", { data: { parkedCount: 5 } })).html), `${icon}<span id="p-nav-parked" data-panel>${bubble("5", "5 unanswered")}</span>`);
  // A page drawn once has no stream: the panel only where there is a count to show.
  assert.equal(pill((await draw("insights", { data: { parkedCount: 5 } })).html), `${icon}<span id="p-nav-parked" data-panel>${bubble("5", "5 unanswered")}</span>`);
  assert.equal(pill((await draw("insights", { data: { parkedCount: null } })).html), icon);
  assert.equal(pill((await draw("config", { data: { snapshot: { parked: [], parkedUnreachable: null } } })).html), icon);
  // The stream's list: the page's panels first, then the count, on a live page only, and the same bytes as the page's.
  for (const name of Object.keys(PAGES)) {
    const ids = panelIds(name);
    assert.equal(ids.includes(NAV_PARKED_ID), PAGES[name].live, name);
    // The frame's panels (the Parked count, the overview's headline) are listed after the screen's own, so a screen's
    // first panel stays its first.
    const shell = ids.filter((id) => SHELL_PANEL_IDS.includes(id));
    assert.deepEqual(ids.slice(ids.length - shell.length), shell, `${name}: the frame's panels are listed last`);
    const ctx = { query: parsePageQuery(name, name === "run" ? "id=gh-1" : "").query, session: { name: "ops", role: "operator" }, data: { now: 0, env: {}, parkedCount: 3 } };
    const panels = await pagePanels(name, ctx);
    assert.deepEqual(panels.map((p) => p.id), ids, `${name}: pagePanels lists panelIds`);
    const page = String((await renderPage(name, ctx)).html);
    for (const p of panels) {
      const tag = SHELL_PANEL_IDS.includes(p.id) ? "span" : "section";
      assert.ok(page.includes(`<${tag} id="${p.id}" data-panel>${p.html}</${tag}>`), `${name}: ${p.id} is the page's own`);
    }
  }
  assert.throws(() => shellHtml("nope", {}, null), /no such page/);
});

test("LEGACY_PAGES is a written-out frozen list: a page added to PAGES later is not legacy by default", () => {
  // The list as written: a copy derived from PAGES would make every new page start in the old markup. PR 2
  // converted the audit log, the two sign-in pages and the operators-only refusal; PR 3 the overview; PR 4 the runs and
  // parked pages.
  assert.deepEqual(LEGACY_PAGES, ["config"]);
  assert.ok(Array.isArray(LEGACY_PAGES) && Object.isFrozen(LEGACY_PAGES), "an array, frozen: a frozen Set still takes .add()");
  assert.throws(() => LEGACY_PAGES.push("models"), TypeError);
  assert.equal(new Set(LEGACY_PAGES).size, LEGACY_PAGES.length);
  for (const name of LEGACY_PAGES) assert.ok(Object.hasOwn(PAGES, name), `${name} is a screen`);
  // A page PAGES does not hold is not legacy, however it is spelled; nor are the pages PR 2 and PR 3 converted.
  for (const name of ["overview", "audit", "login", "login-code", "forbidden", "error", "models", "watch", "secrets", "connections", "project", "host", "Overview", "", "__proto__", "constructor"]) assert.equal(LEGACY_PAGES.includes(name), false, name);
  assert.equal(String(legacyWrap("audit", html`<p>x</p>`)), "<p>x</p>", "a converted page's content is as it is");
  assert.equal(String(legacyWrap("overview", html`<p>x</p>`)), "<p>x</p>");
  assert.equal(String(legacyWrap("fleet", html`<p>x</p>`)), "<p>x</p>");
  assert.equal(String(legacyWrap("config", html`<p>x</p>`)), '<div class="legacy"><p>x</p></div>');
});

test("the legacy wrapper: each section of a legacy page in a .legacy of its own, the frame and the slot outside every one", async () => {
  for (const name of Object.keys(PAGES)) {
    for (const role of ROLES) {
      const { html } = await draw(name, { role });
      const key = `${name}.${role}`;
      const spans = boxSpans(html);
      const sections = [...html.matchAll(/<section id="(p-[a-z0-9-]+|transcript)"(?: data-panel| class="transcript-section")>/g)];
      if (!LEGACY_PAGES.includes(name)) {
        assert.deepEqual(spans, [], `${key}: converted, no wrapper`);
        continue;
      }
      assert.ok(sections.length > 0, `${key} has sections`);
      assert.equal(spans.length, sections.length, `${key}: one wrapper per section`);
      for (const [i, m] of sections.entries()) {
        const [a, b] = spans[i];
        assert.equal(m.index, a + '<div class="legacy">'.length, `${key}: ${m[1]} opens its own wrapper`);
        assert.equal(html.slice(b - "</section></div>".length, b), "</section></div>", `${key}: and closes it`);
      }
      assert.ok(html.indexOf("<h1") < spans[0][0], `${key}: the title bar is the shell's, outside them`);
      for (const needle of ['id="confirm-slot"', 'id="live-note"', '<template id="held-note">']) {
        const at = html.indexOf(needle);
        if (at !== -1) assert.ok(!spans.some(([a, b]) => at > a && at < b), `${key}: ${needle} is outside every wrapper`);
      }
    }
  }
});

test("the sign-in pages: the skip link to sign-in, the sprite, a top bar of the pill and the theme button alone, their card, the request's theme", () => {
  for (const [fn, name, title, panel] of [[loginPage, "login", "Sign in", "p-signin"], [loginCodePage, "login-code", LINK_PAGE_TITLE, "p-link"]]) {
    const plain = String(fn());
    const pill = `<a class="brandpill" href="/"><span class="brandpill__m" aria-hidden="true">pi</span>pi-dispatch</a>`;
    const toggle = (label) => `<button class="roundbtn" type="button" data-theme-toggle hidden aria-label="${label}" title="${label}"><svg class="ic" aria-hidden="true"><use href="#i-theme"></use></svg></button>`;
    // No title bar: the card's own heading leads the page, and the page's h1 is there for a screen reader.
    // The card opens with what a page without a script says (signin.mjs: the noscript is its first child).
    assert.ok(plain.includes(`<body data-page="${name}">\n<a class="skip" href="#main">Skip to sign-in</a>\n${String(SPRITE)}\n<div class="page">\n<header class="top">${pill}<div class="top__end">${toggle(THEME_LABELS.system)}</div></header>\n<main id="main" tabindex="-1">\n<h1 class="sr">${title}</h1>\n<section id="${panel}" data-panel><div class="card signin">\n${NO_SCRIPT}\n`), name);
    assert.ok(plain.includes(`<title>pi-dispatch console: ${title}</title>`), name);
    assert.match(plain, /<html lang="en">\n[^]*<meta name="color-scheme" content="light dark">/);
    // Nobody is signed in: no navigation, no live pill, no who, no sign-out, no wrapper, no slot.
    for (const absent of ["pillnav", 'id="live-status"', 'class="who"', 'id="logout"', 'class="legacy"', 'id="confirm-slot"', 'class="titlebar"']) assert.ok(!plain.includes(absent), `${name}: no ${absent}`);
    assert.equal(count(plain, "<h1"), 1);
    assert.equal(count(plain, '<svg class="sprite"'), 1);
    assertClean(name, plain);
    for (const theme of THEMES) {
      const themed = String(fn({ theme }));
      assert.match(themed, new RegExp(`<html lang="en" data-theme="${theme}">\n[^]*<meta name="color-scheme" content="${theme}">`), `${name} ${theme}`);
      assert.ok(themed.includes(toggle(THEME_LABELS[theme])), `${name} ${theme}: the button names the theme the page was drawn in`);
    }
    for (const odd of [HOSTILE, "constructor", "__proto__", "toString"]) {
      const page = String(fn({ theme: odd }));
      assert.match(page, /<html lang="en">\n[^]*<meta name="color-scheme" content="light dark">/, `${String(odd)}: a value that is not a theme is the system's`);
      assert.doesNotMatch(page, /native code|\[object Object\]/, `${String(odd)}: nothing of the prototype on the page`);
    }
  }
  // What each page's script finds, by id, drawn by hand with the kit's classes (the kit refuses those ids).
  const login = String(loginPage());
  assert.ok(login.includes(`<form id="login-form" class="signin__form" autocomplete="off" hidden data-reveal><div class="field"><label for="token">Console token</label><input id="token" class="input input--code" name="token" type="password" autocomplete="off" spellcheck="false" required aria-describedby="notice"></div><button class="btn btn--primary btn--lg" type="submit">Sign in</button></form>`));
  assert.equal(count(login, 'id="notice"'), 1);
  assert.equal(count(String(loginCodePage()), 'id="notice"'), 1);
});

test("the sign-in card: one notice region holding every notice, hidden but the server's choice; the help with --link; the footer by the bind", () => {
  // The two lists share no name, so a value can only select one of them.
  assert.deepEqual(ENDED_REASONS.filter((r) => Object.hasOwn(SIGN_IN_NOTICES, r)), []);
  const keys = [...ENDED_REASONS.map((r) => `ended-${r}`), ...Object.keys(SIGN_IN_NOTICES)];
  const shown = (text) => [...text.matchAll(/<div data-notice="([a-z-]+)">/g)].map((m) => m[1]);
  const all = (text) => [...text.matchAll(/<div data-notice="([a-z-]+)"(?: hidden)?>/g)].map((m) => m[1]);
  for (const notice of [null, ...ENDED_REASONS, ...Object.keys(SIGN_IN_NOTICES)]) {
    const text = String(signInContent({ notice }));
    assert.deepEqual(all(text), keys, `${notice}: every notice, once, in order`);
    assert.deepEqual(shown(text), notice === null ? [] : [ENDED_REASONS.includes(notice) ? `ended-${notice}` : notice], `${notice}: only the chosen one shows`);
  }
  // A value that is no reason and no kind shows none, and its bytes are nowhere on the page.
  for (const odd of [HOSTILE, "IDLE", " idle", "ended-idle", "__proto__", "constructor", 7, {}]) {
    const text = String(signInContent({ notice: odd }));
    assert.deepEqual(shown(text), [], String(odd));
    assert.ok(!text.includes("<img src=x") && !text.includes(ESC));
  }
  // Each notice is the session-ends table's, the console's own limits in the ended ones.
  const n = endedNotices({ idleMinutes: 15, maxHours: 4 });
  const text = String(signInContent({ notice: "idle", limits: { idleMinutes: 15, maxHours: 4 } }));
  assert.ok(text.includes(`<div data-notice="ended-idle"><div class="banner banner--sm tone-idle" role="status"><span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-clock"></use></svg></span><div><p class="banner__t">${n.idle.title}</p><p class="banner__s">${n.idle.body}</p></div></div></div>`), text);
  assert.ok(text.includes("You were signed out after 15 minutes without a request") && text.includes("You were signed out after 4 hours"));
  for (const bad of [{ idleMinutes: 0 }, { idleMinutes: -1, maxHours: 1.5 }, { idleMinutes: "15" }, null]) {
    const t = String(signInContent({ limits: bad }));
    assert.ok(t.includes("after 60 minutes without a request") && t.includes("after 12 hours"), `${JSON.stringify(bad)}: the defaults, never a wrong limit`);
  }
  // The refusal the server words itself: its text is set by the script, into an empty element.
  assert.ok(text.includes('<div data-notice="other" hidden><div class="banner banner--sm tone-failed" role="status"><span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-failed"></use></svg></span><div><p class="banner__t">The console refused the sign-in</p><p class="banner__s"><span data-notice-text></span></p></div></div></div>'));
  // The help (the command that prints a link is --link; the name placeholder is quoted, as a shell reads it).
  assert.ok(text.includes(`<p class="muted">Make a link from pi. It works once, for 60 seconds:</p><div class="cmd"><code><span>/dispatch</span> <span>console</span> <span>--link</span></code><button class="btn btn--sm" type="button" data-copy hidden>Copy</button></div><p class="muted">Or make a token on the host:</p><div class="cmd"><code><span>pi-dispatch-console</span> <span>token</span> <span>add</span> <span>--name</span> <span>&#39;&lt;you&gt;&#39;</span> <span>--role</span> <span>operator</span></code>`));
  // Without a script the form and its lead-in are not drawn (signin.mjs); the script reveals the two of them.
  assert.ok(text.includes('<p class="muted" hidden data-reveal>Paste a console token, or open a one-time link from pi.</p>'));
  assert.equal(count(text, "data-reveal"), 2);
  // A command in a notice is in the code face; the other notice's text stays the script's, set as text.
  assert.ok(text.includes('<p class="banner__s">An operator should run <span class="code">pi-dispatch doctor</span> on the host.</p>'));
  assert.ok(!Object.values(SIGN_IN_NOTICES).some((n) => /`/.test(n.title)), "no title carries a code mark");
  // No token's prefix anywhere, so the leak canary holds on the sign-in page too; no placeholder at all.
  assert.ok(!/pdc_/.test(text) && !/placeholder=/.test(text));
  // The footer follows the bind: loopback, a unix socket, or nothing for a bind that may not be loopback.
  const foot = (listen) => /<p class="signin__foot faint">([^<]*)<\/p>/.exec(String(signInContent({ listen })))?.[1] ?? null;
  for (const host of ["127.0.0.1", "127.1.2.3", "::1"]) assert.equal(foot({ kind: "tcp", host, port: 4790 }), LISTEN_FOOTERS.loopback.replace("'", "&#39;"), host);
  assert.equal(foot({ kind: "unix", path: "/run/x.sock" }), LISTEN_FOOTERS.unix.replace("'", "&#39;"));
  for (const listen of [{ kind: "tcp", host: "0.0.0.0", port: 4790 }, { kind: "tcp", host: "192.168.1.2" }, { kind: "tcp" }, "public", null, undefined, {}, "nope", "TCP"]) assert.equal(foot(listen), null, JSON.stringify(listen));
  // The server's own words: "tcp" is a loopback TCP listener (it sends "public" for any other), "unix" a socket.
  for (const word of ["tcp", "loopback"]) assert.equal(foot(word), LISTEN_FOOTERS.loopback.replace("'", "&#39;"), word);
  assert.equal(foot("unix"), LISTEN_FOOTERS.unix.replace("'", "&#39;"));
  assert.ok(!String(signInContent({ listen: { kind: "unix", path: "/run/secret/x.sock" } })).includes("/run/secret"), "never the socket's path");
  // The page as the server draws it carries the reason it was given and the footer of its bind.
  const page = String(loginPage({ notice: "revoked", listen: { kind: "tcp", host: "127.0.0.1" } }));
  assert.deepEqual(shown(page), ["ended-revoked"]);
  assert.ok(page.includes(LISTEN_FOOTERS.loopback.replace("'", "&#39;")));
  assertClean("login.revoked", page);
});

test("the one-time link's card: each state drawn, only the chosen one for the script to reveal, its own notices, the commands for a new link", () => {
  assert.deepEqual(LINK_STATES, ["wait", "used", "nocode"]);
  // `*` the state the page opens in: drawn `hidden data-reveal`, so a page without a script shows no state.
  const states = (text) => [...text.matchAll(/<div class="signin__state" data-link-state="([a-z]+)"( hidden data-reveal| hidden)>/g)].map((m) => `${m[1]}${m[2] === " hidden" ? "" : "*"}`);
  for (const state of LINK_STATES) assert.deepEqual(states(String(linkContent({ state }))), LINK_STATES.map((s) => (s === state ? `${s}*` : s)), state);
  for (const odd of [HOSTILE, "USED", null, "__proto__"]) assert.deepEqual(states(String(linkContent({ state: odd }))), ["wait*", "used", "nocode"], String(odd));
  const text = String(linkContent());
  assert.equal(count(text, '<a class="link signin__alt" href="/login">Sign in with a token instead</a>'), 3, "every state offers the token form");
  assert.ok(text.includes("<h2>Signing in with a one-time link</h2><p class=\"muted\">This takes a moment. The link is taken out of your browser history first, so it cannot be used again from there.</p>"));
  // The used state's two ways to a new link, each led in by where it runs.
  assert.ok(text.includes('<p class="muted">A link works once, for 60 seconds. Ask for a new one on the host:</p><div class="cmd"><code><span>pi-dispatch-console</span> <span>link</span> <span>--name</span> <span>&#39;&lt;you&gt;&#39;</span></code><button class="btn btn--sm" type="button" data-copy hidden>Copy</button></div><p class="muted">Or in pi:</p><div class="cmd"><code><span>/dispatch</span> <span>console</span> <span>--link</span></code>'));
  assert.deepEqual([...text.matchAll(/<div data-notice="([a-z-]+)" hidden>/g)].map((m) => m[1]), [...LINK_NOTICES]);
  for (const k of LINK_NOTICES) assert.ok(Object.hasOwn(SIGN_IN_NOTICES, k), k);
  assert.ok(text.startsWith(`<section id="p-link" data-panel><div class="card signin">\n${NO_SCRIPT}\n`), "what a page without a script says, first");
  // A golden's notice (the server draws none): one of the link page's own, shown; anything else, none.
  const shownNotices = (t) => [...t.matchAll(/<div data-notice="([a-z-]+)">/g)].map((m) => m[1]);
  for (const k of LINK_NOTICES) assert.deepEqual(shownNotices(String(linkContent({ state: "used", notice: k }))), [k], k);
  for (const odd of ["wrong", "ended-idle", HOSTILE, "__proto__"]) assert.deepEqual(shownNotices(String(linkContent({ notice: odd }))), [], String(odd));
  assert.deepEqual(shownNotices(String(loginCodePage({ notice: "rate" }))), ["rate"]);
  assert.ok(!/pdc_/.test(text));
  assertClean("login-code", String(loginCodePage()));
  assert.deepEqual(states(String(loginCodePage({ state: "used" }))), ["wait", "used*", "nocode"]);
});

test("frameHtml: a page that is not a screen, with the sign-in bar, or the signed-in bar with no current pill and no live pill", () => {
  const inner = html`<section id="p-x" data-panel><p>body</p></section>`;
  const out = String(frameHtml({ name: "error", title: "Page not found" }, inner));
  assert.ok(out.includes('<body data-page="error">\n<a class="skip" href="#main">Skip to content</a>'));
  assert.ok(out.includes(`<main id="main" tabindex="-1">\n<div class="titlebar"><div class="titlebar__lead"><h1>Page not found</h1></div></div>\n<section id="p-x" data-panel>`));
  // The title bar's line under the title, escaped, and only where there is a title bar.
  assert.ok(String(frameHtml({ name: "error", title: "Page not found", sub: "Not <here>." }, inner)).includes('<h1>Page not found</h1><p class="titlebar__sub">Not &lt;here&gt;.</p></div></div>'));
  assert.ok(!String(frameHtml({ name: "error", title: "T", sub: "S", titleShown: false }, inner)).includes("titlebar__sub"));
  for (const none of [null, "", 7]) assert.ok(!String(frameHtml({ name: "error", title: "T", sub: none }, inner)).includes("titlebar__sub"), String(none));
  assert.ok(out.includes("<title>pi-dispatch console: Page not found</title>"));
  for (const absent of ["pillnav", 'id="logout"', 'class="who"', 'id="live-status"']) assert.ok(!out.includes(absent), absent);
  // nav without a session, or a session without nav: still the sign-in bar.
  assert.ok(!String(frameHtml({ name: "error", title: "t", nav: true }, inner)).includes("pillnav"));
  assert.ok(!String(frameHtml({ name: "error", title: "t", session: { name: "ops", role: "operator" } }, inner)).includes("pillnav"));
  for (const role of ROLES) {
    const signed = String(frameHtml({ name: "error", title: "Page not found", nav: true, session: { name: "ops", role }, readOnly: true, theme: "dark" }, inner));
    const nav = navOf(signed);
    assert.deepEqual([...nav.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]), [...NAV, ...(role === "operator" ? NAV_MORE : [])].map((n) => PAGES[n].path), role);
    assert.ok(!nav.includes("aria-current"), `${role}: this page is no screen, so no pill is current`);
    assert.ok(signed.includes('<header class="top top--ro">') && signed.includes("Read-only console") && signed.includes('id="logout"'));
    assert.ok(!signed.includes('id="live-status"') && !signed.includes('id="p-nav-parked"'), "no stream, no live pill, no count panel");
    assert.ok(signed.includes(`<span class="who" data-name="ops" data-role="${role}" title="ops, ${role === "operator" ? "Operator" : "Viewer"}">`));
    assert.match(signed, /<html lang="en" data-theme="dark">/);
  }
  // titleShown false: the h1 is for a screen reader, with no title bar; the skip link says where it goes.
  const bare = String(frameHtml({ name: "login", title: "Sign in", skip: "Skip to sign-in", titleShown: false }, inner));
  assert.ok(bare.includes('<a class="skip" href="#main">Skip to sign-in</a>') && bare.includes('<main id="main" tabindex="-1">\n<h1 class="sr">Sign in</h1>\n'));
  // Every value escaped.
  const hostile = String(frameHtml({ name: "error", title: HOSTILE, nav: true, session: { name: HOSTILE, role: "operator" } }, inner));
  assert.ok(!hostile.includes("<img src=x") && !hostile.includes(ESC));
});

test("a page drawn once says when, beside Reload to its own address; a live page has the live notes instead", async () => {
  const NOW = Date.UTC(2026, 9, 8, 15, 39, 8);
  for (const name of Object.keys(PAGES)) {
    const { html } = await draw(name, { data: { now: NOW } });
    const live = PAGES[name].live;
    assert.equal(html.includes('<div class="titlebar__end">'), !live, `${name}: drawn once says when`);
    assert.equal(count(html, 'id="live-note"'), live ? 1 : 0, `${name}: the notes on a live page`);
  }
  const reload = (q) => `<a class="btn btn--sm btn--ghost" href="${q}"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-rerun"></use></svg>Reload</a>`;
  const drawn = `<div class="titlebar__end"><span class="drawn"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-clock"></use></svg><span>Drawn at <time datetime="2026-10-08T15:39:08.000Z">15:39 UTC</time> \u00b7 not live</span></span>`;
  assert.ok((await draw("config", { data: { now: NOW } })).html.includes(`<h1>Configuration</h1></div>${drawn}${reload("/config")}</div></div>`));
  // Reload is the page's own address, with its query as the page parser writes it back.
  const insights = (await draw("insights", { data: { now: NOW }, query: parsePageQuery("insights", "range=7d").query })).html;
  assert.ok(insights.includes(reload("/insights?range=7d")), "the query kept");
  // No clock in the data: it says only that it is not live.
  assert.ok((await draw("audit", { data: { now: Number.NaN } })).html.includes('<span class="drawn"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-clock"></use></svg><span>Drawn once \u00b7 not live</span></span>'));
  // A viewer refused the audit log is not offered its address.
  assert.ok(!(await draw("audit", { role: "viewer", data: { now: NOW } })).html.includes('href="/audit"'));
});

test("the live notes: four, each hidden in its box, the limit's from the console's own numbers, the stale time the script's", () => {
  assert.deepEqual(Object.keys(LIVE_NOTES), ["retry", "limit", "out", "stale"]);
  assert.ok(Object.isFrozen(LIVE_NOTES) && Object.values(LIVE_NOTES).every(Object.isFrozen));
  assert.equal(LIVE_STREAMS_TOTAL, STREAMS_TOTAL_MAX, "the console's own stream limit, which the server imports this module before defining");
  const notes = String(liveNoteHtml({ maxStreams: 6, reload: "/runs?project=web" }));
  assert.ok(notes.startsWith('<div id="live-note" class="live-note" aria-live="polite"><div data-live-note="retry" hidden><div class="banner banner--sm tone-attention" role="status">'));
  assert.deepEqual([...notes.matchAll(/<div data-live-note="([a-z]+)" hidden>/g)].map((m) => m[1]), Object.keys(LIVE_NOTES), "each drawn hidden, in order");
  for (const [state, n] of Object.entries(LIVE_NOTES)) {
    assert.ok(notes.includes(`<use href="#i-${n.icon}"></use>`), `${state}: its icon`);
    if (state !== "limit") assert.ok(notes.includes(`<p class="banner__s">${n.body.replace(/'/g, "&#39;")}</p>`), `${state}: its sentence`);
  }
  assert.ok(notes.includes("One token may hold 6 live tabs, and the console 32 in all."), "the token's limit, as the console runs");
  assert.ok(notes.includes('<a class="btn btn--sm btn--primary" href="/runs?project=web">Reload</a>'), "the limit note's Reload, the page's own address");
  assert.ok(notes.includes('<p class="banner__t">Shown as last seen<span class="live-note__at"> at <time data-since></time></span></p>'), "the time is the script's to write");
  for (const bad of [null, 0, -1, 1.5, "4", Number.NaN]) {
    const t = String(liveNoteHtml({ maxStreams: bad }));
    assert.ok(t.includes("One token may hold only a few live tabs, and the console 32 in all.") && !t.includes("{maxStreams}"), `${String(bad)}: no wrong number`);
    assert.ok(!t.includes(">Reload<"), "no Reload without an address");
  }
});

test("the read-only banner on every page of a read-only console; the done banner once from the session's flash", async () => {
  const banner = `<div class="banner banner--sm tone-attention" role="status"><span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-shield"></use></svg></span><div><p class="banner__t">${READ_ONLY_TITLE}</p><p class="banner__s">It was started with <span class="code">PI_CONSOLE_READ_ONLY=1</span>, so every change is refused and no page shows a form. Operators still see reasons, transcripts and the audit log.</p></div></div>`;
  assert.equal(READ_ONLY_TITLE, "This console is read-only");
  const flash = { summary: "Paused the fleet", by: "ops", auditSeq: 41, count: 1, undo: "Resume it.", inverse: { action: "fleet-resume", body: {} }, kind: "fleet-pause", at: 0 };
  for (const name of Object.keys(PAGES)) {
    for (const role of ROLES) {
      for (const readOnly of [false, true]) {
        const { html } = await draw(name, { role, readOnly });
        assert.equal(count(html, banner), readOnly ? 1 : 0, `${name}.${role}.${readOnly}`);
        if (readOnly) assert.ok(html.indexOf(banner) > html.indexOf("<h1") && html.indexOf(banner) < html.indexOf('<section id="p-'), `${name}: under the title bar, above the panels`);
      }
    }
    const done = String(doneBannerHtml(flash));
    const { html } = await draw(name, { flash });
    assert.equal(count(html, done), 1, `${name}: the done banner, once`);
    assert.ok(html.indexOf(done) < html.indexOf('<section id="p-'), `${name}: above the panels`);
    assert.ok(!(await draw(name)).html.includes("Changed by"), `${name}: none without a flash`);
  }
  // The order: the read-only banner, then the done banner, then the live notes, then the panels.
  const both = (await draw("fleet", { readOnly: true, flash })).html;
  assert.ok(both.indexOf(banner) < both.indexOf(String(doneBannerHtml(flash))) && both.indexOf(String(doneBannerHtml(flash))) < both.indexOf('id="live-note"'));
});

test("the confirm slot for an operator on a console that takes changes, the held note's template on every live page for every role: once, after the content", async () => {
  const slot = String(confirmSlotHtml());
  const tpl = `<template id="held-note">${heldNoteHtml()}</template>`;
  for (const name of Object.keys(PAGES)) {
    for (const role of ROLES) {
      for (const readOnly of [false, true]) {
        const { status, html } = await draw(name, { role, readOnly });
        const shown = !(PAGES[name].auth === "operator" && role !== "operator");
        const writes = shown && role === "operator" && !readOnly;
        // A live page's panels can be held by a field in use (a viewer's runs filters, a read-only console's too), so
        // each says why it stands still; a page drawn once is never updated and holds nothing.
        const held = shown && PAGES[name].live;
        assert.equal(count(html, slot), writes ? 1 : 0, `${name}.${role}.${readOnly}: the slot`);
        assert.equal(count(html, tpl), held ? 1 : 0, `${name}.${role}.${readOnly}: the template (${status})`);
        const last = `${writes ? slot : ""}${held ? tpl : ""}`;
        if (last !== "") assert.ok(html.endsWith(`${last}\n</main>\n</div>\n</body>\n</html>\n`), `${name}.${role}.${readOnly}: last in main`);
      }
    }
    assert.ok(!(await draw(name, { slot: false })).html.includes('id="confirm-slot"'), `${name}: slot false keeps it off`);
  }
});

// ---- the script's side of the shell ---------------------------------------------------------------------------------

/** A stub element: attributes, `hidden`, listeners, and what it contains. */
function element(attrs = {}, extra = {}) {
  const listeners = new Map();
  return {
    attrs: { ...attrs },
    hidden: "hidden" in attrs,
    textContent: "",
    getAttribute(n) { return Object.hasOwn(this.attrs, n) ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    removeAttribute(n) { delete this.attrs[n]; },
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type, ev = {}) => listeners.get(type)?.(ev),
    listeners,
    ...extra,
  };
}

/** Run the console script on a stub of a signed-in, non-live page holding the shell's elements. */
function shellDom({ theme = null, clipboard = null, secure = true } = {}) {
  const root = element(theme === null ? {} : { "data-theme": theme });
  const meta = element({ name: "color-scheme", content: theme ?? SYSTEM_SCHEME });
  const toggle = element({ "data-theme-toggle": "", hidden: "" });
  const summary = element({}, { focus() { summary.focused = true; } });
  const inMenu = element();
  const more = element({}, { open: false, contains: (n) => n === more || n === summary || n === inMenu, querySelector: (s) => (s === "summary" ? summary : null) });
  const code = element();
  code.textContent = "pi-dispatch sandbox gh-1";
  const box = element({}, { querySelector: (s) => (s === "code" ? code : null) });
  const copy = element({ "data-copy": "", hidden: "" }, { closest: (s) => (s === ".cmd" ? box : null) });
  copy.textContent = "Copy";
  const cookies = [];
  const docListeners = new Map();
  const document = {
    documentElement: root,
    body: { getAttribute: (n) => (n === "data-page" ? "overview" : null) },
    getElementById: () => null,
    querySelector: (s) => ({ "[data-theme-toggle]": toggle, 'meta[name="color-scheme"]': meta, "details.more": more })[s] ?? null,
    querySelectorAll: (s) => (s === "button[data-copy][hidden]" ? [copy].filter((b) => b.hidden) : []),
    addEventListener: (type, fn) => docListeners.set(type, fn),
    activeElement: null,
  };
  Object.defineProperty(document, "cookie", { set: (v) => cookies.push(v), get: () => { throw new Error("the script never reads document.cookie"); } });
  const navigator = clipboard === null ? {} : { clipboard };
  const timers = [];
  new Function("document", "location", "history", "EventSource", "navigator", "isSecureContext", "setTimeout", CONSOLE_SCRIPT)(document, { hash: "", pathname: "/" }, { replaceState() {} }, undefined, navigator, secure, (fn) => timers.push(fn));
  return { root, meta, toggle, more, summary, inMenu, copy, cookies, document, docListeners, timers };
}

test("the script's theme button: shown, then system, light, dark, system, each written to <html>, the meta and the cookie", () => {
  const d = shellDom();
  assert.equal(d.toggle.hidden, false, "shown where the page can be re-themed");
  assert.equal(d.toggle.attrs["aria-label"], THEME_LABELS.system);
  const max = `Max-Age=${THEME_COOKIE_MAX_AGE_SEC}`;
  // Lax, not Strict (theme.mjs's header): the sign-in page and a one-time link's page, opened from a link on another site,
  // are drawn in the chosen theme too. No signed-in page is reached that way: the session cookie is Strict, so such a
  // link to a run page lands on sign-in.
  assert.equal(THEME_COOKIE_SAME_SITE, "Lax");
  const steps = [
    ["light", "light", `${THEME_COOKIE}=light; Path=/; ${max}; SameSite=Lax`],
    ["dark", "dark", `${THEME_COOKIE}=dark; Path=/; ${max}; SameSite=Lax`],
    [null, SYSTEM_SCHEME, `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`],
    ["light", "light", `${THEME_COOKIE}=light; Path=/; ${max}; SameSite=Lax`],
  ];
  for (const [i, [attr, scheme, cookie]] of steps.entries()) {
    d.toggle.fire("click");
    assert.equal(d.root.getAttribute("data-theme"), attr, `click ${i + 1}: data-theme`);
    assert.equal(d.meta.attrs.content, scheme, `click ${i + 1}: color-scheme`);
    assert.equal(d.cookies.at(-1), cookie, `click ${i + 1}: the cookie`);
    assert.equal(d.toggle.attrs["aria-label"], THEME_LABELS[attr ?? "system"]);
    assert.equal(d.toggle.attrs.title, THEME_LABELS[attr ?? "system"]);
  }
  assert.equal(THEME_COOKIE_MAX_AGE_SEC, 365 * 24 * 60 * 60, "a year");
  // A page the server drew dark goes on to the system, and a hand-edited attribute reads as the system's.
  const dark = shellDom({ theme: "dark" });
  assert.equal(dark.toggle.attrs["aria-label"], THEME_LABELS.dark);
  dark.toggle.fire("click");
  assert.equal(dark.root.getAttribute("data-theme"), null);
  const odd = shellDom({ theme: "constructor" });
  assert.equal(odd.toggle.attrs["aria-label"], THEME_LABELS.system);
});

test("the script closes the More menu on Escape (focus back on its button) and on a click outside it", () => {
  const d = shellDom();
  d.more.open = true;
  d.document.activeElement = d.inMenu;
  d.docListeners.get("keydown")({ key: "Enter" });
  assert.equal(d.more.open, true, "only Escape");
  d.docListeners.get("keydown")({ key: "Escape" });
  assert.equal(d.more.open, false);
  assert.equal(d.summary.focused, true, "the keyboard keeps its place");
  d.more.open = true;
  d.docListeners.get("click")({ target: d.inMenu });
  assert.equal(d.more.open, true, "a click inside is the menu's own");
  d.docListeners.get("click")({ target: element() });
  assert.equal(d.more.open, false);
});

test("the script shows a Copy button only with a clipboard in a secure context, and copies its box's code", async () => {
  assert.equal(shellDom().copy.hidden, true, "no clipboard: stays hidden");
  const written = [];
  const clipboard = { writeText: async (t) => written.push(t) };
  assert.equal(shellDom({ clipboard, secure: false }).copy.hidden, true, "not a secure context: stays hidden");
  const d = shellDom({ clipboard });
  assert.equal(d.copy.hidden, false);
  d.copy.fire("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(written, ["pi-dispatch sandbox gh-1"]);
  assert.equal(d.copy.textContent, "Copied");
  d.timers.forEach((fn) => fn());
  assert.equal(d.copy.textContent, "Copy", "and says Copy again");
});

test("the script never parses document.cookie and holds no pdc_ name: the theme cookie is pd_theme", () => {
  assert.equal(THEME_COOKIE, "pd_theme");
  assert.ok(!CONSOLE_SCRIPT.includes("pdc_"));
  assert.doesNotMatch(CONSOLE_SCRIPT, /=\s*document\.cookie|document\.cookie\s*[.[)]/, "the cookie is only ever assigned");
});
