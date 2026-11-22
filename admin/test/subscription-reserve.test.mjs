import assert from "node:assert/strict";
import { test } from "node:test";
import { modelsSubscriptionQuota } from "../src/console/panels/subscription-auth.mjs";
import { modelsCooldowns } from "../src/console/panels/models.mjs";
import { waitingSentence } from "../src/console/panels/overview.mjs";
import { waitingLine } from "../src/console/actions.mjs";
import { modelsForAgent } from "../src/models-view.mjs";
import { subscriptionAuthForAgent, subscriptionAuthView } from "../src/subscription-auth-view.mjs";
import { wideningFieldRefusal } from "../src/write-plans.mjs";
import { consoleSubscriptionFixture } from "./helpers/subscription-auth-fixture.mjs";

// Issue #1008: what the console says of the deployment quota reserve (`PI_QUOTA_RESERVE_PERCENT`) and of the jobs it holds,
// and that no tool may mark a trigger `run.quotaReserve`.

const NOW = Date.UTC(2026, 9, 31, 12);
const text = (value) => String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const drawModels = (value, options = {}) => String(modelsSubscriptionQuota({ role: "operator", readOnly: false, now: NOW, data: { now: NOW, models: { subscriptionAuth: value } }, ...options }));
const reserved = (percent) => consoleSubscriptionFixture(NOW, (v) => { v.connections[0].reservePercent = percent; });

test("the subscription view keeps a published reserve of 1 to 99 percent, in model context too, and nothing else", () => {
  assert.equal(reserved(85).connections[0].reservePercent, 85);
  assert.equal(subscriptionAuthForAgent(reserved(85)).connections[0].reservePercent, 85);
  for (const bad of [undefined, null, 0, 100, 85.5, "85", -1]) assert.equal(reserved(bad).connections[0].reservePercent, null, String(bad));
  assert.equal(subscriptionAuthView({ state: "ready", partial: false, connections: [{ id: "claude-work", provider: "anthropic", reservePercent: 70 }] }, { now: NOW }).connections[0].reservePercent, 70);
});

test("the Models quota card states a published reserve and the windows at or above it, and says nothing of one never published", () => {
  // The fixture's five-hour window stands at 100%, its seven-day window at 42%.
  const shown = text(drawModels(reserved(85)));
  assert.ok(shown.includes("Quota reserve 85%. At or above it, only jobs of triggers with run.quotaReserve start; the others wait until the window drops below it or resets."), shown);
  assert.equal(shown.split("At or above the quota reserve.").length - 1, 1, "only the five-hour window is at or above 85%");
  assert.equal(text(drawModels(reserved(40))).split("At or above the quota reserve.").length - 1, 2);
  for (const value of [consoleSubscriptionFixture(NOW), reserved(null)]) {
    const doc = text(drawModels(value));
    assert.doesNotMatch(doc, /quota reserve/i, "no reserve published: the card reads as it always did");
  }
  assert.ok(text(drawModels(subscriptionAuthForAgent(reserved(85)), { role: "agent" })).includes("Quota reserve 85%"));
});

// The fixture with both windows observed available: five-hour at 41%, seven-day at 89%, both resetting ahead.
const available = (change = () => {}) => consoleSubscriptionFixture(NOW, (v) => {
  Object.assign(v.connections[0].quota, { state: "available", until: null });
  v.connections[0].quota.windows = [
    { id: "five-hour", window: "five-hour", scope: "account", usedPercent: 41, resetAt: NOW + 3_600_000, state: "available" },
    { id: "seven-day", window: "seven-day", scope: "account", usedPercent: 89, resetAt: NOW + 86_400_000, state: "available" },
  ];
  change(v.connections[0]);
});

test("a window holds at exactly the reserve, and not once its reset has passed or, with no reset, on a stale reading", () => {
  const marks = (row) => text(drawModels(row)).split("At or above the quota reserve.").length - 1;
  assert.equal(marks(available((c) => { c.reservePercent = 89; })), 1, "89% at a reserve of 89 holds");
  assert.equal(marks(available((c) => { c.reservePercent = 89; c.quota.windows[1].usedPercent = 88.9; })), 0);
  assert.equal(marks(available((c) => { c.reservePercent = 85; c.quota.windows[1].resetAt = NOW - 1; })), 0, "a passed reset opened a new window");
  assert.equal(marks(available((c) => { c.reservePercent = 85; c.quota.windows[1].resetAt = null; })), 1, "no reset, fresh reading");
  assert.equal(marks(available((c) => { c.reservePercent = 85; c.quota.windows[1].resetAt = null; c.quota.observedAt = NOW - 600_000; })), 0, "no reset, stale reading: the worker reads it again first");
});

test("while the reserve holds, the badge and the Pickup line say so instead of reading as room, and the window shows outside the focus", () => {
  const held = text(drawModels(available((c) => { c.reservePercent = 85; })));
  assert.ok(held.includes("claude-work At or above the quota reserve"), held);
  assert.ok(held.includes("Pickup Only jobs of triggers with run.quotaReserve start while a window is at or above the quota reserve; the others wait"), held);
  assert.doesNotMatch(held, /Quota observed available|permits checking other pickup gates/);
  const free = text(drawModels(available()));
  assert.ok(free.includes("Quota observed available") && free.includes("Quota observation permits checking other pickup gates"), free);
  // The monitoring focus names the five-hour window alone; the seven-day window the reserve holds is shown anyway.
  const focused = text(drawModels(available((c) => { c.reservePercent = 85; c.quotaWindows = ["five-hour"]; })));
  assert.ok(focused.includes("Seven-day account window 89% used"), focused);
  assert.ok(focused.includes("Outside the monitoring focus, shown because the quota reserve holds jobs on it."), focused);
  assert.doesNotMatch(focused, /Required exhaustion evidence/, "a reserve hold is not exhaustion");
  assert.doesNotMatch(text(drawModels(available((c) => { c.quotaWindows = ["five-hour"]; }))), /Seven-day account window/, "without the reserve the focus hides it, as before");
});

test("a hold by a scoped window alone says only that scope's models wait, never that every job does", () => {
  const scoped = { id: "seven-day:scoped", window: "seven-day", scope: "scoped", usedPercent: 96, resetAt: NOW + 86_400_000, state: "available" };
  const only = text(drawModels(available((c) => { c.reservePercent = 95; c.quota.windows.push(scoped); })));
  assert.ok(only.includes("claude-work A scoped window is at or above the quota reserve"), only);
  assert.match(only, /Pickup A scoped window is at or above the quota reserve: on the models it applies to, only jobs of triggers with run\.quotaReserve start \(the reviewed Fable weekly scope does not apply to anthropic\/claude-opus-5-5 ?\)/);
  assert.doesNotMatch(only, /claude-work At or above the quota reserve|start while a window is at or above the quota reserve; the others wait/);
  // An account window holding too: every job waits, and the card says so.
  const both = text(drawModels(available((c) => { c.reservePercent = 85; c.quota.windows.push(scoped); })));
  assert.ok(both.includes("claude-work At or above the quota reserve") && both.includes("start while a window is at or above the quota reserve; the others wait"), both);
});

test("a job the reserve holds is listed on Models, in the waitlists and in a cancel preview, with its reset", () => {
  const resetAt = Date.UTC(2026, 10, 2, 9);
  const row = { jobId: "gh-held", queue: "github", why: "subscription-reserve", known: true, bucket: "check", untilAt: NOW + 300_000, dueAt: NOW + 300_000, resetAt };
  const models = modelsForAgent({ waiting: [{ jobId: "gh-held", reason: "subscription-reserve", resetAt }, { jobId: "gh-other", reason: "pause-window", resetAt: null }] });
  assert.deepEqual(models.waiting, [{ jobId: "gh-held", reason: "subscription-reserve", resetAt }, { jobId: "gh-other", reason: null, resetAt: null }]);
  const card = text(modelsCooldowns({ data: { models: { state: "ready", roles: [], models: [], cooldowns: [], waiting: [{ jobId: "gh-held", reason: "subscription-reserve", resetAt }] } } }));
  assert.ok(card.includes("gh-held · subscription quota reserve. Earliest observed reset 2026-11-02 09:00:00 UTC."), card);
  const sentence = text(waitingSentence(row));
  assert.ok(sentence.startsWith("The subscription account is at or above its quota reserve, which only triggers marked run.quotaReserve may use. Asks again at"), sentence);
  assert.ok(sentence.endsWith("Earliest observed reset 2026-11-02 09:00:00 UTC."), sentence);
  assert.ok(waitingLine(row).text.endsWith("Earliest observed reset 2026-11-02 09:00:00 UTC."), waitingLine(row).text);
  assert.ok(text(waitingSentence({ ...row, resetAt: null })).endsWith("Reset time unknown."));
});

test("no tool call may carry run.quotaReserve, in any spelling the sweep folds, at any depth", () => {
  const said = "whether a trigger's jobs may use the subscription quota reserve is set by hand in the reviewed triggers file, never by a tool";
  for (const [params, at] of [[{ run: { quotaReserve: true } }, "run.quotaReserve"], [{ quotaReserve: false }, "quotaReserve"], [{ run: { quota_reserve: true } }, "run.quota_reserve"], [{ on: { "Quota-Reserves": true } }, "on.Quota-Reserves"], [{ run: { nested: { useQuotaReserve: true } } }, "run.nested.useQuotaReserve"]]) {
    assert.equal(wideningFieldRefusal(params, "dispatch_trigger_edit"), `dispatch_trigger_edit cannot set run.quotaReserve (sent as ${at}): ${said}`, JSON.stringify(params));
  }
  assert.equal(wideningFieldRefusal({ run: { flow: "fix", reserve: true } }, "dispatch_trigger_add"), null, "a word that only shares the field's last half is not the field");
});
