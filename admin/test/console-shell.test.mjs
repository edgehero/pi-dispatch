import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_PAGES, PAGES, panelIds, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { ICON_NAMES, SPRITE } from "../src/console/pulse-icons.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { LIVE_GLYPHS, LIVE_STATES, NAV, NAV_MORE, NAV_PARKED_ID, loginCodePage, loginPage, navParkedCount, navParkedHtml, shellHtml } from "../src/console/shell.mjs";
import { SYSTEM_SCHEME, THEME_COOKIE, THEME_COOKIE_MAX_AGE_SEC, THEME_COOKIE_SAME_SITE, THEME_LABELS, THEMES } from "../src/console/theme.mjs";

// The Pulse shell (issue #737, `shell.mjs`): the top bar, the navigation, the live pill, the theme button and the title
// bar every page is drawn in, and the browser script's side of them. Pure renders over hand-made page data; the goldens
// (`console-pages.test.mjs`) hold the same frame over the canned deployment.

// Control bytes are built, never typed.
const ESC = String.fromCharCode(27);
const HOSTILE = `<img src=x onerror=alert(1)>"'${ESC}`;
const ROLES = ["viewer", "operator"];

/** Page `name` drawn for `role` over `data` (empty by default: every panel says what it could not read). */
async function draw(name, { role = "operator", data = {}, readOnly = false, theme = null, sessionName = role === "operator" ? "ops" : "watcher" } = {}) {
  const query = parsePageQuery(name, name === "run" ? "id=gh-1" : "").query;
  const out = await renderPage(name, { query, session: { name: sessionName, role }, data: { now: 0, env: {}, ...data }, readOnly, theme });
  return { status: out.status, html: String(out.html) };
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
      const here = name === "run" ? "runs" : name;
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

test("the title bar: the page's title, and the run detail's back link to Runs with the run named", async () => {
  assert.match((await draw("overview")).html, /<div class="titlebar"><div class="titlebar__lead"><h1>Overview<\/h1><\/div><\/div>/);
  assert.match((await draw("audit", { role: "viewer" })).html, /<h1>Audit log<\/h1><\/div><\/div>\n<div class="legacy"><p class="warn">This page is for operators only\.<\/p><\/div>/);
  const run = (await draw("run")).html;
  assert.match(run, /<div class="titlebar__lead"><a class="back" href="\/runs"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-chev-l"><\/use><\/svg>Runs<\/a><h1>Run gh-1<\/h1><\/div>/);
  for (const name of Object.keys(PAGES).filter((n) => n !== "run")) assert.ok(!(await draw(name)).html.includes('class="back"'), `${name} has no back link`);
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
  assert.match((await draw("overview", { role: "viewer" })).html, /<span class="who" title="watcher, Viewer"><span><b>watcher<\/b><small>Viewer<\/small><\/span><span class="avatar">wa<\/span><\/span>/);
  assert.match((await draw("overview")).html, /<span class="who" title="ops, Operator"><span><b>ops<\/b><small>Operator<\/small><\/span><span class="avatar">op<\/span><\/span>/);
  const { html } = await draw("overview", { sessionName: HOSTILE });
  assert.ok(!html.includes("<img src=x") && !html.includes(ESC), "no live markup and no control byte from the name");
  // The full name rides in the block's `title` too, escaped the same way, with the role after it.
  assert.match(html, /<span class="who" title="&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39; ?, Operator"><span><b>&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39; ?<\/b>/);
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
    if (PAGES[name].live) assert.equal(ids.at(-1), NAV_PARKED_ID, `${name}: listed last, so a screen's first panel stays its first`);
    const ctx = { query: parsePageQuery(name, name === "run" ? "id=gh-1" : "").query, session: { name: "ops", role: "operator" }, data: { now: 0, env: {}, parkedCount: 3 } };
    const panels = await pagePanels(name, ctx);
    assert.deepEqual(panels.map((p) => p.id), ids, `${name}: pagePanels lists panelIds`);
    const page = String((await renderPage(name, ctx)).html);
    for (const p of panels) {
      const tag = p.id === NAV_PARKED_ID ? "span" : "section";
      assert.ok(page.includes(`<${tag} id="${p.id}" data-panel>${p.html}</${tag}>`), `${name}: ${p.id} is the page's own`);
    }
  }
  assert.throws(() => shellHtml("nope", {}, null), /no such page/);
});

test("LEGACY_PAGES is a written-out frozen list: a page added to PAGES later is not legacy by default", () => {
  // The list as written (review D1): a copy derived from PAGES would make every new page start in the old markup.
  assert.deepEqual(LEGACY_PAGES, ["overview", "runs", "run", "parked", "insights", "fleet", "config", "audit", "login", "login-code", "forbidden"]);
  assert.ok(Array.isArray(LEGACY_PAGES) && Object.isFrozen(LEGACY_PAGES), "an array, frozen: a frozen Set still takes .add()");
  assert.throws(() => LEGACY_PAGES.push("models"), TypeError);
  // Every name is a screen or one of the three pages that are not screens, each once.
  const notScreens = ["login", "login-code", "forbidden"];
  assert.equal(new Set(LEGACY_PAGES).size, LEGACY_PAGES.length);
  for (const name of LEGACY_PAGES) assert.ok(Object.hasOwn(PAGES, name) || notScreens.includes(name), `${name} is a screen or a sign-in or refusal page`);
  for (const name of notScreens) assert.ok(!Object.hasOwn(PAGES, name), `${name} is not a screen`);
  // A page PAGES does not hold is not legacy (the three static ones aside), however it is spelled.
  for (const name of ["models", "watch", "secrets", "connections", "project", "host", "Overview", "", "__proto__", "constructor"]) assert.equal(LEGACY_PAGES.includes(name), false, name);
});

test("the legacy wrapper: every legacy page's content, the sign-in pages' and the refusal's, inside one .legacy", async () => {
  for (const name of Object.keys(PAGES)) {
    const { html } = await draw(name);
    assert.equal(count(html, '<div class="legacy">'), 1, name);
    const legacy = html.slice(html.indexOf('<div class="legacy">'));
    const sections = [...html.matchAll(/<section id="(p-[a-z-]+)" data-panel>/g)];
    assert.ok(sections.length > 0, `${name} has panels`);
    for (const m of sections) assert.ok(legacy.includes(m[0]), `${name}: ${m[1]} is inside the wrapper`);
    assert.ok(html.indexOf("<h1") < html.indexOf('<div class="legacy">'), `${name}: the title bar is the shell's, outside it`);
  }
});

test("the sign-in pages: the skip link, the sprite, a top bar of the pill and the theme button alone, a title bar, the old form inside .legacy, the request's theme", () => {
  for (const [fn, name] of [[loginPage, "login"], [loginCodePage, "login-code"]]) {
    const plain = String(fn());
    const pill = `<a class="brandpill" href="/"><span class="brandpill__m" aria-hidden="true">pi</span>pi-dispatch</a>`;
    const toggle = (label) => `<button class="roundbtn" type="button" data-theme-toggle hidden aria-label="${label}" title="${label}"><svg class="ic" aria-hidden="true"><use href="#i-theme"></use></svg></button>`;
    assert.ok(plain.includes(`<body data-page="${name}">\n<a class="skip" href="#main">Skip to content</a>\n${String(SPRITE)}\n<div class="page">\n<header class="top">${pill}<div class="top__end">${toggle(THEME_LABELS.system)}</div></header>\n<main id="main" tabindex="-1">\n<div class="titlebar"><div class="titlebar__lead"><h1>pi-dispatch console</h1></div></div>\n<div class="legacy">`), name);
    assert.match(plain, /<html lang="en">\n[^]*<meta name="color-scheme" content="light dark">/);
    // Nobody is signed in: no navigation, no live pill, no who, no sign-out.
    for (const absent of ["pillnav", 'id="live-status"', 'class="who"', 'id="logout"']) assert.ok(!plain.includes(absent), `${name}: no ${absent}`);
    assert.equal(count(plain, "<h1"), 1);
    assert.equal(count(plain, '<svg class="sprite"'), 1);
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
  assert.match(String(loginPage()), /<div class="legacy"><form id="login-form" autocomplete="off">\n<label for="token">Console token<\/label>/);
  assert.match(String(loginCodePage()), /<div class="legacy"><p id="notice" role="status">Signing in with a one-time link\.\.\.<\/p>\n<p><a href="\/login">Sign in with a token instead<\/a><\/p><\/div>/);
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
