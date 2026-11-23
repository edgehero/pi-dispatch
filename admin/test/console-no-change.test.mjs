// A page that could not read the deployment offers no change (issue #988), over the real reader and real files: the
// loader, the fleet reader and the services are the console's own (`helpers/real-console.mjs`), on a client or a queue
// that fails where a state says so.
//
// The rule is about what a change rests on. An edit is previewed against the fleet and its queues, so a page whose
// snapshot failed (`readFailed` with no snapshot) draws no form: it says so, and that the file can still be changed by
// hand. A page that read the snapshot offers every form it has, whatever else went unread: the run history alone
// failing takes nothing away, since no change on these pages is judged by it. The kill switch is not under the rule.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadPageData, parsePageQuery } from "../src/console/pages.mjs";
import { deploymentUnread } from "../src/console/panels/common.mjs";
import { noChangeText } from "../src/console/panels/config-ui.mjs";
import { TRIGGER_GETS_WORDS as W } from "../src/trigger-gets-view.mjs";
import { downQueue, downRedis } from "./helpers/fleet-reader-fakes.mjs";
import { consoleOn, drawn, failing, healthy, mirroring, rolesOf, FAR, HOST, RUN, STATES } from "./helpers/real-console.mjs";

const INSTRUCTIONS = "Keep the diff small.";
const TASK = "Sweep the logs.";
/**
 * A triggers file whose first two rows carry the texts only an operator reads, a row's instructions and a local row's
 * task, and whose third names an MCP server.
 */
const TRIGGERS = { triggers: [
  { on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix", instructions: INSTRUCTIONS } },
  { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "tidy", task: TASK } },
  { on: { type: "cron", id: "weekly", pattern: "0 4 * * 1" }, run: { kind: "local", folder: "/srv/web", flow: "tidy", task: "Tidy.", mcp: ["linear"] } },
] };
/** A run the first row started, so a project's page has a trigger to count. */
const STARTED = { ...RUN, triggerIndex: 0, triggerType: "label" };
/** The pages that offer a change to the files, each with the file its sentence names. */
const CHANGE_PAGES = [["trigger", "index=0", "triggers file"], ["trigger", "index=1", "triggers file"], ["trigger-add", "", "triggers file"], ["triggers", "", "triggers file"], ["project", "id=web", "projects file"], ["models", "", "triggers file"]];
/** What an operator is offered where every read answers: each page's change forms by their action, and the Add button. */
const OFFERED = { "trigger?index=0": ["trigger-delete", "trigger-edit", "trigger-environment-edit"], "trigger?index=1": ["trigger-delete", "trigger-edit", "trigger-environment-edit"], "trigger-add?": ["trigger-add", "trigger-add"], "triggers?": [], "project?id=web": ["project-delete", "project-edit"], "models?": ["model-role-edit"] };
/** How often a page says it offers no change: once where each form, or group of forms, would have been. */
const SAID = { trigger: 2, "trigger-add": 1, triggers: 1, project: 2, models: 1 };
const actionsOf = (whole) => [...whole.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]).sort();
const addButton = (whole) => /<a class="btn btn--primary" href="\/config\/trigger-add">/.test(whole);
const on = (state) => consoleOn({ records: [STARTED], ...state, triggers: TRIGGERS });
const DOWN = () => ({ redis: downRedis(), queue: downQueue() });
/** The fleet's mirror alone not answering: the registry, the queues and the files are read. */
const MIRROR_ONLY = () => ({ redis: failing(mirroring([FAR]), ["zrevrangebyscore"]) });

test("a page that could not read the deployment offers no change and says so; one that read it never says that: every state, page and role", async () => {
  const seen = { unread: 0, read: 0 };
  for (const [name, make] of STATES) {
    for (const [page, qs, file] of CHANGE_PAGES) {
      for (const role of rolesOf(page)) {
        const got = await drawn(page, qs, on(make()), role);
        const where = `${name} | /${page}?${qs} for ${role}`;
        const unread = deploymentUnread({ data: got.data });
        assert.equal(unread, got.data.readFailed === true && (got.data.snapshot ?? null) === null, where);
        seen[unread ? "unread" : "read"] += 1;
        // Only an operator is ever offered a change.
        if (role !== "operator") assert.deepEqual([actionsOf(got.whole), addButton(got.whole)], [[], false], where);
        if (unread) {
          assert.deepEqual([actionsOf(got.whole), addButton(got.whole)], [[], false], `${where}: no form over a deployment that was not read`);
          assert.equal(got.words.split(noChangeText(file)).length - 1, role === "operator" ? SAID[page] : 0, `${where}: said to the one who would have been offered it, where each form was`);
        } else {
          assert.ok(!got.words.includes("offers no change"), `${where}: a page that read the deployment does not say it offers none`);
        }
      }
    }
  }
  assert.ok(seen.unread >= 5 * CHANGE_PAGES.length && seen.read > seen.unread, `both directions are held: ${JSON.stringify(seen)}`);
});

test("on a healthy deployment, on a healthy empty one and with the run mirror alone failing, an operator is offered every form", async () => {
  for (const [name, state] of [["every read answers", { redis: healthy(HOST) }], ["a Valkey that holds nothing, and no run", { redis: healthy(), records: [] }], ["the run mirror alone does not answer", MIRROR_ONLY()]]) {
    for (const [page, qs] of CHANGE_PAGES) {
      const got = await drawn(page, qs, on(state), "operator");
      const where = `${name} | /${page}?${qs}`;
      assert.deepEqual(actionsOf(got.whole), OFFERED[`${page}?${qs}`], where);
      assert.equal(addButton(got.whole), page === "triggers", where);
      assert.ok(!got.words.includes("offers no change") && got.data.readFailed !== true, where);
    }
  }
  // The mirror state is what it says: the snapshot was read, and the history is the one thing that was not.
  const mirror = await drawn("trigger", "index=0", on(MIRROR_ONLY()), "operator");
  assert.match(mirror.data.snapshot.runMirror, /^unreachable/);
  // A deployment that could not be read: the same pages, no form, in each role's own words.
  for (const [page, qs] of CHANGE_PAGES) {
    const got = await drawn(page, qs, on(DOWN()), "operator");
    assert.deepEqual([actionsOf(got.whole), addButton(got.whole), got.data.snapshot], [[], false, null], `/${page}?${qs}`);
  }
});

test("the kill switch is not under the rule: neither Fleet nor the overview asks whether a change is offered", () => {
  const panels = new URL("../src/console/panels/", import.meta.url);
  for (const file of ["fleet.mjs", "overview.mjs"]) {
    const source = readFileSync(new URL(file, panels), "utf8");
    assert.ok(/"fleet-pause"/.test(source) && /"fleet-resume"/.test(source), `${file} draws the kill switch`);
    assert.ok(!/changesOffered|deploymentUnread|noChangeText/.test(source), `${file}: Pause and Resume are offered whatever the page could read`);
  }
});

test("an operator's trigger page with no snapshot reads the instructions and the task from the triggers file; a viewer's, an agent's and a live load do not", async () => {
  const text = { 0: INSTRUCTIONS, 1: TASK };
  for (const index of [0, 1]) {
    const operator = await drawn("trigger", `index=${index}`, on(DOWN()), "operator");
    assert.deepEqual(operator.data.fileTexts, { instructions: { 0: INSTRUCTIONS }, tasks: { 1: TASK, 2: "Tidy." } });
    assert.ok(operator.words.includes(text[index]) && !operator.words.includes("Instructions could not be read") && !operator.words.includes("Task could not be read"), `row ${index + 1}: the text is the file's`);
    // The file views every role's page is drawn from keep dropping the texts: they ride beside them, for this page alone.
    assert.ok(!JSON.stringify(operator.data.files).includes(INSTRUCTIONS) && !JSON.stringify(operator.data.files).includes(TASK));
    for (const role of ["viewer", "agent"]) {
      const other = await drawn("trigger", `index=${index}`, on(DOWN()), role);
      assert.ok(!Object.hasOwn(other.data, "fileTexts") && !other.words.includes(INSTRUCTIONS) && !other.words.includes(TASK), `${role}, row ${index + 1}`);
    }
    // Where the snapshot is read the texts are its own, and the loader reads no file for them.
    const live = await drawn("trigger", `index=${index}`, on({ redis: healthy(HOST) }), "operator");
    assert.ok(!Object.hasOwn(live.data, "fileTexts") && live.words.includes(text[index]), `row ${index + 1}, every read answering`);
  }
  // No other page takes the texts, and neither does a load the live stream makes.
  const query = parsePageQuery("trigger", "index=0").query;
  assert.ok(!Object.hasOwn(await loadPageData("trigger", query, on(DOWN()), { name: "ada", role: "operator", live: true }), "fileTexts"), "a live load");
  assert.ok(!Object.hasOwn((await drawn("triggers", "", on(DOWN()), "operator")).data, "fileTexts"), "another page");
  // A file nobody may read gives no text and no row: the page says that of the file, in its own word.
  const shut = await drawn("trigger", "index=1", on({ ...DOWN(), files: { triggers: "unreadable" } }), "operator");
  assert.deepEqual(shut.data.fileTexts, { instructions: {}, tasks: {} });
  assert.ok(shut.words.includes("What starts it The triggers file could not be read.") && !shut.words.includes(TASK) && !shut.words.includes("Trust model"));
});

test("the trigger card's image, extensions and MCP rows say the hosts were not read; hosts that were read and are none keep their own words", async () => {
  const NO_HOST = [W.noExtensionsKnown, W.noServersKnown, "each host’s own PI_JOB_IMAGE; no host says which"];
  const UNREAD = [W.extensionsUnread, W.serversUnread, W.imageUnread];
  const said = (got, sentences) => sentences.map((sentence) => got.words.includes(sentence));
  // Valkey down: the doctor runs and the live hosts could not be read. The local row has no forge server, so its MCP
  // row is the sentence; the same for a viewer, whose card is the same view.
  for (const role of ["operator", "viewer"]) {
    const down = await drawn("trigger", "index=1", on(DOWN()), role);
    assert.deepEqual([said(down, UNREAD), said(down, NO_HOST)], [[true, true, true], [false, false, false]], role);
    // A server the row names: how it is defined is the hosts' to say, and they were not read.
    const named = await drawn("trigger", "index=2", on(DOWN()), role);
    assert.deepEqual(said(named, [W.serverUnread, "no host says how it is defined"]), [true, false], role);
  }
  // Every read answering, and no host: "no host says" is the read's answer.
  const none = await drawn("trigger", "index=1", on({ redis: healthy() }), "operator");
  assert.deepEqual([said(none, UNREAD), said(none, NO_HOST)], [[false, false, false], [true, true, true]]);
  assert.deepEqual(said(await drawn("trigger", "index=2", on({ redis: healthy() }), "operator"), [W.serverUnread, "no host says how it is defined"]), [false, true]);
});

test("a run mirror that did not answer makes a trigger's and a project's counts floors and its history unread; a mirror that answered, or is off, does not", async () => {
  // The mirror did not answer: this host's one run is a floor, and so is its spend.
  const cut = await drawn("trigger", "index=0", on(MIRROR_ONLY()), "operator");
  assert.deepEqual([cut.data.triggerDetail.historyIncomplete, cut.data.triggerDetail.historyUnread, cut.data.triggerDetail.count24h], [true, true, 1]);
  assert.match(cut.words, /at least 1 run in the last 24 hours · at least \$0\.00 metered spend/);
  // With no run found the card and its table say the history was not read, never that no runs were found.
  const none = await drawn("trigger", "index=1", on(MIRROR_ONLY()), "operator");
  assert.match(none.words, /at least 0 runs in the last 24 hours/);
  assert.ok(none.words.split(W.historyUnread).length - 1 >= 2 && !none.words.includes("No runs were found in the available history."), "what its jobs get, and the runs it started");
  // A mirror that stops answering between two loads: the day's fold is kept from the load before, read whole, and
  // the list beside it is the one read that says the mirror did not answer. The counts are floors all the same.
  const mirror = { down: false };
  const stopping = on({ redis: new Proxy(mirroring([FAR]), { get: (client, key) => (key === "zrevrangebyscore" && mirror.down ? () => Promise.reject(new Error("Command timed out")) : client[key]) }) });
  const before = await drawn("trigger", "index=1", stopping, "operator");
  assert.deepEqual([before.data.snapshot.runMirror, before.data.triggerDetail.historyIncomplete], ["ok", false]);
  mirror.down = true;
  const after = await drawn("trigger", "index=1", stopping, "operator");
  assert.match(after.data.snapshot.runMirror, /^unreachable/);
  assert.equal(after.data.snapshot.parkedUnreachable ?? null, null, "the fold is the one read before");
  assert.deepEqual([after.data.triggerDetail.historyIncomplete, after.data.triggerDetail.historyUnread], [true, true]);
  assert.match(after.words, /at least 0 runs in the last 24 hours · at least \$0\.00 metered spend/);
  const project = await drawn("project", "id=web", on(MIRROR_ONLY()), "operator");
  assert.equal(project.data.projectView.historyIncomplete, true);
  assert.match(project.words, /Trigger 1 .{0,80}at least 1 run /);
  assert.match(project.words, /github:acme\/web repository at least 1 run this week/, "a member's count agrees with its noun");
  // A mirror that answered, and one that is off: the counts are themselves.
  for (const [name, state] of [["the mirror answered", { redis: mirroring([FAR]) }], ["the mirror is off", { redis: healthy(HOST) }]]) {
    const whole = await drawn("trigger", "index=0", on(state), "operator");
    assert.deepEqual([whole.data.triggerDetail.historyIncomplete, whole.data.triggerDetail.historyUnread], [false, false], name);
    assert.match(whole.words, / 1 run in the last 24 hours · \$0\.00 metered spend/, name);
    assert.ok(!whole.words.includes(W.historyUnread) && !/at least 1 run in the last 24 hours/.test(whole.words), name);
    const page = await drawn("project", "id=web", on(state), "operator");
    assert.match(page.words, /Trigger 1 .{0,80} 1 run /, name);
    assert.ok(!/Trigger 1 .{0,80}at least/.test(page.words), name);
    const empty = await drawn("trigger", "index=1", on(state), "operator");
    assert.ok(empty.words.includes("No runs were found in the available history.") && / 0 runs in the last 24 hours/.test(empty.words) && !/at least 0 runs/.test(empty.words), name);
  }
});
