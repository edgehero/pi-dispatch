import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { stripAnsi } from "../src/style.mjs";
import { deploymentDollarCaps, dollarWindowRows, dollarWindowSpecs, dollarWindowsSinceMs, foldWindowRecords, renderDollarWindows, runDollars, UNATTRIBUTED } from "../src/dollar-windows.mjs";
import { dayKey, monthKey, weekKey } from "@edgehero/pi-dispatch/budget";
import { readDollarCounters } from "../src/read-model.mjs";
import { modelDollarKeyPrefix, scopeDollarKeyPrefix } from "@edgehero/pi-dispatch/scoped-limits";

/**
 * Issue #501, part 7: the dollar windows the panel and `dispatch_costs` show. Two sources, never blended: the
 * COUNTER (spent and held, what the next job is admitted against) and the RUN RECORDS (how each run settled). Every
 * clock is injected (`now`), never the wall clock, so the suite holds under the 399-day shift.
 */

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard, createDashboardDeps } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const NOW = new Date(Date.UTC(2026, 9, 14, 12, 0, 0)); // a Wednesday
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const record = (over = {}) => ({
  jobId: "gh-1",
  kind: "github",
  target: "acme/web#12",
  flow: "fix",
  startedAt: iso(NOW.getTime() - HOUR),
  endedAt: iso(NOW.getTime() - HOUR / 2),
  outcome: "completed",
  tokens: { total: 10, cost: 0.4, boundExceeded: 0 },
  dollars: { reservedMicros: 2_000_000, settledMicros: 400_000, basis: "metered", modelBasis: null },
  ...over,
});

const LIMITS = [
  { scope: "acme/web", day: 3, week: null, month: null, concurrent: null, dayUsd: "5.00", weekUsd: null, monthUsd: null },
  { scope: "/srv/site", day: null, week: null, month: null, concurrent: null, dayUsd: null, weekUsd: "7.00", monthUsd: null },
  { scope: "acme/count-only", day: 2, week: null, month: null, concurrent: null, dayUsd: null, weekUsd: null, monthUsd: null },
  { scope: "model:openai/gpt-x", day: null, week: null, month: null, concurrent: null, dayUsd: null, weekUsd: null, monthUsd: "25.00" },
];

test("deploymentDollarCaps merges the overlay over the env, key by key, and names a value it cannot read", () => {
  const { caps, invalid } = deploymentDollarCaps({ dailyCostUsd: "10" }, { PI_DAILY_COST_USD: "99", PI_MONTHLY_COST_USD: "100", PI_WEEKLY_COST_USD: "" });
  assert.deepEqual(caps, { day: 10_000_000, week: null, month: 100_000_000 }, "the overlay wins, an empty env value is unset");
  assert.deepEqual(invalid, []);
  const bad = deploymentDollarCaps({ weeklyCostUsd: "1e3" }, {});
  assert.deepEqual(bad.caps, { day: null, week: null, month: null }, "never a guessed cap");
  assert.deepEqual(bad.invalid, ["weeklyCostUsd"]);
});

test("the specs are the deployment's windows first, then each dollar row in file order, under the worker's own keys", () => {
  const specs = dollarWindowSpecs({ caps: { day: 10_000_000, week: null, month: 50_000_000 }, limits: LIMITS, now: NOW });
  assert.deepEqual(
    specs.map((s) => [s.ledger, s.name, s.index, s.window, s.capMicros]),
    [
      ["deployment", null, null, "day", 10_000_000],
      ["deployment", null, null, "month", 50_000_000],
      ["scope", "acme/web", 0, "day", 5_000_000],
      ["scope", "/srv/site", 1, "week", 7_000_000],
      ["model", "openai/gpt-x", 3, "month", 25_000_000],
    ],
    "a count-only row has no dollar window",
  );
  assert.equal(specs[0].key, dayKey(NOW, "budget:usd"));
  assert.equal(specs[1].key, monthKey(NOW, "budget:usd"));
  assert.equal(specs[2].key, dayKey(NOW, scopeDollarKeyPrefix("acme/web")));
  assert.equal(specs[3].key, weekKey(NOW, scopeDollarKeyPrefix("/srv/site")));
  assert.equal(specs[4].key, monthKey(NOW, modelDollarKeyPrefix("openai/gpt-x")));
  assert.deepEqual(dollarWindowSpecs({ caps: { day: null, week: null, month: null }, limits: [], now: NOW }), [], "nothing set, nothing shown");
});

test("the scan starts at the oldest active window: the month's first, or a Monday in the month before", () => {
  const specs = dollarWindowSpecs({ caps: { day: 1, week: 1, month: 1 }, limits: [], now: NOW });
  assert.equal(dollarWindowsSinceMs(specs, NOW), Date.UTC(2026, 9, 1));
  const early = new Date(Date.UTC(2026, 9, 2, 8)); // a Friday; its week began Monday 2026-09-28
  assert.equal(dollarWindowsSinceMs(dollarWindowSpecs({ caps: { day: 1, week: 1, month: 1 }, limits: [], now: early }), early), Date.UTC(2026, 8, 28));
  assert.equal(dollarWindowsSinceMs(dollarWindowSpecs({ caps: { day: 1, week: null, month: null }, limits: [], now: NOW }), NOW), Date.UTC(2026, 9, 14));
  assert.equal(dollarWindowsSinceMs([], NOW), null);
});

test("spent and held come from the COUNTER, settled from the records, and the two are never blended", () => {
  const specs = dollarWindowSpecs({ caps: { day: 10_000_000, week: null, month: null }, limits: [], now: NOW });
  // The counter holds a running job's whole hold (2,000,000) on top of what settled: the records cannot see it.
  const counters = { [specs[0].key]: 2_400_000 };
  const [row] = dollarWindowRows({ specs, counters, records: [record()] });
  assert.equal(row.counterMicros, 2_400_000, "spent and held is the counter, never the records' sum");
  assert.equal(row.records.settledMicros, 400_000);
  assert.equal(row.records.runs, 1);
  // An absent key is an honest 0 (nothing reserved yet); an unreadable queue is null, never an invented 0.
  assert.equal(dollarWindowRows({ specs, counters: {}, records: [] })[0].counterMicros, 0);
  assert.equal(dollarWindowRows({ specs, counters: { unreachable: "down" }, records: [record()] })[0].counterMicros, null);
});

test("the records' side counts each basis, sums boundExceeded, and keeps only runs that started in the window", () => {
  const specs = dollarWindowSpecs({ caps: { day: 10_000_000, week: null, month: 90_000_000 }, limits: [], now: NOW });
  const records = [
    record(),
    record({ jobId: "b", tokens: { boundExceeded: 2 }, dollars: { reservedMicros: 2_000_000, settledMicros: 2_000_000, basis: "floor", modelBasis: null } }),
    record({ jobId: "c", dollars: { reservedMicros: 2_000_000, settledMicros: 0, basis: "refunded", modelBasis: null } }),
    record({ jobId: "d", dollars: { reservedMicros: 0, settledMicros: 0, basis: "unreserved", modelBasis: null } }),
    // Started yesterday: in the month, not in today's window, and it settled into yesterday's day key.
    record({ jobId: "e", startedAt: iso(NOW.getTime() - DAY), endedAt: iso(NOW.getTime() - DAY + HOUR), dollars: { reservedMicros: 1, settledMicros: 1_000_000, basis: "metered", modelBasis: null } }),
    // No dollar window applied: no `dollars`, never counted.
    record({ jobId: "f", dollars: null }),
    // A malformed amount is skipped and counted, never read as 0.
    record({ jobId: "g", dollars: { reservedMicros: 1, settledMicros: "lots", basis: "metered", modelBasis: null } }),
  ];
  const [day, month] = dollarWindowRows({ specs, counters: {}, records });
  assert.deepEqual(day.records, { runs: 5, settledMicros: 2_400_000, basis: { metered: 2, floor: 1, refunded: 1, unreserved: 1 }, boundExceeded: 2, malformed: 1 });
  assert.equal(month.records.runs, 6);
  assert.equal(month.records.settledMicros, 3_400_000);
});

test("a repo row folds its own forge runs; a folder or model row says why its runs cannot be named", () => {
  const specs = dollarWindowSpecs({ caps: {}, limits: LIMITS, now: NOW });
  const records = [
    record(),
    record({ jobId: "other", target: "acme/api#3", dollars: { reservedMicros: 1, settledMicros: 900_000, basis: "metered", modelBasis: "metered" } }),
    record({ jobId: "local", kind: "local", target: "local:web", dollars: { reservedMicros: 1, settledMicros: 700_000, basis: "metered", modelBasis: null } }),
  ];
  const rows = dollarWindowRows({ specs, counters: {}, records });
  assert.equal(rows[0].name, "acme/web");
  assert.equal(rows[0].records.runs, 1, "only acme/web's own run, never another repo's or a local one");
  assert.equal(rows[0].records.settledMicros, 400_000);
  assert.equal(rows[1].records, null);
  assert.equal(rows[1].unattributed, UNATTRIBUTED.folder);
  assert.equal(rows[2].records, null);
  assert.equal(rows[2].unattributed, UNATTRIBUTED.model);
  assert.equal(foldWindowRecords(records, specs[2]).unattributed, UNATTRIBUTED.model);
});

test("only numbers, fixed tokens and the operator's own scope and model names leave the rows", () => {
  const specs = dollarWindowSpecs({ caps: { day: 10_000_000 }, limits: LIMITS, now: NOW });
  const poisoned = record({ flow: "SECRET-FLOW", target: "acme/web#12", jobId: "SECRET-JOB", reason: "SECRET-REASON" });
  const text = JSON.stringify(dollarWindowRows({ specs, counters: {}, records: [poisoned] }));
  for (const needle of ["SECRET", "#12", "fix"]) assert.ok(!text.includes(needle), `${needle} must not reach a row: ${text}`);
});

test("runDollars lists each run's dollars newest first, rebuilt from named fields, capped with a count", () => {
  const records = [
    record({ jobId: "old", endedAt: iso(NOW.getTime() - 3 * HOUR) }),
    record({ jobId: "new", endedAt: iso(NOW.getTime() - HOUR), dollars: { reservedMicros: 2, settledMicros: 2, basis: "floor", modelBasis: "floor", extra: "SECRET" }, tokens: { boundExceeded: 1 } }),
    record({ jobId: "none", dollars: null }),
  ];
  const out = runDollars(records, { limit: 1 });
  assert.deepEqual(out.runs, [{ jobId: "new", startedAt: records[1].startedAt, endedAt: records[1].endedAt, flow: "fix", outcome: "completed", dollars: { reservedMicros: 2, settledMicros: 2, basis: "floor", modelBasis: "floor" }, boundExceeded: 1 }]);
  assert.equal(out.more, 1, "the run with no dollars is not a row");
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

test("the plain renderer is null when no window is set, and states both sources when one is", () => {
  assert.equal(renderDollarWindows(null), null);
  assert.equal(renderDollarWindows({ rows: [] }), null);
  const text = renderDollarWindows({ rows: [
    { ledger: "deployment", name: null, window: "day", capMicros: 10_000_000, counterMicros: 2_400_000, records: { runs: 2, settledMicros: 400_000, basis: { metered: 1, floor: 1, refunded: 0, unreserved: 0 }, boundExceeded: 0 } },
    { ledger: "model", name: "openai/gpt-x", window: "month", capMicros: 25_000_000, counterMicros: null, records: null, unattributed: UNATTRIBUTED.model },
  ] });
  assert.match(text, /day   deployment  spent\+held \$2\.40 of \$10\.00  settled \$0\.40 from 2 runs \(1 metered, 1 floor\), boundExceeded 0/);
  assert.match(text, /month model:openai\/gpt-x  spent\+held - of \$25\.00  records n\/a/);
});

// --- the panel -------------------------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setImmediate(resolve));
const BASE = {
  queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 0, week: 0, month: 0 },
  settings: { path: "/s", overlay: {} },
  runs: [],
  stagedPackages: { stagedAt: null, packages: [] },
};

async function renderSnapshot(snap, width = 120) {
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW.getTime() },
  });
  await flush();
  const lines = comp.render(width).map((l) => stripAnsi(l));
  await comp.dispose();
  return lines;
}

test("the panel shows no dollar section when no dollar window is set", async () => {
  const lines = await renderSnapshot({ ...BASE, dollars: null });
  assert.ok(!lines.some((l) => /dollar windows/i.test(l)));
});

test("the panel shows each window's counter over its cap, then what the records say", async () => {
  const lines = await renderSnapshot({ ...BASE, dollars: { rows: [
    { ledger: "deployment", name: null, window: "day", capMicros: 10_000_000, counterMicros: 2_400_000, records: { runs: 2, settledMicros: 400_000, basis: { metered: 1, floor: 1, refunded: 0, unreserved: 0 }, boundExceeded: 3 } },
    { ledger: "scope", name: "/srv/site", window: "week", capMicros: 7_000_000, counterMicros: 7_000_000, records: null, unattributed: UNATTRIBUTED.folder },
  ] } });
  assert.ok(lines.some((l) => /dollar windows/i.test(l)));
  assert.ok(lines.some((l) => /day\s+deployment\s+\$2\.40\/\$10\.00\s+settled \$0\.40 · 2 runs \(1 metered, 1 floor\)\s+boundExceeded 3/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /week\s+\/srv\/site\s+\$7\.00\/\$7\.00\s+records n\/a/.test(l)));
});

test("the panel's REAL deps read the counters every tick and the records at most once per interval", async () => {
  const dir = tempDir("pd-501-p7-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ maxCostUsd: "2", dailyCostUsd: "10" }));
  const queue = {
    async isPaused() { return false; }, async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; },
    async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; },
    async getFailed() { return []; }, async pause() {}, async resume() {}, async close() {},
  };
  const mgets = [];
  let counter = "2400000";
  const redis = {
    async get() { return "0"; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {},
    async mget(...keys) { mgets.push(keys); return keys.map(() => counter); },
  };
  const scans = [];
  let clock = NOW.getTime();
  const deps = createDashboardDeps({ valkeyUrl: "redis://x", logsDir: join(dir, "logs"), schedulerStallMax: 3, settingsFile, triggersPath: join(dir, "t.json") }, {
    makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis,
    readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [],
    dollarEnvFn: () => ({ PI_WEEKLY_COST_USD: "40" }),
    scanRecordsFn: (args) => { scans.push(args); return [record()]; },
    nowFn: () => clock,
  });
  const first = await deps.fetchSnapshot();
  assert.deepEqual(mgets[0], [dayKey(NOW, "budget:usd"), weekKey(NOW, "budget:usd")], "the overlay's day and the env's week, one MGET");
  assert.deepEqual(first.dollars.rows.map((r) => [r.window, r.capMicros, r.counterMicros, r.records.settledMicros]), [["day", 10_000_000, 2_400_000, 400_000], ["week", 40_000_000, 2_400_000, 400_000]]);
  assert.equal(scans[0].sinceMs, Date.UTC(2026, 9, 12), "from the oldest window's start, the week's Monday");
  counter = "3000000";
  clock += 5_000;
  const second = await deps.fetchSnapshot();
  assert.equal(second.dollars.rows[0].counterMicros, 3_000_000, "the counter is read every tick");
  assert.equal(scans.length, 1, "the records are not re-scanned within the interval");
  clock += 15_000;
  await deps.fetchSnapshot();
  assert.equal(scans.length, 2, "and are after it");
  await deps.dispose();
});

test("the panel's REAL deps read no dollar key and scan nothing when no dollar window is set", async () => {
  const dir = tempDir("pd-501-p7-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ maxCostUsd: "2" }));
  const queue = {
    async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; },
    async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {},
  };
  const redis = { async get() { return "0"; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {}, async mget() { throw new Error("no dollar key may be read"); } };
  let scanned = false;
  const deps = createDashboardDeps({ valkeyUrl: "redis://x", logsDir: join(dir, "logs"), schedulerStallMax: 3, settingsFile }, {
    makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis,
    readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [],
    scanRecordsFn: () => { scanned = true; return []; }, nowFn: () => NOW.getTime(),
  });
  const snap = await deps.fetchSnapshot();
  await deps.dispose();
  assert.equal(snap.dollars, null);
  assert.equal(scanned, false);
});

test("the panel shows a trigger's models and per-job cap on its row and in full in its drill-in (PR #536's obligation)", async () => {
  const t = { type: "label", any: ["bug"], all: [], none: [], flow: "fix", forge: "github", packages: false, instructions: false, secrets: 0, models: ["openai/gpt-x", "anthropic/claude-y"], maxCostUsd: "1.50" };
  const snap = { ...BASE, triggers: { triggers: [t] } };
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW.getTime() },
  });
  await flush();
  const row = comp.render(140).map((l) => stripAnsi(l)).find((l) => l.includes("bug"));
  assert.match(row, /\[models openai\/gpt-x, anthropic\/claude-y\] \[max \$1\.50\]/);
  comp.handleInput("\r");
  await flush();
  const detail = comp.render(100).map((l) => stripAnsi(l)).join("\n");
  await comp.dispose();
  assert.match(detail, /models\s+openai\/gpt-x, anthropic\/claude-y/);
  assert.match(detail, /max cost\s+\$1\.50 per job/);
});

// --- PR #550's review ----------------------------------------------------------------------------------------

test("a run is counted in the window it STARTED in: one that ran across midnight belongs to yesterday", () => {
  const midnight = Date.UTC(2026, 9, 14);
  const specs = dollarWindowSpecs({ caps: { day: 10_000_000 }, limits: [], now: NOW });
  const across = record({ startedAt: iso(midnight - 60_000), endedAt: iso(midnight + 60_000) });
  assert.equal(dollarWindowRows({ specs, counters: {}, records: [across] })[0].records.runs, 0, "its hold was reserved under yesterday's key");
  const yesterday = dollarWindowSpecs({ caps: { day: 10_000_000 }, limits: [], now: new Date(midnight - 1) });
  assert.equal(dollarWindowRows({ specs: yesterday, counters: {}, records: [across] })[0].records.runs, 1);
});

test("a window is FULL when the next job's per-job cap would not fit, not only when the counter reaches the cap", () => {
  const specs = dollarWindowSpecs({ caps: { day: 10_000_000 }, limits: [], now: NOW });
  const row = (counter, jobCapMicros) => dollarWindowRows({ specs, counters: { [specs[0].key]: counter }, records: [], jobCapMicros })[0].full;
  assert.equal(row(8_000_000, 2_000_000), false, "exactly fits: five $2 jobs fill a $10 window");
  assert.equal(row(8_000_001, 2_000_000), true, "one micro-dollar over: no $2 job fits");
  assert.equal(row(9_000_000, null), false, "no per-job cap known: judged on the counter alone");
  assert.equal(row(10_000_000, null), true);
  assert.equal(dollarWindowRows({ specs, counters: { unreachable: "x" }, records: [], jobCapMicros: 1 })[0].full, false, "no counter, no claim");
  assert.equal(deploymentDollarCaps({ maxCostUsd: "2" }, {}).jobCapMicros, 2_000_000);
  assert.equal(deploymentDollarCaps({}, { PI_MAX_COST_USD: "1.5" }).jobCapMicros, 1_500_000);
});

test("readDollarCounters swallows ioredis' error events and gives up after its timeout", async () => {
  const handlers = [];
  const hung = { on: (ev, fn) => handlers.push(ev), mget: () => new Promise(() => {}), disconnect() {} };
  // The reader's timer is unref'd (a one-shot tool must not hold pi open), so the test holds the loop open with a
  // ref'd guard of its own, which also FAILS the test, rather than hanging it, if the reader never gives up.
  let guard;
  let out;
  try {
    out = await Promise.race([
      readDollarCounters({ url: "redis://127.0.0.1:1", keys: ["budget:usd:2026-10-14"], redisFn: () => hung, timeoutMs: 20 }),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("the reader never timed out")), 2000); }),
    ]);
  } finally {
    clearTimeout(guard);
  }
  assert.deepEqual(out, { unreachable: "timed out reaching the queue" });
  assert.deepEqual(handlers, ["error"], "an error listener, so a down Valkey prints no stack traces");
  const ok = { on() {}, async mget() { return ["5", null]; }, disconnect() {} };
  assert.deepEqual(await readDollarCounters({ url: "redis://127.0.0.1:1", keys: ["a", "b"], redisFn: () => ok }), { a: 5 });
});

test("the panel names a dollar setting it cannot read, even when no window is left to show", async () => {
  const dir = tempDir("pd-501-p7-");
  const settingsFile = join(dir, "settings.json");
  // A malformed overlay value makes the whole overlay invalid (shown by the settings section), so the unreadable
  // window here comes from the env the console reads.
  writeFileSync(settingsFile, JSON.stringify({ maxCostUsd: "2" }));
  const queue = {
    async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; },
    async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {},
  };
  const redis = { async get() { return "0"; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {}, async mget() { throw new Error("no window, no read"); } };
  const deps = createDashboardDeps({ valkeyUrl: "redis://x", logsDir: join(dir, "logs"), schedulerStallMax: 3, settingsFile }, {
    makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis,
    readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => NOW.getTime(),
    dollarEnvFn: () => ({ PI_DAILY_COST_USD: "1e3" }),
  });
  const snap = await deps.fetchSnapshot();
  await deps.dispose();
  assert.deepEqual(snap.dollars, { rows: [], invalid: ["dailyCostUsd"] });
  const lines = await renderSnapshot({ ...BASE, dollars: snap.dollars });
  assert.ok(lines.some((l) => /not a dollar amount: dailyCostUsd/.test(l)), lines.join("\n"));
});

test("a full window renders amber and says so", async () => {
  const COL = { warning: 208 };
  const theme = { fg: (c, t) => `\x1b[38;5;${COL[c] ?? 15}m${t}\x1b[39m`, bold: (t) => t, bg: (_c, t) => t };
  const snap = { ...BASE, dollars: { rows: [{ ledger: "deployment", name: null, window: "day", capMicros: 10_000_000, counterMicros: 9_000_000, full: true, records: null }] } };
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, theme,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW.getTime() },
  });
  await flush();
  const text = comp.render(120).join("\n");
  await comp.dispose();
  assert.ok(text.includes("\x1b[38;5;208m$9.00/$10.00 full"), "amber, with the word, so a monochrome terminal still says it");
});
