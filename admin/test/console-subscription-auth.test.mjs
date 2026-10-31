import { readFileSync } from "node:fs";
import { SUBSCRIPTION_AUTH_CSS } from "../src/console/subscription-auth-css.mjs";
import { loadPageData, renderPage } from "../src/console/pages.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionsSubscriptionAuth, modelsSubscriptionQuota } from "../src/console/panels/subscription-auth.mjs";
import { consoleSubscriptionFixture } from "./helpers/subscription-auth-fixture.mjs";
import { subscriptionAuthForAgent } from "../src/subscription-auth-view.mjs";
import { readConnections, modelConnections } from "../src/connections-view.mjs";
import { readModelsView, modelsForAgent } from "../src/models-view.mjs";

const NOW = Date.UTC(2026, 9, 31, 12);
const draw = (page, value, options = {}) => String((page === "connections" ? connectionsSubscriptionAuth : modelsSubscriptionQuota)({ role: "operator", readOnly: false, now: NOW, data: { now: NOW, [page]: { subscriptionAuth: value } }, ...options }));
const text = value => value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("Connections separates exact adapter compatibility from credential health and offers only terminal commands", () => {
  const value = consoleSubscriptionFixture(NOW), doc = draw("connections", value);
  for (const fact of ["pi-anthropic-oauth@0.3.6", "mini1", "Pinned artifact verified; job checks remain", "Connected", "2026-10-31 13:00:00 UTC", "Disabled"]) assert.ok(text(doc).includes(fact), fact);
  assert.match(text(doc), /pi-dispatch auth login claude-work/); assert.match(text(doc), /pi-dispatch auth logout claude-work/);
  assert.doesNotMatch(doc, /<form|data-action=|oauth\/|accessToken/);
  const unknown = draw("connections", consoleSubscriptionFixture(NOW, v => { delete v.connections[0].compatibility; }));
  assert.match(unknown, /Compatibility not published/); assert.doesNotMatch(unknown, /Pinned artifact verified; job checks remain/);
});

test("all adapter and credential exceptional states have truthful text and a glyph", () => {
  for (const [compatibility, words] of [["disabled", "Extension disabled"], ["unstaged", "Extension not staged"], ["unpinned", "Exact version not pinned"], ["conflicting", "Conflicting provider overrides"], ["version-mismatch", "Adapter version mismatch"], ["unavailable", "Adapter unavailable"]]) {
    const doc = draw("connections", consoleSubscriptionFixture(NOW, v => { v.connections[0].compatibility = compatibility; }));
    assert.ok(text(doc).includes(words)); assert.match(doc, /<svg[^>]*><use/);
  }
  for (const [state, words] of [["disconnected", "Disconnected"], ["reauth-required", "Sign-in required"], ["refresh-uncertain", "Refresh outcome uncertain"], ["other-host", "Owned by another host"], ["adapter-unavailable", "Adapter unavailable"]]) {
    assert.ok(text(draw("connections", consoleSubscriptionFixture(NOW, v => { v.connections[0].state = state; }))).includes(words), state);
  }
});

test("Models shows observed percentages and resets, preserves exhaustion on stale status, and never substitutes zero for unknown", () => {
  const doc = draw("models", consoleSubscriptionFixture(NOW));
  for (const fact of ["100% used", "42% used", "Quota exhausted", "Fresh, observed", "Waiting until 2026-10-31 12:30:00 UTC", "deployment dollar windows still apply"]) assert.ok(text(doc).includes(fact), fact);
  const stale = draw("models", consoleSubscriptionFixture(NOW, v => { v.connections[0].quota.observedAt = NOW - 600_000; }));
  assert.match(stale, /Exhaustion retained/); assert.match(stale, /Stale or freshness unknown/); assert.doesNotMatch(stale, /Quota observed available/);
  const unknown = draw("models", consoleSubscriptionFixture(NOW, v => { v.connections[0].quota = null; }));
  assert.match(unknown, /Usage unknown/); assert.match(unknown, /Reset unknown/); assert.doesNotMatch(unknown, /0% used|Quota observed available/);
  const trial = draw("models", consoleSubscriptionFixture(NOW, v => { Object.assign(v.connections[0].quota, { blockedUnknownReset: true, until: null, trialAvailable: false }); }));
  assert.match(trial, /Exhausted; reset unknown/); assert.match(text(trial), /pi-dispatch auth trial claude-work/);
  assert.match(trial, /does not clear account exhaustion or start a job here/);
});

test("viewer, agent and read-only operators read safe facts but receive no commands or authentication controls", () => {
  const safe = consoleSubscriptionFixture(NOW, v => { v.connections[0].quota.trialAvailable = true; });
  for (const page of ["connections", "models"]) for (const options of [{ role: "viewer" }, { role: "agent" }, { role: "operator", readOnly: true }]) {
    const doc = draw(page, options.role === "agent" ? subscriptionAuthForAgent(safe) : safe, options);
    assert.match(doc, /claude-work/); assert.match(doc, /mini1/);
    assert.doesNotMatch(doc, /pi-dispatch auth|data-copy|<form|data-action=/, `${page} ${JSON.stringify(options)}`);
  }
});

test("both actual readers use the injected published observation, and machine projections retain only typed safe status", async () => {
  const safe = consoleSubscriptionFixture(NOW); let reads = 0;
  const subscriptionAuth = async () => { reads++; return safe; };
  const connections = await readConnections({ now: NOW, snapshot: { triggers: { triggers: [] } }, reads: { environment: () => ({ env: {} }), allowlist: () => [], endpoints: () => [], subscriptionAuth } });
  const models = await readModelsView({ now: NOW, snapshot: { runs: [], waiting: { rows: [] }, settings: { overlay: {} } }, reads: { triggers: () => '{"triggers":[]}', projects: () => null, limits: () => null, overlay: () => null, records: () => [], cooldowns: () => [], subscriptionAuth } });
  assert.equal(reads, 2);
  for (const value of [connections.subscriptionAuth, models.subscriptionAuth, modelConnections(connections).subscriptionAuth, modelsForAgent(models).subscriptionAuth]) assert.deepEqual(value, safe);
});

test("published card CSS and console paste stay identical, with full-width phone fields", () => {
  const generator = readFileSync(new URL("../../design/tools/subscription_auth.py", import.meta.url), "utf8");
  assert.equal(generator.match(/SUBSCRIPTION_AUTH_CSS = """([\s\S]*?)"""/)[1], SUBSCRIPTION_AUTH_CSS);
  assert.match(SUBSCRIPTION_AUTH_CSS, /@media \(max-width: 600px\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});

test("agent Connections renders safely from the actual page projection instead of a half-stripped DTO", async () => {
  const connections = await readConnections({ now: NOW, snapshot: { subscriptionAuth: consoleSubscriptionFixture(NOW), triggers: { triggers: [] } }, reads: { environment: () => ({ env: {} }), allowlist: () => [], endpoints: () => [] } });
  const data = await loadPageData("connections", {}, { now: () => NOW, fleet: { snapshot: async () => ({}) }, connections: async () => connections }, { role: "agent" });
  const result = await renderPage("connections", { session: { name: "agent", role: "agent" }, data, query: {} });
  assert.equal(result.status, 200); assert.match(String(result.html), /claude-work/); assert.match(String(result.html), /pi-anthropic-oauth@0.3.6/);
  assert.doesNotMatch(String(result.html), /pi-dispatch auth|data-copy|<form|could not read this page/);
  assert.match(String(result.html), /Limited Connections view/);
  assert.match(String(result.html), /not published in this agent view/);
});

test("over-cap usage remains visible, granted trials are not offered again, and paid overage uses a per-job USD bound", () => {
  const value = consoleSubscriptionFixture(NOW, v => { const row = v.connections[0]; row.quota.windows[0].usedPercent = 101; row.quota.blockedUnknownReset = true; row.quota.trialAvailable = true; row.extraUsageCreditMicros = 250000; });
  const doc = text(draw("models", value));
  assert.ok(doc.includes("101% used")); assert.ok(doc.includes("One quota trial is already authorized")); assert.ok(doc.includes("One trial is authorized; other pickup gates still apply"));
  assert.ok(!doc.includes("pi-dispatch auth trial")); assert.ok(doc.includes("0.25 USD per job (conservative model-cost bound)"));
  assert.ok(!doc.includes("0.25 provider credits"));
});

test("access-token expiry does not invent a sign-in refusal when the host may refresh it", () => {
  const value = consoleSubscriptionFixture(NOW, v => { v.connections[0].expiresAt = NOW - 1; });
  const doc = text(draw("connections", value));
  assert.ok(doc.includes("Connected")); assert.ok(doc.includes("Access token expiry"));
  assert.ok(doc.includes("access token expired; host refresh required")); assert.ok(!doc.includes("Sign-in required"));
});

test("monitoring focus changes observed account rows but never hides excluded exhausted, scoped or other evidence", () => {
  const focused = consoleSubscriptionFixture(NOW, v => { v.connections[0].quotaWindows = ["five-hour"]; });
  const first = text(draw("models", focused));
  assert.ok(first.includes("100% used"));
  assert.ok(!first.includes("42% used") && !first.includes("Seven-day account window"), "the available weekly row is excluded from a five-hour focus");
  const unknownWeek = consoleSubscriptionFixture(NOW, v => { v.connections[0].quotaWindows = ["five-hour"]; Object.assign(v.connections[0].quota.windows[1], { state: "unknown", usedPercent: null }); });
  assert.ok(!text(draw("models", unknownWeek)).includes("Seven-day account window"), "unknown unselected account rows follow the focus too");
  const exhausted = consoleSubscriptionFixture(NOW, v => {
    const row = v.connections[0]; row.quotaWindows = ["five-hour"];
    row.quota.windows[0].state = "available"; row.quota.windows[0].usedPercent = 12;
    Object.assign(row.quota.windows[1], { state: "exhausted", usedPercent: 100, resetAt: NOW + 7 * 86_400_000 });
    row.quota.until = NOW + 7 * 86_400_000;
  });
  for (const role of ["operator", "viewer", "agent"]) {
    const doc = text(draw("models", role === "agent" ? subscriptionAuthForAgent(exhausted) : exhausted, { role }));
    assert.ok(doc.includes("Seven-day account window") && doc.includes("100% used"));
    assert.ok(doc.includes("Required exhaustion evidence outside the monitoring focus"));
    assert.ok(doc.includes("Waiting until 2026-11-07 12:00:00 UTC"), "the aggregate pickup remains blocked through the weekly reset");
  }
  const extra = consoleSubscriptionFixture(NOW, v => {
    v.connections[0].quotaWindows = [];
    v.connections[0].quota.windows.push({ id: "scoped-week", window: "seven-day", scope: "scoped", state: "available", usedPercent: 31, resetAt: null }, { id: "other", window: "other", scope: "account", state: "unknown", usedPercent: null, resetAt: null });
  });
  const more = text(draw("models", extra));
  assert.ok(more.includes("None selected") && more.includes("31% used") && more.includes("Other account window"));
  assert.ok(!more.includes("42% used")); assert.ok(more.includes("100% used"));
  const unknown = text(draw("models", consoleSubscriptionFixture(NOW, v => { delete v.connections[0].quotaWindows; })));
  assert.ok(unknown.includes("Not published; all windows shown") && unknown.includes("42% used"));
});
