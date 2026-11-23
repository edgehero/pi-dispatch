import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPageData, PAGE_READS, parsePageQuery } from "../src/console/pages.mjs";
import { PAGE_DEADLINE_MS, PAGE_VIEW_GRACE_MS } from "../src/console/page-deadline.mjs";
import { HOST_CAPACITY_TIMEOUT_MS, SCHEDULE_ZONES_TIMEOUT_MS, waitedFor } from "../src/console/cli.mjs";
import { PUBLICATION_READ_MS, readConnections } from "../src/connections-view.mjs";
import { MODELS_LIMITS, readModelsHistory, readModelsView } from "../src/models-view.mjs";
import { ALLOCATION_READ_MS, readProjectFleetRuns, readProjectView } from "../src/project-view.mjs";
import { _setAllocationSeamsForTests } from "../src/insights-assembly.mjs";
import { createFleetReader, RUN_MIRROR_READ_MS, RUN_MIRROR_UNREAD } from "../src/read-model.mjs";
import { quietQueue } from "./helpers/fleet-reader-fakes.mjs";
import { handTime } from "./helpers/hand-time.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fileViewsFixture, RUNS_PAGE_IN_OUTAGE } from "./helpers/no-snapshot.mjs";

/**
 * One deadline per page load (issues #987 and #988). A page's reads are made one after another, each with a bound of
 * its own, so on a Valkey that is connected and does not answer a page took the sum of them: /config/trigger 7.6 to
 * 11.6 s, /config/connections 14.1 s, a run's page 22.6 s. These are the real `loadPageData` and the real views over
 * reads that never settle, that fail, or that answer slowly, with the deadline's clock and timers moved by hand:
 * nothing here waits for a deadline, and nothing here measures the time the test itself takes.
 */

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const OP = { role: "operator" };
const D = PAGE_DEADLINE_MS;
const G = PAGE_VIEW_GRACE_MS;
const iso = (ago) => new Date(NOW - ago).toISOString();
const RECORD = Object.freeze({ jobId: "gh-1", kind: "github", target: "acme/web#12", outcome: "completed", reason: null, host: "build3", startedAt: iso(120_000), endedAt: iso(60_000) });
const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6506"), { code: "ECONNREFUSED" });
const silent = () => new Promise(() => {});

// ---- every read of every page ------------------------------------------------------------------------------------------

/**
 * What a page load can ask, by the name the probe below gives each read, and what the read draws from:
 *   - `valkey`: only Valkey answers it. The load waits for it until the deadline and does not make it once the
 *     deadline has passed.
 *   - `both`: it also draws this host's files, and takes its bound from the page. The load makes it until the grace
 *     has passed too.
 *   - `files`: no Valkey at all. Never timed, so here it always answers.
 * The answers are what a healthy deployment gives, shaped only as far as the loader itself reads them.
 */
const READS = {
  "fleet.snapshot": ["valkey", () => ({ ...fileViewsFixture({ pinned: false }), queue: { counts: {}, fleetDegraded: null }, hostBudgets: [{ name: "build3", jobs: "[]", jobsMore: "0" }], parked: [{ jobId: "gh-9", kind: "github", target: "acme/web#9", parkedAt: NOW - 3_600_000, ageMs: 3_600_000, pendingScan: { jobId: null } }], runs: [], schedulers: [], waiting: { rows: [], scheduled: [], byBucket: {}, byQueue: [], truncated: false } })],
  "fleet.parkedCount": ["valkey", () => 2],
  "fleet.transcriptMeta": ["valkey", () => ({ exists: true, ended: true, outcome: "completed", length: 3, lastId: "1730000000000-0" })],
  "fleet.progressOfRun": ["valkey", () => ({ progress: { missing: true } })],
  "fleet.progress": ["valkey", () => ({ missing: true })],
  "fleet.inbox": ["valkey", () => ({ armed: false, messages: [] })],
  "fleet.jobStatus": ["valkey", () => ({ found: false, state: null })],
  "fleet.pendingAnswer": ["valkey", () => ({ jobId: null })],
  "fleet.runLiveFacts": ["valkey", () => null],
  "fleet.rerunCheck": ["valkey", () => ({ ok: true })],
  "fleet.parkedAnswerCheck": ["valkey", () => ({ ok: true })],
  "fleet.triggerSkew": ["valkey", () => ({ ok: true })],
  "fleet.runHolds": ["valkey", () => []],
  "fleet.runById": ["both", () => ({ missing: true })],
  "fleet.runsPage": ["both", () => ({ runs: [], next: null, mirror: "ok", truncated: false, examined: 0 })],
  "fleet.runsWindow": ["both", () => ({ at: NOW, floor: false, partial: false, byOutcome: {}, byProject: [], projectsMore: 0, byReason: {}, values: {}, spentMicros: 0, unpriced: 0 })],
  hostLoads: ["valkey", () => ({ hosts: [], more: 0 })],
  "answerer.read": ["valkey", () => ({ state: "ok", partial: false, rows: [] })],
  gatewayView: ["valkey", () => ({ enabledHosts: [], sessions: [] })],
  "sandboxes.read": ["valkey", () => ({ hosts: [], sessions: [], options: [], selected: {} })],
  "sandboxes.workspace": ["valkey", () => ({ unknown: true, notPublished: true })],
  zeroTouch: ["valkey", () => ({ coverage: { partial: false, reasons: [] }, totals: {}, projects: [], touchedRunIds: [] })],
  zeroTouchRuns: ["valkey", () => ({ runs: [], next: null, mirror: "off", truncated: false, examined: 0 })],
  triggerFireCheck: ["valkey", () => ({ ok: true })],
  "watch.listRules": ["valkey", () => [{ id: "r1", source: "s1" }]],
  "watch.listFindings": ["valkey", () => []],
  "watch.listSources": ["valkey", () => []],
  "watch.readBoard": ["valkey", () => ({ rule: "r1" })],
  "watch.readFinding": ["valkey", () => ({ id: "f1", ruleId: "r1" })],
  "watch.readTrace": ["valkey", () => []],
  setup: ["both", () => ({ enabled: false, reason: "host-setup-disabled", actions: [], providerKey: null, progress: [], allowlistCount: 3 })],
  modelsView: ["both", () => ({ state: "ready", roles: [] })],
  connections: ["both", () => ({ environmentUnknown: false, forges: [], snapshotUnreadable: false })],
  updates: ["both", () => ({ rows: [] })],
  projectView: ["both", () => ({ id: "web", state: "ready" })],
  triggerList: ["both", () => ({ rows: [], problems: [] })],
  hostCapacity: ["both", () => ({ hosts: [] })],
  insights: ["files", () => ({ window: "30d" })],
  agentWrites: ["files", () => ({ count: 0, partial: false })],
  audit: ["files", () => ({ rows: [], more: false })],
  auditVerify: ["files", () => ({ ok: true, rows: 0 })],
  subscriptions: ["files", () => []],
  triggerEditor: ["files", () => ({})],
  "fleet.sandboxCheck": ["files", () => ({ elsewhere: true })],
  "fleet.runTrigger": ["files", () => null],
};
const kindOf = (name) => READS[name][0];

/**
 * A page's dependencies with every read named and counted. `how(name, kind, at)` says how a read ends: "answer", "silent"
 * (it never settles), "refuse" (it fails at once) or a number of milliseconds after which it fails. `answers` lays a
 * case's own answers over the table's; `without` leaves fleet methods out, as an older reader double has none.
 */
function probe(time, { how = () => "answer", answers = {}, without = [] } = {}) {
  const start = time.clock();
  const calls = [];
  const logs = [];
  const read = (name) => (...args) => {
    const at = time.clock() - start;
    calls.push({ name, at });
    const answer = () => (answers[name] ?? READS[name][1])(...args);
    const verdict = kindOf(name) === "files" ? "answer" : how(name, kindOf(name), at);
    if (verdict === "answer") return Promise.resolve().then(answer);
    if (verdict === "silent") return silent();
    if (verdict === "refuse") return Promise.reject(refused());
    return new Promise((_, reject) => { time.timers.setTimeout(() => reject(refused()), verdict); });
  };
  const fleet = { lookupQuestion: () => ({ asked: 1 }), fileViews: () => fileViewsFixture({ pinned: false }), artifacts: () => null };
  for (const name of Object.keys(READS)) if (name.startsWith("fleet.") && !without.includes(name)) fleet[name.slice("fleet.".length)] = read(name);
  const deps = {
    now: () => NOW, env: {}, fleet,
    deadline: { clock: time.clock, timers: time.timers },
    log: (line) => logs.push(line),
    hostLoads: read("hostLoads"),
    answerer: { read: read("answerer.read") },
    gatewayView: read("gatewayView"),
    sandboxes: { hosts: () => ({ config: null }), read: read("sandboxes.read"), workspace: read("sandboxes.workspace") },
    zeroTouch: read("zeroTouch"),
    zeroTouchRuns: read("zeroTouchRuns"),
    triggerFireCheck: read("triggerFireCheck"),
    watch: Object.fromEntries(["listRules", "listFindings", "listSources", "readBoard", "readFinding", "readTrace"].map((method) => [method, read(`watch.${method}`)])),
    setup: read("setup"),
    modelsView: read("modelsView"),
    connections: read("connections"),
    updates: read("updates"),
    projectView: read("projectView"),
    triggerList: read("triggerList"),
    hostCapacity: read("hostCapacity"),
    insights: read("insights"),
    agentWrites: read("agentWrites"),
    audit: read("audit"),
    auditVerify: read("auditVerify"),
    subscriptions: read("subscriptions"),
    triggerEditor: read("triggerEditor"),
    pricedModels: () => [],
    devices: () => ({ devices: [] }),
    setupGranted: () => false,
    selfHost: () => "build3",
    killSwitchPlan: () => ({ disagreement: null, refused: null }),
    configLocations: () => ({ settings: ".../deployment/settings.json", triggers: ".../deployment/triggers.json", settingsOutsideDeployment: false }),
  };
  return { deps, calls, logs };
}

/**
 * One load on the hand clock, stepped to the deadline and to the grace: `{ data, at, calls, logs }`, `at` the hand time
 * it came back at (0 at once, the deadline, the deadline and the grace) or null when it has not come back by then.
 */
async function loaded(page, query, who, options, { deadlineMs = D } = {}) {
  const time = handTime();
  const { deps, calls, logs } = probe(time, options);
  deps.deadline.ms = deadlineMs;
  let data = null;
  let at = null;
  const back = (when) => { if (data !== null && at === null) at = when; };
  loadPageData(page, query, deps, who).then((got) => { data = got; });
  await time.settled();
  back(0);
  for (const [step, when] of [[D - 1, D - 1], [1, D], [G - 1, D + G - 1], [1, D + G]]) {
    await time.advance(step);
    back(when);
  }
  return { data, at, calls, logs, waiting: time.waiting() };
}

/** A run's record, by what its page then reads. */
const PARKED = { ...RECORD, reason: "awaiting-input" };
const REFUSED_RUN = { ...RECORD, outcome: "policy", reason: "job-image-missing", tokens: null, exitCode: null, budgetReserved: false };
const RECOVERED = { ...RECORD, replica: 1, replicas: 2, checkpoints: 1 };
const run = (record, more = {}) => ({ page: "run", qs: "id=gh-1", answers: { "fleet.runById": (id) => (id === "gh-1" ? { record, source: "local" } : { missing: true }), ...more.answers }, without: more.without ?? [] });

/** Every page kind, and for the pages whose reads depend on what an earlier read gave, each such state. */
const CASES = [
  { page: "setup" }, { page: "models" }, { page: "sandboxes" }, { page: "sandboxes", qs: "id=gh-1", label: "a kept workspace's run" },
  { page: "zero-touch" }, { page: "overview" }, { page: "runs" }, { page: "runs", qs: "touched=1&days=30", label: "the touched runs" },
  { ...run(RECORD), label: "a record on this host" },
  { page: "run", qs: "id=gh-1", label: "no record anywhere" },
  { ...run(PARKED), label: "a parked run, whose chat is a reply" },
  { ...run(REFUSED_RUN), label: "a run refused before it started" },
  { ...run(RECOVERED), label: "a replica that was recovered" },
  { ...run(RECORD, { answers: { "fleet.jobStatus": () => ({ found: true, state: "completed", continuesAs: "gh-1.r1" }) } }), label: "a run that goes on as a recovery" },
  { ...run(RECORD, { without: ["fleet.progressOfRun"] }), label: "a reader with no progressOfRun" },
  { page: "parked" }, { page: "answer-rules" },
  { page: "insights" }, { page: "insights-budget-split" }, { page: "insights-capacity" }, { page: "insights-breakdown" }, { page: "insights-flows" },
  { page: "fleet" }, { page: "host", qs: "name=build3" }, { page: "venue", qs: "name=local" },
  { page: "config" }, { page: "secrets" }, { page: "connections" }, { page: "updates" }, { page: "devices" }, { page: "project", qs: "id=web" },
  { page: "trigger", qs: "index=0" }, { page: "triggers" }, { page: "trigger-check" }, { page: "trigger-add" },
  { page: "watch" }, { page: "watch-board", qs: "rule=r1&finding=f1" }, { page: "audit" },
];
const queryOf = (c) => {
  const parsed = parsePageQuery(c.page, new URLSearchParams(c.qs ?? ""));
  assert.ok(parsed && !parsed.refusal, `${c.page}: the case's query is one the page takes`);
  return parsed.query;
};
const nameOf = (c) => `${c.page}${c.label ? ` (${c.label})` : ""}`;

/**
 * One case with the reads in `quiet` never answering (`quiet(name)`), against the same page over a Valkey that fails
 * each of those reads when the load would stop waiting for it, with no deadline on the page at all: the fallbacks the
 * loader had before there was one. The page a deadline cut must be that page, back at the same time, and marked.
 */
async function cutAgainstFailed(c, quiet, what) {
  const query = queryOf(c);
  const base = { answers: c.answers, without: c.without };
  const cutAt = (kind) => (kind === "valkey" ? D : D + G);
  const cut = await loaded(c.page, query, OP, { ...base, how: (name) => (quiet(name) ? "silent" : "answer") });
  // The same Valkey as a console with no deadline meets it: a read is refused from the moment its page stops waiting.
  const failed = await loaded(c.page, query, OP, { ...base, how: (name, kind, at) => (quiet(name) || at >= cutAt(kind) ? (at >= cutAt(kind) ? "refuse" : cutAt(kind) - at) : "answer") }, { deadlineMs: 3_600_000 });
  assert.ok(cut.at !== null, `${what}: the page is back by the deadline and the grace, whatever Valkey does`);
  assert.equal(cut.at, failed.at, `${what}: back when the read that was cut would have failed`);
  assert.ok(cut.at === D || cut.at === D + G, `${what}: at the deadline, or the grace after it`);
  // Past the deadline nothing that only Valkey answers is asked, and past the grace nothing at all.
  assert.deepEqual(cut.calls.filter((call) => kindOf(call.name) === "valkey" && call.at >= D).map((call) => call.name), [], `${what}: asked after the deadline`);
  assert.deepEqual(cut.calls.filter((call) => kindOf(call.name) === "both" && call.at >= D + G).map((call) => call.name), [], `${what}: asked after the grace`);
  assert.equal(cut.waiting, 0, `${what}: no timer is left behind`);
  // Each read is drawn as the read that failed, with two marks of the deadline's own.
  const expected = { ...failed.data, deadlineSpent: true };
  const snapshotCut = failed.calls.some((call) => call.name === "fleet.snapshot" && (quiet("fleet.snapshot") || call.at >= D));
  if (snapshotCut) expected.snapshotFailure = "late";
  // One read words a failure of the console itself where it threw: a cut read is no such failure, and logs nothing.
  if (expected.zeroTouch?.failure === "read-failed") delete expected.zeroTouch.failure;
  // The chat facts are one read made of three, with no bound to hand it: cut inside its last, the scan for a pending
  // answer, it is the whole read's unread answer, where that scan failing alone leaves the facts with the scan unknown.
  if (quiet("fleet.pendingAnswer") && !quiet("fleet.jobStatus") && cut.calls.some((call) => call.name === "fleet.pendingAnswer")) expected.chat = { unreachable: true };
  assert.deepEqual(cut.data, expected, `${what}: each read's own answer for a Valkey that did not answer`);
  assert.deepEqual(cut.logs, [], `${what}: nothing for the console's log`);
  assert.ok(!Object.hasOwn(failed.data, "deadlineSpent") && !Object.hasOwn(failed.data, "snapshotFailure"), `${what}: a read that failed is not a deadline`);
}

test("every page kind has a case, and every read the table names is reached by one", async () => {
  assert.deepEqual([...new Set(CASES.map((c) => c.page))].sort(), Object.keys(PAGE_READS).sort(), "one case at least for each page of PAGE_READS");
  const reached = new Set();
  for (const c of CASES) {
    const healthy = await loaded(c.page, queryOf(c), OP, { answers: c.answers, without: c.without });
    assert.equal(healthy.at, 0, `${nameOf(c)}: a Valkey that answers costs no wait`);
    for (const mark of ["deadlineSpent", "snapshotFailure", "readFailed"]) assert.ok(!Object.hasOwn(healthy.data, mark), `${nameOf(c)}: no ${mark}`);
    for (const call of healthy.calls) reached.add(call.name);
  }
  assert.deepEqual(Object.keys(READS).filter((name) => !reached.has(name)), [], "a read no case reaches is a read no case can cut");
});

test("a Valkey that answers nothing: every page is back by the deadline and the grace, each read drawn as the read that failed", async () => {
  for (const c of CASES) await cutAgainstFailed(c, (name) => kindOf(name) !== "files", `${nameOf(c)}, nothing answers`);
});

test("each read of each page, the only one that does not answer: the page is back at the deadline with that read's own unread answer and every read before it", async () => {
  let cases = 0;
  for (const c of CASES) {
    const healthy = await loaded(c.page, queryOf(c), OP, { answers: c.answers, without: c.without });
    for (const name of [...new Set(healthy.calls.map((call) => call.name))].filter((read) => kindOf(read) !== "files")) {
      await cutAgainstFailed(c, (read) => read === name, `${nameOf(c)}, ${name} alone does not answer`);
      cases += 1;
    }
  }
  assert.ok(cases >= 100, `${cases} reads of pages, each cut alone`);
});

test("the three pages issue #987 measured answer at the deadline, where each was a sum of its reads' bounds", async () => {
  // Each read here ends at its own bound, 5 s, as a client's command does on a Valkey that stopped answering.
  for (const [page, qs] of [["trigger", "index=0"], ["connections", ""], ["run", "id=gh-1"]]) {
    const query = parsePageQuery(page, new URLSearchParams(qs)).query;
    const got = await loaded(page, query, OP, { how: () => 5_000 });
    assert.ok(got.at === D || got.at === D + G, `${page}: back at ${got.at} ms`);
    assert.equal(got.data.deadlineSpent, true, page);
    // With no deadline the same page is the sum: more than the grace allows.
    const summed = await loaded(page, query, OP, { how: () => 5_000 }, { deadlineMs: 3_600_000 });
    assert.equal(summed.at, null, `${page}: not back by ${D + G} ms without one`);
  }
});

test("a Valkey that is slow and still answers inside the deadline is not called unread: the page is the one a quick Valkey gives", async () => {
  for (const c of CASES) {
    const query = queryOf(c);
    const quick = await loaded(c.page, query, OP, { answers: c.answers, without: c.without });
    // Every read takes 300 ms to answer, one after another.
    const time = handTime();
    const slow = (name) => new Promise((resolve) => { time.timers.setTimeout(resolve, 300); });
    const { deps } = probe(time, { answers: Object.fromEntries(Object.keys(READS).filter((name) => kindOf(name) !== "files").map((name) => [name, async (...args) => { await slow(name); return (c.answers?.[name] ?? READS[name][1])(...args); }])), without: c.without });
    let data = null;
    loadPageData(c.page, query, deps, OP).then((got) => { data = got; });
    await time.settled();
    const start = time.clock();
    while (data === null && time.clock() - start < D) await time.advance(50);
    assert.ok(data !== null, `${nameOf(c)}: read inside the deadline, one slow read after another`);
    assert.deepEqual(data, quick.data, `${nameOf(c)}: nothing is unread`);
    assert.equal(time.waiting(), 0, `${nameOf(c)}: every wait's timer is taken away with its answer`);
  }
  // Up to the last millisecond: a snapshot that answers just inside the deadline is read.
  const time = handTime();
  const { deps } = probe(time, { answers: { "fleet.snapshot": () => new Promise((resolve) => { time.timers.setTimeout(() => resolve(READS["fleet.snapshot"][1]()), D - 1); }) } });
  let data = null;
  loadPageData("overview", parsePageQuery("overview", new URLSearchParams("")).query, deps, OP).then((got) => { data = got; });
  await time.advance(D - 2);
  assert.equal(data, null);
  await time.advance(1);
  assert.ok(data !== null && data.snapshot !== null && !Object.hasOwn(data, "deadlineSpent") && !Object.hasOwn(data, "readFailed"));
});

test("a read that settles in the same turn as the deadline keeps its own answer", async () => {
  // The zero touch report ends by a bound of its own. Where that is the deadline's instant, the report it then gives
  // is the page's, not the deadline's stand-in for it.
  const own = { coverage: { partial: true, reasons: ["touch-index-unavailable"] }, totals: {}, projects: [], touchedRunIds: [] };
  const time = handTime();
  const { deps, logs, calls } = probe(time, { answers: { zeroTouch: () => new Promise((resolve) => { time.timers.setTimeout(() => resolve(own), D); }) } });
  let data = null;
  loadPageData("zero-touch", parsePageQuery("zero-touch", new URLSearchParams("")).query, deps, OP).then((got) => { data = got; });
  await time.advance(D - 1);
  assert.equal(data, null);
  await time.advance(1);
  assert.ok(data !== null, "back at the deadline");
  assert.equal(data.zeroTouch.state, "unavailable");
  assert.ok(!Object.hasOwn(data.zeroTouch, "failure"), "its own answer: unavailable, with no fault of the console's");
  assert.deepEqual(calls.map((call) => call.name), ["zeroTouch"], "the report was asked for, and the Parked count after the deadline was not");
  assert.deepEqual([data.parkedCount, data.deadlineSpent], [null, true]);
  assert.deepEqual(logs, []);
  // A read that failed by itself is still the console's to say, and to log by its code alone.
  const thrown = await loaded("zero-touch", parsePageQuery("zero-touch", new URLSearchParams("")).query, OP, { how: (name) => (name === "zeroTouch" ? "refuse" : "answer") });
  assert.equal(thrown.data.zeroTouch.failure, "read-failed");
  assert.deepEqual(thrown.logs, ["console: the Zero touch read failed (ECONNREFUSED)"]);
});

test("a run whose record is in this host's files is still drawn past the deadline, and the readers that take a bound are handed what is left", async () => {
  // The mirror's part of a history page ends at the bound the page hands the reader, as the real reader's does, and
  // the reader then answers with this host's part: the real reader's own answer for a mirror it could not reach.
  const bounds = [];
  const time = handTime();
  const mirror = (opts) => new Promise((resolve) => { time.timers.setTimeout(() => resolve({ ...RUNS_PAGE_IN_OUTAGE }), opts.timeoutMs); });
  const { deps, calls } = probe(time, {
    how: (name) => (kindOf(name) === "valkey" ? "silent" : "answer"),
    answers: {
      "fleet.runById": (id, opts) => { bounds.push(["runById", opts.timeoutMs]); return { record: RECORD, source: "local" }; },
      "fleet.runsPage": (opts) => { bounds.push(["runsPage", opts.timeoutMs]); return mirror(opts); },
    },
  });
  let data = null;
  loadPageData("run", { id: "gh-1" }, deps, OP).then((got) => { data = got; });
  await time.advance(D);
  assert.equal(data, null, "the history's mirror was handed one millisecond, and has it still");
  await time.advance(1);
  assert.ok(data !== null, "back a millisecond after the deadline");
  assert.equal(data.run.record.jobId, "gh-1", "the record needs no Valkey");
  assert.ok(!Object.hasOwn(data, "readFailed"), "so the page's own read did not fail");
  assert.equal(data.deadlineSpent, true);
  assert.deepEqual(bounds, [["runById", 1], ["runsPage", 1]], "each reader's bound is what the deadline has left, never under 1 ms");
  assert.deepEqual([data.children, data.childrenIncomplete], [[], true], "the reader's own answer: this host's runs, the mirror not reached");
  // Everything only Valkey answers is the read that failed, and none of it was asked for after the deadline.
  assert.deepEqual(calls.filter((call) => kindOf(call.name) === "valkey").map((call) => call.name), ["answerer.read"]);
  assert.deepEqual(data.transcript, { unreachable: true, exists: false });
  for (const field of ["progress", "inbox", "chat", "rerunCheck"]) assert.deepEqual(data[field], { unreachable: true }, field);
  assert.deepEqual(data.sandboxCheck, { elsewhere: true }, "what the files answer is drawn as read");

  // With time left each reader is handed its own bound, whole, and the runs' window what the deadline has.
  bounds.length = 0;
  const fresh = handTime();
  const healthy = probe(fresh, { answers: { "fleet.runById": (id, opts) => { bounds.push(["runById", opts.timeoutMs]); return { record: REFUSED_RUN, source: "local" }; }, "fleet.runsPage": (opts) => { bounds.push(["runsPage", opts.timeoutMs]); return READS["fleet.runsPage"][1](); }, "fleet.runsWindow": (opts) => { bounds.push(["runsWindow", opts.timeoutMs]); return READS["fleet.runsWindow"][1](); } } });
  await loadPageData("run", { id: "gh-1" }, healthy.deps, OP);
  assert.deepEqual(bounds, [["runById", RUN_MIRROR_READ_MS], ["runsPage", RUN_MIRROR_READ_MS], ["runsWindow", D]]);
});

test("each load has its own deadline: a second one, and a live one, start with their whole time", async () => {
  const cut = await loaded("overview", {}, OP, { how: () => "silent" });
  assert.deepEqual([cut.at, cut.data.deadlineSpent], [D, true]);
  for (const who of [OP, { live: true, readOnly: false }]) {
    const next = await loaded("overview", {}, who, {});
    assert.ok(next.at === 0 && next.data.snapshot !== null && !Object.hasOwn(next.data, "deadlineSpent"), JSON.stringify(who));
  }
});

// ---- the views that read Valkey after the snapshot ----------------------------------------------------------------

/** What the deployment's files say of its connections, read with no Valkey. */
const CONNECTION_FILES = {
  environment: () => ({ env: { GITHUB_AUTH_SOURCE: "gh", WEBHOOK_SECRET: "fixture-only", PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fixture-only", RECEIVER_PORT: "3000" } }),
  allowlist: () => ["api.github.com", "registry.npmjs.org"],
  endpoints: () => [{ id: "shared-model", host: "models.example.com", port: 443, keyless: false, slots: 3 }],
  privateEndpoints: () => [],
};

/**
 * The five publication readers as each answers a Valkey that gives it nothing: its own unknown, at the bound it was
 * handed, here on the hand clock. `seen` keeps each one's options.
 */
function publicationsOn(time, seen = {}) {
  const at = (name, unknown) => (_client, ...rest) => {
    const opts = rest.at(-1) ?? {};
    seen[name] = opts;
    return new Promise((resolve) => { time.timers.setTimeout(() => resolve(unknown), opts.timeoutMs ?? PUBLICATION_READ_MS[name]); });
  };
  return {
    endpointStatus: at("endpointStatus", { state: "unknown", hosts: [], more: 0, partial: true }),
    slots: at("slots", [null]),
    receivers: at("receivers", { hosts: [], complete: false, more: 0 }),
    pollers: at("pollers", { hosts: [], complete: false, more: 0 }),
    hookRuns: at("hookRuns", { hosts: [], more: 0, moreUnknown: true, partial: true }),
  };
}

test("/config/connections past its deadline is drawn from the files: the real view, each publication read ended by the millisecond it is handed", async () => {
  const time = handTime();
  const { deps } = probe(time, { how: (name) => (name === "fleet.snapshot" ? "silent" : "answer") });
  const seen = {};
  deps.connections = (snapshot, { within } = {}) => readConnections({ deploymentDir: "/srv/deployment", paths: {}, snapshot, now: NOW, redis: {}, reads: { ...CONNECTION_FILES, ...publicationsOn(time, seen) }, within });
  let data = null;
  loadPageData("connections", {}, deps, OP).then((got) => { data = got; });
  await time.advance(D);
  assert.equal(data, null, "the snapshot is cut, and the view is being read");
  // Four publication reads of 2 to 2.5 s each, one after another: each has 1 ms.
  await time.advance(10);
  assert.ok(data !== null, "back ten milliseconds after the deadline, well inside the grace");
  assert.deepEqual([data.snapshot, data.readFailed, data.snapshotFailure, data.deadlineSpent], [null, true, "late", true]);
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([name, opts]) => [name, opts.timeoutMs])), { endpointStatus: 1, receivers: 1, pollers: 1, hookRuns: 1 });
  const view = data.connections;
  assert.ok(view !== null, "not dropped whole");
  assert.equal(view.snapshotUnreadable, true);
  // What the files hold is there.
  assert.deepEqual(view.endpoints.map((ep) => [ep.id, ep.host, ep.declaredSlots]), [["shared-model", "models.example.com", 3]]);
  assert.equal(view.egress.allowlist.length, 2);
  assert.equal(view.forges.find((forge) => forge.name === "github").secret.set, true);
  assert.equal(view.receiver.port, 3000);
  // What Valkey holds is each reader's own unknown, never an empty list read as none.
  assert.equal(view.endpointStatus.state, "unknown");
  assert.equal(view.receiver.complete, false);
  assert.equal(view.pollers.complete, false);
  assert.equal(view.endpoints[0].used, null);
});

test("readConnections hands each publication read its own bound through the page's deadline, and names none without one", async () => {
  const seen = {};
  const note = (name, answer) => (_client, ...rest) => { seen[name] = rest.at(-1); return answer; };
  const reads = {
    ...CONNECTION_FILES,
    endpointStatus: note("endpointStatus", { state: "reported", partial: false, more: 0, hosts: [{ name: "build3", at: NOW, ageMs: 0, state: "reported", endpointsMore: 0, endpoints: [{ id: "shared-model", slots: 3, used: 1, fleet: 1 }] }] }),
    slots: note("slots", [1]),
    receivers: note("receivers", { hosts: [], complete: true, more: 0 }),
    pollers: note("pollers", { hosts: [], complete: true, more: 0 }),
    hookRuns: note("hookRuns", { partial: false, more: 0, hosts: [] }),
  };
  const input = { deploymentDir: "/srv/deployment", paths: {}, snapshot: { hostBudgets: [{ name: "build3" }] }, now: NOW, redis: {}, reads };
  const own = [];
  await readConnections({ ...input, within: (ms) => (own.push(ms), 7) });
  assert.deepEqual(own, [PUBLICATION_READ_MS.endpointStatus, PUBLICATION_READ_MS.slots, PUBLICATION_READ_MS.receivers, PUBLICATION_READ_MS.pollers, PUBLICATION_READ_MS.hookRuns]);
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([name, opts]) => [name, opts.timeoutMs])), { endpointStatus: 7, slots: 7, receivers: 7, pollers: 7, hookRuns: 7 });
  // No deadline: each reader is called as it was, with no bound named.
  for (const name of Object.keys(seen)) delete seen[name];
  await readConnections(input);
  assert.deepEqual(Object.keys(seen).sort(), ["endpointStatus", "hookRuns", "pollers", "receivers", "slots"]);
  for (const [name, opts] of Object.entries(seen)) assert.ok(!Object.hasOwn(opts ?? {}, "timeoutMs"), name);
  // Setup's read of the same view asks for no publication, with a deadline as without one.
  for (const name of Object.keys(seen)) delete seen[name];
  await readConnections({ ...input, publications: false, within: () => 1 });
  assert.deepEqual(seen, {});
});

test("readModelsView hands the fleet reader the page's bound, so a history cut at the deadline still counts this host's own records", async () => {
  const document = JSON.stringify({ triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", model: "role:editor" } }], modelRoles: { default: { editor: { model: "p/main", fallbackModels: ["p/backup"] } } } });
  const reads = { triggers: () => document, projects: () => null, limits: () => JSON.stringify({ version: 2, limits: [{ scope: "model:p/main", dayUsd: "1" }] }), overlay: () => null, cooldowns: silent, counters: silent };
  // This host holds two runs, one of them a canary of a run it does not hold; the mirror answers nothing, and the
  // reader says so at the bound it is handed, with this host's runs: the real reader's own answer.
  const local = [{ jobId: "gh-7", provider: "p", model: "main", outcome: "completed", endedAt: iso(60_000) }, { jobId: "gh-8", provider: "p", model: "backup", outcome: "completed", endedAt: iso(120_000), canary: { sourceJobId: "gh-5", role: "editor" } }];
  const asked = [];
  const atBound = (answer) => (opts) => new Promise((resolve) => { setTimeout(() => resolve(answer), opts.timeoutMs); });
  const fleet = {
    runsPage: (opts) => { asked.push(["runsPage", opts.timeoutMs]); return atBound({ ...RUNS_PAGE_IN_OUTAGE, runs: local })(opts); },
    runById: (id, opts) => { asked.push(["runById", id, opts?.timeoutMs]); return atBound({ unreadable: "the fleet's run mirror could not be read" })(opts); },
  };
  // With no snapshot the view reads the settings overlay itself, from the file.
  const settingsFile = join(tempDir("pd-988-models-"), "settings.json");
  writeFileSync(settingsFile, "{}");
  const own = [];
  const input = { now: NOW, snapshot: null, paths: { settingsFile }, env: { PI_PROVIDER: "p", PI_MODEL: "main" }, fleet, reads, within: (ms) => (own.push(ms), 1) };
  const view = await readModelsView(input);
  // The history's page, the source record's lookup and the cooldowns; no counter is asked for once a cooldown read was cut.
  assert.deepEqual(own, [MODELS_LIMITS.timeoutMs, MODELS_LIMITS.timeoutMs, MODELS_LIMITS.timeoutMs]);
  assert.deepEqual(asked, [["runsPage", 1], ["runById", "gh-5", 1]], "the reader is handed the same bound the view waits by");
  assert.equal(view.state, "ready");
  assert.equal(view.coverage.records, 2, "this host's two records, never 0 for a history that was not read whole");
  assert.equal(view.coverage.partial, true);
  assert.equal(view.cooldownsUnread, true);
  assert.equal(view.models.find((model) => model.ref === "p/main").windows[0].unavailable, true);
  own.length = 0;
  await readModelsView({ ...input, reads: { ...reads, cooldowns: async () => [] } });
  assert.deepEqual(own, [MODELS_LIMITS.timeoutMs, MODELS_LIMITS.timeoutMs, MODELS_LIMITS.timeoutMs, MODELS_LIMITS.timeoutMs], "and the counters, each read its own bound");
  // With no deadline the reader is called as it was: no bound named, for a page of the history or for a source record.
  asked.length = 0;
  const whole = await readModelsHistory({ fleet: { runsPage: async (opts) => { asked.push(["runsPage", Object.keys(opts).sort()]); return { runs: local, next: null, mirror: "ok" }; }, runById: async (...args) => { asked.push(["runById", args.length]); return { missing: true }; } }, now: NOW });
  assert.deepEqual(asked, [["runsPage", ["before", "limit"]], ["runById", 1]]);
  assert.deepEqual([whole.records.length, whole.partial, whole.sourcesUnknown], [2, false, true]);
});

test("readProjectView hands the allocation and the fleet's run pages their bound: the envelope's own figures and this host's runs are still drawn", async () => {
  // A real envelope file and the real allocation read, over a Valkey that answers nothing.
  const dir = tempDir("pd-988-project-");
  const paths = { projectsFile: join(dir, "projects.json"), scopedLimitsPath: join(dir, "limits.json"), envelopeFile: join(dir, "envelope.json"), logsDir: join(dir, "logs"), valkeyUrl: "redis://127.0.0.1:1" };
  mkdirSync(paths.logsDir);
  writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "billing", name: "Billing", members: ["github:acme/billing"] }] }));
  writeFileSync(paths.envelopeFile, JSON.stringify({ version: 1, window: "week", totalUsd: "70", floorsUsd: { billing: "10", _other: "0" }, defaultWeights: { billing: 1, _other: 1 } }));
  const never = new Proxy({}, { get: (_, key) => (typeof key === "symbol" || key === "then" ? undefined : key === "on" || key === "disconnect" ? () => {} : silent) });
  _setAllocationSeamsForTests({ redisFn: () => never, now: () => new Date(NOW) });
  // The allocation read's own timer holds no process open, so here something else keeps the loop turning for it.
  const keep = setTimeout(() => {}, 10_000);
  try {
    const pages = [];
    const fleet = { runsPage: (opts) => { pages.push(opts.timeoutMs); return new Promise((resolve) => { setTimeout(() => resolve({ ...RUNS_PAGE_IN_OUTAGE, runs: [{ jobId: "gh-9", kind: "github", target: "acme/billing#1", project: "billing", outcome: "completed", endedAt: iso(1000) }] }), opts.timeoutMs); }); } };
    const own = [];
    const view = await readProjectView({ id: "billing", paths, env: { PI_MAX_COST_USD: "3" }, now: NOW, snapshot: null, fleet, within: (ms) => (own.push(ms), 1), reads: { limits: () => ({ limits: [] }), triggers: () => ({ triggers: [] }), settings: () => ({ overlay: {} }), subscriptions: () => ({ subscriptions: [] }), scan: () => [], sizing: () => ({ projects: {} }), edit: () => ({ plan: {} }), delete: () => ({ plan: {} }) } });
    assert.deepEqual(own.sort(), [ALLOCATION_READ_MS, RUN_MIRROR_READ_MS].sort(), "the allocation's read and the history's page, each its own bound");
    assert.deepEqual(pages, [1], "the reader is handed the bound");
    assert.equal(view.state, "ready");
    // The allocation's own answer for a Valkey that did not answer: the file's window, total and floor, the split unread.
    assert.deepEqual([view.allocation.window, view.allocation.totalMicros, view.allocation.floorMicros, view.allocation.shareMicros], ["week", 70_000_000, 10_000_000, null]);
    assert.equal(view.spend.problem, "The allocation could not be read from Valkey.");
    // The history's own answer: this host's run is counted, and the search is incomplete.
    assert.deepEqual([view.totalRuns, view.historyIncomplete], [1, true]);
  } finally {
    clearTimeout(keep);
    _setAllocationSeamsForTests({});
  }
  // With no deadline each reader is called as it was, with no bound named.
  const seen = [];
  await readProjectFleetRuns({ runsPage: async (opts) => { seen.push(Object.keys(opts).sort()); return { runs: [], next: null, mirror: "off" }; } }, { sinceMs: 0 });
  assert.deepEqual(seen, [["before", "limit"]]);
  let options = null;
  await readProjectView({ id: "billing", paths: { projectsFile: "/srv/deployment/projects.json" }, now: NOW, snapshot: null, fleet: { runsPage: async () => ({ runs: [], next: null, mirror: "off" }) }, reads: { projects: () => ({ projects: [{ id: "billing", members: ["github:acme/billing"] }] }), limits: () => ({ limits: [] }), triggers: () => ({ triggers: [] }), settings: () => ({ overlay: {} }), subscriptions: () => ({ subscriptions: [] }), scan: () => [], allocation: (_paths, _counts, opts) => { options = opts; return { unset: true }; }, sizing: () => ({ projects: {} }), edit: () => ({ plan: {} }), delete: () => ({ plan: {} }) } });
  assert.ok(options !== null && !Object.hasOwn(options, "timeoutMs"));
});

// ---- the fleet reader's two reads that take a caller's bound --------------------------------------------------------

/** `run()`'s answer and every delay armed on the process's timers while it ran: what a reader's bound really was. */
async function timersArmed(run) {
  const real = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return real(fn, ms, ...rest); };
  try {
    return { got: await run(), delays };
  } finally {
    globalThis.setTimeout = real;
  }
}

test("the real reader: a run's record and the runs' window end at the bound a page hands them, each with this host's part and its own word for the rest", async () => {
  // This host holds one run of the last day. The fleet's mirror takes each read and answers when the test says so.
  const logsDir = tempDir("pd-988-reader-");
  writeFileSync(join(logsDir, "gh-local.json"), JSON.stringify({ jobId: "gh-local", kind: "github", target: "acme/web#1", outcome: "completed", reason: null, host: "build3", startedAt: iso(120_000), endedAt: iso(60_000) }));
  const mirror = { index: null, record: null };
  const held = (slot) => new Promise((resolve) => { mirror[slot] = resolve; });
  const redis = { on() {}, disconnect() {}, zrevrangebyscore: () => held("index"), get: () => held("record"), exists: async () => 0 };
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir }, { makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => redis, nowFn: () => NOW, readOnly: true });

  // A record this host holds needs no mirror, whatever the bound.
  assert.equal((await reader.runById("gh-local", { timeoutMs: 7 })).record.jobId, "gh-local");
  assert.equal(mirror.record, null, "the mirror was not asked");
  // One it does not hold: the mirror is asked for as long as the caller says, and the reader's own word is its answer.
  const cut = await timersArmed(() => reader.runById("gh-other", { timeoutMs: 7 }));
  assert.deepEqual(cut.got, { unreadable: RUN_MIRROR_UNREAD });
  assert.deepEqual([cut.delays.includes(7), cut.delays.includes(RUN_MIRROR_READ_MS)], [true, false], "the caller's bound, not the reader's default");
  // With no bound from the caller the mirror has the reader's own.
  const own = await timersArmed(async () => { const reading = reader.runById("gh-other"); await new Promise((resolve) => setImmediate(resolve)); mirror.record(null); return reading; });
  assert.deepEqual(own.got, { missing: true }, "both sides read, and neither holds it");
  assert.ok(own.delays.includes(RUN_MIRROR_READ_MS));

  // The runs' window: the read is the shared one with its own bound. A caller whose time ends first is answered from
  // this host's records alone, in a window that says it is partial, as the read answers a mirror that gave nothing.
  const waited = await timersArmed(() => reader.runsWindow({ timeoutMs: 7 }));
  assert.ok(waited.delays.includes(7));
  assert.equal(waited.got.partial, true);
  assert.equal(Object.values(waited.got.byOutcome).reduce((sum, count) => sum + count, 0), 1, "this host's run is counted");
  // The shared read went on: once the mirror answers, its window is kept for the next caller, whole.
  mirror.index([]);
  const whole = await reader.runsWindow();
  assert.equal(whole.partial, false, "a mirror that is off is a whole answer");
  assert.equal(Object.values(whole.byOutcome).reduce((sum, count) => sum + count, 0), 1);
  assert.deepEqual(await reader.runsWindow({ timeoutMs: 7 }), whole, "and a caller with a bound takes that kept window at once");
  await reader.dispose();
});

test("waitedFor ends a wait, not the read: the answer in time, the late one past it, and no time at all means the read itself", async () => {
  assert.equal(await waitedFor(Promise.resolve("answer"), 50, () => "late"), "answer");
  let reject;
  const reading = new Promise((_, rej) => { reject = rej; });
  const keep = setTimeout(() => {}, 2_000);
  try {
    assert.equal(await waitedFor(reading, 5, () => "late"), "late");
    // The read goes on and fails later: nothing is raised for it.
    const seen = [];
    const note = (reason) => seen.push(reason);
    process.on("unhandledRejection", note);
    reject(new Error("Command timed out"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", note);
    assert.deepEqual(seen, []);
  } finally {
    clearTimeout(keep);
  }
  await assert.rejects(waitedFor(Promise.reject(new Error("ECONNREFUSED")), 50, () => "late"), /ECONNREFUSED/);
  const same = Promise.resolve("answer");
  assert.equal(waitedFor(same, Infinity, () => "late"), same, "no deadline: the read is awaited as it was");
});

test("each bound a page names for a reader is that reader's own, so a page with time left changes no read", () => {
  // A page hands a reader its bound or what is left of the deadline, so it has to name the bound. Each is held here
  // to the default in the reader's own signature: a reader whose default moves fails this until the page's does.
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const pins = [
    ["../src/read-model.mjs", /export async function readCapacity\(\{[^\n]*\btimeoutMs = (\d[\d_]*)\b/, HOST_CAPACITY_TIMEOUT_MS],
    ["../src/read-model.mjs", /export async function readAllocations\(\{[^\n]*\btimeoutMs = (\d[\d_]*)\b/, ALLOCATION_READ_MS],
    ["../src/trigger-schedule-zones.mjs", /export async function readTriggerScheduleZones\(\{[^\n]*\btimeoutMs = (\d[\d_]*)\b/, SCHEDULE_ZONES_TIMEOUT_MS],
    ["../../worker/src/endpoint-status.mjs", /readEndpointStatusInner\(redis, \{ \.\.\.options, stopped: \(\) => stopped \}\), options\.timeoutMs \?\? (\d[\d_]*)\)/, PUBLICATION_READ_MS.endpointStatus],
    ["../../worker/src/receiver-status.mjs", /export async function readReceiverStatus\(redis, \{[^\n]*\btimeoutMs = (\d[\d_]*)\b/, PUBLICATION_READ_MS.receivers],
    ["../../worker/src/poller-status.mjs", /export async function readPollerStatus\(redis, \{[^\n]*\btimeoutMs = (\d[\d_]*)\b/, PUBLICATION_READ_MS.pollers],
    ["../../worker/src/hook-runs.mjs", /export async function readHookRuns\(redis, \{[^\n]*\btimeoutMs = (\d[\d_]*)\b/, PUBLICATION_READ_MS.hookRuns],
  ];
  for (const [path, signature, named] of pins) {
    const found = signature.exec(source(path));
    assert.ok(found, `${path}: the reader's bound is where this test reads it`);
    assert.equal(Number(found[1].replaceAll("_", "")), named, path);
  }
  // The run history's two readers and the slots' read take their default from the name a page hands them.
  const readModel = source("../src/read-model.mjs");
  assert.match(readModel, /export async function readRunsPage\(redis, \{[^\n]*\btimeoutMs = RUN_MIRROR_READ_MS\b/);
  assert.match(readModel, /export async function readRunById\(redis, \{[^\n]*\btimeoutMs = RUN_MIRROR_READ_MS\b/);
  assert.match(source("../src/connections-view.mjs"), /export async function readEndpointSlots\(redis, endpoints, \{ timeoutMs = PUBLICATION_READ_MS\.slots \} = \{\}\)/);
});
