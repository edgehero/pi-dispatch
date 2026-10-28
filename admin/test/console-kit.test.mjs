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
import { selectorsOf } from "../src/console/page-css.mjs";
import { QCARD_CSS } from "../src/console/parked-css.mjs";
import { RUNS_CSS } from "../src/console/runs-css.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { ERROR_KINDS, errorPage } from "../src/console/error-pages.mjs";
import { ANSWER_TEXT_MAX_BYTES } from "@edgehero/pi-dispatch/console-answer";
import { DEFER_BUCKETS, DEFER_TIME_MAX_MS } from "@edgehero/pi-dispatch/defer-reasons";
import { ACTIONS } from "../src/console/actions.mjs";
import { HEADLINE_ID, SHELL_PANEL_IDS, loginCodePage, loginPage, shellHtml } from "../src/console/shell.mjs";
import { forgeLinkOf } from "../src/read-model.mjs";
import { DOCS_ROOT, OUTCOME_WORDS, REASON_WORDS, STATUS_KINDS, docsHref, outcomeWord } from "../src/words.mjs";
import { assertOwnReferences } from "./helpers/console-pages-harness.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #737: the console's kit and its icon sprite. Each helper is pinned to its component card's own sample, written
// here as the card's bytes (copied from design/system, which this test does not read, and `fromCard`
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
  // Where a page's rules cut a tag to its column (the timeline's row heads), the tag carries its name whole in a title.
  assert.equal(out(ui.ptag("frontend-platform-team-eu", { title: "frontend-platform-team-eu" })), `<span class="ptag" title="frontend-platform-team-eu">frontend-platform-team-eu</span>`);
  assert.equal(out(ui.ptag(`a"><b>`, { title: `a"><b>` })), `<span class="ptag" title="a&quot;&gt;&lt;b&gt;">a&quot;&gt;&lt;b&gt;</span>`);
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
  // The OverviewScreen card's waitlist head: the small tile with the small icon.
  assert.equal(out(ui.tile("idle", { icon: "slot", sm: true, iconSm: true })), fromCard(`<span class="tile tile--sm tone-idle"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-slot"/></svg></span>`));
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

test("tbl: the DataTable card's runs, stacked on a phone with each cell labelled from its column where the card labels it, ids that never break", () => {
  const rows = [
    [{ when: true, html: "15:30" }, { id: true, html: html`<a href="/run?id=gh-e9a0">gh-e9a0</a>` }, { tgt: true, wide: true, html: html`<a href="/runs?target=acme%2Fbilling%23260">acme/billing#260</a>` }, ui.ptag("billing"), "fix", "build3", ui.vtag("podman"), { wide: true, html: html`${ui.outcomeBadge("policy", "egress-proxy-down")}<span class="reason">Refused: the egress proxy is not running on build3.</span>` }, "-", "not metered"],
    [{ when: true, html: "15:25" }, { id: true, html: "gh-a91e" }, { tgt: true, wide: true, html: "acme/web#422" }, ui.ptag("web"), "fix", "mini2", ui.vtag("openshell"), { wide: true, html: ui.outcomeBadge("completed") }, "85,577", "$0.17"],
  ];
  // The card's head cells have no scope and its other cells no `data-l`: the kit names every column (`scope="col"`) and
  // labels every stacked cell from its head, but the When column, whose empty label writes no `data-l` (the card writes
  // one and switches it off in its stylesheet).
  const want = `<div class="tbl-wrap"><table class="tbl tbl--stack" aria-label="Runs"><thead><tr><th scope="col">When</th><th scope="col">Job</th><th scope="col">Target</th><th scope="col">Project</th><th scope="col">Flow</th><th scope="col">Host</th><th scope="col">Venue</th><th scope="col">Outcome</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Cost</th></tr></thead><tbody>`
    + `<tr><td class="when">15:30</td><td class="id" data-l="Job"><span class="code"><a href="/run?id=gh-e9a0">gh-e9a0</a></span></td><td class="tgt wide" data-l="Target"><a href="/runs?target=acme%2Fbilling%23260">acme/billing#260</a></td><td data-l="Project"><span class="ptag">billing</span></td><td data-l="Flow">fix</td><td data-l="Host">build3</td><td data-l="Venue"><span class="vtag">podman</span></td><td class="wide" data-l="Outcome"><span class="badge tone-refused"><svg class="ic" aria-hidden="true"><use href="#i-refused"></use></svg>Refused</span><span class="reason">Refused: the egress proxy is not running on build3.</span></td><td class="num" data-l="Tokens">-</td><td class="num" data-l="Cost">not metered</td></tr>`
    + `<tr><td class="when">15:25</td><td class="id" data-l="Job"><span class="code">gh-a91e</span></td><td class="tgt wide" data-l="Target">acme/web#422</td><td data-l="Project"><span class="ptag">web</span></td><td data-l="Flow">fix</td><td data-l="Host">mini2</td><td data-l="Venue"><span class="vtag">openshell</span></td><td class="wide" data-l="Outcome"><span class="badge tone-ok"><svg class="ic" aria-hidden="true"><use href="#i-done"></use></svg>Completed</span></td><td class="num" data-l="Tokens">85,577</td><td class="num" data-l="Cost">$0.17</td></tr>`
    + `</tbody></table></div>`;
  assert.equal(out(ui.tbl({ label: "Runs", heads: RUN_HEADS, rows, stack: true })), want);
});

test("tbl: a caption instead of a label, a marked row, a column hidden on a phone, head and cells, and the empty case", () => {
  const t = out(ui.tbl({ caption: "Audit log", heads: [{ label: "Seq", num: true }, "Who", { label: "Note", hidePhone: true }], rows: [{ cells: [7, "ops", "x"], mark: "failed" }, [8, { html: "watcher", hidePhone: true }, null]] }));
  assert.equal(t, `<div class="tbl-wrap"><table class="tbl"><caption class="sr">Audit log</caption><thead><tr><th scope="col" class="num">Seq</th><th scope="col">Who</th><th scope="col" class="hide-phone">Note</th></tr></thead><tbody><tr class="row--failed"><td class="num">7</td><td>ops</td><td class="hide-phone">x</td></tr><tr><td class="num">8</td><td class="hide-phone">watcher</td><td class="hide-phone"></td></tr></tbody></table></div>`);
  assert.equal(out(ui.tbl({ label: "Runs", heads: RUN_HEADS, rows: [], empty: "No runs in the last 24 hours." })), `<p class="note">No runs in the last 24 hours.</p>`);
  const none = ui.empty({ status: "ok", title: "All clear" });
  assert.equal(out(ui.tbl({ label: "Runs", heads: RUN_HEADS, rows: [], empty: none })), String(none), "a fragment is drawn as it is");
  assert.equal(out(ui.tbl({ label: "Runs", heads: ["A"], rows: [] })), `<div class="tbl-wrap"><table class="tbl" aria-label="Runs"><thead><tr><th scope="col">A</th></tr></thead><tbody></tbody></table></div>`);
  // A head written as markup has no phone label (its markup is not a word to print before a cell), so its cells carry
  // no `data-l`, unless `l` gives one.
  const marked = out(ui.tbl({ label: "t", heads: [html`<span class="sr">Actions</span>`, { label: html`<b>Job</b>`, l: "Job" }], rows: [["x", "y"]], stack: true }));
  assert.equal(marked, `<div class="tbl-wrap"><table class="tbl tbl--stack" aria-label="t"><thead><tr><th scope="col"><span class="sr">Actions</span></th><th scope="col"><b>Job</b></th></tr></thead><tbody><tr><td>x</td><td data-l="Job">y</td></tr></tbody></table></div>`);
  // A column right-aligned and hidden on a phone marks its head with both, in the cells' order.
  const both = out(ui.tbl({ label: "t", heads: [{ label: "Tokens", num: true, hidePhone: true }, { label: "Cost", num: true }], rows: [[5, 6]], stack: true }));
  assert.ok(both.includes(`<thead><tr><th scope="col" class="num hide-phone">Tokens</th><th scope="col" class="num">Cost</th></tr></thead><tbody><tr><td class="num hide-phone" data-l="Tokens">5</td><td class="num" data-l="Cost">6</td></tr></tbody>`), both);
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

test("tbl: day rows, each the header of a body of its own, as the RunsScreen card groups its runs", () => {
  const rows = [{ group: "2026-10-08 UTC" }, [{ when: true, html: "15:30" }, { id: true, html: "gh-e9a0" }], [{ when: true, html: "15:25" }, { id: true, html: "gh-a91e" }], { group: "2026-10-07 UTC" }, [{ when: true, html: "23:59" }, { id: true, html: "gh-03a9" }]];
  // The card's day row is `<tr class="runs-day"><td colspan="12" class="wide">Thursday 8 October</td></tr>` inside its
  // one body: here it is a row header (`th scope="rowgroup"`) across every column, opening a body of its own, so the
  // header names its own rows and no other day's, and a stacked table labels no cell of it.
  const t = out(ui.tbl({ label: "Runs", heads: [{ label: "Ended", l: "" }, "Job"], rows, stack: true }));
  assert.equal(t, `<div class="tbl-wrap"><table class="tbl tbl--stack" aria-label="Runs"><thead><tr><th scope="col">Ended</th><th scope="col">Job</th></tr></thead>`
    + `<tbody><tr class="tbl-group"><th scope="rowgroup" colspan="2">2026-10-08 UTC</th></tr><tr><td class="when">15:30</td><td class="id" data-l="Job"><span class="code">gh-e9a0</span></td></tr><tr><td class="when">15:25</td><td class="id" data-l="Job"><span class="code">gh-a91e</span></td></tr></tbody>`
    + `<tbody><tr class="tbl-group"><th scope="rowgroup" colspan="2">2026-10-07 UTC</th></tr><tr><td class="when">23:59</td><td class="id" data-l="Job"><span class="code">gh-03a9</span></td></tr></tbody></table></div>`);
  // Rows before the first header keep a body of their own; a table with no header is one body, as before.
  const lead = out(ui.tbl({ label: "t", heads: ["a"], rows: [["x"], { group: "Earlier" }, ["y"]] }));
  assert.ok(lead.includes(`<tbody><tr><td>x</td></tr></tbody><tbody><tr class="tbl-group"><th scope="rowgroup" colspan="1">Earlier</th></tr><tr><td>y</td></tr></tbody>`), lead);
  assert.equal((out(ui.tbl({ label: "t", heads: ["a"], rows: [["x"], ["y"]] })).match(/<tbody>/g) ?? []).length, 1);
  // A group row is its label alone: no cells, mark or id beside it, and never empty.
  for (const bad of [{ group: "x", cells: [] }, { group: "x", id: "d1" }, { group: "" }, { group: null }]) assert.throws(() => ui.tbl({ label: "t", heads: ["a"], rows: [bad] }), TypeError, JSON.stringify(bad));
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
  // The most characters it takes, as the action that reads it bounds its text, after its rows.
  assert.equal(out(ui.textarea({ id: "b", name: "text", rows: 3, maxlength: 8192, required: true })), `<textarea id="b" class="textarea" name="text" rows="3" maxlength="8192" required></textarea>`);
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
  // Drawn as a button (the SetupScreen card's ghost "What triggers can do"), the same link: rel and target as ever.
  assert.equal(out(ui.outLink({ href: "https://github.com/edgehero/pi-dispatch/blob/main/docs/triggers.md", label: "What triggers can do", btn: "ghost" })), `<a class="btn btn--ghost" href="https://github.com/edgehero/pi-dispatch/blob/main/docs/triggers.md" rel="noreferrer noopener" target="_blank">What triggers can do</a>`);
  assert.equal(out(ui.outLink({ href: "https://x.example/", label: "x", btn: ["sm", "ghost"] })), `<a class="btn btn--sm btn--ghost" href="https://x.example/" rel="noreferrer noopener" target="_blank">x</a>`);
  assert.throws(() => ui.outLink({ href: "https://x.example/", label: "x", btn: "bogus" }), RangeError);
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

// ---- the overview's marks (PR 3 of issue #737) ---------------------------------------------------------------------------

/** The card's slot dots as the kit writes them: an image with a name. The card's are a bare span, its hosts' named without a role. */
const slotsOf = (s, name) => s.replace(/<span class="sls"(?: aria-label="slots")?>/, `<span class="sls" role="img" aria-label="${name}">`);

test("slots: the Status card's dots, running, held and free in that order, as a named image", () => {
  const status = `<span class="sls"><i class="sl sl--run"></i><i class="sl sl--hold"></i><i class="sl"></i></span>`;
  assert.equal(out(ui.slots({ run: 1, hold: 1, free: 1 })), slotsOf(status, "1 running, 1 held, 1 free"), "by default the name says the three counts");
  // OverviewScreen's host rows name theirs "slots" without a role, which a span may not carry; the kit's is an image.
  const host = `<span class="sls" aria-label="slots"><i class="sl sl--run"></i><i class="sl sl--run"></i><i class="sl"></i><i class="sl"></i></span>`;
  assert.equal(out(ui.slots({ run: 2, free: 2, label: "mini1: 2 running, 2 free" })), slotsOf(host, "mini1: 2 running, 2 free"));
  assert.equal(out(ui.slots({ label: "no slots" })), `<span class="sls" role="img" aria-label="no slots"></span>`);
  // At most SLOTS_MAX dots, then the rest as a count; the held are kept first, then the running, then the free.
  assert.equal(ui.SLOTS_MAX, 32);
  const dotsOf = (s) => ({ run: (s.match(/sl--run/g) ?? []).length, hold: (s.match(/sl--hold/g) ?? []).length, free: (s.match(/<i class="sl"><\/i>/g) ?? []).length, more: /\+([\d,]+)<\/span>$/.exec(s)?.[1] ?? null });
  assert.deepEqual(dotsOf(out(ui.slots({ run: 30, hold: 3, free: 12 }))), { run: 29, hold: 3, free: 0, more: "13" });
  assert.deepEqual(dotsOf(out(ui.slots({ run: 2, hold: 40, free: 1 }))), { run: 0, hold: 32, free: 0, more: "11" }, "a held slot is never the dot cut");
  assert.deepEqual(dotsOf(out(ui.slots({ run: 10, hold: 2, free: 20 }))), { run: 10, hold: 2, free: 20, more: null }, "32 exactly is drawn whole");
  assert.deepEqual(dotsOf(out(ui.slots({ run: 10, hold: 2, free: 2000 }))), { run: 10, hold: 2, free: 20, more: "1,980" });
  assert.match(out(ui.slots({ run: 33 })), /^<span class="sls" role="img" aria-label="33 running, 0 held, 0 free">(?:<i class="sl sl--run"><\/i>){32}\+1<\/span>$/, "the name keeps every count");
  for (const bad of [-1, 1.5, Number.NaN, Infinity, "2", null]) {
    assert.throws(() => ui.slots({ run: bad }), TypeError, `run ${String(bad)}`);
    assert.throws(() => ui.slots({ hold: bad }), TypeError, `hold ${String(bad)}`);
    assert.throws(() => ui.slots({ free: bad }), TypeError, `free ${String(bad)}`);
  }
});

test("rowPill: CardsAndBanners' Needs you and In line rows, OverviewScreen's Running rows, and a write as a row's action", () => {
  const needs = `<ul class="rows">
    <li class="rowpill tone-parked"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-parked"/></svg><span class="ptag">api</span><span class="code">gh-2f6a</span><a class="rowpill__act" href="#">Answer</a></li>
    <li class="rowpill tone-failed"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-failed"/></svg><span class="ptag">web</span><span class="code">gh-f0c2</span><a class="rowpill__act" href="#">Re-run</a></li>
    <li class="rowpill tone-refused"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-refused"/></svg><span class="ptag">billing</span><span class="code">gh-e9a0</span><a class="rowpill__act" href="#">Open</a></li>
    <li class="rowpill tone-failed"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-hourglass"/></svg><span class="ptag">api</span><span class="code">gh-5d10</span><a class="rowpill__act" href="#">Retry</a></li>
  </ul>`;
  const id = (s) => html`<span class="code">${s}</span>`;
  const needRows = [
    ["parked", "parked", "api", "gh-2f6a", "Answer"],
    ["failed", "failed", "web", "gh-f0c2", "Re-run"],
    ["refused", "refused", "billing", "gh-e9a0", "Open"],
    ["hourglass", "failed", "api", "gh-5d10", "Retry"],
  ].map(([icon, status, project, job, label]) => ui.rowPill({ icon, status, items: [ui.ptag(project), id(job)], action: { label, href: `/run?id=${job}` } }));
  assert.equal(`<ul class="rows">${needRows.map(out).join("")}</ul>`, tight(hrefs(needs, "/run?id=gh-2f6a", "/run?id=gh-f0c2", "/run?id=gh-e9a0", "/run?id=gh-5d10")));
  const inLine = `<ul class="rows"><li class="rowpill"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-slot"/></svg><span>Free slot</span><span class="end"><b>1</b></span></li><li class="rowpill"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-chain"/></svg><span>Another run</span><span class="end"><b>1</b></span></li><li class="rowpill"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-clock"/></svg><span>Time or check</span><span class="end"><b>1</b></span></li><li class="rowpill"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-rerun"/></svg><span>Retry backoff</span><span class="end"><b>2</b></span></li></ul>`;
  const lineRows = [["slot", "Free slot", 1], ["chain", "Another run", 1], ["clock", "Time or check", 1], ["rerun", "Retry backoff", 2]].map(([icon, label, n]) => ui.rowPill({ icon, items: [label], end: n }));
  assert.equal(`<ul class="rows">${lineRows.map(out).join("")}</ul>`, fromCard(inLine));
  // Running's rows: a host's name in bold, its slot dots (the kit's are a named image), and the held or the free.
  const running = `<ul class="rows">
    <li class="rowpill"><b>build3</b><span class="sls"><i class="sl sl--run"></i><i class="sl sl--hold"></i><i class="sl"></i></span><span class="end tinted tone-attention"><b class="tinted">1 held</b></span></li>
    <li class="rowpill"><b>mini1</b><span class="sls"><i class="sl sl--run"></i><i class="sl sl--run"></i><i class="sl"></i><i class="sl"></i></span><span class="end faint">2 free</span></li>
    <li class="rowpill"><b>mini2</b><span class="sls"><i class="sl sl--run"></i><i class="sl"></i></span><span class="end faint">1 free</span></li>
  </ul>`;
  const runRows = [
    ui.rowPill({ items: [html`<b>build3</b>`, ui.slots({ run: 1, hold: 1, free: 1, label: "build3" })], end: { text: "1 held", status: "attention" } }),
    ui.rowPill({ items: [html`<b>mini1</b>`, ui.slots({ run: 2, free: 2, label: "mini1" })], end: { text: "2 free", faint: true } }),
    ui.rowPill({ items: [html`<b>mini2</b>`, ui.slots({ run: 1, free: 1, label: "mini2" })], end: { text: "1 free", faint: true } }),
  ];
  const named = tight(running).split("<li").map((li, i) => (i === 0 ? li : slotsOf(li, ["build3", "mini1", "mini2"][i - 1]))).join("<li");
  assert.equal(`<ul class="rows">${runRows.map(out).join("")}</ul>`, named);
  // An end as text or a fragment, and a write as the action: the form as it is, after the end.
  assert.equal(out(ui.rowPill({ items: ["x"], end: "longest 4m" })), `<li class="rowpill"><span>x</span><span class="end">longest 4m</span></li>`);
  assert.equal(out(ui.rowPill({ items: [], end: { text: "plain" } })), `<li class="rowpill"><span class="end">plain</span></li>`);
  const retry = ui.actForm({ action: "retry-failed", hidden: [["jobId", "gh-5d10"], ["queue", "pi-jobs"]], label: "Retry", kind: ["sm", "paid"] });
  assert.equal(out(ui.rowPill({ icon: "hourglass", status: "failed", items: [ui.ptag("api"), id("gh-5d10")], end: 3, action: retry })), `<li class="rowpill tone-failed"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-hourglass"></use></svg><span class="ptag">api</span><span class="code">gh-5d10</span><span class="end"><b>3</b></span>${retry}</li>`);
  assert.throws(() => ui.rowPill({ items: "x" }), TypeError);
  assert.throws(() => ui.rowPill({ items: [], action: "Retry" }), TypeError, "a bare string is no action");
  assert.throws(() => ui.rowPill({ items: [], action: { label: "x", href: "/x", kind: "paid" } }), TypeError);
  assert.throws(() => ui.rowPill({ items: [], action: { label: "x", href: "javascript:alert(1)" } }), RangeError);
  assert.throws(() => ui.rowPill({ items: [], end: { text: "x", status: "attention", faint: true } }), RangeError);
  assert.throws(() => ui.rowPill({ items: [], end: { text: "x", tone: "attention" } }), RangeError);
  assert.throws(() => ui.rowPill({ items: [], end: { text: "x", status: "warning" } }), RangeError);
  assert.throws(() => ui.rowPill({ items: [], end: Number.NaN }), TypeError);
  assert.throws(() => ui.rowPill({ items: [], end: [1] }), TypeError);
  assert.throws(() => ui.rowPill({ items: [], status: "warning" }), RangeError);
  assert.throws(() => ui.rowPill({ items: [], icon: "nope" }), RangeError);
});

test("capsule: the overview's Caps (FactsAndLevels' capsules), its tone where the printed percent reads it", () => {
  // OverviewScreen's eight. The card prints whole percents of levels it does not give; these are levels that give its
  // heights (a pill is round(150 * level / 100) high, its percent 21 below its top).
  const card = `<div class="capbars"><div class="cap" title="Jobs today: 63%">
  <svg width="40" height="150" viewBox="0 0 40 150" role="img" aria-label="Jobs today: 63 percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="150"/><circle class="cap__hold" cx="20" cy="30" r="4"/>
    <rect class="cap__pill tone-ok" x="4" y="56" width="32" height="94" rx="16"/>
    <text class="cap__v" x="20" y="77" text-anchor="middle">63</text></svg>
  <p class="cap__l"><b>Jobs</b>today</p></div><div class="cap" title="Jobs week: 50%">
  <svg width="40" height="150" viewBox="0 0 40 150" role="img" aria-label="Jobs week: 50 percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="150"/><circle class="cap__hold" cx="20" cy="30" r="4"/>
    <rect class="cap__pill tone-ok" x="4" y="76" width="32" height="74" rx="16"/>
    <text class="cap__v" x="20" y="97" text-anchor="middle">50</text></svg>
  <p class="cap__l"><b>Jobs</b>week</p></div><div class="cap" title="Jobs month: 28%">
  <svg width="40" height="150" viewBox="0 0 40 150" role="img" aria-label="Jobs month: 28 percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="150"/><circle class="cap__hold" cx="20" cy="30" r="4"/>
    <rect class="cap__pill tone-ok" x="4" y="108" width="32" height="42" rx="16"/>
    <text class="cap__v" x="20" y="130" text-anchor="middle">28</text></svg>
  <p class="cap__l"><b>Jobs</b>month</p></div><div class="cap" title="Tokens today: 39%">
  <svg width="40" height="150" viewBox="0 0 40 150" role="img" aria-label="Tokens today: 39 percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="150"/><circle class="cap__hold" cx="20" cy="30" r="4"/>
    <rect class="cap__pill tone-ok" x="4" y="92" width="32" height="58" rx="16"/>
    <text class="cap__v" x="20" y="113" text-anchor="middle">39</text></svg>
  <p class="cap__l"><b>Tokens</b>today</p></div><div class="cap" title="Deploy $ today: 60%">
  <svg width="40" height="150" viewBox="0 0 40 150" role="img" aria-label="Deploy $ today: 60 percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="150"/><circle class="cap__hold" cx="20" cy="30" r="4"/>
    <rect class="cap__pill tone-ok" x="4" y="60" width="32" height="90" rx="16"/>
    <text class="cap__v" x="20" y="81" text-anchor="middle">60</text></svg>
  <p class="cap__l"><b>Deploy $</b>today</p></div><div class="cap" title="Deploy $ week: 28%">
  <svg width="40" height="150" viewBox="0 0 40 150" role="img" aria-label="Deploy $ week: 28 percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="150"/><circle class="cap__hold" cx="20" cy="30" r="4"/>
    <rect class="cap__pill tone-ok" x="4" y="109" width="32" height="41" rx="16"/>
    <text class="cap__v" x="20" y="130" text-anchor="middle">28</text></svg>
  <p class="cap__l"><b>Deploy $</b>week</p></div><div class="cap" title="web $ week: 26%">
  <svg width="40" height="150" viewBox="0 0 40 150" role="img" aria-label="web $ week: 26 percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="150"/><circle class="cap__hold" cx="20" cy="30" r="4"/>
    <rect class="cap__pill tone-ok" x="4" y="111" width="32" height="39" rx="16"/>
    <text class="cap__v" x="20" y="132" text-anchor="middle">26</text></svg>
  <p class="cap__l"><b>web $</b>week</p></div><div class="cap" title="sonnet $ week: 41%">
  <svg width="40" height="150" viewBox="0 0 40 150" role="img" aria-label="sonnet $ week: 41 percent of cap">
    <line class="cap__rail" x1="20" x2="20" y1="0" y2="150"/><circle class="cap__hold" cx="20" cy="30" r="4"/>
    <rect class="cap__pill tone-ok" x="4" y="89" width="32" height="61" rx="16"/>
    <text class="cap__v" x="20" y="110" text-anchor="middle">41</text></svg>
  <p class="cap__l"><b>sonnet $</b>week</p></div></div>`;
  // The kit's changes to the card, each on purpose:
  //   - the tone is on the <svg>, not on the pill: bundle.css paints the pill `--tone` and the percent `--on-tone`, and
  //     the percent is the pill's sibling, so on the card it read no tone and was drawn in SVG's default black;
  //   - the card prints the one capsule at 28% of the month 22 below its pill's top; the kit keeps every one at 21.
  const kitOf = (s) => {
    const t = tight(s);
    const tone = /class="cap__pill (tone-[a-z]+)"/.exec(t)[1];
    return t.replace(` ${tone}"`, `"`).replace("<svg width", `<svg class="${tone}" width`);
  };
  const caps = /<div class="capbars">([^]*)<\/div>$/.exec(card)[1].split(/(?=<div class="cap")/);
  assert.equal(caps.length, 8);
  const levels = [["Jobs", "today", 62.5], ["Jobs", "week", 49.5], ["Jobs", "month", 28], ["Tokens", "today", 38.8], ["Deploy $", "today", 60], ["Deploy $", "week", 27.5], ["web $", "week", 26], ["sonnet $", "week", 40.8]];
  for (const [i, [name, window, pct]] of levels.entries()) {
    const want = kitOf(caps[i]).replace(`y="130" text-anchor="middle">28</text></svg><p class="cap__l"><b>Jobs</b>month`, `y="129" text-anchor="middle">28</text></svg><p class="cap__l"><b>Jobs</b>month`);
    assert.equal(out(ui.capsule({ name, window, pct, hold: 80 })), want, `${name} ${window}`);
  }
  // The card draws the soft-hold ring on every capsule; a dollar window has no soft hold, so the console passes none
  // and none is drawn.
  assert.doesNotMatch(out(ui.capsule({ name: "Deploy $", window: "today", pct: 60 })), /cap__hold/);
  assert.match(out(ui.capsule({ name: "Jobs", window: "today", pct: 10, hold: 75 })), /<circle class="cap__hold" cx="20" cy="38" r="4"\/>/, "the ring at 150 * (1 - 75/100), whole");
  // The meter rule: ok under the hold, attention from it, failed at the cap; a given status wins.
  const toneOf = (s) => /<svg class="tone-([a-z]+)"/.exec(s)[1];
  assert.equal(toneOf(out(ui.capsule({ name: "Jobs", window: "today", pct: 79.9, hold: 80 }))), "ok");
  assert.equal(toneOf(out(ui.capsule({ name: "Jobs", window: "today", pct: 80, hold: 80 }))), "attention");
  assert.equal(toneOf(out(ui.capsule({ name: "Jobs", window: "today", pct: 100, hold: 80 }))), "failed");
  assert.equal(toneOf(out(ui.capsule({ name: "Deploy $", window: "today", pct: 99 }))), "ok", "no hold: ok up to the cap");
  assert.equal(toneOf(out(ui.capsule({ name: "Jobs", window: "today", pct: 10, status: "attention" }))), "attention");
  // The pill is at least 32 high and stops at the top; the printed percent is whole and says a window past its cap.
  assert.match(out(ui.capsule({ name: "ops $", window: "month", pct: 2 })), /<rect class="cap__pill" x="4" y="118" width="32" height="32" rx="16"\/><text class="cap__v" x="20" y="139" text-anchor="middle">2<\/text>/);
  assert.match(out(ui.capsule({ name: "api $", window: "week", pct: 112.4 })), /title="api \$ week: 112%".*aria-label="api \$ week: 112 percent of cap".*<rect class="cap__pill" x="4" y="0" width="32" height="150" rx="16"\/><text class="cap__v" x="20" y="21" text-anchor="middle">112<\/text>/);
  assert.match(out(ui.capsule({ name: "Jobs", window: "today", pct: -3 })), /height="32" rx="16"\/><text class="cap__v" x="20" y="139" text-anchor="middle">0<\/text>/);
  assert.match(out(ui.capsule({ name: "Jobs", window: "today", pct: 50, label: "Jobs started today: 20 of 40" })), /role="img" aria-label="Jobs started today: 20 of 40"/);
  for (const bad of [Number.NaN, Infinity, "50", null, undefined]) assert.throws(() => ui.capsule({ name: "Jobs", window: "today", pct: bad }), TypeError, String(bad));
  assert.throws(() => ui.capsule({ name: html`<b>x</b>`, window: "today", pct: 1 }), TypeError, "a name is text: it is written into the title too");
  assert.throws(() => ui.capsule({ name: "Jobs", window: 7, pct: 1 }), TypeError);
  assert.throws(() => ui.capsule({ name: "Jobs", window: "today", pct: 1, status: "warning" }), RangeError);
});

test("spendDots: CardsAndBanners' Spend today, one column of 7 dots per hour, lit from the bottom, and its axis", () => {
  const card = `<div class="sd" role="img" aria-label="Metered spend by hour today"><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class="on"></i><i class="on"></i><i class="on"></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class="on"></i><i class="on"></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class="on"></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class="on"></i><i class="on"></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span><span class="sd__c"><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i class="on"></i><i class=""></i></span><span class="sd__c"><i class="on"></i><i class="on"></i><i class="on"></i><i class=""></i><i class=""></i><i class=""></i><i class=""></i></span></div><p class="axis"><span>00:00</span><span>08:00</span><span>15:00</span></p>`;
  // The kit writes an unlit dot without the card's empty class attribute.
  const hours = [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 2, 1, 4, 2, 6, 3];
  assert.equal(out(ui.spendDots({ hours, max: 7, label: "Metered spend by hour today" })), card.replace(/<i class=""><\/i>/g, "<i></i>"));
  assert.equal(ui.SPEND_DOTS, 7);
  const litOf = (s) => Array.from(s.matchAll(/<span class="sd__c">(.*?)<\/span>/g), (m) => (m[1].match(/class="on"/g) ?? []).length);
  // By default the largest hour is a full column; an hour that spent anything lights one at least; the rest none.
  assert.deepEqual(litOf(out(ui.spendDots({ hours: [100, 50, 1, 0, -4, Number.NaN, "9"], label: "x" }))), [7, 4, 1, 0, 0, 0, 0]);
  assert.deepEqual(litOf(out(ui.spendDots({ hours: [0, 0], label: "x" }))), [0, 0], "nothing spent, nothing lit");
  assert.deepEqual(litOf(out(ui.spendDots({ hours: [30, 10], max: 20, label: "x" }))), [7, 4], "over the scale is a full column");
  // The axis is the first, middle and last hours, from startHour, round the clock.
  const axisOf = (s) => Array.from(/<p class="axis">(.*)<\/p>$/.exec(s)[1].matchAll(/<span>([^<]*)<\/span>/g), (m) => m[1]);
  assert.deepEqual(axisOf(out(ui.spendDots({ hours: [1, 2, 3, 4], startHour: 22, label: "x" }))), ["22:00", "00:00", "01:00"]);
  assert.deepEqual(axisOf(out(ui.spendDots({ hours: [1], label: "x" }))), ["00:00"]);
  assert.deepEqual(axisOf(out(ui.spendDots({ hours: [1, 2], label: "x" }))), ["00:00", "01:00"]);
  assert.equal(litOf(out(ui.spendDots({ hours: Array(24).fill(1), label: "x" }))).length, 24);
  assert.equal(out(ui.spendDots({ hours: [], label: "x" })), "", "no hours, nothing drawn");
  assert.throws(() => ui.spendDots({ hours: Array(25).fill(1), label: "x" }), RangeError, "a day has 24 hours");
  assert.throws(() => ui.spendDots({ hours: "1,2", label: "x" }), RangeError);
  assert.throws(() => ui.spendDots({ hours: [1] }), TypeError, "the chart is named");
  for (const bad of [24, -1, 1.5, "0", null]) assert.throws(() => ui.spendDots({ hours: [1], label: "x", startHour: bad }), RangeError, String(bad));
});

test("schedulerRunOf: a cron trigger's run from its id, BullMQ's repeat:<trigger>:<slot>, and nothing else", () => {
  const slot = Date.UTC(2026, 9, 8, 15, 0);
  assert.deepEqual(ui.schedulerRunOf(`repeat:hourly-sync:${slot}`), { scheduler: "hourly-sync", at: slot });
  assert.deepEqual(ui.schedulerRunOf("repeat:nightly.tidy_2-a:0"), { scheduler: "nightly.tidy_2-a", at: 0 }, "a trigger id with dots, an underscore and a hyphen");
  // A slot past the latest instant a date can show names the trigger and no time.
  assert.deepEqual(ui.schedulerRunOf(`repeat:hourly-sync:${DEFER_TIME_MAX_MS}`), { scheduler: "hourly-sync", at: DEFER_TIME_MAX_MS });
  assert.deepEqual(ui.schedulerRunOf(`repeat:hourly-sync:${DEFER_TIME_MAX_MS + 1}`), { scheduler: "hourly-sync", at: null });
  assert.deepEqual(ui.schedulerRunOf("repeat:hourly-sync:9999999999999999"), { scheduler: "hourly-sync", at: null }, "past a safe integer too");
  // Any other id is no run of a trigger's.
  for (const id of ["gh-71b2", "local-aa01", "repeat:hourly-sync", "repeat::1", `repeat:a b:${slot}`, "repeat:x:01", "repeat:x:-1", "repeat:x:99999999999999999", `repeat:${"a".repeat(201)}:1`, `xrepeat:x:1`, null, 7, undefined]) {
    assert.equal(ui.schedulerRunOf(id), null, String(id));
  }
});

test("waitBar: the Waitlists card's bar, a segment per reason in proportion, alternating greys, every segment wide enough to read", () => {
  const card = `<svg class="wbar" height="30" role="img" aria-label="In line by reason"><rect class="wb wb--0" x="0.00%" y="0" width="20.00%" height="30" rx="8"/><g transform="translate(10 8)"><use class="wb-g" href="#i-slot" x="0.00%" width="14" height="14"/></g><text class="wb-t" x="0.00%" dx="30" y="20">1</text><rect class="wb wb--1" x="20.00%" y="0" width="20.00%" height="30" rx="8"/><g transform="translate(10 8)"><use class="wb-g" href="#i-chain" x="20.00%" width="14" height="14"/></g><text class="wb-t" x="20.00%" dx="30" y="20">1</text><rect class="wb wb--2" x="40.00%" y="0" width="20.00%" height="30" rx="8"/><g transform="translate(10 8)"><use class="wb-g" href="#i-clock" x="40.00%" width="14" height="14"/></g><text class="wb-t" x="40.00%" dx="30" y="20">1</text><rect class="wb wb--3" x="60.00%" y="0" width="40.00%" height="30" rx="8"/><g transform="translate(10 8)"><use class="wb-g" href="#i-rerun" x="60.00%" width="14" height="14"/></g><text class="wb-t" x="60.00%" dx="30" y="20">2</text></svg>`;
  // The kit closes `<use>` with `</use>`, as it writes every icon.
  const kitOf = (s) => s.replace(/(<use class="wb-g"[^>]*?)\/>/g, "$1></use>");
  const segments = [{ icon: "slot", count: 1 }, { icon: "chain", count: 1 }, { icon: "clock", count: 1 }, { icon: "rerun", count: 2 }];
  assert.equal(out(ui.waitBar(segments, { label: "In line by reason" })), kitOf(card));
  const bar = (counts) => {
    const s = out(ui.waitBar(counts.map((count, i) => ({ icon: ICON_NAMES[i], count })), { label: "x" }));
    return Array.from(s.matchAll(/<rect class="wb wb--(\d)" x="([\d.]+)%" y="(\d+)" width="([\d.]+)%"[^>]*\/><g transform="translate\(10 (\d+)\)">.*?<text class="wb-t" x="[\d.]+%" dx="30" y="(\d+)">([\d,]+)<\/text>/g), (m) => ({ cls: Number(m[1]), x: m[2], y: Number(m[3]), w: Number(m[4]), gy: Number(m[5]), ty: Number(m[6]), text: m[7] }));
  };
  const heightOf = (counts) => Number(/<svg class="wbar" height="(\d+)"/.exec(out(ui.waitBar(counts.map((count, i) => ({ icon: ICON_NAMES[i], count })), { label: "x" })))[1]);
  // What a segment's glyph and count need on the narrowest bar (310 px, the card's at 375): the glyph 10 px in and 14
  // wide, 6 px, the count at 13 px, 800 (Chrome draws a tabular digit 8.8 px wide), and 10 px before the end.
  assert.equal(ui.WAIT_BAR_PX, 310);
  const needPx = (text) => 30 + text.length * 8.8 + 10;
  // A share under a segment's least is raised to it and the others share the rest; a row's widths always add up to 100.
  assert.deepEqual(bar([30, 1]).map((s) => s.w), [84.19, 15.81]);
  assert.deepEqual(bar([60, 1, 1, 2]).map((s) => s.w), [52.58, 15.81, 15.8, 15.81]);
  assert.deepEqual(bar([1, 1, 1]).map((s) => s.w), [33.33, 33.34, 33.33]);
  for (const counts of [[1, 1, 1], [7, 3], [100, 1, 1, 1, 1, 1], [5, 9, 13, 2, 1], [1, 2, 3, 4, 5, 6, 7, 8], [120, 1, 1, 1, 1, 1, 1, 1, 1, 1], [1204, 999, 88, 7, 1, 1, 1, 1, 1, 1], DEFER_BUCKETS.map(() => 120)]) {
    const segs = bar(counts);
    assert.equal(segs.length, counts.length, counts.join(" "));
    const rows = Map.groupBy(segs, (s) => s.y);
    for (const [y, row] of rows) {
      assert.equal(Math.round(row.reduce((a, s) => a + s.w, 0) * 100), 10000, `${counts.join(" ")}: the row at ${y}`);
      assert.equal(row.at(-1).x, (100 - row.at(-1).w).toFixed(2), "a row's last segment ends at 100%");
      for (const s of row) {
        assert.ok((s.w / 100) * ui.WAIT_BAR_PX >= needPx(s.text), `${counts.join(" ")}: ${s.text} has ${((s.w / 100) * ui.WAIT_BAR_PX).toFixed(1)} px`);
        assert.deepEqual([s.gy, s.ty], [y + 8, y + 20], "its glyph and its count in its own row");
      }
    }
    assert.equal(heightOf(counts), rows.size * 30 + (rows.size - 1) * 6, "a row 30 px high, 6 px apart");
  }
  // Every bucket the worker's leaf has, one job each: ten segments need more than one bar holds, so two rows of five,
  // each even, the card's four greys in turn across both.
  const all = bar(DEFER_BUCKETS.map(() => 1));
  assert.deepEqual(all.map((s) => s.cls), DEFER_BUCKETS.map((_, i) => i % 4));
  assert.deepEqual(all.map((s) => s.y), DEFER_BUCKETS.map((_, i) => (i < 5 ? 0 : 36)));
  for (const s of all) assert.ok(Math.abs(s.w - 20) <= 0.01, `an even share: ${s.w}`);
  assert.equal(heightOf(DEFER_BUCKETS.map(() => 1)), 66);
  // A three-digit count's segment is wider than a one-digit count's, and never cut ("1:" for 120 was a cut "120").
  const wide = bar([120, 1, 1, 1, 1, 1]);
  assert.equal(wide[0].text, "120");
  assert.ok(wide[0].w > wide[1].w);
  // A reason with no jobs is not drawn, and the greys still alternate across the ones that are.
  assert.deepEqual(bar([2, 0, 3]).map((s) => [s.cls, s.w]), [[0, 40], [1, 60]]);
  assert.equal(out(ui.waitBar([{ icon: "slot", count: 0 }], { label: "x" })), "", "nothing waits: no bar");
  assert.equal(out(ui.waitBar([], { label: "x" })), "");
  assert.match(out(ui.waitBar([{ icon: "slot", count: 1204 }], { label: "x" })), /<text class="wb-t" x="0\.00%" dx="30" y="20">1,204<\/text>/);
  assert.equal(heightOf([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]), 66, "the largest count still fits a row of its own");
  assert.throws(() => ui.waitBar([{ icon: "nope", count: 1 }], { label: "x" }), RangeError);
  assert.throws(() => ui.waitBar([{ icon: "slot", count: -1 }], { label: "x" }), TypeError);
  assert.throws(() => ui.waitBar([{ icon: "slot", count: 1.5 }], { label: "x" }), TypeError);
  assert.throws(() => ui.waitBar([{ icon: "slot", count: 1 }]), TypeError, "the bar is named");
  assert.throws(() => ui.waitBar("slot", { label: "x" }), TypeError);
});

test("actForm: a write's form, its hidden fields typed as the script reads them, then the kit's button; no preview area", () => {
  // Needs you's Retry, a paid act (the card's plain link is the console's two-step write).
  assert.equal(out(ui.actForm({ action: "retry-failed", hidden: [["jobId", "gh-5d10"], ["queue", "pi-jobs"]], label: "Retry", kind: ["sm", "paid"] })), `<form class="act" data-action="retry-failed" autocomplete="off"><input type="hidden" name="jobId" value="gh-5d10"><input type="hidden" name="queue" value="pi-jobs"><button class="btn btn--sm btn--paid" type="submit">Retry</button></form>`);
  // OverviewScreen's Pause fleet, the card's link as the form's button, and a host's round pause, destructive both.
  const fleet = fromCard(`<a class="btn btn--sm btn--danger" href="#"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-pause"/></svg>Pause fleet</a>`).replace(`<a `, `<button `).replace(` href="#"`, ` type="submit"`).replace(`</a>`, `</button>`);
  assert.equal(out(ui.actForm({ action: "fleet-pause", label: "Pause fleet", kind: ["sm", "danger"], icon: "pause" })), `<form class="act" data-action="fleet-pause" autocomplete="off">${fleet}</form>`);
  const host = fromCard(`<button class="btn btn--sm btn--round" type="button" aria-label="Pause build3"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-pause"/></svg></button>`).replace(`btn--round"`, `btn--round btn--danger"`).replace(`type="button"`, `type="submit"`);
  assert.equal(out(ui.actForm({ action: "queue-pause", hidden: [{ name: "queue", value: "pi-jobs@build3" }], label: "Pause build3", kind: ["sm", "round", "danger"], icon: "pause" })), `<form class="act" data-action="queue-pause" autocomplete="off"><input type="hidden" name="queue" value="pi-jobs@build3">${host}</form>`);
  assert.equal(out(ui.actForm({ action: "cancel-queued", hidden: [["jobId", "gh-c9e1"], ["queue", "pi-jobs@build3"]], label: "Cancel" })), `<form class="act" data-action="cancel-queued" autocomplete="off"><input type="hidden" name="jobId" value="gh-c9e1"><input type="hidden" name="queue" value="pi-jobs@build3"><button class="btn btn--sm" type="submit">Cancel</button></form>`, "small by default");
  // A field's type is one the browser script reads (`bodyOf`'s `data-type`), and an action's name passes its check.
  const scriptTypes = [...new Set(Array.from(CONSOLE_SCRIPT.matchAll(/\bt === "([a-z]+)"/g), (m) => m[1]))];
  assert.deepEqual(scriptTypes, ["int", "json", "list"]);
  for (const type of scriptTypes) assert.match(out(ui.actForm({ action: "x", hidden: [["index", "3", type]], label: "x" })), new RegExp(`<input type="hidden" name="index" value="3" data-type="${type}">`));
  assert.equal(out(ui.actForm({ action: "x", hidden: [{ name: "index", value: 3, type: "int" }, ["on", true]], label: "x" })), `<form class="act" data-action="x" autocomplete="off"><input type="hidden" name="index" value="3" data-type="int"><input type="hidden" name="on" value="true"><button class="btn btn--sm" type="submit">x</button></form>`);
  assert.ok(CONSOLE_SCRIPT.includes(`!/^[a-z0-9-]{1,40}$/.test(action)`), "the script's own check on an action's name");
  for (const name of ["retry-failed", "fleet-pause", "queue-pause", "cancel-queued"]) assert.ok(ACTIONS.some((a) => a.name === name), `${name} is an action`);
  assert.ok(ACTIONS.every((a) => /^[a-z0-9-]{1,40}$/.test(a.name)), "every action's name is one actForm takes");
  assert.doesNotMatch(String(ui.actForm({ action: "x", label: "x" })), /preview-area|data-preview/, "the page's one confirm slot previews it");
  for (const bad of ["Retry", "retry_failed", "a/b", "", "x".repeat(41), null]) assert.throws(() => ui.actForm({ action: bad, label: "x" }), RangeError, String(bad));
  for (const bad of [["job id", "x"], ["", "x"], ["1st", "x"], ["a-b", "x"], [null, "x"]]) assert.throws(() => ui.actForm({ action: "x", hidden: [bad], label: "x" }), RangeError, String(bad[0]));
  assert.throws(() => ui.actForm({ action: "x", hidden: [["n", "1", "number"]], label: "x" }), RangeError, "an unknown field type");
  for (const bad of [null, undefined, {}, [1], Number.NaN, Infinity]) assert.throws(() => ui.actForm({ action: "x", hidden: [["n", bad]], label: "x" }), TypeError, String(bad));
  assert.throws(() => ui.actForm({ action: "x", hidden: "jobId=1", label: "x" }), TypeError);
  assert.throws(() => ui.actForm({ action: "x", label: "x", kind: "huge" }), RangeError);
  assert.throws(() => ui.actForm({ action: "x", label: "Pause", kind: ["sm", "round"] }), TypeError, "a round button is its icon");
});

// ---- filters and summaries ----------------------------------------------------------------------------------------------------

test("searchPill and filterToggle: the RunsScreen card's search pill and the RunsPhone card's Filters button", () => {
  // The card's pill, its hidden word "Search" as the console names the field, with the field's id, name and value, and
  // its search left to the person (no autocomplete, no spell check).
  const card = `<label class="search runs-search"><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg><span class="sr">Search</span><input type="search" placeholder="Repository, target or job id"></label>`;
  const want = fromCard(card).replace(" runs-search", "").replace(">Search<", ">Search runs<").replace(`<input type="search"`, `<input id="q" type="search" name="q" value="gh-2f6a"`).replace(`job id">`, `job id" autocomplete="off" spellcheck="false">`);
  assert.equal(out(ui.searchPill({ id: ui.SEARCH_ID, name: "q", value: "gh-2f6a" })), want);
  assert.equal(out(ui.searchPill({ id: "au-q", name: "q", label: "Search the log", placeholder: null })), `<label class="search"><svg class="ic" aria-hidden="true"><use href="#i-search"></use></svg><span class="sr">Search the log</span><input id="au-q" type="search" name="q" autocomplete="off" spellcheck="false"></label>`, "any kit id, no value and no placeholder");
  // The card's Filters button with its count, drawn hidden for the script to reveal (the type, the hook and the state
  // added; the card's `(1)` is the number of filters it folds).
  const toggle = `<button class="fpill filterbar__toggle" type="button" aria-expanded="false"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-config"/></svg>Filters <b>(1)</b></button>`;
  assert.equal(out(ui.filterToggle({ count: 1 })), fromCard(toggle).replace(` aria-expanded="false"`, ` data-filter-toggle aria-expanded="false" hidden data-reveal`));
  assert.equal(out(ui.filterToggle()), `<button class="fpill filterbar__toggle" type="button" data-filter-toggle aria-expanded="false" hidden data-reveal><svg class="ic ic--sm" aria-hidden="true"><use href="#i-config"></use></svg>Filters</button>`, "no filter applied, no count");
  assert.equal(out(ui.filterToggle({ count: 0 })), out(ui.filterToggle()));
  for (const bad of [-1, 1.5, "1", Number.NaN]) assert.throws(() => ui.filterToggle({ count: bad }), TypeError, String(bad));
  for (const name of ["", "q q", "1q", null]) assert.throws(() => ui.searchPill({ id: "s", name }), RangeError, String(name));
  assert.throws(() => ui.searchPill({ id: "s", name: "q", label: "" }), TypeError, "a search field is named");
});

test("fpill, fchip and chipRow: the RunsScreen card's project chips and applied filters, as links a page opens without the script", () => {
  // The card's project row is a segmented control of buttons (`.projseg`); the console's chips are links, each the runs
  // page filtered to it, the current one marked by `aria-current` as well as its fill.
  assert.equal(out(ui.fpill({ label: "All", count: 27, href: "/runs", on: true })), `<a class="fpill fpill--on" href="/runs" aria-current="page">All <b>27</b></a>`);
  assert.equal(out(ui.fpill({ label: ui.ptag("billing"), count: 1204, href: "/runs?project=billing" })), `<a class="fpill" href="/runs?project=billing"><span class="ptag">billing</span> <b>1,204</b></a>`);
  assert.equal(out(ui.fpill({ label: "Only problems", href: "/runs?problems=1" })), `<a class="fpill" href="/runs?problems=1">Only problems</a>`);
  // The card's applied chip, its remove control a link (opening the page without the filter needs no script), named for
  // what it removes, the filter's value in the code face.
  const fchip = ui.fchip({ label: "Outcome", value: "failed", href: "/runs?project=web" });
  const chip = out(fchip);
  assert.equal(chip, `<span class="chip">Outcome: <span class="code">failed</span><a class="chip__x" href="/runs?project=web" aria-label="Remove Outcome"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-failed"></use></svg></a></span>`);
  const row = out(ui.chipRow([fchip, ui.btn({ kind: ["sm", "ghost"], label: "Clear filters", href: "/runs" })], { label: "Applied filters" }));
  assert.equal(row, `<div class="chiprow" role="group" aria-label="Applied filters">${chip}<a class="btn btn--sm btn--ghost" href="/runs">Clear filters</a></div>`);
  for (const bad of [Number.NaN, "27", Infinity]) assert.throws(() => ui.fpill({ label: "All", count: bad, href: "/runs" }), TypeError, String(bad));
  assert.throws(() => ui.fpill({ label: "x", href: "?project=web" }), RangeError, "a console link");
  assert.throws(() => ui.fchip({ label: html`<b>x</b>`, value: "y", href: "/runs" }), TypeError, "a chip's label is text: it names its remove link");
  assert.throws(() => ui.fchip({ label: "x", value: "y", href: "https://evil.example/" }), RangeError);
  assert.throws(() => ui.chipRow("x", { label: "r" }), TypeError);
  assert.throws(() => ui.chipRow([], {}), TypeError, "a row is named");
});

test("sumStrip: the RunsScreen card's counts by outcome, each a link to its runs, a lower bound said in words, an item off a phone", () => {
  // The card's `.runs-k` items under the kit's names: the count in bold over its label with the status's icon, the
  // tone on the item; a neutral item (the spend) has no tone and no icon.
  const card = `<a class="runs-k tone-failed" href="#"><b>1</b><span><svg class="ic ic--sm" aria-hidden="true"><use href="#i-failed"/></svg>failed</span></a><a class="runs-k" href="#"><b>$6.13</b><span><svg class="ic ic--sm" aria-hidden="true"><use href="#i-spend"/></svg>metered spend</span></a>`;
  const strip = out(ui.sumStrip([{ n: 1, label: "failed", status: "failed", href: "/runs?outcome=failed" }, { n: "$6.13", label: "metered spend", href: "/insights" }], { label: "Runs that ended in the last 24 hours" }));
  const items = fromCard(hrefs(card, "/runs?outcome=failed", "/insights")).replaceAll("runs-k", "sumstrip__i").replace(`<svg class="ic ic--sm" aria-hidden="true"><use href="#i-spend"></use></svg>`, "");
  assert.equal(strip, `<ul class="sumstrip" aria-label="Runs that ended in the last 24 hours">${items.replace(/<a /g, "<li><a ").replace(/<\/a>/g, "</a></li>")}</ul>`);
  // A count is grouped; a lower bound says "at least" before it; an item with no link is text; one off a phone says so.
  const more = out(ui.sumStrip([{ n: 2000, label: "completed", status: "ok", floor: true }, { n: 3, label: "awaiting input", status: "parked", hidePhone: true }], { label: "s" }));
  assert.equal(more, `<ul class="sumstrip" aria-label="s"><li><span class="sumstrip__i tone-ok"><b><small>at least</small> 2,000</b><span><svg class="ic ic--sm" aria-hidden="true"><use href="#i-done"></use></svg>completed</span></span></li><li class="hide-phone"><span class="sumstrip__i tone-parked"><b>3</b><span><svg class="ic ic--sm" aria-hidden="true"><use href="#i-parked"></use></svg>awaiting input</span></span></li></ul>`);
  assert.throws(() => ui.sumStrip([{ n: 1, label: "x", status: "warn" }], { label: "s" }), RangeError, "a status is a STATUS kind");
  assert.throws(() => ui.sumStrip([{ n: 1, label: "x", tone: "ok" }], { label: "s" }), RangeError, "an unknown item option");
  for (const bad of [Number.NaN, null, undefined, {}]) assert.throws(() => ui.sumStrip([{ n: bad, label: "x" }], { label: "s" }), TypeError, String(bad));
  assert.throws(() => ui.sumStrip([{ n: 1, label: "x", href: "javascript:alert(1)" }], { label: "s" }), RangeError);
  assert.throws(() => ui.sumStrip([], {}), TypeError, "a strip is named");
});

// ---- a parked run's question ----------------------------------------------------------------------------------------------------

test("questionCard and answerForm: the ParkedPhone card's question card, its answer box posting the parked answer's own fields", () => {
  // The card's markup under the kit's names (`pp-` is the card's own prefix), an article and not the panel's section,
  // named for who asks, the id a link to its run, the wait said for a screen reader, the card's quote holding whatever
  // the caller puts there (the console's callers say where the question is read: no question text is on any panel).
  const answer = ui.answerForm({ jobId: "gh-2f6a", id: "answer-gh-2f6a", hint: "Posted to acme/api#131 after you confirm. It resumes the run.", runHref: "/run?id=gh-2f6a" });
  const card = out(ui.questionCard({ jobId: "gh-2f6a", runHref: "/run?id=gh-2f6a", waited: "26m", project: "api", target: html`<a class="link" href="/runs?q=acme%2Fapi%23131">acme/api#131</a>`, where: "triage, mini1", body: "The question is on its issue.", answer }));
  const top = fromCard(`<p class="pp-top"><span class="tile tile--sm tone-parked"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-parked"/></svg></span><b id="pp-q"><span class="code">gh-2f6a</span> asks</b><span class="pp-wait">26m</span></p>`)
    .replaceAll("pp-", "qcard__").replace(` id="qcard__q"`, "").replace(`<span class="code">gh-2f6a</span>`, `<a class="code" href="/run?id=gh-2f6a">gh-2f6a</a>`).replace(">26m<", `><span class="sr">waiting </span>26m<`);
  const meta = `<p class="qcard__meta"><span class="ptag">api</span><a class="link" href="/runs?q=acme%2Fapi%23131">acme/api#131</a><span>triage, mini1</span></p>`;
  assert.equal(card, `<article class="card card--ring tone-parked qcard" aria-label="gh-2f6a asks">${top}${meta}<div class="qcard__body">The question is on its issue.</div>${answer}</article>`);
  // The answer box: the card's hidden label and field, its buttons, its hint, as the parked answer's form. The field
  // posts `text` beside the hidden `jobId`, the names panels/common.mjs parkedAnswerForm posts and the action reads, and
  // takes at most the worker's bound on an answer.
  assert.equal(String(answer), `<form class="act qform" data-action="parked-answer" autocomplete="off"><input type="hidden" name="jobId" value="gh-2f6a"><label class="sr" for="answer-gh-2f6a">Your answer, as the reply on the issue</label><textarea id="answer-gh-2f6a" class="textarea" name="text" rows="3" maxlength="8192" placeholder="Write your answer" required aria-describedby="answer-gh-2f6a-hint"></textarea><div class="qform__act"><button class="btn btn--answer" type="submit"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-comment"></use></svg>Preview the answer</button><a class="btn btn--ghost" href="/run?id=gh-2f6a">Open run</a></div><p class="field__hint" id="answer-gh-2f6a-hint">Posted to acme/api#131 after you confirm. It resumes the run.</p></form>`);
  assert.equal(ui.ANSWER_MAX, ANSWER_TEXT_MAX_BYTES, "the worker's bound on an answer");
  assert.ok(ACTIONS.some((a) => a.name === "parked-answer"), "an action the script posts");
  const legacy = readFileSync(new URL("../src/console/panels/common.mjs", import.meta.url), "utf8");
  assert.match(legacy, /actForm\("parked-answer", \{ hidden: \[\["jobId", jobId\]\], fields: area\("text", /, "the old form's field names, which the kit's keeps");
  // With nothing but its id: no meta line, no body, no answer; no Open run and no hint on a bare form.
  assert.equal(out(ui.questionCard({ jobId: "gh-1", runHref: "/run?id=gh-1" })), `<article class="card card--ring tone-parked qcard" aria-label="gh-1 asks"><p class="qcard__top"><span class="tile tile--sm tone-parked"><svg class="ic ic--sm" aria-hidden="true"><use href="#i-parked"></use></svg></span><b><a class="code" href="/run?id=gh-1">gh-1</a> asks</b></p></article>`);
  const bare = out(ui.answerForm({ jobId: "gh-1", id: "a1", hint: null }));
  assert.ok(!bare.includes("Open run") && !bare.includes("field__hint") && !bare.includes("aria-describedby"), bare);
  assert.throws(() => ui.questionCard({ jobId: "gh-1", runHref: "https://evil.example/" }), RangeError);
  assert.throws(() => ui.questionCard({ jobId: html`<b>x</b>`, runHref: "/run?id=x" }), TypeError, "an id is text: it names the card");
  for (const id of ["q", "p-answer", "Answer", ""]) assert.throws(() => ui.answerForm({ jobId: "gh-1", id, hint: "h" }), RangeError, id);
});

test("SEARCH_ID is reserved, and searchPill is the one helper that writes it", () => {
  assert.equal(ui.SEARCH_ID, "q");
  assert.ok(ui.RESERVED_IDS.includes(ui.SEARCH_ID));
  assert.ok(String(ui.searchPill({ id: ui.SEARCH_ID, name: "q" })).includes(`<input id="q" `));
  for (const fn of [() => ui.input({ id: "q" }), () => ui.select({ id: "q", options: [] }), () => ui.textarea({ id: "q" }), () => ui.btn({ label: "x", id: "q" })]) assert.throws(fn, RangeError);
  for (const id of ["main", "logout", "p-filters", "i-search"]) assert.throws(() => ui.searchPill({ id, name: "q" }), RangeError, `#${id}`);
});

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
  throwsRange(() => ui.textarea({ id: "a", maxLength: 3 }), "an option the kit does not write (its maxlength is spelt as the attribute)");
  for (const bad of [0, -1, 1.5, "3", Number.NaN]) throwsRange(() => ui.textarea({ id: "a", maxlength: bad }), `maxlength ${String(bad)}`);
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
    // PR 3's marks.
    ui.slots({ run: 1, label: H }), ui.capsule({ name: H, window: H, pct: 50, hold: 80 }), ui.capsule({ name: "x", window: "y", pct: 50, label: H }),
    ui.spendDots({ hours: [1], label: H }), ui.waitBar([{ icon: "slot", count: 1 }], { label: H }),
    ui.rowPill({ items: [H], end: { text: H, status: "attention" }, action: { label: H, href: "/run?id=\"><script>" } }), ui.rowPill({ items: [], end: H }), ui.rowPill({ items: [], end: { text: H, faint: true } }),
    ui.actForm({ action: "x", hidden: [["n", H]], label: H }),
    // PR 4's filters, summaries and question card.
    ui.searchPill({ id: "s", name: "q", value: H, label: H, placeholder: H }), ui.filterToggle({ label: H, count: 2 }),
    ui.fpill({ label: H, count: 1, href: "/runs?q=\"><script>" }), ui.fchip({ label: H, value: H, href: "/runs?q=\"><script>" }), ui.chipRow([H], { label: H }),
    ui.sumStrip([{ n: H, label: H, status: "failed", href: "/runs?q=\"><script>" }], { label: H }), ui.tbl({ label: "t", heads: ["a"], rows: [{ group: H }, [H]] }),
    ui.questionCard({ jobId: H, runHref: "/run?id=\"><script>", waited: H, project: H, target: H, where: H, body: H, answer: H }),
    ui.answerForm({ jobId: H, id: "a", hint: H, runHref: "/run?id=\"><script>" }),
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
    ui.outLink({ href: docsHref("docs/triggers.md"), label: "What triggers can do", btn: "ghost" }),
    ui.field({ label: "Answer", id: "answer", control: ui.textarea({ id: "answer" }), hint: "h", error: "e" }),
    // PR 4's: the filter pills and chips, the summary strip's links, the question card's run link and its Open run.
    ui.chipRow([ui.fpill({ label: "web", count: 2, href: ui.pageHref(PAGES, "runs", { project: "web" }), on: true }), ui.fchip({ label: "Outcome", value: "failed", href: ui.pageHref(PAGES, "runs") })], { label: "Filters" }),
    ui.sumStrip([{ n: 1, label: "failed", status: "failed", href: ui.pageHref(PAGES, "runs", { outcome: "failed" }) }], { label: "Runs" }),
    ui.questionCard({ jobId: "gh-2f6a", runHref: ui.pageHref(PAGES, "run", { id: "gh-2f6a" }), answer: ui.answerForm({ jobId: "gh-2f6a", id: "answer-1", hint: "h", runHref: ui.pageHref(PAGES, "run", { id: "gh-2f6a" }) }) }),
    ui.searchPill({ id: ui.SEARCH_ID, name: "q" }),
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
  // The frame's headline panel, as the shell draws it for a page that has one (PR 3: the overview's).
  pages.push(String(shellHtml("overview", { session: { name: "ops", role: "operator" }, data: { now: 0, env: {} }, query: {} }, html``, { headline: "All clear." })));
  for (const page of pages) for (const m of frameOf(page).matchAll(/\sid="([^"]+)"/g)) frameIds.add(m[1]);
  assert.ok(frameIds.has("main") && frameIds.has("p-nav-parked") && frameIds.has(HEADLINE_ID) && frameIds.has("i-runs"), [...frameIds].slice(0, 12).join(", "));
  // PR 2's: the live notes' region, the one confirm slot and the held note's template, found by the script by id.
  for (const id of ["live-note", "confirm-slot", "held-note"]) assert.ok(frameIds.has(id), `the frame draws #${id}`);
  // The frame's own panels (the Parked count, the headline) are named here although their family is refused too: the
  // list is where a reader looks for the ids the frame owns.
  for (const id of SHELL_PANEL_IDS) assert.ok(ui.RESERVED_IDS.includes(id) && frameIds.has(id), `#${id} is listed and drawn`);
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
  // Every class the kit writes (and the samples' own `code`, `link` and `reason`) is a class PULSE_CSS has a rule for,
  // or one of the few the console styles itself where bundle.css has none (the kit's header): the summary strip, a
  // table's day rows and a chip row in the runs page's rules, the question card and its form in the card's own, which
  // every page that draws one serves. Each of those is named, so a class added to the kit that nothing styles fails.
  const own = new Map([[RUNS_CSS, ["chip__x", "chiprow", "sumstrip", "sumstrip__i", "tbl-group"]], [QCARD_CSS, ["qcard", "qcard__body", "qcard__meta", "qcard__top", "qcard__wait", "qform", "qform__act"]]]);
  const styledBy = (css, c) => selectorsOf(css).some((sel) => new RegExp(`\\.${c.replace(/[-_]/g, "\\$&")}(?![a-z0-9_-])`).test(sel));
  const classes = new Set(OUT.flatMap((s) => Array.from(s.matchAll(/\sclass="([^"]*)"/g), (m) => m[1].split(" "))).flat());
  for (const c of classes) {
    const page = [...own].find(([, names]) => names.includes(c));
    if (page) assert.ok(styledBy(page[0], c), `.${c} is styled by the rules the kit's header names for it`);
    else assert.match(PULSE_CSS, new RegExp(`\\.${c.replace(/[-_]/g, "\\$&")}(?![a-z0-9_-])`), `.${c} is styled by the stylesheet`);
  }
  for (const [, names] of own) for (const c of names) assert.ok(classes.has(c), `.${c} is a class the kit writes`);
  for (const [, names] of own) for (const c of names) assert.doesNotMatch(PULSE_CSS, new RegExp(`\\.${c.replace(/[-_]/g, "\\$&")}(?![a-z0-9_-])`), `.${c} is not bundle.css's: it would be styled twice`);
});

test("a banner's block body holds paragraphs without nesting a paragraph inside another", () => {
  const body = html`<p>What happened.</p><p>What to do.</p>`;
  const text = out(ui.banner({ status: "failed", title: "Run failed", body, block: true }));
  assert.match(text, /<div class="banner__s"><p>What happened\.<\/p><p>What to do\.<\/p><\/div>/);
  assert.doesNotMatch(text, /<p class="banner__s"><p>/);
});
