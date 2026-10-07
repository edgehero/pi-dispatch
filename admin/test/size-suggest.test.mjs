import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { stripAnsi } from "../src/style.mjs";
import { hostBudgetsOf, readSizeSuggestions } from "../src/read-model.mjs";
import { PAGE_THEME } from "../src/graph-html.mjs";
import { INSIGHTS_CAP_MISSING, INSIGHTS_CPU_REASONS, INSIGHTS_MEMORY_HELD, SIZING_NO_CAP_WORDS, INSIGHTS_MEMORY_REASONS, INSIGHTS_SIZE_FACTS, buildInsightsHtml, layoutSizingChart, sizeCoresText, sizeCpuText, sizeMemText } from "../src/insights-html.mjs";
import { CPU_REASONS, MEMORY_CAP_MISSING, MEMORY_HELD, MEMORY_REASONS, SIZE_FACTS, coresText } from "@edgehero/pi-dispatch/size-suggest";
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

function rec({ i = 0, at = NOW, project = "shop", memMiB = 4096, cpuCenti = 200, peakMiB = 1024, cores = 1, throttle = 0, reason = null } = {}) {
  const end = at - (i + 1) * MIN;
  return {
    jobId: `j-${project}-${i}`,
    project,
    reason,
    startedAt: new Date(end - 10 * MIN).toISOString(),
    endedAt: new Date(end).toISOString(),
    resources: { memPeak: peakMiB * MIB, cpuUsec: Math.round(cores * 10 * MIN * 1000), throttledUsec: Math.round(throttle * 10 * MIN * 1000) },
    size: { memMiB, cpuCenti, source: "project" },
  };
}
/** Records written as files whose mtime is the clock's (`at`), never the wall clock's: the reader prefilters by mtime. */
function logsWith(records, at = NOW) {
  const dir = tempDir("pd-596-sizing-logs-");
  records.forEach((r, i) => {
    writeFileSync(join(dir, `r${i}.json`), JSON.stringify(r));
    utimesSync(join(dir, `r${i}.json`), at / 1000, at / 1000);
  });
  return dir;
}

test("readSizeSuggestions: the worker's suggestion per project, capped per host, with its call and words; an unreadable logs dir says so", () => {
  const logsDir = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 }), ...Array.from({ length: 12 }, (_, i) => rec({ i: 10 + i, project: "ops", peakMiB: 3000 }))]);
  const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "4g" }] }), "sl.json");
  const res = readSizeSuggestions({ logsDir, projectIds: ["shop", "ops"], limits, env: {}, hostBudgets: [{ memMiB: 5120, cpuCenti: 800 }], nowMs: NOW, withSeries: true });
  assert.deepEqual([res.projects.shop.memory.suggested, res.projects.shop.memory.reason, res.projects.shop.memory.held, res.projects.shop.memory.wanted, res.skipped], [5120, "oom-killed", "cap", 6144, 0]);
  assert.equal(res.projects.shop.call, 'dispatch_limit_edit {"index":0,"memory":"5g"}');
  assert.equal(res.projects.shop.words.memory, "1 run ended oom-killed (the largest size killed 4g)");
  assert.deepEqual(res.projects.shop.series, [{ at: NOW - MIN, peakMiB: 4096, sizeMiB: 4096, oom: true }]);
  assert.deepEqual([res.projects.ops.memory.reason, res.projects.ops.call], ["fits", null]);
  // no host budget read (the edit preview): a raise names what it wants and offers no call
  const none = readSizeSuggestions({ logsDir, projectIds: ["shop"], limits, nowMs: NOW });
  assert.deepEqual([none.projects.shop.memory.suggested, none.projects.shop.memory.held, none.projects.shop.call, none.projects.shop.series], [null, "no-cap", null, undefined]);
  // a refused deployment size leaves the project out rather than guessing one
  assert.deepEqual(readSizeSuggestions({ logsDir, projectIds: ["shop"], env: { PI_JOB_MEMORY: "4GB" }, nowMs: NOW }).projects, {});
  const file = join(logsDir, "r0.json");
  assert.match(readSizeSuggestions({ logsDir: file, projectIds: ["shop"], nowMs: NOW }).unreachable, /logs dir unreadable/);
  // the worker's bounded reader: a file the clock calls old is not read, and one over the cap is counted
  const old = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 })], NOW - 40 * 24 * 60 * MIN);
  assert.equal(readSizeSuggestions({ logsDir: old, projectIds: ["shop"], nowMs: NOW }).projects.shop.runs, 0);
  writeFileSync(join(logsDir, "big.json"), JSON.stringify({ ...rec(), pad: "x".repeat(256 * 1024) }));
  utimesSync(join(logsDir, "big.json"), NOW / 1000, NOW / 1000);
  assert.equal(readSizeSuggestions({ logsDir, projectIds: ["shop"], nowMs: NOW }).skipped, 1);
});

test("hostBudgetsOf: each live host's own budget pair, as published; never merged across hosts", () => {
  assert.deepEqual(hostBudgetsOf([]), []);
  assert.deepEqual(hostBudgetsOf(null), []);
  assert.deepEqual(hostBudgetsOf([{ budgetMemMiB: "8192", budgetCpuCenti: "700" }, { budgetMemMiB: "16384", budgetCpuCenti: "off" }, { name: "a", budgetMemMiB: "", budgetCpuCenti: "junk" }]), [
    { memMiB: 8192, cpuCenti: 700 },
    { memMiB: 16384, cpuCenti: Infinity },
    { memMiB: null, cpuCenti: null },
  ]);
});

// ── the PROJECTS view ─────────────────────────────────────────────────────────────────────────────────

const SNAP = {
  queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 0, week: 0, month: 0 },
  settings: { path: "/s", overlay: {} },
  runs: [],
  schedulers: [],
  projects: { projects: [{ id: "shop", name: null, members: ["github:acme/web"] }, { id: "ops", name: null, members: ["/srv/ops"] }, { id: "new", name: null, members: ["/srv/new"] }, { id: "big", name: null, members: ["/srv/big"] }, { id: "wide", name: null, members: ["/srv/wide"] }, { id: "a-project-whose-id-is-32-chars-x", name: null, members: ["/srv/long"] }] },
  scopedLimits: { limits: [{ scope: "project:shop", memory: "4g" }, { scope: "project:big", memory: "16g", cpus: 8 }] },
  hostBudgets: [{ name: "mini1", budgetMemMiB: "5120", budgetCpuCenti: "700", usedMemMiB: "0", usedCpuCenti: "0" }],
};

function sizingInfo() {
  const logsDir = logsWith([
    rec({ reason: "oom-killed", peakMiB: 4096 }),
    ...Array.from({ length: 12 }, (_, i) => rec({ i: 10 + i, project: "ops", peakMiB: 3000, cores: 1.5, throttle: 0.5 })),
    rec({ i: 40, project: "new" }),
    ...Array.from({ length: 10 }, (_, i) => rec({ i: 50 + i, project: "big", memMiB: 16384, cpuCenti: 800, peakMiB: 6000, cores: 3 })),
    ...Array.from({ length: 10 }, (_, i) => rec({ i: 70 + i, project: "wide", peakMiB: 1000, cores: 0.3 })),
    ...Array.from({ length: 10 }, (_, i) => rec({ i: 90 + i, project: "a-project-whose-id-is-32-chars-x", peakMiB: 1000, cores: 0.4 })),
  ]);
  const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: SNAP.scopedLimits.limits }), "sl.json");
  const hostBudgets = hostBudgetsOf(SNAP.hostBudgets);
  return { ...readSizeSuggestions({ logsDir, projectIds: ["shop", "ops", "new", "big", "wide", "a-project-whose-id-is-32-chars-x"], limits, env: {}, hostBudgets, nowMs: NOW }), hostBudgetCount: hostBudgets.length };
}

async function projectsAt(width, sizing = sizingInfo()) {
  const asked = [];
  const deps = { fetchSnapshot: async () => SNAP, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW, projectsInfo: (arg) => (asked.push(arg), { byProject: [], sizing }) };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps });
  await flush();
  comp.handleInput("j");
  const raw = comp.render(width);
  await comp.dispose();
  return { raw, lines: raw.map(stripAnsi), asked };
}
/** A frame row's content: the border and the padding off. */
const content = (l) => l.trim().replace(/^│/, "").replace(/│$/, "").trim();

test("the PROJECTS view shows each project's size, p95 peaks and verdict, then the suggestion, the exact call and any fact", async () => {
  const { lines, asked } = await projectsAt(140);
  const out = lines.map(content).join("\n");
  assert.deepEqual(asked, [{ hosts: SNAP.hostBudgets }], "the seam is handed the registry rows the tick read");
  assert.match(out, /^sizes: p95 of 30 days' runs · capped by 1 host budget$/m);
  assert.match(out, /^(?:› )?shop .*\n4g, 2 CPUs · p95 4g, 1 core · suggest\nmemory 5g \(oom-killed, the most a live host offers\)\ndispatch_limit_edit \{"index":0,"memory":"5g"\}\ngithub:acme\/web$/m);
  assert.match(out, /^ops .*\n4g, 2 CPUs · p95 3000m, 1\.5 cores · fits\nthe median run was held back 50% of its time by this host's\nCPU ceiling/m);
  assert.match(out, /^new .*\n4g, 2 CPUs · p95 1g, 1 core · not enough runs \(1 of 10\)\n\/srv\/new$/m);
  // a lowering still larger than any live host offers (judged on the host's own pair: its 7 CPUs hold the 3.75 the
  // lowering leaves, so its 5g is the memory cap) says so, and carries NO call: it would never fit; only that project
  assert.match(out, /^big .*\n16g, 8 CPUs · p95 6000m, 3 cores · suggest\nmemory 7680m \(oversized\); CPUs 3\.75 \(underused\)\nlarger than any live host offers/m);
  assert.doesNotMatch(out, /"index":1/, "no call for a size that never fits");
  assert.equal(lines.filter((l) => /larger than any live host offers/.test(l)).length, 1);
  assert.doesNotMatch(out, /raise|budget first/i, "never advises growing a host");
  assert.doesNotMatch(out, /over 256 KiB/, "nothing skipped, nothing said");
  const skipped = (await projectsAt(140, { ...sizingInfo(), skipped: 2 })).lines.map(content).join("\n");
  assert.match(skipped, /^sizes: p95 of 30 days' runs · capped by 1 host budget\n2 run records over 256 KiB skipped$/m);
  // no host budget read: a raise wants its size and offers no call
  const bare = { ...sizingInfo(), hostBudgetCount: 0 };
  const shop = readSizeSuggestions({ logsDir: logsWith([rec({ reason: "oom-killed", peakMiB: 4096 })]), projectIds: ["shop"], limits: parseScopedLimits(JSON.stringify({ version: 3, limits: SNAP.scopedLimits.limits }), "sl.json"), hostBudgets: [], nowMs: NOW });
  const none = (await projectsAt(140, { ...bare, projects: { ...bare.projects, shop: shop.projects.shop } })).lines.map(content).join("\n");
  assert.match(none, /^sizes: p95 of 30 days' runs · no host budget read$/m);
  assert.match(none, /^4g, 2 CPUs · p95 4g, 1 core · suggest\nmemory wants 6g \(oom-killed, no host budget read: no call\)\ngithub:acme\/web$/m);
});

/** True when `text` ends outside every JSON string (an even count of unescaped quotes). */
const outsideString = (text) => (text.replace(/\\./g, "").match(/"/g) ?? []).length % 2 === 0;

test("the PROJECTS view wraps the exact call so it pastes: never clipped, never broken inside a JSON string, at 140, 80, 60 and 47 columns", async () => {
  // a row's edit, a row-less project's add, and the longest project id there is (its scope string alone is 43 columns,
  // the narrowest frame's whole inner width: the indent gives way rather than the string breaking)
  const calls = [
    ["p95 4g, 1 core", 'dispatch_limit_edit {"index":0,"memory":"5g"}'],
    ["p95 1000m, 0.3 cores", 'dispatch_limit_add {"scope":"project:wide","memory":"1280m","cpus":0.5}'],
    ["p95 1000m, 0.4 cores", 'dispatch_limit_add {"scope":"project:a-project-whose-id-is-32-chars-x","memory":"1280m","cpus":0.5}'],
  ];
  let wrapped = 0;
  for (const width of [140, 80, 60, 47]) {
    const { lines } = await projectsAt(width);
    for (const l of lines) assert.ok(l.length <= width, `${width}: a row past the frame: ${l}`);
    const inner = lines[0].trim().length - 4;
    for (const [marker, call] of calls) {
      const at = lines.findIndex((l) => l.includes(marker));
      const body = lines.slice(at + 1).map(content);
      const from = body.findIndex((l) => l.startsWith("dispatch_limit_"));
      const to = body.findIndex((l, i) => i > from && /^join the lines before running it$|^\/srv\/|^github:/.test(l));
      const frags = body.slice(from, to);
      assert.equal(frags.join(""), call, `${width}: the call reads whole, joined with nothing between`);
      for (const f of frags) assert.ok(f.length <= inner, `${width}: a call line past the frame: ${f}`);
      // every break is outside a string: each line but the last ends outside one, on a piece boundary
      for (const f of frags.slice(0, -1)) assert.match(f, /[,{:]$|^dispatch_limit_(?:edit|add)$/, `${width}: ${f}`);
      // between a key and its value only where a whole key and value (with its comma) is wider than the frame
      const widestField = Math.max(...call.slice(call.indexOf("{") + 1).split(",").map((x) => x.length + 1));
      if (widestField <= inner) assert.deepEqual(frags.filter((f) => f.endsWith(":")), [], `${width}: a key split from its value with room for both`);
      let seen = "";
      for (const f of frags) {
        seen += f;
        assert.ok(outsideString(seen), `${width}: a break inside a JSON string after: ${f}`);
      }
      // a call on more than one line is followed by the note to join them, and only then
      if (frags.length > 1) {
        wrapped++;
        assert.equal(body[to], "join the lines before running it", `${width}: the join note under ${call}`);
      } else assert.notEqual(body[to], "join the lines before running it", `${width}: no note under a one-line call`);
    }
  }
  assert.ok(wrapped >= 4, "the narrow frames wrap the calls");
});

test("callPieces breaks only outside a JSON string, after a colon only when asked; an escaped quote does not end a string", async () => {
  const { callPieces } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));
  assert.deepEqual(callPieces('dispatch_limit_edit {"index":0,"memory":"5g"}'), ["dispatch_limit_edit ", "{", '"index":0,', '"memory":"5g"}']);
  assert.deepEqual(callPieces('x {"a":"b,c:{d","e":1}', true), ["x ", "{", '"a":', '"b,c:{d",', '"e":', "1}"]);
  assert.deepEqual(callPieces('x {"a":"q\\",{","b":2}'), ["x ", "{", '"a":"q\\",{",', '"b":2}']);
});

test("the PROJECTS view says why a raise has no cap (none read, none holds the size, every budget off) and when a size is above the cap", async () => {
  const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: SNAP.scopedLimits.limits }), "sl.json");
  const logsDir = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 })]);
  const shopWith = async (hostBudgets) => {
    const shop = readSizeSuggestions({ logsDir, projectIds: ["shop"], limits, hostBudgets, nowMs: NOW }).projects.shop;
    const base = sizingInfo();
    const out = (await projectsAt(140, { ...base, projects: { ...base.projects, shop } })).lines.map(content).join("\n");
    // the verdict, its wrapped continuation lines joined back with the space they broke at
    return out.match(/^4g, 2 CPUs · p95 4g, 1 core · suggest\n([^]*?)\ngithub:acme\/web$/m)?.[1].replace(/\n/g, " ");
  };
  assert.equal(await shopWith([]), `memory wants 6g (oom-killed, ${SIZING_NO_CAP_WORDS.unread}: no call)`);
  assert.equal(await shopWith([{ memMiB: 16384, cpuCenti: 100 }]), `memory wants 6g (oom-killed, ${SIZING_NO_CAP_WORDS["none-holds"]}: no call)`);
  assert.equal(await shopWith([{ memMiB: Infinity, cpuCenti: Infinity }]), `memory wants 6g (oom-killed, ${SIZING_NO_CAP_WORDS.off}: no call)`);
  assert.deepEqual(Object.values(SIZING_NO_CAP_WORDS), ["no host budget read", "no live host's budget holds this size", "every live host's budget is off"]);
  // a host whose budget is below the size already set: the size is above what it offers, not at it
  assert.equal(await shopWith([{ memMiB: 2048, cpuCenti: 800 }]), "memory stays (oom-killed, already above the most a live host offers)");
  assert.equal(await shopWith([{ memMiB: 4096, cpuCenti: 800 }]), "memory stays (oom-killed, already the largest size a live host offers)");
});

test("readSizeSuggestions caps a raise at the project's hostShare of each live host's budget", () => {
  const logsDir = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 })]);
  const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "4g", hostShare: 50 }] }), "sl.json");
  const res = readSizeSuggestions({ logsDir, projectIds: ["shop"], limits, hostBudgets: [{ memMiB: 10240, cpuCenti: 800 }], nowMs: NOW });
  assert.deepEqual([res.projects.shop.memory.suggested, res.projects.shop.memory.held, res.projects.shop.call], [5120, "cap", 'dispatch_limit_edit {"index":0,"memory":"5g"}']);
  const whole = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "4g" }] }), "sl.json");
  assert.equal(readSizeSuggestions({ logsDir, projectIds: ["shop"], limits: whole, hostBudgets: [{ memMiB: 10240, cpuCenti: 800 }], nowMs: NOW }).projects.shop.call, 'dispatch_limit_edit {"index":0,"memory":"6g"}');
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
  Array.from({ length: 12 }, (_, i) => rec({ i, at: now, peakMiB: 2000, cores: 0.5 })).forEach((r, i) => {
    writeFileSync(join(logs, `r${i}.json`), JSON.stringify(r));
    utimesSync(join(logs, `r${i}.json`), now / 1000, now / 1000); // the reader prefilters by mtime, against that clock
  });
  process.env.PI_PROJECTS_FILE = join(dir, "projects.json");
  process.env.PI_SCOPED_LIMITS_FILE = join(dir, "scoped-limits.json");
  process.env.PI_LOGS_DIR = logs;
  const edit = toolByName("dispatch_limit_edit");
  const sized = toolCtx();
  await edit.execute("id", { index: 0, memory: "3g" }, undefined, undefined, sized.ctx);
  assert.match(sized.shown[0].message, /\nProject shop's runs \(the last 30 days, measured inside the jobs, so advisory\): size now 4g, 2 CPUs; p95 peak 2000m over 12 runs, p95 0\.5 cores used over 12 runs\. They suggest memory 2560m \(oversized: p95 peak 2000m, largest 2000m, over 12 runs\), CPUs 0\.75 \(underused: p95 0\.5 cores used, largest 0\.5 cores, over 12 runs\)\.$/);
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
  assert.match(indexMod.sizingNote(paths, "project:shop", NOW), /size now 4g, 2 CPUs; p95 peak none over 0 runs, p95 none used over 0 runs\. They suggest memory not enough runs, CPUs not enough runs\.$/);
  assert.equal(indexMod.sizingNote({ ...paths, scopedLimitsPath: join(dir, "bad.json") }, "project:shop", NOW), "\nThe project's runs could not be read (the scoped-limits file does not load).");
  // a raise: no host budget is read in a confirm, so it names what the runs ask for and says the budget was not checked
  const oomLogs = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 })]);
  assert.match(indexMod.sizingNote({ ...paths, logsDir: oomLogs }, "project:shop", NOW), /They suggest memory 6g \(oom-killed: 1 run ended oom-killed \(the largest size killed 4g\); budget not checked here\), CPUs not enough runs\.$/);
  // a fact rides along as a sentence of its own
  const hot = logsWith(Array.from({ length: 10 }, (_, i) => rec({ i, cores: 1, throttle: 0.5 })));
  assert.match(indexMod.sizingNote({ ...paths, logsDir: hot }, "project:shop", NOW), /CPUs fits\. The median run was held back 50% of its time by this host's CPU ceiling \(its CPU budget, shared by every job\), which a job's cpus do not change\.$/);
});

// ── the insights page ─────────────────────────────────────────────────────────────────────────────────

test("the insights page restates the worker's reasons and spellings, held equal here", () => {
  assert.deepEqual(INSIGHTS_MEMORY_REASONS, MEMORY_REASONS);
  assert.deepEqual(INSIGHTS_CPU_REASONS, CPU_REASONS);
  assert.deepEqual(INSIGHTS_MEMORY_HELD, MEMORY_HELD);
  assert.deepEqual(INSIGHTS_SIZE_FACTS, SIZE_FACTS);
  assert.deepEqual(INSIGHTS_CAP_MISSING, MEMORY_CAP_MISSING);
  assert.deepEqual(Object.keys(SIZING_NO_CAP_WORDS), MEMORY_CAP_MISSING);
  for (let c = 25; c <= 25600; c += 25) assert.equal(sizeCoresText(c), coresText(c));
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
  assert.match(html, /<span class="pid">shop<\/span> <span class="dim">size 4g, 2 CPUs · p95 4g, 1 core<\/span>/);
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
  assert.match(buildInsightsHtml({ sizing: over }, { now: NOW }), /memory: suggest 6g \(oom-killed, larger than any live host offers\)/);
  // a held raise says what the hosts offer, never "raise the budget"; a fact is information below the call
  const held = (h, more = {}) => {
    const p = sizingPayload();
    p.projects.shop.memory = { ...p.projects.shop.memory, held: h, wanted: 6144, ...more };
    return buildInsightsHtml({ sizing: p }, { now: NOW });
  };
  assert.match(held("cap", { suggested: 5120 }), /memory: suggest 5g \(oom-killed, the most a live host offers\)/);
  assert.match(held("largest", { suggested: null }), /memory: stays \(oom-killed, already the largest size a live host offers\)/);
  assert.match(held("no-cap", { suggested: null }), /memory: wants 6g \(oom-killed, no host budget read: no call\)/);
  // why no cap is known, worded apart: budgets that WERE read are never called unread
  assert.match(held("no-cap", { suggested: null, capMissing: "unread" }), /memory: wants 6g \(oom-killed, no host budget read: no call\)/);
  assert.match(held("no-cap", { suggested: null, capMissing: "none-holds" }), /memory: wants 6g \(oom-killed, no live host&#39;s budget holds this size: no call\)/);
  assert.match(held("no-cap", { suggested: null, capMissing: "off" }), /memory: wants 6g \(oom-killed, every live host&#39;s budget is off: no call\)/);
  assert.match(held("no-cap", { suggested: null, capMissing: "made-up" }), /no host budget read: no call/, "an unknown reason reads as unread");
  // a size above the cap is above it, not at it
  assert.match(held("largest", { suggested: null, cap: 2048 }), /memory: stays \(oom-killed, already above the most a live host offers\)/);
  assert.match(held("largest", { suggested: null, cap: 4096 }), /memory: stays \(oom-killed, already the largest size a live host offers\)/);
  assert.match(held("made-up", { suggested: null }), /memory: oom-killed ·/, "an unknown held is dropped");
  const facts = sizingPayload();
  facts.projects.shop.memory = { ...facts.projects.shop.memory, fact: "pressure", evidence: { samples: 10, p95MiB: 4096, pressured: 3 } };
  facts.projects.shop.cpu = { ...facts.projects.shop.cpu, reason: "fits", fact: "ceiling", evidence: { samples: 10, p95CoresCenti: 100, throttledPct: 60 } };
  const fhtml = buildInsightsHtml({ sizing: facts }, { now: NOW });
  assert.match(fhtml, /<div class="dim small">3 of 10 runs reached the memory limit while stalled for memory<\/div><div class="dim small">the median run was held back 60% of its time by its host&#39;s CPU ceiling, which a job&#39;s cpus do not change<\/div><svg/);
  facts.projects.shop.memory.fact = "at-limit";
  assert.doesNotMatch(buildInsightsHtml({ sizing: facts }, { now: NOW }), /reached the memory limit/, "an unknown fact is dropped");
  assert.doesNotMatch(fhtml + held("cap", { suggested: 5120 }), /raise (?:the|this|a) host|budget first/i);
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

test("assembleSizingView reads the registry through its seam and caps a raise per host", async () => {
  const dir = tempDir("pd-596-assemble-");
  writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
  const logsDir = logsWith([rec({ reason: "oom-killed", peakMiB: 4096 })]);
  const paths = { logsDir, projectsFile: join(dir, "projects.json"), scopedLimitsPath: join(dir, "absent.json"), valkeyUrl: "not-a-url" };
  const rows = [{ name: "mini1", budgetMemMiB: "5120", budgetCpuCenti: "700", usedMemMiB: "0", usedCpuCenti: "0" }, { name: "big1", budgetMemMiB: "16384", budgetCpuCenti: "100", usedMemMiB: "0", usedCpuCenti: "0" }];
  const view = await indexMod.assembleSizingView(paths, NOW, { readHostsFn: async () => ({ hosts: rows }) });
  assert.deepEqual(view.hosts, { rows });
  // big1's 16g is no cap for a 2-CPU job: it offers 1 CPU. mini1's 5g is.
  assert.deepEqual([view.projects.shop.memory.suggested, view.projects.shop.memory.held, view.projects.shop.memory.overBudget, view.projects.shop.series.length, view.windowDays, view.hostBudgetCount], [5120, "cap", false, 1, 30, 2]);
  assert.equal(view.projects.shop.call, 'dispatch_limit_add {"scope":"project:shop","memory":"5g"}');
  const down = await indexMod.assembleSizingView(paths, NOW, { readHostsFn: async () => ({ unreachable: "timed out" }) });
  assert.deepEqual([down.hosts, down.projects.shop.memory.suggested, down.projects.shop.memory.held, down.projects.shop.call], [{ unreachable: "timed out" }, null, "no-cap", null]);
  // the real reader on an unparseable URL degrades at once, without a connection
  const real = await indexMod.assembleSizingView(paths, NOW);
  assert.ok(typeof real.hosts.unreachable === "string");
});
