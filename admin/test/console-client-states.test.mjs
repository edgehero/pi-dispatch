import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { CONFIRM_NO_ANSWER, CONFIRM_SIGNED_OUT, CONFIRM_SLOT_ID, HELD_NOTE_CHIP, HELD_NOTE_TEXT, bulkResultsHtml, heldNoteHtml, previewBarHtml, refusalHtml, unchangedBarHtml } from "../src/console/confirm-view.mjs";
import { html, page } from "../src/console/html.mjs";
import { actForm, area, editor, field } from "../src/console/panels/common.mjs";
import { CONSOLE_SCRIPT, RETRY_MS, SIGN_IN_GAVE_UP, SIGN_IN_RETRY_FOR_MS, SIGN_IN_TRIES_MAX, SIGN_OUT_TIMEOUT_MS, SIGN_OUT_UNCONFIRMED, STALE_TOKENS_BODY } from "../src/console/script.mjs";
import { PERSON_CHANGED } from "../src/console/server.mjs";
import { ENDED_REASONS, NOTICE_OF_STATUS, PERSON_HEADER, PERSON_PARAM, SIGN_IN_NOTICES, STREAM_ENDS, STREAM_SHUTDOWN } from "../src/console/session-ends.mjs";
import { LIVE_NOTES, LIVE_STATES, SEARCH_HREF, loginCodePage, loginPage, shellHtml } from "../src/console/shell.mjs";
import { errorPage } from "../src/console/error-pages.mjs";
import * as ui from "../src/console/kit.mjs";
import { runTranscriptSection } from "../src/console/transcript.mjs";
import * as configUi from "../src/console/panels/config-ui.mjs";
import { CLIENT_STATES, LEDGER_CARDS, T } from "./helpers/client-states.mjs";
import { parseDocument, runConsoleScript, shown, trapGlobalFetch } from "./helpers/script-dom.mjs";

// Issue #737, PR 2: the browser script in every state a card names, run over the server's OWN markup (the shell, the
// sign-in pages, the confirm slot and the bars confirm-view.mjs draws), so what is checked is that the script shows the
// state the server drew for it, and nothing it made up. The DOM, the stream, fetch and the clock are stubs
// (`helpers/script-dom.mjs`); every test runs with Node's own fetch trapped, so a stub left out fails instead of
// reaching the network. `helpers/client-states.mjs` lists each state with the test here that reaches it.

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const OPERATOR = Object.freeze({ name: "ops", role: "operator" });
const UNDO = "Cannot be undone from here: no console action removes a waiting job; once it runs, Cancel stops it.";

/** A test that fails if the script reached Node's own `fetch`. */
const stateTest = (name, fn) => test(name, () => trapGlobalFetch(fn));

/**
 * The fleet page as the shell draws it for an operator who can write, each legacy panel in its own wrapper: the
 * fleet's pause form, a table whose cell holds a retry form with the bulk editor under it, and a JSON field's form.
 * `flash` is the session's last write, which the shell draws as the done banner.
 */
function fleetPage({ flash = null, maxStreams = 4 } = {}) {
  const state = html`<section id="p-fleet-state" data-panel><h2>Fleet</h2>${actForm("fleet-pause", { label: "Pause the fleet" })}</section>`;
  const failed = html`<section id="p-fleet-failed" data-panel><h2>Failed jobs</h2><div class="scroll"><table class="grid"><tbody><tr><td>gh-1</td><td class="acts">${actForm("retry-failed", { hidden: [["jobId", "gh-1"], ["queue", "jobs"]], label: "Retry" })}</td></tr></tbody></table></div>${editor("Retry failed jobs in bulk", actForm("retry-all-failed", { fields: field("repo", "Repository"), label: "Preview retry of all" }))}</section>`;
  const windows = html`<section id="p-fleet-windows" data-panel><h2>Pause windows</h2>${actForm("pause-windows", { fields: area("windows", "Pause windows, as JSON", { type: "json" }), label: "Preview the windows" })}</section>`;
  const ctx = { session: OPERATOR, readOnly: false, data: { parkedCount: 3, now: NOW }, query: {}, theme: null, flash, maxStreams };
  const body = shellHtml("fleet", ctx, html`${state}${failed}${windows}`);
  return String(page({ title: "pi-dispatch console: Fleet", name: "fleet", body, live: "fleet", query: "" }));
}

/**
 * A page laid out as the overview is (issue #737), with no `.legacy` wrapper: a row of cards in a grid marked
 * `data-slot-after`, then two columns of stacked cards, which carry no mark; and, past the overview's own layout, a
 * marked grid inside another.
 */
function gridPage() {
  const card = (id, form) => html`<section id="${id}" data-panel><h2>${id}</h2>${form}</section>`;
  const retry = actForm("retry-failed", { hidden: [["jobId", "gh-1"], ["queue", "jobs"]], label: "Retry" });
  const cancel = actForm("cancel-queued", { hidden: [["jobId", "gh-2"], ["queue", "jobs"]], label: "Cancel" });
  const hostPause = actForm("queue-pause", { hidden: [["queue", "pi-jobs@build3"]], label: "Pause build3" });
  const row = html`<div class="cards-4" data-slot-after>${card("p-needs", retry)}${card("p-waiting", cancel)}${card("p-active", "")}${card("p-spend", "")}</div>`;
  const columns = html`<div class="cols"><div class="stack">${card("p-timeline", "")}</div><div class="stack">${card("p-hosts", hostPause)}</div></div>`;
  const nested = html`<div class="cols" data-slot-after><div class="cards-4" data-slot-after>${card("p-inner", actForm("fleet-pause", { label: "Pause the fleet" }))}</div></div>`;
  const ctx = { session: OPERATOR, readOnly: false, data: { parkedCount: 0, now: NOW }, query: {}, theme: null, maxStreams: 4 };
  return String(page({ title: "pi-dispatch console: Overview", name: "overview", body: shellHtml("overview", ctx, html`${row}${columns}${nested}`), live: "overview", query: "" }));
}

/** A run page with its live transcript section, as `renderPage` draws one for an operator. */
function runPage() {
  const view = { role: "operator", query: { id: "gh-1" }, data: { transcript: { exists: true, ended: false } } };
  const ctx = { session: OPERATOR, readOnly: false, data: { parkedCount: 0, now: NOW }, query: { id: "gh-1" }, theme: null, maxStreams: 4 };
  const inner = html`<section id="p-run" data-panel><h2>Run</h2></section><section id="p-transcript" data-panel><p data-transcript-status>waiting</p></section><section id="transcript">${runTranscriptSection(view)}</section>`;
  return String(page({ title: "pi-dispatch console: Run", name: "run", body: shellHtml("run", ctx, inner), live: "run", query: "id=gh-1" }));
}

// Elements are compared with `===` inside `assert.ok`, never handed to `assert.equal`: an assertion's message inspects its
// values with custom inspection off, and a node holds the whole page through its parent, so a failing compare of two
// elements spends minutes formatting.
const boot = (markup, opts = {}) => runConsoleScript(CONSOLE_SCRIPT, markup, opts);
const slotOf = (w) => w.document.getElementById(CONFIRM_SLOT_ID);
const formOf = (w, action) => w.document.querySelector(`form[data-action="${action}"]`);
const text = (el) => String(el?.textContent ?? "").replace(/\s+/g, " ").trim();
const pill = (w) => {
  const s = w.document.getElementById("live-status");
  return { cls: s.className, word: s.querySelector("[data-live-word]").textContent };
};
const notes = (w) => w.document.querySelectorAll("#live-note [data-live-note]").filter((n) => !n.hidden).map((n) => n.getAttribute("data-live-note"));
const notices = (w) => w.document.querySelectorAll("#notice [data-notice]").filter((n) => !n.hidden).map((n) => n.getAttribute("data-notice"));
/** The run page's transcript line, as a reader sees it. */
const tstatus = (w) => text(w.document.querySelector("[data-transcript-status]"));
const linkStates = (w) => w.document.querySelectorAll("[data-link-state]").filter((n) => !n.hidden).map((n) => n.getAttribute("data-link-state"));
const calls = (w, url) => w.fetch.calls.filter((c) => c.url === url);
const bar = (opts = {}) => String(previewBarHtml({ title: "Retry gh-1", lines: ["queue jobs"], undo: UNDO, expiresAt: NOW + 300_000, now: NOW, ...opts }));

/** The fleet page with the retry form previewed and its bar in the slot. */
async function previewed(barOpts = {}) {
  const w = boot(fleetPage());
  w.submit(formOf(w, "retry-failed"));
  await w.fetch.open("/api/act/retry-failed/preview").answer(200, { ok: true, ticket: "tk-1", action: "retry-failed", html: bar(barOpts) });
  return w;
}

// ---- the confirm slot (ConfirmStates) ------------------------------------------------------------------------------

stateTest(T.previewing, async () => {
  const w = boot(fleetPage());
  const slot = slotOf(w);
  assert.ok(slot, "an operator's page carries the slot");
  assert.equal(slot.hidden, true, "drawn hidden");
  const skeleton = slot.innerHTML;
  w.submit(formOf(w, "fleet-pause"));
  const panel = w.document.getElementById("p-fleet-state");
  assert.ok(panel.nextElementSibling === slot, "the slot goes right after the panel that asked");
  assert.equal(slot.parentElement.id, "main");
  assert.deepEqual(["[data-panel]", "td"].map((q) => slot.closest(q) === null), [true, true], "never inside a panel or a table cell");
  assert.ok(shown(slot));
  assert.equal(text(slot.querySelector("[data-slot-title]")), "Previewing: Pause the fleet");
  assert.equal(slot.querySelector("[data-confirm]").disabled, true, "Confirm waits for a ticket");
  assert.equal(slot.querySelector(".confirm").getAttribute("aria-busy"), "true");
  assert.ok(shown(slot.querySelector(".confirm__ghost")), "the grey lines");
  assert.equal(shown(slot.querySelector("[data-slot-message]")), false);
  assert.deepEqual(w.fetch.calls.map((c) => [c.method, c.url, c.body]), [["POST", "/api/act/fleet-pause/preview", {}]]);
  // The page's person rides every preview (issue #737): the header the server holds to the cookie's session.
  assert.equal(w.fetch.calls[0].init.headers[PERSON_HEADER], "ops.operator");
  // A form in a table cell: the slot goes after its panel, out of the cell and the scroll box.
  w.submit(formOf(w, "retry-failed"));
  assert.ok(w.document.getElementById("p-fleet-failed").nextElementSibling === slot);
  assert.ok(slot.closest("td") === null);
  assert.equal(text(slot.querySelector("[data-slot-title]")), "Previewing: Retry");
  assert.deepEqual(w.fetch.calls[1].body, { jobId: "gh-1", queue: "jobs" }, "the form's own fields, typed as drawn");
  // The first preview's answer arrives after the slot moved on: it is dropped.
  await w.fetch.calls[0].answer(200, { ok: true, ticket: "tk-0", html: bar({ title: "Pause the fleet" }) });
  assert.equal(text(slot.querySelector("[data-slot-title]")), "Previewing: Retry");
  assert.equal(slot.querySelector("[data-confirm]").disabled, true);
  assert.ok(skeleton.includes("data-slot-title"), "the skeleton was read as the server drew it");

  // A layout grid (issue #737): the slot is never one of its cells. A card in the overview's row of cards puts it after
  // the row; a card in a column, which is no grid, keeps it right under the card; marked grids one inside another put
  // it after the outermost.
  const g = boot(gridPage());
  const gslot = slotOf(g);
  const el = (id) => g.document.getElementById(id);
  g.submit(formOf(g, "cancel-queued"));
  const row = el("p-waiting").parentElement;
  assert.ok(row.hasAttribute("data-slot-after") && row.classList.contains("cards-4"));
  assert.ok(row.nextElementSibling === gslot, "the slot goes after the row of cards, not in it after the card");
  assert.equal(gslot.parentElement.id, "main");
  assert.deepEqual(["[data-panel]", ".cards-4", "[data-slot-after]"].map((q) => gslot.closest(q) === null), [true, true, true], "never inside a panel or a marked grid");
  assert.equal(text(gslot.querySelector("[data-slot-title]")), "Previewing: Cancel");
  assert.ok(shown(gslot));
  g.submit(formOf(g, "retry-failed"));
  assert.ok(row.nextElementSibling === gslot, "any card of the row: the same place");
  g.submit(formOf(g, "queue-pause"));
  assert.ok(el("p-hosts").nextElementSibling === gslot, "a column keeps the slot right after its card");
  assert.ok(gslot.parentElement === el("p-hosts").parentElement);
  assert.equal(gslot.parentElement.className, "stack");
  g.submit(formOf(g, "fleet-pause"));
  assert.ok(el("p-inner").parentElement.parentElement.nextElementSibling === gslot, "nested marked grids: after the outermost");
  assert.equal(gslot.parentElement.id, "main");
  assert.deepEqual(g.fetch.calls.map((c) => c.url), ["/api/act/cancel-queued/preview", "/api/act/retry-failed/preview", "/api/act/queue-pause/preview", "/api/act/fleet-pause/preview"]);
  // A round button is its icon: the slot names its preview by the button's aria-label, never the action's machine name.
  const round = formOf(g, "fleet-pause");
  const icon = round.querySelector("button[type=submit]");
  icon.textContent = "";
  icon.setAttribute("aria-label", "Pause queue pi-jobs@build3");
  g.submit(round);
  assert.equal(text(gslot.querySelector("[data-slot-title]")), "Previewing: Pause queue pi-jobs@build3");
});

test("a preview brings the slot into view and gives its title the focus, wherever the slot was put; an answer keeps the focus in the slot, and never takes it from elsewhere", () => trapGlobalFetch(async () => {
  // The overview's row of cards puts the slot after the whole row, which on a phone is a screen or more below the button
  // that asked: without the scroll and the focus the bar opens out of sight and the keyboard stays on the button.
  const g = boot(gridPage());
  const gslot = slotOf(g);
  const title = () => gslot.querySelector("[data-slot-title]");
  for (const action of ["cancel-queued", "queue-pause", "fleet-pause"]) {
    const from = g.document.scrolls.length;
    const button = formOf(g, action).querySelector("button[type=submit]");
    button.focus();
    g.submit(formOf(g, action), button);
    assert.deepEqual(g.document.scrolls.slice(from).map((x) => [x.el === gslot, x.options]), [[true, { block: "nearest" }]], `${action}: the slot is scrolled into view, by the least move`);
    assert.ok(g.document.activeElement === title(), `${action}: the focus is on the slot's title`);
    assert.equal(title().getAttribute("tabindex"), "-1", `${action}: focusable by script, never in the tab order`);
  }
  // The answer replaces the title that held the focus: the focus goes to the bar's heading, never to the page's body.
  await g.fetch.open("/api/act/fleet-pause/preview").answer(200, { ok: true, ticket: "tk-1", action: "fleet-pause", html: bar({ title: "Pause the fleet" }) });
  const heading = gslot.querySelector(".confirm__h");
  assert.equal(text(heading), "Pause the fleet");
  assert.ok(g.document.activeElement === heading, "the bar's heading holds the focus");
  assert.equal(heading.getAttribute("tabindex"), "-1");
  // A reader who moved on before the answer keeps their place: an answer takes no focus it did not have.
  g.submit(formOf(g, "retry-failed"));
  const elsewhere = formOf(g, "cancel-queued").querySelector("button[type=submit]");
  elsewhere.focus();
  await g.fetch.open("/api/act/retry-failed/preview").answer(200, { ok: true, ticket: "tk-2", action: "retry-failed", html: bar() });
  assert.equal(text(gslot.querySelector(".confirm__h")), "Retry gh-1");
  assert.ok(g.document.activeElement === elsewhere, "the focus stays where the reader put it");
  // The legacy pages' slot (after a panel's wrapper) is brought into view the same way.
  const w = boot(fleetPage());
  w.submit(formOf(w, "retry-failed"));
  assert.ok(w.document.scrolls.length === 1 && w.document.scrolls[0].el === slotOf(w));
  assert.ok(w.document.activeElement === slotOf(w).querySelector("[data-slot-title]"));
}));

test("every fill while the slot is open brings it into view again (the answer, a refusal, the script's own sentence), and a closed slot is never scrolled", () => trapGlobalFetch(async () => {
  // The scroll at open measured the skeleton; the answer is taller, and with the slot near the fold its Confirm landed
  // below it. Each fill asks for the least scroll again, after the new markup is in, so its size is the answer's.
  const g = boot(gridPage());
  const gslot = slotOf(g);
  const scrolled = (from) => g.document.scrolls.slice(from).map((x) => [x.el === gslot, x.options]);
  const once = [[true, { block: "nearest" }]];
  let from = g.document.scrolls.length;
  g.submit(formOf(g, "retry-failed"));
  assert.deepEqual(scrolled(from), once, "at open");
  from = g.document.scrolls.length;
  await g.fetch.open("/api/act/retry-failed/preview").answer(200, { ok: true, ticket: "tk-1", action: "retry-failed", html: bar({ lines: ["queue jobs", "attempt 2 of 3", "its trigger's model"], reserve: "The job holds up to $2.00 of the budget while it runs.", paid: true }) });
  assert.ok(gslot.querySelector("[data-confirm]") && gslot.querySelector(".confirm__note"), "the answer is in");
  assert.deepEqual(scrolled(from), once, "after the answer, once its size is known");
  // A refused confirm's bar replaces the answer: in view again.
  gslot.querySelector("[data-confirm]").click();
  from = g.document.scrolls.length;
  const moved = "the job changed since the preview, so nothing was changed";
  await g.fetch.open("/api/act/retry-failed/confirm").answer(409, { error: moved, html: String(refusalHtml({ where: "confirm", sentence: moved, status: 409 })) });
  assert.deepEqual(scrolled(from), once, "after a refusal");
  // The script's own sentence in the skeleton (an answer with no html), and a field it cannot read: in view again.
  g.submit(formOf(g, "cancel-queued"));
  from = g.document.scrolls.length;
  await g.fetch.open("/api/act/cancel-queued/preview").answer(502, "<html>Bad gateway</html>");
  assert.equal(text(gslot.querySelector("[data-slot-message]")), "The console refused the request (502).");
  assert.deepEqual(scrolled(from), once, "after the script's own sentence, with the sentence in");
  // Closed: no fill scrolls it, and an answer for a slot since closed is dropped unscrolled.
  g.submit(formOf(g, "queue-pause"));
  gslot.querySelector("[data-cancel]").click();
  assert.equal(gslot.hidden, true);
  from = g.document.scrolls.length;
  await g.fetch.open("/api/act/queue-pause/preview").answer(200, { ok: true, ticket: "tk-2", action: "queue-pause", html: bar({ title: "Pause queue pi-jobs@build3" }) });
  assert.deepEqual(scrolled(from), [], "a closed slot is never scrolled");
}));

test("closing the slot gives the focus back to the button that opened it, else to the card that asked, only when the focus was in the slot", () => trapGlobalFetch(async () => {
  // Close and Cancel put the skeleton back, which removes the control that held the focus: the browser then gave it to
  // the page's body, and the next Tab started from the top of the page, in another panel.
  const g = boot(gridPage());
  const gslot = slotOf(g);
  const el = (id) => g.document.getElementById(id);
  const opener = (action) => formOf(g, action).querySelector("button[type=submit]");
  // Cancel on the preview's bar: the button that opened the slot.
  opener("cancel-queued").focus();
  g.submit(formOf(g, "cancel-queued"), opener("cancel-queued"));
  await g.fetch.open("/api/act/cancel-queued/preview").answer(200, { ok: true, ticket: "tk-1", action: "cancel-queued", html: bar({ title: "Cancel gh-2" }) });
  assert.ok(gslot.contains(g.document.activeElement), "the focus is in the slot");
  gslot.querySelector("[data-cancel]").click();
  assert.equal(gslot.hidden, true);
  assert.ok(g.document.activeElement === opener("cancel-queued"), "Cancel: back on the button that opened it");
  // Close on a no-change bar, from a column's card: the same.
  g.submit(formOf(g, "queue-pause"));
  await g.fetch.open("/api/act/queue-pause/preview").answer(200, { ok: true, unchanged: true, action: "queue-pause", summary: ["pi-jobs@build3 is already paused"], html: String(unchangedBarHtml({ summary: ["pi-jobs@build3 is already paused"] })) });
  gslot.querySelector("[data-close]").click();
  assert.ok(g.document.activeElement === opener("queue-pause"), "Close: back on the button that opened it");
  // Close after an answer, when Preview again opened it a second time: still the button the reader pressed.
  g.submit(formOf(g, "retry-failed"));
  await g.fetch.open("/api/act/retry-failed/preview").answer(200, { ok: true, ticket: "tk-2", action: "retry-failed", html: bar() });
  gslot.querySelector("[data-confirm]").click();
  const expired = "this confirmation has expired. Preview the change again and confirm the new preview";
  await g.fetch.open("/api/act/retry-failed/confirm").answer(409, { error: expired, html: String(refusalHtml({ where: "confirm", sentence: expired, status: 409 })) });
  gslot.querySelector("[data-again]").click();
  await g.fetch.open("/api/act/retry-failed/preview").answer(400, { error: "it is no longer failed", html: String(refusalHtml({ where: "preview", sentence: "it is no longer failed", status: 400 })) });
  gslot.querySelector("[data-close]").click();
  assert.ok(g.document.activeElement === opener("retry-failed"), "after an answer: back on the button that opened it");
  // A browser that does not focus a button on a click leaves the body focused when Cancel is pressed: given back too.
  g.submit(formOf(g, "fleet-pause"));
  g.document.activeElement.blur();
  assert.ok(g.document.activeElement === g.document.body);
  gslot.querySelector("[data-cancel]").click();
  assert.ok(g.document.activeElement === opener("fleet-pause"), "from the body: back on the button");
  // The reader moved on before closing: the focus stays where they put it.
  g.submit(formOf(g, "cancel-queued"));
  opener("retry-failed").focus();
  gslot.querySelector("[data-cancel]").click();
  assert.ok(g.document.activeElement === opener("retry-failed"), "focus elsewhere is never taken");
  assert.equal(el("p-waiting").hasAttribute("tabindex"), false, "and no card was made focusable");
  // The stream swapped the button's panel while the slot held it: Cancel lands the update, the button is gone, and the
  // focus goes to the card that asked, focusable by script alone.
  const w = boot(fleetPage());
  const wslot = slotOf(w);
  const panel = w.document.getElementById("p-fleet-state");
  w.submit(formOf(w, "fleet-pause"));
  w.streams[0].emit("panel", { id: "p-fleet-state", html: "<h2>Fleet</h2><p>paused</p>" });
  wslot.querySelector("[data-cancel]").click();
  assert.equal(panel.innerHTML, "<h2>Fleet</h2><p>paused</p>", "the update landed");
  assert.ok(w.document.activeElement === panel, "the card that asked");
  assert.equal(panel.getAttribute("tabindex"), "-1", "focusable by script, never in the tab order");
  // The done banner's Undo: back on the Undo button.
  const change = { summary: "Paused the fleet", by: "ops", auditSeq: 44, count: 1, undo: "Resume it with the button here.", inverse: { action: "fleet-resume", body: {} }, kind: "fleet", at: NOW };
  const b = boot(fleetPage({ flash: change }));
  const undo = b.document.querySelector('main > .banner form[data-action="fleet-resume"] button');
  undo.click();
  slotOf(b).querySelector("[data-cancel]").click();
  assert.ok(b.document.activeElement === undo, "the Undo button");
}));

test("where a swap replaced the button that opened the slot, closing it gives the focus to the same form's button in the swapped card, else to the card", () => trapGlobalFetch(async () => {
  // On the overview the Hosts card is drawn anew on every tick, so while the slot held it its button was always
  // replaced, and the focus always fell to the card.
  const g = boot(gridPage());
  const gslot = slotOf(g);
  const panel = g.document.getElementById("p-hosts");
  const opener = formOf(g, "queue-pause").querySelector("button[type=submit]");
  opener.focus();
  g.submit(formOf(g, "queue-pause"), opener);
  await g.fetch.open("/api/act/queue-pause/preview").answer(200, { ok: true, ticket: "tk-1", action: "queue-pause", html: bar({ title: "Pause queue pi-jobs@build3" }) });
  // The card drawn again while the slot held it: a form of the same action for another queue first, then the opener's.
  const pause = (queue, label) => actForm("queue-pause", { hidden: [["queue", queue]], label });
  g.streams[0].emit("panel", { id: "p-hosts", html: String(html`<h2>p-hosts</h2>${pause("pi-jobs@mini2", "Pause mini2")}${pause("pi-jobs@build3", "Pause build3")}`) });
  gslot.querySelector("[data-cancel]").click();
  assert.equal(panel.querySelectorAll(".held").length, 0, "the update landed");
  assert.equal(g.document.contains(opener), false, "the opener is gone");
  const forms = panel.querySelectorAll('form[data-action="queue-pause"]');
  assert.ok(g.document.activeElement === forms[1].querySelector("button[type=submit]"), "the swapped card's button that does what the opener did");
  assert.equal(panel.hasAttribute("tabindex"), false, "and the card was not made focusable");
  // A swapped card with no form of that action and those hidden fields: the card.
  forms[1].querySelector("button[type=submit]").focus();
  g.submit(forms[1], forms[1].querySelector("button[type=submit]"));
  g.streams[0].emit("panel", { id: "p-hosts", html: String(html`<h2>p-hosts</h2>${pause("pi-jobs@mini2", "Pause mini2")}`) });
  gslot.querySelector("[data-cancel]").click();
  assert.ok(g.document.activeElement === panel, "the card that asked");
  assert.equal(panel.getAttribute("tabindex"), "-1");
}));

test("a focused button never holds its panel: after Cancel gives the focus back to the button that opened the slot, the panel's next update lands", () => trapGlobalFetch(async () => {
  const g = boot(gridPage());
  const gslot = slotOf(g);
  const panel = g.document.getElementById("p-waiting");
  const opener = formOf(g, "cancel-queued").querySelector("button[type=submit]");
  opener.focus();
  g.submit(formOf(g, "cancel-queued"), opener);
  await g.fetch.open("/api/act/cancel-queued/preview").answer(200, { ok: true, ticket: "tk-1", action: "cancel-queued", html: bar({ title: "Cancel gh-2" }) });
  gslot.querySelector("[data-cancel]").click();
  assert.ok(g.document.activeElement === opener, "the focus is back on the opener");
  g.streams[0].emit("panel", { id: "p-waiting", html: "<h2>p-waiting</h2><p>NEW</p>" });
  assert.equal(panel.innerHTML, "<h2>p-waiting</h2><p>NEW</p>", "the update landed, with no kept-still note");
  // A button focused with no slot open holds nothing either; a field focused in the same panel's form still does.
  const f = boot(fleetPage());
  const failed = f.document.getElementById("p-fleet-failed");
  formOf(f, "retry-failed").querySelector("button[type=submit]").focus();
  f.streams[0].emit("panel", { id: "p-fleet-failed", html: String(html`<h2>Failed jobs</h2>${editor("Retry failed jobs in bulk", actForm("retry-all-failed", { fields: field("repo", "Repository"), label: "Preview retry of all" }))}`) });
  assert.equal(failed.querySelectorAll(".held").length, 0, "a button: the update landed");
  f.document.querySelector('input[name="repo"]').focus();
  f.streams[0].emit("panel", { id: "p-fleet-failed", html: "<p>fresh</p>" });
  assert.equal(failed.firstElementChild.className, "held", "a field: held");
}));

test("a swap never drops the focus: a focused button goes to the same form's button in the new markup, a link to the same link, else to the panel", () => trapGlobalFetch(async () => {
  // On the overview the Hosts card is drawn anew on every tick; a swap that let the focus fall to the page's body sent
  // a keyboard reader back to the card's first control each tick, so its later rows could not be reached.
  const g = boot(gridPage());
  const panel = g.document.getElementById("p-hosts");
  const pause = (queue, label) => actForm("queue-pause", { hidden: [["queue", queue]], label });
  const tick = (markup) => g.streams[0].emit("panel", { id: "p-hosts", html: String(markup) });
  formOf(g, "queue-pause").querySelector("button[type=submit]").focus();
  tick(html`<h2>p-hosts</h2>${pause("pi-jobs@mini2", "Pause mini2")}${pause("pi-jobs@build3", "Pause build3")}<a href="/fleet">Open Fleet</a>`);
  const forms = panel.querySelectorAll('form[data-action="queue-pause"]');
  assert.ok(g.document.activeElement === forms[1].querySelector("button[type=submit]"), "the same form's button");
  assert.equal(panel.querySelectorAll(".held").length, 0, "and nothing was held");
  assert.equal(panel.hasAttribute("tabindex"), false);
  panel.querySelector("a[href]").focus();
  tick(html`<h2>p-hosts</h2>${pause("pi-jobs@mini2", "Pause mini2")}<a href="/fleet">Open Fleet</a>`);
  assert.ok(g.document.activeElement === panel.querySelector('a[href="/fleet"]'), "the same link");
  tick(html`<h2>p-hosts</h2><p>No host beats.</p>`);
  assert.ok(g.document.activeElement === panel, "else the panel");
  assert.equal(panel.getAttribute("tabindex"), "-1");
  tick(html`<h2>p-hosts</h2>${pause("pi-jobs@mini2", "Pause mini2")}`);
  assert.ok(g.document.activeElement === panel, "a focused panel keeps it");
  // Focus outside the swapped panel is never taken.
  const elsewhere = formOf(g, "retry-failed").querySelector("button[type=submit]");
  elsewhere.focus();
  tick(html`<h2>p-hosts</h2>${pause("pi-jobs@build3", "Pause build3")}`);
  assert.ok(g.document.activeElement === elsewhere, "the focus stays where the reader put it");
}));

test("every change the script makes while the slot shows brings it into view again, never a slot scrolled away or closed", () => trapGlobalFetch(async () => {
  // At 1440 px the Hosts card took its kept-still note about 200 ms after the answer and pushed Pause's Confirm below
  // the fold; a panel swapped above the slot, a live note shown or hidden and the sign-out banner move it the same way.
  const g = boot(gridPage());
  const gslot = slotOf(g);
  const scrolled = (from) => g.document.scrolls.slice(from).map((x) => [x.el === gslot, x.options]);
  const once = [[true, { block: "nearest" }]];
  g.submit(formOf(g, "queue-pause"));
  await g.fetch.open("/api/act/queue-pause/preview").answer(200, { ok: true, ticket: "tk-1", action: "queue-pause", html: bar({ title: "Pause queue pi-jobs@build3" }) });
  const es = g.streams[0];
  let from = g.document.scrolls.length;
  es.emit("panel", { id: "p-hosts", html: "<h2>p-hosts</h2><p>one</p>" });
  assert.equal(g.document.getElementById("p-hosts").firstElementChild.className, "held");
  assert.deepEqual(scrolled(from), once, "the kept-still note");
  from = g.document.scrolls.length;
  es.emit("panel", { id: "p-hosts", html: "<h2>p-hosts</h2><p>two</p>" });
  assert.deepEqual(scrolled(from), [], "an update that waits changes nothing on the page");
  from = g.document.scrolls.length;
  es.emit("panel", { id: "p-needs", html: "<h2>p-needs</h2><p>a row more</p>" });
  assert.deepEqual(scrolled(from), once, "a panel swapped");
  from = g.document.scrolls.length;
  es.emit("stale", { since: NOW });
  assert.deepEqual(notes(g), ["stale"]);
  assert.deepEqual(scrolled(from), once, "the stale note, once for its words and its showing");
  from = g.document.scrolls.length;
  es.emit("fresh");
  assert.deepEqual(scrolled(from), once, "the stale note hidden");
  from = g.document.scrolls.length;
  g.document.getElementById("logout").click();
  await g.fetch.open("/logout").answer(500, {});
  assert.ok(g.document.querySelector('[data-signout="unconfirmed"]'));
  assert.deepEqual(scrolled(from), once, "the sign-out banner");
  // The reader scrolled the slot wholly out of view to read another card: their place stands; a slot partly in view
  // is brought in whole.
  const h = boot(gridPage(), { innerHeight: 800 });
  const hslot = slotOf(h);
  h.submit(formOf(h, "queue-pause"));
  let box = { top: 900, bottom: 1100 };
  hslot.getBoundingClientRect = () => box;
  from = h.document.scrolls.length;
  h.streams[0].emit("panel", { id: "p-needs", html: "<p>x</p>" });
  assert.equal(h.document.scrolls.length, from, "below the window: not scrolled");
  box = { top: -300, bottom: -20 };
  h.streams[0].emit("panel", { id: "p-needs", html: "<p>y</p>" });
  assert.equal(h.document.scrolls.length, from, "above the window: not scrolled");
  box = { top: 700, bottom: 900 };
  h.streams[0].emit("panel", { id: "p-needs", html: "<p>z</p>" });
  assert.ok(h.document.scrolls.length === from + 1 && h.document.scrolls[from].el === hslot, "partly in view: brought in");
  // Closed: no change scrolls it.
  hslot.querySelector("[data-cancel]").click();
  from = h.document.scrolls.length;
  h.streams[0].emit("panel", { id: "p-needs", html: "<p>w</p>" });
  h.streams[0].emit("stale", { since: NOW });
  assert.equal(h.document.scrolls.length, from, "a closed slot is never scrolled");
}));

test("a bar's times are shown as the page's are: each <time> the answer drew gets the reader's zone and the UTC title", async () => {
  const w = boot(fleetPage());
  const slot = slotOf(w);
  w.submit(formOf(w, "fleet-pause"));
  const at = '<time datetime="2026-10-08T15:39:08.000Z">2026-10-08 15:39 UTC</time>';
  await w.fetch.open("/api/act/fleet-pause/preview").answer(200, { ok: true, ticket: "tk-1", html: `${bar({ title: "Pause the fleet" })}<p>In a pause window until ${at}</p>` });
  const time = slot.querySelector("time[datetime]");
  assert.ok(time, "the answer's time is in the slot");
  assert.equal(time.getAttribute("title"), "2026-10-08 15:39 UTC", "rewritten as the page's own times are");
});

stateTest(T.unchanged, async () => {
  const w = boot(fleetPage());
  const slot = slotOf(w);
  const skeleton = slot.innerHTML;
  w.submit(formOf(w, "fleet-pause"));
  const summary = ["the fleet is already paused"];
  await w.fetch.open("/api/act/fleet-pause/preview").answer(200, { ok: true, unchanged: true, action: "fleet-pause", summary, html: String(unchangedBarHtml({ summary })) });
  assert.ok(shown(slot.querySelector(".confirm--none")));
  assert.deepEqual([".confirm__h", ".confirm__note", "[data-close]"].map((q) => text(slot.querySelector(q))), ["No change", "The fleet is already paused.", "Close"]);
  assert.ok(slot.querySelector("[data-confirm]") === null, "nothing to confirm");
  slot.querySelector("[data-close]").click();
  assert.equal(slot.hidden, true);
  assert.equal(slot.innerHTML, skeleton, "the skeleton is back for the next preview");
  w.tick(10 * 60_000);
  assert.equal(w.fetch.calls.length, 1, "Close sends nothing");
});

stateTest(T.paid, async () => {
  const w = await previewed({ reserve: "The job holds up to $2.00 of the budget while it runs.", confirmLabel: "Retry for up to $2.00", paid: true });
  const slot = slotOf(w);
  const yes = slot.querySelector("[data-confirm]");
  assert.equal(yes.disabled, false, "the ticket arrived");
  assert.equal(text(yes), "Retry for up to $2.00");
  assert.ok(yes.classList.contains("btn--confirm-paid"), "in the paid fill");
  assert.ok(slot.querySelector(".confirm").classList.contains("confirm--paid"));
  assert.equal(text(slot.querySelector(".confirm__note")), "The job holds up to $2.00 of the budget while it runs.");
  assert.equal(text(slot.querySelector(".confirm__undo")), `Undo: ${UNDO}`);
  yes.click();
  assert.deepEqual(calls(w, "/api/act/retry-failed/confirm").map((c) => c.body), [{ ticket: "tk-1" }]);
  assert.equal(calls(w, "/api/act/retry-failed/confirm")[0].init.headers[PERSON_HEADER], "ops.operator", "and every confirm");
  assert.deepEqual([yes.disabled, slot.querySelector("[data-cancel]").disabled], [true, true], "nothing to press while it is out");
  yes.disabled = false;
  yes.click();
  assert.equal(calls(w, "/api/act/retry-failed/confirm").length, 1, "the ticket left with the first press: a second sends nothing");
  await w.fetch.open("/api/act/retry-failed/confirm").answer(200, { ok: true, action: "retry-failed", change: { summary: "Retried gh-1" } });
  assert.equal(w.location.reloads, 1, "the page reloads; its banner names the change");
});

stateTest(T.bulk, async () => {
  const w = boot(fleetPage());
  const slot = slotOf(w);
  w.document.querySelector("details.editor").setAttribute("open", "");
  w.type(w.document.querySelector('input[name="repo"]'), "acme/web");
  w.submit(formOf(w, "retry-all-failed"));
  assert.deepEqual(calls(w, "/api/act/retry-all-failed/preview")[0].body, { repo: "acme/web" });
  const lines = ["gh-1: up to $2.00", "gh-2: up to $1.50", "3 more match but are not in this action"];
  await w.fetch.open("/api/act/retry-all-failed/preview").answer(200, { ok: true, ticket: "tk-b", html: bar({ title: "Retry 2 failed jobs", lines, reserve: "Together they hold up to $3.50.", confirmLabel: "Retry 2 for up to $3.50", paid: true }) });
  assert.deepEqual(slot.querySelectorAll(".confirm__list li").map(text), lines, "each job with its own reserve, and how many more match");
  assert.equal(text(slot.querySelector(".confirm__note")), "Together they hold up to $3.50.");
  slot.querySelector("[data-confirm]").click();
  const results = [{ jobId: "gh-1", ok: true }, { jobId: "gh-2", ok: false, reason: "it is no longer failed" }];
  await w.fetch.open("/api/act/retry-all-failed/confirm").answer(200, { ok: true, action: "retry-all-failed", count: 2, done: 1, results, html: String(bulkResultsHtml({ kind: "failed-retry-all", results, count: 2, done: 1, auditSeq: 41 })) });
  assert.equal(w.location.reloads, 0, "a job was refused: the results first");
  assert.equal(text(slot.querySelector(".banner__t")), "1 of 2 retried");
  assert.deepEqual(slot.querySelectorAll(".confirm__results li").map(text), ["gh-1: done", "gh-2: not done, it is no longer failed"]);
  const audit = slot.querySelector("a.link");
  assert.deepEqual([text(audit), audit.getAttribute("href")], ["2 audit rows, from row 41", "/audit?seq=41#seq-41"]);
  const reload = slot.querySelector("[data-reload]");
  assert.ok(reload.classList.contains("btn--primary"), "Reload is the one step forward");
  reload.click();
  assert.equal(w.location.reloads, 1);
});

stateTest(T.expiry, async () => {
  const w = await previewed();
  const slot = slotOf(w);
  const left = () => text(slot.querySelector("[data-expires]"));
  assert.equal(left(), "5:00");
  w.tick(1000);
  assert.equal(left(), "4:59");
  w.tick(59_000);
  assert.equal(left(), "4:00");
  assert.equal(slot.querySelector("[data-confirm]").disabled, false);
  w.tick(240_000);
  assert.equal(left(), "0:00");
  const yes = slot.querySelector("[data-confirm]");
  assert.equal(yes.disabled, true, "at 0:00 Confirm is disabled");
  yes.disabled = false;
  yes.click();
  assert.equal(calls(w, "/api/act/retry-failed/confirm").length, 0, "and an expired ticket is never sent");
  // The span is the bar's own: a bar drawn with 90 s left counts from 1:30, whatever this browser's clock says.
  const late = await previewed({ expiresAt: NOW + 90_000 });
  assert.equal(text(slotOf(late).querySelector("[data-expires]")), "1:30");
  late.tick(90_000);
  assert.equal(slotOf(late).querySelector("[data-confirm]").disabled, true);
});

stateTest(T.refusedPreview, async () => {
  // A refusal the server drew: its sentence, "Nothing was changed.", and Close.
  const w = boot(fleetPage());
  const slot = slotOf(w);
  w.submit(formOf(w, "fleet-pause"));
  const sentence = "fleet-pause takes no fields; colour is not one of them, so nothing was changed";
  await w.fetch.open("/api/act/fleet-pause/preview").answer(400, { error: sentence, html: String(refusalHtml({ where: "preview", sentence, status: 400 })) });
  assert.equal(text(slot.querySelector(".banner__t")), "The change was refused");
  assert.match(text(slot.querySelector(".banner__s")), /^fleet-pause takes no fields; colour is not one of them, so nothing was changed\.$/);
  assert.ok(slot.querySelector("[data-confirm]") === null);
  slot.querySelector("[data-close]").click();
  assert.equal(slot.hidden, true);
  // An answer with no html (a proxy's error page): the skeleton's message line, as text, and nothing else to press.
  w.submit(formOf(w, "fleet-pause"));
  await w.fetch.open("/api/act/fleet-pause/preview").answer(502, "<html>Bad gateway</html>");
  const line = slot.querySelector("[data-slot-message]");
  assert.deepEqual([shown(line), text(line)], [true, "The console refused the request (502)."]);
  assert.equal(text(slot.querySelector("[data-slot-title]")), "Pause the fleet", "titled for what was asked, no longer previewing");
  assert.deepEqual([shown(slot.querySelector(".confirm__ghost")), slot.querySelector(".confirm").hasAttribute("aria-busy"), slot.querySelector(".confirm").classList.contains("confirm--busy")], [false, false, false]);
  assert.equal(slot.querySelector("[data-confirm]").disabled, true);
  slot.querySelector("[data-cancel]").click();
  assert.equal(slot.hidden, true);
  // An answer of JSON with no html: its error, as text.
  w.submit(formOf(w, "fleet-pause"));
  await w.fetch.open("/api/act/fleet-pause/preview").answer(503, { error: "the deployment's Valkey could not be reached" });
  assert.equal(text(slot.querySelector("[data-slot-message]")), "the deployment's Valkey could not be reached");
  // No answer at all.
  w.submit(formOf(w, "fleet-pause"));
  await w.fetch.open("/api/act/fleet-pause/preview").fail();
  assert.equal(text(slot.querySelector("[data-slot-message]")), "The console could not be reached, so nothing was previewed or changed.");
  // A field the form cannot read: said, and nothing sent.
  const before = w.fetch.calls.length;
  const json = w.document.querySelector('textarea[name="windows"]');
  w.type(json, "[{ not json");
  w.submit(formOf(w, "pause-windows"));
  assert.equal(w.fetch.calls.length, before, "nothing was sent");
  assert.equal(text(slot.querySelector("[data-slot-message]")), "windows is not valid JSON; nothing was sent.");
  assert.ok(w.document.getElementById("p-fleet-windows").nextElementSibling === slot);
});

stateTest(T.refusedConfirm, async () => {
  // Expired, used, another sign-in or action: the ticket store's sentence, and Preview again asks for a new ticket.
  const ticket = await previewed();
  const slot = slotOf(ticket);
  slot.querySelector("[data-confirm]").click();
  const expired = "this confirmation has expired. Preview the change again and confirm the new preview";
  await ticket.fetch.open("/api/act/retry-failed/confirm").answer(409, { error: expired, html: String(refusalHtml({ where: "confirm", sentence: expired, status: 409 })) });
  assert.equal(text(slot.querySelector(".banner__t")), "This confirmation cannot be used");
  slot.querySelector("[data-again]").click();
  assert.deepEqual(calls(ticket, "/api/act/retry-failed/preview").map((c) => c.body), [{ jobId: "gh-1", queue: "jobs" }, { jobId: "gh-1", queue: "jobs" }], "the same form, previewed again");
  assert.equal(text(slot.querySelector("[data-slot-title]")), "Previewing: Retry");
  // Changed since the preview: Look again reloads, since the page is what moved.
  const changed = await previewed();
  slotOf(changed).querySelector("[data-confirm]").click();
  const moved = "the job changed since the preview, so nothing was changed";
  await changed.fetch.open("/api/act/retry-failed/confirm").answer(409, { error: moved, html: String(refusalHtml({ where: "confirm", sentence: moved, status: 409 })) });
  slotOf(changed).querySelector("[data-reload]").click();
  assert.equal(changed.location.reloads, 1);
  // Valkey: Try again previews again.
  const valkey = await previewed();
  slotOf(valkey).querySelector("[data-confirm]").click();
  const down = "the deployment's Valkey could not be reached";
  await valkey.fetch.open("/api/act/retry-failed/confirm").answer(503, { error: down, html: String(refusalHtml({ where: "confirm", sentence: down, status: 503 })) });
  assert.equal(text(slotOf(valkey).querySelector("[data-again]")), "Try again");
  slotOf(valkey).querySelector("[data-again]").click();
  assert.equal(calls(valkey, "/api/act/retry-failed/preview").length, 2);
  // The audit log: nothing on the page fixes it, so nothing retries; Close puts the bar away (a bar with no step left its
  // panel held until a reload).
  const audit = await previewed();
  slotOf(audit).querySelector("[data-confirm]").click();
  const log = "the audit log could not be written, so nothing was changed";
  await audit.fetch.open("/api/act/retry-failed/confirm").answer(500, { error: log, html: String(refusalHtml({ where: "confirm", sentence: log, status: 500 })) });
  assert.equal(text(slotOf(audit).querySelector(".banner__t")), "The audit log could not be written");
  assert.ok(slotOf(audit).querySelector("[data-again], [data-reload], [data-confirm]") === null, "nothing that retries");
  slotOf(audit).querySelector("[data-close]").click();
  assert.equal(slotOf(audit).hidden, true, "Close puts the slot away");
  // No answer: said, and the spent ticket is never sent again.
  const silent = await previewed();
  slotOf(silent).querySelector("[data-confirm]").click();
  await silent.fetch.open("/api/act/retry-failed/confirm").fail();
  assert.equal(text(slotOf(silent).querySelector("[data-slot-message]")), CONFIRM_NO_ANSWER);
  assert.equal(slotOf(silent).querySelector("[data-confirm]").disabled, true);
  silent.tick(10 * 60_000);
  assert.equal(calls(silent, "/api/act/retry-failed/confirm").length, 1, "never retried: the change may have been made");
  assert.equal(silent.location.reloads, 0);
  // This browser signed in as someone else meanwhile: the server's 409 bar, which names why (ended "switched"), and its
  // Look again goes to sign-in saying so, never a reload into the other person's console; nothing retried.
  const person = { error: PERSON_CHANGED, ended: "switched", html: String(refusalHtml({ sentence: PERSON_CHANGED, status: 409, state: "changed" })) };
  const swapped = await previewed();
  slotOf(swapped).querySelector("[data-confirm]").click();
  await swapped.fetch.open("/api/act/retry-failed/confirm").answer(409, person);
  assert.equal(text(slotOf(swapped).querySelector(".banner__s")), "This browser is now signed in as someone else, so nothing was changed; sign in again.");
  slotOf(swapped).querySelector("[data-reload]").click();
  assert.deepEqual([swapped.location.reloads, swapped.location.assigned, calls(swapped, "/api/act/retry-failed/confirm").length], [0, ["/login?ended=switched"], 1]);
  // The same at preview; and the next preview's own bar is its own again: a Look again there reloads.
  const early = boot(fleetPage());
  early.submit(formOf(early, "fleet-pause"));
  await early.fetch.open("/api/act/fleet-pause/preview").answer(409, person);
  slotOf(early).querySelector("[data-reload]").click();
  assert.deepEqual(early.location.assigned, ["/login?ended=switched"]);
  early.submit(formOf(early, "fleet-pause"));
  await early.fetch.open("/api/act/fleet-pause/preview").answer(409, { error: "the fleet changed", html: String(refusalHtml({ where: "confirm", sentence: "the fleet changed", status: 409 })) });
  slotOf(early).querySelector("[data-reload]").click();
  assert.deepEqual([early.location.reloads, early.location.assigned], [1, ["/login?ended=switched"]]);
  // A refusal with no html (a proxy's page): its status, as text.
  const proxied = await previewed();
  slotOf(proxied).querySelector("[data-confirm]").click();
  await proxied.fetch.open("/api/act/retry-failed/confirm").answer(504, "<html>Gateway Timeout</html>");
  assert.equal(text(slotOf(proxied).querySelector("[data-slot-message]")), "The console refused the request (504).");
});

stateTest(T.done, async () => {
  const change = { summary: "Paused the fleet", by: "ops", auditSeq: 44, count: 1, undo: "Resume it with the button here.", inverse: { action: "fleet-resume", body: {} }, kind: "fleet", at: NOW };
  const w = boot(fleetPage({ flash: change }));
  const banner = w.document.querySelector("main > .banner");
  assert.equal(text(banner.querySelector(".banner__t")), "Paused the fleet");
  assert.match(text(banner.querySelector(".banner__s")), /^Changed by ops\. Audit row 44\. Undo: Resume it with the button here\.$/);
  assert.equal(banner.querySelector("a.link").getAttribute("href"), "/audit?seq=44#seq-44");
  const undo = banner.querySelector('form[data-action="fleet-resume"]');
  undo.querySelector("button[type=submit]").click();
  assert.deepEqual(calls(w, "/api/act/fleet-resume/preview").map((c) => c.body), [{}], "Undo previews the inverse, never writes it");
  const slot = slotOf(w);
  assert.ok(banner.nextElementSibling === slot, "the slot opens after the banner that asked");
  assert.equal(text(slot.querySelector("[data-slot-title]")), "Previewing: Undo");
  // The slot is no panel's: a panel update still lands.
  w.streams[0].emit("panel", { id: "p-fleet-state", html: "<h2>Fleet</h2><p>paused</p>" });
  assert.equal(w.document.getElementById("p-fleet-state").innerHTML, "<h2>Fleet</h2><p>paused</p>");
  // An inverse's body comes back exactly as it was given: text, a whole number, an object.
  const typed = boot(fleetPage({ flash: { ...change, inverse: { action: "limit-edit", body: { index: 2, limit: { per: "day", usd: 5 }, note: "x" } } } }));
  typed.document.querySelector('main > .banner form[data-action="limit-edit"] button').click();
  assert.deepEqual(calls(typed, "/api/act/limit-edit/preview")[0].body, { index: 2, limit: { per: "day", usd: 5 }, note: "x" });
});

// ---- held panels (LiveStates "A panel in use is not swapped", "Newer data is waiting") ------------------------------

stateTest(T.held, async () => {
  // The slot open for a panel holds it.
  const w = boot(fleetPage());
  const es = w.streams[0];
  const panel = w.document.getElementById("p-fleet-state");
  w.submit(formOf(w, "fleet-pause"));
  es.emit("panel", { id: "p-fleet-state", html: "<h2>Fleet</h2><p>one</p>" });
  assert.ok(formOf(w, "fleet-pause"), "not swapped while its preview is open");
  assert.equal(panel.firstElementChild.className, "held", "the kept-still note, first in the panel");
  assert.deepEqual([text(panel.querySelector(".held .chip")), text(panel.querySelector(".held__s"))], [HELD_NOTE_CHIP, HELD_NOTE_TEXT]);
  es.emit("panel", { id: "p-fleet-state", html: "<h2>Fleet</h2><p>two</p>" });
  assert.equal(panel.querySelectorAll(".held").length, 1, "the note once, however many updates wait");
  es.emit("panel", { id: "p-fleet-failed", html: "<h2>Failed jobs</h2><p>none</p>" });
  assert.equal(w.document.getElementById("p-fleet-failed").innerHTML, "<h2>Failed jobs</h2><p>none</p>", "a panel not in use takes its update");
  slotOf(w).querySelector("[data-cancel]").click();
  assert.equal(panel.innerHTML, "<h2>Fleet</h2><p>two</p>", "Cancel lands the newest update, and the note goes with the old content");
  // A field focused holds its panel; focus leaving it lands the update a tick later.
  const f = boot(fleetPage());
  const repo = f.document.querySelector('input[name="repo"]');
  repo.focus();
  f.streams[0].emit("panel", { id: "p-fleet-failed", html: "<p>fresh</p>" });
  assert.ok(f.document.querySelector('input[name="repo"]'), "held while focused");
  repo.blur();
  assert.ok(f.document.querySelector('input[name="repo"]'), "not during focusout: focus has not landed yet");
  f.tick(0);
  assert.equal(f.document.getElementById("p-fleet-failed").innerHTML, "<p>fresh</p>");
  // A field typed into stays held after focus leaves: the half-made change is the reader's.
  const e = boot(fleetPage());
  const typed = e.document.querySelector('input[name="repo"]');
  e.type(typed, "acme/web");
  e.streams[0].emit("panel", { id: "p-fleet-failed", html: "<p>fresh</p>" });
  typed.blur();
  e.tick(0);
  assert.equal(e.document.querySelector('input[name="repo"]').value, "acme/web");
  // An open editor holds its panel.
  const d = boot(fleetPage());
  d.document.querySelector("details.editor").setAttribute("open", "");
  d.streams[0].emit("panel", { id: "p-fleet-failed", html: "<p>fresh</p>" });
  assert.ok(d.document.querySelector("details.editor"));
  assert.equal(d.document.getElementById("p-fleet-failed").firstElementChild.className, "held");
});

// ---- the live stream (LiveStates) ---------------------------------------------------------------------------------

stateTest(T.pill, async () => {
  const w = boot(fleetPage());
  const es = w.streams[0];
  assert.equal(es.url, `/api/events?page=fleet&${PERSON_PARAM}=ops.operator`, "the page's stream, saying the page's person");
  assert.deepEqual(pill(w), { cls: LIVE_STATES.start.cls, word: LIVE_STATES.start.word }, "as the server drew it");
  assert.deepEqual(notes(w), [], "every note drawn hidden");
  assert.deepEqual(w.document.querySelectorAll("#live-note [data-live-note]").map((n) => n.getAttribute("data-live-note")), Object.keys(LIVE_NOTES));
  es.emit("open");
  assert.deepEqual(pill(w), { cls: LIVE_STATES.on.cls, word: "Live" });
  es.readyState = 0;
  es.emit("error");
  assert.deepEqual(pill(w), { cls: LIVE_STATES.retry.cls, word: "Reconnecting" }, "a dropped stream the browser reopens");
  assert.deepEqual(notes(w), [], "the pill alone: the browser is already retrying");
  es.emit("open");
  // Refused with the session holding (a 200 from whoami): the stream limit.
  es.readyState = 2;
  es.emit("error");
  assert.equal(pill(w).word, "Reconnecting", "not Live while the console is asked");
  await w.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator", readOnly: false });
  assert.deepEqual(pill(w), { cls: LIVE_STATES.off.cls, word: "Not live" });
  assert.deepEqual(notes(w), ["limit"]);
  const limit = w.document.querySelector('[data-live-note="limit"]');
  assert.match(text(limit), /One token may hold 4 live tabs/);
  assert.equal(limit.querySelector("a.btn").getAttribute("href"), "/fleet", "Reload is the page's own address");
  // Signed out.
  const out = boot(fleetPage());
  out.streams[0].emit("open");
  out.streams[0].emit("end", { ended: "idle" });
  assert.deepEqual(pill(out), { cls: LIVE_STATES.out.cls, word: "Signed out" });
  assert.deepEqual(notes(out), ["out"]);
  // The transcript's line the same way: a stream the browser reconnects by itself (CONNECTING, 0) is "reconnecting",
  // never "live", and nothing is asked; it is live again when it opens.
  const run = boot(runPage(), { url: "/run?id=gh-1" });
  const transcript = run.streams[0];
  transcript.emit("entry", { html: "<article data-kind=\"assistant\"><pre>hello</pre></article>" });
  assert.equal(tstatus(run), "live");
  transcript.readyState = 0;
  transcript.emit("error");
  assert.deepEqual([tstatus(run), calls(run, "/api/whoami").length], ["reconnecting", 0], "the browser is already retrying");
  transcript.emit("open");
  assert.equal(tstatus(run), "live");
});

stateTest(T.unreachable, async () => {
  const w = boot(fleetPage());
  const es = w.streams[0];
  es.emit("open");
  const before = w.document.getElementById("p-fleet-state").innerHTML;
  es.readyState = 2;
  es.emit("error");
  await w.fetch.open("/api/whoami").fail();
  assert.deepEqual([pill(w).word, notes(w)], ["Reconnecting", ["retry"]], "Console not reachable, retrying");
  assert.equal(text(w.document.querySelector('[data-live-note="retry"] .banner__t')), LIVE_NOTES.retry.title);
  assert.equal(w.document.getElementById("p-fleet-state").innerHTML, before, "the page stays as it was");
  w.tick(RETRY_MS - 1);
  assert.equal(calls(w, "/api/whoami").length, 1);
  w.tick(1);
  assert.equal(calls(w, "/api/whoami").length, 2, "asked again 2 s later");
  await w.fetch.open("/api/whoami").answer(503, { error: "the console's tokens file cannot be used right now" });
  assert.deepEqual(notes(w), ["retry"], "a 503 is the console unable to say: the same");
  w.tick(RETRY_MS);
  await w.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
  assert.equal(w.location.reloads, 1, "the console is back: the page reloads to reopen its stream");
  assert.deepEqual(w.location.assigned, []);
  // A browser with no fetch at all: it cannot ask, so it says what it knows and stops. A stream it closed is
  // Not live (no note: the stream limit is a guess it cannot check); a session's end it cannot confirm keeps the page
  // under the retry note. Either way nothing loops.
  const mute = boot(fleetPage(), { fetch: null });
  mute.streams[0].emit("open");
  mute.streams[0].readyState = 2;
  mute.streams[0].emit("error");
  assert.deepEqual([pill(mute).word, notes(mute)], ["Not live", []]);
  // Nothing waits or queues where nothing can be asked: a stream's end, which waits before it asks where fetch exists,
  // says what is known as it comes, with no timer left behind it.
  const muteEnd = boot(fleetPage(), { fetch: null });
  muteEnd.streams[0].emit("end", { ended: "elsewhere" });
  assert.deepEqual([pill(muteEnd).word, notes(muteEnd), muteEnd.location.reloads, muteEnd.location.assigned, muteEnd.timers.pending()], ["Reconnecting", ["retry"], 0, [], 0]);
  muteEnd.tick(10 * RETRY_MS);
  assert.deepEqual([pill(muteEnd).word, notes(muteEnd), muteEnd.location.reloads, muteEnd.location.assigned, muteEnd.timers.pending()], ["Reconnecting", ["retry"], 0, [], 0], "and nothing later");
  // The console stopping, on a run page: the page under the retry note and the transcript's line reconnecting, at once.
  const muteStop = boot(runPage(), { url: "/run?id=gh-1", fetch: null });
  muteStop.streams[0].emit("open");
  muteStop.streams[0].emit("open");
  muteStop.streams[0].emit("end", { ended: STREAM_SHUTDOWN });
  assert.ok(muteStop.streams[0].closed && muteStop.streams[0].closed, "both streams closed by the script");
  assert.deepEqual([pill(muteStop).word, notes(muteStop), tstatus(muteStop), muteStop.timers.pending()], ["Reconnecting", ["retry"], "reconnecting", 0]);
  // On a run page with no fetch, a transcript the browser closed says so on its own line and leaves the page's pill as
  // it was: what it knows is said by the stream that asked. The page's stream closed after it says its own, not dropped.
  const muteRun = boot(runPage(), { url: "/run?id=gh-1", fetch: null });
  muteRun.streams[0].emit("open");
  muteRun.streams[0].emit("open");
  muteRun.streams[0].readyState = 2;
  muteRun.streams[0].emit("error");
  assert.deepEqual([pill(muteRun).word, notes(muteRun), tstatus(muteRun)], ["Not live", [], "reconnecting"]);
  muteRun.streams[0].readyState = 2;
  muteRun.streams[0].emit("error");
  assert.deepEqual([pill(muteRun).word, notes(muteRun), tstatus(muteRun), muteRun.timers.pending()], ["Not live", [], "reconnecting", 0]);
});

stateTest(T.shutdown, async () => {
  const w = boot(fleetPage());
  const es = w.streams[0];
  es.emit("open");
  es.emit("end", { ended: STREAM_SHUTDOWN });
  assert.equal(es.closed, true);
  assert.deepEqual([pill(w).word, notes(w)], ["Reconnecting", ["retry"]]);
  assert.equal(calls(w, "/api/whoami").length, 0, "nothing asked while the console is going");
  w.tick(RETRY_MS);
  await w.fetch.open("/api/whoami").fail();
  w.tick(RETRY_MS);
  await w.fetch.open("/api/whoami").answer(401, { error: "sign in first" });
  assert.deepEqual(w.location.assigned, ["/login?ended=restart"], "a sign-in it no longer knows: it may have restarted");
  assert.deepEqual([pill(w).word, notes(w)], ["Signed out", ["out"]]);
  // The new process's own reason wins; a 200 is a console that never went.
  const told = boot(fleetPage());
  told.streams[0].emit("end", { ended: STREAM_SHUTDOWN });
  told.tick(RETRY_MS);
  await told.fetch.open("/api/whoami").answer(401, { error: "sign in first", ended: "revoked" });
  assert.deepEqual(told.location.assigned, ["/login?ended=revoked"]);
  const stayed = boot(fleetPage());
  stayed.streams[0].emit("end", { ended: STREAM_SHUTDOWN });
  stayed.tick(RETRY_MS);
  await stayed.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
  assert.equal(stayed.location.reloads, 1);
  // A 200 naming someone else (this browser signed in as another meanwhile) is never reloaded into (issue #737): sign-in,
  // saying the browser is someone else's now.
  const swapped = boot(fleetPage());
  swapped.streams[0].emit("end", { ended: STREAM_SHUTDOWN });
  swapped.tick(RETRY_MS);
  await swapped.fetch.open("/api/whoami").answer(200, { name: "mallory", role: "operator" });
  assert.deepEqual([swapped.location.reloads, swapped.location.assigned, pill(swapped).word], [0, ["/login?ended=switched"], "Signed out"]);
});

stateTest(T.ended, async () => {
  for (const r of STREAM_ENDS.filter((x) => x !== STREAM_SHUTDOWN && x !== "elsewhere")) {
    const w = boot(fleetPage());
    w.streams[0].emit("end", { ended: r });
    assert.deepEqual([w.location.assigned, pill(w).word, notes(w), w.streams[0].closed], [[`/login?ended=${r}`], "Signed out", ["out"], true], r);
    assert.equal(w.fetch.calls.length, 0, `${r}: nothing to ask`);
  }
  // No reason, or one a stream never sends: plain sign-in, never the bytes it was given.
  for (const data of ["", "{}", "not json", JSON.stringify({ ended: "restart" }), JSON.stringify({ ended: "IDLE" }), JSON.stringify({ ended: "idle&x=1" })]) {
    const w = boot(fleetPage());
    w.streams[0].emit("end", data);
    assert.deepEqual(w.location.assigned, ["/login"], data);
  }
  // Elsewhere: this browser may already hold a newer sign-in, so it asks first, after a wait (issue #737): the sign-in
  // in another tab ends this stream as its answer goes out, and the browser may still be storing its cookie.
  const again = boot(fleetPage());
  again.streams[0].emit("end", { ended: "elsewhere" });
  assert.equal(pill(again).word, "Reconnecting");
  again.tick(RETRY_MS - 1);
  assert.equal(calls(again, "/api/whoami").length, 0, "not at once");
  again.tick(1);
  await again.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
  assert.deepEqual([again.location.reloads, again.location.assigned], [1, []], "the same person: reloaded");
  // Anyone else, or an answer that does not say who: sign-in with "switched", never a reload into another person's
  // console, and never the "signed out in another tab" the browser was not (it is signed in, as someone else).
  for (const body of [{ name: "mallory", role: "operator" }, { name: "ops", role: "viewer" }, { name: "ops" }, {}, "not json"]) {
    const w = boot(fleetPage());
    w.streams[0].emit("end", { ended: "elsewhere" });
    w.tick(RETRY_MS);
    await w.fetch.open("/api/whoami").answer(200, body);
    assert.deepEqual([w.location.reloads, w.location.assigned, pill(w).word, notes(w)], [0, ["/login?ended=switched"], "Signed out", ["out"]], JSON.stringify(body));
  }
  // A page whose bar does not say who it is never reloads either, and says no person on its requests.
  const anonymous = boot(fleetPage().replace(/ data-name="ops" data-role="operator"/, ""));
  assert.equal(anonymous.streams[0].url, "/api/events?page=fleet", "no person to say");
  anonymous.submit(formOf(anonymous, "fleet-pause"));
  assert.equal(Object.hasOwn(calls(anonymous, "/api/act/fleet-pause/preview")[0].init.headers, PERSON_HEADER), false);
  anonymous.streams[0].emit("end", { ended: "elsewhere" });
  anonymous.tick(RETRY_MS);
  await anonymous.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
  assert.deepEqual([anonymous.location.reloads, anonymous.location.assigned], [0, ["/login?ended=switched"]]);
  for (const [body, to] of [[{ error: "sign in first", ended: "elsewhere" }, "/login?ended=elsewhere"], [{ error: "sign in first" }, "/login?ended=elsewhere"], [{ error: "sign in first", ended: "all" }, "/login?ended=all"], [{ ended: "<b>" }, "/login?ended=elsewhere"]]) {
    const w = boot(fleetPage());
    w.streams[0].emit("end", { ended: "elsewhere" });
    w.tick(RETRY_MS);
    await w.fetch.open("/api/whoami").answer(401, body);
    assert.deepEqual(w.location.assigned, [to], JSON.stringify(body));
  }
  // The tab signing out ignores the end its own sign-out sends, and goes to sign-in on the console's 200 alone.
  const leaving = boot(fleetPage());
  leaving.document.getElementById("logout").click();
  assert.deepEqual(calls(leaving, "/logout").map((c) => c.method), ["POST"]);
  assert.equal(Object.hasOwn(calls(leaving, "/logout")[0].init.headers, PERSON_HEADER), false, "a sign-out acts for the browser, not a person: it says none");
  leaving.streams[0].emit("end", { ended: "elsewhere" });
  leaving.tick(RETRY_MS * 3);
  assert.equal(calls(leaving, "/api/whoami").length, 0);
  assert.notEqual(pill(leaving).word, "Signed out");
  await leaving.fetch.open("/logout").answer(200, { ok: true });
  assert.deepEqual(leaving.location.assigned, ["/login"]);
  // A sign-out the console did not confirm (any other answer, or none) keeps the page, and says so once, as an alert
  // after the title bar (issue #737): going to sign-in would show a browser signed out that may not be.
  for (const answer of [(c) => c.answer(500, { error: "the console failed on this request; see its log" }), (c) => c.answer(403, { error: "cross-site" }), (c) => c.answer(503, "<html>proxy</html>"), (c) => c.fail()]) {
    const w = boot(fleetPage());
    const logout = w.document.getElementById("logout");
    logout.click();
    await answer(w.fetch.open("/logout"));
    assert.deepEqual(w.location.assigned, [], "the page stays");
    const said = w.document.querySelectorAll('[data-signout="unconfirmed"]');
    assert.equal(said.length, 1);
    assert.deepEqual([said[0].getAttribute("role"), text(said[0].querySelector(".banner__t")), text(said[0].querySelector(".banner__s"))], ["alert", SIGN_OUT_UNCONFIRMED.title, SIGN_OUT_UNCONFIRMED.body]);
    assert.ok(said[0].previousElementSibling.classList.contains("titlebar") && said[0].parentElement.id === "main", "right after the title bar");
    // The tile every server banner has, first, holding the sign-out button's own icon.
    const tile = said[0].firstElementChild;
    assert.deepEqual([tile.tagName.toLowerCase(), tile.className], ["span", "tile"]);
    assert.equal(tile.querySelector("svg use").getAttribute("href"), logout.querySelector("svg use").getAttribute("href"));
    // It is no longer signing out: a real end from now on is read as one.
    w.streams[0].emit("end", { ended: "revoked" });
    assert.deepEqual(w.location.assigned, ["/login?ended=revoked"]);
    // Pressed again and refused again: one note still, never a second.
    logout.click();
    await answer(w.fetch.open("/logout"));
    w.tick(SIGN_OUT_TIMEOUT_MS);
    assert.equal(w.document.querySelectorAll('[data-signout="unconfirmed"]').length, 1, "pressed twice, refused twice: one note");
    // Pressed again: one note still, and a 200 goes to sign-in.
    logout.click();
    await w.fetch.open("/logout").answer(200, { ok: true });
    assert.equal(w.document.querySelectorAll('[data-signout="unconfirmed"]').length, 1);
    assert.deepEqual(w.location.assigned, ["/login?ended=revoked", "/login"]);
  }
  // A console that takes the sign-out and never answers: after SIGN_OUT_TIMEOUT_MS the page says it was not
  // confirmed, once, however often Sign out is pressed; an answer that comes later still counts.
  assert.equal(SIGN_OUT_TIMEOUT_MS, 10_000);
  const wedged = boot(fleetPage());
  const button = wedged.document.getElementById("logout");
  button.click();
  wedged.tick(SIGN_OUT_TIMEOUT_MS - 1);
  assert.equal(wedged.document.querySelectorAll('[data-signout="unconfirmed"]').length, 0, "not before the timeout");
  wedged.tick(1);
  assert.equal(wedged.document.querySelectorAll('[data-signout="unconfirmed"]').length, 1, "said at the timeout");
  wedged.streams[0].emit("end", { ended: "elsewhere" });
  wedged.tick(RETRY_MS);
  assert.equal(calls(wedged, "/api/whoami").length, 1, "no longer signing out: another tab's end is asked about");
  button.click();
  wedged.tick(SIGN_OUT_TIMEOUT_MS);
  await calls(wedged, "/logout")[0].answer(500, { error: "late" });
  assert.equal(wedged.document.querySelectorAll('[data-signout="unconfirmed"]').length, 1, "a second timeout and a late refusal draw no second note");
  await calls(wedged, "/logout")[1].answer(200, { ok: true });
  assert.deepEqual(wedged.location.assigned, ["/login"], "a 200 after the timeout is the sign-out, and goes to sign-in");
  // One handler for the page's stream and the transcript's: either end closes both, once.
  const run = boot(runPage(), { url: "/run?id=gh-1" });
  const [page] = run.streams;
  const transcript = page;
  assert.equal(run.streams.length, 1, "one page stream carries the transcript");
  assert.equal(page.url, "/api/events?page=run&id=gh-1&as=ops.operator", "the stream says the page's person");
  transcript.emit("end", { ended: "max" });
  page.emit("end", { ended: "max" });
  assert.deepEqual([page.closed, transcript.closed, run.location.assigned], [true, true, ["/login?ended=max"]]);
  assert.equal(text(run.document.querySelector("[data-transcript-status]")), "signed out");
  assert.ok(ENDED_REASONS.includes("max"));
  // The end on the transcript stream alone: it is the page's end too, closing both.
  const alone = boot(runPage(), { url: "/run?id=gh-1" });
  alone.streams[0].emit("end", { ended: "revoked" });
  assert.deepEqual([alone.streams[0].closed, alone.streams[0].closed, alone.location.assigned, pill(alone).word], [true, true, ["/login?ended=revoked"], "Signed out"]);
  // A transcript stream the browser closed (a 401, a 429 or a 503: it cannot tell) is asked about as the page's own is,
  // saying "reconnecting" on its line meanwhile and leaving the page's pill alone: a session that ended goes to sign-in
  // with its reason, another person to sign-in as switched, and only a 200 for the page's person is the stream limit.
  for (const [answer, to] of [[[401, { error: "sign in first", ended: "idle" }], "/login?ended=idle"], [[200, { name: "mallory", role: "operator" }], "/login?ended=switched"]]) {
    const w = boot(runPage(), { url: "/run?id=gh-1" });
    w.streams[0].emit("open");
    w.streams[0].emit("open");
    w.streams[0].readyState = 2;
    w.streams[0].emit("error");
    assert.deepEqual([tstatus(w), pill(w).word], ["reconnecting", "Reconnecting"], "the shared stream updates both statuses");
    await w.fetch.open("/api/whoami").answer(...answer);
    assert.deepEqual(w.location.assigned, [to], JSON.stringify(answer));
  }
  const limited = boot(runPage(), { url: "/run?id=gh-1" });
  limited.streams[0].emit("open");
  limited.streams[0].readyState = 2;
  limited.streams[0].emit("error");
  await limited.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
  assert.deepEqual([tstatus(limited), pill(limited).word, notes(limited), limited.location.assigned], ["not live: reload after closing another console tab", "Not live", ["limit"], []], "the shared stream limit");
  // A preview or a confirm answered 401 is the session behind the page ending, not the write's refusal: the slot says
  // nothing was changed and the console is being asked (never the 401's own text), then sign-in with the reason (the
  // console's answer's, else the write's).
  for (const [where, answer, to] of [["preview", { error: "sign in first", ended: "idle" }, "/login?ended=idle"], ["confirm", { error: "sign in first", ended: "max" }, "/login?ended=max"], ["preview", { error: "sign in first", ended: null }, "/login"]]) {
    const w = where === "preview" ? boot(fleetPage()) : await previewed();
    const slot = slotOf(w);
    if (where === "preview") w.submit(formOf(w, "fleet-pause"));
    else slot.querySelector("[data-confirm]").click();
    await w.fetch.open(where === "preview" ? "/api/act/fleet-pause/preview" : "/api/act/retry-failed/confirm").answer(401, answer);
    const line = slot.querySelector("[data-slot-message]");
    assert.deepEqual([shown(line), text(line), slot.querySelector("[data-confirm]").disabled], [true, CONFIRM_SIGNED_OUT, true], `${where}: the slot says so, and nothing can be confirmed`);
    assert.ok(!text(slot).includes("sign in first"), where);
    await w.fetch.open("/api/whoami").answer(401, { error: "sign in first" });
    assert.deepEqual([w.location.assigned, pill(w).word, notes(w)], [[to], "Signed out", ["out"]], `${where} ${JSON.stringify(answer)}`);
  }
  const back = boot(fleetPage());
  back.submit(formOf(back, "fleet-pause"));
  await back.fetch.open("/api/act/fleet-pause/preview").answer(401, { error: "sign in first", ended: "elsewhere" });
  await back.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
  assert.deepEqual([back.location.reloads, back.location.assigned], [1, []], "signed in again as the page's person meanwhile: reloaded");
  const other = boot(fleetPage());
  other.submit(formOf(other, "fleet-pause"));
  await other.fetch.open("/api/act/fleet-pause/preview").answer(401, { error: "sign in first", ended: "elsewhere" });
  await other.fetch.open("/api/whoami").answer(200, { name: "mallory", role: "operator" });
  assert.deepEqual([other.location.reloads, other.location.assigned], [0, ["/login?ended=switched"]], "someone else: switched");
  // Two sign-out presses: the first press's timer and late answer belong to it, and never end the second's signing out.
  const twice = boot(fleetPage());
  const signOut = twice.document.getElementById("logout");
  signOut.click();
  twice.tick(SIGN_OUT_TIMEOUT_MS / 2);
  signOut.click();
  twice.tick(SIGN_OUT_TIMEOUT_MS / 2);
  assert.equal(twice.document.querySelectorAll('[data-signout="unconfirmed"]').length, 0, "the first press's timer was cleared by the second");
  await calls(twice, "/logout")[0].answer(500, { error: "late" });
  assert.equal(twice.document.querySelectorAll('[data-signout="unconfirmed"]').length, 0, "and its late refusal says nothing for the second");
  twice.streams[0].emit("end", { ended: "elsewhere" });
  twice.tick(RETRY_MS);
  assert.equal(calls(twice, "/api/whoami").length, 0, "still signing out: its own sign-out's end is ignored");
  twice.tick(SIGN_OUT_TIMEOUT_MS / 2);
  assert.equal(twice.document.querySelectorAll('[data-signout="unconfirmed"]').length, 1, "the second press's own timeout says it");
  await calls(twice, "/logout")[1].answer(200, { ok: true });
  assert.deepEqual(twice.location.assigned, ["/login"]);
});

stateTest(T.stale, async () => {
  const w = boot(fleetPage());
  const es = w.streams[0];
  const main = w.document.getElementById("main");
  es.emit("open");
  es.emit("stale", { since: NOW - 90_000 });
  assert.equal(main.classList.contains("stale"), true, "the panels dimmed (main.stale)");
  assert.deepEqual(notes(w), ["stale"]);
  const at = w.document.querySelector("#live-note time[data-since]");
  assert.deepEqual([at.getAttribute("datetime"), at.getAttribute("title"), text(at)], ["2026-10-24T11:58:30.000Z", "2026-10-24 11:58 UTC", "2026-10-24 11:58 UTC"], "the time last seen, in the reader's zone (UTC here) with UTC in its title");
  const body = w.document.querySelector('[data-live-note="stale"] .banner__s');
  assert.equal(text(body), LIVE_NOTES.stale.body, "the deployment's data, in the server's words");
  es.emit("fresh", {});
  assert.deepEqual([main.classList.contains("stale"), notes(w)], [false, []]);
  // No good render to keep: no time.
  es.emit("stale", { since: null });
  assert.deepEqual([at.hasAttribute("datetime"), text(at)], [false, ""]);
  es.emit("stale", "not json");
  assert.deepEqual([main.classList.contains("stale"), notes(w)], [true, ["stale"]]);
  es.emit("fresh", {});
  // A reconnect is a new stream (issue #737): its OPENING says nothing about the page's data, so
  // it takes nothing back; the hub's first message on it is its state, and only fresh undims.
  es.emit("stale", { since: NOW - 60_000, what: "data" });
  es.readyState = 0;
  es.emit("error");
  es.emit("open");
  assert.deepEqual([main.classList.contains("stale"), notes(w), pill(w).word], [true, ["stale"], "Live"], "open again, still dimmed under its note");
  // The lone tab's reconnect: the hub let the view go, so its stale has no time; the page keeps the one it was told.
  es.emit("stale", { since: null, what: "data" });
  assert.deepEqual([at.getAttribute("datetime"), main.classList.contains("stale")], ["2026-10-24T11:59:00.000Z", true], "the time the panels it holds were last seen");
  es.emit("fresh", {});
  assert.deepEqual([main.classList.contains("stale"), notes(w)], [false, []], "fresh, and nothing else, takes it back");
  es.emit("stale", { since: NOW - 1000, what: "data" });
  assert.deepEqual([main.classList.contains("stale"), notes(w)], [true, ["stale"]], "still failing: dimmed again");
  // The tokens file (what: tokens) is not the deployment's data: the note says which, its command in the code face (a
  // plain one broke as "pi-/dispatch" at 375 px), and the data's words come back.
  es.emit("stale", { since: NOW - 1000, what: "tokens" });
  assert.equal(text(body), STALE_TOKENS_BODY.replaceAll("`", ""));
  assert.deepEqual(body.querySelectorAll("span.code").map(text), ["pi-dispatch doctor"]);
  assert.equal(STALE_TOKENS_BODY, "The console could not read its tokens file, so it shows nothing newer; this is the page as it was last seen. An operator should run `pi-dispatch doctor`.");
  es.emit("stale", { since: NOW - 1000, what: "data" });
  assert.equal(text(body), LIVE_NOTES.stale.body);
  assert.equal(body.querySelectorAll("span.code").length, 0);
  for (const odd of [{ since: 1, what: "Tokens" }, { since: 1, what: ["tokens"] }, { since: 1 }]) {
    es.emit("stale", odd);
    assert.equal(text(body), LIVE_NOTES.stale.body, JSON.stringify(odd));
  }
  // A stale the server drew (a golden's) is not this script's to take back: neither an open nor a fresh takes it.
  const drawn = boot(fleetPage().replace('<main id="main"', '<main id="main" class="stale"'));
  drawn.streams[0].emit("open");
  drawn.streams[0].emit("fresh", {});
  assert.equal(drawn.document.getElementById("main").classList.contains("stale"), true);
});

stateTest(T.bothClosed, async () => {
  // The browser closes both of a run page's streams together (a 429 over the stream limit refuses each), in either
  // order, whether they had opened or were refused at their first connect. Each says "asking" on its own line, one
  // question goes out, and its answer is said by both: the stream limit on the pill (with its note) AND on the
  // transcript's line. A guard that dropped the second asker left it as it was: the pill Live over a closed page stream,
  // or the line "reconnecting" for good.
  const run = () => boot(runPage(), { url: "/run?id=gh-1" });
  const closeBoth = (w, order) => {
    const streams = { page: w.streams[0], transcript: w.streams[0] };
    assert.equal(w.streams.length, 1, "the transcript has no second connection");
    for (const name of order) {
      streams[name].readyState = 2;
      streams[name].emit("error");
    }
  };
  for (const order of [["transcript", "page"], ["page", "transcript"]]) {
    for (const opened of [true, false]) {
      const label = `${order.join(" then ")}${opened ? ", both open first" : ""}`;
      const w = run();
      if (opened) for (const s of w.streams) s.emit("open");
      closeBoth(w, order);
      assert.deepEqual([pill(w).word, tstatus(w), calls(w, "/api/whoami").length], ["Reconnecting", "reconnecting", 1], `${label}: both asking, one question`);
      await w.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
      assert.deepEqual([pill(w), notes(w), tstatus(w)], [{ cls: LIVE_STATES.off.cls, word: "Not live" }, ["limit"], "not live: reload after closing another console tab"], label);
      assert.deepEqual([w.location.reloads, w.location.assigned, calls(w, "/api/whoami").length], [0, [], 1], `${label}: nothing more`);
    }
  }
  // One after the other: an answer that settled the transcript's question frees the queue, so the page's stream the
  // browser closes later asks a question of its own and is said the stream limit, never left Reconnecting.
  const apart = run();
  for (const s of apart.streams) s.emit("open");
  apart.streams[0].readyState = 2;
  apart.streams[0].emit("error");
  await apart.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
  assert.deepEqual([tstatus(apart), pill(apart).word], ["not live: reload after closing another console tab", "Not live"], "the shared stream");
  apart.streams[0].readyState = 2;
  apart.streams[0].emit("error");
  assert.equal(calls(apart, "/api/whoami").length, 2, "the page's stream asks again");
  await apart.fetch.open("/api/whoami").answer(200, { name: "ops", role: "operator" });
  assert.deepEqual([pill(apart), notes(apart), apart.location.reloads], [{ cls: LIVE_STATES.off.cls, word: "Not live" }, ["limit"], 0], "and is said the stream limit");
  // Every other answer settles both at once, once: a sign-in that ended, another person, and the console back after a
  // failed question (a reload, one).
  for (const [answers, reloads, assigned] of [[[[401, { error: "sign in first", ended: "idle" }]], 0, ["/login?ended=idle"]], [[[200, { name: "mallory", role: "operator" }]], 0, ["/login?ended=switched"]], [[null, [200, { name: "ops", role: "operator" }]], 1, []]]) {
    const w = run();
    closeBoth(w, ["transcript", "page"]);
    for (const a of answers) {
      if (a === null) {
        await w.fetch.open("/api/whoami").fail();
        w.tick(RETRY_MS);
      } else await w.fetch.open("/api/whoami").answer(...a);
    }
    assert.deepEqual([w.location.reloads, w.location.assigned, calls(w, "/api/whoami").length], [reloads, assigned, answers.length], JSON.stringify(answers));
  }
  // A write's 401 while a stream's question is out joins it: the slot says at once that the session ended before the
  // change was sent (never left on its previewing skeleton), and the page goes where that one answer says, with the
  // write's reason when the answer names none.
  for (const [answer, reloads, assigned] of [[[401, { error: "sign in first" }], 0, ["/login?ended=idle"]], [[200, { name: "ops", role: "operator" }], 1, []]]) {
    const w = boot(fleetPage());
    w.streams[0].emit("open");
    w.streams[0].readyState = 2;
    w.streams[0].emit("error");
    w.submit(formOf(w, "fleet-pause"));
    await w.fetch.open("/api/act/fleet-pause/preview").answer(401, { error: "sign in first", ended: "idle" });
    const slot = slotOf(w);
    const line = slot.querySelector("[data-slot-message]");
    assert.deepEqual([shown(slot), shown(line), text(line), text(slot.querySelector("[data-slot-title]")), slot.querySelector("[data-confirm]").disabled], [true, true, CONFIRM_SIGNED_OUT, "Pause the fleet", true]);
    assert.equal(calls(w, "/api/whoami").length, 1, "the write joins the question already out");
    await w.fetch.open("/api/whoami").answer(...answer);
    assert.deepEqual([w.location.reloads, w.location.assigned], [reloads, assigned], `${JSON.stringify(answer)}: the write asked for a reload, so the stream limit is not the answer`);
  }
});

// ---- the sign-in pages (SignIn, AccessStates) ----------------------------------------------------------------------

stateTest(T.signIn, async () => {
  const w = boot(String(loginPage({ notice: "idle" })), { url: "/login?ended=idle" });
  assert.deepEqual(notices(w), ["ended-idle"], "the server's choice, alone");
  const input = w.document.getElementById("token");
  const form = w.document.getElementById("login-form");
  const signIn = (token) => {
    input.value = token;
    w.submit(form);
    assert.equal(input.value, "", "out of the field at once");
  };
  signIn("tok-1");
  assert.deepEqual(calls(w, "/login").map((c) => c.body), [{ token: "tok-1" }]);
  assert.deepEqual(notices(w), ["ended-idle"], "nothing changes until the answer");
  // Literal pairs, not NOTICE_OF_STATUS read back: a table that swapped two notices would pass a test built from it.
  for (const [status, kind] of [[401, "wrong"], [429, "rate"], [503, "tokens"], [500, "audit"]]) {
    if (calls(w, "/login").every((c) => c.done)) signIn("tok-1");
    await w.fetch.open("/login").answer(status, { error: "the console's own sentence" });
    assert.deepEqual(notices(w), [kind], `${status}: one notice`);
    assert.equal(text(w.document.querySelector(`[data-notice="${kind}"] .banner__t`)), SIGN_IN_NOTICES[kind].title);
  }
  assert.deepEqual(Object.keys(NOTICE_OF_STATUS["/login"]).sort(), ["401", "429", "500", "503"], "and the table holds no other");
  signIn("tok-1");
  await w.fetch.open("/login").answer(418, { error: "a teapot refused it" });
  assert.deepEqual(notices(w), ["other"]);
  assert.equal(text(w.document.querySelector('[data-notice="other"] [data-notice-text]')), "a teapot refused it", "the server's sentence, as text");
  // No answer: the page stays and posts the same token again every 2 s.
  signIn("tok-2");
  await w.fetch.open("/login").fail();
  assert.deepEqual(notices(w), ["unreachable"]);
  assert.equal(w.location.assigned.length, 0, "the page stays");
  w.tick(RETRY_MS);
  assert.deepEqual(calls(w, "/login").at(-1).body, { token: "tok-2" }, "the attempt's own token, from the closure");
  await w.fetch.open("/login").fail();
  // A new submit ends the old loop.
  signIn("tok-3");
  w.tick(RETRY_MS * 3);
  assert.deepEqual(calls(w, "/login").slice(-1).map((c) => c.body), [{ token: "tok-3" }], "only the new attempt is out");
  assert.equal(calls(w, "/login").filter((c) => c.body.token === "tok-2").length, 2, "the old token was posted twice and not again");
  await w.fetch.open("/login").answer(200, { ok: true });
  assert.deepEqual(w.location.assigned, ["/"]);
  // Two attempts out at once: the older one's answer, arriving after a newer submit, does nothing, whether it
  // signs in, refuses or reaches nothing; only the newest attempt's answer acts.
  const two = boot(String(loginPage()), { url: "/login" });
  const field = two.document.getElementById("token");
  field.value = "tok-a";
  two.submit(two.document.getElementById("login-form"));
  field.value = "tok-b";
  two.submit(two.document.getElementById("login-form"));
  const [older, newer] = calls(two, "/login");
  assert.deepEqual([older.body, newer.body], [{ token: "tok-a" }, { token: "tok-b" }]);
  await older.answer(200, { ok: true });
  assert.deepEqual([two.location.assigned, notices(two)], [[], []], "the older sign-in's 200 navigates nowhere");
  await newer.answer(401, { error: "that token is not valid for this console" });
  assert.deepEqual(notices(two), ["wrong"]);
  field.value = "tok-c";
  two.submit(two.document.getElementById("login-form"));
  field.value = "tok-d";
  two.submit(two.document.getElementById("login-form"));
  await calls(two, "/login")[2].fail();
  two.tick(RETRY_MS * 5);
  assert.equal(calls(two, "/login").length, 4, "the older attempt reaching nothing schedules no retry");
  await calls(two, "/login")[3].answer(429, { error: "too many" });
  assert.deepEqual(notices(two), ["rate"]);
  // Without the script nothing here works, so the server draws what does hidden with data-reveal, and
  // the script shows it first; an element only hidden stays as it was.
  const marked = String(loginPage()).replace('<form id="login-form"', '<p id="rv" hidden data-reveal>shown by the script</p><p id="kept" hidden>not mine</p><form hidden data-reveal id="login-form"');
  const r = boot(marked, { url: "/login" });
  assert.deepEqual([shown(r.document.getElementById("rv")), shown(r.document.getElementById("login-form")), shown(r.document.getElementById("kept"))], [true, true, false]);
});

stateTest(T.signInStops, async () => {
  // Nothing answers, quickly: 30 posts, RETRY_MS apart, then the attempt stops.
  const w = boot(String(loginPage()), { url: "/login" });
  const input = w.document.getElementById("token");
  input.value = "tok-1";
  w.submit(w.document.getElementById("login-form"));
  for (let i = 1; i < SIGN_IN_TRIES_MAX; i++) {
    await w.fetch.open("/login").fail();
    assert.deepEqual(notices(w), ["unreachable"], `try ${i}`);
    w.tick(RETRY_MS);
  }
  assert.equal(calls(w, "/login").length, SIGN_IN_TRIES_MAX);
  input.value = "typed while it retried";
  await w.fetch.open("/login").fail();
  assert.deepEqual(notices(w), ["gaveup"], "the attempt stopped, and says so alone");
  const box = w.document.querySelector('[data-notice="gaveup"]');
  assert.deepEqual([text(box.querySelector(".banner__t")), text(box.querySelector(".banner__s"))], [SIGN_IN_GAVE_UP.title, SIGN_IN_GAVE_UP.login]);
  assert.ok(box.querySelector(".tile svg"), "the server's notice, copied: its tile and tone");
  assert.equal(box.querySelector(".banner").className, w.document.querySelector('[data-notice="unreachable"] .banner').className);
  assert.equal(input.value, "", "the field cleared");
  w.tick(10 * 60_000);
  assert.equal(calls(w, "/login").length, SIGN_IN_TRIES_MAX, "and nothing more is sent: the token is no longer held");
  assert.equal(w.location.assigned.length, 0);
  // Pressing Sign in again starts afresh, with the new token alone; a second stop shows the same notice, once.
  input.value = "tok-2";
  w.submit(w.document.getElementById("login-form"));
  assert.deepEqual(calls(w, "/login").at(-1).body, { token: "tok-2" });
  await w.fetch.open("/login").answer(200, { ok: true });
  assert.deepEqual(w.location.assigned, ["/"]);
  assert.equal(w.document.querySelectorAll('[data-notice="gaveup"]').length, 1);
  // Slow failures (a connection that hangs before it fails): 60 s from the first post comes first.
  const slow = boot(String(loginPage()), { url: "/login" });
  slow.document.getElementById("token").value = "tok-s";
  slow.submit(slow.document.getElementById("login-form"));
  for (let i = 0; i < 3; i++) {
    slow.tick(25_000);
    await slow.fetch.open("/login").fail();
    slow.tick(RETRY_MS);
  }
  assert.equal(calls(slow, "/login").length, 3, "three posts: the third failed past 60 s from the first");
  assert.deepEqual(notices(slow), ["gaveup"]);
  assert.equal(SIGN_IN_TRIES_MAX * RETRY_MS, SIGN_IN_RETRY_FOR_MS, "the two caps agree at the retry pace");
  // The boundary, judged before each post goes out: a retry due 59,999 ms after the first post goes out; one
  // due at 60,000 ms is never sent, and the stop is said at the failure that would have scheduled it.
  const edge = (failAt, page = "login") => {
    const e = page === "login" ? boot(String(loginPage()), { url: "/login" }) : boot(String(loginCodePage()), { url: `/login/code#${"k".repeat(43)}` });
    if (page === "login") {
      e.document.getElementById("token").value = "tok-e";
      e.submit(e.document.getElementById("login-form"));
    }
    e.tick(failAt);
    return e;
  };
  const inside = edge(SIGN_IN_RETRY_FOR_MS - RETRY_MS - 1);
  await inside.fetch.open("/login").fail();
  assert.deepEqual(notices(inside), ["unreachable"]);
  inside.tick(RETRY_MS);
  assert.equal(calls(inside, "/login").length, 2, "the second post leaves at 59,999 ms");
  await inside.fetch.open("/login").fail();
  assert.deepEqual([calls(inside, "/login").length, notices(inside)], [2, ["gaveup"]]);
  const outside = edge(SIGN_IN_RETRY_FOR_MS - RETRY_MS);
  await outside.fetch.open("/login").fail();
  assert.deepEqual(notices(outside), ["gaveup"], "a post due at 60,000 ms is never sent: stopped at once");
  outside.tick(10 * RETRY_MS);
  assert.equal(calls(outside, "/login").length, 1);
  // A timer that runs late (a tab asleep) is judged again as it fires, so the post it was due to send stays unsent.
  const late = edge(1000);
  await late.fetch.open("/login").fail();
  late.timers.jump(SIGN_IN_RETRY_FOR_MS);
  late.tick(RETRY_MS);
  assert.deepEqual([calls(late, "/login").length, notices(late)], [1, ["gaveup"]]);
  // The link page's posts are held to the same boundary.
  const linkEdge = edge(SIGN_IN_RETRY_FOR_MS - RETRY_MS, "link");
  await linkEdge.fetch.open("/login/code").fail();
  assert.deepEqual([calls(linkEdge, "/login/code").length, linkStates(linkEdge), notices(linkEdge)], [1, ["used"], ["gaveup"]]);
  const linkLate = edge(1000, "link");
  await linkLate.fetch.open("/login/code").fail();
  linkLate.timers.jump(SIGN_IN_RETRY_FOR_MS);
  linkLate.tick(RETRY_MS);
  assert.deepEqual([calls(linkLate, "/login/code").length, linkStates(linkLate), notices(linkLate)], [1, ["used"], ["gaveup"]]);
  // The one-time link: the same cap; by then the link has expired, so the page shows used and the stop notice.
  const code = "k".repeat(43);
  const link = boot(String(loginCodePage()), { url: `/login/code#${code}` });
  for (let i = 1; i < SIGN_IN_TRIES_MAX; i++) {
    await link.fetch.open("/login/code").fail();
    link.tick(RETRY_MS);
  }
  assert.deepEqual([linkStates(link), notices(link)], [["wait"], ["unreachable"]]);
  await link.fetch.open("/login/code").fail();
  assert.deepEqual([linkStates(link), notices(link)], [["used"], ["gaveup"]]);
  assert.equal(text(link.document.querySelector('[data-notice="gaveup"] .banner__s')), SIGN_IN_GAVE_UP.link);
  link.tick(10 * 60_000);
  assert.equal(calls(link, "/login/code").length, SIGN_IN_TRIES_MAX, "the code is not sent again");
});

stateTest(T.link, async () => {
  const none = boot(String(loginCodePage()), { url: "/login/code" });
  assert.deepEqual([linkStates(none), notices(none), none.fetch.calls.length], [["nocode"], [], 0], "a link with no code: said, nothing sent");
  const code = "k".repeat(43);
  const open = (hash = `#${code}`) => boot(String(loginCodePage()), { url: `/login/code${hash}` });
  const w = open();
  assert.deepEqual(w.history.states, ["/login/code"], "the code is out of the history first");
  assert.deepEqual([linkStates(w), calls(w, "/login/code").map((c) => c.body)], [["wait"], [{ code }]]);
  await w.fetch.open("/login/code").answer(401, { error: "this sign-in link is used, expired or unknown" });
  assert.deepEqual([linkStates(w), notices(w)], [["used"], []], "the link's own refusal: the used state says it all");
  // Literal pairs, not NOTICE_OF_STATUS read back. A 429 is the limiter's, answered before the code is read: the link
  // was not tried, so it is not shown used. A 503 or a 500 comes after the server took the code: used.
  for (const [status, kind, state] of [[429, "rate", "wait"], [503, "tokens", "used"], [500, "audit", "used"]]) {
    const r = open();
    await r.fetch.open("/login/code").answer(status, { error: "the console's own sentence" });
    assert.deepEqual([linkStates(r), notices(r)], [[state], [kind]], String(status));
  }
  // A new link pasted into the same tab changes only the fragment: the page is loaded again for it, so it is posted.
  const pasted = open();
  await pasted.fetch.open("/login/code").answer(429, { error: "too many" });
  pasted.hash(`#${"m".repeat(43)}`);
  assert.equal(pasted.location.reloads, 1);
  // The link's own 401 is its used state alone (asserted above), whatever the table holds for it; these three are the
  // only notices a link page shows for a status.
  assert.deepEqual(["429", "500", "503"].map((st) => NOTICE_OF_STATUS["/login/code"][st]), ["rate", "audit", "tokens"]);
  const odd = open();
  await odd.fetch.open("/login/code").answer(400, { error: "a sentence of its own" });
  assert.deepEqual([linkStates(odd), notices(odd)], [["used"], ["other"]]);
  assert.equal(text(odd.document.querySelector('[data-notice="other"] [data-notice-text]')), "a sentence of its own");
  // No answer: still signing in, and the same code posted again every 2 s.
  const far = open(`#${code}&next=/runs`);
  await far.fetch.open("/login/code").fail();
  assert.deepEqual([linkStates(far), notices(far)], [["wait"], ["unreachable"]]);
  far.tick(RETRY_MS);
  assert.deepEqual(calls(far, "/login/code").map((c) => c.body), [{ code, next: "/runs" }, { code, next: "/runs" }]);
  await far.fetch.open("/login/code").answer(200, { ok: true, next: "/runs" });
  assert.deepEqual(far.location.replaced, ["/runs"]);
  // The state the server drew stands: data-reveal shows it, and the script moves off it only
  // for a missing code or an answer, never by forcing "wait". So each link golden, loaded with a code and its post held
  // (the width check's way), is measured in the state it draws; with no code it says so.
  for (const state of ["wait", "used", "nocode"]) {
    const markup = String(loginCodePage({ state }));
    assert.equal((markup.match(/hidden data-reveal/g) ?? []).length, 1, `${state}: the drawn state alone is the script's to reveal`);
    const held = boot(markup, { url: `/login/code#${code}` });
    assert.deepEqual([linkStates(held), calls(held, "/login/code").length], [[state], 1], `${state}: as drawn while its post is out`);
    assert.deepEqual(linkStates(boot(markup, { url: "/login/code" })), ["nocode"], `${state}: no code`);
  }
});

// ---- the runs page: the search field and the filter bar (RunsScreen, RunsPhone, Shell's Search) -----------------------

/**
 * The runs page's filter bar as the kit draws its parts (`panels/runs.mjs` `runsFilters` builds the real one): the
 * search pill, the Filters toggle, a row of project pills, a closed list in a field and Apply, in a GET form marked
 * `data-collapsible`.
 */
function filterBar({ q = null, outcome = "" } = {}) {
  const list = ui.field({ label: "Outcome", id: "f-outcome", control: ui.select({ id: "f-outcome", name: "outcome", value: outcome, options: [{ value: "", label: "Any" }, { value: "failed", label: "failed" }] }) });
  return html`<form class="filterbar" method="get" action="/runs" data-collapsible>${ui.searchPill({ id: ui.SEARCH_ID, name: "q", value: q })}${ui.filterToggle({ count: outcome === "" ? 0 : 1 })}${ui.chipRow([ui.fpill({ label: "All", count: 3, href: "/runs", on: true })], { label: "Project" })}${list}${ui.btn({ label: "Apply", type: "submit" })}</form>`;
}

/** The runs page in the shell, its filters a live panel above the table's, for `role`, on a read-only console or not. */
function runsPage({ role = "operator", readOnly = false, bar = filterBar() } = {}) {
  const session = role === "operator" ? OPERATOR : { name: "watcher", role: "viewer" };
  const ctx = { session, readOnly, data: { parkedCount: 0, now: NOW }, query: {}, theme: null, maxStreams: 4 };
  const inner = html`<section id="p-filters" data-panel>${bar}</section><section id="p-runs" data-panel><p>runs</p></section>`;
  return String(page({ title: "pi-dispatch console: Runs", name: "runs", body: shellHtml("runs", ctx, inner), live: "runs", query: "" }));
}

stateTest("the runs page puts the focus in its search field when it opens at #q, when its address changes to #q, and when Search is pressed there", async () => {
  const w = boot(runsPage(), { url: `/runs#${ui.SEARCH_ID}` });
  assert.ok(w.document.activeElement === w.document.getElementById("q"), "opened at the Search button's address: the field has the focus");
  // Opened plainly nothing moves; the Search button on the runs page itself only changes the fragment (no page loads).
  const p = boot(runsPage(), { url: "/runs" });
  const field = p.document.getElementById("q");
  assert.ok(p.document.activeElement === p.document.body, "a page that opens focuses nothing of its own accord");
  p.hash(`#${ui.SEARCH_ID}`);
  assert.ok(p.document.activeElement === field, "the fragment changed to #q");
  // Pressed again while the address already ends with #q, which fires no hashchange: the field again.
  field.blur();
  const search = p.document.querySelector(`a[href="${SEARCH_HREF}"]`);
  assert.ok(search, "the top bar's Search button");
  search.click();
  assert.ok(p.document.activeElement === field, "Search pressed at #q");
  // Any other fragment, a link that is not Search, and another page holding the field (the run-id 404) leave it alone.
  p.hash("#p-runs");
  field.blur();
  p.document.querySelector('a[href="/runs"]').click();
  assert.ok(p.document.activeElement !== field, "another link or fragment moves nothing");
  const e = boot(String(errorPage({ kind: "no-run", session: OPERATOR, runId: "gh-1" }).html), { url: `/run?id=gh-1#${ui.SEARCH_ID}` });
  assert.ok(e.document.getElementById("q") && e.document.activeElement !== e.document.getElementById("q"), "the 404's field is not the runs page's to focus");
});

stateTest("a filter bar folds on a phone behind its toggle, which the script shows and which opens and closes it; without the script every filter shows", async () => {
  // As the server draws it, which is what a browser without the script shows: nothing folded, the toggle hidden.
  const drawn = parseDocument(runsPage());
  assert.ok(!drawn.querySelector(".filterbar").classList.contains("filterbar--collapsible"), "no fold without the script");
  assert.ok(!shown(drawn.querySelector("[data-filter-toggle]")), "and no button that would do nothing");
  const w = boot(runsPage());
  const bar = w.document.querySelector(".filterbar");
  const toggle = w.document.querySelector("[data-filter-toggle]");
  assert.ok(bar.classList.contains("filterbar--collapsible") && shown(toggle), "folded, its toggle shown");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  toggle.click();
  assert.ok(!bar.classList.contains("filterbar--collapsible") && toggle.getAttribute("aria-expanded") === "true", "opened");
  toggle.click();
  assert.ok(bar.classList.contains("filterbar--collapsible") && toggle.getAttribute("aria-expanded") === "false", "closed again");
  // A live update swaps the panel (its counts changed): the new bar is as the person left it, open, and the toggle that
  // had the focus has it again.
  toggle.click();
  toggle.focus();
  w.streams[0].emit("panel", { id: "p-filters", html: String(filterBar({ outcome: "failed" })) });
  const bar2 = w.document.querySelector(".filterbar");
  const toggle2 = w.document.querySelector("[data-filter-toggle]");
  assert.ok(bar2 !== bar && toggle2 !== toggle, "the panel was swapped");
  assert.ok(!bar2.classList.contains("filterbar--collapsible") && toggle2.getAttribute("aria-expanded") === "true" && shown(toggle2), "still open");
  assert.ok(w.document.activeElement === toggle2, "the focus on the new toggle");
  toggle2.click();
  w.document.body.focus();
  w.streams[0].emit("panel", { id: "p-filters", html: String(filterBar()) });
  assert.ok(w.document.querySelector(".filterbar").classList.contains("filterbar--collapsible"), "closed, it stays closed");
  // A bar that is not marked foldable is left as drawn, and its toggle, if it had one, hidden.
  const plain = boot(runsPage({ bar: html`<form class="filterbar" method="get" action="/runs">${ui.searchPill({ id: ui.SEARCH_ID, name: "q" })}${ui.filterToggle()}</form>` }));
  assert.ok(!plain.document.querySelector(".filterbar").classList.contains("filterbar--collapsible") && !shown(plain.document.querySelector("[data-filter-toggle]")));
});

stateTest("a filter bar in use keeps its live panel still and says so, a viewer's and a read-only console's too: a field focused, a search half typed, a list chosen and not applied", async () => {
  const fresh = String(filterBar({ outcome: "failed" }));
  for (const [role, readOnly] of [["operator", false], ["viewer", false], ["operator", true]]) {
    // Focused: held, saying so with the server's note, and taken once the focus has left (a tick later).
    const f = boot(runsPage({ role, readOnly }));
    const q = f.document.getElementById("q");
    q.focus();
    f.streams[0].emit("panel", { id: "p-filters", html: fresh });
    assert.ok(f.document.getElementById("q") === q, `${role}: not swapped under the focused field`);
    const note = f.document.getElementById("p-filters").firstElementChild;
    assert.equal(note.className, "held", `${role} ${readOnly}: the kept-still note, first in the panel`);
    assert.equal(text(note), String(heldNoteHtml()).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(), `${role} ${readOnly}: the server's own note`);
    q.blur();
    f.tick(0);
    assert.ok(f.document.getElementById("q") !== q && f.document.getElementById("f-outcome").value === "failed", `${role}: the update lands once the field is left`);
    // Typed into: the half typed search is the reader's, after the focus leaves too.
    const t = boot(runsPage({ role, readOnly }));
    t.type(t.document.getElementById("q"), "gh-2f");
    t.streams[0].emit("panel", { id: "p-filters", html: fresh });
    t.document.getElementById("q").blur();
    t.tick(0);
    assert.equal(t.document.getElementById("q").value, "gh-2f", `${role}: the typed search kept`);
    // A list chosen and not applied.
    const s = boot(runsPage({ role, readOnly }));
    const options = s.document.getElementById("f-outcome").querySelectorAll("option");
    options[0].liveSelected = false;
    options[1].liveSelected = true;
    s.streams[0].emit("panel", { id: "p-filters", html: String(filterBar()) });
    assert.equal(s.document.getElementById("f-outcome").value, "failed", `${role}: the chosen list kept`);
    // Nothing in use: the update lands at once.
    const n = boot(runsPage({ role, readOnly }));
    n.streams[0].emit("panel", { id: "p-filters", html: fresh });
    assert.equal(n.document.getElementById("f-outcome").value, "failed", `${role}: swapped`);
  }
  // A list whose markup marks no option chosen shows the browser's first: choosing another is a change, and holds.
  const bare = (attr = "") => html`<form class="filterbar" method="get" action="/runs"><select id="f-kind" name="kind"><option value="">Any</option><option value="github"${attr ? html` selected` : null}>github</option></select></form>`;
  const b = boot(runsPage({ bar: bare() }));
  const kinds = b.document.getElementById("f-kind").querySelectorAll("option");
  kinds[0].liveSelected = false;
  kinds[1].liveSelected = true;
  b.streams[0].emit("panel", { id: "p-filters", html: String(bare()) });
  assert.equal(b.document.getElementById("f-kind").value, "github", "the chosen list kept");
  // Left at the browser's first option, it is not in use, and the update lands.
  const a = boot(runsPage({ bar: bare() }));
  a.streams[0].emit("panel", { id: "p-filters", html: String(bare("on")) });
  assert.equal(a.document.getElementById("f-kind").value, "github", "swapped: the server's new choice");
});

stateTest("a filter bar's GET carries only the fields in use: its empty fields are left out as the form is sent, and enabled again a tick later", async () => {
  for (const [page, bar] of [["runs", filterBar({ q: "acme/web" })], ["audit", html`<form class="filterbar" method="get" action="/audit"><input type="search" name="q" value=""><select name="who"><option value="" selected>Who: all</option><option value="ops">Who: ops</option></select><select name="action"><option value="">Action: all</option><option value="fleet-pause" selected>Action: fleet-pause</option></select>${ui.btn({ label: "Filter", type: "submit" })}</form>`]]) {
    const w = boot(runsPage({ bar }), { url: `/${page}` });
    const form = w.document.querySelector("form.filterbar");
    const named = () => [...form.elements].filter((el) => el.name);
    // As the browser reads the form once every submit listener has run (this one is added after the script's, on the
    // same document): a disabled control is not sent.
    let sent = null;
    w.document.addEventListener("submit", () => { sent = named().filter((el) => !el.disabled).map((el) => [el.name, el.value]); });
    w.submit(form);
    assert.deepEqual(sent, page === "runs" ? [["q", "acme/web"]] : [["action", "fleet-pause"]], `${page}: only what is set`);
    assert.ok(named().filter((el) => el.value === "").every((el) => el.disabled), `${page}: each empty field disabled while the form is read`);
    w.tick(0);
    assert.ok(named().every((el) => !el.disabled), `${page}: and enabled again, so a page brought back by Back works as it was`);
  }
  // A write's form is the confirm slot's, untouched: its fields are the preview's to read.
  const f = boot(fleetPage());
  const repo = f.document.querySelector('input[name="repo"]');
  f.submit(formOf(f, "retry-all-failed"));
  assert.equal(repo.disabled, false, "a write's empty field is never disabled");
});

// ---- what the script is made of ------------------------------------------------------------------------------------

test("the script's closed lists are written in from their one source each, never copied", () => {
  for (const [name, value] of Object.entries({ ENDED_REASONS, STREAM_ENDS, STREAM_SHUTDOWN, PERSON_PARAM, PERSON_HEADER, NOTICE_OF_STATUS, CONFIRM_SLOT_ID, CONFIRM_NO_ANSWER, CONFIRM_SIGNED_OUT, RETRY_MS, SIGN_IN_TRIES_MAX, SIGN_IN_RETRY_FOR_MS, SIGN_IN_GAVE_UP, SIGN_OUT_TIMEOUT_MS, SIGN_OUT_UNCONFIRMED, STALE_TOKENS_BODY })) {
    assert.ok(CONSOLE_SCRIPT.includes(`var ${name} = ${JSON.stringify(value)};`), name);
  }
  assert.ok(CONSOLE_SCRIPT.includes(`var LIVE_NOTE_KEYS = ${JSON.stringify(Object.keys(LIVE_NOTES))};`));
  // Every note and pill state the script names is one the server draws.
  const named = (fn) => [...new Set(Array.from(CONSOLE_SCRIPT.matchAll(new RegExp(`\\b${fn}\\("([^"]*)"\\)`, "g")), (m) => m[1]))].sort();
  assert.deepEqual(named("note"), Object.keys(LIVE_NOTES).sort(), "each live note shown somewhere, and no other");
  assert.deepEqual(named("unnote"), ["retry", "stale"]);
  assert.deepEqual(named("mark"), Object.keys(LIVE_STATES).filter((k) => k !== "start").sort());
  // The sign-in page goes where a reason is the console's own, and nowhere else.
  // Sign-out's only one is its 200's (issue #737): an unconfirmed sign-out stays on the page.
  assert.deepEqual(CONSOLE_SCRIPT.match(/location\.assign\(.*?\);/g), ['location.assign(isReason(r) ? "/login?ended=" + r : "/login");', 'location.assign("/");', 'location.assign("/login");']);
  assert.match(CONSOLE_SCRIPT, /if \(r\.status === 200\) location\.assign\("\/login"\);\n\s+else unconfirmed\(\);\n\s+\}, unconfirmed\);/);
  // The signed-out sentence is said as text, in the slot's message line (slotSays), never as markup.
  assert.match(CONSOLE_SCRIPT, /function signedOut\(r\) \{[^]*?slotSays\(CONFIRM_SIGNED_OUT\);/);
  // The three sentences the script owns are set as text, in their elements, never as markup.
  for (const name of ["SIGN_IN_GAVE_UP.title", "SIGN_IN_GAVE_UP[kind]", "SIGN_OUT_UNCONFIRMED.title", "SIGN_OUT_UNCONFIRMED.body"]) assert.ok(CONSOLE_SCRIPT.includes(`.textContent = ${name};`), name);
  assert.ok(CONSOLE_SCRIPT.includes("sayWithCode(staleBody, tokens ? STALE_TOKENS_BODY : staleData);"));
  assert.match(CONSOLE_SCRIPT, /function sayWithCode\(el, sentence\) \{[^]*?code\.textContent = parts\[i\];[^]*?\n {2}\}/, "the code run set as text, never markup");
});

test("the 2 s the script waits is the stream's own retry and what the sentences promise", () => {
  assert.equal(RETRY_MS, 2000);
  assert.ok(readFileSync(new URL("../src/console/server.mjs", import.meta.url), "utf8").includes(`res.write("retry: ${RETRY_MS}\\n\\n");`), "the stream's retry: line");
  const said = `every ${RETRY_MS / 1000} seconds`;
  assert.ok(LIVE_STATES.retry.title.includes(said), LIVE_STATES.retry.title);
  assert.ok(SIGN_IN_NOTICES.unreachable.body.includes(said), SIGN_IN_NOTICES.unreachable.body);
});

test("the script writes markup in exactly three places: the slot's answer or skeleton, the panel swap, and the transcript append", () => {
  const writes = CONSOLE_SCRIPT.match(/[\w.]+\.(?:innerHTML|outerHTML)\s*=(?!=)|[\w.]*insertAdjacentHTML|document\.write/g) ?? [];
  assert.deepEqual(writes.map((x) => x.replace(/\s+/g, "")), ["slot.innerHTML=", "el.innerHTML=", "tbox.insertAdjacentHTML"]);
  assert.match(CONSOLE_SCRIPT, /function fillSlot\(markup\) \{\n\s+slot\.innerHTML = markup;\n\s+try \{ localTimes\(slot\); \} catch \(e\) \{ \/\* the times stay UTC \*\/ \}\n\s+\}/, "the slot's one write, in one function, its times shown as the page's");
  assert.match(CONSOLE_SCRIPT, /var slot = document\.getElementById\(CONFIRM_SLOT_ID\);/);
  assert.deepEqual(CONSOLE_SCRIPT.match(/\bslot\s*=(?!=)/g), ["slot ="], "bound once, to the server's slot");
  assert.match(CONSOLE_SCRIPT, /function swapPanel\(el, markup\) \{\n[^]*?el\.innerHTML = markup;/, "the panel's one write, in one function");
  assert.match(CONSOLE_SCRIPT, /if \(!el \|\| !el\.hasAttribute\("data-panel"\)\) return;\n[^]*?if \(inUse\(el\)\) hold\(el, msg\.html\);\n\s+else swapPanel\(el, msg\.html\);/, "only an element the server marked data-panel, and not while it is in use");
  assert.match(CONSOLE_SCRIPT, /if \(!el \|\| !el\.hasAttribute\("data-panel"\)\) delete pending\[id\];\n\s+else if \(!inUse\(el\)\) swapPanel\(el, pending\[id\]\);/, "a held update lands only in a panel, once it is free");
});

// ---- the table ------------------------------------------------------------------------------------------------------

test("the client-state table: every row's test is in this file, each state once", () => {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const names = new Set(Object.values(T));
  for (const row of CLIENT_STATES) {
    assert.ok(names.has(row.reached), `${row.card} ${row.state}: reached by a test this file names`);
    assert.ok(LEDGER_CARDS.includes(row.card), row.card);
  }
  for (const [key, name] of Object.entries(T)) assert.ok(source.includes(`stateTest(T.${key},`), `${name}: a test here`);
  const keys = CLIENT_STATES.map((r) => `${r.card} ${r.state}`);
  assert.equal(new Set(keys).size, keys.length, "each state listed once");
  assert.ok(Object.values(T).every((name) => CLIENT_STATES.some((r) => r.reached === name)), "and every test reaches a listed state");
});

test("the client-state table holds every state element of the ConfirmStates, LiveStates, SignIn and AccessStates ledgers", () => {
  const dir = new URL("./fixtures/console-ledger/", import.meta.url);
  for (const card of LEDGER_CARDS) {
    const file = new URL(`${card}.json`, dir);
    assert.ok(existsSync(file), `admin/test/fixtures/console-ledger/${card}.json exists (one ledger per design card)`);
    const ledger = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(ledger.card, card);
    for (const el of ledger.elements.filter((e) => e.kind === "state")) {
      assert.ok(CLIENT_STATES.some((r) => r.card === card && r.state === el.el), `${card}: the state "${el.el}" is in helpers/client-states.mjs with the test that reaches it`);
    }
  }
});

stateTest("inline configuration errors keep unique stable associations across two row forms", async () => {
  const forms = [0,1].map(index => configUi.actForm("pause-window-edit", {hidden:[["index",index,"int"]],fields:configUi.field("scope","Scope"),label:`Preview row ${index+1}`}));
  const markup = String(page({title:"Configuration",name:"config",body:shellHtml("config",{session:OPERATOR,data:{now:NOW},query:{},theme:null},html`<section id="cf-pause-windows" data-panel>${forms}</section>`)}));
  const w=boot(markup);
  const rowForms=w.document.querySelectorAll('form[data-action="pause-window-edit"]');
  const controls=rowForms.map(f=>f.querySelector('[name="scope"]'));
  const ids=[];
  for(let i=0;i<2;i++) {
    w.submit(rowForms[i]);
    await w.fetch.open("/api/act/pause-window-edit/preview").answer(400,{refusal:`scope is invalid on row ${i+1}`});
    ids.push(controls[i].getAttribute("aria-describedby"));
    assert.equal(controls[i].getAttribute("aria-invalid"),"true");
    assert.ok(controls[i].closest(".field").classList.contains("field--err"),"the refused control gets the kit error treatment");
    assert.match(w.document.getElementById(ids[i]).textContent,new RegExp(`row ${i+1}`));
    assert.ok(rowForms[i].contains(w.document.getElementById(ids[i])),"the association stays in its own form");
  }
  assert.notEqual(ids[0],ids[1],"two failed forms never share an error id");
  w.submit(rowForms[0]);
  await w.fetch.open("/api/act/pause-window-edit/preview").answer(400,{refusal:"scope is still invalid on row 1"});
  assert.equal(controls[0].getAttribute("aria-describedby"),ids[0],"the same slot keeps its id on a later refusal");
  assert.match(w.document.getElementById(ids[1]).textContent,/row 2/,"another form's retained error stays associated");
  controls[0].value = "github:acme/web";
  w.submit(rowForms[0]);
  await w.fetch.open("/api/act/pause-window-edit/preview").answer(200,{unchanged:true,html:String(unchangedBarHtml({summary:"The scope is already set"}))});
  assert.ok(!controls[0].closest(".field").classList.contains("field--err"),"a corrected preview clears the old error treatment");
  assert.equal(controls[0].getAttribute("aria-invalid"),null);
  assert.equal(controls[0].getAttribute("aria-describedby"),null);
  assert.ok(controls[1].closest(".field").classList.contains("field--err"),"another form retains its own error treatment");

});
