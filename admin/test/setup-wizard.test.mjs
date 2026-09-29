import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as realFs from "node:fs";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The `/dispatch setup` wizard (setup-wizard.ts): the detection tree, the pinned npm shapes, the
 * suspend/spawn bracket, the step engine's consent seams, the first-trigger flow, and the one-time
 * startup nudge. Everything runs offline: detection and the wizard take injected env/fs/probe/spawn
 * seams, and the real-fs cases use per-test temp dirs.
 */

// Hermeticity, BEFORE the module graph loads: pointerPath() and the nudge marker derive from
// PI_CODING_AGENT_DIR, and no test may ever read (or write!) the real ~/.pi/agent.
process.env.PI_CODING_AGENT_DIR = tempDir("admin-setup-agent-");

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(fileURLToPath(new URL("../src/setup-wizard.ts", import.meta.url)));

/** A probe that fails the test if detection consults the network when it must not. */
const mustNotProbe = async () => {
  throw new Error("detection consulted the queue probe on a branch that must short-circuit before it");
};

/** An empty temp dir (no scaffold files), for cwd arguments. */
const emptyDir = () => tempDir("admin-setup-empty-");

/** A canned-answer, recording ctx.ui in the crud.test.mjs shape, plus (title/message) capture. */
function wizardUi({ select = [], input = [], confirm = [] } = {}) {
  const notes = [];
  const seen = { select: [], input: [], confirm: [] };
  const sel = [...select];
  const inp = [...input];
  const con = [...confirm];
  const ui = {
    async select(title, options) {
      seen.select.push({ title, options });
      return sel.shift();
    },
    async input(title, placeholder) {
      seen.input.push({ title, placeholder });
      return inp.shift();
    },
    async confirm(title, message) {
      seen.confirm.push({ title, message });
      return con.shift();
    },
    notify: (m, t) => notes.push({ m, t }),
  };
  return { ui, notes, seen };
}

/**
 * Common recording deps for the step engine; every host-touching seam is a fake that records.
 *
 * `probeDockerFn` defaults to a green answer for the same reason detectFn is canned: the docker
 * pre-check (step 3) would otherwise exec a REAL `docker version` on whatever box runs the suite, which
 * is neither offline nor deterministic. The docker step's own tests override it.
 */
function wizardDeps(overrides = {}) {
  const attached = [];
  const pointerWrites = [];
  const order = [];
  const dashboards = [];
  const deps = {
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json") },
    platform: "linux",
    execPath: "/usr/bin/node-under-test",
    homedirFn: () => tempDir("admin-setup-home-"),
    detectFn: async () => ({ state: "none", detail: "canned detection" }),
    probeDockerFn: () => ({ ok: true }),
    // No `up` Valkey to hand over, and nothing on its volume, unless a test says so (never this host's docker).
    dockerQueryFn: fakeDocker(),
    // No Valkey is dialled: the owner marker is this folder's unless a test says otherwise.
    claimOwnerFn: async (_url, folder) => ({ owner: folder, claimed: false }),
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      return { code: 0 };
    },
    writePointerFn: (args) => {
      pointerWrites.push(args);
      order.push("write");
      return { ok: true };
    },
    reapplyFn: () => {
      order.push("reapply");
      return { applied: [] };
    },
    openDashboardFn: async (paths, _ctx, _notify) => {
      dashboards.push(paths);
    },
    resolvePathsFn: () => ({ canned: "resolved" }),
    ...overrides,
  };
  return { deps, attached, pointerWrites, order, dashboards };
}

const tuiCtx = (ui, cwd) => ({ mode: "tui", hasUI: true, ui, cwd });

/** Plant an installed runtime of `version` inside a deployment dir (what the npm step would produce). */
function plantRuntime(dir, version) {
  const runtimeDir = join(dir, "node_modules", "@edgehero", "pi-dispatch");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "package.json"), JSON.stringify({ name: "@edgehero/pi-dispatch", version }));
  return runtimeDir;
}

const cliPathOf = (dir) => join(dir, "node_modules", "@edgehero", "pi-dispatch", "src", "cli.mjs");

// ── the detection tree: one test per branch, in trust order ──────────────────────────────────────

test("detect: a valid pointer file wins, and the probe is never consulted", async () => {
  const pfile = join(tempDir("admin-det-"), "pointer.json");
  writeFileSync(pfile, JSON.stringify({ version: 1, deploymentDir: "/srv/deploy", env: {} }));
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: pfile },
    cwd: emptyDir(),
    probeQueue: mustNotProbe,
  });
  assert.equal(det.state, "pointer");
  assert.match(det.detail, /\/srv\/deploy/, "the detail names the deployment dir");
});

test("detect: a stale/invalid pointer file falls through to the later branches", async () => {
  const pfile = join(tempDir("admin-det-"), "pointer.json");
  // A future-version pointer is readPointer's { ignored } -- detection must degrade exactly like
  // /dispatch itself does, not stop at a file it cannot honor.
  writeFileSync(pfile, JSON.stringify({ version: 99, deploymentDir: "/srv/deploy", env: {} }));
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: pfile, PI_TRIGGERS_FILE: "/x/triggers.json" },
    cwd: emptyDir(),
    probeQueue: mustNotProbe,
  });
  assert.equal(det.state, "env", "the broken pointer is skipped, the env branch answers");
});

test("detect: an exported path variable means 'env', named in the detail", async () => {
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json"), PI_TRIGGERS_FILE: "/x/triggers.json" },
    cwd: emptyDir(),
    probeQueue: mustNotProbe,
  });
  assert.equal(det.state, "env");
  assert.match(det.detail, /PI_TRIGGERS_FILE/);
});

test("detect: VALKEY_URL alone is probed, never trusted as 'env'", async () => {
  // An exported queue URL is a claim about the network, so detection verifies it (branch 4) instead of
  // short-circuiting -- a dead URL must yield the setup offer, and the wiring tests pin the probe to a
  // dead port through exactly this behaviour.
  let probedUrl;
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json"), VALKEY_URL: "redis://127.0.0.1:1" },
    cwd: emptyDir(),
    probeQueue: async (url) => {
      probedUrl = url;
      return false;
    },
  });
  assert.equal(det.state, "none");
  assert.equal(probedUrl, "redis://127.0.0.1:1", "the exported URL fed the probe");
});

test("detect: the cwd scaffold quadruple means 'cwd' (pi-packages.json deliberately not required)", async () => {
  const cwd = emptyDir();
  // Exactly init's original signature -- and NO pi-packages.json, which older deployments predate.
  for (const f of [".env", "triggers.json", "pause-windows.json", "subscriptions.json"]) writeFileSync(join(cwd, f), "");
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json") },
    cwd,
    probeQueue: mustNotProbe,
  });
  assert.equal(det.state, "cwd");
  assert.match(det.detail, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("detect: a partial scaffold is not 'cwd' — it falls through to the probe", async () => {
  const cwd = emptyDir();
  for (const f of [".env", "triggers.json", "pause-windows.json"]) writeFileSync(join(cwd, f), "");
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json") },
    cwd,
    probeQueue: async () => false,
  });
  assert.equal(det.state, "none");
});

test("detect: a reachable queue with nothing else configured is 'reachable'", async () => {
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(emptyDir(), "absent.json") },
    cwd: emptyDir(),
    probeQueue: async () => true,
  });
  assert.equal(det.state, "reachable");
  assert.match(det.detail, /redis:\/\/127\.0\.0\.1:6379/, "the default URL was the one probed");
});

test("detect: never stats logsDir/settingsFile — every fs touch is the pointer or the scaffold", async () => {
  // logsDir and settingsFile default lazily into OS temp locations, so their absence proves nothing;
  // a recording fake fs pins that detection never grows a stat of either. Whitelist assertion: every
  // recorded path must be the pointer file or one of the four scaffold files -- nothing else, ever.
  const reads = [];
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const fakeFs = {
    readFileSync: (p) => {
      reads.push(String(p));
      throw enoent();
    },
    existsSync: (p) => {
      reads.push(String(p));
      return false;
    },
    statSync: (p) => {
      reads.push(String(p));
      throw enoent();
    },
    readdirSync: (p) => {
      reads.push(String(p));
      return [];
    },
  };
  const cwd = "/detect-cwd";
  const det = await mod.detectDeployment({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: "/agent/pointer.json", PI_LOGS_DIR: "", PI_SETTINGS_FILE: "" },
    cwd,
    fs: fakeFs,
    probeQueue: async () => false,
  });
  assert.equal(det.state, "none");
  const allowed = new Set([
    "/agent/pointer.json",
    join(cwd, ".env"),
    join(cwd, "triggers.json"),
    join(cwd, "pause-windows.json"),
    join(cwd, "subscriptions.json"),
  ]);
  assert.ok(reads.length > 0, "the fake fs was actually consulted");
  for (const p of reads) assert.ok(allowed.has(p), `unexpected filesystem read: ${p}`);
  assert.ok(!reads.some((p) => /logs|settings/i.test(p)), "no logsDir/settingsFile path was ever touched");
});

// ── the npm shapes: pure, exact, path-free ───────────────────────────────────────────────────────

test("npmInstallArgs: the exact pinned, script-less argv with no filesystem path token", () => {
  const args = mod.npmInstallArgs();
  assert.deepEqual(args, [
    "install",
    `@edgehero/pi-dispatch@${mod.RUNTIME_VERSION}`,
    "--omit=dev",
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ]);
  // The win32 shell:true safety argument (import-pi.mjs:400-419) rests on argv holding NO filesystem
  // path: no absolute/relative path token, no backslash, no --prefix pair -- the install target is cwd.
  for (const a of args) {
    assert.ok(!a.startsWith("/") && !a.startsWith(".") && !a.startsWith("\\"), `no path token in argv: ${a}`);
    assert.ok(!a.includes("\\"), `no backslash in argv: ${a}`);
  }
  assert.ok(!args.some((a) => a.includes("--prefix")), "the install target is the spawn cwd, never a --prefix path");
});

test("npmInstallArgsFor: the SAME pinned, path-free argv for both packages, wrappers included", () => {
  // The generalization must not weaken the win32 `shell: true` argument for EITHER package: the whole
  // safety rests on argv carrying no filesystem path and one `name@version` token of module literals.
  assert.deepEqual(
    mod.npmInstallArgs(),
    mod.npmInstallArgsFor("@edgehero/pi-dispatch", mod.RUNTIME_VERSION),
    "the runtime wrapper is exactly the shared shape applied to its pin",
  );
  assert.deepEqual(
    mod.receiverInstallArgs(),
    mod.npmInstallArgsFor("@edgehero/pi-dispatch-receiver", mod.RECEIVER_VERSION),
    "and so is the receiver's",
  );
  assert.equal(mod.receiverInstallArgs()[1], `@edgehero/pi-dispatch-receiver@${mod.RECEIVER_VERSION}`);
  for (const args of [mod.npmInstallArgs(), mod.receiverInstallArgs()]) {
    assert.equal(args[0], "install");
    for (const flag of ["--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]) {
      assert.ok(args.includes(flag), `${flag} survives for ${args[1]}`);
    }
    for (const a of args) {
      assert.ok(!a.startsWith("/") && !a.startsWith(".") && !a.startsWith("\\"), `no path token in argv: ${a}`);
      assert.ok(!a.includes("\\"), `no backslash in argv: ${a}`);
    }
    assert.ok(!args.some((a) => a.includes("--prefix")), "the install target is the spawn cwd, never a --prefix path");
  }
});

test("npmSpawnOptions: npm.cmd + shell on win32, plain npm elsewhere, cwd is the deployment dir", () => {
  assert.deepEqual(mod.npmSpawnOptions("win32", "C:\\deploy"), { bin: "npm.cmd", options: { cwd: "C:\\deploy", shell: true } });
  assert.deepEqual(mod.npmSpawnOptions("linux", "/deploy"), { bin: "npm", options: { cwd: "/deploy" } });
  assert.deepEqual(mod.npmSpawnOptions("darwin", "/deploy"), { bin: "npm", options: { cwd: "/deploy" } });
});

test("runtimeDirFor + readInstalledVersion: one spelling for both packages; absent/garbage is undefined", () => {
  const dir = emptyDir();
  assert.equal(mod.runtimeDirFor(dir), join(dir, "node_modules", "@edgehero", "pi-dispatch"), "the runtime is the default");
  assert.equal(mod.runtimeDirFor(dir, "pi-dispatch-receiver"), join(dir, "node_modules", "@edgehero", "pi-dispatch-receiver"));
  assert.equal(mod.readInstalledVersion(realFs, mod.runtimeDirFor(dir)), undefined, "absent reads undefined, never throws");
  plantRuntime(dir, "0.0.9");
  assert.equal(mod.readInstalledVersion(realFs, mod.runtimeDirFor(dir)), "0.0.9");
  writeFileSync(join(mod.runtimeDirFor(dir), "package.json"), "{ not json");
  assert.equal(mod.readInstalledVersion(realFs, mod.runtimeDirFor(dir)), undefined, "unparseable is undefined too — the skew notice's silence");
});

// ── the docker probe: three outcomes, three remedies ─────────────────────────────────────────────

test("probeDocker: asks `docker version` with output discarded and sorts the two failure kinds", () => {
  const calls = [];
  assert.deepEqual(
    mod.probeDocker((bin, args, opts) => {
      calls.push([bin, args, opts]);
      return "";
    }),
    { ok: true },
  );
  // The timeout is load-bearing: this is a SYNC exec on a dialog path, so a wedged docker socket must
  // not be able to freeze pi's render loop.
  assert.deepEqual(
    calls,
    [["docker", ["version"], { stdio: "ignore", timeout: 10_000 }]],
    "the cheapest question, output discarded, bounded in time",
  );

  const killed = mod.probeDocker(() => {
    throw Object.assign(new Error("spawnSync docker ETIMEDOUT"), { killed: true, signal: "SIGTERM" });
  });
  assert.match(killed.daemonDown, /ETIMEDOUT/, "a timeout kill is 'installed but not answering', not 'missing'");

  const missing = mod.probeDocker(() => {
    throw Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" });
  });
  assert.deepEqual(missing, { missing: true }, "no binary on PATH");

  const down = mod.probeDocker(() => {
    throw Object.assign(new Error("Cannot connect to the Docker daemon"), { status: 1 });
  });
  assert.match(down.daemonDown, /exited 1/, "the CLI ran and refused: installed, daemon not up");

  const odd = mod.probeDocker(() => {
    throw new Error("something else entirely");
  });
  assert.match(odd.daemonDown, /something else entirely/, "an unclassifiable failure is still a state, never a throw");
});

test("dockerHint: per-OS vendor instructions, and NEVER a piped installer command", () => {
  assert.match(mod.dockerHint("darwin"), /Docker Desktop/);
  assert.match(mod.dockerHint("darwin"), /orbstack/i, "macOS gets the OrbStack alternative too");
  assert.match(mod.dockerHint("win32"), /Docker Desktop/);
  assert.match(mod.dockerHint("linux"), /docs\.docker\.com\/engine\/install/, "linux points at the distro-package docs");
  for (const platform of ["darwin", "win32", "linux", "freebsd"]) {
    const hint = mod.dockerHint(platform);
    assert.ok(hint.length > 0, `${platform} still gets text (unknown platforms fall back)`);
    assert.ok(
      !/curl|wget|\|\s*(ba)?sh\b|Invoke-WebRequest|\biwr\b/i.test(hint),
      `a wizard must never print a piped installer: ${hint}`,
    );
  }
});

// ── RUNTIME_VERSION / RECEIVER_VERSION anti-drift ────────────────────────────────────────────────

test("RUNTIME_VERSION matches the in-repo worker/package.json version (release bumps stay atomic)", () => {
  const workerPkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../worker/package.json", import.meta.url)), "utf8"));
  assert.equal(mod.RUNTIME_VERSION, workerPkg.version);
});

test("RECEIVER_VERSION matches the in-repo receiver/package.json version (same atomic-bump bolt)", () => {
  const receiverPkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../receiver/package.json", import.meta.url)), "utf8"));
  assert.equal(mod.RECEIVER_VERSION, receiverPkg.version);
  assert.equal(receiverPkg.name, "@edgehero/pi-dispatch-receiver", "and the package name the argv pins");
});

// ── runAttached: the suspend/spawn/restore bracket ───────────────────────────────────────────────

/** A ctx whose ui.custom invokes the factory with a recording fake tui and resolves on done(). */
function attachedCtx(order) {
  const tui = {
    stop: () => order.push("stop"),
    start: () => order.push("start"),
    requestRender: (full) => order.push(`render:${full}`),
  };
  const ui = {
    custom(factory, opts) {
      assert.equal(opts?.overlay, true, "runAttached runs as an overlay");
      return new Promise((resolve) => {
        const component = factory(tui, {}, {}, resolve);
        assert.equal(typeof component.render, "function", "the factory returns a component");
        component.handleInput("x"); // must be inert: the child owns stdin
      });
    },
  };
  return { mode: "tui", ui };
}

test("runAttached: stop → spawn → start + requestRender(true), and the exit code is captured", async () => {
  const order = [];
  const { EventEmitter } = await import("node:events");
  const spawnFn = (argv0, args, options) => {
    order.push(`spawn:${argv0}`);
    assert.equal(options.stdio, "inherit", "the child owns the terminal");
    assert.equal(options.cwd, "/deploy");
    const child = new EventEmitter();
    setImmediate(() => child.emit("close", 7));
    return child;
  };
  const res = await mod.runAttached(attachedCtx(order), { title: "t", argv0: "x", args: [], cwd: "/deploy", spawnFn });
  assert.equal(res.code, 7, "the exit code is captured, never discarded (unlike the sandbox opener)");
  assert.deepEqual(order, ["stop", "spawn:x", "start", "render:true"]);
});

test("runAttached: a spawn 'error' event resolves { code: null, error } and still restores the tui", async () => {
  const order = [];
  const { EventEmitter } = await import("node:events");
  const spawnFn = () => {
    order.push("spawn");
    const child = new EventEmitter();
    setImmediate(() => child.emit("error", new Error("ENOENT-ish")));
    return child;
  };
  const res = await mod.runAttached(attachedCtx(order), { title: "t", argv0: "x", args: [], spawnFn });
  assert.equal(res.code, null);
  assert.match(res.error.message, /ENOENT-ish/);
  assert.deepEqual(order, ["stop", "spawn", "start", "render:true"]);
});

test("runAttached: a synchronously-throwing spawn still runs the finally bracket", async () => {
  const order = [];
  const spawnFn = () => {
    order.push("spawn");
    throw new Error("boom at spawn time");
  };
  const res = await mod.runAttached(attachedCtx(order), { title: "t", argv0: "x", args: [], spawnFn });
  assert.equal(res.code, null);
  assert.match(res.error.message, /boom at spawn time/);
  assert.deepEqual(order, ["stop", "spawn", "start", "render:true"], "start + full redraw even on a throw");
});

test("runAttached: refuses without a TUI (mode/custom), spawning nothing", async () => {
  const spawnFn = () => {
    throw new Error("must not spawn");
  };
  for (const ctx of [{ mode: "print", ui: { custom: () => {} } }, { mode: "tui", ui: {} }, undefined]) {
    const res = await mod.runAttached(ctx, { title: "t", argv0: "x", args: [], spawnFn });
    assert.equal(res.code, null);
    assert.match(res.error.message, /terminal UI/);
  }
});

// ── the step engine ──────────────────────────────────────────────────────────────────────────────

test("wizard: without the dialog primitives it degrades to one notice and touches nothing", async () => {
  const notes = [];
  const { deps, attached } = wizardDeps({
    detectFn: async () => {
      throw new Error("must not even detect");
    },
  });
  await mod.runSetupWizard({}, { mode: "tui", ui: {} }, (m, t) => notes.push({ m, t }), deps);
  assert.equal(notes.length, 1);
  assert.match(notes[0].m, /dialogs|newer pi/);
  assert.equal(attached.length, 0);
});

test("wizard: 'Open the panel anyway' short-circuits to the dashboard with the original paths", async () => {
  const { ui, seen } = wizardUi({ select: ["Open the panel anyway"] });
  const paths = { triggersPath: "/decoy/triggers.json" };
  const opened = [];
  const { deps } = wizardDeps({ openDashboardFn: async (p) => opened.push(p) });
  await mod.runSetupWizard(paths, tuiCtx(ui), ui.notify, deps);
  assert.equal(opened.length, 1);
  assert.equal(opened[0], paths, "the pre-wizard paths object, by identity");
  assert.equal(seen.input.length, 0, "no later step ran");
});

test("wizard: initialDetection is honored — the caller's verdict is never re-detected", async () => {
  // The bare-/dispatch caller detected already; one keypress must not cost two detections (queue probe
  // included). detectFn THROWS here, so a re-detect fails the test instead of quietly costing a probe.
  const { ui, notes } = wizardUi({ select: ["Cancel"] });
  const { deps } = wizardDeps({
    detectFn: async () => {
      throw new Error("the wizard re-detected instead of using initialDetection");
    },
    initialDetection: { state: "none", detail: "handed over by the caller" },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.ok(notes.some((n) => /handed over by the caller/.test(n.m)), "the handed-over detail is what the operator reads");
});

// ── the docker pre-check (step 3) ─────────────────────────────────────────────────────────────────

test("wizard: a green docker pre-check asks nothing and says nothing", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  let probes = 0;
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Skip", "Skip"], // intent, worker, trigger edge
    input: [dir],
    confirm: [false, false, false], // up, pointer, github — all declined
  });
  const { deps } = wizardDeps({
    probeDockerFn: () => {
      probes++;
      return { ok: true };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(probes, 1, "probed exactly once");
  assert.ok(!seen.select.some((s) => /Docker/.test(s.title)), "a healthy host is never asked about docker");
  // No noise from THIS step (the later trigger-edge notice legitimately names `docker compose`).
  assert.ok(
    !notes.some((n) => /docker check|Docker is not ready|without a docker answer/.test(n.m)),
    "a green probe says nothing at all",
  );
});

test("wizard: a missing docker notifies the per-OS pointer text; 'Continue anyway' still installs", async () => {
  const dir = emptyDir();
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Continue anyway", "Skip", "Skip"], // intent, DOCKER GATE, worker, trigger edge
    input: [dir],
    confirm: [true, false, false, false], // install ACCEPTED, up/pointer/github declined
  });
  const { deps, attached } = wizardDeps({
    platform: "darwin",
    probeDockerFn: () => ({ missing: true }),
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      plantRuntime(dir, mod.RUNTIME_VERSION);
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  const gate = seen.select.find((s) => /Docker is not ready/.test(s.title));
  assert.deepEqual(gate.options, ["Re-check", "Continue anyway", "Stop"]);
  const warned = notes.find((n) => /docker check/.test(n.m));
  assert.equal(warned.t, "warning", "the remedy is on screen before the question is answered");
  assert.match(warned.m, /no `docker` on PATH/);
  assert.match(warned.m, /Docker Desktop/, "the macOS pointer text, per the injected platform");
  assert.ok(!/curl|wget/i.test(warned.m), "never a piped installer");
  // "Continue anyway" is not enforcement-by-our-probe: up runs its own docker checks and refuses there.
  assert.equal(attached.length, 1, "the install step still ran");
  assert.deepEqual(attached[0].args, mod.npmInstallArgs());
});

test("wizard: 'Stop' at the docker gate ends the wizard having spawned nothing", async () => {
  const dir = emptyDir();
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Stop"], // intent, DOCKER GATE
    input: [dir],
    confirm: [], // no consent gate is ever reached
  });
  const { deps, attached, pointerWrites, dashboards } = wizardDeps({
    platform: "linux",
    probeDockerFn: () => ({ daemonDown: "`docker version` exited 1" }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0, "nothing spawned");
  assert.equal(pointerWrites.length, 0, "nothing written");
  assert.equal(seen.confirm.length, 0, "no consent gate was reached");
  assert.equal(dashboards.length, 0, "and no panel — a Stop is a stop");
  assert.ok(notes.some((n) => /not answering/.test(n.m) && /docs\.docker\.com\/engine\/install/.test(n.m)), "the linux pointer text");
  assert.ok(notes.some((n) => /stopped before anything was installed/.test(n.m)), "and says nothing was installed");
});

test("wizard: 'Re-check' re-probes, bounded — five probes, then it stops like Stop", async () => {
  const dir = emptyDir();
  let probes = 0;
  const { ui, notes, seen } = wizardUi({
    // One more Re-check than the bound can consume: the cap, not the answer source, must end this.
    select: ["Guided setup", "Re-check", "Re-check", "Re-check", "Re-check", "Re-check"], // intent, then five Re-checks
    input: [dir],
    confirm: [], // no consent gate is ever reached
  });
  const { deps, attached, dashboards } = wizardDeps({
    probeDockerFn: () => {
      probes++;
      return { missing: true };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(probes, 5, "bounded at five probes — a stuck answer source cannot spin the wizard");
  assert.equal(seen.select.filter((s) => /Docker is not ready/.test(s.title)).length, 4, "four gates for five probes");
  assert.equal(attached.length, 0, "nothing was ever spawned");
  assert.equal(dashboards.length, 0);
  assert.ok(notes.some((n) => n.t === "error" && /still not ready after 5 checks/.test(n.m)), "the exhausted bound is said out loud");
});

test("wizard: declined confirms spawn NOTHING, and every step is still offered", async () => {
  const dir = emptyDir();
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Skip", "Skip"], // intent, worker, trigger edge
    input: [dir],
    confirm: [false, false, false, false], // install, up, pointer, github -- all declined
  });
  const { deps, attached, pointerWrites, dashboards } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0, "a declined confirm never reaches a spawn");
  assert.equal(pointerWrites.length, 0, "a declined pointer confirm writes nothing");
  assert.equal(seen.confirm.length, 4, "all four consent gates were offered despite the declines");
  assert.equal(seen.select.length, 3, "intent + worker choice + trigger edge");
  assert.ok(notes.some((n) => /provider key/.test(n.m)), "the never-tier provider-key notice still fires");
  assert.ok(notes.some((n) => /setup finished/.test(n.m)));
  assert.equal(dashboards.length, 1, "the wizard still ends at the panel");
  assert.deepEqual(dashboards[0], { canned: "resolved" }, "opened against freshly resolved paths");
});

test("wizard: an accepted install spawns the exact npm shape and never clobbers an existing package.json", async () => {
  const dir = emptyDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "custom-root" }));
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Skip", "Skip"], // intent, worker, trigger edge
    input: [dir],
    confirm: [true, false, false, false], // install ACCEPTED, up, pointer, github declined
  });
  const { deps, attached, dashboards } = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      plantRuntime(dir, mod.RUNTIME_VERSION); // what a good npm run produces
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 1);
  assert.equal(attached[0].argv0, "npm", "posix npm, per npmSpawnOptions");
  assert.deepEqual(attached[0].args, mod.npmInstallArgs());
  assert.equal(attached[0].cwd, dir, "the install target is the spawn cwd");
  assert.equal(attached[0].shell, undefined, "no shell off win32");
  assert.match(seen.confirm[0].message, /npm install/, "the confirm shows the exact command");
  assert.match(seen.confirm[0].message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "and names the dir");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), { name: "custom-root" }, "an existing root package.json is never clobbered");
  assert.equal(dashboards.length, 1, "a clean install continues to the end");
});

test("wizard: a post-install version mismatch stops the wizard loudly — no later step runs", async () => {
  const dir = emptyDir();
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup"], // intent only — the mismatch below stops the wizard
    input: [dir],
    confirm: [true], // accept the install; nothing later should be asked
  });
  const { deps, attached, dashboards } = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      plantRuntime(dir, "9.9.9"); // npm "succeeded" with the wrong artifact (import-pi:334-341)
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.ok(notes.some((n) => n.t === "error" && /9\.9\.9/.test(n.m) && /not the pinned/.test(n.m)), "the error names both versions");
  assert.equal(attached.length, 1, "only the npm spawn ran — never up/service/github");
  assert.equal(seen.confirm.length, 1, "no later consent gate was reached");
  assert.equal(dashboards.length, 0, "the wizard did not continue to the panel");
  // The if-absent private root package.json was written before the install (import-pi:294 idiom).
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), { name: "pi-dispatch-deployment", private: true });
});

test("wizard: an already-pinned runtime skips the install silently-but-said", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Skip", "Skip"], // intent, worker, trigger edge
    input: [dir],
    confirm: [false, false, false], // up, pointer, github — no install confirm expected
  });
  const { deps, attached } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.ok(!seen.confirm.some((c) => /Install the pi-dispatch runtime/.test(c.title)), "no install dialog");
  assert.ok(notes.some((n) => /already installed/.test(n.m) && /skipping npm install/.test(n.m)), "the skip is said out loud");
  assert.equal(attached.length, 0);
});

test("wizard: up runs without --yes; a nonzero exit gates on Continue/Stop, and Stop ends the wizard", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Stop"], // intent, then the up-failure gate
    input: [dir],
    confirm: [true], // accept up; it fails; Stop
  });
  const { deps, attached, dashboards } = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      return { code: 1 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].args, [cliPathOf(dir), "up"], "the child's own y/N gates are the consents — never --yes");
  assert.ok(!attached[0].args.includes("--yes"));
  assert.equal(attached[0].cwd, dir);
  assert.match(seen.select[1].title, /up exited 1/);
  assert.equal(seen.confirm.length, 1, "Stop: the pointer step was never reached");
  assert.equal(dashboards.length, 0);
});

test("wizard: a failed up with 'Continue anyway' proceeds to the pointer step", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Continue anyway", "Skip", "Skip"], // intent, up-failure gate, worker, trigger edge
    input: [dir],
    confirm: [true, false, false], // up (fails), pointer declined, github declined
  });
  const { deps, dashboards } = wizardDeps({
    runAttachedFn: async () => ({ code: 3 }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.ok(seen.confirm.some((c) => /pointer/.test(c.title)), "the wizard continued past the failure");
  assert.equal(dashboards.length, 1);
});

test("wizard: the pointer is written only after a confirm showing the JSON verbatim, then re-applied", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Skip", "Skip"], // intent, worker, trigger edge
    input: [dir],
    confirm: [false, true, false], // up declined, POINTER ACCEPTED, github declined
  });
  const { deps, pointerWrites, order } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(pointerWrites.length, 1);
  const { path, pointer } = pointerWrites[0];
  assert.equal(path, deps.env.PI_DISPATCH_DEPLOYMENT_FILE, "written where pointerPath(env) says");
  assert.equal(pointer.version, 1);
  assert.equal(pointer.deploymentDir, dir);
  assert.deepEqual(pointer.env, {
    PI_TRIGGERS_FILE: join(dir, "triggers.json"),
    PI_PAUSE_WINDOWS_FILE: join(dir, "pause-windows.json"),
    PI_SCOPED_LIMITS_FILE: join(dir, "scoped-limits.json"),
    PI_SUBSCRIPTIONS_FILE: join(dir, "subscriptions.json"),
  });
  const pointerConfirm = seen.confirm.find((c) => /pointer/.test(c.title));
  assert.ok(pointerConfirm.message.includes(JSON.stringify(pointer, null, 2)), "the confirm shows the exact JSON-to-be");
  assert.ok(pointerConfirm.message.includes(dir), "including the deploymentDir");
  assert.deepEqual(order, ["write", "reapply"], "re-applied AFTER the write, so this session picks it up");
});

// ── the trigger-edge step (step 10) ──────────────────────────────────────────────────────────────

const EDGE_TITLE = "How should GitHub events reach the queue?";
const EDGE_SERVICE = "Install the webhook receiver as a service";
const EDGE_COMPOSE = "Run the receiver with docker compose";
const EDGE_POLL = "Show the polling command";
const RECEIVER_PKG = "@edgehero/pi-dispatch-receiver";

/** Plant an installed receiver of `version` — what the edge step's npm install would produce. */
function plantReceiver(dir, version) {
  const d = join(dir, "node_modules", "@edgehero", "pi-dispatch-receiver");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: RECEIVER_PKG, version }));
  return d;
}

/**
 * The FIFO answers that walk an already-pinned deployment to the trigger-edge step and out the other
 * side: intent, worker Skip, the chosen `edge` answer, then Skip at the first trigger. Confirms are
 * up/pointer/github (all declined) followed by whatever the chosen edge answer asks for -- so every
 * assertion below is about the edge answer alone.
 */
function edgeAnswers(dir, edge, edgeConfirms = []) {
  return {
    select: ["Guided setup", "Skip", edge, "Skip"], // intent, worker, TRIGGER EDGE, first trigger
    input: [dir],
    confirm: [false, false, false, ...edgeConfirms], // up, pointer, github declined; then the edge's own
  };
}

/** Did the wizard walk PAST the edge step into step 11? Every one of the four answers must. */
function reachedFirstTrigger(seen) {
  return seen.select.some((s) => /First trigger/.test(s.title));
}

test("wizard: the trigger-edge step offers exactly the three shapes plus Skip", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi(edgeAnswers(dir, "Skip"));
  const { deps } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui, tempDir("admin-setup-repo-")), ui.notify, deps);
  const edge = seen.select.find((s) => s.title === EDGE_TITLE);
  assert.deepEqual(edge.options, [EDGE_SERVICE, EDGE_COMPOSE, EDGE_POLL, "Skip"]);
});

test("wizard: the edge's service answer installs the PINNED receiver, then the --receiver unit", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi(edgeAnswers(dir, EDGE_SERVICE, [true])); // + the receiver install confirm
  const { deps, attached, dashboards } = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      if (opts.args.includes(`${RECEIVER_PKG}@${mod.RECEIVER_VERSION}`)) plantReceiver(dir, mod.RECEIVER_VERSION);
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, deps);

  assert.equal(attached.length, 2, "the npm install and the unit install — nothing else");
  assert.equal(attached[0].argv0, "npm", "posix npm, per npmSpawnOptions");
  assert.deepEqual(attached[0].args, mod.npmInstallArgsFor(RECEIVER_PKG, mod.RECEIVER_VERSION));
  assert.ok(attached[0].args.includes(`${RECEIVER_PKG}@1.5.0`), "the pinned name@version token, spelled out");
  assert.equal(attached[0].cwd, dir, "installed into the deployment dir, by cwd");
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
    { name: "pi-dispatch-deployment", private: true },
    "the receiver install pins npm's project to the deployment dir too — it may be the first npm run here",
  );
  // Commit 1's service fix is what makes THIS correct: the unit anchors on the deployment folder and
  // resolves the receiver's own ./start export from there.
  assert.equal(attached[1].argv0, "/usr/bin/node-under-test");
  assert.deepEqual(attached[1].args, [cliPathOf(dir), "service", "install", "--receiver"]);
  assert.equal(attached[1].cwd, dir);

  const c = seen.confirm.find((x) => /receiver/i.test(x.title));
  assert.match(c.message, new RegExp(`${RECEIVER_PKG.replace("/", "\\/")}@1\\.5\\.0`), "the confirm shows the exact pin");
  assert.match(c.message, /service install --receiver/, "and the unit command it will run after");
  assert.ok(c.message.includes(dir), "and names the cwd");
  assert.ok(reachedFirstTrigger(seen), "the wizard continued to step 11");
  assert.equal(dashboards.length, 1);
});

test("wizard: a receiver version mismatch skips the UNIT and the wizard CONTINUES (unlike the runtime's)", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes, seen } = wizardUi(edgeAnswers(dir, EDGE_SERVICE, [true]));
  const { deps, attached, dashboards } = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      plantReceiver(dir, "9.9.9"); // npm "succeeded" with the wrong artifact
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, deps);
  assert.equal(attached.length, 1, "the npm spawn only — never a unit pointing at the wrong version");
  assert.ok(
    notes.some((n) => n.t === "error" && /9\.9\.9/.test(n.m) && /not the pinned/.test(n.m) && /skipping the receiver unit/.test(n.m)),
    "the error names both versions and what it skipped",
  );
  assert.ok(reachedFirstTrigger(seen), "the receiver is OPTIONAL: a bad install costs this step, not the wizard");
  assert.equal(dashboards.length, 1, "and the panel still opens");
});

test("wizard: a declined receiver confirm spawns nothing and names both commands for later", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes, seen } = wizardUi(edgeAnswers(dir, EDGE_SERVICE, [false]));
  const { deps, attached } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, deps);
  assert.equal(attached.length, 0);
  assert.ok(notes.some((n) => /receiver skipped/.test(n.m) && /service install --receiver/.test(n.m)));
  assert.ok(reachedFirstTrigger(seen));
});

test("wizard: the edge's compose answer copies the runtime's compose file CREATE-ONLY, then runs it", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  const runtimeDir = plantRuntime(dir, mod.RUNTIME_VERSION);
  mkdirSync(join(runtimeDir, "deploy"), { recursive: true });
  writeFileSync(join(runtimeDir, "deploy", "docker-compose.yml"), "# the runtime's own compose file\n");
  writeFileSync(join(runtimeDir, "deploy", "egress-proxy.conf"), "# the runtime's own squid rules\n");
  // Into <dir>/deploy/, the layout the file's relative paths are written for (the follow-up to issue #468).
  const dest = join(dir, "deploy", "docker-compose.yml");

  const first = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [true])); // + the compose up confirm
  const rec = wizardDeps({
    runAttachedFn: async (_ctx, opts) => {
      rec.attached.push(opts);
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(first.ui, repo), first.ui.notify, rec.deps);
  assert.equal(readFileSync(dest, "utf8"), "# the runtime's own compose file\n", "copied out of the installed runtime");
  assert.equal(readFileSync(join(dir, "deploy", "egress-proxy.conf"), "utf8"), "# the runtime's own squid rules\n", "with the rules file its ./egress-proxy.conf names");
  assert.ok(!existsSync(join(dir, "docker-compose.yml")), "never at the folder's top, where its ../ paths leave the folder");
  assert.equal(rec.attached.length, 1);
  assert.equal(rec.attached[0].argv0, "docker");
  // The docs' own command, from the deployment folder: `--env-file .env` is where compose reads the Valkey's
  // VALKEY_PASSWORD (issue #468), `-f deploy/docker-compose.yml` the file in the layout it is written for.
  // `-p` keeps the project named after the folder, as the copy at its top was (PR #475's review).
  const project = mod.composeProjectName(dir);
  const args = ["compose", "-p", project, "--env-file", ".env", "-f", join("deploy", "docker-compose.yml"), "--profile", "receiver", "up", "-d"];
  assert.deepEqual(rec.attached[0].args, args, "the opt-in receiver profile");
  assert.equal(rec.attached[0].cwd, dir);
  assert.ok(first.seen.confirm.at(-1).message.includes(`docker ${args.join(" ")}`), "the confirm shows the exact command");
  assert.equal(rec.attached[0].title, `docker ${args.join(" ")} (in ${dir})`, "the title is the argv that runs");
  assert.ok(reachedFirstTrigger(first.seen));

  // Second pass over the SAME dir: the operator may have edited that file, so it is never clobbered.
  writeFileSync(dest, "# MINE — edited by the operator\n");
  const second = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [false])); // decline the up: only the copy matters here
  const rec2 = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(second.ui, repo), second.ui.notify, rec2.deps);
  assert.equal(readFileSync(dest, "utf8"), "# MINE — edited by the operator\n", "create-only: an existing compose file survives");
  assert.ok(second.notes.some((n) => /already exists/.test(n.m) && /kept as it is \(setup never overwrites an existing file\)/.test(n.m)), "and the skip is said out loud");
  assert.ok(second.notes.some((n) => n.m.startsWith(`later: docker ${args.join(" ")}  (in ${dir})`)), "the skip hint is the argv that would have run");
  assert.equal(rec2.attached.length, 0, "a declined up spawns nothing");
  assert.ok(reachedFirstTrigger(second.seen));

  // An earlier setup's copy at the folder's top is named as unused, never run and never removed.
  writeFileSync(join(dir, "docker-compose.yml"), "# the old copy\n");
  const third = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [false]));
  await mod.runSetupWizard({}, tuiCtx(third.ui, repo), third.ui.notify, wizardDeps().deps);
  assert.ok(third.notes.some((n) => n.t === "warning" && /is an earlier setup's copy: its \.\.\/ paths reach the folder above/.test(n.m) && n.m.includes(`It ran as compose project "${project}" (its volume ${project}_valkey-data), which the command below keeps with -p ${project}`)), "names the project and the volume it keeps");
  assert.equal(readFileSync(join(dir, "docker-compose.yml"), "utf8"), "# the old copy\n");
});

// The follow-up to issue #468: the SHIPPED compose file, copied where the wizard copies it, names only paths inside the
// deployment folder. Every relative path in it (env_file entries and bind-mount sources) is resolved against the written
// file's own directory, as compose resolves them.
test("wizard: every relative path in the compose file it writes resolves inside the deployment folder", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  const runtimeDir = plantRuntime(dir, mod.RUNTIME_VERSION);
  mkdirSync(join(runtimeDir, "deploy"), { recursive: true });
  const shipped = join(fileURLToPath(new URL("../../worker/deploy/", import.meta.url)));
  for (const f of ["docker-compose.yml", "egress-proxy.conf"]) writeFileSync(join(runtimeDir, "deploy", f), readFileSync(join(shipped, f)));
  const { ui } = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [false]));
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, wizardDeps().deps);
  const written = join(dir, "deploy", "docker-compose.yml");
  const text = readFileSync(written, "utf8");
  const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  const rel = [];
  for (const m of code.matchAll(/^\s*env_file:\s*(\S+)\s*$/gm)) rel.push(m[1]);
  for (const m of code.matchAll(/^\s*-\s*"?(\.{1,2}\/[^:"\s]+):/gm)) rel.push(m[1]);
  assert.deepEqual(rel.sort(), ["../.env", "../egress-allowlist.conf", "../triggers.json", "./egress-proxy.conf"], "the scan reaches every relative path the shipped file names");
  const { resolve, dirname, sep } = await import("node:path");
  for (const p of rel) {
    const at = resolve(dirname(written), p);
    assert.ok(at.startsWith(dir + sep), `${p} resolves to ${at}, outside ${dir}`);
  }
  // And each lands on what the deployment holds under that name.
  assert.ok(existsSync(resolve(dirname(written), "./egress-proxy.conf")), "the rules file beside it");
  assert.equal(resolve(dirname(written), "../.env"), join(dir, ".env"), "the .env `--env-file .env` names from the folder");
});

test("wizard: the edge's compose answer degrades when the runtime ships no compose file", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION); // no deploy/ inside it: the install was declined earlier
  const { ui, notes, seen } = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [true]));
  const { deps, attached, dashboards } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, deps);
  assert.equal(attached.length, 0, "no compose spawn without a compose file");
  assert.ok(notes.some((n) => n.t === "error" && /could not copy/.test(n.m)), "the failure is named, not swallowed");
  assert.ok(reachedFirstTrigger(seen), "and it is still only this step that is skipped");
  assert.equal(dashboards.length, 1);
});

test("wizard: the edge's polling answer PRINTS both commands and spawns nothing", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes, seen } = wizardUi(edgeAnswers(dir, EDGE_POLL));
  const { deps, attached } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, deps);
  assert.equal(attached.length, 0, "a long-running poller is never started from the wizard's overlay");
  const note = notes.find((n) => /pi-dispatch-receiver poll/.test(n.m));
  assert.ok(note, "the producer command is named");
  assert.match(note.m, /setup github --no-webhook/, "and the hook-inactive App mint that goes with it");
  assert.ok(note.m.includes(dir), "both from the deployment folder");
  assert.equal(seen.confirm.length, 3, "print-only: no consent gate of its own (up/pointer/github only)");
  assert.ok(reachedFirstTrigger(seen));
});

test("wizard: the edge's Skip says one line naming all three options, and spawns nothing", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes, seen } = wizardUi(edgeAnswers(dir, "Skip"));
  const { deps, attached } = wizardDeps();
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, deps);
  assert.equal(attached.length, 0);
  const note = notes.find((n) => /trigger edge left for later/.test(n.m));
  assert.ok(note, "the deferral is said once");
  for (const needle of ["service install --receiver", "--profile receiver up -d", "pi-dispatch-receiver poll"]) {
    assert.ok(note.m.includes(needle), `the deferral names ${needle}`);
  }
  // Issue #480: the compose route needs the compose file, which this answer did not copy in, so it names setup's own step.
  assert.ok(note.m.includes("run /dispatch setup again and choose it: that copies in deploy/docker-compose.yml"), note.m);
  assert.ok(!note.m.includes("`docker compose --profile receiver up -d`"), "no bare compose line a folder without the file cannot run");
  assert.ok(reachedFirstTrigger(seen));
});

// ── the first-trigger step ───────────────────────────────────────────────────────────────────────

/** Wrap the real fs, recording every write/mkdir path, so "never writes into the repo" is assertable. */
function recordingFs() {
  const writes = [];
  return {
    writes,
    fs: {
      mkdirSync: (p, o) => {
        writes.push(String(p));
        return realFs.mkdirSync(p, o);
      },
      writeFileSync: (p, d) => {
        writes.push(String(p));
        return realFs.writeFileSync(p, d);
      },
      renameSync: (a, b) => {
        writes.push(String(b));
        return realFs.renameSync(a, b);
      },
      existsSync: (p) => realFs.existsSync(p),
      readFileSync: (p, e) => realFs.readFileSync(p, e),
      readdirSync: (p) => realFs.readdirSync(p),
    },
  };
}

test("wizard: the first trigger targets ctx.cwd, lists real repo skills, and writes only the deploy dir", async () => {
  const repo = tempDir("admin-setup-repo-");
  // One offerable skill, one gate-refused name (uppercase+space fails SKILL_NAME_RE), one without SKILL.md.
  mkdirSync(join(repo, ".pi", "skills", "nightly-tidy"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "nightly-tidy", "SKILL.md"), "# tidy\n");
  mkdirSync(join(repo, ".pi", "skills", "Bad Name"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "Bad Name", "SKILL.md"), "# nope\n");
  mkdirSync(join(repo, ".pi", "skills", "no-skill-md"), { recursive: true });

  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Skip", "Skip", "A cron trigger for this repo", "nightly-tidy"], // intent, worker, trigger edge, first trigger, flow
    input: [dir, "", "", ""], // dir, id blank→nightly, pattern blank→0 3 * * *, task blank→run the flow
    confirm: [false, false, false], // up, pointer, github — all declined
  });
  const rec = recordingFs();
  const triggerWrites = [];
  const { deps } = wizardDeps({
    fs: rec.fs,
    writeTriggersFn: ({ triggersPath, mutate }) => {
      triggerWrites.push({ triggersPath, list: mutate([]) });
      return { ok: true };
    },
  });
  const paths = { triggersPath: "/decoy/triggers.json" };
  await mod.runSetupWizard(paths, tuiCtx(ui, repo), ui.notify, deps);

  const flowSelect = seen.select.find((s) => /flow/.test(s.title));
  assert.deepEqual(flowSelect.options, ["nightly-tidy", "type another…"], "SKILL_NAME_RE + SKILL.md filter the offer");

  assert.equal(triggerWrites.length, 1);
  assert.equal(triggerWrites[0].triggersPath, join(dir, "triggers.json"), "the DEPLOY dir's file — where the pointer aims the panel");
  assert.notEqual(triggerWrites[0].triggersPath, paths.triggersPath, "never the pre-wizard resolved path");
  const entry = triggerWrites[0].list[0];
  assert.deepEqual(entry, {
    on: { type: "cron", id: "nightly", pattern: "0 3 * * *" },
    run: { kind: "local", folder: repo, flow: "nightly-tidy", task: "run the flow" },
  });

  assert.ok(notes.some((n) => n.t === "warning" && /IN PLACE with no undo/.test(n.m)), "the in-place-edit warning fired");
  assert.ok(notes.some((n) => /ai-trigger: allow/.test(n.m)), "the frontmatter line is notified, not written");
  for (const p of rec.writes) {
    assert.ok(!p.startsWith(repo), `the wizard must never write into the repo: ${p}`);
  }
});

test("wizard: an invalid cron id refuses at the dialog and skips the trigger", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes } = wizardUi({
    select: ["Guided setup", "Skip", "Skip", "A cron trigger for this repo"], // intent, worker, trigger edge, first trigger
    // No .pi/skills in this repo, so flow is a free input: dir, flow, then the bad id.
    input: [dir, "tidy", "night:ly"],
    confirm: [false, false, false], // up, pointer, github — all declined
  });
  const triggerWrites = [];
  const { deps } = wizardDeps({
    writeTriggersFn: (args) => {
      triggerWrites.push(args);
      return { ok: true };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui, repo), ui.notify, deps);
  assert.ok(notes.some((n) => n.t === "error" && /invalid cron id/.test(n.m)), "the ':' id is refused with the charset named");
  assert.equal(triggerWrites.length, 0, "nothing was written");
});

test("wizard: no first-trigger offer when ctx.cwd is unset or missing on disk", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  for (const cwd of [undefined, join(emptyDir(), "absent-subdir")]) {
    const { ui, seen } = wizardUi({
      select: ["Guided setup", "Skip", "Skip"], // intent, worker, trigger edge
      input: [dir],
      confirm: [false, false, false], // up, pointer, github — all declined
    });
    const triggerWrites = [];
    const { deps } = wizardDeps({
      writeTriggersFn: (args) => {
        triggerWrites.push(args);
        return { ok: true };
      },
    });
    await mod.runSetupWizard({}, tuiCtx(ui, cwd), ui.notify, deps);
    assert.ok(!seen.select.some((s) => /First trigger/.test(s.title)), "the step is not offered without a real folder");
    assert.equal(triggerWrites.length, 0);
  }
});

test("listRepoSkills: filters by SKILL_NAME_RE and SKILL.md presence; [] on any error", () => {
  const repo = tempDir("admin-setup-skills-");
  mkdirSync(join(repo, ".pi", "skills", "fix"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "fix", "SKILL.md"), "");
  mkdirSync(join(repo, ".pi", "skills", "review"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "review", "SKILL.md"), "");
  mkdirSync(join(repo, ".pi", "skills", "UPPER"), { recursive: true });
  writeFileSync(join(repo, ".pi", "skills", "UPPER", "SKILL.md"), "");
  mkdirSync(join(repo, ".pi", "skills", "empty-one"), { recursive: true });
  assert.deepEqual(mod.listRepoSkills(repo).sort(), ["fix", "review"]);
  assert.deepEqual(mod.listRepoSkills(join(repo, "nope")), [], "a missing .pi/skills is an empty offer, not a throw");
});

// ── the one-time startup nudge ───────────────────────────────────────────────────────────────────

/** Register the nudge against a crud-style pi Proxy and capture the session_start handler. */
function nudgeSetup({ env = {}, scaffoldCwd = false } = {}) {
  const agentDir = tempDir("admin-nudge-agent-");
  const cwd = tempDir("admin-nudge-cwd-");
  if (scaffoldCwd) {
    for (const f of [".env", "triggers.json", "pause-windows.json", "subscriptions.json"]) writeFileSync(join(cwd, f), "");
  }
  let handler;
  const pi = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === "on"
          ? (evt, h) => {
              if (evt === "session_start") handler = h;
            }
          : () => {},
    },
  );
  mod.registerNudge(pi, { env: { PI_CODING_AGENT_DIR: agentDir, ...env } });
  const notes = [];
  const dialogs = [];
  const ctx = {
    hasUI: true,
    cwd,
    ui: {
      notify: (m, t) => notes.push([m, t]),
      select: () => dialogs.push("select"),
      input: () => dialogs.push("input"),
      confirm: () => dialogs.push("confirm"),
    },
  };
  return { handler, notes, dialogs, ctx, agentDir, cwd };
}

test("nudge: registers a session_start handler; reload and no-UI starts are inert", () => {
  const n = nudgeSetup();
  assert.equal(typeof n.handler, "function");
  n.handler({ type: "session_start", reason: "reload" }, n.ctx);
  assert.equal(n.notes.length, 0, "reload never nudges");
  n.handler({ type: "session_start", reason: "startup" }, { ...n.ctx, hasUI: false });
  assert.equal(n.notes.length, 0, "no UI, no nudge");
  assert.equal(existsSync(join(n.agentDir, "pi-dispatch-setup.nudged")), false, "an inert start writes no marker");
});

test("nudge: fires once with notify only, then the marker suppresses it for good", () => {
  const n = nudgeSetup();
  n.handler({ type: "session_start", reason: "startup" }, n.ctx);
  assert.equal(n.notes.length, 1);
  assert.match(n.notes[0][0], /\/dispatch setup/);
  assert.equal(n.notes[0][1], "info");
  assert.equal(n.dialogs.length, 0, "notify-only: no dialog is ever raised at session start");
  assert.equal(existsSync(join(n.agentDir, "pi-dispatch-setup.nudged")), true, "the once-ever marker exists");
  n.handler({ type: "session_start", reason: "startup" }, n.ctx);
  assert.equal(n.notes.length, 1, "the marker suppresses every later startup");
});

test("nudge: any configured signal — env sextet, pointer file, cwd scaffold — keeps it quiet", () => {
  // VALKEY_URL is part of the NUDGE's sextet (unlike detection's env branch): no probe is allowed
  // here, so an exported queue URL is the closest sync evidence of intent.
  const withEnv = nudgeSetup({ env: { VALKEY_URL: "redis://127.0.0.1:1" } });
  withEnv.handler({ type: "session_start", reason: "startup" }, withEnv.ctx);
  assert.equal(withEnv.notes.length, 0, "an exported VALKEY_URL suppresses the nudge");

  const withPointer = nudgeSetup();
  writeFileSync(
    join(withPointer.agentDir, "pi-dispatch-deployment.json"),
    JSON.stringify({ version: 1, deploymentDir: "/srv/deploy", env: {} }),
  );
  withPointer.handler({ type: "session_start", reason: "startup" }, withPointer.ctx);
  assert.equal(withPointer.notes.length, 0, "a present pointer suppresses the nudge");

  const withScaffold = nudgeSetup({ scaffoldCwd: true });
  withScaffold.handler({ type: "session_start", reason: "startup" }, withScaffold.ctx);
  assert.equal(withScaffold.notes.length, 0, "a cwd scaffold suppresses the nudge");
});

// ── the podman venue (issue #430) ───────────────────────────────────────────────────────────────────

test("probePodman: asks podman info for the rootless flag and sorts rootless, rootful, missing and not answering", () => {
  let asked;
  assert.deepEqual(
    mod.probePodman((bin, args) => {
      asked = [bin, ...args];
      return "true\n";
    }),
    { ok: true },
  );
  assert.deepEqual(asked, ["podman", "info", "--format", "{{.Host.Security.Rootless}}"]);
  assert.deepEqual(mod.probePodman(() => "false\n"), { rootful: true });
  assert.deepEqual(mod.probePodman(() => { throw Object.assign(new Error("x"), { code: "ENOENT" }); }), { missing: true });
  assert.match(mod.probePodman(() => { throw Object.assign(new Error("x"), { status: 125 }); }).daemonDown, /exited 125/);
});

test("wizard: PI_BACKENDS=podman asks podman, never docker, runs up with it, and records it in the deployment's .env", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  let dockerProbes = 0;
  let podmanProbes = 0;
  const { ui, notes, seen } = wizardUi({
    select: ["Guided setup", "Skip", "Skip"], // intent, worker, trigger edge: no runtime gate on a green podman
    input: [dir],
    confirm: [true, false, false], // up accepted; pointer, github declined
  });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probeDockerFn: () => {
      dockerProbes++;
      return { ok: true };
    },
    probePodmanFn: () => {
      podmanProbes++;
      return { ok: true };
    },
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      // What init inside `up` does: scaffold .env with the key commented out.
      writeFileSync(join(dir, ".env"), "# PI_BACKENDS=\n");
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(dockerProbes, 0, "a podman deployment is never asked about docker");
  assert.equal(podmanProbes, 1);
  assert.equal(attached[0].env.PI_BACKENDS, "podman", "up itself runs the podman venue");
  // Issue #458: what up starts on this venue, named as up's own plan names it (worker/src/podman-stack.mjs QUADLET_FILES).
  assert.match(seen.confirm[0].message, /then Valkey, the egress proxy and its rootless network keeper as Quadlet units/);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^PI_BACKENDS=podman$/m, "the service reads the venue from the file");
  assert.ok(notes.some((n) => /PI_BACKENDS=podman written into/.test(n.m)));
});

test("#447 gate round 1: a .env that `up` creates with a systemd hazard in it is left unchanged, not given PI_BACKENDS", async () => {
  // `init` inside `up` copies the deployment's OWN .env.example when there is one, so the file the wizard writes into
  // can appear after its pre-check with a line systemd reads differently. The write-time check refuses it and says so.
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes } = wizardUi({ select: ["Guided setup", "Skip", "Skip"], input: [dir], confirm: [true, false, false] });
  const { deps } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
    runAttachedFn: async () => {
      writeFileSync(join(dir, ".env"), "# PI_BACKENDS=\nX=1\rY=2\n");
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "# PI_BACKENDS=\nX=1\rY=2\n", "PI_BACKENDS was not written");
  assert.ok(notes.some((n) => /line 2 has a carriage return/.test(n.m) && /PI_BACKENDS=podman was NOT written into .*, which is unchanged/.test(n.m)), JSON.stringify(notes));
  assert.ok(!notes.some((n) => /PI_BACKENDS=podman written into/.test(n.m)), "and it never says the service reads it");
});

test("wizard: on Linux a failed docker gate offers rootless Podman, and choosing it runs up with PI_BACKENDS=podman", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, seen } = wizardUi({
    select: ["Guided setup", "Use rootless Podman instead", "Skip", "Skip"], // intent, DOCKER GATE, worker, trigger edge
    input: [dir],
    confirm: [true, false, false],
  });
  const { deps, attached } = wizardDeps({
    platform: "linux",
    probeDockerFn: () => ({ missing: true }),
    probePodmanFn: () => ({ ok: true }),
    runAttachedFn: async (_ctx, opts) => {
      attached.push(opts);
      writeFileSync(join(dir, ".env"), "WEBHOOK_SECRET=x\n");
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  const gate = seen.select.find((s) => /Docker is not ready/.test(s.title));
  assert.deepEqual(gate.options, ["Re-check", "Use rootless Podman instead", "Continue anyway", "Stop"]);
  assert.match(seen.confirm[0].message, /PI_BACKENDS=podman .* up/, "the exact command, with the variable it runs under");
  assert.equal(attached[0].env.PI_BACKENDS, "podman");
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /^PI_BACKENDS=podman$/m);
});

test("wizard: a rootful Podman is named as the wrong kind, and Stop ends setup having spawned nothing", async () => {
  const dir = emptyDir();
  const { ui, notes } = wizardUi({ select: ["Guided setup", "Stop"], input: [dir], confirm: [] });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ rootful: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0);
  assert.ok(notes.some((n) => n.t === "warning" && /not rootless for this account/.test(n.m) && /docs\/podman\.md/.test(n.m)));
});

test("wizard: the compose receiver is explained, not attempted, on the podman venue", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes } = wizardUi({
    select: ["Guided setup", "Skip", "Run the receiver with docker compose"],
    input: [dir],
    confirm: [false, false, false],
  });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.ok(!existsSync(join(dir, "docker-compose.yml")), "no compose file copied");
  assert.ok(!attached.some((a) => a.argv0 === "docker"), "docker never spawned");
  assert.ok(notes.some((n) => /needs docker compose, and this deployment runs on rootless Podman/.test(n.m)));
});

test("wizard: the edge's Skip on the podman venue names no receiver container, only the service (PR #488's review)", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes } = wizardUi({
    select: ["Guided setup", "Skip", "Skip"],
    input: [dir],
    confirm: [false, false, false],
  });
  const { deps } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  const note = notes.find((n) => /trigger edge left for later/.test(n.m));
  assert.ok(note, notes.map((n) => n.m).join("\n"));
  assert.match(note.m, /trigger edge left for later: two ways stay open from .*no receiver container on rootless Podman \(it needs docker compose: run the receiver as that service instead\)/);
  assert.doesNotMatch(note.m, /--profile receiver up -d|all three/);
});

test("M21: a re-run finds the podman venue in the deployment's .env when the wizard's own env says nothing", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  writeFileSync(join(dir, ".env"), "PI_BACKENDS=podman\n");
  let dockerProbes = 0;
  let podmanProbes = 0;
  const { ui } = wizardUi({ select: ["Guided setup", "Skip", "Skip"], input: [dir], confirm: [false, false, false] });
  const { deps } = wizardDeps({
    probeDockerFn: () => {
      dockerProbes++;
      return { ok: true };
    },
    probePodmanFn: () => {
      podmanProbes++;
      return { ok: true };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(dockerProbes, 0);
  assert.equal(podmanProbes, 1);
});

test("M14: a PI_BACKENDS the operator already set without podman is left untouched, and the wizard says so", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes } = wizardUi({ select: ["Guided setup", "Skip", "Skip"], input: [dir], confirm: [true, false, false] });
  const { deps } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
    runAttachedFn: async () => {
      writeFileSync(join(dir, ".env"), "PI_BACKENDS=local\n");
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "PI_BACKENDS=local\n", "never clobbered");
  assert.ok(notes.some((n) => n.t === "warning" && /already sets PI_BACKENDS to something without podman; left untouched/.test(n.m)));
});

test("E5: rootless Podman chosen over a .env that sets PI_BACKENDS without podman stops setup, never clobbers, and names the edit", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  writeFileSync(join(dir, ".env"), "PI_BACKENDS=local\n");
  const { ui, notes } = wizardUi({ select: ["Guided setup", "Use rootless Podman instead"], input: [dir], confirm: [] });
  const { deps, attached } = wizardDeps({ platform: "linux", probeDockerFn: () => ({ missing: true }), probePodmanFn: () => ({ ok: true }) });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0, "up never ran");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "PI_BACKENDS=local\n");
  assert.ok(notes.some((n) => n.t === "error" && /sets PI_BACKENDS=local, which does not list podman/.test(n.m) && /Change it to PI_BACKENDS=podman/.test(n.m)));
});

test("E5: a .env that already lists podman is what up reads: the wizard hands up no PI_BACKENDS of its own", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  writeFileSync(join(dir, ".env"), "PI_BACKENDS=podman\n");
  const { ui, seen } = wizardUi({ select: ["Guided setup", "Skip", "Skip"], input: [dir], confirm: [true, false, false] });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "local,podman" },
    probePodmanFn: () => ({ ok: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached[0].env.PI_BACKENDS, undefined, "the shell's list would conflict with the file's, and up refuses a conflict");
  assert.doesNotMatch(seen.confirm[0].message, /PI_BACKENDS=podman /);
});

test("#447: a .env systemd splits into lines differently (a lone CR) stops the podman setup, naming the line and the change", async () => {
  // systemd reads the CR as a line break, so the unit sets PI_BACKENDS=podman from line 1 while a line-by-line reading
  // sees only X (measured on systemd 259). The wizard reads the file as `service install` does, so it stops too.
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  writeFileSync(join(dir, ".env"), "X=1\rPI_BACKENDS=local\n");
  const { ui, notes } = wizardUi({ select: ["Guided setup"], input: [dir], confirm: [] });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0, "nothing is installed");
  const err = notes.find((n) => n.t === "error" && /line 1 has a carriage return \(CR\) that is not part of a CRLF line ending/.test(n.m));
  assert.ok(err, JSON.stringify(notes));
  assert.match(err.m, /remove the CR, or save the file with LF \(or CRLF\) line endings\. Setup stops before anything is installed: make that change/);
});

test("#447 gate round 1: the podman setup refuses a .env with a systemd hazard BEFORE it writes PI_BACKENDS, even with no venue key in it", async () => {
  // The wizard used to pass `X=1<CR>Y=2` (no venue key spelled), write PI_BACKENDS=podman under it, and say the service
  // reads it; the next up or service install then refused the file. It now refuses first and changes nothing.
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  writeFileSync(join(dir, ".env"), "X=1\rY=2\n");
  const { ui, notes } = wizardUi({ select: ["Guided setup"], input: [dir], confirm: [] });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0, "nothing is installed");
  assert.ok(notes.some((n) => n.t === "error" && /line 1 has a carriage return/.test(n.m)), JSON.stringify(notes));
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "X=1\rY=2\n", "and the file is unchanged");
});

test("#447 gate round 1: a .env that is not UTF-8 stops the podman setup, and its bytes are left alone", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const bytes = Buffer.concat([Buffer.from("K=caf"), Buffer.from([0xe9]), Buffer.from("\n")]);
  writeFileSync(join(dir, ".env"), bytes);
  const { ui, notes } = wizardUi({ select: ["Guided setup"], input: [dir], confirm: [] });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0);
  // The WRITER's own rule answers first (gate round 2), before up runs, rather than after it.
  assert.ok(notes.some((n) => n.t === "error" && /refusing to edit .*\.env: line 1 \(byte 5\) is not valid UTF-8, and rewriting the file would replace those bytes/.test(n.m)), JSON.stringify(notes));
  assert.ok(readFileSync(join(dir, ".env")).equals(bytes), "byte-identical");
});

test("#447 gate round 2: a byte that is bad only in a COMMENT passes the reader but not the writer, so setup stops before up", async () => {
  // systemd loads this file (a comment is never stored), but the writer would have to rewrite the byte to add a line.
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const bytes = Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from("\nA=1\n")]);
  writeFileSync(join(dir, ".env"), bytes);
  const { ui, notes } = wizardUi({ select: ["Guided setup"], input: [dir], confirm: [] });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0, "up never ran");
  assert.ok(notes.some((n) => n.t === "error" && /line 1 \(byte 5\) is not valid UTF-8/.test(n.m)), JSON.stringify(notes));
  assert.ok(readFileSync(join(dir, ".env")).equals(bytes));
});

test("#447 gate round 3: a .env the writer would refuse stops setup BEFORE up (w01, w02, w13: a continuation or an open quote at the end)", async () => {
  for (const before of ["A=1\nX=a\\\n", 'A=1\nX="abc\n', "A=1\nX='abc\n"]) {
    const dir = emptyDir();
    plantRuntime(dir, mod.RUNTIME_VERSION);
    writeFileSync(join(dir, ".env"), before);
    const { ui, notes } = wizardUi({ select: ["Guided setup"], input: [dir], confirm: [] });
    const { deps, attached } = wizardDeps({
      env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
      probePodmanFn: () => ({ ok: true }),
    });
    await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
    assert.equal(attached.length, 0, `up never ran: ${JSON.stringify(before)}`);
    assert.ok(notes.some((n) => n.t === "error" && /refusing to edit .*: after the edit, systemd's EnvironmentFile= would find no PI_BACKENDS/.test(n.m) && /Setup stops before anything is installed/.test(n.m)), JSON.stringify(notes));
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), before);
  }
});

test("#447 gate round 3: the wizard's own read-back is a backstop behind the writer's, and a failing reading refuses the write", async () => {
  // No file reaches it today (the writer's read-back refuses first), so the seam feeds it a reading that fails: the
  // edited text read as PI_BACKENDS=local. Nothing is written and the refusal is the wizard's own sentence.
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  writeFileSync(join(dir, ".env"), "A=1\n");
  const { ui, notes } = wizardUi({ select: ["Guided setup"], input: [dir], confirm: [] });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
    readBackFn: () => ({ keys: { PI_BACKENDS: "local" } }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0);
  assert.ok(notes.some((n) => /refusing to edit .*: after the edit systemd would not read PI_BACKENDS as podman\. Nothing was written/.test(n.m)), JSON.stringify(notes));
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "A=1\n");
});

test("#447 gate round 2: PI_BACKENDS is written only if the result reads PI_BACKENDS=podman (a file ending in an open quote)", async () => {
  // w02, measured: appending after `X="abc` puts the key inside X's value. The reader has no hazard to name in the
  // file as it stands (the value simply runs to the end), so only reading the RESULT back catches it.
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  const { ui, notes } = wizardUi({ select: ["Guided setup", "Skip", "Skip"], input: [dir], confirm: [true, false, false] });
  const { deps } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
    runAttachedFn: async () => {
      writeFileSync(join(dir, ".env"), 'A=1\nX="abc\n');
      return { code: 0 };
    },
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), 'A=1\nX="abc\n', "nothing written");
  // Refused by the writer's own plan, run dry just before the write (gate round 3), in the writer's words.
  assert.ok(notes.some((n) => /refusing to edit .*: after the edit, systemd's EnvironmentFile= would find no PI_BACKENDS\. Nothing was written\. PI_BACKENDS=podman was NOT written into .*, which is unchanged/.test(n.m)), JSON.stringify(notes));
  assert.ok(!notes.some((n) => /PI_BACKENDS=podman written into/.test(n.m)));
});

test("E4: a .env whose venue line sits inside a quoted value systemd continues is refused, not read", async () => {
  const dir = emptyDir();
  plantRuntime(dir, mod.RUNTIME_VERSION);
  writeFileSync(join(dir, ".env"), "NOTE='see\nPI_BACKENDS=podman\n'\n");
  const { ui, notes } = wizardUi({ select: ["Guided setup"], input: [dir], confirm: [] });
  const { deps, attached } = wizardDeps({
    env: { PI_DISPATCH_DEPLOYMENT_FILE: join(tempDir("admin-setup-ptr-"), "pointer.json"), PI_BACKENDS: "podman" },
    probePodmanFn: () => ({ ok: true }),
  });
  await mod.runSetupWizard({}, tuiCtx(ui), ui.notify, deps);
  assert.equal(attached.length, 0);
  assert.ok(notes.some((n) => n.t === "error" && /lies inside the quoted value that opens on line 1/.test(n.m)));
});

// PR #475's review: compose names a project after the directory of its first file, so the copy in <dir>/deploy/ ran as
// project "deploy" for every deployment, leaving the old project (and its volume) behind and colliding across folders.
// `-p` is the folder's own name, normalised as compose normalises a directory name (measured with compose 2.31:
// "My Deploy.v2_x" became project "mydeployv2_x"), which is what the old layout's copy ran as.
test("wizard: the compose project name is the one the old layout's copy ran as (the folder's name, as compose normalises it)", () => {
  for (const [dir, name] of [["/srv/pi-dispatch", "pi-dispatch"], ["/home/op/My Deploy.v2_x", "mydeployv2_x"], ["/srv/Prod_Queue", "prod_queue"], ["/srv/-lead", "lead"], ["/srv/..", "pi-dispatch"], ["/srv/ÜBER", "ber"]]) {
    assert.equal(mod.composeProjectName(dir), name, dir);
  }
  assert.notEqual(mod.composeProjectName("/srv/a/deploy-parent"), "deploy", "never the deploy/ directory's name");
});

// PR #475's review: `up` (earlier in the wizard) runs pi-dispatch-valkey, which the worker drains; compose's own valkey
// could not bind that port, or would be a second queue the receiver fills. The compose answer hands up's VOLUME to
// compose's valkey, so both use one Valkey and one queue; round 2: images first, every exit checked, VALKEY_URL's port.
function composeFolder({ envText = "" } = {}) {
  const dir = emptyDir();
  const rt = plantRuntime(dir, mod.RUNTIME_VERSION);
  mkdirSync(join(rt, "deploy"), { recursive: true });
  for (const f of ["docker-compose.yml", "egress-proxy.conf"]) writeFileSync(join(rt, "deploy", f), readFileSync(join(fileURLToPath(new URL("../../worker/deploy/", import.meta.url)), f)));
  if (envText) writeFileSync(join(dir, ".env"), envText);
  return dir;
}
/**
 * The docker the hand-over asks (PR #475's review, round 3): `up` is "ours" (pi-dispatch-valkey labelled with `dir`'s real
 * path), "legacy" (unlabelled, on `port`), "theirs" (another deployment's label), or absent; `volume` names what
 * `docker ps -a --filter volume=` lists, `records` any other container's inspect answer.
 */
function fakeDocker({ dir = null, up = null, port = 6379, volume = null, records = {}, asked = [], volumeLabel = "mine" } = {}) {
  const rec = (labels, p = port) => ({ code: 0, stdout: JSON.stringify([{ Name: "/pi-dispatch-valkey", Config: { Labels: labels }, HostConfig: { PortBindings: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: String(p) }] } } }]), stderr: "" });
  return (cmd, args) => {
    asked.push([cmd, ...args].join(" "));
    if (args[0] === "volume") {
      // pi-dispatch-valkey-data's label (the volume gap): "mine" (this folder's, as up creates it), null (unlabelled), a
      // folder, or "absent".
      if (volumeLabel === "absent") return { code: 1, stdout: "", stderr: "Error: no such volume\n" };
      const label = volumeLabel === "mine" ? (dir ? realpathSync(dir) : null) : volumeLabel;
      return { code: 0, stdout: JSON.stringify([{ Name: "pi-dispatch-valkey-data", CreatedAt: "2026-09-01T10:00:00Z", Labels: label ? { "com.pi-dispatch.deployment": label } : {} }]), stderr: "" };
    }
    if (args[0] === "ps") return { code: 0, stdout: (volume ?? (up ? ["pi-dispatch-valkey"] : [])).map((n) => `${n}\n`).join(""), stderr: "" };
    const name = args.at(-1);
    if (name === "pi-dispatch-valkey" && up === "ours") return rec({ "com.pi-dispatch.deployment": realpathSync(dir) });
    if (name === "pi-dispatch-valkey" && up === "legacy") return rec({});
    if (name === "pi-dispatch-valkey" && up === "theirs") return rec({ "com.pi-dispatch.deployment": "/srv/other" }, 16496);
    if (records[name]) return records[name];
    return { code: 1, stdout: "", stderr: `Error: No such container: ${name}\n` };
  };
}
const recorder = (over = {}, codeOf = () => 0) => {
  const rec = wizardDeps({ ...over, runAttachedFn: async (_ctx, opts) => (rec.attached.push(opts), { code: codeOf(opts) }) });
  return rec;
};

test("wizard: the compose answer hands up's Valkey over to compose's (one volume, one queue): pull first, then stop, rm, compose", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = composeFolder();
  const project = mod.composeProjectName(dir);
  const override = join(dir, "deploy", "docker-compose.valkey.yml");
  const base = ["compose", "-p", project, "--env-file", ".env", "-f", "deploy/docker-compose.yml", "-f", "deploy/docker-compose.valkey.yml", "--profile", "receiver"];
  const first = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [true]));
  const rec = recorder({ dockerQueryFn: fakeDocker({ dir, up: "ours" }) });
  await mod.runSetupWizard({}, tuiCtx(first.ui, repo), first.ui.notify, rec.deps);
  const confirm = first.seen.confirm.at(-1).message;
  assert.ok(confirm.includes(mod.VALKEY_HANDOVER_OVERRIDE.split("\n")[5]), "the confirm shows the override's contents");
  assert.match(confirm, /docker stop pi-dispatch-valkey {3}\(a job running right now is interrupted\)\n {2}docker rm pi-dispatch-valkey/);
  const pullBase = ["compose", "-p", project, "--env-file", ".env", "-f", "deploy/docker-compose.yml", "--profile", "receiver"];
  assert.deepEqual(rec.attached.map((a) => [a.argv0, ...a.args]), [["docker", ...pullBase, "pull"], ["docker", "stop", "pi-dispatch-valkey"], ["docker", "rm", "pi-dispatch-valkey"], ["docker", ...base, "up", "-d"]], "the images while up's Valkey still serves (without the override, not yet written: compose refuses a missing -f, measured), then stop (its AOF written), rm, compose on the same volume");
  assert.equal(rec.attached[0].env.PI_VALKEY_PORT, "6379", "compose's valkey on VALKEY_URL's port");
  assert.equal(readFileSync(override, "utf8"), mod.VALKEY_HANDOVER_OVERRIDE);
  assert.match(mod.VALKEY_HANDOVER_OVERRIDE, /^ {2}valkey:\n {4}volumes:\n {6}- pi-dispatch-valkey-data:\/data$/m);
  assert.match(mod.VALKEY_HANDOVER_OVERRIDE, /^ {2}pi-dispatch-valkey-data:\n {4}external: true$/m);
  // A later pass with no up container: the override stays in the command, nothing stopped, never rewritten.
  writeFileSync(override, "# the operator's own edit\n");
  const again = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [true]));
  const rec2 = recorder({ dockerQueryFn: fakeDocker({ dir }) });
  await mod.runSetupWizard({}, tuiCtx(again.ui, repo), again.ui.notify, rec2.deps);
  assert.deepEqual(rec2.attached.map((a) => [a.argv0, ...a.args]), [["docker", ...base, "up", "-d"]]);
  // Round 2: up's container back beside an existing override (up re-created it, measured) is handed over again, the
  // override left as it is: whether up's Valkey runs decides it, never the override's presence.
  const third = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [true]));
  const rec3 = recorder({ dockerQueryFn: fakeDocker({ dir, up: "ours" }) });
  await mod.runSetupWizard({}, tuiCtx(third.ui, repo), third.ui.notify, rec3.deps);
  assert.deepEqual(rec3.attached.map((a) => a.args.at(-1)), ["pull", "pi-dispatch-valkey", "pi-dispatch-valkey", "-d"]);
  assert.equal(readFileSync(override, "utf8"), "# the operator's own edit\n", "an existing override is never rewritten");
});

test("wizard: a hand-over publishes on VALKEY_URL's port, and a failed step says what runs and the way back (#475 round 2)", async () => {
  const repo = tempDir("admin-setup-repo-");
  // VALKEY_URL on 16495: compose's valkey is published there too, so the queue never moves off the worker's port.
  const dir = composeFolder({ envText: "VALKEY_URL=redis://127.0.0.1:16495\n" });
  const ui = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [true]));
  const rec = recorder({ dockerQueryFn: fakeDocker({ dir, up: "ours" }) });
  await mod.runSetupWizard({}, tuiCtx(ui.ui, repo), ui.ui.notify, rec.deps);
  assert.ok(rec.attached.every((a) => a.args[0] !== "compose" || a.env.PI_VALKEY_PORT === "16495"), "every compose step on 16495");
  assert.match(ui.seen.confirm.at(-1).message, /PI_VALKEY_PORT=16495 docker compose -p /);
  // The pull fails: up's Valkey untouched, nothing written.
  const d2 = composeFolder();
  const u2 = wizardUi(edgeAnswers(d2, EDGE_COMPOSE, [true]));
  const r2 = recorder({ dockerQueryFn: fakeDocker({ dir: d2, up: "ours" }) }, (o) => (o.args.at(-1) === "pull" ? 1 : 0));
  await mod.runSetupWizard({}, tuiCtx(u2.ui, repo), u2.ui.notify, r2.deps);
  assert.deepEqual(r2.attached.map((a) => a.args.at(-1)), ["pull"]);
  assert.ok(!existsSync(join(d2, "deploy", "docker-compose.valkey.yml")));
  assert.ok(u2.notes.some((n) => n.t === "error" && /pull failed; up's Valkey was left running and nothing else was done/.test(n.m)));
  // Compose fails after the removal: the override is put back as it was found, and the way back is named.
  const d3 = composeFolder();
  const u3 = wizardUi(edgeAnswers(d3, EDGE_COMPOSE, [true]));
  const r3 = recorder({ dockerQueryFn: fakeDocker({ dir: d3, up: "ours" }) }, (o) => (o.args.at(-1) === "-d" ? 1 : 0));
  await mod.runSetupWizard({}, tuiCtx(u3.ui, repo), u3.ui.notify, r3.deps);
  assert.ok(!existsSync(join(d3, "deploy", "docker-compose.valkey.yml")), "removed again, so `up` starts pi-dispatch-valkey, not compose's");
  assert.ok(u3.notes.some((n) => n.t === "error" && /failed after up's Valkey was removed: NO Valkey runs now\. Its volume, pi-dispatch-valkey-data, and the queue in it are kept: `node .* up` \(in .*\) starts pi-dispatch-valkey on it again\./.test(n.m)));
  // A failed stop starts nothing more and puts the override back.
  const d4 = composeFolder();
  const u4 = wizardUi(edgeAnswers(d4, EDGE_COMPOSE, [true]));
  const r4 = recorder({ dockerQueryFn: fakeDocker({ dir: d4, up: "ours" }) }, (o) => (o.args[0] === "stop" ? 1 : 0));
  await mod.runSetupWizard({}, tuiCtx(u4.ui, repo), u4.ui.notify, r4.deps);
  assert.deepEqual(r4.attached.map((a) => a.args.at(-1) === "pull" ? "pull" : a.args[0]), ["pull", "stop"]);
  assert.ok(!existsSync(join(d4, "deploy", "docker-compose.valkey.yml")));
  // Declined: nothing runs, and the hint carries the whole of it, the override's contents included.
  const d5 = composeFolder();
  const u5 = wizardUi(edgeAnswers(d5, EDGE_COMPOSE, [false]));
  const r5 = recorder({ dockerQueryFn: fakeDocker({ dir: d5, up: "ours" }) });
  await mod.runSetupWizard({}, tuiCtx(u5.ui, repo), u5.ui.notify, r5.deps);
  assert.equal(r5.attached.length, 0);
  assert.ok(u5.notes.some((n) => n.m.startsWith("later: ") && n.m.includes(mod.VALKEY_HANDOVER_OVERRIDE) && /docker stop pi-dispatch-valkey && docker rm pi-dispatch-valkey; then /.test(n.m)));
});

// PR #475's review, round 3 (measured on Fedora: the hand-over, re-run in a folder whose override was on disk while
// pi-dispatch-valkey was ANOTHER deployment's, stopped and removed that Valkey and cut its worker off). The hand-over acts
// only on a pi-dispatch-valkey that is provably this deployment's, and never starts compose's valkey on the volume while
// a container that is not this deployment's mounts it.
test("wizard: the hand-over never stops, removes or mounts beside another deployment's Valkey (#475 round 3)", async () => {
  const repo = tempDir("admin-setup-repo-");
  const override = (d) => join(d, "deploy", "docker-compose.valkey.yml");
  // The Fedora case: the override from an earlier hand-over, pi-dispatch-valkey another deployment's on the volume.
  const d1 = composeFolder();
  mkdirSync(join(d1, "deploy"), { recursive: true });
  writeFileSync(override(d1), mod.VALKEY_HANDOVER_OVERRIDE);
  const u1 = wizardUi(edgeAnswers(d1, EDGE_COMPOSE, [true]));
  const r1 = recorder({ dockerQueryFn: fakeDocker({ dir: d1, up: "theirs" }) });
  await mod.runSetupWizard({}, tuiCtx(u1.ui, repo), u1.ui.notify, r1.deps);
  assert.equal(r1.attached.length, 0, "nothing pulled, stopped, removed or started");
  assert.ok(u1.notes.some((n) => n.t === "error" && /^the receiver container was not started: pi-dispatch-valkey-data is mounted by pi-dispatch-valkey \(the deployment in \/srv\/other\), which is not this deployment's Valkey: a second Valkey on the same AOF would corrupt both queues/.test(n.m)), JSON.stringify(u1.notes));
  // Without the override, compose's valkey keeps its own volume: the receiver starts, the other Valkey is named and left.
  const d2 = composeFolder();
  const u2 = wizardUi(edgeAnswers(d2, EDGE_COMPOSE, [true]));
  const r2 = recorder({ dockerQueryFn: fakeDocker({ dir: d2, up: "theirs" }) });
  await mod.runSetupWizard({}, tuiCtx(u2.ui, repo), u2.ui.notify, r2.deps);
  assert.deepEqual(r2.attached.map((a) => a.args.at(-1)), ["-d"], "compose up only: no pull-for-hand-over, no stop, no rm");
  assert.ok(!r2.attached.some((a) => a.args.includes("deploy/docker-compose.valkey.yml")));
  assert.ok(!existsSync(override(d2)), "no override written");
  assert.ok(u2.notes.some((n) => n.t === "warning" && /pi-dispatch-valkey is not this deployment's Valkey \(the deployment in \/srv\/other\), so it is never stopped, removed or reused from here; it is left running/.test(n.m)));
  // Legacy, unlabelled: ours only on this deployment's VALKEY_URL port.
  for (const [port, handed] of [[6379, true], [16496, false]]) {
    const d = composeFolder();
    const u = wizardUi(edgeAnswers(d, EDGE_COMPOSE, [true]));
    const r = recorder({ dockerQueryFn: fakeDocker({ dir: d, up: "legacy", port }) });
    await mod.runSetupWizard({}, tuiCtx(u.ui, repo), u.ui.notify, r.deps);
    assert.equal(r.attached.some((a) => a.args[0] === "stop"), handed, `legacy on ${port}`);
  }
  // Ours, but another deployment's container also mounts the volume: refused before anything runs.
  const d3 = composeFolder();
  const u3 = wizardUi(edgeAnswers(d3, EDGE_COMPOSE, [true]));
  const other = { code: 0, stdout: JSON.stringify([{ Name: "/b-valkey-1", Config: { Labels: { "com.docker.compose.project.working_dir": "/srv/b/deploy" } } }]), stderr: "" };
  const r3 = recorder({ dockerQueryFn: fakeDocker({ dir: d3, up: "ours", volume: ["pi-dispatch-valkey", "b-valkey-1"], records: { "b-valkey-1": other } }) });
  await mod.runSetupWizard({}, tuiCtx(u3.ui, repo), u3.ui.notify, r3.deps);
  assert.equal(r3.attached.length, 0);
  assert.ok(u3.notes.some((n) => n.t === "error" && /mounted by b-valkey-1 \(the compose project in \/srv\/b\/deploy\)/.test(n.m)));
  // docker not answering is a refusal, never a guess.
  const d4 = composeFolder();
  const u4 = wizardUi(edgeAnswers(d4, EDGE_COMPOSE, [true]));
  const r4 = recorder({ dockerQueryFn: () => ({ code: null, stdout: "", stderr: "" }) });
  await mod.runSetupWizard({}, tuiCtx(u4.ui, repo), u4.ui.notify, r4.deps);
  assert.equal(r4.attached.length, 0);
  assert.ok(u4.notes.some((n) => n.t === "error" && /whether pi-dispatch-valkey is this deployment's could not be read/.test(n.m)));
});

// PR #475's review, round 3: the docs' plain compose command in the folder must publish where the worker dials.
test("wizard: the compose answer writes PI_VALKEY_PORT into .env when VALKEY_URL's port is not 6379, never over a different value (#475 round 3)", async () => {
  const repo = tempDir("admin-setup-repo-");
  const d1 = composeFolder({ envText: "VALKEY_URL=redis://127.0.0.1:16495\n" });
  const u1 = wizardUi(edgeAnswers(d1, EDGE_COMPOSE, [true]));
  await mod.runSetupWizard({}, tuiCtx(u1.ui, repo), u1.ui.notify, recorder().deps);
  assert.match(readFileSync(join(d1, ".env"), "utf8"), /^PI_VALKEY_PORT=16495$/m);
  const d2 = composeFolder({ envText: "VALKEY_URL=redis://127.0.0.1:16495\nPI_VALKEY_PORT=16000\n" });
  const u2 = wizardUi(edgeAnswers(d2, EDGE_COMPOSE, [true]));
  await mod.runSetupWizard({}, tuiCtx(u2.ui, repo), u2.ui.notify, recorder().deps);
  assert.equal(readFileSync(join(d2, ".env"), "utf8"), "VALKEY_URL=redis://127.0.0.1:16495\nPI_VALKEY_PORT=16000\n", "never overwritten");
  assert.ok(u2.notes.some((n) => n.t === "warning" && /PI_VALKEY_PORT is 16000 in .*\.env, and VALKEY_URL's port is 16495/.test(n.m)));
  const d3 = composeFolder({ envText: "VALKEY_URL=redis://127.0.0.1:6379\n" });
  const u3 = wizardUi(edgeAnswers(d3, EDGE_COMPOSE, [true]));
  await mod.runSetupWizard({}, tuiCtx(u3.ui, repo), u3.ui.notify, recorder().deps);
  assert.doesNotMatch(readFileSync(join(d3, ".env"), "utf8"), /PI_VALKEY_PORT/);
});

// PR #475's review, the volume gap: the hand-over's volume keeps the rule `up` has. Another folder's label refuses; an
// unlabelled volume no container of this deployment serves is adopted only after its own question; every compose start
// on it checks the queue's pi-dispatch:owner marker, and another folder's stops compose's valkey again.
test("wizard: pi-dispatch-valkey-data is used only when it is this folder's, an unlabelled one only once `up` adopted and recorded it, and the owner marker is checked (#475 volume gap, round-cap re-review)", async () => {
  const repo = tempDir("admin-setup-repo-");
  const withOverride = () => {
    const d = composeFolder();
    mkdirSync(join(d, "deploy"), { recursive: true });
    writeFileSync(join(d, "deploy", "docker-compose.valkey.yml"), mod.VALKEY_HANDOVER_OVERRIDE);
    return d;
  };
  // Another folder's label: refused, nothing run.
  const d1 = withOverride();
  const u1 = wizardUi(edgeAnswers(d1, EDGE_COMPOSE, [true]));
  const r1 = recorder({ dockerQueryFn: fakeDocker({ dir: d1, volumeLabel: "/srv/a" }) });
  await mod.runSetupWizard({}, tuiCtx(u1.ui, repo), u1.ui.notify, r1.deps);
  assert.equal(r1.attached.length, 0);
  assert.ok(u1.notes.some((n) => n.t === "error" && /pi-dispatch-valkey-data belongs to the deployment in \/srv\/a \(its label\), so this deployment never uses it/.test(n.m)));
  // Unlabelled, and this folder has no record of adopting it: the wizard does not adopt (round-cap re-review); it names
  // `up`, which asks, reads the marker with an unpublished Valkey first, and records the answer. Nothing run.
  const d2 = withOverride();
  const u2 = wizardUi(edgeAnswers(d2, EDGE_COMPOSE, [true]));
  const r2 = recorder({ dockerQueryFn: fakeDocker({ dir: d2, volumeLabel: null }) });
  await mod.runSetupWizard({}, tuiCtx(u2.ui, repo), u2.ui.notify, r2.deps);
  assert.equal(r2.attached.length, 0);
  assert.ok(!u2.seen.confirm.some((c) => /Adopt/.test(c.title ?? "")), "no adoption question here");
  assert.ok(u2.notes.some((n) => n.t === "error" && /this volume holds a queue pi-dispatch cannot attribute to a folder\)\. Run `node .* up` in .*: it asks whether to adopt it, checks whose queue it holds before starting anything on it, and records the answer/.test(n.m)), JSON.stringify(u2.notes));
  // `up` adopted it and recorded its CreatedAt: the step uses it, and a marker naming another folder still stops it.
  const d3 = withOverride();
  writeFileSync(join(d3, ".pi-dispatch-valkey-volume.json"), '{"name":"pi-dispatch-valkey-data","createdAt":"2026-09-01T10:00:00Z"}\n');
  const u3 = wizardUi(edgeAnswers(d3, EDGE_COMPOSE, [true]));
  const r3 = recorder({ dockerQueryFn: fakeDocker({ dir: d3, volumeLabel: null }), claimOwnerFn: async () => ({ owner: "/srv/a", claimed: false }) });
  await mod.runSetupWizard({}, tuiCtx(u3.ui, repo), u3.ui.notify, r3.deps);
  assert.deepEqual(r3.attached.map((a) => a.args.slice(-2).join(" ")), ["up -d", "stop valkey"]);
  assert.ok(u3.notes.some((n) => n.t === "error" && /the queue on pi-dispatch-valkey-data is the deployment's in \/srv\/a \(pi-dispatch:owner inside it\), not this one's: compose's valkey was stopped again at once/.test(n.m)));
  // This folder's label: no question, the marker recorded after the start.
  const d4 = withOverride();
  const u4 = wizardUi(edgeAnswers(d4, EDGE_COMPOSE, [true]));
  const claims = [];
  const r4 = recorder({ dockerQueryFn: fakeDocker({ dir: d4 }), claimOwnerFn: async (url, folder) => (claims.push([url, folder]), { owner: folder, claimed: true }) });
  await mod.runSetupWizard({}, tuiCtx(u4.ui, repo), u4.ui.notify, r4.deps);
  assert.deepEqual(r4.attached.map((a) => a.args.at(-1)), ["-d"]);
  assert.deepEqual(claims, [["redis://127.0.0.1:6379", realpathSync(d4)]]);
  assert.ok(u4.notes.some((n) => /recorded pi-dispatch:owner=/.test(n.m)));
  // The hand-over of this deployment's own pi-dispatch-valkey serving an unlabelled (pre-label) volume: no question.
  const d5 = composeFolder();
  const u5 = wizardUi(edgeAnswers(d5, EDGE_COMPOSE, [true]));
  const r5 = recorder({ dockerQueryFn: fakeDocker({ dir: d5, up: "ours", volumeLabel: null }) });
  await mod.runSetupWizard({}, tuiCtx(u5.ui, repo), u5.ui.notify, r5.deps);
  assert.deepEqual(r5.attached.map((a) => a.args.at(-1)), ["pull", "pi-dispatch-valkey", "pi-dispatch-valkey", "-d"]);
  assert.ok(!u5.seen.confirm.some((c) => /cannot attribute to a folder/.test(c.message)), "no adoption question");
  // ...and that volume, attributed by up's own container, is recorded here, 0600, so a later `up` needs no question.
  assert.equal(readFileSync(join(d5, ".pi-dispatch-valkey-volume.json"), "utf8"), '{"name":"pi-dispatch-valkey-data","createdAt":"2026-09-01T10:00:00Z"}\n');
  assert.equal(realFs.statSync(join(d5, ".pi-dispatch-valkey-volume.json")).mode & 0o777, 0o600);
});

// PR #475's round-cap re-review (measured: compose prefers the environment over `--env-file .env`, so a VALKEY_PASSWORD
// exported in pi's shell became the Valkey's password): compose's steps get no VALKEY_PASSWORD from the environment.
test("wizard: compose's steps are never handed the environment's VALKEY_PASSWORD, only PI_VALKEY_PORT (#475 round-cap re-review)", async () => {
  const repo = tempDir("admin-setup-repo-");
  const dir = composeFolder();
  const ui = wizardUi(edgeAnswers(dir, EDGE_COMPOSE, [true]));
  const rec = recorder({ dockerQueryFn: fakeDocker({ dir, up: "ours" }), env: { ...wizardDeps().deps.env, VALKEY_PASSWORD: "shell0exported0password0" } });
  await mod.runSetupWizard({}, tuiCtx(ui.ui, repo), ui.ui.notify, rec.deps);
  const compose = rec.attached.filter((a) => a.args[0] === "compose");
  assert.ok(compose.length >= 2, "the pull and the up");
  for (const a of compose) {
    assert.equal(a.env.VALKEY_PASSWORD, undefined, `${a.args.at(-1)}: compose reads the deployment's from --env-file .env`);
    assert.equal(a.env.PI_VALKEY_PORT, "6379");
  }
});
