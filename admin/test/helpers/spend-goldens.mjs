import assert from "node:assert/strict";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { foldCosts } from "../../src/costs.mjs";
import { buildGraphModel } from "../../src/graph-model.mjs";
import { capacityViewOf, spendSummaryOf, spendChartsOf } from "../../src/insights-assembly.mjs";
import { computeCapacity } from "@edgehero/pi-dispatch/capacity";
import { loadPageData, pagePanels, parsePageQuery, renderPage } from "../../src/console/pages.mjs";

// Real renderers and pure data folds, with the same frozen clock as the deployment goldens. No network or files.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
export const SPEND_HOSTILE_REASON = "Needs <img src=x onerror=alert(1)> & review\u202e\u0001";
const pricing = { isZeroRated: () => false, reprice: (q) => ({ usd: (q.input + q.output) / 1000, ratesVersion: "fixture" }) };
const records = () => [0, 1, 2].map((i) => ({ jobId: `gh-spend-${i}`, kind: "github", target: "acme/web#4", repo: "acme/web", project: i === 2 ? "ops" : "web", host: ["build3", "mini1", "mini2"][i], flow: i === 2 ? "review" : "fix", outcome: "completed", startedAt: iso(NOW - (i + 1) * HOUR), endedAt: iso(NOW - (i + .5) * HOUR), queuedAt: iso(NOW - (i + 1) * HOUR - (i + 1) * 10000), exitCode: 0, capacity: { slots: i + 2, memMiB: 8192, cpuCenti: 400, cpus: 4 }, size: { memMiB: 1024, cpuCenti: 100, source: "project" }, tokens: { input: 100, output: 20, total: 120, metered: true, cost: (i + 1) / 10 }, dollars: { settledMicros: (i + 1) * 100000 }, usage: { v: 1, truncated: 0, models: [{ provider: "acme", model: "model-1", calls: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total: 120, cost: (i + 1) / 10 }] } }));
const graph = () => buildGraphModel({
  triggers: { count: 2, triggers: [{ type: "cron", index: 0, id: "nightly", pattern: "0 3 * * *", folder: "/srv/work/site", flow: "fix", packages: true }, { type: "label", index: 1, any: ["pi"], forge: "github", flow: "review", disarmed: { at: iso(NOW - HOUR), jobId: "gh-spent-one" }, packages: true }] },
  schedulers: [{ key: "nightly", name: "local", pattern: "0 3 * * *", next: NOW + HOUR, overdueMs: 0 }],
  folderSkills: { "/srv/work/site": { head: "abcdef123456", truncated: false, unreachable: null, skills: [{ name: "fix", aiTrigger: true, mentions: [{ name: "notify", strong: true }] }, { name: "notify", aiTrigger: true, mentions: [] }, { name: "orphan", aiTrigger: false, mentions: [] }] } },
  overlaySkills: { skills: [], truncated: false, unreachable: null }, stagedSkills: { skills: [], unenumerable: [], truncated: false },
  cronStats: { byId: { nightly: { runs: 3, lastOutcome: "completed", lastEndedAt: iso(NOW - HOUR) } } },
  runJoin: { byIndex: { 1: { runs: 1, lastOutcome: "completed", lastEndedAt: iso(NOW - HOUR) } }, unattributed: 1 },
  chainEdges: { edges: [], refusals: { fix: 1 }, truncated: false },
  caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 }, nowMs: NOW,
});
export function spendFixture() {
  const rs = records();
  const fold = foldCosts({ records: rs, subscriptions: [], pricing, nowMs: NOW, piAiPin: "fixture", sinceMs: NOW - 7 * DAY });
  const hosts = [{ name: "build3", fpEnvelope: "fixture-digest", jobsMore: "0", jobs: [{ id: "gh-live", p: "web", at: NOW - HOUR, h: 2000000, ha: NOW - HOUR }] }];
  const budget = { day: { reserved: 3, cap: 10, state: "ok" }, week: { reserved: 7, cap: 30, state: "ok" }, month: { reserved: 12, cap: 100, state: "ok" }, softHoldPct: 80, tokens: { spent: 360, cap: 10000 }, scoped: [], dollars: { windows: [{ ledger: "deployment", name: "Deployment", window: "day", counterMicros: 2600000, capMicros: 10000000 }, { ledger: "deployment", name: "Deployment", window: "week", counterMicros: 2600000, capMicros: 50000000 }] } };
  const envelope = { window: "week", totalMicros: 50000000, floors: { web: 5000000, ops: 0 }, defaultWeights: { web: 3, ops: 1 }, delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 7 } };
  const state = { planId: "0123456789abcdef", writer: "portfolio-job", jobId: "gh-portfolio", triggerId: "pm-weekly", model: "acme/model-1", appliedAt: iso(NOW - DAY), validUntil: iso(NOW + DAY), clamped: true, allocations: { web: 35000000, ops: 15000000 }, weights: { web: 3, ops: 1 }, unallocated: 0, reasons: { web: SPEND_HOSTILE_REASON, ops: "Keep capacity for maintenance." } };
  const allocation = { window: "week", totalMicros: 50000000, floors: envelope.floors, delegation: true, digest: "fixture-digest", envelope, hosts, state, spend: { deployment: 2600000, projects: { web: 2300000, ops: 300000 } }, counts: { refusals: { "allocation-cap": 2, "envelope-mismatch": 1, "portfolio-no-envelope": 0, "portfolio-snapshot-oversize": 0 }, plans: { applied: 1 } }, log: [{ at: iso(NOW - DAY), writer: "portfolio-job", outcome: "applied", host: "build3", planId: "0123456789abcdef", weights: state.weights }, { at: iso(NOW - 2 * DAY), writer: "operator-session", outcome: "applied", host: "mini1", planId: "fedcba9876543210", weights: { web: 1, ops: 1 } }, { at: iso(NOW - 3 * DAY), writer: "operator-session", outcome: "duplicate", host: "build3", planId: "fedcba9876543210", weights: { web: 1, ops: 1 } }, { at: iso(NOW - 4 * DAY), writer: "default", outcome: "refused", host: "build3", planId: null, weights: null }] };
  return { nowMs: NOW, window: "7d", projects: [{ id: "web", name: "Web" }, { id: "ops", name: "Operations" }], fold, recent24h: fold, graph: graph(), budget, hosts, spend: { ...spendSummaryOf({ records: rs, hosts, budget, nowMs: NOW, jobCapMicros: 2000000 }), ...spendChartsOf({ records: rs, sinceMs: NOW - 7 * DAY, nowMs: NOW, jobCapMicros: 2000000, heldMicros: 2000000 }) }, allocation, meteredCostsMicros: [100000, 200000, 300000], capacity: capacityViewOf(computeCapacity({ records: rs, windowStartMs: NOW - DAY, nowMs: NOW, bucketMs: HOUR })), sizing: null };
}

export async function drawSpend(page = "insights", { role = "operator", query = "range=7d", payload = spendFixture(), whatIf = null } = {}) {
  const parsed = parsePageQuery(page, query);
  assert.ok(parsed.query, parsed.refusal);
  const data = await loadPageData(page, parsed.query, { now: () => NOW, insights: async () => payload, pricedModels: () => ["acme/model-1", "acme/model-2"], whatIf: async () => whatIf, fleet: { parkedCount: async () => 0 } }, { role });
  const ctx = { query: parsed.query, session: { name: role === "operator" ? "ops" : "watcher", role }, data, readOnly: false, theme: null, maxStreams: 4 };
  const out = await renderPage(page, ctx);
  assert.equal(out.status, 200);
  for (const { id, html } of await pagePanels(page, ctx)) assert.ok(String(out.html).includes(`id="${id}" data-panel>${html}</`), `${page}: panel ${id} matches its renderer`);
  return String(out.html);
}
const allocationState = (over) => { const p = spendFixture(); return { ...p, allocation: { ...p.allocation, ...over } }; };
function recordMoneyState(kind) {
  const p = spendFixture();
  const base = records()[0];
  const paid = { ...base, endedAt: iso(NOW - 1000), dollars: { basis: "unreserved", settledMicros: 0 }, tokens: { ...base.tokens, cost: 7, metered: true }, usage: { models: [{ ...base.usage.models[0], cost: 7 }] } };
  const unknown = { ...base, jobId: "gh-unknown-cost", endedAt: iso(NOW - 1000), dollars: { basis: "unreserved", settledMicros: 0 }, tokens: null, usage: null };
  const rs = kind === "unknown" ? [unknown] : kind === "partial" ? [paid, unknown] : [paid];
  const budget = kind === "partial" ? p.budget : {};
  const currentFold = foldCosts({ records: rs, subscriptions: [], pricing, nowMs: NOW, piAiPin: "fixture", sinceMs: NOW - 7 * DAY });
  return { ...p, budget, fold: currentFold, recent24h: currentFold, spend: { ...spendSummaryOf({ records: rs, hosts: [], budget, nowMs: NOW, jobCapMicros: 2000000 }), ...spendChartsOf({ records: rs, sinceMs: NOW - 7 * DAY, nowMs: NOW, jobCapMicros: 2000000, heldMicros: 0 }) } };
}
const states = {
  "spend-no-dollar-window.viewer": () => drawSpend("insights", { role: "viewer", payload: recordMoneyState("paid") }),
  "spend-partial-money.viewer": () => drawSpend("insights", { role: "viewer", payload: recordMoneyState("partial") }),
  "spend-unknown-money.viewer": () => drawSpend("insights", { role: "viewer", payload: recordMoneyState("unknown") }),
  "spend-plan-model.viewer": () => { const p = spendFixture(); p.recent24h.byModel.push({ provider: "plan-provider", model: "plan-model", runs: 2, tokens: 300, cost: { usd: 0, class: "plan", planId: "work", floor: false } }); p.triggersByModel = { "plan-provider/plan-model": ["row 2"] }; return drawSpend("insights", { role: "viewer", payload: p }); },
  "spend-whatif-runs.viewer": () => drawSpend("insights", { role: "viewer", query: "range=7d&whatif=acme/model-2&runs=24h", whatIf: { runSet: { class: "estimated", usd: .3, originalUsd: .6, runs: 3, excluded: 1, coverage: .75, ratesVersion: "fixture", planId: "work" } } }),
  "spend-whatif-flow.viewer": () => drawSpend("insights-breakdown", { role: "viewer", query: "range=7d&whatif=acme/model-2&flow=fix", whatIf: { result: { class: "estimated", usd: .4, perRun: .2, windowRuns: 2, coverage: 1, excluded: 0, ratesVersion: "fixture" } } }),
  "spend-populated.operator": () => drawSpend(),
  "spend-populated.viewer": () => drawSpend("insights", { role: "viewer", query: "range=7d&paths=full" }),
  "spend-costs-unreadable.viewer": () => drawSpend("insights", { role: "viewer", payload: { ...spendFixture(), fold: null, spend: { ...spendFixture().spend, daily: null } } }),
  "spend-unknown-holds.operator": () => { const p = spendFixture(); p.spend.today.unknownHosts = ["old-worker"]; return drawSpend("insights", { payload: p }); },
  "spend-counters-unreadable.operator": () => drawSpend("insights", { payload: { ...spendFixture(), budget: { unreachable: "unavailable", settingsInvalid: true } } }),
  "spend-split.operator": () => drawSpend("insights-budget-split"),
  "spend-split.viewer": () => drawSpend("insights-budget-split", { role: "viewer" }),
  "spend-split-no-envelope.viewer": () => drawSpend("insights-budget-split", { role: "viewer", payload: allocationState({ unset: true }) }),
  "spend-split-invalid.operator": () => drawSpend("insights-budget-split", { payload: allocationState({ problem: "invalid envelope fields" }) }),
  "spend-split-no-plan.viewer": () => drawSpend("insights-budget-split", { role: "viewer", payload: allocationState({ state: null }) }),
  "spend-split-mismatch.operator": () => drawSpend("insights-budget-split", { payload: allocationState({ mismatch: true }) }),
  "spend-split-unreachable.viewer": () => drawSpend("insights-budget-split", { role: "viewer", payload: allocationState({ unreachable: "unavailable" }) }),
  "spend-split-newer.viewer": () => drawSpend("insights-budget-split", { role: "viewer", payload: allocationState({ stateProblem: "newer" }) }),
  "spend-split-outside-edit.operator": () => drawSpend("insights-budget-split", { payload: allocationState({ outsideEdit: { at: "10-08 15:00", digest: "01234567", split: "89abcdef" } }) }),
  "spend-capacity.viewer": () => drawSpend("insights-capacity", { role: "viewer", query: "range=24h" }),
  "spend-capacity-no-time.viewer": () => drawSpend("insights-capacity", { role: "viewer", query: "range=mtd", payload: { ...spendFixture(), capacity: { noTime: true, fromMs: NOW } } }),
  "spend-capacity-unreadable.viewer": () => drawSpend("insights-capacity", { role: "viewer", payload: { ...spendFixture(), capacity: { unreachable: "unavailable" } } }),
  "spend-capacity-truncated.viewer": () => { const p = spendFixture(); p.capacity.truncated = true; p.capacity.fleet.incomplete = true; for (const h of p.capacity.hosts) h.truncated = true; return drawSpend("insights-capacity", { role: "viewer", payload: p }); },
  "spend-breakdown.viewer": () => drawSpend("insights-breakdown", { role: "viewer" }),
  "spend-breakdown-unreadable.viewer": () => drawSpend("insights-breakdown", { role: "viewer", payload: { ...spendFixture(), fold: null } }),
  "spend-breakdown-empty.viewer": () => { const p = spendFixture(); p.fold = foldCosts({ records: [], subscriptions: [], pricing, nowMs: NOW, sinceMs: NOW - 7 * DAY }); return drawSpend("insights-breakdown", { role: "viewer", payload: p }); },
  "spend-whatif-unknown.viewer": () => drawSpend("insights-breakdown", { role: "viewer", query: "range=7d&whatif=acme/missing&flow=fix", whatIf: { unknown: true, near: ["acme/model-1"] } }),
  "spend-whatif-seeded.viewer": () => drawSpend("insights-breakdown", { role: "viewer", query: "range=7d&whatif=acme/model-1&flow=fix", whatIf: { result: { class: "seeded", low: .5, high: 5, note: "unmeasured (OQ-002)" } } }),
  "spend-flows-map.viewer": () => drawSpend("insights-flows", { role: "viewer" }),
  "spend-flows-list.viewer": () => drawSpend("insights-flows", { role: "viewer", query: "range=7d&view=list" }),
  "spend-flows-selected.viewer": () => drawSpend("insights-flows", { role: "viewer", query: "range=7d&select=0" }),
  "spend-flows-spent.viewer": () => drawSpend("insights-flows", { role: "viewer", query: "range=7d&select=1" }),
  "spend-flows-invalid.viewer": () => { const p = spendFixture(); p.graph = buildGraphModel({ triggers: { invalid: "triggers file is invalid" }, nowMs: NOW }); return drawSpend("insights-flows", { role: "viewer", payload: p }); },
  "spend-flows-missing.viewer": () => { const p = spendFixture(); p.graph = buildGraphModel({ triggers: { missing: true }, nowMs: NOW }); return drawSpend("insights-flows", { role: "viewer", payload: p }); },
};
export const SPEND_DRAW = Object.freeze(states);
export const SPEND_PANEL_STATES = Object.freeze(Object.keys(states));
