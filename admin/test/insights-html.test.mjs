import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildInsightsHtml, layoutDailyChart, layoutBarList, layoutFlowLines, layoutCumulative, INSIGHTS_COST_CLASSES } from "../src/insights-html.mjs";
import { buildGraphModel } from "../src/graph-model.mjs";
import { COST_CLASSES } from "../src/costs.mjs";

const NOW = 1770000000000;

// The same canned deployment graph-html.test.mjs uses (inlined, not imported: test files do not
// import each other), built THROUGH buildGraphModel so the topology half of this page is exercised
// against the assembler's real output shape.
const CANNED = () => ({
  triggers: {
    triggers: [
      { type: "cron", index: 0, id: "nightly", pattern: "0 3 * * *", folder: "/srv/site", flow: "build-report", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
      { type: "label", index: 1, any: ["ai"], all: [], none: [], flow: "triage", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
      { type: "cron", index: 2, id: "gone", pattern: "0 4 * * *", folder: "/srv/site", flow: "deleted-flow", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
    ],
  },
  schedulers: [{ key: "nightly", name: "nightly", pattern: "0 3 * * *", every: null, next: "2026-08-12T03:00:00.000Z", overdueMs: null }],
  folderSkills: {
    "/srv/site": {
      head: "abc123",
      truncated: false,
      unreachable: null,
      skills: [
        { name: "build-report", isSub: false, group: null, aiTrigger: true, meta: { name: "build-report", description: "d" }, mentions: [{ name: "notify", strong: true }], loops: [{ hint: "until the report renders right" }], unread: false },
        { name: "notify", isSub: false, group: null, aiTrigger: true, meta: null, mentions: [], unread: false },
        { name: "old-import", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false },
        { name: "group/sub", isSub: true, group: "group", aiTrigger: false, meta: null, mentions: [], unread: false },
        { name: "group", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false },
      ],
    },
  },
  injectedSkills: { "/inj": { skills: [{ name: "tidy", aiTrigger: true }], truncated: false, unreachable: null } },
  forgeRepos: { github: ["acme/website", "acme/api"] },
  cronStats: { byId: { nightly: { runs: 41, lastOutcome: "completed", lastEndedAt: "2026-08-11T00:00:00.000Z" }, gone: { runs: 0, lastOutcome: null, lastEndedAt: null } } },
  runJoin: { byIndex: { 1: { runs: 12, lastOutcome: "completed", lastEndedAt: "2026-08-11T01:00:00.000Z" } }, unattributed: 2 },
  chainEdges: { edges: [{ parentFlow: "build-report", childFlow: "notify", target: "local:site", count: 3, lastEndedAt: "2026-08-10T00:00:00.000Z" }], refusals: { "build-report": 1 }, truncated: false },
  caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
  nowMs: NOW,
});

/** A typed dollar literal (the costs.mjs shape): the fold is hand-built rather than run, because
 * this page's contract is the SHAPES foldCosts documents, and canned literals keep every dollar
 * assertion hand-computable. */
const usd = (n, cls, over = {}) => ({ usd: n, class: cls, floor: false, ...over });

/**
 * One realistic canned fold: an owned SAVING plan with a null-limit rolling window plus a range
 * window, a hypothetical WOULD_LOSE plan with a numeric limit, a daily series with a zero-run gap
 * day and a floored estimated day, byFlow with a plan row + metered row + apiEquiv, byModel with a
 * zero-rated row, byTrigger with real trigger rows + honesty tail rows + a failedCost, byRepo, and
 * a provenance with every counter nonzero.
 */
const CANNED_FOLD = () => ({
  window: { fromMs: Date.parse("2026-07-20T00:00:00.000Z"), toMs: Date.parse("2026-08-01T00:00:00.000Z"), days: 12, firstRunMs: Date.parse("2026-07-29T10:00:00.000Z") },
  daily: [
    { day: "2026-07-29", cost: usd(1.1, "metered"), runs: 3 },
    { day: "2026-07-30", cost: usd(0, "metered"), runs: 0 }, // the gap day: zero runs, never compressed away
    { day: "2026-07-31", cost: usd(3.1, "estimated", { coverage: 0.5, floor: true }), runs: 4 },
  ],
  dailyByFlow: [
    {
      flow: "fix",
      flowKey: "fix",
      days: [
        { day: "2026-07-29", cost: usd(0.9, "metered"), runs: 2 },
        { day: "2026-07-30", cost: usd(0, "metered"), runs: 0 },
        { day: "2026-07-31", cost: usd(2.4, "estimated", { coverage: 0.5, floor: true }), runs: 3 },
      ],
    },
    {
      flow: "tidy",
      flowKey: "tidy",
      days: [
        { day: "2026-07-29", cost: usd(0.2, "metered"), runs: 1 },
        { day: "2026-07-30", cost: usd(0, "metered"), runs: 0 },
        { day: "2026-07-31", cost: usd(0.7, "metered"), runs: 1 },
      ],
    },
  ],
  byFlow: [
    { flow: "fix", flowKey: "fix", runs: 12, tokens: 5400000, cost: usd(0, "plan", { planId: "kimi" }), apiEquiv: usd(44.49, "estimated") },
    { flow: "tidy", flowKey: "tidy", runs: 3, tokens: 90000, cost: usd(1.25, "metered"), apiEquiv: null },
  ],
  byModel: [
    { provider: "kimi-coding", model: "kimi-k2", runs: 12, calls: 24, input: 4000000, output: 1400000, cacheRead: 0, cacheWrite: 0, tokens: 5400000, cost: usd(0, "plan", { planId: "kimi" }) },
    { provider: "anthropic", model: "claude-sonnet-4", runs: 3, calls: 6, input: 60000, output: 30000, cacheRead: 0, cacheWrite: 0, tokens: 90000, cost: usd(1.25, "metered") },
    { provider: "zai", model: "glm-4.7", runs: 1, calls: 1, input: 800, output: 200, cacheRead: 0, cacheWrite: 0, tokens: 1000, cost: usd(0, "zero-rated") },
  ],
  byTrigger: [
    { key: "trigger:0", index: 0, type: "cron", label: "nightly 0 3 * * *", runs: 9, tokens: 4000000, cost: usd(0, "plan", { planId: "kimi" }), outcomes: { completed: 9, policy: 0, failed: 0 }, failedCost: null },
    { key: "trigger:1", index: 1, type: "label", label: "any[ai]", runs: 3, tokens: 90000, cost: usd(1.25, "metered"), outcomes: { completed: 2, policy: 0, failed: 1 }, failedCost: usd(0.4, "metered") },
    { key: "chained", index: null, type: null, label: "(chained runs)", runs: 2, tokens: 200000, cost: usd(0.2, "metered"), outcomes: { completed: 2, policy: 0, failed: 0 }, failedCost: null },
    { key: "manual", index: null, type: null, label: "(manual/local)", runs: 2, tokens: 1000, cost: usd(0, "zero-rated"), outcomes: { completed: 2, policy: 0, failed: 0 }, failedCost: null },
  ],
  byRepo: [
    { key: "acme/api", label: "acme/api", kind: "github", runs: 12, tokens: 5400000, cost: usd(0, "plan", { planId: "kimi" }) },
    { key: "local:site", label: "local:site", kind: "local", runs: 4, tokens: 91000, cost: usd(1.25, "metered") },
  ],
  plans: [
    {
      id: "kimi",
      vendor: "Moonshot AI",
      hypothetical: false,
      price: { amount: 99, currency: "USD", per: "month" },
      attributedRuns: 12,
      attributedTokens: 5400000,
      amortizedPerRun: usd(3.3, "estimated"),
      apiEquiv: usd(44.49, "estimated"),
      verdict: { kind: "SAVING", usd: usd(4.89, "estimated") },
      windows: [
        { per: "5h", rolling: true, unit: "tokens", limit: null, peakRuns: 4, peakTokens: 1200000 },
        { per: "7d", rolling: true, unit: "tokens", limit: [1000000, 2000000], peakRuns: 9, peakTokens: 3000000 },
      ],
    },
    {
      id: "zai-max",
      vendor: "Z.ai",
      hypothetical: true,
      price: { amount: 15, currency: "USD", per: "month" },
      attributedRuns: 1,
      attributedTokens: 1000,
      amortizedPerRun: usd(6, "estimated"),
      apiEquiv: null,
      verdict: { kind: "WOULD_LOSE", usd: usd(2.4, "estimated") },
      windows: [{ per: "month", rolling: false, unit: "tokens", limit: 5000000, peakRuns: 1, peakTokens: 1000 }],
    },
  ],
  provenance: {
    total: usd(4.45, "estimated", { floor: true, coverage: 0.5 }),
    runsTotal: 16,
    runsUnmetered: 1,
    runsUnledgered: 2,
    runsLedgerTruncated: 1,
    ratesDrifted: 1,
    piAiPin: "0.9.7",
  },
});

const CANNED_BUDGET = () => ({
  unreachable: null,
  softHoldPct: 20,
  day: { reserved: 3, cap: 25, state: "ok" },
  week: { reserved: 4, cap: null, state: "ok" }, // cap in the worker's env, unknown to the admin
  month: { reserved: 9, cap: 40, state: "soft-hold" },
  tokens: { spent: 5400000, cap: 8000000, state: "ok", maxTokens: 200000 },
});

const CANNED_PAYLOAD = () => ({
  graph: buildGraphModel(CANNED()),
  fold: CANNED_FOLD(),
  costsUnreachable: null,
  window: "30d",
  costByTrigger: {
    "trigger:0": { cost: usd(0, "plan", { planId: "kimi" }), runs: 9 },
    "trigger:1": { cost: usd(1.25, "estimated", { coverage: 0.5 }), runs: 3 },
  },
  budget: CANNED_BUDGET(),
});

const cannedHtml = () => buildInsightsHtml(CANNED_PAYLOAD(), { now: NOW });

// ---- 1. purity / import allowlist ----

test("insights-html.mjs imports only graph-html and panel, and reads no clock, randomness or environment", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/insights-html.mjs", import.meta.url)), "utf8");
  const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...specs].sort(), ["./graph-html.mjs", "./panel.mjs"], "exactly the two sanctioned imports, nothing else");
  assert.ok(!src.includes("require("), "no CJS loads");
  assert.ok(!src.includes("Date.now"), "the generation instant is injected as `now`, never read");
  assert.ok(!src.includes("Math.random"), "determinism is a test below");
  assert.ok(!/process\./.test(src), "no environment access");
  assert.ok(!src.includes("node:"), "no builtins, not even for a comment to name");
  assert.ok(!src.includes("readFileSync"), "no filesystem");
  assert.ok(!src.includes("innerHTML"), "the page script assigns text only");
});

// ---- 2. class parity vs the fold ----

test("INSIGHTS_COST_CLASSES is costs.mjs's COST_CLASSES byte for byte, frozen", () => {
  // The module may not import costs.mjs (that would drag in the worker's day bucketing), so this
  // deepEqual IS the anti-drift wire: a class minted in the fold without a drawing arm here goes
  // red instead of rendering as "unknown".
  assert.deepEqual([...INSIGHTS_COST_CLASSES], [...COST_CLASSES]);
  assert.ok(Object.isFrozen(INSIGHTS_COST_CLASSES));
});

// ---- 3. escaping / breakout ----

test("hostile flow, plan, repo, trigger and day strings cannot break out of markup or the json", () => {
  const payload = CANNED_PAYLOAD();
  payload.fold.byFlow[0].flow = '"><script>alert(1)</script>';
  payload.fold.byFlow[0].cost.planId = "</script><script>";
  payload.fold.plans[0].id = "</script><script>";
  payload.fold.byRepo[0].label = 'acme" onmouseover="alert(2)';
  payload.fold.byTrigger[1].label = "</script><script>evil()";
  // A hostile day string is not escaped but DROPPED: a day is an axis coordinate, and a non-date
  // coordinate has nowhere truthful to draw. The $77 canary proves the whole entry went with it.
  payload.fold.daily.push({ day: '"><script>', cost: usd(77, "metered"), runs: 1 });
  const out = buildInsightsHtml(payload, { now: NOW });

  assert.equal(out.split("<script").length - 1, 1, "exactly ONE script open tag: the page's own");
  assert.equal(out.split("</script").length - 1, 1, "and exactly one close: nothing embedded can spell it");
  assert.ok(!out.includes("<script>alert"), "the attack string never appears unescaped");
  assert.ok(out.includes("&lt;script&gt;") || out.includes("&lt;/script&gt;"), "it appears as entities instead");
  assert.ok(out.includes("\\u003c"), "the embedded json carries < as an escape, never a literal");
  assert.ok(!out.includes("$77.00"), "the malformed-day entry is dropped whole, cost and all");
});

// ---- 4. determinism ----

test("same payload + same now is byte-identical, and every input array order is irrelevant", () => {
  assert.equal(cannedHtml(), cannedHtml());

  const base = buildInsightsHtml(CANNED_PAYLOAD(), { now: NOW });
  const p = CANNED_PAYLOAD();
  p.fold.daily.reverse();
  p.fold.byFlow.reverse();
  p.fold.byModel.reverse();
  p.fold.byTrigger.reverse();
  p.fold.byRepo.reverse();
  p.fold.plans.reverse();
  p.fold.plans.find((pl) => pl.id === "kimi").windows.reverse();
  p.graph.nodes.reverse();
  p.graph.edges.reverse();
  p.graph.flags.reverse();
  p.graph.folders.reverse();
  p.costByTrigger = Object.fromEntries(Object.entries(p.costByTrigger).reverse());
  p.fold.dailyByFlow.reverse();
  for (const r of p.fold.dailyByFlow) r.days.reverse();
  p.budget = Object.fromEntries(Object.entries(p.budget).reverse());
  assert.equal(buildInsightsHtml(p, { now: NOW }), base, "normalisation re-sorts everything; a permuted payload may not move a byte");
});

// ---- 5. well-formedness smoke ----

test("balanced markup, finite numbers everywhere, path grammar, and labelled chart svgs", () => {
  const out = cannedHtml();
  assert.equal(out.split("<svg").length, out.split("</svg>").length, "balanced <svg>");
  assert.equal((out.match(/<g[ >]/g) ?? []).length, (out.match(/<\/g>/g) ?? []).length, "balanced <g>");
  for (const word of ["NaN", "undefined", "Infinity"]) {
    assert.ok(!out.includes(word), `a non-finite value leaked into the page as ${word}`);
  }
  const vbs = [...out.matchAll(/viewBox="([^"]+)"/g)];
  assert.ok(vbs.length >= 1, "the topology svg carries a viewBox");
  for (const [, vb] of vbs) {
    const nums = vb.split(" ").map(Number);
    assert.equal(nums.length, 4);
    assert.ok(nums.every(Number.isFinite), "every viewBox is four finite numbers");
  }
  for (const [, d] of out.matchAll(/ d="([^"]*)"/g)) {
    assert.match(d, /^[MmCcLlHhVvZzAaQq0-9eE .,+-]+$/, `path grammar violated: ${d}`);
  }
  // Every svg is either decorative (a legend swatch, aria-hidden) or a labelled image: the daily
  // chart, the four breakdown lists, and the topology itself all carry role + aria-label.
  for (const [tag] of out.matchAll(/<svg[^>]*>/g)) {
    assert.ok(tag.includes('aria-hidden="true"') || (tag.includes('role="img"') && tag.includes("aria-label=")), `unlabelled svg: ${tag}`);
  }
  assert.ok(out.includes('aria-label="daily spend"'));
  for (const label of ["spend by flow", "spend by trigger", "spend by model", "spend by repo"]) {
    assert.ok(out.includes(`aria-label="${label}"`), `chart labelled: ${label}`);
  }
});

// ---- 6. file:// posture ----

test("nothing on the page can reach outside the file", () => {
  const out = cannedHtml();
  for (const needle of ["src=", "<link", "url(", "@import", "fetch", "XMLHttpRequest", "innerHTML"]) {
    assert.ok(!out.includes(needle), `forbidden over file://: ${needle}`);
  }
});

// ---- 7. money discipline (fmtCost is the only dollar renderer) ----

test("plan chips never become dollars, estimates wear tildes, floors wear ≥, nothing says free", () => {
  const out = cannedHtml();
  assert.ok(out.includes("plan:kimi"), "a plan-class cost renders as its chip text");
  assert.ok(!out.includes("$0.00"), "a covered or unrated run must never read as $0.00");
  assert.ok(!/free/i.test(out), "the fold cannot know that anything is free, so the page never says it");
  assert.ok(out.includes("~≥$3.10 est."), "the floored estimated day carries both marks");
  assert.ok(out.includes("~≥$4.45 est."), "the window total is floored and estimated, and says so");
  assert.ok(out.includes("$0 (unrated)"), "zero-rated renders the rate-table fact");
  assert.ok(out.includes("~$44.49 est. @ API"), "the flow api-equivalent is labelled and estimated");
  assert.ok(out.includes("SAVING"), "the owned verdict word renders");
  assert.ok(out.includes("WOULD LOSE") && out.includes(" (hypothetical)"), "the what-if verdict is worded and suffixed");
  assert.ok(out.includes("~$3.30 est./run"), "amortized is estimated, per run");
});

test("a null window limit renders undisclosed with no burn-down, and NO_BASELINE never shows a number", () => {
  const out = cannedHtml();
  assert.ok(out.includes("peak 5h rolling: 4 runs · 1200000 tok · limit undisclosed by vendor"));
  assert.ok(out.includes("peak 7d rolling: 9 runs · 3000000 tok · limit 1000000–2000000 tokens"));
  assert.ok(out.includes("peak month: 1 runs · 1000 tok · limit 5000000 tokens"));
  assert.ok(!/remaining/i.test(out), "no room-left arithmetic against a number the vendor never published");
  assert.ok(!/burn[- ]?down/i.test(out));

  const p = CANNED_PAYLOAD();
  p.fold.plans[0].apiEquiv = null;
  p.fold.plans[0].verdict = { kind: "NO_BASELINE", usd: usd(9.99, "estimated") }; // a smuggled number
  const page = buildInsightsHtml(p, { now: NOW });
  assert.ok(page.includes("no API-rate baseline declared, set counterfactualModel to compare"));
  assert.ok(!page.includes("$9.99"), "NO_BASELINE renders the sentence and never a number, even a smuggled one");
});

// ---- 8. chart geometry via the exported helpers ----

test("layoutDailyChart: bars inside the plot, monotone x, gap days present, all-zero safe", () => {
  const lay = layoutDailyChart(CANNED_FOLD().daily, { width: 920, height: 160 });
  assert.equal(lay.bars.length, 3, "every day draws, gap day included");
  for (let i = 1; i < lay.bars.length; i += 1) {
    assert.ok(lay.bars[i].x > lay.bars[i - 1].x, "x advances monotonically with the day sequence");
  }
  for (const b of lay.bars) {
    assert.ok(b.x >= lay.plot.x && b.x + b.w <= lay.plot.x + lay.plot.w + 0.001, `bar ${b.day} inside the plot (x)`);
    assert.ok(b.y >= lay.plot.y - 0.001 && b.y + b.h <= lay.plot.y + lay.plot.h + 0.001, `bar ${b.day} inside the plot (y)`);
  }
  const gap = lay.bars.find((b) => b.day === "2026-07-30");
  assert.equal(gap.runs, 0);
  assert.equal(gap.cls, "zero");
  assert.equal(gap.h, 1, "a zero-run day is a 1px baseline tick, never skipped");
  const est = lay.bars.find((b) => b.day === "2026-07-31");
  assert.equal(est.cls, "estimated");
  assert.equal(est.floor, true);
  assert.equal(lay.yTicks.length, 4, "four nice-step gridlines");
  for (const t of lay.yTicks) assert.match(t.label, /^[<$~]/, "axis labels come from fmtUsd");

  const zero = layoutDailyChart([{ day: "2026-01-01", cost: usd(0, "metered"), runs: 0 }], { width: 920, height: 160 });
  assert.equal(zero.yTicks.length, 0, "an all-zero window draws no gridlines rather than dividing by zero");
  assert.equal(zero.bars.length, 1);
  assert.deepEqual(layoutDailyChart(null, {}).bars, [], "junk input lays out to nothing, never a throw");
});

test("layoutBarList: plan rows chip with no bar, estimated dashed class, unknown dash, nodeId guarded", () => {
  const rows = [
    { label: "fix", cost: usd(0, "plan", { planId: "kimi" }), runs: 12, apiEquiv: usd(44.49, "estimated") },
    { label: "tidy", cost: usd(1.25, "metered"), runs: 3 },
    { label: "est", cost: usd(2, "estimated", { floor: true }), runs: 1, nodeId: "n4" },
    { label: "zr", cost: usd(0, "zero-rated"), runs: 1 },
    { label: "junk", cost: null, runs: 0, nodeId: "constructor" },
  ];
  const laid = layoutBarList(rows, { width: 430 });
  const [fix, tidy, est, zr, junk] = laid;
  assert.equal(fix.barW, null, "a plan row draws NO bar");
  assert.equal(fix.chipText, "plan:kimi", "it draws the chip instead");
  assert.ok(fix.apiW > 0 && fix.apiText.includes("@ API"), "the api-equivalent ghost bar rides along");
  assert.ok(tidy.barW > 0 && tidy.cls === "metered");
  assert.equal(est.cls, "estimated");
  assert.equal(est.nodeId, "n4", "a minted ordinal rides through to the row");
  assert.ok(est.valueText.startsWith("~≥") && est.valueText.endsWith(" est."));
  assert.equal(zr.barW, 1, "zero-rated is a hairline tick");
  assert.equal(zr.valueText, "$0 (unrated)");
  assert.equal(junk.barW, null);
  assert.equal(junk.chipText, null);
  assert.equal(junk.valueText, "—", "a null cost degrades to the em dash");
  assert.equal(junk.nodeId, null, "a non-minted id (here a prototype-chain key) never rides through");
  laid.forEach((row, i) => assert.equal(row.y, i * 22, "rows stack at a fixed pitch"));
  assert.ok(tidy.barW < est.barW, "bars share one section scale (1.25 under 2)");
  assert.deepEqual(layoutBarList(null, {}), [], "junk input lays out to nothing");
});

// ---- 9. content canary / path leak ----

test("unexpected fields and host paths never reach the page; fullPaths widens group labels only", () => {
  const payload = CANNED_PAYLOAD();
  const inputs = CANNED();
  inputs.folderSkills["/Users/someone/private"] = {
    head: "def456",
    truncated: false,
    unreachable: null,
    skills: [{ name: "solo", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false }],
  };
  payload.graph = buildGraphModel(inputs);
  payload.fold.plans[0].secret = "CANARY-9f3"; // fields no allowlist names; a spread would leak them
  payload.fold.byFlow[0].secret = "CANARY-9f3";
  payload.fold.byTrigger[0].secret = "CANARY-9f3";
  payload.costByTrigger["trigger:0"].secret = "CANARY-9f3";
  const out = buildInsightsHtml(payload, { now: NOW });
  assert.ok(!out.includes("CANARY-9f3"), "unknown fields must be structurally unreachable, not merely unused");
  assert.ok(!out.includes("/Users/someone/private"), "groups render their basename label by DEFAULT, never the path");
  assert.ok(out.includes("private"), "the basename label itself still renders");
  assert.ok(!out.includes('"trigger:0"'), "original trigger ids are server-side join vocabulary only");

  const full = buildInsightsHtml(payload, { now: NOW, fullPaths: true });
  assert.ok(full.includes("/Users/someone/private"), "fullPaths: true labels local groups with their path");
  assert.ok(!full.includes("CANARY-9f3"), "the opt-in widens labels, not the allowlist");
});

// ---- 10. honesty counters, dual windows, retention ----

test("provenance counters, the pi-ai pin, the dual window statement and the date span all render", () => {
  const out = cannedHtml();
  assert.ok(out.includes("unmetered 1 · no ledger (not re-priceable) 2 · rates drifted 1 · ledgers truncated 1"));
  assert.ok(out.includes("pi-ai 0.9.7"));
  assert.ok(out.includes("~ marks estimates · metered = pi-ai computed prices, not invoices"));
  assert.ok(out.includes("spend window: last 30d"), "the spend window label");
  assert.ok(out.includes("topology: fixed 30d record window"), "the topology window beside it");
  assert.ok(out.includes("series bounded by retention (PI_LOG_RETENTION_DAYS) and the 92-day scan cap"));
  assert.ok(out.includes("topology (fixed 30d window)"), "the topology section restates its own window");
  assert.ok(out.includes("chip run counts use the topology window; spend badges use the spend window"));
  assert.ok(out.includes("spend window 2026-07-20 – 2026-08-01 UTC"), "the UTC date span of the fold window");
  assert.ok(out.includes("13 of 16"), "the fully-ledgered KPI: 16 - 1 unmetered - 2 unledgered");
  assert.ok(out.includes("top flow · tidy"), "the top flow is the biggest metered spender, not the plan bucket");

  // The bracketed counters only appear when nonzero: "rates drifted 0" reads as an accusation.
  const p = CANNED_PAYLOAD();
  p.fold.provenance.ratesDrifted = 0;
  p.fold.provenance.runsLedgerTruncated = 0;
  const quiet = buildInsightsHtml(p, { now: NOW });
  assert.ok(!quiet.includes("rates drifted"));
  assert.ok(!quiet.includes("ledgers truncated"));

  const mtd = CANNED_PAYLOAD();
  mtd.window = "mtd";
  assert.ok(buildInsightsHtml(mtd, { now: NOW }).includes("spend window: month to date"));
});

test("the spend layer badges triggers under their chips, amber only for estimated dollars", () => {
  const out = cannedHtml();
  const spendLayer = /<g id="spend">([\s\S]*?)<\/g>/.exec(out);
  assert.ok(spendLayer, "the spend layer exists inside the topology svg");
  assert.ok(spendLayer[1].includes("plan:kimi"), "the covered trigger badges its chip, not a dollar");
  assert.ok(spendLayer[1].includes(">~$1.25 est.</text>"), "the estimated trigger badges its typed dollar");
  assert.ok(spendLayer[1].includes('fill="#d29922"'), "estimated badges use the amber");
  assert.ok(out.includes('height="1" fill="#8b949e"'), "the gap day renders as a dim baseline tick");
});

test("breakdown lists cap at 8 rows and state the tail as one estimated aggregate", () => {
  const p = CANNED_PAYLOAD();
  p.fold.byRepo = Array.from({ length: 11 }, (_, i) => ({
    key: `r${i}`,
    label: `repo-${String(i).padStart(2, "0")}`,
    kind: "github",
    runs: 1,
    tokens: 10,
    cost: usd(11 - i, "metered"),
  }));
  const out = buildInsightsHtml(p, { now: NOW });
  // Rows 9..11 carry $3 + $2 + $1: the tail is their sum, demoted to an estimate because a fold of
  // heterogeneous rows is no longer one measured number.
  assert.ok(out.includes("(+3 more · ~$6.00 est.)"), "totals never silently truncate");
  assert.ok(!out.includes("repo-10"), "the tail rows do not render individually");
  assert.ok(out.includes("repo-07"), "the eighth row still does");
});

// ---- 11. script hardening ----

test("one script that parses, minted-only data-node ids, bounded tips, one guarded GRAPH read", () => {
  const out = cannedHtml();
  const script = /<script>([\s\S]*?)<\/script>/.exec(out)[1];
  new Function(script); // parse check: a syntax break in the emitted script goes red here, not in a browser

  assert.equal((script.match(/GRAPH\.nodes\[/g) ?? []).length, 1, "exactly one raw indexed read of GRAPH.nodes: PAGE_JS's own guarded one");
  assert.ok(script.includes("/^n\\d+$/"), "the click replay guards its id before any DOM lookup");
  assert.ok(script.includes('MouseEvent("click"'), "row clicks replay through the DOM so PAGE_JS owns selection");
  assert.ok(script.includes("textContent"), "tips reach the DOM as text only");

  const nodeIds = [...out.matchAll(/data-node="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(nodeIds.length >= 2, "the canned trigger rows link to their chips");
  for (const id of nodeIds) assert.match(id, /^n\d+$/, "only minted ordinals ride the DOM");

  const tips = JSON.parse(/var INSIGHTS = (.*);/.exec(out)[1]).tips;
  const refs = [...out.matchAll(/data-tip="([^"]*)"/g)].map((m) => Number(m[1]));
  assert.ok(refs.length > 0 && tips.length > 0);
  for (const i of refs) assert.ok(Number.isInteger(i) && i >= 0 && i < tips.length, "every data-tip ordinal is in bounds");
  assert.ok(tips.includes("2026-07-29 · $1.10 · 3 runs"), "daily tips carry the typed dollar");
  assert.ok(tips.some((t) => t.includes("1 failed (") && t.includes("$0.40")), "a trigger with failures states their cost in its tip");
});

test("the header keeps graph.html's reload contract so PAGE_JS binds unmodified", () => {
  const out = cannedHtml();
  assert.ok(out.includes("<h1>pi-dispatch insights</h1>"));
  assert.ok(out.includes('<span id="stamp"></span>'));
  assert.ok(out.includes(">Reload</button>"));
  for (const opt of [">off<", ">5s<", ">30s<"]) assert.ok(out.includes(opt), `auto-reload option ${opt}`);
  assert.ok(out.includes(`GENERATED_AT = ${NOW}`));
  assert.ok(out.includes('<div id="wrap">') && out.includes('<div id="tip">'), "the ids PAGE_JS expects");
  assert.ok(out.includes("location.reload") && !out.includes("fetch"), "refresh means reloading regenerated bytes");
});

// ---- 12. degrades ----

test("null payload, unreachable costs, missing joins and junk all degrade to a stated page", () => {
  const nothing = buildInsightsHtml(null);
  assert.ok(nothing.startsWith("<!doctype html>"));
  assert.ok(nothing.includes("<title>pi-dispatch insights</title>"));
  assert.ok(nothing.includes("no graph model supplied; the page has nothing to draw"));

  const unreachable = buildInsightsHtml(
    { graph: buildGraphModel(CANNED()), fold: null, costsUnreachable: "records dir unreadable", window: "7d", costByTrigger: null },
    { now: NOW },
  );
  assert.ok(unreachable.includes("costs unreachable: records dir unreadable"), "the reason renders, escaped");
  assert.ok(unreachable.includes('<g id="root">') && unreachable.includes('<g id="spend">'), "the topology still renders whole");
  assert.ok(unreachable.includes("spend window: last 7d"), "the window statement survives a dead cost side");

  const noJoin = CANNED_PAYLOAD();
  noJoin.fold.byTrigger = null;
  assert.ok(buildInsightsHtml(noJoin, { now: NOW }).includes("not computed (no trigger join wired)"), "absence, not an empty table");

  const empty = CANNED_PAYLOAD();
  empty.fold.daily = [];
  assert.ok(buildInsightsHtml(empty, { now: NOW }).includes("no runs in the spend window"));

  const zeroRuns = CANNED_PAYLOAD();
  zeroRuns.fold.provenance.runsTotal = 0;
  assert.ok(buildInsightsHtml(zeroRuns, { now: NOW }).includes("no runs in the spend window"), "the zero-run banner");

  const allZero = CANNED_PAYLOAD();
  allZero.fold.daily = [
    { day: "2026-07-29", cost: usd(0, "metered"), runs: 0 },
    { day: "2026-07-30", cost: usd(0, "metered"), runs: 0 },
  ];
  assert.ok(buildInsightsHtml(allZero, { now: NOW }).includes("no spend recorded"), "an all-zero window keeps its axis frame and says so");

  const noSubs = CANNED_PAYLOAD();
  noSubs.fold.plans = [];
  noSubs.subscriptionsInvalid = true;
  assert.ok(buildInsightsHtml(noSubs, { now: NOW }).includes("subscriptions file missing or invalid: plans not scored"));
  const noFlag = CANNED_PAYLOAD();
  noFlag.fold.plans = [];
  assert.ok(!buildInsightsHtml(noFlag, { now: NOW }).includes("subscriptions file missing"), "no flag, no accusation");

  for (const junk of [null, 42, "x", { graph: "no", fold: 7, window: 9, costByTrigger: [] }]) {
    const page = buildInsightsHtml(junk, { now: NOW });
    assert.ok(page.includes("<svg"), "malformed input still yields a page, never a throw");
  }
});

// ---- 13. the budget panel (issue #181): facts only, states as words, the lever named ----

test("budget rows render used-vs-cap FACTS: known caps get a bar, unknown caps get words and nothing else", () => {
  const out = cannedHtml();
  assert.ok(out.includes("reserved 3 / cap 25 (overlay)"), "the day window's facts, byte for byte");
  assert.ok(out.includes("reserved 4 / cap unknown (worker env/default)"), "an overlay-unset cap is UNKNOWN, never guessed");
  assert.ok(out.includes("reserved 9 / cap 40 (overlay)"), "the month window's facts");
  assert.ok(out.includes(">soft-hold</span>"), "the state is a WORD; color only reinforces it");
  assert.ok(out.includes("5400000 / cap 8000000 tok"), "the token counter vs its overlay cap -- counts, never dollars");
  assert.ok(out.includes("per-job maxTokens 200000"), "the per-job budget rides the token row");
  assert.ok(out.includes("soft-hold band: 20% of each cap"), "the band caption renders only because pct is set");
  assert.ok(out.includes("adjust: /dispatch set dailyCap|weeklyCap|monthlyCap|dailyTokenCap|softHoldPct"), "the lever is named -- the panel exists to point at it");
  assert.ok(!/remaining/i.test(out), "used-vs-cap facts only; room-left arithmetic is the burn-down lie");

  // The unknown-cap row draws NO bar: count meter tracks (aria-hidden 220-wide svgs) -- one per
  // known-cap row (day, month, tokens), none for the week row.
  const meters = (out.match(/<svg width="220" height="12" aria-hidden="true">/g) ?? []).length;
  assert.equal(meters, 3, "three known caps, three meter tracks; the unknown-cap week row draws none");
});

test("budget degrades: off windows, an unreachable queue, junk states, and a missing slice", () => {
  const offPayload = CANNED_PAYLOAD();
  offPayload.budget.week = { reserved: 0, cap: null, state: "ok" };
  const off = buildInsightsHtml(offPayload, { now: NOW });
  assert.ok(off.includes("off · no cap set"), "week/month with no cap and nothing reserved is OFF, not zero");

  const downPayload = CANNED_PAYLOAD();
  downPayload.budget.unreachable = "timed out reaching the queue";
  downPayload.budget.day = { reserved: null, cap: 25, state: "ok" };
  downPayload.budget.tokens = { spent: null, cap: 8000000, state: "ok", maxTokens: null };
  const down = buildInsightsHtml(downPayload, { now: NOW });
  assert.ok(down.includes("budget unreachable: timed out reaching the queue"), "the banner states the absence");
  assert.ok(down.includes("cap 25 (overlay) · reserved unavailable (queue unreachable)"), "caps stay facts; reserved does not invent a zero");

  const junkPayload = CANNED_PAYLOAD();
  junkPayload.budget.day.state = "critical!!";
  const junk = buildInsightsHtml(junkPayload, { now: NOW });
  assert.ok(!junk.includes("critical"), "a junk state degrades toward SILENCE -- it can hide an alarm, never invent one");

  const bare = CANNED_PAYLOAD();
  delete bare.budget;
  assert.ok(buildInsightsHtml(bare, { now: NOW }).includes("no budget data in this payload"), "a missing slice is a stated absence");
});

// ---- 14. the line charts (issue #181): shared scales, dashed estimates, honest gaps ----

test("layoutFlowLines: one scale across panels, band-center x, dashed segments where an estimated day touches", () => {
  const lay = layoutFlowLines(CANNED_FOLD().dailyByFlow, {});
  assert.equal(lay.panels.length, 2);
  const [fix, tidy] = lay.panels;
  assert.equal(fix.flow, "fix", "window total desc: fix outspends tidy");
  for (const panel of lay.panels) {
    for (let i = 1; i < panel.points.length; i += 1) {
      assert.ok(panel.points[i].x > panel.points[i - 1].x, "monotone x");
    }
    for (const pt of panel.points) {
      assert.ok(pt.x >= panel.plot.x - 0.001 && pt.x <= panel.plot.x + panel.plot.w + 0.001, "inside the plot in x");
      assert.ok(pt.y >= panel.plot.y - 0.001 && pt.y <= panel.plot.y + panel.plot.h + 0.001, "inside the plot in y");
    }
  }
  assert.deepEqual(fix.points.map((p) => p.x), tidy.points.map((p) => p.x), "the SAME band centers: one x-domain across multiples");
  assert.deepEqual(fix.segments.map((s) => s.dashed), [false, true], "the segment touching the estimated day wears the estimate");
  assert.deepEqual(tidy.segments.map((s) => s.dashed), [false, false], "an all-metered flow stays solid, gap day included");
  const zeroDay = fix.points[1];
  assert.equal(zeroDay.y, fix.plot.y + fix.plot.h, "a zero-run day sits ON the baseline -- a $0 day is a measured fact");
  assert.ok(lay.scaleMax > 0);
  assert.equal(fix.yTicks.length, 2, "two gridlines; four in a 96px panel is noise");
});

test("layoutFlowLines: top-N cut aggregates the rest honestly, junk never throws", () => {
  const rows = CANNED_FOLD().dailyByFlow;
  const lay = layoutFlowLines(rows, { top: 1 });
  assert.equal(lay.panels.length, 1);
  assert.equal(lay.restCount, 1);
  assert.equal(lay.restAgg.class, "estimated", "an aggregate over heterogeneous rows is at best an estimate");
  assert.deepEqual(layoutFlowLines(null, {}).panels, []);
  assert.deepEqual(layoutFlowLines([{ flow: 7, days: "x" }], {}).panels.length, 1, "junk rows normalize instead of throwing");
});

test("layoutCumulative: monotone running total, demoted from the first estimated day onward, typed end label", () => {
  const lay = layoutCumulative(CANNED_FOLD().daily, {});
  assert.equal(lay.points.length, 3);
  for (let i = 1; i < lay.points.length; i += 1) {
    assert.ok(lay.points[i].total >= lay.points[i - 1].total, "a running total never goes down");
    assert.ok(lay.points[i].y <= lay.points[i - 1].y + 0.001, "so the line never rises in SVG y");
  }
  assert.deepEqual(lay.points.map((p) => p.demoted), [false, false, true], "the estimate enters on the estimated day and never leaves");
  assert.deepEqual(lay.segments.map((s) => s.dashed), [false, true]);
  assert.deepEqual(lay.endTotal, { usd: 4.2, class: "estimated", floor: true }, "the end label is the running TYPED total");
  assert.deepEqual(layoutCumulative([], {}).points, []);
  assert.deepEqual(layoutCumulative(null, {}).points, []);
});

test("the flow panels render with text-borne identity; an absent series is an absent section", () => {
  const out = cannedHtml();
  assert.ok(out.includes("daily spend by flow"), "the section renders when the fold carries the series");
  assert.ok(/aria-label="daily spend · fix"/.test(out), "each panel is labelled by its flow -- identity by TEXT, never hue");
  assert.ok(out.includes(">cumulative</div>"), "the cumulative mini-chart rides under the daily columns");

  const bare = CANNED_PAYLOAD();
  delete bare.fold.dailyByFlow;
  const page = buildInsightsHtml(bare, { now: NOW });
  assert.ok(!page.includes("daily spend by flow"), "a fold that predates the series gets NO section -- absence, never an empty grid");
});

test("a hostile flow name in the series stays entity-escaped in panel titles and aria labels", () => {
  const p = CANNED_PAYLOAD();
  p.fold.dailyByFlow[0].flow = '"><script>alert(1)</script>';
  p.fold.dailyByFlow[0].flowKey = "x";
  const out = buildInsightsHtml(p, { now: NOW });
  assert.equal((out.match(/<script/g) ?? []).length, 1, "still exactly one script element");
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the hostile name renders as entities");
});
