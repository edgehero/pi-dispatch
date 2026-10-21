/**
 * pi-dispatch admin extension.
 *
 * A pi extension that adds a `/dispatch` command for operating a pi-dispatch
 * deployment (status, pause, resume, runs, logs, budget, triggers, settings).
 *
 * Loading: the operator's own pi supplies `ExtensionAPI` at runtime. Three ways
 * to load it, all on the operator's host:
 *   - `pi -e admin/src/index.ts` (explicit, one session)
 *   - an entry in the `extensions` array of `~/.pi/agent/settings.json`
 *   - the in-repo `.pi/extensions/dispatch.ts` shim, which pi loads only after
 *     the operator trusts this checkout (trust gating)
 *
 * A job container CAN reach this. The job loader runs `noExtensions: false`, so a
 * serviced repo's `.pi/extensions` is discovered -- including this repo's own shim
 * when pi-dispatch services itself. The runner's recursion guard is what keeps it
 * out of the session: it drops admin-like extensions from the loaded set (by entry
 * name, and by the `dispatch_*` tools below) and logs the drop.
 *
 * The extension is a thin channel over the read-model and the renderers: it
 * parses the subcommand, calls `read-model.mjs` for data and `render.mjs` for
 * text, and picks the output channel. PII-free records go to `sendMessage`
 * (they may enter later model context, which is accepted per REQ); raw `.log`
 * bytes go ONLY to the overlay viewer, never to a message.
 *
 * It also registers LLM-callable tools: reads (`dispatch_status`, `dispatch_runs`,
 * `dispatch_costs`, `dispatch_triggers`), the durable-but-reversible on/off controls (`dispatch_pause`/
 * `dispatch_resume`), the gated PAID enqueue (`dispatch_run`), and the confirm-gated
 * writes (`dispatch_set`, `dispatch_trigger_add`/`_edit`/`_delete`) -- each of which
 * refuses unless a human operator approves a confirmation dialog showing the concrete
 * change. There is still no log tool (raw `.log` bytes never enter model context), and
 * a live dashboard overlay renders on the bare `/dispatch` command. The extension also
 * ships an `operate-pi-dispatch` skill, advertised via `resources_discover`, that tells
 * the model how to use those human-in-the-loop write gates.
 *
 * `/dispatch setup` (issue #92) runs the guided deployment wizard (setup-wizard.ts); a bare
 * `/dispatch` on a host with no deployment at all ENTERS it directly -- the wizard's own first
 * select is the consent -- and a one-time session_start nudge names it on a fresh host. The
 * wizard sequences the worker CLI's own consented commands and writes the deployment pointer
 * this factory applies above. A bare `/dispatch` against a POINTED-AT deployment whose installed
 * runtime differs from the pinned one says so once per process, and names setup as the fix.
 *
 * Tested pi version: SUPPORTED_PI_VERSION below. The gate is the capability
 * probe, not the version: the factory registers nothing unless every API member
 * it consumes is present; on a miss it names the member and the tested version
 * on stderr and returns. A pi that DIFFERS from the pin but passes the probe
 * loads normally -- the mismatch becomes a one-line info advisory drained by the
 * next /dispatch, never a refusal (issue #96: a merely newer pi must not scare
 * or block anyone).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// A VALUE import, deliberately its own line: the type-only line above is regex-anchored by
// pinned-extension-api.test.mjs and must keep its exact shape. VERSION is the HOST's pi version --
// build.mjs keeps pi external, so this resolves against whatever pi actually loaded the extension.
import { VERSION } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  resolvePaths,
  panelEnv,
  readQueueState,
  readSchedulers,
  readBudget,
  listRuns,
  listRunsMerged,
  readRun,
  readLogTail,
  readSettingsView,
  readTriggers,
  renderSecretBundles,
  secretBundlesView,
  modelRunRecord,
  withoutOperatorOnly,
  readPauseWindows,
  readScopedLimits,
  readScopedBudget,
  hostBudgetsOf,
  readCapacity,
  readDollarWindows,
  readHeldJobs,
  cancelHeldJob,
  listRunIds,
  setQueuePaused,
  killSwitchSet,
  killSwitchPlan,
  installPanelValkeyContext,
  writeSettings,
  writeTriggers,
  writePauseWindows,
  writeScopedLimits,
  writeInputs,
  readProjects,
  writeProjects,
  enqueueDispatchRun,
  KNOWN_KEYS,
  DEPLOYMENT_SCAFFOLD_FILES,
  readEnvelope,
  readAllocations,
  writeEnvelope,
  applyPriorities,
  revertAllocation,
  envelopeJobCap,
  createFleetReader,
  planParkedAnswer,
  enqueueParkedAnswer,
  sandboxShellRefusal,
} from "./read-model.mjs";
// The operator session's write guard (issue #504 part C): pi's own `write`, `edit` and `powershell` blocked on the
// deployment's money files, which only the confirm-gated tools and the operator's own hand may change.
import { envNamedFiles, makeWriteGuard } from "./write-guard.mjs";
import { consolePageLines } from "./console/link.mjs";
import { CONSOLE_PAGE_WORDS, consoleCommand } from "./console-command.mjs";
import { loginCodesDir } from "./console/login-codes.mjs";
import { WHATIF_MODEL_RE } from "./console/whatif.mjs";
import { SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
// The insights payload's assembly, pi-free so the operator console shares it (issue #641). The allocation seams live
// there too, because its split reads through them; the tests keep reaching them, and the slices, through this module.
import {
  assembleCosts as assembleCostsOf,
  assembleAllocationView as assembleAllocationViewOf,
  assembleSizingView as assembleSizingViewOf,
  assembleCapacityView as assembleCapacityViewOf,
  projectSizing as projectSizingOf,
  envelopeProblem,
  allocRedis,
  allocNow,
} from "./insights-assembly.mjs";
export { assembleBudgetView, splitCounts, capacityViewOf, INSIGHTS_CAPACITY_BUCKET_MS, INSIGHTS_CAPACITY_NAMES_SHOWN, _setAllocationSeamsForTests } from "./insights-assembly.mjs";
import { valkeyDownHint } from "@edgehero/pi-dispatch/valkey-auth";
// The trigger vocabularies, IMPORTED from the loader that validates them rather than retyped. Every one
// of these was a hand-written copy of a table one package over, and this is the surface a MODEL authors
// triggers through -- so both drift directions are silent and both are expensive. A widened loader table
// that never reaches the hint means the model is told a word does not exist and never writes it: a
// capability lost with no error anywhere. A narrowed one means the model proposes an entry, the operator
// approves a confirm dialog, and writeTriggers rejects it: a wasted human approval. `blessedBackends`
// below is the precedent, and its header is a post-mortem of the same mistake.
import { FORGE_KINDS, ON_TYPES, PR_ACTIONS, PR_CLOSE_ACTIONS, REVIEW_STATES } from "@edgehero/pi-dispatch/triggers";
import { formatMicros, parseUsdMicros } from "@edgehero/pi-dispatch/money";
import { formatCpus, formatMemory } from "@edgehero/pi-dispatch/job-size";
import { SUGGEST_WINDOW_DAYS, coresText, cpusText, notEnoughRunsText } from "@edgehero/pi-dispatch/size-suggest";
import { runDollars } from "./dollar-windows.mjs";
import { tokensFilePath } from "@edgehero/pi-dispatch/console-tokens";
import { defaultWorkerName } from "@edgehero/pi-dispatch/config";
// The deployment pointer (INT-DEPLOYMENT-POINTER-CONTRACT): the wizard-written file that aims this
// extension at a deployment built in another directory. Layered into process.env once at factory load
// (the operator's env always wins), so resolvePaths stays env-only by contract while every one of its
// call sites below is covered without a signature change.
// readPointer/pointerPath join the import for ONE reader: the bare command's version-skew notice, which
// needs the pointed-at `deploymentDir` to find the deployment's installed runtime. readPointer stays pure
// (it never stats that dir) -- the stat lives at the call site below, which is exactly where the pointer
// module's documented purity says it belongs.
import { applyDeploymentPointer, pointerPath, pointerState, readPointer, takePointerNotice } from "./deployment-pointer.mjs";
// The only fs use in this module: the skew notice reads one package.json through the wizard's own reader.
// Everything else fs-shaped goes through read-model.mjs by design.
import * as nodeFs from "node:fs";
// The audit rows' host name for a plan this session applies (issue #504 part C): PI_WORKER_NAME, else this machine's.
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { COSTS_WINDOWS, PROJECT_KEY_RE } from "./costs.mjs";
// The REAL pricing façade. costs.mjs may not hold a module-scope worker/pricing import by contract (the
// fold is pure; tests inject a canned fake) -- index.ts is where the fs-adjacent assembly lives, so the
// injection happens here.
import { getPricedModel, isZeroRated, listPricedModels, piAiVersion, reprice } from "@edgehero/pi-dispatch/pricing";
import { clipData, escapeInterpreted, scrubControls, scrubControlsPerLine, setGlyphs } from "./panel.mjs";
import { gateDialogs } from "./dialog-gate.mjs";
import { openSandbox, sandboxEgress, sandboxLauncher, sandboxSyncRefusal, sandboxVenueOf, sandboxVenuePolicy, sandboxWindowRefusal } from "@edgehero/pi-dispatch/sandbox";
import { readManifest, sandboxDeadline } from "@edgehero/pi-dispatch/sandbox-store";
import { sizeBits, renderStatus, renderRuns, renderBudget, renderScopedLimits, renderTriggers, renderSettingsView, renderAllocations } from "./render.mjs";
import { makeDashboard, createDashboardDeps, switchFailure, withAuditedWrites } from "./dashboard.ts";
// `/dispatch chat` (issue #647, part 2): pi-free, so its tests drive it with fakes; `chatIo` below wires it.
import { CHAT_USAGE, dispatchChat } from "./dispatch-chat.mjs";
// Only the nudge is loaded eagerly (it must register its session_start handler at factory time); the
// wizard itself stays behind the dispatch handler's lazy import. The setup-wizard module imports
// buildTriggerEntry back from here -- a cycle on paper, but both sides only call across it at runtime.
import { registerNudge } from "./setup-wizard.ts";
import { matchesKey } from "./keys.mjs";
// The pre-confirm half of every write (issue #642): build, judge with the worker's own validators, and say what the
// confirm shows. Pi-free so the operator console refuses with these same words; the tools and commands below run the
// plan, confirm, then call the read-model funnel. The builders the tests reach through this module are re-exported.
import {
  buildPauseWindow,
  buildScopedLimit,
  buildTriggerEntry,
  envelopeGuard,
  limitSummary,
  liveOr,
  planEnvelope,
  planLimitAdd,
  planLimitDelete,
  planLimitEdit,
  planPauseWindowAdd,
  planPauseWindowDelete,
  planPauseWindowEdit,
  planPriorities,
  planProjectAdd,
  planProjectDelete,
  planProjectEdit,
  planSettingChange,
  planSettingSet,
  planSettingUnset,
  planTriggerAdd,
  planTriggerDelete,
  planTriggerEdit,
  projectShown,
  scopeChangeNote,
  sizeFieldsFrom,
} from "./write-plans.mjs";
export { blessedBackends, buildTriggerEntry, ISSUE_CLOSE_WORD, SIZE_FIELD_RIDES, scopeChangeNote } from "./write-plans.mjs";
// One audit chain (issue #642): every write this extension makes, from a tool, a command or the panel, lands in the
// operator console's audit log as actor `panel`, appended BEFORE the write (`audited-write.mjs`).
import { panelWrite } from "./audited-write.mjs";

// The single source of truth for the ExtensionAPI surface this extension
// consumes. It grows only when a task actually uses a new member.
export const USED_API = ["registerCommand", "registerTool", "sendMessage", "on"] as const;

export const SUPPORTED_PI_VERSION = "1.2.0";

/**
 * The advisory for running on a pi that is not the tested pin (issue #96). Pure over its two inputs
 * so the comparison is unit-testable without faking a pi install. Equal versions mean nothing to
 * say; pi's own "0.0.0" fallback (config.js: `VERSION = pkg.version || "0.0.0"` when its
 * package.json is unreadable) means UNKNOWN, not different -- comparing it would report a bogus
 * mismatch on an install the capability probe already vets for real.
 */
export function computePiVersionAdvisory(version: string, supported: string): string | undefined {
  if (version === supported || version === "0.0.0") return undefined;
  return (
    `pi-dispatch admin: running on pi ${version}, tested with pi ${supported} — things should ` +
    `work; report anything odd, and check for a newer @edgehero/pi-dispatch-admin`
  );
}

// The retained advisory, drained once by the next /dispatch (the takePointerNotice idiom). Computed
// at factory time but NEVER printed there: a successful load is silent, and load.test.mjs pins the
// refusal path to exactly one stderr line. Memoized like deployment-pointer's appliedOnce -- pi may
// in principle evaluate the factory more than once, and a re-evaluation must not re-arm an advisory
// the operator already saw.
let piVersionAdvisory: string | undefined;
let piVersionCheckDone = false;

/**
 * The deployment/console skew latch -- piVersionAdvisory's twin, and once per PROCESS for the same
 * reason: the two versions cannot change under a running pi, so saying it on every bare `/dispatch`
 * would be nagging, not informing. Set only when the notice actually fires, so a session that never
 * had skew never burns the latch.
 */
let runtimeSkewNoticed = false;

// Issue #471: the one line `panelEnv` has about the deployment's `.env` (a key pi's environment sets differently, a
// line it could not read), drained by the next /dispatch like the pointer's notice, and said again only when it
// changes, so a standing disagreement is one warning per session and not one per keystroke.
let serviceEnvNoticePending: string | undefined;
let serviceEnvNoticeShown: string | undefined;

/**
 * Issue #471: the environment every `resolvePaths` call and the host-routing name read: pi's own, with the deployment's
 * `.env` filling what pi's does not set, by the rule doctor judges the service by (`panelEnv`, the worker's shared
 * resolver). The deployment is the pointer's folder and nothing else (a repository pi starts in can commit init's
 * scaffold, gate round 1); with no pointer, this is `process.env` exactly as before. Read per call, like
 * `resolvePaths` itself, so an edit to `.env` reaches the next command without a restart.
 */
function deploymentEnv(): any {
  const { deploymentDir, owned } = pointerState();
  const { env, notice } = panelEnv({ env: process.env, pointerDir: deploymentDir, owned });
  if (notice && notice !== serviceEnvNoticeShown) serviceEnvNoticePending = notice;
  return env;
}

/** This host's worker name, the way the worker resolves its own: the deployment's PI_WORKER_NAME, else the sanitized hostname. */
function thisWorkerName(): string {
  const declared = deploymentEnv()?.PI_WORKER_NAME;
  return typeof declared === "string" && declared !== "" ? declared : defaultWorkerName();
}

/**
 * The dashboard's LIVE_TAIL `.log` read (exported for its wiring test): `readLogTail`'s result verbatim, told the job's
 * host and this host's name, so a run on another host with no local log comes back `{ missing, elsewhere }`.
 */
export function panelTailLog(paths: any) {
  return ({ jobId, lines, host }: { jobId: string; lines: number; host?: string | null }) => readLogTail({ logsDir: paths.logsDir, jobId, lines, host: host ?? null, self: thisWorkerName() });
}

/** TEST-ONLY: arm the advisory directly (under the pinned devDep pi the natural computation is a no-op). */
export function _setPiVersionAdvisoryForTests(message: string | undefined): void {
  piVersionAdvisory = message;
}

const CHANNEL = "pi-dispatch-admin";


const USAGE =
  "usage: /dispatch <status|pause|resume|run|runs|logs|chat|budget|insights|console|triggers|settings|set|unset|priorities|setup|secrets>";

const KNOWN_SUBCOMMANDS = [
  "status",
  "pause",
  "resume",
  "run",
  "runs",
  "logs",
  "chat",
  "budget",
  "insights",
  "console",
  "triggers",
  "settings",
  "set",
  "unset",
  "priorities",
  "setup",
  "secrets",
] as const;

export default function admin(pi: ExtensionAPI): void {
  for (const member of USED_API) {
    if (typeof (pi as Record<string, unknown>)[member] !== "function") {
      console.error(
        `[pi-dispatch/admin] refusing to load: pi is missing '${member}'. ` +
          `This extension supports pi ${SUPPORTED_PI_VERSION}.`,
      );
      return;
    }
  }

  // The probe above is the gate; the version is only an advisory (issue #96). A pi that differs
  // from the tested pin yet still carries every consumed member must not scare or block anyone, so
  // the mismatch is computed here -- after the probe PASSES, so a refused load stays a one-line
  // no-op -- and surfaced by the next /dispatch, never printed at load.
  if (!piVersionCheckDone) {
    piVersionCheckDone = true;
    piVersionAdvisory = computePiVersionAdvisory(VERSION, SUPPORTED_PI_VERSION);
  }

  // Layer the setup wizard's deployment pointer into process.env exactly once, before anything can call
  // resolvePaths(deploymentEnv()). Placement matters twice over: AFTER the capability probe, so a refused
  // load stays a complete no-op (an extension that registers nothing must not mutate the env either);
  // and at the FACTORY top rather than inside the /dispatch handler, because resolvePaths runs
  // per-command AND per LLM tool call -- an operator who never types /dispatch but lets the model call
  // dispatch_status still needs the pointer's paths in place before the first resolve. The try/catch is
  // the never-throw doctrine: an extension factory must never fail to load over a bad pointer file; the
  // retained notice (surfaced on the next /dispatch) is the error channel, not an exception.
  try {
    applyDeploymentPointer();
  } catch {
    // Deliberately swallowed: applyDeploymentPointer degrades internally ({ ignored } + notice), so
    // anything reaching here is unexpected -- and still must not take the whole extension down.
  }
  // Issue #468 over issue #471: every Valkey client of the panel takes its password (and its facts about the
  // deployment's Valkey) from the pointer's folder through the one `.env` reader the panel has, never another.
  installPanelValkeyContext();

  pi.registerCommand("dispatch", {
    // The operator-visible summary; a subcommand once went missing from it while USAGE carried it,
    // which is exactly the drift the USAGE/KNOWN_SUBCOMMANDS pin exists to catch -- keep all three
    // in step.
    description:
      "pi-dispatch admin: status|pause|resume|run|runs|logs|chat|budget|insights|console|triggers|settings|set|unset|priorities|setup",
    getArgumentCompletions: (prefix) => completeArguments(prefix),
    handler: async (args, ctx) => dispatch(pi, args, ctx),
  });

  registerTools(pi);
  registerSkill(pi);
  registerNudge(pi);
  registerWriteGuard(pi);
}

/**
 * The write guard (issue #504 part C, `write-guard.mjs`): a `tool_call` handler that blocks pi's built-in `write` and
 * `edit` (and a `powershell` command naming one) when the target is one of the deployment's money files, or one of the
 * two files that NAME them: the deployment's `.env` and the deployment pointer. `models.json` is not here: the admin
 * never writes it, so no confirm is bypassed by writing it.
 *
 * The set is read per call (a deployment the panel is pointed at after load is guarded from its next call) AND it
 * never shrinks within a session: every file guarded at load, or at any call since, stays guarded. The per-call read
 * goes through the deployment's `.env`, so without the union a session that rewrote where `.env` points could unguard
 * the real file, write it, and point `.env` back (measured in review). `.env` and the pointer are guarded too, for the
 * same reason and for the worker's: a service restart reads them.
 */
function registerWriteGuard(pi: ExtensionAPI): void {
  const seen = new Map<string, Guarded>();
  const remember = () => {
    for (const g of guardedFiles()) if (!seen.has(g.path)) seen.set(g.path, g);
    return [...seen.values()];
  };
  try {
    remember();
  } catch {
    // A deployment that cannot be read at load is read again at the first call; the guard blocks if it still cannot.
  }
  const guard = makeWriteGuard({ guardedFiles: remember });
  pi.on("tool_call", (event: any, ctx: any) => guard(event, ctx));
}

/**
 * The files the write guard protects, with the label and the tool the model is told to ask for instead. A cwd
 * default (`./triggers.json`, `./scoped-limits.json`, `./projects.json`) is guarded when its key is set (the worker
 * reads that file only then: `config.mjs`, each is null when unset), or, with no pointer, when the session folder is an
 * init scaffold folder (below); otherwise every repository with a file of that name would be refused in a session
 * that has no deployment. The settings overlay's default is the worker's own per-account file, so it is always
 * guarded. A deployment the panel cannot see at all (no pointer, no key, not the folder pi started in) is not.
 */
const CONSOLE_TOKENS_GUARD = { label: "the console tokens file (PI_CONSOLE_TOKENS_FILE)", tool: "`pi-dispatch-console token add`, `revoke` or `rotate`, in the operator's own shell" };

type Guarded = { path: string; label: string; tool: string; dir?: boolean };

/**
 * The console tokens file and, beside it, its one-time login codes (`console-login-codes/`, `loginCodesDir`), guarded
 * as a DIRECTORY: every path under it. The login-codes directory joins the guarded files, as the tokens file is,
 * because a code file there is a sign-in as the token it names: a model that could `write` `<sha256(code)>.json` into
 * it could mint itself a console session as an operator, the same reach as adding a token. Only the operator makes
 * codes (`/dispatch console --link`, `pi-dispatch-console link`); the residual is `bash`, as for the tokens file.
 */
function consoleTokenGuards(tokensPath: string | null): Guarded[] {
  if (tokensPath === null) return [];
  return [
    { path: tokensPath, ...CONSOLE_TOKENS_GUARD },
    { path: loginCodesDir(tokensPath), label: "the console's one-time login codes (console-login-codes, beside the tokens file)", tool: "`/dispatch console --link` or `pi-dispatch-console link`, typed by the operator", dir: true },
  ];
}

/**
 * The console tokens file the panel sees, or null where it sees none: the pointer's deployment folder's (its key, else
 * the default name there); with no pointer, the session folder's when `PI_CONSOLE_TOKENS_FILE` is set or the folder is
 * an init scaffold. ONE helper for the guard and for `/dispatch console --link` (issue #708, review round 1), so the
 * command mints only into the drop beside a tokens file this guard holds, never one it computed some other way.
 */
function consoleTokensPathFor(env: any, dir: unknown): string | null {
  if (typeof dir === "string" && dir !== "") return tokensFilePath(env, dir);
  const cwd = process.cwd();
  if (typeof env?.PI_CONSOLE_TOKENS_FILE === "string" && env.PI_CONSOLE_TOKENS_FILE !== "") return tokensFilePath(env, cwd);
  if (DEPLOYMENT_SCAFFOLD_FILES.every((f) => nodeFs.existsSync(join(cwd, f)))) return tokensFilePath(env, cwd);
  return null;
}

export function guardedFiles(): Guarded[] {
  const env = deploymentEnv();
  const paths = resolvePaths(deploymentEnv());
  const set = (key: string) => typeof env?.[key] === "string" && env[key] !== "";
  const dir = pointerState().deploymentDir;
  const out = [
    { path: paths.envelopeFile, label: "the allocation envelope (PI_ENVELOPE_FILE)", tool: "dispatch_envelope_set" },
    { path: paths.projectsFile, label: "projects.json (PI_PROJECTS_FILE)", tool: "dispatch_project_add, _edit or _delete" },
    { path: set("PI_SCOPED_LIMITS_FILE") ? paths.scopedLimitsPath : null, label: "scoped-limits.json (PI_SCOPED_LIMITS_FILE)", tool: "dispatch_limit_add, _edit or _delete" },
    { path: set("PI_TRIGGERS_FILE") ? paths.triggersPath : null, label: "triggers.json (PI_TRIGGERS_FILE)", tool: "dispatch_trigger_add, _edit or _delete" },
    { path: paths.settingsFile, label: "the settings overlay (PI_SETTINGS_FILE)", tool: "dispatch_set" },
    { path: typeof dir === "string" && dir !== "" ? join(dir, ".env") : null, label: "the deployment's .env, which names these files (PI_*_FILE)", tool: "the operator's own editor" },
    { path: pointerPath(process.env), label: "the deployment pointer (PI_DISPATCH_DEPLOYMENT_FILE)", tool: "/dispatch setup" },
    // Issue #640: the console's tokens file. A model that could write it could add a token of its own and sign in to
    // the console as an operator. Its default lives in the deployment folder, so it is guarded wherever the folder is
    // known (the pointer's, an init scaffold folder) and, with the key set, wherever that key resolves (`consoleTokensPathFor`).
    ...consoleTokenGuards(consoleTokensPathFor(env, dir)),
  ];
  if (!(typeof dir === "string" && dir !== "")) {
    // No pointer: the session folder may BE the deployment (`init` then `up`, pi started there, nothing exported). Its
    // `.env` is never read for configuration (`panelEnv`), but it may ADD to the guard: every guarded file it names,
    // and itself (`envNamedFiles`). And in a deployment folder (init's four scaffold files are there) the files the
    // panel's own confirm tools write with no key set (`./triggers.json`, `./scoped-limits.json`, `./projects.json`)
    // are guarded too; in any other folder they stay a repository's own files (review round 1).
    const cwd = process.cwd();
    out.push(...envNamedFiles(cwd));
    if (DEPLOYMENT_SCAFFOLD_FILES.every((f) => nodeFs.existsSync(join(cwd, f)))) {
      out.push(
        { path: join(cwd, ".env"), label: "the deployment's .env, which names these files (PI_*_FILE)", tool: "the operator's own editor" },
        { path: paths.triggersPath, label: "triggers.json (PI_TRIGGERS_FILE)", tool: "dispatch_trigger_add, _edit or _delete" },
        { path: paths.scopedLimitsPath, label: "scoped-limits.json (PI_SCOPED_LIMITS_FILE)", tool: "dispatch_limit_add, _edit or _delete" },
        { path: paths.projectsPath, label: "projects.json (PI_PROJECTS_FILE)", tool: "dispatch_project_add, _edit or _delete" },
      );
    }
  }
  return out.filter((g): g is Guarded => typeof g.path === "string" && g.path !== "");
}

/**
 * Advertise the bundled `operate-pi-dispatch` skill to pi via the `resources_discover` event, so it loads
 * exactly when this extension does (no separate install step). The skill does not grant capability -- the
 * tools do that -- it recommends how to use the human confirm gates on the write tools. pi's resource loader
 * honours `skillPaths` from this event; the path is the extension-relative `admin/skills` directory.
 */
function registerSkill(pi: ExtensionAPI): void {
  const skillPaths = [fileURLToPath(new URL("../skills", import.meta.url))];
  pi.on("resources_discover", () => ({ skillPaths }));
}

/** A one-shot text tool result. Failure is signalled by THROWing from `execute`, never by this shape. */
function toolText(text: string): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * Register the LLM-callable tools. Reads: `dispatch_status`, `dispatch_runs`, `dispatch_costs`,
 * `dispatch_triggers`, `dispatch_projects` (and the other reads below). On/off:
 * `dispatch_pause`/`dispatch_resume` (durable, reversible, money-safe -- no confirm). The gated PAID enqueue:
 * `dispatch_run`. Confirm-gated writes: `dispatch_set` (a limit/setting), `dispatch_trigger_add`/`_edit`/
 * `_delete`, and the project writes `dispatch_project_add`/`_edit`/`_delete`. There is still NO log tool -- raw `.log` bytes never enter model context (DES-ADMIN-VIA-PI-EXTENSION
 * injection boundary; REQ acceptance).
 *
 * The write tools do NOT weaken the money/trigger gates: each routes through `confirmedWrite`, which refuses
 * unless a human operator is present (`ctx.hasUI`) and approves a `ctx.ui.confirm` dialog showing the concrete
 * before->after. The model emits only the tool CALL; the operator answers the CONFIRM, so a prompt-injected
 * session cannot raise the cap or add a paid trigger without a human keypress it cannot forge (the same human
 * approval the operator-typed `/dispatch set` and the overlay CRUD already require). Without an interactive UI
 * (print/headless) the write is refused, never silently applied.
 *
 * `dispatch_run` takes no spend-knob params (model/maxTurns/dailyCap/concurrency resolve worker-side) and is
 * bounded producer-side by the folder allowlist, the committed per-flow ai-trigger gate read at a pre-agent
 * SHA, and a per-hour rate limit; the daily cap stays the worker's. Each read reuses the self-closing
 * read-model wrappers: a tool call is a one-shot, so a per-call connection is correct here where a per-tick
 * one on the dashboard would not be. A control, write, or enqueue that cannot reach the queue/file THROWs,
 * which pi reports to the model as an error rather than a false success.
 */
function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dispatch_status",
    label: "pi-dispatch status",
    description:
      "Read-only. Reports pi-dispatch queue/worker state: paused flag, job counts, connected workers, today's budget use, schedulers, runtime settings overlay.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(deploymentEnv());
      const [queue, budget, schedulers] = await Promise.all([
        readQueueState({ url: paths.valkeyUrl }),
        readBudget({ url: paths.valkeyUrl }),
        readSchedulers({ url: paths.valkeyUrl }),
      ]);
      // The operator-only overlay keys (`secretProfiles`, `secretBundles`: resolver paths the worker executes) are left
      // out of what the model reads (issue #704 review): no tool can set them, and none needs to see them.
      const settings = withoutOperatorOnly(readSettingsView({ settingsFile: paths.settingsFile }));
      return toolText(JSON.stringify({ queue, budget, settings, schedulers }));
    },
  });

  pi.registerTool({
    name: "dispatch_runs",
    label: "pi-dispatch runs",
    description:
      "Read-only. Returns structured run records (PII-free by construction, plus the worker name when the operator declared one) from the durable run history. Raw job logs are not available to tools — ask the user to run /dispatch logs.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      jobId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const paths = resolvePaths(deploymentEnv());
      // A record's `bundle` reaches the model as counts only (`modelRunRecord`, issue #704): its variable names are the
      // operator's manager's contents and stay in the operator's own views. Issue #712: an openshell run's rule hosts ride
      // only here, by id; the list below carries their count.
      if (params.jobId) return toolText(JSON.stringify(modelRunRecord(readRun({ logsDir: paths.logsDir, jobId: params.jobId }))));
      // `{runs, hosts, mirror}` rather than a bare array (issue #57, Gap 3). The one deliberate tool-shape
      // change here, and this surface's own doctrine is the justification: typed dollars carry their
      // `class` so a model consuming them cannot launder an estimate into a fact by dropping the label, and
      // a bare array holding some unstated fraction of a fleet's runs is exactly that laundering. `mirror`
      // says whether the list is the whole deployment ("ok"), this host alone ("off"), capped
      // ("truncated"), or unknown ("unreachable ...").
      const merged: any = await listRunsMerged({ logsDir: paths.logsDir, limit: params.limit ?? 10, url: paths.valkeyUrl });
      return toolText(JSON.stringify(Array.isArray(merged?.runs) ? { ...merged, runs: merged.runs.map((r: any) => modelRunRecord(r, { list: true })) } : merged));
    },
  });

  pi.registerTool({
    name: "dispatch_costs",
    label: "pi-dispatch costs",
    description:
      "Read-only. Folds the PII-free run history against the operator's declared subscriptions and pi-ai's " +
      "rate tables into the costs read-model: window totals, daily buckets, per-flow and per-model rollups, " +
      "per-plan verdicts, and provenance. window = 7d | 30d | mtd (default mtd); flow filters to one flow's " +
      "runs; repo filters to one repo's runs: a bare \"acme/web\" selects that repo on every forge, a forge-qualified " +
      "\"github:acme/web\" (the by-repo rollup's key) one forge, and \"local:site\" a local folder's runs; project " +
      "filters to the runs recorded under one project id (the by-project rollup's key). `byProject` groups by the " +
      "project id each run record carries: runs outside every project, and runs recorded before projects existed, are " +
      "\"(no project)\", and a record is never re-attributed from the projects file as it is now. " +
      "`dollars` adds the dollar caps: `windows` has one row per active dollar window (the deployment's, then each " +
      "scoped-limits dollar row), with `counterMicros` (spent and held, the Valkey counter the next job is admitted " +
      "against, null when unreadable) beside the records' side (settled micro-dollars, how many runs settled metered, " +
      "floor, refunded or unreserved, and the boundExceeded count; null for a folder or model row, which a run record " +
      "cannot name); `runs` lists the per-run `dollars` of this window's records, newest first. All amounts are " +
      "integer micro-dollars (1 USD = 1000000).",
    parameters: Type.Object({ window: Type.Optional(Type.String()), flow: Type.Optional(Type.String()), repo: Type.Optional(Type.String()), project: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const window = params.window ?? "mtd";
      if (!COSTS_WINDOWS.includes(window)) {
        throw new Error(`unknown window '${window}' (7d|30d|mtd)`);
      }
      // Issue #499 part C: an id or nothing, so a typo is an error rather than a fold of nothing that reads as no spend.
      if (params.project !== undefined && !PROJECT_KEY_RE.test(String(params.project))) {
        throw new Error("project must be a project id (lowercase letters, digits and \"-\", 1 to 32 characters); dispatch_projects lists them");
      }
      const paths = resolvePaths(deploymentEnv());
      const res = assembleCosts(paths, window, params.flow, params.repo, params.project);
      if (res.unreachable) throw new Error(`could not read the run history: ${res.unreachable}`);
      // Issue #501, part 7: the dollar caps beside the fold. The windows are the CURRENT day, week and month whatever
      // `window` asked for (that is what a cap counts), each counter read under the worker's own keys; the runs are
      // this window's records, filtered like the fold. Integers and fixed tokens, so nothing a job chose rides along.
      const windows = await readDollarWindows({ paths, env: deploymentEnv() });
      const runs = runDollars(res.records);
      // ONLY when there is something to say (PR #550's review): no window, no run carrying dollars and no unreadable
      // setting is a deployment that sets no dollar cap, and its result stays byte-identical to what it always was.
      const anyDollars = windows.windows.length > 0 || runs.runs.length > 0 || Array.isArray((windows as any).invalid);
      if (!anyDollars) return toolText(JSON.stringify({ window, fold: res.fold }));
      const dollars = { ...windows, ...runs };
      // The fold's dollars are TYPED `{ usd, class, floor, ... }` on purpose: the class rides beside every
      // number in this JSON, so a model consuming it cannot launder an estimate into a fact by dropping
      // the label -- the same discipline fmtCost enforces on the text views.
      return toolText(JSON.stringify({ window, fold: res.fold, dollars }));
    },
  });

  pi.registerTool({
    name: "dispatch_pause",
    label: "pi-dispatch pause",
    description:
      "Durably pauses pi-dispatch job processing: NEW jobs stop starting; running containers finish; jobs still enqueue. Survives worker restart. Reversible via dispatch_resume.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute() {
      // The CLI's kill-switch rule (PR #475's review, round 3): both Valkeys when this process's VALKEY_URL and the
      // deployment .env's disagree, every URL shown without its userinfo.
      const set: any = await panelWrite(auditDir(), { kind: "fleet-pause", target: "fleet", failure: switchFailure }, async () => await killSwitchSet({ paused: true }));
      if (set.refused) throw new Error(set.refused);
      const lines = [];
      for (const { shown, res } of set.results) {
        const at = set.results.length > 1 ? ` at ${shown}` : "";
        if (res.unreachable && !res.partial) throw new Error(`could not reach the queue at ${shown}: ${res.unreachable}`);
        // A PARTIAL result is the dangerous one: some queues switched, one did not, and reporting a bare
        // "paused" for it tells an operator the deployment is stopped while a host keeps spending.
        if (res.partial) throw new Error(`paused ${res.partial.done.join(", ")}${at} but FAILED at ${res.partial.failed}: the deployment is half paused: ${res.partial.error}`);
        lines.push(`paused${at}${res.queues.length > 1 ? ` (${res.queues.length} queues)` : ""}`);
      }
      return toolText(`${set.disagreement ? `${set.disagreement}: paused both. ` : ""}${lines.join("; ")}`);
    },
  });

  pi.registerTool({
    name: "dispatch_resume",
    label: "pi-dispatch resume",
    description: "Re-enables PAID job processing after a pause. Only call when the user explicitly asks to resume.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute() {
      const set: any = await panelWrite(auditDir(), { kind: "fleet-resume", target: "fleet", failure: switchFailure }, async () => await killSwitchSet({ paused: false }));
      if (set.refused) throw new Error(set.refused);
      const { shown, res } = set.results[0];
      if (res.unreachable && !res.partial) {
        throw new Error(`could not reach the queue at ${shown}: ${res.unreachable}`);
      }
      if (res.partial) {
        throw new Error(`resumed ${res.partial.done.join(", ")} but FAILED at ${res.partial.failed} — the deployment is half resumed: ${res.partial.error}`);
      }
      return toolText(`resumed${res.queues.length > 1 ? ` (${res.queues.length} queues)` : ""}`);
    },
  });

  pi.registerTool({
    name: "dispatch_run",
    label: "pi-dispatch run",
    description:
      "Enqueues a PAID pi-dispatch agent run against a local folder, editing it in place with no undo. " +
      "Only folders under the operator's PI_DISPATCH_RUN_ROOTS, and only flows whose .pi/skills/<flow>/SKILL.md " +
      "(at HEAD) sets ai-trigger: allow, can be started. Refuses a dirty git working tree — no force option. " +
      "Rate-limited per hour. Flows only: a registered extension command (a run.command trigger) is never " +
      "AI-triggerable and a /name flow is refused.",
    executionMode: "sequential",
    parameters: Type.Object({ folder: Type.String(), flow: Type.String(), task: Type.String() }),
    async execute(_toolCallId, params) {
      const res: any = await panelWrite(auditDir(), { kind: "run-enqueue", target: params.folder, failure: enqueueFailure }, () => enqueueDispatchRun({
        folder: params.folder,
        flow: params.flow,
        task: params.task,
        aiInvoked: true,
        env: deploymentEnv(),
      }));
      if (res.refused) throw new Error(res.refused);
      if (res.unreachable) throw new Error(`could not reach the queue: ${res.unreachable}`);
      // Issue #524: a swallowed duplicate is said as one, so the model never reports a run that was not queued.
      if (res.deduplicated) return toolText(JSON.stringify({ jobId: res.jobId, folder: params.folder, flow: params.flow, queued: false, note: res.said }));
      return toolText(JSON.stringify({ jobId: res.jobId, folder: params.folder, flow: params.flow }));
    },
  });

  // Issue #599, phase 2: how busy each host is and was (REQ-CAPACITY-INSIGHTS, INT-CAPACITY-REPORT), through the CLI's
  // own read and function (`readCapacity`), so the tool, `pi-dispatch capacity` and doctor never disagree. Read-only:
  // the registry is read without its prune and the mirror reader writes nothing.
  pi.registerTool({
    name: "dispatch_capacity",
    label: "pi-dispatch capacity",
    description:
      "Read-only. How busy each worker host was over a window (window = 24h | 7d | 30d, default 7d; host narrows to one " +
      "host): busy and idle time, jobs at once (average, peak, time with every slot taken), memory and CPU promised " +
      "against the host budget, CPU used, the wait for a slot (p50, p95) and the projects by run time, from the run " +
      "records plus the jobs running now. `text` is the plain report; `report` is the capacity report v1 (integers: " +
      "milliseconds, and ratios per mille). Jobs only: a machine busy with other work reads as idle. Time before a " +
      "host's history starts is reported as missing (`missingMs`, `coverage`), never as idle; a host that is new, or " +
      "was down, inside history that is there reads as idle for that time.",
    parameters: Type.Object({ window: Type.Optional(Type.String()), host: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const paths = resolvePaths(deploymentEnv());
      const window = params.window ?? "7d";
      const res: any = await readCapacity({ url: paths.valkeyUrl, env: deploymentEnv(), window, host: params.host });
      if (res.error) throw new Error(res.error);
      return toolText(JSON.stringify({ window, text: res.text, report: res.report }));
    },
  });

  pi.registerTool({
    name: "dispatch_triggers",
    label: "pi-dispatch triggers",
    description:
      "Read-only. Lists the configured triggers as `{ index, ...trigger }` entries. Use the `index` to target " +
      "a specific trigger with dispatch_trigger_edit or dispatch_trigger_delete. A close-capable entry (kind " +
      "issue, or a pull_request on the forge's close word) may carry `on.number` (narrowed to one item), " +
      "`on.once` (a one-shot), and `on.disarmed` { at, jobId? } — the worker's mark that the one-shot fired; " +
      "a disarmed entry still lists here but matches nothing until an operator deletes the key to re-arm it.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(deploymentEnv());
      const t = readTriggers({ triggersPath: paths.triggersPath });
      const data = Array.isArray(t?.triggers)
        ? t.triggers.map((tr: any, index: number) => ({ index, ...tr }))
        : t;
      return toolText(JSON.stringify(data));
    },
  });

  pi.registerTool({
    name: "dispatch_set",
    label: "pi-dispatch set limit",
    description:
      "Changes a pi-dispatch runtime setting/limit and applies it live. The operator MUST approve a confirm " +
      "dialog showing the exact before->after; with no interactive operator the change is refused, never " +
      "applied. Omit `value` (or pass empty) to unset a key back to its default. Valid keys: " +
      KNOWN_KEYS.join(", ") + ".",
    executionMode: "sequential",
    parameters: Type.Object({ key: Type.String(), value: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      const env = deploymentEnv(); // the dollar settings' source for the confirm (settingShown)
      const shown = { deploymentDir: pointerState().deploymentDir ?? null };
      // Judged BEFORE the confirm (`planSettingChange`, write-plans.mjs): an unknown key; an invalid file (issue #501;
      // a BLANK one reads as missing, #540); a dollar value the worker's own parser refuses (#501 part 7); a model or
      // provider id outside the worker's shape (#673, `modelIdProblem`/`providerIdProblem`); a change that
      // would leave the allocation envelope unloadable (#504 part C). A dollar change that leaves a window uncapped in
      // the merged overlay is WARNED in the confirm, never refused (PR #542's review): the worker's cap may come from its
      // service unit, which the admin cannot see.
      const planned: any = planSettingChange({ key: params.key, value: params.value, paths, env, shown });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: plan.unset ? "setting-unset" : "setting-set", target: paths.settingsFile }, () => writeSettings({ settingsFile: paths.settingsFile, mutate: plan.mutate, expect: plan.expect }));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, key: params.key, value: plan.value };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_trigger_add",
    label: "pi-dispatch add trigger",
    description:
      "Adds a trigger to triggers.json and applies it live. The operator MUST approve a confirm dialog showing " +
      "the entry; with no interactive operator it is refused. `flow` is the .pi/skills/<name> skill the job runs " +
      "(its SKILL.md is the agent's instructions). `kind` = " + [...ON_TYPES].join("|") + ". cron (local) needs " +
      "id, pattern, `folder` (absolute host path the job runs in), `flow`, and `task` (the prompt text handed to " +
      "the agent), and may set optional model/provider/maxTurns for that schedule (omit = deployment default). " +
      "label needs labels[]+flow; comment needs phrase+flow; pull_request needs action[] (+ optional labels[]) + " +
      "flow. issue fires when an ISSUE closes: it needs flow, its action[] defaults to the forge's close word " +
      "(github/forgejo closed, gitlab close; azure has no close trigger), and it may set `number` (the forge's " +
      "own item number, narrowing the rule to that one issue) and `once: true` (a one-shot: it fires once, the " +
      "run is recorded, then the worker disarms the entry by writing on.disarmed; once requires number). A " +
      "close-only pull_request rule accepts the same number/once narrowing. " +
      "Webhook triggers take an optional `forge` = github (default) | gitlab | forgejo | azure, which " +
      "also decides which action words pull_request accepts: " +
      FORGE_KINDS.map((f: string) => `${f} is ${[...(PR_ACTIONS[f] as Set<string>)].join("|")}${PR_CLOSE_ACTIONS[f] ? "" : " (no close word)"}`).join(", ") +
      ". " +
      "The close word rides alone: it cannot be mixed with other actions in one entry. An azure label or comment " +
      "trigger must also set `repository` (a work item belongs to a project, not a repository), and an azure " +
      "pull_request trigger may not carry labels[] at all. A github review_submitted trigger may also set " +
      "reviewState[] (" + [...REVIEW_STATES].join("|") + ") to narrow which verdicts fire; omitted, all " +
      "three do. For webhook triggers the repo and the task come from the triggering " +
      "issue/PR event, so set only the match + flow. Every kind may set model/provider/maxTurns (omit = deployment default). " +
      "`backend` (optional, any kind) names WHERE the job's container is built, chosen from the names this " +
      "deployment blesses in PI_BACKENDS; omitted, the job runs on the deployment default. A name this " +
      "deployment does not bless is refused here, and refused again before the job spends. " +
      "`progress: true` (optional, any kind) offers the job a report_progress tool and shows the phases it reports; " +
      "`statusComment: true` (optional, webhook kinds only, refused on cron) has the worker post one status comment " +
      "on the issue or pull request and edit it as the run goes. " +
      "`recover: true` (optional, webhook kinds only, refused on cron) makes a run the worker loses continue from its " +
      "last checkpoint instead of failing; it needs the deployment's session store and an image that supports it. " +
      "`steer: true` (optional, any kind) lets operators send messages to the job while it runs; it needs an image " +
      "that supports it and a venue that bind-mounts.",
    executionMode: "sequential",
    parameters: Type.Object({
      kind: Type.String(),
      flow: Type.String(),
      forge: Type.Optional(Type.String()),
      // buildTriggerEntry has always READ `f.repository`, and the schema has always stripped it -- so an
      // azure label/comment trigger was unauthorable by the model, refused at the write for want of a field
      // it had no way to send. Surfaced by #187 widening what the description above must say about forges.
      repository: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      pattern: Type.Optional(Type.String()),
      folder: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      phrase: Type.Optional(Type.String()),
      labels: Type.Optional(Type.Array(Type.String())),
      action: Type.Optional(Type.Array(Type.String())),
      // The close-trigger narrowings (issue #231), read only by the close-capable arms of
      // buildTriggerEntry and refused fail-loud by the shared validator everywhere else -- the
      // `repository` posture above, restated for the two fields whose whole point is narrowing spend.
      number: Type.Optional(Type.Integer({ minimum: 1 })),
      once: Type.Optional(Type.Boolean()),
      model: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
      // #227. WHICH venue this trigger's container is built in. A NAME chosen from what PI_BACKENDS
      // blessed, never a configuration -- `DES-PER-TRIGGER-JOB-IMAGE` predicted this exact arrival: "If a
      // future tool ever takes an image parameter, the allowlist arrives with that tool, and this row is
      // the reason it must." The allowlist is checked in execute, below, because a schema enum would be
      // frozen at registration while PI_BACKENDS is read per call.
      backend: Type.Optional(Type.String()),
      // Issue #644. Neither is a capability the model gains (buildTriggerEntry says why); checked with the loader's own
      // validator before the confirm, so a status comment on cron is refused before the operator is asked.
      progress: Type.Optional(Type.Boolean()),
      statusComment: Type.Optional(Type.Boolean()),
      // Issue #645. Not a capability the model gains either (buildTriggerEntry says why it differs from run.resume);
      // the loader's own validator refuses it on cron before the confirm.
      recover: Type.Optional(Type.Boolean()),
      // Issue #646. Not a capability the model gains (buildTriggerEntry says why); legal on every kind, and the loader's
      // own validator refuses a non-boolean before the confirm.
      steer: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Judged BEFORE the confirm (`planTriggerAdd`): the tool-proof fields and their near misses (#501 part 7), the
      // backend against what PI_BACKENDS blesses (#227, refused under an empty set too), and the provider, model and turn
      // limit with the loader's own message (#502), so the operator never approves an entry the write then refuses.
      const paths = resolvePaths(deploymentEnv());
      const planned: any = planTriggerAdd({ params, paths, env: process.env });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "trigger-add", target: paths.triggersPath }, () => writeTriggers({ triggersPath: paths.triggersPath, mutate: plan.mutate, expect: plan.expect }));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, added: plan.entry };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_trigger_edit",
    label: "pi-dispatch edit trigger",
    description:
      "Changes which flow a trigger runs (by array index from dispatch_triggers) and applies it live, and " +
      "optionally which `backend` (venue) its container is built in, chosen from the names PI_BACKENDS " +
      "blesses, and which `provider` and `model` its jobs run on (omitted, the trigger keeps what it has), and " +
      "`progress` / `statusComment` / `recover` / `steer` (booleans, as on dispatch_trigger_add; omitted, the trigger keeps what it has). " +
      "The operator MUST approve a confirm dialog showing the before->after; with no interactive " +
      "operator it is refused.",
    executionMode: "sequential",
    parameters: Type.Object({
      index: Type.Integer({ minimum: 0 }),
      flow: Type.String(),
      backend: Type.Optional(Type.String()),
      // #502. Which model the trigger's jobs run on. Checked below with the LOADER's own validator before
      // the operator is asked, so a confirm dialog never shows a value the write would then refuse.
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      // Issue #644, merged only when sent and judged against the entry's own type (no status comment on cron).
      progress: Type.Optional(Type.Boolean()),
      statusComment: Type.Optional(Type.Boolean()),
      // Issue #645, the same merge, judged against the entry's type and its own run.command.
      recover: Type.Optional(Type.Boolean()),
      // Issue #646, the same merge, judged against the entry's own run.command.
      steer: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Judged BEFORE the confirm (`planTriggerEdit`): the tool-proof fields, the index, a non-empty flow, the backend
      // against PI_BACKENDS (#227; the picker bounds what an operator can choose, the worker what actually runs), and the
      // provider and model with the loader's own validator, alone and MERGED with the entry's own run (#502, PR #536).
      const paths = resolvePaths(deploymentEnv());
      const planned: any = planTriggerEdit({ params, paths, env: process.env });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        // `backend`, `provider` and `model` are merged only when the caller sent them (`plan.mutate`), so an edit that
        // changes just the flow leaves the entry byte-identical in every other key.
        const res: any = panelWrite(auditDir(), { kind: "trigger-edit", target: paths.triggersPath }, () => writeTriggers({ triggersPath: paths.triggersPath, mutate: plan.mutate, expect: plan.expect }));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, index: params.index, flow: plan.flow, ...(plan.backend !== undefined && { backend: plan.backend }), ...plan.ref, ...plan.flags };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_pauses",
    label: "pi-dispatch pause windows",
    description:
      "Read-only. Lists the scheduled pause windows (per folder/repo quiet hours) with their array index. " +
      "Use the index for dispatch_pause_edit / dispatch_pause_delete.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(deploymentEnv());
      const p = readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath });
      const data = Array.isArray(p?.windows) ? p.windows.map((w: any, index: number) => ({ index, ...w })) : p;
      return toolText(JSON.stringify(data));
    },
  });

  pi.registerTool({
    name: "dispatch_pause_add",
    label: "pi-dispatch add pause window",
    description:
      "Adds a scheduled pause window and applies it live: runs for `scope` (a repo \"owner/name\" on every forge, " +
      "a forge-qualified \"<forge>:owner/name\" such as \"github:acme/web\" for that forge only, a local " +
      "folder path, or \"*\" for all) are DEFERRED between `from` and `to` (\"HH:MM\" 24h; from>to = overnight) " +
      "and resume automatically after — nothing is dropped, and deferring costs no budget. Optional `tz` (IANA, " +
      "default UTC), `days` (mon..sun), `dateFrom`/`dateTo` (\"YYYY-MM-DD\"). The operator MUST approve a confirm " +
      "dialog showing the window; refused with no interactive operator.",
    executionMode: "sequential",
    parameters: Type.Object({
      scope: Type.String(),
      from: Type.String(),
      to: Type.String(),
      tz: Type.Optional(Type.String()),
      days: Type.Optional(Type.Array(Type.String())),
      dateFrom: Type.Optional(Type.String()),
      dateTo: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      const plan: any = planPauseWindowAdd({ fields: params, paths }).plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "pause-window-add", target: paths.pauseWindowsPath }, () => writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: plan.mutate, expect: plan.expect }));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, added: plan.entry };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_pause_delete",
    label: "pi-dispatch delete pause window",
    description:
      "Removes a scheduled pause window (by array index from dispatch_pauses) and applies it live. The operator " +
      "MUST approve a confirm dialog showing the window; refused with no interactive operator.",
    executionMode: "sequential",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      const planned: any = planPauseWindowDelete({ index: params.index, paths });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "pause-window-delete", target: paths.pauseWindowsPath }, () => writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: plan.mutate, expect: plan.expect }));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, deletedIndex: params.index };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_pause_edit",
    label: "pi-dispatch edit pause window",
    description:
      "Changes fields of an existing pause window (by array index from dispatch_pauses) and applies it live. " +
      "Provide only the fields to change (scope/from/to/tz/days/dateFrom/dateTo); the rest keep their current " +
      "value. `scope` is a repo \"owner/name\" on every forge, a forge-qualified \"<forge>:owner/name\" such as " +
      "\"github:acme/web\" for that forge only, a local folder path, or \"*\" for all. The operator MUST approve a confirm dialog showing the before->after; refused with no interactive " +
      "operator.",
    executionMode: "sequential",
    parameters: Type.Object({
      index: Type.Integer({ minimum: 0 }),
      scope: Type.Optional(Type.String()),
      from: Type.Optional(Type.String()),
      to: Type.Optional(Type.String()),
      tz: Type.Optional(Type.String()),
      days: Type.Optional(Type.Array(Type.String())),
      dateFrom: Type.Optional(Type.String()),
      dateTo: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      // A provided field replaces; an omitted one keeps the current value, rebuilt through the shared builder so the
      // result is validated the same way as an add (`planPauseWindowEdit`).
      const planned: any = planPauseWindowEdit({ index: params.index, fields: params, paths });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "pause-window-edit", target: paths.pauseWindowsPath }, () => writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: plan.mutate, expect: plan.expect }));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, index: params.index, window: plan.entry };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_limits",
    label: "pi-dispatch scoped limits",
    description:
      "Read-only. Lists the scoped limits (per repo/folder budget caps and concurrency, scoped-limits.json) " +
      "with their array index and, when the queue is reachable, each scope's used day/week/month run counts. " +
      "Each row carries `summary` (its caps in words) and, for a row with dollar windows (dayUsd/weekUsd/monthUsd, " +
      "or a model:<provider>/<model> row), `dollars`: one entry per window with its cap and `counterMicros`, the " +
      "micro-dollars spent and held in it so far (null when the queue is unreachable). " +
      "Use the index for dispatch_limit_edit / dispatch_limit_delete. The always-on one-job-per-folder mutex " +
      "for local jobs is separate: it has no entry here and no switch anywhere.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(deploymentEnv());
      const p = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
      if (!Array.isArray((p as any)?.limits)) return toolText(JSON.stringify(p));
      const counters = await readScopedBudget({ url: paths.valkeyUrl, limits: (p as any).limits });
      const rows = (p as any).limits.map((l: any, index: number) => {
        const used = (counters as any).rows?.[index] ?? null;
        // `summary` and `dollars` only on a row with a dollar window (PR #550's review), so a count-only row reads
        // exactly as it always did.
        const usd = dollarRowsOf(l, used);
        return "dollars" in usd ? { index, ...l, used, summary: limitSummary(l), ...usd } : { index, ...l, used };
      });
      return toolText(JSON.stringify(rows));
    },
  });

  pi.registerTool({
    name: "dispatch_waits",
    label: "pi-dispatch held jobs",
    description:
      "Read-only. Lists the jobs the worker is currently HOLDING on a trigger's run.waitFor condition: the " +
      "job id, an id-only target, the operator's own words for what it is waiting on, and how long it has " +
      "waited. A held job has reserved no budget slot and started no container. This is a different set from " +
      "the queue's `delayed` count, which also mixes cron next-occurrences, retry backoff and quiet hours; " +
      "only waits appear here. Use the job id for dispatch_wait_cancel.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(deploymentEnv());
      const held = await readHeldJobs({ url: paths.valkeyUrl });
      return toolText(JSON.stringify(held));
    },
  });

  pi.registerTool({
    name: "dispatch_wait_cancel",
    label: "pi-dispatch cancel a held job",
    description:
      "Removes a job that is waiting on a run.waitFor condition, so it never runs. The operator MUST approve " +
      "a confirm dialog naming the job and what it was waiting on; refused with no interactive operator. " +
      "Use dispatch_waits for the job id. The operator can also do this without a model: `pi-dispatch cancel " +
      "<jobId>` at a terminal, or the panel's held view (h, then x). A held job spends nothing while it waits, so " +
      "no budget cap will stop it, and deleting the trigger does not reach a job already enqueued. " +
      "Cancelling writes no run record of its own.",
    executionMode: "sequential",
    parameters: Type.Object({ jobId: Type.String({ minLength: 1 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      const held = await readHeldJobs({ url: paths.valkeyUrl });
      if ((held as any).unreachable) throw new Error(`queue unreachable: ${(held as any).unreachable}`);
      const row = ((held as any).rows ?? []).find((r: any) => r.jobId === params.jobId);
      if (!row) throw new Error(`no held job ${params.jobId} (dispatch_waits lists the ids that are waiting)`);
      const result = await confirmedWrite(
        ctx,
        { title: `Cancel held job ${row.jobId}`, message: `Cancel ${row.target ?? row.jobId}, waiting on ${row.label ?? "a condition"}. It will never run.` },
        async () => {
          const res: any = await panelWrite(auditDir(), { kind: "cancel-held", target: params.jobId }, () => cancelHeldJob({ url: paths.valkeyUrl, jobId: params.jobId }));
          if ((res as any).invalid) throw new Error(`rejected: ${(res as any).invalid}`);
          return { applied: true, jobId: params.jobId };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_limit_add",
    label: "pi-dispatch add scoped limit",
    description:
      "Adds a scoped limit and applies it live: jobs whose scope (a repo \"owner/name\", which counts that repo on " +
      "every forge as one, a forge-qualified \"<forge>:owner/name\" such as \"github:acme/web\", which counts one " +
      "forge's repo, or a local folder path, ABSOLUTE, matched exactly like pause windows, no globs) exceed the `day`/`week`/`month` " +
      "job-count caps are REFUSED before any spend (reason scope-cap, never retried); jobs over `concurrent` " +
      "are DEFERRED, never dropped, and run when a slot frees. At least one of day/week/month/concurrent is " +
      "required, each an integer >= 1. `dayUsd`/`weekUsd`/`monthUsd` are DOLLAR windows (a decimal string such as " +
      "\"2.50\": above 0, at most 1000000, at most 6 decimals): what the scope's jobs may spend per UTC day, Monday " +
      "week and month; a job that does not fit is refused dollar-cap. A scope of model:<provider>/<model> caps one " +
      "model across every scope and takes the three dollar fields only. A scope of project:<id> (an id from " +
      "projects.json) caps every member of that project as one: a job over its day/week/month is refused " +
      "project-cap, over its dollar window dollar-cap, and its `concurrent` defers; the id must already be in " +
      "projects.json. Under an allocation envelope (PI_ENVELOPE_FILE) a project's or a repo's share of the split " +
      "narrows its dollar window further, and the envelope total the deployment's: a job refused by a share or the " +
      "envelope total is allocation-cap, not dollar-cap. " +
      "A bare row and a qualified row for the same " +
      "repo are refused together: keep one form. A dollar window needs a per-job cap " +
      "(maxCostUsd). A project:<id> row may also set its jobs' SIZE: `memory` (a string such as \"512m\", \"1536m\" " +
      "or \"4g\", at least 512m; no swap is given beyond it) and `cpus` (a number such as 0.5 or 2, at least 0.25, at " +
      "most two decimals; a CPU WEIGHT under contention, not a cap). Unset, a job takes PI_JOB_MEMORY and PI_JOB_CPUS " +
      "(4g and 2). `hostShare` (a whole percentage, 1 to 100, of a host's job budget: the most the project's running " +
      "jobs may hold together on one host) and `minJobs` (an integer >= 1, needs memory or cpus on the row, at most its " +
      "concurrent: how many of its jobs a host keeps room for first) are enforced by each worker's host budget " +
      "(PI_HOST_MEMORY_BUDGET, PI_HOST_CPU_BUDGET, which count a job's cpus as reserved CPU). A size larger than a " +
      "host's budget, or than the project's hostShare of it, refuses a job on that host's own queue before any spend " +
      "(job-size-exceeds-host, -share); a job on the shared queue waits for a host it fits on. A row may " +
      "carry a size and nothing else. The file stays " +
      "version 1 unless a row needs version 2, or 3 for a size field (a worker older than this one then refuses the " +
      "file, so upgrade every worker first). The operator MUST approve a confirm dialog showing the entry; refused " +
      "with no interactive operator.",
    executionMode: "sequential",
    parameters: Type.Object({
      scope: Type.String(),
      day: Type.Optional(Type.Integer({ minimum: 1 })),
      week: Type.Optional(Type.Integer({ minimum: 1 })),
      month: Type.Optional(Type.Integer({ minimum: 1 })),
      concurrent: Type.Optional(Type.Integer({ minimum: 1 })),
      // Issue #501, part 7. Strings, the form `parseUsdMicros` reads exactly as written. pi's own validation turns a
      // JSON number into a string before `execute` (`dollarFieldsOf`), so a number is read by its value; one that does
      // not print as a plain decimal of at most 6 places is refused.
      dayUsd: Type.Optional(Type.String()),
      weekUsd: Type.Optional(Type.String()),
      monthUsd: Type.Optional(Type.String()),
      // Issue #596: a project row's job size (version 3), one table for both tools (`SIZE_FIELD_SCHEMAS`).
      ...SIZE_FIELD_SCHEMAS,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      // Judged BEFORE the confirm (`planLimitAdd`): the dollar and size fields by the worker's parsers, then the whole
      // change without writing (the parser, the project pair and the allocation envelope, issue #504 part C), so the
      // operator is never asked to approve a row the write would refuse, such as one below an envelope floor. `expect` is
      // the files as the change is built from them (PR #569's second review).
      const planned: any = planLimitAdd({ params, paths, env: deploymentEnv() });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "limit-add", target: paths.scopedLimitsPath }, () => writeScopedLimits(plan.writeArgs));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, added: plan.entry, ...(res.pending ? { pending: res.pending } : {}) };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_limit_delete",
    label: "pi-dispatch delete scoped limit",
    description:
      "Removes a scoped limit (by array index from dispatch_limits) and applies it live. The operator MUST " +
      "approve a confirm dialog showing the limit; refused with no interactive operator.",
    executionMode: "sequential",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      const planned: any = planLimitDelete({ index: params.index, paths, env: deploymentEnv() });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "limit-delete", target: paths.scopedLimitsPath }, () => writeScopedLimits(plan.writeArgs));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, deletedIndex: params.index, ...(res.pending ? { pending: res.pending } : {}) };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_limit_edit",
    label: "pi-dispatch edit scoped limit",
    description:
      "Changes fields of an existing scoped limit (by array index from dispatch_limits) and applies it live. " +
      "Provide only the fields to change (scope/day/week/month/concurrent/dayUsd/weekUsd/monthUsd, and on a project:<id> " +
      "row memory/cpus/hostShare/minJobs as dispatch_limit_add describes them); the rest keep " +
      "their current value. `scope` is a repo \"owner/name\" on every forge, a forge-qualified " +
      "\"<forge>:owner/name\" such as \"github:acme/web\" for that forge only, or an ABSOLUTE local folder path. `dayUsd`/`weekUsd`/`monthUsd` are dollar windows, written as a decimal string (\"2.50\"). " +
      "No field can be removed here: to drop a cap from an entry, edit scoped-limits.json by hand. Changing `scope` " +
      "(such as a bare \"acme/web\" rewritten to \"github:acme/web\") starts a NEW count under a new key: the old " +
      "row's used runs and dollars do not carry over, and jobs already running keep their slot under the old scope " +
      "until they finish while the new row counts from zero, so with `concurrent: N` up to 2N jobs can run until " +
      "then. A new size applies to the project's NEXT jobs; a running job keeps the size it started with. The file stays " +
      "version 1 unless a row needs version 2, or 3 for a size field. The operator MUST approve a confirm dialog showing the before->after; " +
      "refused with no interactive operator.",
    executionMode: "sequential",
    parameters: Type.Object({
      index: Type.Integer({ minimum: 0 }),
      scope: Type.Optional(Type.String()),
      day: Type.Optional(Type.Integer({ minimum: 1 })),
      week: Type.Optional(Type.Integer({ minimum: 1 })),
      month: Type.Optional(Type.Integer({ minimum: 1 })),
      concurrent: Type.Optional(Type.Integer({ minimum: 1 })),
      dayUsd: Type.Optional(Type.String()),
      weekUsd: Type.Optional(Type.String()),
      monthUsd: Type.Optional(Type.String()),
      ...SIZE_FIELD_SCHEMAS,
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      // Judged BEFORE the confirm (`planLimitEdit`): a dollar field (#501 part 7) and a size field (#596) by the worker's
      // parsers; a provided field replaces and an omitted one is CARRIED, never dropped, so an edit of a count cannot
      // silently remove a dollar cap or a size; then the whole change without writing, like an add. A size change adds
      // the project's evidence to the confirm (`sizingNote`).
      const planned: any = planLimitEdit({ params, paths, env: deploymentEnv(), sizingNoteFn: (scope: any) => sizingNote(paths, scope, Date.now()) });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "limit-edit", target: paths.scopedLimitsPath }, () => writeScopedLimits(plan.writeArgs));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, index: params.index, limit: plan.entry, ...(res.pending ? { pending: res.pending } : {}) };
      });
      return toolText(JSON.stringify(result));
    },
  });

  // Issue #499 part C: the projects file (INT-PROJECTS-FILE-CONTRACT). One read tool and three confirm-gated writes,
  // through `planProjectsWrite`/`writeProjects` (the worker's own parser, tmp + rename). Confirm-gated because which
  // project a repo is in decides which project row counts it: moving a repo out of a capped project widens what it may
  // spend. A project's `name` is operator free text and is ESCAPED wherever it is shown (`escapeInterpreted`), so a
  // bidi override in it is visible and reorders nothing; it never reaches a log line.
  pi.registerTool({
    name: "dispatch_projects",
    label: "pi-dispatch projects",
    description:
      "Read-only. Lists the projects (projects.json, PI_PROJECTS_FILE): each project's id, its display name (control and " +
      "bidi characters shown escaped as \\u{...}), its members (forge-qualified repos such as github:acme/web, and absolute " +
      "folders), and `limitRows`, the indexes of the scoped-limits rows (project:<id>) that cap it. A run records the id " +
      "of the project its scope belonged to when it was picked up. Spend per project is dispatch_costs (byProject, or " +
      "its project filter). `unset` means PI_PROJECTS_FILE is unset and the worker reads no projects.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(deploymentEnv());
      const p: any = readProjects({ projectsPath: paths.projectsFile });
      if (!Array.isArray(p?.projects)) return toolText(JSON.stringify(p?.invalid ? { invalid: escapeInterpreted(p.invalid) } : p));
      const sl: any = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
      const limits: any[] = Array.isArray(sl?.limits) ? sl.limits : [];
      const projects = p.projects.map((pr: any) => ({
        ...projectShown(pr),
        limitRows: limits.flatMap((l: any, i: number) => (l?.scope === `project:${pr.id}` ? [i] : [])),
      }));
      return toolText(JSON.stringify(sl?.invalid ? { projects, limitsInvalid: true } : { projects }));
    },
  });

  pi.registerTool({
    name: "dispatch_project_add",
    label: "pi-dispatch add project",
    description:
      "Adds a project to projects.json and applies it live: a job whose scope is a member records this project's `id` " +
      "from its next pickup, and a scoped-limits row project:<id> (dispatch_limit_add) caps the members as one. `id`: " +
      "lowercase letters, digits and \"-\", 1 to 32 characters. `members`: one or more scopes, a forge-qualified repo " +
      "\"<forge>:owner/name\" such as \"github:acme/web\" (a bare owner/name is refused, it names the repo on every " +
      "forge) or an ABSOLUTE folder path; a scope already in another project is refused (one project per scope). " +
      "`name`: optional display text, never written to a run record or a log. Runs recorded before are never moved " +
      "into the project. The operator MUST approve a confirm dialog showing the entry; refused with no interactive operator.",
    executionMode: "sequential",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      members: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      const planned: any = planProjectAdd({ params, paths, env: deploymentEnv() });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "project-add", target: paths.projectsFile }, () => writeProjects({ ...plan.writeArgs, envelope: envelopeGuard(paths, deploymentEnv()) }));
        if (res.invalid) throw new Error(`rejected: ${escapeInterpreted(res.invalid)}`);
        return { applied: true, added: projectShown(plan.added), ...(res.pending ? { pending: escapeInterpreted(res.pending) } : {}) };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_project_edit",
    label: "pi-dispatch edit project",
    description:
      "Changes an existing project (by `id`, from dispatch_projects) and applies it live. `name` replaces the display " +
      "text (an empty string removes it); `members` replaces the whole member list (same rules as dispatch_project_add). " +
      "The id cannot be changed here: add the new project, move its scoped-limits row, then delete the old one. A member " +
      "removed from a capped project is no longer counted by its project:<id> row, which WIDENS what it may spend; " +
      "records already written keep the project they were recorded under. The operator MUST approve a confirm dialog " +
      "showing the before->after; refused with no interactive operator.",
    executionMode: "sequential",
    parameters: Type.Object({
      id: Type.String(),
      name: Type.Optional(Type.String()),
      members: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      // A member leaving a capped project is named in the confirm (`planProjectEdit`): it WIDENS what it may spend.
      const planned: any = planProjectEdit({ params, paths, env: deploymentEnv() });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "project-edit", target: paths.projectsFile }, () => writeProjects({ ...plan.writeArgs, envelope: envelopeGuard(paths, deploymentEnv()) }));
        if (res.invalid) throw new Error(`rejected: ${escapeInterpreted(res.invalid)}`);
        return { applied: true, project: projectShown(plan.after), ...(res.pending ? { pending: escapeInterpreted(res.pending) } : {}) };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_project_delete",
    label: "pi-dispatch delete project",
    description:
      "Removes a project (by `id`) from projects.json and applies it live: its members' runs record no project from " +
      "their next pickup, and records already written keep the id. REFUSED while a scoped-limits row project:<id> names " +
      "it (the worker would keep its last good projects): delete or change that row first with dispatch_limit_delete or " +
      "dispatch_limit_edit. The operator MUST approve a confirm dialog naming the project; refused with no interactive operator.",
    executionMode: "sequential",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      // Judged BEFORE the confirm (`planProjectDelete`): a row naming the project refuses here, so the operator is never
      // asked to approve it.
      const planned: any = planProjectDelete({ id: params.id, paths, env: deploymentEnv() });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "project-delete", target: paths.projectsFile }, () => writeProjects({ ...plan.writeArgs, envelope: envelopeGuard(paths, deploymentEnv()) }));
        if (res.invalid) throw new Error(`rejected: ${escapeInterpreted(res.invalid)}`);
        return { applied: true, deleted: plan.deleted, ...(res.pending ? { pending: escapeInterpreted(res.pending) } : {}) };
      });
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_trigger_delete",
    label: "pi-dispatch delete trigger",
    description:
      "Removes a trigger from triggers.json (by array index from dispatch_triggers) and applies it live. The " +
      "operator MUST approve a confirm dialog showing the entry; with no interactive operator it is refused.",
    executionMode: "sequential",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0 }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(deploymentEnv());
      const planned: any = planTriggerDelete({ index: params.index, paths });
      if (planned.refusal) throw new Error(planned.refusal);
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, () => {
        const res: any = panelWrite(auditDir(), { kind: "trigger-delete", target: paths.triggersPath }, () => writeTriggers({ triggersPath: paths.triggersPath, mutate: plan.mutate, expect: plan.expect }));
        if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
        return { applied: true, deletedIndex: params.index };
      });
      return toolText(JSON.stringify(result));
    },
  });
  // Issue #504 part C: delegated allocation (REQ-DELEGATED-ALLOCATION, DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE). One
  // read, the delegated write that needs no keypress, and the confirm-gated envelope write. Every rule is the worker's:
  // the envelope through `parseEnvelope`, a plan through `applyPlan`. No result of any of the three carries a plan's
  // reason text: it is agent-authored, so it lives in `alloc:plan` and the audit file and is drawn only by the panel.
  pi.registerTool({
    name: "dispatch_allocations",
    label: "pi-dispatch allocations",
    description:
      "Read-only. The allocation envelope and the split applied inside it (PI_ENVELOPE_FILE, docs/allocation.md): the " +
      "envelope's window, total, floors, default weights and delegation rules; the applied split (plan id, writer, when " +
      "it was applied and until when, the weights, and each project's and repo's allocation in integer micro-dollars, " +
      "1 USD = 1000000); what each project has spent and holds in the envelope window; and the last 20 outcomes " +
      "(applied, refused with its reason, expired, rebased, reverted). It returns no reason text a plan carried. " +
      "`unset` means PI_ENVELOPE_FILE is unset: no envelope, no delegation.",
    parameters: Type.Object({}),
    async execute() {
      const a = allocationContext();
      const r = a.read;
      if (r.unset) return toolText(JSON.stringify({ unset: true }));
      if (!r.envelope) return toolText(JSON.stringify({ envelope: envelopeProblem(r) }));
      const alloc: any = await readAllocations({ url: a.paths.valkeyUrl, envelope: r.envelope, projects: r.projects, now: allocNow(), withReasons: false, ...allocRedis() });
      if (alloc.unreachable) throw new Error(`could not reach the queue: ${alloc.unreachable}`);
      return toolText(JSON.stringify({ envelope: envelopeShown(r.envelope, r.digest), ...alloc }));
    },
  });

  pi.registerTool({
    name: "dispatch_priorities_set",
    label: "pi-dispatch set priorities",
    description:
      "Sets a priorities plan: a WEIGHT per project (an integer 0 to 1000), and pi-dispatch splits the envelope's " +
      "headroom by it. NO confirm, and it works with no interactive operator: it can only move money between projects " +
      "inside the operator's envelope, never above the total, below a floor or by more than the envelope's step per " +
      "plan. `projects` must name every project of the envelope (dispatch_allocations lists them); `_other` (the jobs " +
      "in no listed project) keeps its current weight when it is left out. `reason` (at most 200 characters, no " +
      "control characters) is kept for the operator's panel and never returned. `repos` (optional) splits a " +
      "project's share by repo `ref` (the first 8 hex digits of sha256 of the member scope), naming every member. " +
      "`validDays` (optional) is how long the plan lives, at most the envelope's maxPlanDays; it then gives way to the " +
      "neutral split. The plan's basis is filled in from the applied plan. The result is the outcome (applied, " +
      "duplicate, refused or apply-failed), the refusal's reason (delegation-off, writer-not-allowed, " +
      "envelope-mismatch, plan-duplicate, plan-stale, plan-too-soon, plan-incomplete, plan-busy, or plan-invalid " +
      "with the field and rule), the plan id, whether the step clamped it, and each project's micro-dollars before " +
      "and after. A refusal changes nothing; every attempt is recorded.",
    executionMode: "sequential",
    parameters: Type.Object({
      projects: Type.Array(
        Type.Object({
          id: Type.String(),
          weight: Type.Integer({ minimum: 0, maximum: 1000 }),
          reason: Type.Optional(Type.String()),
          repos: Type.Optional(Type.Array(Type.Object({ ref: Type.String(), weight: Type.Integer({ minimum: 0, maximum: 1000 }) }))),
        }),
        { minItems: 1 },
      ),
      validDays: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    // NO confirmedWrite, on purpose (REQ-ADMIN-VIA-PI-EXTENSION, the delegated allocation write): the bound is the
    // envelope's arithmetic, not a keypress, and a confirm refused headless would make the unattended manager impossible.
    async execute(_id, params) {
      const res = await setPriorities(params.projects, params.validDays);
      return toolText(JSON.stringify(res));
    },
  });

  pi.registerTool({
    name: "dispatch_envelope_set",
    label: "pi-dispatch set the allocation envelope",
    description:
      "Changes the allocation envelope (PI_ENVELOPE_FILE) and applies it live: any of `window` (day, week or month), " +
      "`totalUsd` (a decimal string such as \"100\"), `floorsUsd` (project id to a decimal string; merged with the " +
      "file's, \"0\" is a floor), `defaultWeights` (project id to an integer 0 to 1000; merged), and the delegation " +
      "rules `enabled`, `writers` (operator-session, portfolio-job), `maxStepPct` (1 to 100), `minIntervalHours` and " +
      "`maxPlanDays`. The result is judged by the worker's own parser before the confirm (floors may not exceed the " +
      "total, a floor names a project in projects.json or _other, no floor above a project's own dollar row). The " +
      "operator MUST approve a confirm dialog showing the before->after; refused with no interactive operator. The " +
      "fleet re-bases the split onto the new envelope with no step.",
    executionMode: "sequential",
    parameters: Type.Object({
      window: Type.Optional(Type.String()),
      totalUsd: Type.Optional(Type.String()),
      floorsUsd: Type.Optional(Type.Record(Type.String(), Type.String())),
      defaultWeights: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 0, maximum: 1000 }))),
      enabled: Type.Optional(Type.Boolean()),
      writers: Type.Optional(Type.Array(Type.String())),
      maxStepPct: Type.Optional(Type.Integer()),
      minIntervalHours: Type.Optional(Type.Integer()),
      maxPlanDays: Type.Optional(Type.Integer()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Judged BEFORE the confirm (`planEnvelope`), so the operator is never asked to approve an envelope the worker would
      // refuse; a change the file already says is no write at all.
      const env = deploymentEnv();
      const paths = resolvePaths(deploymentEnv());
      const planned: any = planEnvelope({ params, paths, env });
      if (planned.refusal) throw new Error(planned.refusal);
      if (planned.unchanged) return toolText(JSON.stringify({ applied: false, reason: planned.unchanged }));
      const plan = planned.plan;
      const result = await confirmedWrite(ctx, { title: plan.title, message: plan.message }, async () => {
        const res: any = await panelWrite(auditDir(), { kind: "envelope-set", target: paths.envelopeFile, beforeDigest: plan.beforeDigest, afterDigest: plan.digest }, () => writeEnvelope({ ...plan.files, change: plan.change, expect: plan.expect, url: paths.valkeyUrl, ...allocRedis() }));
        if (res.invalid) throw new Error(`rejected: ${escapeInterpreted(res.invalid)}`);
        return { applied: true, digest: res.digest, previousDigest: res.previousDigest, changed: plan.lines };
      });
      return toolText(JSON.stringify(result));
    },
  });

}

/**
 * The single human-in-the-loop gate for every write tool. It is what lets a model-callable tool touch the
 * cap or the triggers file without breaking CONST-BUDGET-BEFORE-TOKENS / CONST-TRIGGER-AUTHOR-GATE: the model
 * emits the CALL, but the mutation runs only after the OPERATOR approves a `ctx.ui.confirm` dialog that shows
 * the concrete change. Fail-closed: with no confirm-capable UI (print/headless, `ctx.hasUI` false) it THROWs
 * rather than apply -- no operator, no write. An explicit decline is a determinate, non-error outcome
 * (`{ applied:false }`) -- the caller must not loop-retry it.
 */
async function confirmedWrite(
  rawCtx: any,
  prompt: { title: string; message: string },
  doWrite: () => any,
): Promise<any> {
  // THE TOOL DOOR (issue #404). A tool's `execute` gets its own `ctx` straight from pi and never passes
  // through the command handler, so the gate there does not reach it -- and this confirm body interpolates
  // the MODEL's own parameters: `dispatch_trigger_edit`'s `flow` put an erase-display and an OSC-52 write
  // into it, measured. Every tool that confirms does it through this one function.
  const ctx = gateDialogs(rawCtx);
  if (!ctx?.hasUI || typeof ctx?.ui?.confirm !== "function") {
    throw new Error(
      "refused: this change needs an interactive operator to confirm it, and no confirm-capable UI is available (e.g. print/headless mode).",
    );
  }
  const ok = await ctx.ui.confirm(prompt.title, prompt.message);
  if (!ok) return { applied: false, reason: "operator declined" };
  return doWrite();
}

// ---- delegated allocation (issue #504 part C) ----

/**
 * The deployment's allocation context, read per call: its paths and environment, the merged per-job cap the worker
 * judges the envelope with, and the envelope as read (`readEnvelope`).
 */
function allocationContext(): any {
  const env = deploymentEnv();
  const paths = resolvePaths(deploymentEnv());
  const maxCostMicros = envelopeJobCap({ settingsFile: paths.settingsFile, env });
  const read: any = readEnvelope({ envelopeFile: paths.envelopeFile, projectsPath: paths.projectsFile, scopedLimitsPath: paths.scopedLimitsPath, maxCostMicros });
  return { env, paths, maxCostMicros, read };
}

/** The envelope as a tool shows it: numbers and ids the parser checked, in micro-dollars, with its digest. */
function envelopeShown(e: any, digest: string): any {
  return { digest, window: e.window, totalMicros: e.totalMicros, floors: e.floors, defaultWeights: e.defaultWeights, delegation: e.delegation };
}

/**
 * Apply a priorities plan as the operator's session (`dispatch_priorities_set`, `/dispatch priorities set`). The plan
 * is built from what was given, the basis filled in by `applyPriorities` from the applied state, and `_other` keeps
 * its current weight when it is left out. Returns the worker's outcome with the micro-dollars before and after, and
 * NEVER a reason text. Throws only when there is no envelope to apply against or on infrastructure.
 */
async function setPriorities(projects: any[], validDays?: number): Promise<any> {
  const a = allocationContext();
  if (!a.read.envelope) throw new Error(envelopeProblem(a.read));
  const now = allocNow();
  const plan: any = planPriorities({ projects, validDays, now }).plan.plan;
  // Audited as the panel too (issue #642), beside the allocation audit file's own row: the console's chain then holds
  // every write this session made, and an append failure refuses the plan as a `refused` outcome the callers render.
  const res: any = await panelWrite(a.paths.logsDir, { kind: "priorities-set", target: "allocation", failure: allocationFailure, refusal: (s: string) => ({ outcome: "refused", reason: s }) }, () => applyPriorities({
    url: a.paths.valkeyUrl,
    envelope: a.read.envelope,
    digest: a.read.digest,
    projects: a.read.projects,
    plan,
    keepOther: true,
    host: allocHost(a.env),
    logsDir: a.paths.logsDir,
    now,
    ...allocRedis(),
  }));
  return res;
}

/** The panel's allocation read (issue #504 part C): the envelope as read, and the split WITH its reasons, for the view alone. */
async function allocationInfo(): Promise<any> {
  const a = allocationContext();
  if (!a.read.envelope) return { envelope: null, problem: envelopeProblem(a.read) };
  const alloc = await readAllocations({ url: a.paths.valkeyUrl, envelope: a.read.envelope, projects: a.read.projects, now: allocNow(), withReasons: true, ...allocRedis() });
  return { envelope: a.read.envelope, digest: a.read.digest, alloc };
}

/** The panel's revert to an `alloc:log` row (issue #504 part C): `revertAllocation` against the envelope as read now. */
async function revertTo(target: any): Promise<any> {
  const a = allocationContext();
  if (!a.read.envelope) return { outcome: "refused", reason: "no-envelope" };
  return panelWrite(a.paths.logsDir, { kind: "allocation-revert", target: "allocation", failure: allocationFailure, refusal: (s: string) => ({ outcome: "refused", reason: s }) }, () => revertAllocation({ url: a.paths.valkeyUrl, envelope: a.read.envelope, digest: a.read.digest, target, host: allocHost(a.env), logsDir: a.paths.logsDir, now: allocNow(), ...allocRedis() }));
}

/** An allocation write's failure for its audit row: an outcome other than applied, duplicate or reverted, with its reason enum. */
function allocationFailure(res: any): string | null {
  const outcome = res?.outcome;
  if (outcome === "applied" || outcome === "duplicate" || outcome === "reverted") return null;
  return `${typeof outcome === "string" ? outcome : "refused"}: ${typeof res?.reason === "string" ? res.reason : "unknown"}`;
}

/** The host name an audit row of this session carries: the deployment's PI_WORKER_NAME, else this machine's. */
function allocHost(env: any): string {
  return typeof env?.PI_WORKER_NAME === "string" && env.PI_WORKER_NAME !== "" ? env.PI_WORKER_NAME : hostname();
}

/**
 * `/dispatch priorities [set <id>=<weight> ...]` (issue #504 part C), operator-typed, zero-spend. The bare form sends
 * the envelope, the applied split, the spend and the history to the PII-free channel (no reason text: that channel
 * reaches model context); `set` applies a plan as `operator-session`, through the same path as the tool.
 */
async function prioritiesCommand(pi: ExtensionAPI, tokens: string[], notify: Notify): Promise<void> {
  if (tokens[1] === "set") {
    const given: any[] = [];
    for (const t of tokens.slice(2)) {
      const m = /^([a-z0-9_-]{1,32})=(\d{1,4})$/.exec(t);
      if (!m) {
        notify?.("usage: /dispatch priorities set <project>=<weight> ... (weights are integers 0 to 1000; _other keeps its weight unless given)", "warning");
        return;
      }
      given.push({ id: m[1], weight: Number(m[2]) });
    }
    if (given.length === 0) {
      notify?.("usage: /dispatch priorities set <project>=<weight> ...", "warning");
      return;
    }
    try {
      const res = await setPriorities(given);
      notify?.(prioritiesOutcome(res), res.outcome === "applied" || res.outcome === "duplicate" ? "info" : "warning");
    } catch (err: any) {
      notify?.(`priorities: ${scrubControls(String(err?.message ?? err))}`, "error");
    }
    return;
  }
  if (tokens.length > 1) {
    notify?.("usage: /dispatch priorities [set <project>=<weight> ...]", "warning");
    return;
  }
  const a = allocationContext();
  const alloc: any = a.read.envelope ? await readAllocations({ url: a.paths.valkeyUrl, envelope: a.read.envelope, projects: a.read.projects, now: allocNow(), withReasons: false, ...allocRedis() }) : null;
  send(pi, renderAllocations({ envelope: a.read.envelope ?? null, digest: a.read.digest ?? null, problem: a.read.envelope ? null : envelopeProblem(a.read), alloc }));
}

/** One line for a plan's outcome: the enum, the plan id, and each project's dollars after (never a reason text). */
function prioritiesOutcome(res: any): string {
  const after = res?.after?.allocations ?? {};
  const split = Object.keys(after).sort().map((id) => `${id} $${formatMicros(after[id])}`).join(", ");
  if (res?.outcome === "applied") return `applied ${res.planId}${res.clamped ? " (clamped by the step)" : ""}: ${split}`;
  if (res?.outcome === "duplicate") return `no change: plan ${res.planId} is already applied`;
  const field = res?.field ? ` (${res.field}: ${res.rule})` : "";
  return `${res?.outcome ?? "refused"}: ${res?.reason ?? "unknown"}${field}; the split is unchanged${split ? ` (${split})` : ""}`;
}

/**
 * The forge prompt and the per-forge pull-request action vocabulary, in one place each.
 *
 * Both were two-way ternaries naming github and gitlab. A third and fourth forge turns a ternary into a
 * chain, and an operator offered "github or gitlab" cannot discover that two more exist -- which is a
 * different failure from being refused: they simply never try.
 */
export const FORGE_PROMPT = `forge — ${FORGE_KINDS.slice(0, -1).join(", ")} or ${FORGE_KINDS.at(-1)}`;
// The DEFAULTS stay hand-written and the hints do not, which is the whole distinction this sweep is
// about. A hint restates what the loader ACCEPTS, so it is derived and cannot drift. A default answers
// what an operator most often wants, which is an editorial judgement and not a property of the table:
// gitlab's is `update`, not its set's first member `open`. Deriving it would manufacture a relation that
// does not exist, and `admin/test/wiring.test.mjs` asserts that it is NOT the set's head so this stays a
// decision rather than quietly becoming a coincidence.
//
// The close words ride the hint too (issue #231): the dialog passes whatever is typed through the shared
// validator, so a close-only rule IS authorable here, and a hint that omits the word reads as the word
// not existing. The loader refuses a list mixing a close word with any other action.
// Keyed against a DERIVED key set, so a fifth forge would otherwise get a correct hint and an undefined
// default -- and worse, because the key would exist, the `?? PR_ACTION_VOCAB.github` fallback at the
// dialog would stop firing. `wiring.test.mjs` asserts this covers FORGE_KINDS.
const PR_ACTION_DEFAULT: Record<string, string> = {
  github: "labeled",
  gitlab: "update",
  forgejo: "label_updated",
  azure: "updated",
};
export const PR_ACTION_VOCAB: Record<string, { hint: string; dflt: string }> = Object.fromEntries(
  FORGE_KINDS.map((forge: string) => [forge, { hint: [...(PR_ACTIONS[forge] as Set<string>)].join(" "), dflt: PR_ACTION_DEFAULT[forge] }]),
);

/**
 * The version 3 size fields (issue #596), each with the TypeBox schema both limit tools take it by. Keyed in the
 * worker's `SIZE_LIMIT_FIELDS` order and held to it by a test (`admin/test/size-tools.test.mjs`), so the two schemas,
 * the edit's carry, the dialog's carry and the builder share one list rather than four hand-written copies.
 * `memory` is a string ("1536m"); `cpus` a number or a decimal string, read by the worker's own parser
 * (`sizeFieldsOf`), so the confirm shows the one spelling the file holds.
 */
export const SIZE_FIELD_SCHEMAS = {
  memory: Type.Optional(Type.String()),
  cpus: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  hostShare: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  minJobs: Type.Optional(Type.Integer({ minimum: 1 })),
};

/**
 * `dispatch_limits`' dollar rows for one scoped limit (issue #501, part 7): `{ dollars: [{ window, cap, capMicros,
 * counterMicros }] }` for each dollar window the row caps, from `readScopedBudget`'s `usdMicros` (read under
 * `dollarKeyPrefixFor`, the worker's own key), or `{}` for a row with none. `counterMicros` is spent and held;
 * null when the counters could not be read, never an invented 0.
 */
function dollarRowsOf(l: any, used: any): any {
  const windows = [["dayUsd", "day"], ["weekUsd", "week"], ["monthUsd", "month"]].filter(([f]) => typeof l?.[f] === "string");
  if (windows.length === 0) return {};
  return {
    dollars: windows.map(([f, w]) => {
      const counter = used?.usdMicros?.[w];
      return { window: w, cap: l[f], capMicros: parseUsdMicros(l[f], f), counterMicros: Number.isSafeInteger(counter) ? counter : null };
    }),
  };
}

async function dispatch(pi: ExtensionAPI, args: string, rawCtx: any): Promise<void> {
  const ctx = gateDialogs(rawCtx);
  const notify = ctx?.ui?.notify?.bind(ctx.ui);
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "";
  const paths = resolvePaths(deploymentEnv());
  // Glyph posture BEFORE any rendering: every /dispatch surface (the overlay, the insights surfaces)
  // draws through panel.mjs' active table, and this is the one funnel all subcommands pass through. The
  // dashboard's own styler opts in per instance (makeStyler's `ascii`, threaded from these same paths in
  // makeDashboard), so PI_DISPATCH_ASCII now flips the overlay frame too, not only panel.mjs (issue #54).
  setGlyphs(paths.asciiGlyphs);

  // Drain the deployment pointer's retained one-line notice (a broken or newer pointer file) into the
  // operator's face exactly once: a surfaced warning, never a throw, and
  // never into model context.
  const pnote = takePointerNotice();
  if (pnote) notify?.(pnote, "warning");
  // And the deployment `.env`'s (issue #471), resolved just above by `deploymentEnv()`.
  if (serviceEnvNoticePending) {
    notify?.(serviceEnvNoticePending, "warning");
    serviceEnvNoticeShown = serviceEnvNoticePending;
    serviceEnvNoticePending = undefined;
  }

  // Drain the factory's version advisory the same way, once per process -- and at "info", not
  // "warning": a different-but-capable pi is a heads-up, not a defect (issue #96). Sits before the
  // sub dispatch below, so every subcommand (and the bare command) passes it.
  if (piVersionAdvisory) {
    notify?.(piVersionAdvisory, "info");
    piVersionAdvisory = undefined;
  }

  if (sub === "") {
    // Detection decides what a bare /dispatch means (issue #92). Lazy import: the wizard module loads
    // only on the bare command and `setup`, never for the read subcommands or the LLM tools.
    const { detectDeployment, runSetupWizard, readInstalledVersion, runtimeDirFor, RUNTIME_VERSION } = await import(
      "./setup-wizard.ts"
    );
    const det = await detectDeployment({ env: process.env, cwd: ctx?.cwd });
    if (det.state === "none") {
      // Nothing anywhere: the wizard IS what a bare /dispatch means here, so it is entered DIRECTLY.
      // There used to be a confirm in front of it ("…set one up now?"); it is gone on purpose. The
      // wizard's own step-1 select -- Guided setup / Open the panel anyway / Cancel -- is the consent,
      // and it is a better one: it offers the panel as a real third answer instead of dead-ending a
      // decline at a usage line. A confirm asking permission to ask was one keypress that bought
      // nothing, and nothing is spawned or written before that select answers.
      //
      // The degrade for a ctx without dialogs is the wizard's own capability gate (it notifies once and
      // returns), so there is deliberately NO notify here: two notices for one degrade reads like two
      // separate failures. `initialDetection` hands over the verdict just computed -- one keypress must
      // not cost two detections, queue probe included.
      await runSetupWizard(paths, ctx, notify, { openDashboardFn: openDashboard, initialDetection: det });
      return;
    }
    if (det.state === "pointer" && !runtimeSkewNoticed) {
      // Version skew between the deployment and this console (issue #96's other half): the pointer names
      // the folder, the folder's `node_modules` names the runtime version it actually runs, and this
      // admin pins the version it was reviewed against. Different is worth ONE line -- `/dispatch setup`
      // converges it, because its install step is a no-op when the pin already matches.
      //
      // Absent or unreadable ⇒ SILENCE, deliberately: an operator running the worker straight from a
      // clone has no `node_modules/@edgehero/pi-dispatch` to read, has made a deliberate choice, and
      // would be scolded for it every session by a notice that guessed instead of knowing.
      const ptrRes: any = readPointer({ path: pointerPath(process.env) });
      const deploymentDir = ptrRes.pointer?.deploymentDir;
      const installed = deploymentDir ? readInstalledVersion(nodeFs, runtimeDirFor(deploymentDir)) : undefined;
      if (typeof installed === "string" && installed !== RUNTIME_VERSION) {
        runtimeSkewNoticed = true;
        notify?.(
          `deployment runtime ${installed}, this console pins ${RUNTIME_VERSION} — run /dispatch setup to upgrade`,
          "warning",
        );
      }
    }
    if (det.state === "cwd" || det.state === "reachable") {
      // A deployment that works only from this directory (cwd scaffold) or was merely probed
      // (reachable queue, no config wired): open the panel as always, plus ONE hint that a pointer
      // would make it work from anywhere. "pointer"/"env" open with no hint -- exactly as today.
      notify?.(`using ${det.detail} — /dispatch setup can write a deployment pointer so this works from anywhere`, "info");
    }
    await openDashboard(paths, ctx, notify);
    return;
  }

  switch (sub) {
    case "status": {
      // An unreadable wait index costs the status line one named clause, never the whole answer
      // (issue #289): readHeldJobs never rejects -- it resolves rows or { unreachable } -- and the
      // heldCount ternary below is the degrade, reading undefined off the unreachable shape.
      const [queue, budget, held] = await Promise.all([
        readQueueState({ url: paths.valkeyUrl }),
        readBudget({ url: paths.valkeyUrl }),
        readHeldJobs({ url: paths.valkeyUrl }),
      ]);
      const settings = readSettingsView({ settingsFile: paths.settingsFile });
      const heldCount = Array.isArray((held as any)?.rows) ? (held as any).rows.length + (Number((held as any).more) || 0) : undefined;
      send(pi, `${renderStatus(queue, { heldCount, cronNext: (queue as any)?.cronNext ?? undefined })}\n${renderBudget({ budget, settings })}`);
      return;
    }
    case "runs": {
      const limit = tokens[1] ? Number(tokens[1]) : undefined;
      send(pi, renderRuns(listRuns({ logsDir: paths.logsDir, limit })));
      return;
    }
    case "budget": {
      const budget = await readBudget({ url: paths.valkeyUrl });
      const settings = readSettingsView({ settingsFile: paths.settingsFile });
      const limits: any = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
      const scopedBudget: any = Array.isArray(limits?.limits) && limits.limits.length > 0 ? await readScopedBudget({ url: paths.valkeyUrl, limits: limits.limits }) : { rows: [] };
      const scopedText = renderScopedLimits({ limits, scopedBudget });
      send(pi, `${renderBudget({ budget, settings })}${scopedText ? `\n${scopedText}` : ""}`);
      return;
    }
    case "triggers": {
      const schedulers = await readSchedulers({ url: paths.valkeyUrl });
      const triggers = readTriggers({ triggersPath: paths.triggersPath });
      // The project secret bundles (issue #704) under the triggers, on this MODEL-VISIBLE channel without the last
      // run's variable names (`names: false`): ids, projects and profile names are the reviewed file's, the names a
      // manager holds are not for model context. "" when the file binds none, so the output is as before.
      const bundles = renderSecretBundles(secretBundlesView({ triggers, settings: readSettingsView({ settingsFile: paths.settingsFile }), env: deploymentEnv(), projects: readProjects({ projectsPath: paths.projectsFile }) }), { names: false });
      send(pi, `${renderTriggers({ schedulers, triggers })}${bundles !== "" ? `\n\n${bundles}` : ""}`);
      return;
    }
    case "settings": {
      send(pi, renderSettingsView(readSettingsView({ settingsFile: paths.settingsFile })));
      return;
    }
    case "insights": {
      // The ONE analytics surface is the operator console's spend screen (the insights move to the console): this
      // prints its address, for a window or a what-if question. Still deliberately not an LLM-callable tool.
      insightsLink(tokens, notify);
      return;
    }
    case "console": {
      // Issue #708: the console's address, whether it runs, a sign-in link and the browser, in one step. An
      // operator-typed COMMAND and never a tool, for the reason `secrets` is one: a sign-in link is a login as an
      // operator, so it goes to `notify` (the operator's alone) and never through `send` (console-command.mjs).
      const env = deploymentEnv();
      const dir = pointerState().deploymentDir;
      await consoleCommand(tokens.slice(1), {
        hasUI: Boolean(ctx?.hasUI),
        mode: ctx?.mode,
        notify,
        select: typeof ctx?.ui?.select === "function" ? ctx.ui.select.bind(ctx.ui) : undefined,
        env,
        sessionEnv: process.env,
        logsDir: paths.logsDir,
        tokensPath: consoleTokensPathFor(env, dir),
        guarded: (codesDir: string) => guardedFiles().some((g) => g.dir === true && g.path === codesDir),
      });
      return;
    }
    case "run": {
      const folder = tokens[1];
      const flow = tokens[2];
      const task = tokens.slice(3).join(" ");
      if (!folder) {
        notify?.("usage: /dispatch run <folder> <flow> [task...]", "warning");
        return;
      }
      // Operator path (aiInvoked:false): ungated -- typing the command is the approval -- but the dirty
      // guard still fires inside enqueueDispatchRun. No spend knobs; provider/model/maxTurns resolve worker-side.
      const res: any = await panelWrite(paths.logsDir, { kind: "run-enqueue", target: folder, failure: enqueueFailure }, () => enqueueDispatchRun({ folder, flow, task, aiInvoked: false, env: deploymentEnv() }));
      if (res.refused) {
        notify?.(res.refused, "error");
        return;
      }
      if (res.unreachable) {
        notify?.(`could not reach the queue: ${res.unreachable}`, "error");
        return;
      }
      if (res.deduplicated) {
        notify?.(res.said, "info");
        return;
      }
      notify?.(`queued ${res.jobId} for ${folder} (${flow})`, "info");
      return;
    }
    case "logs":
      await showLogs(paths.logsDir, tokens, ctx);
      return;
    case "chat": {
      // Issue #647, part 2 (REQ-TERMINAL-CHAT): a run's chat from inside pi. An operator-typed COMMAND, never a tool:
      // it opens the dashboard, asks for an answer through dialogs, or hands the terminal to the operator's own pi, none
      // of which a model may start. The mode is `/api/run`'s rule over the panel's own fleet reader.
      if (tokens.length !== 2) {
        notify?.(CHAT_USAGE, "warning");
        return;
      }
      await dispatchChat(tokens[1], chatIo(paths, ctx, notify));
      return;
    }
    case "pause":
    case "resume": {
      const paused = sub === "pause";
      // The CLI's kill-switch rule (PR #475's review, round 3): a pause pauses BOTH Valkeys when this process's
      // VALKEY_URL and the deployment .env's disagree, a resume refuses then, and every URL is shown without userinfo.
      const set: any = await panelWrite(paths.logsDir, { kind: paused ? "fleet-pause" : "fleet-resume", target: "fleet", failure: switchFailure }, async () => await killSwitchSet({ paused }));
      if (set.refused) {
        notify?.(set.refused, "error");
        return;
      }
      if (set.disagreement) notify?.(`${set.disagreement}: pausing both`, "warning");
      for (const { shown, res } of set.results) {
        const at = set.results.length > 1 ? ` at ${shown}` : "";
        if (res.unreachable) {
          // A HALF switched deployment gets its own message. "Could not reach Valkey" reads as "nothing
          // happened", and walking away from a fleet with one host stopped and another spending is the one
          // outcome this switch exists to prevent.
          notify?.(
            res.partial
              ? `${paused ? "paused" : "resumed"} ${res.partial.done.join(", ")}${at} but FAILED at ${res.partial.failed}: the deployment is half ${paused ? "paused" : "resumed"}`
              : `could not reach Valkey at ${shown}: ${valkeyDownHint(shown)}`,
            "error",
          );
          continue;
        }
        const span = res.blind ? ` (fleet unknown: ${res.blind}, only ${res.queues[0]})` : res.queues.length > 1 ? ` (${res.queues.length} queues)` : "";
        notify?.(
          paused
            ? `paused${at}: worker will stop taking new jobs (jobs still enqueue; durable, survives restart)${span}`
            : `resumed${at}${span}`,
          "info",
        );
      }
      return;
    }
    case "set": {
      applySet(paths.settingsFile, tokens, notify);
      return;
    }
    case "unset": {
      applyUnset(paths.settingsFile, tokens, notify);
      return;
    }
    case "priorities": {
      await prioritiesCommand(pi, tokens, notify);
      return;
    }
    case "secrets": {
      // REQ-TRIGGER-SECRETS. Declaring a resolver profile means naming an absolute host path the WORKER
      // EXECUTES, so it lives on OPERATOR-TYPED surfaces only: this command, and the operator console's audited
      // `secret-profile-add` and `secret-bundle-add` forms (issue #642, a person submitting a form and approving its
      // preview). Never a tool: nothing a model can call declares one (issue #712 corrected an "and nowhere else" here,
      // which the console's forms had made untrue).
      //
      // THE SEPARATION IS STRUCTURAL, not a convention this file invented. `registerCommand` has no
      // parameter schema and no LLM-facing surface; pi reaches a command handler only from its own
      // `prompt()` path, which assistant text and tool results never enter, and its queueing APIs throw
      // outright on a slash-leading string. That is the same mechanism that makes `/dispatch setup`
      // operator-typed only, and it is why this is a subcommand rather than a fifteenth tool.
      //
      // The worker still does not trust what lands here. Every overlay-declared path is re-checked against
      // PI_SECRET_RESOLVER_ROOTS at resolution time, because PI_SETTINGS_FILE can put this settings.json
      // anywhere (its default was the OS temp directory until issue #290). A panel-side check alone would
      // be cosmetic.
      const { runSecretsCommand } = await import("./secrets-command.ts");
      // The deployment's env (issue #704): `list` says whether PI_SECRET_BUNDLES declares a bundle's profile, and `add
      // --bundle` refuses a name it already holds (the worker reads a name in both places as ambiguous).
      await runSecretsCommand(paths, ctx, notify, tokens.slice(1), { logsDir: paths.logsDir, env: deploymentEnv() });
      return;
    }
    case "setup": {
      // Same lazy import as the bare branch; openDashboard rides in as a dep so the wizard's final
      // step (and its "Open the panel anyway" escape) reuse this module's opener without a cycle at
      // evaluation time.
      const { runSetupWizard } = await import("./setup-wizard.ts");
      await runSetupWizard(paths, ctx, notify, { openDashboardFn: openDashboard });
      return;
    }
    default:
      notify?.(`dispatch: unknown subcommand '${sub}'. ${USAGE}`, "warning");
      return;
  }
}

// ---- the insights command surface (issues #53/#54/#175, unified by #181) ----
// COSTS_WINDOWS and costsSinceMs live in costs.mjs beside the fold: proration denominates on the
// requested window, so the scan cutoff and the fold's sinceMs must come from the one function.

// The pricing façade in the injectable shape the pure fold expects (costs.mjs takes `pricing` as an
// argument by contract; the tests hand it a canned fake, this object is the real one). The insights assembly
// takes it as a parameter too: insights-assembly.mjs stays pi-free, and this worker export loads pi-ai.
const PRICING = { listPricedModels, getPricedModel, isZeroRated, reprice, piAiVersion };

/** The costs fold for the dispatch_costs tool and the PROJECTS view, priced by the real façade (`assembleCostsOf`). */
function assembleCosts(paths: any, window: string, flow?: string, repo?: string, project?: string): any {
  return assembleCostsOf(paths, window, { flow, repo, project, pricing: PRICING });
}

// The insights slices the tests reach through this module, bound to the deployment's environment (`deploymentEnv`);
// the console binds its own. Each keeps its signature, and an `envFn` or `env` the caller passes wins.
export function assembleAllocationView(paths: any, counts: any, opts: any = {}): Promise<any> {
  return assembleAllocationViewOf(paths, counts, { envFn: deploymentEnv, ...opts });
}
export function assembleSizingView(paths: any, nowMs: number, opts: any = {}): Promise<any> {
  return assembleSizingViewOf(paths, nowMs, { envFn: deploymentEnv, ...opts });
}
export function assembleCapacityView(paths: any, window: string, nowMs: number, opts: any = {}): Promise<any> {
  return assembleCapacityViewOf(paths, window, nowMs, { envFn: deploymentEnv, ...opts });
}

const INSIGHTS_USAGE = "usage: /dispatch insights [7d|30d|mtd] | /dispatch insights whatif <provider/model> --flow <flow>";

/**
 * `/dispatch insights [7d|30d|mtd]` and `/dispatch insights whatif <provider/model> --flow <flow>`: the address of the
 * operator console's spend screen (the insights move to the console, REQ-ADMIN-VIA-PI-EXTENSION), for that window or
 * that what-if question, plus how to start the console. The console draws everything the static export drew and more
 * (the what-if form, the live data a file could not hold), so this command writes nothing and opens nothing: the URL is
 * the whole answer. Default window 30d, the page's own. The retired flags (`--no-open`, `--full-paths`) and any junk
 * answer the usage line, which is what teaches the new grammar. Exported for its tests: `env` is the deployment's
 * environment (`deploymentEnv()` by default), read for `PI_CONSOLE_LISTEN` and `PI_CONSOLE_BIND_PUBLIC` alone
 * (`link.mjs`, which parses them as the console does).
 */
export function insightsLink(tokens: string[], notify: Notify, env: any = deploymentEnv()): void {
  const rest = tokens.slice(1);
  let query: URLSearchParams;
  if (rest[0] === "whatif") {
    const target = rest[1] ?? "";
    const flowAt = rest.indexOf("--flow");
    const flow = flowAt >= 2 ? rest[flowAt + 1] : undefined;
    // The console page's own rules (its `parsePageQuery` checks the same two), so a URL printed here is one the page
    // accepts rather than one it refuses 400.
    if (!flow || rest.length !== 4 || !WHATIF_MODEL_RE.test(target) || !SKILL_NAME_RE.test(flow)) {
      notify?.(INSIGHTS_USAGE, "warning");
      return;
    }
    query = new URLSearchParams({ range: "30d", whatif: target, flow: flow as string });
  } else {
    const window = rest.length > 0 ? rest[0] : "30d";
    if (rest.length > 1 || !COSTS_WINDOWS.includes(window)) {
      notify?.(INSIGHTS_USAGE, "warning");
      return;
    }
    query = new URLSearchParams({ range: window });
  }
  notify?.(["insights are on the operator console's spend screen:", ...consolePageLines(env, `insights?${query}`)].join("\n"), "info");
}

/**
 * Open the live dashboard overlay for the bare `/dispatch`. The overlay is the panel's only surface, so a
 * pi build without `ctx.ui.custom` degrades to a usage note naming the reason rather than a silent no-op;
 * it never sends into the model channel. The `ctx.ui.custom` factory constructs the panel with the real
 * `tui`/`done`, so the queue and redis connections open only when the overlay actually shows.
 */
async function openDashboard(paths: any, ctx: any, notify: Notify, { initialTail = null }: { initialTail?: string | null } = {}): Promise<void> {
  const custom = ctx?.ui?.custom;
  if (typeof custom !== "function") {
    notify?.(`${USAGE} — the dashboard needs a TUI (this pi build has no overlay support)`, "info");
    return;
  }
  // `/dispatch chat` on a live run (issue #647, part 2) opens on that job's tail ONCE: a CRUD action that closes the
  // overlay reopens it on the LIST, as from a bare `/dispatch`.
  let tailOnce: string | null = initialTail;
  const factory = (tui: any, theme: any, _keybindings: any, done: (value: any) => void) =>
    makeDashboard({
      paths,
      done,
      tui,
      theme,
      initialTail: (() => {
        const t = tailOnce;
        tailOnce = null;
        return t;
      })(),
      deps: {
        // The dollar caps' env (issue #501, part 7): the deployment's, the source `dispatch_set`'s confirm reads. Its
        // writes (pause, resume, both cancels) go through the console's audit chain as the panel (issue #642).
        // The kill switch's plan (issue #642) is the CLI's and the tools' (`killSwitchPlan`): both Valkeys on a pause when this
        // process's and the deployment's disagree, and a resume refused then, so the TUI cannot resume one and strand the other.
        ...withAuditedWrites(createDashboardDeps(paths, { dollarEnvFn: deploymentEnv, killSwitchPlanFn: ({ paused }: any) => killSwitchPlan({ paused }) }), (opts: any, fn: () => any) => panelWrite(auditDir(), opts, fn)),
        // log read stays here; overlay-only, returns readLogTail's result verbatim. The live transcript (issue #643) comes
        // through `createDashboardDeps` above, off the fleet reader's held client; this is the fallback for a run with no
        // stream. `host` (the registry's host for the job) and `self` (this host's worker name, as the worker resolves it:
        // PI_WORKER_NAME, else the sanitized hostname) are what let a missing log say "this run is on host X": without
        // them `readLogTail` can never tell a foreign run from an uncaptured one, which is the gap #643 closed.
        tailLog: panelTailLog(paths),
        // REQ-RESURRECTABLE-SANDBOX, both seams. The fs read and the spawn live HERE for the same reason
        // tailLog does: dashboard.ts renders and holds the tui, and touches no filesystem and no child
        // process of its own. It brackets the launch with tui.stop()/tui.start(); this side only builds
        // the argv and runs it attached to the terminal.
        sandboxInfo: ({ jobId }: { jobId: string }) => readSandboxInfo(paths, jobId),
        // The PROJECTS view's spend (issue #499 part C): this month's fold by the project each record carries, read once
        // when the view opens. The records scan lives here with the other fs reads; the panel gets the fold arm only.
        // Issue #596, phase 3: with each project's size suggestion beside its spend, each raise capped by the live hosts'
        // budgets judged per host (the registry rows the panel's own tick read). One records read for every project.
        projectsInfo: ({ hosts }: any = {}) => {
          const c: any = assembleCosts(paths, "mtd");
          const sizing = projectSizing(paths, { hostBudgets: hostBudgetsOf(hosts), nowMs: Date.now() });
          return c?.unreachable ? { unreachable: String(c.unreachable), sizing } : { byProject: c?.fold?.byProject ?? [], sizing };
        },
        // The HOSTS view (issue #599 phase 3, key `u`): the capacity report of the last 7 days, read once when the view
        // opens, through `readCapacity`, the read `dispatch_capacity` and `pi-dispatch capacity` make, so the three cannot
        // print two reports. Read-only: no registry prune, no mirror write. Its Valkey and file reads live here.
        capacityInfo: ({ window = "7d" }: any = {}) => readCapacity({ url: paths.valkeyUrl, env: deploymentEnv(), window }),
        launchSandbox: ({ jobId }: { jobId: string }) => openSandboxSession(paths, jobId),
        // The ALLOCATION view (issue #504 part C, key `b`): the envelope and the split, read here where the Valkey and the
        // file reads live, WITH the plan's reasons, which only this view draws (escaped, through the control-byte gate).
        allocationInfo: () => allocationInfo(),
        // Its `r`: the worker's own revert, writer operator-revert, against the envelope as it is read now.
        revertAllocation: ({ target }: { target: any }) => revertTo(target),
        // OSC 52 clipboard write. This hands the terminal the operator's OWN selection: it fires only on
        // an explicit y/Y keypress in RUN_DETAIL, carries id-only strings (a jobId or a derived public
        // URL, never log bytes), and nothing is ever read back. The escape rides the stdout pi already
        // owns, which is exactly why it works over SSH where a spawned pbcopy/xclip would not. The write
        // lives HERE for the same reason tailLog's read does: dashboard.ts touches no process streams.
        copyText: (text: string) => {
          process.stdout.write(`\x1b]52;c;${Buffer.from(String(text)).toString("base64")}\x07`);
        },
        // The terminal's row count for the LIST collapse budget. Null -- not a guess -- when stdout
        // is not a TTY (rows undefined), which renders the full panel exactly as before.
        terminalRows: () => process.stdout.rows ?? null,
      },
    });
  const opts = { overlay: true, overlayOptions: { width: "75%", maxHeight: "90%", anchor: "center" } };
  // The overlay resolves with a CRUD action the operator triggered (add/edit/delete a trigger, edit
  // settings) or `undefined` to quit. A CRUD action is driven here via ctx.ui dialogs -- writes are
  // validated + atomic (`writeTriggers`/`writeSettings`) and the worker/receiver reload the file live -- then
  // the overlay REOPENS so the change is visible immediately. Only-operator-typed, never an LLM tool.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await custom.call(ctx.ui, factory, opts);
    if (!result || !result.action) return;
    await handleDashboardAction(result, paths, ctx);
  }
}

/**
 * `/dispatch chat`'s wiring (issue #647, part 2; `dispatch-chat.mjs` holds the logic): the deployment's environment
 * (its PI_SESSIONS_DIR and forge hosts, `panelEnv`), a read-only fleet reader for the lookup (`resolveRunChat`, the
 * console's own), this module's dashboard opener, the parked answer planned by `planParkedAnswer` from the panel (signed
 * with the reserved `panel`, whose trail says the /dispatch panel answered) and written through `panelWrite` around
 * `enqueueParkedAnswer`, and the fork's terminal lines scrubbed per line, as the sandbox's are (they run with the TUI
 * suspended, straight to the terminal). `seams` replace the readers, the planner, the enqueue, the dashboard opener and
 * the terminal in tests, nothing else (the audited write stays `panelWrite`, the call site the audit table scans).
 */
export function chatIo(paths: any, ctx: any, notify: Notify, seams: any = {}): any {
  const {
    envFn = deploymentEnv,
    readerFn = createFleetReader,
    planFn = planParkedAnswer,
    enqueueFn = enqueueParkedAnswer,
    dashboardFn = openDashboard,
    stdout = process.stdout,
    hostEnv = process.env,
  } = seams;
  const env = envFn();
  return {
    ui: ctx?.ui,
    env,
    openReader: () => readerFn(paths, { dollarEnvFn: envFn, readOnly: true }),
    openDashboard: ({ initialTail }: { initialTail: string }) => dashboardFn(paths, ctx, notify, { initialTail }),
    planAnswer: ({ jobId, text }: { jobId: string; text: string }) =>
      planFn({ url: paths.valkeyUrl, logsDir: paths.logsDir, jobId, text, from: "panel", triggersPath: paths.triggersPath ?? null, overlay: readSettingsView({ settingsFile: paths.settingsFile })?.overlay ?? {}, env }),
    // The one write `/dispatch chat` makes: the parked answer, its kind spelled here so the audit table's scan sees it.
    write: (opts: any, fn: () => any) => panelWrite(auditDir(), { ...opts, kind: "parked-answer" }, fn),
    enqueueAnswer: (plan: any) => enqueueFn(plan, { url: paths.valkeyUrl }),
    forkIo: {
      hostEnv,
      cwd: ctx?.cwd ?? process.cwd(),
      agentDir: hostEnv.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
      out: (line: string) => stdout.write(`${scrubControlsPerLine(String(line))}\n`),
    },
  };
}

/**
 * Whether this run is still re-openable, as a VERDICT rather than a path (REQ-RESURRECTABLE-SANDBOX).
 *
 * Synchronous on purpose: RUN_DETAIL reads it once on entry, inside a key handler, and one small
 * `readFileSync` there is cheaper than making the overlay's state a promise. Whether a sandbox is
 * currently running is deliberately NOT asked -- that needs docker and `pi-dispatch sandbox --list`
 * already answers it.
 */
export function readSandboxInfo(paths: any, jobId: string, { now = Date.now, env = process.env }: { now?: () => number; env?: any } = {}): any {
  if (!jobId) return null;
  if (!paths?.sandboxRetentionHours) return { retained: false, reason: "retention off" };
  const manifest = readManifest({ sandboxDir: paths.sandboxDir, jobId });
  if (!manifest) return { retained: false, reason: "swept" };
  // Issue #446: the same `id-mismatch` refusal `resolveSandbox` makes, so `b` is not offered for a directory that holds
  // another run (two ids that differ only in characters a file name cannot hold share one).
  if (typeof manifest.jobId === "string" && manifest.jobId !== String(jobId)) return { retained: false, reason: "not reopenable (another run holds its directory)" };
  // #277: the SAME venue refusal `resolveSandbox` applies when the key is pressed, asked here so the panel
  // never advertises `b` for a run this host cannot re-open. `retained` is this object's "re-openable"
  // verdict, which is what the dashboard's key guard reads.
  // THE THREE refusals `resolveSandbox` decides from the manifest alone, through the SAME predicate it
  // uses (issue #337), so the panel does not advertise `b` for a run this host cannot re-open.
  //
  // NOT every one, and the exception is named rather than left to be discovered: `decideSandboxJobUser`
  // can also refuse from the manifest alone, when the recorded job user is malformed (issue #341), and
  // that check is not in this predicate. The reason is MEASURED and lives at `sandboxSyncRefusal`'s own
  // declaration; the superseded one ("it would change what the CLI refuses and when") was corrected there
  // and left standing here for a round, which is the recurrence this round keeps catching (issue #367).
  // In short: that function checks the PLATFORM before it reads the stamp, so one malformed manifest
  // refuses on linux and every other posix and returns `{ user: null, home: null }` on darwin and win32.
  // Folding it in would make whether this panel offers `b` depend on the OPERATOR'S OS for an identical
  // run, where every other refusal here is a property of the run.
  //
  // It used to ask only the venue one, so a run whose manifest names no image, or whose local
  // folder moved, was offered the key, given two lines of egress detail about the session it would get,
  // and refused the moment the key was pressed. Copying the other two here instead of sharing them would
  // have been the shape `openSandbox`'s own docblock warns about: two callers assembling the same answer
  // from parts is how one of them drops a part.
  //
  // What stays in `openSandbox` is anything needing docker (a proxy that is not running, a sandbox
  // already up). This read is synchronous by design so RUN_DETAIL can do it once on entry inside a key
  // handler, and that residual is `OQ-038`'s rather than this function's.
  //
  // The MESSAGE is this pane's own, not the refusal's: `resolveSandbox` names the workspace path, and
  // the rule here is a retention state and never a path, because a manifest path embeds an account name
  // on Windows and this view renders beside PII-free record fields.
  //
  // WHICH VENUES OPEN HERE is this shell's `PI_BACKENDS` (issue #429), read through the worker's own parser exactly as
  // `openSandboxSession` will read it when `b` is pressed, and never the deployment's (`OQ-038`). A panel started
  // without it sees `local` alone, so a podman run is NOT offered here rather than offered and then launched under
  // docker: the launcher is the run's own venue's, and an unblessed venue is refused before anything is asked. A
  // malformed value is its own state, as a malformed `PI_EGRESS` is: the key press would refuse, so neither is offered.
  let policy;
  try {
    policy = sandboxVenuePolicy(env);
  } catch {
    return { retained: false, reason: "not reopenable (PI_BACKENDS or PI_BACKEND_FLOOR unreadable here)" };
  }
  const refusal = sandboxSyncRefusal({ jobId, manifest, blessed: policy.blessed });
  if (refusal) {
    // The venue the refusal itself read: a manifest with no `backend` key is a `local` run from before attribution,
    // so in a shell whose PI_BACKENDS leaves `local` out its cause is that variable, not a missing record.
    const venue = sandboxVenueOf(manifest);
    const named = typeof venue === "string" && venue !== "";
    // A venue this build CAN open, left out of this shell's PI_BACKENDS: the one reason here an operator fixes in
    // their own shell, so it says which variable. Kept under the pane's 53 columns.
    const unblessed = named && sandboxLauncher(venue) !== null;
    const reason =
      refusal.refused === "no-image"
        ? "not reopenable (the manifest names no image)"
        : refusal.refused === "workspace-gone"
          ? "not reopenable (the workspace has moved or been deleted)"
          : unblessed
            ? `not reopenable here (PI_BACKENDS lacks ${venue})`
            : named
              ? // Issue #712: the console's run page says the same words for the same venue (`sandboxShellRefusal`).
                (sandboxShellRefusal(venue) ?? `not reopenable here (ran on ${venue})`)
              : "not reopenable (no venue recorded)";
    return { retained: false, reason };
  }
  // Issue #446: a run past its deadline, or within the opener's grace of it, is refused when `b` is pressed unless the
  // open pins it first, and this panel has no pin. So it is not offered: the SAME predicate `resolveSandbox` asks, never
  // a copy of the window maths, and the reason names where the pin is (the CLI), kept under the pane's 53 columns. The
  // key press itself inherits the refusal from `openSandbox`, whose message carries the whole command.
  const at = now();
  if (sandboxWindowRefusal({ jobId, manifest, retentionHours: paths.sandboxRetentionHours, at })) {
    return { retained: false, reason: "past its window: open it with the CLI's --pin" };
  }
  // The runtime `b` would open this run in, so the pane can say where an egress-off shell lands (issue #429).
  // Issue #683: a venue with no launcher row (`openshell`) is refused by `sandboxSyncRefusal` above; if one ever reached
  // here, it is not reopenable, never reopened under docker.
  const launcher = sandboxLauncher(sandboxVenueOf(manifest));
  if (!launcher) return { retained: false, reason: sandboxShellRefusal(sandboxVenueOf(manifest)) ?? "not reopenable (its venue has no sandbox shell)" };
  const runtime = launcher.bin;
  // The sweep's own deadline rule (issue #446): the pin, else the earlier of the `retainUntil` the worker wrote and
  // `createdAt` plus this shell's window.
  const { until, source } = sandboxDeadline(manifest, paths.sandboxRetentionHours);
  const egress = sandboxEgressPosture(env);
  if (until === null) return { retained: true, egress, runtime };
  const hours = Math.max(0, Math.round((until - at) / 3600000));
  return { retained: true, pinned: source === "pin", expiresIn: hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`, egress, runtime };
}

/**
 * The egress posture a sandbox opened from HERE would get, and the fact that it is this shell's (#337).
 *
 * The panel resolves `PI_EGRESS` and `PI_EGRESS_PROXY` from its OWN process, through the worker's own
 * reader, because that is what `openSandbox` will use when `b` is pressed. What it cannot do is compare
 * that against the deployment's: nothing in this project loads a `.env` into a process, the panel may
 * have been started from anywhere, and a deployment pointer carries paths and never capability grants
 * (`INT-DEPLOYMENT-POINTER-CONTRACT`, and `deployment-pointer.mjs`'s own header). So the line states the posture AND its provenance, which is what #337 asks for: not a
 * claim about a mismatch it cannot see, but the plain fact that this is the environment it read.
 *
 * `malformed` is its own state rather than a guess. `egressArmed` throws on a `PI_EGRESS` it cannot
 * parse, and `openSandbox` refuses rather than opening a shell on the open network, so the panel must
 * not render that as "off".
 */
function sandboxEgressPosture(env: any): any {
  try {
    const { armed, proxy } = sandboxEgress(env);
    return { armed, proxy, source: "this shell" };
  } catch {
    return { malformed: true, source: "this shell" };
  }
}

/**
 * Open one run's sandbox attached to this terminal.
 *
 * The caller (dashboard.ts) has already suspended pi's TUI, so stdout is ours and `stdio: "inherit"` hands
 * the terminal to the container until the operator exits. A refusal prints and returns rather than
 * throwing: the panel is mid-suspend, and an exception here would surface as a broken screen instead of a
 * sentence.
 *
 * THROUGH `openSandbox`, the same function the CLI uses (#277). This used to call `resolveSandbox` and
 * `buildSandboxRunArgs` itself and pass no network, so a sandbox opened here ran on docker's default bridge
 * with `PI_EGRESS` armed, and a second press on a running sandbox tried to start another. The egress posture
 * is read with the worker's own readers, and a malformed `PI_EGRESS` refuses rather than opening the shell
 * on the open network.
 *
 * `io` is a test seam: every write goes through `io.write`, never `process.stdout` directly, because a test
 * runner reading the same stream would lose its own result frames to a stray write.
 */
export async function openSandboxSession(paths: any, jobId: string, io: any = {}): Promise<void> {
  // SCRUBBED AT THE SEAM, like every other terminal write in this extension. These lines run with the TUI
  // SUSPENDED, so they reach the raw terminal with nothing between them and it, and one of them interpolates
  // `manifest.image` -- read back by a bare `JSON.parse` from a manifest the WORKER stamped from the
  // trigger's `run.image`, which the project's own writer accepts verbatim. That is the same value the
  // panel's gate now holds; this path did not go through a pane at all.
  const out = io.write ?? ((s: string) => process.stdout.write(s));
  // Per LINE, because these messages carry deliberate newlines and `scrubControls` would turn each into a
  // space: the class is about what a terminal INTERPRETS, and the line breaks here are this code's own.
  const write = (s: string) => out(scrubControlsPerLine(s));
  const pause = io.pause ?? pauseForMessage;
  const env = io.env ?? process.env;
  let egress;
  // Issue #429: which venues open here and the floor a podman sandbox's observations must meet, from THIS process's
  // environment through the worker's own parsers, as `readSandboxInfo` read them. A malformed value refuses rather
  // than reading as "local only" or "no floor", for `sandboxEgress`'s reason.
  let policy;
  try {
    egress = sandboxEgress(env);
    policy = sandboxVenuePolicy(env);
  } catch (err: any) {
    write(`\ncannot open a sandbox for ${jobId}: ${err?.message}\n`);
    await pause();
    return;
  }
  // The runtime the run's venue launches through, learned in `beforeLaunch`; "docker" only before that point, where
  // no line below reads it.
  let runtime = "docker";
  const result = await openSandbox({
    jobId,
    sandboxDir: paths.sandboxDir,
    retentionHours: paths.sandboxRetentionHours,
    // env-internal TERM: the operator's own terminal type, passed through to the sandbox shell.
    term: env.TERM,
    idleSeconds: (paths.sandboxIdleMinutes ?? 0) * 60,
    egress,
    ...(io.running ? { running: io.running } : {}),
    ...(io.launch ? { launch: io.launch } : {}),
    ...(io.spawnNetwork ? { spawnNetwork: io.spawnNetwork } : {}),
    ...(io.resolveJobUser ? { resolveJobUser: io.resolveJobUser } : {}),
    // Issue #452 gate round 2: the keeper check an egress-armed podman open asks first, seamed like the rest.
    ...(io.keeperCheck ? { keeperCheck: io.keeperCheck } : {}),
    // Issue #452 gate round 3: the detach gate the session's teardown asks, seamed like the rest.
    ...(io.detachGate ? { detachGate: io.detachGate } : {}),
    // Issue #452 gate round 4: a teardown the detach gate refused leaves the session's network; said, never silent.
    onNetworkKept: (network: string, reason: string) => write(`\nthe egress network ${network} was kept (${reason}): start the rootless network keeper, and the worker's retention sweep removes it\n`),
    // Issue #446: the clock the past-window refusal reads, seamed like the rest. No `pin`: the panel offers none, so a
    // run past its window is refused here with the CLI command that pins it.
    ...(io.now ? { now: io.now } : {}),
    blessed: policy.blessed,
    backendFloor: policy.backendFloor,
    beforeLaunch: ({ resolved, runtime: cli }: any) => {
      runtime = cli ?? runtime;
      write(`\nopening ${resolved.name} — image ${resolved.manifest.image}\n`);
      write("no credentials are set in this container. exit the shell to return to the panel.\n\n");
    },
  });
  if (result.refused) {
    write(`\ncannot open a sandbox for ${jobId}: ${result.message}\n`);
    await pause();
    return;
  }
  if (result.detached) {
    write("\ndetached: the sandbox is still running with its egress network, which is left in place after it exits\n");
    await pause();
  }
  // Issue #446: a run lost from under the session after it started is said when the shell exits, and never acted on.
  if (result.lost) {
    write(`\nnote: ${result.message}\n`);
    await pause();
  }
  if (result.error) {
    write(`\ncould not start ${runtime}: ${result.error.message}\n`);
    await pause();
  }
  // THE THREE CODES A RUNTIME USES TO REFUSE, which used to redraw over themselves in silence (#337
  // item 4). The panel suspended pi's TUI to hand the terminal over, so without a pause the whole
  // failure is one line that `tui.start()` paints over before anyone reads it: the operator presses `b`
  // at a run that never opens and no screen says why.
  //
  // WORDED SO THE CODE CAN CARRY IT, which took two goes. The sandbox runs `--entrypoint bash -i`, so
  // `docker run` returns BASH's status, and 125, 126 and 127 are each used by both sides: the runtime
  // for "I refused before the container ran", and bash for its own last command. The first draft claimed
  // the sandbox "never opened", which is false for an operator who typed `exit 1`; the second narrowed
  // to 125 alone, which made a genuine `exec bash failed: No such file or directory` (127) silent again,
  // and a mistyped flag on `timeout` (which documents 125 as its own failure) still spoke. No exit code
  // separates the two, so the line states the code and offers the runtime reading CONDITIONALLY. Both
  // readings are then true, and the redraw is stopped for all three.
  //
  // Telling them apart properly needs a docker read (whether a container by that name exists after the
  // exit, or a `--cidfile`), which is a second round trip in a key handler. Recorded in `OQ-038` as one
  // more thing this panel cannot settle without docker, beside the posture it can only read from its own
  // environment.
  const refusalCause = SANDBOX_RUNTIME_REFUSAL_CAUSES[result.code];
  if (refusalCause) {
    write(`\nthe sandbox exited ${result.code}. If no shell opened, ${refusalCause}\n`);
    await pause();
  }
}

/**
 * The exit codes a container runtime uses to refuse before the container runs, each with the cause THAT
 * code means. Docker and Podman both use all three, and they do not mean the same thing: 125 is the
 * runtime's own refusal, while 126 and 127 come from the exec of the entrypoint. A shared list of causes
 * was written first and was wrong for two of the three, offering a name clash as a reason for a 127 and
 * omitting the one the widening was FOR -- `exec bash failed: No such file or directory`.
 *
 * Bash uses the same three codes for its own last command, which is why each line offers rather than
 * asserts: "if no shell opened" is true whichever side produced the code.
 */
const SANDBOX_RUNTIME_REFUSAL_CAUSES: Record<number, string> = {
  125: "the runtime refused before the container ran: the name may be taken by a container that is still around, the image may be missing under --pull=never, or DOCKER_HOST in this shell may not be the daemon you think it is",
  126: "the image's entrypoint is not executable",
  127: "the image has no entrypoint at that path (a sandbox needs bash in the image)",
};
/**
 * Hold the suspended terminal open long enough to read a refusal, then return.
 *
 * A TIMER, deliberately, and not a keypress. pi's `terminal.stop()` calls `process.stdin.pause()`, so a
 * `stdin.once("data")` here would never fire and the panel would hang suspended forever -- waiting on
 * input from a stream the suspend just paused. Resuming stdin to read one key would mean re-entering the
 * input handling that the suspend exists to hand away. A fixed pause cannot deadlock, and this path is
 * reached whenever `openSandbox` refuses at the key press, or docker cannot be started.
 */
function pauseForMessage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2500));
}

/**
 * Drive a CRUD action the dashboard overlay signalled, using pi's `ctx.ui` dialogs (`select`/`input`/
 * `confirm`). Every write goes through `writeTriggers`/`writeSettings` (validated + atomic + fail-closed);
 * the live-reload watchers apply it without a restart. A build without the dialog primitives degrades to a
 * notice rather than a crash. `undefined` from any dialog is a cancel.
 */
export async function handleDashboardAction(result: any, paths: any, rawCtx: any): Promise<void> {
  // GATED HERE TOO, not only at `dispatch` (issue #404). This is an EXPORTED entry: the dashboard reaches it
  // through `dispatch`, which already wraps, but a caller that has its own `ctx` -- every test in
  // `crud.test.mjs` does -- would otherwise drive the dialogs ungated, which is the same "covered on one
  // path" shape the render gates were refuted for. Wrapping twice is harmless: the scrub is idempotent.
  const ctx = gateDialogs(rawCtx);
  const ui = ctx?.ui;
  const notify: Notify = ui?.notify?.bind(ui);
  // The `i` key (issue #181): the console's spend screen address, between overlays, then the caller's loop reopens
  // the panel. BEFORE the dialog guard on purpose -- this action needs no dialogs, and an older pi without them must
  // still reach the one analytics surface.
  if (result.action === "openInsights") {
    return insightsLink(["insights"], notify);
  }
  if (typeof ui?.input !== "function" || typeof ui?.select !== "function" || typeof ui?.confirm !== "function") {
    notify?.("editing needs a newer pi (no input/select/confirm dialogs)", "warning");
    return;
  }
  switch (result.action) {
    case "addTrigger":
      return addTriggerViaDialogs(paths, ui, notify);
    case "editTrigger":
      return editTriggerFlow(paths, ui, notify, result.index);
    case "deleteTrigger":
      return deleteTriggerEntry(paths, ui, notify, result.index, result.confirmed === true);
    case "editSettings":
      return editSettingsViaDialogs(paths, ui, notify);
    case "managePauses":
      return managePausesViaDialogs(paths, ui, notify);
    case "manageLimits":
      return manageLimitsViaDialogs(paths, ui, notify);
  }
}

async function manageLimitsViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const action = await ui.select("Scoped limits", ["Add a scoped limit", "Edit a scoped limit", "Delete a scoped limit"]);
  if (!action) return;
  if (action.startsWith("Add")) return addScopedLimitViaDialogs(paths, ui, notify);
  if (action.startsWith("Edit")) return editScopedLimitViaDialogs(paths, ui, notify);
  return deleteScopedLimitViaDialogs(paths, ui, notify);
}

/** Add a scoped limit: scope, then the four optional bounds (blank = omit). Validated + live. */
async function addScopedLimitViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const expect = writeInputs({ paths: [paths.scopedLimitsPath, paths.projectsFile] }); // the files as the change is built from them (PR #569's second review)
  const scope = await ui.input("scope: a repo \"owner/name\" (every forge), \"<forge>:owner/name\" such as github:acme/web (one forge), or an ABSOLUTE local folder path (exact match, no globs)", "");
  if (scope === undefined || scope.trim() === "") return;
  const day = await ui.input("day — max jobs per UTC day for this scope (blank = no day cap)", "");
  if (day === undefined) return;
  const week = await ui.input("week — max jobs per Mon-Sun UTC week (blank = no week cap)", "");
  if (week === undefined) return;
  const month = await ui.input("month — max jobs per calendar month (blank = no month cap)", "");
  if (month === undefined) return;
  const concurrent = await ui.input("concurrent — max jobs in flight for this scope, extras deferred (blank = no limit)", "");
  if (concurrent === undefined) return;
  const l = buildScopedLimit({ scope, day, week, month, concurrent });
  const res: any = panelWrite(auditDir(), { kind: "limit-add", target: paths.scopedLimitsPath }, () => writeScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath, projectsPath: paths.projectsFile, expect, envelope: envelopeGuard(paths, deploymentEnv()), mutate: (list: any[]) => [...list, l] }));
  notify?.(res.ok ? `scoped limit added (${liveOr(res)}): ${l.scope} ${limitSummary(l)}` : `add rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/**
 * Edit a scoped limit: select which, re-prompt each field with its current value (blank keeps it). Exported for its
 * test: the fields it does not prompt for (the dollar windows and, since issue #596, the size) must be carried.
 */
export async function editScopedLimitViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const expect = writeInputs({ paths: [paths.scopedLimitsPath, paths.projectsFile] }); // the files as the change is built from them (PR #569's second review)
  const p: any = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
  const list: any[] = Array.isArray(p?.limits) ? p.limits : [];
  if (list.length === 0) { notify?.("no scoped limits to edit", "info"); return; }
  const labels = list.map((l, i) => `#${i + 1}  ${l.scope}  ${limitSummary(l)}`);
  const picked = await ui.select("Edit which scoped limit", labels);
  if (!picked) return;
  const index = labels.indexOf(picked);
  if (index < 0) return;
  const cur = list[index];
  const ask = async (label: string, current: string) => ui.input(`${label} — blank keeps "${current}"`, current);
  const keep = (v: string | undefined, current: any) => (v === undefined || v.trim() === "" ? current : v);
  const scope = await ask("scope: \"owner/name\" (every forge), \"<forge>:owner/name\" (one forge) or an ABSOLUTE folder path", cur.scope ?? "");
  if (scope === undefined) return;
  const day = await ask("day cap", String(cur.day ?? ""));
  if (day === undefined) return;
  const week = await ask("week cap", String(cur.week ?? ""));
  if (week === undefined) return;
  const month = await ask("month cap", String(cur.month ?? ""));
  if (month === undefined) return;
  const concurrent = await ask("concurrent (max in flight)", String(cur.concurrent ?? ""));
  if (concurrent === undefined) return;
  const merged = buildScopedLimit({
    scope: keep(scope, cur.scope),
    day: keep(day, cur.day),
    week: keep(week, cur.week),
    month: keep(month, cur.month),
    concurrent: keep(concurrent, cur.concurrent),
    // Carried unchanged (see dispatch_limit_edit): editing a count must never drop a dollar cap, nor a size (#596).
    dayUsd: cur.dayUsd,
    weekUsd: cur.weekUsd,
    monthUsd: cur.monthUsd,
    ...sizeFieldsFrom((k) => cur[k]),
  });
  const note = scopeChangeNote(buildScopedLimit(cur), merged);
  if (note !== "" && !(await ui.confirm(`Edit scoped limit #${index + 1}`, `${cur.scope} → ${merged.scope}.${note}`))) return;
  const res: any = panelWrite(auditDir(), { kind: "limit-edit", target: paths.scopedLimitsPath }, () => writeScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath, projectsPath: paths.projectsFile, expect, envelope: envelopeGuard(paths, deploymentEnv()), mutate: (l: any[]) => l.map((w, i) => (i === index ? merged : w)) }));
  notify?.(res.ok ? `scoped limit #${index + 1} updated (${liveOr(res)}): ${merged.scope} ${limitSummary(merged)}` : `edit rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/**
 * The projects' size suggestions (issue #596, phase 3, DES-SIZE-SUGGESTIONS) for the PROJECTS view, the edit preview and
 * the insights page: the worker's own `suggestSize` over this host's run records, read once for every project, each
 * raise capped by the live hosts' budgets judged per host (`hostBudgets`, `hostBudgetsOf`; null where no budget was read,
 * and a raise then offers no call). `projectIds` defaults to every project in the projects file. `{ projects, hosts,
 * skipped }` (`hosts` how many budgets were judged against, null for none read), or `{ unreachable }` when the records
 * or the scoped-limits file cannot be read: a size resolved without the file would be the default, which is not the
 * project's.
 */
export function projectSizing(paths: any, opts: { hostBudgets?: any[] | null; projectIds?: string[] | null; nowMs: number; withSeries?: boolean }): any {
  return projectSizingOf(paths, { envFn: deploymentEnv, ...opts });
}

/**
 * The lines `dispatch_limit_edit`'s confirm adds when it changes a size field of a `project:<id>` row (issue #596,
 * phase 3): the project's size now, its runs' peaks (p95 memory, p95 cores) and what they suggest, so the operator
 * approves a size against what the jobs used. Empty for any other row. Advisory: the numbers come from inside the jobs'
 * containers, and the edit is what the operator confirms, not the suggestion. No host budget is read here (it would put
 * a registry read inside a confirm), so a raise names what the runs ask for and says the budget was not checked.
 */
export function sizingNote(paths: any, scope: any, nowMs: number): string {
  if (typeof scope !== "string" || !scope.startsWith("project:")) return "";
  const id = scope.slice("project:".length);
  const sizing = projectSizing(paths, { projectIds: [id], nowMs });
  if (sizing.unreachable) return `\nThe project's runs could not be read (${sizing.unreachable}).`;
  const s = sizing.projects?.[id];
  if (!s) return "";
  const m = s.memory;
  const c = s.cpu;
  const peaks = `p95 peak ${m.evidence.p95MiB === null ? "none" : formatMemory(m.evidence.p95MiB)} over ${m.evidence.samples} runs, p95 ${c.evidence.p95CoresCenti === null ? "none" : coresText(c.evidence.p95CoresCenti)} used over ${c.evidence.samples} runs`;
  const said = (dim: any, words: string, shown: (v: number) => string) => {
    if (dim.suggested) return `${shown(dim.suggested)} (${dim.reason}: ${words})`;
    if (dim.held === "no-cap") return `${shown(dim.wanted)} (${dim.reason}: ${words}; budget not checked here)`;
    if (dim.held === "largest") return `no larger size (${dim.reason}: ${words})`;
    return dim.reason === "not-enough-runs" ? notEnoughRunsText(dim, shown === formatCpus ? cpusText : shown) : "fits";
  };
  const facts = [s.words.memoryFact, s.words.cpuFact].filter(Boolean);
  return `\nProject ${id}'s runs (the last ${SUGGEST_WINDOW_DAYS} days, measured inside the jobs, so advisory): size now ${formatMemory(m.current)}, ${cpusText(c.current)}; ${peaks}. They suggest memory ${said(m, s.words.memory, formatMemory)}, CPUs ${said(c, s.words.cpu, formatCpus)}.${facts.length > 0 ? ` ${facts.map((f: string) => `${f[0].toUpperCase()}${f.slice(1)}.`).join(" ")}` : ""}`;
}

/** Delete a scoped limit: select which, confirm, remove. */
async function deleteScopedLimitViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const expect = writeInputs({ paths: [paths.scopedLimitsPath, paths.projectsFile] }); // the files as the change is built from them (PR #569's second review)
  const p: any = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
  const list: any[] = Array.isArray(p?.limits) ? p.limits : [];
  if (list.length === 0) { notify?.("no scoped limits to delete", "info"); return; }
  const labels = list.map((l, i) => `#${i + 1}  ${l.scope}  ${limitSummary(l)}`);
  const picked = await ui.select("Delete which scoped limit", labels);
  if (!picked) return;
  const index = labels.indexOf(picked);
  if (index < 0) return;
  const ok = await ui.confirm("Delete scoped limit", `Remove ${labels[index]}?`);
  if (!ok) return;
  const res: any = panelWrite(auditDir(), { kind: "limit-delete", target: paths.scopedLimitsPath }, () => writeScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath, projectsPath: paths.projectsFile, expect, envelope: envelopeGuard(paths, deploymentEnv()), mutate: (l: any[]) => l.filter((_, i) => i !== index) }));
  notify?.(res.ok ? `scoped limit #${index + 1} deleted (${liveOr(res)})` : `delete rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Pause-window management: pick add / edit / delete, then run the matching dialog. One overlay key (`w`). */
async function managePausesViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const action = await ui.select("Pause windows", ["Add a pause window", "Edit a pause window", "Delete a pause window"]);
  if (!action) return;
  if (action.startsWith("Add")) return addPauseWindowViaDialogs(paths, ui, notify);
  if (action.startsWith("Edit")) return editPauseWindowViaDialogs(paths, ui, notify);
  return deletePauseWindowViaDialogs(paths, ui, notify);
}

/** Add a pause window: scope + from/to, then the optional tz/days/date bounds (blank = omit). Validated + live. */
async function addPauseWindowViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const scope = await ui.input("scope: a repo \"owner/name\" (every forge), \"<forge>:owner/name\" such as github:acme/web (one forge), a local folder path, or \"*\" for all", "");
  if (scope === undefined || scope.trim() === "") return;
  const from = await ui.input("from — pause start \"HH:MM\" 24h (from > to = overnight)", "22:00");
  if (from === undefined) return;
  const to = await ui.input("to — resume time \"HH:MM\" 24h", "06:00");
  if (to === undefined) return;
  const tz = await ui.input("tz — IANA timezone (blank = UTC), e.g. Europe/Amsterdam", "");
  if (tz === undefined) return;
  const days = await ui.input("days — space-separated weekdays to restrict to (blank = every day), e.g. mon tue", "");
  if (days === undefined) return;
  const dateFrom = await ui.input("dateFrom — only on/after \"YYYY-MM-DD\" (blank = no bound)", "");
  if (dateFrom === undefined) return;
  const dateTo = await ui.input("dateTo — only on/before \"YYYY-MM-DD\" (blank = no bound)", "");
  if (dateTo === undefined) return;
  const w = buildPauseWindow({ scope, from, to, tz, days, dateFrom, dateTo });
  const res: any = panelWrite(auditDir(), { kind: "pause-window-add", target: paths.pauseWindowsPath }, () => writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (list: any[]) => [...list, w] }));
  notify?.(res.ok ? `pause window added (live) — ${w.scope} ${w.from}-${w.to}` : `add rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Edit a pause window: select which, then re-prompt each field with its current value — a blank answer keeps
 * it, so you only re-type what you change. Validated + live through the same `writePauseWindows`. */
async function editPauseWindowViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const p = readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath });
  const list: any[] = Array.isArray(p?.windows) ? p.windows : [];
  if (list.length === 0) { notify?.("no pause windows to edit", "info"); return; }
  const labels = list.map((w, i) => `#${i + 1}  ${w.scope}  ${w.from}-${w.to} ${w.tz}${w.days ? ` [${w.days.join(",")}]` : ""}`);
  const picked = await ui.select("Edit which pause window", labels);
  if (!picked) return;
  const index = labels.indexOf(picked);
  if (index < 0) return;
  const cur = list[index];
  // Each field's current value is the placeholder; a blank answer keeps it (undefined = the operator cancelled).
  const ask = async (label: string, current: string) => ui.input(`${label} — blank keeps "${current}"`, current);
  const keep = (v: string | undefined, current: any) => (v === undefined || v.trim() === "" ? current : v);
  const scope = await ask("scope: \"owner/name\" (every forge), \"<forge>:owner/name\" (one forge), a folder path or \"*\"", cur.scope ?? "");
  if (scope === undefined) return;
  const from = await ask("from (HH:MM)", cur.from ?? "");
  if (from === undefined) return;
  const to = await ask("to (HH:MM)", cur.to ?? "");
  if (to === undefined) return;
  const tz = await ask("tz (IANA / UTC)", cur.tz ?? "UTC");
  if (tz === undefined) return;
  const days = await ask("days (space-separated)", (cur.days ?? []).join(" "));
  if (days === undefined) return;
  const dateFrom = await ask("dateFrom (YYYY-MM-DD)", cur.dateFrom ?? "");
  if (dateFrom === undefined) return;
  const dateTo = await ask("dateTo (YYYY-MM-DD)", cur.dateTo ?? "");
  if (dateTo === undefined) return;
  const merged = buildPauseWindow({
    scope: keep(scope, cur.scope),
    from: keep(from, cur.from),
    to: keep(to, cur.to),
    tz: keep(tz, cur.tz),
    days: keep(days, cur.days),
    dateFrom: keep(dateFrom, cur.dateFrom),
    dateTo: keep(dateTo, cur.dateTo),
  });
  const res: any = panelWrite(auditDir(), { kind: "pause-window-edit", target: paths.pauseWindowsPath }, () => writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (l: any[]) => l.map((w, i) => (i === index ? merged : w)) }));
  notify?.(res.ok ? `pause window #${index + 1} updated (live) — ${merged.scope} ${merged.from}-${merged.to}` : `edit rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Delete a pause window: select which (by a scope/time label), confirm, remove. */
async function deletePauseWindowViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const p = readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath });
  const list: any[] = Array.isArray(p?.windows) ? p.windows : [];
  if (list.length === 0) { notify?.("no pause windows to delete", "info"); return; }
  const labels = list.map((w, i) => `#${i + 1}  ${w.scope}  ${w.from}-${w.to} ${w.tz}${w.days ? ` [${w.days.join(",")}]` : ""}`);
  const picked = await ui.select("Delete which pause window", labels);
  if (!picked) return;
  const index = labels.indexOf(picked);
  if (index < 0) return;
  const ok = await ui.confirm("Delete pause window", `Remove ${labels[index]}?`);
  if (!ok) return;
  const res: any = panelWrite(auditDir(), { kind: "pause-window-delete", target: paths.pauseWindowsPath }, () => writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (l: any[]) => l.filter((_, i) => i !== index) }));
  notify?.(res.ok ? `pause window #${index + 1} deleted (live)` : `delete rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Add a trigger: kind-first (the on x run diagonal is locked by construction), then the per-kind fields. */
async function addTriggerViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const kind = await ui.select("Add trigger — kind", ["cron", "label", "comment", "pull_request"]);
  if (!kind) return;
  let entry: any;
  if (kind === "cron") {
    const id = await ui.input("cron id — unique name for this schedule, no ':'", "nightly");
    if (id === undefined) return;
    const pattern = await ui.input("schedule — cron pattern, 5 or 6 fields (min hour day month weekday)", "0 3 * * *");
    if (pattern === undefined) return;
    const folder = await ui.input("folder — absolute host path the job runs in (must exist)", "");
    if (folder === undefined) return;
    const flow = await ui.input("flow — the .pi/skills/<name> skill to run (its SKILL.md is the agent's instructions)", "fix");
    if (flow === undefined) return;
    const task = await ui.input("task — the prompt text handed to the agent for this run", "run the flow");
    if (task === undefined) return;
    // Optional per-cron overrides — blank keeps the deployment default (overlay/env) at job start.
    const model = await ui.input("model — this schedule's model (blank = deployment default)", "");
    if (model === undefined) return;
    const provider = await ui.input("provider — this schedule's provider (blank = deployment default)", "");
    if (provider === undefined) return;
    const maxTurns = await ui.input("maxTurns — turn budget for this schedule (blank = deployment default)", "");
    if (maxTurns === undefined) return;
    entry = buildTriggerEntry("cron", { id, pattern, folder, flow, task, model, provider, maxTurns });
  } else if (kind === "label") {
    // Webhook triggers run against the triggering repo, and the issue/PR text is the task — neither is set here.
    const forge = await ui.input(FORGE_PROMPT, "github");
    if (forge === undefined) return;
    const labels = await ui.input("labels — space-separated, any-of (a project member applies one to fire)", "pi:fix");
    if (labels === undefined) return;
    const flow = await ui.input("flow — the .pi/skills/<name> skill to run (the issue text is the task)", "fix");
    if (flow === undefined) return;
    // An azure work item belongs to a PROJECT, not a repository, so nothing in the delivery says where to
    // clone and the trigger has to name it. Asked only for azure, because the loader refuses it elsewhere.
    const repository = forge === "azure" ? await ui.input("repository — the repo within the project to clone (azure work items name none)", "") : undefined;
    if (repository === undefined && forge === "azure") return;
    entry = buildTriggerEntry("label", { labels, flow, forge, repository });
  } else if (kind === "comment") {
    const forge = await ui.input(FORGE_PROMPT, "github");
    if (forge === undefined) return;
    const phrase = await ui.input("trigger phrase — a comment containing this fires the flow (e.g. @pi)", "@pi");
    if (phrase === undefined) return;
    const flow = await ui.input("flow — the .pi/skills/<name> skill to run (the comment/issue text is the task)", "fix");
    if (flow === undefined) return;
    const repository = forge === "azure" ? await ui.input("repository — the repo within the project to clone (azure work items name none)", "") : undefined;
    if (repository === undefined && forge === "azure") return;
    entry = buildTriggerEntry("comment", { phrase, flow, forge, repository });
  } else {
    const forge = await ui.input(FORGE_PROMPT, "github");
    if (forge === undefined) return;
    // The action vocabulary is the forge's own, and a word from the wrong one is refused at the write --
    // so the prompt names the right set rather than offering a union that half-works.
    const vocab = PR_ACTION_VOCAB[forge] ?? PR_ACTION_VOCAB.github;
    const action = await ui.input(`MR/PR actions — space-separated: ${vocab.hint}`, vocab.dflt);
    if (action === undefined) return;
    // Azure attaches tags to work items and never to pull requests, so a predicate there could never match
    // and the loader refuses one. Not asking beats asking and discarding.
    const labels = forge === "azure" ? "" : await ui.input("labels for 'labeled' — space-separated (blank for the auto actions)", "pi:review");
    if (labels === undefined) return;
    const flow = await ui.input("flow — the .pi/skills/<name> skill to run (the PR text is the task)", "review");
    if (flow === undefined) return;
    entry = buildTriggerEntry("pull_request", { action, labels, flow, forge });
  }
  const res: any = panelWrite(auditDir(), { kind: "trigger-add", target: paths.triggersPath }, () => writeTriggers({ triggersPath: paths.triggersPath, mutate: (list: any[]) => [...list, entry] }));
  notify?.(res.ok ? `trigger added (live) — ${kind} → ${entry.run.flow}` : `add rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Edit a trigger's flow in place (the common "change what a trigger runs" edit). */
async function editTriggerFlow(paths: any, ui: any, notify: Notify, index: number): Promise<void> {
  if (typeof index !== "number") return;
  const flow = await ui.input(`new flow for trigger #${index + 1} — the .pi/skills/<name> skill it runs`, "");
  if (flow === undefined || flow.trim() === "") return;
  const res: any = panelWrite(auditDir(), { kind: "trigger-edit", target: paths.triggersPath }, () => writeTriggers({
    triggersPath: paths.triggersPath,
    mutate: (list: any[]) => list.map((t, i) => (i === index ? { ...t, run: { ...t.run, flow: flow.trim() } } : t)),
  }));
  notify?.(res.ok ? `flow updated (live) → ${flow.trim()}` : `edit rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/**
 * Delete a trigger after an explicit confirm. `confirmed` marks a y/n the operator already answered inside
 * the overlay's own frame (TRIGGER_DETAIL arms `x`, `y` executes) — asking again through `ui.confirm` would
 * be the same question twice, so it is skipped. The write path is identical either way: the shared
 * validate-then-rename `writeTriggers`, never a second door.
 */
async function deleteTriggerEntry(paths: any, ui: any, notify: Notify, index: number, confirmed = false): Promise<void> {
  if (typeof index !== "number") return;
  if (!confirmed) {
    const ok = await ui.confirm("Delete trigger", `Remove trigger #${index + 1} from triggers.json?`);
    if (!ok) return;
  }
  const res: any = panelWrite(auditDir(), { kind: "trigger-delete", target: paths.triggersPath }, () => writeTriggers({ triggersPath: paths.triggersPath, mutate: (list: any[]) => list.filter((_, i) => i !== index) }));
  notify?.(res.ok ? `trigger #${index + 1} deleted (live)` : `delete rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Edit a limit / runtime setting: pick a key, then a value (blank unsets). Reuses the operator-typed
 * `set`/`unset` path, so the same validation + effect-next-job semantics apply. */
async function editSettingsViaDialogs(paths: any, ui: any, notify: Notify): Promise<void> {
  const key = await ui.select("Change a limit / setting", [...KNOWN_KEYS]);
  if (!key) return;
  const value = await ui.input(`${key} — new value (blank to unset)`, "");
  if (value === undefined) return;
  if (value.trim() === "") applyUnset(paths.settingsFile, ["unset", key], notify);
  else applySet(paths.settingsFile, ["set", key, value.trim()], notify);
}

type Notify = ((message: string, type?: string) => void) | undefined;

/**
 * `set <key> <value>`: the key must be a known settings key (checked BEFORE the write, since
 * `writeOverlay` silently drops unknown keys and would report ok on a no-op), the value is coerced by the
 * key's type, and exactly one value token is accepted (model ids carry no spaces). A rejected candidate
 * surfaces `writeOverlay`'s key-only reason, and a present-but-invalid file is refused rather than rebuilt
 * (`writeSettings`, issue #501), so no prior overlay is ever lost to a set. The checks are `planSettingSet`'s
 * (write-plans.mjs, the command surface); a dollar key's write carries the deployment's env, so `writeSettings`
 * returns a WARNING beside it (issue #501, PR #542's review), never a refusal.
 */
function applySet(settingsFile: string, tokens: string[], notify: Notify): void {
  const key = tokens[1] ?? "";
  const planned: any = planSettingSet({ key, valueTokens: tokens.slice(2), ...settingsCommandContext(settingsFile), surface: "command" });
  if (planned.refusal) {
    notify?.(planned.refusal, "error");
    return;
  }
  const plan = planned.plan;
  const res: any = panelWrite(auditDir(), { kind: "setting-set", target: settingsFile }, () => writeSettings({ settingsFile, mutate: plan.mutate, ...plan.writeArgs }));
  if (res.invalid) {
    notify?.(`set: ${res.invalid}`, "error");
    return;
  }
  notify?.(`set ${key} = ${plan.value}${res.warning ? ` (warning: ${res.warning})` : ""}`, res.warning ? "warning" : "info");
}

/**
 * The deployment as the operator-typed `set`/`unset` judge it: its paths with the settings file the command writes,
 * its environment (the dollar settings' source and the envelope's per-job cap), and the pointer's folder.
 */
function settingsCommandContext(settingsFile: string): any {
  return { paths: { ...resolvePaths(deploymentEnv()), settingsFile }, env: deploymentEnv(), shown: { deploymentDir: pointerState().deploymentDir ?? null } };
}

/**
 * `unset <key>`: the key must be a known settings key; the mutation deletes it, and an empty result `{}`
 * is a valid written state (no overrides). Over a present-but-invalid file it is refused like `set`.
 */
function applyUnset(settingsFile: string, tokens: string[], notify: Notify): void {
  const key = tokens[1] ?? "";
  const planned: any = planSettingUnset({ key, ...settingsCommandContext(settingsFile), surface: "command" });
  if (planned.refusal) {
    notify?.(planned.refusal, "error");
    return;
  }
  const plan = planned.plan;
  const res: any = panelWrite(auditDir(), { kind: "setting-unset", target: settingsFile }, () => writeSettings({ settingsFile, mutate: plan.mutate, ...plan.writeArgs }));
  if (res.invalid) {
    notify?.(`unset: ${res.invalid}`, "error");
    return;
  }
  notify?.(`unset ${key}${res.warning ? ` (warning: ${res.warning})` : ""}`, res.warning ? "warning" : "info");
}

// ---- the panel's audit (issue #642) ----

/**
 * The logs directory this session's writes are audited in: the deployment's PI_LOGS_DIR as the panel resolves it
 * (`resolvePaths(deploymentEnv())`, the directory the run history is read from), so the panel, the console and doctor
 * read one chain. Read per call like every other path; `panelAudit` builds the writer once per directory.
 */
function auditDir(): string {
  return resolvePaths(deploymentEnv()).logsDir;
}

/** An enqueue's failure for its audit row: a refusal, an unreachable queue, or a swallowed duplicate (nothing queued). */
function enqueueFailure(res: any): string | null {
  if (typeof res?.refused === "string" && res.refused !== "") return res.refused;
  if (res?.unreachable) return "could not reach the queue";
  if (res?.deduplicated) return "a duplicate: nothing new was queued";
  return null;
}

/**
 * The model-visible channel for the PII-free structured views. `display: true` shows the text; the empty
 * options object is deliberate -- NEVER `triggerTurn`, which would spend a paid turn just to observe state.
 */
/**
 * THE MODEL-VISIBLE CHANNEL, and the third place the control-byte gate runs (issue #382).
 *
 * `renderTriggers`, `renderSettingsView` and `renderScopedLimits` print trigger, settings and limit fields
 * that nothing re-validates on read -- `on.phrase` and a label arrive from `dispatch_trigger_add` itself --
 * and they went straight to `sendMessage` without passing either pane gate, because those two sit in the
 * overlay's own render path and this channel does not go near it. So an escape reached the terminal AND
 * model context through `/dispatch triggers` while the overlay showing the same trigger was clean.
 *
 * `scrubControls` per LINE, not over the whole string: this channel is plain text with no styling to
 * preserve, and the newlines between rows are this code's own.
 */
function send(pi: ExtensionAPI, content: string): void {
  const safe = scrubControlsPerLine(content);
  pi.sendMessage({ customType: CHANNEL, content: safe, display: true }, {});
}

/**
 * Show a job's raw `.log` in the overlay viewer, and ONLY there. Raw container output is untrusted and
 * PII-bearing, so it must never enter model context: if the pi build has no `ctx.ui.custom`, this fails
 * LOUD (an error notification, or console.error) and returns -- it never falls back to `sendMessage`,
 * which would leak the bytes into context, and never silently no-ops, which would fake "no logs".
 */
async function showLogs(logsDir: string, tokens: string[], ctx: any): Promise<void> {
  const notify = ctx?.ui?.notify?.bind(ctx.ui);
  const jobId = tokens[1];
  if (!jobId) {
    notify?.("usage: /dispatch logs <jobId> [lines]", "warning");
    return;
  }
  const lines = tokens[2] ? Number(tokens[2]) : undefined;
  // The record already says which machine ran this job, so a foreign run can be named rather than reported
  // as "no captured log" (issue #57, Gap 3). One file read that the viewer would not otherwise do, on a
  // command an operator types by hand -- and only its `host` field is used.
  const record: any = readRun({ logsDir, jobId });
  const tail = readLogTail({ logsDir, jobId, lines, host: record?.host ?? null, self: deploymentEnv().PI_WORKER_NAME ?? null });

  const custom = ctx?.ui?.custom;
  if (typeof custom !== "function") {
    const message = "logs viewer unavailable in this pi version -- raw logs are never sent to the model";
    if (notify) notify(message, "error");
    else console.error(`[pi-dispatch/admin] ${message}`);
    return;
  }

  await custom.call(ctx.ui, makeLogViewer(jobId, tail), { overlay: true });
}

const VIEWPORT_LINES = 20;

/**
 * Build the scrollable log-viewer factory for `ctx.ui.custom`. The component renders a bounded window of
 * the tail with a title, and scrolls on up/down/pageUp/pageDown; escape closes via `done`. A missing log
 * renders a capture-off note rather than an empty view. The lines live only in this closure -- there is no
 * path from here to `sendMessage`.
 */
function makeLogViewer(jobId: string, tail: { lines?: string[]; missing?: boolean; elsewhere?: string }) {
  const missing = tail.missing === true;
  const lines = missing ? [] : tail.lines ?? [];
  const maxTop = () => Math.max(0, lines.length - VIEWPORT_LINES);
  let top = 0;

  return (_tui: any, _theme: any, _keybindings: any, done: (value: void) => void) => {
    const component = {
      render(width: number): string[] {
        // EVERY LINE THROUGH THE GATE, and the width honoured (issue #382). This view printed the `.log`
        // file's own bytes RAW and ignored the width it was handed: container output, the most untrusted
        // content this extension renders, straight to the operator's terminal with CSI, OSC-8 and OSC-52 in
        // it, on lines measured at 134 columns inside a 40-column pane. LIVE_TAIL gates the same bytes and
        // has since #367; this viewer was the other half of the same content and was missed.
        //
        // The id and `elsewhere` go through it too: the id arrives from the COMMAND LINE, whose `\s+` split
        // keeps an ESC or a BEL, and `elsewhere` is a `host` field read back off a run record.
        //
        // A non-finite width is guarded because `clip(x, NaN)` returns "" -- an unguarded NaN blanks the
        // whole viewer rather than failing.
        const w = Number.isFinite(width) && width > 0 ? Math.trunc(width) : 80;
        const line = (text: string) => clipData(text, w);
        if (missing) {
          // A run that happened on another machine is NOT "no captured log". The bytes exist, on a host this
          // panel deliberately cannot reach, and saying so is the difference between an operator who knows
          // where to look and one who concludes capture is off.
          return tail.elsewhere
            ? [line(`logs ${jobId} -- this run happened on ${tail.elsewhere}; its raw log stays on that host. Esc to close.`), ""]
            : [line(`logs ${jobId} -- no captured log (PI_CAPTURE_JOB_LOGS off or not found). Esc to close.`), ""];
        }
        const out = [line(`logs ${jobId} -- ${lines.length} line(s). Up/Down scroll, PgUp/PgDn page, Esc close.`), ""];
        for (const l of lines.slice(top, top + VIEWPORT_LINES)) out.push(line(String(l)));
        out.push("", line(`[${Math.min(top + VIEWPORT_LINES, lines.length)}/${lines.length}]`));
        return out;
      },
      invalidate(): void {
        // No cached render state to clear; the TUI redraws from render().
      },
      handleInput(data: string): void {
        if (matchesKey(data, "escape")) {
          done(undefined);
          return;
        }
        if (missing) return;
        if (matchesKey(data, "up")) top = Math.max(0, top - 1);
        else if (matchesKey(data, "down")) top = Math.min(maxTop(), top + 1);
        else if (matchesKey(data, "pageUp")) top = Math.max(0, top - VIEWPORT_LINES);
        else if (matchesKey(data, "pageDown")) top = Math.min(maxTop(), top + VIEWPORT_LINES);
        component.invalidate();
      },
    };
    return component;
  };
}

/**
 * Argument completion: the first token completes against the subcommand names; `logs <partial>` completes
 * against the run ids present on disk; `insights <partial>` against the three windows plus `whatif`, and
 * `insights whatif <partial>` against the priced catalog -- the long-tail model picker, now that no
 * interactive filter exists. Returns null (not []) when there is nothing to offer.
 */
function completeArguments(prefix: string) {
  const parts = prefix.trimStart().split(/\s+/);
  if (parts.length <= 1) {
    const token = parts[0] ?? "";
    const items = KNOWN_SUBCOMMANDS.filter((s) => s.startsWith(token)).map((s) => ({ value: s, label: s }));
    return items.length > 0 ? items : null;
  }
  if (parts[0] === "logs" && parts.length === 2) {
    const partial = parts[1];
    const ids = listRunIds({ logsDir: resolvePaths(deploymentEnv()).logsDir });
    const items = ids
      .filter((id) => id.startsWith(partial))
      .map((id) => ({ value: `logs ${id}`, label: id }));
    return items.length > 0 ? items : null;
  }
  if (parts[0] === "chat" && parts.length === 2) {
    // A run id from this host's history; a link or a session key is typed whole.
    const partial = parts[1];
    const ids = listRunIds({ logsDir: resolvePaths(deploymentEnv()).logsDir });
    const items = ids
      .filter((id) => id.startsWith(partial))
      .map((id) => ({ value: `chat ${id}`, label: id }));
    return items.length > 0 ? items : null;
  }
  if (parts[0] === "console" && parts.length >= 2) {
    // The page words and the flags; a run id is typed whole (or completed under `logs`).
    const partial = parts[parts.length - 1];
    const head = parts.slice(0, -1).join(" ");
    const items = [...CONSOLE_PAGE_WORDS, "--link", "--no-open"]
      .filter((w) => w.startsWith(partial) && !parts.slice(1, -1).includes(w))
      .map((w) => ({ value: `${head} ${w}`, label: w }));
    return items.length > 0 ? items : null;
  }
  if (parts[0] === "insights" && parts.length === 2) {
    const partial = parts[1];
    const items = ["7d", "30d", "mtd", "whatif"]
      .filter((w) => w.startsWith(partial))
      .map((w) => ({ value: `insights ${w}`, label: w }));
    return items.length > 0 ? items : null;
  }
  if (parts[0] === "insights" && parts[1] === "whatif" && parts.length === 3) {
    const partial = parts[2];
    const items = listPricedModels()
      .map((m: any) => `${m.provider}/${m.id}`)
      .filter((t: string) => t.startsWith(partial))
      .map((t: string) => ({ value: `insights whatif ${t}`, label: t }));
    return items.length > 0 ? items : null;
  }
  if ((parts[0] === "set" || parts[0] === "unset") && parts.length === 2) {
    const partial = parts[1];
    const items = KNOWN_KEYS.filter((k) => k.startsWith(partial)).map((k) => ({
      value: `${parts[0]} ${k}`,
      label: k,
    }));
    return items.length > 0 ? items : null;
  }
  return null;
}
