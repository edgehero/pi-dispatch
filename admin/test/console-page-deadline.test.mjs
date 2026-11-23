import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPageData, PAGE_READS, pagePanels, parsePageQuery } from "../src/console/pages.mjs";
import { PAGE_DEADLINE_MS, PAGE_VIEW_GRACE_MS } from "../src/console/page-deadline.mjs";
import { dirname } from "node:path";
import { cachedPerWindow, HOST_CAPACITY_TIMEOUT_MS, SCHEDULE_ZONES_TIMEOUT_MS, UPDATES_FACTS_TIMEOUT_MS, waitedFor } from "../src/console/cli.mjs";
import { ANSWER_STORE_MS, makeAnswererService } from "../src/answerer-data.mjs";
import { makeSandboxService } from "../src/sandbox-data.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { makeZeroTouchService, ZERO_TOUCH_STORE_MS } from "../src/zero-touch-data.mjs";
import { PUBLICATION_READ_MS, readConnections } from "../src/connections-view.mjs";
import { MODELS_LIMITS, readModelsHistory, readModelsView } from "../src/models-view.mjs";
import { ALLOCATION_READ_MS, readProjectFleetRuns, readProjectView } from "../src/project-view.mjs";
import { _setAllocationSeamsForTests } from "../src/insights-assembly.mjs";
import { createFleetReader, HOST_HISTORY_READ_MS, RUN_MIRROR_READ_MS, RUN_MIRROR_UNREAD, TRIGGER_SKEW_READ_MS } from "../src/read-model.mjs";
import { CAPACITY_OP_TIMEOUT_MS } from "@edgehero/pi-dispatch/capacity-records";
import { QUESTION_GROUP_LIMITS } from "@edgehero/pi-dispatch/question-groups";
import { downRedis, quietQueue } from "./helpers/fleet-reader-fakes.mjs";
import { handTime } from "./helpers/hand-time.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fileViewsFixture, noSnapshotFleet, outagePaths, RUNS_PAGE_IN_OUTAGE } from "./helpers/no-snapshot.mjs";

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
 *   - `valkey`: only Valkey answers it, and it takes no bound. The load waits for it until the deadline and does not
 *     make it once the deadline has passed.
 *   - `bound`: it takes its bound from the page (`BOUNDS` says how), and on a Valkey that does not answer it ends at
 *     that bound with its own answer, as every such reader does. The load makes it until the grace has passed too.
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
  "fleet.triggerSkew": ["bound", () => ({ ok: true })],
  "fleet.runHolds": ["valkey", () => []],
  "fleet.runById": ["bound", () => ({ missing: true })],
  "fleet.runsPage": ["bound", () => ({ runs: [], next: null, mirror: "ok", truncated: false, examined: 0 })],
  "fleet.runsWindow": ["bound", () => ({ at: NOW, floor: false, partial: false, byOutcome: {}, byProject: [], projectsMore: 0, byReason: {}, values: {}, spentMicros: 0, unpriced: 0 })],
  hostLoads: ["valkey", () => ({ hosts: [], more: 0 })],
  "answerer.read": ["bound", () => ({ state: "ok", partial: false, rows: [] })],
  gatewayView: ["valkey", () => ({ enabledHosts: [], sessions: [] })],
  "sandboxes.read": ["valkey", () => ({ hosts: [], sessions: [], options: [], selected: {} })],
  "sandboxes.workspace": ["valkey", () => ({ unknown: true, notPublished: true })],
  zeroTouch: ["bound", () => ({ coverage: { partial: false, reasons: [] }, totals: {}, projects: [], touchedRunIds: [] })],
  zeroTouchRuns: ["bound", () => ({ runs: [], next: null, mirror: "off", truncated: false, examined: 0 })],
  triggerFireCheck: ["valkey", () => ({ ok: true })],
  "watch.listRules": ["valkey", () => [{ id: "r1", source: "s1" }]],
  "watch.listFindings": ["valkey", () => []],
  // The watch sources are the triggers file's, read with no Valkey.
  "watch.listSources": ["files", () => []],
  "watch.readBoard": ["valkey", () => ({ rule: "r1" })],
  "watch.readFinding": ["valkey", () => ({ id: "f1", ruleId: "r1" })],
  "watch.readTrace": ["valkey", () => []],
  setup: ["bound", () => ({ enabled: false, reason: "host-setup-disabled", actions: [], providerKey: null, progress: [], allowlistCount: 3 })],
  modelsView: ["bound", () => ({ state: "ready", roles: [] })],
  connections: ["bound", () => ({ environmentUnknown: false, forges: [], snapshotUnreadable: false })],
  updates: ["bound", () => ({ rows: [] })],
  projectView: ["bound", () => ({ id: "web", state: "ready" })],
  triggerList: ["bound", () => ({ rows: [], problems: [] })],
  hostCapacity: ["bound", () => ({ hosts: [] })],
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
 * How each read that takes a bound is handed it, and the bound it has by itself: `[own, handed(...args), asked]`. A
 * run's record, a history page, the runs' window and a trigger's skew check take a number of milliseconds; a view and
 * a service take the page's `within` and ask it with the bound of the read they are about to make. `asked` is what
 * the page asks its deadline for where that is not the read's own bound.
 */
const asks = (own, at) => [own, (...args) => args.at(at)?.within?.(own)];
const BOUNDS = {
  "fleet.runById": [RUN_MIRROR_READ_MS, (id, opts) => opts?.timeoutMs],
  "fleet.runsPage": [RUN_MIRROR_READ_MS, (opts) => opts?.timeoutMs],
  // The window is a shared read with a bound of its own: a page waits for it as long as its deadline has (`asked`).
  "fleet.runsWindow": [RUN_MIRROR_READ_MS, (opts) => opts?.timeoutMs, Infinity],
  "fleet.triggerSkew": [TRIGGER_SKEW_READ_MS, (index, waiting, opts) => opts?.timeoutMs],
  zeroTouch: asks(ZERO_TOUCH_STORE_MS, 0),
  zeroTouchRuns: asks(ZERO_TOUCH_STORE_MS, 0),
  "answerer.read": asks(ANSWER_STORE_MS, 0),
  setup: asks(PUBLICATION_READ_MS.endpointStatus, 0),
  modelsView: asks(MODELS_LIMITS.timeoutMs, 1),
  connections: asks(PUBLICATION_READ_MS.endpointStatus, 1),
  updates: asks(UPDATES_FACTS_TIMEOUT_MS, 0),
  projectView: asks(ALLOCATION_READ_MS, 2),
  triggerList: asks(SCHEDULE_ZONES_TIMEOUT_MS, 1),
  hostCapacity: asks(HOST_CAPACITY_TIMEOUT_MS, 1),
};

/**
 * What each read answers on a Valkey that answers nothing, from the REAL service: the fleet reader, the answer rules,
 * the zero touch report, the sandbox report and the hosts' doctor results, each over a client whose every command
 * ends unanswered (`downRedis`) and over the outage fixture's files. So a page cut at its deadline is held against
 * what its readers themselves say in an outage, not against a throw: a read whose own answer says more than the
 * page's catch does (the answer rules keep the rules and standing answers of the triggers file; the touched runs keep
 * this host's part and say the window is partial) shows here the moment the page cuts it from outside.
 *
 * THE GAP, named: that client ends every command AT ONCE, in the words a bounded client ends a command a silent socket
 * never answered ("Command timed out"). A read that takes no bound from the page ends that way on a silent socket
 * too, later. But a service that ends a silent read by a timer of its own may word it differently (the fleet reader's
 * "no answer in time" beside "Command timed out" in the same sentence), and that wording is not what this table
 * holds a page against. It is held by the tests of the real reader and services on a socket that stays silent, near
 * the end of this file: a run's record and the runs' window, a run asked of the host that holds it, a trigger's skew
 * check, the zero touch report with its touched runs, and the answer rules. The sandbox report and the hosts' doctor
 * runs have no such case: neither takes a bound from the page.
 *
 * Three kinds of read have no service to run here and keep a stand-in. The gateway view and the Fire now check are
 * the console's own wiring around a reader and a planner: a throw, which is what the page catches. The views over
 * the snapshot (Setup, Models, Connections, Updates, a project, the trigger list, a host's capacity) are handed their
 * bound and answer for themselves: the table's answer in both, since the page draws whatever they say, and their own
 * outage answers have tests of their own below.
 */
function outageAnswers() {
  const paths = outagePaths();
  const reader = noSnapshotFleet({}, { now: () => NOW, pinned: false });
  const services = { redisFn: () => downRedis(), now: () => NOW, env: {}, paths };
  const zeroTouch = makeZeroTouchService(services);
  const answerer = makeAnswererService(services);
  const sandboxes = makeSandboxService({ ...services, deploymentDir: dirname(paths.triggersPath), fleet: reader });
  const real = {
    hostLoads: () => readHostLoadsView(downRedis(), { now: () => NOW }),
    "answerer.read": (query) => answerer.read(query),
    "sandboxes.read": (query) => sandboxes.read(query),
    "sandboxes.workspace": (record) => sandboxes.workspace(record),
    zeroTouch: (query) => zeroTouch.read(query),
    zeroTouchRuns: (query) => zeroTouch.runs(query),
  };
  return (name) => {
    if (Object.hasOwn(real, name)) return real[name];
    if (name.startsWith("fleet.")) return (...args) => reader[name.slice("fleet.".length)](...args);
    if (name.startsWith("watch.")) return (...args) => reader.watch[name.slice("watch.".length)](...args);
    if (kindOf(name) === "bound") return READS[name][1];
    return () => Promise.reject(refused());
  };
}

/**
 * A page's dependencies with every read named and counted. `how(name, kind, at)` says how a read ends: "answer";
 * "silent", a Valkey that takes the read and answers nothing (a read that takes no bound never settles, and one that
 * takes a bound ends at the bound it was handed, or at its own where it was handed none, with its own outage
 * answer); "outage", that outage answer at once; "refuse" (it fails at once); or a number of milliseconds after
 * which it fails. `answers` lays a case's own answers over the table's; `without` leaves fleet methods out, as an
 * older reader double has none;
 * `takes` makes every read that asks Valkey answer after that many milliseconds, and a call then keeps when it ended;
 * `slowFiles` makes what the files answer take as long.
 */
function probe(time, { how = () => "answer", answers = {}, without = [], takes = 0, slowFiles = false } = {}) {
  const start = time.clock();
  const calls = [];
  const logs = [];
  let outage = null;
  const inOutage = (name, args) => Promise.resolve().then(() => (outage ??= outageAnswers())(name)(...args));
  const read = (name) => (...args) => {
    const at = time.clock() - start;
    const call = { name, at, end: null };
    calls.push(call);
    const answer = () => (answers[name] ?? READS[name][1])(...args);
    const verdict = kindOf(name) === "files" ? "answer" : how(name, kindOf(name), at);
    if (verdict === "outage") return inOutage(name, args);
    if (verdict === "silent" && kindOf(name) === "bound") {
      const [own, handed] = BOUNDS[name];
      call.handed = handed(...args);
      return new Promise((resolve) => { time.timers.setTimeout(() => resolve(inOutage(name, args)), call.handed ?? own); });
    }
    // `takes`: a Valkey that answers every read, each after that many milliseconds (a number, or a function of the
    // read's name); what the files answer costs none, unless `slowFiles` gives them the same.
    const ms = kindOf(name) === "files" && !slowFiles ? 0 : typeof takes === "function" ? takes(name) : takes;
    if (verdict === "answer" && ms > 0) return new Promise((resolve) => { time.timers.setTimeout(() => { call.end = time.clock() - start; resolve(answer()); }, ms); });
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
 * One load on the hand clock, stepped to the deadline and to the grace: `{ data, at, took, calls, logs }`, `at` the
 * hand time it came back at (0 at once, the deadline, the deadline and the grace) or null when it has not come back by
 * then, and `took` the hand clock's own reading when it did, to the millisecond. `wire` lays dependencies of a test's
 * own over the probe's, or is a function that changes them.
 */
async function loaded(page, query, who, options, { deadlineMs = D, wire = {} } = {}) {
  const time = handTime();
  const { deps, calls, logs } = probe(time, options);
  deps.deadline.ms = deadlineMs;
  if (typeof wire === "function") wire(deps);
  else Object.assign(deps, wire);
  let data = null;
  let at = null;
  let took = null;
  const start = time.clock();
  const back = (when) => { if (data !== null && at === null) at = when; };
  loadPageData(page, query, deps, who).then((got) => { data = got; took = time.clock() - start; });
  await time.settled();
  back(0);
  for (const [step, when] of [[D - 1, D - 1], [1, D], [G - 1, D + G - 1], [1, D + G]]) {
    await time.advance(step);
    back(when);
  }
  return { data, at, took, calls, logs, waiting: time.waiting() };
}

/** A run's record, by what its page then reads. */
const PARKED = { ...RECORD, reason: "awaiting-input" };
const REFUSED_RUN = { ...RECORD, outcome: "policy", reason: "job-image-missing", tokens: null, exitCode: null, budgetReserved: false };
const RECOVERED = { ...RECORD, replica: 1, replicas: 2, checkpoints: 1 };
/** `starts`: where the page's reads start other than the table below says (`STARTS`). A record's children are searched for once it is read. */
const run = (record, more = {}) => ({ page: "run", qs: "id=gh-1", answers: { "fleet.runById": (id) => (id === "gh-1" ? { record, source: "local" } : { missing: true }), ...more.answers }, without: more.without ?? [], starts: { "fleet.runsPage": [1], ...more.starts } });

/** Every page kind, and for the pages whose reads depend on what an earlier read gave, each such state. */
const CASES = [
  { page: "setup" }, { page: "models" }, { page: "sandboxes" }, { page: "sandboxes", qs: "id=gh-1", label: "a kept workspace's run" },
  { page: "zero-touch" }, { page: "overview" }, { page: "runs" }, { page: "runs", qs: "touched=1&days=30", label: "the touched runs" },
  { ...run(RECORD), label: "a record on this host" },
  { page: "run", qs: "id=gh-1", label: "no record anywhere" },
  // The chat of a parked run is one read that makes three, one after another (the job's state, a search of the run
  // history for a newer run, the scan for a pending answer), and its answer check follows the chat.
  { ...run(PARKED, { starts: { "fleet.runsPage": [1, 2], "fleet.pendingAnswer": [3], "fleet.parkedAnswerCheck": [4] } }), label: "a parked run, whose chat is a reply" },
  // Its page also draws the snapshot and the runs' window, read once the record says it was refused.
  { ...run(REFUSED_RUN, { starts: { "fleet.snapshot": [1], "fleet.runsWindow": [1] } }), label: "a run refused before it started" },
  // Its sibling replica and its recovery are looked up by the record's own ids, together.
  { ...run(RECOVERED, { starts: { "fleet.runById": [0, 1, 1] } }), label: "a replica that was recovered" },
  // The run that continues it is named by the chat: its live facts and its progress are read after the chat, together.
  { ...run(RECORD, { answers: { "fleet.jobStatus": () => ({ found: true, state: "completed", continuesAs: "gh-1.r1" }) }, starts: { "fleet.progressOfRun": [1, 2], "fleet.runLiveFacts": [2] } }), label: "a run that goes on as a recovery" },
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
 * Four reads say "not read" in two shapes that every panel draws alike (the test "two shapes of not read are one
 * drawing" holds them to it): the hosts' doctor results answer `{ unreachable, hosts: [] }` for a registry that did
 * not answer, where the page's catch keeps null and a mark of its own; a run's progress names what could not be read
 * where the catch says only that it could not, and the progress of the run that continues it is null there; and a
 * workspace nobody could read carries a shell of null where the catch names none. Each is written here as the catch
 * writes it.
 */
function asDrawn(data) {
  const drawn = { ...data };
  if (drawn.hostLoads?.unreachable === true && drawn.hostLoads.hosts?.length === 0) Object.assign(drawn, { hostLoads: null, hostLoadsUnread: true });
  if (typeof drawn.progress?.unreachable === "string") drawn.progress = { ...drawn.progress, unreachable: true };
  if (typeof drawn.recoveryProgress?.progress?.unreachable === "string") drawn.recoveryProgress = null;
  if (drawn.workspace?.unknown === true && drawn.workspace.shell === null) { const { shell, ...rest } = drawn.workspace; drawn.workspace = rest; }
  return drawn;
}

/**
 * One case over a Valkey that takes the reads in `quiet` and answers none of them (`quiet(name)`), against the same
 * page over a console with no deadline at all, where each of those reads gives what its real service says in an
 * outage. The page a deadline cut must be that page: what a reader says of a Valkey that did not answer is drawn in
 * the reader's words, and what the page says for a read it cut is what that read would have said.
 */
async function cutAgainstOutage(c, quiet, what) {
  const query = queryOf(c);
  const base = { answers: c.answers, without: c.without };
  const cut = await loaded(c.page, query, OP, { ...base, how: (name) => (quiet(name) ? "silent" : "answer") });
  const outage = await loaded(c.page, query, OP, { ...base, how: (name) => (quiet(name) ? "outage" : "answer") }, { deadlineMs: 3_600_000 });
  assert.ok(cut.took !== null && cut.took <= D + G, `${what}: the page is back by the deadline and the grace, whatever Valkey does`);
  assert.ok(outage.data !== null, `${what}: the readers' own outage answers make a page`);
  // Past the deadline nothing that only Valkey answers is asked, and past the grace nothing at all.
  assert.deepEqual(cut.calls.filter((call) => kindOf(call.name) === "valkey" && call.at >= D).map((call) => call.name), [], `${what}: asked after the deadline`);
  assert.deepEqual(cut.calls.filter((call) => kindOf(call.name) === "bound" && call.at >= D + G).map((call) => call.name), [], `${what}: asked after the grace`);
  assert.equal(cut.waiting, 0, `${what}: no timer is left behind`);
  const { deadlineSpent, snapshotFailure, ...drawn } = cut.data;
  const expected = asDrawn(outage.data);
  // The chat facts are one read made of three (the job's state, a search of the run history for a newer run, the scan
  // for a pending answer), with no bound to hand it: cut inside the scan it is the whole read's unread answer, where
  // the scan failing by itself leaves the facts with that part unknown.
  if (quiet("fleet.pendingAnswer") && !quiet("fleet.jobStatus") && cut.calls.some((call) => call.name === "fleet.pendingAnswer")) expected.chat = { unreachable: true };
  assert.deepEqual(asDrawn(drawn), expected, `${what}: each read drawn as its own service answers a Valkey that did not answer`);
  // The two marks are the deadline's own: the load says it was cut where it stopped waiting for a read, or a read
  // that was handed less than its own bound ended with the deadline; the snapshot's failure is "late" where the
  // snapshot is what it cut.
  const cutShort = cut.calls.some((call) => quiet(call.name) && (kindOf(call.name) === "valkey" || (kindOf(call.name) === "bound" && call.handed < (BOUNDS[call.name][2] ?? BOUNDS[call.name][0]) && call.at + call.handed >= D)));
  assert.equal(deadlineSpent === true, cutShort, `${what}: marked as cut where a read was, or ended at the deadline on less than its own bound (back at ${cut.took} ms)`);
  assert.equal(snapshotFailure, quiet("fleet.snapshot") && cut.calls.some((call) => call.name === "fleet.snapshot") ? "late" : undefined, `${what}: the snapshot's failure`);
  assert.deepEqual(cut.logs, [], `${what}: nothing for the console's log`);
  assert.ok(!Object.hasOwn(outage.data, "deadlineSpent") && !Object.hasOwn(outage.data, "snapshotFailure"), `${what}: an outage is not a deadline`);
  return { cut, outage };
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

test("a Valkey that answers nothing: every page is back by the deadline and the grace, each read drawn as its own service answers an outage", async () => {
  for (const c of CASES) await cutAgainstOutage(c, (name) => kindOf(name) !== "files", `${nameOf(c)}, nothing answers`);
});

test("each read of each page, the only one that does not answer: the page is back at the deadline with that read's own unread answer and every answer that needs nothing of it", async () => {
  let cases = 0;
  for (const c of CASES) {
    const healthy = await loaded(c.page, queryOf(c), OP, { answers: c.answers, without: c.without });
    for (const name of [...new Set(healthy.calls.map((call) => call.name))].filter((read) => kindOf(read) !== "files")) {
      await cutAgainstOutage(c, (read) => read === name, `${nameOf(c)}, ${name} alone does not answer`);
      cases += 1;
    }
  }
  assert.ok(cases >= 100, `${cases} reads of pages, each cut alone`);
});

test("two shapes of not read are one drawing: a run's page and a trigger's page say the same of each, for both roles", async () => {
  // `asDrawn` writes four reads' own outage answers as the page's catch writes them. That is only fair where no panel
  // tells the two apart, so here each page is drawn with one shape and with the other, and the panels are compared.
  const outage = outageAnswers();
  const loads = await outage("hostLoads")();
  const progress = await outage("fleet.progressOfRun")("gh-1", RECORD);
  const workspace = await outage("sandboxes.workspace")(RECORD);
  assert.deepEqual([loads, progress.progress, workspace], [{ unreachable: true, hosts: [], more: 0 }, { unreachable: "the progress key could not be read" }, { shell: null, sessionsUnknown: true, unknown: true }], "what the real services say in an outage");
  const drawings = async (page, qs, data) => {
    const out = [];
    for (const role of ["operator", "viewer"]) out.push((await pagePanels(page, { query: parsePageQuery(page, new URLSearchParams(qs)).query, session: { name: "ada", role }, data, readOnly: false })).map((panel) => String(panel.html)));
    return out;
  };
  const goesOn = CASES.find((one) => one.label === "a run that goes on as a recovery");
  const run = (await loaded("run", queryOf(goesOn), OP, { answers: goesOn.answers })).data;
  const theirs = { ...run, hostLoads: loads, progress: progress.progress, recoveryProgress: progress, workspace };
  const pages = { ...run, hostLoads: null, hostLoadsUnread: true, progress: { unreachable: true }, recoveryProgress: null, workspace: { unknown: true, sessionsUnknown: true } };
  assert.notDeepEqual(theirs, pages);
  assert.deepEqual(asDrawn(theirs), asDrawn(pages));
  assert.deepEqual(await drawings("run", "id=gh-1", theirs), await drawings("run", "id=gh-1", pages), "a run's page");
  const sandboxes = (await loaded("sandboxes", {}, OP, {})).data;
  assert.deepEqual(await drawings("sandboxes", "", { ...sandboxes, hostLoads: loads }), await drawings("sandboxes", "", { ...sandboxes, hostLoads: null, hostLoadsUnread: true }), "the Sandboxes page");
  const trigger = (await loaded("trigger", { index: 0 }, OP, {})).data;
  assert.deepEqual(await drawings("trigger", "index=0", { ...trigger, hostLoads: loads }), await drawings("trigger", "index=0", { ...trigger, hostLoads: null, hostLoadsUnread: true }), "a trigger's page");
});

test("each read that takes a bound is handed what is left of the page's deadline, and its own bound whole while there is time", async () => {
  // A page with time left hands every such read its own bound, so the deadline changes no read; with 1.5 s left of a
  // short deadline each is handed that; and a read that starts once the snapshot or the record has answered, a second
  // into that deadline, is handed the half second that remains. One case per read, so a call that stopped passing the
  // bound on shows as a read that was handed none.
  const refusedRun = CASES.find((one) => one.label === "a run refused before it started");
  const recovered = CASES.find((one) => one.label === "a replica that was recovered");
  const handoffs = [
    { read: "fleet.runsPage", page: "runs" }, { read: "fleet.runsWindow", page: "runs", own: D }, { read: "zeroTouchRuns", page: "runs", qs: "touched=1&days=30" },
    { read: "zeroTouch", page: "zero-touch" }, { read: "answerer.read", page: "parked" }, { read: "updates", page: "updates" }, { read: "hostCapacity", page: "host", qs: "name=build3" },
    { read: "fleet.runById", page: "run", qs: "id=gh-1" }, { read: "fleet.runById", page: "sandboxes", qs: "id=gh-1" },
    { read: "setup", page: "setup", after: "fleet.snapshot" }, { read: "setup", page: "connections", after: "fleet.snapshot" }, { read: "connections", page: "connections", after: "fleet.snapshot" },
    { read: "modelsView", page: "models", after: "fleet.snapshot" }, { read: "projectView", page: "project", qs: "id=web", after: "fleet.snapshot" }, { read: "triggerList", page: "triggers", after: "fleet.snapshot" },
    { read: "fleet.triggerSkew", page: "trigger", qs: "index=0", after: "fleet.snapshot" },
    { read: "fleet.runsPage", page: "run", qs: "id=gh-1", after: "fleet.runById", answers: recovered.answers }, { read: "fleet.runById", page: "run", qs: "id=gh-1", after: "fleet.runById", answers: recovered.answers, nth: 1 },
    { read: "fleet.runsWindow", page: "run", qs: "id=gh-1", after: "fleet.runById", answers: refusedRun.answers, own: D },
  ];
  for (const { read, page, qs = "", after = null, answers = {}, nth = 0, own = BOUNDS[read][0] } of handoffs) {
    const what = `${page}: ${read}${nth ? ", the related run's" : ""}`;
    const query = parsePageQuery(page, new URLSearchParams(qs)).query;
    // What the read was handed, in a load whose deadline is `ms`, with `after` taking a second where the read needs it.
    const handedIn = async (ms) => {
      const time = handTime();
      const seen = [];
      const table = (name) => (...args) => (answers[name] ?? READS[name][1])(...args);
      const slowOnce = (name) => { let calls = 0; return (...args) => ((calls += 1) === 1 ? new Promise((resolve) => { time.timers.setTimeout(() => resolve(table(name)(...args)), 1_000); }) : table(name)(...args)); };
      const made = after === read ? slowOnce(read) : table(read);
      const { deps } = probe(time, { answers: { ...answers, ...(after ? { [after]: slowOnce(after) } : {}), [read]: (...args) => { seen.push(BOUNDS[read][1](...args)); return made(...args); } } });
      deps.deadline.ms = ms;
      let over = false;
      loadPageData(page, query, deps, OP).then(() => { over = true; });
      await time.advance(1_000);
      assert.ok(over, `${what}: the page is back`);
      return seen[nth];
    };
    assert.equal(await handedIn(D), own === D ? (after ? D - 1_000 : D) : own, `${what}: its own bound while the page has time`);
    assert.equal(await handedIn(1_500), after ? 500 : 1_500, `${what}: what is left of a deadline that has less`);
  }
});

test("the three pages issue #987 measured, each read ending at its own bound: a page takes its longest chain of reads, and the deadline ends a chain of two", async () => {
  // Each read here ends at its own bound, 5 s, as a client's command does on a Valkey that stopped answering. One
  // after another that was a sum: /config/trigger 7.6 to 11.6 s, /config/connections 14.1 s, a run's page 22.6 s.
  const bound = 5_000;
  const pages = [
    // The trigger page's three reads (the hosts, the snapshot, the Fire now check) end beside each other, at one
    // bound, and the skew check that needs the snapshot is not made without one: nothing waits for the deadline.
    { page: "trigger", qs: "index=0", took: bound, cut: false, unbounded: bound },
    // The snapshot, then the views that take it: the second of the chain is what the deadline ends, with its grace.
    { page: "connections", qs: "", took: D + G, cut: true, unbounded: null },
    // The record, then what is keyed on it, which only Valkey answers: ended at the deadline.
    { page: "run", qs: "id=gh-1", took: D, cut: true, unbounded: null },
  ];
  for (const { page, qs, took, cut, unbounded } of pages) {
    const query = parsePageQuery(page, new URLSearchParams(qs)).query;
    const got = await loaded(page, query, OP, { how: () => bound });
    assert.equal(got.took, took, `${page}: back at ${got.took} ms`);
    assert.equal(got.data.deadlineSpent === true, cut, `${page}: cut by the deadline`);
    assert.equal(got.data.readFailed, true, `${page}: its own read is the read that failed`);
    // With no deadline a chain of two bounds is longer than the grace allows.
    const chained = await loaded(page, query, OP, { how: () => bound }, { deadlineMs: 3_600_000 });
    assert.equal(chained.took, unbounded, `${page}: without a deadline`);
  }
});

test("a Valkey that takes a whole second for every read is not called unread: each page is the one a quick Valkey gives", async () => {
  // One after another a page of twelve such reads met its deadline at the sixth. Beside each other a page takes its
  // longest chain, and the longest of any page here is five reads: a parked run's record, then its chat's three reads
  // and the answer check, and the five the watch board's one read makes of Valkey.
  let longest = 0;
  for (const c of CASES) {
    const query = queryOf(c);
    const quick = await loaded(c.page, query, OP, { answers: c.answers, without: c.without });
    const slow = await loaded(c.page, query, OP, { answers: c.answers, without: c.without, takes: 1_000 });
    assert.ok(slow.data !== null, `${nameOf(c)}: read inside the deadline`);
    assert.deepEqual(slow.data, quick.data, `${nameOf(c)}: nothing is unread`);
    assert.equal(slow.waiting, 0, `${nameOf(c)}: every wait's timer is taken away with its answer`);
    assert.ok(slow.took <= D, `${nameOf(c)}: back at ${slow.took} ms`);
    longest = Math.max(longest, slow.took);
  }
  assert.equal(longest, 5_000, "the longest chain of any page is inside the deadline");
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
  assert.deepEqual(calls.map((call) => [call.name, call.at]), [["zeroTouch", 0], ["fleet.parkedCount", 0]], "the report and the Parked count were asked for together");
  assert.deepEqual([data.parkedCount, Object.hasOwn(data, "deadlineSpent")], [2, false], "nothing was cut: the report gave its own answer, and the count was read beside it");
  assert.deepEqual(logs, []);
  // A read that failed by itself is still the console's to say, and to log by its code alone.
  const thrown = await loaded("zero-touch", parsePageQuery("zero-touch", new URLSearchParams("")).query, OP, { how: (name) => (name === "zeroTouch" ? "refuse" : "answer") });
  assert.equal(thrown.data.zeroTouch.failure, "read-failed");
  assert.deepEqual(thrown.logs, ["console: the Zero touch read failed (ECONNREFUSED)"]);
});

test("a run whose record is in this host's files is drawn on a Valkey that answers nothing, and what is keyed on a record that comes late is handed what is left", async () => {
  // The mirror's part of a history page ends at the bound the page hands the reader, as the real reader's does, and
  // the reader then answers with this host's part: the real reader's own answer for a mirror it could not reach.
  const bounds = [];
  const outage = (record, recordAfter) => {
    const time = handTime();
    const mirror = (opts) => new Promise((resolve) => { time.timers.setTimeout(() => resolve({ ...RUNS_PAGE_IN_OUTAGE }), opts.timeoutMs); });
    const { deps, calls } = probe(time, {
      how: (name) => (kindOf(name) === "valkey" ? "silent" : "answer"),
      answers: {
        "fleet.runById": (id, opts) => new Promise((resolve) => { bounds.push(["runById", opts.timeoutMs]); time.timers.setTimeout(() => resolve({ record, source: "local" }), recordAfter); }),
        "fleet.runsPage": (opts) => { bounds.push(["runsPage", opts.timeoutMs]); return mirror(opts); },
        "fleet.runsWindow": (opts) => { bounds.push(["runsWindow", opts.timeoutMs]); return READS["fleet.runsWindow"][1](); },
      },
    });
    return { time, deps, calls };
  };
  // The record is read at once, beside everything that needs nothing of it, each reader with its own bound whole.
  bounds.length = 0;
  const first = outage(RECORD, 0);
  let data = null;
  loadPageData("run", { id: "gh-1" }, first.deps, OP).then((got) => { data = got; });
  await first.time.advance(D - 1);
  assert.equal(data, null, "what only Valkey answers is waited for until the deadline");
  await first.time.advance(1);
  assert.ok(data !== null, "back at the deadline");
  assert.equal(data.run.record.jobId, "gh-1", "the record needs no Valkey");
  assert.ok(!Object.hasOwn(data, "readFailed"), "so the page's own read did not fail");
  assert.equal(data.deadlineSpent, true);
  assert.deepEqual(bounds, [["runById", RUN_MIRROR_READ_MS], ["runsPage", RUN_MIRROR_READ_MS]], "each reader's own bound, whole");
  assert.deepEqual([data.children, data.childrenIncomplete], [[], true], "the reader's own answer: this host's runs, the mirror not reached");
  // Everything only Valkey answers was asked for at the start, beside the record or as soon as it was read, and is the
  // read that failed; none of it was asked for after the deadline.
  assert.deepEqual(first.calls.filter((call) => kindOf(call.name) === "valkey").map((call) => call.at), new Array(9).fill(0));
  assert.deepEqual(first.calls.filter((call) => kindOf(call.name) === "valkey").map((call) => call.name).sort(), ["fleet.inbox", "fleet.jobStatus", "fleet.parkedCount", "fleet.progressOfRun", "fleet.rerunCheck", "fleet.transcriptMeta", "gatewayView", "hostLoads", "sandboxes.workspace"]);
  assert.deepEqual(data.transcript, { unreachable: true, exists: false });
  for (const field of ["progress", "inbox", "chat", "rerunCheck"]) assert.deepEqual(data[field], { unreachable: true }, field);
  assert.deepEqual(data.sandboxCheck, { elsewhere: true }, "what the files answer is drawn as read");

  // A record that comes 100 ms before the deadline: what is keyed on it is started then, with what the deadline has left.
  bounds.length = 0;
  const late = outage(REFUSED_RUN, D - 100);
  data = null;
  loadPageData("run", { id: "gh-1" }, late.deps, OP).then((got) => { data = got; });
  await late.time.advance(D);
  assert.ok(data !== null && data.run.record.jobId === "gh-1");
  assert.deepEqual(bounds, [["runById", RUN_MIRROR_READ_MS], ["runsPage", 100], ["runsWindow", 100]]);

  // A record that comes inside the grace is still drawn, and the history keyed on it is handed one millisecond.
  bounds.length = 0;
  const grace = outage(RECORD, D + 10);
  data = null;
  loadPageData("run", { id: "gh-1" }, grace.deps, OP).then((got) => { data = got; });
  await grace.time.advance(D + 10);
  assert.equal(data, null, "the history's mirror was handed one millisecond, and has it still");
  await grace.time.advance(1);
  assert.ok(data !== null, "back a millisecond later");
  assert.equal(data.run.record.jobId, "gh-1");
  assert.ok(!Object.hasOwn(data, "readFailed"));
  assert.equal(data.deadlineSpent, true);
  assert.deepEqual(bounds, [["runById", RUN_MIRROR_READ_MS], ["runsPage", 1]], "never under 1 ms");
  assert.deepEqual([data.children, data.childrenIncomplete], [[], true]);
  assert.deepEqual(grace.calls.filter((call) => kindOf(call.name) === "valkey" && call.at >= D).map((call) => call.name), [], "nothing only Valkey answers is asked for after the deadline");

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

// ---- the reads start together -----------------------------------------------------------------------------------------

/**
 * When each read of a page is started, counted in reads, where every read takes the same time, what the files answer
 * included: a read that needs nothing from another read of the load starts at 0, and one that needs another's answer
 * when that one has ended. A case says where its page differs (`starts`).
 */
const STARTS = {
  // What needs nothing from another read of the load.
  "fleet.snapshot": [0], "fleet.parkedCount": [0], "fleet.transcriptMeta": [0], "fleet.inbox": [0], "fleet.runById": [0], "fleet.runsPage": [0], "fleet.runsWindow": [0],
  hostLoads: [0], "answerer.read": [0], gatewayView: [0], "sandboxes.read": [0], zeroTouch: [0], zeroTouchRuns: [0], triggerFireCheck: [0], updates: [0], hostCapacity: [0],
  // What takes the snapshot.
  setup: [1], modelsView: [1], connections: [1], projectView: [1], triggerList: [1], "fleet.triggerSkew": [1], "fleet.parkedAnswerCheck": [1],
  // What is keyed on a run's record.
  "fleet.progressOfRun": [1], "fleet.progress": [1], "fleet.jobStatus": [1], "fleet.rerunCheck": [1], "sandboxes.workspace": [1], "fleet.runHolds": [1],
  // The live facts of a run with no record look the job up by its id, as the chat facts do: after them, so that the
  // one lookup answers both (issue #988).
  "fleet.runLiveFacts": [2],
  // The watch pages' one read makes its own one after another: each says what the next is asked for.
  "watch.listRules": [0], "watch.listFindings": [1], "watch.listSources": [2], "watch.readBoard": [3], "watch.readFinding": [4], "watch.readTrace": [5],
  // What the files answer is started beside the rest: nothing waits behind a slow disk either.
  agentWrites: [0], subscriptions: [0], insights: [0], triggerEditor: [0],
  // The audit page's one read checks the log's chain, then reads its page; a run's actions are one read too: after
  // the re-run check, which is keyed on the record, the sandbox check. The run's trigger is keyed on the record.
  auditVerify: [0], audit: [1], "fleet.runTrigger": [1], "fleet.sandboxCheck": [2],
};

test("a page takes its longest chain of reads, not their sum: on every page each read is started when what it needs has ended, and no later", async () => {
  const T = 500;
  for (const c of CASES) {
    const got = await loaded(c.page, queryOf(c), OP, { answers: c.answers, without: c.without, takes: T, slowFiles: true });
    const started = {};
    for (const call of got.calls) (started[call.name] ??= []).push(call.at / T);
    assert.deepEqual(started, Object.fromEntries(Object.keys(started).map((name) => [name, c.starts?.[name] ?? STARTS[name]])), `${nameOf(c)}: when each read is started, in reads`);
    const chain = Math.max(...got.calls.map((call) => call.at / T)) + 1;
    assert.equal(got.took, chain * T, `${nameOf(c)}: back after its longest chain of ${chain}`);
    assert.ok(!Object.hasOwn(got.data, "deadlineSpent"), `${nameOf(c)}: nothing is cut`);
  }
  // In numbers: the page of a run that goes on as a recovery asks fourteen reads of half a second each. One after
  // another that is seven seconds, more than the deadline; its longest chain is three, a second and a half.
  const c = CASES.find((one) => one.label === "a run that goes on as a recovery");
  const got = await loaded(c.page, queryOf(c), OP, { answers: c.answers, without: c.without, takes: T });
  assert.deepEqual([got.calls.filter((call) => kindOf(call.name) !== "files").length, got.took], [14, 1_500]);
});

test("the Insights assembly is started as soon as the load has read its clock, before anything else of the load: its window and the page's instant stay together", async () => {
  // The assembly reads the clock for its own window as it starts, and the capacity chart is drawn against the page's
  // instant: a millisecond between the two marks the newest bar as one with part of it missing. So nothing of the
  // load comes between the page's reading and the assembly's start, and the lookup's one question, which only the
  // pages that look a job up by its id ask, is not asked on these pages at all. The
  // assembly is asked for through the console's own cache, as a console asks: that cache starts it one turn of the
  // microtask queue later, and a load that went on without giving that turn would put all its setup in between.
  for (const page of ["insights", "insights-budget-split", "insights-capacity", "insights-breakdown", "insights-flows"]) {
    const order = [];
    const { data } = await loaded(page, {}, OP, {}, { wire: (deps) => {
      const insights = deps.insights;
      deps.now = () => { order.push("the page's clock"); return NOW; };
      deps.insights = cachedPerWindow((...args) => { order.push("the assembly"); return insights(...args); }, { now: () => NOW });
      deps.fleet.lookupQuestion = () => { order.push("the lookup's question"); return {}; };
    } });
    assert.deepEqual(order, ["the page's clock", "the assembly"], page);
    assert.deepEqual(data.insights, { window: "30d" }, `${page}: and its answer is the page's`);
  }
  // An assembly that throws as it is started, or fails later, is the page's one sentence.
  for (const failing of [() => { throw new Error("thrown as it started"); }, () => Promise.reject(new Error("failed later"))]) {
    const { data } = await loaded("insights", {}, OP, {}, { wire: { insights: failing } });
    assert.deepEqual([data.insights, data.insightsError], [null, "The spend history could not be assembled."]);
  }
  // Nothing ends an Insights page's load between the start of its assembly and its reads (issue #988): the one call
  // of the reader that came between them, the lookup's question, is the run page's and Parked's. A question that
  // throws ended such a load with its assembly already started; it is not asked there, so the page is drawn.
  const unhandled = [];
  const note = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", note);
  try {
    const time = handTime();
    for (const page of ["insights", "insights-capacity"]) {
      const { deps } = probe(time, {});
      let started = 0;
      deps.insights = async () => { started += 1; return { window: "30d" }; };
      deps.fleet.lookupQuestion = () => { throw new Error("the lookup's question"); };
      const loading = loadPageData(page, {}, deps, OP);
      await time.settled();
      assert.deepEqual([(await loading).insights, started], [{ window: "30d" }, 1], page);
    }
    // The pages that ask it still do, before any of their reads, and a load it ends starts no read.
    for (const page of ["run", "parked"]) {
      const { deps, calls } = probe(time, {});
      deps.fleet.lookupQuestion = () => { throw new Error("the lookup's question"); };
      await assert.rejects(() => loadPageData(page, page === "run" ? { id: "gh-1" } : {}, deps, OP), /the lookup's question/, page);
      assert.deepEqual(calls.map((call) => call.name), [], page);
    }
    await time.settled();
  } finally {
    process.off("unhandledRejection", note);
  }
  assert.deepEqual(unhandled, []);
});

test("what a read needs is in its hand when it is started: the snapshot for its views, the record for what is keyed on it, the chat for its answer check and its continuation, a page's cursor for the next", async () => {
  const T = 500;
  // What is needed takes three times as long as anything else, so a read started without waiting for it would show.
  const slow = (...names) => (name) => (names.includes(name) ? 3 * T : T);
  const startOf = (calls, name, nth = 0) => calls.filter((call) => call.name === name)[nth]?.at;

  // The snapshot, then each view that takes it: handed the one the load read, not a second read of its own.
  const snapshot = READS["fleet.snapshot"][1]();
  for (const [page, qs, view, handed] of [
    ["setup", "", "setup", (args) => args[0].snapshot],
    ["models", "", "modelsView", (args) => args[0]],
    ["connections", "", "connections", (args) => args[0]],
    ["connections", "", "setup", (args) => args[0].snapshot],
    ["project", "id=web", "projectView", (args) => args[1]],
    ["triggers", "", "triggerList", (args) => args[0]],
    ["trigger", "index=0", "fleet.triggerSkew", (args) => args[1]],
  ]) {
    const seen = [];
    const got = await loaded(page, parsePageQuery(page, new URLSearchParams(qs)).query, OP, { takes: slow("fleet.snapshot"), answers: { "fleet.snapshot": () => snapshot, [view]: (...args) => { seen.push(handed(args)); return READS[view][1](); } } });
    assert.equal(startOf(got.calls, view), 3 * T, `${page}: ${view} is started when the snapshot has ended`);
    assert.deepEqual(seen.map((one) => one === (view === "fleet.triggerSkew" ? snapshot.waiting : snapshot)), [true], `${page}: ${view} is handed what the snapshot read`);
    assert.equal(got.calls.filter((call) => call.name === "fleet.snapshot").length, 1, `${page}: one snapshot read`);
  }
  // The secrets view is the files' and the snapshot's, with no read of its own: drawn from the snapshot the load read.
  const secretsOf = [];
  await loaded("secrets", {}, OP, { takes: slow("fleet.snapshot"), answers: { "fleet.snapshot": () => snapshot } }, { wire: { secretsView: (read, files) => { secretsOf.push([read === snapshot, files]); return { bundles: [] }; } } });
  assert.deepEqual(secretsOf, [[true, null]]);
  // The Parked page's answer checks are for the parked runs the snapshot lists.
  const parked = await loaded("parked", {}, OP, { takes: slow("fleet.snapshot") });
  assert.deepEqual([startOf(parked.calls, "fleet.parkedAnswerCheck"), Object.keys(parked.data.parkedChecks)], [3 * T, ["gh-9"]]);

  // A run's record, then all that is keyed on it, each handed that record.
  const recovered = CASES.find((one) => one.label === "a replica that was recovered");
  const handedRecord = [];
  const keyed = await loaded("run", queryOf(recovered), OP, {
    takes: slow("fleet.runById"), without: recovered.without,
    answers: { ...recovered.answers, "fleet.progressOfRun": (id, record) => { handedRecord.push(["progressOfRun", record]); return READS["fleet.progressOfRun"][1](); }, "sandboxes.workspace": (record) => { handedRecord.push(["workspace", record]); return READS["sandboxes.workspace"][1](); }, "fleet.runHolds": (id, record) => { handedRecord.push(["runHolds", record]); return READS["fleet.runHolds"][1](); } },
  }, { wire: (deps) => { deps.fleet.artifacts = (id, record) => { handedRecord.push(["artifacts", record]); return { of: id }; }; } });
  assert.deepEqual(keyed.data.artifacts, { of: "gh-1" }, "what the run's /artifacts folder left is looked up by the record, once it is read");
  for (const name of ["fleet.runsPage", "fleet.progressOfRun", "sandboxes.workspace", "fleet.jobStatus", "fleet.rerunCheck", "fleet.runHolds"]) assert.equal(startOf(keyed.calls, name), 3 * T, `${name} is started when the record has ended`);
  assert.deepEqual(keyed.calls.filter((call) => call.name === "fleet.runById").map((call) => call.at), [0, 3 * T, 3 * T], "the related runs are looked up by the record's ids");
  assert.deepEqual(handedRecord.map(([name, record]) => [name, record === RECOVERED]).sort(), [["artifacts", true], ["progressOfRun", true], ["runHolds", true], ["workspace", true]]);
  // No record: the live facts of a run that has none are asked for only once the record's read says so.
  const none = await loaded("run", { id: "gh-1" }, OP, { takes: slow("fleet.runById") });
  assert.deepEqual([startOf(none.calls, "fleet.jobStatus"), startOf(none.calls, "fleet.runLiveFacts")], [3 * T, 4 * T]);
  // And only once the chat facts have looked the job up (issue #988): the two lookups ask one question, and beside
  // each other both missed what the first to end would have left for the second.
  const lookedUp = await loaded("run", { id: "gh-1" }, OP, { takes: slow("fleet.jobStatus") });
  const chatLookup = lookedUp.calls.find((call) => call.name === "fleet.jobStatus");
  assert.deepEqual([chatLookup.at, chatLookup.end, startOf(lookedUp.calls, "fleet.runLiveFacts")], [T, 4 * T, 4 * T]);
  // A run refused before it started: the snapshot and the runs' window its page draws, together, once the record says so.
  const refusedRun = CASES.find((one) => one.label === "a run refused before it started");
  const refusal = await loaded("run", queryOf(refusedRun), OP, { takes: slow("fleet.runById"), answers: refusedRun.answers });
  assert.deepEqual([startOf(refusal.calls, "fleet.snapshot"), startOf(refusal.calls, "fleet.runsWindow")], [3 * T, 3 * T]);

  // The chat, then its answer check: only a chat that can take a reply has one.
  const parkedRun = CASES.find((one) => one.label === "a parked run, whose chat is a reply");
  const reply = await loaded("run", queryOf(parkedRun), OP, { takes: slow("fleet.pendingAnswer"), answers: parkedRun.answers });
  const scan = reply.calls.find((call) => call.name === "fleet.pendingAnswer");
  assert.equal(scan.end - scan.at, 3 * T);
  assert.equal(startOf(reply.calls, "fleet.parkedAnswerCheck"), scan.end, "the answer check is started when the chat's last read has ended");
  assert.equal(reply.data.chat.mode, "reply");
  // The chat, then the run that continues it: its live facts and its progress, together, by the id the chat named.
  const goesOn = CASES.find((one) => one.label === "a run that goes on as a recovery");
  const named = [];
  const continued = await loaded("run", queryOf(goesOn), OP, { takes: slow("fleet.jobStatus"), answers: { ...goesOn.answers, "fleet.runLiveFacts": (id) => { named.push(id); return null; } } });
  const status = continued.calls.find((call) => call.name === "fleet.jobStatus");
  assert.deepEqual([startOf(continued.calls, "fleet.runLiveFacts"), startOf(continued.calls, "fleet.progressOfRun", 1)], [status.end, status.end]);
  assert.deepEqual(named, ["gh-1.r1"]);

  // A search for children: each page is asked for from the cursor the page before it gave.
  const cursors = [];
  const search = await loaded("run", { id: "gh-1" }, OP, {
    takes: T,
    answers: { "fleet.runById": () => ({ record: RECORD, source: "local" }), "fleet.runsPage": (opts) => { cursors.push(opts.before); return { runs: [], next: (opts.before ?? NOW) - 10_000, mirror: "ok", truncated: false, examined: 0 }; } },
  });
  assert.deepEqual(search.calls.filter((call) => call.name === "fleet.runsPage").map((call) => call.at), [T, 2 * T, 3 * T], "one page after another");
  assert.deepEqual(cursors, [null, NOW - 10_000, NOW - 20_000]);
});

test("reads that fail beside each other each draw their own fallback, and a throw no read catches is the load's own once every read has ended: none is left unhandled", async () => {
  const unhandled = [];
  const note = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", note);
  try {
    // Six reads of a run's page fail, at once and at three later moments, beside reads that answer: each is drawn as
    // the read that failed, and what answered is drawn as read.
    const fails = { gatewayView: "refuse", "fleet.inbox": "refuse", hostLoads: 100, "answerer.read": 200, "fleet.transcriptMeta": 300, "fleet.progressOfRun": 300 };
    const c = CASES.find((one) => one.label === "a record on this host");
    const got = await loaded(c.page, queryOf(c), OP, { answers: c.answers, how: (name) => fails[name] ?? "answer" });
    assert.equal(got.took, 300, "back when the last of them has failed");
    assert.deepEqual([got.data.hostLoads, got.data.hostLoadsUnread], [null, true]);
    assert.deepEqual(got.data.answerer, { state: "unavailable", partial: true, rows: [] });
    assert.equal(got.data.browserGateways.problem, "Browser-terminal information could not be read. Use the native terminal route.");
    assert.deepEqual(got.data.transcript, { unreachable: true, exists: false });
    assert.deepEqual([got.data.inbox, got.data.progress], [{ unreachable: true }, { unreachable: true }]);
    assert.deepEqual([got.data.run.record.jobId, got.data.parkedCount, got.data.rerunCheck, got.data.chat.found], ["gh-1", 2, { ok: true }, false], "what answered is drawn as read");
    for (const mark of ["deadlineSpent", "readFailed"]) assert.ok(!Object.hasOwn(got.data, mark), mark);

    // Two throws no read catches, on the Zero touch page. The report answers after half a second with a field that
    // throws when the page projects it; the Parked count's own lookup throws at once. The load ends when both have,
    // with the throw of the read that comes first in the page's order, not of the one that threw first.
    const time = handTime();
    const { deps, calls } = probe(time, { takes: 500, answers: { zeroTouch: () => ({ get coverage() { throw new Error("the report's field"); } }) } });
    Object.defineProperty(deps.fleet, "parkedCount", { get() { throw new Error("the count's lookup"); } });
    let thrown = null;
    let at = null;
    loadPageData("zero-touch", parsePageQuery("zero-touch", new URLSearchParams("")).query, deps, OP).then(() => assert.fail("the load answered"), (err) => { thrown = err; at = time.clock(); });
    const start = time.clock();
    await time.settled();
    assert.equal(thrown, null, "not at the first throw: the report is still being read");
    await time.advance(500);
    assert.deepEqual([thrown?.message, at - start], ["the report's field", 500]);
    assert.deepEqual(calls.map((call) => [call.name, call.end]), [["zeroTouch", 500]], "no read of the load is still going when it ends");
    await time.settled();
  } finally {
    process.off("unhandledRejection", note);
  }
  assert.deepEqual(unhandled, []);
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

/**
 * `run()`'s answer and every delay armed on the process's timers while it ran: what a reader's bound really was. The
 * readers' own timers hold no process open, so one of this test's does while it waits for them, for five seconds and
 * no longer: a read that never ends then fails its test, where a timer with no end would keep this file running.
 */
async function timersArmed(run) {
  const real = globalThis.setTimeout;
  const delays = [];
  const keep = real(() => {}, 5_000);
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return real(fn, ms, ...rest); };
  try {
    return { got: await run(), delays };
  } finally {
    globalThis.setTimeout = real;
    clearTimeout(keep);
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

test("the real reader: a run asked of the host that holds it ends inside the caller's time, in the reader's own two sentences", { timeout: 30_000 }, async () => {
  // A run opened from the overview's timeline names the host that holds it. Neither this host's files nor the mirror
  // hold it, so the reader asks the registry for that host and then the host for the record: two more reads, one
  // after the other, which took no bound and outlived a page's deadline, so the page said the record could not be
  // read where the reader was about to say which of the two it was.
  const logsDir = tempDir("pd-988-host-");
  const registry = { hosts: [], held: false };
  const subscribed = [];
  const redis = {
    on() {}, disconnect() {}, exists: async () => 0, get: async () => null, zrevrangebyscore: async () => [], mget: async () => [], publish: async () => 0,
    duplicate: () => ({ on() {}, disconnect() {}, subscribe: (channel) => { subscribed.push(channel); return new Promise(() => {}); } }),
  };
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir }, {
    makeQueueFn: quietQueue(), parseConnectionFn: () => ({}), redisFn: () => redis, nowFn: () => NOW, readOnly: true,
    readLiveHostsFn: () => (registry.held ? new Promise(() => {}) : Promise.resolve({ hosts: registry.hosts })),
  });
  const asked = [];
  const within = (ms) => { asked.push(ms); return 7; };

  // The registry does not answer, and no host was ever seen: the caller's time ends the wait, and the reader says so.
  registry.held = true;
  const unseen = await timersArmed(() => reader.runById("gh-there", { historyHost: "build9", timeoutMs: 7, within }));
  assert.deepEqual(unseen.got, { unreadable: "the host holding this run is not available" });
  assert.deepEqual(asked, [Infinity], "the registry's read is waited for as long as the caller has");
  assert.deepEqual(subscribed, [], "a host nobody saw is not asked");
  // The registry answered before and names the host; now it is silent again, and so is the host. The host is asked,
  // for as long as the caller has, and the reader's other sentence is the answer.
  registry.held = false;
  registry.hosts = [{ name: "build9" }];
  await reader.runById("gh-there", { historyHost: "build9", within: () => 1 });
  registry.held = true;
  subscribed.length = 0;
  asked.length = 0;
  const silentHost = await timersArmed(() => reader.runById("gh-there", { historyHost: "build9", timeoutMs: 7, within }));
  assert.deepEqual(silentHost.got, { unreadable: "the host could not provide this run's record" });
  assert.deepEqual(asked, [Infinity, HOST_HISTORY_READ_MS], "then the host's own bound, or what the caller has left of it");
  assert.equal(subscribed.length, 1);
  assert.ok(!silentHost.delays.includes(HOST_HISTORY_READ_MS), "the host is not waited for by its own bound once the caller's is shorter");
  // With no deadline from the caller the registry is waited for whole and the host has its own bound, as before.
  registry.held = false;
  const own = await timersArmed(async () => { const reading = reader.runById("gh-there", { historyHost: "build9" }); for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve)); return Promise.race([reading, "still asking the host"]); });
  assert.equal(own.got, "still asking the host");
  assert.ok(own.delays.includes(HOST_HISTORY_READ_MS));
  assert.match(readFileSync(new URL("../../worker/src/history-reader.mjs", import.meta.url), "utf8"), new RegExp(`export async function readHostHistory\\(\\{[^\\n]*\\btimeoutMs = ${HOST_HISTORY_READ_MS}\\b`), "the bound the reader names is the host read's own");
  await reader.dispose();
});

test("the real reader: a trigger's skew check ends at the bound a page hands it and says for itself that it was incomplete", { timeout: 30_000 }, async () => {
  const dir = tempDir("pd-988-skew-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["go"] }, run: { kind: "github", flow: "fix" } }] }));
  const waiting = { rows: [{ jobId: "gh-7", queue: "pi-jobs" }], truncated: false };
  // The queue takes the lookup of the waiting job and answers nothing.
  const queue = (_connection, opts) => ({ ...quietQueue()(_connection, opts), getJob: () => new Promise(() => {}) });
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir: join(dir, "logs"), triggersPath }, { makeQueueFn: queue, parseConnectionFn: () => ({}), redisFn: () => ({ on() {}, disconnect() {} }), nowFn: () => NOW, readOnly: true, readLiveHostsFn: async () => ({ hosts: [] }) });
  const cut = await timersArmed(() => reader.triggerSkew(0, waiting, { timeoutMs: 7 }));
  assert.deepEqual(cut.got, { rows: [], queued: [], incomplete: true }, "its own answer: nothing found, and not everything looked at");
  assert.ok(cut.delays.includes(7), "the job's lookup is waited for as long as the caller says");
  const own = await timersArmed(async () => { const reading = reader.triggerSkew(0, waiting); for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve)); return Promise.race([reading, "still looking"]); });
  assert.deepEqual([own.got, own.delays.includes(7), own.delays.includes(TRIGGER_SKEW_READ_MS)], ["still looking", false, true], "with no bound from the caller, the check's own");
  await reader.dispose();
});

test("a run opened with the host that holds it: the reader is handed the page's deadline, and the reader's own sentence is the page's, also a moment past the deadline", async () => {
  const query = parsePageQuery("run", new URLSearchParams("id=gh-1&historyHost=build9")).query;
  assert.equal(query.historyHost, "build9");
  // The reader takes the bound of each of its two later reads from the deadline as it makes them.
  const handed = [];
  const asking = await loaded("run", query, OP, { answers: { "fleet.runById": (id, opts) => { handed.push([opts.historyHost, opts.timeoutMs, opts.within(HOST_HISTORY_READ_MS), opts.within(Infinity)]); return { unreadable: "the host holding this run is not available" }; } } });
  assert.deepEqual(handed, [["build9", RUN_MIRROR_READ_MS, HOST_HISTORY_READ_MS, D]], "the mirror's bound, and the deadline itself for what follows");
  assert.deepEqual(asking.data.run, { unreadable: "the host holding this run is not available" });
  // The mirror, the registry and the host, each silent to its bound, end a moment after the deadline: the page waits
  // the grace for the reader, and says what the reader said, not that the record could not be read.
  const time = handTime();
  const { deps } = probe(time, { answers: { "fleet.runById": () => new Promise((resolve) => { time.timers.setTimeout(() => resolve({ unreadable: "the host could not provide this run's record" }), D + 20); }) } });
  let data = null;
  loadPageData("run", query, deps, OP).then((got) => { data = got; });
  await time.advance(D + 20);
  assert.deepEqual([data.run, Object.hasOwn(data, "readFailed")], [{ unreadable: "the host could not provide this run's record" }, false]);
});

// ---- the services that take a page's deadline ----------------------------------------------------------------------

test("the zero touch report under a page's deadline: each step is made with what is left, and the report and its touched runs say in their own words what an outage left unread", async () => {
  const paths = outagePaths();
  const service = makeZeroTouchService({ paths, env: {}, now: () => NOW, redisFn: () => downRedis() });
  const asked = [];
  const within = (ms) => { asked.push(ms); return 7; };
  const cut = await timersArmed(() => service.read({ windowDays: 30, within }));
  // The outbox's store, the question groups' and the fold of the window: three steps, each asking the deadline with
  // the two seconds a store has by itself. The fix store takes no bound, and its commands keep their own.
  assert.deepEqual(asked, [ZERO_TOUCH_STORE_MS, ZERO_TOUCH_STORE_MS, ZERO_TOUCH_STORE_MS]);
  assert.ok(cut.delays.filter((ms) => ms === 7).length >= 3, "each of those steps was bounded by what the deadline had left");
  assert.equal(cut.got.coverage.partial, true, "its own answer: a window that is partial");
  assert.ok(cut.got.coverage.reasons.includes("touch-index-unavailable"));
  // The touched runs are that report's: the same bound goes on, and the list says the window is partial and the mirror
  // was not reached, where a page that stopped waiting could only say the history could not be read.
  asked.length = 0;
  const runs = await service.runs({ windowDays: 30, filter: { touched: "1", days: "30" }, within });
  assert.deepEqual(asked, [ZERO_TOUCH_STORE_MS, ZERO_TOUCH_STORE_MS, ZERO_TOUCH_STORE_MS]);
  assert.deepEqual([runs.runs, runs.truncated, runs.touchCoverage.partial, /unreachable/.test(runs.mirror)], [[], true, true, true]);
  // No deadline: every store keeps its own bound.
  const own = await timersArmed(() => service.read({ windowDays: 30 }));
  assert.ok(!own.delays.includes(7));
  assert.deepEqual(own.got.coverage, cut.got.coverage, "and the answer is the same answer");
  // The bound the service names is each store's own.
  assert.deepEqual([QUESTION_GROUP_LIMITS.timeoutMs, CAPACITY_OP_TIMEOUT_MS], [ZERO_TOUCH_STORE_MS, ZERO_TOUCH_STORE_MS]);
  assert.match(readFileSync(new URL("../../worker/src/touch-state.mjs", import.meta.url), "utf8"), new RegExp(`export function makeTouchStore\\(\\{[^\\n]*\\btimeoutMs = ${ZERO_TOUCH_STORE_MS}\\b`));
});

test("the answer rules under a page's deadline: the store is made with what is left, and an outage still names the rules and standing answers of the triggers file", async () => {
  const paths = outagePaths();
  const service = makeAnswererService({ paths, env: {}, now: () => NOW, redisFn: () => downRedis() });
  const asked = [];
  const cut = await timersArmed(() => service.read({ role: "operator", within: (ms) => { asked.push(ms); return 7; } }));
  assert.deepEqual(asked, [ANSWER_STORE_MS]);
  assert.deepEqual([cut.delays.includes(7), cut.delays.includes(ANSWER_STORE_MS)], [true, false], "the store's commands end with the caller's time");
  assert.deepEqual([cut.got.state, cut.got.rows, cut.got.rules, cut.got.standing], ["unavailable", [], [], []], "its own answer: the rows not known, the file's rules and standing answers read");
  const own = await timersArmed(() => service.read({ role: "operator" }));
  assert.deepEqual([own.delays.includes(7), own.delays.includes(ANSWER_STORE_MS)], [false, true], "no deadline: the store's own bound");
  assert.match(readFileSync(new URL("../../worker/src/answerer.mjs", import.meta.url), "utf8"), new RegExp(`export function makeAnswerDraftStore\\(\\{[^\\n]*\\btimeoutMs = ${ANSWER_STORE_MS}\\b`));
});

test("a read that ends by itself a moment after the deadline is still the page's: the touched runs, the zero touch report, the answer rules and a skew check have the grace", async () => {
  // Each of these makes its reads one after another with a bound each, so on a Valkey that stopped answering it ends
  // about when the deadline does, by milliseconds on either side. The page waits the grace for it, as for every read
  // that takes its bound, and draws what it said.
  const late = (answer) => (time) => () => new Promise((resolve) => { time.timers.setTimeout(() => resolve(answer), D + 50); });
  const partial = { runs: [], next: null, mirror: "unreachable (Command timed out)", truncated: true, examined: 0, touchCoverage: { partial: true } };
  for (const [page, qs, read, answer, field] of [
    ["runs", "touched=1&days=30", "zeroTouchRuns", partial, (data) => data.runsPage],
    ["zero-touch", "", "zeroTouch", { coverage: { partial: true, reasons: ["touch-index-unavailable"] }, totals: {}, projects: [], touchedRunIds: [] }, null],
    ["parked", "", "answerer.read", { state: "unavailable", partial: true, rows: [], rules: [], standing: [] }, (data) => data.answerer],
  ]) {
    const time = handTime();
    const { deps } = probe(time, { answers: { [read]: late(answer)(time) } });
    let data = null;
    loadPageData(page, parsePageQuery(page, new URLSearchParams(qs)).query, deps, OP).then((got) => { data = got; });
    await time.advance(D + 49);
    assert.equal(data, null, `${page}: waited for past the deadline`);
    await time.advance(1);
    assert.ok(data !== null, `${page}: back when the read ended`);
    assert.ok(!Object.hasOwn(data, "readFailed"), `${page}: its own read did not fail`);
    if (field) assert.deepEqual(field(data), answer, `${page}: drawn as the read said`);
    else assert.equal(data.zeroTouch.state, "unavailable");
  }
  // The skew check of a trigger whose snapshot came just before the deadline.
  const time = handTime();
  const skew = { rows: [], queued: [], incomplete: true };
  const { deps } = probe(time, { takes: (name) => (name === "fleet.snapshot" ? D - 10 : 0), answers: { "fleet.triggerSkew": () => new Promise((resolve) => { time.timers.setTimeout(() => resolve(skew), 60); }) } });
  let data = null;
  loadPageData("trigger", { index: 0 }, deps, OP).then((got) => { data = got; });
  await time.advance(D + 49);
  assert.equal(data, null);
  await time.advance(1);
  assert.deepEqual([data.snapshot.triggerSkew, data.triggerDetail.skewIncomplete], [{ 0: skew }, true]);
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
