import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleInsightsView, heldMoneyOf, spendSummaryOf, spendChartsOf, assembleBudgetView } from "../src/insights-assembly.mjs";
import { costsSinceMs, whatIfRuns } from "../src/costs.mjs";
import { makeWhatIfReader } from "../src/console/whatif.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86_400_000;
const pricing = { piAiVersion: () => "test", getPricedModel: () => ({}), isZeroRated: () => false, reprice: (q) => ({ usd: q.input + 2 * q.output + 3 * q.cacheRead + 4 * q.cacheWrite + 5 * q.cacheWrite1h, ratesVersion: "test" }) };
const run = (id, over = {}) => ({ jobId: id, flow: "fix", project: "site", endedAt: new Date(NOW - 1000).toISOString(), usage: { v: 1, truncated: 0, models: [{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 5, cost: 7 }] }, tokens: { cost: 7, metered: true }, ...over });

function readsFixture() {
  const calls = [];
  const watch = (name, value) => (...args) => (calls.push({ name, args }), typeof value === "function" ? value(...args) : value);
  return { calls, reads: {
    projects: watch("projects", { projects: [{ id: "site", name: "Site" }] }),
    costs: watch("costs", { fold: { byFlow: [] }, records: [] }),
    graph: watch("graph", {}), budget: watch("budget", { tokens: {}, dollars: { windows: [] } }),
    allocation: watch("allocation", { window: "week" }), capacity: watch("capacity", {}), sizing: watch("sizing", {}),
    hosts: watch("hosts", { hosts: [] }), scan: watch("scan", []), subscriptions: watch("subscriptions", { subscriptions: [] }), settings: watch("settings", { overlay: {} }),
  } };
}

for (const [view, expected] of [
  ["capacity", ["capacity", "sizing"]],
  ["budget-split", ["projects", "allocation", "hosts", "scan"]],
  ["breakdown", ["projects", "costs"]],
]) test(`${view} reads only its own slices`, async () => {
  const { reads, calls } = readsFixture();
  await assembleInsightsView({}, "7d", { view, pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.deepEqual(calls.map((c) => c.name), expected);
});

test("allocation reasons are requested only for operator loads, viewer full paths stay off and counts use envelope window", async () => {
  const { reads, calls } = readsFixture();
  await assembleInsightsView({}, "30d", { view: "budget-split", role: "viewer", fullPaths: true, pricing, nowMs: NOW, reads });
  const options = calls.find((c) => c.name === "allocation").args[2];
  assert.equal(options.role, "viewer");
  assert.equal(options.fullPaths, false);
  assert.equal(calls.find((c) => c.name === "scan").args[0].sinceMs, costsSinceMs("week", NOW));
  calls.length = 0;
  await assembleInsightsView({}, "7d", { view: "budget-split", role: "operator", fullPaths: true, pricing, nowMs: NOW, reads });
  assert.equal(calls.find((c) => c.name === "allocation").args[2].role, "operator");
});

test("holds use actual published amounts, distinguish old rows from zero, and keep prior-day reservations out of today", () => {
  const hosts = [
    { name: "new", jobsMore: "0", jobs: JSON.stringify([{ id: "a", p: "site", at: NOW - 1000, h: 3_000_000, ha: NOW - 1000 }, { id: "b", p: "site", at: NOW - DAY, h: 5_000_000, ha: NOW - DAY }, { id: "c", p: "site", at: NOW - 1000, h: 0, ha: NOW - 1000 }]) },
    { name: "old", jobsMore: "0", jobs: JSON.stringify([{ id: "d", p: "site", at: NOW - 1000 }]) },
  ];
  assert.deepEqual(heldMoneyOf(hosts, { nowMs: NOW, project: "site" }), { heldMicros: 3_000_000, heldJobs: 1, unknownHosts: ["old"] });
});

test("missing or capped live lists are unknown rather than a claim of no holds", () => {
  const r = heldMoneyOf([{ name: "missing" }, { name: "capped", jobs: "[]", jobsMore: "1" }], { nowMs: NOW });
  assert.deepEqual(r.unknownHosts, ["missing", "capped"]);
});

test("today names the counter remainder and never turns it into held money", () => {
  const budget = { dollars: { windows: [{ ledger: "deployment", window: "day", counterMicros: 10_000_000, capMicros: 20_000_000 }] } };
  const r = spendSummaryOf({ records: [run("a", { dollars: { settledMicros: 2_000_000 } })], hosts: [], budget, nowMs: NOW });
  assert.equal(r.today.heldMicros, 0);
  assert.equal(r.today.settledMicros, 2_000_000);
  assert.equal(r.today.unattributedMicros, 8_000_000);
});

test("project windows are chosen where configured, else deployment fallback is explicit", () => {
  const budget = { dollars: { windows: [{ ledger: "deployment", window: "day", counterMicros: 9, capMicros: 20 }, { ledger: "scope", name: "project:site", window: "day", counterMicros: 3, capMicros: 10 }] } };
  assert.equal(spendSummaryOf({ records: [], hosts: [], budget, project: "site", nowMs: NOW }).today.usedMicros, 3);
  const fallback = spendSummaryOf({ records: [], hosts: [], budget, project: "other", nowMs: NOW });
  assert.equal(fallback.today.usedMicros, 9);
  assert.equal(fallback.projectFallback, true);
});

test("run-set estimate sums full cache tiers per run, excludes missing/partial ledgers and identifies plan targets", () => {
  const records = [run("a"), run("b", { flow: "review" }), run("missing", { usage: null }), run("partial", { usage: { truncated: 1, models: [{ input: 1, cost: 2 }] } })];
  const r = whatIfRuns({ records, target: { provider: "test", id: "model" }, pricing, subscriptions: [{ id: "work", provider: "test", models: ["*"] }] });
  assert.equal(r.usd, 2 * (1 + 4 + 9 + 16 + 25));
  assert.equal(r.originalUsd, 14);
  assert.equal(r.runs, 2);
  assert.equal(r.excluded, 2);
  assert.equal(r.planId, "work");
});

test("what-if cache partitions project, window and run selection over one bounded scan", async () => {
  let scans = 0;
  const records = [run("today"), run("old", { endedAt: new Date(NOW - 2 * DAY).toISOString() }), run("other", { project: "other" })];
  const reader = makeWhatIfReader({ pricing, scan: () => (scans++, records), now: () => NOW });
  const args = { model: "test/model", runs: "24h", project: "site" };
  assert.equal((await reader(args)).runSet.runs, 1);
  assert.equal((await reader({ ...args, runs: "week" })).runSet.runs, 2);
  assert.equal((await reader({ ...args, project: "other" })).runSet.runs, 1);
  assert.equal(scans, 1);
});

test("flow total uses the requested window count while the per-run median retains the scan's evidence", async () => {
  const records = [run("new"), run("old", { endedAt: new Date(NOW - 20 * DAY).toISOString() })];
  const reader = makeWhatIfReader({ pricing, scan: () => records, now: () => NOW });
  const result = (await reader({ model: "test/model", flow: "fix", range: "7d" })).result;
  assert.equal(result.windowRuns, 1);
  assert.equal(result.usd, result.perRun);
});

test("24h and Monday week starts use the injected instant", () => {
  assert.equal(costsSinceMs("24h", NOW), NOW - DAY);
  assert.equal(costsSinceMs("week", NOW), Date.parse("2026-10-26T00:00:00Z"));
});

test("tokens never enter the job soft hold band", async () => {
  const dir = tempDir("insights-token-cap-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ dailyTokenCap: 100, softHoldPct: 50 }));
  const view = await assembleBudgetView({ valkeyUrl: "redis://localhost:6379", settingsFile }, { redisFn: () => ({ get: async (key) => key.includes(":t:") ? "75" : "0", disconnect() {} }), nowMs: NOW });
  assert.equal(view.tokens.spent, 75);
  assert.equal(view.tokens.state, "ok");
});

test("an unread host registry makes both held money and its reconciliation unknown", async () => {
  const { reads } = readsFixture();
  reads.hosts = async () => ({ unreachable: "not answering" });
  reads.budget = async () => ({ dollars: { windows: [{ ledger: "deployment", window: "day", counterMicros: 100, capMicros: 200 }] } });
  const got = await assembleInsightsView({}, "7d", { pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.equal(got.spend.today.heldMicros, null);
  assert.equal(got.spend.today.unattributedMicros, null);
  assert.equal(got.spend.today.hostsUnreadable, true);
});

test("a project weekly limit does not disguise a deployment daily counter as the project's", () => {
  const budget = { dollars: { windows: [{ ledger: "deployment", window: "day", counterMicros: 9, capMicros: 20 }, { ledger: "scope", name: "project:site", window: "week", counterMicros: 3, capMicros: 10 }] } };
  const got = spendSummaryOf({ records: [], hosts: [], budget, project: "site", nowMs: NOW });
  assert.equal(got.today.usedMicros, 9);
  assert.equal(got.today.basis, "deployment");
  assert.equal(got.today.projectFallback, true);
  assert.equal(got.week.usedMicros, 3);
  assert.equal(got.week.basis, "project:site");
});

test("a counter smaller than visible records is a reconciliation mismatch, never negative held money", () => {
  const budget = { dollars: { windows: [{ ledger: "deployment", window: "day", counterMicros: 1, capMicros: 20 }] } };
  const got = spendSummaryOf({ records: [run("r", { dollars: { settledMicros: 3 } })], hosts: [], budget, nowMs: NOW });
  assert.equal(got.today.heldMicros, 0);
  assert.equal(got.today.unattributedMicros, -2);
  assert.equal(got.today.reconciliationMismatch, true);
});

test("job and token counter keys use the supplied instant, even when the wall clock differs", async () => {
  const dir = tempDir("insights-injected-budget-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, "{}");
  const keys = [];
  await assembleBudgetView({ valkeyUrl: "redis://localhost:6379", settingsFile }, { nowMs: NOW, redisFn: () => ({ get: async (key) => (keys.push(key), "0"), disconnect() {} }) });
  assert.deepEqual(keys.sort(), ["budget:2026-10-29", "budget:m:2026-10", "budget:t:2026-10-29", "budget:w:2026-10-26"].sort());
});

test("Spend daily bars are settled facts, today's live holds are separate, and cost bins use metered runs only", () => {
  const records = [run("a", { usage: null, tokens: { cost: 2, metered: true }, dollars: { settledMicros: 2_000_000 } }), run("plan", { usage: null, provider: "plan", model: "paid", tokens: { cost: 7, metered: true }, dollars: { settledMicros: 7_000_000 } }), run("yesterday", { usage: null, endedAt: new Date(NOW - DAY).toISOString(), tokens: { cost: 4, metered: true }, dollars: { settledMicros: 4_000_000 } })];
  const r = spendChartsOf({ records, sinceMs: NOW - 2 * DAY, nowMs: NOW, jobCapMicros: 10_000_000, heldMicros: 3_000_000, subscriptions: [{ provider: "plan", models: ["paid"] }] });
  assert.equal(r.daily.at(-1).settledMicros, 9_000_000);
  assert.equal(r.daily.at(-1).heldMicros, 3_000_000);
  assert.equal(r.daily.at(-2).heldMicros, 0);
  assert.equal(r.histogram.reduce((sum, b) => sum + b.runs, 0), 2);
  assert.equal(r.histogram[2].runs, 1);
  assert.equal(r.histogram[4].runs, 1);
  assert.equal(r.largestRangeMicros, 4_000_000);
});

test("a run with paid and plan ledger children never becomes metered-only through its top-level model", () => {
  const mixed = run("mixed", { provider: "paid", model: "api", usage: { models: [{ provider: "paid", model: "api", cost: 2 }, { provider: "plan", model: "prepaid", cost: 4 }] } });
  const subs = [{ provider: "plan", models: ["prepaid"] }];
  const charts = spendChartsOf({ records: [mixed], sinceMs: NOW - DAY, nowMs: NOW, jobCapMicros: 10_000_000, subscriptions: subs });
  const summary = spendSummaryOf({ records: [mixed], hosts: [], budget: {}, nowMs: NOW, subscriptions: subs });
  assert.equal(charts.meteredRangeRuns, 0);
  assert.equal(summary.average.runs, 0);
});
