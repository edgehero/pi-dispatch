import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleInsightsView, heldMoneyOf, spendSummaryOf, spendChartsOf, recordSpendOf, assembleBudgetView, assembleGraph } from "../src/insights-assembly.mjs";
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

test("a paid $7 run with unreserved/0 remains $7 in Today and the daily chart without dollar windows", () => {
  const paid = run("unreserved-paid", { dollars: { reservedMicros: 0, settledMicros: 0, basis: "unreserved" } });
  const summary = spendSummaryOf({ records: [paid], hosts: [], budget: {}, nowMs: NOW, pricing });
  const day = spendChartsOf({ records: [paid], sinceMs: NOW - DAY, nowMs: NOW, jobCapMicros: null, pricing }).daily.at(-1);
  assert.equal(summary.today.settledMicros, 7_000_000);
  assert.equal(summary.today.ledgerMicros, 0);
  assert.equal(summary.today.usedMicros, 7_000_000);
  assert.equal(summary.today.counterConfigured, false);
  assert.equal(summary.today.usedSource, "records");
  assert.equal(day.settledMicros, 7_000_000);
  assert.equal(day.settledFloor, false);
});

test("an unpriced run without a dollar ledger is unknown, not an exact empty day", () => {
  const unknown = run("unknown", { tokens: null, usage: null });
  const summary = spendSummaryOf({ records: [unknown], hosts: [], budget: {}, nowMs: NOW });
  const day = spendChartsOf({ records: [unknown], sinceMs: NOW - DAY, nowMs: NOW, jobCapMicros: null }).daily.at(-1);
  for (const result of [summary.today, day]) {
    assert.equal(result.settledMicros, null);
    assert.equal(result.settledFloor, true);
    assert.equal(result.unpriced, 1);
    assert.equal(result.ledgerMicros, null);
  }
  assert.equal(summary.today.usedMicros, null);
});

test("legacy recorded prices are retained and mixed known/unknown spend stays a floor", () => {
  const legacy = run("legacy", { usage: null, tokens: { cost: 7, metered: true } });
  const unknown = run("unknown", { tokens: null, usage: null });
  const known = recordSpendOf(legacy);
  assert.equal(known.micros, 7_000_000);
  assert.equal(known.floor, false);
  const sum = spendSummaryOf({ records: [legacy, unknown], hosts: [], budget: {}, nowMs: NOW });
  assert.equal(sum.today.settledMicros, 7_000_000);
  assert.equal(sum.today.settledFloor, true);
  assert.equal(sum.today.usedFloor, true);
  assert.equal(sum.today.unpriced, 1);
});

test("reserved settlements, refunds and floors keep the ledger semantics while unreserved prices do not enter reconciliation", () => {
  const ledger = run("settled", { dollars: { reservedMicros: 9_000_000, settledMicros: 3_000_000, basis: "metered" } });
  const refunded = run("refunded", { dollars: { reservedMicros: 9_000_000, settledMicros: 0, basis: "refunded" } });
  const floor = run("floor", { dollars: { reservedMicros: 9_000_000, settledMicros: 9_000_000, basis: "floor" } });
  const unreserved = run("unreserved", { dollars: { reservedMicros: 0, settledMicros: 0, basis: "unreserved" } });
  const budget = { dollars: { windows: [{ ledger: "deployment", window: "day", counterMicros: 12_000_000, capMicros: 20_000_000 }] } };
  const today = spendSummaryOf({ records: [ledger, refunded, floor, unreserved], hosts: [], budget, nowMs: NOW }).today;
  assert.equal(today.usedMicros, 12_000_000);
  assert.equal(today.settledMicros, 19_000_000);
  assert.equal(today.ledgerMicros, 12_000_000);
  assert.equal(today.unattributedMicros, 0);
  assert.equal(today.settledFloor, true);
  assert.equal(today.counterAvailable, true);
  assert.equal(today.usedSource, "counter");
});

test("a configured but unread daily counter stays unknown despite readable priced records", () => {
  const budget = { dollars: { windows: [{ ledger: "deployment", window: "day", counterMicros: null, capMicros: 20_000_000 }] } };
  const today = spendSummaryOf({ records: [run("paid", { dollars: { settledMicros: 0, basis: "unreserved" } })], hosts: [], budget, nowMs: NOW }).today;
  assert.equal(today.settledMicros, 7_000_000);
  assert.equal(today.usedMicros, null);
  assert.equal(today.counterConfigured, true);
  assert.equal(today.counterAvailable, false);
  assert.equal(today.usedSource, "unknown-counter");
});

test("recorded plan API-equivalent spend is retained, and old zero-price plans need an explicit baseline", () => {
  const subs = [{ id: "work", provider: "plan", models: ["paid"], counterfactualModel: { provider: "test", id: "api" } }];
  const paidPlan = run("plan-api", { provider: "plan", model: "paid", usage: { models: [{ provider: "plan", model: "paid", input: 1, cost: 7 }] }, dollars: { settledMicros: 0, basis: "unreserved" } });
  assert.equal(recordSpendOf(paidPlan, { subscriptions: subs, pricing }).micros, 7_000_000);
  const oldPlan = run("plan-old", { provider: "plan", model: "paid", tokens: { cost: 0, metered: true }, usage: { models: [{ provider: "plan", model: "paid", input: 1, cost: 0 }] }, dollars: { settledMicros: 0, basis: "unreserved" } });
  const estimated = recordSpendOf(oldPlan, { subscriptions: subs, pricing });
  assert.equal(estimated.micros, 1_000_000);
  assert.equal(estimated.estimated, true);
  assert.equal(recordSpendOf(oldPlan, { subscriptions: [{ ...subs[0], counterfactualModel: null }], pricing }).micros, null);
});

test("a price floor is sticky for uncapped fallback meter records and their chart totals", () => {
  const partial = run("partial", { usage: null, tokens: { cost: 7, metered: false }, dollars: { settledMicros: 0, basis: "unreserved" } });
  const day = spendChartsOf({ records: [partial], sinceMs: NOW - DAY, nowMs: NOW, jobCapMicros: null }).daily.at(-1);
  assert.equal(day.settledMicros, 7_000_000);
  assert.equal(day.settledFloor, true);
  assert.equal(day.settledEstimated, true);
});

test("project charts use that project's holds even when Today's headline falls back to deployment windows", async () => {
  const { reads } = readsFixture();
  reads.hosts = async () => ({ hosts: [{ name: "worker", jobsMore: "0", jobs: JSON.stringify([{ id: "site-job", p: "site", at: NOW - 1000, ha: NOW - 1000, h: 2_000_000 }, { id: "other-job", p: "other", at: NOW - 1000, ha: NOW - 1000, h: 3_000_000 }]) }] });
  reads.budget = async () => ({ dollars: { windows: [{ ledger: "deployment", window: "day", capMicros: 10_000_000, counterMicros: 5_000_000 }] } });
  const data = await assembleInsightsView({}, "7d", { project: "site", pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.equal(data.spend.today.basis, "deployment");
  assert.equal(data.spend.today.heldMicros, 5_000_000);
  assert.equal(data.spend.daily.at(-1).heldMicros, 2_000_000);
});


test("a real loader-invalid trigger file draws only the Flows error and performs no scheduler read", async () => {
  const dir = tempDir("insights-invalid-graph-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "not-a-trigger" }, run: { flow: "fix" } }] }));
  const graph = await assembleGraph({ triggersPath }, { pricing, nowMs: NOW, readSchedulersFn: () => { throw new Error("an invalid graph must not dial the scheduler"); } });
  const { renderPage, parsePageQuery } = await import("../src/console/pages.mjs");
  const out = await renderPage("insights-flows", { query: parsePageQuery("insights-flows", "").query, session: { role: "viewer", name: "watcher" }, data: { now: NOW, insights: { graph } } });
  const text = String(out.html);
  assert.match(text, /on.type must be one of/);
  assert.match(text, /Nothing is drawn until it loads/);
  assert.doesNotMatch(text, /id="graph"/);
  assert.ok(!text.includes(dir));
});
