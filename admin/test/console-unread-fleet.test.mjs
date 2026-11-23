import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NOW } from "../../launch/fixture-deployment.mjs";
import { PAGES, pagePanels, loadPageData, renderPage } from "../src/console/pages.mjs";
import { HOSTS_UNREAD, HOSTS_UNREAD_TEXT, NO_BEAT_READ, REGISTRY_PART_TEXT, beatFresh, hostsUnread } from "../src/console/panels/common.mjs";
import { ACTIVE_PARTIAL_TEXT, ACTIVE_UNREAD_TEXT, DOCTOR_HOSTS_UNREAD_TEXT, HOSTS_LAST_EMPTY_TEXT, HOSTS_PART_EMPTY_TEXT, QUEUES_UNREAD_TEXT, STALLS_UNREAD } from "../src/console/panels/fleet.mjs";
import { beatAgeOf, firstRunState } from "../src/doctor-view.mjs";
import { stateOf } from "../src/console/live.mjs";
import { runHost } from "../src/console/panels/run.mjs";
import { LAST_SEEN_WORDS } from "../src/console/panels/overview.mjs";
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

// Issue #1062: a registry that answered with some hosts' rows not read in time was read in part. Its rows that answered
// are drawn and dated by that read (`hostsReadAt`); no surface says the registry or the hosts could not be read.
const partQueue = (over = {}) => ({ ...snap().queue, fleetDegraded: "1 of 4 host rows not read", registryReadInPart: true, ...over });
const COULD_NOT = [REGISTRY_UNREAD_TEXT, HOSTS_UNREAD_TEXT, HOSTS_UNREAD, "The host registry could not be read", "Registry not read"];

test("the pages' sentence for a registry read in part promises nothing about waiting: a row Valkey answers with an error is not read on the next try either (#1036)", () => {
  assert.doesNotMatch(REGISTRY_PART_TEXT, /in time|try again|once Valkey answers|did not answer/);
  assert.match(REGISTRY_PART_TEXT, /^The host registry was read in part: some hosts' rows were not read, /);
});

test("/fleet and the overview over a registry read in part say so, draw the rows that were read, and never say it could not be read (#1062)", async () => {
  const fleet = await panelsOf("fleet", snap({ queue: partQueue(), hostsReadAt: NOW - 1_000 }));
  assert.ok(fleet["p-hosts"].includes(REGISTRY_PART_TEXT) && fleet["p-hosts"].includes("build3"), fleet["p-hosts"]);
  assert.ok(fleet["p-fleetbar"].includes("Registry read in part") && fleet["p-fleetbar"].includes(REGISTRY_PART_TEXT), fleet["p-fleetbar"]);
  for (const never of COULD_NOT) assert.ok(!all(fleet).includes(never), never);
  // No row answered: said as such, never "No host was registered" nor "No host is registered".
  const empty = await panelsOf("fleet", snap({ hostBudgets: [], queue: partQueue(), hostsReadAt: NOW - 1_000 }));
  assert.ok(empty["p-hosts"].includes(HOSTS_PART_EMPTY_TEXT), empty["p-hosts"]);
  for (const never of [HOSTS_LAST_EMPTY_TEXT, "No host is registered", ...COULD_NOT]) assert.ok(!empty["p-hosts"].includes(never), never);
  const overview = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, queue: { ...overviewSnapshot().queue, fleetDegraded: "1 of 4 host rows not read", registryReadInPart: true }, hostsReadAt: NOW - 1_000 }));
  for (const id of ["p-active", "p-hosts"]) assert.ok(overview[id].includes(REGISTRY_PART_TEXT), overview[id]);
  assert.match(all(overview), /The host registry was read in part(, so| and the queue sees no worker connected, so) failing doctors are not counted/);
  for (const never of COULD_NOT) assert.ok(!all(overview).includes(never), never);
});

test("hostsUnread is false over a registry read in part, even with no hostsReadAt: its rows were read (#1062)", () => {
  assert.equal(hostsUnread({ queue: { fleetDegraded: "1 of 2 host rows not read", registryReadInPart: true }, hostsReadAt: null }), false);
  assert.equal(hostsUnread({ queue: { fleetDegraded: "ECONNREFUSED" }, hostsReadAt: null }), true, "one never read stays unread");
});

test("the host page and the first run's worker step over a registry read in part: a row it read is as read now, one it did not is said so (#1062)", async () => {
  const host = async (name, snapshot) => (await pagePanels("host", { query: { name }, session: OP, data: { page: "host", now: NOW, env: {}, snapshot }, readOnly: false })).map((p) => wordsOf(p.html)).join(" ");
  const read = await host("build3", snap({ queue: partQueue(), hostsReadAt: NOW - 1_000 }));
  for (const never of [REGISTRY_PART_TEXT, ...COULD_NOT]) assert.ok(!read.includes(never), never);
  const notRead = await host("build3", snap({ queue: partQueue(), hostsReadAt: NOW - 1_000, hostBudgets: snap().hostBudgets.map((h) => (h.name === "build3" ? { ...h, notRead: true } : h)) }));
  assert.ok(notRead.includes(REGISTRY_PART_TEXT), notRead);
  const absent = await host("hostz", snap({ queue: partQueue(), hostsReadAt: NOW - 1_000 }));
  assert.ok(absent.includes(REGISTRY_PART_TEXT) && !absent.includes("This host has no live registry row"), absent);
  for (const never of COULD_NOT) assert.ok(!absent.includes(never), never);
  // A row read now that beats says a worker runs; with only kept rows, whether one does is not known, read in part.
  const beat = (h) => ({ ...h, ttlAgeMs: 5_000 });
  const worker = (hostBudgets) => firstRunState(snap({ queue: partQueue(), hostsReadAt: NOW - 1_000, hostBudgets }), { session: { role: "operator" } }).steps.find((s) => s.id === "worker");
  assert.equal(worker(snap().hostBudgets.map(beat)).state, "ready");
  const kept = worker(snap().hostBudgets.map((h) => ({ ...beat(h), notRead: true })));
  assert.deepEqual([kept.state, kept.sentence], ["check", ["The host registry was read in part, so whether a worker runs is not known."]]);
});

test("over a registry read in part a row it did not read is not counted, dated or drawn as current, and a row it read is (#1062)", async () => {
  const notRead = (rows, name) => rows.map((h) => (h.name === name ? { ...h, notRead: true } : h));
  // /fleet: the bar's beats and the hosts card's count are floors over the rows read; wholly unread stays "unknown".
  const rows = notRead(snap().hostBudgets, "build3");
  const fleet = await panelsOf("fleet", snap({ queue: partQueue(), hostsReadAt: NOW - 1_000, hostBudgets: rows }));
  const beating = rows.filter((h) => { const age = beatAgeOf(h); return age !== null && age <= 60_000; }).length;
  assert.ok(beating < snap().hostBudgets.filter((h) => { const age = beatAgeOf(h); return age !== null && age <= 60_000; }).length, "the kept row is not counted (vacuous otherwise)");
  assert.match(fleet["p-fleetbar"], new RegExp(`at least ${beating} ${beating === 1 ? "host beats" : "hosts beat"}`), fleet["p-fleetbar"]);
  assert.ok(fleet["p-hosts"].includes(`at least ${beating} beating`), fleet["p-hosts"]);
  // A row it read draws its slots, its jobs known; only the row it did not read has them not known.
  assert.equal(fleet["p-hosts"].split("Free slots not known").length - 1, 1, fleet["p-hosts"]);
  const unread = await panelsOf("fleet", snap({ queue: degraded, hostsReadAt: NOW - 3_600_000 }));
  assert.equal(unread["p-hosts"].split("Free slots not known").length - 1, snap().hostBudgets.length, "wholly unread: no row's slots are known");
  // A floor of 0 is said as no beat read, never "at least 0".
  const noBeat = await panelsOf("fleet", snap({ queue: partQueue(), hostsReadAt: NOW - 1_000, hostBudgets: rows.map((h) => ({ ...h, ttlAgeMs: undefined, beatAt: undefined, staleMs: 600_000 })) }));
  assert.match(noBeat["p-fleetbar"], new RegExp(`${NO_BEAT_READ}, \\d+ queues? accepts? jobs`), noBeat["p-fleetbar"]);
  assert.match(noBeat["p-hosts"], new RegExp(`Hosts ${NO_BEAT_READ}, `), noBeat["p-hosts"]);
  assert.doesNotMatch(noBeat["p-fleetbar"] + noBeat["p-hosts"], /at least 0/);
  assert.match(unread["p-fleetbar"], /unknown hosts beat/);
  // The overview: the row read is current (its beat's age and its slots), the row not read is "as last seen".
  const lastSeenCount = (text) => text.split(LAST_SEEN_WORDS).length - 1;
  const base = overviewSnapshot({ ...OVERVIEW_CALM });
  const partRows = notRead(base.hostBudgets, "build3");
  const part = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, queue: { ...base.queue, fleetDegraded: "1 of 2 host rows not read", registryReadInPart: true }, hostsReadAt: NOW - 1_000, hostBudgets: partRows }));
  assert.equal(lastSeenCount(part["p-hosts"]), 1, part["p-hosts"]);
  assert.match(part["p-hosts"], new RegExp(`at least ${partRows.filter((h) => beatFresh(h)).length} beating`));
  assert.match(part["p-hosts"], /build3 \S+ as last seen/, "the row not read is as last seen");
  assert.match(part["p-hosts"], /mini1 \S+ \d+s /, "the row read is drawn with its beat's age");
  // The Running card: the row read draws its free slots, the row not read is as last seen.
  assert.match(part["p-active"], /build3 as last seen mini1 \d+ free/, part["p-active"]);
  // No row read beats and the queue sees no worker: whether one is online is not known, never judged on "at least 0".
  const silent = partRows.map((h) => ({ ...h, ttlAgeMs: undefined, beatAt: undefined, staleMs: 600_000 }));
  const quiet = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, queue: { ...base.queue, workers: 0, fleetDegraded: "1 of 2 host rows not read", registryReadInPart: true }, hostsReadAt: NOW - 1_000, hostBudgets: silent }));
  assert.ok(quiet["p-hosts"].includes(`Hosts ${NO_BEAT_READ}`) && !quiet["p-hosts"].includes("at least 0"), quiet["p-hosts"]);
  assert.ok(quiet["p-needs"].includes("The host registry was read in part and the queue sees no worker connected, so failing doctors are not counted and whether a worker is online is not known."), quiet["p-needs"]);
  const whole = await panelsOf("overview", overviewSnapshot({ ...OVERVIEW_CALM, queue: { ...base.queue, fleetDegraded: "registry" }, hostsReadAt: NOW - 60_000 }));
  assert.ok(lastSeenCount(whole["p-hosts"]) > base.hostBudgets.length, "wholly unread: every row and the head are as last seen");
  assert.doesNotMatch(whole["p-hosts"], /mini1 \S+ \d+s /, "and no row is drawn with a beat of now");
  // dispatch_hosts' and the state API's age, the host page and the run page's heartbeat: none from a row not read.
  const state = stateOf(snap({ queue: partQueue(), hostsReadAt: NOW - 1_000, hostBudgets: rows }), "operator", { now: NOW });
  assert.equal(state.hosts.find((h) => h.name === "build3").lastBeatAgeMs, null);
  assert.notEqual(state.hosts.find((h) => h.name !== "build3").lastBeatAgeMs, null);
  const host = (await pagePanels("host", { query: { name: "build3" }, session: OP, data: { page: "host", now: NOW, env: {}, snapshot: snap({ queue: partQueue(), hostsReadAt: NOW - 1_000, hostBudgets: rows }) }, readOnly: false })).map((p) => wordsOf(p.html)).join(" ");
  assert.ok(host.includes("Row not read this time") && host.includes("Last beat not read this time: the host registry was read in part.") && !/Stale|Heartbeat late/.test(host), host);
  const record = { jobId: "gh-1062", kind: "github", target: "acme/api#1", outcome: "policy", reason: "backend-floor", host: "build3", backend: "podman", budgetReserved: false, tokens: null, exitCode: null, startedAt: new Date(NOW - 60_000).toISOString(), endedAt: new Date(NOW - 30_000).toISOString() };
  const run = wordsOf(runHost({ data: { run: { record }, snapshot: snap({ queue: partQueue(), hostsReadAt: NOW - 1_000, hostBudgets: rows }) }, role: "operator", env: {}, query: { id: "gh-1062" }, now: NOW, readOnly: false }));
  assert.ok(run.includes("Heartbeat not read this time: the host registry was read in part") && !run.includes("could not be read"), run);
});

test("the host page's headline over a registry read in part says the host is not known, never that it has no row (#1062)", async () => {
  const page = async (snapshot) => wordsOf((await renderPage("host", { query: { name: "hostz" }, session: OP, data: { page: "host", now: NOW, env: {}, snapshot }, readOnly: false, theme: null, maxStreams: 4 })).html);
  const part = await page(snap({ queue: partQueue(), hostsReadAt: NOW - 1_000 }));
  assert.ok(part.includes("Not known: the host registry was read in part, so nothing here says whether hostz is live."), part.slice(0, 800));
  assert.ok(!part.includes("No live registry row for hostz"));
  assert.ok((await page(snap())).includes("No live registry row for hostz."), "a whole read says so");
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
  // The page's deadline rides beside it (issue #988), with no default either: a caller with none leaves each read its bound.
  assert.match(cli, /const modelsView = m\.modelsView \? \(snapshot, \{ within \} = \{\}\) => m\.modelsView\.readModelsView\(\{[^}]*\bsnapshot, fleet\b[^}]*\bwithin \}\)/);
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

test("dataUnread: a failed read, or a snapshot read with the registry, the active jobs or the parked runs missing; nothing else on a page with no reads of its own", () => {
  for (const data of [{ readFailed: true, snapshot: null }, { snapshot: { activeUnreachable: true } }, { snapshot: { parkedUnreachable: "timeout" } }, { snapshot: { queue: { fleetDegraded: "registry" }, hostsReadAt: null } }, { snapshot: { queue: { fleetDegraded: "registry" }, hostsReadAt: NOW } }]) assert.equal(dataUnread(data), true, JSON.stringify(data));
  for (const data of [null, undefined, {}, { parkedCount: 2 }, { snapshot: {} }, { snapshot: snap() }, { snapshot: { activeUnreachable: false, parkedUnreachable: null, queue: { fleetDegraded: null } } }]) assert.equal(dataUnread(data), false, JSON.stringify(data));
});

/**
 * The pill's marks by page (issue #988), each in the shape its reader gives it (console-pill.test.mjs holds every one
 * to the real readers and to the sentence a panel then draws): `[what, the mark over a page that is otherwise read]`.
 */
const SNAP = Object.freeze({ queue: { fleetDegraded: null }, failures24h: 0, waiting: { rows: [] }, failed: { rows: [], more: 0 }, doctor: { hosts: [], more: 0 }, settings: { path: "settings.json", overlay: {} }, triggers: { triggers: [] }, parked: [] });
const READ = Object.freeze({
  overview: { snapshot: SNAP },
  fleet: { snapshot: SNAP },
  setup: { snapshot: SNAP },
  parked: { snapshot: SNAP, answerer: { state: "ok", partial: false, rows: [] }, parkedChecks: {} },
  runs: { runsPage: { runs: [], next: null, mirror: "ok", truncated: false, examined: 0 }, runsWindow: { partial: false, floor: false } },
  run: { run: { record: { jobId: "gh-1", outcome: "completed" }, source: "local" }, transcript: { exists: false }, progress: { missing: true }, inbox: { found: false }, chat: { mode: "fork", says: null }, children: [], childrenIncomplete: false, hostLoads: { hosts: [], more: 0 }, workspace: { shell: null, sessionsUnknown: false, unknown: true } },
  sandboxes: { sandboxes: { hosts: [], sessions: [], sessionsUnavailable: false, noticesUnavailable: false }, browserGateways: { enabledHosts: [], sessions: [] }, hostLoads: { hosts: [], more: 0 } },
  host: { snapshot: { queue: { fleetDegraded: null }, waiting: { rows: [] }, doctor: { hosts: [] } }, host: null, hostHistory: { runs: [], records: [], mirror: "off" } },
});
const REFUSED_RECORD = { jobId: "gh-2", outcome: "policy", reason: "job-image-missing", tokens: null, exitCode: null, budgetReserved: false };
const PARKED_UNKNOWN = "This run asked a question, but whether it still waits for an answer cannot be told right now (the run history or the queue could not be read); try again.";
/** Sandboxes opened for a kept workspace the report holds a row for: the card that says what its run loaded is that row's. */
const KEPT = { sandboxPicked: { id: "gh-1", host: null }, sandboxes: { hosts: [{ name: "build3", rows: [{ id: "gh-1" }] }], sessions: [], sessionsUnavailable: false, noticesUnavailable: false } };
/** A run that reported what it loaded, which its page holds against the hosts' doctor runs. */
const LOADED_RECORD = { jobId: "gh-1", outcome: "completed", loaded: { runner: "reported", at: "end", sources: [] } };
const PARKED_ROW = { jobId: "gh-3", kind: "github", target: "acme/web#14" };
const MARKS = Object.freeze({
  overview: [
    ["the waiting jobs", { snapshot: { ...SNAP, waiting: { unreachable: true } } }],
    ["the failed jobs", { snapshot: { ...SNAP, failed: { unreachable: "Command timed out" } } }],
    ["the doctor results", { snapshot: { ...SNAP, doctor: { unreachable: "the doctor results could not be read" } } }],
    ["a settings overlay nobody could read", { snapshot: { ...SNAP, settings: { path: "settings.json", invalid: "settings file unreadable (EACCES)" } } }],
    ["a settings overlay that does not load, which the Caps card words the same", { snapshot: { ...SNAP, settings: { path: "settings.json", invalid: "settings file is not valid JSON" } } }],
    ["no view of the settings overlay", { snapshot: { ...SNAP, settings: null } }],
    ["the day's failures, as the reader answers a fold that failed", { snapshot: { ...SNAP, failures24h: null } }],
    ["the day's runs, of a fold that failed", { snapshot: { ...SNAP, runsDay: null } }],
    ["the day's runs, folded without a side of the history (what an agent's copy of the data keeps of a mirror that did not answer)", { snapshot: { ...SNAP, runsDay: { runs: [], partial: true } } }],
    ["the spend per hour, of a fold that failed", { snapshot: { ...SNAP, spendByHour: null } }],
  ],
  fleet: [
    ["the waiting jobs", { snapshot: { ...SNAP, waiting: { unreachable: true } } }],
    ["the failed jobs", { snapshot: { ...SNAP, failed: { unreachable: "Command timed out" } } }],
    ["the doctor results", { snapshot: { ...SNAP, doctor: { unreachable: "the doctor results could not be read" } } }],
  ],
  setup: [
    ["the doctor results", { snapshot: { ...SNAP, doctor: { unreachable: "the doctor results could not be read" } } }],
    ["a triggers file nobody could read", { snapshot: { ...SNAP, triggers: { unreadable: "EACCES" } } }],
  ],
  parked: [
    ["the answer rules' results", { answerer: { state: "unavailable", partial: true, rows: [] } }],
    ["a triggers file the answer rules could not take", { answerer: { state: "configuration-unavailable", partial: true, rows: [], rules: [] } }],
    ["the planner's check of a question", { parkedChecks: { "gh-3": { unreachable: true } } }],
    ["a question whose pending answer the scan could not reach", { snapshot: { ...SNAP, parked: [{ ...PARKED_ROW, pendingScan: { unreachable: true } }] } }],
    ["a question whose pending answer a partial scan did not find", { snapshot: { ...SNAP, parked: [{ ...PARKED_ROW, pendingScan: { unknown: true, tooMany: false } }] } }],
  ],
  runs: [
    ["this host's run files unread", { runsPage: { ...READ.runs.runsPage, unreachable: "EACCES", mirror: "off" } }],
    ["a mirror that is on and did not answer", { runsPage: { ...READ.runs.runsPage, mirror: "unreachable (Command timed out)" } }],
    ["the same in an agent's copy of the data", { runsPage: { ...READ.runs.runsPage, mirror: "unreachable" } }],
    ["no window of the day", { runsWindow: null }],
    ["a window folded without a side of the history", { runsWindow: { partial: true, floor: false } }],
  ],
  run: [
    ["the record", { run: { unreadable: "the fleet's run mirror could not be read" } }],
    ["the transcript's state", { transcript: { unreachable: "the transcript could not be read", exists: false } }],
    ["the progress of a run with no record", { run: { missing: true }, progress: { unreachable: true } }],
    ["the inbox", { inbox: { unreachable: true } }],
    ["an inbox's messages", { inbox: { found: true, steer: true, state: "active", open: true, entries: null } }],
    ["whether an inbox takes a message", { inbox: { found: true, steer: true, state: "active", open: null, entries: [] } }],
    ["the chat facts", { chat: { unreachable: true } }],
    ["a chat that cannot tell whether its question waits", { chat: { mode: null, says: PARKED_UNKNOWN } }],
    ["the planner's check of a reply", { chatAnswer: { unreachable: true } }],
    ["the search for child runs", { childrenIncomplete: true }],
    ["the open shells behind the Workspace row, as the sandbox service answers a read that failed", { workspace: { shell: null, sessionsUnknown: true, sessionsUnread: true, sessionsMore: 0, sessionsUnreadable: 0, unknown: true } }],
    ["the open shells, as the page's catch keeps them", { workspace: { unknown: true, sessionsUnknown: true, sessionsUnread: true, sessionsMore: 0, sessionsUnreadable: 0 } }],
    ["the open shells, of a list that says only that it is not whole", { workspace: { shell: null, sessionsUnknown: true, unknown: true } }],
    ["the browser sessions behind the Workspace row", { browserGateways: { enabledHosts: ["build3"], sessions: [], partial: true, unread: true, more: 0, unreadable: 0 } }],
    ["the browser sessions, of a view that says only that it is partial", { browserGateways: { enabledHosts: ["build3"], sessions: [], partial: true } }],
    ["the open shells unread beside a browser list that is cut", { workspace: { shell: null, sessionsUnknown: true, sessionsUnread: true, sessionsMore: 0, sessionsUnreadable: 0 }, browserGateways: { enabledHosts: [], sessions: [], partial: true, unread: false, more: 3, unreadable: 0 } }],
    ["a refused run's inbox", { run: { record: REFUSED_RECORD, source: "local" }, snapshot: SNAP, runsWindow: { partial: false }, inbox: { unreachable: true } }],
    ["a refused run's snapshot", { run: { record: REFUSED_RECORD, source: "local" }, snapshot: null, runsWindow: { partial: false } }],
    ["a refused run's window", { run: { record: REFUSED_RECORD, source: "local" }, snapshot: { queue: { fleetDegraded: null } }, runsWindow: null }],
    ["a refused run's window, folded without a side of the history", { run: { record: REFUSED_RECORD, source: "local" }, snapshot: { queue: { fleetDegraded: null } }, runsWindow: { partial: true } }],
    ["a refused run's doctor results", { run: { record: REFUSED_RECORD, source: "local" }, snapshot: { queue: { fleetDegraded: null }, doctor: { unreachable: "the doctor results could not be read" } }, runsWindow: { partial: false } }],
  ],
  sandboxes: [
    ["the open shells", { sandboxes: { ...READ.sandboxes.sandboxes, sessionsUnavailable: true } }],
    ["the cleanup notices, as their reader answers a read that failed", { sandboxes: { ...READ.sandboxes.sandboxes, noticesUnavailable: true, noticesUnread: true, noticesMore: false, noticesUnreadable: false } }],
    ["the cleanup notices, of a report that says only that they are not whole", { sandboxes: { ...READ.sandboxes.sandboxes, noticesUnavailable: true } }],
    ["the record of the run the kept workspace the page was opened for came from", { ...KEPT, sandboxRunUnread: true }],
    ["the hosts' doctor runs, behind the card of a sandbox being prepared", { sandboxes: { ...READ.sandboxes.sandboxes, plan: { host: "build3" } }, hostLoads: { unreachable: true, hosts: [], more: 0 } }],
    ["the hosts' doctor runs, as the page's catch keeps them", { sandboxes: { ...READ.sandboxes.sandboxes, plan: { host: "build3" } }, hostLoads: null, hostLoadsUnread: true }],
    ["the deployment's configuration", { sandboxes: { ...READ.sandboxes.sandboxes, options: [], refusal: "The triggers, projects or scoped limits could not be read. Fix the deployment configuration before preparing a sandbox." } }],
    ["the browser terminals, as the gateway answers a read of its own that failed", { browserGateways: { enabledHosts: [], sessions: [], drivers: [], partial: true, unread: true, problem: "Browser-terminal authorization could not be read. No attachment was authorized; retry from Sandboxes." } }],
    ["the browser terminals", { browserGateways: { enabledHosts: [], sessions: [], problem: "Browser-terminal information could not be read. Use the native terminal route." } }],
  ],
  host: [
    ["the run records of a host with no row: none read", { hostHistory: null }],
    ["the run records of a host with no row: a mirror that did not answer", { hostHistory: { runs: [], records: [], mirror: "unreachable (Command timed out)" } }],
    ["the waiting jobs", { snapshot: { ...READ.host.snapshot, waiting: { unreachable: true } } }],
    ["the doctor results", { snapshot: { ...READ.host.snapshot, doctor: { unreachable: "the doctor results could not be read" } } }],
  ],
});

test("dataUnread, by page: each read a page makes beside its snapshot marks the pill when it failed, and none does while it answered", () => {
  for (const [page, marks] of Object.entries(MARKS)) {
    assert.equal(dataUnread({ page, ...READ[page] }), false, `${page}: every read answered`);
    for (const [what, mark] of marks) {
      assert.equal(dataUnread({ page, ...READ[page], ...mark }), true, `${page}: ${what}`);
      // The shell names the page it draws, for data that names none; the same data on no page at all marks nothing.
      assert.equal(dataUnread({ ...READ[page], ...mark }, page), true, `${page}: ${what}, the page named by the shell`);
      assert.equal(dataUnread({ ...READ[page], ...mark }), false, `${page}: ${what}, on no page at all`);
    }
  }
  // What answered and is not unread, where a careless rule would say so.
  const live = [
    // A full list, or one with a registration that does not parse, is read (issue #988): it said "could not be read".
    ["run", { workspace: { shell: null, sessionsUnknown: true, sessionsUnread: false, sessionsMore: 1, sessionsUnreadable: 0 } }, "more open shells than the list holds"],
    ["run", { workspace: { shell: null, sessionsUnknown: true, sessionsUnread: false, sessionsMore: 0, sessionsUnreadable: 1 } }, "an open shell's registration that does not parse"],
    ["run", { browserGateways: { enabledHosts: ["build3"], sessions: [], partial: true, unread: false, more: 1, unreadable: 0 } }, "more browser sessions than the view holds"],
    ["sandboxes", { sandboxes: { ...READ.sandboxes.sandboxes, noticesUnavailable: true, noticesUnread: false, noticesMore: true, noticesUnreadable: false } }, "more cleanup notices than the list holds"],
    ["sandboxes", { sandboxes: { ...READ.sandboxes.sandboxes, noticesUnavailable: true, noticesUnread: false, noticesMore: false, noticesUnreadable: true } }, "a cleanup notice that does not parse"],
    // What no card of the page draws is not the page's to mark.
    ["sandboxes", { sandboxRunUnread: true, sandboxPicked: { id: "gh-far", host: null } }, "the record of a run no kept workspace is of"],
    ["sandboxes", { ...KEPT, sandboxPicked: { id: "gh-1", host: "build7" }, sandboxRunUnread: true }, "a workspace kept on another host than the one the page names"],
    ["sandboxes", { hostLoads: { unreachable: true, hosts: [], more: 0 } }, "the hosts' doctor runs on a page that prepares no sandbox"],
    ["sandboxes", { ...KEPT, hostLoads: { unreachable: true, hosts: [], more: 0 } }, "the hosts' doctor runs beside a kept workspace's card, which says the same of pi with them read and unread"],
    // An agent's copy of the data holds a mirror that answered as "bounded".
    ["runs", { runsPage: { ...READ.runs.runsPage, mirror: "bounded" } }, "an agent's copy of a mirror that answered"],
    ["host", { hostHistory: { runs: [], records: [], mirror: "bounded" } }, "the same, on the page of a host no record names"],
    ["overview", { snapshot: { ...SNAP, settings: { path: "settings.json", overlay: {} } } }, "a settings file that does not exist: an empty overlay, read"],
    ["overview", { snapshot: { queue: { fleetDegraded: null } } }, "a snapshot that was asked for none of these parts"],
    ["overview", { snapshot: { ...SNAP, runsDay: { runs: [], partial: false }, spendByHour: { hours: [], partial: true, floor: true } } }, "a day read whole, and hours that may be short, which its card says in other words"],
    ["fleet", { snapshot: { ...SNAP, failures24h: null, runsDay: null, spendByHour: null } }, "the day's fold, which Fleet does not draw"],
    ["fleet", { snapshot: { ...SNAP, settings: { path: "settings.json", invalid: "settings file is not valid JSON" } } }, "a settings overlay Fleet does not draw"],
    ["setup", { snapshot: { ...SNAP, triggers: { invalid: "triggers file is not valid JSON" } } }, "a triggers file that does not load: read, and said so"],
    ["setup", { snapshot: { ...SNAP, triggers: { missing: true } } }, "a triggers file that does not exist"],
    ["setup", { snapshot: { ...SNAP, waiting: { unreachable: true }, failed: { unreachable: true } } }, "the waiting and the failed jobs, which the setup page does not draw"],
    ["parked", { snapshot: { ...SNAP, parked: [{ ...PARKED_ROW, pendingScan: { jobId: null } }, { ...PARKED_ROW, pendingScan: { jobId: "gh-4" } }, { ...PARKED_ROW, pendingScan: { unknown: true, tooMany: true } }] } }, "questions that wait, that are being answered, and one behind a queue too deep to scan, which says that"],
    ["parked", { snapshot: { ...SNAP, parked: [PARKED_ROW] } }, "a row that holds no scan at all"],
    ["parked", { parkedChecks: { "gh-3": { ok: true }, "gh-4": { refusal: "not a question" } } }, "checks that answered"],
    ["sandboxes", { sandboxes: { ...READ.sandboxes.sandboxes, refusal: "The triggers file does not exist, so there is no trigger to prepare a sandbox as." } }, "a triggers file that does not exist"],
    ["sandboxes", { sandboxes: { ...READ.sandboxes.sandboxes, refusal: "The host's current sandbox settings were not published. Choose a fresh host or inspect it in Fleet." } }, "a host that published no settings"],
    ["run", { run: { record: LOADED_RECORD, source: "local" }, hostLoads: { unreachable: true, hosts: [], more: 0 }, hostLoadsUnread: true }, "the hosts' doctor runs: a run's card says which other hosts lack what it loaded, and nothing of hosts it could not ask"],
    ["run", { run: { record: REFUSED_RECORD, source: "local" }, snapshot: SNAP, runsWindow: { partial: false }, transcript: { unreachable: "x" }, chat: { unreachable: true }, chatAnswer: { unreachable: true }, progress: { unreachable: true }, hostLoads: { unreachable: true } }, "what a run refused before it started draws none of: a transcript, a chat, progress, loaded parts"],
    ["runs", { runsPage: { ...READ.runs.runsPage, mirror: "off" } }, "a mirror that is off"],
    ["runs", { runsWindow: { partial: false, floor: true } }, "a window that ended inside the day: a floor, read whole"],
    ["runs", { runsPage: { ...READ.runs.runsPage, truncated: true, examined: 2000 } }, "a page that stopped at its cap"],
    ["run", { run: { missing: true }, progress: { missing: true }, chat: { mode: null, says: "No run with that id is in this host's history, the fleet's run mirror or the queue." } }, "no such run"],
    ["run", { run: { invalid: true } }, "an id that is not a run id"],
    ["run", { progress: { unreachable: true } }, "a progress key that was not read, beside a record: the card draws the record's"],
    ["run", { inbox: { found: true, steer: false, open: null, entries: null } }, "an inbox of a run that is not steer-armed"],
    ["run", { snapshot: null, runsWindow: null }, "no snapshot and no window on the page of a run that was not refused: it reads neither"],
    ["run", { run: { record: { ...REFUSED_RECORD, budgetReserved: true }, source: "local" }, snapshot: null, runsWindow: null }, "nor does a refusal that kept its count slot"],
    ["run", { run: { record: REFUSED_RECORD, source: "local" }, snapshot: { queue: { fleetDegraded: null }, doctor: { hosts: [], more: 0 } }, runsWindow: { partial: false, byReason: {} } }, "a refused run whose snapshot and window answered"],
    ["run", { artifacts: { state: "unreadable", kept: 2 } }, "kept files this host's store cannot read"],
    ["sandboxes", { browserGateways: { enabledHosts: [], sessions: [], problem: "The sandbox gateways file is readable by others." } }, "a gateways file the console refuses"],
    ["sandboxes", { sandboxes: { ...READ.sandboxes.sandboxes, sessionsMore: 3, hosts: [{ name: "build3", unreadable: true }] } }, "what a host published as unreadable"],
    ["host", { host: { name: "build3", jobsUnreadable: true }, hostHistory: null }, "a host that has a row: its history is not what the page draws"],
    ["host", { hostHistory: { runs: [], records: [], mirror: "off" } }, "a host no record names"],
    ["host", { hostHistory: { runs: [{ jobId: "gh-1" }], records: [{ jobId: "gh-1" }], mirror: "unreachable (Command timed out)" } }, "records this host's files hold beside a mirror that did not answer: the page draws when the host was last seen from them"],
    ["host", { hostCapacity: null }, "a capacity history that was not read: the card is read on page load, never by the stream"],
    // A key the data lacks is a read the page did not make: the loader sets each key a page reads, and marks a report
    // that did not arrive as the page's own read failing.
    ["sandboxes", { sandboxes: undefined }, "data that holds no report"],
    ["host", { snapshot: { queue: { fleetDegraded: null }, doctor: { hosts: [] } } }, "a snapshot that was not asked for the waiting jobs"],
    ["run", { inbox: undefined, chat: undefined, transcript: undefined }, "data that holds none of a run's reads"],
  ];
  for (const [page, over, what] of live) assert.equal(dataUnread({ page, ...READ[page], ...over }), false, `${page}: ${what}`);
});

test("dataUnread: a load the deadline cut is unread on any page, and no page outside the table takes a mark of another's", () => {
  // Every mark of every page at once, but for the three parts of a snapshot every page is judged by.
  const every = { ...Object.assign({}, ...Object.values(MARKS).flat().map(([, mark]) => mark)), snapshot: { ...SNAP, waiting: { unreachable: true }, failed: { unreachable: true }, doctor: { unreachable: true }, settings: null, triggers: { unreadable: "EACCES" }, parked: [{ ...PARKED_ROW, pendingScan: { unreachable: true } }] } };
  for (const page of Object.keys(PAGES)) {
    assert.equal(dataUnread({ page, deadlineSpent: true }), true, `${page}: cut by its deadline`);
    if (!Object.hasOwn(MARKS, page)) assert.equal(dataUnread({ page, ...every }), false, `${page}: reads none of these, and none of them changes its pill`);
  }
  // The table holds every live page, and no other: a page that is drawn once has no pill.
  assert.deepEqual(Object.keys(MARKS).sort(), Object.keys(PAGES).filter((page) => PAGES[page].live).sort());
  assert.deepEqual(Object.keys(MARKS).sort(), ["fleet", "host", "overview", "parked", "run", "runs", "sandboxes", "setup"]);
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
