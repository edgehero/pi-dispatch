import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tempDir } from "./helpers/temp-dir.mjs";
import { resolvePaths } from "../src/read-model.mjs";
import { assembleInsights } from "../src/insights-assembly.mjs";
import * as html from "../src/insights-html.mjs";
import { buildGraphScene } from "../src/graph-html.mjs";
import * as ia from "../src/insights-assembly.mjs";
import { insightsBody } from "../src/console/panels.mjs";
import { modelDollarKeyPrefix, scopeDollarKeyPrefix } from "@edgehero/pi-dispatch/scoped-limits";

/**
 * The insights assembly as the operator console uses it (issue #641): a separate process that never loads pi, so the
 * module is imported here directly (no jiti, no index.ts) and handed what the extension hands it: the pricing facade
 * and the deployment's environment.
 */

/** Every file a bundle of `entry` reaches, by esbuild's own resolution (the published bundles' resolver). */
async function reached(entry) {
  const res = await build({
    stdin: { contents: `import ${JSON.stringify(entry)};`, resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    metafile: true,
    outfile: "unused.mjs",
    external: ["bullmq", "ioredis"],
    logLevel: "silent",
  });
  return Object.keys(res.metafile.inputs);
}

const PI_OR_TYPEBOX = /node_modules\/(?:@earendil-works\/pi-coding-agent|typebox)\//;

test("insights-assembly.mjs reaches neither the pi runtime nor typebox, and the walk would see them", async () => {
  const files = await reached("./insights-assembly.mjs");
  assert.ok(files.some((f) => f.endsWith("src/read-model.mjs")), "the walk followed the module's imports");
  assert.deepEqual(files.filter((f) => PI_OR_TYPEBOX.test(f)), []);
  // The control: the pricing export this module takes as a parameter instead of importing reaches typebox through pi-ai,
  // so a regression that imports it here turns this red.
  assert.ok((await reached("@edgehero/pi-dispatch/pricing")).some((f) => PI_OR_TYPEBOX.test(f)), "the walk finds typebox where it is");
});

// The facade's shape, canned like the costs tests' (no model is priced, so a metered run keeps its own cost).
const PRICING = { getPricedModel: () => null, isZeroRated: () => false, reprice: () => null, listPricedModels: () => [], piAiVersion: () => "1.2.3" };

function deployment() {
  const dir = tempDir("admin-insights-assembly-");
  const logs = join(dir, "logs");
  const env = {
    // Unparseable, so every Valkey read degrades synchronously (a dead port would leak an async error into the suite).
    VALKEY_URL: "not-a-url",
    PI_LOGS_DIR: logs,
    PI_SETTINGS_FILE: join(dir, "settings.json"),
    PI_TRIGGERS_FILE: join(dir, "triggers.json"),
    PI_SCOPED_LIMITS_FILE: join(dir, "scoped-limits.json"),
    PI_SUBSCRIPTIONS_FILE: join(dir, "subscriptions.json"),
    PI_PROJECTS_FILE: join(dir, "projects.json"),
    PI_GRAPH_DIR: join(dir, "graph"),
  };
  writeFileSync(env.PI_TRIGGERS_FILE, JSON.stringify({ triggers: [{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: join(dir, "absent"), flow: "tidy", task: "t" } }] }));
  writeFileSync(env.PI_SUBSCRIPTIONS_FILE, JSON.stringify({ version: 1, subscriptions: [{ id: "kimi", vendor: "Moonshot AI", provider: "kimi-coding", models: ["*"], price: { amount: 90, currency: "USD", per: "month" } }] }));
  writeFileSync(env.PI_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ id: "site", name: "Site", members: ["github:acme/web"] }] }));
  const endedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const usage = { v: 1, piAi: "1.2.3", truncated: 0, models: [{ provider: "anthropic", model: "claude-sonnet-4", calls: 2, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total: 1500, cost: 0.5 }] };
  const record = { jobId: "cost-1", target: "local:repo", flow: "tidy", outcome: "completed", endedAt, provider: "anthropic", model: "claude-sonnet-4", tokens: { input: 1000, output: 500, total: 1500, cost: 0.5, metered: true, calls: 2, unpriced: 0, unresolved: 0 }, usage };
  mkdirSync(logs);
  writeFileSync(join(logs, "cost-1.json"), JSON.stringify(record));
  return { env, paths: resolvePaths(env) };
}

test("assembleInsights runs in a process without pi, over a small deployment, and its sections render", async () => {
  const { env, paths } = deployment();
  const nowMs = Date.now();
  let envReads = 0;
  const payload = await assembleInsights(paths, "7d", { pricing: PRICING, nowMs, envFn: () => (envReads++, env) });
  assert.deepEqual(Object.keys(payload).sort(), ["allocation", "budget", "capacity", "costByTrigger", "costsUnreachable", "fold", "graph", "projects", "sizing", "window"]);
  assert.equal(payload.window, "7d");
  assert.equal(payload.costsUnreachable, null);
  assert.equal(payload.fold.provenance.runsTotal, 1, "the one run record was folded");
  assert.equal(payload.fold.provenance.piAiPin, "1.2.3", "through the facade it was handed");
  assert.deepEqual(payload.projects, [{ id: "site", name: "Site" }]);
  assert.deepEqual(payload.fold.plans.map((x) => x.id), ["kimi"], "the declared plan was scored");
  assert.deepEqual(payload.allocation, { unset: true }, "no envelope file is named");
  assert.equal(typeof payload.budget.unreachable, "string", "the Valkey read degraded and said so");
  assert.ok(envReads >= 1, "the deployment's environment came from envFn, not this process's");
  // The console's whole insights body still builds from it, and carries every section as the renderers draw it.
  const page = String(insightsBody(payload, nowMs));
  assert.ok(page.includes('id="graph"'));
  const tips = [];
  const nf = html.normFold(payload.fold);
  const scene = buildGraphScene(payload.graph, { now: nowMs });
  const { minted, html: spendHtml } = html.topologySpend(scene, html.normSpendMap(payload.costByTrigger));
  const names = html.normProjectNames(payload.projects);
  const label = html.insightsWindowLabel(payload.window);
  const sections = {
    kpis: html.kpisHtml(nf),
    budget: html.budgetSectionHtml(html.normBudget(payload.budget)),
    split: html.splitSectionHtml(html.normAllocation(payload.allocation), tips, names, label),
    sizing: html.sizingSectionHtml(html.normSizing(payload.sizing), tips, scene.nowMs),
    capacity: html.capacitySectionHtml(html.normCapacity(payload.capacity), tips, scene.nowMs, label),
    plans: html.planCardsHtml(nf.plans),
    daily: html.dailyChartHtml(nf.daily, tips) + html.cumulativeHtml(nf.daily, tips),
    flows: String(html.flowLinesHtml(nf, tips)),
    breakdown: html.breakdownHtml(nf, minted, tips, names),
    topology: html.topologySectionHtml(scene, spendHtml),
    footer: html.footerHtml(nf, label),
    banners: html.costBannersHtml(payload, nf, html.normBudget(payload.budget), html.normAllocation(payload.allocation)),
  };
  for (const [name, out] of Object.entries(sections)) {
    assert.equal(typeof out, "string", name);
    assert.ok(page.includes(out.trim().split("\n")[0]), `${name}: the page carries the same markup`);
  }
  assert.ok(sections.breakdown.includes("tidy"), "the breakdown names the run's flow");
});

/** What the console's CSP (no inline style, no inline script) refuses, in markup. */
const INLINE = /\sstyle\s*=\s*["'`$]|<style\b|<script\b|\son[a-z]+\s*=\s*["'`$]/i;

test("the exported section renderers emit no inline style, script or handler (the console's CSP)", () => {
  // By source, over everything the renderers can emit: both modules minus the stylesheet and the label fitter (which the
  // console serves as its stylesheet and inside its one script).
  const cut = (src, start, end) => {
    const i = src.indexOf(start);
    assert.ok(i >= 0, start);
    const j = src.indexOf(end, i + start.length);
    assert.ok(j >= 0, end);
    return src.slice(0, i) + src.slice(j + end.length);
  };
  let ih = readFileSync(new URL("../src/insights-html.mjs", import.meta.url), "utf8");
  ih = cut(ih, "export const INSIGHTS_CSS = `", "\n`;");
  ih = ih.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, ""); // comments name what is refused
  let gh = readFileSync(new URL("../src/graph-html.mjs", import.meta.url), "utf8");
  gh = cut(gh, "export const FIT_JS = `", "\n`;");
  gh = gh.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
  assert.doesNotMatch(ih, INLINE);
  assert.doesNotMatch(gh, INLINE);
  // And the topology pane's scale cap, the one inline style the page had, is an attribute the CSP allows.
  assert.match(ih, /<svg id="graph" class="canvas" width="\$\{/);
});

// ---- moved from the retired /dispatch insights command (the insights move to the console) ----
// What that command's suite held about the PAGE (its budget, split and capacity sections, the full-paths opt-in, both
// windows) is held here on the console's own renderer over `assembleInsights`; what it held about writing a file and
// opening a browser left with the file.


/** The console's insights body for a payload, as a string (the spend screen's `p-insights` panel draws exactly this). */
const pageOf = (payload, now, opts) => String(insightsBody(payload, now, opts));

const cmdFixtureDir = tempDir("admin-insights-cmd-fixture-");
const cmdLogsDir = tempDir("admin-insights-cmd-logs-");
const cmdTriggersPath = join(cmdFixtureDir, "triggers.json");
writeFileSync(cmdTriggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: join(cmdFixtureDir, "absent"), flow: "tidy", task: "t" } }] }));

/** A deployment's paths whose every Valkey read degrades synchronously (an unparseable URL). */
function cannedPaths() {
  return {
    triggersPath: cmdTriggersPath,
    logsDir: cmdLogsDir,
    subscriptionsPath: join(cmdFixtureDir, "subscriptions.json"), // absent: degrades to no plans
    valkeyUrl: "not-a-url",
    chainDepthMax: 1,
    chainMaxPerJob: 2,
  };
}

/** `assembleInsights` then the console's renderer, at one instant, as the spend screen does for one request. */
async function assembledPage(paths, window, { fullPaths = false, now = 1770000000000 } = {}) {
  const payload = await assembleInsights(paths, window, { pricing: PRICING, fullPaths, nowMs: now, envFn: () => ({}) });
  return pageOf(payload, now, { fullPaths });
}

test("full paths are the explicit opt-in that puts run.folder paths into the page (an operator's ?paths=full)", async () => {
  const probe = join(cmdFixtureDir, "absent");
  assert.ok(!(await assembledPage(cannedPaths(), "30d")).includes(probe), "the default page carries no absolute host path");
  assert.ok((await assembledPage(cannedPaths(), "30d", { fullPaths: true })).includes(probe), "the opted-in page names the configured folder by its full path");
});

test("the page carries both halves: the topology svg and the spend section, windows both stated", async () => {
  const page = await assembledPage(cannedPaths(), "7d");
  assert.ok(page.includes('id="graph"'), "the topology pane is in the page");
  assert.ok(page.includes("spend window: last 7d"), "the requested spend window is stated");
  assert.ok(page.includes("topology: fixed 30d record window"), "the fixed topology window is stated beside it");
});

test("the page carries the budget panel: unreachable canned queue stated as a banner, the lever named", async () => {
  const page = await assembledPage(cannedPaths(), "30d");
  assert.ok(page.includes("<h2>budget</h2>"), "the budget panel renders even with the canned dead queue");
  assert.ok(page.includes("budget unreachable:"), "the absence is a banner, not a silent gap");
  assert.ok(page.includes("adjust: /dispatch set dailyCap"), "the lever is named -- the panel exists to point at it");
});

test("the budget slice carries the scoped rows from the limits file; a dead queue leaves used as ? not 0", async () => {
  const dir = tempDir("admin-insights-sl-");
  const slPath = join(dir, "scoped-limits.json");
  writeFileSync(slPath, JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 10, concurrent: 2 }] }));
  const page = await assembledPage({ ...cannedPaths(), scopedLimitsPath: slPath }, "30d");
  assert.ok(page.includes("scoped limits (scoped-limits.json)"), "the configured limits reach the page");
  assert.ok(page.includes("day used ? / cap 10"), "the dead queue leaves used unknown, never an invented zero");
  assert.ok(page.includes("concurrent ≤2 (config; in-flight not shown)"), "concurrency stays config-only");
});

test("the budget slice carries a scoped row's dollar windows, so a dollar-only row is not drawn bare (#507)", async () => {
  // A `model:` row, or a `project:` row with only `weekUsd`, has no job-count window; the page drew its scope and no
  // number. The counters come from the one scoped read the slice already makes (`usdMicros`), the caps from the file.
  const dir = tempDir("admin-insights-usd-");
  const slPath = join(dir, "scoped-limits.json");
  writeFileSync(slPath, JSON.stringify({ version: 2, limits: [
    { scope: "acme/web", day: 10 },
    { scope: "project:shop", weekUsd: "45" },
    { scope: "model:anthropic/claude-sonnet-4-5", weekUsd: "80", monthUsd: "300.5" },
  ] }));
  const shop = scopeDollarKeyPrefix("project:shop");
  const model = modelDollarKeyPrefix("anthropic/claude-sonnet-4-5");
  const redis = {
    on() {},
    disconnect() {},
    async get(key) {
      if (key.startsWith(shop)) return "6340917";
      if (key.startsWith(model) && key.includes(":w:")) return "7966101";
      return null;
    },
  };
  const view = await ia.assembleBudgetView({ valkeyUrl: "redis://127.0.0.1:1", scopedLimitsPath: slPath }, { redisFn: () => redis });
  assert.deepEqual(view.scoped.map((r) => r.usd), [
    { day: null, week: null, month: null },
    { day: null, week: { usedMicros: 6_340_917, capMicros: 45_000_000 }, month: null },
    { day: null, week: { usedMicros: 7_966_101, capMicros: 80_000_000 }, month: { usedMicros: 0, capMicros: 300_500_000 } },
  ]);
  const dead = await ia.assembleBudgetView({ valkeyUrl: "not-a-url", scopedLimitsPath: slPath });
  assert.deepEqual(dead.scoped[1].usd.week, { usedMicros: null, capMicros: 45_000_000 }, "a dead queue leaves the counter unknown, never $0");
});

test("with an envelope set, the split is read through readAllocations, without hosts or reasons, and counted from the records (#507)", async () => {
  // The slice's assembler on its own: the rest of assembleInsights dials the real queue (the budget read), which a unit
  // test cannot fake, so the page half is the console's insights body over exactly what this returns.
  const { fakeAllocRedis } = await import("./helpers/fake-alloc-redis.mjs");
  const { readEnvelope } = await import("../src/read-model.mjs");
  const dir = tempDir("admin-insights-split-");
  const files = { envelope: join(dir, "envelope.json"), projects: join(dir, "projects.json"), settings: join(dir, "settings.json") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", _other: "0" }, defaultWeights: { shop: 1, _other: 0 }, delegation: { enabled: true, writers: ["portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  writeFileSync(files.settings, JSON.stringify({ maxCostUsd: "2" }));
  const digest = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 }).digest;
  const redis = fakeAllocRedis();
  const M = 1_000_000;
  redis.store.set("t507:plan", JSON.stringify({ version: 1, envelopeDigest: digest, planId: "3f9a0c1d2e4b5a67", writer: "portfolio-job", appliedAt: "2026-10-05T06:00:00.000Z", weights: { shop: 1, _other: 0 }, allocations: { shop: 100 * M, _other: 0 }, unallocated: 0, repos: {}, clamped: false, reasons: { shop: "CANARY-REASON" } }));
  redis.lists.set("t507:log", [JSON.stringify({ at: "2026-10-05T06:00:00.000Z", host: "CANARY-HOST", writer: "portfolio-job", outcome: "applied", reason: null, planId: "3f9a0c1d2e4b5a67", weights: { shop: 1 } })]);
  const records = [
    { jobId: "a", outcome: "policy", reason: "allocation-cap" },
    { jobId: "b", outcome: "completed", reason: null, plan: { outcome: "refused", reason: "plan-stale", planId: null, clamped: false } },
    { jobId: "c", outcome: "completed", reason: null, plan: { outcome: "applied", reason: null, planId: "3f9a0c1d2e4b5a67", clamped: false } },
    { jobId: "d", outcome: "policy", reason: "over-budget" },
    // PR #580's reason: a portfolio run that wrote no plan, counted under its reason like any refusal.
    { jobId: "e", outcome: "completed", reason: null, plan: { outcome: "refused", reason: "plan-absent", planId: null, clamped: false } },
  ];
  const paths = { envelopeFile: files.envelope, projectsFile: files.projects, settingsFile: files.settings, valkeyUrl: "redis://127.0.0.1:6390" };
  ia._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507", now: () => new Date(Date.parse("2026-10-05T12:00:00Z")) });
  let slice;
  try {
    slice = await ia.assembleAllocationView(paths, ia.splitCounts(records), { nowMs: Date.parse("2026-10-05T12:00:00Z") });
    const viewer = await ia.assembleAllocationView(paths, null, { consoleView: true, role: "viewer", nowMs: Date.parse("2026-10-05T12:00:00Z") });
    const operator = await ia.assembleAllocationView(paths, null, { consoleView: true, role: "operator", nowMs: Date.parse("2026-10-05T12:00:00Z") });
    assert.equal(viewer.log[0].host, "CANARY-HOST", "the console names the host without changing shareable exports");
    assert.deepEqual(viewer.state.weights, { shop: 1, _other: 0 });
    assert.equal("reasons" in viewer.state, false, "a viewer's data never contains the plan text");
    assert.equal(operator.state.reasons.shop, "CANARY-REASON");
    assert.equal(viewer.envelope.delegation.maxPlanDays, 14, "structured forms receive the parsed envelope bounds");
  } finally {
    ia._setAllocationSeamsForTests({});
  }
  assert.deepEqual(slice.counts, { refusals: { "allocation-cap": 1, "envelope-mismatch": 0, "portfolio-no-envelope": 0, "portfolio-snapshot-oversize": 0 }, plans: { "plan-stale": 1, applied: 1, "plan-absent": 1 } });
  assert.deepEqual(slice.log, [{ at: "2026-10-05T06:00:00.000Z", writer: "portfolio-job", outcome: "applied", reason: null, planId: "3f9a0c1d2e4b5a67" }], "a row cut to its enum fields: no host");
  assert.equal(JSON.stringify(slice).includes("CANARY"), false, "no host and no reason text leave the assembler");
  assert.equal(slice.mismatch, false);
  const page = pageOf({ allocation: slice, window: "30d" }, 0);
  assert.ok(page.includes('<span class="wl">envelope</span><span>$100.00 per week · delegation on</span>'), "the envelope the worker's parser read");
  assert.ok(page.includes('plan 3f9a0c1d2e4b5a67 · written by portfolio-job · applied <time datetime="2026-10-05T06:00:00Z">2026-10-05 06:00 UTC</time>'));
  assert.ok(page.includes("plans collected in runs on this host, last 30d: applied 1 · plan-absent 1 · plan-stale 1</div>"));
  assert.equal(ia.splitCounts({ unreachable: "EACCES" }), null, "an unread scan counts nothing");
  assert.equal(slice.outsideEdit, null);

  // No envelope, and an envelope that does not load: neither reads the queue at all.
  let dials = 0;
  ia._setAllocationSeamsForTests({ redisFn: () => { dials += 1; throw new Error("dialled"); }, prefix: "t507" });
  try {
    assert.deepEqual(await ia.assembleAllocationView({ envelopeFile: null }, null, { nowMs: Date.parse("2026-10-05T12:00:00Z") }), { unset: true });
    writeFileSync(files.envelope, "{ not json");
    // A broken envelope names its file by basename only: a viewer reads the page too.
    assert.deepEqual(await ia.assembleAllocationView(paths, null, { nowMs: Date.parse("2026-10-05T12:00:00Z") }), { problem: "the envelope file does not load: envelope file is not valid JSON (at character 2): envelope.json" });
    // An operator's ?paths=full is the page's one opt-in for host paths, and it holds here too.
    assert.deepEqual(await ia.assembleAllocationView(paths, null, { fullPaths: true, nowMs: Date.parse("2026-10-05T12:00:00Z") }), { problem: `the envelope file does not load: envelope file is not valid JSON (at character 2): ${files.envelope}` });
    // The cut is made on the parser's raw text: a folder whose name the escape rewrites still loses its path.
    const odd = join(dir, "zero\u200bwidth");
    mkdirSync(odd);
    writeFileSync(join(odd, "envelope.json"), "{ not json");
    assert.deepEqual(await ia.assembleAllocationView({ ...paths, envelopeFile: join(odd, "envelope.json") }, null, { nowMs: Date.parse("2026-10-05T12:00:00Z") }), { problem: "the envelope file does not load: envelope file is not valid JSON (at character 2): envelope.json" });
  } finally {
    ia._setAllocationSeamsForTests({});
  }
  assert.equal(dials, 0, "no queue read for an unset or a broken envelope");
});

test("during an envelope mismatch every total shown is the applied split's, and the mismatch line says this host's file differs, on the text twin, the assembler and the insights page (#507)", async () => {
  const { fakeAllocRedis } = await import("./helpers/fake-alloc-redis.mjs");
  const { fileTotalText, renderAllocations, splitTotalMicros } = await import("../src/render.mjs");
  const { readEnvelope } = await import("../src/read-model.mjs");
  const dir = tempDir("admin-insights-total-");
  const files = { envelope: join(dir, "envelope.json"), projects: join(dir, "projects.json"), settings: join(dir, "settings.json") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  // This host's file says $30; the applied split was made for a $28 envelope (the e2e's outside edit).
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "30", floorsUsd: { shop: "10", _other: "0" }, defaultWeights: { shop: 1, _other: 0 }, delegation: { enabled: true, writers: ["portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  writeFileSync(files.settings, JSON.stringify({ maxCostUsd: "2" }));
  const read = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 });
  const paths = { envelopeFile: files.envelope, projectsFile: files.projects, settingsFile: files.settings, valkeyUrl: "redis://127.0.0.1:6390" };
  const M = 1_000_000;
  const made = "5428cdb615bcf0d2";
  const state = { version: 1, envelopeDigest: made, planId: "13a11619b5ea3d49", writer: "portfolio-job", appliedAt: "2026-10-05T10:06:00.000Z", weights: { shop: 1, _other: 0 }, allocations: { shop: 27 * M, _other: 0 }, unallocated: 1 * M, repos: {}, clamped: false };
  assert.equal(splitTotalMicros(state, 30 * M), 28 * M);
  assert.equal(splitTotalMicros(null, 30 * M), 30 * M, "no split: the envelope's");
  assert.equal(splitTotalMicros({ ...state, unallocated: -1 }, 30 * M), 30 * M, "a split that does not decode: the envelope's");
  const redis = fakeAllocRedis();
  redis.store.set("t507t:plan", JSON.stringify(state));
  ia._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507t", now: () => new Date(Date.parse("2026-10-05T14:00:00Z")) });
  let slice;
  try {
    slice = await ia.assembleAllocationView(paths, null);
  } finally {
    ia._setAllocationSeamsForTests({});
  }
  assert.deepEqual([slice.totalMicros, slice.fileTotalMicros, slice.mismatch], [28 * M, 30 * M, true]);
  const note = fileTotalText("$30.00");
  assert.equal(note, " This host's file says total $30.00; the totals shown are the split's.");
  const text = renderAllocations({ envelope: read.envelope, digest: read.digest, alloc: { state, log: [], spend: { deployment: { micros: 8 * M } } } }).split("\n");
  assert.match(text[0], /^ALLOCATION · week · total \$28\.00 · /);
  assert.ok(text.includes(`made for envelope ${made}, not this host's: governed jobs here refuse as envelope-mismatch.${note}`), text.join("\n"));
  assert.ok(text.includes("  unallocated $1.00 · deployment spent $8.00 of $28.00"), text.join("\n"));
  const page = pageOf({ allocation: slice, window: "30d" }, 0);
  assert.ok(page.includes("<span>$28.00 per week · delegation on</span>"), "the envelope row");
  assert.ok(page.includes(`governed jobs on this host refuse as envelope-mismatch.${note}</span>`), "the page's mismatch line, in render.mjs' words");
  assert.ok(page.includes("of $28.00</span>"), "the headroom");
  assert.ok(!page.includes("of $30.00"));
  // The same split on a host whose file agrees: no note, and the totals are the same number.
  const agreeing = renderAllocations({ envelope: { ...read.envelope, totalMicros: 28 * M }, digest: read.digest, alloc: { state, log: [], spend: {} } });
  assert.ok(!agreeing.includes("This host's file says"), agreeing);
  assert.ok(agreeing.includes(`made for envelope ${made}, not this host's: governed jobs here refuse as envelope-mismatch\n`), "the line ends where it always did");
});

test("during an envelope mismatch an entry only the split allocates is listed and marked on the text twin and the insights page, by one rule (#507)", async () => {
  const { fakeAllocRedis } = await import("./helpers/fake-alloc-redis.mjs");
  const { allocationRowIds, renderAllocations, SPLIT_ONLY_MARK } = await import("../src/render.mjs");
  const { readEnvelope } = await import("../src/read-model.mjs");
  const dir = tempDir("admin-insights-splitonly-");
  const files = { envelope: join(dir, "envelope.json"), projects: join(dir, "projects.json"), settings: join(dir, "settings.json") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  // This host's file dropped `legacy`; the applied split, made for the old envelope, still allocates it.
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "30", floorsUsd: { shop: "10", _other: "0" }, defaultWeights: { shop: 1, _other: 0 }, delegation: { enabled: true, writers: ["portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  writeFileSync(files.settings, JSON.stringify({ maxCostUsd: "2" }));
  const read = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 });
  const paths = { envelopeFile: files.envelope, projectsFile: files.projects, settingsFile: files.settings, valkeyUrl: "redis://127.0.0.1:6390" };
  const M = 1_000_000;
  const state = { version: 1, envelopeDigest: "5428cdb615bcf0d2", planId: "13a11619b5ea3d49", writer: "portfolio-job", appliedAt: "2026-10-05T10:06:00.000Z", weights: { shop: 2, legacy: 1, _other: 0 }, allocations: { shop: 20 * M, legacy: 7 * M, _other: 0 }, unallocated: 1 * M, repos: {}, clamped: false };
  assert.deepEqual(allocationRowIds(read.envelope.floors, state, true).filter((r) => r.splitOnly).map((r) => r.id), ["legacy"]);
  assert.deepEqual(allocationRowIds(read.envelope.floors, state, false).filter((r) => r.splitOnly), [], "no mismatch: the file's entries alone");
  const text = renderAllocations({ envelope: read.envelope, digest: read.digest, alloc: { state, log: [], spend: {} } }).split("\n");
  const legacy = text.find((l) => l.trim().startsWith("legacy"));
  assert.ok(legacy, text.join("\n"));
  assert.match(legacy, new RegExp(`^  legacy\\s+floor -\\s+weight 1\\s+allocation \\$7\\.00\\s+spent -\\s+${SPLIT_ONLY_MARK}$`));
  assert.ok(text[0].includes("total $28.00"), "the row the total counted is the row shown");
  const agreeing = renderAllocations({ envelope: read.envelope, digest: read.digest, alloc: { state: { ...state, envelopeDigest: read.digest }, log: [], spend: {} } });
  assert.ok(!agreeing.includes("legacy"), "the same split on its own envelope lists the file's entries alone");
  const redis = fakeAllocRedis();
  redis.store.set("t507s:plan", JSON.stringify(state));
  ia._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507s", now: () => new Date(Date.parse("2026-10-05T14:00:00Z")) });
  let slice;
  try {
    slice = await ia.assembleAllocationView(paths, null);
  } finally {
    ia._setAllocationSeamsForTests({});
  }
  const page = pageOf({ allocation: slice, window: "30d" }, 0);
  assert.ok(page.includes(`$7.00 allocated · ${SPLIT_ONLY_MARK.replace("'", "&#39;")}`), "the page's bar row, in render.mjs' words, escaped");
  assert.ok(page.includes(`>legacy</text>`), "its label");
  const agreeingPage = pageOf({ allocation: { ...slice, mismatch: false }, window: "30d" }, 0);
  assert.ok(!agreeingPage.includes(">legacy</text>"));
});

test("the outside-edit notice is one rule and one sentence on the panel's text twin, the assembler and the insights page (#507)", async () => {
  const { fakeAllocRedis } = await import("./helpers/fake-alloc-redis.mjs");
  const { outsideEdit, outsideEditText, renderAllocations } = await import("../src/render.mjs");
  const { readEnvelope } = await import("../src/read-model.mjs");
  const dir = tempDir("admin-insights-outside-");
  const files = { envelope: join(dir, "envelope.json"), projects: join(dir, "projects.json"), settings: join(dir, "settings.json") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", _other: "0" }, defaultWeights: { shop: 1, _other: 0 }, delegation: { enabled: true, writers: ["portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  writeFileSync(files.settings, JSON.stringify({ maxCostUsd: "2" }));
  const read = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 });
  const digest = read.digest;
  const paths = { envelopeFile: files.envelope, projectsFile: files.projects, settingsFile: files.settings, valkeyUrl: "redis://127.0.0.1:6390" };
  const M = 1_000_000;
  const state = { version: 1, envelopeDigest: digest, planId: "3f9a0c1d2e4b5a67", writer: "portfolio-job", appliedAt: "2026-10-05T06:00:00.000Z", weights: { shop: 1, _other: 0 }, allocations: { shop: 100 * M, _other: 0 }, unallocated: 0, repos: {}, clamped: false };
  const other = "e2e2e2e2e2e2e2e2";
  const outside = { at: "2026-10-05T13:00:00.000Z", writer: "envelope-change", outcome: "envelope-changed-externally", reason: "envelope-mismatch", envelopeDigest: other };
  const applied = { at: "2026-10-05T12:00:00.000Z", writer: "operator-session", outcome: "applied", planId: "3f9a0c1d2e4b5a67", envelopeDigest: digest };
  const refused = { at: "2026-10-05T12:30:00.000Z", writer: "operator-session", outcome: "refused", reason: "plan-too-soon" };
  const restored = { ...outside, envelopeDigest: digest };
  const cases = [[[outside, applied], true], [[applied, outside], true], [[refused, outside, applied], true], [[restored, outside], false], [[], false]];
  for (const [log, want] of cases) {
    const redis = fakeAllocRedis();
    redis.store.set("t507:plan", JSON.stringify(state));
    redis.lists.set("t507:log", log.map((r) => JSON.stringify(r)));
    ia._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507", now: () => new Date(Date.parse("2026-10-05T14:00:00Z")) });
    let slice;
    try {
      slice = await ia.assembleAllocationView(paths, null);
    } finally {
      ia._setAllocationSeamsForTests({});
    }
    const label = JSON.stringify(log.map((r) => r.outcome));
    const rule = outsideEdit(log, digest);
    assert.equal(rule !== null, want, label);
    assert.deepEqual(slice.outsideEdit, rule, `the assembler applies the rule: ${label}`);
    const text = renderAllocations({ envelope: read.envelope, digest, alloc: { state, log, spend: {} } });
    const page = pageOf({ allocation: slice, window: "30d" }, 0);
    if (want) {
      const words = outsideEditText(rule);
      assert.equal(words, `a host reported envelope e2e2e2e2 at 10-05 13:00, not the one the split was made for (${digest.slice(0, 8)}); a host still on it refuses governed jobs as envelope-mismatch`);
      assert.ok(text.split("\n").includes(words), `the text twin: ${label}`);
      assert.ok(page.includes(`<span class="state">${words}</span>`), `the page: ${label}`);
    } else {
      assert.ok(!text.includes("a host reported envelope") && !page.includes("a host reported envelope"), label);
    }
  }
});

// ---- the capacity section's assembler (issue #599, phase 4) ----

const { computeCapacity } = await import("@edgehero/pi-dispatch/capacity");
const { TRUNCATED_NOTE, capacityText } = await import("@edgehero/pi-dispatch/capacity-cli");

const CNOW = Date.parse("2026-10-08T12:00:00.000Z");
const CH = 60 * 60 * 1000;
function capReport() {
  const cap = { slots: 4, memMiB: 16384, cpuCenti: 800, cpus: 8 };
  const rec = (jobId, host, project, from, to, extra = {}) => ({ jobId, host, project, startedAt: new Date(CNOW - from * CH).toISOString(), endedAt: new Date(CNOW - to * CH).toISOString(), queuedAt: new Date(CNOW - from * CH - 40_000).toISOString(), capacity: cap, size: { memMiB: 4096, cpuCenti: 200, source: "env" }, resources: { cpuUsec: 3_600_000_000 }, ...extra });
  const records = [rec("a", "mini1", "web", 30, 28), rec("b", "mini1", "api", 29, 27), rec("c", "mini1", "web", 5, 4, { attempt: 2 }), rec("d", "mini2", "docs", 3, 1), { ...rec("e", "mini1", "web", 2, 2), capacity: null }];
  const live = [{ name: "mini1", routes: "true", concurrency: "4", staleMs: 1000, jobs: "[]" }, { name: "mini2", routes: "true", concurrency: "2", staleMs: 1000, jobs: "[]" }, { name: "laptop", routes: "false", concurrency: "1", staleMs: 1000, jobs: "[]" }];
  const coverage = { source: "mirror", reason: null, localHost: "mini1", local: null, mirror: { fromMs: CNOW - 48 * CH, truncated: true, hosts: ["mini1", "mini2"] } };
  return computeCapacity({ records, live, windowStartMs: CNOW - 7 * 24 * CH, nowMs: CNOW, bucketMs: CH, coverage });
}

test("capacityViewOf: every headline number and caveat is the CLI's own text for the same report", () => {
  const report = capReport();
  const view = ia.capacityViewOf(report);
  const text = capacityText(report, { since: "7d" });
  assert.deepEqual(view.window, report.window);
  assert.equal(view.truncated, true);
  // The page draws the cut history as its own warning (`truncated`), where the CLI's line says it as a clause.
  assert.equal(`Coverage: ${[view.coverage[0], TRUNCATED_NOTE, ...view.coverage.slice(1)].join("; ")}.`, text.trim().split("\n").at(-2), "the coverage clauses are the CLI's, one by one");
  assert.deepEqual(view.hosts.map((h) => h.name), ["laptop", "mini1", "mini2"]);
  const laptop = view.hosts[0];
  assert.equal(laptop.facts, undefined, "a host whose history is not here has no numbers");
  assert.ok(text.includes(`no history here: ${laptop.notShared}`));
  for (const h of view.hosts.slice(1)) {
    const f = h.facts;
    const of = f.slots !== null ? ` of ${f.slots}` : "";
    assert.ok(text.includes(`  busy ${f.busy}, idle ${f.idle}${f.missing ? ` (${f.missing} of the window has no history)` : ""}\n`), h.name);
    assert.ok(text.includes(`  slots: avg ${f.avg}${of}, peak ${f.peak}${of}${f.full !== null ? `, full ${f.full} of the time` : ""}`), h.name);
    assert.ok(text.includes(`  promised: ${f.memory}, ${f.cpu}\n`), h.name);
    if (f.cpuUsed !== null) assert.ok(text.includes(`  CPU used: ${f.cpuUsed}\n`), h.name);
    assert.ok(text.includes(f.wait === null ? "  wait for a slot: no run recorded one" : `  wait for a slot: ${f.wait}\n`), h.name);
    if (f.projects.length > 0) assert.ok(text.includes(`  projects by run time: ${f.projects.join(", ")}\n`), h.name);
    for (const c of h.caveats.filter((c) => !c.startsWith("slots: "))) assert.ok(text.includes(`  ${c}\n`), `${h.name}: ${c}`);
    assert.ok(text.includes(`  ${h.notes}\n`), h.name);
    assert.deepEqual(h.buckets, report.hosts.find((r) => r.name === h.name).buckets, "the buckets as the report has them");
  }
  // the hand-checkable ones: mini1's two runs overlap for an hour, and its history starts 48h back, inside the window
  const mini1 = view.hosts[1];
  assert.equal(mini1.facts.peak, 2);
  assert.equal(mini1.facts.missing, "71.4%");
  assert.equal(mini1.truncated, true);
  assert.ok(mini1.caveats.includes("1 job refused before a slot"));
  assert.ok(mini1.caveats.some((c) => c.startsWith("1 retried run")));
});

test("assembleCapacityView: the page's window and instant reach the read, mtd from the start of the month", async () => {
  const seen = [];
  const readCapacityFn = async (args) => (seen.push(args), { report: capReport() });
  const paths = cannedPaths();
  const view = await ia.assembleCapacityView(paths, "mtd", CNOW, { readCapacityFn, env: {} });
  assert.equal(view.hosts.length, 3);
  const [a] = seen;
  assert.equal(a.url, "not-a-url");
  assert.equal(a.now(), CNOW, "the page's instant, not a clock of its own");
  assert.equal(a.span.sinceMs(CNOW), Date.parse("2026-10-01T00:00:00.000Z"), "mtd starts at the start of the month, as the spend does");
  assert.equal(a.span.bucketMs, 6 * CH);
  await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn, env: {} });
  assert.equal(seen[1].span.sinceMs(CNOW), CNOW - 7 * 24 * CH);
  assert.equal(seen[1].span.bucketMs, CH);
  await ia.assembleCapacityView(paths, "30d", CNOW, { readCapacityFn, env: {} });
  assert.equal(seen[2].span.sinceMs(CNOW), CNOW - 30 * 24 * CH);
  assert.equal(seen[2].span.bucketMs, 6 * CH);
  assert.deepEqual(ia.INSIGHTS_CAPACITY_BUCKET_MS, { "24h": CH, "7d": CH, "30d": 6 * CH, mtd: 6 * CH });
  // a read that fails says so; it is never a host with nothing to show
  assert.deepEqual(await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn: async () => ({ error: "PI_LOG_RETENTION_DAYS must be a non-negative integer" }), env: {} }), { unreachable: "PI_LOG_RETENTION_DAYS must be a non-negative integer" });
  assert.deepEqual(await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn: async () => { throw new Error("EACCES"); }, env: {} }), { unreachable: "the capacity report could not be read (EACCES)" });
});

test("the page carries the capacity section for its window, read with the page's own instant", async () => {
  const page = await assembledPage(cannedPaths(), "mtd", { now: CNOW });
  assert.ok(page.includes("<h2>capacity</h2>"));
  assert.ok(page.includes('month to date, from <time datetime="2026-10-01T00:00:00.000Z">2026-10-01 00:00 UTC</time> to <time datetime="2026-10-08T12:00:00.000Z">2026-10-08 12:00 UTC</time>'), "the window is the page's, ending at its instant");
  assert.ok(page.includes("Jobs only: a machine busy with other work reads as idle."));
});

test("assembleCapacityView: a report it cannot word degrades the section, and the month's first millisecond is no time yet", async () => {
  const paths = cannedPaths();
  for (const junk of [{ hosts: [null] }, { hosts: [{ name: "a", shared: true, coveredMs: 5 }] }, { hosts: [{ name: "a", shared: true, coveredMs: 5, capacity: {}, waits: { n: 0 }, projects: null }] }]) {
    const view = await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn: async () => ({ report: junk }), env: {} });
    assert.match(view.unreachable, /^the capacity report could not be read/, JSON.stringify(junk));
  }
  for (const coverage of [null, 7]) {
    const view = await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn: async () => ({ report: { ...capReport(), coverage } }), env: {} });
    assert.ok(Array.isArray(view.hosts) && Array.isArray(view.coverage), `a coverage of ${coverage} is worded as none`);
  }
  const first = Date.parse("2026-10-01T00:00:00.000Z");
  let asked = 0;
  const v = await ia.assembleCapacityView(paths, "mtd", first, { readCapacityFn: async () => (asked++, { report: capReport() }), env: {} });
  assert.deepEqual(v, { noTime: true, fromMs: first });
  assert.equal(asked, 0, "nothing to read");
});

test("capacityViewOf: a long list of hosts whose history is not here is summarised, and nothing after it is lost", () => {
  const report = capReport();
  report.coverage = { ...report.coverage, historyNotShared: Array.from({ length: 14 }, (_, i) => `h${String(i).padStart(2, "0")}-${"x".repeat(58)}`), withoutHost: 3, reason: "Valkey did not answer" };
  const view = ia.capacityViewOf(report);
  assert.equal(view.coverage[1], `14 hosts whose history is not here: ${report.coverage.historyNotShared.slice(0, ia.INSIGHTS_CAPACITY_NAMES_SHOWN).join(", ")} and 9 more`);
  assert.ok(view.coverage.includes("3 without a host, not counted"));
  assert.equal(view.coverage.at(-1), "Valkey did not answer");
});

test("console Capacity coverage preserves actual zero counts and unknowns without widening static export", () => {
  const report = capReport();
  const consoleView = ia.capacityViewOf(report, { consoleDetails: true });
  assert.equal(consoleView.hostCount, report.hosts.length);
  for (const key of ["used", "refusedBeforeSlot", "retried", "withoutSize", "live", "liveNotCounted", "running"]) assert.equal(consoleView.coverageCounts[key], report.coverage[key], key);
  assert.equal(consoleView.coverageCounts.source, report.coverage.source);
  const unknown = ia.capacityViewOf({ ...report, coverage: { ...report.coverage, used: undefined, retried: 0, withoutSize: -1, running: null } }, { consoleDetails: true });
  assert.equal(unknown.coverageCounts.used, null);
  assert.equal(unknown.coverageCounts.retried, 0);
  assert.equal(unknown.coverageCounts.withoutSize, null);
  assert.equal(unknown.coverageCounts.running, null);
  const shared = ia.capacityViewOf(report);
  assert.equal("coverageCounts" in shared, false);
  assert.equal("hostCount" in shared, false);
  assert.equal(shared.hosts.some((host) => "venues" in host), false);
});
