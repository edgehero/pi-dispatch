import { NOW } from "../../../launch/fixture-deployment.mjs";
import { renderPage } from "../../src/console/pages.mjs";
import { SANDBOX_HOSTS_FIXTURE } from "./sandbox-goldens.mjs";

export function workspaceFixture({ state = "open", role = "operator", readOnly = false } = {}) {
  const record = { jobId: "gh-9575", kind: "github", target: "acme/web#490", flow: "fix", host: "mini1", project: "web", backend: "local", outcome: "completed", reason: null, startedAt: new Date(NOW - 180000).toISOString(), endedAt: new Date(NOW - 60000).toISOString(), triggerIndex: 2, triggerType: "comment" };
  const shell = { id: record.jobId, host: record.host, venue: "local", by: "ops", since: NOW - 30000, nonce: "a".repeat(32), containerId: "b".repeat(64) };
  const data = { now: NOW, env: {}, run: { record }, chat: { state: "finished", jobState: "completed", mode: "fork" }, workspace: { retained: true, until: NOW + 3600000, shell: state === "open" || state === "shared" ? shell : null }, sandboxHosts: SANDBOX_HOSTS_FIXTURE, browserGateways: { enabledHosts: ["mini1"], sessions: state === "open" || state === "shared" ? [shell] : [], drivers: [] }, forkPoints: { refusal: "fork-source-unavailable" }, transcript: { exists: false } };
  if (state === "shared") data.browserGateways.drivers = [{ ...shell, by: "lee", ownerKey: "c".repeat(64), watching: true, watchers: [{ name: "sam", state: "connected" }] }];
  if (state === "failed") { record.outcome = "failed"; record.reason = "oom-killed"; }
  if (state === "awaiting") { record.reason = "awaiting-input"; data.chat = { state: "parked", jobState: "completed", mode: "reply" }; }
  if (state === "unsupported") { record.backend = "openshell"; data.workspace = { retained: false, why: "venue" }; }
  if (state === "running" || state === "recovery") { data.chat = { state: "active", jobState: "active", mode: "live" }; if (state === "recovery") { record.reason = "recovery-enqueued"; data.chat.activeJobId = "gh-9575.r1"; } }
  if (state === "never-started") { record.outcome = "failed"; record.reason = "container-never-started"; }
  if (state === "refused") { record.outcome = "policy"; record.reason = "over-budget"; record.budgetReserved = false; }
  if (state === "expired") data.workspace = { retained: true, until: NOW - 1 };
  if (state === "swept") data.sandboxCheck = { retained: false, why: "swept" };
  if (state === "retention-off") data.workspace = { retained: false, why: "retention-off" };
  if (state === "unknown") data.workspace = { unknown: true, sessionsUnknown: true };
  if (state === "deleted") data.run = { missing: true };
  if (state === "stale") { data.workspace = { unknown: true, sessionsUnknown: true }; data.browserGateways.partial = true; }
  if (state === "fork") data.forkPoints = { ok: true, entries: [{ id: "safe-point", positions: ["at"], role: "assistant" }] };
  return { data, query: { id: record.jobId }, session: { name: role === "operator" ? "sam" : "watcher", role }, role, name: "sam", readOnly, env: {}, now: NOW };
}

const states = ["open", "shared", "kept", "failed", "awaiting", "unsupported", "running", "recovery", "never-started", "refused", "expired", "swept", "retention-off", "unknown", "stale", "fork"];
export const WORKSPACE_DRAW = Object.freeze({
  ...Object.fromEntries(states.map((state) => [`run-workspace-${state}.operator`, async () => String((await renderPage("run", workspaceFixture({ state }))).html)])),
  "run-workspace-readonly.operator": async () => String((await renderPage("run", workspaceFixture({ readOnly: true }))).html),
  "run-workspace-hidden.viewer": async () => String((await renderPage("run", workspaceFixture({ role: "viewer" }))).html),
});
export const WORKSPACE_PANEL_STATES = Object.freeze(Object.keys(WORKSPACE_DRAW));
