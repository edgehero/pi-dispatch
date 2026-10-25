import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ERROR_KINDS, ERROR_SENTENCES, errorPage } from "../src/console/error-pages.mjs";
import { parsePageQuery } from "../src/console/pages.mjs";
import { LINK_PAGE_TITLE, loginCodePage, loginPage } from "../src/console/shell.mjs";
import { NO_SCRIPT_TEXT } from "../src/console/signin.mjs";
import { FIXTURES, STATIC_SHOTS, assertClean, renderStatic } from "./helpers/console-pages-harness.mjs";
import { parseDocument, shown } from "./helpers/script-dom.mjs";

/**
 * The console's pages that are not screens (issue #737): the sign-in page, the one-time link page and the error
 * pages, each drawn by the real modules (`console-pages-harness.mjs` `renderStatic`) and pinned byte for byte as
 * `admin/test/fixtures/console/<shot>.<role>.html`, beside the screens' goldens, so the page rules (`assertClean`), the
 * width check and a diff hold them as they hold every screen. Pure: no deployment and no Valkey, so it runs
 * everywhere (the screens' render needs `VALKEY_TEST_URL`; these do not).
 *
 *   UPDATE_CONSOLE_FIXTURES=1 node --test test/console-static-pages.test.mjs    rewrite these goldens from this render
 *
 * (then read the diff, as for the screens: the goldens ARE the pages).
 */

const update = process.env.UPDATE_CONSOLE_FIXTURES === "1";

test("the static pages: each byte-identical to its golden and to a second render, and held to every page rule", async () => {
  const first = await renderStatic();
  const second = await renderStatic();
  assert.deepEqual(Object.keys(first), [...STATIC_SHOTS]);
  if (update) mkdirSync(FIXTURES, { recursive: true });
  for (const shot of STATIC_SHOTS) {
    const file = join(FIXTURES, `${shot}.html`);
    if (update) writeFileSync(file, first[shot].html);
    assert.ok(existsSync(file), `${file} exists (UPDATE_CONSOLE_FIXTURES=1 writes it)`);
    assert.ok(first[shot].html === readFileSync(file, "utf8"), `fixtures/console/${shot}.html is not what the console draws now: run with UPDATE_CONSOLE_FIXTURES=1, read the diff, and commit it`);
    assert.equal(second[shot].html, first[shot].html, `${shot} is the same bytes on a second render`);
    assert.match(first[shot].html, /^<!doctype html>/, `${shot} is a whole page`);
    assertClean(shot, first[shot].html);
  }
});

test("each static page answers its status, names its page for the script and the stylesheet, and is one panel", async () => {
  const pages = await renderStatic();
  const want = {
    "login.anonymous": [200, "login", "p-signin"],
    "login-code.anonymous": [200, "login-code", "p-link"],
    "error-404.operator": [404, "error", "p-error"],
    "error-404.viewer": [404, "error", "p-error"],
    "error-400.operator": [400, "error", "p-error"],
    "error-403.viewer": [403, "error", "p-error"],
    "error-421.anonymous": [421, "error", "p-error-421"],
    "error-503.anonymous": [503, "error", "p-error"],
  };
  assert.deepEqual(Object.keys(want), [...STATIC_SHOTS], "every static shot is checked here");
  for (const [shot, [status, name, panel]] of Object.entries(want)) {
    const { html } = pages[shot];
    assert.equal(pages[shot].status, status, shot);
    assert.match(html, new RegExp(`<body data-page="${name}">`), `${shot}: data-page`);
    assert.deepEqual([...html.matchAll(/<section id="([^"]+)" data-panel>/g)].map((m) => m[1]), [panel], `${shot}: its one panel`);
    assert.ok(!html.includes("pdc_"), `${shot}: no token prefix (the server's leak canary)`);
    assert.ok(!html.includes('id="confirm-slot"') && !html.includes('id="live-status"'), `${shot}: no write slot and no live pill: nothing here writes or streams`);
  }
});

test("the static pages say what their card says: who is signed in only where a session is known, and nothing from the request but the 421's host", async () => {
  const pages = await renderStatic();
  // The sign-in page: the token form, both commands for a way in (pi's prints a link with --link), loopback only.
  const login = pages["login.anonymous"].html;
  assert.ok(login.includes('<form id="login-form" class="signin__form" autocomplete="off" hidden data-reveal>'), "the token form, for the script to reveal");
  assert.ok(login.includes("<code><span>/dispatch</span> <span>console</span> <span>--link</span></code>"), "the pi command that prints a link");
  assert.ok(login.includes("<code><span>pi-dispatch-console</span> <span>token</span> <span>add</span> <span>--name</span> <span>&#39;&lt;you&gt;&#39;</span> <span>--role</span> <span>operator</span></code>"), "the host command, its placeholder quoted");
  assert.ok(login.includes("This console answers on this host&#39;s loopback address only."), "the default listener's footer");
  assert.equal((login.match(/<div data-notice="[^"]+">/g) ?? []).length, 0, "no notice shown on a plain visit");
  assert.ok(!login.includes('class="pillnav"') && !login.includes('id="logout"'), "nobody is signed in");
  // The link page starts signing in, for the script to reveal; the other two states drawn hidden for it to switch to.
  const link = pages["login-code.anonymous"].html;
  assert.deepEqual([...link.matchAll(/<div class="signin__state" data-link-state="([a-z]+)"( hidden data-reveal| hidden)>/g)].map((m) => [m[1], m[2] === " hidden data-reveal"]), [["wait", true], ["used", false], ["nocode", false]]);
  // 404, 400 and 403 keep the console's navigation for the session they were asked by (a viewer's has no audit link);
  // none marks a screen current, since the page is none of them.
  for (const shot of ["error-404.operator", "error-404.viewer", "error-400.operator", "error-403.viewer"]) {
    const html = pages[shot].html;
    assert.ok(html.includes('<nav class="pillnav" aria-label="Console screens">') && html.includes('id="logout"'), `${shot}: the navigation and sign-out`);
    assert.ok(!html.includes('aria-current="page"'), `${shot}: no screen marked current`);
    assert.equal(html.includes('href="/audit"'), shot.endsWith(".operator"), `${shot}: the audit link is the operator's`);
  }
  assert.ok(pages["error-404.operator"].html.includes(">Go to Runs</a>") && pages["error-404.operator"].html.includes(">Go to Overview</a>"), "404: Runs and Overview");
  // The 400 says the parser's own refusal, which names the parameter and never its value, and leads back to the page.
  const bad = pages["error-400.operator"].html;
  assert.match(bad, /The page refused its address, so it read nothing: <span class="code">before<\/span> must be a whole number/);
  assert.ok(bad.includes('href="/runs"') && !bad.includes("xyzzy"), "back to Runs, the value not echoed");
  assert.ok(pages["error-403.viewer"].html.includes("The audit log is for operators"), "403: the operators-only card");
  // The 421 and the 503 draw no navigation and no session; the 421 names the refused host and the tunnel to use.
  for (const shot of ["error-421.anonymous", "error-503.anonymous"]) {
    const html = pages[shot].html;
    assert.ok(!html.includes('class="pillnav"') && !html.includes('id="logout"') && !html.includes('class="who"'), `${shot}: no navigation, no session`);
  }
  const host = pages["error-421.anonymous"].html;
  assert.ok(host.includes('Your browser asked for <span class="code">myhost.lan</span>'), "the refused host, in the code face");
  assert.ok(host.includes('<code><span>ssh</span> <span>-L</span> <span>7788:localhost:7788</span> <span>&#39;&lt;this host&gt;&#39;</span></code>'), "the tunnel to the port this request reached, on localhost when the address it reached is not known");
  assert.ok(pages["error-503.anonymous"].html.includes("<code><span>pi-dispatch</span> <span>doctor</span></code>"), "503: what an operator runs");
});

// ---- without a script --------------------------------------------------------------------------------------------

/**
 * `page` as a browser draws it: with scripts off a `<noscript>`'s content is markup (read here as a `div`), with them on
 * it is not drawn at all; `reveal` applies the script's first act on a sign-in page (every `[data-reveal]` loses
 * `hidden`: `script.mjs`, the contract `signin.mjs`'s header states).
 */
function drawn(page, { script, reveal = script }) {
  const markup = script ? String(page).replace(/<noscript>[^]*?<\/noscript>/g, "") : String(page).replaceAll("<noscript>", "<div data-noscript>").replaceAll("</noscript>", "</div>");
  const doc = parseDocument(markup);
  if (reveal) for (const el of doc.querySelectorAll("[data-reveal]")) el.hidden = false;
  return doc;
}

/** The words a reader sees in `el`: its text outside every hidden element (and the sprite), squashed. */
function seen(el) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) out.push(n.data);
    else if (n.nodeType === 1 && !n.hidden && n.localName !== "svg") for (const c of n.childNodes) walk(c);
  };
  walk(el);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

test("without a script the sign-in pages show only what works, the sentence that says so first in the card; the script's reveal shows the rest", () => {
  const login = loginPage({ notice: "idle", limits: { idleMinutes: 60, maxHours: 12 }, listen: "tcp" });
  const off = drawn(login, { script: false });
  const card = off.querySelector(".signin");
  assert.ok(card.firstElementChild.hasAttribute("data-noscript"), "the no-script notice is the card's first child");
  assert.ok(seen(card).startsWith(NO_SCRIPT_TEXT), seen(card));
  assert.ok(!shown(off.getElementById("login-form")), "no token form that cannot post");
  for (const gone of ["Paste a console token", "Console token"]) assert.ok(!seen(card).includes(gone), `${gone}: not shown without a script`);
  assert.deepEqual([...card.querySelectorAll("button, input")].filter(shown).map((el) => el.outerHTML), [], "no control: Sign in and the copy buttons need the script");
  // What is true without a script stays: why the session ended, where a token or a link comes from, where it answers.
  for (const kept of ["You were signed out after 60 minutes without a request", "No token yet?", "pi-dispatch-console token add", "loopback address only"]) assert.ok(seen(card).includes(kept), kept);
  // With the script: the noscript is not drawn, and the reveal shows the form and its lead-in.
  const on = drawn(login, { script: true });
  assert.ok(shown(on.getElementById("login-form")) && !on.querySelector("[data-noscript]"));
  assert.ok(seen(on.querySelector(".signin")).startsWith("pi Sign in to the console Paste a console token, or open a one-time link from pi."), seen(on.querySelector(".signin")));
  // The reveal is the only thing that shows them: drawn hidden, and nothing else on the page is marked for it.
  assert.ok(!shown(drawn(login, { script: true, reveal: false }).getElementById("login-form")));
  assert.deepEqual([...on.querySelectorAll("[data-reveal]")].map((el) => el.localName), ["p", "form"]);

  // The link page without a script says that sentence and nothing else; never "Signing in", in its card or its title.
  const link = loginCodePage();
  const linkOff = drawn(link, { script: false });
  assert.equal(seen(linkOff.querySelector(".signin")), NO_SCRIPT_TEXT);
  assert.ok(!seen(linkOff.body).includes("Signing in"), seen(linkOff.body));
  assert.ok(String(link).includes(`<title>pi-dispatch console: ${LINK_PAGE_TITLE}</title>`) && !/Signing in/.test(LINK_PAGE_TITLE));
  // With the script, the state the page opens in shows, and only that one.
  const linkOn = drawn(link, { script: true });
  assert.deepEqual([...linkOn.querySelectorAll("[data-link-state]")].filter(shown).map((el) => el.getAttribute("data-link-state")), ["wait"]);
  assert.ok(seen(linkOn.querySelector(".signin")).includes("Signing in with a one-time link"));
});

// ---- the 400's refusal -------------------------------------------------------------------------------------------

/** The parameters page `name` takes, as the real parser lists them when it refuses one it does not take. */
function paramsOf(name) {
  const refusal = parsePageQuery(name, new URLSearchParams("zz-not-a-parameter=1")).refusal;
  const m = /^the [a-z-]+ page takes (?:only (.+)|no query parameters)$/.exec(refusal);
  assert.ok(m, refusal);
  return m[1] === undefined ? [] : m[1].split(", ");
}

test("a 400 page sets the refusal's leading parameter name in the code face, and only a name the page takes, for the real parser's refusals", () => {
  const BAD = {
    runs: ["before=x", "before=1&before=2", "outcome=nope", `repo=${"r".repeat(300)}`, "zz=1", "q=a&q=b", Array.from({ length: 17 }, (_, i) => `repo=${i}`).join("&")],
    run: ["", "id=not%20an%20id", "id=a&id=b"],
    insights: ["range=never", "whatif=a/b", "flow=f", "whatif=a&flow=f", "whatif=a/b&flow=BAD!", "paths=nope"],
    audit: ["before=x", "who=no%20one", "action=nope", "outcome=nope", "seq=0", "seq=1&before=2026-10:3"],
    overview: ["x=1"],
  };
  let coded = 0;
  for (const [name, queries] of Object.entries(BAD)) {
    const takes = paramsOf(name);
    for (const q of queries) {
      const { refusal } = parsePageQuery(name, new URLSearchParams(q));
      assert.equal(typeof refusal, "string", `${name}?${q} is refused`);
      const card = /<p class="er-s">([^]*?)<\/p>/.exec(String(errorPage({ kind: "bad-query", sentence: refusal, page: name }).html))[1];
      const names = [...card.matchAll(/<span class="code">([^<]*)<\/span>/g)].map((m) => m[1]);
      for (const n of names) assert.ok(takes.includes(n), `${name}?${q}: ${n} is a parameter of ${name} (${refusal})`);
      // A refusal that opens with one of the page's parameters has it in the code face, at the start of the tail.
      const first = /^[a-z0-9_]+/.exec(refusal)?.[0];
      if (takes.includes(first)) assert.ok(card.includes(`so it read nothing: <span class="code">${first}</span>`), `${name}?${q}: ${refusal}`);
      else assert.deepEqual(names, [], `${name}?${q}: ${refusal} names no parameter first`);
      coded += names.length;
    }
  }
  assert.ok(coded >= 15, `the queries reach the parameter-led refusals (${coded} names coded)`);
  // A pair is two names, the tail's words between them kept.
  const pair = String(errorPage({ kind: "bad-query", sentence: "seq and before do not go together: each says where the page starts", page: "audit" }).html);
  assert.ok(pair.includes('so it read nothing: <span class="code">seq</span> and <span class="code">before</span> do not go together: each says where the page starts.</p>'));
});

test("each error page's title bar says its title and the line under it, as the ErrorPage card's does", () => {
  for (const kind of ERROR_KINDS) {
    const said = ERROR_SENTENCES[kind];
    assert.ok(typeof said.sub === "string" && /^[A-Z].*\.$/.test(said.sub) && !said.sub.includes("—"), `${kind}: ${said.sub}`);
    const text = String(errorPage({ kind, host: "myhost.lan", port: 7788 }).html);
    assert.ok(text.includes(`<div class="titlebar"><div class="titlebar__lead"><h1>${said.title.replace("'", "&#39;")}</h1><p class="titlebar__sub">${said.sub.replace("'", "&#39;")}</p></div></div>`), kind);
  }
  // A command in a catalog sentence is in the code face: the 503's, and the sign-in notice's, which says the same.
  assert.ok(String(errorPage({ kind: "unavailable" }).html).includes('An operator should run <span class="code">pi-dispatch doctor</span> on the host'));
  assert.ok(String(loginPage({ notice: "tokens" })).includes('<p class="banner__s">An operator should run <span class="code">pi-dispatch doctor</span> on the host.</p>'));
});
