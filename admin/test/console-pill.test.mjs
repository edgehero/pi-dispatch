import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeLiveHub } from "../src/console/live.mjs";
import { loadPageData, PAGES, pagePanels, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { dataUnread } from "../src/console/panels/common.mjs";
import { makeAnswererService } from "../src/answerer-data.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { assembleHostCapacity } from "../src/insights-assembly.mjs";
import { createFleetReader, readCapacity, readSubscriptions } from "../src/read-model.mjs";
import { makeSandboxService } from "../src/sandbox-data.mjs";
import { RUNS_INDEX, runRecordKey } from "@edgehero/pi-dispatch/run-mirror";
import { downQueue, downRedis, keyedRedis, quietQueue, registryKeys } from "./helpers/fleet-reader-fakes.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The live pill agrees with the page (issue #988): it says Not live wherever a panel of the page says "could not be
 * read" of a read the page made, and Live on a page whose reads all answered. The rule is `dataUnread`
 * (panels/common.mjs), and it had no mark for the run history, a run's own reads, the Sandboxes report's parts or a
 * host's history, so the pill said Live over cards that said the history, the transcript or the queue could not be
 * read.
 *
 * Every state here is the REAL loader over the real fleet reader, answer rules, sandbox report and host loads, on a
 * client and queues that answer, hold nothing, or fail one command, and over real files in a temp folder: a mark is
 * tested in the shape its reader gives it, and a sentence is the one the page's own panels draw.
 */

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const iso = (ago) => new Date(NOW - ago).toISOString();

function deployment(records = [], { logs = "folder" } = {}) {
  const dir = join(tempDir("pd-988-pill-"), "deployment");
  mkdirSync(logs === "folder" ? join(dir, "logs") : dir, { recursive: true });
  // `logs: "file"`: the run history's folder is not one, so this host's run files cannot be listed.
  if (logs === "file") writeFileSync(join(dir, "logs"), "not a folder");
  const paths = { valkeyUrl: "redis://unused", logsDir: join(dir, "logs"), globalPiDir: join(dir, "pi"), schedulerStallMax: 2, triggersPath: join(dir, "triggers.json"), projectsFile: join(dir, "projects.json"), settingsFile: join(dir, "settings.json"), subscriptionsPath: join(dir, "subscriptions.json") };
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } }] }));
  writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
  writeFileSync(paths.settingsFile, JSON.stringify({ maxTurns: 30 }));
  if (logs === "folder") for (const record of records) writeFileSync(join(paths.logsDir, `${record.jobId}.json`), JSON.stringify(record));
  return { dir, paths, env: { PI_WORKER_NAME: "build3" } };
}

/**
 * A console's page dependencies as `cli.mjs` wires them for these four pages, on `redis` and `queue` and over a
 * deployment folder that holds `records`.
 */
function consoleOn({ redis, queue = quietQueue(), records = [], logs = "folder", gateway = async () => ({ enabledHosts: [], sessions: [] }) }) {
  const { dir, paths, env } = deployment(records, { logs });
  const fleet = createFleetReader(paths, { redisFn: () => redis, makeQueueFn: queue, parseConnectionFn: () => ({}), nowFn: () => NOW, readOnly: true, dollarEnvFn: () => env });
  const services = { paths, env, now: () => NOW, redisFn: () => redis };
  return {
    now: () => NOW, env, fleet, paths,
    answerer: makeAnswererService(services),
    sandboxes: makeSandboxService({ ...services, deploymentDir: dir, fleet }),
    hostLoads: () => readHostLoadsView(redis, { now: () => NOW }),
    // The console's own wiring of the browser terminals, with no gateway file: nothing is asked of Valkey for it.
    gatewayView: gateway,
    hostCapacity: (host) => assembleHostCapacity(paths, host, NOW, { envFn: () => env, readCapacityFn: (opts) => readCapacity({ ...opts, redisFn: () => redis }) }),
    subscriptions: () => readSubscriptions({ subscriptionsPath: paths.subscriptionsPath }),
    selfHost: () => "build3",
    setupGranted: () => false,
  };
}

const wordsOf = (markup) => String(markup).replace(/<(script|style|template)\b[^]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

/**
 * A page as a console draws it for `role`: its data; every place a panel says "could not be read", as `said` (the
 * panel and the words around it, a sentence or a cell of a table) and counted per panel as `times`; what the rule
 * says of that data (`pill`); and whether the page the server draws carries the pill's mark.
 */
async function drawn(page, qs, deps, role) {
  const query = parsePageQuery(page, new URLSearchParams(qs)).query;
  const data = await loadPageData(page, query, deps, { role });
  const ctx = { query, session: { name: "ada", role }, data, readOnly: false };
  const said = [];
  const times = {};
  for (const panel of await pagePanels(page, ctx)) {
    const words = wordsOf(panel.html);
    const found = words.match(/[^.]{0,120}could not be read[^.]{0,80}/g) ?? [];
    if (found.length > 0) times[panel.id] = words.split("could not be read").length - 1;
    for (const place of found) said.push(`${panel.id}: ${place.trim()}`);
  }
  const whole = String((await renderPage(page, ctx)).html);
  return { data, said, times, pill: dataUnread(data), marked: /<span id="live-status"[^>]* data-unread>/.test(whole) };
}

const RUN = { v: 1, jobId: "gh-1", attempt: 1, kind: "github", target: "acme/web#12", project: "web", host: "build3", backend: "local", flow: "fix", outcome: "completed", reason: null, startedAt: iso(120_000), endedAt: iso(60_000) };
const REFUSED = { ...RUN, jobId: "gh-2", outcome: "policy", reason: "job-image-missing", tokens: null, exitCode: null, budgetReserved: false };
/** A run of another host, which this host's files do not hold: the fleet's mirror alone does. */
const FAR = { ...RUN, jobId: "gh-9", host: "build7", target: "acme/web#13", startedAt: iso(300_000), endedAt: iso(240_000) };
const HOST = registryKeys({ build3: { version: "5.4.2", image: "pi-job:latest", concurrency: "2", pid: "1", beat: String(NOW - 2_000), startedAt: String(NOW - 3_600_000), jobs: "[]", jobsMore: "0" } });

/**
 * A Valkey that answers every command these pages send and holds `keys`: `keyedRedis`, with the server's clock, an
 * empty transcript stream, no open shell, and the run mirror's window script over an index that holds nothing.
 */
const healthy = (keys = {}) => ({
  ...keyedRedis(keys),
  async time() { return [String(Math.floor(NOW / 1000)), "0"]; },
  async xlen() { return 0; },
  async xrange() { return []; },
  async xrevrange() { return []; },
  async zrangebyscore() { return []; },
  async eval() { return [0]; },
});
/**
 * That Valkey on a fleet whose run mirror is on and holds `records`: the index, read by score from the newest as the
 * mirror's readers ask, and each record's body.
 */
function mirroring(records, keys = HOST) {
  const members = records.map((record) => [record.jobId, Date.parse(record.endedAt)]).sort((a, b) => b[1] - a[1]);
  const edge = (text) => (text === "+inf" ? [Infinity, true] : text === "-inf" ? [-Infinity, true] : String(text).startsWith("(") ? [Number(String(text).slice(1)), false] : [Number(text), true]);
  return {
    ...healthy({ ...keys, [RUNS_INDEX]: { zset: members }, ...Object.fromEntries(records.map((record) => [runRecordKey(record.jobId), JSON.stringify(record)])) }),
    async zrevrangebyscore(key, max, min, ...rest) {
      if (key !== RUNS_INDEX) return [];
      const [top, topIn] = edge(max);
      const [low, lowIn] = edge(min);
      const inside = members.filter(([, score]) => (topIn ? score <= top : score < top) && (lowIn ? score >= low : score > low));
      const at = rest.indexOf("LIMIT");
      const page = at < 0 ? inside : inside.slice(Number(rest[at + 1]), Number(rest[at + 1]) + Number(rest[at + 2]));
      return rest.includes("WITHSCORES") ? page.flatMap(([id, score]) => [id, String(score)]) : page.map(([id]) => id);
    },
  };
}
/** The roles a page is drawn for: an operator's alone, or both. */
const rolesOf = (page) => (PAGES[page].auth === "operator" ? ["operator"] : ["operator", "viewer"]);
/** That Valkey with `commands` taken and never answered inside their bound, as a client ends one. */
const failing = (client, commands) => new Proxy(client, { get: (target, key) => (commands.includes(key) ? () => Promise.reject(new Error("Command timed out")) : target[key]) });
/** A pipeline whose commands are taken and whose `exec` is never answered inside its bound. */
const unanswered = new Proxy({}, { get: (_, key) => (typeof key === "symbol" || key === "then" ? undefined : key === "exec" ? () => Promise.reject(new Error("Command timed out")) : () => unanswered) });
/** A queue that answers, but for `calls`. */
const failingQueue = (calls) => (connection, opts) => ({ ...quietQueue()(connection, opts), ...Object.fromEntries(calls.map((call) => [call, () => Promise.reject(new Error("Command timed out"))])) });

/**
 * What a refused run's two cards say of a host that has no row, or one that published no doctor result: "could not be
 * read", of reads that answered. Another bullet of the same issue words those; on a page whose reads all answered
 * they are left out of what the page "says", since nothing was unread, and the pill there is Live.
 */
const ABSENT_SAID_AS_UNREAD = /^(p-why|p-host): /;

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
        assert.deepEqual(got.said.filter((line) => !(qs === "id=gh-2" && ABSENT_SAID_AS_UNREAD.test(line))), [], what);
        assert.deepEqual([got.pill, got.marked], [false, false], `${what}: Live`);
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
  // A refused run on a deployment with no host row: its two cards say "could not be read" of what is absent, which is
  // not the pill's to repeat.
  const lone = await drawn("run", "id=gh-2", consoleOn({ redis: healthy(), records: [REFUSED] }), "operator");
  assert.ok(lone.said.length > 0 && lone.said.every((line) => ABSENT_SAID_AS_UNREAD.test(line)), JSON.stringify(lone.said));
  assert.deepEqual([lone.pill, lone.marked], [false, false]);
  // A finished run: its record, no live transcript, no inbox, a chat that only forks, and nothing unread.
  const finished = await drawn("run", "id=gh-1", consoleOn({ redis: healthy(HOST), records: [RUN] }), "operator");
  assert.deepEqual([finished.data.run.record.jobId, finished.data.transcript.exists, finished.data.childrenIncomplete, finished.data.workspace.sessionsUnknown, finished.pill], ["gh-1", false, false, false, false]);
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
    // The record of the run a kept workspace came from. The card that says so is drawn for a kept workspace, which a
    // deployment with no sandbox host has none of: the mark is the reader's all the same.
    ["sandboxes", "id=gh-far", "operator", () => ({ redis: failing(healthy(HOST), ["get"]) }), [], (d) => [d.sandboxRunUnread]],
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

test("whatever one command or one queue call fails, a page that says could not be read never has a Live pill", { timeout: 120_000 }, async () => {
  const pages = [["runs", ""], ["run", "id=gh-1"], ["run", "id=gh-2"], ["run", "id=gh-none"], ["sandboxes", ""], ["sandboxes", "id=gh-1"], ["host", "name=build3"]];
  const states = [
    ...["smembers", "hgetall", "hmget", "hget", "get", "mget", "lrange", "zrange", "zrevrangebyscore", "scan", "exists", "zscore", "pttl", "time", "xlen", "xrange", "xrevrange", "zrangebyscore", "eval"].map((command) => [`${command} is not answered`, () => ({ redis: failing(healthy(HOST), [command]), records: [RUN, REFUSED] })]),
    ...["getJob", "getJobCounts", "getActive", "getFailed", "getJobSchedulers", "getWorkers", "isPaused", "getJobState"].map((call) => [`the queue's ${call} is not answered`, () => ({ redis: healthy(HOST), queue: failingQueue([call]), records: [RUN, REFUSED] })]),
    ["no pipeline is answered", () => ({ redis: { ...healthy(HOST), pipeline: () => unanswered }, records: [RUN, REFUSED] })],
    ["nothing is answered", () => ({ redis: downRedis(), queue: downQueue(), records: [RUN, REFUSED] })],
  ];
  // What each page says with every read answered: nothing, but for a refused run's two cards (see above). A page says
  // a read failed where a panel says "could not be read" more often than that.
  const calm = new Map();
  for (const [page, qs] of pages) for (const role of rolesOf(page)) calm.set(`${page}?${qs} ${role}`, (await drawn(page, qs, consoleOn({ redis: healthy(HOST), records: [RUN, REFUSED] }), role)).times);
  let said = 0;
  for (const [label, make] of states) {
    for (const [page, qs] of pages) {
      for (const role of rolesOf(page)) {
        const got = await drawn(page, qs, consoleOn(make()), role);
        const before = calm.get(`${page}?${qs} ${role}`);
        // The host's capacity card is read when the page is drawn and never by the stream, as it says: not the pill's.
        const panels = Object.keys(got.times).filter((id) => id !== "p-hostcap" && got.times[id] > (before[id] ?? 0));
        if (panels.length === 0) continue;
        said += 1;
        assert.ok(got.pill && got.marked, `${label}: /${page}?${qs} for ${role} says so in ${panels.join(", ")} under a Live pill: ${JSON.stringify(got.said)}`);
      }
    }
  }
  assert.ok(said >= 60, `${said} pages said so: the states here do fail reads`);
  // With nothing answered, every one of these pages says so and is marked.
  for (const [page, qs] of pages) {
    const got = await drawn(page, qs, consoleOn({ redis: downRedis(), queue: downQueue(), records: [RUN, REFUSED] }), "operator");
    assert.ok(got.said.length > 0 && got.pill && got.marked, `/${page}?${qs}`);
  }
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
