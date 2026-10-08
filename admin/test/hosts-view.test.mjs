import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { computeCapacity } from "@edgehero/pi-dispatch/capacity";
import { capacityText } from "@edgehero/pi-dispatch/capacity-cli";
import { stripAnsi, visibleLen } from "../src/style.mjs";

/**
 * The panel's HOSTS view (issue #599, phase 3, key `u`): each live host's slots, budget and running jobs from the
 * registry rows the 1 s tick already reads, and its last 7 days from the capacity report, read ONCE when the view opens
 * through the injected `capacityInfo` seam. Offline: canned snapshots, a report built by the worker's own
 * `computeCapacity` at a fixed instant, and fake deps; nothing here reaches a Valkey, a logs directory or the wall clock.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard, createDashboardDeps } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeTui = () => ({ requestRender() {} });
const SGR_THEME = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };

const AT = Date.UTC(2026, 9, 8, 12, 0, 0);
const H = 3600_000;
const DAY = 24 * H;

const rec = (jobId, host, project, fromH, toH) => ({
  jobId,
  host,
  project,
  startedAt: new Date(AT - fromH * H).toISOString(),
  endedAt: new Date(AT - toH * H).toISOString(),
  queuedAt: new Date(AT - fromH * H - 60_000).toISOString(),
  capacity: { slots: 4, memMiB: 16384, cpuCenti: 700, cpus: 8 },
  size: { memMiB: 4096, cpuCenti: 200 },
});

const LIVE = [
  {
    name: "mini1",
    routes: "true",
    concurrency: "4",
    budgetMemMiB: "16384",
    budgetCpuCenti: "700",
    usedMemMiB: "6144",
    usedCpuCenti: "300",
    budgetRunning: "2",
    waiters: "1",
    staleMs: 3000,
    jobs: [
      { id: "gh-123456", p: "web", m: 4096, c: 200, at: AT - 12 * 60_000, o: false },
      { id: "repeat:nightly:1791460800000", p: null, m: 2048, c: 100, at: AT - 65 * 60_000, o: false },
      { id: "container:pi-job-old", p: "ops", m: 2048, c: 100, at: AT - 5 * H, o: true },
    ],
    jobsMore: 0,
    jobsUnreadable: false,
  },
  { name: "mini2", routes: "false", concurrency: "2", budgetMemMiB: "", budgetCpuCenti: "", budgetRunning: "0", staleMs: 200_000, jobs: null, jobsMore: null, jobsUnreadable: true },
];

/** The report the view draws, by the worker's own function: mini1's local files, a mirror cut 3 days back, old3 gone. */
function reportOf(live = LIVE, records = [rec("a", "mini1", "web", 30, 28), rec("b", "mini1", "ops", 29, 20), rec("c", "old3", null, 50, 40)]) {
  return computeCapacity({
    records,
    live,
    windowStartMs: AT - 7 * DAY,
    nowMs: AT,
    bucketMs: 6 * H,
    coverage: { source: "mirror+local", localHost: "mini1", local: { fromMs: AT - 7 * DAY }, mirror: { fromMs: AT - 3 * DAY, truncated: true, hosts: ["mini1", "old3"] } },
  });
}

const SNAP = { queue: { counts: {} }, budget: {}, runs: [], hostBudgets: LIVE };

function cannedDeps(overrides = {}) {
  return { fetchSnapshot: async () => SNAP, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT, ...overrides };
}

/** Open the HOSTS view on a canned panel and hand back the component. */
async function openHosts(overrides = {}, theme = undefined) {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, theme, deps: cannedDeps(overrides) });
  await flush();
  comp.handleInput("u");
  await flush();
  return comp;
}

const textAt = (comp, w) => stripAnsi(comp.render(w).join("\n"));
/** The frame's body as one run of text: borders off, each row trimmed, rows joined by a space, so a clause wrapped onto
 * the next row still matches as one. */
const body = (comp, w) => comp.render(w).map((l) => stripAnsi(l).trim().replace(/^│ ?/, "").replace(/ *│$/, "").trim()).filter(Boolean).join(" ");

test("u opens the HOSTS view; Esc returns to the list; c and g stay inert; the footer is unchanged and fits 80", async () => {
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ fetchSnapshot: async () => ({ ...SNAP, runs: [] }), capacityInfo: async () => ({ report: reportOf() }) }) });
  await flush();
  const list = comp.render(80).map(stripAnsi);
  const divider = list.find((l) => /RUNS/.test(l));
  assert.match(divider, /j projects · u hosts/, "the runs divider names the key, beside j");
  assert.ok(!divider.includes("…"), "the divider's meta is whole at 80");
  const footer = list.find((l) => l.includes("q quit"));
  assert.ok(!footer.includes("…"), "the footer is not clipped");
  assert.doesNotMatch(footer, /u hosts/, "the key is announced in the divider, not the footer");
  for (const key of ["c", "g"]) {
    comp.handleInput(key);
    await flush();
    assert.match(textAt(comp, 80), /RUNS/, `${key} stays on the LIST`);
  }
  comp.handleInput("u");
  await flush();
  assert.match(textAt(comp, 80), /hosts · 2 live · last 7d/);
  for (const key of ["q", "p", "x", "j", "b", "u"]) {
    comp.handleInput(key);
    await flush();
    assert.match(textAt(comp, 80), /hosts · 2 live/, `${key} is inert in the HOSTS view`);
  }
  comp.handleInput("\x1b");
  await flush();
  assert.match(textAt(comp, 80), /RUNS/, "Esc backs out to the list");
  await comp.dispose();
});

test("capacityInfo is read once on entry and never on the tick; a reopen reads again", async () => {
  let fetches = 0;
  const asked = [];
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 5,
    deps: cannedDeps({ fetchSnapshot: async () => (fetches++, SNAP), capacityInfo: async (arg) => (asked.push(arg), { report: reportOf() }) }),
  });
  await flush();
  comp.handleInput("u");
  const from = fetches;
  // Bounded by count, not by the clock: wait for several ticks to have run while the view is open.
  for (let i = 0; i < 400 && fetches < from + 4; i++) await delay(5);
  assert.ok(fetches >= from + 4, "the tick kept fetching while the view was open");
  assert.deepEqual(asked, [{ window: "7d" }], "one read, of the 7-day window, however many ticks ran");
  comp.handleInput("\x1b");
  comp.handleInput("u");
  await flush();
  assert.equal(asked.length, 2, "Esc drops the report, so the next u reads it again");
  await comp.dispose();
});

test("an answer that arrives after Esc is never drawn; a reopen while it runs waits for it rather than reading again", async () => {
  const pending = [];
  const comp = await openHosts({ capacityInfo: () => new Promise((resolve) => pending.push(resolve)) });
  assert.match(textAt(comp, 80), /reading the last 7 days of run records/, "the loading state");
  assert.match(textAt(comp, 80), /last 7d: reading/, "each host says its history is being read, never idle");
  comp.handleInput("\x1b");
  pending[0]({ report: reportOf() });
  await flush();
  assert.match(textAt(comp, 80), /RUNS/, "still the list");
  comp.handleInput("u");
  comp.handleInput("\x1b");
  comp.handleInput("u");
  await flush();
  assert.equal(pending.length, 2, "one read for the two openings: the second waits for the first's");
  pending[1]({ error: "second" });
  await flush();
  assert.match(textAt(comp, 80), /history unreadable \(second\)/, "the open view draws the read it waited for");
  await comp.dispose();
});

test("a read storm: fifty Esc and u presses over a slow read start one read, and u in the view starts none while it runs", async () => {
  let started = 0;
  let inFlight = 0;
  let peak = 0;
  const pending = [];
  const capacityInfo = () => {
    started++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise((resolve) => pending.push((v) => (inFlight--, resolve(v))));
  };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: cannedDeps({ capacityInfo }) });
  await flush();
  for (let i = 0; i < 50; i++) {
    comp.handleInput("u");
    comp.handleInput("\x1b");
  }
  comp.handleInput("u");
  comp.handleInput("u");
  comp.handleInput("u");
  await flush();
  assert.deepEqual({ started, peak }, { started: 1, peak: 1 });
  pending[0]({ report: reportOf() });
  await flush();
  assert.match(textAt(comp, 80), /last 7d to 12:00 UTC: busy/, "the one read is drawn under the opening that waited for it");
  await comp.dispose();
});

test("u in the view reads the 7 days again, keeping the last reading on screen, marked, until the new one lands", async () => {
  const pending = [];
  const later = computeCapacity({ records: [], live: LIVE, windowStartMs: AT + 15 * 60_000 - 7 * DAY, nowMs: AT + 15 * 60_000, bucketMs: 6 * H, coverage: { source: "local", localHost: "mini1", local: { fromMs: AT - 8 * DAY }, mirror: null } });
  const comp = await openHosts({ capacityInfo: () => new Promise((resolve) => pending.push(resolve)) });
  pending[0]({ report: reportOf() });
  await flush();
  assert.match(textAt(comp, 80), /last 7d to 12:00 UTC: busy 6\.6%/, "the reading is labelled with the moment it was taken");
  const footer = comp.render(80).map(stripAnsi).find((l) => l.includes("esc back"));
  assert.match(footer, /u refresh {2}· {2}esc back/);
  assert.ok(!footer.includes("…"), "the footer fits 80");
  comp.handleInput("u");
  await flush();
  assert.equal(pending.length, 2, "u in the view reads again");
  const during = textAt(comp, 80);
  assert.match(during, /reading the last 7 days again/);
  assert.match(during, /last 7d to 12:00 UTC: busy 6\.6%/, "the last reading stays until the new one lands");
  pending[1]({ report: later });
  await flush();
  assert.match(textAt(comp, 80), /last 7d to 12:15 UTC/);
  assert.doesNotMatch(textAt(comp, 80), /again/);
  await comp.dispose();
});

test("the live lines: slots of the limit, promised against the budget, waiters, jobs with project, size and age, orphans", async () => {
  const comp = await openHosts({ capacityInfo: async () => ({ report: reportOf() }) });
  const out = body(comp, 140);
  await comp.dispose();
  assert.match(out, /┐ mini1 2 of 4 slots/, "the host's name heads its block, first in the frame");
  assert.match(out, /2 of 4 slots · promised memory 6g of 16g, CPU 3 of 7 (· )?1 waiting for the budget/, "an orphan holds no slot");
  assert.match(out, /gh-123456 {2}web {2}4g, 2 CPUs {2}12m/);
  assert.match(out, /repeat:nightly:1791460800000 {2}\(no project\) {2}2g, 1 CPU {2}1h 5m/);
  assert.match(out, /container:pi-job-old {2}ops {2}2g, 1 CPU {2}5h {2}orphan/);
  assert.match(out, /orphan: a container whose stop did not take, still held by the budget/);
  assert.doesNotMatch(out.split("mini2")[0], /stale/, "a fresh row is not called stale");
  assert.match(out, /1h 5m container:pi-job-old/, "oldest last as listed: the row's own order");
});

test("the 7-day lines: busy, slots on average and at peak, time full, wait p95, top projects, and where the history is from", async () => {
  const comp = await openHosts({ capacityInfo: async () => ({ report: reportOf() }) });
  const out = body(comp, 140);
  await comp.dispose();
  assert.match(out, /last 7d to 12:00 UTC: busy 6\.6% · avg 0\.1 of 4, peak 2 · full 0% (· )?wait p95 1m/);
  assert.match(out, /top: ops 9h, web 2h 12m, \(no project\) 1h 5m/);
  assert.match(out, /history from the run mirror and this host's files/, "a host both sources hold says both");
  assert.doesNotMatch(out, /files only/, "never `only` for a host the mirror also holds");
  assert.match(out, /Jobs only: a machine busy with other work reads as idle\./);
});

test("missing history is never idle: a cut mirror, a host whose history is not shared, a host with no live row", async () => {
  const comp = await openHosts({ capacityInfo: async () => ({ report: reportOf() }) });
  const out = body(comp, 140);
  await comp.dispose();
  // mini2 declares no PI_WORKER_NAME: the shared sentence, not a 0% busy line.
  assert.match(out, /mini2[^]*last 7d to 12:00 UTC: not here: no source here holds its runs \(a worker without PI_WORKER_NAME writes no run mirror\)/);
  assert.doesNotMatch(out.split("mini2")[1].split("old3")[0], /busy/, "no busy share for a host whose history is not here");
  assert.match(out, /old3 {2}no live row/);
  assert.match(out, /history from the run mirror; from 2026-10-05T12:00:00\.000Z on \(the run mirror holds nothing older: its cap, or a peer's shorter retention, cut it\), earlier time counted as neither busy nor idle/, "the CLI's words");
});

test("a mirror that was not read names its reason, through the shared sentence", async () => {
  const live = [{ ...LIVE[0], name: "peer", routes: "true" }];
  const report = computeCapacity({ records: [], live, windowStartMs: AT - 7 * DAY, nowMs: AT, bucketMs: 6 * H, coverage: { source: "local", reason: "the run mirror was not read (timeout)", localHost: "mini1", local: { fromMs: AT - 7 * DAY }, mirror: null } });
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: live }), capacityInfo: async () => ({ report }) });
  const out = body(comp, 140);
  await comp.dispose();
  assert.match(out, /last 7d to 12:00 UTC: not here: the run mirror was not read \(the run mirror was not read \(timeout\)\), so its runs are not here/);
  assert.match(out, /Jobs only: a machine busy with other work reads as idle; the run mirror was not read \(timeout\)\./);
});

test("a stale row says so; a row whose job list does not parse says how many run is unknown; no budget is said", async () => {
  const comp = await openHosts({ capacityInfo: async () => ({ report: reportOf() }) });
  const out = textAt(comp, 140);
  await comp.dispose();
  assert.match(out, /mini2 {2}stale 3m/);
  assert.match(out, /its row is stale: its running jobs count up to its last beat/);
  assert.match(out, /\? of 2 slots · budget not known yet/, "an unreadable list is `?`, never 0; a budget published as \"\" is not known yet");
  assert.match(out, /its list of running jobs could not be read: how many run is unknown/);
});

test("a worker older than the jobs field falls back to its budget's running count; a dimension switched off is said", async () => {
  const row = { name: "old", routes: "true", concurrency: "3", budgetMemMiB: "off", budgetCpuCenti: "400", usedMemMiB: "0", usedCpuCenti: "200", budgetRunning: "2", staleMs: 1000, jobs: null, jobsMore: null, jobsUnreadable: false };
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: [row] }), capacityInfo: async () => ({ report: reportOf([row], []) }) });
  const out = textAt(comp, 140);
  await comp.dispose();
  assert.match(out, /2 of 3 slots · promised CPU 2 of 4, no memory budget/);
  assert.match(out, /it lists no running jobs \(a worker older than this panel\): 2 by its budget/);
});

test("unknown is not absent: a starting worker, a budget switched off, a worker from before the budget fields", async () => {
  const starting = { name: "boot", routes: "true", concurrency: "2", budgetMemMiB: "", budgetCpuCenti: "", usedMemMiB: "", usedCpuCenti: "", budgetRunning: "", waiters: "", staleMs: 1000, jobs: null, jobsMore: null, jobsUnreadable: false };
  const off = { name: "free", routes: "true", concurrency: "2", budgetMemMiB: "off", budgetCpuCenti: "off", waiters: "", staleMs: 1000, jobs: [], jobsMore: 0, jobsUnreadable: false };
  const ancient = { name: "ancient", routes: "true", concurrency: "2", staleMs: 1000, jobs: null, jobsMore: null, jobsUnreadable: false };
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: [starting, off, ancient] }), capacityInfo: async () => ({ unwired: true }) });
  const out = body(comp, 140);
  await comp.dispose();
  assert.match(out, /boot \? of 2 slots · budget not known yet its running jobs are not published yet \(the worker is starting\)/);
  assert.doesNotMatch(out.split("free")[0], /older than this panel/, "a starting worker is not an old one");
  assert.match(out, /free 0 of 2 slots · no memory budget, no CPU budget no job running/);
  assert.match(out, /ancient \? of 2 slots · no host budget published it lists no running jobs \(a worker older than this panel\)/);
});

test("a row with no beat time is no evidence of life: its slots are ?, and it says so", async () => {
  const ghost = { name: "ghost", routes: "true", concurrency: "4", budgetMemMiB: "", budgetCpuCenti: "", budgetRunning: "3", waiters: "0", staleMs: null, jobs: [{ id: "gh-1", p: "web", m: 1024, c: 100, at: AT - 5 * DAY, o: false }], jobsMore: 0, jobsUnreadable: false };
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: [ghost] }), capacityInfo: async () => ({ unwired: true }) });
  const out = body(comp, 140);
  await comp.dispose();
  assert.match(out, /ghost {2}no beat time \? of 4 slots/);
  assert.match(out, /its row carries no beat time, so it is no evidence the host runs: its jobs are not counted/);
});

test("hidden orphans are counted apart from hidden running jobs, and hold no slot", async () => {
  const run = (i) => ({ id: `gh-${i}`, p: "web", m: 1024, c: 100, at: AT - (20 - i) * 60_000, o: false });
  const orphan = (i) => ({ id: `container:pi-job-${i}`, p: "ops", m: 1024, c: 100, at: AT - (5 - i) * 60_000, o: true });
  const only = { ...LIVE[0], jobs: [0, 1, 2, 3].map(run).concat([0, 1, 2].map(orphan)), jobsMore: 0 };
  let comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: [only] }), capacityInfo: async () => ({ unwired: true }) });
  let out = body(comp, 140);
  await comp.dispose();
  assert.match(out, /4 of 4 slots/);
  assert.match(out, /\+3 orphaned containers orphan: a container whose stop did not take/, "no `more running` for three orphans");
  assert.doesNotMatch(out, /more running/);
  const mixed = { ...LIVE[0], jobs: [0, 1, 2, 3, 4].map(run).concat([0, 1].map(orphan)), jobsMore: 1 };
  comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: [mixed] }), capacityInfo: async () => ({ unwired: true }) });
  out = body(comp, 140);
  await comp.dispose();
  assert.match(out, /6 of 4 slots/);
  assert.match(out, /\+2 more running, 2 orphaned containers/);
  const none = { ...LIVE[0], jobs: [0, 1, 2, 3, 4].map(run), jobsMore: 0 };
  comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: [none] }), capacityInfo: async () => ({ unwired: true }) });
  out = body(comp, 140);
  await comp.dispose();
  assert.doesNotMatch(out, /orphan/, "no orphan, no orphan sentence");
});

test("the caveats are the CLI's sentences: the slot basis, retries, stalls, refusals, and the fleet's uncounted records", async () => {
  const report = reportOf();
  const h = report.hosts.find((x) => x.name === "mini1");
  h.capacity = { ...h.capacity, basis: "current", changed: false };
  Object.assign(h.coverage, { retried: 2, earlier: 1, stalledRepick: 1, refusedBeforeSlot: 3, legacyOccupied: 1, legacyRefused: 0 });
  Object.assign(report.coverage, { withoutHost: 2, earlierDropped: 1 });
  const cli = capacityText(report, { since: "7d" }).replace(/\s+/g, " ");
  const comp = await openHosts({ capacityInfo: async () => ({ report }) });
  const out = body(comp, 140);
  await comp.dispose();
  for (const sentence of [
    "slots: current setting, no run recorded one",
    "3 jobs refused before a slot",
    "2 retried runs: 1 earlier attempt counted from the records the retries kept; an attempt whose record was not kept is not counted, so busy time can be under-counted",
    "1 run was picked up again after a stall: the first pickup's time is not counted",
    "1 record from before capacity was recorded, inferred (1 held a slot, 0 refused)",
    "2 without a host, not counted",
    "1 carried earlier attempt not counted (not valid, beyond the 4 a record keeps, or overlapping its own run)",
  ]) {
    assert.ok(out.includes(sentence), `the panel says: ${sentence}`);
    assert.ok(cli.includes(sentence.replace(/^slots: /, "")), `the CLI says it too: ${sentence}`);
  }
});

test("many jobs: the oldest few, then a count of the rest including what the row did not list", async () => {
  const jobs = Array.from({ length: 9 }, (_, i) => ({ id: `gh-${i}`, p: "web", m: 1024, c: 100, at: AT - (9 - i) * 60_000, o: false }));
  const row = { ...LIVE[0], concurrency: "32", jobs, jobsMore: 3 };
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: [row] }), capacityInfo: async () => ({ report: reportOf([row], []) }) });
  const out = textAt(comp, 140);
  await comp.dispose();
  assert.match(out, /12 of 32 slots/, "listed plus not listed");
  assert.match(out, /gh-0 .*9m[^]*gh-3 /);
  assert.doesNotMatch(out, /gh-4 /, "only the first four rows");
  assert.match(out, /\+8 more running/, "five listed past the four shown, and three the row did not list");
});

test("an empty fleet, an unreachable history, an error and an unwired panel each say what they are", async () => {
  const empty = computeCapacity({ records: [], live: [], windowStartMs: AT - 7 * DAY, nowMs: AT, bucketMs: 6 * H, coverage: {} });
  let comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: [] }), capacityInfo: async () => ({ report: empty }) });
  assert.match(textAt(comp, 80), /hosts · 0 live[^]*no live host, and no host ran a job in the last 7d/);
  await comp.dispose();
  comp = await openHosts({ capacityInfo: async () => { throw new Error("valkey \x1b[31mgone"); } });
  let out = textAt(comp, 80);
  await comp.dispose();
  assert.match(out, /history unreadable \(valkey  ?\[31mgone\)/, "the thrown message, its control byte gated");
  assert.doesNotMatch(out, /\x1b/);
  assert.match(out, /last 7d: not read/);
  assert.match(out, /2 of 4 slots/, "the live lines still draw");
  comp = await openHosts({ capacityInfo: async () => ({ error: "PI_LOG_RETENTION_DAYS must be a non-negative integer" }) });
  assert.match(textAt(comp, 80), /history unreadable \(PI_LOG_RETENTION_DAYS must be a non-negative integer\)/);
  await comp.dispose();
  comp = await openHosts({});
  out = textAt(comp, 80);
  await comp.dispose();
  assert.match(out, /history not wired in this panel \(no capacity reader\)/);
});

test("an unreadable registry says the rows are the last read", async () => {
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, queue: { counts: {}, fleetDegraded: "timeout" } }), capacityInfo: async () => ({ report: reportOf() }) });
  assert.match(textAt(comp, 80), /host registry unreadable \(timeout\): the rows last read/);
  await comp.dispose();
});

const LONG_HOST = `a${"b".repeat(63)}`;
const LONG_PROJECT = `p${"q".repeat(31)}`;
const LONG_ID = `gh-${"9".repeat(125)}`;
const HOSTILE = "evil\x1b[2J\u009b31m‮name\x07";

function hardRows() {
  return [
    { ...LIVE[0], name: LONG_HOST, staleMs: 400_000, jobs: [{ id: LONG_ID, p: LONG_PROJECT, m: 16384, c: 1250, at: AT - 3 * DAY, o: true }], jobsMore: 40 },
    { ...LIVE[0], name: HOSTILE, jobs: [{ id: "gh-\x1b]8;;x\x07id", p: "web\x1b[1m", m: 1, c: 1, at: AT, o: false }] },
    LIVE[1],
  ];
}

test("every line fits at 140, 80, 60 and 47, framed and coloured; long names and ids clip rather than overflow", async () => {
  const rows = hardRows();
  const live = rows.filter((r) => r.name !== HOSTILE);
  const report = reportOf(live, [rec("a", LONG_HOST, LONG_PROJECT, 30, 28), rec("b", LONG_HOST, "ops", 29, 20)]);
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: rows }), capacityInfo: async () => ({ report }) }, SGR_THEME);
  for (const w of [140, 80, 60, 47]) {
    const lines = comp.render(w);
    assert.ok(lines.some((l) => l.includes("\x1b[38;5;42m")), `width ${w}: the framed view is coloured`);
    for (const l of lines) assert.ok(visibleLen(l) <= w, `width ${w}: ${JSON.stringify(stripAnsi(l))} is ${visibleLen(l)} columns`);
    const plain = lines.map(stripAnsi).join("\n");
    assert.match(plain, /hosts · 3 live/, `width ${w}: the title`);
    assert.match(plain, /abbbb/, `width ${w}: the long host name is drawn, clipped where it must be`);
  }
  assert.match(textAt(comp, 140), new RegExp(`${LONG_HOST} {2}stale 6m`), "at 140 the whole name and its stale age");
  assert.match(textAt(comp, 140), /\+40 more running/);
  assert.match(textAt(comp, 140), /pqqqqqqqqqqqqqq… {2}16g, 12\.5 CPUs {2}3d {2}orphan/, "the project clipped, the size, age and orphan mark kept");
  await comp.dispose();
});

test("a hostile host name, job id or project id reaches the terminal as text: no escape, no C1, the bidi override shown", async () => {
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: hardRows() }), capacityInfo: async () => ({ report: reportOf() }) }, SGR_THEME);
  for (const w of [140, 80, 47]) {
    const plain = comp.render(w).map(stripAnsi).join("\n");
    assert.doesNotMatch(plain, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, `width ${w}: no control byte survives`);
    assert.doesNotMatch(plain, /‮/, `width ${w}: the override does not reach the terminal`);
  }
  const out = textAt(comp, 140);
  assert.match(out, /evil\\u\{001B\}\[2J\\u\{009B\}31m\\u\{202E\}name/, "the override and the controls are escaped as visible text");
  assert.match(out, /not counted \(not a worker name\)/, "a name outside the worker's rule has no history, and says so");
  await comp.dispose();
});

test("below the frame's minimum the view degrades to plain lines with no SGR, inside the width it was given", async () => {
  const comp = await openHosts({ fetchSnapshot: async () => ({ ...SNAP, hostBudgets: hardRows() }), capacityInfo: async () => ({ report: reportOf() }) }, SGR_THEME);
  for (const w of [4, 7, NaN]) {
    const lines = comp.render(w);
    for (const l of lines) {
      assert.doesNotMatch(String(l), /\x1b/, `width ${w}: the degrade emitted an escape`);
      if (Number.isFinite(w)) assert.ok(visibleLen(l) <= w, `width ${w}: ${JSON.stringify(l)}`);
    }
  }
  const nan = comp.render(NaN);
  assert.equal(nan[0], "hosts · 3 live · last 7d", "the title leads the plain lines");
  assert.equal(nan[nan.length - 1], "u refresh · esc back");
  await comp.dispose();
});

// ── the snapshot's registry projection ──────────────────────────────────────────────────────────────────

function fakeFleet(rows) {
  const queue = (name) => ({
    name,
    async isPaused() { return false; },
    async getJobCounts() { return {}; },
    async getWorkers() { return []; },
    async getJobSchedulers() { return []; },
    async getActive() { return []; },
    async getFailed() { return []; },
    async close() {},
  });
  const redis = { async get() { return null; }, async mget() { return []; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {} };
  let scans = 0;
  return {
    get scans() { return scans; },
    deps: {
      makeQueueFn: (_c, opts) => queue(opts?.name ?? "pi-jobs"),
      parseConnectionFn: () => ({}),
      redisFn: () => redis,
      readLiveHostsFn: async () => ({ hosts: rows }),
      discoverHostQueuesFn: async () => [],
      scanRecordsFn: () => (scans++, []),
      nowFn: () => AT,
    },
  };
}

test("the tick's snapshot carries each row's live fields through the worker's allowlist, and reads no history", async () => {
  const rows = [
    {
      name: "mini1",
      routes: "true",
      concurrency: "4",
      budgetMemMiB: "8192",
      budgetCpuCenti: "700",
      usedMemMiB: "4096",
      usedCpuCenti: "200",
      budgetRunning: "1",
      waiters: "2",
      staleMs: 1500,
      fpUsd: "secret-ish",
      // a raw row as an unparsing reader hands it: one good entry, one hostile id the allowlist drops
      jobs: JSON.stringify([{ id: "gh-1", p: "web", m: 4096, c: 200, at: AT - 60_000 }, { id: "gh-\u001b[2J", p: "web", at: AT }]),
      jobsMore: "1",
    },
    { name: "mini2", routes: "true", concurrency: "2", jobs: "not json", jobsMore: "0", staleMs: -5 },
  ];
  const fleet = fakeFleet(rows);
  const d = createDashboardDeps({ valkeyUrl: "redis://x", logsDir: "/nope", schedulerStallMax: 3 }, fleet.deps);
  const snap = await d.fetchSnapshot();
  await d.dispose();
  assert.deepEqual(snap.hostBudgets[0], {
    name: "mini1",
    budgetMemMiB: "8192",
    budgetCpuCenti: "700",
    usedMemMiB: "4096",
    usedCpuCenti: "200",
    concurrency: "4",
    budgetRunning: "1",
    waiters: "2",
    jobs: [{ id: "gh-1", p: "web", m: 4096, c: 200, at: AT - 60_000, o: false }],
    jobsMore: 2,
    jobsUnreadable: false,
    staleMs: 1500,
    routes: "true",
  }, "these keys and no other; the dropped entry joins jobsMore");
  assert.equal(snap.hostBudgets[1].jobs, null);
  assert.equal(snap.hostBudgets[1].jobsUnreadable, true, "a value that is not a list is unreadable, never an empty list");
  assert.equal(snap.hostBudgets[1].staleMs, null, "a negative age is not an age");
  assert.equal(fleet.scans, 0, "no run-records scan on the tick (no dollar window is set)");
});
