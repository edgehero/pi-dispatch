import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLiveHub } from "../src/console/live.mjs";
import { loadPageData, PAGES, pagePanels, parsePageQuery } from "../src/console/pages.mjs";
import { consoleOn, drawn, failing, failingQueue, FAR, healthy, HOST, mirroring, NOW, pillOf, REFUSED, rolesOf, RUN, saysUnread, saysWhatIsMissing, STATES, unanswered, wordsOf } from "./helpers/real-console.mjs";

/**
 * The live pill agrees with the page (issue #988): it says Not live wherever a panel of the page says "could not be
 * read" of a read the page made, and Live on a page whose reads all answered. The rule is `dataUnread`
 * (panels/common.mjs), and it had no mark for the run history, a run's own reads, the Sandboxes report's parts or a
 * host's history, so the pill said Live over cards that said the history, the transcript or the queue could not be
 * read.
 *
 * Every state here is the REAL loader over the real fleet reader, answer rules, sandbox report and host loads
 * (helpers/real-console.mjs), on a client and queues that answer, hold nothing, or fail one command, and over real
 * files in a temp folder: a mark is tested in the shape its reader gives it, and a sentence is the one the page's own
 * panels draw.
 */

test("a page whose reads all answered: the pill is Live and no panel says could not be read, on a deployment that holds nothing, one with runs, a mirror that is off and a host with no history", async () => {
  const states = [
    ["holds nothing", () => ({ redis: healthy() }), [["runs", ""], ["run", "id=gh-none"], ["sandboxes", ""]]],
    ["a host and runs", () => ({ redis: healthy(HOST), records: [RUN, REFUSED] }), [["runs", ""], ["run", "id=gh-1"], ["run", "id=gh-2"], ["run", "id=gh-none"], ["sandboxes", ""], ["sandboxes", "id=gh-1"], ["host", "name=build3"], ["host", "name=build9"]]],
    ["a host with no history", () => ({ redis: healthy(HOST) }), [["host", "name=build3"]]],
    ["runs and no host", () => ({ redis: healthy(), records: [RUN, REFUSED] }), [["runs", ""], ["run", "id=gh-1"], ["run", "id=gh-2"], ["sandboxes", "id=gh-1"], ["host", "name=build3"]]],
    ["a fleet whose mirror is on", () => ({ redis: mirroring([FAR]), records: [RUN, REFUSED] }), [["runs", ""], ["run", "id=gh-1"], ["run", "id=gh-2"], ["run", "id=gh-9"], ["sandboxes", ""], ["host", "name=build3"], ["host", "name=build7"]]],
  ];
  for (const [label, make, pages] of states) {
    for (const [page, qs] of pages) {
      for (const role of rolesOf(page)) {
        const got = await drawn(page, qs, consoleOn(make()), role);
        const what = `${label}: /${page}?${qs} for ${role}`;
        assert.deepEqual([got.said, saysUnread(got.words)], [[], false], what);
        // A page that is not found draws no pill at all.
        assert.deepEqual([got.pill, got.marked ?? false], [false, false], `${what}: Live`);
        for (const mark of ["readFailed", "deadlineSpent"]) assert.ok(!Object.hasOwn(got.data, mark), `${what}: no ${mark}`);
      }
    }
  }
  // The mirror is off on a single host, and a history read with it off is a whole answer.
  const runs = await drawn("runs", "", consoleOn({ redis: healthy(HOST), records: [RUN] }), "viewer");
  assert.deepEqual([runs.data.runsPage.mirror, runs.data.runsPage.runs.length, runs.data.runsWindow.partial, runs.pill], ["off", 1, false, false]);
  // On, it answers: the page holds both hosts' runs, a run of the other host is read from it, and that host is known
  // by its record though it has no row.
  const fleet = () => consoleOn({ redis: mirroring([FAR]), records: [RUN] });
  const both = await drawn("runs", "", fleet(), "viewer");
  assert.deepEqual([both.data.runsPage.mirror, both.data.runsPage.runs.map((run) => run.jobId).sort(), both.data.runsWindow.partial, both.pill], ["ok", ["gh-1", "gh-9"], false, false]);
  const far = await drawn("run", "id=gh-9", fleet(), "operator");
  assert.deepEqual([far.data.run.record?.host, far.data.childrenIncomplete, far.pill], ["build7", false, false]);
  const gone = await drawn("host", "name=build7", fleet(), "viewer");
  assert.deepEqual([gone.data.host, gone.data.hostHistory.records.length, gone.pill], [null, 1, false]);
  // A refused run on a deployment with no host row: its two cards say that the host has none, which is not a read that
  // failed (they said "could not be read" five times of what was absent).
  const lone = await drawn("run", "id=gh-2", consoleOn({ redis: healthy(), records: [REFUSED] }), "operator");
  for (const absent of ["Heartbeat no live registry row for build3", "Newest doctor result no doctor result published", "Newest failing doctor check no doctor result published", "Venue floor (PI_BACKEND_FLOOR) not known: no live registry row for build3", "Same reason in the last 24 hours 1"]) assert.ok(lone.words.includes(absent), `${absent}: ${lone.words.slice(lone.words.indexOf("Why it was refused"), lone.words.indexOf("Open Fleet"))}`);
  assert.deepEqual([saysUnread(lone.words), lone.pill, lone.marked], [false, false, false]);
});

test("each read of these pages that fails is said by a panel and by the pill, in the shape the real reader gives it", async () => {
  const mirrorDown = () => failing(healthy(HOST), ["zrevrangebyscore"]);
  const cases = [
    // /runs: the mirror is on and does not answer, so the page and the day's window are this host's alone.
    ["runs", "", "viewer", () => ({ redis: mirrorDown(), records: [RUN] }), [/p-runs: .*Other hosts' runs could not be read/, /p-summary: Part of the run history could not be read/], (d) => [/unreachable/.test(d.runsPage.mirror), d.runsWindow.partial]],
    // This host's run files, which no mirror stands in for.
    ["runs", "", "viewer", () => ({ redis: healthy(HOST), logs: "file" }), [/p-runs: .*This host's run history could not be read/, /p-summary: Part of the run history could not be read/], (d) => [typeof d.runsPage.unreachable === "string", d.runsPage.mirror === "off", d.runsWindow.partial]],
    // A run's page: the record this host does not hold, behind a mirror that did not answer.
    ["run", "id=gh-far", "viewer", () => ({ redis: failing(healthy(HOST), ["get"]) }), [/p-outcome: The fleet's run mirror could not be read/, /p-progress: .*The run's progress could not be read/], (d) => [typeof d.run.unreadable, Boolean(d.progress.unreachable)]],
    // The transcript's state.
    ["run", "id=gh-1", "viewer", () => ({ redis: failing(healthy(HOST), ["xlen", "xrevrange", "xrange", "exists"]), records: [RUN] }), [/The live transcript could not be read/], (d) => [Boolean(d.transcript.unreachable)]],
    // The queue's lookup of the job: the chat and the inbox.
    ["run", "id=gh-1", "viewer", () => ({ redis: healthy(HOST), queue: failingQueue(["getJob"]), records: [RUN] }), [/p-chat: .*The queue could not be read/, /p-inbox: .*The run's inbox could not be read/], (d) => [d.chat.unreachable, d.inbox.unreachable]],
    // The search for its children, through the same mirror.
    ["run", "id=gh-1", "operator", () => ({ redis: mirrorDown(), records: [RUN] }), [/p-chain: .*The search for child runs was incomplete: part of the run history could not be read/], (d) => [d.childrenIncomplete]],
    // The open shells behind an operator's Workspace row.
    ["run", "id=gh-1", "operator", () => ({ redis: failing(healthy(HOST), ["time"]), records: [RUN] }), [/p-workspace: .*Some shell or browser status could not be read/], (d) => [d.workspace.sessionsUnknown]],
    // A run refused before it started draws the snapshot too: the hosts, behind a registry that did not answer.
    ["run", "id=gh-2", "operator", () => ({ redis: failing(healthy(HOST), ["smembers"]), records: [REFUSED] }), [/p-why: .*the hosts could not be read/], (d) => [Boolean(d.snapshot.queue.fleetDegraded)]],
    // And its doctor results, behind the same two cards.
    ["run", "id=gh-2", "operator", () => ({ redis: failing(healthy(HOST), ["mget"]), records: [REFUSED] }), [/p-host: .*Newest failing doctor check could not be read/], (d) => [Boolean(d.snapshot.doctor.unreachable)]],
    // Sandboxes: the report arrived, its open shells did not.
    ["sandboxes", "", "operator", () => ({ redis: failing(healthy(HOST), ["time"]) }), [/p-sb-open: .*Open shells could not be read/], (d) => [d.sandboxes.sessionsUnavailable]],
    // The browser terminals, where the console's read of them threw.
    ["sandboxes", "", "operator", () => ({ redis: healthy(HOST), gateway: async () => { throw new Error("Command timed out"); } }), [/p-sb-browser: .*Browser-terminal information could not be read/], (d) => [/could not be read/.test(d.browserGateways.problem)]],
    // A host with no row: its run records are all that can say when it was last seen, and the mirror did not answer.
    ["host", "name=build9", "viewer", () => ({ redis: mirrorDown() }), [/p-hostrow: .*This host's run records could not be read/], (d) => [d.host === null, d.hostHistory.records.length === 0 && /unreachable/.test(d.hostHistory.mirror)]],
    // The waiting jobs, which the reader asks for in one pipeline.
    ["host", "name=build3", "viewer", () => ({ redis: { ...healthy(HOST), pipeline: () => unanswered }, records: [RUN] }), [/p-hostjobs: .*Waiting jobs could not be read/], (d) => [Boolean(d.snapshot.waiting.unreachable)]],
    // Its doctor results.
    ["host", "name=build3", "viewer", () => ({ redis: failing(healthy(HOST), ["mget"]), records: [RUN] }), [/p-hostdoctor: .*the doctor results could not be read/], (d) => [Boolean(d.snapshot.doctor.unreachable)]],
  ];
  for (const [page, qs, role, make, sentences, marks] of cases) {
    const got = await drawn(page, qs, consoleOn(make()), role);
    const what = `/${page}?${qs} for ${role}`;
    for (const sentence of sentences) assert.ok(got.said.some((line) => sentence.test(line)), `${what}: a panel says ${sentence}; it says ${JSON.stringify(got.said)}`);
    assert.deepEqual(marks(got.data).map(Boolean), marks(got.data).map(() => true), `${what}: the reader's own mark`);
    assert.ok(!Object.hasOwn(got.data, "readFailed"), `${what}: the page's own read did not fail, so nothing else said so`);
    assert.deepEqual([got.pill, got.marked], [true, true], `${what}: Not live`);
  }
});

/** Every live page, as the real loader draws it here: `[page, query]`. */
const LIVE_PAGES = [["overview", ""], ["overview", "rows=host"], ["fleet", ""], ["setup", ""], ["parked", ""], ["runs", ""], ["run", "id=gh-1"], ["run", "id=gh-2"], ["sandboxes", ""], ["sandboxes", "id=gh-1"], ["host", "name=build3"], ["host", "name=build9"]];

/**
 * Where the rule does not hold yet on the real reader, each with why and what ends it. An entry is `state | page for
 * role`. The list only shrinks: the test fails for a line that is not here, and for one that is here and holds.
 */
const SAYS_UNDER_A_LIVE_PILL = new Map([]);
const EVERY_PAGES_PARTS = "one of the three parts of a snapshot every page is judged by (issue #962), on a page that draws nothing of that part: goes when those three are held page by page, as the reads beside them are";
const AN_OPERATORS_CARDS = "a read only an operator's cards are drawn from (the chain, a refused run's two cards), on a viewer's or an agent's page: goes when the rule knows who looks, or when the loader makes no such read for them";
const NOT_LIVE_AND_SILENT = new Map([
  ["smembers is not answered | /parked for operator", EVERY_PAGES_PARTS],
  ["smembers is not answered | /parked for viewer", EVERY_PAGES_PARTS],
  ["smembers is not answered | /parked for agent", EVERY_PAGES_PARTS],
  ["hgetall is not answered | /parked for operator", EVERY_PAGES_PARTS],
  ["hgetall is not answered | /parked for viewer", EVERY_PAGES_PARTS],
  ...["/setup", "/fleet"].flatMap((page) => ["operator", "viewer"].map((role) => [`zrevrangebyscore is not answered | ${page} for ${role}`, EVERY_PAGES_PARTS])),
  ["zrevrangebyscore is not answered | /run?id=gh-1 for viewer", AN_OPERATORS_CARDS],
  // An agent's page draws what a viewer's does, from its own copy of the data, which holds a registry read in part as
  // read: so no entry for it where the hosts' rows did not answer.
  ["zrevrangebyscore is not answered | /run?id=gh-1 for agent", AN_OPERATORS_CARDS],
  ...["smembers", "get", "mget", "zrevrangebyscore"].map((command) => [`${command} is not answered | /run?id=gh-2 for agent`, AN_OPERATORS_CARDS]),
  ...["getJobCounts", "getJobSchedulers", "isPaused"].map((call) => [`the queue's ${call} is not answered | /run?id=gh-2 for agent`, AN_OPERATORS_CARDS]),
  ...["/setup", "/parked", "/run?id=gh-2"].map((page) => [`the queue's getActive is not answered | ${page} for agent`, EVERY_PAGES_PARTS]),
  ["smembers is not answered | /run?id=gh-2 for viewer", AN_OPERATORS_CARDS],
  ["hgetall is not answered | /run?id=gh-2 for viewer", AN_OPERATORS_CARDS],
  ["get is not answered | /run?id=gh-2 for viewer", AN_OPERATORS_CARDS],
  ["mget is not answered | /run?id=gh-2 for viewer", AN_OPERATORS_CARDS],
  ["zrevrangebyscore is not answered | /run?id=gh-2 for viewer", AN_OPERATORS_CARDS],
  ...["getJobCounts", "getJobSchedulers", "isPaused"].map((call) => [`the queue's ${call} is not answered | /run?id=gh-2 for viewer`, AN_OPERATORS_CARDS]),
  ...["/setup", "/parked", "/run?id=gh-2"].flatMap((page) => ["operator", "viewer"].map((role) => [`the queue's getActive is not answered | ${page} for ${role}`, EVERY_PAGES_PARTS])),
  ...["/setup", "/fleet"].flatMap((page) => ["operator", "viewer"].map((role) => [`this host's run files cannot be listed | ${page} for ${role}`, EVERY_PAGES_PARTS])),
  ...["operator", "viewer"].map((role) => [`this host's run files cannot be listed | /host?name=build9 for ${role}`, "a host with no row whose page says no retained run record names it, of run files that could not be listed: goes when that page says its run records could not be read"]),
]);

test("the pill agrees with the page on the real reader: a page that says could not be read is Not live, and a page that is Not live says what it lacks", { timeout: 240_000 }, async () => {
  const said = [], silent = [];
  let pages = 0;
  for (const [label, make] of STATES) {
    for (const [page, qs] of LIVE_PAGES) {
      for (const role of rolesOf(page)) {
        const got = await drawn(page, qs, consoleOn(make()), role);
        if (got.marked === null) continue;
        pages += 1;
        const key = `${label} | /${page}${qs ? `?${qs}` : ""} for ${role}`;
        assert.equal(got.marked, got.pill, `${key}: the page the server draws carries the rule's answer`);
        if (saysUnread(got.words) && !got.pill) said.push(key);
        if (got.pill && !saysWhatIsMissing(got.words)) silent.push(key);
      }
    }
  }
  assert.ok(pages > 500, `${pages} pages were drawn`);
  const held = (found, listed) => ({ new: found.filter((key) => !listed.has(key)), gone: [...listed.keys()].filter((key) => !found.includes(key)) });
  assert.deepEqual(held(said, SAYS_UNDER_A_LIVE_PILL), { new: [], gone: [] }, "says could not be read under a Live pill (new: not listed; gone: listed and now right, so take it off the list)");
  assert.deepEqual(held(silent, NOT_LIVE_AND_SILENT), { new: [], gone: [] }, "Not live and says nowhere what it lacks (new: not listed; gone: listed and now right, so take it off the list)");
});

const FIXTURES = fileURLToPath(new URL("./fixtures/console/", import.meta.url));
/**
 * The goldens the rule does not hold for yet, each with why and what ends it: `file without .html` to the reason. The
 * list only shrinks, as the one above.
 */
const BY_HAND = (lacks) => `drawn from data put together by hand, which lacks ${lacks}: goes when this golden is drawn through the loader, which sets it`;
const GOLDEN_SAYS_UNDER_A_LIVE_PILL = new Map([
  ...["sandboxes.operator", "panels/sandboxes-unavailable.operator"].map((name) => [name, BY_HAND("a Sandboxes report and the mark of the read that failed")]),
  ["panels/setup-unreadable.viewer", BY_HAND("a snapshot and the mark of the read that failed")],
  ...["run-refused", "run-cancelled-before-start", "run-loaded-refused", "run-workspace-refused"].map((name) => [`panels/${name}.operator`, BY_HAND("the doctor results, the queues' counts and the day's window of a refused run's snapshot")]),
  ...["run-loaded-running", "run-recovering", "run-workspace-recovery", "run-workspace-running"].map((name) => [`panels/${name}.operator`, BY_HAND("the inbox of a run at work")]),
  ...["agent-writes-partial", "agent-writes-populated", "agent-writes-unavailable", "confirm-preview-many-queues"].map((name) => [`panels/${name}.operator`, BY_HAND("the run history, the spend per hour and the waiting jobs of the overview's snapshot")]),
  ...[
    "confirm-bulk-preview.operator", "confirm-bulk-results.operator", "confirm-done-no-undo.operator", "confirm-done-rerun.operator", "confirm-done.operator", "confirm-preview-cancel-queued.operator",
    "confirm-preview-danger.operator", "confirm-preview-paid.operator", "confirm-previewing.operator", "confirm-refused-confirm.operator", "confirm-refused-partial.operator", "confirm-refused-person.operator",
    "confirm-refused-started.operator", "confirm-refused-timeout.operator", "live-kept-still.operator", "live-not-live.operator", "live-reconnecting.operator", "live-signed-out.operator", "live-stale.operator",
    "read-only.operator", "read-only.viewer", "restart-needed.operator", "restart-needed.viewer",
  ].map((name) => [`panels/${name}`, BY_HAND("the waiting jobs of Fleet's snapshot")]),
]);

test("the pill agrees with the page in every console golden: one that says could not be read is drawn Not live, and one drawn Not live says what it lacks", () => {
  const files = [...readdirSync(FIXTURES).filter((name) => name.endsWith(".html")), ...readdirSync(join(FIXTURES, "panels")).filter((name) => name.endsWith(".html")).map((name) => `panels/${name}`)];
  const said = [], silent = [];
  let live = 0;
  for (const file of files) {
    const page = readFileSync(join(FIXTURES, file), "utf8");
    const pill = pillOf(page);
    if (pill === null) continue;
    live += 1;
    const words = wordsOf(page), key = file.replace(/\.html$/, "");
    if (saysUnread(words) && !pill) said.push(key);
    if (pill && !saysWhatIsMissing(words)) silent.push(key);
  }
  assert.ok(files.length > 600 && live > 250, `${files.length} goldens, ${live} of a live page`);
  assert.deepEqual(silent, [], "drawn Not live, and says nowhere what it lacks");
  assert.deepEqual({ new: said.filter((key) => !GOLDEN_SAYS_UNDER_A_LIVE_PILL.has(key)), gone: [...GOLDEN_SAYS_UNDER_A_LIVE_PILL.keys()].filter((key) => !said.includes(key)) }, { new: [], gone: [] }, "says could not be read under a Live pill (new: not listed; gone: listed and now right, so take it off the list)");
});

/** The names of a stream's events, in order, and the stream emptied. */
const eventsOf = (res) => [...res.chunks.splice(0).join("").matchAll(/(?:^|\n\n)(?:id: [^\n]*\n)?event: (\w+)/g)].map(([, name]) => name);

test("an open stream is told the same: unread while a read of its page fails, fresh once every read answers again, on one page of each kind", async () => {
  // The hub's own rule is the page's (`dataUnread` over the page's name), so the pill of an open tab and the pill of a
  // page just loaded agree. Each load here is the real loader on a console of its own, so nothing is kept between two.
  const well = () => ({ redis: healthy(HOST), records: [RUN, REFUSED] });
  let state = well;
  const hub = makeLiveHub({
    loadPageData: (page, query, who) => loadPageData(page, query, consoleOn(state()), who),
    pagePanels,
    peekSession: () => ({ id: "s1" }),
    readTokens: () => ({ file: { version: 1, generation: 0, tokens: [] } }),
    now: () => NOW,
    timers: { setInterval: () => ({}), clearInterval: () => {} },
    log: () => {},
    pageMinMs: {},
  });
  const cases = [
    ["runs", "", "viewer", () => ({ redis: failing(healthy(HOST), ["zrevrangebyscore"]), records: [RUN, REFUSED] })],
    ["run", "id=gh-1", "viewer", () => ({ redis: healthy(HOST), queue: failingQueue(["getJob"]), records: [RUN, REFUSED] })],
    ["sandboxes", "", "operator", () => ({ redis: failing(healthy(HOST), ["time"]), records: [RUN, REFUSED] })],
    ["host", "name=build3", "viewer", () => ({ redis: failing(healthy(HOST), ["mget"]), records: [RUN, REFUSED] })],
  ];
  try {
    for (const [page, qs, role, unread] of cases) {
      const res = { chunks: [], writableLength: 0, write(text) { res.chunks.push(text); return true; }, end() {}, destroy() {} };
      const leave = hub.subscribe({ res, sessionId: "s1", session: { name: "ada", role }, page, query: parsePageQuery(page, new URLSearchParams(qs)).query });
      const what = `/${page}?${qs} for ${role}`;
      state = well;
      await hub.tick();
      assert.equal(eventsOf(res)[0], "fresh", `${what}: every read answered`);
      state = unread;
      await hub.tick();
      assert.equal(eventsOf(res)[0], "unread", `${what}: one read failed, and the page was still drawn`);
      await hub.tick();
      assert.ok(!eventsOf(res).some((name) => ["fresh", "unread", "stale"].includes(name)), `${what}: said once while it lasts`);
      state = well;
      await hub.tick();
      assert.equal(eventsOf(res)[0], "fresh", `${what}: read whole again`);
      leave();
    }
  } finally {
    hub.close();
  }
});
