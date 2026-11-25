import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLiveHub } from "../src/console/live.mjs";
import { loadPageData, PAGES, pagePanels, parsePageQuery } from "../src/console/pages.mjs";
import { WAITING_CUT_TEXT, waitingFloor } from "../src/console/panels/common.mjs";
import { WAITING_PER_LIST_MAX } from "../src/read-model.mjs";
import { consoleOn, drawn, erroringKey, failing, failingKey, failingQueue, FAR, healthy, HOST, mirroring, NOT_THE_PILLS, NOW, pillOf, READS, REFUSED, rolesOf, RUN, saysUnread, saysWhatIsMissing, STATES, unanswered, UNREAD_WORDS, wordsOf } from "./helpers/real-console.mjs";

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

test("a waiting read cut only by its own bound leaves the pill Live: the page says the jobs in line may be missing, and no read failed (#1073)", async () => {
  // Held until now by a golden's bytes alone (issue #1073): the rule (`waitingMarked`) turns the pill for a list that
  // could not be read and never for the read's bound, since a list read whole and cut at its bound is an answer. One
  // queue's wait list longer than the read takes, on the real reader.
  const line = Array.from({ length: WAITING_PER_LIST_MAX + 1 }, (_, i) => `gh-${1000 + i}`);
  const cut = () => ({ redis: healthy({ ...HOST, "bull:pi-jobs:wait": line }), records: [RUN] });
  for (const [page, qs] of [["overview", ""], ["fleet", ""], ["host", "name=build3"]]) {
    for (const role of rolesOf(page)) {
      const what = `/${page}?${qs} for ${role}`;
      const got = await drawn(page, qs, consoleOn(cut()), role);
      const waiting = got.data.snapshot.waiting;
      assert.deepEqual([waiting.truncated, waiting.queuesCut, Boolean(waiting.unreachable), waiting.listsUnread ?? null, waitingFloor(waiting)?.unread], [true, 0, false, null, false], `${what}: cut at its bound, no list unread`);
      if (role !== "agent") assert.ok(got.words.includes(WAITING_CUT_TEXT), `${what}: the page says so`);
      assert.deepEqual([got.pill, got.marked, saysUnread(got.words)], [false, false, false], `${what}: Live`);
      // The control: the same list answered with an error is a list not read, and the pill says so.
      const unread = await drawn(page, qs, consoleOn({ ...cut(), redis: erroringKey(healthy({ ...HOST, "bull:pi-jobs:wait": line }), /^bull:pi-jobs:wait$/) }), role);
      assert.deepEqual([unread.data.snapshot.waiting.listsUnread?.length > 0, unread.pill, unread.marked], [true, true, true], `${what}: a list not read is Not live`);
    }
  }
});

/** Every live page, as the real loader draws it here: `[page, query]`. */
const LIVE_PAGES = [["overview", ""], ["overview", "rows=host"], ["fleet", ""], ["setup", ""], ["parked", ""], ["runs", ""], ["run", "id=gh-1"], ["run", "id=gh-2"], ["sandboxes", ""], ["sandboxes", "id=gh-1"], ["host", "name=build3"], ["host", "name=build9"]];

/**
 * Where the rule does not hold yet on the real reader, each with why and what ends it. An entry is `state | page for
 * role`. The list only shrinks: the test fails for a line that is not here, and for one that is here and holds.
 */
const SAYS_UNDER_A_LIVE_PILL = new Map([]);
/**
 * Empty since the rule holds the three parts of a snapshot page by page and knows who looks (issue #988). It held two
 * classes, 72 lines: a part of the snapshot every page was judged by, on a page that draws nothing of that part (Parked
 * over a registry or an active list that was not read; the setup guide and Fleet over the run history); and a read
 * only an operator's cards are drawn from (the chain, a refused run's two cards), on a viewer's or an agent's page.
 */
const NOT_LIVE_AND_SILENT = new Map([]);

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

test("the words of a failed read and the sentences that are never the pill's are held here: neither list changes unseen", () => {
  // The structural tests above are only as strict as these two lists. A phrase taken off the first, or a sentence put
  // on the second, would let a page say a read failed under a Live pill with every other test green: so each is held
  // by its exact text, and a change to either is a change to this test, which a person reads.
  assert.deepEqual(UNREAD_WORDS.map((phrase) => phrase.source), ["could not be read", "could not read\\b", "cannot be read", "\\bnot read\\b", "\\bunreadable\\b", "read in part", "did not answer", "\\bincomplete\\b",
    "\\bNot every [\\w' ]{1,40}? could be (?:read|found)\\b", "\\bNot read\\b", "\\bnot asked\\b", "answered this page's read with\\b", "failed while it read\\b"]);
  assert.deepEqual(NOT_THE_PILLS.map(([sentence]) => sentence.source), [
    "The host's capacity history could not be read\\.",
    "logs dir unreadable \\([A-Z_-]+\\)",
    "Its list of running jobs could not be read",
    "The runtime's CPU reserve could not be read\\.",
    "The \\d+ files? this run kept could not be read here\\.",
    "\\(its data could not be read\\)",
    "The console could not read the deployment's data; this is the page as it was last seen\\.",
    "The retained workspace list is unreadable or was not published by this worker\\.",
    "(?:Memory|CPU): budget not known yet or unreadable\\.",
    "[A-Za-z0-9._-]+: publication unreadable\\. Its list is incomplete\\.",
    "Its doctor result cannot be read|Its published result cannot be read \\(a worker of another version may have written it\\)\\.",
    "The host's running-job list is unreadable\\.",
    "CPU reserve [^.]{0,60}?: unreadable",
    "Published doctor observations are incomplete or stale\\.",
    "\\b(?!rows\\b)[\\w.@-]+ did not answer in time",
    "Result unreadable|CPU budget unreadable|running jobs unreadable",
    "The registered shell list is incomplete: at least \\d+ more(?: and \\d+ unreadable registrations?)?\\.",
  ]);
  assert.equal(NOT_THE_PILLS.length, 17);
  for (const [sentence, why] of NOT_THE_PILLS) assert.ok(sentence.global && typeof why === "string" && why.length > 20, `${sentence.source}: every entry says why`);
  // Each phrase is seen where a page says it, and a sentence on the second list is not.
  assert.equal(saysUnread("Held jobs 2 cron schedules; held jobs unreadable"), true);
  assert.equal(saysUnread("Heartbeat not read this time: the host registry was read in part"), true);
  assert.equal(saysUnread("The host registry was read in part: some hosts' rows did not answer in time, so those hosts are as they were last seen."), true);
  assert.equal(saysUnread("MCP server linear did not answer in time. build3: publication unreadable. Its list is incomplete."), false);
  assert.equal(saysUnread("The triggers file does not load, so its answer rules and standing answers are not shown. No live registry row for build9."), false);
});

test("Fleet's held jobs that could not be read are said by its card, its header and the pill, with every other read answering", async () => {
  const held = READS.find(([what]) => what === "the held jobs")[1];
  for (const role of rolesOf("fleet")) {
    const got = await drawn("fleet", "", consoleOn({ redis: failingKey(healthy(HOST), held), records: [RUN] }), role);
    assert.ok(got.words.includes("The held jobs could not be read.") && got.words.includes("held jobs unreadable"), role);
    assert.deepEqual([got.data.snapshot.held.unreachable !== undefined, got.pill, got.marked], [true, true, true], role);
    // Nothing else is unread: the hosts, the waiting jobs and the doctor results answered.
    assert.ok(!got.data.snapshot.queue.fleetDegraded && !got.data.snapshot.activeUnreachable && !got.data.snapshot.parkedUnreachable, role);
    const well = await drawn("fleet", "", consoleOn({ redis: healthy(HOST), records: [RUN] }), role);
    assert.deepEqual([well.pill, well.marked, saysUnread(well.words)], [false, false, false], role);
  }
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
