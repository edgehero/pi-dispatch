import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
    runtime: "docker",
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
    // Issue #452 gate round 2: the keeper holds, never read from a real Podman in a unit test.
    keeperCheck: async () => null,
    // Issue #452 gate round 3: the teardown's detach gate held open; the gate has its own tests in the worker.
    detachGate: async () => null,
    // Issue #446: the past-window refusal reads this clock, an hour into every fixture's 24h window.
    now: () => NOW,
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
  assert.match(written.join(""), /the sandbox exited 125\. If no shell opened, the runtime refused/);
  assert.match(written.join(""), /DOCKER_HOST in this shell may not be the daemon/, "and 125 names all three of ITS causes, the daemon included");
  assert.equal(pauses, 1, "the operator reads it before the panel comes back");

  // THREE CODES, and the wording is what makes that safe. The sandbox runs `--entrypoint bash -i`, so
  // 125, 126 and 127 each belong to both sides: the runtime's own refusal, and bash's last command. An
  // earlier version asserted the sandbox "never opened" and was false for `exit 1`; the next narrowed to
  // 125 and made a genuine `exec bash failed` (127) silent again. Offering the runtime reading
  // conditionally is true either way.
  // Each code gets ITS OWN cause. A shared list was written first and was wrong for two of the three: a
  // name clash cannot produce a 127, and the cause the widening was FOR -- `exec bash failed: No such
  // file or directory` -- was not in it at all.
  for (const [code, cause, wrong] of [
    [126, /entrypoint is not executable/, /--pull=never/],
    [127, /no entrypoint at that path/, /name may be taken/],
  ]) {
    let p2 = 0;
    const runtime = panelIo({ launch: async () => ({ code }), pause: async () => void p2++ });
    await mod.openSandboxSession(RETAINED, "gh-1", runtime.io);
    const text = runtime.written.join("");
    assert.match(text, new RegExp(`the sandbox exited ${code}\\. If no shell opened`), `exit ${code} is also a runtime refusal code`);
    assert.match(text, cause, `exit ${code} names what THAT code means`);
    assert.doesNotMatch(text, wrong, `exit ${code} must not offer a cause that cannot produce it`);
    assert.match(text, /If no shell opened/, "the runtime reading is OFFERED, never asserted: no exit code separates it from the shell's own status");
    assert.equal(p2, 1);
  }

  // Everything else is the shell's own status and says nothing, because nothing can be said about it.
  for (const code of [1, 2, 130]) {
    let p3 = 0;
    const shell = panelIo({ launch: async () => ({ code }), pause: async () => void p3++ });
    await mod.openSandboxSession(RETAINED, "gh-1", shell.io);
    assert.doesNotMatch(shell.written.join(""), /the sandbox exited/, `exit ${code} is the shell's own status`);
    assert.equal(p3, 0, `exit ${code} must not stop the panel`);
  }
});

test("the panel does not offer `b`, or describe a session, for a run it cannot actually open (#337)", async () => {
  // `readSandboxInfo` stopped at the venue refusal, so a run whose manifest names no image, or whose
  // local folder moved, was advertised with the key AND given two lines of egress detail about the
  // session it would get -- and then refused the moment `b` was pressed. Nobody reads two lines of
  // detail about a door they are also being told is shut. These are the other two SYNCHRONOUS refusals
  // `resolveSandbox` makes; the third (a proxy that is not running) needs docker and stays `OQ-038`'s.
  const noImage = { sandboxDir: retainedRoot({ backend: "local", image: null }), sandboxRetentionHours: 24 };
  const a = mod.readSandboxInfo(noImage, "gh-1", { now: () => NOW, env: {} });
  assert.equal(a.retained, false, "no image, no offer");
  assert.match(a.reason, /names no image/);
  assert.equal(a.egress, undefined, "and no posture for a session that cannot exist");

  const gone = { sandboxDir: retainedRoot({ backend: "local", workspace: "/definitely/not/here" }), sandboxRetentionHours: 24 };
  const b = mod.readSandboxInfo(gone, "gh-1", { now: () => NOW, env: {} });
  assert.equal(b.retained, false, "no workspace, no offer");
  assert.match(b.reason, /moved or been deleted/);
  assert.equal(b.egress, undefined);
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

test("the sandbox session's own terminal writes are scrubbed, manifest image included (#382)", async () => {
	// These five lines run with the TUI SUSPENDED, so they reach the raw terminal with nothing between them
	// and it -- and one interpolates `manifest.image`, read back by a bare `JSON.parse` from a file the
	// WORKER stamps from the trigger's `run.image`, which the project's own writer accepts verbatim. Every
	// pane in the panel now holds that byte; this path never went through a pane at all.
	const paths = { sandboxDir: retainedRoot({ backend: "local", image: "pi-job\u001b]52;c;cm0=\u0007:latest" }), sandboxRetentionHours: 24, sandboxIdleMinutes: 30 };
	const io = panelIo();
	await mod.openSandboxSession(paths, "gh-1", io.io);
	const all = io.written.join("");
	assert.ok(all.length > 0, "the session wrote something");
	assert.doesNotMatch(all, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, "no control byte reaches the suspended terminal");
	// PER LINE and not by deleting them: the messages carry deliberate newlines, and turning those into
	// spaces would run five separate notices together.
	assert.ok(all.split("\n").length > 1, "and the writer's own line breaks survive the scrub");
});

// --- issue #429: a run on the native podman venue ---------------------------------------------------------------

test("the panel offers a podman run only where ITS OWN PI_BACKENDS blesses podman, and says which variable (#429)", () => {
  const paths = { sandboxDir: retainedRoot({ backend: "podman" }), sandboxRetentionHours: 24 };
  // OQ-038: the panel reads PI_BACKENDS from the environment pi was started in. Without it that is `local` alone.
  const unset = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW, env: {} });
  assert.equal(unset.retained, false);
  assert.equal(unset.reason, "not reopenable here (PI_BACKENDS lacks podman)");
  const blessed = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW, env: { PI_BACKENDS: "podman" } });
  assert.equal(blessed.retained, true);
  assert.equal(blessed.runtime, "podman", "so the pane can say where an egress-off shell lands");
  const typo = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW, env: { PI_BACKENDS: "podmn" } });
  assert.equal(typo.retained, false);
  assert.match(typo.reason, /unreadable here/);
  // A far venue keeps its own words: no launcher, so no variable would help.
  assert.match(mod.readSandboxInfo({ sandboxDir: retainedRoot({ backend: "far" }), sandboxRetentionHours: 24 }, "gh-1", { now: () => NOW, env: { PI_BACKENDS: "podman" } }).reason, /ran on far/);
});

test("a podman run pressed from a panel WITHOUT podman blessed is refused, and nothing is spawned under docker (#429)", async () => {
  const paths = { sandboxDir: retainedRoot({ backend: "podman" }), sandboxRetentionHours: 24, sandboxIdleMinutes: 30 };
  const bins = [];
  const { io, written, docker, launched } = panelIo({ launch: async (o) => (bins.push(o.bin), { code: 0 }) });
  await mod.openSandboxSession(paths, "gh-1", io);
  assert.match(written.join(""), /cannot open a sandbox for gh-1: .*"podman" backend, which PI_BACKENDS in this process's environment does not bless/);
  assert.deepEqual([launched, bins, docker], [[], [], []], "no launch, no network, under any runtime");

  const typo = panelIo({ env: { PI_BACKENDS: "podmn" } });
  await mod.openSandboxSession(paths, "gh-1", typo.io);
  assert.match(typo.written.join(""), /unknown backend "podmn"/);
  assert.deepEqual(typo.launched, []);
});

test("a podman run opened from a panel that blesses podman runs through podman alone (#429)", async () => {
  const paths = { sandboxDir: retainedRoot({ backend: "podman" }), sandboxRetentionHours: 24, sandboxIdleMinutes: 30 };
  const spawned = [];
  const bins = [];
  const judged = [];
  const { io, launched, written } = panelIo({
    env: { PI_BACKENDS: "local,podman", PI_BACKEND_FLOOR: "isolation=enforced" },
    running: async (o) => (bins.push(`running:${o?.bin}`), []),
    launch: async (o) => (bins.push(`launch:${o.bin}`), launched.push(o.args), { code: null, error: new Error("spawn podman ENOENT") }),
    resolveJobUser: async (o) => (judged.push(o), { user: "1234:1234", home: "/home/pi" }),
    spawnNetwork: (cmd, args) => {
      spawned.push(`${cmd} ${args.join(" ")}`);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  await mod.openSandboxSession(paths, "gh-1", io);
  assert.deepEqual(bins, ["running:podman", "launch:podman"]);
  assert.ok(spawned.length > 0 && spawned.every((c) => c.startsWith("podman ")), spawned.join(" | "));
  assert.ok(launched[0].includes("--userns=keep-id") && launched[0].includes("--user=1234:1234"));
  assert.equal(judged[0].venue, "podman");
  assert.deepEqual(judged[0].backendFloor, { isolation: "enforced" }, "the panel's own floor reaches the podman judge");
  assert.match(written.join(""), /could not start podman: spawn podman ENOENT/);
});

test("a pre-attribution run in a panel without local names PI_BACKENDS, not a missing record (#429 review)", () => {
  const info = mod.readSandboxInfo({ sandboxDir: retainedRoot({}), sandboxRetentionHours: 24 }, "gh-1", { now: () => NOW, env: { PI_BACKENDS: "podman" } });
  assert.equal(info.retained, false);
  assert.equal(info.reason, "not reopenable here (PI_BACKENDS lacks local)");
});

// --- issue #446: the panel has no pin, so it neither offers nor opens a run past its window ---------------------

test("a run past the deadline its manifest records is not offered, and the key press is refused with the CLI's --pin (#446)", async () => {
  // The worker retained it with a 6h window and wrote that down; this panel's own 24h must not admit it.
  const paths = { sandboxDir: retainedRoot({ backend: "local", retainUntil: "2026-09-14T14:00:00.000Z" }), sandboxRetentionHours: 24, sandboxIdleMinutes: 30 };
  const open = mod.readSandboxInfo(paths, "gh-1", { now: () => NOW, env: {} });
  assert.equal(open.retained, true, "five hours left: offered");
  assert.equal(open.expiresIn, "5h", "counted down to the worker's deadline, not createdAt plus this panel's window");

  const late = Date.parse("2026-09-14T13:56:00.000Z");
  const info = mod.readSandboxInfo(paths, "gh-1", { now: () => late, env: {} });
  assert.deepEqual(info, { retained: false, reason: "past its window: open it with the CLI's --pin" }, "inside the grace: not offered");
  assert.ok(info.reason.length <= 53, "and it fits the pane");

  const { io, written, launched, docker } = panelIo({ now: () => late });
  await mod.openSandboxSession(paths, "gh-1", io);
  assert.match(written.join(""), /cannot open a sandbox for gh-1: .*`pi-dispatch sandbox gh-1 --pin`/);
  assert.deepEqual([launched, docker], [[], []], "nothing launched, no network");
});

test("a directory holding ANOTHER run's manifest is not offered for this id (#446)", () => {
  // The fixture's directory is `gh-1`, whose manifest says another id: two ids sharing one safe form.
  const paths = { sandboxDir: retainedRoot({ backend: "local", jobId: "gh:1" }), sandboxRetentionHours: 24 };
  assert.deepEqual(mod.readSandboxInfo(paths, "gh-1", { now: () => NOW, env: {} }), { retained: false, reason: "not reopenable (another run holds its directory)" });
});

test("a run lost during the session is said after the shell, with a pause, and the shell is not refused (#446)", async () => {
  const sandboxDir = retainedRoot({ backend: "local", keepUntil: "2026-09-20T00:00:00.000Z" });
  let pauses = 0;
  const { io, written } = panelIo({
    env: { PI_EGRESS: "0" },
    pause: async () => void pauses++,
    launch: async () => (rmSync(join(sandboxDir, "gh-1"), { recursive: true, force: true }), { code: 0 }),
  });
  await mod.openSandboxSession({ sandboxDir, sandboxRetentionHours: 24, sandboxIdleMinutes: 30 }, "gh-1", io);
  const text = written.join("");
  assert.match(text, /note: the retained workspace for gh-1 was DELETED while this sandbox was open \(by the retention sweep, or by a retry of the run clearing it\)/);
  assert.doesNotMatch(text, /cannot open a sandbox/);
  assert.equal(pauses, 1, "read before the panel comes back");
});

test("the panel hands its keeper check to the open, and a refusal opens nothing (#452 gate round 2)", async () => {
  const paths = { sandboxDir: retainedRoot({ backend: "podman" }), sandboxRetentionHours: 24, sandboxIdleMinutes: 30 };
  const { io, launched, written } = panelIo({
    env: { PI_BACKENDS: "podman", PI_BACKEND_FLOOR: "isolation=enforced" },
    resolveJobUser: async () => ({ user: "1234:1234", home: "/home/pi" }),
    keeperCheck: async () => ({ refused: "netns-keeper-not-holding", message: "the seamed keeper check refused this open" }),
  });
  await mod.openSandboxSession(paths, "gh-1", io);
  assert.deepEqual(launched, []);
  assert.match(written.join(""), /the seamed keeper check refused this open/, "the panel's own seam, not a real Podman read");
});
