import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPageData, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { hostLoadsOf } from "../src/console/panels/common.mjs";
import { ANSWERER_READ_FAILURE, ANSWERER_STANDING_UNREAD } from "../src/console/panels/answerer.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { SANDBOX_CONFIG_UNREAD, SANDBOX_NO_TRIGGERS_FILE } from "../src/sandbox-data.mjs";
import { TRIGGERS_FILE_ABSENT_TEXT } from "../src/trigger-list.mjs";
import { downQueue, downRedis } from "./helpers/fleet-reader-fakes.mjs";
import { consoleOn, doctorKeys, drawn, failing, failingQueue, healthy, HOST, iso, NOW, REFUSED, RUN, saysUnread, wordsOf } from "./helpers/real-console.mjs";
import { sandboxFixture, SANDBOX_HOSTS_FIXTURE } from "./helpers/sandbox-goldens.mjs";

/**
 * Absent is not unread, and unread is not absent (issue #988). A page said "could not be read" of what simply was not
 * there (a host with no row, a triggers file that does not exist, a projects file nobody configured), and "unknown" of
 * a zero it had read; and it said "none" of what it could not ask (hosts whose doctor runs were not read). Each
 * sentence here is held in both directions, on the real loader over the real reader and services
 * (helpers/real-console.mjs) and over real files in a temp folder: absent, there and unreadable, there and not JSON.
 */

/** The words of a page between two of its own, for a card. */
const between = (words, from, to) => {
  const start = words.indexOf(from);
  assert.ok(start >= 0, `the page holds "${from}": ${words.slice(0, 200)}`);
  const end = words.indexOf(to, start);
  return words.slice(start, end < 0 ? undefined : end);
};
const FILE_STATES = ["absent", "unreadable", "invalid"];

test("a refused run's two cards say could not be read of a read that failed, and of a host, a doctor result or a queue that is not there that there is none", async () => {
  const published = doctorKeys("build3", [{ ok: true, label: "valkey answers" }, { ok: false, label: "the job image is present", fix: "pull it" }]);
  const cards = async (make, role = "operator") => {
    const got = await drawn("run", "id=gh-2", consoleOn(make), role);
    return { ...got, why: role === "operator" ? between(got.words, "Why it was refused", "Read the rule") : null, host: role === "operator" ? between(got.words, "The host Host", "Open Fleet") : null };
  };
  // Everything read, and everything there: the facts themselves.
  const whole = await cards({ redis: healthy({ ...HOST, ...published }), records: [RUN, REFUSED] });
  assert.match(whole.why, /Venue floor \(PI_BACKEND_FLOOR\) This host has not published a floor\. Same reason in the last 24 hours 1 Newest doctor result 1 failing, 0 warnings, 1 passing, 1m ago/);
  assert.match(whole.host, /Heartbeat \d+s ago Newest failing doctor check the job image is present Queue waiting no queue of this host is listed Queue running no queue of this host is listed/);
  assert.deepEqual([saysUnread(whole.words), whole.pill], [false, false]);
  // Read, and the host published no doctor result: none, which is not a read that failed.
  const noDoctor = await cards({ redis: healthy(HOST), records: [RUN, REFUSED] });
  assert.match(noDoctor.why, /Newest doctor result no doctor result published/);
  assert.match(noDoctor.host, /Heartbeat \d+s ago Newest failing doctor check no doctor result published/);
  assert.deepEqual([saysUnread(noDoctor.words), noDoctor.pill], [false, false]);
  // Read, and the host has no row (it left, or this is another deployment's record): the cards said "could not be
  // read" five times of that.
  const noRow = await cards({ redis: healthy(), records: [REFUSED] });
  assert.match(noRow.why, /Venue floor \(PI_BACKEND_FLOOR\) not known: no live registry row for build3 Same reason in the last 24 hours 1 Newest doctor result no doctor result published/);
  assert.match(noRow.host, /Heartbeat no live registry row for build3 Newest failing doctor check no doctor result published Queue waiting no queue of this host is listed Queue running no queue of this host is listed/);
  assert.deepEqual([saysUnread(noRow.words), noRow.pill, noRow.marked], [false, false, false]);
  // A reason with no other run in the day is counted, as 0.
  const old = await cards({ redis: healthy(HOST), records: [{ ...REFUSED, startedAt: iso(3 * 86_400_000), endedAt: iso(3 * 86_400_000 - 1000) }] });
  assert.match(old.why, /Same reason in the last 24 hours 0 Newest doctor result/);
  assert.equal(saysUnread(old.words), false);

  // The hosts were not read at all: that, of the host, its floor and its queue.
  const hostsUnread = await cards({ redis: failing(healthy(HOST), ["smembers"]), records: [REFUSED] });
  assert.match(hostsUnread.why, /Venue floor \(PI_BACKEND_FLOOR\) not known: the hosts could not be read/);
  assert.match(hostsUnread.host, /Heartbeat not known: the hosts could not be read Newest failing doctor check could not be read Queue waiting not known: the hosts could not be read Queue running not known: the hosts could not be read/);
  // Some hosts' rows did not answer in time: the registry's own words for it.
  const inPart = await cards({ redis: failing(healthy(HOST), ["hgetall"]), records: [REFUSED] });
  assert.match(inPart.host, /Heartbeat not read this time: the host registry was read in part .*Queue waiting not read this time: the host registry was read in part/);
  // The doctor results alone were not read: of them, and of nothing else.
  const doctorUnread = await cards({ redis: failing(healthy({ ...HOST, ...published }), ["mget"]), records: [REFUSED] });
  assert.match(doctorUnread.why, /This host has not published a floor\. .*Newest doctor result could not be read/);
  assert.match(doctorUnread.host, /Heartbeat \d+s ago Newest failing doctor check could not be read Queue waiting no queue of this host is listed/);
  // No snapshot: nothing was read of the host.
  const noSnapshot = await cards({ redis: healthy(HOST), queue: failingQueue(["getJobCounts"]), records: [REFUSED] });
  assert.match(noSnapshot.why, /Venue floor \(PI_BACKEND_FLOOR\) not known: the hosts could not be read .*Newest doctor result could not be read/);
  assert.match(noSnapshot.host, /Heartbeat could not be read Newest failing doctor check could not be read Queue waiting could not be read Queue running could not be read/);
  for (const [what, got] of [["hosts unread", hostsUnread], ["read in part", inPart], ["doctor unread", doctorUnread], ["no snapshot", noSnapshot]]) {
    assert.deepEqual([got.pill, got.marked], [true, true], `${what}: Not live`);
    for (const absent of ["no live registry row", "no doctor result published"]) assert.ok(what === "read in part" || !`${got.why} ${got.host}`.includes(absent), `${what}: never "${absent}" of what was not read`);
  }
  // A viewer's page draws neither card.
  const viewer = await drawn("run", "id=gh-2", consoleOn({ redis: healthy(), records: [REFUSED] }), "viewer");
  assert.ok(!viewer.words.includes("Why it was refused") && !viewer.words.includes("Heartbeat"));
});

test("a triggers file that does not exist is an empty document on Parked, Watch and Sandboxes; one that is there and could not be read or does not load is not", async () => {
  const on = (files) => consoleOn({ redis: healthy(HOST), records: [RUN], files });
  // Parked: the answer rules and the standing answers are the file's.
  const parked = async (files) => drawn("parked", "", on(files), "operator");
  for (const files of [{}, { triggers: "absent" }]) {
    const got = await parked(files);
    assert.equal(got.data.answerer.state, "ok", JSON.stringify(files));
    assert.deepEqual([got.data.answerer.rules, got.data.answerer.standing], [[], []], JSON.stringify(files));
    assert.ok(!got.words.includes(ANSWERER_READ_FAILURE) && !got.words.includes(ANSWERER_STANDING_UNREAD) && !saysUnread(got.words), JSON.stringify(files));
    assert.deepEqual([got.pill, got.marked], [false, false], JSON.stringify(files));
  }
  for (const state of ["unreadable", "invalid"]) {
    const got = await parked({ triggers: state });
    assert.equal(got.data.answerer.state, "configuration-unavailable", state);
    assert.ok(!Object.hasOwn(got.data.answerer, "standing"), `${state}: no list of standing answers, which would read as none adopted`);
    assert.ok(got.words.includes(ANSWERER_READ_FAILURE), state);
    assert.deepEqual([got.pill, got.marked], [true, true], state);
  }

  // Watch: the sources are the file's, and a file that is not there names none.
  const WATCH_UNREAD = "The watch store could not be read. This is not an empty list.";
  for (const files of [{}, { triggers: "absent" }]) {
    const deps = on(files);
    assert.deepEqual(await deps.watch.listSources(), [], JSON.stringify(files));
    assert.deepEqual(await deps.watch.listRules(), [], JSON.stringify(files));
    const got = await drawn("watch", "", deps, "operator");
    assert.ok(!got.words.includes(WATCH_UNREAD) && got.words.includes("No watch rules have received findings."), JSON.stringify(files));
  }
  for (const state of ["unreadable", "invalid"]) {
    const deps = on({ triggers: state });
    await assert.rejects(deps.watch.listSources(), /watch configuration unreadable/, state);
    assert.ok((await drawn("watch", "", deps, "operator")).words.includes(WATCH_UNREAD), state);
  }
  // A file that is there and names a source lists it.
  const named = on({});
  const { writeFileSync } = await import("node:fs");
  writeFileSync(named.paths.triggersPath, JSON.stringify({ triggers: [], watchSources: { shop: { verify: "none", maxBodyBytes: 1024, maxPerDay: 10 } } }));
  assert.deepEqual(await named.watch.listSources(), [{ id: "shop", verify: "none", maxBodyBytes: 1024, maxPerDay: 10 }]);

  // Sandboxes, and the preview of preparing one: no trigger to prepare a sandbox as, which is not a file unread.
  const sandboxes = async (files) => {
    const deps = on(files);
    const got = await drawn("sandboxes", "", deps, "operator");
    return { ...got, preview: await deps.sandboxes.preview("sandbox-prepare", { host: "build3", repo: "acme/web", ref: "HEAD", index: 0, pin: false }) };
  };
  const healthyPage = await sandboxes({});
  assert.ok(!healthyPage.words.includes(SANDBOX_NO_TRIGGERS_FILE) && !healthyPage.words.includes(SANDBOX_CONFIG_UNREAD));
  assert.ok(![SANDBOX_NO_TRIGGERS_FILE, SANDBOX_CONFIG_UNREAD].includes(healthyPage.preview.refusal));
  const absent = await sandboxes({ triggers: "absent" });
  assert.ok(absent.words.includes(SANDBOX_NO_TRIGGERS_FILE) && !absent.words.includes(SANDBOX_CONFIG_UNREAD) && !saysUnread(absent.words));
  assert.equal(absent.preview.refusal, SANDBOX_NO_TRIGGERS_FILE);
  assert.deepEqual([absent.pill, absent.marked], [false, false]);
  for (const state of ["unreadable", "invalid"]) {
    const got = await sandboxes({ triggers: state });
    assert.ok(got.words.includes(SANDBOX_CONFIG_UNREAD) && !got.words.includes(SANDBOX_NO_TRIGGERS_FILE), state);
    assert.equal(got.preview.refusal, SANDBOX_CONFIG_UNREAD, state);
    assert.deepEqual([got.pill, got.marked], [true, true], state);
  }
  // The projects file keeps its rule: one the worker is configured with is required, so an absent one is unread.
  assert.ok((await sandboxes({ projects: "absent" })).words.includes(SANDBOX_CONFIG_UNREAD));
});

test("/triggers: a zero that was read is 0, a side of the history unread is unknown or a floor, and the triggers file has one word per case", async () => {
  // A run the first rule made, so that its count is its own.
  const made = { ...RUN, jobId: "gh-7", triggerIndex: 0, triggerType: "label" };
  const page = async (make) => (await drawn("triggers", "kind=all", consoleOn(make), "operator")).words;
  const rule = (words) => words.match(/.{0,100}\bruns? in 30 days.{0,90}/)?.[0] ?? "";
  const week = (words) => words.match(/\S+ attributed to these rules [^.]*since/)?.[0] ?? "";

  // Read, and holding nothing: 0. This said "unknown" on every deployment, an empty one included.
  for (const [what, make] of [["an empty history", { redis: healthy(HOST) }], ["a Valkey that holds nothing", { redis: healthy() }]]) {
    const words = await page(make);
    assert.match(rule(words), /No run in retained history 0 runs in 30 days · \$0 this UTC week/, what);
    assert.match(week(words), /\$0 attributed to these rules 0 run records since/, what);
    assert.ok(!/unknown runs|unknown run records|at least|lower bounds/.test(words), what);
  }
  // Read, and holding one: its noun agrees.
  const one = await page({ redis: healthy(HOST), records: [made] });
  assert.match(rule(one), /1 run in 30 days/);
  assert.match(week(one), /1 run record since/);
  assert.ok(!/at least|unknown runs|\b1 runs\b|\b1 run records\b/.test(one));

  // The fleet's mirror did not answer: a count is a floor, a zero is not known, and neither is the last run.
  const mirrorDown = (records) => ({ redis: failing(healthy(HOST), ["zrevrangebyscore"]), records });
  const floor = await page(mirrorDown([made]));
  assert.match(rule(floor), /at least 1 run in 30 days/);
  assert.match(week(floor), /at least 1 run record since/);
  const notKnown = await page(mirrorDown([]));
  assert.match(rule(notKnown), /Last run not known: the fleet's run records could not be read\. unknown runs in 30 days · unknown spend this UTC week/);
  assert.match(week(notKnown), /unknown attributed to these rules unknown run records since/);
  assert.ok(!notKnown.includes("No run in retained history"));
  // This host's run files could not be listed, and nothing is answered at all: the same.
  for (const [what, make] of [["this host's scan failed", { redis: healthy(HOST), logs: "file" }], ["nothing is answered", { redis: downRedis(), queue: downQueue() }]]) {
    const words = await page(make);
    assert.match(rule(words), /Last run not known: the fleet's run records could not be read\. unknown runs in 30 days/, what);
    assert.ok(!/\b0 runs in 30 days|No run in retained history/.test(words), what);
  }

  // The file itself: absent holds no rule; unreadable could not be read; not JSON does not load.
  const said = { absent: TRIGGERS_FILE_ABSENT_TEXT, unreadable: "The triggers file could not be read; rule facts are unknown.", invalid: "The triggers file does not load; rule facts are unknown." };
  for (const state of FILE_STATES) {
    const words = await page({ redis: healthy(HOST), files: { triggers: state } });
    for (const [other, sentence] of Object.entries(said)) assert.equal(words.includes(sentence), other === state, `${state}: ${sentence}`);
    assert.ok(!words.includes("The triggers file is not available"), state);
    assert.equal(/All 0\b/.test(words), state === "absent", `${state}: a count of 0 only for a file that holds none`);
  }
  assert.ok(!Object.values(said).some((sentence) => one.includes(sentence)));
});

test("a project's page, the Secrets bundle row and the settings card: does not exist, could not be read and does not load are three cases", async () => {
  const on = (files, over = {}) => consoleOn({ redis: healthy(HOST), records: [RUN], files, ...over });
  // A project: no projects file is the page of a project that is not there (404), as for an id the file lacks.
  const project = async (files, id = "web") => {
    const deps = on(files);
    const query = parsePageQuery("project", new URLSearchParams(`id=${id}`)).query;
    const data = await loadPageData("project", query, deps, { role: "operator" });
    const out = await renderPage("project", { query, session: { name: "ada", role: "operator" }, data, readOnly: false });
    return { status: out.status, state: data.projectView.state, problem: data.projectView.problem ?? null, words: wordsOf(out.html) };
  };
  assert.deepEqual([(await project({})).status, (await project({})).state], [200, "ready"]);
  const gone = await project({ projects: "absent" });
  const unknownId = await project({}, "nope");
  assert.deepEqual([gone.status, gone.state, gone.problem], [404, "missing", null]);
  assert.deepEqual([unknownId.status, unknownId.state], [404, "missing"]);
  assert.ok(!gone.words.includes("could not be read") && !gone.words.includes("does not load"));
  const unreadable = await project({ projects: "unreadable" });
  assert.deepEqual([unreadable.state, unreadable.problem], ["unreadable", "The projects file could not be read. Run pi-dispatch doctor for the reason."]);
  assert.ok(unreadable.words.includes("The projects file could not be read.") && unreadable.words.includes("Project configuration could not be read.") && !unreadable.words.includes("does not load"));
  const invalid = await project({ projects: "invalid" });
  assert.deepEqual([invalid.state, invalid.problem], ["unreadable", "The projects file does not load. Run pi-dispatch doctor for the reason."]);
  assert.ok(invalid.words.includes("The projects file does not load.") && invalid.words.includes("Project configuration does not load."), invalid.words.slice(0, 400));
  assert.ok(!invalid.words.includes("could not be read"), "one word for the case, on the whole page");

  // Secrets: under a bundle's project that could not be looked up, why.
  const bundled = (files) => {
    const deps = on({});
    return import("node:fs").then(({ writeFileSync, chmodSync, rmSync }) => {
      writeFileSync(deps.paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } }], secretBundles: { shop: { profile: "shop-env", ref: "shop", project: "web" } } }));
      if (files.projects === "absent") rmSync(deps.paths.projectsFile);
      if (files.projects === "invalid") writeFileSync(deps.paths.projectsFile, "{ not json");
      if (files.projects === "unreadable") chmodSync(deps.paths.projectsFile, 0o000);
      return drawn("secrets", "", deps, "operator");
    });
  };
  const row = (words) => between(words, "Secret bundles Bundle Project", "Binding a bundle");
  const notes = { absent: "there is no projects file", unreadable: "projects.json could not be read", invalid: "projects.json does not load" };
  const read = row((await bundled({})).words);
  assert.ok(read.includes("web") && !Object.values(notes).some((note) => read.includes(note)) && !read.includes("not in projects.json"), read);
  for (const state of FILE_STATES) {
    const words = row((await bundled({ projects: state })).words);
    for (const [other, note] of Object.entries(notes)) assert.equal(words.includes(note), other === state, `${state}: ${note} in ${words}`);
  }

  // Configuration's settings card: a file nobody could read is not one that does not load.
  const settings = async (files) => between((await drawn("config", "", on(files), "operator")).words, "Settings overlay", "Triggers");
  assert.match(await settings({ settings: "unreadable" }), /The settings overlay cannot be read \(EACCES\)\./);
  assert.ok(!(await settings({ settings: "unreadable" })).includes("does not load"));
  assert.match(await settings({ settings: "invalid" }), /The settings overlay does not load/);
  assert.ok(!(await settings({ settings: "invalid" })).includes("cannot be read"));
  for (const files of [{}, { settings: "absent" }]) assert.ok(!/cannot be read|does not load|could not be read/.test(await settings(files)), JSON.stringify(files));
});

test("Sandboxes says the hosts' doctor runs could not be read where that read threw, and that a host published none only where the hosts were read", async () => {
  // The card that says what a fresh sandbox would load on a host. The report is the Sandboxes fixture's; the read under
  // test is the page's own of the hosts' doctor runs, through the real loader.
  const page = async (hostLoads) => {
    const query = parsePageQuery("sandboxes", new URLSearchParams("repo=acme%2Fweb&index=2&ref=HEAD&host=mini1")).query;
    const deps = { now: () => NOW, fleet: { parkedCount: async () => 1, runById: async () => ({ missing: true }) }, sandboxes: { hosts: () => ({ config: SANDBOX_HOSTS_FIXTURE }), read: async () => sandboxFixture() }, hostLoads };
    const data = await loadPageData("sandboxes", query, deps, { role: "operator", readOnly: false });
    const out = await renderPage("sandboxes", { data, query, session: { role: "operator", name: "ops" }, readOnly: false });
    return { data, words: wordsOf(out.html), marked: /<span id="live-status"[^>]* data-unread>/.test(String(out.html)) };
  };
  const UNREAD = "the hosts’ doctor runs could not be read", NONE = "it has published no doctor run";
  // The read threw: it drew "it has published no doctor run" of hosts nobody could ask.
  const threw = await page(async () => { throw new Error("Command timed out"); });
  assert.deepEqual([threw.data.hostLoads, threw.data.hostLoadsUnread], [null, true]);
  assert.deepEqual(hostLoadsOf(threw.data), { unreachable: true, hosts: [], more: 0 });
  assert.ok(threw.words.includes(UNREAD) && !threw.words.includes(NONE), threw.words.match(/[^.]*doctor run[^.]*/g)?.join(" | "));
  assert.equal(threw.marked, true);
  // The reader's own answer in an outage says the same.
  const down = await page(() => readHostLoadsView(downRedis(), { now: () => NOW }));
  assert.equal(down.data.hostLoads.unreachable, true);
  assert.ok(down.words.includes(UNREAD) && !down.words.includes(NONE));
  assert.equal(down.marked, true);
  // The hosts were read and this one published nothing: that, and a Live pill.
  const none = await page(() => readHostLoadsView(healthy(HOST), { now: () => NOW }));
  assert.ok(!none.data.hostLoads.unreachable && hostLoadsOf(none.data) === none.data.hostLoads);
  assert.ok(none.words.includes(NONE) && !none.words.includes(UNREAD), none.words.match(/[^.]*doctor run[^.]*/g)?.join(" | "));
  assert.equal(none.marked, false);
  // A console that wires no such read holds null, which is not a read that failed.
  assert.equal(hostLoadsOf({ hostLoads: null }), null);
});
