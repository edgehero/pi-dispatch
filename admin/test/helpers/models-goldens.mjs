/** #773 exceptional states use production page renderers, with an injected clock and operational facts. */
import { renderPage } from "../../src/console/pages.mjs";
import { NOW } from "../../../launch/fixture-deployment.mjs";
export function consoleModelsFixture(now) {
  if (!Number.isFinite(now)) throw new TypeError("consoleModelsFixture needs its injected clock");
  const primary = "anthropic/claude-sonnet-4-5", fallback = "openai/gpt-5";
  return {
    now, state: "ready", partial: false, scopes: ["default", "web"], banners: [],
    roles: [
      { scope: "default", role: "planner", model: primary, fallbackModels: [{ ref: fallback, known: true, priced: true }], triggers: [{ index: 0, number: 1, flow: "fix" }, { index: 2, number: 3, flow: "triage", project: "api" }], next: { kind: "candidate", model: fallback } },
      { scope: "default", role: "editor", model: primary, fallbackModels: [], triggers: [{ index: 1, number: 2, flow: "frontend-fix", project: "web" }], next: { kind: "direct", model: primary } },
      { scope: "web", role: "planner", model: fallback, fallbackModels: [{ ref: "example/unpriced", known: true, priced: false, skipped: true }], triggers: [{ index: 3, number: 4, flow: "review", project: "web" }], next: { kind: "candidate", model: fallback } },
    ],
    cooldowns: [{ ref: primary, kind: "rate-limited", until: now + 13 * 60000 }],
    waiting: [{ jobId: "gh-77c1", why: "model-cooldown" }, { jobId: "gh-80e1", why: "model-window" }],
    recentFallbacks: [{ jobId: "gh-c41f", provider: "openai", model: "gpt-5", modelRole: "planner", modelWhy: "fallback-cooldown" }],
    models: [{ ref: primary, provider: "anthropic", model: "claude-sonnet-4-5", known: true, priced: true, state: "cooldown", windows: [{ scope: `model:${primary}`, window: "week", spentMicros: 32460000, capMicros: 80000000 }] }, { ref: fallback, provider: "openai", model: "gpt-5", known: true, priced: true, state: "configured", windows: [] }, { ref: "example/unpriced", provider: "example", model: "unpriced", known: true, priced: false, state: "configured", windows: [] }],
    proposals: [{ id: "model-proposal.default.planner.newer", host: "mini1", at: now - 5 * 60000, stale: false, kind: "newer-sibling", scope: "default", role: "planner", model: primary, candidate: fallback, label: "A newer model is available for the planner role.", fix: "Compare the candidate with a capped canary before changing the role." }],
    canaries: [{ id: "sample", digest: "a".repeat(64), role: "planner", candidate: fallback, flow: "fix", count: 2, scopes: ["default", "web"], partial: false, suggestedCapUsd: 2, whatIf: "/insights/breakdown?whatif=openai%2Fgpt-5&flow=fix", candidateStats: { runs: 2, completed: 1, costPerRun: .06, averageTurns: 11.2, averageTokens: 131900, knownCosts: 2, knownTurns: 2, knownTokens: 2 }, sourceStats: { runs: 2, completed: 2, costPerRun: .19, averageTurns: 9.4, averageTokens: 118400, knownCosts: 2, knownTurns: 2, knownTokens: 2 }, rows: [{ jobId: "canary-c41f", sourceJobId: "gh-c41f", candidate: { outcome: "completed", model: fallback }, source: { outcome: "completed", model: primary } }, { jobId: "canary-c42f", sourceJobId: "gh-c42f", candidate: { outcome: "failed", model: fallback }, source: { outcome: "completed", model: primary } }] }],
    coverage: { complete: false, partial: true, records: 24, days: 30, notes: [] },
  };
}
async function draw({ change = () => {}, role = "operator", readOnly = false } = {}) {
  const m = consoleModelsFixture(NOW); change(m);
  return (await renderPage("models", { session: { name: role === "operator" ? "ops" : "watcher", role }, data: { now: NOW, models: m }, query: {}, readOnly })).html;
}
export const MODELS_DRAW = Object.freeze({
  "models-populated.operator": () => draw(),
  "models-populated.viewer": () => draw({ role: "viewer" }),
  "models-readonly.operator": () => draw({ readOnly: true }),
  "models-radius.operator": () => draw({ change: (m) => { m.banners = [{ title: "A capped Radius model cannot start", label: "Doctor on mini1: Radius cannot be bounded by a per-job dollar cap.", fix: "Choose a priced, boundable model for this capped role or trigger.", triggers: [0] }]; } }),
  "models-undeclared.operator": () => draw({ change: (m) => { m.banners = [{ title: "Undeclared model role", label: "A trigger names a role no scope declares. Pickup refuses it.", fix: "Declare the role or change the trigger.", triggers: [2] }]; } }),
  "models-provider-clash.operator": () => draw({ change: (m) => { m.banners = [{ title: "Provider and role disagree", label: "A trigger's provider differs from its role model. Pickup refuses it.", fix: "Align the trigger provider with the role model.", triggers: [1] }]; } }),
  "models-fallback-clash.operator": () => draw({ change: (m) => { m.banners = [{ title: "Two fallback lists", label: "A trigger and its role both declare fallbacks. Pickup refuses it.", fix: "Keep a fallback list on one side only.", triggers: [3] }]; } }),
  "models-partial-canary.operator": () => draw({ change: (m) => { const c = m.canaries[0]; c.partial = true; c.rows[1].source = null; c.sourceStats = { runs: 1, completed: 1, costPerRun: null, averageTurns: null, averageTokens: null, knownCosts: 0, knownTurns: 0, knownTokens: 0 }; } }),
  "models-empty.viewer": () => draw({ role: "viewer", change: (m) => { for (const k of ["roles", "models", "cooldowns", "proposals", "canaries", "waiting", "recentFallbacks"]) m[k] = []; m.coverage.records = 0; } }),
  "models-unreadable.viewer": () => draw({ role: "viewer", change: (m) => { m.state = "unreadable"; m.partial = true; for (const k of ["roles", "models", "cooldowns", "proposals", "canaries", "waiting", "recentFallbacks"]) m[k] = []; } }),
  "models-long-names.operator": () => draw({ change: (m) => { m.roles[0].role = "a".repeat(32); m.roles[0].model = `${"p".repeat(64)}/${"m".repeat(64)}`; m.roles[0].fallbackModels[0].ref = `${"f".repeat(64)}/${"n".repeat(64)}`; } }),
});
export const MODELS_PANEL_STATES = Object.freeze(Object.keys(MODELS_DRAW));
