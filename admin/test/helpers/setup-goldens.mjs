/** #774 exceptional setup states, rendered through the production route and role projection. */
import { loadPageData, renderPage } from "../../src/console/pages.mjs";
import { SETUP_ACTIONS } from "../../src/setup-view.mjs";
export const SETUP_AT = Date.UTC(2026, 10, 1, 12);
export function setupFixture() {
  return { readAt: SETUP_AT, runs: [], runsDay: { runs: [], partial: false }, hostBudgets: [], queue: { workers: 0 }, triggers: { triggers: [] }, doctor: { hosts: [{ name: "build3", ageMs: 60_000, every: 24, checks: [{ id: "egress.proxy", level: "fail" }, { id: "provider.key", level: "fail" }] }] } };
}
export function setupAvailable() {
  return { enabled: true, actions: [...SETUP_ACTIONS], providerKey: "ANTHROPIC_API_KEY", allowlistCount: 12, progress: [] };
}
export async function setupGolden({ role = "operator", readOnly = false, state = "starting" } = {}) {
  const snapshot = state === "unreadable" ? null : setupFixture();
  const facts = setupAvailable();
  if (["starting", "timeout", "unknown"].includes(state)) facts.progress = [{ step: "worker", state: state === "timeout" ? "timeout" : state, stage: state === "starting" ? "waiting-heartbeat" : "complete", atMs: SETUP_AT - 8000, ...(state === "unknown" ? { reason: "readback-unavailable" } : {}) }];
  if (state === "no-grant") { facts.enabled = false; facts.reason = "unsafe-entry"; }
  if (state === "partial-doctor") { snapshot.doctor.partial = true; snapshot.doctor.hosts[0].checks.forEach(check => { check.level = "ok"; }); }
  if (state === "ready") {
    snapshot.hostBudgets = [{ name: "build3", ttlAgeMs: 1000 }];
    snapshot.triggers.triggers = [{ type: "cron" }];
    snapshot.doctor.hosts[0].checks.forEach(check => { check.level = "ok"; });
  }
  const data = await loadPageData("setup", {}, { now: () => SETUP_AT, deployment: { folder: "pi-dispatch" }, fleet: { snapshot: async () => snapshot }, setup: () => facts }, { role });
  return (await renderPage("setup", { data, query: {}, session: { name: role === "operator" ? "ops" : "watcher", role }, readOnly })).html;
}
export const SETUP_DRAW = Object.freeze({
  "setup-starting.operator": () => setupGolden(),
  "setup-starting.viewer": () => setupGolden({ role: "viewer" }),
  "setup-no-grant.operator": () => setupGolden({ state: "no-grant" }),
  "setup-timeout.operator": () => setupGolden({ state: "timeout" }),
  "setup-unknown.operator": () => setupGolden({ state: "unknown" }),
  "setup-partial-doctor.viewer": () => setupGolden({ role: "viewer", state: "partial-doctor" }),
  "setup-unreadable.viewer": () => setupGolden({ role: "viewer", state: "unreadable" }),
  "setup-readonly.operator": () => setupGolden({ readOnly: true }),
  "setup-ready.operator": () => setupGolden({ state: "ready" }),
});
export const SETUP_PANEL_STATES = Object.freeze(Object.keys(SETUP_DRAW));
