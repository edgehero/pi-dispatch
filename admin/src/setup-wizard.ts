/**
 * The `/dispatch setup` wizard (issue #92): a guided, step-by-step build of a pi-dispatch deployment,
 * driven entirely through pi's own dialogs and one attached-terminal overlay.
 *
 * Division of labor, deliberately: the WORKER's CLI (`up`, `service`, `setup github`) stays the one
 * place host mutations happen -- the wizard only sequences those commands, attached to the operator's
 * terminal, with a confirm in front of each spawn showing the exact command. The wizard's OWN writes
 * are four files, each tame: the deployment dir's private `package.json` (never clobbered), the
 * deployment pointer (via `writePointer`'s validating normalizer), one appended trigger entry (via the
 * validated, atomic `writeTriggers`), and -- only on the compose answer to the trigger-edge step -- a
 * `docker-compose.yml` COPIED create-only out of the installed runtime's own `deploy/`. Secrets are
 * never touched: the provider-key step is a notice naming the file, nothing more.
 *
 * Every step is declinable and a decline CONTINUES to the next step (converge-style, like `up` itself):
 * an operator who already ran half the quickstart by hand skips the steps that are done. Two exceptions,
 * both deliberate: the RUNTIME's post-install version assertion is a hard stop -- a wrong runtime
 * version poisons every later step, so that failure is loud and final (worker/src/import-pi.mjs:334-341
 * idiom) -- and the docker pre-check's "Stop" is an operator-chosen early exit taken before anything has
 * been downloaded. The receiver's own version assertion is NOT a stop: the receiver is optional, so a
 * bad receiver install skips its unit and the wizard carries on.
 */

import * as nodeFs from "node:fs";
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
// The single source of truth for skill-directory names -- the same regex the worker's flow gate applies
// at job time, so the wizard can never offer a flow the gate would refuse on shape.
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import {
  POINTER_ENV_ALLOWLIST,
  POINTER_VERSION,
  pointerPath,
  readPointer,
  reapplyDeploymentPointer,
  writePointer,
} from "./deployment-pointer.mjs";
import { readQueueState, resolvePaths, writeTriggers } from "./read-model.mjs";
// buildTriggerEntry is index.ts's on x run matrix -- the SAME builder the dialogs and the LLM tool use,
// so the wizard's first trigger has exactly their shape. The import is circular on paper (index.ts
// lazy-imports this module from its /dispatch handler and statically imports registerNudge below), but
// never at evaluation time: both sides only CALL across the boundary at runtime, after both modules
// have finished loading.
import { buildTriggerEntry } from "./index.ts";

type Notify = ((message: string, type?: string) => void) | undefined;

/**
 * The `@edgehero/pi-dispatch` version this wizard installs -- pinned, never `latest`, so a wizard run
 * is reproducible and the admin that drove it was reviewed against the runtime it produced. The
 * anti-drift test (setup-wizard.test.mjs) ties this literal to the in-repo `worker/package.json`
 * version, so a release bump stays atomic: bump the worker and the test fails here until this literal
 * follows in the same change.
 */
export const RUNTIME_VERSION = "1.10.0";

/**
 * The `@edgehero/pi-dispatch-receiver` version the trigger-edge step installs -- pinned for exactly the
 * reasons RUNTIME_VERSION is, and with the same anti-drift test (this literal against the in-repo
 * `receiver/package.json`), so a receiver release bump cannot land without this line following it in the
 * same change. Its own literal rather than a reuse of RUNTIME_VERSION: the two packages version
 * independently (the receiver's dependency range on the runtime is `^`), and pretending otherwise would
 * install a version that does not exist the first time they diverge.
 */
export const RECEIVER_VERSION = "1.5.0";

/** The two npm package names, spelled once. Literals of this module -- see npmInstallArgsFor's argument. */
const RUNTIME_PKG = "@edgehero/pi-dispatch";
const RECEIVER_PKG = "@edgehero/pi-dispatch-receiver";

/** The pointer marker file suffix and the four-file cwd scaffold signature, shared by detect + nudge. */
const NUDGE_MARKER_BASENAME = "pi-dispatch-setup.nudged";
const CWD_SCAFFOLD_FILES = [".env", "triggers.json", "pause-windows.json", "subscriptions.json"];

/**
 * The env keys whose PRESENCE means "the operator pointed the admin at a deployment": the pointer
 * allowlist minus VALKEY_URL. Derived, not restated, so a new resolvePaths path variable added to the
 * allowlist is picked up here on the same review. VALKEY_URL is deliberately excluded from the
 * presence check: an exported queue URL is a claim, and detection PROBES it (branch 4) rather than
 * trusting it -- a dead URL should yield the setup offer, not a broken panel, and the tests pin the
 * probe to a dead port through exactly this seam.
 */
const ENV_PATH_KEYS = POINTER_ENV_ALLOWLIST.filter((key) => key !== "VALKEY_URL");

/** Non-empty-string presence, matching resolvePaths' own `||` defaulting (an empty export falls back). */
function envIsSet(env: any, key: string): boolean {
  return typeof env[key] === "string" && env[key] !== "";
}

/**
 * Whether `cwd` carries `pi-dispatch init`'s scaffold signature: `.env` + `triggers.json` +
 * `pause-windows.json` + `subscriptions.json`, ALL present. Deliberately not `pi-packages.json`:
 * older deployments predate it (init grew it later), and requiring it would misread every one of them
 * as unconfigured.
 */
function hasCwdScaffold(cwd: string, fs: any): boolean {
  return CWD_SCAFFOLD_FILES.every((name) => fs.existsSync(join(cwd, name)));
}

/** The default queue probe: one self-closing readQueueState; reachable iff it did not come back `{ unreachable }`. */
async function defaultProbeQueue(url: string): Promise<boolean> {
  return !(await readQueueState({ url })).unreachable;
}

/**
 * Where is the deployment, if anywhere? Returns `{ state, detail }` with state one of:
 *   "pointer"   -- a VALID pointer file exists (the wizard ran, or the operator wrote one)
 *   "env"       -- one of the path env vars is exported (the operator wired the env)
 *   "cwd"       -- this directory carries init's scaffold signature (a launched-from-the-deployment session)
 *   "reachable" -- none of the above, but the queue answers at the (default or exported) VALKEY_URL
 *   "none"      -- nothing found: the setup offer's trigger state
 *
 * The order IS the trust order: an explicit pointer beats env beats cwd beats a bare network probe. A
 * stale/invalid pointer file falls through (readPointer's `{ ignored }`), degrading to the pre-pointer
 * detection exactly as `/dispatch` itself degrades -- the retained notice, not this function, tells the
 * operator the file is broken.
 *
 * NEVER consulted: `logsDir` / `settingsFile` absence. Both default lazily into OS temp locations
 * (see resolvePaths), so their absence proves nothing about a deployment and testing them would drag
 * OS-temp paths into a detection that is otherwise pure over the operator's own files.
 */
export async function detectDeployment({
  env = process.env,
  cwd = process.cwd(),
  fs = nodeFs,
  probeQueue = defaultProbeQueue,
}: any = {}): Promise<{ state: "pointer" | "env" | "cwd" | "reachable" | "none"; detail: string }> {
  const pointerRes: any = readPointer({ path: pointerPath(env), fs });
  if (pointerRes.pointer) {
    return { state: "pointer", detail: `deployment pointer -> ${pointerRes.pointer.deploymentDir}` };
  }
  const setKeys = ENV_PATH_KEYS.filter((key) => envIsSet(env, key));
  if (setKeys.length > 0) {
    return { state: "env", detail: `env points at a deployment (${setKeys.join(", ")})` };
  }
  if (typeof cwd === "string" && cwd !== "" && hasCwdScaffold(cwd, fs)) {
    return { state: "cwd", detail: `deployment files in ${cwd}` };
  }
  const valkeyUrl = env.VALKEY_URL || "redis://127.0.0.1:6379";
  if (await probeQueue(valkeyUrl)) {
    return { state: "reachable", detail: `queue reachable at ${valkeyUrl}` };
  }
  return { state: "none", detail: "no pointer, no env, no deployment files here, queue unreachable" };
}

/**
 * Run one command ATTACHED to the operator's terminal from inside a pi TUI session, and resolve its
 * `{ code, error }`. Three constraints shape this function, none negotiable:
 *
 *   1. The live `tui` handle exists ONLY inside a `ctx.ui.custom` factory -- there is no other
 *      sanctioned way to suspend pi's render loop and input handling (`stop()`/`start()` are pi's own
 *      $EDITOR pair; dashboard.ts:399-424 is the in-repo precedent). So the spawn runs inside a
 *      one-line overlay whose factory brackets it.
 *   2. Dialogs and an attached child are mutually exclusive: `ui.confirm`/`select` paint through the
 *      TUI this very function stops. Every question is asked BEFORE runAttached; the overlay itself
 *      renders one static line and asks nothing.
 *   3. `stdio: "inherit"` hands stdin to the child until it closes, so the component ignores input --
 *      while suspended there are no keys to receive, and competing for them would race the child
 *      (worker/src/sandbox.mjs:155-171, the never-reject spawn shape reused here).
 *
 * Unlike openSandboxSession (index.ts), the EXIT CODE is captured and returned, never discarded: the
 * install step's version assertion and the up step's continue/stop gate both decide on it. The
 * `finally` restores the TUI and forces the full redraw even when the spawn itself throws.
 */
export async function runAttached(
  ctx: any,
  { title, argv0, args, cwd, env, shell, spawnFn = nodeSpawn }: any,
): Promise<{ code: number | null; error?: Error }> {
  if (ctx?.mode !== "tui" || typeof ctx?.ui?.custom !== "function") {
    return { code: null, error: new Error("needs the terminal UI") };
  }
  const custom = ctx.ui.custom;
  const factory = (tui: any, _theme: any, _keybindings: any, done: (value: any) => void) => {
    void (async () => {
      let outcome: { code: number | null; error?: Error } = { code: null };
      tui?.stop?.();
      try {
        process.stdout.write(`\n${title}\n\n`);
        outcome = await new Promise((resolve) => {
          let child: any;
          try {
            child = spawnFn(argv0, args, { stdio: "inherit", cwd, env, ...(shell ? { shell: true } : {}) });
          } catch (err: any) {
            // A synchronously-throwing spawn (bad injected fake, exotic platform failure) must land in
            // the same never-reject shape -- the finally below is the whole suspend-safety guarantee.
            resolve({ code: null, error: err });
            return;
          }
          child.on("error", (err: any) => resolve({ code: null, error: err }));
          child.on("close", (code: number | null) => resolve({ code }));
        });
      } catch (err: any) {
        outcome = { code: null, error: err };
      } finally {
        tui?.start?.();
        tui?.requestRender?.(true);
        done(outcome);
      }
    })();
    return {
      render: () => [title],
      invalidate(): void {
        // Static content; the TUI redraws from render().
      },
      handleInput(): void {
        // Constraint 3: the child owns stdin for the duration; the overlay never acts on input.
      },
    };
  };
  const result = await custom.call(ctx.ui, factory, { overlay: true });
  return result ?? { code: null, error: new Error("the overlay closed before the command finished") };
}

/**
 * The exact npm argv for installing ONE pinned package. Pure, and NO filesystem path in argv: the
 * install target is the spawn's `cwd`, never a `--prefix <dir>` pair. That absence is what makes
 * `shell: true` safe on win32 (npmSpawnOptions below): argv holds only literal flags spelled out here
 * plus one `name@version` token -- and BOTH halves of that token are literals of this module at every
 * call site (RUNTIME_PKG/RUNTIME_VERSION, RECEIVER_PKG/RECEIVER_VERSION), so no operator-supplied
 * string can reach the command line as shell syntax (worker/src/import-pi.mjs:400-419 carries the full
 * argument; passing a caller-shaped name or re-introducing a path here breaks it and must be revisited
 * together with that comment). The parameters exist so the two packages share one reviewed argv, not so
 * arbitrary names can be installed.
 *
 * `--ignore-scripts` is load-bearing exactly as in import-pi: without it, lifecycle scripts of the
 * package and every transitive dependency run as the operator at install time. No `--omit=peer` /
 * `--install-strategy=nested` here, deliberately: this is a normal application install resolved by
 * node's own algorithm at run time, not a staged self-contained overlay.
 */
export function npmInstallArgsFor(pkgName: string, version: string): string[] {
  return [
    "install",
    `${pkgName}@${version}`,
    "--omit=dev",
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
  ];
}

/** The runtime's own install argv -- the pinned pair applied to the shared shape above. */
export function npmInstallArgs(): string[] {
  return npmInstallArgsFor(RUNTIME_PKG, RUNTIME_VERSION);
}

/** The receiver's install argv, same shape, its own pin (the trigger-edge step's service answer). */
export function receiverInstallArgs(): string[] {
  return npmInstallArgsFor(RECEIVER_PKG, RECEIVER_VERSION);
}

/** How many probes one wizard run will ever make -- the "Re-check" loop's bound (see ensureDocker). */
const DOCKER_PROBE_ROUNDS = 5;

/** Long enough for a cold Docker Desktop VM to answer, short enough that a wedged socket is not a freeze. */
const DOCKER_PROBE_TIMEOUT_MS = 10_000;

/**
 * Is docker usable RIGHT NOW? `docker version` is the cheapest question that reaches the daemon: the
 * client prints its own version without one, so a zero exit means the CLI exists AND something answered.
 * DELIBERATELY the same command `up` itself gates on (worker/src/up.mjs:88), so this step and the child
 * it precedes can never disagree about what "docker is ready" means.
 * Output is discarded (`stdio: "ignore"`) -- this is a yes/no, and the wizard must not paint docker's
 * banner over pi's TUI. `exec` is injectable exactly as read-model.mjs:145's revParseHead does it, so
 * every test drives this without a docker on the box.
 *
 * Three outcomes, because they have three different remedies:
 *   `{ ok: true }`            -- CLI present, daemon answering
 *   `{ missing: true }`       -- no `docker` binary on PATH at all (spawn ENOENT)
 *   `{ daemonDown: reason }`  -- the CLI ran and refused: installed, but the daemon/VM is not up
 * Never throws: an unusable docker is a state to report, not an exception to raise.
 *
 * The `timeout` is the one thing this does that revParseHead does not, and it is not decoration: this is
 * a SYNCHRONOUS exec on the path of a TUI dialog, so a docker CLI wedged on an unresponsive VM socket
 * would freeze pi's render loop for as long as it hung. A timeout kill lands in the daemonDown branch,
 * which is exactly the right verdict for it.
 */
export function probeDocker(
  execFn: any = execFileSync,
): { ok: true } | { missing: true } | { daemonDown: string } {
  try {
    execFn("docker", ["version"], { stdio: "ignore", timeout: DOCKER_PROBE_TIMEOUT_MS });
    return { ok: true };
  } catch (err: any) {
    // ENOENT is the spawn failing to find the binary -- which is also exactly what "not on PATH" looks
    // like, on every platform. A numeric `status` means the binary DID run and exited nonzero.
    if (err?.code === "ENOENT" || err?.errno === "ENOENT") return { missing: true };
    if (typeof err?.status === "number") return { daemonDown: `\`docker version\` exited ${err.status}` };
    return { daemonDown: err?.message ?? String(err) };
  }
}

/**
 * Per-OS pointer text for getting docker running. Vendor instructions ONLY, deliberately never a command
 * to run and NEVER a piped installer (a download-into-shell one-liner on the operator's own host,
 * printed by a wizard, is exactly the habit this project refuses to teach): the operator fetches and
 * verifies their own engine, the same division of labor as the provider-key step.
 */
export function dockerHint(platform: string): string {
  if (platform === "darwin") {
    return "macOS: install and START Docker Desktop (docs.docker.com/desktop/install/mac-install) or OrbStack (orbstack.dev) — either one provides the `docker` CLI and a running daemon.";
  }
  if (platform === "win32") {
    return "Windows: install and START Docker Desktop (docs.docker.com/desktop/install/windows-install) — it provides the `docker` CLI and a running daemon.";
  }
  return "Linux: install the docker engine from your distribution's own packages, following docs.docker.com/engine/install, then start and enable its daemon.";
}

/**
 * Step 3's body: docker is the one host prerequisite every later step leans on, so it is asked about
 * BEFORE anything is downloaded. `up` already refuses on its own when docker is missing (up.mjs:85-95,
 * the same `docker version` gate) -- this step adds no enforcement, it moves the SAME verdict earlier and
 * into the wizard's own voice, where it costs the operator no npm install and no child-process output to
 * read.
 *
 * Returns whether to continue. "Re-check" re-probes (bounded: at most DOCKER_PROBE_ROUNDS probes per
 * run, so a wizard driven by a stuck answer source cannot spin), "Continue anyway" continues, "Stop"
 * (and a cancelled dialog, and the exhausted bound) returns false having spawned nothing at all.
 */
async function ensureDocker(ui: any, notify: Notify, { platform, probeDockerFn }: any): Promise<boolean> {
  for (let round = 1; ; round++) {
    const probe = probeDockerFn();
    if (probe.ok) return true;
    const why = probe.missing
      ? "no `docker` on PATH"
      : `docker is installed but not answering (${probe.daemonDown})`;
    // The pointer text goes out FIRST, at warning: whatever the operator answers next, the remedy is
    // already on screen -- and a select's own title is too small a place for an install instruction.
    notify?.(`docker check: ${why}. ${dockerHint(platform)}`, "warning");
    if (round >= DOCKER_PROBE_ROUNDS) {
      notify?.(
        `docker still not ready after ${DOCKER_PROBE_ROUNDS} checks — stopping setup before anything was installed. Re-run /dispatch setup once \`docker version\` answers.`,
        "error",
      );
      return false;
    }
    const choice = await ui.select("Docker is not ready", ["Re-check", "Continue anyway", "Stop"]);
    if (choice === "Re-check") continue;
    if (choice === "Continue anyway") {
      // Deliberately permitted: `up` runs its own docker checks and refuses on its own, so this step is
      // a BETTER MESSAGE EARLIER, never the enforcement. An operator installing docker in the next
      // window over -- or driving a daemon this probe cannot see -- must not be locked out by our probe.
      notify?.("continuing without a docker answer — `up` runs its own docker checks and refuses there if it is still missing", "info");
      return true;
    }
    notify?.("setup stopped before anything was installed — re-run /dispatch setup when docker is ready", "info");
    return false;
  }
}

/**
 * The npm binary + spawn options for one platform. win32 needs BOTH `npm.cmd` and `shell: true`
 * (CVE-2024-27980: Node refuses to spawn a `.cmd` without a shell -- worker/src/import-pi.mjs:400-419),
 * and that is safe here ONLY because npmInstallArgsFor keeps every path out of argv; everywhere else it is
 * plain `npm` with the target dir as cwd.
 */
export function npmSpawnOptions(platform: string, dir: string): { bin: string; options: { cwd: string; shell?: true } } {
  return platform === "win32" ? { bin: "npm.cmd", options: { cwd: dir, shell: true } } : { bin: "npm", options: { cwd: dir } };
}

/**
 * The repo's offerable flows: every `.pi/skills/<name>` directory whose name the worker's own
 * SKILL_NAME_RE accepts AND that actually contains a SKILL.md. Both filters matter: a name the gate
 * would refuse must not be offered, and a skill-less directory would enqueue a job with no
 * instructions. `[]` on ANY error (no `.pi/skills`, unreadable, not a repo) -- an empty list simply
 * downgrades the picker to a free-text input.
 */
export function listRepoSkills(cwd: string, fs: any = nodeFs): string[] {
  try {
    const root = join(cwd, ".pi", "skills");
    return fs
      .readdirSync(root)
      .filter((name: string) => SKILL_NAME_RE.test(name) && fs.existsSync(join(root, name, "SKILL.md")));
  } catch {
    return [];
  }
}

/**
 * Where npm puts one of our packages inside a deployment dir. One spelling for both packages and for
 * both readers (this module's install assertions and index.ts's skew notice), so "the deployment's
 * runtime lives HERE" is a fact stated once. Not a path the wizard writes -- npm owns that tree.
 */
export function runtimeDirFor(dir: string, pkg: string = "pi-dispatch"): string {
  return join(dir, "node_modules", "@edgehero", pkg);
}

/**
 * The installed version of the package at `runtimeDir`, or undefined when absent/unreadable/shapeless.
 * Exported because index.ts asks the same question of a POINTED-AT deployment (the skew notice) that the
 * install steps ask of the one they just built -- and an absent answer must mean the same silence there.
 */
export function readInstalledVersion(fs: any, runtimeDir: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(join(runtimeDir, "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A private root `package.json` pins npm's idea of "the project" to the deployment dir, so an install run
 * there cannot walk up into (or read config from) whatever happens to be above it. IF ABSENT only -- the
 * import-pi.mjs:294 idiom: a file the operator may have edited is never clobbered. BOTH install steps
 * call it (runtime, receiver), because either one can be the first npm run in a fresh dir -- a receiver
 * install after a declined runtime install must not be the one that escapes.
 */
function ensureDeploymentPackageJson(fs: any, dir: string): void {
  const rootPkg = join(dir, "package.json");
  if (!fs.existsSync(rootPkg)) {
    fs.writeFileSync(rootPkg, `${JSON.stringify({ name: "pi-dispatch-deployment", private: true }, null, 2)}\n`);
  }
}

/** The cron-id charset the triggers validator enforces (triggers.mjs:144-151; no ":" -- it corrupts the repeat jobId). */
const CRON_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The step engine. Every collaborator is injectable through `deps` so the tests drive the whole
 * sequence offline with recording fakes; production passes only `openDashboardFn` (index.ts's own
 * dashboard opener -- handed in rather than imported to keep the module cycle call-time-only).
 *
 * Steps (each declinable; a decline continues): (1) detect + intent, (2) deployment dir, (3) docker
 * pre-check, (4) pinned npm install with post-install version assertion, (5) `up`, (6) deployment
 * pointer, (7) provider-key notice, (8) worker service, (9) github credentials, (10) the trigger edge
 * (receiver unit / receiver container / polling command), (11) first cron trigger for ctx.cwd, (12)
 * re-detect + open the panel.
 */
export async function runSetupWizard(paths: any, ctx: any, notify: Notify, deps: any = {}): Promise<void> {
  const {
    fs = nodeFs,
    env = process.env,
    platform = process.platform,
    execPath = process.execPath,
    homedirFn = homedir,
    runAttachedFn = runAttached,
    writePointerFn = writePointer,
    reapplyFn = reapplyDeploymentPointer,
    detectFn = detectDeployment,
    openDashboardFn,
    writeTriggersFn = writeTriggers,
    resolvePathsFn = resolvePaths,
    listRepoSkillsFn = listRepoSkills,
    existsSyncFn = (p: string) => fs.existsSync(p),
    probeDockerFn = probeDocker,
    initialDetection,
  } = deps;
  const ui = ctx?.ui;

  // Capability gate, the handleDashboardAction idiom: the wizard is dialogs end to end, so a build
  // without the primitives degrades to one notice instead of half-running.
  if (typeof ui?.input !== "function" || typeof ui?.select !== "function" || typeof ui?.confirm !== "function") {
    notify?.("setup needs dialogs (newer pi) — no input/select/confirm available", "warning");
    return;
  }

  // ── (1) detection + intent ─────────────────────────────────────────────────────────────────────
  // `initialDetection` is the caller's ALREADY-COMPUTED verdict, reused rather than recomputed: a bare
  // `/dispatch` detects to decide that this host has nothing configured and then enters the wizard
  // directly, and one keypress must not cost two detections -- the second would repeat the queue probe
  // (a network round-trip) to re-derive an answer the caller is handing over. Absent it (the `/dispatch
  // setup` path, and every test that wants the seam), the wizard detects for itself as before.
  const det = initialDetection ?? (await detectFn({ env, cwd: ctx?.cwd, fs }));
  notify?.(`pi-dispatch setup — detected: ${det.detail}`, "info");
  const intent = await ui.select("pi-dispatch setup", ["Guided setup", "Open the panel anyway", "Cancel"]);
  if (intent === "Open the panel anyway") {
    if (typeof openDashboardFn === "function") await openDashboardFn(paths, ctx, notify);
    return;
  }
  if (intent !== "Guided setup") return;

  // ── (2) the deployment dir ─────────────────────────────────────────────────────────────────────
  // The one step with no "skip": every later step names this dir, so blank AND cancel both take the
  // default rather than aborting nine steps over one Esc. The mkdir itself is silent-tier (recursive,
  // idempotent, creates an empty dir at a path the operator just typed) -- but the dir is NAMED in the
  // very next confirm's message, so nothing lands anywhere the operator has not read on screen.
  const defaultDir = join(homedirFn(), "pi-dispatch");
  const dirAnswer = await ui.input("deployment directory — where the runtime and its config live", defaultDir);
  const dir = dirAnswer === undefined || dirAnswer.trim() === "" ? defaultDir : dirAnswer.trim();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err: any) {
    notify?.(`could not create ${dir}: ${err?.message ?? err} — setup cannot continue`, "error");
    return;
  }
  const runtimeDir = runtimeDirFor(dir);
  const cliPath = join(runtimeDir, "src", "cli.mjs");

  // ── (3) docker: the one host prerequisite, asked about before anything is downloaded ───────────
  // Placed AFTER the dir step (so a Stop here still leaves the operator's chosen dir created and named,
  // which is harmless and idempotent) and BEFORE the install: the point is to spend nobody's bandwidth
  // on a host where `up` cannot work anyway.
  if (!(await ensureDocker(ui, notify, { platform, probeDockerFn }))) return;

  // ── (4) install the pinned runtime ─────────────────────────────────────────────────────────────
  if (readInstalledVersion(fs, runtimeDir) === RUNTIME_VERSION) {
    // Convergence, said out loud: a re-run of the wizard must not re-download a runtime that is
    // already the pinned version -- and must SAY it skipped, so the operator is not left wondering.
    notify?.(`runtime ${RUNTIME_VERSION} already installed in ${dir} — skipping npm install`, "info");
  } else {
    const args = npmInstallArgs();
    const { bin, options } = npmSpawnOptions(platform, dir);
    const okInstall = await ui.confirm(
      "Install the pi-dispatch runtime",
      `Run in ${dir}:\n  ${bin} ${args.join(" ")}\n\n(scripts disabled; installs the pinned @edgehero/pi-dispatch@${RUNTIME_VERSION})`,
    );
    if (!okInstall) {
      notify?.(`install skipped — later steps assume the runtime at ${runtimeDir}`, "info");
    } else {
      ensureDeploymentPackageJson(fs, dir);
      const res = await runAttachedFn(ctx, {
        title: `npm install @edgehero/pi-dispatch@${RUNTIME_VERSION} — in ${dir}`,
        argv0: bin,
        args,
        cwd: options.cwd,
        shell: options.shell,
        env,
      });
      // POST-INSTALL ASSERTION, and the wizard's only hard stop: assert the artifact, never npm's exit
      // code alone (import-pi.mjs:330-341 -- npm has reported success over a wrong or absent stage).
      // Every later step runs THIS runtime; continuing past a wrong version would `up` and service a
      // deployment the wizard was never reviewed against.
      const installed = readInstalledVersion(fs, runtimeDir);
      if (installed !== RUNTIME_VERSION) {
        const how = res.error ? `npm could not run: ${res.error.message}` : `npm exited ${res.code}`;
        notify?.(
          `${how}; installed version is ${installed ?? "(absent)"}, not the pinned ${RUNTIME_VERSION} — stopping setup. Fix the install, then re-run /dispatch setup.`,
          "error",
        );
        return;
      }
      notify?.(`installed @edgehero/pi-dispatch@${RUNTIME_VERSION} into ${dir}`, "info");
    }
  }

  // ── (5) up: image, Valkey, init, doctor — the worker's own consented pass ──────────────────────
  // NEVER `--yes`: up's per-mutation y/N prompts ARE the host-mutation consents (docker pull, docker
  // run). The wizard's confirm approves STARTING the pass; auto-accepting the child's gates would
  // collapse per-action consent into one blanket yes the operator never gave.
  const okUp = await ui.confirm(
    "Bring the deployment up",
    `Run in ${dir}:\n  ${execPath} ${cliPath} up\n\nup shows each docker action and asks y/N before it — nothing is auto-accepted.`,
  );
  if (!okUp) {
    notify?.(`skipped — run it later: node ${cliPath} up  (in ${dir})`, "info");
  } else {
    const res = await runAttachedFn(ctx, {
      title: `pi-dispatch up — in ${dir}`,
      argv0: execPath,
      args: [cliPath, "up"],
      cwd: dir,
      env,
    });
    if (res.error || res.code !== 0) {
      // up's own exit code mirrors doctor's verdict, so a nonzero here usually means "something is
      // still missing", not "everything failed" -- the operator, who just watched the output, decides.
      const why = res.error ? `could not start (${res.error.message})` : `exited ${res.code}`;
      const choice = await ui.select(`up ${why} — continue setup?`, ["Continue anyway", "Stop"]);
      if (choice !== "Continue anyway") return;
    }
  }

  // ── (6) the deployment pointer ─────────────────────────────────────────────────────────────────
  // Only the four cwd-default files need pointing: resolvePaths defaults them to "./" (right only
  // when pi runs FROM the deployment dir), while logsDir/settingsFile default to absolute OS-temp
  // locations and VALKEY_URL's default already matches the container up starts. Absolute paths by
  // pointer contract (a relative value is dropped by the normalizer).
  const pointer = {
    version: POINTER_VERSION,
    deploymentDir: dir,
    env: {
      PI_TRIGGERS_FILE: join(dir, "triggers.json"),
      PI_PAUSE_WINDOWS_FILE: join(dir, "pause-windows.json"),
      PI_SCOPED_LIMITS_FILE: join(dir, "scoped-limits.json"),
      PI_SUBSCRIPTIONS_FILE: join(dir, "subscriptions.json"),
    },
  };
  const pPath = pointerPath(env);
  // The JSON is shown VERBATIM: this file is the one artifact that redirects every future /dispatch,
  // so the operator approves the exact bytes-to-be, not a summary of them.
  const okPointer = await ui.confirm("Write the deployment pointer", `${pPath} gets:\n${JSON.stringify(pointer, null, 2)}`);
  if (!okPointer) {
    notify?.(`skipped — without the pointer, /dispatch finds this deployment only when pi runs from ${dir}`, "info");
  } else {
    const res = writePointerFn({ path: pPath, pointer, fs });
    if (res.invalid) {
      notify?.(`pointer rejected: ${res.invalid}`, "error");
    } else {
      // Re-apply immediately so THIS session's panel opens against the new deployment -- the memoized
      // factory-time apply already ran, and reapply is its one sanctioned refresh (no restart needed).
      reapplyFn(env, { fs });
      notify?.(`pointer written — the panel now finds ${dir} from any directory, in this session too`, "info");
    }
  }

  // ── (7) provider key: notice only, never-tier ──────────────────────────────────────────────────
  // Deliberately NO dialog and NO write: a secret must never transit a wizard dialog (dialog text is
  // not a credential channel) nor a wizard-written file. The operator edits the named file themselves,
  // or leans on the already-logged-into-pi fallback the worker honours.
  notify?.(
    `provider key: set ANTHROPIC_API_KEY (or your provider's key) in ${join(dir, ".env")} — already logged into pi on this machine? leave it blank and jobs use that login. Setup never reads or writes the key itself.`,
    "info",
  );

  // ── (8) the worker ─────────────────────────────────────────────────────────────────────────────
  const workerChoice = await ui.select("Run the worker", [
    "Install as an OS service (user-level)",
    "I'll run it myself",
    "Skip",
  ]);
  if (workerChoice === "Install as an OS service (user-level)") {
    // `service install` is user-level by default on every platform (service.mjs:13); no flag needed.
    await runAttachedFn(ctx, {
      title: `pi-dispatch service install — in ${dir}`,
      argv0: execPath,
      args: [cliPath, "service", "install"],
      cwd: dir,
      env,
    });
  } else if (workerChoice === "I'll run it myself") {
    notify?.(`run: node ${cliPath} worker  (in ${dir}; keep it running — its own terminal, tmux, …)`, "info");
  }

  // ── (9) github credentials (optional) ──────────────────────────────────────────────────────────
  // Phrased so declining is obviously fine: local cron triggers -- the first-trigger step right below
  // -- need none of this, and the command is named for later.
  const okGithub = await ui.confirm(
    "GitHub webhook triggers (optional)",
    "Only needed for label/comment/PR triggers on GitHub repos. Local cron triggers need none of this — declining is the normal choice for a first setup. Mint GitHub App credentials now?",
  );
  if (okGithub) {
    await runAttachedFn(ctx, {
      title: `pi-dispatch setup github — in ${dir}`,
      argv0: execPath,
      args: [cliPath, "setup", "github"],
      cwd: dir,
      env,
    });
  } else {
    notify?.(`later: node ${cliPath} setup github  (in ${dir})`, "info");
  }

  // ── (10) the trigger edge: how a forge event actually reaches the queue ─────────────────────────
  // Credentials (step 9) mint the App; they do not make a delivery arrive. This step closes that gap,
  // which was previously left to the README: a receiver UNIT, a receiver CONTAINER, or polling (no
  // public URL at all). Every answer -- including Skip -- continues to the next step.
  await offerTriggerEdge(dir, ctx, ui, notify, { fs, platform, env, execPath, cliPath, runAttachedFn });

  // ── (11) a first trigger for the repo pi is sitting in ──────────────────────────────────────────
  // Offered only when ctx.cwd names an existing directory: the trigger's folder is the one hard
  // precondition (the worker refuses a missing run.folder at load), so no folder, no offer.
  if (typeof ctx?.cwd === "string" && ctx.cwd !== "" && existsSyncFn(ctx.cwd)) {
    await offerFirstTrigger(ctx.cwd, dir, ui, notify, { fs, listRepoSkillsFn, writeTriggersFn });
  }

  // ── (12) re-detect + open the panel ────────────────────────────────────────────────────────────
  const finalDet = await detectFn({ env, cwd: ctx?.cwd, fs });
  notify?.(`setup finished — ${finalDet.detail}`, "info");
  if (typeof openDashboardFn === "function") {
    // Fresh resolvePaths on purpose: the pointer re-apply above layered the new deployment's paths
    // into the env, so the panel must resolve NOW, not reuse the pre-wizard `paths`.
    await openDashboardFn(resolvePathsFn(env), ctx, notify);
  }
}

/** The four trigger-edge answers, spelled once so the flow below and its tests read the same strings. */
const EDGE_SERVICE = "Install the webhook receiver as a service";
const EDGE_COMPOSE = "Run the receiver with docker compose";
const EDGE_POLL = "Show the polling command";

/**
 * Step 10's body: the trigger EDGE. A GitHub App with credentials still delivers nowhere until something
 * is listening (or asking), and until now the wizard stopped one step short of that -- so an operator who
 * accepted every offer still had a deployment no label could reach. The three real shapes, in the order
 * they cost:
 *
 *   - a receiver SERVICE on this host: the pinned receiver package plus `service install --receiver`.
 *     Correct only since the unit renderer started anchoring on the deployment folder and resolving the
 *     receiver's own `./start` export from there (the `service` fix that ships alongside this step);
 *     before it, a unit installed here would have pointed at a guessed repo root.
 *   - a receiver CONTAINER via the runtime's own shipped compose file and its opt-in `receiver` profile.
 *   - POLLING: no inbound delivery at all, so no public URL, DNS or tunnel -- printed, never started,
 *     because a poller belongs in a supervisor the operator chose, not in a wizard's child process.
 *
 * Declining or skipping is fine and says so: local cron triggers need none of this.
 */
async function offerTriggerEdge(
  dir: string,
  ctx: any,
  ui: any,
  notify: Notify,
  { fs, platform, env, execPath, cliPath, runAttachedFn }: any,
): Promise<void> {
  const choice = await ui.select("How should GitHub events reach the queue?", [
    EDGE_SERVICE,
    EDGE_COMPOSE,
    EDGE_POLL,
    "Skip",
  ]);

  if (choice === EDGE_SERVICE) {
    const args = receiverInstallArgs();
    const { bin, options } = npmSpawnOptions(platform, dir);
    const unitHint = `node ${cliPath} service install --receiver  (in ${dir})`;
    const ok = await ui.confirm(
      "Install the webhook receiver",
      `Run in ${dir}:\n  ${bin} ${args.join(" ")}\n\nthen, in the same folder:\n  ${execPath} ${cliPath} service install --receiver\n\n(scripts disabled; installs the pinned ${RECEIVER_PKG}@${RECEIVER_VERSION}, then renders a user-level receiver unit for this host)`,
    );
    if (!ok) {
      notify?.(`receiver skipped — later: ${bin} ${args.join(" ")}  (in ${dir}), then ${unitHint}`, "info");
      return;
    }
    // Same project pin as the runtime install: this may be the FIRST npm run in this dir (the operator
    // could have declined step 4 and installed the runtime by hand).
    ensureDeploymentPackageJson(fs, dir);
    const res = await runAttachedFn(ctx, {
      title: `npm install ${RECEIVER_PKG}@${RECEIVER_VERSION} — in ${dir}`,
      argv0: bin,
      args,
      cwd: options.cwd,
      shell: options.shell,
      env,
    });
    // The same artifact-not-exit-code assertion the runtime install makes -- but NOT a hard stop. The
    // receiver is optional: a deployment whose cron triggers work is still a working deployment, so a
    // bad receiver install costs the operator this step and nothing else. What it must never do is
    // install a UNIT pointing at a package that is absent or the wrong version -- `service install`
    // would either refuse (commit 1's loud hint) or pin a boot-time failure into launchd/systemd.
    const installed = readInstalledVersion(fs, runtimeDirFor(dir, "pi-dispatch-receiver"));
    if (installed !== RECEIVER_VERSION) {
      const how = res?.error ? `npm could not run: ${res.error.message}` : `npm exited ${res?.code}`;
      notify?.(
        `${how}; installed receiver version is ${installed ?? "(absent)"}, not the pinned ${RECEIVER_VERSION} — skipping the receiver unit (the rest of the deployment is unaffected). Fix the install, then run: ${unitHint}`,
        "error",
      );
      return;
    }
    await runAttachedFn(ctx, {
      title: `pi-dispatch service install --receiver — in ${dir}`,
      argv0: execPath,
      args: [cliPath, "service", "install", "--receiver"],
      cwd: dir,
      env,
    });
    return;
  }

  if (choice === EDGE_COMPOSE) {
    // The compose file the RUNTIME ships (worker/deploy/docker-compose.yml, published in its `files`),
    // copied beside the deployment's own config so `-f` names a stable path the operator can edit and
    // keep. CREATE-ONLY, the import-pi.mjs:294 idiom the root package.json already follows: an operator
    // who tuned their compose file must never lose it to a re-run of the wizard.
    const src = join(runtimeDirFor(dir), "deploy", "docker-compose.yml");
    const dest = join(dir, "docker-compose.yml");
    if (fs.existsSync(dest)) {
      notify?.(`${dest} already exists — keeping yours as it is (setup never overwrites a compose file you may have edited)`, "info");
    } else {
      try {
        fs.copyFileSync(src, dest);
        notify?.(`copied the runtime's compose file to ${dest}`, "info");
      } catch (err: any) {
        notify?.(
          `could not copy ${src}: ${err?.message ?? err} — the receiver profile needs that file; skipping this step (install the runtime first, or copy it by hand)`,
          "error",
        );
        return;
      }
    }
    // `--profile receiver` is what makes the receiver container OPT-IN: the same compose file's plain
    // `up` is Valkey-only, which is what a worker-on-host deployment wants.
    const args = ["compose", "-f", dest, "--profile", "receiver", "up", "-d"];
    const ok = await ui.confirm(
      "Start the receiver container",
      `Run in ${dir}:\n  docker ${args.join(" ")}\n\nthe receiver profile reads ${join(dir, ".env")} — WEBHOOK_SECRET and the forge credentials must be in there, or the container refuses to boot.`,
    );
    if (!ok) {
      notify?.(`later: docker ${args.join(" ")}  (in ${dir})`, "info");
      return;
    }
    await runAttachedFn(ctx, {
      title: `docker compose --profile receiver up -d — in ${dir}`,
      argv0: "docker",
      args,
      cwd: dir,
      env,
    });
    return;
  }

  if (choice === EDGE_POLL) {
    // Print-only by design: `poll` is a long-running producer, and starting it inside the wizard's
    // attached overlay would tie the operator's whole session to it. Both commands, in order.
    notify?.(
      `polling needs no public URL, no DNS and no tunnel — two commands, in ${dir}:\n  1) node ${cliPath} setup github --no-webhook   (mints the App with its webhook INACTIVE — the polling-ready shape)\n  2) npx @edgehero/pi-dispatch-receiver poll   (the producer; run it from the deployment folder, under whatever keeps it alive)`,
      "info",
    );
    return;
  }

  notify?.(
    `trigger edge left for later — all three ways stay open from ${dir}: \`service install --receiver\` (a receiver unit on this host), \`docker compose --profile receiver up -d\` (a receiver container), or \`npx @edgehero/pi-dispatch-receiver poll\` (no public URL at all). Local cron triggers need none of them.`,
    "info",
  );
}

/**
 * Step 11's body: pick a flow (the repo's own skills first, free text as the escape), then id/pattern/
 * task with the same defaults the add-trigger dialog uses, then write ONE cron entry -- into the
 * DEPLOYMENT dir's triggers.json, deliberately not `paths.triggersPath`: the pointer written in step 6
 * aims the panel (and the worker's init scaffold) at the deployment dir, and a trigger written to
 * wherever the pre-wizard env happened to point would land in a file the new deployment never reads.
 * Any cancel or invalid answer skips the step; the wizard continues.
 */
async function offerFirstTrigger(
  repoCwd: string,
  deployDir: string,
  ui: any,
  notify: Notify,
  { fs, listRepoSkillsFn, writeTriggersFn }: any,
): Promise<void> {
  const offer = await ui.select("First trigger", ["A cron trigger for this repo", "Skip"]);
  if (offer !== "A cron trigger for this repo") return;

  // The repo's own skills as a picker, with a typed escape for a flow that is not committed yet; an
  // empty listing (no .pi/skills) downgrades to the input directly.
  const skills = listRepoSkillsFn(repoCwd, fs);
  const TYPE_ANOTHER = "type another…";
  let flow: string | undefined;
  if (skills.length > 0) {
    const picked = await ui.select("flow — the .pi/skills/<name> skill the job runs", [...skills, TYPE_ANOTHER]);
    if (picked === undefined) return;
    flow = picked === TYPE_ANOTHER ? await ui.input("flow — the .pi/skills/<name> skill the job runs", "fix") : picked;
  } else {
    flow = await ui.input("flow — the .pi/skills/<name> skill the job runs", "fix");
  }
  if (flow === undefined || flow.trim() === "") return;
  flow = flow.trim();

  const idAnswer = await ui.input("cron id — unique name for this schedule, no ':'", "nightly");
  if (idAnswer === undefined) return;
  const id = idAnswer.trim() === "" ? "nightly" : idAnswer.trim();
  // The triggers validator's own charset (triggers.mjs:144-151), checked here so a bad id fails at the
  // dialog instead of surfacing as a rejected write three questions later.
  if (!CRON_ID_RE.test(id)) {
    notify?.(`invalid cron id '${id}' — letters, digits, dot, dash, underscore only (no ':') — skipping the trigger`, "error");
    return;
  }
  const patternAnswer = await ui.input("schedule — cron pattern, 5 or 6 fields (min hour day month weekday)", "0 3 * * *");
  if (patternAnswer === undefined) return;
  const pattern = patternAnswer.trim() === "" ? "0 3 * * *" : patternAnswer.trim();
  const taskAnswer = await ui.input("task — the prompt text handed to the agent for this run", "run the flow");
  if (taskAnswer === undefined) return;
  const task = taskAnswer.trim() === "" ? "run the flow" : taskAnswer.trim();

  // The same disclosure `pi-dispatch run` makes (cli.mjs:112): the job edits the operator's checkout,
  // not a clone, and there is no undo -- said BEFORE the entry exists, while cancelling still helps.
  notify?.(`a local cron job edits ${repoCwd} IN PLACE with no undo — commit or stash before it first fires`, "warning");
  // Print-only, NEVER written: the ai-trigger gate lives in the repo's own reviewed history, and a
  // wizard that edited the serviced repo would grant itself the very opt-in the gate exists to demand.
  notify?.(
    `to let AI-invoked runs use this flow, add \`ai-trigger: allow\` to ${join(".pi", "skills", flow, "SKILL.md")} frontmatter — takes effect once committed. Setup never writes into the repo.`,
    "info",
  );

  const entry = buildTriggerEntry("cron", { id, pattern, folder: repoCwd, flow, task });
  const res = writeTriggersFn({ triggersPath: join(deployDir, "triggers.json"), mutate: (list: any[]) => [...list, entry] });
  notify?.(
    res.ok !== false && !res.invalid
      ? `trigger added — ${id} (${pattern}) runs ${flow} in ${repoCwd}`
      : `trigger rejected: ${res.invalid}`,
    res.invalid ? "error" : "info",
  );
}

/**
 * The one-time startup nudge: on a fresh, unconfigured host, tell the operator `/dispatch setup`
 * exists -- once EVER, then a marker file keeps it quiet for good.
 *
 * Sync-only checks by design: this handler runs on EVERY pi startup, so it may read a few local files
 * but must never probe the queue -- a network round-trip (even a fast-failing one) taxing every session
 * start to detect a state the pointer/env/cwd checks already cover is the wrong trade. The probe-backed
 * "reachable" state stays a bare-`/dispatch` concern, where the operator explicitly asked.
 *
 * Notify-only: no dialog is ever raised from a session_start handler (an unprompted modal at startup
 * is exactly the interruption a nudge must not be). The whole body is try/caught -- a nudge that could
 * break a session start would cost more than it ever says.
 */
export function registerNudge(pi: any, deps: any = {}): void {
  const { fs = nodeFs, env = process.env, homedirFn = homedir } = deps;
  pi.on("session_start", (event: any, ctx: any) => {
    try {
      // Only a real interactive startup: reload/resume/fork repeat within a configured workflow, and
      // without a UI there is nobody to nudge (and no notify to carry it).
      if (event?.reason !== "startup" || !ctx?.hasUI) return;
      // A PRESENT pointer -- valid or broken -- means the operator has been here; /dispatch itself
      // surfaces broken-pointer notices, so the nudge stays quiet on anything but true absence.
      if (!(readPointer({ path: pointerPath(env), fs }) as any).absent) return;
      // The full sextet here (VALKEY_URL included), unlike detection's env branch: with no probe
      // allowed, an exported queue URL is the closest sync evidence of intent, and the nudge errs
      // toward silence.
      if (POINTER_ENV_ALLOWLIST.some((key) => envIsSet(env, key))) return;
      const cwd = typeof ctx?.cwd === "string" && ctx.cwd !== "" ? ctx.cwd : process.cwd();
      if (hasCwdScaffold(cwd, fs)) return;
      const agentDir = env.PI_CODING_AGENT_DIR || join(homedirFn(), ".pi", "agent");
      const marker = join(agentDir, NUDGE_MARKER_BASENAME);
      if (fs.existsSync(marker)) return;
      ctx?.ui?.notify?.("pi-dispatch: no deployment configured — /dispatch setup gets you started", "info");
      // Marker AFTER the notify: if the write fails (missing agent dir, read-only fs) the catch below
      // swallows it and the nudge may repeat -- twice-said beats never-said-and-crashed.
      fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
    } catch {
      // Deliberately swallowed: a session start must never fail over a nudge.
    }
  });
}
