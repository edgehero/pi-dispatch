/**
 * The `/dispatch setup` wizard (issue #92): a guided, step-by-step build of a pi-dispatch deployment,
 * driven entirely through pi's own dialogs and one attached-terminal overlay.
 *
 * Division of labor, deliberately: the WORKER's CLI (`up`, `service`, `setup github`) stays the one
 * place host mutations happen -- the wizard only sequences those commands, attached to the operator's
 * terminal, with a confirm in front of each spawn showing the exact command. The wizard's OWN writes
 * are five files, each tame: the deployment dir's private `package.json` (never clobbered), the
 * deployment pointer (via `writePointer`'s validating normalizer), one appended trigger entry (via the
 * validated, atomic `writeTriggers`), -- only on the compose answer to the trigger-edge step -- a
 * `docker-compose.yml` COPIED create-only out of the installed runtime's own `deploy/`, and -- only on the
 * podman answer to the runtime step (issue #430) -- one `PI_BACKENDS=podman` line in the deployment's
 * `.env`, through the worker's own never-clobber writer. Secrets are never touched: the provider-key
 * step is a notice naming the file, nothing more.
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
import { gateDialogs } from "./dialog-gate.mjs";
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
import { DEPLOYMENT_SCAFFOLD_FILES, panelValkeyContext, readQueueState, resolvePaths, writeTriggers } from "./read-model.mjs";
// The worker's own answers to "which venues does this list bless" and "set this .env key unless the operator already
// did" (issue #430): one parse and one never-clobber writer, never a second copy of either in the admin.
import { venuesOf } from "@edgehero/pi-dispatch/backends";
import { envFileEditCheck, envFileEditRefusal, updateEnvFile } from "@edgehero/pi-dispatch/env-file";
// The venue keys read exactly as `service install` and `up` read them (issue #430 review round 2, E4): the general
// reader takes a line inside a quoted value that systemd continues for an assignment, and this one refuses that file.
import { readStackKeys, valkeyTarget } from "@edgehero/pi-dispatch/podman-stack";
import { COMPOSE_VALKEY_OVERRIDE, OWNER_MARKER_KEY, VALKEY_HANDOVER_OVERRIDE, VALKEY_PASSWORD_KEY, VALKEY_PORT_KEY, composeArgs, composeHandoverPlan, composeProjectName, VALKEY_VOLUME_RECORD, foreignMarkerRefusal, readVolumeRecord, valkeyPortEnvDecision, volumeRecordText } from "@edgehero/pi-dispatch/valkey-auth";
import { claimValkeyOwner } from "@edgehero/pi-dispatch/connection";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
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
export const RUNTIME_VERSION = "2.1.0";

/**
 * The `@edgehero/pi-dispatch-receiver` version the trigger-edge step installs -- pinned for exactly the
 * reasons RUNTIME_VERSION is, and with the same anti-drift test (this literal against the in-repo
 * `receiver/package.json`), so a receiver release bump cannot land without this line following it in the
 * same change. Its own literal rather than a reuse of RUNTIME_VERSION: the two packages version
 * independently (the receiver's dependency range on the runtime is `^`), and pretending otherwise would
 * install a version that does not exist the first time they diverge.
 */
export const RECEIVER_VERSION = "2.0.0";

/** The two npm package names, spelled once. Literals of this module -- see npmInstallArgsFor's argument. */
const RUNTIME_PKG = "@edgehero/pi-dispatch";
const RECEIVER_PKG = "@edgehero/pi-dispatch-receiver";

/** The pointer marker file suffix and the four-file cwd scaffold signature, shared by detect + nudge. */
const NUDGE_MARKER_BASENAME = "pi-dispatch-setup.nudged";
// Spelled once in read-model.mjs since issue #471, where it also decides which cwd `.env` the panel may read.
const CWD_SCAFFOLD_FILES = DEPLOYMENT_SCAFFOLD_FILES;

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
 * NEVER consulted: `logsDir` / `settingsFile` absence. Both default lazily (since issue #290, under
 * `~/.pi-dispatch`), so their absence proves nothing about a deployment -- and neither does their
 * PRESENCE, which is the sharper half now that the default is a stable per-user path a previous
 * deployment may well have created. Testing them would also drag a resolved path into a detection that
 * is otherwise pure over the operator's own files.
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
// The folder's compose project and the hand-over override are the worker package's (valkey-auth.mjs), shared with
// `pi-dispatch up`, which starts compose's Valkey in a folder this wizard handed over (PR #475's review).
export { composeProjectName, VALKEY_HANDOVER_OVERRIDE };

/**
 * VALKEY_URL's port as the deployment's `.env` gives it (6379 unset, or for a URL this reader cannot use): the port
 * compose's Valkey is published on (PI_VALKEY_PORT), so a hand-over never moves the queue off the port the worker
 * dials (PR #475's review, measured: a 16495 deployment's queue went to 6379).
 */
export function composeValkeyPort(dir: string, fs: any): number {
  try {
    // Through issue #471's one reader (`deploymentServiceEnv`: one descriptor, nothing from a file another account can
    // change), as the panel reads this folder's `.env`, never a second reader.
    const read: any = deploymentServiceEnv({ env: {}, dir, keys: ["VALKEY_URL"], fs, platform: "linux" });
    const target = valkeyTarget(read.fromFile.VALKEY_URL);
    return target.error ? 6379 : target.port;
  } catch {
    return 6379;
  }
}

/**
 * One docker query for the hand-over's ownership questions (PR #475's review, round 3): `{ code, stdout, stderr }`, the
 * shape `composeHandoverPlan` asks through. A docker that cannot be launched is `code: null`, which it never reads as ours.
 */
export function dockerQuery(cmd: string, args: string[], execFn: any = execFileSync): { code: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFn(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: DOCKER_PROBE_TIMEOUT_MS });
    return { code: 0, stdout: String(stdout ?? ""), stderr: "" };
  } catch (err: any) {
    return { code: typeof err?.status === "number" ? err.status : null, stdout: String(err?.stdout ?? ""), stderr: String(err?.stderr ?? "") };
  }
}

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
 * The podman counterpart of probeDocker (issue #430), asked only when the operator chose the podman venue: ONE
 * bounded `podman info` that also says whether this account's Podman is rootless, because a rootful one is refused by
 * the venue at every job, and learning that after an npm install and an `up` is the waste step 3 exists to prevent.
 * Four outcomes:
 *   `{ ok: true }`          -- podman answered and says rootless
 *   `{ missing: true }`     -- no `podman` on PATH
 *   `{ rootful: true }`     -- podman answered and is not rootless for this account
 *   `{ daemonDown: why }`   -- the CLI ran and did not answer usefully
 * The full check (remote service, controllers, the worker's own uid) is `up`'s and doctor's: the same rule the
 * worker boots with. This step is, like the docker one, a better message earlier and never the enforcement.
 */
export function probePodman(
  execFn: any = execFileSync,
): { ok: true } | { missing: true } | { rootful: true } | { daemonDown: string } {
  try {
    const out = String(
      execFn("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: DOCKER_PROBE_TIMEOUT_MS,
      }) ?? "",
    ).trim();
    if (out === "true") return { ok: true };
    if (out === "false") return { rootful: true };
    return { daemonDown: `\`podman info\` did not say whether it is rootless` };
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.errno === "ENOENT") return { missing: true };
    if (typeof err?.status === "number") return { daemonDown: `\`podman info\` exited ${err.status}` };
    return { daemonDown: err?.message ?? String(err) };
  }
}

/** Where to get a usable rootless Podman. Vendor text only, for dockerHint's reason; the venue runs only on Linux. */
export function podmanHint(platform: string): string {
  if (platform !== "linux") {
    return "the podman venue runs only on Linux (it refuses other hosts as podman-platform); use Docker here instead.";
  }
  return "Linux: install Podman from your distribution's own packages and follow the rootless setup in docs/podman.md (subordinate ids, linger, delegated cgroup controllers), as the account the worker will run as.";
}

/** The answer on the docker gate that switches this run to the podman venue. Linux only: nowhere else runs it. */
const USE_PODMAN = "Use rootless Podman instead";

/**
 * Does this deployment already mean the podman venue without docker? From the wizard's own env or, on a re-run, the
 * deployment's `.env` (the file the service reads). Only a list WITHOUT `local` counts: with `local` in it docker is
 * the host's runtime and the docker gate is the right question, exactly as `up` decides.
 */
function podmanPreferred(env: any, dir: string, fs: any): boolean {
  const fromEnv = venuesOf({ PI_BACKENDS: env?.PI_BACKENDS });
  if (fromEnv.podmanUsed && !fromEnv.localUsed) return true;
  const file = deploymentBackends(dir, fs);
  if (!("value" in file)) return false;
  const fromFile = venuesOf({ PI_BACKENDS: file.value });
  return fromFile.podmanUsed && !fromFile.localUsed;
}

/**
 * What the deployment's `.env` says about PI_BACKENDS, read as `service install` reads it: `{ absent: true }` when the
 * file or the key is not there, `{ value }`, or `{ unreadable }` with the reader's reason. `writing`: the wizard is
 * about to write PI_BACKENDS into this file, so a line systemd reads differently counts even where no venue key is
 * spelled yet, because after the write one is (issue #447, gate round 1: it wrote the key under such a line and said the
 * service reads it, and the next `up` refused).
 */
function deploymentBackends(dir: string, fs: any, { writing = false, platform = process.platform, readBackFn = readStackKeys }: any = {}): { absent: true } | { value: string } | { unreadable: string } {
  const envPath = join(dir, ".env");
  let text: string | Uint8Array;
  try {
    if (!fs.existsSync(envPath)) return { absent: true };
    // Bytes, not text: the reader checks what systemd refuses to load before it decodes (issue #447).
    text = fs.readFileSync(envPath);
  } catch (err: any) {
    return { unreadable: `${envPath} could not be read: ${err?.message ?? err}` };
  }
  // About to write: first the WRITER's own rule (a file it would refuse to edit is refused now, before `up` runs rather
  // than after), then every line hazard as though the key were already spelled (issue #447, gate rounds 1 and 2).
  if (writing) {
    const refusal = envFileEditRefusal(text, envPath);
    if (refusal !== null) return { unreadable: refusal };
  }
  const read: any = readStackKeys(text, { loader: "systemd", path: envPath, assumeSpelled: writing });
  if (read.error) return { unreadable: read.error };
  // And the WRITER itself, run dry on the file as it stands (gate round 3): a file ending inside a continuation or an
  // open quote passed every check above, `up` ran, and only then did the write refuse. Same rule, same function.
  if (writing) {
    const wouldRefuse = envFileEditCheck(text, envPath, "PI_BACKENDS", "podman", { platform, verify: podmanWriteVerify(envPath, read.keys, readBackFn) });
    if (wouldRefuse !== null) return { unreadable: wouldRefuse };
  }
  return typeof read.keys.PI_BACKENDS === "string" ? { value: read.keys.PI_BACKENDS } : { absent: true };
}

/**
 * Step 3 on the podman venue: the same bounded Re-check loop as ensureDocker, with podman's own verdicts. A rootful
 * Podman gets its own sentence: it is installed and answering, and still the wrong thing for this venue.
 */
async function ensurePodman(ui: any, notify: Notify, { platform, probePodmanFn }: any): Promise<boolean> {
  for (let round = 1; ; round++) {
    const probe = platform === "linux" ? probePodmanFn() : { daemonDown: "not Linux" };
    if (probe.ok) return true;
    const why = probe.missing
      ? "no `podman` on PATH"
      : probe.rootful
        ? "podman answers, but not rootless for this account, and the podman venue refuses a rootful Podman"
        : `podman is not answering (${probe.daemonDown})`;
    notify?.(`podman check: ${why}. ${podmanHint(platform)}`, "warning");
    if (round >= DOCKER_PROBE_ROUNDS) {
      notify?.(
        `podman still not ready after ${DOCKER_PROBE_ROUNDS} checks: stopping setup before anything was installed. Re-run /dispatch setup once \`podman info\` answers.`,
        "error",
      );
      return false;
    }
    const choice = await ui.select("Podman is not ready", ["Re-check", "Continue anyway", "Stop"]);
    if (choice === "Re-check") continue;
    if (choice === "Continue anyway") {
      notify?.("continuing without a podman answer: `up` runs the venue's own checks and refuses there if it is still not usable", "info");
      return true;
    }
    notify?.("setup stopped before anything was installed: re-run /dispatch setup when podman is ready", "info");
    return false;
  }
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
async function ensureDocker(ui: any, notify: Notify, { platform, probeDockerFn }: any): Promise<"docker" | "podman" | false> {
  for (let round = 1; ; round++) {
    const probe = probeDockerFn();
    if (probe.ok) return "docker";
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
    // On Linux a host without docker has a second answer since issue #430: the podman venue. Offered HERE, where docker
    // has just failed, rather than as a question every run asks, so a docker host's wizard is exactly what it was.
    const choice = await ui.select(
      "Docker is not ready",
      platform === "linux" ? ["Re-check", USE_PODMAN, "Continue anyway", "Stop"] : ["Re-check", "Continue anyway", "Stop"],
    );
    if (choice === "Re-check") continue;
    if (choice === USE_PODMAN) return "podman";
    if (choice === "Continue anyway") {
      // Deliberately permitted: `up` runs its own docker checks and refuses on its own, so this step is
      // a BETTER MESSAGE EARLIER, never the enforcement. An operator installing docker in the next
      // window over -- or driving a daemon this probe cannot see -- must not be locked out by our probe.
      notify?.("continuing without a docker answer — `up` runs its own docker checks and refuses there if it is still missing", "info");
      return "docker";
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
export async function runSetupWizard(paths: any, rawCtx: any, notify: Notify, deps: any = {}): Promise<void> {
  // An EXPORTED door with its own `ctx` (issue #404), driven directly by this file's own tests about thirty
  // times. It gates for itself rather than trusting its caller, which is the same reason
  // `handleDashboardAction` does.
  const ctx = gateDialogs(rawCtx);
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
    probePodmanFn = probePodman,
    // Whether `up`'s pi-dispatch-valkey container exists (the compose answer's hand-over; a seam for its test).
    dockerQueryFn = dockerQuery,
    // The volume gap (PR #475's review): the started Valkey's pi-dispatch:owner marker, recorded and read back through
    // the project's one connection function with the deployment's credential; a seam so no test dials a Valkey.
    // The context from that folder's `.env` through issue #471's one reader (`panelValkeyContext`), never a second reader.
    claimOwnerFn = (url: string, folder: string, dir: string, env: any) => claimValkeyOwner(url, folder, { context: panelValkeyContext({ env, pointerDir: dir }) }),
    // The venue-key reading behind the wizard's own post-edit check (a seam for its test; see podmanWriteVerify).
    readBackFn = readStackKeys,
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
  //
  // Which runtime (issue #430): the podman venue when the deployment already says so (PI_BACKENDS without `local`), or
  // when the operator picks it at a failed docker gate on Linux. Everything after this reads `runtime`.
  let runtime: "docker" | "podman";
  if (podmanPreferred(env, dir, fs)) {
    if (!(await ensurePodman(ui, notify, { platform, probePodmanFn }))) return;
    runtime = "podman";
  } else {
    const chosen = await ensureDocker(ui, notify, { platform, probeDockerFn });
    if (!chosen) return;
    if (chosen === "podman" && !(await ensurePodman(ui, notify, { platform, probePodmanFn }))) return;
    runtime = chosen;
  }
  // The podman answer meets a deployment whose `.env` already says otherwise (round 2, E5): a re-run over a docker
  // deployment, where the operator picked rootless Podman at the docker gate. Setup never overwrites a key the operator
  // set, so going on would run `up` for podman while the service it installs next reads `local` from the file. It stops
  // here, before anything is downloaded, with the one edit that resolves it.
  const fileBackends = deploymentBackends(dir, fs, { writing: runtime === "podman", platform, readBackFn });
  if (runtime === "podman") {
    if ("unreadable" in fileBackends) {
      notify?.(`${fileBackends.unreadable}. Setup stops before anything is installed: make that change, with PI_BACKENDS on a plain PI_BACKENDS=podman line, then re-run /dispatch setup`, "error");
      return;
    }
    if ("value" in fileBackends && !venuesOf({ PI_BACKENDS: fileBackends.value }).podmanUsed) {
      notify?.(
        `${join(dir, ".env")} sets PI_BACKENDS=${fileBackends.value}, which does not list podman, and setup never overwrites a key you set. Change it to PI_BACKENDS=podman (or add podman to the list), then re-run /dispatch setup. Nothing was installed`,
        "error",
      );
      return;
    }
  }

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
  //
  // On podman, `up` decides the venue from its own environment where that sets PI_BACKENDS and from the deployment's
  // `.env` otherwise, and refuses when the two disagree. So: when `.env` already assigns PI_BACKENDS (it lists podman,
  // or setup stopped above), `up` gets NO PI_BACKENDS of its own and reads the file, as the service will; when it does
  // not (a fresh folder, where init inside this very `up` scaffolds `.env`), `up` runs with PI_BACKENDS=podman, and the
  // line is written into `.env` afterwards for the SERVICE, which reads only the file.
  const fileAssigns = runtime === "podman" && "value" in fileBackends;
  const withoutBackends = (e: any) => {
    const { PI_BACKENDS: _dropped, ...rest } = e ?? {};
    return rest;
  };
  const upAddsBackends = runtime === "podman" && !fileAssigns && !venuesOf({ PI_BACKENDS: env?.PI_BACKENDS }).podmanUsed;
  const upEnv =
    runtime !== "podman" ? env : fileAssigns ? (typeof env?.PI_BACKENDS === "string" ? withoutBackends(env) : env) : upAddsBackends ? { ...env, PI_BACKENDS: "podman" } : env;
  const podmanUpText = `Run in ${dir}:\n  ${upAddsBackends ? "PI_BACKENDS=podman " : ""}${execPath} ${cliPath} up\n\nup shows each podman and systemctl action (the job image, then Valkey, the egress proxy and its rootless network keeper as Quadlet units) and asks y/N before it: nothing is auto-accepted.`;
  const okUp = await ui.confirm(
    "Bring the deployment up",
    runtime === "podman" ? podmanUpText :
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
      env: upEnv,
    });
    if (res.error || res.code !== 0) {
      // up's own exit code mirrors doctor's verdict, so a nonzero here usually means "something is
      // still missing", not "everything failed" -- the operator, who just watched the output, decides.
      const why = res.error ? `could not start (${res.error.message})` : `exited ${res.code}`;
      const choice = await ui.select(`up ${why} — continue setup?`, ["Continue anyway", "Stop"]);
      if (choice !== "Continue anyway") return;
    }
  }

  // ── (5b) the podman venue, recorded where the service reads it ────────────────────────────────
  if (runtime === "podman") recordPodmanVenue(dir, fs, notify, platform, readBackFn);

  // ── (6) the deployment pointer ─────────────────────────────────────────────────────────────────
  // The four cwd-default files need pointing because resolvePaths defaults them to "./", which is right
  // only when pi runs FROM the deployment dir. VALKEY_URL's default already matches the container `up`
  // starts, so it stays out. Absolute paths by pointer contract (a relative value is dropped).
  //
  // logsDir and settingsFile are deliberately NOT here, and the reason changed with issue #290 even
  // though the answer did not. They used to be excluded because they defaulted to `<OS temp>/pi-dispatch`,
  // a path both sides resolved identically. They default to `~/.pi-dispatch` now, which is per ACCOUNT --
  // and they are still excluded, because every deployment this tooling installs runs the worker as the
  // INVOKING user: `service install --user` strips the template's `User=pi` outright (systemd rejects it
  // in user scope) and `--system` rewrites it to the invoking user, while launchd gets a LaunchAgent. So
  // the worker and this panel share an account and resolve the same two paths with nothing written down.
  //
  // Pinning them here would be worse than useless: the pointer moves only the PANEL, so unless the same
  // two values also reach the worker's own environment the two would read different directories -- an
  // empty run list and panel-set caps landing where the worker never looks. The one shape where the
  // accounts genuinely differ is a hand-rolled unit whose `User=` the operator edited, and the fix there
  // belongs in that operator's `.env`, which is exactly what all three deploy templates now say.
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
  await offerTriggerEdge(dir, ctx, ui, notify, { fs, platform, env, execPath, cliPath, runAttachedFn, runtime, dockerQueryFn, claimOwnerFn });

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
  { fs, platform, env, execPath, cliPath, runAttachedFn, runtime = "docker", dockerQueryFn = dockerQuery, claimOwnerFn = async (_u: string, folder: string) => ({ owner: folder, claimed: false }) }: any,
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

  if (choice === EDGE_COMPOSE && runtime === "podman") {
    // Kept in the list so the answers read the same on every host, and explained rather than attempted: the compose
    // file drives docker, which this host was set up without, and its receiver would also start a SECOND Valkey beside
    // the Quadlet one. The receiver unit (the first answer) runs on the host and needs no container runtime at all.
    notify?.(
      `the receiver container needs docker compose, and this deployment runs on rootless Podman without docker. Install the receiver as a service instead (it needs no container runtime): node ${cliPath} service install --receiver  (in ${dir}), after installing ${RECEIVER_PKG}@${RECEIVER_VERSION} there`,
      "info",
    );
    return;
  }

  if (choice === EDGE_COMPOSE) {
    // The compose file the RUNTIME ships (worker/deploy/docker-compose.yml, published in its `files`), copied into the
    // deployment folder so `-f` names a stable path the operator can edit and keep. CREATE-ONLY, the import-pi.mjs:294
    // idiom the root package.json already follows: an operator who tuned their compose file must never lose it to a
    // re-run of the wizard.
    //
    // Into `<dir>/deploy/`, the layout the file is written for: its relative paths resolve against its OWN directory
    // (the Compose spec, for `env_file` and bind mounts alike), and it names `../.env`, `../triggers.json`,
    // `../egress-allowlist.conf`, `../model-endpoints.conf` (issue #503, scaffolded by `init`, which `up` runs earlier in
    // this wizard) and `./egress-proxy.conf`. Copied to `<dir>/docker-compose.yml`, as it was until issue
    // #468's follow-up, every `../` reached the folder ABOVE the deployment, so the receiver container read another
    // directory's .env and triggers. Beside it goes the proxy's rules file its `./egress-proxy.conf` names, also
    // create-only, so `--profile egress` finds it too. The command is then the one the docs give, run from `dir`:
    // `docker compose --env-file .env -f deploy/docker-compose.yml ...`. Rewriting the paths on copy was the other way,
    // rejected: a copy that differs from the shipped file cannot be compared with it or diffed against a newer one.
    const deployDir = join(dir, "deploy");
    const copies: Array<[string, string, boolean]> = [
      [join(runtimeDirFor(dir), "deploy", "docker-compose.yml"), join(deployDir, "docker-compose.yml"), true],
      [join(runtimeDirFor(dir), "deploy", "egress-proxy.conf"), join(deployDir, "egress-proxy.conf"), false],
    ];
    const dest = copies[0][1];
    for (const [src, to, required] of copies) {
      if (fs.existsSync(to)) {
        // Neutral (PR #488's review): `pi-dispatch init` writes deploy/egress-proxy.conf itself now, so an existing file here is
        // as often init's copy as one the operator edited.
        notify?.(`${to} already exists: kept as it is (setup never overwrites an existing file)`, "info");
        continue;
      }
      try {
        fs.mkdirSync(deployDir, { recursive: true });
        fs.copyFileSync(src, to);
        notify?.(`copied the runtime's ${src.split(/[\\/]/).pop()} to ${to}`, "info");
      } catch (err: any) {
        if (!required) {
          notify?.(`could not copy ${src}: ${err?.message ?? err}: only the egress profile needs it, not the receiver`, "warning");
          continue;
        }
        notify?.(
          `could not copy ${src}: ${err?.message ?? err} — the receiver profile needs that file; skipping this step (install the runtime first, or copy it by hand)`,
          "error",
        );
        return;
      }
    }
    // PR #475's review: the project is named after the FOLDER, as compose named the copy that sat at its top, since
    // compose names a project after the directory of its first file and that is now `deploy/` for every deployment.
    const project = composeProjectName(dir);
    const legacy = join(dir, "docker-compose.yml");
    if (fs.existsSync(legacy)) {
      notify?.(
        `${legacy} is an earlier setup's copy: its ../ paths reach the folder above ${dir}, so it is not used. It ran as compose project "${project}" (its volume ${project}_valkey-data), which the command below keeps with -p ${project}. ${dest} is the one to run; move any edits of yours there, then remove it`,
        "warning",
      );
    }
    // ONE Valkey for the worker and the receiver (PR #475's review). `up`, earlier in this wizard, started
    // `pi-dispatch-valkey`, which is what the worker dials; compose's own `valkey` would then fail to bind that port,
    // or, started, be a second Valkey the receiver (dialling `valkey:6379`) enqueues into while the worker drains the
    // other. So while up's container EXISTS and is this deployment's (round 2: an override already on disk from an
    // earlier pass is no reason to leave a second Valkey running; round 3: another deployment's is never touched), compose's valkey takes over up's VOLUME through an
    // override (written once, create-only, then named in every command for this folder, `up`'s included): the images
    // are pulled first, while up's Valkey still serves; then up's container is stopped (SIGTERM: the AOF is written out)
    // and removed, and compose's valkey starts on the same data. Both are published on VALKEY_URL's port
    // (PI_VALKEY_PORT). A compose that fails after the removal puts the override back as it found it and names the way
    // back: `pi-dispatch up` starts pi-dispatch-valkey on its volume again.
    // Rejected: pointing the containerised receiver at the host's Valkey, which is bound to 127.0.0.1 and so
    // unreachable from a bridge network on Linux; and letting `up` skip its Valkey, which would ask the edge question
    // before `up` and leave the worker without a queue until this step.
    const override = join(dir, COMPOSE_VALKEY_OVERRIDE);
    const hasOverride = fs.existsSync(override);
    const port = composeValkeyPort(dir, fs);
    // Round 3 of PR #475's review: up's container is handed over only when it is PROVABLY this deployment's (its label
    // naming this folder, or, unlabelled, publishing this deployment's VALKEY_URL port), and nothing starts on its volume
    // while a container that is not this deployment's mounts it; the rule is `composeHandoverPlan`, shared with a test on
    // a real docker. Measured before it: this step stopped and removed ANOTHER deployment's pi-dispatch-valkey.
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {
      // Unresolvable: the folder as given.
    }
    const plan = await composeHandoverPlan({ dirs: [real, dir], port, override: hasOverride, query: (cmd: string, args: string[]) => dockerQueryFn(cmd, args), record: readVolumeRecord(dir, fs) });
    if (plan.refused) {
      notify?.(`the receiver container was not started: ${plan.refused}`, "error");
      return;
    }
    if (plan.note) notify?.(plan.note, "warning");
    // An unlabelled pi-dispatch-valkey-data that no container of this deployment serves and this folder has no record of
    // (the volume gap): its queue cannot be attributed. The wizard does not adopt it (PR #475's round-cap re-review):
    // `pi-dispatch up` does, on a question `--yes` does not answer, reads the queue's owner marker with a Valkey that has
    // no network before any is published, and records the adoption here, after which this step uses the volume.
    if (plan.adopt) {
      notify?.(`the receiver container was not started: pi-dispatch-valkey-data has no owner label and this folder has no record of adopting it (this volume holds a queue pi-dispatch cannot attribute to a folder). Run \`node ${cliPath} up\` in ${dir}: it asks whether to adopt it, checks whose queue it holds before starting anything on it, and records the answer; then run /dispatch setup again`, "error");
      return;
    }
    const handover = plan.handover;
    const useOverride = hasOverride || handover;
    const composeEnv: any = { ...env, [VALKEY_PORT_KEY]: String(port) };
    // Never a shell's VALKEY_PASSWORD (round-cap re-review, measured: compose prefers the environment over
    // `--env-file .env`, so an exported one became the Valkey's password): the deployment's comes from `.env`, as `up`
    // hands docker the deployment's and never the shell's.
    delete composeEnv[VALKEY_PASSWORD_KEY];
    const base = composeArgs({ project, override: useOverride });
    // `--profile receiver` is what makes the receiver container OPT-IN: the same compose file's plain
    // `up` is Valkey-only, which is what a worker-on-host deployment wants.
    // `--env-file` names the deployment's .env for compose's own interpolation (issue #468): the Valkey in this file takes
    // VALKEY_PASSWORD from it, and without it a compose run elsewhere started that Valkey with no password.
    // Relative to `dir`, the cwd it runs in: exactly the command the docs give.
    const args = [...base, "--profile", "receiver", "up", "-d"];
    // The pull names the override only when it is ALREADY on disk: it runs before the override is written (the images do
    // not depend on it), and compose refuses a -f that does not exist (measured on Fedora 44, compose 5.5.1: "compose
    // file ... is invalid: ... no such file or directory", which stopped the hand-over at its first step).
    const pull = [...composeArgs({ project, override: hasOverride }), "--profile", "receiver", "pull"];
    const portPrefix = port !== 6379 ? `${VALKEY_PORT_KEY}=${port} ` : "";
    const shown = `${portPrefix}docker ${args.join(" ")}`;
    const shownPull = `${portPrefix}docker ${pull.join(" ")}`;
    const writeLine = handover && !hasOverride ? `write ${override}:\n${VALKEY_HANDOVER_OVERRIDE.replace(/^/gm, "      ")}` : "";
    const handoverLines = handover
      ? `${shownPull}   (the images, while up's Valkey still serves)\n  ${writeLine ? `${writeLine}\n  ` : ""}docker stop pi-dispatch-valkey   (a job running right now is interrupted)\n  docker rm pi-dispatch-valkey\n  `
      : "";
    const ok = await ui.confirm(
      "Start the receiver container",
      `Run in ${dir}:\n  ${handoverLines}${shown}\n\nthe receiver profile reads ${join(dir, ".env")}: WEBHOOK_SECRET and the forge credentials must be in there, or the container refuses to boot.`,
    );
    if (!ok) {
      // The whole of what would have run, the override's contents included, so it can be done by hand.
      notify?.(`later: ${handover ? `${shownPull}; ${writeLine ? `write ${override} with:\n${VALKEY_HANDOVER_OVERRIDE}` : ""}docker stop pi-dispatch-valkey && docker rm pi-dispatch-valkey; then ` : ""}${shown}  (in ${dir})`, "info");
      return;
    }
    // PI_VALKEY_PORT into .env where VALKEY_URL's port is not 6379 (round 3), so the docs' plain compose command in this
    // folder publishes where the worker dials; a different value already there is named and never overwritten.
    try {
      const envPath = join(dir, ".env");
      if (fs.existsSync(envPath)) {
        // Read through issue #471's one reader; a line it could not read counts as a value (never written over).
        const read: any = deploymentServiceEnv({ env: {}, dir, keys: [VALKEY_PORT_KEY], fs, platform: "linux" });
        const found = read.fromFile[VALKEY_PORT_KEY] ?? (read.unread.length > 0 || read.hazardSkipped.length > 0 || read.untrusted ? "?" : undefined);
        const decided: any = valkeyPortEnvDecision(found, port, { envPath });
        if (decided.conflict) notify?.(decided.conflict, "warning");
        else if (decided.write && updateEnvFile(envPath, VALKEY_PORT_KEY, decided.write, { fs, platform }).changed) notify?.(`wrote ${VALKEY_PORT_KEY}=${port} into ${envPath} (VALKEY_URL's port)`, "info");
      }
    } catch (err: any) {
      notify?.(`${VALKEY_PORT_KEY} could not be written into .env: ${err?.message ?? err}; the commands below pass it themselves`, "warning");
    }
    const step = async (argv: string[], title: string, stepEnv = env) => {
      const res = await runAttachedFn(ctx, { title: `${title} (in ${dir})`, argv0: "docker", args: argv, cwd: dir, env: stepEnv });
      return !(res?.error || res?.code !== 0);
    };
    // After compose's valkey started on pi-dispatch-valkey-data: the queue's own pi-dispatch:owner, recorded where it
    // is missing, checked where it is not; another folder's stops compose's valkey again at once.
    const ownerMarker = async () => {
      const r: any = await claimOwnerFn(`redis://127.0.0.1:${port}`, real, dir, env);
      if (r?.error) {
        notify?.(`compose's valkey started, but its ${OWNER_MARKER_KEY} could not be recorded or read (${r.error}), so whose queue it holds is unconfirmed; \`node ${cliPath} up\` (in ${dir}) checks it again`, "error");
        return;
      }
      if (r.owner !== real && r.owner !== dir) {
        const stopped = await step([...base, "stop", "valkey"], `docker ${[...base, "stop", "valkey"].join(" ")}`, composeEnv);
        notify?.(`${foreignMarkerRefusal(r.owner)}: compose's valkey was ${stopped ? "stopped again at once" : "NOT stopped (the stop failed): stop it now"}`, "error");
        return;
      }
      if (r.claimed) notify?.(`recorded ${OWNER_MARKER_KEY}=${real} in the queue on pi-dispatch-valkey-data`, "info");
    };
    if (handover) {
      if (!(await step(pull, shownPull, composeEnv))) {
        notify?.(`${shownPull} failed; up's Valkey was left running and nothing else was done`, "error");
        return;
      }
      let wrote = false;
      if (!hasOverride) {
        try {
          fs.writeFileSync(override, VALKEY_HANDOVER_OVERRIDE, { flag: "wx" });
          wrote = true;
        } catch (err: any) {
          notify?.(`could not write ${override}: ${err?.message ?? err}; nothing was stopped, and the receiver was not started`, "error");
          return;
        }
      }
      const putBack = () => {
        if (!wrote) return "";
        try {
          fs.unlinkSync(override);
          return ` ${override} was removed again.`;
        } catch {
          return ` ${override} could not be removed: remove it before running \`pi-dispatch up\`.`;
        }
      };
      if (!(await step(["stop", "pi-dispatch-valkey"], "docker stop pi-dispatch-valkey"))) {
        notify?.(`docker stop pi-dispatch-valkey failed; up's Valkey runs as it was, and the receiver was not started.${putBack()}`, "error");
        return;
      }
      if (!(await step(["rm", "pi-dispatch-valkey"], "docker rm pi-dispatch-valkey"))) {
        notify?.(`docker rm pi-dispatch-valkey failed; up's Valkey is STOPPED. \`docker start pi-dispatch-valkey\` brings it back on its volume.${putBack()}`, "error");
        return;
      }
      if (!(await step(args, shown, composeEnv))) {
        notify?.(`${shown} failed after up's Valkey was removed: NO Valkey runs now. Its volume, pi-dispatch-valkey-data, and the queue in it are kept: \`node ${cliPath} up\` (in ${dir}) starts pi-dispatch-valkey on it again.${putBack()} Compose's own output above says why it failed`, "error");
        return;
      }
      await ownerMarker();
      // The volume up's own container served, unlabelled: recorded here (create-only, 0600), so a later `up` in this
      // folder takes it as this deployment's without asking (round-cap re-review).
      if (plan.record) {
        try {
          fs.writeFileSync(join(dir, VALKEY_VOLUME_RECORD), volumeRecordText(plan.record), { mode: 0o600, flag: "wx" });
        } catch (err: any) {
          if (err?.code !== "EEXIST") notify?.(`the volume could not be recorded in ${join(dir, VALKEY_VOLUME_RECORD)} (${err?.message ?? err}); a later \`up\` asks about it`, "warning");
        }
      }
      return;
    }
    if (!(await step(args, shown, composeEnv))) {
      notify?.(`${shown} failed; compose's own output above says why (another container on 127.0.0.1:${port} is the usual one)`, "error");
      return;
    }
    if (useOverride) await ownerMarker();
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
    `trigger edge left for later: ${runtime === "podman" ? "two ways stay open" : "all three ways stay open"} from ${dir}: \`service install --receiver\` (a receiver unit on this host), ${runtime === "podman" ? "no receiver container on rootless Podman (it needs docker compose: run the receiver as that service instead)" : "a receiver container (run /dispatch setup again and choose it: that copies in deploy/docker-compose.yml and runs its \`--profile receiver up -d\`)"}, or \`npx @edgehero/pi-dispatch-receiver poll\` (no public URL at all). Local cron triggers need none of them.`,
    "info",
  );
}

/**
 * The wizard's own condition on the edited `.env` (gate round 2): read the way `service install` will read it, the new
 * text must give PI_BACKENDS=podman with the other two venue keys as they were. A BACKSTOP behind the writer's own
 * read-back (`updateEnvFile`), which since gate round 3 refuses every such case first, so no file reaches this today;
 * it stays so that a gap in that read-back cannot turn into a venue the service does not run, and `readBackFn` is a seam
 * so a test can pin it with a reading that fails.
 */
function podmanWriteVerify(envPath: string, prior: any, readBackFn: any = readStackKeys) {
  return (next: string): string | null => {
    const after: any = readBackFn(next, { loader: "systemd", path: envPath });
    if (after.error) return `after the edit ${after.error}`;
    if (after.keys.PI_BACKENDS !== "podman") return "after the edit systemd would not read PI_BACKENDS as podman";
    for (const key of ["PI_EGRESS", "PI_EGRESS_PROXY"]) {
      if (after.keys[key] !== prior[key]) return `the edit would change what systemd reads for ${key}`;
    }
    return null;
  };
}

/**
 * Step 5b's body: the one `.env` line the podman answer implies, `PI_BACKENDS=podman`, written through the worker's
 * never-clobber writer so a value the operator set survives. Only into a `.env` that exists (init, inside `up`, makes
 * it): inventing one would stop init from ever scaffolding the real file. Without this line `service install` reads
 * the default list, `local`, and installs a docker worker on a host that has no docker.
 */
function recordPodmanVenue(dir: string, fs: any, notify: Notify, platform: string, readBackFn: any = readStackKeys): void {
  const envPath = join(dir, ".env");
  if (!fs.existsSync(envPath)) {
    notify?.(`no ${envPath} yet (\`up\` runs init, which writes it): add PI_BACKENDS=podman to it before \`service install\`, which reads only that file`, "warning");
    return;
  }
  // Refused BEFORE the write, and the file left as it is: a line systemd reads differently would make the key this
  // writes one the service may never see, and the next `up` or `service install` refuses the file anyway.
  const before = deploymentBackends(dir, fs, { writing: true, platform, readBackFn });
  if ("unreadable" in before) {
    notify?.(`${before.unreadable}. PI_BACKENDS=podman was NOT written into ${envPath}, which is unchanged: make that change, then add PI_BACKENDS=podman before \`service install\``, "warning");
    return;
  }
  const priorRead: any = readStackKeys(fs.readFileSync(envPath), { loader: "systemd", path: envPath });
  const verify = podmanWriteVerify(envPath, priorRead.keys ?? {}, readBackFn);
  try {
    if (updateEnvFile(envPath, "PI_BACKENDS", "podman", { fs, platform, verify }).changed) {
      notify?.(`PI_BACKENDS=podman written into ${envPath}: the worker and \`service install\` read the podman venue from there`, "info");
      return;
    }
    const file = deploymentBackends(dir, fs);
    if ("unreadable" in file) {
      notify?.(`${file.unreadable}. Make that change, with PI_BACKENDS on a plain PI_BACKENDS=podman line, before \`service install\``, "warning");
    } else if (!venuesOf({ PI_BACKENDS: "value" in file ? file.value : undefined }).podmanUsed) {
      notify?.(`${envPath} already sets PI_BACKENDS to something without podman; left untouched (setup never overwrites a key you set). Add podman to it yourself if this deployment is meant to run there`, "warning");
    }
  } catch (err: any) {
    notify?.(`could not write PI_BACKENDS into ${envPath}: ${err?.message ?? err}. Add PI_BACKENDS=podman yourself before \`service install\``, "error");
  }
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
  pi.on("session_start", (event: any, rawCtx: any) => {
    // THE SIXTH DOOR (issue #404). A `ctx` arrives here straight from pi and never passes the command
    // handler, so the gates there do not reach it. Its one notify is a CONSTANT today, which is why this is
    // completeness rather than a leak -- but "a door is anywhere a ctx enters from pi" is the rule, and a
    // door left out because its current message happens to be safe is how the render gates were refuted.
    const ctx = gateDialogs(rawCtx);
    try {
      // Only a real interactive startup: reload/resume/fork repeat within a configured workflow, and
      // without a UI there is nobody to nudge (and no notify to carry it).
      if (event?.reason !== "startup" || !ctx?.hasUI) return;
      // A PRESENT pointer -- valid or broken -- means the operator has been here; /dispatch itself
      // surfaces broken-pointer notices, so the nudge stays quiet on anything but true absence.
      if (!(readPointer({ path: pointerPath(env), fs }) as any).absent) return;
      // All seven here (VALKEY_URL included), unlike detection's env branch: with no probe
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
