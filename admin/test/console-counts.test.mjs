// A count is bare only over a list that was read whole (issue #988), over the real reader and real files: the loader,
// the fleet reader and the services are the console's own (`helpers/real-console.mjs`), on a mirror that holds what a
// case says.
//
// `/triggers` counted a rule's runs over this host's files and the fleet's NEWEST 50 runs, and said the count bare
// while the mirror held more: 41 runs of 65. The fleet's side is now the snapshot's wide window, which says of itself
// whether it holds every run both sides have, and a count is "at least" wherever it does not. And one rule says which
// records are a trigger's, so the three pages that count them agree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mirrorUnread as commonMirrorUnread, shellsShort } from "../src/console/panels/common.mjs";
import { mirrorAnswered, mirrorStateOf, mirrorUnread } from "../src/mirror-words.mjs";
import { WIDE_RUNS, WIDE_RUNS_CUT_TEXT } from "../src/read-model.mjs";
import { consoleOn, drawn, failing, healthy, iso, mirroring, HOST, RUN } from "./helpers/real-console.mjs";

/** A run the label rule (row 1 of the helper's triggers file) started `ago` ms back, metered at half a dollar. */
const labelRun = (jobId, ago, over = {}) => ({ ...RUN, jobId, triggerIndex: 0, triggerType: "label", startedAt: iso(ago + 30_000), endedAt: iso(ago), provider: "provider", model: "model", tokens: { input: 1, output: 1, total: 2, cost: 0.5, metered: true }, ...over });
/** `n` of them by another host, which the fleet's mirror alone holds; and `n` by this host, as its own files. */
const far = (n) => Array.from({ length: n }, (_, k) => labelRun(`far-${k}`, 600_000 + k * 20_000, { host: "build7" }));
const near = (n) => Array.from({ length: n }, (_, k) => labelRun(`near-${k}`, 60_000 + k * 20_000));
const usd = (n) => (n * 0.5).toFixed(2);

test("/triggers, a trigger's page and a project's page count every run of a rule the mirror holds: 49, 50, 51, 99, 100 and 101 runs, with and without this host's own", async () => {
  for (const local of [0, 5]) {
    for (const n of [49, 50, 51, 99, 100, 101]) {
      const deps = consoleOn({ redis: mirroring(far(n)), records: near(local) });
      const where = `${n} in the mirror, ${local} of this host`;
      const list = await drawn("triggers", "", deps, "operator");
      assert.deepEqual([list.data.snapshot.recordsWhole, list.data.snapshot.recordDetails.size, list.data.snapshot.runs.length], [true, n + local, Math.min(50, n + local)], `${where}: the window holds them all, and the newest list 50 at most`);
      assert.deepEqual([list.data.triggerList.rows[0].stats.runs30d, list.data.triggerList.rows[0].stats.incomplete, list.data.triggerList.rows[0].stats.unread], [n + local, false, false], where);
      assert.ok(list.words.includes(` ${n + local} runs in 30 days · $${usd(n + local)} this UTC week`), `${where}: ${list.words.match(/[^.]{0,30}runs in 30 days[^.]{0,60}/)?.[0]}`);
      assert.ok(list.words.includes(`$${usd(n + local)} attributed to these rules ${n + local} run records since`), where);
      assert.ok(!/at least|lower bounds|unknown runs/.test(list.words), `${where}: nothing is a floor`);
      // The trigger's own page counts the same window: every one of them ran inside the last 24 hours.
      const page = await drawn("trigger", "index=0", deps, "operator");
      assert.equal(page.data.triggerDetail.count24h, n + local, where);
      assert.ok(page.words.includes(` ${n + local} runs in the last 24 hours · $${usd(n + local)} metered spend`), `${where}: ${page.words.match(/[^.]{0,20}in the last 24 hours[^.]{0,40}/)?.[0]}`);
      assert.ok(!page.words.includes("at least") && page.data.triggerDetail.historyIncomplete === false, where);
      // And so does the project's page, over its own read of the fleet's day.
      const project = await drawn("project", "id=web", deps, "operator");
      assert.deepEqual([project.data.projectView.triggers.map((t) => [t.index, t.count]), project.data.projectView.historyIncomplete], [[[0, n + local]], false], where);
      assert.match(project.words, new RegExp(`Trigger 1 .{0,60} ${n + local} runs `), where);
    }
  }
});

test("at the window's bound a count is a floor and says why; one run below it the count is itself", async () => {
  const below = await drawn("triggers", "", consoleOn({ redis: mirroring(far(WIDE_RUNS - 1)) }), "operator");
  assert.deepEqual([below.data.snapshot.recordsWhole, below.data.triggerList.rows[0].stats.runs30d, below.data.triggerList.rows[0].stats.incomplete], [true, WIDE_RUNS - 1, false]);
  assert.ok(below.words.includes(` ${WIDE_RUNS - 1} runs in 30 days`) && !/at least|lower bounds/.test(below.words));
  // At the bound a read cannot tell a full answer from a cut one, and past it the list is cut: neither is whole.
  for (const [n, local] of [[WIDE_RUNS, 0], [WIDE_RUNS + 1, 0], [WIDE_RUNS - 1, 5]]) {
    const cut = await drawn("triggers", "", consoleOn({ redis: mirroring(far(n)), records: near(local) }), "operator");
    const where = `${n} in the mirror, ${local} of this host`;
    assert.deepEqual([cut.data.snapshot.recordsWhole, cut.data.triggerList.rows[0].stats.incomplete, cut.data.triggerList.rows[0].stats.unread], [false, true, false], where);
    assert.ok(cut.words.includes(` at least ${WIDE_RUNS} runs in 30 days`), where);
    assert.ok(cut.words.includes(`Counts and spend are lower bounds: ${WIDE_RUNS_CUT_TEXT}.`), `${where}: the one clause that names the cause`);
  }
  // A mirror that did not answer is the other way of being short, and says so: a count is a floor, a zero not known.
  const unread = await drawn("triggers", "", consoleOn({ redis: failing(mirroring(far(60)), ["zrevrangebyscore"]), records: near(5) }), "operator");
  assert.deepEqual([unread.data.triggerList.rows[0].stats.runs30d, unread.data.triggerList.rows[0].stats.unread], [5, true]);
  assert.ok(unread.words.includes(" at least 5 runs in 30 days") && unread.words.includes("Counts and spend are lower bounds: a side of the fleet's run records could not be read."));
  const none = await drawn("triggers", "", consoleOn({ redis: failing(mirroring(far(60)), ["zrevrangebyscore"]) }), "operator");
  assert.ok(none.words.includes("unknown runs in 30 days") && !none.words.includes(" 0 runs in 30 days"));
  // Read whole and holding none: 0, on a single host and on a fleet.
  for (const redis of [healthy(HOST), healthy(), mirroring([{ ...RUN, jobId: "other", host: "build7" }])]) {
    const empty = await drawn("triggers", "", consoleOn({ redis }), "operator");
    assert.ok(empty.words.includes(" 0 runs in 30 days · $0 this UTC week") && !/at least|lower bounds|unknown runs/.test(empty.words));
  }
});

test("one history, three pages: /triggers, a trigger's own page and a project's page count the same runs of each trigger", async () => {
  const triggers = { triggers: [
    { on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } },
    { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/web", flow: "tidy", task: "Sweep." } },
  ] };
  const cronRun = (k) => labelRun(`repeat:nightly:${Date.parse(iso(900_000 + k * 60_000))}`, 900_000 + k * 60_000, { kind: "local", target: "local:/srv/web", flow: "tidy", triggerIndex: undefined, triggerType: undefined });
  // What is no run of either rule, each in a way one of the three pages once took for one: a row number whose type is
  // another's (the rows were renumbered), a row number on a local run that no cron fired, and a cron's id on a forge run.
  const decoys = [
    labelRun("renumbered", 120_000, { triggerType: "comment" }),
    labelRun("local-with-a-row", 150_000, { kind: "local", target: "local:/srv/web", triggerIndex: 1, triggerType: undefined }),
    labelRun("repeat:nightly:1", 180_000, { triggerIndex: undefined, triggerType: undefined }),
  ];
  const deps = () => consoleOn({ redis: mirroring(far(4)), records: [...near(3), cronRun(0), cronRun(1), ...decoys], triggers });
  const list = await drawn("triggers", "", deps(), "operator");
  const rows = Object.fromEntries(list.data.triggerList.rows.map((row) => [row.trigger.index, row.stats.runs30d]));
  assert.deepEqual(rows, { 0: 7, 1: 2 }, "/triggers");
  const counts = [];
  for (const index of [0, 1]) counts.push((await drawn("trigger", `index=${index}`, deps(), "operator")).data.triggerDetail.count24h);
  assert.deepEqual(counts, [7, 2], "each trigger's own page");
  const project = await drawn("project", "id=web", deps(), "operator");
  assert.deepEqual(Object.fromEntries(project.data.projectView.triggers.map((t) => [t.index, t.count])), { 0: 7, 1: 2 }, "the project's page");
  assert.match(project.words, /Trigger 1 .{0,60} 7 runs .{0,80}Trigger 2 .{0,60} 2 runs /);
  // The project's page counts its own runs, twelve of them, of which three are no trigger's.
  assert.equal(project.data.projectView.runs24h.total, 12);
});

test("the mirror's word has one table and one rule: an operator's words and an agent's are read alike, and a cut is not unread", async () => {
  const table = { ok: "read", bounded: "read", truncated: "cut", off: "off", "unreachable (Command timed out)": "unread", unreachable: "unread", degraded: "unread" };
  for (const [word, state] of Object.entries(table)) {
    assert.equal(mirrorStateOf(word), state, word);
    assert.deepEqual([mirrorUnread(word), mirrorAnswered(word), commonMirrorUnread(word)], [state === "unread", state === "read" || state === "cut", state === "unread"], word);
  }
  for (const none of [undefined, null, 7, {}]) assert.deepEqual([mirrorStateOf(none), mirrorUnread(none), mirrorAnswered(none)], [null, false, false]);
  // On the real reader: the runs page's foot names the hosts it read through the mirror, for every role. An agent's
  // copy of the word is "bounded", and a foot that knew "ok" alone lost the line there.
  for (const role of ["operator", "viewer", "agent"]) {
    const runs = await drawn("runs", "", consoleOn({ redis: mirroring(far(1)), records: near(1) }), role);
    assert.equal(mirrorStateOf(runs.data.runsPage.mirror), "read", `${role}: ${runs.data.runsPage.mirror}`);
    assert.ok(runs.words.includes("2 runs, read from 2 hosts through the fleet's run mirror."), `${role}: ${runs.words.match(/\d+ runs?, [^.]{0,80}\./)?.[0]}`);
    assert.deepEqual([runs.pill, runs.marked], [false, false], role);
    const off = await drawn("runs", "", consoleOn({ redis: healthy(HOST), records: near(1) }), role);
    assert.ok(!off.words.includes("through the fleet's run mirror") && off.pill === false, `${role}: a mirror that is off`);
  }
});

test("a refused run's count is a floor over a window that ended inside the day, and says no read failed; the open shells' rule holds for a view that says no reason", async () => {
  // A day with more runs than the wide window holds: the window ends inside the day, so the count of a reason is a
  // floor (`windowFloor`), with no word of a read that failed, since none did.
  const day = Array.from({ length: WIDE_RUNS }, (_, k) => labelRun(`day-${k}`, 600_000 + k * 20_000, { host: "build7" }));
  const refused = { ...RUN, jobId: "gh-2", outcome: "policy", reason: "job-image-missing", tokens: null, exitCode: null, budgetReserved: false };
  const cut = await drawn("run", "id=gh-2", consoleOn({ redis: mirroring(day), records: [refused] }), "operator");
  assert.deepEqual([cut.data.runsWindow.floor, cut.data.runsWindow.partial], [true, false]);
  assert.match(cut.words, /Same reason in the last 24 hours at least 1 Newest doctor result/);
  assert.ok(!cut.words.includes("part of the run history could not be read"));
  // One run fewer and the window holds the whole day: the count is itself.
  const whole = await drawn("run", "id=gh-2", consoleOn({ redis: mirroring(day.slice(2)), records: [refused] }), "operator");
  assert.deepEqual([whole.data.runsWindow.floor, whole.data.runsWindow.partial], [false, false]);
  assert.match(whole.words, /Same reason in the last 24 hours 1 Newest doctor result/);
  // The open shells behind a run's Workspace row, by what the two reads say of themselves. A gateway view that says
  // it is partial and gives no reason (no `unread`, `more` or `unreadable`) is taken as unread: nothing says it was read.
  const gateways = (over) => ({ browserGateways: { enabledHosts: ["build3"], sessions: [], partial: true, ...over } });
  assert.equal(shellsShort(gateways({})), "unread", "partial, and no word of why");
  assert.equal(shellsShort(gateways({ unread: true, more: 4 })), "unread");
  assert.equal(shellsShort(gateways({ more: 4 })), "cut", "a full list, with no `unread` key at all");
  assert.equal(shellsShort(gateways({ unread: false, unreadable: 1 })), "rows");
  assert.equal(shellsShort({ browserGateways: { enabledHosts: [], sessions: [], partial: false, more: 4 } }), null, "a view that is whole");
  assert.equal(shellsShort({ workspace: { sessionsUnknown: true, sessionsMore: 1 }, ...gateways({ unread: true }) }), "unread", "either read unread is unread");
});
