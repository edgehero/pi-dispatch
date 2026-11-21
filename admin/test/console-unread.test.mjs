import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFleetReader, readCapacity, readPauseWindows, readScopedLimits } from "../src/read-model.mjs";
import { assembleCapacityView, assembleHostCapacity } from "../src/insights-assembly.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { triggerListOf, SCHEDULERS_UNREAD_TEXT, SCHEDULERS_UNREAD_NO_RULES_TEXT, TRIGGERS_FILE_ABSENT_TEXT } from "../src/trigger-list.mjs";
import { hostsUnread } from "../src/console/panels/common.mjs";
import { OVERVIEW_UNREAD_TEXT } from "../src/console/panels/overview.mjs";
import { SANDBOX_WORDS } from "../src/console/panels/sandboxes.mjs";
import { HOST_CAPACITY_WORDS } from "../src/console/panels/host.mjs";
import { fileTrouble } from "../src/console/panels/config.mjs";
import { ANSWERER_STANDING_UNREAD } from "../src/console/panels/answerer.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fileViewsFixture, noSnapshotFleet } from "./helpers/no-snapshot.mjs";
import { SETUP_DRAW, setupFixture, setupAvailable, SETUP_AT } from "./helpers/setup-goldens.mjs";
import { setupState } from "../src/setup-view.mjs";
import { FLEET_DRAW } from "./helpers/fleet-goldens.mjs";
import { SANDBOX_DRAW } from "./helpers/sandbox-goldens.mjs";
import { CONFIGURATION_DRAW } from "./helpers/configuration-goldens.mjs";
import { TRIGGER_LIST_DRAW } from "./helpers/trigger-list-goldens.mjs";
import { ANSWERER_DRAW, answererFixture, answererParkedRows } from "./helpers/answerer-goldens.mjs";

/**
 * An unread value is not an empty one (issue #844). With the deployment's Valkey not answering, a page says "not
 * known" for what only Valkey holds and still shows what the files hold; "gone", "none", "not published" and a zero are
 * said only of a read that showed them. Canned readers at a fixed instant; nothing here reads a Valkey.
 */

const NOW = Date.UTC(2026, 9, 8, 15, 39, 0);
/** The words of a page, tags and the scripts' own text dropped. */
const wordsOf = (page) => String(page).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

test("fileViews answers the files under the snapshot's own keys and asks Valkey nothing", () => {
  const dir = tempDir("pd-844-files-");
  assert.ok(dir.startsWith(tmpdir()), "a temp folder, checked before anything is written");
  const paths = { valkeyUrl: "redis://unused", logsDir: join(dir, "logs"), triggersPath: join(dir, "triggers.json"), projectsFile: join(dir, "projects.json"), settingsFile: join(dir, "settings.json"), scopedLimitsPath: join(dir, "scoped-limits.json"), pauseWindowsPath: join(dir, "pause-windows.json"), globalPiDir: join(dir, "pi"), schedulerStallMax: 4 };
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "tidy", task: "tidy up", instructions: "be brief" } }, { on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } }] }));
  writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
  writeFileSync(paths.settingsFile, JSON.stringify({ maxTurns: 30 }));
  const asked = [];
  const refuse = (what) => new Proxy({}, { get: (_, key) => (key === "on" ? () => {} : key === "then" ? undefined : (...args) => { asked.push(`${what}.${String(key)}`); throw new Error("Valkey was asked"); }) });
  const reader = createFleetReader(paths, { redisFn: () => refuse("redis"), makeQueueFn: () => refuse("queue"), parseConnectionFn: () => ({}) });
  const views = reader.fileViews();
  assert.deepEqual(Object.keys(views).sort(), ["envelopeSet", "overlayMcp", "pauseWindows", "projects", "schedulerStallMax", "scopedLimits", "settings", "stagedPackages", "triggers"]);
  assert.equal(views.triggers.triggers.length, 2);
  assert.deepEqual(views.triggers.triggers.map((t) => t.type), ["cron", "label"]);
  assert.deepEqual(views.projects.projects.map((p) => p.id), ["web"]);
  assert.equal(views.settings.overlay.maxTurns, 30);
  assert.equal(views.schedulerStallMax, 4);
  // Whether an envelope is named is the path's to say, with no read at all.
  assert.equal(views.envelopeSet, false);
  assert.equal(createFleetReader({ ...paths, envelopeFile: join(dir, "envelope.json") }, { redisFn: () => refuse("redis"), makeQueueFn: () => refuse("queue"), parseConnectionFn: () => ({}) }).fileViews().envelopeSet, true);
  // The files that are not there are their readers' own shapes, never a throw.
  assert.ok(views.scopedLimits && views.pauseWindows && views.stagedPackages && views.overlayMcp);
  assert.ok(!JSON.stringify(views).includes("be brief") && !JSON.stringify(views).includes("tidy up"), "no instructions and no task text");
  assert.deepEqual(asked, [], "no Valkey command and no queue call");
});

test("loadPageData keeps the file views only where the snapshot failed, and a reader without them or one that throws costs nothing", async () => {
  const down = async () => { throw new Error("Valkey does not answer"); };
  const config = (fleet) => loadPageData("config", {}, { now: () => NOW, fleet });
  const failed = await config(noSnapshotFleet());
  assert.equal(failed.snapshot, null);
  assert.equal(failed.readFailed, true);
  assert.deepEqual(failed.files, fileViewsFixture());
  let calls = 0;
  const read = await config({ snapshot: async () => ({ parked: [] }), fileViews: () => { calls += 1; return fileViewsFixture(); } });
  assert.ok(!Object.hasOwn(read, "files"), "a read snapshot holds the files already");
  assert.equal(calls, 0);
  const none = await config({ snapshot: down });
  assert.equal(none.snapshot, null);
  assert.ok(!none.files, "no reader for them: nothing is made up");
  const thrown = await config({ snapshot: down, fileViews: () => { throw new Error("EACCES"); } });
  assert.equal(thrown.files, null, "a reader that throws is caught: the load never throws");
  // The list page builds its rules from the files, marked as a list whose schedulers were not read.
  let got;
  const listed = await loadPageData("triggers", { kind: "all" }, { now: () => NOW, fleet: noSnapshotFleet(), triggerList: (snapshot) => { got = snapshot; return triggerListOf({ snapshot, now: NOW }); } });
  assert.equal(got.schedulersUnread, true);
  assert.equal(got.triggers.triggers.length, 2);
  assert.equal(listed.triggerList.rows.length, 2);
  // A list reader that throws falls back to the same files, not to "the triggers file is not available".
  const fell = await loadPageData("triggers", { kind: "all" }, { now: () => NOW, fleet: noSnapshotFleet(), triggerList: () => { throw new Error("history"); } });
  assert.equal(fell.triggerList.rows.length, 2);
  assert.equal(fell.triggerList.schedulersUnread, true);
  // File views the list cannot take at all (a shape no reader gives) still end in a page, with no rule facts.
  const broken = await loadPageData("triggers", { kind: "all" }, { now: () => NOW, fleet: noSnapshotFleet({ fileViews: () => ({ triggers: { triggers: {} } }) }), triggerList: () => { throw new Error("history"); } });
  assert.deepEqual(broken.triggerList.rows, []);
  assert.ok(broken.triggerList.problems.includes("The triggers file is not available; rule facts are unknown."));
});

test("nothing read about the hosts: no snapshot, or a registry that was never read; a degraded read after a good one is not that", () => {
  assert.equal(hostsUnread(null), true);
  assert.equal(hostsUnread(undefined), true);
  assert.equal(hostsUnread({ queue: { fleetDegraded: "registry" }, hostsReadAt: null }), true);
  assert.equal(hostsUnread({ queue: { fleetDegraded: "registry" }, hostsReadAt: NOW - 60_000 }), false, "the rows as last seen");
  assert.equal(hostsUnread({ queue: { fleetDegraded: null }, hostsReadAt: null }), false);
  assert.equal(hostsUnread({ queue: {}, hostBudgets: [] }), false, "a read that showed no host");
});

test("/fleet/host says gone, no record and no result only of a read that showed it", async () => {
  const gone = ["Host has gone", "This host has no live registry row", "No retained run record names this host", "No doctor result published by this host", "No live registry row for"];
  for (const state of ["host-no-snapshot.operator", "host-registry-never-read.viewer"]) {
    const words = wordsOf(await FLEET_DRAW[state]());
    assert.match(words, /Host not known/, state);
    assert.match(words, /Not known: the hosts could not be read, so nothing here says whether build3 is live\./, `${state}: the headline`);
    assert.match(words, /Not known: the doctor results could not be read\./, state);
    for (const said of gone.filter((s) => state === "host-no-snapshot.operator" || s !== "No retained run record names this host")) assert.ok(!words.includes(said), `${state}: ${said}`);
  }
  assert.match(wordsOf(await FLEET_DRAW["host-no-snapshot.operator"]()), /This host's run records could not be read\./);
  // The real reader does not throw in an outage: it answers no run and a mirror it did not reach. That is unread too.
  const outage = wordsOf(await FLEET_DRAW["host-outage.viewer"]());
  assert.match(outage, /This host's run records could not be read\./);
  for (const said of gone) assert.ok(!outage.includes(said), `host-outage: ${said}`);
  const row = async (hostHistory) => wordsOf((await renderPage("host", { query: { name: "build3" }, session: { name: "ops", role: "viewer" }, data: { now: NOW, snapshot: { queue: {}, hostBudgets: [], doctor: { hosts: [], more: 0 } }, hostHistory }, theme: null })).html);
  assert.match(await row({ records: [], mirror: "unreachable" }), /This host's run records could not be read\./);
  for (const mirror of ["ok", "off"]) assert.match(await row({ records: [], mirror }), /No retained run record names this host\./, mirror);
  assert.match(await row({ records: [{ jobId: "gh-1", endedAt: new Date(NOW).toISOString() }], mirror: "unreachable" }), /Last seen/);
  // The controls: a read that showed no row still says so, in every one of those sentences.
  const read = wordsOf(await FLEET_DRAW["host-unknown.viewer"]());
  for (const said of ["Host has gone", "This host has no live registry row", "No retained run record names this host", "No doctor result published by this host", "No live registry row for unknown"]) assert.ok(read.includes(said), `host-unknown: ${said}`);
});

test("/fleet/venue with no snapshot, and with a registry never read, says not known where it names hosts", async () => {
  const none = wordsOf(await FLEET_DRAW["venue-no-snapshot.operator"]());
  assert.equal(none.split("not known: the hosts could not be read").length - 1, 4);
  assert.ok(!none.includes("no live host") && !none.includes("No live host"));
  const parsed = parsePageQuery("venue", new URLSearchParams({ name: "openshell" }));
  const draw = async (snapshot) => wordsOf((await renderPage("venue", { query: parsed.query, session: { name: "ops", role: "operator" }, data: { now: NOW, snapshot }, theme: null })).html);
  const never = await draw({ queue: { fleetDegraded: "registry" }, hostsReadAt: null, hostBudgets: [] });
  assert.ok(never.includes("not known: the hosts could not be read") && !never.includes("no live host"));
  const empty = await draw({ queue: {}, hostsReadAt: NOW, hostBudgets: [] });
  assert.ok(empty.includes("no live host") && !empty.includes("not known: the hosts could not be read"), "the control: a read that showed none");
});

test("/setup with no snapshot: the worker, egress, provider and forge steps are not known, the trigger step is the file's", async () => {
  const words = wordsOf(await SETUP_DRAW["setup-no-snapshot.operator"]());
  assert.match(words, /3 of 8 ready · 4 not known/);
  assert.match(words, /Getting ready the doctor results could not be read /);
  assert.match(words, /A first trigger The triggers file holds 2 triggers\./);
  assert.match(words, /Start a worker Not known Valkey could not be read, so nothing here says whether a worker runs\./);
  assert.match(words, /Forge credentials Not known The doctor results could not be read/);
  assert.match(words, /Queue Not yet Valkey does not answer/);
  assert.match(words, /The allowlist count is not known\./);
  for (const said of ["No host is registered", "Add a first trigger", "No doctor result yet", "waiting for a published doctor result", "The allowlist count is not published", "To do"]) assert.ok(!words.includes(said), said);
  // A read snapshot draws no "not known" part at all.
  const read = wordsOf(await SETUP_DRAW["setup-starting.operator"]());
  assert.ok(!read.includes("not known") && /of 8 ready/.test(read));
});

test("/triggers with no snapshot: the file's rules, and next fire, owning host and stalls not known", async () => {
  const words = wordsOf(await TRIGGER_LIST_DRAW["triggers-no-snapshot.operator"]());
  assert.ok(words.includes(SCHEDULERS_UNREAD_TEXT));
  assert.match(words, /2 rules/);
  assert.match(words, /owning host not known/);
  assert.match(words, /Next fire and stall count not known: Valkey could not be read\./);
  assert.match(words, /Not known: Valkey could not be read, so no next fire can be shown\./);
  assert.match(words, /Last run not known: the fleet's run records could not be read\./);
  for (const said of ["The triggers file is not available", "No next fire is published", "owning host not published", "Scheduler next fire unavailable", "timezone is not published", "Rules unavailable", "No run in retained history"]) assert.ok(!words.includes(said), said);
});

test("the trigger list marks what only Valkey says of a schedule as unread, and leaves a read list as it was", () => {
  const files = fileViewsFixture();
  const unread = triggerListOf({ snapshot: { ...files, schedulersUnread: true }, now: NOW });
  assert.equal(unread.schedulersUnread, true);
  assert.deepEqual(unread.counts, { all: 2, schedule: 1, label: 1, comment: 0, pull_request: 0, issue: 0, watch: 0, spent: 0 });
  const cron = unread.rows.find((r) => r.trigger.type === "cron");
  assert.deepEqual(cron.nextFire, { at: null, health: "unknown", stalls: null, stallLimit: 3, hosts: [], zone: null, problem: null, unread: true });
  assert.ok(!cron.unknown.includes("Scheduler next fire unavailable"));
  assert.ok(unread.problems.includes(SCHEDULERS_UNREAD_TEXT));
  assert.equal(unread.week.quietUnknown, false, "the quiet windows are the file's");
  assert.equal(unread.week.lanes[0].problem, "The owning host's timezone could not be read; further schedule times are unknown.");
  const read = triggerListOf({ snapshot: { ...files, schedulers: [] }, now: NOW });
  assert.equal(read.schedulersUnread, false);
  assert.equal(read.rows.find((r) => r.trigger.type === "cron").nextFire.unread, undefined);
  assert.ok(read.rows.find((r) => r.trigger.type === "cron").unknown.includes("Scheduler next fire unavailable"));
  assert.ok(!read.problems.includes(SCHEDULERS_UNREAD_TEXT));
  // No files either: the sentence a missing, unreadable or invalid file has always had.
  assert.ok(triggerListOf({ snapshot: null, now: NOW }).problems.includes("The triggers file is not available; rule facts are unknown."));
});

test("/config with no snapshot: counts and read-only cards from the files, no number above a card that could not be read", async () => {
  const page = await CONFIGURATION_DRAW["config-no-snapshot.operator"]();
  const words = wordsOf(page);
  assert.match(words, /Settings 2 Triggers 2 Pause windows 1 Scoped limits 1 Projects 1 Files 2 Unset 0 MCP servers 0 /);
  assert.match(words, /cron nightly/);
  assert.match(words, /Allocation envelope not set/);
  assert.equal(words.split("Valkey could not be read, so this shows what the file holds and offers no change.").length - 1, 9);
  assert.equal(words.split("The deployment's Valkey could not be read. Reload to try again.").length - 1, 2, "the two secret cards, whose facts are not the files' alone");
  assert.ok(!page.includes('data-action="') && !words.includes("Add a trigger"), "no change is offered");
  // No file views at all: every card says it could not be read, and no tab draws a count.
  const data = await loadPageData("config", {}, { now: () => NOW, fleet: { snapshot: async () => { throw new Error("down"); } } });
  const bare = String((await renderPage("config", { query: {}, session: { name: "ops", role: "operator" }, data, theme: null })).html);
  const nav = bare.slice(bare.indexOf('aria-label="Configuration sections"'), bare.indexOf("config-divider"));
  assert.ok(nav.includes("Triggers") && !/<b>\d+<\/b>/.test(nav), "no count on any tab");
  assert.equal(wordsOf(bare).split("The deployment's Valkey could not be read. Reload to try again.").length - 1, 11);
});

test("/parked: unread parked runs draw no count, unread answer results no split and no zero, an unlisted standing list no none", async () => {
  const none = wordsOf(await ANSWERER_DRAW["answerer-no-snapshot.operator"]());
  assert.ok(none.includes(OVERVIEW_UNREAD_TEXT));
  for (const said of ["Yours to answer", "Drafted for you", "Waiting for a person", "No retained answer from a draft today", "cited 0 times", "sent as drafted", "These questions still wait for a person"]) assert.ok(!none.includes(said), said);
  assert.match(none, /Test command .* citations not known/);
  assert.match(none, /History could not be read; no count is inferred\./);
  const viewer = wordsOf(await ANSWERER_DRAW["answerer-no-snapshot.viewer"]());
  assert.ok(viewer.includes(OVERVIEW_UNREAD_TEXT));
  for (const said of ["Waiting for a person", "Standing answers", "Answer rule:", "Answered today", "These questions still wait for a person"]) assert.ok(!viewer.includes(said), `viewer: ${said}`);

  const draw = async (answerer, snapshot, role = "operator") => wordsOf((await renderPage("parked", { session: { name: role === "operator" ? "ops" : "watcher", role }, data: { now: NOW, env: {}, answerer, snapshot }, query: {} })).html);
  const parked = answererParkedRows(NOW);
  const snap = { parked, queue: { counts: {} }, hostBudgets: [] };
  // The results unread over a read list: the questions, unsplit, and how many wait.
  const model = { ...answererFixture(NOW), state: "unavailable", partial: true, rows: [] };
  const unsplit = await draw(model, snap);
  assert.match(unsplit, /Waiting for a person 2 /);
  for (const said of ["Yours to answer", "Drafted for you", "No retained answer from a draft today", "cited 0 times"]) assert.ok(!unsplit.includes(said), said);
  assert.match(await draw({ state: "unavailable", partial: true, rows: [] }, snap, "viewer"), /Waiting for a person 2 /, "a viewer still reads how many wait");
  // The standing list unlisted (the file that holds it did not load): not "none adopted".
  const { standing, ...unlisted } = answererFixture(NOW);
  const noList = await draw({ ...unlisted, state: "configuration-unavailable" }, snap);
  assert.ok(noList.includes(ANSWERER_STANDING_UNREAD) && !noList.includes("No standing answer has been adopted"));
  // That state read the results (only the triggers file failed), and so does a partial read: the split stays.
  assert.match(noList, /Yours to answer 1 /);
  assert.match(noList, /Drafted for you 1 /);
  assert.match(noList, /These questions still wait for a person/);
  assert.match(await draw({ ...answererFixture(NOW), partial: true }, snap), /Yours to answer 1 .*Drafted for you 1 /);
  // The parked fold alone unread, the results read: no count, and the reader's reason.
  const fold = await draw(answererFixture(NOW), { ...snap, parkedUnreachable: "timeout" });
  assert.match(fold, /The parked runs could not be read \(timeout\); this is not an empty inbox\./);
  assert.ok(!fold.includes("Yours to answer") && !fold.includes("Drafted for you"));
  // The controls: everything read says its counts, and an empty standing list says none.
  const all = await draw(answererFixture(NOW), snap);
  assert.match(all, /Yours to answer 1 /);
  assert.match(all, /Drafted for you 1 /);
  assert.match(all, /cited 2 times/);
  assert.match(await draw({ ...answererFixture(NOW), standing: [] }, snap), /No standing answer has been adopted\./);
});

test("/runs/sandboxes with no report: every card that reads it says so, and a read, empty inventory still says none", async () => {
  for (const state of ["sandboxes-no-snapshot.operator", "sandboxes-unavailable.operator"]) {
    const words = wordsOf(await SANDBOX_DRAW[state]());
    assert.equal(words.split(SANDBOX_WORDS.unavailable).length - 1, 4, `${state}: from a run, without a run, open now, kept`);
    if (state === "sandboxes-unavailable.operator") assert.ok(words.includes("Not known: whether a host is enrolled could not be read.") && !words.includes("Off by default") && !words.includes("Enabled per host"), "no chip beside an enrolment that was not read");
    for (const said of ["0 shown", "0 open", "No live sandbox shell was registered", "Choose a trigger", "Review settings", "No host is enrolled in this console", "No kept workspace was published"]) assert.ok(!words.includes(said), `${state}: ${said}`);
  }
  const empty = wordsOf(await SANDBOX_DRAW["sandboxes-empty.operator"]());
  assert.ok(empty.includes(SANDBOX_WORDS.noShells) && empty.includes("0 open") && empty.includes("Review settings") && empty.includes("No host is enrolled in this console"), "the control");
});

test("/setup over a read snapshot whose doctor results alone were not read says so under the title, and counts those steps", async () => {
  const draw = async (doctor) => {
    const snapshot = { ...setupFixture(), doctor };
    const data = await loadPageData("setup", {}, { now: () => SETUP_AT, deployment: { folder: "pi-dispatch" }, fleet: { snapshot: async () => snapshot }, setup: () => setupAvailable() }, { role: "viewer" });
    return wordsOf((await renderPage("setup", { data, query: {}, session: { name: "watcher", role: "viewer" } })).html);
  };
  const unread = await draw({ unreachable: "timeout" });
  assert.match(unread, /Getting ready the doctor results could not be read /);
  assert.match(unread, /of 8 ready · 2 not known/);
  assert.ok(!unread.includes("waiting for a published doctor result"));
  const none = await draw({ hosts: [], more: 0 });
  assert.match(none, /Getting ready waiting for a published doctor result /, "the control: a read that held no result");
  assert.ok(!none.includes("not known"));
});

test("a host operation under way on a step that could not be read says its own words, and is no longer counted as not known", () => {
  const files = fileViewsFixture();
  const state = (progress, now = SETUP_AT) => setupState(null, { role: "operator", deployment: { folder: "pi-dispatch" }, facts: { ...setupAvailable(), progress }, now, files });
  const idle = state([]);
  assert.equal(idle.unknown, 4);
  assert.equal(idle.steps.find((s) => s.id === "worker").unread, true);
  const starting = state([{ step: "worker", state: "starting", stage: "waiting-heartbeat", atMs: SETUP_AT - 8000 }]);
  assert.deepEqual([starting.steps.find((s) => s.id === "worker").state, starting.steps.find((s) => s.id === "worker").unread], ["starting", false]);
  assert.equal(starting.unknown, 3);
  const waitedOut = state([{ step: "worker", state: "starting", stage: "waiting-heartbeat", atMs: SETUP_AT - 91_000 }]);
  assert.deepEqual([waitedOut.steps.find((s) => s.id === "worker").state, waitedOut.steps.find((s) => s.id === "worker").unread], ["check", false]);
  assert.equal(waitedOut.unknown, 3);
  const timeout = state([{ step: "egress", state: "timeout", stage: "complete", atMs: SETUP_AT - 8000 }]);
  assert.deepEqual([timeout.steps.find((s) => s.id === "egress").state, timeout.steps.find((s) => s.id === "egress").unread], ["check", false]);
  assert.equal(timeout.unknown, 3);
});

/**
 * Issue #962: the same rule where the snapshot loaded and one read beside it did not, and its reverse. What is simply
 * absent (a file that does not exist, a host with no history kept) says so, and is never "could not be read".
 */

test("/config over a read snapshot: the tab of a file that cannot be read or does not load draws no count, and a file that is not there counts none", async () => {
  const nav = async (over) => {
    const snapshot = { queue: { counts: {} }, hostBudgets: [], ...fileViewsFixture(), ...over };
    const page = String((await renderPage("config", { query: {}, session: { name: "ops", role: "operator" }, data: { now: NOW, snapshot }, theme: null })).html);
    return wordsOf(page.slice(page.indexOf('aria-label="Configuration sections"'), page.indexOf('<span class="config-divider"'))).replace(/^.*?Settings/, "Settings").trim();
  };
  assert.equal(await nav({}), "Settings 2 Triggers 2 Pause windows 1 Scoped limits 1 Projects 1 Files 2 Unset 0 MCP servers 0", "the control: every file read");
  const broken = await nav({ settings: { path: "/srv/deployment/settings.json", invalid: "not JSON" }, triggers: { unreadable: "EACCES" }, pauseWindows: { invalid: "bad zone" }, scopedLimits: { invalid: "newer", newer: true }, projects: { unreadable: true }, overlayMcp: { servers: [], refused: [], unreadable: "EACCES" } });
  assert.equal(broken, "Settings Triggers Pause windows Scoped limits Projects Files 2 Unset 0 MCP servers");
  // A read that showed there is no file, or none configured: none, said as the number it is.
  const absent = await nav({ triggers: { missing: true }, pauseWindows: { missing: true }, scopedLimits: { missing: true }, projects: { unset: true }, settings: { path: "/srv/deployment/settings.json", overlay: {} } });
  assert.equal(absent, "Settings 0 Triggers 0 Pause windows 0 Scoped limits 0 Projects 0 Files 2 Unset 0 MCP servers 0");
  // The MCP card under its tab does not count an overlay it could not read either.
  const card = async (overlayMcp) => wordsOf((await renderPage("config", { query: {}, session: { name: "ops", role: "operator" }, data: { now: NOW, snapshot: { queue: { counts: {} }, hostBudgets: [], ...fileViewsFixture(), overlayMcp } }, theme: null })).html);
  assert.match(await card({ servers: [], refused: [], unreadable: "EACCES" }), /Overlay servers not known: the overlay's MCP file cannot be read \(EACCES\)\. Open Connections/);
  assert.match(await card({ servers: [], refused: [], unreadable: "invalid" }), /Overlay servers not known: the overlay's MCP file does not load\. Open Connections/);
  assert.match(await card({ servers: [], refused: [], unreadable: "unreadable" }), /Overlay servers not known: the overlay's MCP file cannot be read\. Open Connections/);
  for (const u of ["EACCES", "invalid"]) assert.ok(!(await card({ servers: [], refused: [], unreadable: u })).includes("0 overlay servers"), u);
  const mcpRead = await card({ servers: [], refused: [], unreadable: null });
  assert.match(mcpRead, /0 overlay servers\. Open Connections/);
  assert.ok(!mcpRead.includes("not known: the overlay"));
  // The scoped-limits file through its own reader: only a file that is not there is missing, and the card says which.
  const dir = tempDir("pd-962-limits-");
  assert.ok(dir.startsWith(tmpdir()), "a temp folder, checked before anything is written");
  assert.deepEqual(readScopedLimits({ scopedLimitsPath: join(dir, "none.json") }), { missing: true });
  assert.deepEqual(readScopedLimits({ scopedLimitsPath: undefined }), { missing: true });
  mkdirSync(join(dir, "folder.json"));
  const unreadable = readScopedLimits({ scopedLimitsPath: join(dir, "folder.json") });
  assert.deepEqual(unreadable, { unreadable: "EISDIR" });
  assert.equal(await nav({ scopedLimits: unreadable }), "Settings 2 Triggers 2 Pause windows 1 Scoped limits Projects 1 Files 2 Unset 0 MCP servers 0");
  const limitsCard = async (scopedLimits) => wordsOf((await renderPage("config", { query: {}, session: { name: "ops", role: "operator" }, data: { now: NOW, snapshot: { queue: { counts: {} }, hostBudgets: [], ...fileViewsFixture(), scopedLimits } }, theme: null })).html);
  const unreadCard = await limitsCard(unreadable);
  assert.ok(unreadCard.includes("The scoped-limits file cannot be read (EISDIR).") && !unreadCard.includes("The scoped-limits file does not exist."));
  const absentCard = await limitsCard(readScopedLimits({ scopedLimitsPath: join(dir, "none.json") }));
  assert.ok(absentCard.includes("The scoped-limits file does not exist.") && !absentCard.includes("The scoped-limits file cannot be read"));
});

test("/setup over a read snapshot: an unreadable triggers file makes the trigger and forge steps not known; a read file keeps to do and optional", async () => {
  const draw = async (triggers) => {
    const snapshot = { ...setupFixture(), triggers };
    const data = await loadPageData("setup", {}, { now: () => SETUP_AT, deployment: { folder: "pi-dispatch" }, fleet: { snapshot: async () => snapshot }, setup: () => setupAvailable() }, { role: "viewer" });
    return wordsOf((await renderPage("setup", { data, query: {}, session: { name: "watcher", role: "viewer" } })).html);
  };
  const unread = await draw({ unreadable: "EACCES" });
  assert.match(unread, /Not known The triggers file could not be read here \(EACCES\), so this cannot say which triggers it holds\./);
  assert.match(unread, /Not known The triggers file was not read, so nothing here says whether a trigger needs forge credentials\./);
  assert.match(unread, /of 8 ready · 2 not known/);
  for (const said of ["Not yet The triggers file", "Only label, comment, issue and pull request triggers need them"]) assert.ok(!unread.includes(said), said);
  const none = await draw({ triggers: [] });
  assert.match(none, /To do A matching trigger starts a scheduled or forge job/);
  assert.match(none, /Optional Only label, comment, issue and pull request triggers need them/);
  assert.ok(!none.includes("not known") && !none.includes("Not known"), "the control: a file that was read and holds none");
});

test("/triggers with neither a snapshot nor file views: the schedulers are unread, not unpublished", async () => {
  const down = async () => { throw new Error("Valkey does not answer"); };
  let got;
  const data = await loadPageData("triggers", { kind: "all" }, { now: () => NOW, fleet: { snapshot: down }, triggerList: (snapshot) => { got = snapshot; return triggerListOf({ snapshot, now: NOW }); } });
  assert.deepEqual(got, { schedulersUnread: true }, "the list reader is told, so it does not wait on Valkey a second time");
  assert.equal(data.triggerList.schedulersUnread, true);
  const words = wordsOf((await renderPage("triggers", { data, query: { kind: "all" }, session: { name: "ops", role: "operator" } })).html);
  assert.ok(words.includes(SCHEDULERS_UNREAD_NO_RULES_TEXT));
  assert.match(words, /Not known: Valkey could not be read, so no next fire can be shown\./);
  assert.match(words, /Not known: the next fires could not be read\./);
  assert.match(words, /The triggers file is not available; rule facts are unknown\./);
  for (const said of ["No next fire is published", "The rules shown are the triggers file's"]) assert.ok(!words.includes(said), said);
  // The same without a list reader, and with file views that throw.
  for (const fleet of [{ snapshot: down }, { snapshot: down, fileViews: () => { throw new Error("EACCES"); } }]) assert.equal((await loadPageData("triggers", { kind: "all" }, { now: () => NOW, fleet })).triggerList.schedulersUnread, true);
  // The control: a read snapshot that holds no scheduler says none is published.
  const read = await loadPageData("triggers", { kind: "all" }, { now: () => NOW, fleet: { snapshot: async () => ({ ...fileViewsFixture(), schedulers: [] }) } });
  assert.equal(read.triggerList.schedulersUnread, false);
  const readWords = wordsOf((await renderPage("triggers", { data: read, query: { kind: "all" }, session: { name: "ops", role: "operator" } })).html);
  assert.match(readWords, /No next fire is published\./);
  assert.ok(!readWords.includes("Not known: Valkey could not be read"));
});

test("/triggers: a triggers file that does not exist holds no rules, counted 0; one that cannot be read or does not load is not available", async () => {
  const NOT_AVAILABLE = "The triggers file is not available; rule facts are unknown.";
  const list = (triggers) => triggerListOf({ snapshot: { ...fileViewsFixture(), schedulers: [], triggers }, now: NOW });
  const page = async (triggers) => wordsOf((await renderPage("triggers", { data: { now: NOW, triggerList: list(triggers) }, query: { kind: "all" }, session: { name: "ops", role: "operator" } })).html);
  const absent = list({ missing: true });
  assert.deepEqual(absent.counts, { all: 0, schedule: 0, label: 0, comment: 0, pull_request: 0, issue: 0, watch: 0, spent: 0 });
  assert.ok(absent.problems.includes(TRIGGERS_FILE_ABSENT_TEXT) && !absent.problems.includes(NOT_AVAILABLE));
  assert.notEqual(absent.stats, null);
  const absentWords = await page({ missing: true });
  assert.ok(absentWords.includes(TRIGGERS_FILE_ABSENT_TEXT) && !absentWords.includes(NOT_AVAILABLE));
  assert.match(absentWords, /All 0 /);
  for (const unread of [{ unreadable: "EACCES" }, { unreadable: true }, { invalid: "not JSON" }, undefined, null]) {
    const model = list(unread);
    assert.ok(model.problems.includes(NOT_AVAILABLE) && !model.problems.includes(TRIGGERS_FILE_ABSENT_TEXT), JSON.stringify(unread));
    assert.equal(model.counts.all, null, JSON.stringify(unread));
    const words = await page(unread);
    assert.ok(words.includes(NOT_AVAILABLE) && !words.includes(TRIGGERS_FILE_ABSENT_TEXT) && !/All 0 /.test(words), JSON.stringify(unread));
  }
  // A file that is there and holds none says neither.
  const empty = list({ triggers: [] });
  assert.ok(!empty.problems.includes(TRIGGERS_FILE_ABSENT_TEXT) && !empty.problems.includes(NOT_AVAILABLE));
  assert.equal(empty.counts.all, 0);
});

test("quiet windows: a pause-windows file that does not exist holds none; one that cannot be read or does not load could not be read", async () => {
  const dir = tempDir("pd-962-pause-");
  assert.ok(dir.startsWith(tmpdir()), "a temp folder, checked before anything is written");
  assert.deepEqual(readPauseWindows({ pauseWindowsPath: join(dir, "none.json") }), { missing: true });
  for (const none of [undefined, null, ""]) assert.deepEqual(readPauseWindows({ pauseWindowsPath: none }), { missing: true }, "no path is no file, not a read that failed");
  mkdirSync(join(dir, "folder.json"));
  assert.deepEqual(readPauseWindows({ pauseWindowsPath: join(dir, "folder.json") }), { unreadable: "EISDIR" });
  const denied = { readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
  assert.deepEqual(readPauseWindows({ pauseWindowsPath: join(dir, "p.json"), fs: denied }), { unreadable: "EACCES" });
  writeFileSync(join(dir, "bad.json"), "{");
  assert.ok(typeof readPauseWindows({ pauseWindowsPath: join(dir, "bad.json") }).invalid === "string");
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ version: 1, windows: [] }));
  assert.deepEqual(readPauseWindows({ pauseWindowsPath: join(dir, "ok.json") }), { windows: [] });
  // The configuration card's sentence follows the same split.
  assert.equal(fileTrouble({ missing: true }, "pause-windows file"), "The pause-windows file does not exist.");
  assert.equal(fileTrouble({ unreadable: "EISDIR" }, "pause-windows file"), "The pause-windows file cannot be read (EISDIR).");

  const SAID = "Quiet windows could not be read";
  const list = (pauseWindows) => triggerListOf({ snapshot: { ...fileViewsFixture(), schedulers: [], pauseWindows }, now: NOW });
  const page = async (pauseWindows) => wordsOf((await renderPage("triggers", { data: { now: NOW, triggerList: list(pauseWindows) }, query: { kind: "all" }, session: { name: "ops", role: "operator" } })).html);
  for (const absent of [{ missing: true }, { windows: [] }]) {
    const model = list(absent);
    assert.deepEqual([model.week.quietUnknown, model.week.quiet, model.problems.some((p) => p.includes(SAID))], [false, [], false], JSON.stringify(absent));
    assert.ok(!(await page(absent)).includes(SAID), JSON.stringify(absent));
  }
  for (const unread of [{ unreadable: "EACCES" }, { unreadable: true }, { invalid: "bad zone" }, undefined, null]) {
    const model = list(unread);
    assert.deepEqual([model.week.quietUnknown, model.problems.includes("Quiet windows could not be read; bands are unknown.")], [true, true], JSON.stringify(unread));
    assert.ok((await page(unread)).includes("Quiet windows could not be read; no absence of bands proves they are off."), JSON.stringify(unread));
  }
});

test("/fleet/host: no capacity history only where the registry and the mirror answered and name no such host; could not be read of every other report", async () => {
  const snapshot = { queue: {}, hostBudgets: [], doctor: { hosts: [], more: 0 } };
  const window = { fromMs: NOW - 7 * 24 * 3600_000, toMs: NOW, bucketMs: 3600_000 };
  const draw = async (hostCapacity) => wordsOf((await renderPage("host", { query: { name: "build3" }, session: { name: "ops", role: "operator" }, data: { now: NOW, snapshot, hostCapacity }, theme: null })).html);
  const none = await draw({ window, hosts: [], coverage: [], sourcesRead: true });
  assert.ok(none.includes(HOST_CAPACITY_WORDS.none) && !none.includes(HOST_CAPACITY_WORDS.unread));
  const golden = wordsOf(await FLEET_DRAW["host-capacity-missing.operator"]());
  assert.ok(golden.includes(HOST_CAPACITY_WORDS.none) && !golden.includes(HOST_CAPACITY_WORDS.unread));
  for (const unread of [null, undefined, { unreachable: "the capacity report could not be read (timeout)" }, { unreachable: "no report", hosts: [], sourcesRead: true }, { window, sourcesRead: true }, { window, hosts: [], coverage: [] }, { window, hosts: [], coverage: [], sourcesRead: false }, { window, hosts: { length: 0 }, sourcesRead: true }]) {
    const words = await draw(unread);
    assert.ok(words.includes(HOST_CAPACITY_WORDS.unread) && !words.includes(HOST_CAPACITY_WORDS.none), JSON.stringify(unread));
  }
  // Through the page's own load: a reader that throws is a report that was not read.
  const load = async (hostCapacity) => { const data = await loadPageData("host", { name: "build3" }, { now: () => NOW, fleet: { snapshot: async () => snapshot }, hostCapacity }); return wordsOf((await renderPage("host", { query: { name: "build3" }, session: { name: "ops", role: "operator" }, data, theme: null })).html); };
  assert.ok((await load(async () => { throw new Error("down"); })).includes(HOST_CAPACITY_WORDS.unread));
  assert.ok((await load(async () => ({ window, hosts: [], coverage: [], sourcesRead: true }))).includes(HOST_CAPACITY_WORDS.none));
});

test("/fleet/host over the real capacity read: a Valkey that does not answer still gives a report, and that report is not a host with no history", async () => {
  // The reader's own code over a client that never answers, as a frozen Valkey leaves it: it does not answer
  // `{ unreachable }`, it builds the report from this host's files and names no host.
  const logs = tempDir("pd-962-capacity-");
  assert.ok(logs.startsWith(tmpdir()));
  const client = (answer) => () => new Proxy({}, { get: (_, key) => (key === "on" || key === "disconnect" ? () => {} : key === "then" ? undefined : () => answer()) });
  const host = (redisFn) => assembleHostCapacity({ valkeyUrl: "redis://127.0.0.1:1" }, "build3", NOW, { env: { PI_LOGS_DIR: logs }, readCapacityFn: (args) => readCapacity({ ...args, redisFn, timeoutMs: 60 }) });
  const page = async (hostCapacity) => { const data = await loadPageData("host", { name: "build3" }, { now: () => NOW, fleet: { snapshot: async () => ({ queue: {}, hostBudgets: [], doctor: { hosts: [], more: 0 } }) }, hostCapacity: async () => hostCapacity }); return wordsOf((await renderPage("host", { query: { name: "build3" }, session: { name: "ops", role: "operator" }, data, theme: null })).html); };
  const frozen = await host(client(() => new Promise(() => {})));
  assert.deepEqual([frozen.unreachable, frozen.hosts, frozen.sourcesRead], [undefined, [], false], "a report, with no host, that says its sources were not read");
  assert.ok(frozen.coverage.some((line) => /run mirror unreachable \(timeout\)/.test(line) && /host registry unreadable/.test(line)));
  const frozenWords = await page(frozen);
  assert.ok(frozenWords.includes(HOST_CAPACITY_WORDS.unread) && !frozenWords.includes(HOST_CAPACITY_WORDS.none));
  // One of the two unread is enough: the registry answered an empty set, the mirror's index did not answer a list.
  const half = await host(client(() => Promise.resolve(null)));
  assert.equal(half.sourcesRead, false);
  assert.ok((await page(half)).includes(HOST_CAPACITY_WORDS.unread));
  // The control: a Valkey that answers, holding no host and no mirror. The host has no history here.
  const read = await host(client(() => Promise.resolve([])));
  assert.deepEqual([read.hosts, read.sourcesRead], [[], true]);
  const readWords = await page(read);
  assert.ok(readWords.includes(HOST_CAPACITY_WORDS.none) && !readWords.includes(HOST_CAPACITY_WORDS.unread));
  // The reader names what it could not ask; the insights page's view does not carry the mark unless asked.
  assert.deepEqual((await readCapacity({ url: "redis://127.0.0.1:1", env: { PI_LOGS_DIR: logs }, now: () => NOW, redisFn: client(() => new Promise(() => {})), timeoutMs: 60 })).unread, ["registry", "mirror"]);
  assert.deepEqual((await readCapacity({ url: "not a url", env: { PI_LOGS_DIR: logs }, now: () => NOW })).unread, ["registry", "mirror"]);
  assert.ok(!Object.hasOwn(await assembleCapacityView({ valkeyUrl: "redis://127.0.0.1:1" }, "7d", NOW, { env: { PI_LOGS_DIR: logs }, readCapacityFn: (args) => readCapacity({ ...args, redisFn: client(() => Promise.resolve([])), timeoutMs: 60 }) }), "sourcesRead"));
});

test("/runs/sandboxes: New sandbox is not offered where the sandbox report was not read, and is where it was", async () => {
  const button = '<a class="btn" href="/runs/sandboxes#p-sb-new">New sandbox</a>';
  for (const state of ["sandboxes-no-snapshot.operator", "sandboxes-unavailable.operator"]) assert.ok(!(await SANDBOX_DRAW[state]()).includes("New sandbox"), state);
  for (const state of ["sandboxes-populated.operator", "sandboxes-empty.operator"]) assert.ok((await SANDBOX_DRAW[state]()).includes(button), `${state}: the control`);
});
