import assert from "node:assert/strict";
import { test } from "node:test";
import { html, isSafeHtml, loginCodePage, loginPage, raw, signedInPage } from "../src/console/html.mjs";

// The console's escaping (issue #640, REQ-CONSOLE-SECURITY f and the run-text rule): every interpolation is escaped,
// and nothing but a fragment `html` built passes through.

const HOSTILE = "<img src=x onerror=alert(1)>";
// Control bytes are built, never typed: ESC, a bidi override (U+202E) and BEL.
const ESC = String.fromCharCode(27);
const RLO = String.fromCharCode(0x202e);
const BEL = String.fromCharCode(7);

test("an interpolated hostile name is inert text", () => {
  const out = String(html`<p>${HOSTILE}</p>`);
  assert.equal(out, "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
  assert.equal(String(html`<a title="${'" onmouseover="x'}">`), '<a title="&quot; onmouseover=&quot;x">');
  assert.equal(String(html`${"it's"}`), "it&#39;s");
});

test("control bytes are scrubbed before escaping, so none reaches the page", () => {
  const out = String(html`<p>${`a${ESC}[31mb${RLO}c${BEL}d`}</p>`);
  for (const ch of [ESC, RLO, BEL]) assert.ok(!out.includes(ch), `code ${ch.charCodeAt(0)}`);
  assert.match(out, /^<p>a ?\[31mb ?c ?d<\/p>$/);
});

test("fragments nest unescaped, arrays render item by item, null/undefined/false render nothing", () => {
  const inner = html`<b>${HOSTILE}</b>`;
  assert.ok(isSafeHtml(inner));
  assert.equal(String(html`<p>${inner}</p>`), "<p><b>&lt;img src=x onerror=alert(1)&gt;</b></p>");
  assert.equal(String(html`<ul>${["<a>", html`<li>x</li>`]}</ul>`), "<ul>&lt;a&gt;<li>x</li></ul>");
  assert.equal(String(html`${null}${undefined}${false}${0}`), "0");
});

test("raw() joins fragments and refuses a string, so nothing can be smuggled past the escaping", () => {
  assert.equal(String(raw(html`<a>`, [html`<b>`])), "<a><b>");
  assert.throws(() => raw("<script>alert(1)</script>"), TypeError);
  assert.throws(() => raw([html`<a>`, HOSTILE]), TypeError);
  // an object that merely looks like a fragment is escaped like any value
  assert.equal(String(html`${{ toString: () => "<x>" }}`), "&lt;x&gt;");
});

test("the signed-in page escapes a hostile token name and role", () => {
  const out = String(signedInPage({ name: `${HOSTILE}${ESC}`, role: "<b>operator</b>", readOnly: true }));
  assert.ok(!out.includes(HOSTILE));
  assert.ok(!out.includes(ESC));
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /&lt;b&gt;operator&lt;\/b&gt;/);
  assert.match(out, /read-only/);
});

test("no page carries inline script, inline style or an event handler; each loads the one script by URL", () => {
  for (const page of [loginPage(), loginCodePage(), signedInPage({ name: "alice", role: "operator", readOnly: false })]) {
    const out = String(page);
    assert.deepEqual(out.match(/<script[^>]*>/g), ['<script src="/static/console.js" defer>']);
    assert.ok(!/<style|style=|\son[a-z]+=/i.test(out), out);
    assert.match(out, /<body data-page="(login|login-code|home)">/);
  }
  // the sign-in form has no action: a plain submit would be form-encoded, which the server refuses
  assert.ok(!/action=/.test(String(loginPage())));
});
