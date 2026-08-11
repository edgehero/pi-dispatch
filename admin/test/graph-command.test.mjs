import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The graph HTML export command (REQ-GRAPH-HTML-EXPORT): write atomically to the STABLE path, print
 * the file:// URL FIRST, best-effort open, skip-and-say over SSH/headless. Every side effect is
 * injected (the github-app-setup harness shape), so nothing here touches the real fs, spawns, or the
 * network -- assembleGraph's reads resolve against a temp triggers file, an empty temp logs dir, and
 * an unparseable VALKEY_URL that degrades synchronously.
 */
process.env.PI_LOGS_DIR = mkdtempSync(join(tmpdir(), "admin-graph-cmd-"));
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "admin-graph-cmd-agent-"));

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

const fixtureDir = mkdtempSync(join(tmpdir(), "admin-graph-cmd-fixture-"));
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
    valkeyUrl: "not-a-url", // degrades readSchedulers synchronously; a dead PORT would leak an async error event
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

test("graph html writes atomically to the STABLE path and prints the file:// URL before opening", async () => {
  const { events, deps, notify } = harness();
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html"], notify, deps);

  assert.deepEqual(events[0], ["mkdir", "/gdir", true], "the artifact dir is created recursively first");
  const [, tmpPath, mode, nonEmpty] = events[1];
  assert.equal(events[1][0], "write");
  assert.equal(tmpPath, "/gdir/graph.html.tmp", "the write goes to the .tmp sibling");
  assert.equal(mode, 0o644);
  assert.ok(nonEmpty, "a real page was rendered");
  assert.deepEqual(events[2], ["rename", "/gdir/graph.html.tmp", "/gdir/graph.html"], "tmp+rename: a reload never reads half a file");

  const notifyAt = events.findIndex((e) => e[0] === "notify");
  const openAt = events.findIndex((e) => e[0] === "open");
  assert.ok(notifyAt >= 0 && openAt > notifyAt, "the URL prints BEFORE the spawn -- the URL is the contract, the spawn a convenience");
  assert.match(events[notifyAt][2], /^graph written: file:\/\/\/gdir\/graph\.html$/);
  assert.equal(events[openAt][1], "file:///gdir/graph.html", "the opened URL is the notified one");
});

test("a second run renames onto the SAME path: stable filename, no timestamped strays", async () => {
  const { events, deps, notify } = harness();
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html"], notify, deps);
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html"], notify, deps);
  const renames = events.filter((e) => e[0] === "rename").map((e) => e[2]);
  assert.deepEqual(renames, ["/gdir/graph.html", "/gdir/graph.html"], "re-running updates the tab an operator already has open");
});

test("--no-open writes and prints but never spawns", async () => {
  const { events, deps, notify } = harness();
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html", "--no-open"], notify, deps);
  assert.ok(events.some((e) => e[0] === "rename"), "the artifact still writes");
  assert.ok(events.some((e) => e[0] === "notify" && /graph written/.test(e[2])), "the URL still prints");
  assert.equal(events.filter((e) => e[0] === "open").length, 0);
});

test("over SSH the spawn is skipped AND SAID; on linux without a display likewise; darwin opens", async () => {
  for (const [env, platform, reason] of [
    [{ SSH_CONNECTION: "10.0.0.1 22" }, "darwin", /SSH session/],
    [{ SSH_TTY: "/dev/pts/1" }, "linux", /SSH session/],
    [{}, "linux", /no display/],
  ]) {
    const { events, deps, notify } = harness({ env, platform });
    await mod.graphHtmlCommand(cannedPaths(), ["graph", "html"], notify, deps);
    assert.equal(events.filter((e) => e[0] === "open").length, 0, `no spawn for ${reason}`);
    assert.ok(events.some((e) => e[0] === "notify" && reason.test(e[2])), `the skip is said, never silent (${reason})`);
  }
  const { events, deps, notify } = harness({ env: {}, platform: "darwin" });
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html"], notify, deps);
  assert.equal(events.filter((e) => e[0] === "open").length, 1, "a local darwin session opens");
});

test("a write failure notifies the path and NEVER opens -- a stale artifact must not pass as fresh", async () => {
  const { events, deps, notify } = harness({ writeThrows: true });
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html"], notify, deps);
  assert.ok(events.some((e) => e[0] === "notify" && e[1] === "error" && e[2].includes("/gdir/graph.html")), "the error names the path");
  assert.equal(events.filter((e) => e[0] === "open").length, 0);
  assert.equal(events.filter((e) => e[0] === "rename").length, 0);
});

test("an unknown argument is a usage warning, and nothing writes", async () => {
  const { events, deps, notify } = harness();
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html", "--yes"], notify, deps);
  assert.deepEqual(events.filter((e) => e[0] !== "notify"), [], "no side effect on a usage mistake");
  assert.ok(events.some((e) => e[0] === "notify" && e[1] === "warning" && e[2].includes("usage")), "the usage line answers");
});

test("isHeadlessEnv: SSH wins over the display check, and only linux gates on DISPLAY", () => {
  assert.equal(mod.isHeadlessEnv({ SSH_CONNECTION: "x" }, "darwin"), "SSH session");
  assert.equal(mod.isHeadlessEnv({}, "linux"), "no display");
  assert.equal(mod.isHeadlessEnv({ DISPLAY: ":0" }, "linux"), null);
  assert.equal(mod.isHeadlessEnv({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), null);
  assert.equal(mod.isHeadlessEnv({}, "darwin"), null, "darwin's opener needs no display variable");
  assert.equal(mod.isHeadlessEnv({}, "win32"), null);
});

test("--full-paths is the explicit opt-in that puts run.folder paths into the artifact", async () => {
  // The default artifact is basename-only (durable, shareable file); the flag is the operator's own
  // choice to name their folders (REQ-GRAPH-HTML-EXPORT). The fixture folder path is the probe.
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
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html", "--no-open"], () => {}, deps(without));
  const withFlag = [];
  await mod.graphHtmlCommand(cannedPaths(), ["graph", "html", "--no-open", "--full-paths"], () => {}, deps(withFlag));
  const probe = join(fixtureDir, "absent");
  assert.ok(!without[0].includes(probe), "the default artifact carries no absolute host path");
  assert.ok(withFlag[0].includes(probe), "the opted-in artifact names the configured folder by its full path");
});
