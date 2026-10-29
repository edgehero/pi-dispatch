import { test } from "node:test";
import assert from "node:assert/strict";
import { FLEET_PANEL_STATES } from "./helpers/fleet-goldens.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIRM_SLOT_ID } from "../src/console/confirm-view.mjs";
import { ENDED_REASONS } from "../src/console/session-ends.mjs";
import { LIVE_NOTES, READ_ONLY_TITLE } from "../src/console/shell.mjs";
import { UNDO_SENTENCES } from "../src/console/actions.mjs";
import { PERSON_CHANGED } from "../src/console/server.mjs";
import { DEFER_BUCKETS, DEFER_BUCKET_WORDS } from "@edgehero/pi-dispatch/defer-reasons";
import { FREE_SLOT_TEXT, HOST_NO_EXPIRY_TEXT, NEEDS_EMPTY, WAITLISTS_CALM } from "../src/console/panels/overview.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { LONG_NAMES, PANELS, PANEL_STATES, RUN_PANEL_STATES, renderPanelStates } from "./helpers/panel-goldens.mjs";
import { CRON_ID_MAX } from "@edgehero/pi-dispatch/triggers";

/**
 * The panel goldens (issue #737): every state of a page the fixture deployment cannot reach (each confirm state,
 * the banner after a write, each live note, the read-only banner, a damaged audit chain, every sign-in notice and the
 * one-time link's states), drawn as a whole page by `helpers/panel-goldens.mjs` (its header says how) and pinned byte
 * for byte as `admin/test/fixtures/console/panels/<state>.<role>.html`. Pure: no Valkey, so it runs everywhere; the
 * width check loads every file here as it loads the screens' goldens.
 *
 *   UPDATE_CONSOLE_FIXTURES=1 node --test test/console-panel-goldens.test.mjs    rewrite them from this render
 *
 * (then read the diff: each file IS the page a person sees in that state).
 */

const update = process.env.UPDATE_CONSOLE_FIXTURES === "1";
const rendered = renderPanelStates();

test("the panel goldens are the states the cards name, by name: the ledgers and the width check read them so", () => {
  const confirm = ["previewing", "preview", "preview-paid", "preview-danger", "unchanged", "bulk-preview", "bulk-results", "refused-preview", "refused-confirm", "preview-long-line", "preview-long-names", "preview-long-queue", "refused-partial", "refused-person", "preview-cancel-queued", "refused-started", "done", "done-rerun", "done-no-undo"].map((s) => `confirm-${s}.operator`);
  const live = ["reconnecting", "not-live", "signed-out", "stale", "kept-still"].map((s) => `live-${s}.operator`);
  const signIn = [...ENDED_REASONS.map((r) => `login-ended-${r}.anonymous`), ...["wrong", "rate", "tokens", "audit", "other"].map((k) => `login-refused-${k}.anonymous`), "login-unreachable.anonymous"];
  // The link page: its two states the script switches to, then each notice it can show (signin.mjs LINK_NOTICES).
  const link = ["login-code-used.anonymous", "login-code-nocode.anonymous", ...["rate", "tokens", "audit", "other"].map((k) => `login-code-refused-${k}.anonymous`), "login-code-unreachable.anonymous"];
  // The overview's states (issue #737): all clear and the first run for both roles where the role changes the page, the
  // waitlists with each kind of wait alone (`DEFER_BUCKETS`), and the two hosts the registry has something to say of.
  const overview = ["overview-all-clear.operator", "overview-all-clear.viewer", "setup-nothing-ready.operator", "setup-partial.operator", "setup-partial.viewer", ...DEFER_BUCKETS.map((b) => `waitlist-${b}.operator`), "overview-host-skew.operator", "overview-host-no-expiry.operator", "overview-host-long-names.operator"];
  // The runs page's footer states, the parked page's answer states, the run-not-found page for both roles, and three
  // more bars: a preview the fleet did not answer in time, a resume over a scan that did not finish, and one over more
  // paused queues than a sentence names.
  const runs = ["runs-mirror-off.operator", "runs-mirror-degraded.operator", "runs-truncated.operator", "runs-unreadable.viewer", "runs-empty.viewer", "runs-unknown-reason.viewer"];
  const parked = ["parked-approval.operator", "parked-approval.viewer", "parked-answerable.operator", "parked-unanswerable.operator", "parked-being-answered.operator", "parked-unknown.operator", "parked-empty.viewer"];
  const more = ["run-not-found.operator", "run-not-found.viewer", "confirm-refused-timeout.operator", "confirm-preview-resume-incomplete.operator", "confirm-preview-many-queues.operator"];
  assert.deepEqual([...PANEL_STATES], [...FLEET_PANEL_STATES, ...RUN_PANEL_STATES, ...confirm, ...live, "read-only.operator", "read-only.viewer", "audit-damaged.operator", "audit-not-verified.operator", ...overview, ...runs, ...parked, ...more, ...signIn, ...link]);
  // `<state>.<role>`, the role one the width check knows (`console-width-check.mjs` `GOLDEN_ROLES`).
  for (const state of PANEL_STATES) assert.match(state, /^[a-z0-9][a-z0-9-]*\.(?:operator|viewer|anonymous)$/, state);
});

test("panel goldens: each byte-identical to its file and to a second render, a whole page, held to every page rule, and no other file in panels/", async () => {
  const first = await rendered;
  const second = await renderPanelStates();
  if (update) mkdirSync(PANELS, { recursive: true });
  for (const state of PANEL_STATES) {
    const file = join(PANELS, `${state}.html`);
    if (update) writeFileSync(file, first[state]);
    assert.ok(existsSync(file), `${file} exists (UPDATE_CONSOLE_FIXTURES=1 writes it)`);
    assert.ok(first[state] === readFileSync(file, "utf8"), `fixtures/console/panels/${state}.html is not what the console draws now: run with UPDATE_CONSOLE_FIXTURES=1, read the diff, and commit it`);
    assert.equal(second[state], first[state], `${state} is the same bytes on a second render`);
    // The width check loads whole pages only: a fragment would load in quirks mode, unstyled.
    assert.match(first[state], /^<!doctype html>\n/, `${state} is a whole page`);
    assertClean(`panels/${state}`, first[state]);
    assert.ok(!first[state].includes("pdc_"), `${state}: no token prefix (the server's leak canary)`);
  }
  // A file nothing draws is a stale golden (a renamed state) or a hand-made one: either way it fails.
  assert.deepEqual(readdirSync(PANELS).sort(), PANEL_STATES.map((s) => `${s}.html`).sort(), "a file per panel state, and no other");
});

/** The slot's opening tag and where it sits: open or not, and the element right before it. */
function slotOf(page) {
  const tag = new RegExp(`<div id="${CONFIRM_SLOT_ID}" class="cslot" role="region" aria-live="polite" aria-label="Preview"( hidden)?>`).exec(page);
  if (!tag) return null;
  const before = page.slice(0, tag.index);
  const panel = [...before.matchAll(/<section id="(p-[a-z-]+)" data-panel>/g)].at(-1)?.[1] ?? null;
  return { open: tag[1] === undefined, at: tag.index, panel, closesWrapper: before.endsWith("</section></div>"), closesPanel: before.endsWith("</section>"), body: page.slice(tag.index + tag[0].length) };
}

/** The live notes shown (not hidden) on a page, by state. */
const notesShown = (page) => [...page.matchAll(/<div data-live-note="([a-z]+)">/g)].map((m) => m[1]);

test("the confirm states: the slot open right after the wrapper of the card that asked, never inside a panel, holding that state's bar", async () => {
  const pages = await rendered;
  const want = {
    "confirm-previewing": ["p-fleetbar", '<span data-slot-title>Previewing: Pause the fleet</span>'],
    "confirm-preview": ["p-settings", '<p class="confirm__undo">'],
    "confirm-preview-paid": ["p-failed", '<div class="confirm confirm--paid">'],
    "confirm-preview-danger": ["p-fleetbar", '<div class="confirm confirm--danger">'],
    "confirm-unchanged": ["p-settings", '<div class="confirm confirm--none">'],
    "confirm-bulk-preview": ["p-failed", '<div class="confirm confirm--paid">'],
    "confirm-bulk-results": ["p-failed", '<ul class="confirm__results">'],
    "confirm-refused-preview": ["p-settings", "The change was refused"],
    "confirm-refused-confirm": ["p-failed", "This confirmation cannot be used"],
    "confirm-preview-long-line": ["p-pause-windows", '<ul class="confirm__list">'],
    "confirm-refused-partial": ["p-fleetbar", "The change did not finish"],
    "confirm-refused-person": ["p-queues", "This browser is now signed in as someone else"],
    "confirm-preview-cancel-queued": ["p-queues", "build3 has no free job slot"],
    "confirm-refused-started": ["p-queues", "started since the preview; nothing was changed"],
  };
  for (const [state, [panel, shows]] of Object.entries(want)) {
    const page = pages[`${state}.operator`];
    const slot = slotOf(page);
    assert.ok(slot?.open, `${state}: the slot is open`);
    assert.equal(slot.panel, panel, `${state}: after ${panel}`);
    assert.ok(page.includes('class="legacy"') ? slot.closesWrapper : slot.closesPanel, `${state}: immediately after the asking panel or its legacy wrapper, outside it`);
    assert.equal(page.split(`id="${CONFIRM_SLOT_ID}"`).length, 2, `${state}: one slot`);
    assert.ok(slot.body.slice(0, slot.body.indexOf("<template")).includes(shows), `${state}: the slot holds ${shows}`);
  }
  // The bars that carry the longest names (`LONG_NAMES`), asked from the overview's Hosts card: the slot right after
  // that card, in its column (no grid there is marked `data-slot-after`), so the width check measures each bar where the
  // script puts it. Resume fleet over two such host queues paused names both in its waiting line and its Undo; one such
  // queue's Pause names it in the summary, the Undo and the Confirm label.
  const { host, peer } = LONG_NAMES;
  for (const [state, shows] of [
    ["confirm-preview-long-names", [`(pi-jobs@${host}, pi-jobs@${peer}): each reserves`, `Pause queues pi-jobs@${host}, pi-jobs@${peer} again by hand, one at a time`]],
    ["confirm-preview-long-queue", [`Pause queue pi-jobs@${peer}: nothing new starts there`, `<b>Resume queue pi-jobs@${peer}</b>`, `data-confirm>Pause queue pi-jobs@${peer}</button>`]],
  ]) {
    const page = pages[`${state}.operator`];
    const slot = slotOf(page);
    assert.ok(slot?.open, `${state}: the slot is open`);
    assert.equal(slot.panel, "p-hosts", `${state}: after the Hosts card`);
    assert.ok(page.slice(0, slot.at).endsWith("</section>") && !slot.closesWrapper, `${state}: right after the card, inside its column`);
    assert.equal(page.split(`id="${CONFIRM_SLOT_ID}"`).length, 2, `${state}: one slot`);
    const bar = slot.body.slice(0, slot.body.indexOf("<template"));
    for (const text of shows) assert.ok(bar.includes(text), `${state}: the bar says ${text.slice(0, 60)}`);
  }
  // What the bars say, from the real action table: the paid retry's reserve and its Undo. A retry keeps the job's
  // attempts, so the cancel of a queued job never takes it back: the ConfirmStates ledger names the design's "Cancel
  // the new run" as absent for a retry, and a re-run's banner offers it.
  const paid = pages["confirm-preview-paid.operator"];
  assert.ok(paid.includes(">Retry for up to $2.00</button>") && paid.includes("It holds 1 job slot and $2.00 (the per-job cap)"), "the paid label and the reserve");
  assert.ok(paid.includes(`<span>No undo: ${UNDO_SENTENCES.retried}</span>`), "retry's Undo is the retried sentence, muted after No undo");
  assert.ok(pages["confirm-preview-danger.operator"].includes(">Pause the fleet</button>"), "the danger label");
  assert.ok(pages["confirm-bulk-preview.operator"].includes(">Retry 3, at least $4.00</button>") && pages["confirm-bulk-preview.operator"].includes("2 more match and are <b>not in this action</b>"), "the bulk label, each reserve, how many more");
  assert.ok(pages["confirm-bulk-results.operator"].includes(">3 audit rows, from row 44</a>") && pages["confirm-bulk-results.operator"].includes("data-reload>Reload</button>"), "the rows the confirm wrote, and Reload");
  assert.ok(pages["confirm-preview.operator"].includes('<span class="ticket">Preview expires in <b data-expires="300000">5:00</b></span>'), "the expiry");
  // The partial refusal says some of it may have been done, never that nothing was; the person refusal names the
  // other sign-in; the long line is the new window as JSON, one word with no space in it.
  const partial = pages["confirm-refused-partial.operator"];
  assert.ok(partial.includes("Some of it may have been done, so this page may be out of date.") && !partial.slice(partial.indexOf('id="confirm-slot"')).split("<template")[0].includes("Nothing was changed"), "partial: what may have changed");
  assert.ok(pages["confirm-refused-person.operator"].includes(`${PERSON_CHANGED.charAt(0).toUpperCase()}${PERSON_CHANGED.slice(1)}.`), "the person refusal's sentence, the server's own");
  assert.match(pages["confirm-preview-long-line.operator"], /<li>\{&quot;scope&quot;:&quot;github:acme\/api&quot;,&quot;from&quot;:&quot;01:00&quot;,[^ <]*\}<\/li>/, "the window's JSON, one line with no space");
  // After a write the slot is closed again, and the page opens with the done banner (its Undo a form where it has one).
  for (const [state, undo] of [["confirm-done", true], ["confirm-done-no-undo", false]]) {
    const page = pages[`${state}.operator`];
    assert.equal(slotOf(page).open, false, `${state}: the slot closed, at the end of main`);
    assert.ok(page.includes("Changed by ops. <a class=\"link\" href=\"/audit?seq=44#seq-44\">Audit row 44</a>."), `${state}: who, and the row`);
    assert.equal(page.includes('<form data-action="fleet-resume" class="undo" autocomplete="off">'), undo, `${state}: the Undo form`);
  }
  assert.ok(pages["confirm-done-no-undo.operator"].includes(` No undo: ${UNDO_SENTENCES.held}</p>`), "a cancelled hold says why there is no way back");
  // A re-run's Undo, decided at the confirm: the cancel of the job it queued, offered while that job has not started.
  const rerun = pages["confirm-done-rerun.operator"];
  assert.equal(slotOf(rerun).open, false, "confirm-done-rerun: the slot closed");
  assert.ok(rerun.includes('<form data-action="cancel-queued" class="undo" autocomplete="off">') && rerun.includes('value="cron:nightly:1760010000000"'), "the Undo form cancels the new job");
  // What happened, in the past tense, the act's own summary staying the preview's.
  assert.ok(pages["confirm-done.operator"].includes('<p class="banner__t">Paused the fleet</p>') && pages["confirm-done-no-undo.operator"].includes('<p class="banner__t">Cancelled held job gh-h41c</p>'));
});

test("the live states: the pill and exactly one note each, the page dimmed when shown as last seen, the kept-still note in the held panel", async () => {
  const pages = await rendered;
  const want = { reconnecting: ["live live--retry", "Reconnecting", ["retry"]], "not-live": ["live live--off", "Not live", ["limit"]], "signed-out": ["live live--off live--out", "Signed out", ["out"]], stale: ["live", "Live", ["stale"]], "kept-still": ["live", "Live", []] };
  for (const [state, [cls, word, notes]] of Object.entries(want)) {
    const page = pages[`live-${state}.operator`];
    assert.ok(page.includes(`<span id="live-status" class="${cls}" role="status" aria-live="polite"`), `${state}: the pill's classes`);
    assert.ok(page.includes(`<span data-live-word>${word}</span>`), `${state}: the pill's word`);
    assert.deepEqual(notesShown(page), notes, `${state}: the notes shown`);
    assert.equal(slotOf(page).open, false, `${state}: no preview open`);
  }
  assert.deepEqual(Object.values(want).flatMap(([, , notes]) => notes).sort(), Object.keys(LIVE_NOTES).sort(), "every live note is some state's, once");
  const stale = pages["live-stale.operator"];
  assert.ok(stale.includes('<main id="main" tabindex="-1" class="stale">') && stale.includes('<time data-since datetime="2026-10-08T15:37:08.000Z">2026-10-08 15:37 UTC</time>'), "dimmed, with when it was last seen");
  assert.ok(pages["live-not-live.operator"].includes("One token may hold 4 live tabs"), "the token's limit, as serve passes it");
  const held = pages["live-kept-still.operator"];
  assert.ok(held.includes('<section id="p-failed" data-panel><div class="held" role="status">'), "the note leads the held panel");
  assert.equal(held.split('<div class="held" role="status">').length, 3, "once in the panel, once in the shell's template");
});

test("the read-only banner for both roles, with no form and no slot; the damaged audit chain and the rows after it", async () => {
  const pages = await rendered;
  for (const role of ["operator", "viewer"]) {
    const page = pages[`read-only.${role}`];
    assert.ok(page.includes(`<p class="banner__t">${READ_ONLY_TITLE}</p>`) && page.includes('<span class="code">PI_CONSOLE_READ_ONLY=1</span>'), `${role}: the banner`);
    assert.ok(!page.includes("<form data-action") && slotOf(page) === null, `${role}: no write form, no slot`);
  }
  // Row 5's prev was rewritten: row 5 is the damaged place, and row 4, the other end of the broken link, is not vouched
  // for either (the chain cannot tell which of the two changed), so the verified range ends at row 3.
  const damaged = pages["audit-damaged.operator"];
  assert.ok(damaged.includes("Chain verified through row 3. Line 5 of 2026-10.jsonl is damaged."), "the chain banner, naming the line the check names");
  // A damaged row is tinted and keyed by its place, not its seq (its seq is what the chain cannot vouch for).
  assert.ok(damaged.includes('<tr id="line-2026-10-5" class="row--failed">'), "the damaged row is marked");
  assert.ok(!damaged.includes("Not verified: it follows the damaged row."), "nothing after it, so nothing after it unverified");
  assert.equal(damaged.split("Not verified: the link to the row after it does not hold.").length - 1, 1, "the row before it says why it is not verified");
  const after = pages["audit-not-verified.operator"];
  assert.ok(after.includes("Chain verified through row 2. Line 4 of 2026-10.jsonl is damaged."), "the chain banner");
  assert.equal(after.split("Not verified: it follows the damaged row.").length - 1, 2, "both rows written after it say so");
  assert.equal(after.split("Not verified: the link to the row after it does not hold.").length - 1, 1, "and the row before it");
  assert.ok(after.includes('<tr id="line-2026-10-4" class="row--failed">') && after.includes('<tr id="seq-6">') && after.includes('<tr id="seq-5">') && after.includes('<tr id="seq-3">'), "the damaged row, then the two after it and the one before it by their seq");
});

/** A panel's section in a page, its inner HTML, or null. */
const panelOf = (page, id) => new RegExp(`<section id="${id}" data-panel>([^]*?)</section>`).exec(page)?.[1] ?? null;

/** The headline's text in a page. */
const headlineOf = (page) => /<span id="p-headline" data-panel>([^<]*)<\/span>/.exec(page)?.[1] ?? null;

test("the overview's states: all clear, the first run for each role, each kind of wait alone, and the hosts' registry notes", async () => {
  const pages = await rendered;
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
  for (const role of ["operator", "viewer"]) {
    const page = pages[`overview-all-clear.${role}`];
    assert.equal(headlineOf(page), "All clear. 4 jobs running, nothing needs you.", role);
    assert.ok(panelOf(page, "p-needs").includes(`<b>All clear</b><span>${NEEDS_EMPTY.body}</span>`), `${role}: Needs you's empty state`);
    // The same panels as the problem state, so nothing jumps; the first run's three are empty.
    for (const id of ["p-setup", "p-setup-pi", "p-setup-empty"]) assert.equal(panelOf(page, id), "", `${role}: ${id} is empty`);
    assert.ok(panelOf(page, "p-waitlists").includes(esc(WAITLISTS_CALM)), `${role}: the calm line`);
    assert.ok(!page.includes("data-action=") || role === "operator", `${role}: a viewer has no form`);
  }
  // The first run: the checklist, and the eight empty; a viewer reads the steps without a command or Add.
  for (const state of ["setup-nothing-ready.operator", "setup-partial.operator", "setup-partial.viewer"]) {
    const page = pages[state];
    assert.match(panelOf(page, "p-setup"), /<h2>Getting ready<\/h2>/, state);
    for (const id of ["p-needs", "p-waiting", "p-active", "p-spend", "p-timeline", "p-caps", "p-waitlists", "p-hosts"]) assert.equal(panelOf(page, id), "", `${state}: ${id} is empty`);
    assert.match(headlineOf(page), /^The console is up\. /, state);
  }
  assert.match(panelOf(pages["setup-partial.operator"], "p-setup"), /<b class="su-big">3<\/b> of 8 ready/);
  assert.match(panelOf(pages["setup-partial.operator"], "p-setup"), /from doctor on build3, 2 minutes ago/);
  assert.match(panelOf(pages["setup-partial.operator"], "p-setup"), /Add a trigger/);
  for (const absent of ['class="cmd"', "Add a trigger"]) assert.ok(!pages["setup-partial.viewer"].includes(absent), `a viewer: no ${absent}`);
  // Each waitlist state holds its kind of wait alone, under the bucket's title, with the row's one action.
  // What each kind of wait's rows offer, by bucket; the buckets themselves are the leaf's (DEFER_BUCKETS), so one it gains
  // fails here by name until its actions are written down.
  const actions = { slot: ["Open build3", "Cancel"], run: ["Chain"], check: ["Edit"], retry: [], pause: ["Cancel"], ready: ["Cancel"], paused: ["Cancel"], due: ["Cancel", "Edit"], unknown: ["Cancel"], none: ["Cancel"] };
  for (const b of DEFER_BUCKETS) {
    assert.ok(Object.hasOwn(actions, b), `the waitlist state of bucket ${b} has its actions written down here`);
    const list = panelOf(pages[`waitlist-${b}.operator`], "p-waitlists");
    const titles = DEFER_BUCKETS.filter((x) => list.includes(`<b>${esc(DEFER_BUCKET_WORDS[x].title)}</b>`));
    assert.deepEqual(titles, [b], `waitlist-${b}: its bucket alone`);
    const drawn = [...list.matchAll(/<(?:a class="btn[^"]*" href="[^"]*"|button class="btn[^"]*" type="submit")>([A-Za-z0-9 -]+)<\/(?:a|button)>/g)].map((m) => m[1]).filter((w) => w !== "Spend");
    assert.deepEqual([...new Set(drawn)].sort(), [...actions[b]].sort(), `waitlist-${b}: its actions`);
  }
  assert.ok(panelOf(pages["waitlist-slot.operator"], "p-waitlists").includes(esc(FREE_SLOT_TEXT)), "the free slot's sentence");
  assert.ok(panelOf(pages["waitlist-unknown.operator"], "p-waitlists").includes('<span class="code">brand-new-why</span>'), "an operator reads a reason this console has no words for as its token");
  // A scheduler's overdue next run, named by its trigger and its run time (the raw id in its title): its cron trigger's
  // Edit, and no Cancel, which the queue would refuse.
  const due = panelOf(pages["waitlist-due.operator"], "p-waitlists");
  assert.match(due, /<span class="code" title="repeat:hourly-sync:\d+">hourly-sync, <time[^>]*>[^<]+<\/time> run<\/span><span class="wl__t">Due since <time[^>]*>[^<]+<\/time>; no worker has taken it<\/span><a class="btn btn--sm btn--ghost" href="\/config">Edit<\/a><\/li>/);
  assert.equal((due.match(/data-action="cancel-queued"/g) ?? []).length, 1, "Cancel for the job that never started alone");
  // The registry's notes on a host.
  assert.ok(panelOf(pages["overview-host-skew.operator"], "p-hosts").includes(esc("build3's clock is about 1m 48s behind this console's: its beat says 2m ago, and Valkey last refreshed its row 12s ago.")), "the skew");
  assert.ok(panelOf(pages["overview-host-no-expiry.operator"], "p-hosts").includes(esc(HOST_NO_EXPIRY_TEXT)), "no expiry");
  // The long names, each legal and each drawn where running text holds it, so the width check measures every one.
  const { host, gone, cron } = LONG_NAMES;
  for (const name of [host, gone]) assert.ok(WORKER_NAME_RE.test(name) && name.length === 64, `${name}: the longest name a worker can declare`);
  assert.ok(/^[A-Za-z0-9._-]+$/.test(cron) && cron.length === CRON_ID_MAX, "a cron trigger id, the longest the triggers file takes, with no place to break");
  const long = pages["overview-host-long-names.operator"];
  const hosts = panelOf(long, "p-hosts");
  assert.ok(hosts.includes("Partly paused: 1 host queue</span>"), "the head counts the paused queue, never names it");
  assert.ok(hosts.includes(`<b>${host}</b>`) && hosts.includes(`<span class="code">@${host}</span> paused, `) && hosts.includes(`aria-label="Resume ${host}"`), "the host, its paused queue and its resume");
  const waitlists = panelOf(long, "p-waitlists");
  assert.ok(waitlists.includes(`<span class="wl__t">${host} has no free job slot. <span class="code">gh-4a7e</span> still holds one of its slots</span>`), "a job waiting for the long host's slot");
  assert.ok(waitlists.includes(`. It is in <span class="code">pi-jobs@${gone}</span>, whose host is not in the registry`), "a job in a gone host's queue");
  assert.ok(waitlists.includes(`<span class="qp"><b class="code">@${host}</b>paused, 1 delayed</span>`) && waitlists.includes(`<span class="qp"><b class="code">@${gone}</b>1 in line, its host not in the registry</span>`), "both queues in the Queues line");
  assert.ok(waitlists.includes(`Scheduled: <span class="code">${cron}</span> <time`), "the cron trigger next in Scheduled");
});

test("the sign-in states: exactly one notice each, the reason's or the refusal's; the link page in each state", async () => {
  const pages = await rendered;
  const shownNotices = (page) => [...page.matchAll(/<div data-notice="([a-z-]+)">/g)].map((m) => m[1]);
  for (const r of ENDED_REASONS) assert.deepEqual(shownNotices(pages[`login-ended-${r}.anonymous`]), [`ended-${r}`], r);
  for (const k of ["wrong", "rate", "tokens", "audit", "other"]) assert.deepEqual(shownNotices(pages[`login-refused-${k}.anonymous`]), [k], k);
  assert.deepEqual(shownNotices(pages["login-unreachable.anonymous"]), ["unreachable"]);
  // A refusal no notice names says the server's own sentence, set as text, in both pages' `other` notice.
  for (const state of ["login-refused-other.anonymous", "login-code-refused-other.anonymous"]) {
    assert.ok(pages[state].includes("<span data-notice-text>a write must come from the console&#39;s own origin, and its Origin header named another</span>"), state);
  }
  assert.ok(pages["login-ended-idle.anonymous"].includes("You were signed out after 60 minutes without a request"), "the console's own idle limit");
  assert.ok(pages["login-ended-restart.anonymous"].includes("it may have restarted"), "restart worded as a possibility");
  // The state a page opens in is drawn for the script to reveal (signin.mjs: without a script none shows), the others
  // hidden for it to switch to.
  const states = (page) => [...page.matchAll(/<div class="signin__state" data-link-state="([a-z]+)"( hidden data-reveal| hidden)>/g)].map((m) => [m[1], m[2] === " hidden data-reveal"]);
  for (const state of ["used", "nocode"]) {
    assert.deepEqual(states(pages[`login-code-${state}.anonymous`]), ["wait", "used", "nocode"].map((s) => [s, s === state]), state);
  }
  // The link page's notices: a refusal is the used state with the notice that says why, except too many attempts, which
  // leaves the link untried (the limiter answers before the code is read), so the page keeps waiting; out of reach, it
  // keeps waiting too.
  for (const k of ["rate", "tokens", "audit", "other"]) {
    const page = pages[`login-code-refused-${k}.anonymous`];
    assert.deepEqual([shownNotices(page), states(page).filter(([, opens]) => opens).map(([s]) => s)], [[k], [k === "rate" ? "wait" : "used"]], k);
  }
  const far = pages["login-code-unreachable.anonymous"];
  assert.deepEqual([shownNotices(far), states(far).filter(([, opens]) => opens).map(([s]) => s)], [["unreachable"], ["wait"]]);
  assert.ok(pages["login-code-used.anonymous"].includes("<code><span>pi-dispatch-console</span> <span>link</span> <span>--name</span> <span>&#39;&lt;you&gt;&#39;</span></code>"), "a used link names the command for a new one");
});
