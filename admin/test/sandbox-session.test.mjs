import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
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
  // `egress` rides along since #337: the posture a sandbox opened HERE would get, read from the env this
  // call is given rather than from the deployment's, which the panel has no way to see.
  assert.deepEqual(mod.readSandboxInfo(local, "gh-1", { now: () => NOW, env: { PI_EGRESS: "0" } }), {
    retained: true,
    pinned: false,
    expiresIn: "23h",
    egress: { armed: false, proxy: "pi-dispatch-egress-proxy", source: "this shell" },
  });
  const old = { sandboxDir: retainedRoot({}), sandboxRetentionHours: 24 };
  assert.equal(mod.readSandboxInfo(old, "gh-1", { now: () => NOW, env: {} }).retained, true);
});

test("readSandboxInfo reports the egress posture it resolved, and says whose environment that is (#337)", () => {
  // #337 item 2. The panel reads PI_EGRESS from its OWN process, because that is what `openSandbox` uses
  // when `b` is pressed, and it genuinely cannot compare that against the deployment's: nothing here
  // loads a `.env`, the panel may have been started anywhere, and the deployment pointer carries paths
  // and never capability grants (`OQ-025`). So the answer states the posture AND its provenance.
  const paths = { sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24 };
  const armed = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW, env: {} });
  assert.deepEqual(armed.egress, { armed: true, proxy: "pi-dispatch-egress-proxy", source: "this shell" }, "unset means ARMED, which is the worker's own default");
  const named = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW, env: { PI_EGRESS_PROXY: "my-proxy" } });
  assert.equal(named.egress.proxy, "my-proxy");
  // `egressArmed` THROWS on a value it cannot parse and `openSandbox` refuses rather than opening a shell
  // on the open network, so this must not come back as "off": that is the one reading that is wrong in
  // the dangerous direction.
  const bad = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW, env: { PI_EGRESS: "maybe" } });
  assert.deepEqual(bad.egress, { malformed: true, source: "this shell" });
});

test("a manifest that names no venue is not advertised either", () => {
  const paths = { sandboxDir: retainedRoot({ backend: null }), sandboxRetentionHours: 24 };
  const info = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW });
  assert.equal(info.retained, false);
  assert.match(info.reason, /no venue recorded/);
});

/** A retained local run, which is what every session test below opens. */
const RETAINED = { sandboxDir: retainedRoot({ backend: "local" }), sandboxRetentionHours: 24, sandboxIdleMinutes: 30 };

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

test("a sandbox that exits non-zero without opening a shell PAUSES, rather than redrawing over itself (#337)", async () => {
  // Item 4. The panel suspended pi's TUI to hand over the terminal, so without a pause the whole failure
  // is one line that `tui.start()` paints over before anyone reads it: the operator presses `b` at a run
  // that never opens and no screen says why.
  let pauses = 0;
  const { io, written } = panelIo({ launch: async () => ({ code: 125 }), pause: async () => void pauses++ });
  await mod.openSandboxSession(RETAINED, "gh-1", io);
  assert.match(written.join(""), /the sandbox exited 125 without opening a shell/);
  assert.match(written.join(""), /the name may be taken/, "and 125 gets the hint docker's own code earns");
  assert.equal(pauses, 1, "the operator reads it before the panel comes back");
});

test("a DETACHED session exits 0 and must not also report a failure (#337)", async () => {
  // Ctrl-P Ctrl-Q returns code 0 with the container still live, and the detached branch already pauses.
  // A second pause for the same event would make the operator press a key twice for one outcome.
  // `detached` is `openSandbox`'s own verdict, from docker still listing the sandbox after the shell
  // returned, so it is driven the way the #277 test drives it rather than faked on the launch result.
  let pauses = 0;
  let asks = 0;
  const { io, written } = panelIo({ running: async () => (asks++ === 0 ? [] : ["gh-1"]), pause: async () => void pauses++ });
  await mod.openSandboxSession(RETAINED, "gh-1", io);
  assert.match(written.join(""), /detached: the sandbox is still running/);
  assert.doesNotMatch(written.join(""), /without opening a shell/);
  assert.equal(pauses, 1);
});

test("a clean exit says nothing extra and does not pause (#337)", async () => {
  let pauses = 0;
  const { io, written } = panelIo({ launch: async () => ({ code: 0 }), pause: async () => void pauses++ });
  await mod.openSandboxSession(RETAINED, "gh-1", io);
  assert.doesNotMatch(written.join(""), /without opening a shell/);
  assert.equal(pauses, 0, "an ordinary exit returns straight to the panel, as it always did");
});

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
