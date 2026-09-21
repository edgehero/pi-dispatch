import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The panel's sandbox entry point, loaded through pi's own jiti exactly as the extension is (#277).
 *
 * RUN_DETAIL advertises `b` from `readSandboxInfo`'s `retained` verdict, and the key press goes through
 * `resolveSandbox`. Both have to refuse a run from another venue, or the panel offers a key the worker's own
 * choke point then refuses -- or, before #277, opens it.
 */
process.env.PI_CODING_AGENT_DIR = tempDir("admin-sandbox-agent-");

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

/** A retention root holding one run, written the way `retainJobDir` writes it. */
function retainedRoot(extra) {
  const sandboxDir = tempDir("admin-sbx-");
  mkdirSync(join(sandboxDir, "gh-1"), { recursive: true });
  const workspace = join(sandboxDir, "gh-1", "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(sandboxDir, "gh-1", "manifest.json"), JSON.stringify({ jobId: "gh-1", kind: "github", image: "pi-job:latest", workspace, createdAt: "2026-09-14T08:00:00.000Z", keepUntil: null, ...extra }));
  return sandboxDir;
}

const NOW = Date.parse("2026-09-14T09:00:00.000Z");

test("the panel does not advertise a sandbox for a run from another venue, and says which (#277)", () => {
  const paths = { sandboxDir: retainedRoot({ backend: "far" }), sandboxRetentionHours: 24 };
  const info = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW });
  assert.equal(info.retained, false, "`retained` is the verdict the dashboard's `b` guard reads");
  assert.match(info.reason, /ran on far/);
});

test("a local run, and one retained before venues were recorded, are still re-openable from the panel", () => {
  const local = { sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24 };
  assert.deepEqual(mod.readSandboxInfo(local, "gh-1", { now: () => NOW }), { retained: true, pinned: false, expiresIn: "23h" });
  const old = { sandboxDir: retainedRoot({}), sandboxRetentionHours: 24 };
  assert.equal(mod.readSandboxInfo(old, "gh-1", { now: () => NOW }).retained, true);
});

test("a manifest that names no venue is not advertised either", () => {
  const paths = { sandboxDir: retainedRoot({ backend: null }), sandboxRetentionHours: 24 };
  const info = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW });
  assert.equal(info.retained, false);
  assert.match(info.reason, /no venue recorded/);
});

/** The panel's own I/O and docker, recorded. */
function panelIo(over = {}) {
  const written = [];
  const docker = [];
  const launched = [];
  const io = {
    write: (s) => written.push(s),
    pause: async () => {},
    env: {},
    running: async () => [],
    launch: async ({ args }) => (launched.push(args), { code: 0 }),
    // Issue #341: never decided against a real daemon in a unit test.
    resolveJobUser: async () => ({ user: null, home: null }),
    spawnNetwork: (cmd, args) => {
      docker.push(args.join(" "));
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
    ...over,
  };
  return { io, written, docker, launched };
}

test("a sandbox opened from the panel lands on its own egress network, like the CLI's (#277)", async () => {
  // Before #277 the panel passed no network: with PI_EGRESS armed, a panel-opened sandbox had the whole internet.
  const paths = { sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24, sandboxIdleMinutes: 30 };
  const { io, docker, launched, written } = panelIo();
  await mod.openSandboxSession(paths, "gh-1", io);
  assert.equal(launched.length, 1);
  assert.ok(launched[0].includes("--network=pi-sandbox-gh-1-net"));
  assert.ok(launched[0].some((a) => a.startsWith("HTTPS_PROXY=")));
  assert.ok(docker.indexOf("network create --internal pi-sandbox-gh-1-net") >= 0, "the session's own network is created");
  assert.equal(docker.at(-1), "network rm pi-sandbox-gh-1-net", "and removes it when the shell exits");
  assert.match(written.join(""), /no credentials are set/);

  const off = panelIo({ env: { PI_EGRESS: "0" } });
  await mod.openSandboxSession(paths, "gh-1", off.io);
  assert.ok(!off.launched[0].some((a) => a.startsWith("--network")), "PI_EGRESS=0 keeps the default bridge, as the worker does");
  assert.deepEqual(off.docker, []);
});

test("the panel launches a sandbox as the user the job-user seam answers, like the CLI (#341)", async () => {
  const paths = { sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24, sandboxIdleMinutes: 30 };
  let asked = null;
  const { io, launched } = panelIo({ env: { PI_EGRESS: "0" }, resolveJobUser: async ({ manifest }) => ((asked = manifest), { user: "1234:1234", home: "/home/pi" }) });
  await mod.openSandboxSession(paths, "gh-1", io);
  assert.equal(asked?.jobId, "gh-1");
  assert.ok(launched[0].includes("--user=1234:1234"));
  assert.ok(launched[0].includes("HOME=/home/pi"));
});

test("the panel refuses what the CLI refuses: another venue, a running sandbox, a malformed PI_EGRESS", async () => {
  const far = panelIo();
  await mod.openSandboxSession({ sandboxDir: retainedRoot({ backend: "far" }), sandboxRetentionHours: 24 }, "gh-1", far.io);
  assert.match(far.written.join(""), /cannot open a sandbox for gh-1: .*"far"/);
  assert.deepEqual(far.launched, []);

  const busy = panelIo({ running: async () => ["gh-1"] });
  await mod.openSandboxSession({ sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24 }, "gh-1", busy.io);
  assert.match(busy.written.join(""), /already running/);
  assert.deepEqual(busy.launched, []);

  const typo = panelIo({ env: { PI_EGRESS: "off" } });
  await mod.openSandboxSession({ sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24 }, "gh-1", typo.io);
  assert.match(typo.written.join(""), /PI_EGRESS must be exactly/);
  assert.deepEqual(typo.launched, [], "never the open network on a typo");
});

test("a network the panel cannot create names where the panel reads the egress setting (#277)", async () => {
  // A deployment that sets PI_EGRESS=0 only in its .env reads as armed here; the refusal must not just blame a
  // proxy that deployment never runs.
  const failing = panelIo({
    spawnNetwork: (cmd, args) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", args[1] === "create" || args[1] === "inspect" ? 1 : 0));
      return child;
    },
  });
  await mod.openSandboxSession({ sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24 }, "gh-1", failing.io);
  const text = failing.written.join("");
  assert.match(text, /could not create the egress network/);
  assert.match(text, /read from this process's environment \(PI_EGRESS, PI_EGRESS_PROXY\)/);
  assert.deepEqual(failing.launched, []);
});

test("a detached panel session says so, and leaves the network (#277)", async () => {
  let asks = 0;
  const detached = panelIo({ running: async () => (asks++ === 0 ? [] : ["gh-1"]) });
  await mod.openSandboxSession({ sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24 }, "gh-1", detached.io);
  assert.match(detached.written.join(""), /detached: the sandbox is still running with its egress network, which is left in place after it exits/);
  assert.ok(!detached.docker.includes("network rm pi-sandbox-gh-1-net"));
});
