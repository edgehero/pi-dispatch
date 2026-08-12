import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COST_CLASSES, COSTS_WINDOWS, costsSinceMs, matchesGlob, classifyRow, foldCosts, whatIfFlow, repoOfTarget, foldTriggerCosts } from "../src/costs.mjs";

test("costs.mjs is pure: no fs, no redis, no queue, no env, no console -- records and opinions in, typed dollars out", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/costs.mjs", import.meta.url)), "utf8");
  assert.ok(
    !/readFileSync|\breadFile\b|require\(|import\s+.*node:fs|console\.|process\.env[.[]|ioredis|bullmq/.test(src),
    "the fold must do no I/O and read no env",
  );
  // Budget's dayKey is the ONE permitted worker coupling: the fold's daily buckets and the worker's
  // spend windows must agree on where a UTC day boundary falls, and importing the worker's own key
  // function is how the two sides cannot drift. Everything else -- the pricing facade above all --
  // must arrive as an injected argument, never as a module-scope worker import.
  assert.ok(
    !/@edgehero\/pi-dispatch\/(?!budget\b)/.test(src),
    "the only worker import the fold may hold is @edgehero/pi-dispatch/budget (dayKey)",
  );
});

// ---- fixtures: the record shapes of INT-RUN-HISTORY-FILE-CONTRACT, one per rung of the ladder ----

/** A full record literal, overridable per fixture; defaults are a completed local run. */
function rec(over = {}) {
  return {
    jobId: "j1",
    kind: "local",
    target: "local:repo",
    flow: "fix",
    startedAt: "2026-07-14T09:00:00.000Z",
    endedAt: "2026-07-14T10:00:00.000Z",
    outcome: "completed",
    reason: null,
    exitCode: 0,
    turns: 5,
    tokens: null,
    usage: null,
    provider: null,
    model: null,
    budgetReserved: true,
    attempt: 1,
    parentJobId: null,
    chainDepth: null,
    chainRefused: null,
    replica: null,
    replicas: null,
    session: null,
    ...over,
  };
}

/** The flat per-job totals (`tokens`), process-wide-meter shape unless `metered:false` is forced. */
function tok(cost, { input = 1000, output = 500, unpriced = 0, unresolved = 0, calls = 3 } = {}) {
  return { input, output, total: input + output, cost, metered: true, rootTotal: input + output, otherTotal: 0, looseTotal: 0, sessions: 1, calls, unresolved, unpriced };
}

/** One per-(provider,model) ledger row, `total` following the rows-sum-to-total convention. */
function row(provider, model, { cost = 0, input = 1000, output = 500, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0, reasoning = 0, calls = 2, unpriced = 0 } = {}) {
  return { provider, model, calls, input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning, total: input + output + cacheRead + cacheWrite + cacheWrite1h, cost, unpriced };
}

/** A `usage` ledger block around a set of rows. */
function usage(models, { piAi = "1.2.3", truncated = 0 } = {}) {
  return { v: 1, piAi, truncated, models };
}

// The degradation ladder, newest shape first (all endedAt on 2026-07-14, two days before NOW):
const ledgeredMetered = rec({
  jobId: "led-1",
  endedAt: "2026-07-14T10:00:00.000Z",
  tokens: tok(0.5),
  usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 })]),
  provider: "anthropic",
  model: "claude-sonnet-4",
});
const planCovered = rec({
  jobId: "plan-1",
  endedAt: "2026-07-14T11:00:00.000Z",
  tokens: tok(0, { input: 4_000_000, output: 2_000_000 }),
  usage: usage([row("kimi-coding", "kimi-k2", { cost: 0, input: 4_000_000, output: 2_000_000 })]),
  provider: "kimi-coding",
  model: "kimi-k2",
});
const zeroRatedUnmatched = rec({
  jobId: "zai-1",
  flow: null,
  endedAt: "2026-07-14T12:00:00.000Z",
  tokens: tok(0),
  usage: usage([row("zai", "glm-4.7", { cost: 0 })]),
  provider: "zai",
  model: "glm-4.7",
});
const preLedger = rec({
  jobId: "prelede-1",
  endedAt: "2026-07-14T13:00:00.000Z",
  tokens: tok(0.25),
  usage: null,
  provider: "anthropic",
  model: "claude-sonnet-4",
});
const legacyNoModel = rec({
  jobId: "legacy-1",
  flow: "tidy",
  endedAt: "2026-07-14T14:00:00.000Z",
  tokens: tok(0.125),
  usage: null,
  provider: null,
  model: null,
});
const preTokens = rec({
  jobId: "pre25-1",
  flow: "tidy",
  endedAt: "2026-07-14T15:00:00.000Z",
  tokens: null,
  usage: null,
  provider: null,
  model: null,
});
const floored = rec({
  jobId: "floor-1",
  endedAt: "2026-07-14T16:00:00.000Z",
  tokens: tok(0.5, { unpriced: 2 }),
  usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5, unpriced: 2 })]),
  provider: "anthropic",
  model: "claude-sonnet-4",
});
const retried = rec({
  jobId: "retry-1",
  attempt: 2,
  endedAt: "2026-07-14T17:00:00.000Z",
  tokens: tok(0.25),
  usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.25 })]),
  provider: "anthropic",
  model: "claude-sonnet-4",
});

/**
 * A canned pricing facade (the frozen worker/src/pricing.mjs API), deterministic so every assertion is
 * hand-computable: re-pricing at claude-sonnet-4 charges $10 per million quad tokens, at haiku-cheap
 * $1 per million; glm-4.7 is the zero-rated model; any other target is unpriced (null).
 */
const SONNET = { provider: "anthropic", id: "claude-sonnet-4", cost: { input: 10, output: 10 } };
const GLM = { provider: "zai", id: "glm-4.7", cost: { input: 0, output: 0 } };
function cannedPricing() {
  return {
    listPricedModels: () => [SONNET, GLM],
    getPricedModel: (provider, id) =>
      provider === SONNET.provider && id === SONNET.id ? SONNET : provider === GLM.provider && id === GLM.id ? GLM : null,
    isZeroRated: (model) => model === GLM,
    reprice: (quad, target) => {
      const tokens = quad.input + quad.output + quad.cacheRead + quad.cacheWrite + quad.cacheWrite1h;
      if (target.provider === "anthropic" && target.id === "claude-sonnet-4") return { usd: (tokens / 1e6) * 10, ratesVersion: "1.2.3" };
      if (target.provider === "anthropic" && target.id === "haiku-cheap") return { usd: (tokens / 1e6) * 1, ratesVersion: "1.2.3" };
      return null;
    },
    piAiVersion: () => "1.2.3",
  };
}

/** A normalized subscription entry (the parseSubscriptions output shape), overridable per test. */
function sub(over = {}) {
  return {
    id: "kimi",
    vendor: "Moonshot AI",
    provider: "kimi-coding",
    models: ["*"],
    price: { amount: 90, currency: "USD", per: "month" },
    sharedWithOtherProducts: false,
    hypothetical: false,
    counterfactualModel: { provider: "anthropic", id: "claude-sonnet-4" },
    windows: [],
    ...over,
  };
}

const NOW = Date.parse("2026-07-16T00:00:00.000Z");

function fold(records, { subscriptions = [], nowMs = NOW, piAiPin = "1.2.3", sinceMs = null } = {}) {
  return foldCosts({ records, subscriptions, pricing: cannedPricing(), nowMs, piAiPin, sinceMs });
}

// ---- classification ----

test("COST_CLASSES is the closed class set, and 'free' is not in it", () => {
  assert.deepEqual(COST_CLASSES, ["metered", "plan", "zero-rated", "estimated", "seeded", "unknown"]);
  assert.ok(!COST_CLASSES.includes("free"), "'free' is a claim the fold cannot make");
});

test("matchesGlob: '*' as prefix/suffix/middle, case-insensitive, everything else literal", () => {
  assert.equal(matchesGlob("kimi-k2", "*"), true);
  assert.equal(matchesGlob("claude-sonnet-4", "claude-*"), true, "suffix wildcard");
  assert.equal(matchesGlob("glm-4.7", "*-4.7"), true, "prefix wildcard");
  assert.equal(matchesGlob("kimi-k2-turbo", "kimi-*-turbo"), true, "middle wildcard");
  assert.equal(matchesGlob("Claude-Sonnet-4", "claude-sonnet-4"), true, "case-insensitive");
  assert.equal(matchesGlob("claude-opus", "claude-sonnet-*"), false);
  assert.equal(matchesGlob("kimi-k2", "kimi-k2"), true, "no star -> exact match");
  assert.equal(matchesGlob("kimi-k2", "kimi"), false, "no star -> no implicit prefix");
  assert.equal(matchesGlob("glm.4", "glm.4"), true);
  assert.equal(matchesGlob("glmx4", "glm.4"), false, "a dot in the glob is literal, never a regex any-char");
});

test("classifyRow: owned plan match wins; cost>0 is metered; $0 is zero-rated -- never 'free'", () => {
  const pricing = cannedPricing();
  const subs = [sub()];
  assert.deepEqual(classifyRow(row("kimi-coding", "kimi-k2"), subs, pricing), { class: "plan", planId: "kimi" });
  assert.deepEqual(classifyRow(row("anthropic", "claude-sonnet-4", { cost: 0.5 }), subs, pricing), { class: "metered", planId: null });
  assert.equal(classifyRow(row("zai", "glm-4.7"), subs, pricing).class, "zero-rated", "the rate table itself says zero");
  assert.equal(
    classifyRow(row("someone", "mystery-model"), subs, pricing).class,
    "zero-rated",
    "an unknown model at $0 is zero-rated too -- the honest default, never 'free'",
  );
});

test("classifyRow: a hypothetical plan never classifies -- the row still costs what it costs today", () => {
  const subs = [sub({ hypothetical: true })];
  const r = classifyRow(row("kimi-coding", "kimi-k2"), subs, cannedPricing());
  assert.equal(r.class, "zero-rated");
  assert.equal(r.planId, null);
});

// ---- aggregation: demotion, coverage, floors ----

test("an all-metered bucket stays 'metered'; one plan-covered addend demotes to 'estimated' with run coverage", () => {
  const pure = fold([ledgeredMetered, preLedger, retried]);
  assert.deepEqual(pure.provenance.total, { usd: 1, class: "metered", floor: false });
  const mixed = fold([ledgeredMetered, preLedger, retried, planCovered]);
  assert.equal(mixed.provenance.total.class, "estimated", "one non-metered addend demotes the sum");
  assert.equal(mixed.provenance.total.usd, 1, "the plan-covered run contributes $0 metered to the total");
  assert.equal(mixed.provenance.total.coverage, 3 / 4, "3 of 4 runs contributed metered dollars");
});

test("floor propagation: unpriced calls, the fallback meter, and a pre-#25 record all floor their aggregates", () => {
  const f = fold([ledgeredMetered, floored]);
  assert.equal(f.provenance.total.floor, true, "one floored addend floors the sum");
  assert.equal(f.provenance.total.class, "metered", "floor is orthogonal to class -- both runs are metered");
  assert.equal(f.daily.find((d) => d.day === "2026-07-14").cost.floor, true, "the day bucket holding the floored run is a floor too");

  const fallback = rec({
    jobId: "fb-1",
    tokens: { input: 100, output: 50, total: 150, cost: 0.5, metered: false }, // the subscribe() fallback: 5 keys, no ledger
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  assert.equal(fold([fallback]).provenance.total.floor, true, "metered:false missed subagent/compaction spend -- a floor");

  const pre = fold([preTokens]);
  assert.deepEqual(pre.provenance.total, { usd: 0, class: "estimated", floor: true, coverage: 0 }, "tokens:null spent something and measured nothing");
});

// ---- daily buckets ----

test("daily: UTC dayKey buckets over endedAt -- 23:59Z and 00:01Z land on different days -- with gap days present", () => {
  const nowMs = Date.parse("2026-07-08T12:00:00.000Z");
  const a = rec({ jobId: "a", endedAt: "2026-07-05T23:59:00.000Z", tokens: tok(0.5), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const b = rec({ jobId: "b", endedAt: "2026-07-06T00:01:00.000Z", tokens: tok(0.25), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.25 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const f = fold([a, b], { nowMs });
  assert.deepEqual(f.daily.map((d) => d.day), ["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08"]);
  assert.deepEqual(f.daily.map((d) => d.runs), [1, 1, 0, 0]);
  assert.deepEqual(f.daily[0].cost, { usd: 0.5, class: "metered", floor: false });
  assert.deepEqual(f.daily[1].cost, { usd: 0.25, class: "metered", floor: false });
  assert.deepEqual(f.daily[2].cost, { usd: 0, class: "metered", floor: false }, "a gap day is a zero-run ENTRY, so a sparkline renders quiet days as quiet");
  assert.deepEqual(f.window, { fromMs: Date.parse("2026-07-05T23:59:00.000Z"), toMs: nowMs, days: 3, firstRunMs: Date.parse("2026-07-05T23:59:00.000Z") });
});

test("an empty window folds to the empty shape, not an error", () => {
  const f = fold([]);
  assert.deepEqual(f.window, { fromMs: NOW, toMs: NOW, days: 0, firstRunMs: null });
  assert.deepEqual(f.daily, []);
  assert.deepEqual(f.byFlow, []);
  assert.deepEqual(f.byModel, []);
  assert.deepEqual(f.provenance.total, { usd: 0, class: "metered", floor: false }, "vacuously metered: $0, fully measured");
});

// ---- the requested window (issue #175) ----

test("COSTS_WINDOWS and costsSinceMs: the one window vocabulary, 7d/30d spans and the UTC month edge", () => {
  assert.deepEqual([...COSTS_WINDOWS], ["7d", "30d", "mtd"]);
  const nowMs = Date.parse("2026-07-16T09:30:00.000Z");
  assert.equal(costsSinceMs("7d", nowMs), nowMs - 7 * 24 * 60 * 60 * 1000);
  assert.equal(costsSinceMs("30d", nowMs), nowMs - 30 * 24 * 60 * 60 * 1000);
  assert.equal(costsSinceMs("mtd", nowMs), Date.parse("2026-07-01T00:00:00.000Z"));
});

test("sinceMs denominates proration on the REQUESTED window: the same sparse records flip SAVING to LOSING", () => {
  // One covered run on 2026-07-01, NOW 2026-07-16. Under the first-run derivation days=15, prorated
  // 90*15/30=45 < apiEquiv 60 -> SAVING (the previous test pins that path, sinceMs null). Under the
  // 30d window the operator actually asked about, days=30, prorated 90 > 60 -> LOSING $30. Same runs,
  // same plan: only the denominator got honest.
  const covered = { ...planCovered, endedAt: "2026-07-01T00:00:00.000Z" };
  const sinceMs = NOW - 30 * 24 * 60 * 60 * 1000;
  const f = fold([covered], { subscriptions: [sub()], sinceMs });
  assert.deepEqual(f.window, { fromMs: sinceMs, toMs: NOW, days: 30, firstRunMs: Date.parse("2026-07-01T00:00:00.000Z") });
  assert.equal(f.plans[0].verdict.kind, "LOSING");
  assert.deepEqual(f.plans[0].verdict.usd, { usd: 30, class: "estimated", floor: false }, "90 prorated - 60 api-equivalent");
  // The daily series still starts at the FIRST RUN, not the requested edge: leading zero cells would
  // compress a young deployment's history; firstRunMs lets a renderer pad if it wants the full window.
  assert.equal(f.daily[0].day, "2026-07-01");
});

test("sinceMs edge cases: a future edge clamps to a 1-day window, and an empty requested window keeps its span", () => {
  const future = fold([], { sinceMs: NOW + 5 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(future.window, { fromMs: NOW, toMs: NOW, days: 1, firstRunMs: null });
  const empty = fold([], { sinceMs: NOW - 7 * 24 * 60 * 60 * 1000 });
  assert.equal(empty.window.days, 7, "the operator asked about 7 days; that nothing ran does not shrink the question");
  assert.deepEqual(empty.daily, []);
});

// ---- dailyByFlow (issue #181, the line charts) ----

test("dailyByFlow: every flow gap-padded over the SHARED span, mixed days demoted, keys beside labels", () => {
  const nowMs = Date.parse("2026-07-08T12:00:00.000Z");
  const fixA = rec({ jobId: "a", flow: "fix", endedAt: "2026-07-05T10:00:00.000Z", tokens: tok(0.5), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const fixB = rec({ jobId: "b", flow: "fix", endedAt: "2026-07-07T10:00:00.000Z", tokens: tok(0.25), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.25 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const noflow = rec({ jobId: "c", flow: null, endedAt: "2026-07-06T10:00:00.000Z", tokens: tok(0), usage: usage([row("zai", "glm-4.7", { cost: 0 })]), provider: "zai", model: "glm-4.7" });
  const f = fold([fixA, fixB, noflow], { nowMs });

  assert.deepEqual(f.dailyByFlow.map((r) => [r.flow, r.flowKey]), [["fix", "fix"], ["(no flow)", null]], "window total desc; machine key beside the label, null for the no-flow bucket");
  const days = (r) => r.days.map((d) => d.day);
  assert.deepEqual(days(f.dailyByFlow[0]), ["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08"], "the shared cursor span");
  assert.deepEqual(days(f.dailyByFlow[1]), days(f.dailyByFlow[0]), "EVERY flow shares the x-domain -- multiples are only comparable on one axis");
  const fix = f.dailyByFlow[0];
  assert.deepEqual(fix.days.map((d) => d.runs), [1, 0, 1, 0], "a flow's quiet day is a zero-run entry, exactly as the global series keeps it");
  assert.deepEqual(fix.days[1].cost, { usd: 0, class: "metered", floor: false }, "an empty bucket is vacuously metered $0");
  assert.deepEqual(f.dailyByFlow[1].days[1].cost.class, "estimated", "a zero-rated day demotes like anywhere else");
});

test("dailyByFlow: empty fold folds to [] and the series shares daily's first-run origin", () => {
  assert.deepEqual(fold([]).dailyByFlow, []);
  const sinceMs = NOW - 30 * 24 * 60 * 60 * 1000;
  const one = rec({ jobId: "o", flow: "fix", endedAt: "2026-07-14T10:00:00.000Z", tokens: tok(0.5), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const f = fold([one], { sinceMs });
  assert.equal(f.dailyByFlow[0].days[0].day, f.daily[0].day, "same origin as the global series: no month of leading zero cells");
  assert.equal(f.dailyByFlow[0].days.length, f.daily.length, "same span too");
});

// ---- byFlow ----

test("byFlow groups on flow with '(no flow)' for null, sorts by cost desc, and re-prices covered rows into apiEquiv", () => {
  const f = fold([ledgeredMetered, planCovered, zeroRatedUnmatched], { subscriptions: [sub()] });
  assert.deepEqual(f.byFlow.map((x) => x.flow), ["fix", "(no flow)"]);
  // flowKey is the machine key beside the display label: null for the no-flow bucket, so a what-if
  // filter matching `flow ?? null` can target it -- the display label matches no record (issue #175).
  assert.deepEqual(f.byFlow.map((x) => x.flowKey), ["fix", null]);
  const fix = f.byFlow[0];
  assert.equal(fix.runs, 2);
  assert.equal(fix.tokens, 1500 + 6_000_000);
  assert.equal(fix.cost.usd, 0.5);
  assert.equal(fix.cost.class, "estimated", "one plan addend demotes the flow sum");
  assert.deepEqual(fix.apiEquiv, { usd: 60, class: "estimated", floor: false }, "6M covered tokens at the declared counterfactual ($10/M)");
  const noflow = f.byFlow[1];
  assert.equal(noflow.apiEquiv, null, "no covered rows -> nothing to re-price");
  assert.equal(noflow.cost.class, "estimated");
  assert.equal(noflow.cost.coverage, 0, "a purely zero-rated flow contributed no metered dollars");
});

// ---- byModel ----

test("byModel attribution ladder: ledger rows, whole-run fallback via record.provider/model, then ('unknown','unknown')", () => {
  const f = fold([ledgeredMetered, preLedger, legacyNoModel, planCovered, zeroRatedUnmatched], { subscriptions: [sub()] });
  assert.deepEqual(
    f.byModel.map((m) => `${m.provider}/${m.model}`),
    ["anthropic/claude-sonnet-4", "unknown/unknown", "kimi-coding/kimi-k2", "zai/glm-4.7"],
    "sorted by cost desc, ties alphabetical",
  );
  const [sonnet, unknown, kimi, zai] = f.byModel;
  assert.equal(sonnet.runs, 2, "the ledgered run and the pre-ledger whole-run fallback");
  assert.equal(sonnet.calls, 2 + 3, "ledger row calls plus the pre-ledger run's flat tokens.calls");
  assert.equal(sonnet.tokens, 3000);
  assert.deepEqual(sonnet.cost, { usd: 0.75, class: "metered", floor: false });
  assert.deepEqual(unknown.cost, { usd: 0.125, class: "metered", floor: false }, "a legacy record with no provider/model attributes to ('unknown','unknown'), never to a guess");
  assert.deepEqual(kimi.cost, { usd: 0, class: "plan", floor: false, planId: "kimi" });
  assert.deepEqual(zai.cost, { usd: 0, class: "zero-rated", floor: false }, "zero-rated, not 'free'");
});

// ---- byTrigger / byRepo / foldTriggerCosts (issue #175) ----

test("byTrigger buckets on the passed-in join; chained/manual/unattributed are explicit and pinned to the tail", () => {
  const cronRun = rec({ jobId: "repeat:nightly:1752480000000", flow: "fix", tokens: tok(0.5), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const forgeRun = rec({ jobId: "gh-1", kind: "github", target: "acme/api#12", flow: "triage", outcome: "failed", tokens: tok(0.25), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.25 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const refusedJoin = rec({ jobId: "gh-2", kind: "github", target: "acme/api#13", flow: "triage", tokens: tok(0.05), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.05 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const chained = rec({ jobId: "ch-1", parentJobId: "repeat:nightly:1752480000000", flow: "fix", tokens: tok(0.1), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.1 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const manual = rec({ jobId: "loc-1", tokens: tok(0.02), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.02 })]), provider: "anthropic", model: "claude-sonnet-4" });
  // The join is the read-model's job (attributeRunsToTriggers); the fold's contract is this SHAPE.
  const triggerJoin = {
    byJobId: {
      "repeat:nightly:1752480000000": { key: "trigger:0", index: 0, type: "cron", label: "nightly 0 3 * * *" },
      "gh-1": { key: "trigger:2", index: 2, type: "label", label: "any[dispatch]" },
      "gh-2": { key: "unattributed", index: null, type: null, label: null },
    },
  };
  const f = foldCosts({ records: [manual, chained, refusedJoin, forgeRun, cronRun], subscriptions: [], pricing: cannedPricing(), nowMs: NOW, triggerJoin });

  assert.deepEqual(
    f.byTrigger.map((t) => t.key),
    ["trigger:0", "trigger:2", "chained", "manual", "unattributed"],
    "real triggers by cost desc, then the honesty tail in its fixed order however the dollars compare",
  );
  const [nightly, label, chainedRow, manualRow, unattributed] = f.byTrigger;
  assert.equal(nightly.label, "nightly 0 3 * * *");
  assert.deepEqual(nightly.outcomes, { completed: 1, policy: 0, failed: 0 });
  assert.equal(nightly.failedCost, null, "no failed member, no failed figure -- null, not $0.00");
  assert.deepEqual(nightly.cost, { usd: 0.5, class: "metered", floor: false });
  assert.deepEqual(label.outcomes, { completed: 0, policy: 0, failed: 1 });
  assert.deepEqual(label.failedCost, { usd: 0.25, class: "metered", floor: false }, "what the trigger's failures cost, typed like every dollar");
  assert.equal(chainedRow.label, "(chained runs)");
  assert.equal(manualRow.label, "(manual/local)");
  assert.equal(unattributed.label, "(unattributed)");
  assert.equal(unattributed.runs, 1, "a refused join stays visible, never blended into manual");

  assert.equal(fold([cronRun]).byTrigger, null, "no join wired -> null, because 'not computed' and 'nothing attributed' are different sentences");
});

test("byRepo groups on the stripped target; local targets ride whole and a missing target is its own stated bucket", () => {
  const gh1 = rec({ jobId: "r1", kind: "github", target: "acme/api#12", tokens: tok(0.5), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const gh2 = rec({ jobId: "r2", kind: "github", target: "acme/api#34", tokens: tok(0.25), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.25 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const gl = rec({ jobId: "r3", kind: "gitlab", target: "group/proj!3", tokens: tok(0.1), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.1 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const local = rec({ jobId: "r4", target: "local:site", tokens: tok(0.05), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.05 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const bare = rec({ jobId: "r5", target: null, tokens: tok(0.01), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.01 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const f = fold([gh1, gh2, gl, local, bare]);
  assert.deepEqual(
    f.byRepo.map((r) => [r.label, r.runs, r.kind]),
    [
      ["acme/api", 2, "github"],
      ["group/proj", 1, "gitlab"],
      ["local:site", 1, "local"],
      ["(no target)", 1, "local"],
    ],
    "cost desc; the issue/MR tail stripped; a target-less record is stated, not dropped",
  );
  assert.equal(f.byRepo[0].cost.usd, 0.75);
  assert.equal(f.byRepo[3].key, null, "machine key null for the no-target bucket -- the flowKey lesson");
});

test("repoOfTarget strips exactly the forge issue/MR tail and nothing else", () => {
  assert.equal(repoOfTarget("acme/api#12"), "acme/api");
  assert.equal(repoOfTarget("group/proj!3"), "group/proj");
  assert.equal(repoOfTarget("local:site"), "local:site", "no numeric tail: rides through whole");
  assert.equal(repoOfTarget("acme/api"), "acme/api");
  assert.equal(repoOfTarget(""), null);
  assert.equal(repoOfTarget(null), null);
  assert.equal(repoOfTarget("#12"), null, "a bare tail strips to nothing and nothing is null, not an empty-string bucket");
});

test("foldTriggerCosts maps ONLY real triggers, keyed by the graph node id", () => {
  const cronRun = rec({ jobId: "repeat:nightly:1752480000000", tokens: tok(0.5), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const cronRun2 = rec({ jobId: "repeat:nightly:1752483600000", tokens: tok(0.25), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.25 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const manual = rec({ jobId: "loc-1", tokens: tok(1), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 1 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const refused = rec({ jobId: "gh-2", kind: "github", tokens: tok(1), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 1 })]), provider: "anthropic", model: "claude-sonnet-4" });
  const triggerJoin = {
    byJobId: {
      "repeat:nightly:1752480000000": { key: "trigger:3", index: 3, type: "cron", label: "nightly 0 3 * * *" },
      "repeat:nightly:1752483600000": { key: "trigger:3", index: 3, type: "cron", label: "nightly 0 3 * * *" },
      "gh-2": { key: "unattributed", index: null, type: null, label: null },
    },
  };
  const map = foldTriggerCosts({ records: [cronRun, cronRun2, manual, refused], subscriptions: [], pricing: cannedPricing(), triggerJoin });
  assert.deepEqual(Object.keys(map), ["trigger:3"], "honesty buckets have no node to badge and stay out of the map");
  assert.equal(map["trigger:3"].runs, 2);
  assert.deepEqual(map["trigger:3"].cost, { usd: 0.75, class: "metered", floor: false });
});

// ---- plans ----

test("plan verdicts: SAVING/LOSING (owned, via counterfactual), WOULD_SAVE/WOULD_LOSE (hypothetical, via actual cost), NO_BASELINE", () => {
  // 15 days of window against a 30-day month proxy: prorated = 90 * 15/30 = 45, exactly.
  const covered = { ...planCovered, endedAt: "2026-07-01T00:00:00.000Z" };
  const saving = fold([covered], { subscriptions: [sub()] });
  assert.equal(saving.window.days, 15);
  assert.deepEqual(saving.plans[0].apiEquiv, { usd: 60, class: "estimated", floor: false }, "6M covered tokens at sonnet's $10/M");
  assert.equal(saving.plans[0].verdict.kind, "SAVING");
  assert.deepEqual(saving.plans[0].verdict.usd, { usd: 15, class: "estimated", floor: false }, "60 api-equivalent - 45 prorated");

  const losing = fold([covered], { subscriptions: [sub({ counterfactualModel: { provider: "anthropic", id: "haiku-cheap" } })] });
  assert.equal(losing.plans[0].verdict.kind, "LOSING");
  assert.deepEqual(losing.plans[0].verdict.usd, { usd: 39, class: "estimated", floor: false }, "45 prorated - 6 at the cheap counterfactual");

  // Hypothetical: the SAME attribution (provider+glob), scored against the rows' ACTUAL metered cost.
  const spend = rec({
    jobId: "hyp-1",
    endedAt: "2026-07-01T00:00:00.000Z",
    tokens: tok(60, { input: 4_000_000, output: 2_000_000 }),
    usage: usage([row("anthropic", "claude-sonnet-4", { cost: 60, input: 4_000_000, output: 2_000_000 })]),
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  const whatIf = { id: "max", provider: "anthropic", models: ["claude-*"], hypothetical: true, counterfactualModel: null };
  const wouldSave = fold([spend], { subscriptions: [sub(whatIf)] });
  assert.equal(wouldSave.plans[0].attributedRuns, 1, "hypothetical plans attribute the same rows an owned one would");
  assert.equal(wouldSave.plans[0].verdict.kind, "WOULD_SAVE");
  assert.deepEqual(wouldSave.plans[0].verdict.usd, { usd: 15, class: "estimated", floor: false }, "actual 60 today vs 45 prorated");

  const cheapSpend = { ...spend, tokens: tok(6, { input: 4_000_000, output: 2_000_000 }), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 6, input: 4_000_000, output: 2_000_000 })]) };
  const wouldLose = fold([cheapSpend], { subscriptions: [sub(whatIf)] });
  assert.equal(wouldLose.plans[0].verdict.kind, "WOULD_LOSE");
  assert.deepEqual(wouldLose.plans[0].verdict.usd, { usd: 39, class: "estimated", floor: false }, "45 prorated vs actual 6 today");

  // No counterfactual on an OWNED plan: no API-rate baseline exists, and none is invented.
  const noBase = fold([covered], { subscriptions: [sub({ counterfactualModel: null })] });
  assert.equal(noBase.plans[0].apiEquiv, null);
  assert.deepEqual(noBase.plans[0].verdict, { kind: "NO_BASELINE", usd: null });

  // ...and a plan with nothing attributed has nothing to verdict either.
  const idle = fold([], { subscriptions: [sub()] });
  assert.deepEqual(idle.plans[0].verdict, { kind: "NO_BASELINE", usd: null });
  assert.equal(idle.plans[0].attributedRuns, 0);
  assert.equal(idle.plans[0].amortizedPerRun, null);
});

test("plan attribution: run/token tallies, amortization, and the pre-ledger run EXCLUDED from apiEquiv", () => {
  const covered = { ...planCovered, endedAt: "2026-07-01T00:00:00.000Z" };
  const coveredNoLedger = rec({
    jobId: "plan-2",
    endedAt: "2026-07-02T00:00:00.000Z",
    tokens: tok(0),
    usage: null,
    provider: "kimi-coding",
    model: "kimi-k2",
  });
  const f = fold([covered, coveredNoLedger], { subscriptions: [sub()] });
  const plan = f.plans[0];
  assert.equal(plan.id, "kimi");
  assert.equal(plan.vendor, "Moonshot AI");
  assert.equal(plan.hypothetical, false);
  assert.deepEqual(plan.price, { amount: 90, currency: "USD", per: "month" });
  assert.equal(plan.attributedRuns, 2);
  assert.equal(plan.attributedTokens, 6_000_000 + 1500);
  assert.deepEqual(plan.amortizedPerRun, { usd: 22.5, class: "estimated", floor: false }, "prorated 45 across 2 attributed runs");
  // The un-ledgered covered run is EXCLUDED from apiEquiv -- an api-equivalent back-derived from flat
  // totals would be a guess -- and its exclusion makes the number a floor; it surfaces in provenance.
  assert.deepEqual(plan.apiEquiv, { usd: 60, class: "estimated", floor: true });
  assert.equal(f.provenance.runsUnledgered, 1);

  // An owned plan whose only covered runs are pre-ledger has no re-priceable row at all: no baseline.
  const only = fold([coveredNoLedger], { subscriptions: [sub()] });
  assert.equal(only.plans[0].apiEquiv, null);
  assert.equal(only.plans[0].verdict.kind, "NO_BASELINE");
});

test("peak windows: a rolling 5h window takes a true sliding max; non-rolling approximates at day grain; limits are FACTS ONLY", () => {
  const windows = [
    { per: "5h", rolling: true, unit: "prompts", limit: 200, scope: null },
    { per: "5h", rolling: false, unit: null, limit: null, scope: null },
  ];
  const at = (jobId, iso) =>
    rec({
      jobId,
      endedAt: iso,
      tokens: tok(0, { input: 800, output: 200 }),
      usage: usage([row("kimi-coding", "kimi-k2", { cost: 0, input: 800, output: 200 })]),
      provider: "kimi-coding",
      model: "kimi-k2",
    });
  const f = fold(
    [at("w1", "2026-07-14T00:00:00.000Z"), at("w2", "2026-07-14T01:00:00.000Z"), at("w3", "2026-07-14T06:00:00.000Z")],
    { subscriptions: [sub({ windows })] },
  );
  const [rolling, calendar] = f.plans[0].windows;
  assert.equal(rolling.peakRuns, 2, "00:00 and 01:00 share a 5h window; 06:00 does not");
  assert.equal(rolling.peakTokens, 2000);
  assert.equal(rolling.limit, 200, "the declared limit rides through verbatim");
  assert.equal(rolling.unit, "prompts");
  assert.equal(calendar.peakRuns, 3, "non-rolling 5h approximates at day grain -- an over-count, never an undercount");
  assert.equal(calendar.limit, null, "null = vendor undisclosed, still verbatim");
  assert.ok(!("remaining" in rolling) && !("burnDown" in rolling), "peaks are FACTS; no remaining/burn-down is ever computed");
});

// ---- provenance ----

test("provenance: run tallies, and ratesDrifted counts records priced by a different pi-ai than the pin", () => {
  const drifted = {
    ...ledgeredMetered,
    jobId: "drift-1",
    usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 })], { piAi: "1.0.0" }),
  };
  const f = fold([ledgeredMetered, drifted, preLedger, preTokens], { piAiPin: "1.2.3" });
  assert.equal(f.provenance.runsTotal, 4);
  assert.equal(f.provenance.runsUnmetered, 1, "pre-#25: tokens null");
  assert.equal(f.provenance.runsUnledgered, 1, "pre-ledger: tokens but no usage");
  assert.equal(f.provenance.ratesDrifted, 1);
  assert.equal(f.provenance.piAiPin, "1.2.3");
  const unpinned = fold([drifted], { piAiPin: null });
  assert.equal(unpinned.provenance.ratesDrifted, 0, "an unknown pin cannot accuse a record of drifting");
});

test("provenance: runsLedgerTruncated counts runs whose ledger folded rows into `other` past the 8-row cap", () => {
  const truncated = {
    ...ledgeredMetered,
    jobId: "trunc-1",
    usage: usage([row("anthropic", "claude-sonnet-4", { cost: 0.5 }), row("other", "other", { cost: 0.1 })], { truncated: 3 }),
  };
  const f = fold([ledgeredMetered, truncated]);
  assert.equal(f.provenance.runsLedgerTruncated, 1, "the run's per-model attribution is partly anonymous and the fold says so");
  assert.equal(fold([ledgeredMetered]).provenance.runsLedgerTruncated, 0);
});

// ---- whatIfFlow ----

test("whatIfFlow: median per-run quad (outlier-resistant) repriced at the target; coverage counts ledgered runs", () => {
  const mk = (jobId, input) =>
    rec({
      jobId,
      endedAt: "2026-07-14T10:00:00.000Z",
      tokens: tok(1, { input, output: 0 }),
      usage: usage([row("anthropic", "claude-sonnet-4", { cost: 1, input, output: 0 })]),
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
  const unledgered = rec({ jobId: "u1", tokens: tok(1), usage: null, provider: "anthropic", model: "claude-sonnet-4" });
  const res = whatIfFlow({
    records: [mk("m1", 100_000), mk("m2", 125_000), mk("m3", 1_000_000), unledgered],
    flow: "fix",
    target: { provider: "anthropic", id: "claude-sonnet-4" },
    pricing: cannedPricing(),
  });
  assert.equal(res.class, "estimated");
  assert.equal(res.perRun, 1.25, "median input 125k at $10/M -- the 1M outlier run does not move the estimate");
  assert.equal(res.usd, 5, "per-run estimate times ALL 4 observed runs of the flow");
  assert.equal(res.coverage, 0.75);
  assert.equal(res.excluded, 1, "the un-ledgered run is excluded from the median, counted here instead");
  assert.equal(res.ratesVersion, "1.2.3");
});

test("whatIfFlow: no ledgered runs -> the OQ-002 seeded band, times observed runs, or per-run when the flow never ran", () => {
  const unledgered = rec({ jobId: "u1", flow: "mystery", tokens: tok(1), usage: null });
  const twice = [unledgered, { ...unledgered, jobId: "u2" }];
  assert.deepEqual(
    whatIfFlow({ records: twice, flow: "mystery", target: { provider: "anthropic", id: "claude-sonnet-4" }, pricing: cannedPricing() }),
    { class: "seeded", low: 1, high: 10, note: "unmeasured (OQ-002)" },
  );
  assert.deepEqual(
    whatIfFlow({ records: [], flow: "never-ran", target: { provider: "anthropic", id: "claude-sonnet-4" }, pricing: cannedPricing() }),
    { class: "seeded", low: 0.5, high: 5, note: "unmeasured (OQ-002)" },
  );
});

test("whatIfFlow: an unpriced target degrades to the seeded band rather than emitting a $0 that looks like an answer", () => {
  const m = rec({ jobId: "m1", tokens: tok(1), usage: usage([row("anthropic", "claude-sonnet-4", { cost: 1 })]) });
  assert.deepEqual(
    whatIfFlow({ records: [m], flow: "fix", target: { provider: "nobody", id: "no-model" }, pricing: cannedPricing() }),
    { class: "seeded", low: 0.5, high: 5, note: "unmeasured (OQ-002)" },
  );
});
