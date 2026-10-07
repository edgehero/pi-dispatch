import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { stripAnsi } from "../src/style.mjs";
import { largestHostBudget, readSizeSuggestions } from "../src/read-model.mjs";
import { PAGE_THEME } from "../src/graph-html.mjs";
import { INSIGHTS_CPU_REASONS, INSIGHTS_MEMORY_REASONS, buildInsightsHtml, layoutSizingChart, sizeCpuText, sizeMemText } from "../src/insights-html.mjs";
import { CPU_REASONS, MEMORY_REASONS } from "@edgehero/pi-dispatch/size-suggest";
import { formatCpus, formatMemory } from "@edgehero/pi-dispatch/job-size";
import { parseScopedLimits } from "@edgehero/pi-dispatch/scoped-limits";

/**
 * Issue #596, phase 3 (DES-SIZE-SUGGESTIONS): the admin's size suggestion surfaces. The reader over the run records,
 * the PROJECTS view (size, p95 peaks, the suggestion and the exact call), the `dispatch_limit_edit` preview (the
 * project's peaks when a size field is edited) and the insights page (peak against size over time, the hosts'
 * budgets). Every clock is injected; records written to disk are dated relative to the clock the subject reads.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIB = 1024 * 1024;
const MIN = 60 * 1000;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const fakeTui = () => ({ requestRender() {} });

function rec({ i = 0, at = NOW, project = "shop", memMiB = 4096, cpuCenti = 200, peakMiB = 1024, cores = 1, reason = null } = {}) {
  const end = at - (i + 1) * MIN;
  return {
    jobId: `j-${project}-${i}`,
    project,
    reason,
    startedAt: new Date(end - 10 * MIN).toISOString(),
    endedAt: new Date(end).toISOString(),
    resources: { memPeak: peakMiB * MIB, cpuUsec: Math.round(cores * 10 * MIN * 1000), throttledUsec: 0 },
    size: { memMiB, cpuCenti, source: "project" },
  };
}
function logsWith(records) {
  const dir = tempDir("pd-596-sizing-logs-");
  records.forEach((r, i) => writeFileSync(join(dir, `r${i}.json`), JSON.stringify(r)));
  return dir;
}

test("readSizeSuggestions: the worker's suggestion per project, with its call and words; an unreadable logs dir says so", () => {
  const logsDir = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 }), ...Array.from({ length: 12 }, (_, i) => rec({ i: 10 + i, project: "ops", peakMiB: 3000 }))]);
  const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "4g" }] }), "sl.json");
  const res = readSizeSuggestions({ logsDir, projectIds: ["shop", "ops"], limits, env: {}, budget: { memMiB: 5120, cpuCenti: 800 }, nowMs: NOW, withSeries: true });
  assert.deepEqual([res.projects.shop.memory.suggested, res.projects.shop.memory.reason, res.projects.shop.memory.overBudget], [6144, "oom-killed", true]);
  assert.equal(res.projects.shop.call, 'dispatch_limit_edit {"index":0,"memory":"6g"}');
  assert.equal(res.projects.shop.words.memory, "1 run ended oom-killed");
  assert.deepEqual(res.projects.shop.series, [{ at: NOW - MIN, peakMiB: 4096, sizeMiB: 4096, oom: true }]);
  assert.deepEqual([res.projects.ops.memory.reason, res.projects.ops.call], ["fits", null]);
  assert.equal(readSizeSuggestions({ logsDir, projectIds: ["shop"], nowMs: NOW }).projects.shop.series, undefined, "no series unless asked");
  // a refused deployment size leaves the project out rather than guessing one
  assert.deepEqual(readSizeSuggestions({ logsDir, projectIds: ["shop"], env: { PI_JOB_MEMORY: "4GB" }, nowMs: NOW }).projects, {});
  const file = join(logsDir, "r0.json");
  assert.match(readSizeSuggestions({ logsDir: file, projectIds: ["shop"], nowMs: NOW }).unreachable, /logs dir unreadable/);
});

test("largestHostBudget: the largest published budget per dimension; off wins; unknown rows are skipped; none is null", () => {
  assert.equal(largestHostBudget([]), null);
  assert.equal(largestHostBudget([{ name: "a", budgetMemMiB: "", budgetCpuCenti: "" }]), null);
  assert.deepEqual(largestHostBudget([{ budgetMemMiB: "8192", budgetCpuCenti: "700" }, { budgetMemMiB: "16384", budgetCpuCenti: "300" }]), { memMiB: 16384, cpuCenti: 700 });
  assert.deepEqual(largestHostBudget([{ budgetMemMiB: "8192", budgetCpuCenti: "off" }, { budgetMemMiB: "junk", budgetCpuCenti: "300" }]), { memMiB: 8192, cpuCenti: Infinity });
  assert.deepEqual(largestHostBudget([{ budgetMemMiB: "8192" }]), { memMiB: 8192, cpuCenti: null });
});

// ── the PROJECTS view ─────────────────────────────────────────────────────────────────────────────────

const SNAP = {
  queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 0, week: 0, month: 0 },
  settings: { path: "/s", overlay: {} },
  runs: [],
  schedulers: [],
  projects: { projects: [{ id: "shop", name: null, members: ["github:acme/web"] }, { id: "ops", name: null, members: ["/srv/ops"] }, { id: "new", name: null, members: ["/srv/new"] }] },
  scopedLimits: { limits: [{ scope: "project:shop", memory: "4g" }] },
  hostBudgets: [{ name: "mini1", budgetMemMiB: "5120", budgetCpuCenti: "700", usedMemMiB: "0", usedCpuCenti: "0" }],
};

function sizingInfo() {
  const logsDir = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 }), ...Array.from({ length: 12 }, (_, i) => rec({ i: 10 + i, project: "ops", peakMiB: 3000, cores: 1.5 })), rec({ i: 40, project: "new" })]);
  const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "4g" }] }), "sl.json");
  const budget = largestHostBudget(SNAP.hostBudgets);
  return { ...readSizeSuggestions({ logsDir, projectIds: ["shop", "ops", "new"], limits, env: {}, budget, nowMs: NOW }), budget };
}

test("the PROJECTS view shows each project's size, p95 peaks and suggestion, then the exact call on its own line", async () => {
  const asked = [];
  const sizing = sizingInfo();
  const deps = { fetchSnapshot: async () => SNAP, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW, projectsInfo: (arg) => (asked.push(arg), { byProject: [], sizing }) };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps });
  await flush();
  comp.handleInput("j");
  const lines = comp.render(140).map(stripAnsi);
  await comp.dispose();
  const out = lines.join("\n");
  assert.deepEqual(asked, [{ hosts: SNAP.hostBudgets }], "the seam is handed the registry rows the tick read");
  assert.match(out, /sizes: p95 of 30 days' runs · largest host budget 5g, 7 CPUs/);
  assert.match(out, /4g, 2 CPUs · p95 4g, 1 cores · suggest 6g \(oom-killed\)/);
  assert.match(out, /dispatch_limit_edit \{"index":0,"memory":"6g"\}/);
  assert.match(out, /ops .*\n.*4g, 2 CPUs · p95 3000m, 1\.5 cores · fits/);
  assert.match(out, /new .*\n.*4g, 2 CPUs · p95 1g, 1 cores · not enough runs \(1 of 10\)/);
  // the call line sits right under its project's size line, then the budget warning, before the members
  const at = lines.findIndex((l) => /suggest 6g/.test(l));
  assert.match(lines[at + 1], /dispatch_limit_edit/);
  assert.match(lines[at + 2], /above every host's budget: raise one first/);
  assert.match(lines[at + 3], /github:acme\/web/);
  assert.equal(lines.filter((l) => /above every host's budget/.test(l)).length, 1, "only the project over the budget says so");
});

test("the PROJECTS view says when the sizes could not be read, and draws no size line then", async () => {
  const deps = { fetchSnapshot: async () => SNAP, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW, projectsInfo: () => ({ byProject: [], sizing: { unreachable: "the scoped-limits file does not load" } }) };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps });
  await flush();
  comp.handleInput("j");
  const out = stripAnsi(comp.render(140).join("\n"));
  await comp.dispose();
  assert.match(out, /sizes unreadable \(the scoped-limits file does not load\)/);
  assert.doesNotMatch(out, /4g, 2 CPUs/);
});

// ── the dispatch_limit_edit preview ───────────────────────────────────────────────────────────────────

function registeredTools() {
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  return tools;
}
const toolByName = (name) => registeredTools().find((t) => t.name === name);
function toolCtx() {
  const shown = [];
  return { ctx: { hasUI: true, ui: { confirm: async (title, message) => (shown.push({ title, message }), false) } }, shown };
}

test("dispatch_limit_edit's confirm shows the project's peaks when a size field is edited, and only then", async () => {
  const dir = tempDir("pd-596-preview-");
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  writeFileSync(join(dir, "scoped-limits.json"), JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "4g" }, { scope: "acme/api", day: 3 }] }));
  const logs = join(dir, "logs");
  mkdirSync(logs);
  // dated relative to the clock the tool reads (the real one), so the record is inside its window on any day.
  const now = Date.now();
  Array.from({ length: 12 }, (_, i) => rec({ i, at: now, peakMiB: 2000, cores: 0.5 })).forEach((r, i) => writeFileSync(join(logs, `r${i}.json`), JSON.stringify(r)));
  process.env.PI_PROJECTS_FILE = join(dir, "projects.json");
  process.env.PI_SCOPED_LIMITS_FILE = join(dir, "scoped-limits.json");
  process.env.PI_LOGS_DIR = logs;
  const edit = toolByName("dispatch_limit_edit");
  const sized = toolCtx();
  await edit.execute("id", { index: 0, memory: "3g" }, undefined, undefined, sized.ctx);
  assert.match(sized.shown[0].message, /\nProject shop's runs \(the last 30 days, measured inside the jobs, so advisory\): size now 4g, 2 CPUs; p95 peak 2000m over 12 runs, p95 0\.5 cores used over 12 runs\. They suggest memory 2560m \(oversized: p95 peak 2000m over 12 runs\), CPUs 0\.75 \(underused: p95 0\.5 cores used over 12 runs\)\.$/);
  const counted = toolCtx();
  await edit.execute("id", { index: 0, day: 4 }, undefined, undefined, counted.ctx);
  assert.doesNotMatch(counted.shown[0].message, /runs \(the last/, "a count edit shows no peaks");
  const repo = toolCtx();
  await edit.execute("id", { index: 1, day: 5 }, undefined, undefined, repo.ctx);
  assert.doesNotMatch(repo.shown[0].message, /runs \(the last/);
  // a row that is not a project's has no note
  assert.equal(indexMod.sizingNote({ logsDir: logs, scopedLimitsPath: join(dir, "nope.json"), projectsFile: join(dir, "projects.json") }, "acme/web", now), "");
});

test("sizingNote names a project with no measured runs, and a limits file that does not load", () => {
  const dir = tempDir("pd-596-note-");
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  writeFileSync(join(dir, "bad.json"), "{nope");
  const paths = { logsDir: join(dir, "logs"), scopedLimitsPath: join(dir, "absent.json"), projectsFile: join(dir, "projects.json") };
  assert.match(indexMod.sizingNote(paths, "project:shop", NOW), /size now 4g, 2 CPUs; p95 peak none over 0 runs, p95 none cores used over 0 runs\. They suggest memory not enough runs, CPUs not enough runs\.$/);
  assert.equal(indexMod.sizingNote({ ...paths, scopedLimitsPath: join(dir, "bad.json") }, "project:shop", NOW), "\nThe project's runs could not be read (the scoped-limits file does not load).");
});

// ── the insights page ─────────────────────────────────────────────────────────────────────────────────

test("the insights page restates the worker's reasons and spellings, held equal here", () => {
  assert.deepEqual(INSIGHTS_MEMORY_REASONS, MEMORY_REASONS);
  assert.deepEqual(INSIGHTS_CPU_REASONS, CPU_REASONS);
  for (let mib = 512; mib <= 70000; mib += 37) assert.equal(sizeMemText(mib), formatMemory(mib));
  for (let c = 25; c <= 25600; c += 7) assert.equal(sizeCpuText(c), formatCpus(c));
});

test("the sizing chart: points in time order inside the plot, the size line a step through each run's size to the current one", () => {
  const day = 24 * 60 * MIN;
  const series = [
    { at: NOW - 20 * day, peakMiB: 4096, sizeMiB: 4096, oom: true },
    { at: NOW - 10 * day, peakMiB: 5000, sizeMiB: 6144, oom: false },
    { at: NOW - 40 * day, peakMiB: 100, sizeMiB: 512, oom: false }, // outside the window: not drawn
  ];
  const lay = layoutSizingChart(series, { nowMs: NOW, windowDays: 30, currentMiB: 8192 });
  assert.equal(lay.points.length, 2);
  for (const pt of lay.points) {
    assert.ok(pt.x >= lay.plot.x && pt.x <= lay.plot.x + lay.plot.w);
    assert.ok(pt.y >= lay.plot.y && pt.y <= lay.plot.y + lay.plot.h);
  }
  assert.ok(lay.points[0].x < lay.points[1].x);
  // 20 of 30 days from the right edge is a third of the plot
  assert.ok(Math.abs(lay.points[0].x - (lay.plot.x + lay.plot.w / 3)) < 1e-9);
  assert.ok(lay.scaleMax >= 8192, "the scale holds the current size");
  const ys = lay.steps.map((s) => s.y);
  const yOf = (mib) => lay.plot.y + lay.plot.h - (mib / lay.scaleMax) * lay.plot.h;
  assert.deepEqual(ys, [yOf(4096), yOf(4096), yOf(6144), yOf(8192)], "4g until the first run, 4g to the second, 6g to the edge, then up to the current 8g");
  assert.equal(lay.steps.at(-1).from, yOf(6144));
  const empty = layoutSizingChart([], { nowMs: NOW, currentMiB: 4096 });
  assert.deepEqual([empty.points.length, empty.steps.length, empty.steps[0].y], [0, 1, yOf4096(empty)]);
  function yOf4096(l) {
    return l.plot.y + l.plot.h - (4096 / l.scaleMax) * l.plot.h;
  }
});

function sizingPayload(overrides = {}) {
  return {
    hosts: { rows: [{ name: "mini1", budgetMemMiB: "29492", budgetCpuCenti: "700", usedMemMiB: "4096", usedCpuCenti: "off" }] },
    budget: { memMiB: 29492, cpuCenti: 700 },
    windowDays: 30,
    projects: {
      shop: {
        memory: { current: 4096, suggested: 6144, reason: "oom-killed", overBudget: false, evidence: { samples: 1, p95MiB: 4096 } },
        cpu: { current: 200, suggested: null, reason: "not-enough-runs", overBudget: false, evidence: { samples: 1, p95CoresCenti: 100 } },
        call: 'dispatch_limit_edit {"index":0,"memory":"6g"}',
        series: [{ at: NOW - MIN, peakMiB: 4096, sizeMiB: 4096, oom: true }],
      },
    },
    ...overrides,
  };
}

test("the insights page draws a job sizes section: the hosts' budgets in use, each project's chart, suggestion and call", () => {
  const html = buildInsightsHtml({ sizing: sizingPayload() }, { now: NOW });
  assert.match(html, /<h2>job sizes<\/h2>/);
  assert.match(html, /<span class="pid">mini1<\/span> budget 29492m, 7 CPUs · in use 4g, off CPUs/);
  assert.match(html, /<span class="pid">shop<\/span> <span class="dim">size 4g, 2 CPUs · p95 4g, 1 cores<\/span>/);
  assert.match(html, /memory: suggest 6g \(oom-killed\) · CPUs: not enough runs \(1\)/);
  assert.match(html, /<code>dispatch_limit_edit \{&quot;index&quot;:0,&quot;memory&quot;:&quot;6g&quot;\}<\/code>/);
  assert.match(html, /aria-label="peak memory against size · shop"/);
  assert.match(html, /peak 4g of 4g · oom-killed/, "the point's tip");
  assert.ok(html.includes(`r="2.5" fill="${PAGE_THEME.danger}"`), "an oom-killed run's dot is drawn in the danger colour");
  const ok = sizingPayload();
  ok.projects.shop.series = [{ at: NOW - MIN, peakMiB: 1000, sizeMiB: 4096 }];
  assert.ok(buildInsightsHtml({ sizing: ok }, { now: NOW }).includes(`r="2.5" fill="${PAGE_THEME.accent}"`));
  const over = sizingPayload();
  over.projects.shop.memory.overBudget = true;
  assert.match(buildInsightsHtml({ sizing: over }, { now: NOW }), /memory: suggest 6g \(oom-killed, above every host&#39;s budget\)/);
  assert.doesNotMatch(buildInsightsHtml({}, { now: NOW }), /job sizes/, "no slice, no section");
  assert.match(buildInsightsHtml({ sizing: { unreachable: "logs dir unreadable (EACCES)" } }, { now: NOW }), /job sizes not read: logs dir unreadable \(EACCES\)/);
  assert.match(buildInsightsHtml({ sizing: sizingPayload({ hosts: { unreachable: "timed out" } }) }, { now: NOW }), /host budgets not read: timed out/);
  assert.match(buildInsightsHtml({ sizing: sizingPayload({ hosts: { rows: [] } }) }, { now: NOW }), /no live host publishes a budget/);
});

test("the insights sizing slice is allowlisted: junk ids, reasons, calls and points are dropped, never drawn", () => {
  const p = sizingPayload();
  p.projects["Bad Id"] = p.projects.shop;
  p.projects.ok = { ...p.projects.shop, call: 'dispatch_limit_edit {"index":0,"memory":"<script>"}', memory: { ...p.projects.shop.memory, reason: "made-up" } };
  p.projects.pts = { ...p.projects.shop, call: "rm -rf /", series: [{ at: "x", peakMiB: 1, sizeMiB: 1 }, { at: NOW - MIN, peakMiB: -1, sizeMiB: 4096 }, { at: NOW - MIN, peakMiB: 9999, sizeMiB: 4096 }] };
  p.hosts.rows.push({ name: "<img>", budgetMemMiB: "1" });
  const html = buildInsightsHtml({ sizing: p }, { now: NOW });
  assert.doesNotMatch(html, /Bad Id|&lt;script&gt;|made-up|rm -rf|&lt;img&gt;/);
  assert.match(html, /<span class="pid">pts<\/span>/);
  assert.doesNotMatch(html, /peak 9999m/, "a peak above its size is drawn at the size");
  // a hostile getter takes only this section down
  const hostile = { get projects() { throw new Error("boom"); }, hosts: { rows: [] } };
  assert.doesNotMatch(buildInsightsHtml({ sizing: hostile }, { now: NOW }), /job sizes/);
});

test("assembleSizingView reads the registry through its seam and flags against the largest host budget", async () => {
  const dir = tempDir("pd-596-assemble-");
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  const logsDir = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 })]);
  const paths = { logsDir, projectsFile: join(dir, "projects.json"), scopedLimitsPath: join(dir, "absent.json"), valkeyUrl: "not-a-url" };
  const view = await indexMod.assembleSizingView(paths, NOW, { readHostsFn: async () => ({ hosts: [{ name: "mini1", budgetMemMiB: "5120", budgetCpuCenti: "700", usedMemMiB: "0", usedCpuCenti: "0" }] }) });
  assert.deepEqual(view.hosts, { rows: [{ name: "mini1", budgetMemMiB: "5120", budgetCpuCenti: "700", usedMemMiB: "0", usedCpuCenti: "0" }] });
  assert.deepEqual([view.projects.shop.memory.suggested, view.projects.shop.memory.overBudget, view.projects.shop.series.length, view.windowDays], [6144, true, 1, 30]);
  assert.equal(view.projects.shop.call, 'dispatch_limit_add {"scope":"project:shop","memory":"6g"}');
  const down = await indexMod.assembleSizingView(paths, NOW, { readHostsFn: async () => ({ unreachable: "timed out" }) });
  assert.deepEqual([down.hosts, down.projects.shop.memory.overBudget], [{ unreachable: "timed out" }, false]);
  // the real reader on an unparseable URL degrades at once, without a connection
  const real = await indexMod.assembleSizingView(paths, NOW);
  assert.ok(typeof real.hosts.unreachable === "string");
});
