import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ui from "../src/console/kit.mjs";
import { html, isSafeHtml } from "../src/console/html.mjs";
import { PAGES, renderPage } from "../src/console/pages.mjs";
import { ICON_NAMES, SPRITE } from "../src/console/pulse-icons.mjs";
import { PULSE_CSS } from "../src/console/pulse-css.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { ERROR_KINDS, errorPage } from "../src/console/error-pages.mjs";
import { loginCodePage, loginPage } from "../src/console/shell.mjs";
import { forgeLinkOf } from "../src/read-model.mjs";
import { DOCS_ROOT, OUTCOME_WORDS, REASON_WORDS, STATUS_KINDS, docsHref, outcomeWord } from "../src/words.mjs";
import { assertOwnReferences } from "./helpers/console-pages-harness.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #737: the console's kit and its icon sprite. Each helper is pinned to its component card's own sample, written
// here as the card's bytes (the design files are not in this repository, so the samples are copied, and `fromCard`
// applies the one spelling the kit writes differently everywhere). Where the kit adds to a card on purpose (a column
// head's scope, a meter's minimum, the Copy button's reveal hook) the difference is spelled out beside the sample.
// The sweeps at the end run over every fragment the tests above built.

/** A card's markup as the kit writes it: the cards close `<use>` with `/>`, the kit with `</use>`. */
const fromCard = (s) => s.replace(/<use href="(#i-[a-z0-9-]+)"\/>/g, `<use href="$1"></use>`);
/** A card's sample with the whitespace between its tags taken out (the cards indent; the kit writes none). */
const tight = (s) => fromCard(s.replace(/>\s+</g, "><"));
/** A card's `href="#"` placeholders, which the kit refuses, given real targets in order. */
const hrefs = (s, ...targets) => s.replace(/href="#"/g, () => `href="${targets.shift()}"`);

/** Every fragment a test built, for the sweeps at the end. */
const OUT = [];
const out = (frag) => {
  assert.ok(isSafeHtml(frag), "a kit helper returns a fragment built by html");
  OUT.push(String(frag));
  return String(frag);
};

const HOSTILE = `<script>alert("x")</script> & 'q'\u0007`;
const ESCAPED = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; ";

// ---- the sprite -----------------------------------------------------------------------------------------------------------

/** The five stroke attributes every stroked card element repeats, lifted onto its symbol (see pulse-icons.mjs). */
const STROKE = `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;

test("the sprite holds the cards' 57 icons, the hatch and the arrow, each id once, in a static fragment under its budget", () => {
  assert.ok(isSafeHtml(SPRITE));
  const text = String(SPRITE);
  assert.ok(text.startsWith(`<svg class="sprite" aria-hidden="true" focusable="false"><defs>\n`), "hidden and out of the tab order");
  assert.ok(text.endsWith("\n</defs></svg>"));
  assert.deepEqual(ICON_NAMES, [
    "home", "runs", "parked", "spend", "fleet", "config", "audit", "search", "chev", "chev-l", "chev-r", "plus", "minus", "pause", "play", "theme",
    "bolt", "git", "clock", "terminal", "shield", "queue", "rerun", "done", "failed", "refused", "attention", "running", "hourglass", "beat",
    "doctor", "cancel", "slot-held", "logout", "more", "fit", "steer", "info", "edit", "chain", "slot", "key", "tag", "comment", "pr", "issue",
    "globe", "plug", "bell", "folder", "pie", "flows", "skill", "flag", "box", "eye", "layers",
  ]);
  assert.ok(Object.isFrozen(ICON_NAMES));
  const ids = Array.from(text.matchAll(/\sid="([^"]+)"/g), (m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "every id once");
  assert.deepEqual(ids.filter((id) => !id.startsWith("i-")), ["hatch", "arrow"]);
  assert.ok(text.includes(`<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hatch-bg" width="6" height="6"/><rect class="hatch-ln" width="2" height="6"/></pattern>`));
  assert.ok(text.includes(`<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arrowhead" d="M0 0 10 5 0 10z"/></marker>`));
  // The budget: 57 symbols at about 49 bytes of `<symbol id viewBox>` each, 52 of them carrying the 102 bytes of
  // stroke attributes, 2.3 KB of path data and 3.3 KB of the other geometry. 13,696 bytes as generated (the cards'
  // own copy is 17,560); the bound catches a symbol pasted in with its attributes repeated again.
  assert.ok(Buffer.byteLength(text) < 14000, `${Buffer.byteLength(text)} bytes`);
  // Pinned as generated: a red hash means a symbol changed. Regenerate from the cards by the rule in pulse-icons.mjs's
  // header, check the drawing, then move the hash.
  assert.equal(createHash("sha256").update(text).digest("hex"), "cf848e858b227a359b53e3991e62259c3d3db30fb719e212a64ecbf7c2d768c5");
});

test("each stroked symbol carries the stroke attributes once, no part repeats them, and its solid parts say stroke none", () => {
  const symbols = Array.from(String(SPRITE).matchAll(/<symbol id="i-([a-z0-9-]+)" ([^>]*)>(.*?)<\/symbol>/g));
  assert.equal(symbols.length, 57);
  const solidOnly = [];
  for (const [, id, attrs, body] of symbols) {
    const parts = Array.from(body.matchAll(/<(path|circle|rect)\b([^>]*)\/>/g));
    assert.equal(parts.map((p) => p[0]).join(""), body, `${id}: drawn with path, circle and rect only`);
    const solid = (a) => /\bfill="currentColor"/.test(a);
    if (parts.every((p) => solid(p[2]))) {
      solidOnly.push(id);
      assert.equal(attrs, `viewBox="0 0 24 24"`, `${id}: nothing to lift`);
    } else {
      assert.equal(attrs, `viewBox="0 0 24 24" ${STROKE}`, `${id}: the stroke attributes on the symbol`);
    }
    for (const [, , a] of parts) {
      assert.doesNotMatch(a, /stroke-width|stroke-linecap|stroke-linejoin|stroke="currentColor"|fill="none"/, `${id}: a part repeats a lifted attribute`);
      if (solid(a) && !solidOnly.includes(id)) assert.match(a, /\sstroke="none"/, `${id}: a solid part is not outlined by the lifted stroke`);
      if (!solid(a)) assert.doesNotMatch(a, /\bstroke="none"|\bfill=/, `${id}: a stroked part keeps the symbol's fill and stroke`);
    }
  }
  assert.deepEqual(solidOnly, ["pause", "play", "running", "cancel", "more"]);
});

// ---- statuses ---------------------------------------------------------------------------------------------------------------

test("STATUS is keyed by words.mjs STATUS_KINDS, in its order, with the Status card's tone and icon for each", () => {
  assert.deepEqual(Object.keys(ui.STATUS), [...STATUS_KINDS]);
  assert.deepEqual(Object.fromEntries(Object.entries(ui.STATUS).map(([k, v]) => [k, `${v.tone} ${v.icon}`])), {
    running: "running running",
    parked: "parked parked",
    failed: "failed failed",
    refused: "refused refused",
    attention: "attention attention",
    ok: "ok done",
    idle: "idle clock",
    cancelled: "idle cancel",
  });
  for (const [k, v] of Object.entries(ui.STATUS)) assert.ok(ICON_NAMES.includes(v.icon), `${k}'s icon is in the sprite`);
  assert.deepEqual(ui.TONES, ["running", "parked", "failed", "refused", "attention", "ok", "idle"]);
  // The tones are exactly the stylesheet's `.tone-*` rules.
  assert.deepEqual(Array.from(PULSE_CSS.matchAll(/^\.tone-([a-z]+)\s*\{/gm), (m) => m[1]), [...ui.TONES]);
  for (const w of [...Object.values(OUTCOME_WORDS), ...Object.values(REASON_WORDS), outcomeWord("vapour")]) assert.ok(Object.hasOwn(ui.STATUS, w.status), w.status);
});

test("icon: the sprite's symbol by name, hidden, in the three sizes", () => {
  assert.equal(out(ui.icon("running")), `<svg class="ic" aria-hidden="true"><use href="#i-running"></use></svg>`);
  assert.equal(out(ui.icon("rerun", { size: "sm" })), `<svg class="ic ic--sm" aria-hidden="true"><use href="#i-rerun"></use></svg>`);
  assert.equal(out(ui.icon("refused", { size: "lg" })), `<svg class="ic ic--lg" aria-hidden="true"><use href="#i-refused"></use></svg>`);
  for (const name of ICON_NAMES) out(ui.icon(name));
});

test("badge: the Status card's outcome and state badges, and the solid one", () => {
  const card = `<span class="badge tone-running"><svg class="ic" aria-hidden="true"><use href="#i-running"/></svg>Running</span><span class="badge tone-parked"><svg class="ic" aria-hidden="true"><use href="#i-parked"/></svg>Awaiting input</span><span class="badge tone-parked"><svg class="ic" aria-hidden="true"><use href="#i-shield"/></svg>Awaiting approval</span><span class="badge tone-ok"><svg class="ic" aria-hidden="true"><use href="#i-done"/></svg>Completed</span><span class="badge tone-failed"><svg class="ic" aria-hidden="true"><use href="#i-failed"/></svg>Failed</span><span class="badge tone-refused"><svg class="ic" aria-hidden="true"><use href="#i-refused"/></svg>Refused</span><span class="badge tone-attention"><svg class="ic" aria-hidden="true"><use href="#i-attention"/></svg>Needs a look</span><span class="badge tone-idle"><svg class="ic" aria-hidden="true"><use href="#i-cancel"/></svg>Cancelled</span><span class="badge tone-idle"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg>Held</span><span class="badge tone-idle"><svg class="ic" aria-hidden="true"><use href="#i-hourglass"/></svg>Delayed</span><span class="badge tone-ok"><svg class="ic" aria-hidden="true"><use href="#i-done"/></svg>Healthy</span>`;
  const kit = [
    ui.badge("running", "Running"),
    ui.badge("parked", "Awaiting input"),
    ui.badge("parked", "Awaiting approval", { icon: "shield" }),
    ui.badge("ok", "Completed"),
    ui.badge("failed", "Failed"),
    ui.badge("refused", "Refused"),
    ui.badge("attention", "Needs a look"),
    ui.badge("cancelled", "Cancelled"),
    ui.badge("idle", "Held"),
    ui.badge("idle", "Delayed", { icon: "hourglass" }),
    ui.badge("ok", "Healthy"),
  ].map(out).join("");
  assert.equal(kit, fromCard(card));
  assert.equal(out(ui.badge("failed", "Failed", { solid: true })), `<span class="badge badge--solid tone-failed"><svg class="ic" aria-hidden="true"><use href="#i-failed"></use></svg>Failed</span>`);
});

test("outcomeBadge: words.mjs's word and status for a record's outcome and reason; an unknown outcome as itself, as a failure", () => {
  const b = (status, icon, word) => `<span class="badge tone-${status}"><svg class="ic" aria-hidden="true"><use href="#i-${icon}"></use></svg>${word}</span>`;
  assert.equal(out(ui.outcomeBadge("completed")), b("ok", "done", "Completed"));
  assert.equal(out(ui.outcomeBadge("completed", "awaiting-input")), b("parked", "parked", "Awaiting input"));
  assert.equal(out(ui.outcomeBadge("policy", "scope-cap")), b("refused", "refused", "Refused"));
  assert.equal(out(ui.outcomeBadge("policy", "operator-cancel")), b("idle", "cancel", "Cancelled"));
  assert.equal(out(ui.outcomeBadge("failed", "container-never-started")), b("failed", "failed", "Failed"));
  assert.equal(out(ui.outcomeBadge("policy", "awaiting-input")), b("refused", "refused", "Refused"), "a qualifier only under its own outcome");
  assert.equal(out(ui.outcomeBadge("vapour")), b("failed", "failed", "vapour"));
  assert.equal(out(ui.outcomeBadge(null)), b("failed", "failed", "unknown"));
  assert.equal(out(ui.outcomeBadge(HOSTILE)), b("failed", "failed", ESCAPED));
});

test("ptag and vtag: the Status card's project and venue tags", () => {
  const card = `<span class="ptag">web</span><span class="ptag">api</span><span class="ptag">billing</span><span class="ptag">ops</span><span class="vtag">local</span><span class="vtag">podman</span><span class="vtag">openshell</span><span class="vtag">openshell-bind</span>`;
  assert.equal([...["web", "api", "billing", "ops"].map(ui.ptag), ...["local", "podman", "openshell", "openshell-bind"].map(ui.vtag)].map(out).join(""), card);
});

test("chip, count, dot and tile: the Status card's row, the Shell's nav count and ConfirmStates' small tile", () => {
  const chips = `<span class="chip tone-ok">60% of cap</span><span class="chip">longest 2h 14m</span><span class="chip tone-running"><svg class="ic" aria-hidden="true"><use href="#i-running"/></svg>live</span>`;
  assert.equal([ui.chip("60% of cap", { status: "ok" }), ui.chip("longest 2h 14m"), ui.chip("live", { status: "running", icon: "running" })].map(out).join(""), fromCard(chips));
  assert.equal([ui.count(1, "parked"), ui.count(4, "attention")].map(out).join(""), `<span class="count tone-parked">1</span><span class="count tone-attention">4</span>`);
  // The Shell's Parked count, whose card names it with `aria-label` on the span: the kit says it in visually hidden
  // text instead (a plain span may not be named), and hides the number it repeats from a screen reader.
  assert.equal(out(ui.count(1, "parked", { label: "1 waiting" })), `<span class="count tone-parked"><span aria-hidden="true">1</span><span class="sr">1 waiting</span></span>`, "the Shell's Parked count");
  assert.equal(out(ui.count(1204, null, { label: "1204 rows" })), `<span class="count"><span aria-hidden="true">1,204</span><span class="sr">1204 rows</span></span>`);
  assert.equal(out(ui.count(13)), `<span class="count">13</span>`, "the Configuration tabs' neutral count");
  assert.equal(out(ui.count(85577)), `<span class="count">85,577</span>`);
  assert.equal([ui.dot("ok"), ui.dot("attention"), ui.dot("failed")].map(out).join(""), `<span class="dot tone-ok"></span><span class="dot tone-attention"></span><span class="dot tone-failed"></span>`);
  assert.equal(out(ui.dot("ok", { label: "beating" })), `<span class="dot tone-ok" role="img" aria-label="beating"></span>`);
  const tiles = `<span class="tile tone-parked"><svg class="ic" aria-hidden="true"><use href="#i-parked"/></svg></span><span class="tile tone-failed"><svg class="ic" aria-hidden="true"><use href="#i-failed"/></svg></span><span class="tile tone-refused"><svg class="ic" aria-hidden="true"><use href="#i-refused"/></svg></span><span class="tile tone-attention"><svg class="ic" aria-hidden="true"><use href="#i-fleet"/></svg></span><span class="tile tone-ok"><svg class="ic" aria-hidden="true"><use href="#i-spend"/></svg></span><span class="tile tone-idle"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg></span>`;
  assert.equal([ui.tile("parked"), ui.tile("failed"), ui.tile("refused"), ui.tile("attention", { icon: "fleet" }), ui.tile("ok", { icon: "spend" }), ui.tile("idle")].map(out).join(""), fromCard(tiles));
  assert.equal(out(ui.tile("attention", { icon: "spend", sm: true })), fromCard(`<span class="tile tile--sm tone-attention"><svg class="ic" aria-hidden="true"><use href="#i-spend"/></svg></span>`));
});

// ---- actions -----------------------------------------------------------------------------------------------------------------

test("btn: the Actions card's buttons, the confirm bar's, a round icon button, a submit and a disabled link", () => {
  const card = `<a class="btn btn--primary" href="#">Open Fleet</a><a class="btn" href="#">Spend</a><a class="btn btn--answer" href="#"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-parked"/></svg>Answer</a><a class="btn btn--paid" href="#"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-rerun"/></svg>Re-run</a><a class="btn btn--danger" href="#"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-pause"/></svg>Pause fleet</a><a class="btn btn--ghost" href="#">See why</a><button class="btn" type="button" disabled>Re-run</button>`;
  const kit = [
    ui.btn({ kind: "primary", label: "Open Fleet", href: "/fleet" }),
    ui.btn({ label: "Spend", href: "/insights" }),
    ui.btn({ kind: "answer", label: "Answer", icon: "parked", href: "/parked" }),
    ui.btn({ kind: "paid", label: "Re-run", icon: "rerun", href: "/run?id=gh-f0c2" }),
    ui.btn({ kind: "danger", label: "Pause fleet", icon: "pause", href: "/fleet" }),
    ui.btn({ kind: "ghost", label: "See why", href: "#why" }),
    ui.btn({ label: "Re-run", disabled: true }),
  ].map(out).join("");
  assert.equal(kit, fromCard(hrefs(card, "/fleet", "/insights", "/parked", "/run?id=gh-f0c2", "/fleet", "#why")));
  const act = `<button class="btn btn--confirm" type="button">Confirm</button><button class="btn btn--ghost" type="button">Cancel</button><button class="btn btn--confirm-paid" type="button">Re-run for up to $2.00</button><button class="btn btn--confirm-danger" type="button">Pause the fleet</button>`;
  assert.equal([ui.btn({ kind: "confirm", label: "Confirm" }), ui.btn({ kind: "ghost", label: "Cancel" }), ui.btn({ kind: "confirm-paid", label: "Re-run for up to $2.00" }), ui.btn({ kind: "confirm-danger", label: "Pause the fleet" })].map(out).join(""), act);
  // FleetScreen's round pause button: the icon alone, its label the accessible name.
  assert.equal(out(ui.btn({ kind: ["sm", "round"], icon: "pause", label: "Pause build3" })), fromCard(`<button class="btn btn--sm btn--round" type="button" aria-label="Pause build3"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-pause"/></svg></button>`));
  assert.equal(out(ui.btn({ kind: ["primary", "lg"], label: "Sign in", type: "submit", id: "sign-in", name: "go", value: "1" })), `<button class="btn btn--primary btn--lg" type="submit" id="sign-in" name="go" value="1">Sign in</button>`);
  assert.equal(out(ui.btn({ kind: ["sm", "ghost"], label: "Undo", href: "/config", disabled: true })), `<a class="btn btn--sm btn--ghost" aria-disabled="true">Undo</a>`, "a disabled link has no target");
});

test("tabs and seg: the Spend views and the Configuration sections as tabs, the Parked filter as a segmented control", () => {
  // SpendScreen's tabs, less its page class `sp-tabs` (page CSS is the page's, not the kit's).
  const spend = `<nav class="tabs" aria-label="Spend views"><a href="/insights" aria-current="page"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-spend"/></svg>Spend</a><a href="/insights/budget-split"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-pie"/></svg>Budget split</a><a href="/insights/capacity"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-slot"/></svg>Capacity</a><a href="/insights/breakdown"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-runs"/></svg>Breakdown</a><a href="/insights/flows"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-flows"/></svg>Flows map</a></nav>`;
  const items = [["/insights", "spend", "Spend"], ["/insights/budget-split", "pie", "Budget split"], ["/insights/capacity", "slot", "Capacity"], ["/insights/breakdown", "runs", "Breakdown"], ["/insights/flows", "flows", "Flows map"]].map(([href, icon, label], i) => ({ href, icon, label, current: i === 0 }));
  assert.equal(out(ui.tabs(items, { label: "Spend views" })), fromCard(spend));
  assert.equal(out(ui.tabs([{ href: "#cf-triggers", label: "Triggers", count: 7 }, { href: "#cf-settings", label: "Settings", count: 13, current: true }], { label: "Sections" })), `<nav class="tabs" aria-label="Sections"><a href="#cf-triggers">Triggers<span class="count">7</span></a><a href="#cf-settings" aria-current="page">Settings<span class="count">13</span></a></nav>`);
  // ParkedPhone's control, with `type="button"` added: a button in a form submits it otherwise.
  assert.equal(out(ui.seg([{ label: "Questions", count: 1, on: true }, { label: "Approvals", count: 1 }], { label: "Show" })), `<div class="seg" role="group" aria-label="Show"><button type="button" aria-pressed="true">Questions <b>1</b></button><button type="button" aria-pressed="false">Approvals <b>1</b></button></div>`);
  assert.equal(out(ui.seg([{ label: "1h", href: "/?zoom=1h" }, { label: "3h", href: "/?zoom=3h", on: true }], { label: "Zoom" })), `<div class="seg" role="group" aria-label="Zoom"><a href="/?zoom=1h">1h</a><a href="/?zoom=3h" aria-current="page">3h</a></div>`);
});

// ---- cards and notices ------------------------------------------------------------------------------------------------------

test("card, kpi and big: CardsAndBanners' cards drawn inside a panel, never as it", () => {
  // The card's sample is `<section class="card" id="p-waiting" data-panel>`; the kit's card is the div inside the panel.
  const inLine = `<div class="card">
  <div class="card__head"><h2>In line</h2><span class="end"><span class="chip">longest 2h 14m</span></span></div>
  <p class="kpi"><b>5</b><span>jobs waiting to start</span></p></div>`;
  assert.equal(out(ui.card({ title: "In line", end: ui.chip("longest 2h 14m"), body: ui.kpi("5", "jobs waiting to start") })), tight(inLine));
  const spend = `<div class="card">
  <div class="card__head"><h2>Spend today</h2><span class="end"><span class="chip tone-ok">60% of cap</span></span></div>
  <p class="kpi"><b>$15.04</b><span>of $25.00</span></p></div>`;
  assert.equal(out(ui.card({ title: "Spend today", end: ui.chip("60% of cap", { status: "ok" }), body: ui.kpi("$15.04", "of $25.00") })), tight(spend));
  // The DataTable card's flush card, as an article; a tinted and a ringed card in one status.
  assert.equal(out(ui.card({ title: "Runs", sub: "last 24 hours", flush: true, tag: "article", body: html`<p>x</p>` })), `<article class="card card--flush"><div class="card__head"><h2>Runs</h2><span class="card__sub">last 24 hours</span></div><p>x</p></article>`);
  assert.equal(out(ui.card({ tint: "parked", ring: "parked", body: "x" })), `<div class="card card--tint card--ring tone-parked">x</div>`);
  assert.equal(out(ui.card({ body: "x" })), `<div class="card">x</div>`, "no head without a title, a sub or an end");
  assert.equal(out(ui.kpi("4")), `<p class="kpi"><b>4</b></p>`);
  // The Needs-you pair: the card writes `href` before `class`; the kit writes `class` first.
  assert.equal(out(ui.big({ n: 1, label: "question", status: "parked", href: "/parked", trend: "up" })), `<a class="big tone-parked" href="/parked"><span class="big__n"><span class="tri"></span>1</span><span class="big__l">question</span></a>`);
  assert.equal(out(ui.big({ n: 3, label: "to fix", status: "failed", href: "/runs?outcome=failed", trend: "down" })), `<a class="big tone-failed" href="/runs?outcome=failed"><span class="big__n"><span class="tri tri--down"></span>3</span><span class="big__l">to fix</span></a>`);
  assert.equal(out(ui.big({ n: 0, label: "waiting" })), `<span class="big"><span class="big__n">0</span><span class="big__l">waiting</span></span>`);
});

test("banner, empty and collapsed: CardsAndBanners' notices", () => {
  const done = `<div class="banner tone-ok" role="status">
  <span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-done"/></svg></span>
  <div><p class="banner__t">Changed maxTurns from 30 to 40</p><p class="banner__s">Audit row 7. <b>Undo:</b> set maxTurns back to 30.</p></div>
  <div class="banner__act"><a class="btn btn--sm btn--ghost" href="#">Undo</a></div>
</div>`;
  assert.equal(out(ui.banner({ status: "ok", title: "Changed maxTurns from 30 to 40", body: html`Audit row 7. <b>Undo:</b> set maxTurns back to 30.`, actions: ui.btn({ kind: ["sm", "ghost"], label: "Undo", href: "/config" }) })), tight(hrefs(done, "/config")));
  const retry = `<div class="banner banner--sm tone-attention" role="status">
  <span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-beat"/></svg></span>
  <div><p class="banner__t">Console not reachable, retrying</p><p class="banner__s">The page stays as it was. Live panels resume when the console answers.</p></div>

</div>`;
  assert.equal(out(ui.banner({ status: "attention", sm: true, icon: "beat", title: "Console not reachable, retrying", body: "The page stays as it was. Live panels resume when the console answers." })), tight(retry));
  const noWorker = `<div class="banner banner--sm tone-failed" role="status">
  <span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-fleet"/></svg></span>
  <div><p class="banner__t">No worker online</p><p class="banner__s">No host has sent a heartbeat for 2 minutes, so nothing will start.</p></div>
  <div class="banner__act"><a class="btn btn--sm" href="#">Open Fleet</a></div>
</div>`;
  assert.equal(out(ui.banner({ status: "failed", sm: true, icon: "fleet", title: "No worker online", body: "No host has sent a heartbeat for 2 minutes, so nothing will start.", actions: [ui.btn({ kind: "sm", label: "Open Fleet", href: "/fleet" })] })), tight(hrefs(noWorker, "/fleet")));
  assert.equal(out(ui.banner({ status: "cancelled", title: "Signed out", actions: [] })), `<div class="banner tone-idle" role="status"><span class="tile"><svg class="ic" aria-hidden="true"><use href="#i-cancel"></use></svg></span><div><p class="banner__t">Signed out</p></div></div>`);
  const allClear = `<div class="empty"><span class="tile tone-ok"><svg class="ic" aria-hidden="true"><use href="#i-done"/></svg></span><b>All clear</b><span>No questions, failures or refusals in the last 24 hours.</span></div>`;
  assert.equal(out(ui.empty({ status: "ok", title: "All clear", body: "No questions, failures or refusals in the last 24 hours." })), fromCard(allClear));
  const lines = `<p class="collapsed"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-runs"/></svg><b>Chain</b> no parent, no children</p><p class="collapsed"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-queue"/></svg><b>Run record, tokens and resources</b> are written when the run ends</p>`;
  assert.equal([ui.collapsed({ icon: "runs", title: "Chain", body: "no parent, no children" }), ui.collapsed({ icon: "queue", title: "Run record, tokens and resources", body: "are written when the run ends" })].map(out).join(""), fromCard(lines));
});

test("withCode: a catalog sentence's backticked runs in the code face, every run escaped, an unclosed backtick refused", () => {
  assert.equal(out(ui.withCode("An operator should run `pi-dispatch doctor` on the host.")), 'An operator should run <span class="code">pi-dispatch doctor</span> on the host.');
  assert.equal(out(ui.withCode("`a` and `b`")), '<span class="code">a</span> and <span class="code">b</span>');
  assert.equal(out(ui.withCode("no code here")), "no code here", "a sentence with none is itself");
  assert.equal(out(ui.withCode("")), "");
  // Each run, in the code face or not, is text: escaped and scrubbed, so a catalog cannot carry markup this way.
  assert.equal(out(ui.withCode(`${HOSTILE} \`${HOSTILE}\``)), `${ESCAPED} <span class="code">${ESCAPED}</span>`);
  for (const bad of ["one ` alone", "`a` and `b", "```"]) assert.throws(() => ui.withCode(bad), RangeError, bad);
});

// ---- tables -------------------------------------------------------------------------------------------------------------------

const RUN_HEADS = [{ label: "When", l: "" }, "Job", "Target", "Project", "Flow", "Host", "Venue", "Outcome", { label: "Tokens", num: true }, { label: "Cost", num: true }];

test("tbl: the DataTable card's runs, stacked on a phone with each cell labelled from its column, ids that never break", () => {
  const rows = [
    [{ when: true, html: "15:30" }, { id: true, html: html`<a href="/run?id=gh-e9a0">gh-e9a0</a>` }, { tgt: true, wide: true, html: html`<a href="/runs?target=acme%2Fbilling%23260">acme/billing#260</a>` }, ui.ptag("billing"), "fix", "build3", ui.vtag("podman"), { wide: true, html: html`${ui.outcomeBadge("policy", "egress-proxy-down")}<span class="reason">Refused: the egress proxy is not running on build3.</span>` }, "-", "not metered"],
    [{ when: true, html: "15:25" }, { id: true, html: "gh-a91e" }, { tgt: true, wide: true, html: "acme/web#422" }, ui.ptag("web"), "fix", "mini2", ui.vtag("openshell"), { wide: true, html: ui.outcomeBadge("completed") }, "85,577", "$0.17"],
  ];
  // The card's head cells have no scope and its other cells no `data-l`: the kit names every column (`scope="col"`) and
  // labels every stacked cell from its head, the When column with the empty label the card gives it.
  const want = `<div class="tbl-wrap"><table class="tbl tbl--stack" aria-label="Runs"><thead><tr><th scope="col">When</th><th scope="col">Job</th><th scope="col">Target</th><th scope="col">Project</th><th scope="col">Flow</th><th scope="col">Host</th><th scope="col">Venue</th><th scope="col">Outcome</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th></tr></thead><tbody>`
    + `<tr><td class="when" data-l="">15:30</td><td class="id" data-l="Job"><span class="code"><a href="/run?id=gh-e9a0">gh-e9a0</a></span></td><td class="tgt wide" data-l="Target"><a href="/runs?target=acme%2Fbilling%23260">acme/billing#260</a></td><td data-l="Project"><span class="ptag">billing</span></td><td data-l="Flow">fix</td><td data-l="Host">build3</td><td data-l="Venue"><span class="vtag">podman</span></td><td class="wide" data-l="Outcome"><span class="badge tone-refused"><svg class="ic" aria-hidden="true"><use href="#i-refused"></use></svg>Refused</span><span class="reason">Refused: the egress proxy is not running on build3.</span></td><td class="num" data-l="Tokens">-</td><td class="num" data-l="Cost">not metered</td></tr>`
    + `<tr><td class="when" data-l="">15:25</td><td class="id" data-l="Job"><span class="code">gh-a91e</span></td><td class="tgt wide" data-l="Target">acme/web#422</td><td data-l="Project"><span class="ptag">web</span></td><td data-l="Flow">fix</td><td data-l="Host">mini2</td><td data-l="Venue"><span class="vtag">openshell</span></td><td class="wide" data-l="Outcome"><span class="badge tone-ok"><svg class="ic" aria-hidden="true"><use href="#i-done"></use></svg>Completed</span></td><td class="num" data-l="Tokens">85,577</td><td class="num" data-l="Cost">$0.17</td></tr>`
    + `</tbody></table></div>`;
  assert.equal(out(ui.tbl({ label: "Runs", heads: RUN_HEADS, rows, stack: true })), want);
});

test("tbl: a caption instead of a label, a marked row, a cell hidden on a phone, and the empty case", () => {
  const t = out(ui.tbl({ caption: "Audit log", heads: [{ label: "Seq", num: true }, "Who", { label: "Note", hidePhone: true }], rows: [{ cells: [7, "ops", "x"], mark: "failed" }, [8, { html: "watcher", hidePhone: true }, null]] }));
  assert.equal(t, `<div class="tbl-wrap"><table class="tbl"><caption class="sr">Audit log</caption><thead><tr><th scope="col" class="num">Seq</th><th scope="col">Who</th><th scope="col">Note</th></tr></thead><tbody><tr class="row--failed"><td class="num">7</td><td>ops</td><td class="hide-phone">x</td></tr><tr><td class="num">8</td><td class="hide-phone">watcher</td><td class="hide-phone"></td></tr></tbody></table></div>`);
  assert.equal(out(ui.tbl({ label: "Runs", heads: RUN_HEADS, rows: [], empty: "No runs in the last 24 hours." })), `<p class="note">No runs in the last 24 hours.</p>`);
  const none = ui.empty({ status: "ok", title: "All clear" });
  assert.equal(out(ui.tbl({ label: "Runs", heads: RUN_HEADS, rows: [], empty: none })), String(none), "a fragment is drawn as it is");
  assert.equal(out(ui.tbl({ label: "Runs", heads: ["A"], rows: [] })), `<div class="tbl-wrap"><table class="tbl" aria-label="Runs"><thead><tr><th scope="col">A</th></tr></thead><tbody></tbody></table></div>`);
  // A head written as markup has no phone label (its markup is not a word to print before a cell), unless `l` gives
  // one (review mutant K5).
  const marked = out(ui.tbl({ label: "t", heads: [html`<span class="sr">Actions</span>`, { label: html`<b>Job</b>`, l: "Job" }], rows: [["x", "y"]], stack: true }));
  assert.equal(marked, `<div class="tbl-wrap"><table class="tbl tbl--stack" aria-label="t"><thead><tr><th scope="col"><span class="sr">Actions</span></th><th scope="col"><b>Job</b></th></tr></thead><tbody><tr><td data-l="">x</td><td data-l="Job">y</td></tr></tbody></table></div>`);
});

test("tbl: a row id, held to the kit's id rule, so a link can open the page at a row (the audit log's #seq-41)", () => {
  const t = out(ui.tbl({ caption: "Audit log", heads: ["Seq", "Who"], rows: [{ cells: [41, "ops"], id: "seq-41" }, { cells: [40, "x"], mark: "failed", id: "line-2026-10-5" }, { cells: [39, "y"], id: null }] }));
  assert.ok(t.includes(`<tbody><tr id="seq-41"><td>41</td><td>ops</td></tr><tr id="line-2026-10-5" class="row--failed"><td>40</td><td>x</td></tr><tr><td>39</td><td>y</td></tr></tbody>`), t);
  // Reserved, family, malformed: each refused like any kit id; and a row option the kit does not know throws.
  for (const id of ["main", "confirm-slot", "live-note", "held-note", "p-audit", "i-runs", "n3", "Seq-1", "a b", "", 7]) {
    assert.throws(() => ui.tbl({ label: "t", heads: ["a"], rows: [{ cells: ["x"], id }] }), RangeError, String(id));
  }
  assert.throws(() => ui.tbl({ label: "t", heads: ["a"], rows: [{ cells: ["x"], klass: "x" }] }), /unknown row option "klass"/);
});

test("tblFoot and pager: the DataTable card's foot, and a pager at the first page", () => {
  // The card writes the foot as a `<p>`; the kit's is a `div`, so a foot may hold more than a line of text.
  const card = `<p class="tbl-foot">5 of 27 runs<span class="pager"><a class="btn btn--sm btn--ghost" href="#">Newer</a><a class="btn btn--sm" href="#">Older</a></span></p>`;
  const kit = out(ui.tblFoot("5 of 27 runs", ui.pager({ newer: "/runs?before=b", older: "/runs?after=a" })));
  assert.equal(kit, hrefs(card, "/runs?before=b", "/runs?after=a").replace(/^<p /, "<div ").replace(/<\/p>$/, "</div>"));
  assert.equal(out(ui.pager({ older: "/audit?before=41", olderLabel: "Older rows" })), `<span class="pager"><a class="btn btn--sm btn--ghost" aria-disabled="true">Newer</a><a class="btn btn--sm" href="/audit?before=41">Older rows</a></span>`);
});

// ---- facts and levels ---------------------------------------------------------------------------------------------------------

test("facts: the FactsAndLevels card's grid, and its one- and three-column forms", () => {
  const card = `<dl class="facts"><div class="fact"><dt>Job</dt><dd><span class="code">gh-b3d7</span></dd></div><div class="fact"><dt>Target</dt><dd><a class="link" href="#">acme/web#415</a></dd></div><div class="fact"><dt>Project</dt><dd><span class="ptag">web</span></dd></div><div class="fact"><dt>Venue</dt><dd><span class="vtag">local</span></dd></div><div class="fact"><dt>Host</dt><dd>mini1</dd></div><div class="fact"><dt>Model</dt><dd>anthropic / claude-sonnet-5-5</dd></div><div class="fact"><dt>Started</dt><dd>15:27 UTC</dd></div><div class="fact"><dt>Size</dt><dd>2,048 MiB, 1 CPU</dd></div></dl>`;
  const pairs = [["Job", html`<span class="code">gh-b3d7</span>`], ["Target", html`<a class="link" href="https://github.com/acme/web/issues/415">acme/web#415</a>`], ["Project", ui.ptag("web")], ["Venue", ui.vtag("local")], ["Host", "mini1"], ["Model", "anthropic / claude-sonnet-5-5"], ["Started", "15:27 UTC"], ["Size", "2,048 MiB, 1 CPU"]];
  assert.equal(out(ui.facts(pairs)), hrefs(card, "https://github.com/acme/web/issues/415"));
  assert.equal(out(ui.facts([["Host", null], ["Turns", 0]], { cols: 1 })), `<dl class="facts facts--1"><div class="fact"><dt>Host</dt><dd>-</dd></div><div class="fact"><dt>Turns</dt><dd>0</dd></div></dl>`);
  assert.equal(out(ui.facts([["a", "b"]], { cols: 3 })), `<dl class="facts facts--3"><div class="fact"><dt>a</dt><dd>b</dd></div></dl>`);
});

test("meter: the FactsAndLevels card's three meters against caps, the hold tick at 80%, the tone by the meter rule", () => {
  const card = [
    `<svg class="pbar tone-ok" height="10" role="meter" aria-valuenow="63" aria-valuemax="100" aria-label="Jobs today: 25 of 40"><rect class="pbar__bed" width="100%" height="10" rx="5"/><rect class="pbar__fill" width="62.5%" height="10" rx="5"/><line class="pbar__hold" x1="80%" x2="80%" y1="-3" y2="13"/></svg>`,
    `<svg class="pbar tone-attention" height="10" role="meter" aria-valuenow="86" aria-valuemax="100" aria-label="Dollars deployment today: $21.50 of $25.00"><rect class="pbar__bed" width="100%" height="10" rx="5"/><rect class="pbar__fill" width="86.0%" height="10" rx="5"/><line class="pbar__hold" x1="80%" x2="80%" y1="-3" y2="13"/></svg>`,
    `<svg class="pbar tone-failed" height="10" role="meter" aria-valuenow="100" aria-valuemax="100" aria-label="Tokens today: 8.00M of 8.00M"><rect class="pbar__bed" width="100%" height="10" rx="5"/><rect class="pbar__fill" width="100.0%" height="10" rx="5"/><line class="pbar__hold" x1="80%" x2="80%" y1="-3" y2="13"/></svg>`,
  ];
  // What the kit adds: the meter's minimum, and every number through the one formatter (`rx="5.0"`, `80.0%`).
  const kitOf = (s) => s.replace(" aria-valuemax", ` aria-valuemin="0" aria-valuemax`).replace(/rx="5"/g, `rx="5.0"`).replace(/"80%"/g, `"80.0%"`);
  assert.equal(out(ui.meter({ value: 25, max: 40, hold: 80, label: "Jobs today: 25 of 40" })), kitOf(card[0]));
  assert.equal(out(ui.meter({ value: 21.5, max: 25, hold: 80, label: "Dollars deployment today: $21.50 of $25.00" })), kitOf(card[1]));
  assert.equal(out(ui.meter({ value: 8e6, max: 8e6, hold: 80, label: "Tokens today: 8.00M of 8.00M" })), kitOf(card[2]));
  // Without a hold there is no tick; a given status wins; a runaway or missing value is clamped, never written raw.
  assert.equal(out(ui.meter({ value: 3, max: 4, label: "x", status: "running", height: 8 })), `<svg class="pbar tone-running" height="8" role="meter" aria-valuenow="75" aria-valuemin="0" aria-valuemax="100" aria-label="x"><rect class="pbar__bed" width="100%" height="8" rx="4.0"/><rect class="pbar__fill" width="75.0%" height="8" rx="4.0"/></svg>`);
  assert.match(out(ui.meter({ value: 90, max: 40, label: "over" })), /tone-failed.*aria-valuenow="100".*class="pbar__fill" width="100\.0%"/);
  assert.match(out(ui.meter({ value: Number.NaN, max: 0, label: "unknown", height: Infinity })), /tone-ok" height="4".*aria-valuenow="0".*rx="2\.0".*width="0\.0%"/);
});

test("meter and ring at their edges: exactly at the hold, a zero cap, a hold, a stroke and a height out of range (review mutants K1-K4, K8, K14)", () => {
  const toneOf = (s) => /class="(?:pbar|ring) tone-([a-z]+)"/.exec(s)[1];
  // Exactly at the hold is attention, just under it ok, exactly at the cap failed: the meter rule's `>=`, both sides.
  assert.equal(toneOf(out(ui.meter({ value: 80, max: 100, hold: 80, label: "x" }))), "attention");
  assert.equal(toneOf(out(ui.meter({ value: 79.9, max: 100, hold: 80, label: "x" }))), "ok");
  assert.equal(toneOf(out(ui.ring({ value: 80, max: 100, hold: 80, label: "x" }))), "attention");
  assert.equal(toneOf(out(ui.meter({ value: 40, max: 40, label: "x" }))), "failed");
  // A zero (or negative) cap draws nothing used and is not a breach: 0%, ok, never 100% failed.
  for (const max of [0, -5]) {
    const m = out(ui.meter({ value: 5, max, hold: 80, label: "no cap" }));
    assert.equal(toneOf(m), "ok", `max ${max}`);
    assert.match(m, /aria-valuenow="0".*class="pbar__fill" width="0\.0%"/, `max ${max}`);
    const r = out(ui.ring({ value: 5, max, label: "no cap" }));
    assert.equal(toneOf(r), "ok", `ring max ${max}`);
    assert.match(r, /stroke-dasharray="0\.0 100"/, `ring max ${max}`);
  }
  // A hold outside 0-100 is drawn at the nearer end, on the bar and on the ring.
  const tickX = (s) => /class="pbar__hold" x1="([^"]+)" x2="([^"]+)"/.exec(s).slice(1);
  assert.deepEqual(tickX(out(ui.meter({ value: 1, max: 2, hold: 150, label: "x" }))), ["100.0%", "100.0%"]);
  assert.deepEqual(tickX(out(ui.meter({ value: 1, max: 2, hold: -20, label: "x" }))), ["0.0%", "0.0%"]);
  const ringTick = (hold) => /<line class="ring__hold"[^>]*\/>/.exec(out(ui.ring({ value: 1, max: 2, hold, label: "x" })))[0];
  assert.equal(ringTick(150), ringTick(100), "a hold past 100 is the tick at 100");
  assert.equal(ringTick(-50), ringTick(0), "a hold under 0 is the tick at 0");
  assert.equal(ringTick(100), `<line class="ring__hold" x1="48.0" y1="10.0" x2="48.0" y2="-1.0"/>`, "both at the top, where the arc starts");
  // A stroke wider than a quarter of the ring is a quarter; a height past 24 is 24.
  const thick = out(ui.ring({ value: 1, max: 2, size: 96, stroke: 60, label: "x" }));
  assert.match(thick, /<circle class="ring__track" cx="48\.0" cy="48\.0" r="36\.0" stroke-width="24"\/>/);
  assert.match(out(ui.ring({ value: 1, max: 2, size: 96, stroke: 0, label: "x" })), /r="47\.5" stroke-width="1"/, "and at least 1");
  const tall = out(ui.meter({ value: 1, max: 2, height: 100, hold: 60, label: "x" }));
  assert.match(tall, /<svg class="pbar tone-ok" height="24" [^>]*><rect class="pbar__bed" width="100%" height="24" rx="12\.0"\/><rect class="pbar__fill" width="50\.0%" height="24" rx="12\.0"\/><line class="pbar__hold" x1="60\.0%" x2="60\.0%" y1="-3" y2="27"\/><\/svg>/);
});

test("ring: the FactsAndLevels card's three rings, as meters", () => {
  const card = [
    `<svg class="ring tone-ok" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="60%"><circle class="ring__track" cx="48.0" cy="48.0" r="43.5" stroke-width="9"/><circle class="ring__arc" cx="48.0" cy="48.0" r="43.5" stroke-width="9" pathLength="100" stroke-dasharray="60.0 100" transform="rotate(-90 48.0 48.0)"/><line class="ring__hold" x1="11.9" y1="36.3" x2="1.4" y2="32.9"/></svg>`,
    `<svg class="ring tone-attention" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="86%"><circle class="ring__track" cx="48.0" cy="48.0" r="43.5" stroke-width="9"/><circle class="ring__arc" cx="48.0" cy="48.0" r="43.5" stroke-width="9" pathLength="100" stroke-dasharray="86.0 100" transform="rotate(-90 48.0 48.0)"/><line class="ring__hold" x1="11.9" y1="36.3" x2="1.4" y2="32.9"/></svg>`,
    `<svg class="ring tone-failed" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="100%"><circle class="ring__track" cx="48.0" cy="48.0" r="43.5" stroke-width="9"/><circle class="ring__arc" cx="48.0" cy="48.0" r="43.5" stroke-width="9" pathLength="100" stroke-dasharray="100.0 100" transform="rotate(-90 48.0 48.0)"/><line class="ring__hold" x1="11.9" y1="36.3" x2="1.4" y2="32.9"/></svg>`,
  ];
  // The card's rings are images with a percentage for a name; the kit's are meters, with the value and its range.
  const kitOf = (s, v) => s.replace(`role="img"`, `role="meter" aria-valuenow="${v}" aria-valuemin="0" aria-valuemax="100"`);
  assert.equal(out(ui.ring({ value: 60, max: 100, hold: 80, label: "60%" })), kitOf(card[0], 60));
  assert.equal(out(ui.ring({ value: 86, max: 100, hold: 80, label: "86%" })), kitOf(card[1], 86));
  assert.equal(out(ui.ring({ value: 100, max: 100, hold: 80, label: "100%" })), kitOf(card[2], 100));
  assert.equal(out(ui.ring({ value: 1, max: 4, label: "a quarter", size: 88, stroke: 8 })), `<svg class="ring tone-ok" width="88" height="88" viewBox="0 0 88 88" role="meter" aria-valuenow="25" aria-valuemin="0" aria-valuemax="100" aria-label="a quarter"><circle class="ring__track" cx="44.0" cy="44.0" r="40.0" stroke-width="8"/><circle class="ring__arc" cx="44.0" cy="44.0" r="40.0" stroke-width="8" pathLength="100" stroke-dasharray="25.0 100" transform="rotate(-90 44.0 44.0)"/></svg>`);
});

test("svgNum: finite, clamped, fixed decimals, and never a negative zero", () => {
  assert.equal(ui.svgNum(62.5, 0, 100), "62.5");
  assert.equal(ui.svgNum(80, 0, 100), "80.0");
  assert.equal(ui.svgNum(250, 0, 100), "100.0");
  assert.equal(ui.svgNum(-5, 0, 100, 0), "0");
  assert.equal(ui.svgNum(-0.04, -1, 1), "0.0");
  for (const bad of [Number.NaN, Infinity, -Infinity, "50", null, undefined]) assert.equal(ui.svgNum(bad, 3, 9, 1), "3.0", String(bad));
});

// ---- forms ----------------------------------------------------------------------------------------------------------------------

test("field, input, select and textarea: the FieldsDiffCommand card's fields, the error tied to its control", () => {
  assert.equal(out(ui.field({ label: "Key", id: "f1", control: ui.select({ id: "f1", options: ["maxTurns"] }) })), `<div class="field"><label for="f1">Key</label><select id="f1" class="select"><option>maxTurns</option></select></div>`);
  assert.equal(out(ui.field({ label: "Value", id: "f2", control: ui.input({ id: "f2", value: "40" }) })), `<div class="field"><label for="f2">Value</label><input id="f2" class="input" value="40"></div>`);
  // The card's error field, with the error's id and the control's `aria-invalid` and `aria-describedby` added.
  const err = `<div class="field field--err"><label for="f3">Key</label><input id="f3" class="input input--code" value="colour"><p class="field__err"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-failed"/></svg>Unknown key colour. Valid keys: model, provider, maxTurns.</p></div>`;
  const kitErr = out(ui.field({ label: "Key", id: "f3", control: ui.input({ id: "f3", value: "colour", code: true, invalid: true, describedBy: "f3-err" }), error: "Unknown key colour. Valid keys: model, provider, maxTurns." }));
  assert.equal(kitErr, fromCard(err).replace(`value="colour">`, `value="colour" aria-invalid="true" aria-describedby="f3-err">`).replace(`<p class="field__err">`, `<p class="field__err" id="f3-err">`));
  assert.equal(out(ui.field({ label: "Your answer", id: "f4", control: ui.textarea({ id: "f4", placeholder: "Write your answer" }) })), `<div class="field"><label for="f4">Your answer</label><textarea id="f4" class="textarea" placeholder="Write your answer"></textarea></div>`);
  // A hint, the other input types and attributes, a select of values with one chosen.
  // (`#token` itself is the sign-in page's, which the script finds by name: a kit id may not be it.)
  assert.equal(out(ui.field({ label: "Token", id: "console-token", hint: "From pi-dispatch console token.", control: ui.input({ id: "console-token", name: "token", type: "password", autocomplete: "off", spellcheck: false, required: true, describedBy: ["console-token-hint", "notice"] }) })), `<div class="field"><label for="console-token">Token</label><input id="console-token" class="input" type="password" name="token" autocomplete="off" spellcheck="false" required aria-describedby="console-token-hint notice"><p class="field__hint" id="console-token-hint">From pi-dispatch console token.</p></div>`);
  assert.equal(out(ui.select({ id: "venue", name: "backend", options: [{ value: "", label: "Any" }, { value: "podman", label: "podman" }], value: "podman", disabled: true })), `<select id="venue" class="select" name="backend" disabled><option value="">Any</option><option value="podman" selected>podman</option></select>`);
  // No value chooses nothing, also not an option whose own value is missing (review mutant K9).
  assert.equal(out(ui.select({ id: "venue2", options: [{ value: null, label: "Any" }, { value: undefined, label: "None" }, "podman"] })), `<select id="venue2" class="select"><option value="">Any</option><option value="">None</option><option>podman</option></select>`);
  // A textarea keeps its text's line breaks, a leading one too; every other control byte is scrubbed.
  assert.equal(out(ui.textarea({ id: "a", name: "answer", rows: 4, value: "\nfirst\r\nsecond\tthird" })), `<textarea id="a" class="textarea" name="answer" rows="4">\n\nfirst\nsecond third</textarea>`);
});

test("cmd: the FieldsDiffCommand card's copy box, its Copy button hidden until the script can copy, and the host line under it", () => {
  // The card's button, with `data-copy` (the script's hook) and `hidden` (shown only where copying works) added; and
  // each argument in a span of its own (`words`), the spaces between them text, so the code's text is the card's line
  // and a wrapped line breaks between arguments, never after the dashes of `--name`.
  const words = (line) => line.split(" ").map((w) => `<span>${w}</span>`).join(" ");
  const card = `<div class="cmd"><code>pi-dispatch chat gh-b3d7</code><button class="btn btn--sm" type="button">Copy</button></div><p class="card__sub">Run this on a host that holds the session store.</p>`;
  assert.equal(out(ui.cmd(["pi-dispatch", "chat", "gh-b3d7"], { host: "Run this on a host that holds the session store." })), card.replace(`type="button">Copy`, `type="button" data-copy hidden>Copy`).replace("pi-dispatch chat gh-b3d7", words("pi-dispatch chat gh-b3d7")));
  assert.equal(out(ui.cmd(["pi-dispatch", "sandbox", "gh-e9a0"])), `<div class="cmd"><code><span>pi-dispatch</span> <span>sandbox</span> <span>gh-e9a0</span></code><button class="btn btn--sm" type="button" data-copy hidden>Copy</button></div>`);
  // The run-id charset, a recovery's id and a URL are plain words; nothing else is.
  assert.equal(out(ui.cmd(["pi-dispatch", "chat", "repeat:nightly-tidy:1760000000000", "gh-1.r1", "https://github.com/acme/web/issues/7", "--model=a/b@c+1%"])), `<div class="cmd"><code>${words("pi-dispatch chat repeat:nightly-tidy:1760000000000 gh-1.r1 https://github.com/acme/web/issues/7 --model=a/b@c+1%")}</code><button class="btn btn--sm" type="button" data-copy hidden>Copy</button></div>`);
  // A quoted argument holding spaces is one span: the box is the argument, whatever it holds.
  assert.ok(out(ui.cmd(["pi-dispatch", "two words"])).includes("<code><span>pi-dispatch</span> <span>&#39;two words&#39;</span></code>"));
});

/**
 * The text a `<code>` element holds, as the browser decodes it (what the Copy button copies): its argument spans'
 * text and the spaces between them. Every `<` inside is one of those spans' tags (an argument's own is `&lt;`).
 */
const codeText = (frag) => {
  const inner = /<code>((?:<span>[^<]*<\/span> ?)+)<\/code>/.exec(String(frag))[1];
  return inner.replace(/<\/?span>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
};

/**
 * A command line split back into its arguments by the rules a POSIX shell applies to what `cmd` writes: words split on
 * spaces, a `'...'` run taken as it is, `\x` as `x`. Any other character a shell reads specially, unquoted, fails: it
 * would be more shell, not an argument's letter.
 */
function shellArgs(line) {
  const words = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") {
      i += 1;
      continue;
    }
    let word = "";
    while (i < line.length && line[i] !== " ") {
      const c = line[i];
      if (c === "'") {
        const end = line.indexOf("'", i + 1);
        assert.ok(end > i, `an unclosed quote in ${line}`);
        word += line.slice(i + 1, end);
        i = end + 1;
      } else if (c === "\\") {
        word += line[i + 1];
        i += 2;
      } else {
        assert.match(c, /[A-Za-z0-9._/:@%+=-]/, `an unquoted ${JSON.stringify(c)} in ${line} would be read by the shell`);
        word += c;
        i += 1;
      }
    }
    words.push(word);
  }
  return words;
}

test("cmd: an argument list, each argument a plain word or POSIX single-quoted, so what is copied runs as exactly those arguments", () => {
  const argv = ["pi-dispatch", "chat", "gh-1; rm -rf ~", "a|b", "$(id)", "`id`", "it's", `"dq"`, "two words", "", "~root", "#c", "a\\b", "*", "&&", "x>y", "'"];
  // Not swept with the others (`out`): a backtick is a Unicode modifier symbol, and here it is the data, not a mark.
  const frag = ui.cmd(argv);
  assert.ok(isSafeHtml(frag));
  const line = codeText(frag);
  assert.equal(line, `pi-dispatch chat 'gh-1; rm -rf ~' 'a|b' '$(id)' '\`id\`' 'it'\\''s' '"dq"' 'two words' '' '~root' '#c' 'a\\b' '*' '&&' 'x>y' ''\\'''`);
  // What `sh -c 'printf "%s\n" <line>'` would print, one argument per line: the list given.
  assert.deepEqual(shellArgs(line), argv);
  // In the page the quotes are entities and the markup is text: nothing of an argument is a tag, each one span.
  assert.match(String(frag), /<code><span>pi-dispatch<\/span> <span>chat<\/span> <span>&#39;gh-1; rm -rf ~&#39;<\/span> (?:<span>[^<]*<\/span> )*<span>&#39;x&gt;y&#39;<\/span> <span>&#39;&#39;\\&#39;&#39;&#39;<\/span><\/code>/);
  assert.equal(String(frag).match(/<span>/g).length, argv.length, "a span per argument");
  // A control byte is scrubbed like any text's, and stays inside its argument's quotes.
  assert.deepEqual(shellArgs(codeText(ui.cmd(["pi-dispatch", `gh-1${String.fromCharCode(10)}id`]))), ["pi-dispatch", "gh-1 id"]);
  // `=` is a letter, except at an argument's start (zsh's `=name` is the path of the command name) and anywhere in the
  // first word (`NAME=value` there is an assignment, and the next word would run as the command).
  assert.equal(codeText(ui.cmd(["FOO=bar", "x", "a=b", "--model=a/b", "=ls", "=", "x="])), `'FOO=bar' x a=b --model=a/b '=ls' '=' x=`);
  assert.equal(codeText(ui.cmd(["=x"])), `'=x'`);
  assert.equal(codeText(ui.cmd(["pi-dispatch"])), "pi-dispatch");
  // A whole command line as one string, an empty list, and an argument that is not a string are refused.
  for (const bad of ["pi-dispatch chat gh-1", [], null, [7], ["pi-dispatch", null]]) assert.throws(() => ui.cmd(bad), TypeError, JSON.stringify(bad));
});

/**
 * Argument lists for the shell round trip: every character a shell reads specially, in and out of quotes, a leading
 * `=` and a first word holding one, and letters outside ASCII. No control byte and no character a reader would not
 * see as itself (a zero-width or a no-break space): `html` scrubs those to a space in all text (the unit test above
 * pins that for a control byte), so their copied argument is a space by design.
 */
const SHELL_CASES = Object.freeze([
  ["pi-dispatch", "chat", "gh-1; echo more"],
  ["pi-dispatch", "$(id)", "`id`", "$HOME", "${HOME}", "$"],
  ["pi-dispatch", "it's", "''", "'", `"dq"`],
  ["pi-dispatch", "a\\b", "\\", "\\'"],
  ["pi-dispatch", "*", "?", "[a]", "{a,b}", "a{b,c}d"],
  ["pi-dispatch", "!x", "!!", "^x"],
  ["pi-dispatch", "~", "~root", "a=~/x", "--p=~"],
  ["pi-dispatch", "=ls", "=pi-dispatch", "=nope-not-a-command", "="],
  ["pi-dispatch", "%1", "@x", "+x", "-x", "--", ":"],
  ["FOO=bar", "x", "a=b"],
  ["pi-dispatch", ""],
  ["pi-dispatch", " ", "two words"],
  ["pi-dispatch", "x#y", "#y", "a&b", "a|b", "a>b", "a<b", "(x)", "&&"],
  ["pi-dispatch", "\u00e9", "\u4e2d", "a\u00e9 b"],
  ["pi-dispatch", "repeat:nightly:1760000000000", "https://github.com/acme/web/issues/7", "--model=a/b@c+1%", "a=b"],
]);

test("cmd: each copied line, run by a real sh, bash and zsh, starts exactly its first word with exactly its arguments", async (t) => {
  // A program per first word, on a PATH of its own, that prints its own name and each argument it was given. The
  // copied line runs as typed (the shell parses it), so a word the shell expanded, split, globbed or took as an
  // assignment arrives changed or not at all. HOME and the working directory are this test's own, so a `~` that
  // expanded or a `>` that redirected touches nothing else.
  const dir = tempDir("console-kit-cmd-");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  for (const first of new Set(SHELL_CASES.map((argv) => argv[0]))) {
    writeFileSync(join(bin, first), `#!/bin/sh\nprintf '%s\\0' "\${0##*/}" "$@"\n`);
    chmodSync(join(bin, first), 0o755);
  }
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
  // zsh with -f reads no startup file; bash and sh started with -c read none without BASH_ENV/ENV, which env omits.
  for (const [shell, flags] of [["sh", []], ["bash", []], ["zsh", ["-f"]]]) {
    const present = spawnSync(shell, [...flags, "-c", "exit 0"], { env }).status === 0;
    await t.test(shell, { skip: present ? false : `${shell} is not installed on this machine, so its round trip cannot run here` }, () => {
      for (const argv of SHELL_CASES) {
        const line = codeText(ui.cmd(argv));
        const r = spawnSync(shell, [...flags, "-c", line], { env, cwd: dir, encoding: "utf8" });
        assert.deepEqual(r.stdout.split("\0").slice(0, -1), argv, `${shell} runs ${line} (status ${r.status}, ${JSON.stringify(r.stderr.slice(0, 200))})`);
      }
    });
  }
});

test("outLink: a link out of the console, rel and target stamped as the page rule reads them; userinfo, another scheme and any spelling the browser rewrites refused", () => {
  assert.equal(out(ui.outLink({ href: "https://github.com/acme/web/issues/415", label: "acme/web#415" })), `<a class="link" href="https://github.com/acme/web/issues/415" rel="noreferrer noopener" target="_blank">acme/web#415</a>`);
  assert.equal(out(ui.outLink({ href: "http://gitlab.internal:8080/g/p/-/issues/3", label: "g/p#3", code: true })), `<a class="link code" href="http://gitlab.internal:8080/g/p/-/issues/3" rel="noreferrer noopener" target="_blank">g/p#3</a>`);
  assert.equal(out(ui.outLink({ href: "https://x.example/?a=1&b=%22#f", label: HOSTILE })), `<a class="link" href="https://x.example/?a=1&amp;b=%22#f" rel="noreferrer noopener" target="_blank">${ESCAPED}</a>`);
  // Whatever forgeLinkOf and docsHref build, every forge and an instance URL with a port, a path, upper case and an
  // IPv6 literal, is a link outLink draws: the console's own builders and the kit's rule agree.
  const env = { GITLAB_URL: "http://[::1]:8080/gl/", FORGEJO_URL: "https://Forge.Example.COM:3000", AZURE_ORG_URL: "http://azure_devops:8080/acme" };
  const built = [
    ...[["github", "acme/web#7"], ["gitlab", "grp/sub/proj#3"], ["gitlab", "grp/proj!4"], ["forgejo", "o/r#5"], ["azure", "proj/repo#6"], ["azure", "proj/repo!8"]].map(([kind, target]) => forgeLinkOf({ kind, target }, env)),
    docsHref("docs/reasons.md#scope-cap"),
    docsHref("docs/console.md"),
  ];
  assert.ok(built.every((u) => typeof u === "string"), JSON.stringify(built));
  assert.ok(built.includes("http://[::1]:8080/gl/grp/proj/-/merge_requests/4") && built.includes("https://forge.example.com:3000/o/r/issues/5"), JSON.stringify(built));
  assert.ok(built.at(-1).startsWith(DOCS_ROOT));
  for (const href of built) assert.ok(out(ui.outLink({ href, label: "x" })).includes(`href="${href}"`), href);
  // An instance URL an operator spelled oddly still builds a link outLink draws: forgeLinkOf writes the parser's own
  // origin (127.1 is 127.0.0.1 there, a default port is dropped), and a canonical odd name is the name the browser
  // opens.
  const odd = { GITLAB_URL: "http://127.1:80/a//b/", FORGEJO_URL: "https://Git.Example..COM./", AZURE_ORG_URL: "https://[0:0::1]:443/org" };
  const oddBuilt = [["gitlab", "g/p#3"], ["forgejo", "o/r#5"], ["azure", "proj/repo!8"]].map(([kind, target]) => forgeLinkOf({ kind, target }, odd));
  assert.deepEqual(oddBuilt, ["http://127.0.0.1/a//b/g/p/-/issues/3", "https://git.example..com./o/r/issues/5", "https://[::1]/org/proj/_git/repo/pullrequest/8"]);
  for (const href of oddBuilt) assert.ok(out(ui.outLink({ href, label: "x" })).includes(`href="${href}"`), href);
  // Canonical URLs are drawn whatever their host looks like: an @ in the path is no user name, punycode is ASCII.
  for (const href of ["https://1.2.3.4/x", "https://[::1]/", "https://x.example:8080/", "http://gitlab_web:8080/x", "https://x.example/@evil.example", "https://xn--80ak6aa92e.com/", "https://x.example/'q'"]) {
    assert.ok(out(ui.outLink({ href, label: "x" })).includes(`href="${href.replace(/'/g, "&#39;")}"`), href);
  }
  const TAB = String.fromCharCode(9);
  const LF = String.fromCharCode(10);
  for (const bad of [
    // A user name or a password: the host after the @ is the one opened.
    "https://github.com@evil.example/",
    "https://user:pw@evil.example/x",
    "https://:pw@evil.example/x",
    "https://github.com:443@evil.example/",
    "https://evil.example\\@github.com/",
    // Another scheme, or no URL at all.
    "javascript:alert(1)",
    "data:text/html,x",
    "ftp://x.example/",
    "ws://x.example/",
    "//evil.example/",
    "/runs",
    "#main",
    "https://",
    null,
    // Review round 2: hosts the parser reads as another, a numeric or shorthand IPv4 address and a rewritten IPv6 one.
    "https://2130706433/",
    "https://0x7f.1/",
    "https://127.1/",
    "https://01.2.3.4/",
    "https://[::ffff:127.0.0.1]/",
    "https://[0:0::1]/",
    "https://[:]/",
    "https://[1:2:3:4:5:6:7:8:9]/",
    "https://[fe80::1%25en0]/",
    "https://x.example%2Eevil/",
    "https://x%40y.example/",
    "https://\u0445.example/",
    // Ports the parser refuses, drops or rewrites, and a URL without its path.
    "https://x.example:99999/",
    "https://x.example:65536/",
    "https://x.example:/",
    "https://x.example:443/",
    "http://x.example:80/",
    "https://x.example:080/",
    "https://x.example:8080",
    "https://x.example#@evil.example",
    "https://x.example?@evil.example",
    // Case, slashes and backslashes the parser rewrites.
    "HTTPS://x.example/",
    "Https://x.example/",
    "https://X.example/",
    "https://GitHub.com/acme/web/issues/1",
    "https:x.example/",
    "https:/x.example/",
    "https:\\\\x.example/",
    "https://x.example\\evil/",
    "https://x.example/\\evil",
    // A dot segment, whitespace, a quote or a bracket the parser drops or escapes.
    "https://x.example/%2e%2e/%2e%2e/",
    "https://x.example/a/../b",
    `https://x.example/a${TAB}b`,
    `https://x.ex${TAB}ample/`,
    `https://x.example/a${LF}b`,
    `https://x.example/${LF}`,
    "https://x y.example/",
    "https://x.example/a b",
    'https://x.example/"onmouseover=x',
    "https://x.example/<x>",
    "https://x.example/a`b",
    "https://x.example/?q=a b",
    "https://x.example/#a b",
  ]) {
    assert.throws(() => ui.outLink({ href: bad, label: "x" }), RangeError, JSON.stringify(bad));
  }
});

test("pageHref: a page's path with its query, from a PAGES-shaped table, null for a page it does not have", () => {
  const pages = { runs: { path: "/runs" }, overview: { path: "/" } };
  assert.equal(ui.pageHref(pages, "runs"), "/runs");
  assert.equal(ui.pageHref(pages, "runs", { outcome: ["failed", "policy"], project: "web", q: null, since: "" }), "/runs?outcome=failed&outcome=policy&project=web");
  assert.equal(ui.pageHref(pages, "overview", new URLSearchParams({ zoom: "3h" })), "/?zoom=3h");
  assert.equal(ui.pageHref(pages, "runs", { target: "acme/web#1 & <x>" }), "/runs?target=acme%2Fweb%231+%26+%3Cx%3E");
  for (const name of ["models", "__proto__", "toString", null]) assert.equal(ui.pageHref(pages, name), null, String(name));
  assert.equal(ui.pageHref(null, "runs"), null);
});

// ---- refusals ---------------------------------------------------------------------------------------------------------------------

test("an unknown status, icon, kind, size, tag, type, option or link THROWS: those come from code, never from a record", () => {
  const throwsRange = (fn, label) => assert.throws(fn, RangeError, label);
  for (const bad of ["warn", "success", "Running", "", "__proto__", "constructor", null, undefined, 1]) {
    if (bad !== null && bad !== undefined) throwsRange(() => ui.chip("x", { status: bad }), `chip ${String(bad)}`);
    throwsRange(() => ui.badge(bad, "x"), `badge ${String(bad)}`);
    throwsRange(() => ui.dot(bad), `dot ${String(bad)}`);
    throwsRange(() => ui.tile(bad), `tile ${String(bad)}`);
    throwsRange(() => ui.banner({ status: bad, title: "x" }), `banner ${String(bad)}`);
    throwsRange(() => ui.empty({ status: bad, title: "x" }), `empty ${String(bad)}`);
  }
  for (const bad of ["nope", "i-done", "Done", "", "__proto__", null]) {
    throwsRange(() => ui.icon(bad), `icon ${String(bad)}`);
    throwsRange(() => ui.badge("ok", "x", { icon: bad === null ? "x" : bad }), `badge icon ${String(bad)}`);
  }
  throwsRange(() => ui.collapsed({ title: "x" }), "collapsed needs its icon");
  throwsRange(() => ui.icon("done", { size: "xl" }));
  throwsRange(() => ui.count(1, "warning"));
  throwsRange(() => ui.btn({ kind: "huge", label: "x" }));
  throwsRange(() => ui.btn({ kind: ["sm", "secondary"], label: "x" }));
  throwsRange(() => ui.btn({ label: "x", type: "reset" }));
  assert.throws(() => ui.btn({ kind: "round", label: "Pause" }), TypeError, "a round button is its icon");
  throwsRange(() => ui.card({ tag: "section", body: "x" }), "a card is never the panel's section");
  throwsRange(() => ui.card({ tint: "ok", ring: "failed" }));
  throwsRange(() => ui.facts([], { cols: 4 }));
  throwsRange(() => ui.big({ n: 1, label: "x", trend: "sideways" }));
  throwsRange(() => ui.input({ id: "a", type: "file" }));
  throwsRange(() => ui.input({ id: "a", requred: true }), "a misspelt option");
  throwsRange(() => ui.textarea({ id: "a", maxlength: 3 }), "an option the kit does not write");
  for (const bad of ["Bad", "a b", "1a", "", "a_b", null]) throwsRange(() => ui.field({ label: "x", id: bad, control: "" }), `id ${String(bad)}`);
  throwsRange(() => ui.input({ id: "a", describedBy: ["a-err", "x\"y"] }));
  // A reserved id (the frame's, the sprite's, an icon's or a panel's) is refused wherever the kit writes an id, the
  // ids a field derives for its hint and its error included (review S2).
  for (const id of [...ui.RESERVED_IDS, "hatch", "arrow", "i-run", "i-x", "p-runs", "p-anything"]) {
    throwsRange(() => ui.input({ id }), `input #${id}`);
    throwsRange(() => ui.select({ id, options: [] }), `select #${id}`);
    throwsRange(() => ui.textarea({ id }), `textarea #${id}`);
    throwsRange(() => ui.btn({ label: "x", id }), `btn #${id}`);
  }
  throwsRange(() => ui.field({ label: "x", id: "i", hint: "h", control: "" }), "a field whose hint would be #i-hint");
  throwsRange(() => ui.field({ label: "x", id: "p", error: "e", control: "" }), "a field whose error would be #p-err");
  for (const near of ["mains", "tokens", "pi-run", "ip-x", "logout2"]) assert.ok(String(ui.btn({ label: "x", id: near })).includes(`id="${near}"`), `#${near} is not reserved`);
  // A console link is a path or an in-page id, anchored at both ends; a query alone, another host and any URL are not
  // (a link out of the console is outLink's), nor a path holding a space, a backslash or a character past ASCII.
  for (const bad of ["javascript:alert(1)", "//evil.example/", "/\\evil.example", "http://evil.example/", "https://github.com/acme/web", "https://a@evil.example", "?x=1", "?", "#", "#A", "#why x", "#why/x", "#a?b", "#main\"", "data:text/html,x", "", "runs", " /x", "/ /x", "/a b", "/a\\b", "/\u00e9", "/\u200b/evil.example", "/x\u0009"]) {
    throwsRange(() => ui.btn({ label: "x", href: bad }), `href ${JSON.stringify(bad)}`);
    throwsRange(() => ui.tabs([{ href: bad, label: "x" }], { label: "t" }), `tabs href ${JSON.stringify(bad)}`);
    throwsRange(() => ui.seg([{ href: bad, label: "x" }], { label: "t" }), `seg href ${JSON.stringify(bad)}`);
    throwsRange(() => ui.big({ n: 1, label: "x", href: bad }), `big href ${JSON.stringify(bad)}`);
  }
  throwsRange(() => ui.tbl({ label: "t", heads: ["a"], rows: [{ cells: ["x"], mark: "ok" }] }));
  throwsRange(() => ui.tbl({ label: "t", heads: ["a"], rows: [[{ html: "x", bold: true }]] }), "an unknown cell option");
  throwsRange(() => ui.tbl({ label: "t", heads: [{ label: "a", align: "left" }], rows: [] }), "an unknown column option");
  throwsRange(() => ui.tbl({ label: "t", heads: ["a", "b"], rows: [["x"]] }), "a row short of a cell");
  assert.throws(() => ui.tbl({ heads: ["a"], rows: [] }), TypeError, "a table is named");
  assert.throws(() => ui.tabs([], { label: "" }), TypeError);
  assert.throws(() => ui.seg([], {}), TypeError);
  for (const bad of [Number.NaN, Infinity, "3", null]) assert.throws(() => ui.count(bad), TypeError, String(bad));
});

test("hostile text is escaped and its control bytes scrubbed in every helper that draws text, in text and in attributes", () => {
  const H = HOSTILE;
  const frags = [
    ui.badge("failed", H), ui.chip(H), ui.ptag(H), ui.vtag(H), ui.count(1, null, { label: H }), ui.dot("ok", { label: H }),
    ui.card({ title: H, sub: H, end: H, body: H }), ui.kpi(H, H), ui.big({ n: H, label: H }), ui.facts([[H, H]]),
    ui.tbl({ label: H, caption: H, heads: [H, { label: H }], rows: [[H, { id: true, html: H }]], stack: true }), ui.tbl({ label: "t", heads: ["a"], rows: [], empty: H }),
    ui.tblFoot(H, ui.pager({ newer: "/runs?q=\"><script>", newerLabel: H, olderLabel: H })),
    ui.meter({ value: 1, max: 2, label: H }), ui.ring({ value: 1, max: 2, label: H }),
    ui.banner({ status: "failed", title: H, body: H, actions: H }), ui.empty({ status: "ok", title: H, body: H }), ui.collapsed({ icon: "runs", title: H, body: H }),
    ui.field({ label: H, id: "f", control: ui.input({ id: "f", name: H, value: H, placeholder: H, autocomplete: H }), hint: H, error: H }),
    ui.select({ id: "s", name: H, options: [H, { value: H, label: H }], value: H }), ui.textarea({ id: "t", name: H, value: H, placeholder: H }),
    ui.cmd(["pi-dispatch", H], { host: H }), ui.outLink({ href: "https://x.example/", label: H }), ui.tabs([{ href: "/?x=\"'<>", label: H, current: true }], { label: H }), ui.seg([{ label: H, on: true }, { label: H, href: "/?q=<a>" }], { label: H }),
    ui.btn({ label: H, href: "/runs?q=<x>" }), ui.btn({ kind: "round", icon: "pause", label: H }), ui.btn({ label: H, name: H, value: H }),
  ];
  for (const f of frags) {
    const s = out(f);
    assert.ok(!s.includes("<script"), s);
    assert.doesNotMatch(s, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, `a control byte reached the page: ${JSON.stringify(s)}`);
    assert.ok(s.includes(ESCAPED) || s.includes("&quot;&gt;&lt;script&gt;"), s);
  }
  assert.ok(String(frags[12]).includes(`href="/runs?q=&quot;&gt;&lt;script&gt;"`), "a link's quote cannot close its attribute");
});

// ---- the kit against the page rules ---------------------------------------------------------------------------------------------------

test("every link form the kit writes passes the page reference rule (assertOwnReferences), and the forms it refuses fail it", () => {
  const runs = ui.pageHref(PAGES, "runs", { project: "web", before: 1760000000000 });
  const links = [
    ui.btn({ label: "Fleet", href: "/fleet", icon: "fleet" }),
    ui.btn({ kind: "ghost", label: "Why", href: "#why" }),
    ui.btn({ label: "Search", href: "/runs?q=\"><script>" }),
    ui.big({ n: 1, label: "question", status: "parked", href: ui.pageHref(PAGES, "parked") }),
    ui.tabs([{ href: ui.pageHref(PAGES, "insights", { range: "7d" }), label: "Spend", icon: "spend", current: true }, { href: "#why", label: "Why", count: 2 }], { label: "Views" }),
    ui.seg([{ label: "1h", href: ui.pageHref(PAGES, "overview", { zoom: "1h" }) }, { label: "3h", href: "/?zoom=3h", on: true }], { label: "Zoom" }),
    ui.pager({ newer: runs, older: ui.pageHref(PAGES, "audit", { before: "2026-10:41" }) }),
    ui.outLink({ href: forgeLinkOf({ kind: "github", target: "acme/web#415" }), label: "acme/web#415" }),
    ui.outLink({ href: docsHref("docs/reasons.md#scope-cap"), label: "the reasons docs", code: true }),
    ui.field({ label: "Answer", id: "answer", control: ui.textarea({ id: "answer" }), hint: "h", error: "e" }),
  ].map(String);
  // A page around them: the sprite every icon names, the skip link's target, and the element `#why` names.
  const page = `<a class="skip" href="#main">Skip</a>${SPRITE}<main id="main"><p id="why">why</p>${links.join("")}</main>`;
  assertOwnReferences("the kit's links", page);
  // Each form the kit refuses is one the rule refuses too: they cannot drift into a link one writes and the other fails.
  const rule = (a) => () => assertOwnReferences("refused", `${page}${a}`);
  for (const a of [`<a href="?x=1">q</a>`, `<a href="https://evil.example/">x</a>`, `<a href="https://github.com/acme/web/issues/1" target="_blank">no rel</a>`, `<a href="#nowhere">x</a>`, `<a href="//evil.example/">x</a>`]) assert.throws(rule(a), assert.AssertionError, a);
  for (const href of ["?x=1", "https://evil.example/", "#nowhere-but-ok-shape-x y", "//evil.example/"]) assert.throws(() => ui.btn({ label: "x", href }), RangeError, href);
});

/**
 * A page's markup with its content taken out: what the frame alone draws. The content is every `.legacy` box (one per
 * old section since PR 2) and the INSIDE of every panel (an element carrying `data-panel`: a converted page's panels
 * sit outside any box, and the ids they hold, a table row's `seq-41`, are the page's own, not the frame's). The panel
 * element itself stays: its `p-` id is a frame-level name the kit refuses by family.
 */
function frameOf(page) {
  const cut = (text, at, open, close) => {
    const tags = new RegExp(`<${open}\\b|</${close}>`, "g");
    tags.lastIndex = at;
    let depth = 0;
    for (let m = tags.exec(text); m !== null; m = tags.exec(text)) {
      depth += m[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return m.index;
    }
    throw new Error(`an unclosed <${open}> at ${at}`);
  };
  let out = page;
  for (let at = out.indexOf('<div class="legacy">'); at !== -1; at = out.indexOf('<div class="legacy">')) {
    const end = cut(out, at, "div", "div");
    out = out.slice(0, at) + out.slice(end + "</div>".length);
  }
  const panel = /<(section|span|div)\b[^>]*\sdata-panel(?=[\s>])[^>]*>/g;
  for (let m = panel.exec(out); m !== null; m = panel.exec(out)) {
    const inner = m.index + m[0].length;
    const end = cut(out, m.index, m[1], m[1]);
    out = out.slice(0, inner) + out.slice(end);
    panel.lastIndex = inner;
  }
  return out;
}

test("frameOf strips the legacy boxes and every panel's inside, and keeps the frame and the panel elements", () => {
  const page = `<main id="main"><div class="legacy"><section id="p-a" data-panel><p id="x1"></p><div><i id="x2"></i></div></section></div><section id="p-b" data-panel><div class="card"><table><tr id="seq-4"></tr></table><section id="x3"></section></div></section><span id="p-nav-parked" data-panel><span id="x4"></span></span><div id="confirm-slot"><div id="x5"></div></div></main>`;
  assert.equal(frameOf(page), `<main id="main"><section id="p-b" data-panel></section><span id="p-nav-parked" data-panel></span><div id="confirm-slot"><div id="x5"></div></div></main>`);
});

test("RESERVED_IDS is every id the page frame draws and the script finds by name, and nothing else: none can be a kit id", async () => {
  assert.ok(Object.isFrozen(ui.RESERVED_IDS));
  const reserved = (id) => {
    assert.throws(() => ui.btn({ label: "x", id }), RangeError, `#${id} is refused as a kit id`);
    return true;
  };
  // The ids the script looks up by a literal name.
  const scriptIds = new Set(Array.from(CONSOLE_SCRIPT.matchAll(/getElementById\("([^"]+)"\)/g), (m) => m[1]));
  assert.ok(scriptIds.has("logout") && scriptIds.has("login-form") && scriptIds.has("graph-nodes"), [...scriptIds].join(", "));
  // The ids the frame draws on every screen, both roles, live and not, read-only and not, with a write's banner and
  // without, on the sign-in pages and on every error page.
  const frameIds = new Set();
  const pages = [String(loginPage({ notice: "idle" })), String(loginCodePage())];
  const flash = { summary: "Paused the fleet", by: "ops", auditSeq: 41, count: 1, undo: "Resume it.", inverse: { action: "fleet-resume", body: {} }, kind: "fleet-pause", at: 0 };
  for (const name of Object.keys(PAGES)) {
    for (const role of ["viewer", "operator"]) {
      for (const readOnly of [false, true]) {
        const query = name === "run" ? { id: "gh-1" } : {};
        pages.push(String((await renderPage(name, { query, session: { name: "ops", role }, data: { now: 0, env: {}, parkedCount: 3 }, readOnly, flash, maxStreams: 4 })).html));
      }
    }
  }
  for (const kind of ERROR_KINDS) pages.push(String(errorPage({ kind, session: { name: "ops", role: "operator" } }).html));
  for (const page of pages) for (const m of frameOf(page).matchAll(/\sid="([^"]+)"/g)) frameIds.add(m[1]);
  assert.ok(frameIds.has("main") && frameIds.has("p-nav-parked") && frameIds.has("i-runs"), [...frameIds].slice(0, 12).join(", "));
  // PR 2's: the live notes' region, the one confirm slot and the held note's template, found by the script by id.
  for (const id of ["live-note", "confirm-slot", "held-note"]) assert.ok(frameIds.has(id), `the frame draws #${id}`);
  for (const id of [...scriptIds, ...frameIds]) assert.ok(reserved(id), id);
  // And the list holds nothing else: each entry is still drawn by the frame or found by the script.
  for (const id of ui.RESERVED_IDS) assert.ok(frameIds.has(id) || scriptIds.has(id), `RESERVED_IDS lists #${id}, which neither the frame draws nor the script finds: drop it`);
});

test("RESERVED_ID_FAMILIES is every ordinal family the spend topology mints, each drawn id refused, and only an ordinal is", () => {
  assert.ok(Object.isFrozen(ui.RESERVED_ID_FAMILIES));
  const refused = (id) => assert.throws(() => ui.btn({ label: "x", id }), RangeError, `#${id} is refused as a kit id`);
  const allowed = (id) => assert.ok(String(ui.btn({ label: "x", id })).includes(` id="${id}"`), `#${id} is a kit id`);
  // Both ways against graph-html.mjs's own minting (`id: \`<family>${...}\``): a family added there is a failure here
  // until the kit reserves it, and a family listed here that the topology no longer mints is one too.
  const src = readFileSync(new URL("../src/graph-html.mjs", import.meta.url), "utf8");
  const minted = [...new Set(Array.from(src.matchAll(/\bid: `([a-z]+)\$\{/g), (m) => m[1]))].sort();
  assert.deepEqual(minted, ["g", "n", "sg", "w"], "the families graph-html.mjs mints");
  assert.deepEqual([...ui.RESERVED_ID_FAMILIES].sort(), minted);
  // Every topology id the spend golden draws (its chips and wires), by graph-html's own families, is refused.
  const golden = readFileSync(new URL("./fixtures/console/insights.operator.html", import.meta.url), "utf8");
  const family = new RegExp(`^(?:${minted.join("|")})\\d+$`);
  const drawn = Array.from(golden.matchAll(/\sid="([^"]+)"/g), (m) => m[1]).filter((id) => family.test(id));
  assert.ok(drawn.includes("n0") && drawn.includes("w0") && drawn.length >= 10, drawn.join(" "));
  for (const id of drawn) refused(id);
  for (const f of minted) for (const id of [`${f}0`, `${f}7`, `${f}123456`]) refused(id);
  // A family is the letters and a number, nothing more: a word that starts or ends like one is the page's own.
  for (const id of ["n", "g", "sg", "nav", "n1x", "n-1", "run1", "log2", "wsg1", "s1", "gn1", "w1-hint", "sg1a"]) allowed(id);
});

// ---- the sweeps (keep these last: they read every fragment built above) -------------------------------------------------------------

test("no fragment carries an inline style, a script, an event handler or a javascript: link", () => {
  assert.ok(OUT.length > 150, `${OUT.length} fragments swept`);
  for (const s of [...OUT, String(SPRITE)]) {
    assert.doesNotMatch(s, /style\s*=/i, s);
    assert.doesNotMatch(s, /<\s*(?:script|style)\b/i, s);
    assert.doesNotMatch(s, /\son[a-z]+\s*=/i, s);
    assert.doesNotMatch(s, /javascript:/i, s);
  }
});

test("no fragment carries a Unicode symbol, an arrow or an emoji: every mark is a sprite icon", () => {
  // So and Sk (the symbol categories; the panel's check, warning and cross are So), the arrows block and every
  // pictographic character, presentation selector or not.
  const SYMBOL = /[\p{So}\p{Sk}\u2190-\u21ff\p{Extended_Pictographic}\ufe0f]/u;
  for (const s of [...OUT, String(SPRITE)]) assert.doesNotMatch(s, SYMBOL, s);
  // And the check bites: the panel's own glyphs are exactly what it refuses.
  for (const w of Object.values(OUTCOME_WORDS)) assert.match(w.glyph, SYMBOL);
});

test("every icon a fragment uses is a symbol in the sprite, and every class it writes is one the stylesheet styles", () => {
  const ids = new Set(Array.from(String(SPRITE).matchAll(/\sid="([^"]+)"/g), (m) => m[1]));
  const used = new Set();
  for (const s of OUT) {
    for (const [, id] of s.matchAll(/<use href="#([^"]+)"/g)) {
      assert.ok(ids.has(id), `#${id} is in the sprite`);
      used.add(id);
    }
    assert.doesNotMatch(s, /<use href="[^#]/, "an icon is always in-page");
  }
  assert.equal(used.size, ICON_NAMES.length, "the sweep drew every icon");
  // Every class the kit writes (and the samples' own `code`, `link` and `reason`) is a class PULSE_CSS has a rule for.
  const classes = new Set(OUT.flatMap((s) => Array.from(s.matchAll(/\sclass="([^"]*)"/g), (m) => m[1].split(" "))).flat());
  for (const c of classes) assert.match(PULSE_CSS, new RegExp(`\\.${c.replace(/[-_]/g, "\\$&")}(?![a-z0-9_-])`), `.${c} is styled by the stylesheet`);
});
