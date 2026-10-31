/** Synthetic reviewed sources; no deployment text or personal instructions enter screenshots or fixtures. */
import { answerConfigDigest, answerStandingSource } from "@edgehero/pi-dispatch/answerer";

export function answererFixture(now) {
  const standing = { id: "test-command", title: "Test command", text: "Run npm test for the complete suite.", projects: ["web"], repo: "github:acme/web" };
  const sources = [answerStandingSource(standing), { id: "b".repeat(64), kind: "repository", name: "docs/CONTRIBUTING.md", revision: "1".repeat(40), url: "https://github.com/acme/web/blob/1234567/docs/CONTRIBUTING.md" }];
  const rule = { id: "known-conventions", projects: ["web", "api"], categories: ["convention", "how-to", "decided"], confidence: 0.8, mode: "draft", flow: "draft-answer", model: "example/drafter", decisionModel: "example/decision", maxCostUsd: "0.05" };
  const meta = { v: 1, runId: "gh-6e1d", draftRunId: "gh-a07c", ruleId: rule.id, at: now - 120000, status: "drafted", draftExists: true, category: "convention", confidence: 0.86, probabilities: { convention: 0.86, "how-to": 0.03, decided: 0.02, product: 0.04, security: 0.01, money: 0.01, scope: 0.01, approval: 0.01, uncovered: 0.01 }, answerableConfidence: 0.91, sources, costUsd: 0.004 };
  const question = "Which command runs the whole suite?";
  const draft = "Run npm test for the complete suite. [standing:test-command]";
  const privateDraft = { meta, question, draft, sources, digest: answerConfigDigest({ question, draft, sources }) };
  const rows = [meta, { ...meta, runId: "gh-2f6a", draftRunId: "gh-91d4", status: "passed", draftExists: false, passReason: "category-disallowed", category: "product", confidence: 0.88, probabilities: { convention: 0.03, "how-to": 0.02, decided: 0.01, product: 0.88, security: 0.02, money: 0.01, scope: 0.01, approval: 0.01, uncovered: 0.01 }, sources: [], costUsd: 0.001 }, { ...meta, runId: "gh-5a02", draftRunId: "gh-old-draft", status: "sent", draftExists: false, by: "ops", sentBy: "ops", sentAt: now - 3600000, disposition: "as-drafted" }];
  return { state: "ok", partial: false, rules: [rule], standing: [{ ...standing, used: 2 }], rows, privateDraft, stats: { sent: 1, edited: 0, dropped: 0, passed: 1, jobs: 3, costUsd: 0.009, costPartial: false } };
}

export function answererParkedRows(now) {
  return [{ jobId: "gh-2f6a", project: "api", target: "acme/api#131", kind: "github", flow: "triage", host: "mini1", reason: "awaiting-input", ageMs: 26 * 60000, endedAt: new Date(now - 26 * 60000).toISOString(), pendingScan: { jobId: null } }, { jobId: "gh-6e1d", project: "web", target: "acme/web#512", kind: "github", flow: "fix", host: "mini2", reason: "awaiting-input", ageMs: 4 * 60000, endedAt: new Date(now - 4 * 60000).toISOString(), pendingScan: { jobId: null } }];
}

export async function renderAnswererState(state = "populated", role = "operator", { now, readOnly = false } = {}) {
  const { renderPage } = await import("../../src/console/pages.mjs");
  const model = answererFixture(now);
  let page = "parked";
  const parked = answererParkedRows(now);
  if (state === "rules") page = "answer-rules";
  if (["run", "stale", "dropped"].includes(state)) page = "run";
  if (state === "empty") { model.rows = []; model.rules = []; model.standing = []; parked.length = 0; }
  if (state === "unavailable") { model.state = "unavailable"; model.partial = true; model.rows = []; }
  if (state === "partial") model.partial = true;
  if (state === "shadow") { model.rules[0].mode = "classify"; model.rows[0].draftExists = false; model.rows[0].status = "passed"; model.rows[0].passReason = "classify-only"; }
  if (state === "pending") { model.rows[0].draftExists = false; model.rows[0].status = "pending"; }
  if (state === "refused") { model.rows[0].draftExists = false; model.rows[0].status = "failed"; model.rows[0].passReason = "cap-refused"; }
  if (state === "no-sources") { model.rows[0].draftExists = false; model.rows[0].status = "passed"; model.rows[0].passReason = "uncovered"; model.rows[0].sources = []; }
  if (state === "stale") { model.privateDraft = null; model.privateDraftProblem = "config-changed"; }
  if (state === "dropped") { model.privateDraft = null; model.rows[0].draftExists = false; model.rows[0].status = "dropped"; }
  if (state === "long-names") { parked[1].jobId = `gh-${"a".repeat(190)}`; model.rows[0].runId = parked[1].jobId; model.rows[0].sources[1].name = `${"deep/".repeat(30)}CONTRIBUTING.md`; }
  const data = { now, env: {}, answerer: model, snapshot: { parked, queue: { counts: {} }, hostBudgets: [] }, parkedChecks: Object.fromEntries(parked.map(p => [p.jobId, { ok: true }])) };
  const query = page === "run" ? { id: model.rows[0].runId } : {};
  if (page === "run") Object.assign(data, { run: { record: { jobId: model.rows[0].runId, project: "web", host: "mini2", backend: "local", kind: "github", target: "acme/web#512", reason: "awaiting-input", outcome: "completed", startedAt: new Date(now - 600000).toISOString(), endedAt: new Date(now - 240000).toISOString() } }, chat: { state: "parked", mode: "reply", jobState: "completed" }, chatAnswer: { ok: true }, transcript: { exists: true, ended: true } });
  return String((await renderPage(page, { session: { name: role === "operator" ? "ops" : "watcher", role }, data, query, readOnly })).html);
}

const states = ["populated", "rules", "run", "stale", "dropped", "empty", "unavailable", "partial", "shadow", "pending", "refused", "no-sources", "long-names"];
const { NOW } = await import("../../../launch/fixture-deployment.mjs");
export const ANSWERER_DRAW = Object.fromEntries([...states.map(state => [`answerer-${state}.operator`, () => renderAnswererState(state, "operator", { now: NOW })]), ["answerer-populated.viewer", () => renderAnswererState("populated", "viewer", { now: NOW })], ["answerer-readonly.operator", () => renderAnswererState("populated", "operator", { now: NOW, readOnly: true })]]);
export const ANSWERER_PANEL_STATES = Object.freeze(Object.keys(ANSWERER_DRAW));

export const AGENT_OVERVIEW_DRAW = Object.fromEntries(["populated", "partial", "unavailable"].map(state => [`agent-writes-${state}.operator`, async () => {
  const { renderPage } = await import("../../src/console/pages.mjs");
  const { FLEET_CARD_SNAPSHOT } = await import("./fleet-goldens.mjs");
  return String((await renderPage("overview", { session: { role: "operator", name: "ops" }, query: {}, data: { now: NOW, snapshot: FLEET_CARD_SNAPSHOT(), agentWrites: { host: "mini1", count: state === "unavailable" ? null : 3, partial: state !== "populated", unavailable: state === "unavailable" } } })).html);
}]));
