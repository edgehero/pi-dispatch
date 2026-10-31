import { COMMUNITY_AUTH_ADAPTERS } from "../../worker/src/community-auth-patches.mjs";
import { SUBSCRIPTION_QUOTA_LIMITS } from "../../worker/src/subscription-quota.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { subscriptionAuthView, readSubscriptionAuthView, subscriptionAuthForAgent, SUBSCRIPTION_ADAPTERS, SUBSCRIPTION_VIEW_LIMITS } from "../src/subscription-auth-view.mjs";
import { consoleSubscriptionFixture } from "./helpers/subscription-auth-fixture.mjs";

const NOW = Date.UTC(2026, 9, 31, 12);

test("subscription projection retains only closed safe facts, including in model context", () => {
  const raw = consoleSubscriptionFixture(NOW);
  const row = raw.connections[0];
  Object.assign(row, { token: "access-secret-sentinel", refresh: "refresh-secret-sentinel", email: "private@example.test", accountGroup: "opaque-account-sentinel", path: "/private/auth-sentinel", error: "provider prose sentinel" });
  row.quota.windows[0].label = "private window sentinel";
  row.quota.extraUsage.email = "extra-private@example.test";
  raw.secret = "top-level sentinel";
  const safe = subscriptionAuthView(raw, { now: NOW });
  assert.equal(safe.connections[0].quota.windows[0].usedPercent, 100);
  assert.equal(safe.connections[0].quota.windows[1].usedPercent, 42);
  for (const value of [safe, subscriptionAuthForAgent(raw)]) {
    assert.doesNotMatch(JSON.stringify(value), /sentinel|private@|extra-private@/);
    assert.equal(value.connections[0].adapter, "pi-anthropic-oauth@0.3.6");
  }
});

test("missing metadata stays unknown, zero is observed zero and freshness expires under the injected clock", () => {
  const missing = subscriptionAuthView(null, { now: NOW });
  assert.equal(missing.state, "unknown"); assert.equal(missing.connections.length, 0);
  const base = consoleSubscriptionFixture(NOW, v => { const r = v.connections[0]; delete r.compatibility; r.quota.state = "available"; r.quota.windows[0].usedPercent = 0; });
  assert.equal(base.connections[0].compatibility, "unknown");
  assert.equal(base.connections[0].quota.windows[0].usedPercent, 0);
  assert.equal(subscriptionAuthView(base, { now: NOW + 300_001 }).connections[0].quota.fresh, false);
  const unknown = consoleSubscriptionFixture(NOW, v => { v.connections[0].quota = null; });
  assert.deepEqual(unknown.connections[0].quota.windows.map(w => [w.window, w.usedPercent, w.resetAt]), [["five-hour", null, null], ["seven-day", null, null]]);
});

test("access expiry retains refreshable credential state, and pin recognition cannot claim compatibility", () => {
  const expired = consoleSubscriptionFixture(NOW, v => { v.connections[0].expiresAt = NOW; });
  assert.equal(expired.connections[0].state, "connected");
  assert.equal(expired.connections[0].expired, true);
  const unknown = consoleSubscriptionFixture(NOW, v => { v.connections[0].adapter = "pi-anthropic-oauth@latest"; });
  assert.equal(unknown.connections[0].adapter, null); assert.equal(unknown.connections[0].compatibility, "unavailable");
  const wrongProvider = consoleSubscriptionFixture(NOW, v => { v.connections[0].provider = "openai"; });
  assert.equal(wrongProvider.connections[0].compatibility, "unavailable");
  assert.deepEqual(Object.keys(SUBSCRIPTION_ADAPTERS), ["openai-chatgpt", "pi-anthropic-oauth@0.3.6", "@gotgenes/pi-anthropic-auth@3.4.3"]);
});

test("published snapshot and optional reader seam are read-only, and unavailable reads retain unknown", async () => {
  const safe = consoleSubscriptionFixture(NOW); let calls = 0;
  const read = await readSubscriptionAuthView({ snapshot: {}, now: NOW, read: async () => { calls++; return safe; } });
  assert.equal(calls, 1); assert.deepEqual(read, safe);
  assert.deepEqual(await readSubscriptionAuthView({ snapshot: { subscriptionAuth: safe }, now: NOW }), safe);
  const unavailable = await readSubscriptionAuthView({ now: NOW, read: async () => { throw Error("secret diagnostic sentinel"); } });
  assert.equal(unavailable.state, "unknown"); assert.doesNotMatch(JSON.stringify(unavailable), /sentinel/);
});

test("invalid date, percentage, identifiers and provider text cannot become safe status", () => {
  const safe = consoleSubscriptionFixture(NOW, v => {
    const r = v.connections[0]; r.state = "secret-state"; r.ownerHost = "email@example.test"; r.expiresAt = Infinity;
    r.quota.observedAt = NOW + 1; r.quota.windows[0].usedPercent = -1; r.quota.windows[1].resetAt = NaN;
    v.connections.push({ id: "email@example.test" });
  });
  assert.equal(safe.connections.length, 1); assert.equal(safe.connections[0].ownerHost, null);
  assert.equal(safe.connections[0].state, "unknown"); assert.equal(safe.connections[0].expiresAt, null);
  assert.equal(safe.connections[0].quota.fresh, false); assert.equal(safe.connections[0].quota.windows[0].usedPercent, null);
});

test("display adapter pins and quota bounds are bolted to the authoritative worker contracts", () => {
  assert.deepEqual(SUBSCRIPTION_ADAPTERS, Object.fromEntries(Object.entries(COMMUNITY_AUTH_ADAPTERS).map(([id, row]) => [id, { provider: row.provider, package: row.package ?? null, version: row.version ?? null, community: row.community }])));
  assert.equal(SUBSCRIPTION_VIEW_LIMITS.freshMs, SUBSCRIPTION_QUOTA_LIMITS.freshMs);
  assert.equal(SUBSCRIPTION_VIEW_LIMITS.windows, SUBSCRIPTION_QUOTA_LIMITS.windows);
});

test("fleet display truncation and malformed rows explicitly retain partial coverage", () => {
  const base = consoleSubscriptionFixture(NOW).connections[0];
  const many = subscriptionAuthView({ state: "ready", partial: false, connections: Array.from({ length: 129 }, (_, n) => ({ ...base, id: `account-${n}` })) }, { now: NOW });
  assert.equal(many.connections.length, 128); assert.equal(many.partial, true); assert.equal(many.truncated, true);
  assert.equal(subscriptionAuthForAgent(many).truncated, true);
  const invalid = subscriptionAuthView({ state: "ready", partial: false, connections: [{ id: "bad@example.test" }] }, { now: NOW });
  assert.equal(invalid.partial, true);
});

test("monitoring preferences survive safe machine projection and malformed choices never hide evidence", () => {
  for (const quotaWindows of [[], ["five-hour"], ["seven-day"], ["five-hour", "seven-day"]]) {
    const value = consoleSubscriptionFixture(NOW, v => { v.connections[0].quotaWindows = quotaWindows; });
    assert.deepEqual(value.connections[0].quotaWindows, quotaWindows);
    assert.deepEqual(subscriptionAuthForAgent(value).connections[0].quotaWindows, quotaWindows);
    assert.equal(value.connections[0].quota.windows.length, 2, "the machine view retains the full observed evidence");
  }
  for (const quotaWindows of [undefined, null, "five-hour", ["private-window-sentinel"], ["five-hour", "five-hour"]]) {
    const value = consoleSubscriptionFixture(NOW, v => { v.connections[0].quotaWindows = quotaWindows; });
    assert.equal(value.connections[0].quotaWindows, null);
    assert.doesNotMatch(JSON.stringify(value), /private-window-sentinel/);
  }
});
