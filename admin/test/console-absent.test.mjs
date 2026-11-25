import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPageData, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { dataUnread, hostLoadsOf } from "../src/console/panels/common.mjs";
import { ANSWERER_FILE_REFUSED, ANSWERER_READ_FAILURE, ANSWERER_STANDING_REFUSED, ANSWERER_STANDING_UNREAD } from "../src/console/panels/answerer.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { parkedAnswerRefusalOf } from "../src/job-actions.mjs";
import { SANDBOX_CONFIG_UNREAD, SANDBOX_NO_TRIGGERS_FILE, sandboxConfigRefusal } from "../src/sandbox-data.mjs";
import { TRIGGERS_FILE_ABSENT_TEXT } from "../src/trigger-list.mjs";
import { downQueue, downRedis, registryKeys } from "./helpers/fleet-reader-fakes.mjs";
import { HOST_SET, hostKey } from "@edgehero/pi-dispatch/host-registry";
import { readSandboxSessions, sandboxNoticeKey, sandboxSessionKey, sandboxSessionMember, SANDBOX_NOTICE_INDEX, SANDBOX_SESSION_INDEX, SANDBOX_SESSION_MAX } from "@edgehero/pi-dispatch/sandbox-sessions";
import { consoleOn, doctorKeys, drawn, failing, failingKey, failingQueue, healthy, HOST, iso, mirroring, NOW, REFUSED, RUN, saysUnread, wordsOf } from "./helpers/real-console.mjs";
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
  // Read, and the host's newest result is one this console's reader refuses (not JSON): it does not load, which is
  // neither "none published" nor a read that failed.
  const refusedResult = await cards({ redis: healthy({ ...HOST, ...Object.fromEntries(Object.keys(published).map((key) => [key, "{ not a doctor result"])) }), records: [RUN, REFUSED] });
  assert.match(refusedResult.why, /Newest doctor result its newest result does not load/);
  assert.match(refusedResult.host, /Newest failing doctor check its newest result does not load/);
  assert.ok(!refusedResult.words.includes("no doctor result published"), "a result that is there is not none");
  assert.deepEqual([saysUnread(refusedResult.words), refusedResult.pill, refusedResult.marked], [false, false, false]);
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
  // The fleet's mirror did not answer: the count is of this host's runs alone, which is a floor, and says why. It was
  // said bare, under a Not live pill, with nothing on the page to say what was not read.
  const floor = await cards({ redis: failing(healthy(HOST), ["zrevrangebyscore"]), records: [RUN, REFUSED] });
  assert.match(floor.why, /Same reason in the last 24 hours at least 1 : part of the run history could not be read Newest doctor result/);
  assert.deepEqual([floor.data.runsWindow.partial, floor.pill, floor.marked], [true, true, true]);
  assert.ok(!/at least/.test(`${whole.why} ${noRow.why} ${old.why}`), "a count over a window read whole is itself");
  // A viewer's page draws neither card.
  const viewer = await drawn("run", "id=gh-2", consoleOn({ redis: healthy(), records: [REFUSED] }), "viewer");
  assert.ok(!viewer.words.includes("Why it was refused") && !viewer.words.includes("Heartbeat"));
});

test("a registry that answered once and not again: the refused run's cards say it was not read this time, never that a host has no row", async () => {
  // The first load reads the registry; then it stops answering, time passes, and a host registers that the last read
  // did not see. The rows are as they were last seen, and "no live registry row" is a read's answer, not theirs.
  const clock = { at: NOW }, registry = { down: false };
  const keys = { ...HOST, ...doctorKeys("build3", [{ ok: true, label: "valkey answers" }]) };
  const client = healthy(keys);
  const redis = new Proxy(client, { get: (target, name) => (name === "smembers" ? async (key, ...rest) => { if (registry.down && key === HOST_SET) throw new Error("Command timed out"); return target.smembers(key, ...rest); } : target[name]) });
  const deps = consoleOn({ redis, records: [RUN, REFUSED, { ...REFUSED, jobId: "gh-3", host: "otherhost" }], now: () => clock.at });
  const cards = async (id) => {
    const got = await drawn("run", `id=${id}`, deps, "operator");
    return { ...got, why: between(got.words, "Why it was refused", "Read the rule"), host: between(got.words, "The host Host", "Open Fleet") };
  };
  // Read: the host that has a row has a beat, and the one that has none has none.
  const first = { known: await cards("gh-2"), other: await cards("gh-3") };
  assert.match(first.known.host, /Heartbeat \d+s ago /);
  assert.match(first.other.host, /Heartbeat no live registry row for otherhost .*Queue waiting no queue of this host is listed/);
  assert.deepEqual([first.known.pill, first.other.pill, saysUnread(first.other.words)], [false, false, false]);
  registry.down = true;
  const joined = registryKeys({ build3: {}, otherhost: { version: "5.4.2", concurrency: "2", beatAt: String(Date.now()), jobs: "[]", jobsMore: "0" } });
  Object.assign(keys, { [HOST_SET]: joined[HOST_SET], [hostKey("otherhost")]: joined[hostKey("otherhost")] });
  const UNREAD = "not read this time: the host registry could not be read";
  for (const later of [14_000, 34_000]) {
    clock.at = NOW + later;
    const other = await cards("gh-3");
    assert.ok(other.host.includes(`Heartbeat ${UNREAD} `) && other.host.includes(`Queue waiting ${UNREAD} Queue running ${UNREAD}`), `${later} ms on: ${other.host}`);
    assert.ok(other.why.includes(`Venue floor (PI_BACKEND_FLOOR) ${UNREAD}`), `${later} ms on: ${other.why}`);
    assert.ok(!other.words.includes("no live registry row") && !other.words.includes("no queue of this host is listed"), `${later} ms on: none is not said of a registry that was not read`);
    assert.deepEqual([other.pill, other.marked], [true, true], `${later} ms on`);
    // A host whose row is as last seen: its beat is not this read's to tell.
    const known = await cards("gh-2");
    assert.ok(known.host.includes(`Heartbeat ${UNREAD} `) && !/Heartbeat \d+s ago/.test(known.host), `${later} ms on: ${known.host}`);
  }
});

test("a triggers file that does not exist is an empty document on Parked, Watch and Sandboxes; one nobody could read could not be read, and one that was read and is refused does not load", async () => {
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
  // One word per case, here too (the three pages said "could not be read" of both): a file nobody could read is
  // unread, with the pill; a file that was read and is refused does not load, which is not a read that failed.
  for (const state of ["unreadable", "invalid"]) {
    const got = await parked({ triggers: state });
    assert.deepEqual([got.data.answerer.state, got.data.answerer.configuration], ["configuration-unavailable", state], state);
    assert.ok(!Object.hasOwn(got.data.answerer, "standing"), `${state}: no list of standing answers, which would read as none adopted`);
    assert.deepEqual([got.words.includes(ANSWERER_READ_FAILURE), got.words.includes(ANSWERER_STANDING_UNREAD), got.words.includes(ANSWERER_FILE_REFUSED), got.words.includes(ANSWERER_STANDING_REFUSED)], state === "unreadable" ? [true, true, false, false] : [false, false, true, true], state);
    assert.deepEqual([got.pill, got.marked, saysUnread(got.words)], state === "unreadable" ? [true, true, true] : [false, false, false], state);
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
  // Neither is a store that could not be read: the file is named, with the word of its case.
  const WATCH_FILE = { unreadable: "The triggers file could not be read, so its watch rules and sources are not shown. This is not an empty list.", invalid: "The triggers file does not load, so its watch rules and sources are not shown. This is not an empty list." };
  for (const state of ["unreadable", "invalid"]) {
    const deps = on({ triggers: state });
    const thrown = state === "unreadable" ? /watch configuration unreadable/ : /watch configuration does not load/;
    await assert.rejects(deps.watch.listSources(), thrown, state);
    await assert.rejects(deps.watch.listRules(), thrown, state);
    const words = (await drawn("watch", "", deps, "operator")).words;
    assert.deepEqual([words.includes(WATCH_UNREAD), words.includes(WATCH_FILE.unreadable), words.includes(WATCH_FILE.invalid)], [false, state === "unreadable", state === "invalid"], state);
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
  // The file that stopped the configuration is named, with the word of its case. Only a read that failed is unread.
  for (const [files, file, word] of [
    [{ triggers: "unreadable" }, "triggers file", "could not be read"], [{ triggers: "invalid" }, "triggers file", "does not load"],
    [{ projects: "unreadable" }, "projects file", "could not be read"], [{ projects: "invalid" }, "projects file", "does not load"],
    // A projects file the deployment configures is required, so one that is absent stops it: as absent, not as unread.
    [{ projects: "absent" }, "projects file", "does not exist"],
  ]) {
    const got = await sandboxes(files);
    const said = sandboxConfigRefusal(file, word);
    assert.ok(got.words.includes(said) && !got.words.includes(SANDBOX_NO_TRIGGERS_FILE) && !got.words.includes(SANDBOX_CONFIG_UNREAD), `${JSON.stringify(files)}: ${got.data.sandboxes.refusal}`);
    assert.equal(got.preview.refusal, said, JSON.stringify(files));
    const unread = word === "could not be read";
    assert.deepEqual([got.pill, got.marked, saysUnread(got.words)], [unread, unread, unread], JSON.stringify(files));
  }
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
  const bundled = (files, bundle = { profile: "shop-env", ref: "shop", project: "web" }) => {
    const deps = on({});
    return import("node:fs").then(({ writeFileSync, chmodSync, rmSync }) => {
      writeFileSync(deps.paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } }], secretBundles: { shop: bundle } }));
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
  // A bundle that names no project has none to look up: with no projects file its row says so of the bundle, and
  // nothing of the file.
  const unbound = row((await bundled({ projects: "absent" }, { profile: "shop-env", ref: "shop" })).words);
  assert.ok(unbound.includes("shop") && !unbound.includes("there is no projects file"), unbound);

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

  // The same two reads on a page with no card to say them (issue #988): the pill is the page's, so it stays Live.
  const opened = async (search, { record = async () => ({ missing: true }), hostLoads = () => readHostLoadsView(healthy(HOST), { now: () => NOW }), prepares = false } = {}) => {
    const query = parsePageQuery("sandboxes", new URLSearchParams(search)).query;
    // The fixture's report holds a sandbox being prepared (`plan`); without one the page draws no card for a new one.
    const report = () => { const { plan, ...rest } = sandboxFixture(); return prepares ? { ...rest, plan } : rest; };
    const deps = { now: () => NOW, fleet: { parkedCount: async () => 1, runById: record }, sandboxes: { hosts: () => ({ config: SANDBOX_HOSTS_FIXTURE }), read: async () => report() }, hostLoads };
    const data = await loadPageData("sandboxes", query, deps, { role: "operator", readOnly: false });
    const out = await renderPage("sandboxes", { data, query, session: { role: "operator", name: "ops" }, readOnly: false });
    return { data, words: wordsOf(out.html), marked: /<span id="live-status"[^>]* data-unread>/.test(String(out.html)) };
  };
  const unreadRecord = async () => ({ unreadable: "the fleet's run mirror could not be read" });
  const downLoads = () => readHostLoadsView(downRedis(), { now: () => NOW });
  // Opened for a kept workspace: its card says what was not read of the run it came from.
  const kept = await opened("id=gh-9575&host=mini1", { record: unreadRecord });
  assert.deepEqual([kept.data.sandboxPicked, kept.data.sandboxRunUnread], [{ id: "gh-9575", host: "mini1" }, true]);
  assert.ok(kept.words.includes("itself loaded could not be read."), kept.words.match(/[^.]*itself loaded[^.]*\./g)?.join(" | "));
  assert.equal(kept.marked, true);
  // The hosts' doctor runs change nothing that card says (pi's version is one this page cannot name either way), so
  // they are not its to mark.
  const keptDown = await opened("id=gh-9575&host=mini1", { hostLoads: downLoads });
  const keptUp = await opened("id=gh-9575&host=mini1");
  const card = (words) => words.match(/pi and what it loads.{0,200}/)?.[0];
  assert.ok(card(keptDown.words) !== undefined && card(keptDown.words) === card(keptUp.words) && !saysUnread(keptDown.words));
  assert.deepEqual([keptDown.marked, keptUp.marked], [false, false]);
  // A sandbox being prepared: its card says what was not read of the hosts.
  const preparing = await opened("", { hostLoads: downLoads, prepares: true });
  assert.ok(preparing.words.includes(UNREAD));
  assert.equal(preparing.marked, true);
  // Opened for a run no kept workspace is of, or for none, and preparing nothing: no card draws either read, and
  // nothing on the page says so.
  for (const search of ["id=gh-nokeep", "id=gh-9575&host=build9", ""]) {
    const none = await opened(search, { record: unreadRecord, hostLoads: downLoads });
    assert.deepEqual(none.words.match(/[^.]{0,90}could not be read[^.]{0,40}/g) ?? [], [], search);
    assert.equal(none.marked, false, search);
  }
});

test("a list that is full, or holds an entry that does not parse, is not a read that failed: the open shells on a run's page and the cleanup notices on Sandboxes say which, and only a read that did not answer says could not be read", async () => {
  // The worker's own reader over a Valkey that holds the lists (issue #988): 257 open shells against a list of 256
  // made every run's page say "Some shell or browser status could not be read", with a Not live pill, for as long as
  // they stayed open; so did one registration that does not parse, and 257 cleanup notices on Sandboxes.
  const shell = (n) => ({ v: 1, host: "build3", id: `gh-s${n}`, nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local", by: "ops", since: NOW - 30_000, at: NOW });
  const listed = ({ shells = [], rawShells = {}, notices = [], rawNotices = {}, noticesDown = false }) => {
    const keys = { ...HOST };
    const index = { [SANDBOX_SESSION_INDEX]: [], [SANDBOX_NOTICE_INDEX]: [] };
    for (const s of shells) { keys[sandboxSessionKey(s.host, s.id)] = JSON.stringify(s); index[SANDBOX_SESSION_INDEX].push(sandboxSessionMember(s.host, s.id)); }
    for (const [id, raw] of Object.entries(rawShells)) { keys[sandboxSessionKey("build3", id)] = raw; index[SANDBOX_SESSION_INDEX].push(sandboxSessionMember("build3", id)); }
    for (const id of notices) { keys[sandboxNoticeKey("build3", id)] = JSON.stringify({ host: "build3", id, at: NOW - 1000, reason: "network-kept" }); index[SANDBOX_NOTICE_INDEX].push(sandboxSessionMember("build3", id)); }
    for (const [id, raw] of Object.entries(rawNotices)) { keys[sandboxNoticeKey("build3", id)] = raw; index[SANDBOX_NOTICE_INDEX].push(sandboxSessionMember("build3", id)); }
    return {
      ...healthy(keys),
      async zrangebyscore(key, _min, _max, _limit, from, count) {
        if (key === SANDBOX_NOTICE_INDEX && noticesDown) throw new Error("Command timed out");
        return (index[key] ?? []).slice(Number(from) || 0, (Number(from) || 0) + (Number(count) || Infinity));
      },
    };
  };
  const many = (n) => Array.from({ length: n }, (_, i) => i);
  const UNREAD = "Some shell or browser status could not be read; an absent watcher is not inferred.";
  const CUT = "More shells are open than the first 256 this list holds; an absent watcher is not inferred.";
  const ROWS = "A registration in the open shells' list does not parse and is left out; an absent watcher is not inferred.";
  const run = (redis) => drawn("run", "id=gh-1", consoleOn({ redis, records: [RUN] }), "operator");

  // The reader's own answers first: one word for "not whole" as before, and beside it which way.
  const full = await readSandboxSessions(listed({ shells: many(SANDBOX_SESSION_MAX + 1).map(shell), notices: many(SANDBOX_SESSION_MAX + 1).map((n) => `gh-n${n}`) }), { now: () => NOW });
  assert.deepEqual([full.sessions.length, full.more, full.unreadable, full.unreachable, full.notices.length], [SANDBOX_SESSION_MAX, 1, 0, undefined, SANDBOX_SESSION_MAX]);
  assert.deepEqual([full.noticesUnavailable, full.noticesMore, full.noticesUnreadable, full.noticesUnread], [true, true, undefined, undefined]);
  const odd = await readSandboxSessions(listed({ shells: [shell(1)], rawShells: { "gh-odd": "{ not json" }, notices: ["gh-n1"], rawNotices: { "gh-odd": "{ not json" } }), { now: () => NOW });
  assert.deepEqual([odd.sessions.length, odd.more, odd.unreadable, odd.noticesUnavailable, odd.noticesMore, odd.noticesUnreadable, odd.noticesUnread], [1, 0, 1, true, undefined, true, undefined]);
  const noNotices = await readSandboxSessions(listed({ shells: [shell(1)], noticesDown: true }), { now: () => NOW });
  assert.deepEqual([noNotices.sessions.length, noNotices.noticesUnavailable, noNotices.noticesUnread, noNotices.noticesMore, noNotices.noticesUnreadable], [1, true, true, undefined, undefined]);
  const whole = await readSandboxSessions(listed({ shells: [shell(1)], notices: ["gh-n1"] }), { now: () => NOW });
  assert.deepEqual([whole.more, whole.unreadable, Object.hasOwn(whole, "noticesUnavailable"), Object.hasOwn(whole, "noticesUnread")], [0, 0, false, false]);

  // A run's page. More shells than the list holds: read, and said as that, with a Live pill.
  const cut = await run(listed({ shells: many(SANDBOX_SESSION_MAX + 1).map(shell) }));
  assert.deepEqual([cut.data.workspace.sessionsUnknown, cut.data.workspace.sessionsUnread, cut.data.workspace.sessionsMore], [true, false, 1]);
  assert.ok(cut.words.includes(CUT) && !cut.words.includes(UNREAD) && !saysUnread(cut.words));
  assert.deepEqual([cut.pill, cut.marked], [false, false]);
  // A registration that does not parse: the same.
  const rows = await run(listed({ shells: [shell(1)], rawShells: { "gh-odd": "{ not json" } }));
  assert.deepEqual([rows.data.workspace.sessionsUnknown, rows.data.workspace.sessionsUnread, rows.data.workspace.sessionsUnreadable], [true, false, 1]);
  assert.ok(rows.words.includes(ROWS) && !rows.words.includes(UNREAD) && !saysUnread(rows.words));
  assert.deepEqual([rows.pill, rows.marked], [false, false]);
  // The read did not answer: could not be read, and Not live.
  const unread = await run(failing(listed({ shells: [shell(1)] }), ["time"]));
  assert.deepEqual([unread.data.workspace.sessionsUnknown, unread.data.workspace.sessionsUnread], [true, true]);
  assert.ok(unread.words.includes(UNREAD) && !unread.words.includes(CUT) && !unread.words.includes(ROWS));
  assert.deepEqual([unread.pill, unread.marked], [true, true]);
  // A list that is whole says none of the three.
  const calm = await run(listed({ shells: [shell(1)] }));
  assert.ok(![UNREAD, CUT, ROWS].some((line) => calm.words.includes(line)));

  // Sandboxes, its cleanup notices.
  const N_UNREAD = "Some sandbox cleanup notices could not be read.", N_CUT = "More cleanup notices are kept than the first 256 this list holds.", N_ROWS = "A cleanup notice does not parse and is left out.";
  const sandboxes = (redis) => drawn("sandboxes", "", consoleOn({ redis, records: [RUN] }), "operator");
  for (const [what, redis, said, live] of [
    ["more than the list holds", listed({ notices: many(SANDBOX_SESSION_MAX + 1).map((n) => `gh-n${n}`) }), N_CUT, true],
    ["one that does not parse", listed({ notices: ["gh-n1"], rawNotices: { "gh-odd": "{ not json" } }), N_ROWS, true],
    ["a read that did not answer", listed({ noticesDown: true }), N_UNREAD, false],
    ["a list that is whole", listed({ notices: ["gh-n1"] }), null, true],
  ]) {
    const got = await sandboxes(redis);
    for (const line of [N_UNREAD, N_CUT, N_ROWS]) assert.equal(got.words.includes(line), line === said, `${what}: ${line}`);
    assert.deepEqual([got.pill, got.marked, saysUnread(got.words)], [!live, !live, !live], what);
  }
});

test("an agent's session over a healthy mirror: /runs and the page of a host no record names say nothing unread and are Live, as for a person", async () => {
  // An agent's copy of the data holds a mirror that answered as "bounded" (`agentReadProjection`), a word the rule
  // took for unread (issue #988): its `/runs` said other hosts' runs could not be read, Not live, for good.
  const far = { ...RUN, jobId: "gh-9", host: "build7", startedAt: iso(300_000), endedAt: iso(240_000) };
  const fleet = () => consoleOn({ redis: mirroring([far]), records: [RUN] });
  for (const role of ["agent", "viewer", "operator"]) {
    const runs = await drawn("runs", "", fleet(), role);
    assert.equal(runs.data.runsPage.mirror, role === "agent" ? "bounded" : "ok", role);
    assert.ok(!runs.words.includes("Other hosts' runs could not be read") && !saysUnread(runs.words), role);
    assert.deepEqual([runs.pill, runs.marked], [false, false], role);
    const ghost = await drawn("host", "name=ghost", fleet(), role);
    assert.ok(ghost.words.includes("No retained run record names this host.") && !saysUnread(ghost.words), role);
    assert.deepEqual([ghost.pill, ghost.marked], [false, false], role);
  }
  // A mirror that did not answer is unread in an agent's copy too, where its word is "unreachable".
  const down = await drawn("runs", "", consoleOn({ redis: failing(mirroring([far]), ["zrevrangebyscore"]), records: [RUN] }), "agent");
  assert.equal(down.data.runsPage.mirror, "unreachable");
  assert.ok(down.words.includes("Other hosts' runs could not be read"));
  assert.deepEqual([down.pill, down.marked], [true, true]);
});

test("one word per case wherever a page words a file: Models, a project's page, the overview's Caps card and a parked answer's refusal", async () => {
  const on = (files) => consoleOn({ redis: healthy(HOST), records: [RUN], files });
  const WORD = { invalid: "does not load", unreadable: "could not be read" };
  const OTHER = { invalid: "could not be read", unreadable: "does not load" };
  const NAMED = { triggers: "triggers file", projects: "projects file", settings: "settings overlay" };
  // Models: which file stopped the policy, in its word. One sentence, "could not be read and validated", said both of all three.
  for (const [file, named] of Object.entries(NAMED)) {
    for (const state of ["invalid", "unreadable"]) {
      const got = await drawn("models", "", on({ [file]: state }), "operator");
      assert.deepEqual([got.data.models.state, got.data.models.configProblem], ["unreadable", { file: named, word: WORD[state] }], `${file} ${state}`);
      assert.ok(got.words.includes(`The ${named} ${WORD[state]}, so the models are not known.`) && got.words.includes(`The ${named} ${WORD[state]}, so the model policy is not known.`), `${file} ${state}`);
      assert.ok(!got.words.includes(`The ${named} ${OTHER[state]}`) && !got.words.includes("Models could not be read") && !got.words.includes("could not be read and validated"), `${file} ${state}: no other word`);
    }
    // A file that does not exist is an empty document: the page is drawn, and says nothing of it.
    const absent = await drawn("models", "", on({ [file]: "absent" }), "operator");
    assert.ok(absent.data.models.state === "ready" && !Object.hasOwn(absent.data.models, "configProblem") && !/so the models are not known/.test(absent.words), `${file} absent`);
  }
  // A project's page: the secret bundle, the triggers that ran here and the check of a change. "Could not be loaded" said all three.
  for (const state of ["invalid", "unreadable"]) {
    const got = await drawn("project", "id=web", on({ triggers: state }), "operator");
    for (const tail of ["so whether this project has a secret bundle is unknown.", "so which triggers ran here is unknown.", "so this project's change cannot be checked."]) {
      assert.ok(got.words.includes(`The triggers file ${WORD[state]}, ${tail}`) && !got.words.includes(`The triggers file ${OTHER[state]}, ${tail}`), `${state}: ${tail}`);
    }
    assert.ok(!got.words.includes("could not be loaded") && !got.words.includes("The triggers file does not exist"), state);
  }
  const noFile = await drawn("project", "id=web", on({ triggers: "absent" }), "operator");
  assert.ok(noFile.words.includes("The triggers file does not exist, so no secret bundle is bound to this project.") && noFile.words.includes("The triggers file does not exist, so no run here is attributed to a trigger."));
  assert.ok(!/The triggers file (?:could not be read|does not load|could not be loaded)/.test(noFile.words) && !noFile.words.includes("is unknown"), "absent is said as absent, and nothing is unknown of it");
  const read = await drawn("project", "id=web", on({}), "operator");
  assert.ok(!/The triggers file (?:could not be read|does not load|does not exist|could not be loaded)/.test(read.words), "a file that was read is not worded at all");
  // The overview's Caps card, with the pill: an overlay that was read and is refused is not a read that failed.
  const CAPS = { invalid: "The settings overlay does not load, so its caps are not drawn.", unreadable: "The settings overlay could not be read, so its caps are not drawn." };
  for (const state of ["invalid", "unreadable"]) {
    const got = await drawn("overview", "", on({ settings: state }), "operator");
    assert.ok(got.words.includes(CAPS[state]) && !got.words.includes(CAPS[state === "invalid" ? "unreadable" : "invalid"]), state);
    assert.deepEqual([got.pill, got.marked], state === "unreadable" ? [true, true] : [false, false], state);
  }
  const noOverlay = await drawn("overview", "", on({ settings: "absent" }), "operator");
  assert.ok(!Object.values(CAPS).some((line) => noOverlay.words.includes(line)) && noOverlay.pill === false, "a settings file that does not exist is an empty overlay");
  // A parked answer's refusal, which Parked and the run's page draw: by the read's error, and never the host's path.
  const answer = (files) => parkedAnswerRefusalOf({ jobId: "gh-1", data: { kind: "github", target: { type: "issue" } }, triggersPath: on(files).paths.triggersPath }).refusal;
  assert.equal(answer({ triggers: "absent" }), "the triggers file does not exist; nothing was queued");
  assert.equal(answer({ triggers: "unreadable" }), "the triggers file could not be read (EACCES); nothing was queued");
  assert.match(answer({ triggers: "invalid" }), /^the triggers file does not load \(.*\); nothing was queued$/);
  // The parser's words name the file by its name alone, never the host's path; and only the read that failed is
  // marked as one, which is what a page that draws the refusal tells its pill by.
  const judged = (files) => { const deps = on(files); return { ...parkedAnswerRefusalOf({ jobId: "gh-1", data: { kind: "github", target: { type: "issue" } }, triggersPath: deps.paths.triggersPath }), dir: deps.paths.triggersPath.slice(0, deps.paths.triggersPath.lastIndexOf("/")) }; };
  const notJson = judged({ triggers: "invalid" });
  assert.ok(notJson.refusal.includes("triggers.json") && !notJson.refusal.includes(notJson.dir), notJson.refusal);
  assert.deepEqual([judged({ triggers: "unreadable" }).unread, notJson.unread, judged({ triggers: "absent" }).unread], [true, undefined, undefined]);
  assert.equal(dataUnread({ page: "parked", answerer: { state: "ok" }, snapshot: { parked: [] }, parkedChecks: { "gh-1": { refusal: "the triggers file could not be read (EACCES); nothing was queued", unread: true } } }), true);
  assert.equal(dataUnread({ page: "parked", answerer: { state: "ok" }, snapshot: { parked: [] }, parkedChecks: { "gh-1": { refusal: "the triggers file does not load (x); nothing was queued" } } }), false);
  // A project's page: the scoped-limits file and the envelope file, each in the word of its case.
  const projectWith = async (set) => { const deps = on({}); set(deps.paths, deps.paths.triggersPath.slice(0, deps.paths.triggersPath.lastIndexOf("/"))); return (await drawn("project", "id=web", deps, "operator")).words; };
  const { writeFileSync: write, chmodSync: chmod } = await import("node:fs");
  const limits = (how) => projectWith((paths, dir) => { paths.scopedLimitsPath = `${dir}/scoped-limits.json`; if (how !== "absent") write(paths.scopedLimitsPath, how === "invalid" ? "{ not json" : JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 10 }] })); if (how === "unreadable") chmod(paths.scopedLimitsPath, 0o000); });
  assert.ok((await limits("invalid")).includes("The scoped-limits file does not load.") && !(await limits("invalid")).includes("The scoped-limits file could not be read."));
  assert.ok((await limits("unreadable")).includes("The scoped-limits file could not be read."));
  for (const how of ["absent", "read"]) assert.ok(!/The scoped-limits file (?:does not load|could not be read|does not exist)\./.test(await limits(how)), how);
  const envelope = (how) => projectWith((paths, dir) => { paths.envelopeFile = `${dir}/envelope.json`; if (how !== "absent") write(paths.envelopeFile, "{ not json"); });
  assert.ok((await envelope("absent")).includes("The envelope file does not exist. Run pi-dispatch doctor for the reason.") && (await envelope("absent")).includes("not known: the envelope file does not exist"));
  assert.ok((await envelope("invalid")).includes("The envelope file does not load. Run pi-dispatch doctor for the reason.") && !(await envelope("invalid")).includes("could not be read. Run pi-dispatch doctor"));
  assert.equal(answer({}), "the triggers file has no github comment trigger, so the receiver would not route a reply either");
});

test("a key an agent's copy does not hold is not a read that failed: an unknown run id is not found for every role, and a healthy host's slots say what is not known", async () => {
  // A run id nothing holds, with every place read: 404, whoever asks. An agent's copy of the data holds no transcript
  // and no progress, and a page that judged the places from it answered 503 on a healthy, empty deployment.
  for (const role of ["operator", "viewer", "agent"]) {
    for (const redis of [healthy(), healthy(HOST)]) {
      const none = await drawn("run", "id=gh-404", consoleOn({ redis, records: [RUN] }), role);
      assert.deepEqual([none.status, none.data.runPlaces], [404, { shown: false, unread: [] }], role);
      assert.ok(!none.words.includes("could not read"), role);
    }
    // A place that truly could not be read is still said, by name, to each of them: 503.
    for (const [place, key] of [["the run's progress", /^run:progress:/], ["the live transcript", /^run:live:/]]) {
      const untold = await drawn("run", "id=gh-404", consoleOn({ redis: failingKey(healthy(HOST), key), records: [RUN] }), role);
      assert.deepEqual([untold.status, untold.data.runPlaces], [503, { shown: false, unread: [place] }], `${role}: ${place}`);
      assert.ok(untold.words.includes(`but this page could not read ${place}, so it cannot say whether the run exists`), `${role}: ${place}`);
    }
    // And a run that is there is a run.
    assert.equal((await drawn("run", "id=gh-1", consoleOn({ redis: healthy(HOST), records: [RUN] }), role)).status, 200, role);
  }
  // A host's slots: why they are not drawn, by its cause. One sentence said "this host is late or its running-job list
  // was not read whole" of a healthy host on an agent's page, whose copy of the row held no slot count. Since issue
  // #1073 the copy holds it, so an agent's healthy host is drawn as an operator's is.
  const row = (over) => registryKeys({ build3: { version: "5.4.2", image: "pi-job:latest", concurrency: "2", pid: "1", beatAt: String(Date.now() - 2_000), startedAt: String(NOW - 3_600_000), jobs: "[]", jobsMore: "0", ...over } });
  const slots = async (keys, role) => (await drawn("host", "name=build3", consoleOn({ redis: healthy(keys), records: [RUN] }), role)).words;
  const WHY = { count: "Free slots are not known: its slot count is not known here.", late: "Free slots are not known: this host is late.", list: "Free slots are not known: its running-job list was not published whole." };
  const said = (words) => Object.entries(WHY).filter(([, sentence]) => words.includes(sentence)).map(([why]) => why);
  assert.deepEqual(said(await slots(HOST, "operator")), [], "an operator's healthy host: its slots are drawn");
  assert.deepEqual(said(await slots(HOST, "viewer")), []);
  assert.deepEqual(said(await slots(HOST, "agent")), [], "an agent's copy holds the slot count (issue #1073): its slots are drawn");
  // A row whose slot count is no whole number is the one case left of the "count" sentence, for every role.
  for (const role of ["operator", "agent"]) assert.deepEqual(said(await slots(row({ concurrency: "two" }), role)), ["count"], role);
  for (const role of ["operator", "agent"]) {
    assert.deepEqual(said(await slots(row({ beatAt: String(Date.now() - 300_000) }), role)), ["late"], role);
    for (const over of [{ jobsMore: "3" }, { jobs: "{ not json" }]) {
      const words = await slots(row(over), role);
      assert.deepEqual(said(words), ["list"], `${role} ${JSON.stringify(over)}`);
      assert.ok(words.includes("The occupied slot count is not known: the host's job list was not published whole."), role);
    }
  }
  for (const role of ["operator", "viewer", "agent"]) assert.ok(!/was not read whole|this host is late or/.test(await slots(HOST, role)), role);
});
