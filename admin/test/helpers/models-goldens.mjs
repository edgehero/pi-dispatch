import { consoleSubscriptionFixture } from "./subscription-auth-fixture.mjs";
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
async function draw({ change = () => {}, role = "operator", readOnly = false, data = {} } = {}) {
  const m = consoleModelsFixture(NOW); change(m);
  return (await renderPage("models", { session: { name: role === "operator" ? "ops" : "watcher", role }, data: { now: NOW, models: m, ...data }, query: {}, readOnly })).html;
}
export const MODELS_DRAW = Object.freeze({
  "models-subscription.operator": () => draw({ change: m => { m.subscriptionAuth = consoleSubscriptionFixture(NOW); } }),
  "models-subscription.viewer": () => draw({ role: "viewer", change: m => { m.subscriptionAuth = consoleSubscriptionFixture(NOW); } }),
  "models-subscription-stale.operator": () => draw({ change: m => { m.subscriptionAuth = consoleSubscriptionFixture(NOW, v => { v.connections[0].quota.observedAt = NOW - 600_000; }); } }),
  "models-subscription-unknown-reset.operator": () => draw({ change: m => { m.subscriptionAuth = consoleSubscriptionFixture(NOW, v => { const q = v.connections[0].quota; q.blockedUnknownReset = true; q.until = null; q.trialAvailable = true; q.windows[0].resetAt = null; }); } }),
  "models-subscription-unknown.viewer": () => draw({ role: "viewer", change: m => { m.subscriptionAuth = consoleSubscriptionFixture(NOW, v => { v.connections[0].quota = null; }); } }),
  // Issue #1046: a ChatGPT connection reads no usage, so the card offers no usage refresh and says how its quota is known.
  "models-subscription-chatgpt.operator": () => draw({ change: m => { m.subscriptionAuth = consoleSubscriptionFixture(NOW, v => { Object.assign(v.connections[0], { id: "chatgpt-main", provider: "openai", adapter: "openai-chatgpt" }); Object.assign(v.connections[0].quota, { blockedUnknownReset: true, until: null, trialAvailable: false, retestAt: NOW + 6 * 3_600_000, trialClaimedAt: null }); v.connections[0].quota.windows = [{ id: "provider-error", window: "other", scope: "quota", usedPercent: null, resetAt: null, state: "exhausted" }]; }); } }),
  "models-random.operator": () => draw({ change: m => { m.randomPools = [{ index: 2, number: 3, candidates: [{ ref: "anthropic/claude-haiku-4-5", state: "unknown" }, { ref: "openai/gpt-5", state: "cooling-down" }] }]; m.recentRandom = [{ jobId: "gh-random-initial", provider: "anthropic", model: "claude-haiku-4-5", modelWhy: "random" }, { jobId: "gh-random", provider: "openai", model: "gpt-5", modelWhy: "random-subscription-limit" }]; } }),
  // Issue #996: a weighted pool beside one without weights, each weighted candidate with its share of the whole pool.
  "models-random-weighted.operator": () => draw({ change: m => { m.randomPools = [{ index: 2, number: 3, weighted: true, candidates: [{ ref: "anthropic/claude-haiku-4-5", state: "unknown", share: 75 }, { ref: "openai/gpt-5", state: "cooling-down", share: 25 }] }, { index: 3, number: 4, candidates: [{ ref: "anthropic/claude-sonnet-4-5", state: "unknown" }, { ref: "openai/gpt-5", state: "cooling-down" }] }]; } }),
  "models-random-blocked.operator": () => draw({ change: m => { m.randomPools = [{ index: 2, number: 3, candidates: [{ ref: "anthropic/claude-haiku-4-5", state: "cooling-down" }, { ref: "openai/gpt-5", state: "window-full" }] }]; m.waiting = [{ jobId: "gh-random-wait", reason: "subscription-quota", resetAt: NOW + 1_800_000 }, { jobId: "gh-random-unknown-reset", reason: "subscription-quota" }]; m.subscriptionAuth = consoleSubscriptionFixture(NOW); } }),
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
  // Issue #962: the page's snapshot could not be read. The roles and models are the files'; the waiting jobs and the
  // doctor proposals are not known, and no list says "none". One role: a models golden is read at every width.
  "models-no-snapshot.viewer": () => draw({ role: "viewer", data: { snapshot: null, readFailed: true }, change: (m) => { m.waiting = []; m.proposals = []; m.cooldowns = []; m.waitingUnread = true; m.proposalsUnread = true; m.cooldownsUnread = true; for (const r of m.roles) if (r.next.kind !== "direct") r.next = { kind: "unknown", model: null, reason: "cooldowns-unavailable" }; for (const row of m.models) row.state = "unknown"; m.banners = [{ kind: "cooldowns-unavailable", reason: "model-cooldown", label: "Model cooldowns could not be read. Current failover routing is unknown.", fix: "Check Valkey and reload; no model was selected." }]; m.coverage.notes = ["Waiting jobs could not be read; an empty list is not proof that none wait.", "No published doctor proposal evidence is available. Reload after doctor publishes on a host."]; } }),
  "models-long-names.operator": () => draw({ change: (m) => { m.roles[0].role = "a".repeat(32); m.roles[0].model = `${"p".repeat(64)}/${"m".repeat(64)}`; m.roles[0].fallbackModels[0].ref = `${"f".repeat(64)}/${"n".repeat(64)}`; } }),
});
export const MODELS_PANEL_STATES = Object.freeze(Object.keys(MODELS_DRAW));
