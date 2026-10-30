import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePauseWindows, windowEndAt } from "@edgehero/pi-dispatch/pause-windows";
import { triggerListOf, recordMatchesTrigger, scheduledOccurrences, quietIntervals, TRIGGER_LIST_LIMITS } from "../src/trigger-list.mjs";

const NOW = Date.UTC(2026, 9, 30, 12);
const DAY = 86400_000;
const rule = (over = {}) => ({ index: 0, type: "label", forge: "github", flow: "fix", any: ["pi"], ...over });
const record = (over = {}) => ({ jobId: "gh-a", kind: "github", triggerIndex: 0, triggerType: "label", flow: "fix", startedAt: new Date(NOW - 3600_000).toISOString(), endedAt: new Date(NOW - 3000_000).toISOString(), outcome: "completed", provider: "provider", model: "model", tokens: { cost: 0.25, metered: true, input: 1, output: 1, total: 2, calls: 1 }, ...over });
const snapshot = (triggers = [rule()], extra = {}) => ({ triggers: { triggers, count: triggers.length }, schedulers: [], pauseWindows: { windows: [] }, ...extra });
const build = (extra = {}) => triggerListOf({ snapshot: snapshot(), records: [], coverage: { complete: true }, now: NOW, ...extra });

test("saved index, type and forge attribute history; a shared flow or mismatched index/type/forge do not", () => {
  const t = rule();
  assert.equal(recordMatchesTrigger(record(), t), true);
  for (const over of [{ triggerIndex: undefined }, { triggerIndex: 1 }, { triggerType: "comment" }, { kind: "gitlab" }]) assert.equal(recordMatchesTrigger(record(over), t), false);
  const cron = rule({ index: 6, type: "cron", id: "nightly" });
  assert.equal(recordMatchesTrigger(record({ jobId: "repeat:nightly:123", kind: "local" }), cron), true);
  assert.equal(recordMatchesTrigger(record({ jobId: "manual:nightly:456", kind: "local" }), cron), true);
  for (const over of [{ jobId: "repeat:other:123", kind: "local" }, { jobId: "repeat:nightly:123", kind: "github" }, { jobId: "local-cli", kind: "local" }]) assert.equal(recordMatchesTrigger(record(over), cron), false);
});

test("statistics use the 30-day range and separate UTC Monday spend from the rolling strip, deduplicating newest records", () => {
  const records = [record(), record({ jobId: "other", triggerIndex: 5 }), record({ jobId: "old", endedAt: new Date(NOW - 31 * DAY).toISOString() }), record({ jobId: "last-week", endedAt: "2026-10-25T20:00:00Z" }), record({ jobId: "future", endedAt: new Date(NOW + DAY).toISOString() }), record({ endedAt: new Date(NOW - 2 * DAY).toISOString(), tokens: null })];
  const got = build({ records });
  assert.equal(got.rows[0].stats.runs30d, 2);
  assert.equal(got.rows[0].stats.weekRuns, 1);
  assert.equal(got.rows[0].stats.weekCostMicros, 250000);
  assert.equal(got.rows[0].stats.costIncomplete, false, "the older duplicate must not overwrite the current metered record");
  assert.equal(got.rows[0].lastRun.jobId, "gh-a");
  assert.equal(got.rows[0].stats.incomplete, false);
  assert.equal(got.weekStart, Date.UTC(2026, 9, 26));
  assert.equal(got.week.start, Date.UTC(2026, 9, 30));
  assert.equal(got.week.end - got.week.start, 7 * DAY);
});

test("missing history stays unknown, a retained or cut view is a lower bound, and missing configuration is not zero rules", () => {
  const missing = build({ records: null });
  assert.equal(missing.rows[0].stats.runs30d, null);
  assert.equal(missing.stats.weekCostMicros, null);
  assert.equal(missing.coverage.complete, false);
  const retained = build({ records: [record()], coverage: {} });
  assert.equal(retained.rows[0].stats.incomplete, true);
  assert.match(retained.problems.join(" "), /retained history/);
  const many = Array.from({ length: TRIGGER_LIST_LIMITS.records + 1 }, (_, i) => record({ jobId: `gh-${i}`, endedAt: new Date(NOW - i * 1000).toISOString() }));
  const cut = build({ records: many });
  assert.equal(cut.rows[0].stats.runs30d, TRIGGER_LIST_LIMITS.records);
  assert.equal(cut.rows[0].stats.incomplete, true);
  const unavailable = build({ snapshot: { triggers: { invalid: "unreadable" } }, records: null });
  assert.equal(unavailable.counts.all, null);
  assert.equal(unavailable.counts.schedule, null);
});

test("weekly spend keeps subscription classes and unknown cost separate from exact free refusals", () => {
  const got = build({ records: [record({ jobId: "paid" }), record({ jobId: "plan", provider: "plan-provider" }), record({ jobId: "unknown", tokens: null }), record({ jobId: "free", tokens: null, exitCode: null, budgetReserved: false })], subscriptions: [{ id: "team", provider: "plan-provider", models: ["*"] }] });
  assert.equal(got.stats.weekRuns, 4);
  assert.equal(got.stats.weekCostMicros, 250000);
  assert.equal(got.stats.costIncomplete, true);
  assert.equal(got.stats.weekCost.floor, true);
  const plan = build({ records: [record({ provider: "plan-provider" })], subscriptions: [{ id: "team", provider: "plan-provider", models: ["*"] }] });
  assert.equal(plan.stats.weekCost.class, "plan");
  assert.equal(plan.stats.weekCost.planId, "team");
  const free = build({ records: [record({ tokens: null, exitCode: null, budgetReserved: false })] });
  assert.equal(free.stats.weekCostMicros, 0);
  assert.equal(free.stats.costIncomplete, false);
});

test("grouping and chips use explicit options while prompt text and secret references never enter list facts", () => {
  const triggers = [rule({ instructions: "PRIVATE PROMPT", task: "PRIVATE TASK", secrets: { TOKEN: "PRIVATE REF" }, extra: "PRIVATE EXTRA", command: "review PRIVATE ARGUMENT" }), rule({ index: 1, type: "cron", id: "nightly", pattern: "0 3 * * *", replicas: 3, resume: true, awaitInput: true, models: ["p/m"], disarmed: { at: "2026-10-01T00:00:00Z", jobId: "gh-spent", other: "PRIVATE DISARM" } }), rule({ index: 2, forge: "gitlab", instructions: true, secrets: 2, secretsProfile: "work", secretBundle: false }), rule({ index: 3, type: "watch" })];
  const got = build({ snapshot: snapshot(triggers), records: [record({ arbitraryText: "PRIVATE RECORD" })] });
  assert.deepEqual(got.groups.map((g) => g.key), ["schedule", "github", "gitlab"]);
  assert.equal(got.counts.all, 3);
  assert.equal(got.counts.watch, 1);
  assert.equal(got.counts.spent, 1);
  assert.ok(got.rows[1].chips.some((c) => c.kind === "costs-more"));
  assert.ok(got.rows[1].chips.some((c) => c.kind === "asks"));
  assert.ok(got.rows[1].chips.some((c) => c.kind === "narrows"));
  assert.ok(got.rows[2].chips.some((c) => c.text === "2 secret variables via work"));
  assert.equal(got.rows[0].trigger.command, "review");
  assert.equal(got.rows[0].trigger.commandArgs, true);
  assert.doesNotMatch(JSON.stringify(got), /PRIVATE/);
});

test("published next fires survive unknown zones, health stays unknown without a scheduler, and a stalled counter wins", () => {
  const cron = rule({ type: "cron", id: "nightly", pattern: "0 3 * * *" });
  const got = build({ snapshot: snapshot([cron], { schedulers: [{ key: "nightly", pattern: "0 3 * * *", next: NOW + 1000 }], schedulerStalls: { nightly: 2 }, schedulerStallMax: 2 }) });
  assert.equal(got.next.at, NOW + 1000);
  assert.equal(got.rows[0].nextFire.health, "on-time");
  assert.equal(got.week.lanes[0].incomplete, true);
  assert.deepEqual(got.week.lanes[0].occurrences, [{ at: NOW + 1000, kind: "scheduled", published: true }]);
  const missing = build({ snapshot: snapshot([cron]) });
  assert.equal(missing.rows[0].nextFire.health, "unknown");
  assert.equal(missing.rows[0].nextFire.stalls, null);
  const stalled = build({ snapshot: snapshot([cron], { schedulerStalls: { nightly: 3 } }) });
  assert.equal(stalled.rows[0].nextFire.health, "stalled");
});

test("schedule projection uses the supplied host zone, supports seconds, crosses DST and caps dense patterns", () => {
  const start = Date.UTC(2026, 9, 30), end = start + 7 * DAY;
  const local = scheduledOccurrences({ pattern: "0 3 * * *", zone: "Europe/Amsterdam", start, end, now: NOW });
  assert.equal(local.occurrences[0].at, Date.UTC(2026, 9, 31, 2));
  const utc = scheduledOccurrences({ pattern: "0 3 * * *", zone: "UTC", start, end, now: NOW });
  assert.equal(utc.occurrences[0].at, Date.UTC(2026, 9, 31, 3));
  const dst = scheduledOccurrences({ pattern: "0 3 * * *", zone: "Europe/Amsterdam", start: Date.UTC(2026, 9, 24), end: Date.UTC(2026, 9, 27), now: Date.UTC(2026, 9, 24) });
  assert.deepEqual(dst.occurrences.map((o) => new Date(o.at).toISOString()), ["2026-10-24T01:00:00.000Z", "2026-10-25T02:00:00.000Z", "2026-10-26T02:00:00.000Z"]);
  const dense = scheduledOccurrences({ pattern: "* * * * * *", zone: "UTC", start, end, now: NOW });
  assert.equal(dense.occurrences.length, TRIGGER_LIST_LIMITS.occurrences);
  assert.equal(dense.incomplete, true);
  assert.equal(dense.occurrences[1].at - dense.occurrences[0].at, 1000);
  assert.equal(scheduledOccurrences({ pattern: "0 3 * * *", zone: null, start, end, now: NOW }).occurrences.length, 0);
});

test("elapsed cron ticks are not painted as observed runs, and only the matching cron record supplies a filled dot", () => {
  const cron = rule({ type: "cron", id: "nightly", pattern: "0 3 * * *" });
  const got = build({ snapshot: snapshot([cron], { schedulers: [{ key: "nightly", pattern: cron.pattern, next: NOW + 15 * 3600_000 }] }), records: [record({ jobId: "repeat:nightly:123", kind: "local" }), record({ jobId: "repeat:other:456", kind: "local" })], scheduleZones: { nightly: "UTC" } });
  const lane = got.week.lanes[0];
  assert.equal(lane.occurrences.filter((o) => o.kind === "ran").length, 1);
  assert.equal(lane.occurrences.find((o) => o.kind === "ran").jobId, "repeat:nightly:123");
  assert.ok(lane.occurrences.filter((o) => o.kind === "scheduled").every((o) => o.at >= NOW));
});

const window = (over = {}) => parsePauseWindows(JSON.stringify({ windows: [{ scope: "github:acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", ...over }] }), "pause-windows.json")[0];

test("quiet bands preserve previous-day overnight qualification and date restrictions with clipped UTC edges", () => {
  const start = Date.UTC(2026, 9, 30), end = start + DAY;
  const w = window({ days: ["thu"], dateFrom: "2026-10-29", dateTo: "2026-10-29" });
  const got = quietIntervals(w, { start, end });
  assert.deepEqual(got.intervals, [{ start, end: Date.UTC(2026, 9, 30, 5) }]);
  const next = quietIntervals(w, { start: end, end: end + DAY });
  assert.deepEqual(next.intervals, []);
  const list = build({ snapshot: snapshot([], { pauseWindows: { windows: [window(), window({ scope: "*" }), window({ scope: "/srv/repo" })] } }) });
  assert.deepEqual(list.week.quiet.map((q) => q.affects), ["forge", "all", "local"]);
  assert.equal(list.week.quiet[0].scope, "github:acme/web");
});

test("formatter-cache projection agrees with the unchanged worker clock through DST gaps/folds and minute boundaries", () => {
  for (const w of [window({ from: "01:30", to: "03:15" }), window({ from: "02:30", to: "04:00" }), window({ tz: "America/New_York", from: "22:00", to: "02:30", days: ["sat", "sun"] })]) {
    const cache = new Map();
    for (const start of [Date.UTC(2026, 2, 29), Date.UTC(2026, 9, 25), Date.UTC(2026, 10, 1)]) {
      for (let minute = 0; minute < 24 * 60; minute += 7) {
        const at = start + minute * 60000;
        assert.equal(windowEndAt(w, at, cache), windowEndAt(w, at), `${w.tz} ${new Date(at).toISOString()}`);
      }
      const intervals = quietIntervals(w, { start, end: start + DAY, formatters: cache }).intervals;
      for (let minute = 0; minute < 24 * 60; minute += 7) {
        const at = start + minute * 60000;
        const until = windowEndAt(w, at);
        assert.equal(intervals.some((band) => band.start <= at && at < band.end), until !== null && until > at);
      }
    }
    assert.equal(cache.size, 1, "each projection reuses exactly its one timezone formatter");
  }
});

test("window and lane bounds disclose their cuts, and unbounded direct interval requests are refused", () => {
  const triggers = Array.from({ length: TRIGGER_LIST_LIMITS.lanes + 1 }, (_, index) => rule({ index, type: "cron", id: `c${index}`, pattern: "0 3 * * *" }));
  const windows = Array.from({ length: TRIGGER_LIST_LIMITS.quietWindows + 1 }, (_, i) => window({ scope: `github:acme/r${i}`, dateTo: "2020-01-01" }));
  const got = build({ snapshot: snapshot(triggers, { pauseWindows: { windows } }) });
  assert.equal(got.week.lanes.length, TRIGGER_LIST_LIMITS.lanes);
  assert.equal(got.week.lanesCut, 1);
  assert.equal(got.week.quiet.length, TRIGGER_LIST_LIMITS.quietWindows);
  assert.equal(got.week.quietCut, 1);
  assert.equal(quietIntervals(window(), { start: NOW, end: NOW + 8 * DAY }).incomplete, true);
});


test("a stale pattern or conflicting queue publications cannot lend a current row a next-fire claim", () => {
  const trigger = rule({ type: "cron", id: "nightly", pattern: "0 3 * * *" });
  for (const schedulers of [[{ key: "nightly", pattern: "0 4 * * *", next: NOW + 1000 }], [{ key: "nightly", pattern: trigger.pattern, next: NOW + 1000 }, { key: "nightly", pattern: trigger.pattern, next: NOW + 2000 }]]) {
    const got = build({ snapshot: snapshot([trigger], { schedulers }), scheduleZones: { nightly: "UTC" } });
    assert.equal(got.rows[0].nextFire.at, null);
    assert.equal(got.rows[0].nextFire.health, "unknown");
    assert.equal(got.rows[0].nextFire.zone, null);
    assert.ok(got.rows[0].nextFire.problem);
    assert.equal(got.next, null);
    assert.equal(got.week.lanes[0].occurrences.length, 0);
  }
});


test("a busy lane retains both observed and projected evidence while disclosing its cap", () => {
  const trigger = rule({ type: "cron", id: "busy", pattern: "* * * * * *" });
  const records = Array.from({ length: 800 }, (_, i) => record({ jobId: `repeat:busy:${i}`, kind: "local", endedAt: new Date(NOW - i * 1000).toISOString() }));
  const got = build({ snapshot: snapshot([trigger], { schedulers: [{ key: "busy", pattern: trigger.pattern, next: NOW + 1000 }] }), records, scheduleZones: { busy: "UTC" } });
  const lane = got.week.lanes[0];
  assert.equal(lane.occurrences.length, TRIGGER_LIST_LIMITS.occurrences);
  assert.ok(lane.occurrences.some((dot) => dot.kind === "ran"));
  assert.ok(lane.occurrences.some((dot) => dot.kind === "scheduled"));
  assert.equal(lane.incomplete, true);
  assert.ok(lane.problem);
});


test("a long selector is visibly cut rather than silently pretending the first names are the entire predicate", () => {
  const got = build({ snapshot: snapshot([rule({ any: Array.from({ length: 65 }, (_, i) => `label-${i}`) })]) });
  assert.equal(got.rows[0].trigger.any.length, 64);
  assert.equal(got.rows[0].trigger.displayCut, true);
  assert.match(got.rows[0].unknown.join(" "), /omitted/);
});


test("projection respects BullMQ's strictly-next boundary while a published tick at now remains real evidence", () => {
  const at = Date.UTC(2026, 9, 30);
  const projected = scheduledOccurrences({ pattern: "0 0 * * *", zone: "UTC", start: at, end: at + 7 * DAY, now: at });
  assert.equal(projected.occurrences[0].at, at + DAY);
  const trigger = rule({ type: "cron", id: "midnight", pattern: "0 0 * * *" });
  const got = build({ now: at, snapshot: snapshot([trigger], { schedulers: [{ key: "midnight", pattern: trigger.pattern, next: at }] }), scheduleZones: { midnight: "UTC" } });
  assert.ok(got.week.lanes[0].occurrences.some((dot) => dot.at === at && dot.published === true));
});

 test("saved row keys cannot distinguish a reused same-kind forge rule, and the view names that limitation", () => {
  const replacement = rule({ any: ["new-selector"], flow: "new-flow" });
  assert.equal(recordMatchesTrigger(record(), replacement), true, "records contain no selector fingerprint; adding a flow check would break real comment flow overrides");
  const got = build({ snapshot: snapshot([replacement]), records: [record()] });
  assert.equal(got.rows[0].stats.runs30d, 1);
  assert.match(got.problems.join(" "), /Editing or renumbering.*older configuration/);
});
 test("schedule owners only pass validated safe names from verified zone evidence", () => {
  const cron = rule({ type: "cron", id: "nightly", pattern: "0 3 * * *" });
  const snap = snapshot([cron], { schedulers: [{ key: "nightly", pattern: cron.pattern, next: NOW + 3600000 }] });
  const got = build({ snapshot: snap, scheduleZones: { nightly: { zone: "UTC", hosts: ["mini1", "build-3", "bad/private", "<unsafe>"] } } });
  assert.deepEqual(got.rows[0].nextFire.hosts, ["mini1", "build-3"]);
  assert.deepEqual(build({ snapshot: snapshot([cron]), scheduleZones: { nightly: { zone: "UTC", hosts: ["mini1"] } } }).rows[0].nextFire.hosts, []);
});

test("portfolio run option survives the safe rule projection and explains its budget-split write chip", () => {
  const got = build({ snapshot: snapshot([rule({ type: "cron", id: "portfolio", pattern: "0 6 * * 1", portfolio: true })]) });
  assert.equal(got.rows[0].trigger.portfolio, true);
  assert.ok(got.rows[0].chips.some(chip => chip.kind === "writes" && chip.text === "budget split"));
  const ordinary = build();
  assert.ok(!ordinary.rows[0].chips.some(chip => chip.text === "budget split"));
});

test("fractional reviewed dollar caps survive projection while invalid money is excluded", () => {
  const got = build({ snapshot: snapshot([rule({ maxCostUsd: 0.25, gateBudgetRaiseUsd: 0.5 })]) });
  assert.equal(got.rows[0].trigger.maxCostUsd, 0.25);
  assert.equal(got.rows[0].trigger.gateBudgetRaiseUsd, 0.5);
  assert.ok(got.rows[0].chips.some(chip => chip.kind === "narrows"));
  for (const value of [-0.5, Infinity, NaN, "0.5"]) {
    const invalid = build({ snapshot: snapshot([rule({ maxCostUsd: value, gateBudgetRaiseUsd: value })]) });
    assert.ok(!Object.hasOwn(invalid.rows[0].trigger, "maxCostUsd"));
    assert.ok(!Object.hasOwn(invalid.rows[0].trigger, "gateBudgetRaiseUsd"));
  }
});
