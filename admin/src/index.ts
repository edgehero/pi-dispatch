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
 * Tested pi version: 0.80.7 (SUPPORTED_PI_VERSION). The gate is the capability
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import {
  resolvePaths,
  readQueueState,
  readSchedulers,
  readBudget,
  listRuns,
  readRun,
  readLogTail,
  readSettingsView,
  readTriggers,
  readPauseWindows,
  listRunIds,
  setQueuePaused,
  writeSettings,
  writeTriggers,
  writePauseWindows,
  enqueueDispatchRun,
  scanRunRecords,
  readSubscriptions,
  KNOWN_KEYS,
  GRAPH_LIMITS,
  cronRunStats,
  joinRunsToTriggers,
  attributeRunsToTriggers,
  observedChainEdges,
  collectGraphInputs,
  forgeRepoTargets,
} from "./read-model.mjs";
import { buildGraphModel } from "./graph-model.mjs";
import { buildInsightsHtml } from "./insights-html.mjs";
import { openBrowser } from "@edgehero/pi-dispatch/open-browser";
// The worker's OWN window classifier (the same one reserveBudget enforces), so the budget states the
// insights payload carries are words the page never derives and the panel and enforcement cannot drift.
import { windowState } from "@edgehero/pi-dispatch/budget";
// The deployment pointer (INT-DEPLOYMENT-POINTER-CONTRACT): the wizard-written file that aims this
// extension at a deployment built in another directory. Layered into process.env once at factory load
// (the operator's env always wins), so resolvePaths stays env-only by contract while every one of its
// call sites below is covered without a signature change.
// readPointer/pointerPath join the import for ONE reader: the bare command's version-skew notice, which
// needs the pointed-at `deploymentDir` to find the deployment's installed runtime. readPointer stays pure
// (it never stats that dir) -- the stat lives at the call site below, which is exactly where the pointer
// module's documented purity says it belongs.
import { applyDeploymentPointer, pointerPath, readPointer, takePointerNotice } from "./deployment-pointer.mjs";
// The only fs use in this module: the skew notice reads one package.json through the wizard's own reader.
// Everything else fs-shaped goes through read-model.mjs by design.
import * as nodeFs from "node:fs";
import { COSTS_WINDOWS, costsSinceMs, foldCosts, foldTriggerCosts, whatIfFlow } from "./costs.mjs";
// The REAL pricing façade. costs.mjs may not hold a module-scope worker/pricing import by contract (the
// fold is pure; tests inject a canned fake) -- index.ts is where the fs-adjacent assembly lives, so the
// injection happens here.
import { getPricedModel, isZeroRated, listPricedModels, piAiVersion, reprice } from "@edgehero/pi-dispatch/pricing";
import { setGlyphs } from "./panel.mjs";
import { buildSandboxRunArgs, launchSandbox as spawnSandbox, resolveSandbox, sandboxContainerName } from "@edgehero/pi-dispatch/sandbox";
import { readManifest } from "@edgehero/pi-dispatch/sandbox-store";
import { renderStatus, renderRuns, renderBudget, renderTriggers, renderSettingsView, renderWhatIf } from "./render.mjs";
import { makeDashboard, createDashboardDeps } from "./dashboard.ts";
// Only the nudge is loaded eagerly (it must register its session_start handler at factory time); the
// wizard itself stays behind the dispatch handler's lazy import. The setup-wizard module imports
// buildTriggerEntry back from here -- a cycle on paper, but both sides only call across it at runtime.
import { registerNudge } from "./setup-wizard.ts";
import { matchesKey } from "./keys.mjs";

// The single source of truth for the ExtensionAPI surface this extension
// consumes. It grows only when a task actually uses a new member.
export const USED_API = ["registerCommand", "registerTool", "sendMessage", "on"] as const;

export const SUPPORTED_PI_VERSION = "0.80.7";

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

/** TEST-ONLY: arm the advisory directly (under the pinned devDep pi the natural computation is a no-op). */
export function _setPiVersionAdvisoryForTests(message: string | undefined): void {
  piVersionAdvisory = message;
}

const CHANNEL = "pi-dispatch-admin";

const REBUILT_NOTICE = (reason: string) =>
  `replaced invalid settings file (${reason}) — other keys were lost`;

const USAGE =
  "usage: /dispatch <status|pause|resume|run|runs|logs|budget|insights|triggers|settings|set|unset|setup|secrets>";

const KNOWN_SUBCOMMANDS = [
  "status",
  "pause",
  "resume",
  "run",
  "runs",
  "logs",
  "budget",
  "insights",
  "triggers",
  "settings",
  "set",
  "unset",
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
  // resolvePaths(process.env). Placement matters twice over: AFTER the capability probe, so a refused
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

  pi.registerCommand("dispatch", {
    // The operator-visible summary; a subcommand once went missing from it while USAGE carried it,
    // which is exactly the drift the USAGE/KNOWN_SUBCOMMANDS pin exists to catch -- keep all three
    // in step.
    description:
      "pi-dispatch admin: status|pause|resume|run|runs|logs|budget|insights|triggers|settings|set|unset|setup",
    getArgumentCompletions: (prefix) => completeArguments(prefix),
    handler: async (args, ctx) => dispatch(pi, args, ctx),
  });

  registerTools(pi);
  registerSkill(pi);
  registerNudge(pi);
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
 * `dispatch_triggers`. On/off:
 * `dispatch_pause`/`dispatch_resume` (durable, reversible, money-safe -- no confirm). The gated PAID enqueue:
 * `dispatch_run`. Confirm-gated writes: `dispatch_set` (a limit/setting) and `dispatch_trigger_add`/`_edit`/
 * `_delete`. There is still NO log tool -- raw `.log` bytes never enter model context (DES-ADMIN-VIA-PI-EXTENSION
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
      const paths = resolvePaths(process.env);
      const [queue, budget, schedulers] = await Promise.all([
        readQueueState({ url: paths.valkeyUrl }),
        readBudget({ url: paths.valkeyUrl }),
        readSchedulers({ url: paths.valkeyUrl }),
      ]);
      const settings = readSettingsView({ settingsFile: paths.settingsFile });
      return toolText(JSON.stringify({ queue, budget, settings, schedulers }));
    },
  });

  pi.registerTool({
    name: "dispatch_runs",
    label: "pi-dispatch runs",
    description:
      "Read-only. Returns structured, PII-free run records from the durable run history. Raw job logs are not available to tools — ask the user to run /dispatch logs.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      jobId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const paths = resolvePaths(process.env);
      const data = params.jobId
        ? readRun({ logsDir: paths.logsDir, jobId: params.jobId })
        : listRuns({ logsDir: paths.logsDir, limit: params.limit ?? 10 });
      return toolText(JSON.stringify(data));
    },
  });

  pi.registerTool({
    name: "dispatch_costs",
    label: "pi-dispatch costs",
    description:
      "Read-only. Folds the PII-free run history against the operator's declared subscriptions and pi-ai's " +
      "rate tables into the costs read-model: window totals, daily buckets, per-flow and per-model rollups, " +
      "per-plan verdicts, and provenance. window = 7d | 30d | mtd (default mtd); flow filters to one flow's runs.",
    parameters: Type.Object({ window: Type.Optional(Type.String()), flow: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      const window = params.window ?? "mtd";
      if (!COSTS_WINDOWS.includes(window)) {
        throw new Error(`unknown window '${window}' (7d|30d|mtd)`);
      }
      const paths = resolvePaths(process.env);
      const res = assembleCosts(paths, window, params.flow);
      if (res.unreachable) throw new Error(`could not read the run history: ${res.unreachable}`);
      // The fold's dollars are TYPED `{ usd, class, floor, ... }` on purpose: the class rides beside every
      // number in this JSON, so a model consuming it cannot launder an estimate into a fact by dropping
      // the label -- the same discipline fmtCost enforces on the text views.
      return toolText(JSON.stringify({ window, fold: res.fold }));
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
      const paths = resolvePaths(process.env);
      const res = await setQueuePaused({ url: paths.valkeyUrl, paused: true });
      if (res.unreachable) {
        throw new Error(`could not reach the queue at ${paths.valkeyUrl}: ${res.unreachable}`);
      }
      return toolText("paused");
    },
  });

  pi.registerTool({
    name: "dispatch_resume",
    label: "pi-dispatch resume",
    description: "Re-enables PAID job processing after a pause. Only call when the user explicitly asks to resume.",
    executionMode: "sequential",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(process.env);
      const res = await setQueuePaused({ url: paths.valkeyUrl, paused: false });
      if (res.unreachable) {
        throw new Error(`could not reach the queue at ${paths.valkeyUrl}: ${res.unreachable}`);
      }
      return toolText("resumed");
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
      const res = await enqueueDispatchRun({
        folder: params.folder,
        flow: params.flow,
        task: params.task,
        aiInvoked: true,
      });
      if (res.refused) throw new Error(res.refused);
      if (res.unreachable) throw new Error(`could not reach the queue: ${res.unreachable}`);
      return toolText(JSON.stringify({ jobId: res.jobId, folder: params.folder, flow: params.flow }));
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
      const paths = resolvePaths(process.env);
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
      if (!KNOWN_KEYS.includes(params.key)) {
        throw new Error(`unknown key '${params.key}'. valid keys: ${KNOWN_KEYS.join(", ")}`);
      }
      const paths = resolvePaths(process.env);
      const view = readSettingsView({ settingsFile: paths.settingsFile });
      const oldVal = view?.overlay?.[params.key];
      const unset = params.value === undefined || params.value.trim() === "";
      const newVal = unset ? undefined : coerceSettingValue(params.key, params.value.trim());
      const result = await confirmedWrite(
        ctx,
        {
          title: unset ? `Unset ${params.key}` : `Set ${params.key}`,
          message: `${params.key}: ${oldVal ?? "(unset)"} -> ${unset ? "(unset)" : newVal}`,
        },
        () => {
          const res = unset
            ? writeSettings({ settingsFile: paths.settingsFile, mutate: (o) => { delete o[params.key]; return o; } })
            : writeSettings({ settingsFile: paths.settingsFile, mutate: (o) => ({ ...o, [params.key]: newVal }) });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, key: params.key, value: unset ? null : newVal, rebuiltFrom: res.rebuiltFrom ?? null };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_trigger_add",
    label: "pi-dispatch add trigger",
    description:
      "Adds a trigger to triggers.json and applies it live. The operator MUST approve a confirm dialog showing " +
      "the entry; with no interactive operator it is refused. `flow` is the .pi/skills/<name> skill the job runs " +
      "(its SKILL.md is the agent's instructions). `kind` = cron|label|comment|pull_request|issue. cron (local) needs " +
      "id, pattern, `folder` (absolute host path the job runs in), `flow`, and `task` (the prompt text handed to " +
      "the agent), and may set optional model/provider/maxTurns for that schedule (omit = deployment default). " +
      "label needs labels[]+flow; comment needs phrase+flow; pull_request needs action[] (+ optional labels[]) + " +
      "flow. issue fires when an ISSUE closes: it needs flow, its action[] defaults to the forge's close word " +
      "(github/forgejo closed, gitlab close; azure has no close trigger), and it may set `number` (the forge's " +
      "own item number, narrowing the rule to that one issue) and `once: true` (a one-shot: it fires once, the " +
      "run is recorded, then the worker disarms the entry by writing on.disarmed; once requires number). A " +
      "close-only pull_request rule accepts the same number/once narrowing. " +
      "Webhook triggers take an optional `forge` = github (default) | gitlab | forgejo | azure, which " +
      "also decides which action words pull_request accepts: github is " +
      "labeled|opened|synchronize|reopened|review_submitted|closed, gitlab is open|update|reopen|approved|close, " +
      "forgejo is label_updated|opened|synchronized|reopened|closed, azure is created|updated (no close word). " +
      "The close word rides alone: it cannot be mixed with other actions in one entry. An azure label or comment " +
      "trigger must also set `repository` (a work item belongs to a project, not a repository), and an azure " +
      "pull_request trigger may not carry labels[] at all. A github review_submitted trigger may also set " +
      "reviewState[] (approved|changes_requested|commented) to narrow which verdicts fire; omitted, all " +
      "three do. For webhook triggers the repo and the task come from the triggering " +
      "issue/PR event — set only the match + flow — and they run under the deployment default model.",
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
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const entry = buildTriggerEntry(params.kind, params);
      if (!entry) throw new Error(`unknown trigger kind '${params.kind}' (cron|label|comment|pull_request|issue)`);
      const result = await confirmedWrite(
        ctx,
        { title: `Add ${params.kind} trigger`, message: `Add to triggers.json:\n${JSON.stringify(entry)}` },
        () => {
          const res = writeTriggers({ triggersPath: resolvePaths(process.env).triggersPath, mutate: (list: any[]) => [...list, entry] });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, added: entry };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_trigger_edit",
    label: "pi-dispatch edit trigger",
    description:
      "Changes which flow a trigger runs (by array index from dispatch_triggers) and applies it live. The " +
      "operator MUST approve a confirm dialog showing flow before->after; with no interactive operator it is refused.",
    executionMode: "sequential",
    parameters: Type.Object({ index: Type.Integer({ minimum: 0 }), flow: Type.String() }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const paths = resolvePaths(process.env);
      const list = triggerList(paths);
      const cur = list[params.index];
      if (!cur) throw new Error(`no trigger at index ${params.index} (have ${list.length})`);
      const flow = params.flow.trim();
      if (!flow) throw new Error("flow must be non-empty");
      const result = await confirmedWrite(
        ctx,
        { title: `Edit trigger #${params.index + 1}`, message: `trigger #${params.index + 1} (${cur.type}) flow: ${cur.flow ?? "-"} -> ${flow}` },
        () => {
          const res = writeTriggers({
            triggersPath: paths.triggersPath,
            mutate: (raw: any[]) => raw.map((tr, i) => (i === params.index ? { ...tr, run: { ...tr.run, flow } } : tr)),
          });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, index: params.index, flow };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_pauses",
    label: "pi-dispatch pause windows",
    description:
      "Read-only. Lists the scheduled pause windows (per folder/repo quiet hours) with their array index. " +
      "Use the index for dispatch_pause_delete.",
    parameters: Type.Object({}),
    async execute() {
      const paths = resolvePaths(process.env);
      const p = readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath });
      const data = Array.isArray(p?.windows) ? p.windows.map((w: any, index: number) => ({ index, ...w })) : p;
      return toolText(JSON.stringify(data));
    },
  });

  pi.registerTool({
    name: "dispatch_pause_add",
    label: "pi-dispatch add pause window",
    description:
      "Adds a scheduled pause window and applies it live: runs for `scope` (a repo \"owner/name\", a local " +
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
      const paths = resolvePaths(process.env);
      const w = buildPauseWindow(params);
      const result = await confirmedWrite(
        ctx,
        { title: "Add pause window", message: `Add to pause-windows.json:\n${JSON.stringify(w)}` },
        () => {
          const res = writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (list: any[]) => [...list, w] });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, added: w };
        },
      );
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
      const paths = resolvePaths(process.env);
      const p = readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath });
      const list = Array.isArray(p?.windows) ? p.windows : [];
      const cur = list[params.index];
      if (!cur) throw new Error(`no pause window at index ${params.index} (have ${list.length})`);
      const result = await confirmedWrite(
        ctx,
        { title: `Delete pause window #${params.index + 1}`, message: `Remove pause window #${params.index + 1}: ${cur.scope} ${cur.from}-${cur.to} ${cur.tz}` },
        () => {
          const res = writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (l: any[]) => l.filter((_, i) => i !== params.index) });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, deletedIndex: params.index };
        },
      );
      return toolText(JSON.stringify(result));
    },
  });

  pi.registerTool({
    name: "dispatch_pause_edit",
    label: "pi-dispatch edit pause window",
    description:
      "Changes fields of an existing pause window (by array index from dispatch_pauses) and applies it live. " +
      "Provide only the fields to change (scope/from/to/tz/days/dateFrom/dateTo); the rest keep their current " +
      "value. The operator MUST approve a confirm dialog showing the before->after; refused with no interactive " +
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
      const paths = resolvePaths(process.env);
      const p = readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath });
      const list = Array.isArray(p?.windows) ? p.windows : [];
      const cur = list[params.index];
      if (!cur) throw new Error(`no pause window at index ${params.index} (have ${list.length})`);
      // A provided field replaces; an omitted one keeps the current value (?? treats undefined as "keep").
      // Rebuild through the shared builder so the result is validated the same way as an add.
      const before = buildPauseWindow(cur);
      const merged = buildPauseWindow({
        scope: params.scope ?? cur.scope,
        from: params.from ?? cur.from,
        to: params.to ?? cur.to,
        tz: params.tz ?? cur.tz,
        days: params.days ?? cur.days,
        dateFrom: params.dateFrom ?? cur.dateFrom,
        dateTo: params.dateTo ?? cur.dateTo,
      });
      const result = await confirmedWrite(
        ctx,
        { title: `Edit pause window #${params.index + 1}`, message: `pause window #${params.index + 1}:\n${JSON.stringify(before)}\n→ ${JSON.stringify(merged)}` },
        () => {
          const res = writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (l: any[]) => l.map((w, i) => (i === params.index ? merged : w)) });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, index: params.index, window: merged };
        },
      );
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
      const paths = resolvePaths(process.env);
      const list = triggerList(paths);
      const cur = list[params.index];
      if (!cur) throw new Error(`no trigger at index ${params.index} (have ${list.length})`);
      const result = await confirmedWrite(
        ctx,
        { title: `Delete trigger #${params.index + 1}`, message: `Remove trigger #${params.index + 1}: ${cur.type} -> ${cur.flow ?? "-"}` },
        () => {
          const res = writeTriggers({ triggersPath: paths.triggersPath, mutate: (raw: any[]) => raw.filter((_, i) => i !== params.index) });
          if (res.invalid) throw new Error(`rejected: ${res.invalid}`);
          return { applied: true, deletedIndex: params.index };
        },
      );
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
  ctx: any,
  prompt: { title: string; message: string },
  doWrite: () => any,
): Promise<any> {
  if (!ctx?.hasUI || typeof ctx?.ui?.confirm !== "function") {
    throw new Error(
      "refused: this change needs an interactive operator to confirm it, and no confirm-capable UI is available (e.g. print/headless mode).",
    );
  }
  const ok = await ctx.ui.confirm(prompt.title, prompt.message);
  if (!ok) return { applied: false, reason: "operator declined" };
  return doWrite();
}

/** The current triggers as a display list (empty on a missing/invalid file), for index resolution + confirm text. */
function triggerList(paths: any): any[] {
  const t = readTriggers({ triggersPath: paths.triggersPath });
  return Array.isArray(t?.triggers) ? t.triggers : [];
}

/**
 * Build one `{ on, run }` trigger entry from a kind + fields. The single source of truth for the on x run
 * matrix (cron -> local, every webhook kind -> a forge): the impossible combination is absent by
 * construction, mirroring the worker's load-time matrix. Shared by the add-trigger dialog and the
 * `dispatch_trigger_add` tool, so both produce identical shapes. `labels`/`action` accept either an array
 * (tool params) or a space-separated string (dialog input) via `asWords`. Returns null for an unknown kind.
 *
 * `f.forge` selects which forge a webhook trigger listens to, defaulting to github so every existing call
 * site -- and every existing entry this rewrites -- is unchanged. It is offered on BOTH paths, unlike
 * `run.image`, and the difference is deliberate: an image is a capability the model would gain (choose the
 * container and you choose the pi version, the guardrail floor and the loader posture), whereas a forge is
 * one it already has -- a model that can add a github trigger can already arm a paid run, and naming
 * gitlab instead does not widen that. Both remain gated by the same operator confirm.
 *
 * An unrecognised forge is passed through rather than corrected, so `parseTriggers` refuses it fail-loud at
 * the write. Silently rewriting a typo to github would arm a trigger on a forge the operator did not name.
 *
 * `run.resume` is deliberately on NEITHER path, following `run.image` rather than `f.forge`, and the test
 * is the one that separates those two: is it a capability the model would GAIN? A forge is not — a model
 * that can add a github trigger can already arm a paid run, and naming gitlab does not widen that. Resume
 * is. Arming it creates a channel in which the agent's own output persists to host disk and is replayed
 * into a later job on the same branch, so a model able to set it could arrange for its own reasoning to
 * reach a future run. That is a self-influence channel, and it is not one an operator confirm on a single
 * dialog meaningfully bounds — the confirm approves one entry, the channel outlives it.
 * Enabling it stays an edit to the reviewed `triggers.json` (`docs/sessions.md`), which is the same answer
 * `run.image` gets and for a stricter version of the same reason. The panel still DISPLAYS it, because
 * reading a disclosure and being able to arm one are different things.
 */
/**
 * The forge prompt and the per-forge pull-request action vocabulary, in one place each.
 *
 * Both were two-way ternaries naming github and gitlab. A third and fourth forge turns a ternary into a
 * chain, and an operator offered "github or gitlab" cannot discover that two more exist -- which is a
 * different failure from being refused: they simply never try.
 */
const FORGE_PROMPT = "forge — github, gitlab, forgejo or azure";
// The per-forge issue close word (issue #231), the tool's default `action` for kind "issue": the
// shared validator's ISSUE_ACTIONS accepts exactly one word per forge today, so defaulting to it
// makes the kind authorable without knowing three forges' spellings. No azure entry on purpose --
// the validator refuses the whole type there with its own message (a work item's close is a state
// transition the projected payload subset cannot see), and a default here would only reword it.
const ISSUE_CLOSE_WORD: Record<string, string> = { github: "closed", gitlab: "close", forgejo: "closed" };
const PR_ACTION_VOCAB: Record<string, { hint: string; dflt: string }> = {
  // The close words ride the hint too (issue #231): the dialog passes whatever is typed through the
  // shared validator, so a close-only rule IS authorable here, and a hint that omits the word reads
  // as the word not existing. The loader refuses a list mixing a close word with any other action.
  github: { hint: "labeled opened synchronize reopened review_submitted closed", dflt: "labeled" },
  gitlab: { hint: "open update reopen approved close", dflt: "update" },
  forgejo: { hint: "label_updated opened synchronized reopened closed", dflt: "label_updated" },
  azure: { hint: "created updated", dflt: "updated" },
};

export function buildTriggerEntry(kind: string, f: any): any {
  if (kind === "cron") {
    // Optional per-entry provider/model/maxTurns pass through to job.data (highest precedence); omitted when
    // blank so the value still resolves against the settings overlay/env at job start (triggers.mjs:127-131).
    // undefined keys drop out of the written JSON. Only the local/cron path carries these — github triggers
    // run under the global overlay/env model, which the loader enforces.
    const run: any = { kind: "local", folder: f.folder, flow: f.flow, task: f.task };
    const model = optStr(f.model);
    const provider = optStr(f.provider);
    const maxTurns = optInt(f.maxTurns);
    if (model) run.model = model;
    if (provider) run.provider = provider;
    if (maxTurns !== undefined) run.maxTurns = maxTurns;
    return { on: { type: "cron", id: f.id, pattern: f.pattern }, run };
  }
  const forge = optStr(f.forge) ?? "github";
  // `run.repository` is required on an azure label/comment trigger and REFUSED on every other forge's, so
  // it is carried only when set and `parseTriggers` decides whether it belongs. Passing it through rather
  // than validating here keeps one validator, exactly as an unrecognised forge is passed through to be
  // refused fail-loud at the write instead of silently rewritten to github.
  const repository = optStr(f.repository);
  const forgeRun = (rest: any) => ({ kind: forge, ...rest, ...(repository ? { repository } : {}) });
  if (kind === "label") return { on: { type: "label", any: asWords(f.labels ?? f.any) }, run: forgeRun({ flow: f.flow }) };
  if (kind === "comment") return { on: { type: "comment", phrase: f.phrase }, run: forgeRun({ flow: f.flow }) };
  if (kind === "pull_request") {
    const on: any = { type: "pull_request", action: asWords(f.action) };
    const any = asWords(f.labels ?? f.any);
    if (any.length > 0) on.any = any;
    // The close-trigger narrowings (issue #231), carried only when set so every pre-#231 call site
    // writes byte-identical entries. Passed through rather than gated on the action word: the shared
    // validator refuses number/once on a non-close rule with a message naming why, and pre-judging
    // that here would be the silent-rewrite posture this function already rejects for `forge`.
    const prNumber = optInt(f.number);
    if (prNumber !== undefined) on.number = prNumber;
    if (typeof f.once === "boolean") on.once = f.once;
    return { on, run: { kind: forge, flow: f.flow } };
  }
  if (kind === "issue") {
    // The close-trigger kind (issue #231). `action` DEFAULTS to this forge's close word -- the only
    // word the shared validator accepts today -- so the kind is authorable without knowing three
    // forges' spellings; an explicit word still passes through verbatim to be refused fail-loud if
    // wrong. `number`/`once` ride only when set, mirroring the loader's absent-not-undefined shape;
    // every constraint between them (once requires number, once excludes replicas, azure has no
    // close trigger at all) lives in the one validator the write goes through.
    const action = asWords(f.action);
    const on: any = { type: "issue", action: action.length > 0 ? action : [ISSUE_CLOSE_WORD[forge] ?? "closed"] };
    const number = optInt(f.number);
    if (number !== undefined) on.number = number;
    if (typeof f.once === "boolean") on.once = f.once;
    return { on, run: { kind: forge, flow: f.flow } };
  }
  return null;
}

/**
 * Build one pause-window entry from a kind-less field bag (shared by the `dispatch_pause_add` tool and the
 * operator dialog). Required scope/from/to; optional tz/days/dateFrom/dateTo included only when non-blank so
 * an omitted field drops out of the JSON. `days` accepts an array (tool) or a space-separated string (dialog).
 * All value validation (time format, IANA tz, weekday names, date format) lives in the shared
 * `parsePauseWindows`, which the write goes through — a bad value is rejected there, never written.
 */
function buildPauseWindow(f: any): any {
  const w: any = { scope: String(f.scope ?? "").trim(), from: String(f.from ?? "").trim(), to: String(f.to ?? "").trim() };
  const tz = optStr(f.tz);
  const days = asWords(f.days);
  const dateFrom = optStr(f.dateFrom);
  const dateTo = optStr(f.dateTo);
  if (tz) w.tz = tz;
  if (days.length > 0) w.days = days;
  if (dateFrom) w.dateFrom = dateFrom;
  if (dateTo) w.dateTo = dateTo;
  return w;
}

/** Normalise a labels/action field to a trimmed non-empty string list, accepting an array or a string. */
function asWords(x: any): string[] {
  if (Array.isArray(x)) return x.map((s) => String(s).trim()).filter(Boolean);
  return splitWords(x);
}

/** A trimmed non-empty string, or undefined (so a blank optional field drops out of the written JSON). */
function optStr(x: any): string | undefined {
  const s = String(x ?? "").trim();
  return s === "" ? undefined : s;
}

/** A finite number from a string/number, or undefined when blank/absent/non-numeric. */
function optInt(x: any): number | undefined {
  if (x === undefined || x === null || String(x).trim() === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

async function dispatch(pi: ExtensionAPI, args: string, ctx: any): Promise<void> {
  const notify = ctx?.ui?.notify?.bind(ctx.ui);
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "";
  const paths = resolvePaths(process.env);
  // Glyph posture BEFORE any rendering: every /dispatch surface (the overlay, the insights surfaces)
  // draws through panel.mjs' active table, and this is the one funnel all subcommands pass through. The
  // dashboard's own styler opts in per instance (makeStyler's `ascii`, threaded from these same paths in
  // makeDashboard), so PI_DISPATCH_ASCII now flips the overlay frame too, not only panel.mjs (issue #54).
  setGlyphs(paths.asciiGlyphs);

  // Drain the deployment pointer's retained one-line notice (a broken or newer pointer file) into the
  // operator's face exactly once -- the REBUILT_NOTICE idiom: a surfaced warning, never a throw, and
  // never into model context.
  const pnote = takePointerNotice();
  if (pnote) notify?.(pnote, "warning");

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
      const [queue, budget] = await Promise.all([
        readQueueState({ url: paths.valkeyUrl }),
        readBudget({ url: paths.valkeyUrl }),
      ]);
      const settings = readSettingsView({ settingsFile: paths.settingsFile });
      send(pi, `${renderStatus(queue)}\n${renderBudget({ budget, settings })}`);
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
      send(pi, renderBudget({ budget, settings }));
      return;
    }
    case "triggers": {
      const schedulers = await readSchedulers({ url: paths.valkeyUrl });
      const triggers = readTriggers({ triggersPath: paths.triggersPath });
      send(pi, renderTriggers({ schedulers, triggers }));
      return;
    }
    case "settings": {
      send(pi, renderSettingsView(readSettingsView({ settingsFile: paths.settingsFile })));
      return;
    }
    case "insights": {
      // The ONE analytics surface (issue #181). `whatif` keeps the CLI estimator (the interactive
      // layer died with the COSTS view); anything else writes AND opens the artifact -- the artifact
      // IS the feature, so the bare command does the whole job with no `html` verb to remember.
      // Still deliberately not an LLM-callable tool: the topology assembly spawns git per folder.
      if (tokens[1] === "whatif") {
        insightsWhatIf(pi, paths, tokens, notify);
        return;
      }
      await insightsCommand(paths, tokens, notify);
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
      const res = await enqueueDispatchRun({ folder, flow, task, aiInvoked: false });
      if (res.refused) {
        notify?.(res.refused, "error");
        return;
      }
      if (res.unreachable) {
        notify?.(`could not reach the queue: ${res.unreachable}`, "error");
        return;
      }
      notify?.(`queued ${res.jobId} — ${folder} (${flow})`, "info");
      return;
    }
    case "logs":
      await showLogs(paths.logsDir, tokens, ctx);
      return;
    case "pause":
    case "resume": {
      const paused = sub === "pause";
      const res = await setQueuePaused({ url: paths.valkeyUrl, paused });
      if (res.unreachable) {
        notify?.(`could not reach Valkey at ${paths.valkeyUrl} — is it running? (docker compose up)`, "error");
        return;
      }
      notify?.(
        paused
          ? "paused — worker will stop taking new jobs (jobs still enqueue; durable, survives restart)"
          : "resumed",
        "info",
      );
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
    case "secrets": {
      // REQ-TRIGGER-SECRETS. Declaring a resolver profile means naming an absolute host path the WORKER
      // EXECUTES, so it lives here, on the operator-typed command surface, and nowhere else.
      //
      // THE SEPARATION IS STRUCTURAL, not a convention this file invented. `registerCommand` has no
      // parameter schema and no LLM-facing surface; pi reaches a command handler only from its own
      // `prompt()` path, which assistant text and tool results never enter, and its queueing APIs throw
      // outright on a slash-leading string. That is the same mechanism that makes `/dispatch setup`
      // operator-typed only, and it is why this is a subcommand rather than a fifteenth tool.
      //
      // The worker still does not trust what lands here. Every overlay-declared path is re-checked against
      // PI_SECRET_RESOLVER_ROOTS at resolution time, because this file is written to a settings.json whose
      // default location is the OS temp directory. A panel-side check alone would be cosmetic.
      const { runSecretsCommand } = await import("./secrets-command.ts");
      await runSecretsCommand(paths, ctx, notify, tokens.slice(1));
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
// argument by contract; the tests hand it a canned fake, this object is the real one).
const PRICING = { listPricedModels, getPricedModel, isZeroRated, reprice, piAiVersion };

/**
 * Assemble the costs fold exactly as the dashboard view does: scan the run records for the window, read
 * the declared subscriptions (a missing/invalid file degrades to none -- the fold then simply has no plans
 * to score), and fold both with the real pricing façade. An optional `flow` filters the fold's INPUT
 * records, so every aggregate -- daily, plans, provenance -- is scoped, not just one table. Returns
 * `{ fold }`, or scanRunRecords' `{ unreachable }` passed through for the caller to surface.
 */
function assembleCosts(paths: any, window: string, flow?: string): any {
  const nowMs = Date.now();
  const sinceMs = costsSinceMs(window, nowMs);
  const records = scanRunRecords({ logsDir: paths.logsDir, sinceMs, nowMs });
  if (!Array.isArray(records)) return records; // { unreachable }
  const subs: any = readSubscriptions({ subscriptionsPath: paths.subscriptionsPath });
  const scoped = typeof flow === "string" && flow !== "" ? records.filter((r: any) => (r?.flow ?? null) === flow) : records;
  // The trigger join over the SCOPED records (a flow-filtered fold attributes only what it folds),
  // the same file-read-plus-pure-fold path the dashboard seam takes.
  const triggersView: any = readTriggers({ triggersPath: paths.triggersPath });
  const triggerJoin = attributeRunsToTriggers({ records: scoped, triggers: Array.isArray(triggersView?.triggers) ? triggersView.triggers : [] });
  const fold = foldCosts({
    records: scoped,
    subscriptions: Array.isArray(subs?.subscriptions) ? subs.subscriptions : [],
    pricing: PRICING,
    nowMs,
    piAiPin: piAiVersion(),
    sinceMs, // the same instant the scan cut at -- proration denominates on the requested window
    triggerJoin,
  });
  return { fold };
}

/**
 * Assemble the trigger/flow graph model for the insights payload: a FRESH triggers read
 * every call (the file live-reloads, OQ-008 -- a cached topology is a stale topology), the resident
 * schedulers, one bounded record scan for the window, the folder/injected enumerations through
 * `collectGraphInputs`, and the pure fold. All I/O lives in the read-model; this function only
 * aggregates its outputs into buildGraphModel's input shape.
 */
async function assembleGraph(paths: any): Promise<any> {
  const nowMs = Date.now();
  const triggers: any = readTriggers({ triggersPath: paths.triggersPath });
  const triggerList: any[] = Array.isArray(triggers?.triggers) ? triggers.triggers : [];
  const schedulers: any = await readSchedulers({ url: paths.valkeyUrl });
  const records: any = scanRunRecords({ logsDir: paths.logsDir, sinceMs: nowMs - GRAPH_LIMITS.windowDays * 24 * 60 * 60 * 1000, nowMs });
  const recs: any[] = Array.isArray(records) ? records : [];
  // Spend badges (issue #175): the dashboard seam's twin -- one subscriptions read, two pure folds.
  const subsView: any = readSubscriptions({ subscriptionsPath: paths.subscriptionsPath });
  const triggerJoin = attributeRunsToTriggers({ records: recs, triggers: triggerList });
  return buildGraphModel({
    triggers,
    schedulers: Array.isArray(schedulers) ? schedulers : [],
    ...collectGraphInputs({ triggers: triggerList, globalPiDir: paths.globalPiDir }),
    cronStats: cronRunStats({ records: recs, schedulerIds: triggerList.filter((t) => t.type === "cron" && typeof t.id === "string").map((t) => t.id) }),
    runJoin: joinRunsToTriggers({ records: recs, triggerCount: triggers?.count, triggerTypes: Object.fromEntries(triggerList.map((t: any) => [t.index, t.type])) }),
    chainEdges: observedChainEdges({ records: recs }),
    forgeRepos: forgeRepoTargets({ records: recs }),
    caps: { chainDepthMax: paths.chainDepthMax, chainMaxPerJob: paths.chainMaxPerJob, windowDays: GRAPH_LIMITS.windowDays },
    nowMs,
    triggerCosts: foldTriggerCosts({ records: recs, subscriptions: Array.isArray(subsView?.subscriptions) ? subsView.subscriptions : [], pricing: PRICING, triggerJoin }),
  });
}

/** The real side-effect deps for insightsCommand; tests inject fakes for every one of them. */
function realArtifactDeps(): any {
  return { fs: nodeFs, openBrowser, env: process.env, now: () => Date.now(), platform: process.platform };
}

/**
 * Why the spawn is skipped, or null when opening locally can work. Exported for its tests: the SSH
 * check is deliberately first (a Mac over SSH has no DISPLAY either, but the reason the operator
 * should see is the session, not the variable), and only linux gates on DISPLAY/WAYLAND_DISPLAY --
 * darwin and win32 have openers that need no display variable.
 */
export function isHeadlessEnv(env: any, platform: string): string | null {
  if (env?.SSH_CONNECTION || env?.SSH_TTY) return "SSH session";
  if (platform === "linux" && !env?.DISPLAY && !env?.WAYLAND_DISPLAY) return "no display";
  return null;
}

const INSIGHTS_USAGE =
  "usage: /dispatch insights [7d|30d|mtd] [--no-open] [--full-paths] | /dispatch insights whatif <provider/model> --flow <flow>";

/**
 * Assemble the unified insights payload: the graph model and the cost fold the two existing
 * assemblers already build, plus the per-trigger spend map keyed by graph node id. The spend map is
 * derived from the SPEND window's records (the operator's question), not the graph's fixed record
 * window -- the artifact states both windows, and a badge whose window differed from the table
 * beside it would be the quiet inconsistency this surface exists to kill.
 */
/** A positive integer or null -- the shape every overlay cap takes on its way into the payload. */
function posIntOrNull(v: any): number | null {
  return Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * The budget slice of the insights payload (issue #181): reserved-vs-cap FACTS for the three job-slot
 * windows and the daily token counter, with the per-window state computed HERE by the worker's own
 * `windowState` (and the token rule the old dashboard token line used: `>=` cap, `>` the soft-hold
 * floor -- tokens are a running count, not a reservation, so equality is already over). States ride
 * the payload as WORDS the page never derives: the artifact builder cannot load the worker
 * (its import allowlist is the two pure siblings), and duplicating threshold arithmetic behind a
 * parity test would put policy in two places. Caps come from the settings overlay ALONE -- a cap the
 * overlay does not set is null, "unknown", because the worker resolves it from env/defaults this
 * process cannot read authoritatively, and the page must render that as absence, never a guess.
 * `readBudget` is GET-only (CONST-BUDGET-BEFORE-TOKENS: observing the budget spends nothing).
 */
async function assembleBudgetView(paths: any): Promise<any> {
  const raw: any = await readBudget({ url: paths.valkeyUrl });
  const view: any = readSettingsView({ settingsFile: paths.settingsFile });
  const overlay = view && !view.invalid && view.overlay ? view.overlay : {};
  const pct = Number.isInteger(overlay.softHoldPct) ? overlay.softHoldPct : null;
  const unreachable = raw?.unreachable ? String(raw.unreachable) : null;
  const slotWindow = (key: string, capKey: string) => {
    const cap = posIntOrNull(overlay[capKey]);
    const reserved = unreachable === null ? Number(raw[key] ?? 0) : null;
    const state = cap !== null && reserved !== null ? windowState(reserved, cap, pct) : "ok";
    return { reserved, cap, state };
  };
  const tokensSpent = unreachable === null ? Number(raw.tokensToday ?? 0) : null;
  const tokenCap = posIntOrNull(overlay.dailyTokenCap);
  const tokenState =
    tokenCap !== null && tokensSpent !== null
      ? tokensSpent >= tokenCap
        ? "over"
        : pct !== null && tokensSpent > Math.floor((tokenCap * pct) / 100)
          ? "soft-hold"
          : "ok"
      : "ok";
  return {
    unreachable,
    softHoldPct: pct,
    day: slotWindow("day", "dailyCap"),
    week: slotWindow("week", "weeklyCap"),
    month: slotWindow("month", "monthlyCap"),
    tokens: { spent: tokensSpent, cap: tokenCap, state: tokenState, maxTokens: posIntOrNull(overlay.maxTokens) },
  };
}

async function assembleInsights(paths: any, window: string): Promise<any> {
  const graph = await assembleGraph(paths);
  const costs = assembleCosts(paths, window);
  // The budget slice rides BOTH return shapes: the caps are the operator's one real lever on cost,
  // and the lever does not depend on the spend scan being readable.
  const budget = await assembleBudgetView(paths);
  if (costs?.unreachable) {
    return { graph, fold: null, costsUnreachable: String(costs.unreachable), window, costByTrigger: null, budget };
  }
  const fold = costs?.fold ?? null;
  // Re-fold the spend map at the requested window so badge and table agree. assembleCosts already
  // scanned; scanning again here costs one directory pass and keeps the two assemblers untouched.
  const nowMs = Date.now();
  const sinceMs = costsSinceMs(window, nowMs);
  const records = scanRunRecords({ logsDir: paths.logsDir, sinceMs, nowMs });
  let costByTrigger: any = null;
  if (Array.isArray(records)) {
    const triggersView: any = readTriggers({ triggersPath: paths.triggersPath });
    const subsView: any = readSubscriptions({ subscriptionsPath: paths.subscriptionsPath });
    const triggerJoin = attributeRunsToTriggers({ records, triggers: Array.isArray(triggersView?.triggers) ? triggersView.triggers : [] });
    costByTrigger = foldTriggerCosts({ records, subscriptions: Array.isArray(subsView?.subscriptions) ? subsView.subscriptions : [], pricing: PRICING, triggerJoin });
  }
  return { graph, fold, costsUnreachable: null, window, costByTrigger, budget };
}

/**
 * `/dispatch insights [7d|30d|mtd] [--no-open] [--full-paths]` (REQ-INSIGHTS-HTML-EXPORT): the bare
 * command does the whole job -- assemble, render the self-contained artifact, write it ATOMICALLY to
 * the STABLE path `<graphDir>/insights.html` (tmp+rename, the writeTriggers idiom -- stable so
 * re-running updates an already-open tab through its Reload/auto-reload controls, atomic so that
 * tab's reload never reads half a file), print the file:// URL FIRST (the URL is the contract, the
 * spawn a convenience; over SSH or without a display the spawn is skipped AND SAID), then best-effort
 * open unless headless/--no-open. A cost-side degrade (scan unreachable) still writes the page with
 * its banner: the artifact is total, never a stack trace. A write failure notifies and never opens --
 * opening a stale artifact after a failed write would show yesterday's deployment as today's.
 * Default window 30d, NOT the old costs mtd: the topology half is pinned at a 30d record window, and
 * the one page's two halves should describe the same period unless the operator asks otherwise.
 * Exported for its tests.
 */
export async function insightsCommand(paths: any, tokens: string[], notify: Notify, deps: any = realArtifactDeps()): Promise<void> {
  const rest = tokens.slice(1);
  const noOpen = rest.includes("--no-open");
  // Full local folder paths are an explicit OPT-IN: the artifact defaults to basename-only because
  // it is a durable, shareable file, but "which folder is this" is a fair question on a multi-folder
  // deployment, and the paths are the operator's own reviewed config.
  const fullPaths = rest.includes("--full-paths");
  const positional = rest.filter((t) => t !== "--no-open" && t !== "--full-paths");
  const window = positional.length > 0 ? positional[0] : "30d";
  // The removed `html` verb lands here as a junk positional and answers usage on purpose: a dead
  // verb that half-works is drift, and the usage string is what teaches the new grammar.
  if (positional.length > 1 || !COSTS_WINDOWS.includes(window)) {
    notify?.(INSIGHTS_USAGE, "warning");
    return;
  }
  const payload = await assembleInsights(paths, window);
  const html = buildInsightsHtml(payload, { now: deps.now(), fullPaths });
  const file = `${paths.graphDir}/insights.html`;
  try {
    deps.fs.mkdirSync(paths.graphDir, { recursive: true });
    const tmp = `${file}.tmp`;
    deps.fs.writeFileSync(tmp, html, { mode: 0o644 });
    deps.fs.renameSync(tmp, file);
  } catch (err: any) {
    notify?.(`insights: could not write ${file} (${err?.message ?? err})`, "error");
    return;
  }
  // pathToFileURL, not concatenation (review finding): an operator-set PI_GRAPH_DIR with a space
  // would otherwise print a URL that truncates in terminals and breaks the opener spawn.
  const url = pathToFileURL(file).href;
  notify?.(`insights written: ${url}`, "info");
  if (noOpen) return;
  const headless = isHeadlessEnv(deps.env, deps.platform);
  if (headless) {
    notify?.(`not opening a browser (${headless}): open the URL on this machine's desktop, or scp the file there`, "info");
    return;
  }
  deps.openBrowser(url);
}

/**
 * `insights whatif <provider/model> --flow <flow>`. The target splits on the FIRST "/" -- model ids
 * carry dots and colons, never the provider separator -- and `--flow` is required because whatIfFlow
 * scores one flow's median run, not a portfolio. An unknown model answers with the closest priced ids
 * by a cheap contains-filter over the façade's catalog: that reply IS the long-tail model picker now
 * that no interactive filter exists.
 */
function insightsWhatIf(pi: ExtensionAPI, paths: any, tokens: string[], notify: Notify): void {
  const target = tokens[2] ?? "";
  const slash = target.indexOf("/");
  const flowAt = tokens.indexOf("--flow");
  const flow = flowAt >= 0 ? tokens[flowAt + 1] : undefined;
  if (slash <= 0 || slash === target.length - 1 || !flow) {
    notify?.(INSIGHTS_USAGE, "warning");
    return;
  }
  const provider = target.slice(0, slash);
  const id = target.slice(slash + 1);
  if (getPricedModel(provider, id) === null) {
    const needle = id.toLowerCase();
    const near = listPricedModels()
      .filter((m: any) => m.id.toLowerCase().includes(needle) || needle.includes(m.id.toLowerCase()))
      .slice(0, 3)
      .map((m: any) => `  ${m.provider}/${m.id}`);
    send(pi, [`unknown model: ${provider}/${id}`, ...(near.length > 0 ? ["closest priced ids:", ...near] : [])].join("\n"));
    return;
  }
  // No window argument here: the estimate wants every ledgered run of the flow it can see, so the scan
  // runs at its own 92-day ceiling rather than a display window.
  const records = scanRunRecords({ logsDir: paths.logsDir, nowMs: Date.now() });
  if (!Array.isArray(records)) {
    notify?.(`insights: ${(records as any).unreachable}`, "error");
    return;
  }
  const result = whatIfFlow({ records, flow, target: { provider, id }, pricing: PRICING });
  send(pi, renderWhatIf(result, { flow, target: `${provider}/${id}` }));
}

/**
 * Open the live dashboard overlay for the bare `/dispatch`. The overlay is the panel's only surface, so a
 * pi build without `ctx.ui.custom` degrades to a usage note naming the reason rather than a silent no-op;
 * it never sends into the model channel. The `ctx.ui.custom` factory constructs the panel with the real
 * `tui`/`done`, so the queue and redis connections open only when the overlay actually shows.
 */
async function openDashboard(paths: any, ctx: any, notify: Notify): Promise<void> {
  const custom = ctx?.ui?.custom;
  if (typeof custom !== "function") {
    notify?.(`${USAGE} — the dashboard needs a TUI (this pi build has no overlay support)`, "info");
    return;
  }
  const factory = (tui: any, theme: any, _keybindings: any, done: (value: any) => void) =>
    makeDashboard({
      paths,
      done,
      tui,
      theme,
      deps: {
        ...createDashboardDeps(paths),
        // log read stays here; overlay-only, returns readLogTail's result verbatim
        tailLog: ({ jobId, lines }: { jobId: string; lines: number }) => readLogTail({ logsDir: paths.logsDir, jobId, lines }),
        // REQ-RESURRECTABLE-SANDBOX, both seams. The fs read and the spawn live HERE for the same reason
        // tailLog does: dashboard.ts renders and holds the tui, and touches no filesystem and no child
        // process of its own. It brackets the launch with tui.stop()/tui.start(); this side only builds
        // the argv and runs it attached to the terminal.
        sandboxInfo: ({ jobId }: { jobId: string }) => readSandboxInfo(paths, jobId),
        launchSandbox: ({ jobId }: { jobId: string }) => openSandboxSession(paths, jobId),
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
 * Whether this run is still re-openable, as a VERDICT rather than a path (REQ-RESURRECTABLE-SANDBOX).
 *
 * Synchronous on purpose: RUN_DETAIL reads it once on entry, inside a key handler, and one small
 * `readFileSync` there is cheaper than making the overlay's state a promise. Whether a sandbox is
 * currently running is deliberately NOT asked -- that needs docker and `pi-dispatch sandbox --list`
 * already answers it.
 */
function readSandboxInfo(paths: any, jobId: string): any {
  if (!jobId) return null;
  if (!paths?.sandboxRetentionHours) return { retained: false, reason: "retention off" };
  const manifest = readManifest({ sandboxDir: paths.sandboxDir, jobId });
  if (!manifest) return { retained: false, reason: "swept" };
  const keepUntil = Date.parse(manifest.keepUntil ?? "");
  const createdAt = Date.parse(manifest.createdAt ?? "");
  const until = Number.isFinite(keepUntil) ? keepUntil : createdAt + paths.sandboxRetentionHours * 3600000;
  if (!Number.isFinite(until)) return { retained: true };
  const hours = Math.max(0, Math.round((until - Date.now()) / 3600000));
  return { retained: true, pinned: Number.isFinite(keepUntil), expiresIn: hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d` };
}

/**
 * Open one run's sandbox attached to this terminal.
 *
 * The caller (dashboard.ts) has already suspended pi's TUI, so stdout is ours and `stdio: "inherit"` hands
 * the terminal to the container until the operator exits. A refusal prints and returns rather than
 * throwing: the panel is mid-suspend, and an exception here would surface as a broken screen instead of a
 * sentence.
 */
async function openSandboxSession(paths: any, jobId: string): Promise<void> {
  const resolved = resolveSandbox({
    jobId,
    sandboxDir: paths.sandboxDir,
    retentionHours: paths.sandboxRetentionHours,
  });
  if (resolved.refused) {
    process.stdout.write(`\ncannot open a sandbox for ${jobId}: ${resolved.message}\n`);
    await pauseForMessage();
    return;
  }
  const args = buildSandboxRunArgs({
    image: resolved.manifest.image,
    name: resolved.name,
    workspace: resolved.manifest.workspace,
    jobDir: resolved.manifest.dir,
    term: process.env.TERM,
    idleSeconds: (paths.sandboxIdleMinutes ?? 0) * 60,
  });
  process.stdout.write(`\nopening ${sandboxContainerName(jobId)} — image ${resolved.manifest.image}\n`);
  process.stdout.write("no credentials are set in this container. exit the shell to return to the panel.\n\n");
  const { error } = await spawnSandbox({ args });
  if (error) {
    process.stdout.write(`\ncould not start docker: ${error.message}\n`);
    await pauseForMessage();
  }
}

/**
 * Hold the suspended terminal open long enough to read a refusal, then return.
 *
 * A TIMER, deliberately, and not a keypress. pi's `terminal.stop()` calls `process.stdin.pause()`, so a
 * `stdin.once("data")` here would never fire and the panel would hang suspended forever -- waiting on
 * input from a stream the suspend just paused. Resuming stdin to read one key would mean re-entering the
 * input handling that the suspend exists to hand away. A fixed pause cannot deadlock, and this path is
 * only reached when a workspace disappears between opening RUN_DETAIL and pressing the key.
 */
function pauseForMessage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2500));
}

/** Split a space-separated dialog answer into trimmed, non-empty words (label/action lists). */
function splitWords(s: string | undefined): string[] {
  return String(s ?? "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * Drive a CRUD action the dashboard overlay signalled, using pi's `ctx.ui` dialogs (`select`/`input`/
 * `confirm`). Every write goes through `writeTriggers`/`writeSettings` (validated + atomic + fail-closed);
 * the live-reload watchers apply it without a restart. A build without the dialog primitives degrades to a
 * notice rather than a crash. `undefined` from any dialog is a cancel.
 */
export async function handleDashboardAction(result: any, paths: any, ctx: any): Promise<void> {
  const ui = ctx?.ui;
  const notify: Notify = ui?.notify?.bind(ui);
  // The `i` key (issue #181): write and open the insights page between overlays, then the caller's
  // loop reopens the panel. BEFORE the dialog guard on purpose -- this action needs no dialogs, and
  // an older pi without them must still reach the one analytics surface.
  if (result.action === "openInsights") {
    return insightsCommand(paths, ["insights"], notify);
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
  }
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
  const scope = await ui.input("scope — a repo \"owner/name\", a local folder path, or \"*\" for all", "");
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
  const res = writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (list: any[]) => [...list, w] });
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
  const scope = await ask("scope", cur.scope ?? "");
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
  const res = writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (l: any[]) => l.map((w, i) => (i === index ? merged : w)) });
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
  const res = writePauseWindows({ pauseWindowsPath: paths.pauseWindowsPath, mutate: (l: any[]) => l.filter((_, i) => i !== index) });
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
  const res = writeTriggers({ triggersPath: paths.triggersPath, mutate: (list: any[]) => [...list, entry] });
  notify?.(res.ok ? `trigger added (live) — ${kind} → ${entry.run.flow}` : `add rejected: ${res.invalid}`, res.ok ? "info" : "error");
}

/** Edit a trigger's flow in place (the common "change what a trigger runs" edit). */
async function editTriggerFlow(paths: any, ui: any, notify: Notify, index: number): Promise<void> {
  if (typeof index !== "number") return;
  const flow = await ui.input(`new flow for trigger #${index + 1} — the .pi/skills/<name> skill it runs`, "");
  if (flow === undefined || flow.trim() === "") return;
  const res = writeTriggers({
    triggersPath: paths.triggersPath,
    mutate: (list: any[]) => list.map((t, i) => (i === index ? { ...t, run: { ...t.run, flow: flow.trim() } } : t)),
  });
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
  const res = writeTriggers({ triggersPath: paths.triggersPath, mutate: (list: any[]) => list.filter((_, i) => i !== index) });
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
 * surfaces `writeOverlay`'s key-only reason; a rebuild over an invalid file adds a loud replaced-file
 * notice so a lost prior overlay is never silent.
 */
function applySet(settingsFile: string, tokens: string[], notify: Notify): void {
  const key = tokens[1] ?? "";
  if (!KNOWN_KEYS.includes(key)) {
    notify?.(`set: unknown key '${key}'. valid keys: ${KNOWN_KEYS.join(", ")}`, "error");
    return;
  }
  const valueTokens = tokens.slice(2);
  if (valueTokens.length !== 1) {
    notify?.(`set: ${key} takes exactly one value`, "error");
    return;
  }
  const value = coerceSettingValue(key, valueTokens[0]);
  const res = writeSettings({ settingsFile, mutate: (o) => ({ ...o, [key]: value }) });
  if (res.invalid) {
    notify?.(`set: ${res.invalid}`, "error");
    return;
  }
  notify?.(`set ${key} = ${value}`, "info");
  if (res.rebuiltFrom) notify?.(REBUILT_NOTICE(res.rebuiltFrom), "warning");
}

/**
 * `unset <key>`: the key must be a known settings key; the mutation deletes it, and an empty result `{}`
 * is a valid written state (no overrides). The same loud replaced-file notice fires when the write repaired
 * an invalid file.
 */
function applyUnset(settingsFile: string, tokens: string[], notify: Notify): void {
  const key = tokens[1] ?? "";
  if (!KNOWN_KEYS.includes(key)) {
    notify?.(`unset: unknown key '${key}'. valid keys: ${KNOWN_KEYS.join(", ")}`, "error");
    return;
  }
  const res = writeSettings({
    settingsFile,
    mutate: (o) => {
      delete o[key];
      return o;
    },
  });
  if (res.invalid) {
    notify?.(`unset: ${res.invalid}`, "error");
    return;
  }
  notify?.(`unset ${key}`, "info");
  if (res.rebuiltFrom) notify?.(REBUILT_NOTICE(res.rebuiltFrom), "warning");
}

/**
 * Coerce a raw token to the settings value its key expects: `model` and `provider` keep the raw string;
 * every other overlay key is numeric and parses via `Number` (a non-numeric token becomes `NaN`, which
 * `writeOverlay` then rejects with a key-only reason). Keying off the two string exceptions rather than an
 * enumerated numeric list keeps this in lockstep with `KNOWN_KEYS` -- a new numeric knob (weekly/monthly
 * caps, the token caps) is coerced without a second edit here. Bounds and integer-ness stay in
 * `writeOverlay`, the single validator.
 */
function coerceSettingValue(key: string, raw: string): number | string {
  if (key === "model" || key === "provider") return raw;
  return Number(raw);
}

/**
 * The model-visible channel for the PII-free structured views. `display: true` shows the text; the empty
 * options object is deliberate -- NEVER `triggerTurn`, which would spend a paid turn just to observe state.
 */
function send(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: CHANNEL, content, display: true }, {});
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
  const tail = readLogTail({ logsDir, jobId, lines });

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
function makeLogViewer(jobId: string, tail: { lines?: string[]; missing?: boolean }) {
  const missing = tail.missing === true;
  const lines = missing ? [] : tail.lines ?? [];
  const maxTop = () => Math.max(0, lines.length - VIEWPORT_LINES);
  let top = 0;

  return (_tui: any, _theme: any, _keybindings: any, done: (value: void) => void) => {
    const component = {
      render(_width: number): string[] {
        if (missing) {
          return [`logs ${jobId} -- no captured log (PI_CAPTURE_JOB_LOGS off or not found). Esc to close.`, ""];
        }
        const out = [`logs ${jobId} -- ${lines.length} line(s). Up/Down scroll, PgUp/PgDn page, Esc close.`, ""];
        for (const line of lines.slice(top, top + VIEWPORT_LINES)) out.push(line);
        out.push("", `[${Math.min(top + VIEWPORT_LINES, lines.length)}/${lines.length}]`);
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
    const ids = listRunIds({ logsDir: resolvePaths(process.env).logsDir });
    const items = ids
      .filter((id) => id.startsWith(partial))
      .map((id) => ({ value: `logs ${id}`, label: id }));
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
