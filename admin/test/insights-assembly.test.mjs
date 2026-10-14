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
  // The whole page still builds from it, and every section the console draws on its own renders the same slices.
  const page = html.buildInsightsHtml(payload, { now: nowMs });
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
  // By source, over everything the renderers can emit: both modules minus the page's own stylesheet and scripts and
  // the one function that wraps them into the file:// page.
  const cut = (src, start, end) => {
    const i = src.indexOf(start);
    assert.ok(i >= 0, start);
    const j = src.indexOf(end, i + start.length);
    assert.ok(j >= 0, end);
    return src.slice(0, i) + src.slice(j + end.length);
  };
  let ih = readFileSync(new URL("../src/insights-html.mjs", import.meta.url), "utf8");
  ih = cut(ih, "export const INSIGHTS_CSS = `", "\n`;");
  ih = cut(ih, "export const INSIGHTS_JS = `", "\n`;");
  ih = cut(ih, "export function buildInsightsHtml(", "\n}\n");
  ih = ih.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, ""); // comments name what is refused
  let gh = readFileSync(new URL("../src/graph-html.mjs", import.meta.url), "utf8");
  gh = cut(gh, "export const FIT_JS = `", "\n`;");
  gh = cut(gh, "export const PAGE_JS = `", "\n`;");
  gh = gh.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
  assert.doesNotMatch(ih, INLINE);
  assert.doesNotMatch(gh, INLINE);
  // And the topology pane's scale cap, the one inline style the page had, is an attribute the CSP allows.
  assert.match(ih, /<svg id="graph" class="canvas" width="\$\{/);
});
