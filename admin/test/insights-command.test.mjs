import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { modelDollarKeyPrefix, scopeDollarKeyPrefix } from "@edgehero/pi-dispatch/scoped-limits";

/**
 * The insights command (REQ-INSIGHTS-HTML-EXPORT): the bare `/dispatch insights` writes the
 * artifact -- atomic stable-path write, URL FIRST, best-effort open, skip-and-say over
 * SSH/headless, usage-with-zero-side-effects on junk (the removed `html` verb included). Every
 * side effect is injected; assembleInsights' reads resolve against a temp triggers file, an empty
 * temp logs dir, and an unparseable VALKEY_URL that degrades synchronously (a dead PORT would leak
 * an async error event into the suite).
 */
process.env.PI_LOGS_DIR = tempDir("admin-insights-cmd-");
process.env.PI_CODING_AGENT_DIR = tempDir("admin-insights-cmd-agent-");

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

const fixtureDir = tempDir("admin-insights-cmd-fixture-");
const triggersPath = join(fixtureDir, "triggers.json");
writeFileSync(
  triggersPath,
  JSON.stringify({ triggers: [{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: join(fixtureDir, "absent"), flow: "tidy", task: "t" } }] }),
);

function cannedPaths() {
  return {
    graphDir: "/gdir",
    triggersPath,
    logsDir: process.env.PI_LOGS_DIR,
    subscriptionsPath: join(fixtureDir, "subscriptions.json"), // absent: degrades to no plans
    valkeyUrl: "not-a-url",
    chainDepthMax: 1,
    chainMaxPerJob: 2,
  };
}

/** One ordered event log shared by every fake, so ordering claims are real assertions. */
function harness({ writeThrows = false, env = {}, platform = "darwin" } = {}) {
  const events = [];
  const deps = {
    fs: {
      mkdirSync: (dir, opts) => events.push(["mkdir", dir, opts?.recursive === true]),
      writeFileSync: (path, data, opts) => {
        if (writeThrows) throw new Error("ENOSPC");
        events.push(["write", path, opts?.mode, typeof data === "string" && data.length > 0]);
      },
      renameSync: (a, b) => events.push(["rename", a, b]),
    },
    openBrowser: (url) => events.push(["open", url]),
    env,
    platform,
    now: () => 1770000000000,
  };
  const notify = (msg, level) => events.push(["notify", level, msg]);
  return { events, deps, notify };
}

test("bare insights writes atomically to the STABLE path and prints the file:// URL before opening", async () => {
  const { events, deps, notify } = harness();
  await mod.insightsCommand(cannedPaths(), ["insights"], notify, deps);

  assert.deepEqual(events[0], ["mkdir", "/gdir", true], "the artifact dir is created recursively first");
  const [, tmpPath, mode, nonEmpty] = events[1];
  assert.equal(events[1][0], "write");
  assert.equal(tmpPath, "/gdir/insights.html.tmp", "the write goes to the .tmp sibling");
  assert.equal(mode, 0o644);
  assert.ok(nonEmpty, "a real page was rendered");
  assert.deepEqual(events[2], ["rename", "/gdir/insights.html.tmp", "/gdir/insights.html"], "tmp+rename: a reload never reads half a file");

  const notifyAt = events.findIndex((e) => e[0] === "notify");
  const openAt = events.findIndex((e) => e[0] === "open");
  assert.ok(notifyAt >= 0 && openAt > notifyAt, "the URL prints BEFORE the spawn -- the URL is the contract, the spawn a convenience");
  assert.match(events[notifyAt][2], /^insights written: file:\/\/\/gdir\/insights\.html$/);
  assert.equal(events[openAt][1], "file:///gdir/insights.html", "the opened URL is the notified one");
});

test("a second run renames onto the SAME path -- the stable filename an open tab reloads", async () => {
  const { events, deps, notify } = harness();
  await mod.insightsCommand(cannedPaths(), ["insights"], notify, deps);
  await mod.insightsCommand(cannedPaths(), ["insights"], notify, deps);
  const renames = events.filter((e) => e[0] === "rename").map((e) => e[2]);
  assert.deepEqual(renames, ["/gdir/insights.html", "/gdir/insights.html"], "re-running updates the tab an operator already has open");
});

test("the window argument: 7d/30d/mtd accepted, junk answers usage with no side effects, default is 30d", async () => {
  for (const window of ["7d", "30d", "mtd"]) {
    const { events, deps, notify } = harness();
    await mod.insightsCommand(cannedPaths(), ["insights", window, "--no-open"], notify, deps);
    assert.ok(events.some((e) => e[0] === "rename"), `${window} is a legal window`);
  }
  const { events, deps, notify } = harness();
  await mod.insightsCommand(cannedPaths(), ["insights", "12d"], notify, deps);
  assert.deepEqual(events.filter((e) => e[0] !== "notify"), [], "no side effect on a bad window");
  assert.ok(events.some((e) => e[0] === "notify" && e[1] === "warning" && e[2].includes("usage")), "the usage line answers");

  // The removed verb: `insights html` is a junk positional and answers usage on purpose -- a dead
  // verb that half-works is drift, and the usage string is what teaches the new grammar.
  const dead = harness();
  await mod.insightsCommand(cannedPaths(), ["insights", "html"], dead.notify, dead.deps);
  assert.deepEqual(dead.events.filter((e) => e[0] !== "notify"), [], "the dead verb writes nothing");
  assert.ok(dead.events.some((e) => e[0] === "notify" && e[1] === "warning" && e[2].includes("usage")), "and answers usage");

  // The default is 30d, NOT costs' mtd: the topology half is pinned at a 30d record window, and one
  // page's two halves should describe the same period unless the operator asks otherwise.
  const def = harness();
  await mod.insightsCommand(cannedPaths(), ["insights", "--no-open"], def.notify, def.deps);
  const page = def.events.find((e) => e[0] === "write");
  assert.ok(page, "the default window renders");
});

test("--no-open writes and prints but never spawns", async () => {
  const { events, deps, notify } = harness();
  await mod.insightsCommand(cannedPaths(), ["insights", "--no-open"], notify, deps);
  assert.ok(events.some((e) => e[0] === "rename"), "the artifact still writes");
  assert.ok(events.some((e) => e[0] === "notify" && /insights written/.test(e[2])), "the URL still prints");
  assert.equal(events.filter((e) => e[0] === "open").length, 0);
});

test("over SSH the spawn is skipped AND SAID; on linux without a display likewise; darwin opens", async () => {
  for (const [env, platform, reason] of [
    [{ SSH_CONNECTION: "10.0.0.1 22" }, "darwin", /SSH session/],
    [{ SSH_TTY: "/dev/pts/1" }, "linux", /SSH session/],
    [{}, "linux", /no display/],
  ]) {
    const { events, deps, notify } = harness({ env, platform });
    await mod.insightsCommand(cannedPaths(), ["insights"], notify, deps);
    assert.equal(events.filter((e) => e[0] === "open").length, 0, `no spawn for ${reason}`);
    assert.ok(events.some((e) => e[0] === "notify" && reason.test(e[2])), `the skip is said, never silent (${reason})`);
  }
  const { events, deps, notify } = harness({ env: {}, platform: "darwin" });
  await mod.insightsCommand(cannedPaths(), ["insights"], notify, deps);
  assert.equal(events.filter((e) => e[0] === "open").length, 1, "a local darwin session opens");
});

test("a write failure notifies the path and NEVER opens -- a stale artifact must not pass as fresh", async () => {
  const { events, deps, notify } = harness({ writeThrows: true });
  await mod.insightsCommand(cannedPaths(), ["insights"], notify, deps);
  assert.ok(events.some((e) => e[0] === "notify" && e[1] === "error" && e[2].includes("/gdir/insights.html")), "the error names the path");
  assert.equal(events.filter((e) => e[0] === "open").length, 0);
  assert.equal(events.filter((e) => e[0] === "rename").length, 0);
});

test("an unknown argument is a usage warning, and nothing writes", async () => {
  const { events, deps, notify } = harness();
  await mod.insightsCommand(cannedPaths(), ["insights", "--yes"], notify, deps);
  assert.deepEqual(events.filter((e) => e[0] !== "notify"), [], "no side effect on a usage mistake");
  assert.ok(events.some((e) => e[0] === "notify" && e[1] === "warning" && e[2].includes("usage")), "the usage line answers");
});

test("--full-paths is the explicit opt-in that puts run.folder paths into the artifact", async () => {
  const deps = (writeSink) => ({
    fs: {
      mkdirSync: () => {},
      writeFileSync: (path, data) => writeSink.push(String(data)),
      renameSync: () => {},
    },
    openBrowser: () => {},
    env: {},
    platform: "darwin",
    now: () => 1770000000000,
  });
  const without = [];
  await mod.insightsCommand(cannedPaths(), ["insights", "--no-open"], () => {}, deps(without));
  const withFlag = [];
  await mod.insightsCommand(cannedPaths(), ["insights", "--no-open", "--full-paths"], () => {}, deps(withFlag));
  const probe = join(fixtureDir, "absent");
  assert.ok(!without[0].includes(probe), "the default artifact carries no absolute host path");
  assert.ok(withFlag[0].includes(probe), "the opted-in artifact names the configured folder by its full path");
});

test("the artifact carries both halves: the topology svg and the spend section, windows both stated", async () => {
  const sink = [];
  const deps = {
    fs: { mkdirSync: () => {}, writeFileSync: (_p, data) => sink.push(String(data)), renameSync: () => {} },
    openBrowser: () => {},
    env: {},
    platform: "darwin",
    now: () => 1770000000000,
  };
  await mod.insightsCommand(cannedPaths(), ["insights", "7d", "--no-open"], () => {}, deps);
  const page = sink[0];
  assert.ok(page.includes('id="graph"'), "the topology pane is in the page");
  assert.ok(page.includes("last 7d"), "the requested spend window is stated");
  assert.ok(page.includes("30d"), "the fixed topology window is stated beside it");
});

test("isHeadlessEnv: SSH wins over the display check, and only linux gates on DISPLAY", () => {
  // Moved here from the removed graph-command suite (issue #181): the export lives on, and this is
  // its unit home now that the insights command is its only caller.
  assert.equal(mod.isHeadlessEnv({ SSH_CONNECTION: "x" }, "darwin"), "SSH session");
  assert.equal(mod.isHeadlessEnv({}, "linux"), "no display");
  assert.equal(mod.isHeadlessEnv({ DISPLAY: ":0" }, "linux"), null);
  assert.equal(mod.isHeadlessEnv({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), null);
  assert.equal(mod.isHeadlessEnv({}, "darwin"), null, "darwin's opener needs no display variable");
  assert.equal(mod.isHeadlessEnv({}, "win32"), null);
});

test("the page carries the budget panel: unreachable canned queue stated as a banner, the lever named", async () => {
  const sink = [];
  const deps = {
    fs: { mkdirSync: () => {}, writeFileSync: (_p, data) => sink.push(String(data)), renameSync: () => {} },
    openBrowser: () => {},
    env: {},
    platform: "darwin",
    now: () => 1770000000000,
  };
  await mod.insightsCommand(cannedPaths(), ["insights", "--no-open"], () => {}, deps);
  const page = sink[0];
  assert.ok(page.includes("<h2>budget</h2>"), "the budget panel renders even with the canned dead queue");
  assert.ok(page.includes("budget unreachable:"), "the absence is a banner, not a silent gap");
  assert.ok(page.includes("adjust: /dispatch set dailyCap"), "the lever is named -- the panel exists to point at it");
});

test("the budget slice carries the scoped rows from the limits file; a dead queue leaves used as ? not 0", async () => {
  const dir = tempDir("admin-insights-sl-");
  const slPath = join(dir, "scoped-limits.json");
  writeFileSync(slPath, JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 10, concurrent: 2 }] }));
  const sink = [];
  const deps = {
    fs: { mkdirSync: () => {}, writeFileSync: (_p, data) => sink.push(String(data)), renameSync: () => {} },
    openBrowser: () => {},
    env: {},
    platform: "darwin",
    now: () => 1770000000000,
  };
  await mod.insightsCommand({ ...cannedPaths(), scopedLimitsPath: slPath }, ["insights", "--no-open"], () => {}, deps);
  const page = sink[0];
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
  const view = await mod.assembleBudgetView({ valkeyUrl: "redis://127.0.0.1:1", scopedLimitsPath: slPath }, { redisFn: () => redis });
  assert.deepEqual(view.scoped.map((r) => r.usd), [
    { day: null, week: null, month: null },
    { day: null, week: { usedMicros: 6_340_917, capMicros: 45_000_000 }, month: null },
    { day: null, week: { usedMicros: 7_966_101, capMicros: 80_000_000 }, month: { usedMicros: 0, capMicros: 300_500_000 } },
  ]);
  const dead = await mod.assembleBudgetView({ valkeyUrl: "not-a-url", scopedLimitsPath: slPath });
  assert.deepEqual(dead.scoped[1].usd.week, { usedMicros: null, capMicros: 45_000_000 }, "a dead queue leaves the counter unknown, never $0");
});

test("the default graph dir's account root is made this account's first, and another account's root writes nothing (#464)", async () => {
  const uid = process.geteuid();
  const withRoot = (owner) => {
    const h = harness({ platform: "linux", env: { SSH_TTY: "/dev/pts/0" } });
    Object.assign(h.deps.fs, {
      lstatSync: (p) => (h.events.push(["lstat", p]), { uid: owner, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 }),
      statSync: (p) => ({ uid: owner, isDirectory: () => true, mode: 0o40700 }),
      chmodSync: (p, m) => h.events.push(["chmod", p, m]),
    });
    return h;
  };
  const paths = { ...cannedPaths(), graphDir: "/t/pi-dispatch-x/graph", graphRoot: "/t/pi-dispatch-x" };
  const mine = withRoot(uid);
  await mod.insightsCommand(paths, ["insights"], mine.notify, mine.deps);
  // lstat first (gate round 1): an existing root is judged and never mkdir'd, so a symlink there is never followed.
  assert.deepEqual(mine.events.slice(0, 2), [["lstat", "/t/pi-dispatch-x"], ["mkdir", "/t/pi-dispatch-x/graph", true]], "the root, checked, then the graph dir");
  assert.ok(mine.events.some((e) => e[0] === "rename"));
  const theirs = withRoot(uid + 1);
  await mod.insightsCommand(paths, ["insights"], theirs.notify, theirs.deps);
  assert.ok(!theirs.events.some((e) => e[0] === "write" || e[0] === "rename"), "nothing written under another account's root");
  const said = theirs.events.find((e) => e[0] === "notify" && e[1] === "error");
  assert.match(said[2], new RegExp(`^insights: could not write /t/pi-dispatch-x/graph/insights\\.html \\(/t/pi-dispatch-x is owned by uid ${uid + 1}, not by this account \\(uid ${uid}\\): another account created /t/pi-dispatch-x before this one`));
});

test("with an envelope set, the split is read through readAllocations, without hosts or reasons, and counted from the records (#507)", async () => {
  // The slice's assembler on its own: the rest of insightsCommand dials the real queue (the budget read), which a unit
  // test cannot fake, so the page half is the builder over exactly what this returns.
  const { fakeAllocRedis } = await import("./helpers/fake-alloc-redis.mjs");
  const { readEnvelope } = await import("../src/read-model.mjs");
  const { buildInsightsHtml } = await import("../src/insights-html.mjs");
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
  mod._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507", now: () => new Date(Date.parse("2026-10-05T12:00:00Z")) });
  let slice;
  try {
    slice = await mod.assembleAllocationView(paths, mod.splitCounts(records));
  } finally {
    mod._setAllocationSeamsForTests({});
  }
  assert.deepEqual(slice.counts, { refusals: { "allocation-cap": 1, "envelope-mismatch": 0, "portfolio-no-envelope": 0, "portfolio-snapshot-oversize": 0 }, plans: { "plan-stale": 1, applied: 1, "plan-absent": 1 } });
  assert.deepEqual(slice.log, [{ at: "2026-10-05T06:00:00.000Z", writer: "portfolio-job", outcome: "applied", reason: null, planId: "3f9a0c1d2e4b5a67" }], "a row cut to its enum fields: no host");
  assert.equal(JSON.stringify(slice).includes("CANARY"), false, "no host and no reason text leave the assembler");
  assert.equal(slice.mismatch, false);
  const page = buildInsightsHtml({ allocation: slice, window: "30d" }, { now: 0 });
  assert.ok(page.includes('<span class="wl">envelope</span><span>$100.00 per week · delegation on</span>'), "the envelope the worker's parser read");
  assert.ok(page.includes("plan 3f9a0c1d2e4b5a67 · written by portfolio-job · applied 2026-10-05 06:00 UTC"));
  assert.ok(page.includes("plans collected in runs on this host, last 30d: applied 1 · plan-absent 1 · plan-stale 1</div>"));
  assert.equal(mod.splitCounts({ unreachable: "EACCES" }), null, "an unread scan counts nothing");
  assert.equal(slice.outsideEdit, null);

  // No envelope, and an envelope that does not load: neither reads the queue at all.
  let dials = 0;
  mod._setAllocationSeamsForTests({ redisFn: () => { dials += 1; throw new Error("dialled"); }, prefix: "t507" });
  try {
    assert.deepEqual(await mod.assembleAllocationView({ envelopeFile: null }, null), { unset: true });
    writeFileSync(files.envelope, "{ not json");
    // A broken envelope names its file by basename only: the page is a file meant to be shared.
    assert.deepEqual(await mod.assembleAllocationView(paths, null), { problem: "the envelope file does not load: envelope file is not valid JSON (at character 2): envelope.json" });
    // --full-paths is the page's one opt-in for host paths, and it holds here too.
    assert.deepEqual(await mod.assembleAllocationView(paths, null, { fullPaths: true }), { problem: `the envelope file does not load: envelope file is not valid JSON (at character 2): ${files.envelope}` });
    // The cut is made on the parser's raw text: a folder whose name the escape rewrites still loses its path.
    const odd = join(dir, "zero\u200bwidth");
    mkdirSync(odd);
    writeFileSync(join(odd, "envelope.json"), "{ not json");
    assert.deepEqual(await mod.assembleAllocationView({ ...paths, envelopeFile: join(odd, "envelope.json") }, null), { problem: "the envelope file does not load: envelope file is not valid JSON (at character 2): envelope.json" });
  } finally {
    mod._setAllocationSeamsForTests({});
  }
  assert.equal(dials, 0, "no queue read for an unset or a broken envelope");
});

test("during an envelope mismatch every total shown is the applied split's, and the mismatch line says this host's file differs, on the text twin, the assembler and the insights page (#507)", async () => {
  const { fakeAllocRedis } = await import("./helpers/fake-alloc-redis.mjs");
  const { fileTotalText, renderAllocations, splitTotalMicros } = await import("../src/render.mjs");
  const { readEnvelope } = await import("../src/read-model.mjs");
  const { buildInsightsHtml } = await import("../src/insights-html.mjs");
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
  mod._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507t", now: () => new Date(Date.parse("2026-10-05T14:00:00Z")) });
  let slice;
  try {
    slice = await mod.assembleAllocationView(paths, null);
  } finally {
    mod._setAllocationSeamsForTests({});
  }
  assert.deepEqual([slice.totalMicros, slice.fileTotalMicros, slice.mismatch], [28 * M, 30 * M, true]);
  const note = fileTotalText("$30.00");
  assert.equal(note, " This host's file says total $30.00; the totals shown are the split's.");
  const text = renderAllocations({ envelope: read.envelope, digest: read.digest, alloc: { state, log: [], spend: { deployment: { micros: 8 * M } } } }).split("\n");
  assert.match(text[0], /^ALLOCATION · week · total \$28\.00 · /);
  assert.ok(text.includes(`made for envelope ${made}, not this host's: governed jobs here refuse as envelope-mismatch.${note}`), text.join("\n"));
  assert.ok(text.includes("  unallocated $1.00 · deployment spent $8.00 of $28.00"), text.join("\n"));
  const page = buildInsightsHtml({ allocation: slice, window: "30d" }, { now: 0 });
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
  const { buildInsightsHtml } = await import("../src/insights-html.mjs");
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
  mod._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507s", now: () => new Date(Date.parse("2026-10-05T14:00:00Z")) });
  let slice;
  try {
    slice = await mod.assembleAllocationView(paths, null);
  } finally {
    mod._setAllocationSeamsForTests({});
  }
  const page = buildInsightsHtml({ allocation: slice, window: "30d" }, { now: 0 });
  assert.ok(page.includes(`$7.00 allocated · ${SPLIT_ONLY_MARK.replace("'", "&#39;")}`), "the page's bar row, in render.mjs' words, escaped");
  assert.ok(page.includes(`>legacy</text>`), "its label");
  const agreeingPage = buildInsightsHtml({ allocation: { ...slice, mismatch: false }, window: "30d" }, { now: 0 });
  assert.ok(!agreeingPage.includes(">legacy</text>"));
});

test("the outside-edit notice is one rule and one sentence on the panel's text twin, the assembler and the insights page (#507)", async () => {
  const { fakeAllocRedis } = await import("./helpers/fake-alloc-redis.mjs");
  const { outsideEdit, outsideEditText, renderAllocations } = await import("../src/render.mjs");
  const { readEnvelope } = await import("../src/read-model.mjs");
  const { buildInsightsHtml } = await import("../src/insights-html.mjs");
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
    mod._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507", now: () => new Date(Date.parse("2026-10-05T14:00:00Z")) });
    let slice;
    try {
      slice = await mod.assembleAllocationView(paths, null);
    } finally {
      mod._setAllocationSeamsForTests({});
    }
    const label = JSON.stringify(log.map((r) => r.outcome));
    const rule = outsideEdit(log, digest);
    assert.equal(rule !== null, want, label);
    assert.deepEqual(slice.outsideEdit, rule, `the assembler applies the rule: ${label}`);
    const text = renderAllocations({ envelope: read.envelope, digest, alloc: { state, log, spend: {} } });
    const page = buildInsightsHtml({ allocation: slice, window: "30d" }, { now: 0 });
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
