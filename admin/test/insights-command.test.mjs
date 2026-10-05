import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";

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
  ];
  const paths = { envelopeFile: files.envelope, projectsFile: files.projects, settingsFile: files.settings, valkeyUrl: "redis://127.0.0.1:6390" };
  mod._setAllocationSeamsForTests({ redisFn: () => redis, prefix: "t507", now: () => new Date(Date.parse("2026-10-05T12:00:00Z")) });
  let slice;
  try {
    slice = await mod.assembleAllocationView(paths, mod.splitCounts(records));
  } finally {
    mod._setAllocationSeamsForTests({});
  }
  assert.deepEqual(slice.counts, { refusals: { "allocation-cap": 1, "envelope-mismatch": 0, "portfolio-no-envelope": 0, "portfolio-snapshot-oversize": 0 }, plans: { "plan-stale": 1, applied: 1 } });
  assert.deepEqual(slice.log, [{ at: "2026-10-05T06:00:00.000Z", writer: "portfolio-job", outcome: "applied", reason: null, planId: "3f9a0c1d2e4b5a67" }], "a row cut to its enum fields: no host");
  assert.equal(JSON.stringify(slice).includes("CANARY"), false, "no host and no reason text leave the assembler");
  assert.equal(slice.mismatch, false);
  const page = buildInsightsHtml({ allocation: slice, window: "30d" }, { now: 0 });
  assert.ok(page.includes('<span class="wl">envelope</span><span>$100.00 per week · delegation on</span>'), "the envelope the worker's parser read");
  assert.ok(page.includes("plan 3f9a0c1d2e4b5a67 · written by portfolio-job · applied 2026-10-05 06:00 UTC"));
  assert.ok(page.includes("plans collected in the spend window: applied 1 · plan-stale 1</div>"));
  assert.equal(mod.splitCounts({ unreachable: "EACCES" }), null, "an unread scan counts nothing");
  assert.deepEqual(await mod.assembleAllocationView({ envelopeFile: null }, null), { unset: true }, "no envelope, no queue read");

  // A broken envelope names its file by basename only: the page is a file meant to be shared.
  writeFileSync(files.envelope, "{ not json");
  const broken = await mod.assembleAllocationView(paths, null);
  assert.deepEqual(broken, { problem: "the envelope file does not load: envelope file is not valid JSON (at character 2): envelope.json" });
});
