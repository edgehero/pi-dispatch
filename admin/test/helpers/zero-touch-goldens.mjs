import { NOW } from "../../../launch/fixture-deployment.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../../src/console/pages.mjs";

const DAY = 86400000;
const KEYS = ["question-answer", "approval-decision", "rerun", "config-fix", "steer", "cancel"];
const cs = (values) => KEYS.map((cause, i) => ({ cause, count: values[i] ?? 0 }));
const digest = (i) => i.toString(16).padStart(64, "0");
/** Same workload and totals as the published card; all content here is invented fixture data. */
export function zeroTouchFixture(now = NOW) {
  const definitions = [
    ["web", 58, 9, 24, 2, [5, 1, 2, 0, 1, 0]], ["api", 64, 13, 33, 0, [9, 2, 2, 0, 0, 0]],
    ["billing", 41, 13, 28, 1, [2, 2, 3, 5, 1, 0]], ["ops", 34, 1, 5, 9, [0, 0, 0, 0, 0, 1]], ["shop", 17, 2, 21, 4, [1, 0, 0, 0, 1, 0]],
  ];
  const projects = definitions.map(([project, runs, touched, previousRate, streakDays, values], i) => ({ project, name: project, runs, touched, rate: touched / runs * 100, previousRate, deltaPoints: Math.round(touched / runs * 100) - previousRate, streakDays, zeroTouch: false, waitingNow: project === "api" ? 1 : 0, topCause: KEYS[values.indexOf(Math.max(...values))], causes: cs(values), touchedRunIds: [`gh-fixture-${i}`], repositories: [{ scopeId: digest(i + 1), name: `acme/${project}`, target: `acme/${project}`, project, runs, touched, rate: touched / runs * 100, previousRate, deltaPoints: Math.round(touched / runs * 100) - previousRate, streakDays, waitingNow: project === "api" ? 1 : 0, topCause: KEYS[values.indexOf(Math.max(...values))], causes: cs(values), touchedRunIds: [`gh-fixture-${i}`] }] }));
  projects[1].repositories = [
    { scopeId: digest(2), name: "acme/api", target: "acme/api", project: "api", runs: 39, touched: 12, rate: 12 / 39 * 100, previousRate: 42, deltaPoints: -11, streakDays: 0, waitingNow: 1, topCause: "question-answer", causes: cs([9, 2, 1, 0, 0, 0]) },
    { scopeId: digest(22), name: "acme/api-docs", target: "acme/api-docs", project: "api", runs: 25, touched: 1, rate: 4, previousRate: 9, deltaPoints: -5, streakDays: 12, waitingNow: 0, topCause: "rerun", causes: cs([0, 0, 1, 0, 0, 0]) },
  ];
  return { nowMs: now, windowDays: 30, coverage: { fromMs: now - 90 * DAY, requestedFromMs: now - 30 * DAY, partial: false, reasons: [] }, totals: { runs: 214, touched: 38, rate: 38 / 214 * 100, stopped: 2, waitingHours: 41, medianWaitMs: 34 * 60000, pending: 1, waitingNow: [{ runId: "gh-2f6a", parkedAt: now - 26 * 60000 }], draftAnswers: 0, deltaPoints: -6 },
    trend: [31, 30, 28, 24, 23, 21, 19, 18].map((rate, i) => ({ atMs: now - (7 - i) * 7 * DAY, rate, runs: 214, touched: Math.round(rate / 100 * 214), partial: false })), projects, causes: cs([17, 5, 7, 5, 3, 1]), touchedRunIds: projects.flatMap((p) => p.touchedRunIds),
    grouping: { enabled: true, pending: 0, unassigned: 1, state: "ready" }, ungroupedRunIds: ["gh-ungrouped"], groups: [
      { id: "a".repeat(31) + "1", name: "Test command", repo: "acme/api", project: "api", count: 6, runIds: ["gh-71c2", "gh-6a0e", "gh-5d19"], status: "open", triggerIndex: 2 },
      { id: "a".repeat(31) + "2", name: "Rate limit scope", repo: "acme/api", project: "api", count: 3, runIds: ["gh-2f6a", "gh-48b0", "gh-3e77"], status: "open", triggerIndex: 6 },
      { id: "a".repeat(31) + "3", name: null, repo: "acme/web", project: "web", count: 2, runIds: ["gh-1b9d", "gh-0c4e"], status: "open", triggerIndex: 1 },
      { id: "a".repeat(31) + "4", name: "Package manager", repo: "acme/web", project: "web", count: 5, runIds: ["gh-09fa", "gh-7f21"], status: "fixed", fixedAt: now - 14 * DAY, triggerIndex: 2 },
    ], fixes: [{ id: "b".repeat(31) + "1", at: now - 14 * DAY, kind: "instructions", groupId: "a".repeat(31) + "4", triggerIndex: 2, beforeCount: 5, afterCount: 0, spanMs: 14 * DAY, partial: false, subsequentRuns: 20, status: "improved" }, { id: "b".repeat(31) + "2", at: now - 9 * DAY, kind: "config", reason: "secret-unresolved", triggerIndex: 2, beforeCount: 4, afterCount: 0, spanMs: 9 * DAY, partial: false, subsequentRuns: 18, status: "improved" }] };
}
async function draw({ role = "operator", readOnly = false, change = () => {}, raw = undefined, query = "days=30" } = {}) {
  const parsed = parsePageQuery("zero-touch", query);
  const report = raw === undefined ? zeroTouchFixture(NOW) : raw;
  if (report) change(report);
  const data = await loadPageData("zero-touch", parsed.query, { now: () => NOW, zeroTouch: async () => report, fleet: { parkedCount: async () => 1 } }, { role, readOnly });
  const out = await renderPage("zero-touch", { query: parsed.query, data, session: { role, name: role === "operator" ? "ops" : "watcher" }, readOnly });
  return String(out.html);
}
export const ZERO_TOUCH_DRAW = Object.freeze({
  "zero-touch-populated.operator": () => draw(),
  "zero-touch-populated.viewer": () => draw({ role: "viewer" }),
  "zero-touch-readonly.operator": () => draw({ readOnly: true }),
  "zero-touch-empty.viewer": () => draw({ role: "viewer", change: (r) => { r.projects = []; r.groups = []; r.fixes = []; r.totals = { runs: 0, touched: 0, rate: null, waitingHours: 0 }; r.trend = []; } }),
  "zero-touch-unavailable.operator": () => draw({ raw: null }),
  "zero-touch-partial.operator": () => draw({ query: "days=90", change: (r) => { r.windowDays = 90; r.coverage = { fromMs: NOW - 20 * DAY, partial: true, reasons: ["touch-tracking-started"] }; r.totals.deltaPoints = null; r.trend = r.trend.map((v, i) => ({ ...v, partial: i < 5 })); } }),
  "zero-touch-observing.operator": () => draw({ change: (r) => { r.grouping = { enabled: true, state: "pending", pending: 1, unassigned: 2 }; r.groups[0].name = null; r.fixes[0].partial = true; r.fixes[0].subsequentRuns = 0; } }),
  "zero-touch-missing-sources.operator": () => draw({ change: (r) => { r.grouping.state = "unavailable"; r.fixesPartial = true; r.groups = []; r.fixes = []; } }),
  "zero-touch-grouping-errors.operator": () => draw({ change: (r) => { r.grouping.state = "partial"; r.grouping.sources = ["source-expired", "source-unavailable", "source-oversize", "candidates-expired", "group-limit", "stale", "refused", "failed"].map((status, i) => ({ runId: `gh-group-${i}`, status })); } }),
  "zero-touch-long-names.operator": () => draw({ change: (r) => { r.projects[0].name = "project-with-a-long-name"; r.projects[0].repositories[0].name = `acme/${"repository-with-a-long-name-".repeat(5)}`; r.groups[0].name = "A human-written group name that uses all the available room in a narrow layout"; } }),
});
export const ZERO_TOUCH_PANEL_STATES = Object.freeze(Object.keys(ZERO_TOUCH_DRAW));
