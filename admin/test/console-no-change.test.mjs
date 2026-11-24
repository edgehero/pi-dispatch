// A page that could not read the deployment offers no change (issue #988), over the real reader and real files: the
// loader, the fleet reader and the services are the console's own (`helpers/real-console.mjs`), on a client or a queue
// that fails where a state says so.
//
// The rule is about what the page can show. A page whose snapshot failed (`readFailed` with no snapshot) cannot show
// what a change would meet, the hosts that read the file, what runs and what waits, so it draws no form: it says so,
// in the words of the cause, and that the file can still be changed by hand. A page that read the snapshot offers
// every form it has, whatever else went unread: the run history alone failing takes nothing away. The rule is the
// page's alone (the routes answer as before), and the kill switch is not under it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEPLOYMENT_UNREAD_WORDS, deploymentUnread, deploymentUnreadWhy, noChangeText } from "../src/console/panels/common.mjs";
import { PAGES, loadPageData, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { allocationUnread, drawSpend } from "./helpers/spend-goldens.mjs";
import { TRIGGER_GETS_WORDS as W } from "../src/trigger-gets-view.mjs";
import { downQueue, downRedis, quietQueue } from "./helpers/fleet-reader-fakes.mjs";
import { consoleOn, drawn, failing, failingKey, healthy, mirroring, rolesOf, wordsOf, FAR, HOST, RUN, STATES } from "./helpers/real-console.mjs";

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
const between = (words, from, to) => { const at = words.indexOf(from); const end = at < 0 ? -1 : words.indexOf(to, at); return at < 0 ? "" : words.slice(at, end < 0 ? at + 600 : end); };
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
          // In the words of the cause (`deploymentUnreadWhy`): the sentence of another cause is not on the page.
          assert.equal(got.words.split(noChangeText({ data: got.data }, file)).length - 1, role === "operator" ? SAID[page] : 0, `${where}: said to the one who would have been offered it, where each form was`);
          assert.equal(got.words.split("offers no change. The").length - 1, role === "operator" ? SAID[page] : 0, `${where}: and in no other words`);
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

test("Fire now is offered only where its check read what it rests on: the schedule in the queue, the triggers file, and a deployment that was read", async () => {
  // The real planner over the real triggers file, on the queue this console is on. A cron trigger of a folder this
  // host has: the row the check can fire.
  const fireable = { triggers: [TRIGGERS.triggers[0], { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: process.cwd(), flow: "tidy", task: TASK } }] };
  const page = async (state, role = "operator", files = {}) => {
    const got = await drawn("trigger", "index=1", consoleOn({ records: [STARTED], redis: healthy(HOST), ...state, triggers: fireable, files }), role);
    return { ...got, fire: actionsOf(got.whole).includes("trigger-fire"), check: got.data.triggerFireCheck ?? null };
  };
  const queueWith = (getJobScheduler) => (connection, opts) => ({ ...quietQueue()(connection, opts), getJobScheduler });
  // Every read answered: Fire now is offered, with its form.
  const well = await page({});
  assert.deepEqual([well.fire, well.check.plan.schedulerId, well.words.includes("Fire now")], [true, "nightly", true]);
  // The schedule could not be read: no form, and the page says the check could not be made.
  const unread = await page({ queue: queueWith(async () => { throw new Error("Command timed out"); }) });
  assert.deepEqual([unread.fire, Object.keys(unread.check)], [false, ["unreachable"]]);
  assert.ok(unread.words.includes("Fire now could not be checked: the deployment's queue did not answer."));
  // The queue holds no schedule for it: refused, in the planner's words.
  const none = await page({ queue: queueWith(async () => null) });
  assert.deepEqual([none.fire, none.words.includes("This cron trigger's schedule is not in this deployment's queue. Nothing was queued.")], [false, true]);
  // A deployment that could not be read offers no change, whatever a check answers.
  const down = await page({ redis: downRedis(), queue: downQueue() });
  assert.deepEqual([down.fire, deploymentUnread({ data: down.data })], [false, true]);
  // A viewer and an agent are offered nothing, and no check is made for them.
  for (const role of ["viewer", "agent"]) assert.deepEqual([(await page({}, role)).fire, (await page({}, role)).check], [false, null], role);
  // The planner's own word for the triggers file, one per case: its "does not load" was said of all three.
  const refusalOf = async (state) => { const deps = consoleOn({ redis: healthy(HOST), triggers: fireable, files: { triggers: state } }); return (await deps.triggerFireCheck(1)).refusal; };
  assert.equal(await refusalOf("absent"), "The triggers file does not exist. Nothing was queued.");
  assert.equal(await refusalOf("unreadable"), "The triggers file could not be read. Nothing was queued.");
  assert.equal(await refusalOf("invalid"), "The triggers file does not load. Run pi-dispatch doctor and fix its named check. Nothing was queued.");
});

/**
 * What a page may draw as a form over a deployment it could not read, each by what names it and why. The list is held
 * here: a form that is not on it fails the walk below, and so does an entry no page draws in any state.
 */
const KILL_SWITCH = "the kill switch: stopping and starting the fleet or one queue is what an operator needs most when the page cannot read it";
const DRAWN_UNREAD = new Map([
  ["data-trigger-check", "the event check on /triggers: it reads the triggers file and changes nothing"],
  ["fleet-pause", KILL_SWITCH], ["fleet-resume", KILL_SWITCH], ["queue-pause", KILL_SWITCH], ["queue-resume", KILL_SWITCH],
]);
/** Every form and action control of a page: a form by its action, else by the attribute that names it. */
const formsOf = (whole) => [...new Set([...[...whole.matchAll(/<form\b[^>]*>/g)].map(([tag]) => tag.match(/data-action="([^"]+)"/)?.[1] ?? tag.match(/\b(data-[a-z-]+)\b/)?.[1] ?? tag), ...[...whole.matchAll(/data-action="([a-z-]+)"/g)].map(([, action]) => action)])];
const QUERIES = { run: "id=gh-1", host: "name=build3", venue: "name=local", trigger: "index=0", project: "id=web" };

test("no page of the console draws a form that changes something over a deployment it could not read: every page of the page table, in every state", { timeout: 240_000 }, async () => {
  const found = new Map(), offered = new Set();
  let unreadPages = 0;
  for (const [name, make] of STATES) {
    for (const page of Object.keys(PAGES)) {
      const got = await drawn(page, QUERIES[page] ?? "", on(make()), "operator");
      const unread = deploymentUnread({ data: got.data });
      if (unread) unreadPages += 1;
      for (const form of formsOf(got.whole)) {
        if (!unread) offered.add(form);
        else if (!found.has(form)) found.set(form, `/${page} | ${name}`);
      }
    }
  }
  assert.ok(unreadPages >= 60, `${unreadPages} pages were drawn over a deployment that was not read`);
  assert.deepEqual([...found].filter(([form]) => !DRAWN_UNREAD.has(form)), [], "a form drawn over a deployment that was not read, and not on the list");
  // The walk sees the forms it must not find: where the deployment was read the same pages draw them.
  for (const form of ["trigger-edit", "trigger-delete", "trigger-environment-edit", "trigger-add", "project-edit", "project-delete", "model-role-edit", "data-trigger-check"]) assert.ok(offered.has(form), `${form} is drawn where the deployment was read`);
  assert.deepEqual([...DRAWN_UNREAD.keys()], ["data-trigger-check", "fleet-pause", "fleet-resume", "queue-pause", "queue-resume"]);
  for (const [form, why] of DRAWN_UNREAD) assert.ok(typeof why === "string" && why.length > 30, form);
});

test("the two pages the rule had missed: Parked's standing answer form, which stood only in the outage, and the budget split's forms", async () => {
  // Parked draws the Standing answers card beside its failure banner, and a deployment with no answer rule draws that
  // card in no other state: its form, which writes the triggers file, stood on Parked only while nothing was read.
  const parked = await drawn("parked", "", on(DOWN()), "operator");
  assert.equal(deploymentUnread({ data: parked.data }), true);
  assert.ok(parked.words.includes("Standing answers") && !formsOf(parked.whole).includes("standing-answer-add"), "the card, and no form");
  assert.equal(parked.words.split(noChangeText({ data: parked.data })).length - 1, 1, "said where the form would be");
  assert.ok(!(await drawn("parked", "", on(DOWN()), "viewer")).words.includes("offers no change"));
  // Where the deployment was read and an answer rule draws the card, its form is there.
  const ruled = { triggers: [TRIGGERS.triggers[0]], answerRules: [{ id: "web", projects: ["web"], flow: "answer" }] };
  const withRules = await drawn("parked", "", consoleOn({ redis: healthy(HOST), records: [STARTED], triggers: ruled }), "operator");
  if (withRules.words.includes("Standing answers")) assert.ok(formsOf(withRules.whole).includes("standing-answer-add") && !withRules.words.includes("offers no change"));
  // The budget split reads no snapshot: its own read says whether the queue answered.
  const SPLIT_FORMS = ["allocation-revert", "envelope-set", "priorities-set"];
  const read = await drawSpend("insights-budget-split");
  assert.deepEqual(SPLIT_FORMS.filter((form) => formsOf(read).includes(form)).length >= 2 && !wordsOf(read).includes("offers no change"), true, "a split that was read: its forms");
  const unread = await drawSpend("insights-budget-split", { payload: allocationUnread() });
  assert.deepEqual(SPLIT_FORMS.filter((form) => formsOf(unread).includes(form)), [], "no form under a split that could not be read");
  assert.ok(wordsOf(unread).includes("The budget split could not be read") && wordsOf(unread).includes("Valkey could not be read, so this page offers no change. The envelope file can still be changed by hand. Reload to try again."));
  const viewer = await drawSpend("insights-budget-split", { role: "viewer", payload: allocationUnread() });
  assert.ok(!wordsOf(viewer).includes("offers no change") && SPLIT_FORMS.every((form) => !formsOf(viewer).includes(form)));
});

test("the sentence is true of its cause: a Valkey that did not answer, one that answered with an error, and a page whose deadline cut the read", async () => {
  assert.deepEqual(DEPLOYMENT_UNREAD_WORDS, { silent: "Valkey could not be read", error: "Valkey answered this page's read with an error", late: "This page could not read the deployment in time" });
  const says = (why, file = "triggers file") => `${DEPLOYMENT_UNREAD_WORDS[why]}, so ${why === "late" ? "it" : "this page"} offers no change. The ${file} can still be changed by hand. Reload to try again.`;
  // Nothing answered.
  const silent = await drawn("trigger", "index=0", on(DOWN()), "operator");
  assert.deepEqual([deploymentUnreadWhy({ data: silent.data }), silent.words.split(says("silent")).length - 1], ["silent", 2]);
  // Valkey answered, with an error (a key of another type): the same rule, and its own words.
  const error = await drawn("trigger", "index=0", on({ redis: failingKey(healthy(HOST), /^budget:/) }), "operator");
  assert.deepEqual([error.data.snapshotFailure, deploymentUnreadWhy({ data: error.data }), error.words.split(says("error")).length - 1, error.words.includes("Valkey could not be read, so this page offers no change")], ["error", "error", 2, false]);
  assert.deepEqual(actionsOf(error.whole), [], "no form either");
  // The page's deadline cut the read of a Valkey that answers late: it could not read the deployment IN TIME.
  // (The snapshot answers a quarter of a second on, whole; the page's deadline here is 40 ms.)
  const slow = on({ redis: healthy(HOST) });
  const late = (...args) => new Promise((resolve, reject) => { setTimeout(() => slow.fleet.snapshot(...args).then(resolve, reject), 250); });
  for (const [page, qs, file] of [["trigger", "index=0", "triggers file"], ["triggers", "", "triggers file"], ["project", "id=web", "projects file"], ["models", "", "triggers file"]]) {
    const query = parsePageQuery(page, new URLSearchParams(qs)).query;
    const data = await loadPageData(page, query, { ...slow, fleet: { ...slow.fleet, snapshot: late, fileViews: slow.fleet.fileViews }, deadline: { ms: 40 } }, { role: "operator" });
    assert.deepEqual([data.snapshot, data.readFailed, data.snapshotFailure, deploymentUnreadWhy({ data })], [null, true, "late", "late"], page);
    const words = wordsOf(String((await renderPage(page, { query, session: { name: "ada", role: "operator" }, data, readOnly: false })).html));
    assert.ok(words.includes(says("late", file)), `${page}: ${words.match(/[^.]{0,60}offers no change[^.]{0,20}/)?.[0]}`);
    assert.ok(!words.includes("Valkey could not be read, so this page offers no change"), `${page}: not said of a Valkey that answered late`);
  }
  // A page that read the deployment has no cause to give.
  assert.equal(deploymentUnreadWhy({ data: (await drawn("trigger", "index=0", on({ redis: healthy(HOST) }), "operator")).data }), null);
});

test("the card that says how a change applies has its own words for a page that could not read the deployment, and never calls a console that takes changes read-only", async () => {
  const how = (got) => between(got.words, "How a change applies", "A person, at the console.");
  const down = await drawn("trigger", "index=0", on(DOWN()), "operator");
  assert.ok(how(down).includes(`No change from this page just now. ${W.unreadHow}`) && !how(down).includes("Read only here") && !down.words.includes(W.readOnly), how(down));
  // A console that takes no change still says that, and a page that read the deployment says how to change it.
  const well = await drawn("trigger", "index=0", on({ redis: healthy(HOST) }), "operator");
  assert.ok(how(well).includes("Change it in place.") && !well.words.includes(W.unreadHow));
  const viewer = await drawn("trigger", "index=0", on(DOWN()), "viewer");
  assert.ok(how(viewer).includes("Read only here.") && !viewer.words.includes(W.unreadHow));
});
