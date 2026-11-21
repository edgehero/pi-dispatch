import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NOW } from "../../launch/fixture-deployment.mjs";
import { pagePanels, loadPageData, renderPage } from "../src/console/pages.mjs";
import { HOSTS_UNREAD, HOSTS_UNREAD_TEXT } from "../src/console/panels/common.mjs";
import { ACTIVE_PARTIAL_TEXT, ACTIVE_UNREAD_TEXT, DOCTOR_HOSTS_UNREAD_TEXT, HOSTS_LAST_EMPTY_TEXT, QUEUES_UNREAD_TEXT, STALLS_UNREAD } from "../src/console/panels/fleet.mjs";
import { HOST_ACTIVE_UNREAD_TEXT } from "../src/console/panels/host.mjs";
import { dataUnread } from "../src/console/panels/common.mjs";
import { toolActionRequest } from "../src/tool-actions.mjs";
import { HOSTS_EMPTY, REGISTRY_UNREAD_TEXT, RUNNING_EMPTY, RUNNING_UNREAD_TITLE } from "../src/console/panels/overview.mjs";
import { MODELS_WORDS } from "../src/console/panels/models.mjs";
import { modelsViewOf, readModelsView } from "../src/models-view.mjs";
import { FLEET_CARD_SNAPSHOT } from "./helpers/fleet-goldens.mjs";
import { OVERVIEW_CALM, firstRun, overviewSnapshot } from "./helpers/panel-goldens.mjs";
import { consoleModelsFixture } from "./helpers/models-goldens.mjs";

/**
 * An unread value is not an empty one on Fleet, the overview and Models (issue #962), in both directions: a read that
 * failed says "not known", and a read that showed emptiness keeps its true empty sentence. Canned snapshots at a fixed
 * instant; nothing here reads a Valkey.
 */

const OP = { name: "ops", role: "operator" };
/** The words of some markup, tags and the scripts' own text dropped. */
const wordsOf = (markup) => String(markup).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
/** A page's panels over `snapshot`, as words by panel id. */
async function panelsOf(page, snapshot, session = OP) {
  const panels = await pagePanels(page, { query: {}, session, data: { page, now: NOW, env: {}, snapshot }, readOnly: false });
  return Object.fromEntries(panels.map((p) => [p.id, wordsOf(p.html)]));
}
const all = (panels) => Object.values(panels).join(" ");
const snap = FLEET_CARD_SNAPSHOT;
const degraded = { ...snap().queue, fleetDegraded: "registry" };

test("/fleet over a registry that was never read says the hosts could not be read: no 'No host is registered', no count of hosts or beats, no 'no live host'", async () => {
  const p = await panelsOf("fleet", snap({ hostBudgets: [], queue: degraded, hostsReadAt: null, doctor: { unreachable: "registry" } }));
  const text = all(p);
  for (const never of ["No host is registered", "0 beating", "shared by 0 hosts", "no live host", "0 hosts' registry rows", "as it was last seen", HOSTS_LAST_EMPTY_TEXT]) assert.ok(!text.includes(never), never);
  assert.ok(p["p-hosts"].includes(HOSTS_UNREAD_TEXT), p["p-hosts"]);
  assert.ok(p["p-hosts"].includes(HOSTS_UNREAD), "the card's line under its title");
  assert.ok(p["p-queues"].includes(`shared; its hosts are ${HOSTS_UNREAD}`), p["p-queues"]);
  assert.ok(p["p-venues"].includes(HOSTS_UNREAD_TEXT) && p["p-venues"].includes("not known"), "which host blesses a venue is not known");
  assert.ok(p["p-fleetbar"].includes(HOSTS_UNREAD_TEXT) && p["p-fleetbar"].includes("no host's registry row: the hosts could not be read"), p["p-fleetbar"]);
  // Only the shared queue was counted, so the bar's numbers are floors and the queues card says what it leaves out.
  assert.match(p["p-fleetbar"], /at least 2 waiting at least 4 active at least 3 delayed/);
  assert.ok(p["p-queues"].includes(QUEUES_UNREAD_TEXT));
  // The doctor results are read for the hosts the registry names: none listed is not "none published".
  const d = (await panelsOf("fleet", snap({ hostBudgets: [], queue: degraded, hostsReadAt: null, doctor: { hosts: [], more: 0 } })))["p-doctor"];
  assert.ok(d.includes(DOCTOR_HOSTS_UNREAD_TEXT) && !d.includes("No host has published doctor results yet"), d);
});

test("/fleet over a registry that was read and is empty keeps its true empty sentences", async () => {
  const p = await panelsOf("fleet", snap({ hostBudgets: [], doctor: { hosts: [], more: 0 } }));
  assert.ok(p["p-hosts"].includes("No host is registered."), p["p-hosts"]);
  assert.ok(p["p-hosts"].includes("0 beating"));
  assert.ok(p["p-queues"].includes("shared by 0 hosts"));
  assert.ok(p["p-venues"].includes("no live host"));
  assert.ok(p["p-fleetbar"].includes("0 hosts' registry rows"));
  assert.ok(p["p-doctor"].includes("No host has published doctor results yet") && !p["p-doctor"].includes(DOCTOR_HOSTS_UNREAD_TEXT));
  assert.match(p["p-fleetbar"], / 2 waiting 4 active 3 delayed/);
  assert.ok(!all(p).includes("at least") && !p["p-queues"].includes(QUEUES_UNREAD_TEXT), "every queue was read: whole numbers");
  assert.ok(!all(p).includes(HOSTS_UNREAD) && !all(p).includes(HOSTS_UNREAD_TEXT), "nothing here was unread");
});

test("/fleet over a registry read before and not now keeps the rows last seen and says so; a last read that showed no host is said as last read", async () => {
  const kept = await panelsOf("fleet", snap({ queue: degraded, hostsReadAt: NOW - 3_600_000 }));
  assert.ok(kept["p-hosts"].includes(REGISTRY_UNREAD_TEXT) && kept["p-hosts"].includes("build3"), "the rows as last seen");
  assert.ok(!all(kept).includes(HOSTS_UNREAD_TEXT), "not the never-read sentence");
  const none = await panelsOf("fleet", snap({ hostBudgets: [], queue: degraded, hostsReadAt: NOW - 3_600_000 }));
  assert.ok(none["p-hosts"].includes(REGISTRY_UNREAD_TEXT) && none["p-hosts"].includes(HOSTS_LAST_EMPTY_TEXT), none["p-hosts"]);
  assert.ok(!none["p-hosts"].includes("No host is registered."), "never stated as a fact of now");
});

test("/fleet schedules: a stall counter that was not read is not known, never 0 of the cap; one that was read, or a schedule that never stalled, keeps its number", async () => {
  const unread = await panelsOf("fleet", snap({ schedulerStalls: { "nightly-tidy": null, "pm-weekly": 2 } }));
  assert.match(unread["p-schedules"], new RegExp(`nightly-tidy .*? no ${STALLS_UNREAD} `));
  assert.ok(unread["p-schedules"].includes("2 of 3") && !unread["p-schedules"].includes("0 of 3"), unread["p-schedules"]);
  const read = await panelsOf("fleet", snap({ schedulerStalls: { "nightly-tidy": 0 } }));
  assert.equal(read["p-schedules"].split("0 of 3").length - 1, 2, "a read 0, and no key at all: both 0");
  assert.ok(!read["p-schedules"].includes(STALLS_UNREAD));
});

test("/fleet active jobs: a list no queue answered for says running jobs are not known; a read, empty list says Nothing is running; a part read is a floor", async () => {
  const lost = await panelsOf("fleet", snap({ active: [], activeUnreachable: true, hostBudgets: [] }));
  assert.ok(lost["p-active"].includes(ACTIVE_UNREAD_TEXT) && lost["p-active"].includes("running jobs not known"), lost["p-active"]);
  assert.ok(!lost["p-active"].includes("Nothing is running") && !lost["p-active"].includes("0 running"));
  const empty = await panelsOf("fleet", snap({ active: [], activeUnreachable: false, hostBudgets: [] }));
  assert.ok(empty["p-active"].includes("Nothing is running.") && empty["p-active"].includes("0 running"), empty["p-active"]);
  assert.ok(!empty["p-active"].includes(ACTIVE_UNREAD_TEXT));
  const before = await panelsOf("fleet", snap({ active: [], hostBudgets: [] }));
  assert.ok(before["p-active"].includes("Nothing is running."), "a snapshot without the flag reads as it did");
  const part = await panelsOf("fleet", snap({ active: [{ jobId: "gh-e802", queue: "pi-jobs@build3", startedAt: NOW - 60_000, host: "build3", project: "web", progress: null }], activeUnreachable: true, hostBudgets: [] }));
  assert.ok(part["p-active"].includes("at least 1 running") && part["p-active"].includes(ACTIVE_PARTIAL_TEXT) && part["p-active"].includes("gh-e802"), part["p-active"]);
  const whole = await panelsOf("fleet", snap({ active: [{ jobId: "gh-e802", queue: "pi-jobs@build3", startedAt: NOW - 60_000, host: "build3", project: "web", progress: null }], hostBudgets: [] }));
  assert.ok(whole["p-active"].includes("1 running") && !whole["p-active"].includes("at least") && !whole["p-active"].includes(ACTIVE_PARTIAL_TEXT));
});

test("the overview: unread running jobs are not known in Running, the headline and the timeline's notes; a read, empty list says nothing is running", async () => {
  const lost = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, active: [], activeUnreachable: true }));
  assert.match(lost["p-active"], /Running - not known The running jobs could not be read, so what runs is not known\./);
  assert.ok(!all(lost).toLowerCase().includes(RUNNING_EMPTY.title), "nowhere 'nothing is running'");
  assert.ok(lost["p-headline"].toLowerCase().includes(RUNNING_UNREAD_TITLE), lost["p-headline"]);
  assert.ok(lost["p-timeline"].includes("The running jobs could not be read, so runs under way may be missing."), "the timeline says its picture may miss runs");
  const empty = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, active: [], activeUnreachable: false }));
  assert.ok(empty["p-headline"].toLowerCase().includes(RUNNING_EMPTY.title), empty["p-headline"]);
  assert.match(empty["p-active"], /Running 0 /);
  assert.ok(!all(empty).includes("running jobs could not be read") && !all(empty).toLowerCase().includes(RUNNING_UNREAD_TITLE));
  const part = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, active: [{ jobId: "gh-e802", queue: "pi-jobs", startedAt: NOW - 60_000 }], activeUnreachable: true }));
  assert.match(part["p-active"], /Running live 1 or more running Not every queue's running jobs could be read, so more may be running\./);
  assert.ok(part["p-headline"].includes("At least 1 job running") || part["p-headline"].includes("at least 1 job running"), part["p-headline"]);
});

test("the overview over a registry that was never read says the hosts are not known, not 'as it was last seen' and not that none is registered", async () => {
  const never = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, hostBudgets: [], queue: { ...overviewSnapshot().queue, fleetDegraded: "registry" }, hostsReadAt: null }));
  for (const id of ["p-active", "p-hosts"]) {
    assert.ok(never[id].includes(HOSTS_UNREAD_TEXT), never[id]);
    assert.ok(!never[id].includes(REGISTRY_UNREAD_TEXT) && !never[id].includes(HOSTS_EMPTY.body), never[id]);
  }
  const seen = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, queue: { ...overviewSnapshot().queue, fleetDegraded: "registry" }, hostsReadAt: NOW - 60_000 }));
  for (const id of ["p-active", "p-hosts"]) assert.ok(seen[id].includes(REGISTRY_UNREAD_TEXT) && !seen[id].includes(HOSTS_UNREAD_TEXT), seen[id]);
});

// ---- /models ----------------------------------------------------------------------------------------------------------

const READS = { triggers: () => '{"triggers":[]}', projects: () => null, limits: () => null, overlay: () => null, records: () => [] };

test("readModelsView does not read again a snapshot its caller could not read; a caller with none has it read once", async () => {
  let asked = 0;
  const fleet = { snapshot: async () => { asked += 1; throw new Error("Valkey does not answer"); }, runsPage: async () => ({ runs: [], mirror: "unreachable", next: null }) };
  const failed = await readModelsView({ now: NOW, snapshot: null, fleet, reads: READS });
  assert.equal(asked, 0, "null is the caller's failed read: a second one only stacks a second timeout");
  assert.deepEqual([failed.waitingUnread, failed.proposalsUnread, failed.waiting, failed.proposals], [true, true, [], []]);
  const own = await readModelsView({ now: NOW, fleet, reads: READS });
  assert.equal(asked, 1, "no snapshot given: read here, once");
  assert.deepEqual([own.waitingUnread, own.proposalsUnread], [true, true], "and that read failing is unread too");
  const good = await readModelsView({ now: NOW, snapshot: { runs: [], waiting: { rows: [] }, doctor: { hosts: [], more: 0 }, settings: { overlay: {} } }, fleet, reads: READS });
  assert.equal(asked, 1);
  assert.deepEqual([good.waitingUnread, good.proposalsUnread, good.cooldownsUnread], [false, false, false], "a read that showed emptiness");
  const part = await readModelsView({ now: NOW, snapshot: { runs: [], waiting: { unreachable: true }, doctor: { unreachable: "timeout" }, settings: { overlay: {} } }, fleet, reads: READS });
  assert.deepEqual([part.waitingUnread, part.proposalsUnread], [true, true], "a snapshot whose own two reads failed");
  // A comparison built from records alone asked for neither list.
  assert.deepEqual([modelsViewOf({ now: NOW }).waitingUnread, modelsViewOf({ now: NOW }).proposalsUnread, modelsViewOf({ now: NOW, cooldowns: null }).cooldownsUnread], [false, false, true]);
});

test("/models draws its three 'No ...' sentences only over a read that showed emptiness", async () => {
  const draw = async (change, data = {}) => {
    const m = consoleModelsFixture(NOW);
    for (const k of ["cooldowns", "waiting", "proposals"]) m[k] = [];
    change(m);
    return wordsOf((await renderPage("models", { session: { name: "watcher", role: "viewer" }, data: { now: NOW, models: m, ...data }, query: {}, readOnly: false })).html);
  };
  const NONE = ["No configured failover model is cooling down.", "No retained jobs are waiting on model cooldown, model window or subscription quota.", "No model proposals were published by doctor."];
  const empty = await draw(() => {});
  for (const s of NONE) assert.ok(empty.includes(s), s);
  const unread = await draw((m) => { m.cooldownsUnread = true; m.waitingUnread = true; m.proposalsUnread = true; }, { snapshot: null, readFailed: true });
  for (const s of NONE) assert.ok(!unread.includes(s), s);
  for (const s of [MODELS_WORDS.cooldownsUnread, MODELS_WORDS.waitingUnread, MODELS_WORDS.proposalsUnread]) assert.ok(unread.includes(s), s);
  // Each flag is its own list's.
  const one = await draw((m) => { m.waitingUnread = true; });
  assert.ok(one.includes(NONE[0]) && !one.includes(NONE[1]) && one.includes(NONE[2]) && one.includes(MODELS_WORDS.waitingUnread));
  // A list that holds rows draws them whatever the flag says.
  const rows = await draw((m) => { m.waiting = [{ jobId: "gh-77c1", why: "model-cooldown" }]; });
  assert.ok(rows.includes("gh-77c1") && !rows.includes(NONE[1]));
});

test("the models page hands a snapshot it could not read to the view as null, so the view reads no second one", async () => {
  const seen = [];
  const down = async () => { throw new Error("Valkey does not answer"); };
  const data = await loadPageData("models", {}, { now: () => NOW, fleet: { snapshot: down }, modelsView: async (snapshot) => { seen.push(snapshot); return consoleModelsFixture(NOW); } });
  assert.deepEqual([seen, data.snapshot, data.readFailed], [[null], null, true]);
});

test("the console hands the models view the page's snapshot as it is: no default turns a caller with none into one whose read failed", () => {
  // The wiring is one line of the console's start, which no test here boots: null must stay the page's failed read and
  // undefined the caller with no snapshot (the canary sample), which the view then reads for itself.
  const cli = readFileSync(new URL("../src/console/cli.mjs", import.meta.url), "utf8");
  assert.match(cli, /const modelsView = m\.modelsView \? \(snapshot\) => m\.modelsView\.readModelsView\(\{[^}]*\bsnapshot, fleet\b/);
  assert.match(cli, /\(await modelsView\?\.\(\)\)\?\.canaries/, "the canary sample gives none");
});

test("the overview's empty timeline and the first run's preview say nothing is running only of an active list that was read", async () => {
  const quiet = (over) => overviewSnapshot({ ...OVERVIEW_CALM, runsDay: { runs: [], floor: false, partial: false }, runs: [], parked: [], hostBudgets: overviewSnapshot().hostBudgets.map((h) => ({ ...h, jobs: [] })), waiting: { at: NOW, rows: [], scheduled: [], byBucket: {}, byQueue: [], truncated: false }, active: [], ...over });
  const NONE = "No run in this window, and nothing in line.";
  assert.ok((await panelsOf("overview", quiet({})))["p-timeline"].includes(NONE), "read whole, and empty");
  const lost = (await panelsOf("overview", quiet({ activeUnreachable: true })))["p-timeline"];
  assert.ok(!lost.includes(NONE) && lost.includes("The running jobs could not be read, so runs under way may be missing."), lost);
  // The first run's preview of the panels: Running's line.
  const first = (over) => panelsOf("overview", { ...firstRun(), active: [], ...over });
  const preview = (p) => all(p).slice(all(p).indexOf("The Overview, once it runs"));
  assert.match(preview(await first({})), /Running nothing is running/);
  assert.match(preview(await first({ activeUnreachable: true })), /Running could not be read/);
  const one = [{ jobId: "gh-e802", queue: "pi-jobs", startedAt: NOW - 60_000 }];
  assert.match(preview(await first({ active: one })), /Running 1 job running/);
  assert.match(preview(await first({ active: one, activeUnreachable: true })), /Running at least 1 job running/);
});

test("dataUnread: a failed read, or a snapshot read with the registry, the active jobs or the parked runs missing; nothing else", () => {
  for (const data of [{ readFailed: true, snapshot: null }, { snapshot: { activeUnreachable: true } }, { snapshot: { parkedUnreachable: "timeout" } }, { snapshot: { queue: { fleetDegraded: "registry" }, hostsReadAt: null } }, { snapshot: { queue: { fleetDegraded: "registry" }, hostsReadAt: NOW } }]) assert.equal(dataUnread(data), true, JSON.stringify(data));
  for (const data of [null, undefined, {}, { parkedCount: 2 }, { snapshot: {} }, { snapshot: snap() }, { snapshot: { activeUnreachable: false, parkedUnreachable: null, queue: { fleetDegraded: null } } }]) assert.equal(dataUnread(data), false, JSON.stringify(data));
});

test("the host page says when the running jobs could not be read, beside what it did read; a read list says nothing of it", async () => {
  const host = async (over) => (await pagePanels("host", { query: { name: "build3" }, session: OP, data: { page: "host", now: NOW, env: {}, snapshot: snap({ active: [], ...over }) }, readOnly: false })).map((p) => wordsOf(p.html)).join(" ");
  assert.ok((await host({ activeUnreachable: true })).includes(HOST_ACTIVE_UNREAD_TEXT));
  assert.ok(!(await host({ activeUnreachable: false })).includes(HOST_ACTIVE_UNREAD_TEXT));
  assert.ok(!(await host({})).includes(HOST_ACTIVE_UNREAD_TEXT));
});

test("dispatch_cancel plans no cancel of a queued job while the running jobs could not be read; a job it did read is planned as before", async () => {
  const fleet = (over) => ({ snapshot: async () => ({ active: [{ jobId: "gh-run" }], held: { rows: [{ jobId: "gh-held" }] }, ...over }) });
  await assert.rejects(() => toolActionRequest("dispatch_cancel", { jobId: "gh-other" }, { fleet: fleet({ activeUnreachable: true }) }), /the running jobs could not be read, so whether this job is running is not known/);
  assert.equal((await toolActionRequest("dispatch_cancel", { jobId: "gh-run" }, { fleet: fleet({ activeUnreachable: true }) })).action, "cancel-active");
  assert.equal((await toolActionRequest("dispatch_cancel", { jobId: "gh-held" }, { fleet: fleet({ activeUnreachable: true }) })).action, "cancel-held");
  assert.equal((await toolActionRequest("dispatch_cancel", { jobId: "gh-other" }, { fleet: fleet({ activeUnreachable: false }) })).action, "cancel-queued");
  assert.equal((await toolActionRequest("dispatch_cancel", { jobId: "gh-other" }, { fleet: fleet({}) })).action, "cancel-queued");
});
