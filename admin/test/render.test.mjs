import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderStatus, renderRuns, renderBudget, renderTriggers, renderSettingsView, renderCosts, renderWhatIf } from "../src/render.mjs";

test("render.mjs has no path to raw .log content", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/render.mjs", import.meta.url)), "utf8");
  // A renderer has no I/O: no fs read and no call into the log tail. (A doc comment may name `.log`;
  // what matters is that no code path reads one.)
  assert.ok(
    !/readLogTail|readFileSync|\breadFile\b|require\(|import\s+.*node:fs/.test(src),
    "renderers must never read raw log content -- that surface belongs to the overlay viewer only",
  );
});

test("renderStatus shows paused state, counts, and workers", () => {
  const out = renderStatus({
    pausedState: false,
    counts: { waiting: 2, active: 1, paused: 0, delayed: 0, failed: 3 },
    workers: 1,
  });
  assert.match(out, /Queue: running/);
  assert.match(out, /waiting 2/);
  assert.match(out, /failed 3/);
  assert.match(out, /workers: 1/);
});

test("renderStatus reports paused and unreachable", () => {
  assert.match(renderStatus({ pausedState: true, counts: {}, workers: "unknown" }), /Queue: paused/);
  assert.match(renderStatus({ unreachable: "down" }), /unreachable \(down\)/);
});

test("renderRuns aligns columns with a header and a data row, including the chain marker", () => {
  const out = renderRuns([
    {
      jobId: "j1",
      target: "o/r#5",
      flow: "fix",
      outcome: "completed",
      reason: null,
      turns: 4,
      chainDepth: 1,
      endedAt: "2026-07-21T00:00:00.000Z",
    },
  ]);
  assert.match(out, /JOB ID/);
  assert.match(out, /CHAIN/);
  assert.match(out, /j1/);
  assert.match(out, /o\/r#5/);
  assert.match(out, /completed/);
  assert.match(out, /\bd1\b/, "a chained child renders a d<n> depth marker");
});

test("renderRuns surfaces per-job tokens and cost, and dashes them when usage is absent", () => {
  const out = renderRuns([
    { jobId: "j1", target: "o/r#5", flow: "fix", outcome: "completed", turns: 4, tokens: { input: 4000, output: 1000, total: 5000, cost: 0.0523 }, endedAt: "2026-07-21T00:00:00.000Z" },
    { jobId: "j2", target: "o/r#6", flow: "fix", outcome: "failed", turns: null, tokens: null, endedAt: "2026-07-21T00:01:00.000Z" },
  ]);
  assert.match(out, /TOKENS/);
  assert.match(out, /COST/);
  assert.match(out, /\b5000\b/, "total tokens render for a run that reported usage");
  assert.match(out, /\$0\.0523/, "cost renders as a $-prefixed fixed-decimal");
  const noUsageRow = out.split("\n").find((l) => l.includes("j2"));
  assert.match(noUsageRow, /-/, "a run without usage dashes its token/cost cells");
});

test("renderRuns renders a fully-null record as dashes (chain column included)", () => {
  const out = renderRuns([{ jobId: null, target: null, flow: null, outcome: null, reason: null, turns: null, chainDepth: null, endedAt: null }]);
  assert.match(out, /CHAIN/);
  const dataRow = out.split("\n")[1];
  assert.match(dataRow, /^-(\s+-)+\s*$/, "a non-chain record renders '-' in the chain column");
});

test("renderRuns degrades on empty and unreachable inputs", () => {
  assert.match(renderRuns([]), /No runs/);
  assert.match(renderRuns({ unreachable: "x" }), /unreachable/);
});

test("renderBudget shows the day window's reserved count and the overlay-derived cap", () => {
  const out = renderBudget({ budget: { day: 5, week: 0, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.match(out, /day: reserved 5 \/ cap 25 \(overlay\)/);
});

test("renderBudget marks the day cap unknown when the overlay omits dailyCap", () => {
  const out = renderBudget({ budget: { day: 0 }, settings: { path: "/s", overlay: {} } });
  assert.match(out, /day: reserved 0 \/ cap unknown/);
});

test("renderBudget shows week/month windows only when the overlay sets their cap (or they are reserving)", () => {
  const withCaps = renderBudget({
    budget: { day: 1, week: 4, month: 9 },
    settings: { path: "/s", overlay: { dailyCap: 25, weeklyCap: 100, monthlyCap: 400 } },
  });
  assert.match(withCaps, /week: reserved 4 \/ cap 100 \(overlay\)/);
  assert.match(withCaps, /month: reserved 9 \/ cap 400 \(overlay\)/);

  // No overlay week/month caps and zero reserved -> those lines are omitted (window not in play).
  const dayOnly = renderBudget({ budget: { day: 1, week: 0, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.doesNotMatch(dayOnly, /week:/);
  assert.doesNotMatch(dayOnly, /month:/);

  // An env-configured window the admin cannot read the cap for still surfaces once it is reserving.
  const envWeek = renderBudget({ budget: { day: 1, week: 3, month: 0 }, settings: { path: "/s", overlay: { dailyCap: 25 } } });
  assert.match(envWeek, /week: reserved 3 \/ cap unknown/);
});

test("renderBudget marks a window soft-hold / over via the shared windowState, and shows the band", () => {
  // day cap 10, softHoldPct 80 -> threshold 8; reserved 9 is inside the band.
  const soft = renderBudget({ budget: { day: 9 }, settings: { path: "/s", overlay: { dailyCap: 10, softHoldPct: 80 } } });
  assert.match(soft, /day: reserved 9 \/ cap 10 \(overlay\) \[soft-hold\]/);
  assert.match(soft, /soft-hold band: 80%/);

  const over = renderBudget({ budget: { day: 11 }, settings: { path: "/s", overlay: { dailyCap: 10 } } });
  assert.match(over, /\[over\]/);
});

test("renderBudget reports unreachable", () => {
  assert.match(renderBudget({ budget: { unreachable: "down" }, settings: {} }), /unreachable/);
});

test("renderTriggers lists schedulers with next + overdue drift and a label trigger line", () => {
  const out = renderTriggers({
    schedulers: [{ key: "s1", next: Date.UTC(2026, 6, 21, 0, 0, 0), overdueMs: 5000 }],
    triggers: { triggers: [{ type: "label", any: ["pi:frontend"], all: [], none: ["wontfix"], flow: "frontend-fix" }] },
  });
  assert.match(out, /s1/);
  assert.match(out, /next 2026-07-21T00:00:00.000Z/);
  assert.match(out, /overdue by 5s/);
  assert.match(out, /label {2}any\[pi:frontend\] none\[wontfix\] → frontend-fix/);
});

test("renderTriggers renders each of the four on.types", () => {
  const out = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/p", flow: "tidy" },
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix" },
        { type: "comment", phrase: "@pi", flow: "fix" },
        { type: "pull_request", action: ["labeled"], any: ["pi:review"], all: [], none: [], flow: "review" },
      ],
    },
  });
  assert.match(out, /cron {2}nightly {2}0 3 \* \* \* → \/srv\/p\/tidy/);
  assert.match(out, /label {2}any\[pi:frontend\] → frontend-fix/);
  assert.match(out, /comment {2}"@pi" → fix/);
  assert.match(out, /pull_request {2}action\[labeled\] any\[pi:review\] → review/);
});

test("renderTriggers marks a packages-loading trigger and leaves a declining one unchanged", () => {
  const cron = (packages) => ({ type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/p", flow: "tidy", packages });
  // `true` is what normalizeTriggerForDisplay yields for a trigger that OMITS run.packages -- the common
  // case under the opt-out polarity, and the one that used to render bare.
  const loading = renderTriggers({ schedulers: [], triggers: { triggers: [cron(true)] } });
  assert.match(loading, /cron {2}nightly {2}0 3 \* \* \* → \/srv\/p\/tidy {2}\[packages\]/, "a loading cron line carries the marker");

  // A trigger that declined must read exactly as it did before the marker existed.
  const declined = renderTriggers({ schedulers: [], triggers: { triggers: [cron(false)] } });
  assert.doesNotMatch(declined, /\[packages\]/);

  // All four kinds carry it -- every kind loads the operator-staged packages unless it declined.
  const all = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", packages: true },
        { type: "comment", phrase: "@pi", flow: "fix", packages: true },
        { type: "pull_request", action: ["labeled"], any: [], all: [], none: [], flow: "review", packages: true },
      ],
    },
  });
  assert.equal(all.split("[packages]").length - 1, 3, "label, comment and pull_request each show the marker");
});

test("renderTriggers shows a non-default image, and a default-image line is byte-identical", () => {
  const cron = (image) => ({ type: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv/p", flow: "tidy", packages: false, image });
  const named = renderTriggers({ schedulers: [], triggers: { triggers: [cron("my-python:1.2.0")] } });
  assert.match(named, /\[image my-python:1\.2\.0\]/, "which image a job runs is which code it runs, so the row says it");

  // The suffix is empty and appended last, so a deployment using no per-trigger images renders exactly as
  // it did before the feature existed.
  const plain = renderTriggers({ schedulers: [], triggers: { triggers: [cron(null)] } });
  assert.doesNotMatch(plain, /\[image/);

  // All four kinds carry it.
  const all = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", image: "a:1" },
        { type: "comment", phrase: "@pi", flow: "fix", image: "b:1" },
        { type: "pull_request", action: ["labeled"], any: [], all: [], none: [], flow: "review", image: "c:1" },
      ],
    },
  });
  assert.equal(all.split("[image ").length - 1, 3, "label, comment and pull_request each show their image");
});

test("renderTriggers degrades on no schedulers and a missing triggers file", () => {
  const out = renderTriggers({ schedulers: [], triggers: { missing: true } });
  assert.match(out, /none configured/);
  assert.match(out, /triggers file not found/);
});

test("renderTriggers reports an invalid triggers file and an empty list", () => {
  assert.match(renderTriggers({ schedulers: [], triggers: { invalid: "bad" } }), /triggers file invalid: bad/);
  assert.match(renderTriggers({ schedulers: [], triggers: { triggers: [] } }), /\(no triggers\)/);
});

test("renderTriggers reports an unreachable scheduler read", () => {
  assert.match(renderTriggers({ schedulers: { unreachable: "down" }, triggers: { triggers: [] } }), /unreachable \(down\)/);
});

test("renderSettingsView lists all ten keys, unset ones marked", () => {
  const out = renderSettingsView({ path: "/s", overlay: { model: "claude", dailyCap: 5, weeklyCap: 100, softHoldPct: 80, maxTokens: 500000 } });
  assert.match(out, /Settings \(\/s\)/);
  assert.match(out, /model: claude/);
  assert.match(out, /dailyCap: 5/);
  assert.match(out, /weeklyCap: 100/);
  assert.match(out, /softHoldPct: 80/);
  assert.match(out, /maxTokens: 500000/);
  assert.match(out, /provider: \(unset\)/);
  assert.match(out, /monthlyCap: \(unset\)/);
  assert.match(out, /dailyTokenCap: \(unset\)/);
  assert.match(out, /concurrency: \(unset\)/);
});

test("renderSettingsView surfaces invalid overlays", () => {
  assert.match(renderSettingsView({ path: "/s", invalid: "dailyCap must be an integer >= 1" }), /invalid/);
});

test("a non-github forge is badged in the LIST line, and a github one renders byte-identically", () => {
  const gh = { type: "label", any: ["pi:fix"], all: [], none: [], flow: "fix", packages: false, image: null, forge: "github" };
  const gl = { ...gh, forge: "gitlab" };

  // Byte identity is the assertion, not a regex: the whole point is that an existing deployment's panel
  // does not move, and a comparison against the forge-less record proves it exactly.
  const show = (t) => renderTriggers({ schedulers: [], triggers: { triggers: [t] } });
  const { forge: _drop, ...noForge } = gh;
  assert.equal(show(gh), show(noForge), "a github trigger must render exactly as it did before the field existed");

  assert.ok(show(gl).includes("[gitlab]"), "a gitlab trigger must say so -- two forges can select the same label");
  assert.ok(!show(gh).includes("[github]"), "github is the unmarked default");
});

test("a resume-armed trigger is BADGED, and an unarmed one renders byte-identically to before", () => {
  // The failure this guards is the one 0.1.4 shipped a fix for, arriving in a new field: a trigger whose
  // jobs persist the agent's working history to disk rendering identically to one whose jobs do not --
  // no badge and no warning, quiet exactly where the risk is.
  const base = { type: "comment", phrase: "@pi", flow: "fix", packages: false, image: null, forge: "github" };
  const armed = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...base, resume: true }] } });
  assert.match(armed, /\[resume\]/);

  for (const cold of [false, undefined]) {
    const out = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...base, resume: cold }] } });
    assert.equal(out.includes("[resume]"), false, `resume ${JSON.stringify(cold)} must not badge`);
    assert.equal(out, renderTriggers({ schedulers: [], triggers: { triggers: [base] } }), "an unarmed trigger must render byte-identically to a deployment that never heard of this feature");
  }
});

test("the badge is opt-IN -- the opposite polarity to [packages], which is the bug that shipped once", () => {
  // [packages] is `=== true` on an opt-OUT field, so absent means LOADING and the badge is present.
  // [resume] is `=== true` on an opt-IN field, so absent means COLD and the badge is absent. Testing both
  // in one place is what stops the next person from "harmonising" them.
  const t = { type: "label", any: ["x"], all: [], none: [], flow: "f", forge: "github" };
  const neither = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...t, packages: undefined, resume: undefined }] } });
  assert.equal(neither.includes("[resume]"), false, "absent resume is a cold start");
  const both = renderTriggers({ schedulers: [], triggers: { triggers: [{ ...t, packages: true, resume: true }] } });
  assert.match(both, /\[packages\]/);
  assert.match(both, /\[resume\]/);
});

test("renderRuns adds a REPLICA column, and an unreplicated run reads '-' rather than '0'", () => {
  // Derived like CHAIN, and for the same reason: `cell()` would render 0 as "0". The set size rides along
  // because `r2` alone does not say whether a sibling exists -- the two rows need not be adjacent.
  const out = renderRuns([
    { jobId: "j1", target: "o/r#5", flow: "fix", outcome: "completed", turns: 4, replica: 1, replicas: 2, endedAt: "2026-08-01T00:00:00.000Z" },
    { jobId: "j2", target: "o/r#5", flow: "fix", outcome: "completed", turns: 6, replica: 2, replicas: 2, endedAt: "2026-08-01T00:01:00.000Z" },
    { jobId: "j3", target: "o/r#6", flow: "fix", outcome: "completed", turns: 3, endedAt: "2026-08-01T00:02:00.000Z" },
  ]);
  assert.match(out, /REPLICA/);
  assert.match(out, /\br1\/2\b/);
  assert.match(out, /\br2\/2\b/);
  // The third row is the unreplicated one; a "0/..." anywhere would mean the derive leaked a falsy index.
  assert.doesNotMatch(out, /\br0\b/);
});

// ---- the costs view (issue #53): golden-ish assertions on a canned fold literal ----

/** A typed dollar exactly as costs.mjs emits one, overridable for coverage/planId. */
function typedCost(usd, cls, over = {}) {
  return { usd, class: cls, floor: false, ...over };
}

const CANNED_FOLD = {
  window: { fromMs: Date.parse("2026-07-01T00:00:00.000Z"), toMs: Date.parse("2026-07-03T00:00:00.000Z"), days: 2 },
  daily: [
    { day: "2026-07-01", cost: typedCost(0.5, "metered"), runs: 2 },
    { day: "2026-07-02", cost: typedCost(1.0, "metered"), runs: 1 },
  ],
  byFlow: [
    { flow: "fix", runs: 2, tokens: 3000, cost: typedCost(1.5, "metered"), apiEquiv: null },
    { flow: "(no flow)", runs: 1, tokens: 6000000, cost: typedCost(0, "estimated", { coverage: 0 }), apiEquiv: typedCost(102, "estimated") },
  ],
  byModel: [
    { provider: "anthropic", model: "claude-sonnet-4", runs: 2, tokens: 3000, cost: typedCost(1.5, "metered") },
    { provider: "kimi-coding", model: "kimi-k2", runs: 1, tokens: 6000000, cost: typedCost(0, "plan", { planId: "kimi" }) },
    { provider: "zai", model: "glm-4.7", runs: 1, tokens: 1500, cost: typedCost(0, "zero-rated") },
  ],
  plans: [
    {
      id: "kimi", vendor: "Moonshot AI", hypothetical: false, price: { amount: 90, currency: "USD", per: "month" },
      attributedRuns: 1, attributedTokens: 6000000,
      amortizedPerRun: typedCost(6, "estimated"), apiEquiv: typedCost(102, "estimated"),
      verdict: { kind: "SAVING", usd: typedCost(96, "estimated") },
      windows: [{ per: "5h", rolling: true, unit: "tokens", limit: null, peakRuns: 1, peakTokens: 6000000 }],
    },
    {
      id: "glm", vendor: "Zhipu", hypothetical: true, price: { amount: 30, currency: "USD", per: "month" },
      attributedRuns: 1, attributedTokens: 1500, amortizedPerRun: typedCost(2, "estimated"), apiEquiv: null,
      verdict: { kind: "WOULD_LOSE", usd: typedCost(2, "estimated") }, windows: [],
    },
    {
      id: "bare", vendor: "Vendor", hypothetical: false, price: { amount: 10, currency: "USD", per: "month" },
      attributedRuns: 1, attributedTokens: 100, amortizedPerRun: typedCost(0.7, "estimated"), apiEquiv: null,
      verdict: { kind: "NO_BASELINE", usd: null }, windows: [],
    },
  ],
  provenance: { total: typedCost(1.5, "estimated", { coverage: 2 / 3 }), runsTotal: 3, runsUnmetered: 1, runsUnledgered: 1, ratesDrifted: 0, piAiPin: "1.2.3" },
};

test("renderCosts: header, verdicts, sparkline, tables, peak facts, provenance — money only via fmtCost", () => {
  const out = renderCosts(CANNED_FOLD, { window: "mtd" });
  assert.match(out, /^Costs \(month to date\): ~\$1\.50 est\. · 3 runs/);
  // Verdict wording per kind, the ~/est. estimate markers riding on the typed dollars.
  assert.match(out, /kimi: SAVING ~\$96\.00 est\. vs API rates/);
  assert.match(out, /glm \(hypothetical\): WOULD_LOSE ~\$2\.00 est\./);
  assert.match(out, /bare: no API-rate baseline declared — set counterfactualModel to compare/);
  assert.match(out, /Daily: [▁▂▃▄▅▆▇█·]+ {2}\(2026-07-01 → 2026-07-02\)/, "the daily sparkline row is present");
  assert.match(out, /FLOW {2}.*RUNS {2}.*TOKENS {2}.*COST {2}.*API-EQUIV/s);
  assert.match(out, /plan:kimi/, "a plan-covered model row reads plan:<id>, never a dollar");
  assert.match(out, /\$0 \(unrated\)/, "a zero-rated row says a table rated it zero");
  assert.match(out, /limit undisclosed by vendor/, "a null window limit is a first-class fact, not a zero");
  assert.match(out, /peak 5h rolling: 1 runs · 6000000 tokens/, "the peak is FACTS observed, never burn-down");
  assert.match(out, /~ marks estimates · metered = pi-ai computed prices, not invoices · pi-ai 1\.2\.3/);
  assert.match(out, /unmetered 1 · no ledger \(not re-priceable\) 1/);
  assert.ok(!out.includes("$0.00"), "$0.00 must never appear -- a plan row rendering it would misread as free");
  assert.ok(!/free/i.test(out), "'free' is a claim no renderer may make");
});

test("renderCosts: byTrigger and byRepo tables render when the fold carries them, and a null byTrigger is absence", () => {
  const fold = structuredClone(CANNED_FOLD);
  fold.byTrigger = [
    { key: "trigger:0", index: 0, type: "cron", label: "nightly 0 3 * * *", runs: 3, tokens: 90_000, cost: typedCost(1.2, "metered"), outcomes: { completed: 2, policy: 0, failed: 1 }, failedCost: typedCost(0.4, "metered") },
    { key: "manual", index: null, type: null, label: "(manual/local)", runs: 1, tokens: 1_000, cost: typedCost(0, "zero-rated"), outcomes: { completed: 1, policy: 0, failed: 0 }, failedCost: null },
  ];
  fold.byRepo = [{ key: "acme/api", label: "acme/api", kind: "github", runs: 2, tokens: 50_000, cost: typedCost(0.9, "metered") }];
  const out = renderCosts(fold, { window: "mtd" });
  assert.match(out, /By trigger:/);
  assert.match(out, /TRIGGER {2}.*RUNS {2}.*FAIL {2}.*TOKENS {2}.*COST/s);
  assert.match(out, /nightly 0 3 \* \* \*\s+3\s+1\s+90000\s+\$1\.20/);
  assert.match(out, /\(manual\/local\)/);
  assert.match(out, /By repo:/);
  assert.match(out, /acme\/api\s+2\s+50000\s+\$0\.90/);

  const withoutJoin = structuredClone(CANNED_FOLD);
  withoutJoin.byTrigger = null;
  const bare = renderCosts(withoutJoin, { window: "mtd" });
  assert.doesNotMatch(bare, /By trigger:/, "null means not computed -- absence, never an empty table that looks exhaustive");
});

test("renderCosts verdict wording covers LOSING and WOULD_SAVE too", () => {
  const fold = structuredClone(CANNED_FOLD);
  fold.plans[0].verdict = { kind: "LOSING", usd: typedCost(40, "estimated") };
  fold.plans[1].verdict = { kind: "WOULD_SAVE", usd: typedCost(3, "estimated") };
  const out = renderCosts(fold, { window: "7d" });
  assert.match(out, /Costs \(last 7 days\)/);
  assert.match(out, /kimi: LOSING ~\$40\.00 est\. vs API rates/);
  assert.match(out, /glm \(hypothetical\): WOULD_SAVE ~\$3\.00 est\./);
});

test("renderCosts renders a sane empty view", () => {
  const empty = {
    window: { fromMs: 0, toMs: 0, days: 0 },
    daily: [],
    byFlow: [],
    byModel: [],
    plans: [],
    provenance: { total: typedCost(0, "metered"), runsTotal: 0, runsUnmetered: 0, runsUnledgered: 0, ratesDrifted: 0, piAiPin: null },
  };
  assert.equal(renderCosts(empty, { window: "mtd" }), "Costs (month to date):\nNo runs in window.");
});

test("renderWhatIf shows the estimate through fmtCost, and the seeded band verbatim", () => {
  const est = renderWhatIf(
    { class: "estimated", usd: 12.5, perRun: 1.25, coverage: 0.8, excluded: 2, ratesVersion: "1.2.3" },
    { flow: "fix", target: "anthropic/claude-sonnet-4" },
  );
  assert.match(est, /What-if fix @ anthropic\/claude-sonnet-4:/);
  assert.match(est, /~\$12\.50 est\. total · ~\$1\.25 est\. per run/);
  assert.match(est, /coverage 80% of observed runs ledgered · excluded 2 \(no ledger\)/);
  assert.match(est, /rates pi-ai 1\.2\.3/);

  const seeded = renderWhatIf(
    { class: "seeded", low: 0.5, high: 5, note: "unmeasured (OQ-002)" },
    { flow: "new-flow", target: "anthropic/claude-sonnet-4" },
  );
  assert.match(seeded, /~~\$0\.50 seeded to ~~\$5\.00 seeded/, "both band edges keep their seeded class marker");
  assert.match(seeded, /unmeasured \(OQ-002\)/, "the fold's own note rides through verbatim");
});

test("renderTriggers marks a replicating trigger, and an unflagged line is byte-identical", () => {
  // A spend multiplier must not render like a preference -- the same class of badge as [resume], appended
  // last so every existing line is unchanged.
  const label = (replicas) => ({ type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", packages: false, replicas });
  const racing = renderTriggers({ schedulers: [], triggers: { triggers: [label(2)] } });
  assert.match(racing, /\[x2\]/);

  const plain = renderTriggers({ schedulers: [], triggers: { triggers: [label(null)] } });
  assert.doesNotMatch(plain, /\[x/);
  assert.equal(plain, renderTriggers({ schedulers: [], triggers: { triggers: [label(undefined)] } }), "absent and null render the same single-run line");

  // All three webhook kinds carry it; cron can never hold one, so it has nothing to show.
  const all = renderTriggers({
    schedulers: [],
    triggers: {
      triggers: [
        { type: "label", any: ["pi:frontend"], all: [], none: [], flow: "frontend-fix", replicas: 2 },
        { type: "comment", phrase: "@pi", flow: "fix", replicas: 3 },
        { type: "pull_request", action: ["labeled"], any: [], all: [], none: [], flow: "review", replicas: 2 },
      ],
    },
  });
  assert.equal(all.split("[x").length - 1, 3, "label, comment and pull_request each show their count");
});

// ---- renderGraph (issue #54): the /dispatch graph text body and the dashboard's unframed twin ----

import { renderGraph } from "../src/render.mjs";
import { buildGraphModel } from "../src/graph-model.mjs";

// Hand-built through the REAL assembler so the render tests cannot drift from the model contract;
// every number below is hand-computable from these literals.
const GRAPH_MODEL = () =>
  buildGraphModel({
    triggers: {
      count: 2,
      triggers: [
        { type: "cron", index: 0, id: "nightly", pattern: "0 3 * * *", folder: "/srv/site", flow: "build-report", model: null, packages: true, image: null, skillsDir: null, instructions: false, resume: false },
        { type: "label", index: 1, any: ["ai"], all: [], none: [], flow: "triage", packages: true, image: null, skillsDir: null, instructions: false, resume: false, replicas: null, forge: "github" },
      ],
    },
    schedulers: [],
    folderSkills: {
      "/srv/site": {
        head: "abc1234def",
        truncated: false,
        unreachable: null,
        skills: [
          { name: "build-report", isSub: false, group: null, aiTrigger: true, meta: null, mentions: [{ name: "notify", strong: true }], unread: false },
          { name: "notify", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false },
          { name: "old-import", isSub: false, group: null, aiTrigger: false, meta: null, mentions: [], unread: false },
        ],
      },
    },
    injectedSkills: {},
    cronStats: { byId: { nightly: { runs: 41, lastOutcome: "completed", lastEndedAt: "2026-08-11T00:00:00.000Z" } } },
    runJoin: { byIndex: { 1: { runs: 12, lastOutcome: "failed", lastEndedAt: "2026-08-11T01:00:00.000Z" } }, unattributed: 2 },
    chainEdges: { edges: [{ parentFlow: "build-report", childFlow: "notify", target: "local:site", count: 3, lastEndedAt: null }], refusals: {}, truncated: false },
    caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 },
    nowMs: 1770000000000,
  });

test("renderGraph renders folders, triggers with stats, skills with badges, and evidence-labelled edges", () => {
  const out = renderGraph(GRAPH_MODEL());
  assert.match(out, /^Graph: triggers and flows/, "header anchored at the start");
  assert.match(out, /folder \/srv\/site, HEAD abc1234\b/, "the folder heading carries the short HEAD");
  assert.match(out, /cron nightly 0 3 \* \* \* -> build-report {2}\(runs 41, last completed\)/);
  assert.match(out, /forge github \(skills unverifiable from the admin host\)/);
  assert.match(out, /label any\[ai\] -> triage {2}\(runs 12, last failed\)/, "forge runs join via the persisted index");
  assert.match(out, /-> notify {2}observed x3/, "an observed edge carries its count");
  assert.match(out, /-> notify {2}mention \(potential, strong; can never fire: target has no ai-trigger allow\)/, "a mention of a non-eligible target says it can never fire");
  assert.match(out, /skill old-import {2}\[orphan/, "the orphan badge renders");
  assert.match(out, /2 runs unattributed/);
  assert.match(out, /caps: chain depth <= 1, <= 2 per job, same folder only, window 30d/, "the caps line always renders");

  // The negative claims: evidence classes never blur, and record-side text never appears.
  assert.ok(!out.includes("label:"), "no matched label text exists anywhere in the model or the render");
  const observedLines = out.split("\n").filter((l) => /observed x\d/.test(l));
  assert.equal(observedLines.length, 1, "exactly the one observed edge renders with a count (the legend's xN is not a count)");
  for (const line of out.split("\n").filter((l) => l.includes("mention (potential") && !l.startsWith("edges:"))) {
    assert.ok(!/observed/.test(line), "a potential EDGE line never borrows observed's vocabulary (the legend names both on purpose)");
  }
});

test("renderGraph: empty model and degraded inputs render exact, honest strings", () => {
  assert.equal(renderGraph({ meta: { triggersMissing: true } }), "Graph: no triggers file found");
  assert.equal(renderGraph({ meta: { triggersInvalid: "not valid JSON" } }), "Graph: triggers file invalid: not valid JSON");
  const empty = renderGraph(buildGraphModel({ caps: { chainDepthMax: 1, chainMaxPerJob: 2, windowDays: 30 } }));
  assert.equal(
    empty,
    ["Graph: triggers and flows", "", "no triggers configured", "", "edges: -> configured, observed xN (from records), mention (potential; a mention is not a promise)", "caps: chain depth <= 1, <= 2 per job, same folder only, window 30d"].join("\n"),
    "the empty render is exact-equality pinned, caps included",
  );
});

test("renderGraph surfaces truncation and dropped edges rather than pretending coverage", () => {
  const model = GRAPH_MODEL();
  model.meta.truncated.folders = true;
  model.meta.truncated.edges = true;
  model.meta.droppedObservedEdges = 2;
  const out = renderGraph(model);
  assert.match(out, /folder scan truncated .*unscanned/);
  assert.match(out, /observed edges truncated/);
  assert.match(out, /2 observed edges dropped \(no unique readable folder/);
  model.meta.injectedUnreachable = ["/inj"];
  assert.match(renderGraph(model), /injected skills dir unreadable: \/inj/, "an unreadable injected dir says so (OQ-022's badge must not silently vanish)");
});
