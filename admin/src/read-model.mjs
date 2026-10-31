import { readSandboxInventories } from "@edgehero/pi-dispatch/sandbox-inventory";
import { readSandboxSessions, requestSandboxEnd } from "@edgehero/pi-dispatch/sandbox-sessions";
/**
 * The admin extension's whole data-access surface: reads the queue, the budget counter, the durable
 * run-history files (INT-RUN-HISTORY-FILE-CONTRACT, admin is the named consumer), the settings overlay
 * (INT-CONFIG-OVERLAY-CONTRACT), and the unified `triggers.json` for display.
 *
 * Every function takes injected dependencies (`fs`, `makeQueueFn`, `redisFn`, ...) with real defaults, so
 * the tests run fully offline against fakes and production uses the worker's own helpers unchanged. The
 * key derivations and validators are IMPORTED from the worker, never re-implemented, so the admin and the
 * worker cannot drift on the budget key, the settings contract, or the id sanitiser.
 *
 * Reads plus a small set of explicit writes: most functions are side-effect-free (the budget read is a
 * plain GET, never reserveBudget / INCR / EXPIRE; the settings read never writes), and the writes are
 * few and named -- `setQueuePaused`, `writeSettings`, and the one gated `enqueueDispatchRun`. A viewer
 * degrades: an unreachable queue or an absent file returns a discriminated `{ unreachable }` /
 * `{ missing }` rather than throwing to the command handler.
 */

import { readTriggerEgress } from "./read-trigger-egress.mjs";
import { watchDurationMs, WATCH_ID_RE as WATCH_RULE_ID_RE } from "@edgehero/pi-dispatch/watch-contract";
import { makeWatchStore } from "@edgehero/pi-dispatch/watch-store";
import { MODEL_WHY, providerFailureOf } from "@edgehero/pi-dispatch/model-failover-protocol";
import * as nodeFs from "node:fs";
import { randomBytes } from "node:crypto";
import { GIT_READ_FLAGS } from "@edgehero/pi-dispatch/git-hardening";
import { join, delimiter, sep, isAbsolute, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { logsDirPath, defaultSandboxDir, delimitedList, workerName, CHAIN_DEPTH_MAX_DEFAULT, CHAIN_MAX_PER_JOB_DEFAULT, WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { settingsFilePath, readOverlay, writeOverlay, KNOWN_KEYS, OPERATOR_ONLY_KEYS } from "@edgehero/pi-dispatch/runtime-settings";
import { DOLLAR_ENV_NAMES, DOLLAR_SETTING_KEYS, checkDollarInvariant, formatMicros } from "@edgehero/pi-dispatch/money";
import { modelRolesTelemetryOf, approvalRecordOf, BUNDLE_SKIPPED_REASONS, LIVE_SKIPPED_REASONS, OPENSHELL_RULE_HOSTS_MAX, RECOVER_SKIPPED_REASONS, STEER_SKIPPED_REASONS, recordedBundle, recordedCheckpoints, recordedOpenshell, recordedSecretsProfile, recordedRecovered, makeReadRecord, recordedRecoveryOf, sanitizeJobId, targetFor, queuedAtOf, UNREADABLE_RECORD } from "@edgehero/pi-dispatch/run-history";
import { pendingFactsOf, QUEUED_STATES } from "@edgehero/pi-dispatch/chat-mode";
import { FORGE_MCP_SERVER_NAME, MCP_SERVER_NAME_RE, mcpServerWhere, readOverlayMcp } from "@edgehero/pi-dispatch/mcp-config";
import { dayKey, weekKey, monthKey, tokenDayKey } from "@edgehero/pi-dispatch/budget";
import { parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
// The scoped-limits validator is shared for the anti-drift reason the pause/subscriptions ones are: the
// write goes through the exact parser the worker boot-loads, so the sides cannot disagree on the schema.
import { danglingProjectRows, dollarKeyPrefixFor, isModelScope, isProjectScope, parseScopedLimits, scopeDollarKeyPrefix, scopedLimitsVersionFor, scopeKeyPrefix, USD_LIMIT_FIELDS } from "@edgehero/pi-dispatch/scoped-limits";
// The projects parser, for the same anti-drift reason: a `project:<id>` row is written only when the id is a project the
// worker would load (issue #499 part B).
import { PROJECT_ID_RE, parseProjects, projectOf } from "@edgehero/pi-dispatch/projects";
import { BUNDLE_FORMATS, parseSecretBundleProfiles, parseSecretProfiles, withinRoots } from "@edgehero/pi-dispatch/secret-profiles";
import { ABSENT, BACKEND_NAMES, BACKENDS, CREDENTIAL_CUSTODY, OBSERVATIONS, OPENSHELL_BACKENDS, PROPERTY_NAMES, SERVES, UNATTRIBUTED_BACKEND, declarationOf, effectiveWord, meets, isDeclaration, parseBackendList, parseHostBackends, servesOf } from "@edgehero/pi-dispatch/backends";
import { CRON_ID_MAX, parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
// The allocation envelope, the plan module and the applied split (issue #504 part C), the worker's own: the admin judges an
// envelope with the parser the worker boots with, and applies or reverts a plan through the worker's `applyPlan` and
// `revert`, so the ladder, the step and the compare-and-set are one implementation.
import { ENVELOPE_VERSION, envelopeDigest, parseEnvelope } from "@edgehero/pi-dispatch/envelope";
import { OTHER, PLAN_VERSION, envelopeEntries, scopeRef } from "@edgehero/pi-dispatch/priorities";
import { ALLOC_EXPECTED_KEY, ALLOC_LOG_KEY, ALLOC_PLAN_KEY, makeAllocationAudit, makeAllocationState, parseState } from "@edgehero/pi-dispatch/allocation";
import { DOLLAR_KEY_PREFIX } from "@edgehero/pi-dispatch/dollar-budget";
import { removeHeldJob, requestCancel } from "@edgehero/pi-dispatch/cancel-state";
import { makeRunBudgetLedger } from "@edgehero/pi-dispatch/run-budget-ledger";
import { RECOVERY_CAP, recoveryJobId, runIdOf } from "@edgehero/pi-dispatch/recovery-queue";
import { STEER_ID_RE, STEER_MODES, STEER_SOURCES, STEER_STATES, isOpen as steerIsOpen, listInboxPublic } from "@edgehero/pi-dispatch/steer-inbox";
import { HELD_SET, jobKey, WAIT_ANSWER_PREFIX, WAIT_ANSWERS, WAIT_PROFILE_FIELD_RE } from "@edgehero/pi-dispatch/wait-state";
// Why a waiting job waits (issue #737): the worker's closed vocabulary and the rules each field of its record is held to,
// from the leaf the worker writes with, so the reader and the writer cannot drift on the key, a field or a bucket.
import { DEFER_BUCKETS, DEFER_FIELDS, DEFER_HOST_RE, DEFER_PROJECT_RE, DEFER_TIME_MAX_MS, deferKey, dueOfScore, isSchedulerNext, parseDefer } from "@edgehero/pi-dispatch/defer-reasons";
// The subscriptions validator is shared for the same anti-drift reason: the admin prices finished runs
// against the exact schema the file declares, and re-deriving it here is how the two would disagree.
import { parseSubscriptions, SUBSCRIPTIONS_VERSION } from "@edgehero/pi-dispatch/subscriptions";
import { parseConnection, makeRedisClient, killSwitchValkeyUrls, urlShown, useValkeyContext, valkeyContextFromKeys, VALKEY_CONTEXT_KEYS } from "@edgehero/pi-dispatch/connection";
import { pointerState } from "./deployment-pointer.mjs";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";
import { readDoctorResults } from "@edgehero/pi-dispatch/doctor-results";
import { CAPACITY_WINDOWS, computeCapacity } from "@edgehero/pi-dispatch/capacity";
import { readCapacityRecords } from "@edgehero/pi-dispatch/capacity-records";
import { capacityText, deploymentFacts, onlyHost } from "@edgehero/pi-dispatch/capacity-cli";
import { resolveJobSize } from "@edgehero/pi-dispatch/job-size";
import { projectBudgetRow, publishedBudget } from "@edgehero/pi-dispatch/host-budget";
import { peakSeries, refusalWords, sizeRefusal, suggestSize, suggestionCall, suggestionEvidence } from "@edgehero/pi-dispatch/size-suggest";
import { readSizingRecords } from "@edgehero/pi-dispatch/size-records";
import { QUEUE, makeQueue, enqueueLocalJobReporting, swallowedRunSentence, fleetQueueNames, hostQueueName, discoverHostQueuesReporting, unionQueueNames } from "@edgehero/pi-dispatch/queue";
import { RUNS_INDEX, RUNS_INDEX_MAX, UNREAD_RECORD, hostsIn, mergeRuns, readMirroredPage, readMirroredRecord, readMirroredRuns } from "@edgehero/pi-dispatch/run-mirror";
import { stallKey } from "@edgehero/pi-dispatch/scheduler-stall-guard";
import { makeCheckWaitSkew } from "@edgehero/pi-dispatch/triggers-file";
import { modelFrom, providerFrom, jobImageFrom, allowedModelsFrom } from "@edgehero/pi-dispatch/config";
import { parseSandboxes, parseBudgetFrom, parseCpuReserve } from "@edgehero/pi-dispatch/host-telemetry";
import { parseJobsMore, parseLiveJobs } from "@edgehero/pi-dispatch/live-jobs";
import { CAP_SECRET, parseCaps } from "@edgehero/pi-dispatch/capabilities";
import { sessionKeyOfRecord } from "@edgehero/pi-dispatch/session-key";
// The live transcript's key, kinds, outcomes and tool charset (issue #643), the worker's own, so the reader and the
// publisher cannot drift on the stream's contract.
import { LIVE_KINDS, LIVE_OUTCOMES, LIVE_TOOL_RE, liveKeyFor } from "@edgehero/pi-dispatch/live-transcript";
// The progress key and its caps (issue #644), the worker's own, for the same reason.
import { COMMENT_ID_RE, PROGRESS_COUNT_MAX, PROGRESS_MAX_BYTES, PROGRESS_NOTE_MAX, PROGRESS_PHASE_MAX, PROGRESS_PHASES_MAX, PROGRESS_RECENT_MAX, PROGRESS_RUNNING_MAX, progressKeyFor } from "@edgehero/pi-dispatch/run-progress";
import { readFlowGate, aiTriggerAllows, SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { gitDirty, localRepoProblem } from "@edgehero/pi-dispatch/git-dirty";
import { readStageManifest, readStagedSkills } from "@edgehero/pi-dispatch/packages";
// The skill enumeration reuses the worker's OWN listing parsers (issue #54), the same anti-drift rule
// as parseTriggers/readOverlay above: selectEntries keeps only regular blobs at allowed paths, and
// keepOnlyDeclaredSkills drops a subtree that declares no SKILL.md -- re-deriving either here is how
// the graph would show a skill the job path can never materialise.
import { selectEntries, keepOnlyDeclaredSkills } from "@edgehero/pi-dispatch/materialize";
import { FORGES, RUN_KINDS, isForgeKind } from "@edgehero/pi-dispatch/forges";
import { hasControls, scrubControls } from "./panel.mjs";
import { RUN_MODEL_RE, RUN_PROVIDER_RE, parseRunFilter, runMatches, runVenueOf, triggerValueOf } from "./run-filter.mjs";
// The two pure text scanners live in graph-model.mjs (the pure side of the graph feature); this module
// supplies them bytes, never the other way around -- the dependency points read-model -> graph-model.
import { parseSkillMeta, findSiblingMentions, findLoopHints, triggerMatchLabel } from "./graph-model.mjs";
import { meteredRunMicros, repoOfTarget } from "./costs.mjs";
import { deploymentDollarCaps, dollarWindowRows, dollarWindowSpecs, dollarWindowsSinceMs } from "./dollar-windows.mjs";
// Issue #471: the ONE resolver of a deployment's service keys, shared with `doctor` (the package boundary allows it: the
// admin already takes its config helpers from the worker the same way).
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { BUNDLE_SKIPPED_TEXT, LIVE_SKIPPED_TEXT, STEER_SKIPPED_TEXT } from "@edgehero/pi-dispatch/reason-catalog";
// Issue #710: what counts as a refusal on the overview is what both surfaces call one; issue #737: a failure too.
// A record reason as every surface carries it (issue #737): `recordReason`, the worker's own token charset (its
// import-free leaf), else null. The one door: no reader here hands out a record's reason another way.
import { OUTCOME_KEYS, OUTCOME_WORDS, outcomeKey, outcomeWord, recordReason, rowNumber } from "./words.mjs";

// Re-exported so the command layer reaches the key contract through the admin's single worker-coupling
// funnel, never re-deriving the five known keys.
export { KNOWN_KEYS };

/**
 * Resolve the paths and URLs the admin reads, from `env` alone. Mirrors the worker's own defaulting
 * (`|| default` so an empty string falls back) but deliberately NEVER calls `loadConfig`: like the CLI
 * kill switch (cli.mjs:80-88), the admin must work when the worker's GitHub auth or other env is broken,
 * so it depends only on the handful of variables it actually reads.
 */
export function resolvePaths(env = process.env) {
  return {
    valkeyUrl: env.VALKEY_URL ?? "redis://127.0.0.1:6379",
    logsDir: logsDirPath(env),
    settingsFile: settingsFilePath(env),
    // Cwd defaults match what `pi-dispatch init` scaffolds (and, since issue #80, what the receiver
    // reads), so a deployment folder works without env wiring when pi is launched from it. The old
    // `deploy/…` defaults pointed at the repo's committed EXAMPLE files — right only from a checkout
    // root, and silently wrong (demo triggers) everywhere else.
    //
    // NOT derived from the worker's `pauseWindowsFilePath`/`scopedLimitsFilePath`, and the difference is
    // the point rather than drift (checked for issue #384). Those return `env.X ?? null`, because a WORKER
    // that has not been pointed at a pause-windows file must not start honouring one, least of all a file
    // that stops paid work. The PANEL has the opposite duty: it has to show and edit something, and a
    // deployment folder is where `init` puts these files. Both use `??`, so an EMPTY value survives in
    // both -- which for the worker is the boot refusal doctor now fails on, and here is a path of `""`
    // that simply does not load.
    triggersPath: env.PI_TRIGGERS_FILE ?? "./triggers.json",
    pauseWindowsPath: env.PI_PAUSE_WINDOWS_FILE ?? "./pause-windows.json",
    scopedLimitsPath: env.PI_SCOPED_LIMITS_FILE ?? "./scoped-limits.json",
    // Issue #499: the projects file, with the same cwd default as its siblings (what `init` scaffolds).
    projectsPath: env.PI_PROJECTS_FILE ?? "./projects.json",
    // The projects file AS THE WORKER READS IT, for judging a scoped-limits `project:<id>` row (issue #499 part B): null
    // when the key is unset, which the worker reads as no projects. Not the panel's cwd default above, which would let
    // the panel accept a row against a file the worker never loads.
    projectsFile: env.PI_PROJECTS_FILE ?? null,
    // Issue #504 part C: the allocation envelope AS THE WORKER READS IT, `projectsFile`'s rule: null when the key is
    // unset, which the worker reads as no envelope and no delegation. No cwd default: an envelope the worker never
    // loads is not one the panel may show or write.
    envelopeFile: env.PI_ENVELOPE_FILE ?? null,
    subscriptionsPath: env.PI_SUBSCRIPTIONS_FILE ?? "./subscriptions.json",
    // The operator's global pi overlay dir (REQ-GLOBAL-PI-OVERLAY), where the staged third-party pi
    // packages live under `packages/`. `|| null` so unset AND empty both read as "no overlay" -- the
    // normal deployment, in which no trigger can arm any package.
    globalPiDir: env.PI_GLOBAL_PI_DIR || null,
    captureJobLogs: env.PI_CAPTURE_JOB_LOGS === "1",
    // Swap the panel's box-drawing/sparkline glyphs for plain ASCII (glyph-width-hostile terminals).
    // Resolved here like every other env read; panel.mjs itself stays env-free -- the extension entry
    // point flips its `setGlyphs` switch from this value before anything renders.
    asciiGlyphs: env.PI_DISPATCH_ASCII === "1",
    // REQ-RESURRECTABLE-SANDBOX: where finished runs' directories are retained, and for how long. Read
    // from env for the same reason as everything above -- never loadConfig. The `0` here means retention
    // OFF (the panel then says so rather than offering a key that always refuses), which is the opposite
    // of the log/session sentinels; worker/src/config.mjs carries the full reasoning.
    sandboxDir: env.PI_SANDBOX_DIR || defaultSandboxDir(env),
    sandboxRetentionHours: parseNonNegInt(env.PI_SANDBOX_RETENTION_HOURS, 24),
    sandboxIdleMinutes: parseNonNegInt(env.PI_SANDBOX_IDLE_MINUTES, 30),
    // The two dispatch_run bounds the extension enforces producer-side, read DIRECTLY from env (never
    // loadConfig, which throws on unrelated GitHub-auth problems). `delimitedList`/`nonNegativeInt` are
    // private to the worker's config, so the same shapes are reimplemented here. Default roots [] fails
    // closed: no folder passes the allowlist, so an AI-invoked dispatch_run refuses everything
    // (DES-AI-TRIGGER-FLOW-GATE). Default per-hour cap 3 (DES-ADMIN-VIA-PI-EXTENSION).
    dispatchRunRoots: (env.PI_DISPATCH_RUN_ROOTS ?? "")
      .split(delimiter)
      .map((s) => s.trim())
      .filter(Boolean),
    dispatchRunPerHour: parseNonNegInt(env.PI_DISPATCH_RUN_PER_HOUR, 3),
    // The per-scheduler stall threshold, mirrored from the worker's PI_SCHEDULER_STALL_MAX (default 2) so the
    // cron drill-in can show `stalls n/threshold`. Read directly from env for the same reason as above.
    schedulerStallMax: parseNonNegInt(env.PI_SCHEDULER_STALL_MAX, 2),
    // The chain caps the graph states (issue #54), on the schedulerStallMax pattern: env read directly
    // (never loadConfig), DEFAULTS imported from the worker so there is no second literal to drift --
    // a graph printing "depth <= 1" while the worker enforces 2 would be the exact dishonesty the
    // GRAPH view exists to remove.
    chainDepthMax: parseNonNegInt(env.PI_CHAIN_DEPTH_MAX, CHAIN_DEPTH_MAX_DEFAULT),
    chainMaxPerJob: parseNonNegInt(env.PI_CHAIN_MAX_PER_JOB, CHAIN_MAX_PER_JOB_DEFAULT),
  };
}

/**
 * The four files `pi-dispatch init` scaffolds, whose presence together marks a directory as a deployment folder
 * (`detectDeployment`'s "cwd" state). Spelled once. NOT a licence to read that folder's `.env` (issue #471, gate round
 * 1): a repository can commit all four.
 */
export const DEPLOYMENT_SCAFFOLD_FILES = Object.freeze([".env", "triggers.json", "pause-windows.json", "subscriptions.json"]);

/**
 * Issue #471: the keys `resolvePaths` and the panel read that the deployment's SERVICE reads from its `.env`: paths,
 * URLs and numbers, the worker's and receiver's own settings. The panel resolved every one of them from the environment
 * pi was started in, so a deployment whose `.env` set PI_LOGS_DIR or VALKEY_URL showed another directory's history or
 * another queue while the service ran its own (`OQ-038` recorded the sandbox half). NOT the capability-shaped keys:
 * PI_BACKENDS, PI_BACKEND_FLOOR, PI_EGRESS, PI_EGRESS_PROXY, DOCKER_HOST and PI_DISPATCH_RUN_ROOTS stay this process's
 * own on purpose (`OQ-038`, `INT-DEPLOYMENT-POINTER-CONTRACT`), and so do the panel's own settings (PI_DISPATCH_*).
 */
export const PANEL_SERVICE_KEYS = Object.freeze(["VALKEY_URL", "PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_TRIGGERS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_ENVELOPE_FILE", "PI_CONSOLE_TOKENS_FILE", "PI_GLOBAL_PI_DIR", "PI_SANDBOX_DIR", "PI_SANDBOX_RETENTION_HOURS", "PI_SANDBOX_IDLE_MINUTES", "PI_CAPTURE_JOB_LOGS", "PI_SCHEDULER_STALL_MAX", "PI_CHAIN_DEPTH_MAX", "PI_CHAIN_MAX_PER_JOB", "PI_WORKER_NAME", "PI_CONSOLE_LISTEN", "PI_CONSOLE_BIND_PUBLIC", "PI_SESSIONS_DIR", "PI_SECRET_BUNDLES", "PI_SECRET_PROFILES", "PI_SECRET_RESOLVER_ROOTS", "TMPDIR", "TEMP", ...Object.values(DOLLAR_ENV_NAMES)]);
// The console's address (the insights move to the console): `/dispatch insights` and the `i` key print the spend
// screen's URL from the PI_CONSOLE_LISTEN the console itself reads from this `.env` (`console/link.mjs`).
// The session store (issue #647, part 2): `/dispatch chat` forks a finished run from the PI_SESSIONS_DIR the worker
// writes, which in a pointer deployment is set in this `.env`, so it is a path key below too.
// The bundle resolvers (issue #704, PI_SECRET_BUNDLES, and PI_SECRET_RESOLVER_ROOTS, which bounds the overlay's): the
// bundles view says whether this deployment declares the profile a bundle names and whether an overlay one sits inside
// the roots, and in a pointer deployment those are the `.env`'s lines. DISPLAY ONLY, which is why it may come from the
// file where the capability keys (OQ-038) may not: the panel never runs a resolver, it only says one is declared.
// PI_SECRET_PROFILES (issue #712) for the same reason and under the same limit: the profiles lists name the env-declared
// profiles beside the overlay's, and a profile add refuses a name the env already declares (the worker reads a name in
// both sources as ambiguous). DISPLAY ONLY too, and still not a capability key in OQ-038's sense: the panel never runs
// the resolver it names.
// The dollar settings (issue #501) are among them: `dispatch_set`'s confirm states a dollar key's effective value, and
// in a pointer deployment the cap the worker runs under lives in the deployment's `.env`, not in pi's environment.
// Of those, the paths: a relative one in `.env` is relative to the service's working directory, the deployment folder.
const PANEL_PATH_KEYS = new Set(["PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_TRIGGERS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_ENVELOPE_FILE", "PI_CONSOLE_TOKENS_FILE", "PI_GLOBAL_PI_DIR", "PI_SANDBOX_DIR", "PI_SESSIONS_DIR", "TMPDIR", "TEMP"]);

/**
 * Issue #471: the environment `resolvePaths` should see, by the rule `doctor` judges the service by
 * (`resolveServiceEnv`): pi's own value where the operator exported one, else the deployment `.env`'s from a line the
 * service's loader reads as written, else what the deployment pointer layered in. Returns `{ env, dir, notice }`.
 *
 * WHICH `.env` is decided before any value in it is used, since several steer what the panel connects to (VALKEY_URL)
 * and writes (the triggers, settings, pause and limits files): the pointer's deployment folder, which the wizard wrote,
 * and no other. With no pointer the panel reads its own environment exactly as before. Gate round 1 removed a second
 * source, a cwd carrying init's four scaffold files: a repository can commit those four files, and pi started in it
 * then took that repository's VALKEY_URL, triggers path and worker name (measured). A file another account can write
 * is not read either (`envFileTrust`), and is said.
 *
 * `notice` is one line or undefined: a key pi's environment and the file set differently (named, never its value: a
 * VALKEY_URL may carry a password), a line the panel could not read the way the service will (named, value unused), or
 * a file it could not read or would not trust. The panel then uses pi's value, as a worker started from that shell
 * would, and says the service runs the file's.
 */
export function panelEnv({ env = process.env, pointerDir = null, owned = [], fs = nodeFs, platform = process.platform, uid = process.geteuid?.() } = {}) {
  const dir = pointerDir;
  if (dir === null) return { env, dir: null, notice: undefined };
  // pi's own environment WITHOUT what the pointer layered into it: an export outranks the file, the file the pointer.
  const own = {};
  for (const [key, value] of Object.entries(env)) if (!owned.includes(key)) own[key] = value;
  const res = deploymentServiceEnv({ env: own, dir, keys: PANEL_SERVICE_KEYS, platform, fs, uid });
  const out = res.env;
  for (const [key, value] of Object.entries(res.fromFile)) {
    if (PANEL_PATH_KEYS.has(key) && value !== "" && !isAbsolute(value)) out[key] = resolvePath(dir, value);
  }
  for (const key of owned) if (out[key] === undefined && env[key] !== undefined) out[key] = env[key];
  const said = [];
  if (res.unreadable) said.push(`${res.path} could not be read (${res.unreadable}), so the panel reads its settings from pi's environment alone`);
  if (res.untrusted) said.push(`${res.path} ${res.untrusted}, so the panel takes nothing from it and reads its settings from pi's environment and the pointer alone`);
  if (res.hazardSkipped.length > 0) said.push(`${res.path} line ${res.hazard.line} ${res.hazard.what}, so the panel read none of ${res.hazardSkipped.join(", ")} from it`);
  if (res.unread.length > 0) said.push(`${res.path} assigns ${res.unread.map((u) => `${u.key} (line ${u.line})`).join(", ")} in a form the service's loader may read differently, so the panel used none of those values`);
  if (res.disagreements.length > 0) said.push(`pi's environment and ${res.path} set ${res.disagreements.map((d) => d.key).join(", ")} differently: the panel uses pi's, the service runs the file's; make them agree`);
  return { env: out, dir, notice: said.length > 0 ? said.join("; ") : undefined };
}

/** Parse a non-negative integer from a raw env string; absent/empty/invalid falls back to `fallback`. */
function parseNonNegInt(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && String(n) === String(raw).trim() ? n : fallback;
}

/**
 * Read paused state, the five job counts, and the worker count through one failFast Queue, always closed.
 * `getWorkers` is EMPTY on Redis providers without CLIENT SETNAME, so an empty/absent list degrades to
 * "unknown" rather than reporting zero live workers. Any connection error returns `{ unreachable }`.
 */
export async function readQueueState({ url, makeQueueFn = makeQueue, parseConnectionFn = parseConnection, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  let queue;
  const queuesToClose = [];
  try {
    // EVERY queue this deployment drains, not just the shared one (issue #57). A named host's cron,
    // chained children and `dispatch_run` jobs live on `pi-jobs@<name>`, so a status read that looked only
    // at `pi-jobs` would report an idle queue while that host was busy -- and the pause state would be the
    // state of half a deployment.
    // The UNION, not the registry alone: a queue whose host has gone quiet still holds jobs and still has
    // a paused flag, and a status read that cannot see it cannot tell an operator why work has stopped.
    const { names, hosts, blind } = await readFleetQueues({ url, redisFn, timeoutMs });
    const fleet = blind ? { unreachable: blind } : { hosts };
    const queues = names.map((name) => makeQueueFn(parseConnectionFn(url, { failFast: true }), { name }));
    queuesToClose.push(...queues);
    queue = queues[0];
    // Across every queue, because "is this deployment paused" is the question. `queues[0]` alone would
    // report the shared queue's state and call it the deployment's -- so a half-paused fleet, which
    // `setQueuePaused` can leave behind if it fails mid-loop, would read as fully one or fully the other.
    const pausedStates = await Promise.all(queues.map((q) => q.isPaused()));
    const pausedState = pausedStates.every(Boolean);
    const pausedPartial = pausedStates.some(Boolean) && !pausedState;
    const perQueue = await Promise.all(queues.map((q) => q.getJobCounts("waiting", "active", "paused", "delayed", "failed")));
    // Summed, because an operator asking "what is this deployment doing" means the deployment.
    const counts = perQueue.reduce((acc, c) => {
      for (const [k, v] of Object.entries(c ?? {})) acc[k] = (acc[k] ?? 0) + (Number(v) || 0);
      return acc;
    }, {});
    const workerCount = await readWorkerCount(queue);
    // Issue #57. The registry is authoritative when it answers, because it is ordinary keys;
    // `getWorkers()` rests on CLIENT SETNAME, which some providers do not support -- the very degradation
    // the "unknown" fallback has always been papering over. Its own client, its own timeout, caught here
    // rather than allowed to fail the whole status read: a fleet this panel cannot see is a fleet it says
    // nothing about, never a status line that vanishes.
    const resolved = resolveWorkerCount({ hosts: fleet.hosts ?? [], workerCount: typeof workerCount === "number" ? workerCount : 0 });
    // Issue #289: how many of the delayed count are cron next-occurrences, from the schedulers' OWN
    // source (one permanent delayed entry per scheduler) across every queue. Additive and degradable:
    // an unreadable list yields null, and renderStatus simply does not name the part -- never an
    // invented number. The shared queue's read could be strict like the panel's, but a status LINE
    // degrading one clause beats a status read that throws.
    // typeof-guarded like the worker's cancel poll: an injected fake without the method degrades the
    // part to null SYNCHRONOUSLY-safely -- a bare `.catch` cannot absorb the TypeError a missing
    // method throws before the promise exists.
    const schedulerLists = await Promise.all(
      queues.map((q) => (typeof q.getJobSchedulers === "function" ? q.getJobSchedulers(0, -1, true).catch(() => null) : Promise.resolve(null))),
    );
    const cronNext = schedulerLists.some((l) => !Array.isArray(l)) ? null : schedulerLists.reduce((n, l) => n + l.length, 0);
    return { pausedState, ...(pausedPartial && { pausedPartial }), counts, workers: resolved.count, workerNames: resolved.names, cronNext };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    for (const q of queuesToClose) await q.close().catch(() => {});
  }
}

/**
 * Set the queue's durable paused state through one failFast Queue, always closed. `pause()`/`resume()`
 * mirror the CLI kill switch (cli.mjs:90-95): the state survives a worker restart. Returns
 * `{ ok: true, paused }` on success, or `{ unreachable }` on a connection error, closing in `finally`.
 */

/**
 * The queues a kill switch or a status read must span: what is LIVE (the host registry) unioned with what
 * EXISTS (BullMQ's own meta keys).
 *
 * The registry alone is not enough and the gap is not theoretical. A host whose registry writes fail for
 * ninety seconds loses its row while its worker keeps draining; a booting worker drains for up to fifteen
 * seconds before its first beat; and a clean `service restart` DELs the row outright. In all three, a
 * registry-derived pause misses that host and reports success.
 *
 * The unrecoverable direction is resume: pause with a host live durably pauses its queue, and a resume
 * while that host is down never enumerates it. It stays paused forever, and before this no surface could
 * even name it. A meta key outlives its worker, so the union always can.
 *
 * One client for both reads. Both fail open -- an unreadable registry or keyspace degrades the answer, it
 * never refuses the command.
 */
export async function readFleetQueues({ url, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  let redis;
  try {
    // Made inside the try (PR #478's gate): a VALKEY_URL the client refuses (a path that names no database) is this
    // read's degraded answer, like a down Valkey, never a throw out of a function that fails open.
    redis = redisFn(url);
    redis.on?.("error", () => {}); // a down Valkey is one clean line, never nine ioredis stack traces
    const { names, blind, hosts } = await fleetQueuesOn(redis, { timeoutMs });
    return { names, blind, hosts };
  } catch (err) {
    return { names: [QUEUE], blind: err?.message ?? String(err), hosts: [] };
  } finally {
    try {
      redis?.disconnect?.();
    } catch {
      // best-effort teardown
    }
  }
}

/**
 * `readFleetQueues`' discovery on a client the caller holds (issue #710, review round 1): the live registry unioned with
 * the queues that exist (`unionQueueNames`), `{ names, blind, hosts, incomplete }`. ONE function for the planners
 * (through `readFleetQueues`) and the fleet reader's retained-job read (the run page's re-run and parked-answer checks),
 * so the page asks exactly the queues the click will: a host out of the registry (stopped more than ~90 s) still has
 * its queue, and a page that searched the registry alone said "the data is gone" for a job the planner then found.
 * `blind` is the registry's degradation, `incomplete` the keyspace scan's (`discoverHostQueuesReporting`); either
 * means a job no queue named here holds may still be held. `readLiveHostsFn`/`discoverFn` are seams; a `discoverFn`
 * answering a bare list (the kill switch's shape) reads as complete. Never throws for a read that fails: it degrades.
 */
export async function fleetQueuesOn(redis, { timeoutMs = 2500, prune, readLiveHostsFn = readLiveHosts, discoverFn = discoverHostQueuesReporting } = {}) {
  // CONCURRENTLY, sharing one budget. Serialising them doubled the worst case, so a status read against
  // an unreachable Valkey took twice as long to say the same thing.
  // The inner per-operation bound is HALVED, like `readHosts`: `readLiveHosts` walks `1 + N` operations
  // sequentially, so an inner bound equal to the outer one lets a single hung operation consume the whole
  // budget and the two timers fire together. Halved, one slow host costs half the budget rather than all
  // of it, and the walk can still finish.
  const [fleet, existing] = await Promise.all([
    withTimeout(
      Promise.resolve()
        .then(() => readLiveHostsFn(redis, { timeoutMs: Math.max(250, Math.floor(timeoutMs / 2)), ...(prune === undefined ? {} : { prune }) }))
        .catch((err) => ({ unreachable: err?.message ?? String(err) })),
      timeoutMs,
      { unreachable: "timed out reaching the registry" },
    ),
    Promise.resolve()
      .then(() => discoverFn(redis, { timeoutMs }))
      .catch((err) => ({ names: [], incomplete: err?.message ?? String(err) })),
  ]);
  const found = Array.isArray(existing) ? { names: existing, incomplete: null } : { names: Array.isArray(existing?.names) ? existing.names : [], incomplete: existing?.incomplete ?? (Array.isArray(existing?.names) ? null : "the queue scan answered nothing") };
  const hosts = Array.isArray(fleet?.hosts) ? fleet.hosts : [];
  const blind = fleet?.unreachable ?? (Array.isArray(fleet?.hosts) ? null : "registry unreadable");
  return { names: unionQueueNames(fleetQueueNames(hosts), found.names), blind, hosts, incomplete: found.incomplete };
}

/**
 * Issue #468 with issue #471's rule: where the panel's Valkey clients stand (`valkeyClientContext`'s shape), from the
 * pointer's deployment folder ONLY, read through the one reader the panel has (`deploymentServiceEnv`, one descriptor,
 * nothing from a file another account can change): its VALKEY_PASSWORD, PI_VALKEY_SHARED and PI_BACKENDS, and its
 * VALKEY_URL beside pi's own. pi's own environment is taken without what the pointer layered into it (the pointer's
 * VALKEY_URL is the wizard's snapshot of the file, which the file outranks), so a disagreement is between the operator's
 * export and the file. No pointer: pi's environment alone, and no file. A file that could not be taken from is the
 * context's `error`, as `valkeyClientContext` says one it could not read.
 */
export function panelValkeyContext({ env = process.env, pointerDir = null, owned = [], fs = nodeFs, platform = process.platform, uid = process.geteuid?.() } = {}) {
  const own = {};
  for (const [key, value] of Object.entries(env)) if (!owned.includes(key)) own[key] = value;
  if (pointerDir === null) return valkeyContextFromKeys({ env: own, platform });
  // The file's own values (resolved against an empty shell, so `fromFile` is exactly what the file says).
  const res = deploymentServiceEnv({ env: {}, dir: pointerDir, keys: VALKEY_CONTEXT_KEYS, platform, fs, uid });
  const error = res.untrusted
    ? `${res.path} ${res.untrusted}`
    : res.unreadable
      ? `${res.path} could not be read (${res.unreadable})`
      : res.hazardSkipped.length > 0
        ? `${res.path} line ${res.hazard.line} ${res.hazard.what}`
        : res.unread.length > 0
          ? `${res.path} assigns ${res.unread.map((u) => `${u.key} (line ${u.line})`).join(", ")} in a form the service's loader may read differently`
          : null;
  return valkeyContextFromKeys({ env: own, envPath: res.path, fileKeys: res.fromFile, error, platform });
}

/**
 * Make `panelValkeyContext`, from the pointer's current state, the context every Valkey client of this process gets
 * when its caller names none (`useValkeyContext`), so no client of the panel reads a `.env` by any other way. Read per
 * client, like `panelEnv`, so an edit to the file reaches the next command.
 */
export function installPanelValkeyContext({ env = process.env } = {}) {
  useValkeyContext(() => {
    const { deploymentDir, owned } = pointerState();
    return panelValkeyContext({ env, pointerDir: deploymentDir, owned });
  });
}

/**
 * The panel's kill switch (PR #475's review, round 3): the CLI's rule, from the one resolver both import
 * (`killSwitchValkeyUrls`), over `panelValkeyContext` (issue #471: the pointer's folder only, through the one reader).
 * The panel used this process's VALKEY_URL alone, so a stale one paused a Valkey the worker does not drain and said
 * "paused". When pi's own VALKEY_URL and the deployment .env's disagree, a PAUSE pauses both, and a RESUME, which would
 * start spending, is refused until they agree. Returns `{ refused }`, or `{ results: [{ url, shown, res }],
 * disagreement }` with each URL as `urlShown` prints it, never with its userinfo; every client sends the deployment's
 * password by that same context.
 */
export async function killSwitchSet({ paused, env = process.env, setFn = setQueuePaused, resolveFn = killSwitchValkeyUrls, stateFn = pointerState, fs = nodeFs, uid = process.geteuid?.(), plan = null } = {}) {
  const picked = plan ?? killSwitchPlan({ paused, env, resolveFn, stateFn, fs, uid });
  if (picked.refused) return { refused: picked.refused };
  const context = picked.context ?? null;
  const conn = context
    ? { parseConnectionFn: (u, o = {}) => parseConnection(u, { ...o, context }), redisFn: (u, o = {}) => makeRedisClient(u, { ...o, context }) }
    : {};
  const results = [];
  for (const url of picked.urls) results.push({ url, shown: urlShown(url), res: await setFn({ url, paused, ...conn }) });
  return { results, disagreement: picked.urls.length > 1 ? picked.disagreement : null };
}

/**
 * The kill switch's DECISION, without acting (issue #642): which Valkeys a pause or resume reaches, or why it refuses.
 * `{ refused }`, or `{ urls, disagreement, context }` with `context` the `panelValkeyContext` every client of it must
 * take (the deployment's password). Split out of `killSwitchSet` so every surface that pauses (the tools, the TUI's
 * `p`/`r` through the fleet reader, the console) refuses the same resume on the same two-Valkey disagreement, by one
 * rule rather than one copy each. `stateFn` names the deployment folder: the pi extension's pointer by default, the
 * console's own deployment folder when it passes one.
 */
export function killSwitchPlan({ paused, env = process.env, resolveFn = killSwitchValkeyUrls, stateFn = pointerState, fs = nodeFs, uid = process.geteuid?.() } = {}) {
  const { deploymentDir, owned } = stateFn();
  const context = panelValkeyContext({ env, pointerDir: deploymentDir, owned, fs, uid });
  const picked = resolveFn({ env, context });
  if (picked.error) return { refused: picked.error };
  const deploymentUrl = picked.urls.length > 1 ? picked.urls[1] : picked.urls[0];
  const resumeArgv = ["pi-dispatch", "resume", "--valkey-url", urlShown(deploymentUrl)];
  const resumeCommand = `pi-dispatch resume --valkey-url '${urlShown(deploymentUrl).replaceAll("'", "'\\''")}'`;
  if (picked.urls.length > 1 && !paused) {
    return { disagreement: picked.disagreement, resumeCommand, resumeArgv, refused: `${picked.disagreement}: resume would start jobs on one of them, so it resumes neither. Make them agree (the .env is what the service reads), or run: ${resumeCommand}` };
  }
  return { urls: picked.urls, disagreement: picked.urls.length > 1 ? picked.disagreement : null, context, resumeCommand, resumeArgv };
}

/**
 * Pause or resume ONE fleet queue (issue #642): the console's per-queue control. `queue` must be a queue this
 * deployment drains, by the kill switch's own discovery (`readFleetQueues`: the live registry unioned with the queues
 * that exist), so a mistyped name is refused rather than creating a paused queue nothing reads (the silent no-op
 * `cli.mjs` warns about). Returns `{ ok: true, paused, queue }`, `{ invalid }` for a name that is not a fleet queue, or
 * `{ unreachable }`.
 *
 * One Valkey, the caller's `url`. The fleet-wide two-Valkey rule (`killSwitchPlan`) is about stopping or starting a
 * whole deployment; a single queue named here is named on the Valkey the caller reads it from, where its paused flag
 * was seen.
 */
export async function setQueuePausedOne({ url, queue, paused, makeQueueFn = makeQueue, parseConnectionFn = parseConnection, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  if (typeof queue !== "string" || queue === "") return { invalid: "a queue name is required" };
  if (typeof paused !== "boolean") return { invalid: "paused must be true or false" };
  let q = null;
  try {
    const { names, blind } = await readFleetQueues({ url, redisFn, timeoutMs });
    if (!names.includes(queue)) {
      // The registry read's own error stays out of it: a client's words, which can name a host, and this is a page's.
      return { invalid: `${JSON.stringify(queue)} is not a queue this deployment drains (${names.join(", ")})${blind ? "; the host registry could not be read, so a host's queue may be missing from that list" : ""}. Nothing was changed` };
    }
    q = makeQueueFn(parseConnectionFn(url, { failFast: true }), { name: queue });
    if (paused) await q.pause();
    else await q.resume();
    return { ok: true, paused, queue };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (q) await q.close().catch(() => {});
  }
}

export async function setQueuePaused({ url, paused, makeQueueFn = makeQueue, parseConnectionFn = parseConnection, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  const opened = [];
  try {
    // EVERY queue in the fleet (issue #57). This is the kill switch: pausing only `pi-jobs` would stop
    // forge deliveries while a named host's cron, chained children and manual runs kept spending, and it
    // would report success for having done it. `cli.mjs`'s own comment already warns that a queue name
    // that names nothing is a silent no-op; half a deployment is the same failure, halved.
    //
    // `readHosts` RETURNS `{unreachable}` and never rejects, so the fallback is a branch, not a `.catch`.
    // It matters which: an unreadable registry means we are acting on the shared queue alone, and the
    // caller has to be able to say so rather than print a success line identical to a single-host one.
    const { names, blind } = await readFleetQueues({ url, redisFn, timeoutMs });
    // Track what actually landed. A loop that throws halfway leaves the deployment HALF paused, and
    // returning a bare `{ unreachable }` for that would be the worst answer available: the operator would
    // read it as "nothing happened" and walk away from a fleet where one host is stopped and another is
    // still spending. So the failure carries the names of the queues that did change.
    const done = [];
    for (const name of names) {
      // Constructed one at a time INSIDE the try, and pushed BEFORE it is used: `makeQueueFn` can throw on
      // a malformed peer-written name, and building the whole list first would leak every connection
      // opened before the throw.
      const q = makeQueueFn(parseConnectionFn(url, { failFast: true }), { name });
      opened.push(q);
      try {
        if (paused) await q.pause();
        else await q.resume();
      } catch (err) {
        return { unreachable: err?.message ?? String(err), partial: { done, failed: name, error: err?.message ?? String(err) }, blind };
      }
      done.push(name);
    }
    return { ok: true, paused, queues: done, ...(blind ? { blind } : {}) };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    for (const q of opened) await q.close().catch(() => {});
  }
}

// ~2h so a rolling-hour bucket outlives its hour and is reclaimed shortly after (mirrors budget's TTL idiom).
const DISPATCH_RUN_TTL_SECONDS = 2 * 60 * 60;

/**
 * Resolve a folder's committed HEAD sha via `git -C <folder> rev-parse HEAD`, trimmed, or `null` on any
 * error (mirrors gitDirty's shape). Operator-host-trusted and pre-enqueue: the sha pins the flow-gate read
 * to the commit BEFORE the agent runs, so an agent cannot self-authorize by committing its own SKILL.md
 * (DES-AI-TRIGGER-FLOW-GATE). `exec` is injectable for tests.
 */
/**
 * The stdio of every git read here: stdin closed, stdout and stderr captured. Inherited, git's stderr reached the
 * caller's own: "fatal: not a git repository" on every insights assembly in the console's log (with the folder's host
 * path in it), and over the TUI's screen inside pi. The exit status still says what failed; the words are not shown.
 */
const GIT_READ_STDIO = Object.freeze(["ignore", "pipe", "pipe"]);

export function revParseHead(folder, { exec = execFileSync } = {}) {
  try {
    // Hardened like every other host-side read. `rev-parse` does not refresh the index, so it does not
    // invoke fsmonitor and nothing here was reachable -- but "this particular subcommand is harmless" is
    // the reasoning that left `git-dirty.mjs` unhardened while `status` sat one module over.
    const out = exec("git", [...GIT_READ_FLAGS, "-C", folder, "rev-parse", "HEAD"], { encoding: "utf8", stdio: GIT_READ_STDIO });
    const sha = out.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The paid-start bounds shared by dispatch_run and Fire now (#750). A preview performs the determinate
 * checks without consuming the hourly allowance; the executor repeats them at HEAD and consumes it immediately
 * before enqueue. Neither a preview nor a page load may spend that allowance.
 */
export async function checkDispatchRun({
  folder, flow, aiInvoked = true, consumeRate = true, env = process.env,
  readFlowGateFn = readFlowGate, gitDirtyFn = gitDirty, localRepoProblemFn = localRepoProblem,
  revParseHeadFn = revParseHead, redisFn = makeRedisClient, now = () => Date.now(),
}) {
  // 1. flow required (both paths). Cheapest and most definitive: a flowless AI trigger is refused, and the
  // tool's `flow` is mandatory even though the CLI's `--flow` is optional.
  if (typeof flow !== "string" || flow.trim() === "") {
    return { refused: "no flow — a flow is required to trigger a run" };
  }

  // A slash-leading "flow" is a registered extension command (issue #189, `run.command`), refused on
  // BOTH paths deliberately: commands are never AI-reachable (no chain, no dispatch_run, no opt-in --
  // stricter than flows, because no committed SKILL.md exists for a gate to read), and an operator
  // typing `/dispatch run /wf` is a user error that deserves this message, not a garbage-prose enqueue
  // of a job the runner would refuse. Everywhere else the exclusion is STRUCTURAL, not a check:
  // dispatch_run's params are exactly {folder, flow, task} and dispatch_trigger_add/_edit carry no
  // command parameter, so this refusal exists only to catch a command smuggled into the flow field.
  if (flow.trim().startsWith("/")) {
    return {
      refused: `flow '${flow}' names a command, not a flow — commands are not AI-triggerable; a registered extension command runs only from a reviewed triggers.json entry (run.command)`,
    };
  }

  const { valkeyUrl, dispatchRunRoots, dispatchRunPerHour } = resolvePaths(env);

  // 2. aiInvoked ONLY -- fail-closed folder allowlist (realpath + containment). Default roots [] refuses all.
  if (aiInvoked && !folderUnderRoots(folder, dispatchRunRoots)) {
    return { refused: "folder not under PI_DISPATCH_RUN_ROOTS" };
  }

  // 3. the worker's folder rule (BOTH paths, issue #524): `.git` at the folder itself and a commit at HEAD. The
  // worker's own sentence, shared rather than restated, so this and `pi-dispatch run` cannot drift. `gitDirty` alone
  // let a subfolder of a repository through (`git status` answers from any depth), and the worker then refused it.
  const notARepo = localRepoProblemFn(folder);
  if (notARepo) return { refused: notARepo };

  // 3b. dirty-tree, no force (BOTH paths). A local run edits the folder in place with no undo.
  const dirty = gitDirtyFn(folder);
  if (dirty === null) return { refused: "not a usable git repository" };
  if (dirty) {
    return { refused: "uncommitted changes — commit/stash, or use the CLI `pi-dispatch run --force`" };
  }

  // 4. aiInvoked ONLY -- committed flow gate at the pre-agent SHA. The sha is resolved here and NOT pinned
  // into job data: the worker re-resolves at prepare, and the enqueue->run TOCTOU window is accepted
  // (DES-AI-TRIGGER-FLOW-GATE). Only an exact `ai-trigger: allow` passes.
  if (aiInvoked) {
    const notTriggerable = `flow '${flow}' is not AI-triggerable (.pi/skills/${flow}/SKILL.md needs ai-trigger: allow at HEAD)`;
    const sha = revParseHeadFn(folder);
    if (typeof sha !== "string" || sha.trim() === "") return { refused: notTriggerable };
    const { gate } = await readFlowGateFn({ folder, flow, sha });
    if (gate !== "allow") return { refused: notTriggerable };
  }

  // 5. aiInvoked ONLY -- per-hour rate limit. INCR-then-compare like reserveBudget: a refused attempt still
  // counts (no give-back), so a burst cannot probe the cap for free. A per-hour cap of 0 disables the tool.
  if (aiInvoked) {
    if (dispatchRunPerHour === 0) return { refused: "dispatch_run hourly limit (0) reached" };
    let redis;
    try {
      redis = redisFn(valkeyUrl);
      const key = hourKey(now());
      const count = Number(consumeRate ? await redis.incr(key) : (await redis.get(key) ?? 0));
      if (consumeRate && count === 1) await redis.expire(key, DISPATCH_RUN_TTL_SECONDS);
      if (consumeRate ? count > dispatchRunPerHour : count >= dispatchRunPerHour) {
        return { refused: `dispatch_run hourly limit (${dispatchRunPerHour}) reached` };
      }
    } catch (err) {
      return { unreachable: err?.message ?? String(err) };
    } finally {
      if (redis) {
        try {
          redis.disconnect();
        } catch {
          // already closed
        }
      }
    }
  }

  return {};
}

/**
 * Enqueue a PAID local run -- the extension's one model-callable WRITE. Producer-side only: it spends
 * nothing here, so every bound refuses BEFORE any container starts; the daily cap stays the worker
 * processor's job (CONST-BUDGET-BEFORE-TOKENS). Returns a discriminated
 * `{ ok, jobId } | { refused } | { unreachable }` (mirrors setQueuePaused's failFast open/close-in-finally).
 * An `ok` the one-minute dedup swallowed also carries `deduplicated: true`, `existing` and `said` (issue #524).
 *
 * `aiInvoked` selects the bound set from the six-control analysis (DES-ADMIN-VIA-PI-EXTENSION):
 *   - `true`  (the `dispatch_run` tool): folder allowlist + committed flow gate + per-hour rate limit,
 *     plus the dirty-tree refusal.
 *   - `false` (the operator's `/dispatch run`): the dirty-tree refusal ONLY -- typing the command IS the
 *     approval, so the allowlist, gate, and rate limit are the AI path's compensating controls and are skipped.
 * Validation runs cheapest/most-definitive first. No spend-knob param (model/maxTurns/dailyCap/concurrency)
 * exists here; those resolve worker-side from the overlay/env. Refusal reasons carry folder/flow (operator
 * config) but NEVER task text, and nothing here logs.
 */
export async function enqueueDispatchRun({
  folder,
  flow,
  task,
  aiInvoked,
  env = process.env,
  makeQueueFn = makeQueue,
  parseConnectionFn = parseConnection,
  readFlowGateFn = readFlowGate,
  gitDirtyFn = gitDirty,
  localRepoProblemFn = localRepoProblem,
  revParseHeadFn = revParseHead,
  redisFn = makeRedisClient,
  now = () => Date.now(),
}) {
  const admission = await checkDispatchRun({ folder, flow, aiInvoked, env, readFlowGateFn, gitDirtyFn, localRepoProblemFn, revParseHeadFn, redisFn, now });
  if (admission.refused || admission.unreachable) return admission;
  const { valkeyUrl } = resolvePaths(env);

  // 6. enqueue. A root run: no chainDepth/parentJobId, and provider/model/maxTurns stay absent so they
  // resolve worker-side against the overlay/env (INT-CONFIG-OVERLAY-CONTRACT).
  let queue;
  try {
    // Onto THIS host's queue when the deployment declares a worker name (issue #57). The folder was
    // resolved against PI_DISPATCH_RUN_ROOTS, which is this machine's allowlist, so this machine is the
    // only one that can run it. Read straight from the environment rather than through the deployment
    // pointer, deliberately: the pointer carries PATHS and refuses capability grants, and a value that
    // decides WHICH HOST runs a job is closer to the second than the first.
    // Issue #471: from the environment the caller resolved (`panelEnv`), which takes the deployment `.env`'s name where
    // pi's environment has none, as the service's worker does: without it a folder only this machine holds went onto the
    // shared queue, where any host could pop it. Never from the pointer, whose allowlist does not carry it.
    const workerName = env.PI_WORKER_NAME;
    queue = makeQueueFn(parseConnectionFn(valkeyUrl, { failFast: true }), { ...(workerName ? { name: hostQueueName(workerName) } : {}) });
    // Reporting (issue #524): the one-minute dedup can swallow this enqueue, and then nothing new is queued. The
    // caller must not say "queued" for that, so it gets `existing` and the shared sentence to say instead.
    const { id: jobId, existing } = await enqueueLocalJobReporting(queue, { folder, flow, task });
    if (existing) return { ok: true, jobId, deduplicated: true, existing, said: swallowedRunSentence(jobId, existing) };
    return { ok: true, jobId };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}

/**
 * Fail-closed folder allowlist for the AI-invoked path: resolve the target's realpath and each root's
 * realpath, and admit only when the target IS a root or is nested under one. Realpath defeats a symlink
 * pointing out of a root; the `+ sep` containment defeats a sibling-prefix match (`/a/rootX` vs `/a/root`).
 * Empty roots or any realpath error refuses (DES-ADMIN-VIA-PI-EXTENSION control 1).
 */
function folderUnderRoots(folder, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  let realTarget;
  try {
    realTarget = nodeFs.realpathSync(folder);
  } catch {
    return false;
  }
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = nodeFs.realpathSync(root);
    } catch {
      continue; // an unresolvable root cannot admit anything; try the next
    }
    if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) return true;
  }
  return false;
}

/** Rolling-hour bucket key for the dispatch_run rate limit: `dispatch-run:YYYY-MM-DD-HH` (UTC). */
function hourKey(nowMs) {
  return `dispatch-run:${new Date(nowMs).toISOString().slice(0, 13).replace("T", "-")}`;
}

/**
 * Read-modify-write the settings overlay: read the current file, apply `mutate` to a copy of the overlay, and write
 * the result through the worker's own atomic `writeOverlay`. Validation stays in `writeOverlay`; a rejected candidate
 * returns `{ invalid }`. Returns `{ ok: true, overlay }`.
 *
 * A present-but-INVALID current file is REFUSED, never rebuilt (issue #501). It used to be rebuilt from `{}` with a
 * loud notice, which turned any later `set` into an eraser: a hand-edited file that is invalid only for a duplicate
 * key still carries its `maxCostUsd` and `secretProfiles`, and the rebuild dropped both, so jobs went from refused
 * (fail closed) to running at the env cap or with none. The refusal names the read reason (key names, never values)
 * and the two ways out: fix the file, or delete it to start from an empty overlay. A MISSING file is still the
 * normal empty overlay and writes as before, and so does a BLANK one (whitespace or a byte-order mark only), which
 * holds nothing that could be lost.
 *
 * `expect` (issue #642), as for `writePauseWindows`: the `writeInputs` snapshots the change was built from (the console's
 * preview). `writeOverlay` re-reads them right before its rename and refuses, with nothing written, when one changed.
 * Without it the write is what it always was.
 */
export function writeSettings({ settingsFile, mutate, expect = null, fs = nodeFs, dollarEnv = undefined, deploymentDir = null }) {
  const res = readOverlay(settingsFile, { fs });
  if (res.invalid && !blankSettingsFile(settingsFile, fs)) return { invalid: overlayInvalidRefusal(res.invalid) };
  const next = mutate({ ...(res.overlay ?? {}) });
  // Issue #501 (PR #542's review): a write that touches a dollar key is judged on the MERGED values when the caller
  // passes the env, and the answer is a WARNING returned beside the result, never a refusal: the worker's cap may come
  // from a source not visible here (`mergedDollarProblem`). Other keys are not judged.
  const warning = dollarEnv === undefined ? undefined : mergedDollarProblem(next, dollarEnv, { deploymentDir })?.warning;
  const w = writeOverlay(settingsFile, next, { fs, expect });
  if (w.invalid) return { invalid: w.invalid };
  return { ok: true, overlay: next, ...(warning ? { warning } : {}) };
}

/**
 * A settings file whose text is nothing but whitespace or a byte-order mark: invalid to the worker (not JSON), but it
 * holds no key, so a write over it loses nothing and is allowed, as a missing file is. Any read error is not blank.
 * `writeSettings` and the `dispatch_set` tool's pre-confirm check (issue #540) share this one test.
 */
export function blankSettingsFile(path, fs = nodeFs) {
  try {
    return String(fs.readFileSync(path, "utf8")).replace(/^\uFEFF/, "").trim() === "";
  } catch {
    return false;
  }
}

/** The words for a write refused over an invalid settings file (issue #501). `reason` is `readOverlay`'s, key-only. */
export function overlayInvalidRefusal(reason) {
  return `the settings file is invalid (${reason}), so nothing was written and no key in it was lost. Fix the file, or delete it to start from an empty overlay, then set again`;
}

/**
 * The value a `dispatch_set` confirm shows for a key (issue #501), before or after the change. For a dollar key it is
 * the EFFECTIVE value and where it comes from, because the overlay alone misleads exactly there: with
 * `PI_MAX_COST_USD=2` in the deployment's env and no overlay key, "maxCostUsd: (unset) -> 1000000" reads as adding a
 * cap while it raises one 500,000 times, and unsetting an overlay key falls back to the env cap, not to none. `env` is
 * `deploymentEnv()`, whose `panelEnv` reads the dollar variables from the deployment's `.env` (`PANEL_SERVICE_KEYS`).
 * Every other key keeps the overlay value, because its env default lives in the worker's config and a second copy of
 * those defaults here would drift.
 *
 * `deploymentDir` says whether the worker's environment is visible here at all. With a deployment pointer the panel
 * reads the deployment's `.env` (the file the worker reads), so a variable absent from it really is unset. With no
 * pointer the panel sees only pi's own environment, which is not the worker's (a service unit, another shell), so an
 * absent variable proves nothing and the confirm says so rather than claiming "no cap". An empty value is unset, the
 * worker's own reading (`usdSetting`).
 */
export function settingShown(key, overlay, env, { deploymentDir = null } = {}) {
  const own = overlay?.[key];
  if (!DOLLAR_SETTING_KEYS.includes(key)) return own === undefined ? "(unset)" : String(own);
  if (own !== undefined) return `${own} (overlay)`;
  const name = DOLLAR_ENV_NAMES[key];
  const fromEnv = env?.[name];
  if (typeof fromEnv === "string" && fromEnv !== "") return `${fromEnv} (env ${name})`;
  return deploymentDir === null ? "(not in the overlay; the worker's environment is not visible here)" : "(unset: no cap)";
}

/**
 * Would this overlay, merged over the env the admin can see, break the dollar invariant (a window with no
 * `maxCostUsd`, issue #501)? The worker checks it per job (`resolveSettings`) and refuses EVERY job as
 * `settings-overlay-invalid` when it breaks, so the operator should hear about it before a `set dailyCostUsd` or an
 * `unset maxCostUsd` lands.
 *
 * Returns null when the merged values hold, else `{ warning }`, and NEVER a refusal (PR #542's review, round 2). The
 * admin cannot see every source of the worker's env: a service unit's `Environment=` line or a `--env-setup` script
 * can set `PI_MAX_COST_USD` with nothing in `.env`, so a refusal here would block a valid change (and could make
 * `unset maxCostUsd` impossible). The worker still fails closed per job, and `doctor` on the worker reads its real
 * env. The warning names what was seen: the overlay plus the deployment's `.env` with a pointer, else this session's
 * environment, which is not the worker's. An empty env value is unset, the worker's own reading.
 */
export function mergedDollarProblem(overlay, env, { deploymentDir = null } = {}) {
  const merged = {};
  for (const key of DOLLAR_SETTING_KEYS) {
    if (overlay?.[key] !== undefined) merged[key] = overlay[key];
    else {
      const fromEnv = env?.[DOLLAR_ENV_NAMES[key]];
      if (typeof fromEnv === "string" && fromEnv !== "") merged[key] = fromEnv;
    }
  }
  const broken = checkDollarInvariant(merged);
  if (broken === null) return null;
  const seen = deploymentDir === null ? "the settings overlay nor this session's environment (not the worker's)" : "the settings overlay nor the deployment's .env";
  return { warning: `${broken.invalid}. Neither ${seen} sets maxCostUsd (PI_MAX_COST_USD). A cap set elsewhere, such as the worker's service unit or its --env-setup script, is not visible here; if the worker has none, it refuses every job as settings-overlay-invalid (or, when the window is in the worker's own environment, will not start). Run \`pi-dispatch doctor\` on the worker to check` };
}

/**
 * Read-modify-write the unified triggers.json. MOVED to the worker package (issue #231,
 * `@edgehero/pi-dispatch/triggers-file`) and re-exported here so the console's six tool/dialog call
 * sites and the wizard's injection seam keep their import path: the worker's one-shot disarm made the
 * file a two-author surface, and both authors must serialize through the one locked writer -- the same
 * "reuse, never re-derive" that single-sources `parseTriggers` itself. Semantics unchanged for every
 * caller (validated fail-closed, tmp+rename atomic, missing-file repair), plus three caller-visible
 * deltas: `{ invalid }` naming the `.lock` when another write holds it (the operator answers by
 * re-pressing the key); a transient EPERM on the rename retries once before it throws (writeOverlay's
 * Windows-AV posture); and a missing parent directory now throws from the lock create naming `.lock`
 * rather than from the tmp write -- same throw contract, different message.
 */
export { writeTriggers } from "@edgehero/pi-dispatch/triggers-file";

/**
 * The console's job actions (issue #642): retry and remove a failed job (one or in bulk), re-run a finished run, answer
 * a parked run, and (issue #646) send a message into a running job or take one back. They live in `job-actions.mjs` for
 * size alone and are re-exported here, so every caller still reaches the queue through this one funnel. And the
 * worker's reserve rule, for the reserve a paid action shows before confirm.
 */
import { boundedText, heldClearedAnswer, heldRefused, heldRemovalUnanswered, parkedAnswerRefusalOf, rerunRefusalOf, RERUN_BAD_ID } from "./job-actions.mjs";
export { planTriggerFire, enqueueTriggerFire } from "./trigger-fire.mjs";
export { BULK_MAX, cancelQueuedJob, cancelQueuedRefusal, enqueueParkedAnswer, enqueueRerun, enqueueSteer, parkedAnswerRefusalOf, planCancelQueued, planFailedBulk, planParkedAnswer, planRerun, rerunRefusalOf, planSteer, planSteerWithdraw, removeFailedJob, removeFailedJobs, retryFailedJob, retryFailedJobs, steerAuditTarget, steerWithdrawSentence, withdrawSteerMessage } from "./job-actions.mjs";
export { estimateReserve } from "@edgehero/pi-dispatch/reserve-estimate";

/**
 * Read + validate the pause-windows file for display (REQ-SCOPED-PAUSE-WINDOWS). Returns `{ windows }` of
 * normalized entries (with `fromMin`/`toMin`), or `{ missing }` / `{ invalid }` so the viewer degrades rather
 * than throwing. Uses the SHARED `parsePauseWindows`, so the admin and the worker cannot drift on the schema.
 */
export function readPauseWindows({ pauseWindowsPath, fs = nodeFs }) {
  let text;
  try {
    text = fs.readFileSync(pauseWindowsPath, "utf8");
  } catch {
    return { missing: true };
  }
  try {
    return { windows: parsePauseWindows(text, pauseWindowsPath) };
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
}

/**
 * Read-modify-write the pause-windows file (mirrors `writeTriggers`): `mutate(windows)` receives a copy of the
 * current raw `windows` array and returns the new array; the result is re-serialized, VALIDATED through the
 * SHARED `parsePauseWindows` (fail-closed — a rejected result is NEVER written, so the worker loader can always
 * parse it), and written ATOMICALLY (tmp + rename) so the live-reload watcher never sees a half-written file.
 * Reached from operator-typed `/dispatch pause …` handlers AND the confirm-gated `dispatch_pause_*` tools; the
 * tools route through `confirmedWrite` (an operator approves before this runs). Returns `{ ok }` or `{ invalid }`.
 *
 * `expect` (issue #640), as for `writeScopedLimits` and `writeProjects`: the `writeInputs` snapshots the change was
 * built from (the console's preview, stored in its confirm ticket). Right before the rename the file is re-read and
 * compared with them, and a difference refuses with nothing written, so a confirm applies exactly what was previewed.
 * With no `expect` the re-check is against this call's own read, which only narrows the window a concurrent write
 * could be lost in. Deliberately NOT `replaceFile`: that one refuses a symlink and keeps the file's mode and owner,
 * each a behaviour change for the extension's existing callers, which this change does not make.
 */
export function writePauseWindows({ pauseWindowsPath, mutate, expect = null, fs = nodeFs }) {
  let current = [];
  // The text as read, which is also the snapshot the re-check compares against when there is no `expect`.
  const read = fileSnapshot(fs, pauseWindowsPath);
  try {
    const raw = JSON.parse(read);
    if (Array.isArray(raw?.windows)) current = raw.windows;
  } catch {
    // Missing/invalid file: start from empty; the validated atomic write below repairs it.
  }
  const next = mutate(current.map((w) => ({ ...w })));
  const text = `${JSON.stringify({ windows: next }, null, 2)}\n`;
  try {
    parsePauseWindows(text, pauseWindowsPath); // the loader's own validator -- never write a file it would reject
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
  // A tmp name of its own, created exclusively, as `replaceFile` does: the console and the pi extension are two
  // processes writing this file, and a shared `<file>.tmp` would let one rename the other's bytes past its own re-check.
  const tmp = `${pauseWindowsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644, flag: "wx" });
  for (const input of Array.isArray(expect) ? expect : [{ path: pauseWindowsPath, text: read }]) {
    if (fileSnapshot(fs, input.path) !== input.text) {
      try {
        fs.unlinkSync?.(tmp);
      } catch {
        // nothing to drop
      }
      return { invalid: `${input.path} changed after this change was built from it (another session wrote it); nothing was written. Look again and retry` };
    }
  }
  fs.renameSync(tmp, pauseWindowsPath);
  return { ok: true };
}

/**
 * Read + validate the scoped-limits file for display (INT-SCOPED-LIMITS-FILE-CONTRACT). Returns
 * `{ limits }` of normalized rows, or `{ missing }` / `{ invalid }` so the viewer degrades — the
 * `{ invalid }` case includes a file written by a newer pi-dispatch (fail-loud, naming both versions).
 * Uses the SHARED `parseScopedLimits`, so the admin and the worker cannot drift on the schema.
 */
export function readScopedLimits({ scopedLimitsPath, fs = nodeFs }) {
  let text;
  try {
    text = fs.readFileSync(scopedLimitsPath, "utf8");
  } catch {
    return { missing: true };
  }
  try {
    return { limits: parseScopedLimits(text, scopedLimitsPath) };
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
}

/**
 * Read-modify-write the scoped-limits file. DELIBERATELY NOT `writePauseWindows`' raw-array scavenge:
 * the read goes THROUGH the shared parser, so an existing file with a missing or NEWER `version`
 * refuses the write (`{ invalid }`) instead of being silently re-stamped v1 with its unknown fields
 * dropped — that re-stamp is exactly the cap-widening the version field exists to prevent, and it is
 * why this money file refuses where the analytics twin (`writeSubscriptions`) repairs. Only a MISSING
 * file starts from the empty v1 shape. The result is re-serialized (absent windows omitted, not
 * null-padded — the committed example's shape), re-validated fail-closed, and written tmp + rename.
 * Returns `{ ok }` (with `pending` when the worker will not take it live, below) or `{ invalid }`.
 *
 * Issue #499 part B: a `project:<id>` row this write adds or changes must name a project in `projectsPath`, the
 * projects file as the WORKER reads it (null when PI_PROJECTS_FILE is unset: no projects), or the write is refused: the
 * worker would refuse to start on it, and a running worker would keep its last good limits. A row already in the file,
 * unchanged, is not re-judged, so a row left dangling by a projects.json edit can still be deleted, and other rows
 * edited, while doctor names it; such a write returns `pending`, which says the worker applies it once its LIVE projects
 * define the id (the admin cannot see those, so it claims neither way).
 *
 * Issue #504 part C: with `envelope` (`{ file, maxCostMicros }`, the allocation envelope the worker reads and the merged
 * per-job cap), a write that would leave that envelope invalid is refused and names the conflict (`envelopeRefusal`):
 * a row lowered below a floor. `dryRun` judges everything and writes nothing, so a tool can refuse BEFORE its confirm.
 */
export function writeScopedLimits({ scopedLimitsPath, projectsPath = null, mutate, expect = null, envelope = null, dryRun = false, fs = nodeFs }) {
  const link = symlinkRefusal(fs, scopedLimitsPath, "PI_SCOPED_LIMITS_FILE");
  if (link) return { invalid: link };
  let current = [];
  // Only a MISSING file starts from the empty v1 shape, the one repair this writer performs (PR #569's review). A file
  // that is there but cannot be read (EACCES, EISDIR, EIO) refuses, as one that does not parse does: starting from
  // nothing would write a file that drops every row the operator cannot see from here.
  const existing = fileSnapshot(fs, scopedLimitsPath);
  if (isUnreadable(existing)) return { invalid: `the scoped-limits file ${scopedLimitsPath} could not be read (${unreadableCode(existing)}); nothing was written` };
  if (existing !== null) {
    try {
      current = parseScopedLimits(existing, scopedLimitsPath);
    } catch (e) {
      return { invalid: e?.message ?? String(e) };
    }
  }
  const next = mutate(current.map((l) => ({ ...l })));
  const rows = next.map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== null && v !== undefined)));
  // The LOWEST version that expresses the file (issues #501 part 5, #502 part 6, #498): 1 unless a row carries a
  // dollar window, is a model row or has a forge-qualified scope, so a file of bare and folder job-count rows stays
  // readable by a worker that predates version 2.
  const text = `${JSON.stringify({ version: scopedLimitsVersionFor(rows), limits: rows }, null, 2)}\n`;
  let written;
  try {
    written = parseScopedLimits(text, scopedLimitsPath); // the loader's own validator -- never write a file it would reject
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
  const pairText = projectsPath === null || projectsPath === undefined ? null : fileSnapshot(fs, projectsPath);
  const judged = judgeProjectRows(current, written, projectsPath, fs);
  if (judged.refusal) return { invalid: judged.refusal };
  const broken = envelope ? envelopeRefusal({ envelopeFile: envelope.file, projectsPath, scopedLimitsPath, maxCostMicros: envelope.maxCostMicros, next: { limits: written }, fs }) : null;
  if (broken) return { invalid: broken };
  if (dryRun) return judged.pending ? { ok: true, dryRun: true, pending: judged.pending } : { ok: true, dryRun: true };
  const inputs = [{ path: scopedLimitsPath, text: existing }];
  if (projectsPath !== null && projectsPath !== undefined) inputs.push({ path: projectsPath, text: pairText });
  const replaced = replaceFile({ path: scopedLimitsPath, text, inputs, expect, envName: "PI_SCOPED_LIMITS_FILE", fs });
  if (replaced.invalid) return replaced;
  return judged.pending ? { ok: true, pending: judged.pending } : { ok: true };
}

/** What `fileSnapshot` returns for a file that is there but cannot be read: a string no file's text can equal. */
const UNREADABLE = "\u0000unreadable:";

/**
 * A file's text, `null` when it does not exist (ENOENT, and only ENOENT), or `UNREADABLE` + the error code for any other
 * read failure (PR #569's review: an EACCES file read as missing let a write drop every project the admin could not
 * see). The value is also the file's identity for `replaceFile`'s re-check, so it compares as a string.
 */
function fileSnapshot(fs, path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    return `${UNREADABLE}${typeof e?.code === "string" ? e.code : "error"}`;
  }
}
function isUnreadable(snapshot) {
  return typeof snapshot === "string" && snapshot.startsWith(UNREADABLE);
}
function unreadableCode(snapshot) {
  return snapshot.slice(UNREADABLE.length);
}

/**
 * A refusal when the file at `path` is a SYMBOLIC LINK (PR #569's second review), else null. The admin writes only a
 * regular file. Writing through a link put the rename in the target's directory under the target's name, where the
 * worker's watcher (which watches the configured path's directory for its basename) never sees it, so a tool said
 * "applied live" while the worker kept the old caps; replacing the link instead left the shared copy stale. Refusing
 * is the one rule that cannot lie. `envName` is the variable an operator points at the real file.
 */
function symlinkRefusal(fs, path, envName) {
  if (typeof fs.lstatSync !== "function") return null;
  try {
    if (!fs.lstatSync(path).isSymbolicLink()) return null;
  } catch {
    return null; // missing (or unreadable: the read reports that)
  }
  return `${path} is a symbolic link, and the admin writes only a regular file; edit the file it points to, or point ${envName} at the real path. Nothing was written`;
}

/**
 * Replace the file at `path` with `text`, ATOMICALLY, for the two money-file writers (scoped limits and projects).
 *
 *   - A SYMLINK is refused (`symlinkRefusal`), never written through or replaced.
 *   - The tmp file has a name of its own (`<file>.<pid>.<random>.tmp`, created exclusively), so two writers never share
 *     one and one's rename can never take the other's half-written bytes. A failure to create it is an `{ invalid }`.
 *   - The file's MODE is kept (a 0600 file stays 0600; a new file is 0644), and so are its OWNER and GROUP (PR #569's
 *     second review): an admin running as another user than the worker would otherwise leave a file the worker cannot
 *     read, which it then refuses at its next boot. When the owner cannot be given back (the admin may not chown),
 *     nothing is written and the write says why.
 *   - RE-CHECKED right before the rename against `expect`, the files AS THEY WERE when the change was built (the read
 *     before the operator's confirm; `inputs`, this call's own read, when no earlier read was made). If any changed,
 *     nothing is written and the write says so. That covers the whole dialog: a second session's write while the
 *     confirm is open is a refusal, never a silent lost update.
 *
 * The residual, stated: a write that lands between the re-check and the rename (microseconds) is still lost or still
 * pairs badly with the other file. There is no lock across the two files. Returns `{ ok }` or `{ invalid }`.
 */
function replaceFile({ path, text, inputs, expect = null, envName, fs }) {
  const link = symlinkRefusal(fs, path, envName);
  if (link) return { invalid: link };
  let before = null;
  if (typeof fs.statSync === "function") {
    try {
      before = fs.statSync(path);
    } catch {
      // A new file: 0644, the mode these writers always gave it, owned by whoever writes it.
    }
  }
  const mode = before ? before.mode & 0o777 : 0o644;
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const drop = () => {
    try {
      fs.unlinkSync?.(tmp);
    } catch {
      // nothing to drop
    }
  };
  const code = (e) => (typeof e?.code === "string" ? e.code : "error");
  try {
    fs.writeFileSync(tmp, text, { mode, flag: "wx" });
  } catch (e) {
    drop();
    return { invalid: `${path} could not be written (${code(e)}: a new file beside it could not be created); nothing was written` };
  }
  try {
    // `mode` on create is masked by the umask; set it exactly.
    fs.chmodSync?.(tmp, mode);
  } catch {
    // best effort: the file was still created with the umask applied
  }
  if (before && typeof fs.chownSync === "function" && typeof fs.statSync === "function") {
    let now = null;
    try {
      now = fs.statSync(tmp);
    } catch {
      // judged below as a mismatch
    }
    if (!now || now.uid !== before.uid || now.gid !== before.gid) {
      try {
        fs.chownSync(tmp, before.uid, before.gid);
      } catch (e) {
        drop();
        return { invalid: `${path} is owned by uid ${before.uid} gid ${before.gid}, and the new file could not be given that owner (${code(e)}), so the worker might not read it; run this as that user. Nothing was written` };
      }
    }
  }
  for (const input of Array.isArray(expect) ? expect : inputs) {
    if (fileSnapshot(fs, input.path) !== input.text) {
      drop();
      return { invalid: `${input.path} changed after this change was built from it (another session wrote it); nothing was written. Look again and retry` };
    }
  }
  try {
    fs.renameSync(tmp, path);
  } catch (e) {
    drop();
    throw e;
  }
  return { ok: true };
}

/**
 * The files a write is judged against, as `{ path, text }` snapshots (PR #569's second review): a tool reads them
 * BEFORE its confirm and passes them back as `expect`, so the re-check before the rename covers the dialog.
 */
export function writeInputs({ paths, fs = nodeFs }) {
  return paths.filter((p) => p !== null && p !== undefined).map((p) => ({ path: p, text: fileSnapshot(fs, p) }));
}

/**
 * Judge a write's `project:<id>` rows against the projects file the worker reads (`projectsPath`, null when
 * PI_PROJECTS_FILE is unset: no projects, the worker's reading), issue #499 part B. Returns `{ refusal }` when a row the
 * write adds or changes names a missing project, or the file cannot be read or parsed while such a row is in play;
 * `{ pending }` when only an UNCHANGED row names a project the file on disk does not define; else `{}`.
 *
 * `pending` says only what the admin can know. The worker judges a limits edit against its LIVE projects too, and those
 * usually still define the id (the projects edit that dropped it was kept out), so the write is then live; the admin
 * cannot see the worker's live projects, so it neither claims that nor its opposite.
 */
function judgeProjectRows(before, after, projectsPath, fs) {
  const rows = after.filter((row) => isProjectScope(row.scope));
  if (rows.length === 0) return {};
  const unchanged = new Set(before.map((row) => JSON.stringify(row)));
  const touched = rows.filter((row) => !unchanged.has(JSON.stringify(row)));
  const waitFor = (list) => {
    const ids = [...new Set(list.map((row) => row.scope.slice("project:".length)))].join(", ");
    return `the worker applies this once its live projects define ${ids}; if they do not, it keeps its last good limits. Run pi-dispatch doctor`;
  };
  let projects = [];
  if (projectsPath !== null && projectsPath !== undefined) {
    let text;
    let why = null;
    try {
      text = fs.readFileSync(projectsPath, "utf8");
    } catch (e) {
      // Set but unreadable (missing included): the worker cannot load it either. Named as unreadable, never as a
      // missing project, so the operator fixes the file rather than adding a project that is already there.
      why = `the projects file ${projectsPath} could not be read (${typeof e?.code === "string" ? e.code : "error"})`;
    }
    if (why === null) {
      try {
        projects = parseProjects(text, projectsPath);
      } catch (e) {
        why = `the projects file does not load (${e?.message ?? String(e)})`;
      }
    }
    if (why !== null) return touched.length > 0 ? { refusal: `${why}, so a project row cannot be checked; fix it first. Nothing was written` } : { pending: `${why}; ${waitFor(rows)}` };
  }
  const missing = danglingProjectRows(rows, projects).map((d) => rows[d.index]);
  const where = projectsPath ? `the projects file ${projectsPath}` : "the projects file (PI_PROJECTS_FILE is unset, so there are no projects)";
  const added = missing.filter((row) => touched.includes(row)).map((row) => row.scope);
  if (added.length > 0) return { refusal: `${added.join(", ")} names a project that is not in ${where}; add the project there first. Nothing was written` };
  if (missing.length > 0) return { pending: `${missing.map((row) => row.scope).join(", ")} names a project that is not in ${where}; ${waitFor(missing)}` };
  return {};
}

/** Why a projects write cannot happen with PI_PROJECTS_FILE unset: the worker reads no projects file then. */
const PROJECTS_UNSET = "PI_PROJECTS_FILE is unset, so the worker reads no projects file and a project written here would decide nothing. Set it in the deployment's .env (pi-dispatch up does) and restart the worker. Nothing was written";

/**
 * Read + validate the projects file for display (issue #499 part C, INT-PROJECTS-FILE-CONTRACT), through the SHARED
 * `parseProjects`. `projectsPath` is the file the WORKER reads (`resolvePaths().projectsFile`): null when
 * PI_PROJECTS_FILE is unset, which reads `{ unset }` (the worker has no projects then, so the panel shows none rather
 * than a cwd file the worker never loads). `{ projects }`, or `{ missing }` / `{ invalid }` so the viewer degrades. A
 * `name` rides in the result for the panel to escape and isolate where it renders; it is never logged.
 */
export function readProjects({ projectsPath, fs = nodeFs }) {
  if (projectsPath === null || projectsPath === undefined) return { unset: true };
  // Only ENOENT is missing (PR #569's review): a file the admin cannot read is `{ unreadable: <code> }`, and the panel
  // says so rather than calling it missing.
  const text = fileSnapshot(fs, projectsPath);
  if (text === null) return { missing: true };
  if (isUnreadable(text)) return { unreadable: unreadableCode(text) };
  try {
    return { projects: parseProjects(text, projectsPath) };
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
}

/**
 * Plan a read-modify-write of the projects file without writing it (issue #499 part C): what `writeProjects` would
 * write, or why it refuses. The tools call it BEFORE their confirm, so an operator is never asked to approve a change
 * the write would refuse, and `writeProjects` calls it again after the confirm, so a file that changed in between is
 * judged as it is then.
 *
 * `mutate(projects)` receives copies of the parsed projects (`{ id, name, members }`) and returns the new list. The
 * existing file goes THROUGH the parser, so a file that does not load, or a newer `version`, refuses the write (this is
 * a money file: which project a scope is in decides which project row counts it). Only a MISSING file starts from no
 * projects. The result is re-validated by `parseProjects`, the worker's own loader.
 *
 * THE PAIR RULE (issue #499 part B), from the projects side. The worker keeps its last good projects when an edit would
 * leave a `project:<id>` row in scoped-limits.json naming a project that is gone (`pairWith`), so this refuses a write
 * that removes an id a row on disk names: delete or change the row first. An id the write does not remove is never
 * judged, so a row that ALREADY dangles cannot block an unrelated edit; such a write returns `pending`, in the words
 * `writeScopedLimits` uses, because the admin cannot see what the worker has live. When the scoped-limits file cannot
 * be read or parsed and the write removes an id, the row cannot be checked, so it is refused.
 *
 * Returns `{ text, projects, pending? }` or `{ invalid, blocker? }`. Optional typed blocker facts let a person page
 * name the actual bundle, row, floor or unread source without parsing or repeating the tool's diagnostic. No message
 * quotes a `name`.
 */
export function planProjectsWrite({ projectsPath, scopedLimitsPath = null, triggersPath = null, mutate, envelope = null, fs = nodeFs }) {
  if (projectsPath === null || projectsPath === undefined) return { invalid: PROJECTS_UNSET };
  const link = symlinkRefusal(fs, projectsPath, "PI_PROJECTS_FILE");
  if (link) return { invalid: link };
  let current = [];
  // Only a MISSING file starts from no projects (PR #569's review): an unreadable one read as missing let an add replace
  // every project with the one added.
  const existing = fileSnapshot(fs, projectsPath);
  if (isUnreadable(existing)) return { invalid: `the projects file ${projectsPath} could not be read (${unreadableCode(existing)}), so its projects cannot be kept; nothing was written` };
  if (existing !== null) {
    try {
      current = parseProjects(existing, projectsPath);
    } catch (e) {
      return { invalid: e?.message ?? String(e) };
    }
  }
  const next = mutate(current.map((p) => ({ ...p, members: [...p.members] })));
  // The stored shape: `name` only when there is one, the committed example's shape.
  const rows = next.map((p) => (p?.name === null || p?.name === undefined ? { id: p?.id, members: p?.members } : { id: p.id, name: p.name, members: p.members }));
  const text = `${JSON.stringify({ version: 1, projects: rows }, null, 2)}\n`;
  let written;
  try {
    written = parseProjects(text, projectsPath); // the loader's own validator -- never write a file it would refuse
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
  // Written in the STORED spelling the loader just produced (members resolved and qualified as `projectOf` matches
  // them, the name trimmed), so the file says what the worker will read rather than what was typed.
  const stored = written.map((p) => (p.name === null ? { id: p.id, members: p.members } : { id: p.id, name: p.name, members: p.members }));
  const finalText = `${JSON.stringify({ version: 1, projects: stored }, null, 2)}\n`;
  const kept = new Set(written.map((p) => p.id));
  const removed = current.map((p) => p.id).filter((id) => !kept.has(id));
  let limits = [];
  let raw = null;
  if (scopedLimitsPath !== null && scopedLimitsPath !== undefined) {
    // No scoped-limits file (ENOENT only): no row can name a project. A file that is there but cannot be read, or does
    // not parse, cannot rule a row out, so a write that removes an id refuses (PR #569's review).
    raw = fileSnapshot(fs, scopedLimitsPath);
    if (isUnreadable(raw)) {
      if (removed.length > 0) return { invalid: `the scoped-limits file ${scopedLimitsPath} could not be read (${unreadableCode(raw)}), so a row naming ${removed.join(", ")} cannot be ruled out; fix it first. Nothing was written`, blocker: { kind: "source", source: "scoped-limits" } };
    } else if (raw !== null) {
      try {
        limits = parseScopedLimits(raw, scopedLimitsPath);
      } catch (e) {
        if (removed.length > 0) return { invalid: `the scoped-limits file does not load (${e?.message ?? String(e)}), so a row naming ${removed.join(", ")} cannot be ruled out; fix it first. Nothing was written`, blocker: { kind: "source", source: "scoped-limits" } };
        limits = [];
      }
    }
  }
  // The files this plan was judged against, as read: `writeProjects` re-reads each right before its rename.
  const inputs = [{ path: projectsPath, text: existing }];
  if (scopedLimitsPath !== null && scopedLimitsPath !== undefined) inputs.push({ path: scopedLimitsPath, text: raw });
  // Issue #704: a project a secret bundle names keeps its membership. Which jobs hold a bundle is decided by which
  // project they are in, so a member added (or a project created under a bundled id) would hand those jobs the
  // project's whole environment, and the confirm-gated project tools are model-callable: a model must not widen a
  // secret grant by editing a list. The scoped-limits "names this project" rule's shape, judged on the triggers file
  // the worker reads, before the confirm and again by `writeProjects` after it.
  if (triggersPath !== null && triggersPath !== undefined) {
    const triggersText = fileSnapshot(fs, triggersPath);
    inputs.push({ path: triggersPath, text: triggersText });
    const touched = (ids) => {
      const before = new Map(current.map((p) => [p.id, [...p.members].sort().join("\n")]));
      const after = new Map(written.map((p) => [p.id, [...p.members].sort().join("\n")]));
      return ids.filter((id) => (before.get(id) ?? null) !== (after.get(id) ?? null));
    };
    if (isUnreadable(triggersText)) {
      const changed = touched([...new Set([...current, ...written].map((p) => p.id))]);
      if (changed.length > 0) return { invalid: `the triggers file ${triggersPath} could not be read (${unreadableCode(triggersText)}), so a secret bundle naming ${changed.join(", ")} cannot be ruled out; fix it first. Nothing was written`, blocker: { kind: "source", source: "triggers" } };
    } else if (triggersText !== null) {
      let bundles = null;
      try {
        bundles = parseTriggersDocument(triggersText, triggersPath).secretBundles;
      } catch {
        const changed = touched([...new Set([...current, ...written].map((p) => p.id))]);
        // Parser diagnostics can quote a rejected declaration, including its secret reference. Every project
        // surface shares this planner, so keep those diagnostics on the host's doctor, never in a page or tool.
        if (changed.length > 0) return { invalid: `the triggers file does not load, so a secret bundle naming ${changed.join(", ")} cannot be ruled out; run pi-dispatch doctor and fix the triggers file first. Nothing was written`, blocker: { kind: "source", source: "triggers" } };
      }
      if (bundles !== null) {
        const byProject = new Map(Object.entries(bundles).map(([id, b]) => [b.project, id]));
        const changed = touched([...byProject.keys()]);
        if (changed.length > 0) {
          const named = changed.map((p) => `secretBundles ${JSON.stringify(byProject.get(p))} (project ${p})`).join(", ");
          return { invalid: `${named} in ${triggersPath} names this project, and a change to its members would change which jobs hold that bundle's secrets; change the bundle in triggers.json first. Nothing was written`, blocker: { kind: "bundle", bindings: changed.map((project) => ({ project, bundle: byProject.get(project) })) } };
        }
      }
    }
  }
  // Issue #504 part C: a project removed or renamed that the allocation envelope floors would leave the envelope
  // invalid (`envelopeRefusal`), so it is refused here, before the confirm and again after it, naming the conflict.
  let envelopeBlocker = null;
  const broken = envelope ? envelopeRefusal({ envelopeFile: envelope.file, projectsPath, scopedLimitsPath, maxCostMicros: envelope.maxCostMicros, next: { projects: written }, fs, onRefusal: (facts) => { envelopeBlocker = facts; } }) : null;
  if (broken) return { invalid: broken, ...(envelopeBlocker ? { blocker: envelopeBlocker } : {}) };
  const dangling = danglingProjectRows(limits, written);
  const blocking = dangling.filter((d) => removed.includes(d.id));
  if (blocking.length > 0) {
    const rows = blocking.map((d) => `project:${d.id} (index ${d.index})`).join(", ");
    return { invalid: `${rows} in ${scopedLimitsPath} names this project, and the worker keeps its last good projects while a row names a missing one; delete or change that row first (dispatch_limit_delete or dispatch_limit_edit). Nothing was written`, blocker: { kind: "limits", rows: blocking.map((d) => ({ project: d.id, index: d.index })) } };
  }
  if (dangling.length > 0) {
    const ids = [...new Set(dangling.map((d) => d.id))].join(", ");
    return { text: finalText, projects: written, inputs, pending: `${dangling.map((d) => `project:${d.id}`).join(", ")} in ${scopedLimitsPath} names a project that is not in this file; the worker applies this once its live scoped limits no longer name ${ids}; if they do, it keeps its last good projects. Run pi-dispatch doctor` };
  }
  return { text: finalText, projects: written, inputs };
}

/**
 * Read-modify-write the projects file (issue #499 part C): `planProjectsWrite`, then `replaceFile` (a symlink refused,
 * a tmp file of its own, the mode and owner kept, both judged files re-checked before the rename against `expect`, the
 * tool's pre-confirm plan's `inputs`), so the worker's live-reload watcher never reads half a file. Reached only from
 * the confirm-gated `dispatch_project_*` tools. Returns `{ ok, pending? }` or `{ invalid }`.
 */
export function writeProjects({ projectsPath, scopedLimitsPath = null, triggersPath = null, mutate, expect = null, envelope = null, fs = nodeFs }) {
  const plan = planProjectsWrite({ projectsPath, scopedLimitsPath, triggersPath, mutate, envelope, fs });
  if (plan.invalid) return { invalid: plan.invalid };
  const replaced = replaceFile({ path: projectsPath, text: plan.text, inputs: plan.inputs, expect, envName: "PI_PROJECTS_FILE", fs });
  if (replaced.invalid) return replaced;
  return plan.pending ? { ok: true, pending: plan.pending } : { ok: true };
}

// ── the allocation envelope and the applied split (issue #504 part C) ───────────────────────────────────────────────
//
// The admin's half of delegated allocation (`REQ-DELEGATED-ALLOCATION`, `DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE`).
// Every rule is the WORKER's: the envelope goes through its `parseEnvelope`, a plan through its `applyPlan` (the ladder,
// the step, the compare-and-set, the audit row first), a revert through its `revert`. This module only finds the files
// and the Valkey, and never re-derives a number.

/** Why an envelope write cannot happen with PI_ENVELOPE_FILE unset: the worker reads no envelope then. */
const ENVELOPE_UNSET = "PI_ENVELOPE_FILE is unset, so the worker reads no envelope and delegation is off; set it in the deployment's .env (docs/allocation.md) and restart the worker. Nothing was written";

/** The Valkey keys of the applied split; `prefix` exists for the live tests alone, as in `makeAllocationState`. */
function allocKeys(prefix) {
  return prefix ? { plan: `${prefix}:plan`, log: `${prefix}:log`, expected: `${prefix}:envelope:expected` } : { plan: ALLOC_PLAN_KEY, log: ALLOC_LOG_KEY, expected: ALLOC_EXPECTED_KEY };
}

/**
 * The per-job cost cap the worker judges the envelope against (its `envelopeCap`): the settings overlay's `maxCostUsd`
 * over `PI_MAX_COST_USD`, in integer micro-dollars, or null. `overlay` overrides the file's, for a write being judged.
 */
export function envelopeJobCap({ settingsFile, env = {}, overlay = undefined, fs = nodeFs }) {
  const ov = overlay !== undefined ? overlay : readSettingsView({ settingsFile, fs })?.overlay;
  return deploymentDollarCaps(ov ?? {}, env).jobCapMicros;
}

/**
 * The projects and scoped limits an envelope is judged against, read the way the worker reads them: a file that is
 * missing, unreadable or invalid counts as empty (its own reader says why; the envelope parse then names the floor it
 * can no longer place).
 */
function envelopeContext({ projectsPath, scopedLimitsPath, fs }) {
  const parsed = (path, parse) => {
    if (path === null || path === undefined) return [];
    const text = fileSnapshot(fs, path);
    if (text === null || isUnreadable(text)) return [];
    try {
      return parse(text, path);
    } catch {
      return [];
    }
  };
  return { projects: parsed(projectsPath, parseProjects), limits: parsed(scopedLimitsPath, parseScopedLimits) };
}

/**
 * Read + validate the envelope file (INT-ENVELOPE-FILE-CONTRACT) through the worker's own `parseEnvelope`, judged
 * against the projects and scoped limits on disk and the merged per-job cap. `{ unset }` when PI_ENVELOPE_FILE is
 * unset (no delegation anywhere), `{ missing }`, `{ unreadable }`, `{ invalid }` (the parser's message, which names the
 * field and never a value), else `{ envelope, digest, projects }`.
 */
export function readEnvelope({ envelopeFile, projectsPath = null, scopedLimitsPath = null, maxCostMicros = null, fs = nodeFs }) {
  if (envelopeFile === null || envelopeFile === undefined) return { unset: true };
  const text = fileSnapshot(fs, envelopeFile);
  if (text === null) return { missing: true };
  if (isUnreadable(text)) return { unreadable: unreadableCode(text) };
  const ctx = envelopeContext({ projectsPath, scopedLimitsPath, fs });
  try {
    const envelope = parseEnvelope(text, envelopeFile, { ...ctx, maxCostMicros });
    return { envelope, digest: envelopeDigest(envelope), projects: ctx.projects };
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
}

/**
 * The admin writers' cross-check of the envelope (issue #504 part C): would `next` (`{ projects?, limits?,
 * maxCostMicros? }`, the parsed result of a projects, scoped-limits or per-job cap write) leave the LIVE envelope
 * invalid? A floored project removed, an id the floors name gone, a project row lowered below its floor, the per-job cap
 * removed: each makes the worker keep its last good envelope, doctor fail and the next start refuse. Returns the
 * refusal, naming the conflict in the parser's words, or null.
 *
 * Only a write that BREAKS a loading envelope is refused. With no envelope, or one that does not load from the files as
 * they are, null: that envelope is broken already, doctor names it, and refusing every unrelated edit would only keep
 * the operator from the edit that fixes it.
 */
export function envelopeRefusal({ envelopeFile, projectsPath = null, scopedLimitsPath = null, maxCostMicros = null, next = {}, fs = nodeFs, onRefusal = null }) {
  if (envelopeFile === null || envelopeFile === undefined) return null;
  const text = fileSnapshot(fs, envelopeFile);
  if (text === null || isUnreadable(text)) return null;
  const cur = envelopeContext({ projectsPath, scopedLimitsPath, fs });
  let loaded;
  try {
    loaded = parseEnvelope(text, envelopeFile, { ...cur, maxCostMicros });
  } catch {
    return null;
  }
  const after = {
    projects: next.projects ?? cur.projects,
    limits: next.limits ?? cur.limits,
    maxCostMicros: next.maxCostMicros !== undefined ? next.maxCostMicros : maxCostMicros,
  };
  try {
    parseEnvelope(text, envelopeFile, after);
    return null;
  } catch (e) {
    // The parser's message is for existing tool callers. A person page gets only verified semantic blockers.
    if (typeof onRefusal === "function" && Array.isArray(after.projects) && loaded?.floors && typeof loaded.floors === "object") {
      const kept = new Set(after.projects.map((p) => p.id));
      const projects = Object.keys(loaded.floors).filter((id) => !kept.has(id) && id !== "_other");
      if (projects.length) onRefusal({ kind: "envelope-floor", projects });
    }
    return `this change would leave the allocation envelope invalid (${e?.message ?? String(e)}), and the worker would keep its last good envelope and refuse to start on it; change the envelope first (dispatch_envelope_set) or in the same edit. Nothing was written`;
  }
}

/** A plain JSON object (not an array, not null). */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The envelope's raw keys a write may set, in the file's own order (INT-ENVELOPE-FILE-CONTRACT). */
const ENVELOPE_DELEGATION_FIELDS = Object.freeze(["enabled", "writers", "maxStepPct", "minIntervalHours", "maxPlanDays"]);

/**
 * `raw` (the envelope file's JSON) with `change` applied: `window` and `totalUsd` replace; `floorsUsd` and
 * `defaultWeights` merge per id (null removes the id); each delegation field replaces its own. Nothing else is touched,
 * so the file keeps every key and its order. The parser judges the result; this function judges nothing.
 */
function applyEnvelopeChange(raw, change) {
  const next = { ...raw };
  if (change.window !== undefined) next.window = change.window;
  if (change.totalUsd !== undefined) next.totalUsd = change.totalUsd;
  for (const field of ["floorsUsd", "defaultWeights"]) {
    if (change[field] === undefined) continue;
    const merged = isPlainObject(raw[field]) ? { ...raw[field] } : {};
    for (const [id, value] of Object.entries(change[field] ?? {})) {
      if (value === null) delete merged[id];
      else merged[id] = value;
    }
    next[field] = merged;
  }
  const delegation = isPlainObject(change.delegation) ? change.delegation : {};
  if (ENVELOPE_DELEGATION_FIELDS.some((f) => delegation[f] !== undefined)) {
    const merged = isPlainObject(raw.delegation) ? { ...raw.delegation } : {};
    for (const f of ENVELOPE_DELEGATION_FIELDS) if (delegation[f] !== undefined) merged[f] = delegation[f];
    next.delegation = merged;
  }
  return next;
}

/**
 * The lines a confirm shows for an envelope change: each normalized field that differs, before and after, in dollars
 * and plain numbers. Every value is the PARSER's (ids that matched the id charset, integers, micro-dollars), so no text
 * an editor typed reaches the dialog.
 */
export function envelopeChangeLines(before, after) {
  const usd = (m) => (Number.isSafeInteger(m) ? `$${formatMicros(m)}` : "-");
  const lines = [];
  const say = (label, a, b) => {
    if (a !== b) lines.push(`${label}: ${a} to ${b}`);
  };
  say("window", before?.window ?? "-", after.window);
  say("total", before ? usd(before.totalMicros) : "-", usd(after.totalMicros));
  const ids = [...new Set([...Object.keys(before?.floors ?? {}), ...Object.keys(after.floors)])].sort();
  for (const id of ids) say(`floor ${id}`, before?.floors?.[id] === undefined ? "-" : usd(before.floors[id]), after.floors[id] === undefined ? "-" : usd(after.floors[id]));
  for (const id of ids) say(`default weight ${id}`, String(before?.defaultWeights?.[id] ?? "-"), String(after.defaultWeights[id] ?? "-"));
  const d0 = before?.delegation ?? {};
  const d1 = after.delegation;
  say("delegation", d0.enabled === undefined ? "-" : d0.enabled ? "on" : "off", d1.enabled ? "on" : "off");
  say("writers", (d0.writers ?? []).join(", ") || "-", (d1.writers ?? []).join(", ") || "-");
  for (const f of ["maxStepPct", "minIntervalHours", "maxPlanDays"]) say(f, String(d0[f] ?? "-"), String(d1[f] ?? "-"));
  return lines;
}

/**
 * Plan an envelope write without writing (issue #504 part C, `dispatch_envelope_set`): the file's JSON with `change`
 * applied, judged by the worker's `parseEnvelope` against the projects and scoped limits on disk and `maxCostMicros`.
 * A missing file starts from `{ "version": 1 }`; a file that is there but does not parse as JSON, or is not an object,
 * refuses (a money file is never rebuilt from a guess). Returns `{ text, envelope, digest, before, beforeDigest, lines,
 * inputs }` or `{ invalid }`. `inputs` are the files as judged, for the re-check before the rename.
 */
export function planEnvelopeWrite({ envelopeFile, projectsPath = null, scopedLimitsPath = null, maxCostMicros = null, change = {}, fs = nodeFs }) {
  if (envelopeFile === null || envelopeFile === undefined) return { invalid: ENVELOPE_UNSET };
  const link = symlinkRefusal(fs, envelopeFile, "PI_ENVELOPE_FILE");
  if (link) return { invalid: link };
  const existing = fileSnapshot(fs, envelopeFile);
  if (isUnreadable(existing)) return { invalid: `the envelope file ${envelopeFile} could not be read (${unreadableCode(existing)}); nothing was written` };
  let raw = { version: ENVELOPE_VERSION };
  if (existing !== null) {
    try {
      raw = JSON.parse(existing);
    } catch {
      return { invalid: `the envelope file ${envelopeFile} is not valid JSON; fix it by hand first. Nothing was written` };
    }
    if (!isPlainObject(raw)) return { invalid: `the envelope file ${envelopeFile} is not a JSON object; fix it by hand first. Nothing was written` };
  }
  const ctx = envelopeContext({ projectsPath, scopedLimitsPath, fs });
  const text = `${JSON.stringify(applyEnvelopeChange(raw, change), null, 2)}\n`;
  let envelope;
  try {
    envelope = parseEnvelope(text, envelopeFile, { ...ctx, maxCostMicros });
  } catch (e) {
    return { invalid: `${e?.message ?? String(e)}. Nothing was written` };
  }
  let before = null;
  if (existing !== null) {
    try {
      before = parseEnvelope(existing, envelopeFile, { ...ctx, maxCostMicros });
    } catch {
      // A file that does not load now: the confirm shows every field as new.
    }
  }
  const inputs = [{ path: envelopeFile, text: existing }];
  for (const p of [projectsPath, scopedLimitsPath]) if (p !== null && p !== undefined) inputs.push({ path: p, text: fileSnapshot(fs, p) });
  const digest = envelopeDigest(envelope);
  return { text, envelope, digest, before, beforeDigest: before ? envelopeDigest(before) : null, lines: envelopeChangeLines(before, envelope), inputs };
}

/**
 * Write the envelope (issue #504 part C), after the operator's confirm. The order is the point:
 *
 *   1. plan again (the files as they are now);
 *   2. `alloc:envelope:expected` := the new digest, in Valkey, BEFORE the file. A host re-bases the fleet's split onto a
 *      changed envelope only when its digest equals that key (`reconcile`), so a file written first would be read by
 *      the hosts as a hand edit: `envelope-mismatch` and an `envelope-changed-externally` row on every host;
 *   3. the file, by `replaceFile` (tmp of its own, mode and owner kept, a symlink refused, the judged files re-checked
 *      against `expect`, the pre-confirm plan's inputs);
 *   4. if the file was not written, the key is put back as it was, so the hosts keep enforcing the old envelope as
 *      their own, by a compare-and-set (`RESTORE_EXPECTED_SCRIPT`): only while the key still holds this write's digest,
 *      so a second confirmed write that landed meanwhile keeps its own.
 *
 * A Valkey that cannot be reached refuses before the file is touched: an envelope the fleet would refuse is worse than
 * no change. Returns `{ ok, digest, previousDigest, unchanged? }` or `{ invalid }`.
 */
export async function writeEnvelope({ envelopeFile, projectsPath = null, scopedLimitsPath = null, maxCostMicros = null, change = {}, expect = null, url, redisFn = makeRedisClient, prefix = null, fs = nodeFs, afterExpected = null }) {
  const plan = planEnvelopeWrite({ envelopeFile, projectsPath, scopedLimitsPath, maxCostMicros, change, fs });
  if (plan.invalid) return plan;
  if (plan.digest === plan.beforeDigest) return { ok: true, unchanged: true, digest: plan.digest, previousDigest: plan.beforeDigest };
  const keys = allocKeys(prefix);
  const key = keys.expected;
  let redis;
  try {
    redis = await writeClient(url, redisFn);
  } catch (err) {
    return { invalid: `could not reach Valkey to record the new envelope's digest in ${key} (${boundedText(err?.message ?? String(err))}), so the file was not written: the fleet would read it as a hand edit and refuse its jobs` };
  }
  try {
    // SET with GET: the value this write REPLACED, read in the same step, so a rollback puts back what was there when
    // this writer took the key, never a value another writer has since replaced.
    let previous;
    try {
      previous = await redis.set(key, plan.digest, "GET");
    } catch (err) {
      // A SET that failed on the client side may still have been applied by the server (a timeout after the write).
      return { invalid: `could not record the new envelope's digest in ${key} (${boundedText(err?.message ?? String(err))}), so the file was not written; ${key} may already hold the new digest ${plan.digest}, in which case set it back to the envelope digest the hosts run (doctor prints it) by hand (docs/allocation.md)` };
    }
    await afterExpected?.(); // a test seam: the window between the key and the file, where a second writer can land
    let replaced;
    try {
      replaced = replaceFile({ path: envelopeFile, text: plan.text, inputs: plan.inputs, expect, envName: "PI_ENVELOPE_FILE", fs });
    } catch (e) {
      replaced = { invalid: `${envelopeFile} could not be replaced (${typeof e?.code === "string" ? e.code : "error"}); nothing was written` };
    }
    if (replaced.invalid) {
      // Put the key back ONLY while it still holds THIS write's digest (a compare-and-set): a second confirmed write
      // that set its own digest meanwhile, and wrote its file, must keep its key, or the fleet would refuse that file
      // as a hand edit. A key another writer moved is left as it is, and said.
      let restored;
      try {
        restored = Number(await redis.eval(RESTORE_EXPECTED_SCRIPT, 1, key, plan.digest, previous ?? ""));
      } catch (err) {
        return { invalid: `${replaced.invalid}; and ${key} could not be put back to ${previous ?? "absent"} (${boundedText(err?.message ?? String(err))}): it may hold ${plan.digest}, a digest no file has; set it by hand (docs/allocation.md)` };
      }
      return restored === 1 ? replaced : { invalid: `${replaced.invalid}; ${key} was not put back, because another write changed it meanwhile` };
    }
    return { ok: true, digest: plan.digest, previousDigest: plan.beforeDigest };
  } finally {
    try {
      redis?.disconnect();
    } catch {
      // already closed
    }
  }
}

/**
 * The rollback of `alloc:envelope:expected` (`writeEnvelope`): KEYS[1] the key, ARGV[1] the digest this writer set,
 * ARGV[2] what it held before (`""` for absent: a digest is never empty). Restores only while the key still holds
 * ARGV[1]; returns 1 when it did, else 0.
 */
export const RESTORE_EXPECTED_SCRIPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end
return 1`;

/**
 * A client for an allocation WRITE, connected before the first command: fail-fast (an unreachable Valkey refuses
 * rather than queueing the write behind reconnects) AND connected first, because a fail-fast client has no offline
 * queue, so a command sent before its socket is up fails with "Stream isn't writeable" (measured in the lab against a
 * live Valkey, where every write refused that way while the fake answered).
 */
async function writeClient(url, redisFn) {
  parseConnection(url, { failFast: true });
  const redis = redisFn(url, { failFast: true, lazyConnect: true });
  redis.on?.("error", () => {});
  if (typeof redis.connect === "function" && redis.status === "wait") await redis.connect();
  return redis;
}

/** The fields of an applied state a reader may see. An ALLOWLIST, so a field added later is not shown by accident. */
const STATE_FIELDS = Object.freeze(["planId", "basis", "writer", "jobId", "triggerId", "appliedAt", "lastPlanAt", "validUntil", "envelopeDigest", "weights", "repoWeights", "allocations", "unallocated", "repos", "clamped"]);
/** The fields of an `alloc:log` row a reader may see. `reasons` is not one: agent text never reaches a tool result. */
const LOG_FIELDS = Object.freeze(["at", "host", "writer", "jobId", "triggerId", "outcome", "reason", "field", "rule", "planId", "basis", "weights", "repoWeights", "before", "after", "clamped", "envelopeDigest"]);

function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (obj?.[f] !== undefined) out[f] = obj[f];
  return out;
}

/**
 * The applied split, its history and the spend, from Valkey (issue #504 part C). Reads only: GETs, one LRANGE, one
 * MGET. `{ state, stateProblem?, expected, log, spend? }` or `{ unreachable }`:
 *   - `state`: `alloc:plan` through the worker's `parseState`, shown through an allowlist of fields; null when absent
 *     (no host has looked yet), with `stateProblem` `newer` or `unreadable` when it is there but not this build's;
 *   - `reasons` (the plan's per-project reason text, agent-authored) ONLY with `withReasons`, which the panel alone
 *     passes, so it is drawn through the control-byte gate and never reaches a tool result or a message;
 *   - `expected`: `alloc:envelope:expected`, the digest the fleet re-bases onto;
 *   - `log`: the newest `limit` rows of `alloc:log`, newest first, through an allowlist (no `reasons`);
 *   - `spend` (with an `envelope`): the envelope window's counters, spent and held, under the worker's own keys:
 *     the deployment, each envelope entry (`project:<id>`, `_other` included) and each project member's repo ledger,
 *     with each key's NAME, so an operator can find it in `valkey-cli`.
 */
export async function readAllocations({ url, envelope = null, projects = [], now = new Date(), withReasons = false, limit = 20, redisFn = makeRedisClient, timeoutMs = 2500, prefix = null } = {}) {
  let redis;
  try {
    parseConnection(url, { failFast: true });
    redis = redisFn(url);
    redis.on?.("error", () => {});
    const keys = allocKeys(prefix);
    const work = (async () => {
      const [planText, expected, logRaw] = await Promise.all([redis.get(keys.plan), redis.get(keys.expected), redis.lrange(keys.log, 0, Math.max(0, limit - 1))]);
      const parsed = parseState(planText);
      const out = { state: null, expected: expected ?? null, log: [] };
      if (parsed?.newer) out.stateProblem = "newer";
      else if (parsed && parsed.corrupt !== undefined) out.stateProblem = "unreadable";
      else if (parsed) out.state = { ...pick(parsed, STATE_FIELDS), ...(withReasons ? { reasons: isPlainObject(parsed.reasons) ? { ...parsed.reasons } : {} } : {}) };
      for (const text of Array.isArray(logRaw) ? logRaw : []) {
        try {
          const row = JSON.parse(text);
          if (isPlainObject(row)) out.log.push(pick(row, LOG_FIELDS));
        } catch {
          // a row that does not decode is skipped; the audit file holds the record
        }
      }
      if (envelope) out.spend = await envelopeSpend(redis, envelope, projects, now);
      return out;
    })().catch((err) => ({ unreachable: err?.message ?? String(err) }));
    return await withTimeout(work, timeoutMs, { unreachable: "timed out reaching the queue" });
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // already closed
      }
    }
  }
}

/** The window key builder of an envelope window, the worker's own (budget.mjs). */
const WINDOW_KEY = Object.freeze({ day: dayKey, week: weekKey, month: monthKey });

/**
 * The envelope window's dollar counters (micro-dollars spent and held), under the keys the worker reserves in
 * (`governedDollars`): the deployment's, each entry's `project:<id>` ledger (a row's and the allocation's are one key)
 * and each member's repo ledger, by `scopeRef`. One MGET; an absent key is an honest 0.
 */
async function envelopeSpend(redis, envelope, projects, now) {
  const keyOf = WINDOW_KEY[envelope.window];
  const deployment = keyOf(now, DOLLAR_KEY_PREFIX);
  const entries = envelopeEntries(envelope);
  const projectKeys = Object.fromEntries(entries.map((id) => [id, keyOf(now, scopeDollarKeyPrefix(`project:${id}`))]));
  const repoKeys = {};
  for (const p of Array.isArray(projects) ? projects : []) {
    if (!entries.includes(p?.id) || p.id === OTHER) continue;
    repoKeys[p.id] = Object.fromEntries((Array.isArray(p.members) ? p.members : []).map((m) => [scopeRef(m), keyOf(now, scopeDollarKeyPrefix(m))]));
  }
  const all = [deployment, ...Object.values(projectKeys), ...Object.values(repoKeys).flatMap((r) => Object.values(r))];
  const values = await redis.mget(...all);
  const at = new Map(all.map((k, i) => [k, Number(values?.[i] ?? 0) || 0]));
  return {
    window: envelope.window,
    deployment: { key: deployment, micros: at.get(deployment) },
    projects: Object.fromEntries(Object.entries(projectKeys).map(([id, key]) => [id, { key, micros: at.get(key) }])),
    repos: Object.fromEntries(Object.entries(repoKeys).map(([id, refs]) => [id, Object.fromEntries(Object.entries(refs).map(([ref, key]) => [ref, { key, micros: at.get(key) }]))])),
  };
}

/** The micro-dollars of a state, for a result's before and after: amounts only, never a reason. */
function amountsShown(state) {
  return state ? { allocations: { ...(state.allocations ?? {}) }, unallocated: state.unallocated ?? 0, repos: state.repos ?? {} } : null;
}

/**
 * Apply a priorities plan as the operator's session (issue #504 part C, `dispatch_priorities_set` and `/dispatch
 * priorities set`): the worker's `applyPlan`, unchanged, with writer `operator-session`. `plan` is the plan WITHOUT its
 * basis (`{ projects, validUntil? }`): the basis is filled in here from the applied state this call reconciled to, so
 * a caller never has to read it first and a model cannot name a stale one. The audit row goes to this host's
 * `PI_LOGS_DIR/allocations/`, the file the worker's own rows use.
 *
 * Returns `{ outcome, reason, planId?, field?, rule?, clamped?, basis, kept?, before, after }`: the ladder's enum and the
 * micro-dollars before and after, never a reason text. Throws on infrastructure (Valkey, the audit file), as the
 * worker does: such a plan has not applied.
 */
export async function applyPriorities({ url, envelope, digest = envelopeDigest(envelope), projects = [], plan, keepOther = false, host, logsDir, now = new Date(), writer = { kind: "operator-session" }, redisFn = makeRedisClient, prefix = null, fs = nodeFs }) {
  const redis = await writeClient(url, redisFn);
  try {
    const state = makeAllocationState({ redis, host, audit: makeAllocationAudit({ logsDir, fs }), prefix });
    const seen = await state.reconcile({ envelope, digest, now });
    const basis = seen?.state?.planId ?? null;
    // `keepOther`: a plan that leaves `_other` out keeps its CURRENT weight (the applied state's, else the envelope's
    // default), so an operator typing `shop=3 platform=1` is not refused for the pseudo-project they did not think of.
    // Any other project left out is still `plan-incomplete`: which project to starve is a decision, `_other` a default.
    const given = Array.isArray(plan?.projects) ? plan.projects : [];
    const kept = keepOther && !given.some((p) => p?.id === OTHER) ? [{ id: OTHER, weight: seen?.state?.weights?.[OTHER] ?? envelope?.defaultWeights?.[OTHER] ?? 0 }] : [];
    const text = JSON.stringify({ version: PLAN_VERSION, basis, ...plan, projects: [...given, ...kept] });
    const result = await state.applyPlan({ envelope, digest, projects, text, writer, now });
    const after = parseState(await redis.get(allocKeys(prefix).plan));
    const afterState = after && after.corrupt === undefined && !after.newer ? after : null;
    return { ...result, basis, ...(kept.length > 0 ? { kept: [OTHER] } : {}), before: amountsShown(seen?.state ?? null), after: amountsShown(afterState) };
  } finally {
    try {
      redis.disconnect();
    } catch {
      // already closed
    }
  }
}

/**
 * The operator's revert to an `alloc:log` row (issue #504 part C, the panel's `r`): the worker's `revert`, writer
 * `operator-revert`, which skips the interval and the step rules but is still a compare-and-set and still refused while
 * delegation is off, the envelope differs or another apply holds the lock. Returns its `{ outcome, reason, planId? }`.
 */
export async function revertAllocation({ url, envelope, digest = envelopeDigest(envelope), target, host, logsDir, now = new Date(), redisFn = makeRedisClient, prefix = null, fs = nodeFs }) {
  const redis = await writeClient(url, redisFn);
  try {
    const state = makeAllocationState({ redis, host, audit: makeAllocationAudit({ logsDir, fs }), prefix });
    return await state.revert({ envelope, digest, target, now });
  } finally {
    try {
      redis.disconnect();
    } catch {
      // already closed
    }
  }
}

/**
 * The used counts behind each scoped limit row (issue #242): GET only the windows a row actually caps
 * (a concurrent-only row touches redis zero times -- in-flight is worker-process state this reader
 * cannot see), under the keys the worker's own builders compose from the shared `scopeKeyPrefix`, so
 * the two sides cannot drift on the key shape. `rows[i]` matches `limits[i]`; an absent key reads as an
 * honest 0 (a scope that never ran). One client, one timeout, `{ unreachable }` on a dead queue --
 * `readBudget`'s posture exactly.
 */
export async function readScopedBudget({ url, limits, redisFn = makeRedisClient, timeoutMs = 2500, now = new Date() } = {}) {
  if (!Array.isArray(limits) || limits.length === 0) return { rows: [] };
  let redis;
  try {
    parseConnection(url, { failFast: true }); // throws on junk before any client exists
    redis = redisFn(url);
    redis.on?.("error", () => {}); // a down Valkey is `{ unreachable }`, never ioredis stack traces (PR #550's review)
    const settled = Promise.all(
      limits.map(async (l) => {
        const cell = async (key) => Number((await redis.get(key)) ?? 0);
        const row = {};
        // A model row has no job-count windows (issue #502 part 6), and its scope is not a job's scope.
        if (!isModelScope(l.scope)) {
          const prefix = scopeKeyPrefix(l.scope);
          if (l.day !== null && l.day !== undefined) row.day = await cell(dayKey(now, prefix));
          if (l.week !== null && l.week !== undefined) row.week = await cell(weekKey(now, prefix));
          if (l.month !== null && l.month !== undefined) row.month = await cell(monthKey(now, prefix));
        }
        // The dollar windows (version 2), in integer micro-dollars held or settled so far, under the keys the worker
        // composes from the same shared export (`dollarKeyPrefixFor`). Only the windows the row caps.
        if (USD_LIMIT_FIELDS.some((f) => l[f] !== null && l[f] !== undefined)) {
          const prefix = dollarKeyPrefixFor(l);
          const usd = {};
          if (l.dayUsd !== null && l.dayUsd !== undefined) usd.day = await cell(dayKey(now, prefix));
          if (l.weekUsd !== null && l.weekUsd !== undefined) usd.week = await cell(weekKey(now, prefix));
          if (l.monthUsd !== null && l.monthUsd !== undefined) usd.month = await cell(monthKey(now, prefix));
          row.usdMicros = usd;
        }
        return row;
      }),
    ).then(
      (rows) => ({ rows }),
      (err) => ({ unreachable: err?.message ?? String(err) }),
    );
    return await withTimeout(settled, timeoutMs, { unreachable: "timed out reaching the queue" });
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // already closed
      }
    }
  }
}

/**
 * The dollar windows' counters (issue #501, part 7): ONE MGET of `keys`, the window keys `dollarWindowSpecs` composed
 * with the worker's own key functions. Returns `{ [key]: value }` (an absent key is absent from the map, an honest 0
 * to the caller), or `{ unreachable }`. A plain GET, never an INCR, so looking at a window cannot hold anything in it.
 * One client, one timeout, `readBudget`'s posture exactly.
 */
export async function readDollarCounters({ url, keys, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  if (!Array.isArray(keys) || keys.length === 0) return {};
  let redis;
  try {
    parseConnection(url, { failFast: true }); // throws on junk before any client exists
    redis = redisFn(url);
    // A down Valkey must degrade to `{ unreachable }`, not print ioredis' "Unhandled error event" stack on every
    // reconnect attempt (readFleetQueues' rule): dispatch_costs touched no Valkey at all before the dollar windows.
    redis.on?.("error", () => {});
    const settled = redis.mget(...keys).then(
      (values) => Object.fromEntries(keys.flatMap((k, i) => (values?.[i] === null || values?.[i] === undefined ? [] : [[k, Number(values[i])]]))),
      (err) => ({ unreachable: err?.message ?? String(err) }),
    );
    return await withTimeout(settled, timeoutMs, { unreachable: "timed out reaching the queue" });
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Every active dollar window as rows (`dollar-windows.mjs`): the deployment's caps from the overlay and `env` merged
 * the worker's way, then the scoped-limits file's dollar rows; each with its counter (spent and held, fleet-wide)
 * and the records' side (settled, basis counts, boundExceeded) from the run records this host can read since the
 * oldest window began. `{ windows, invalid?, limits? }`: `invalid` names a dollar setting that does not parse (shown,
 * never guessed), `limits` carries the scoped-limits file's own `{ missing }` or `{ invalid }`.
 */
export async function readDollarWindows({ paths, env = {}, now = new Date(), fs = nodeFs, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  const view = readSettingsView({ settingsFile: paths.settingsFile, fs });
  const { caps, jobCapMicros, invalid } = deploymentDollarCaps(view?.overlay ?? {}, env);
  const sl = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath, fs });
  const specs = dollarWindowSpecs({ caps, limits: Array.isArray(sl?.limits) ? sl.limits : [], now });
  const out = { windows: [] };
  if (invalid.length > 0) out.invalid = invalid;
  if (view?.invalid) out.settingsInvalid = true;
  if (!Array.isArray(sl?.limits) && sl?.invalid) out.limits = { invalid: sl.invalid };
  if (specs.length === 0) return out;
  const counters = await readDollarCounters({ url: paths.valkeyUrl, keys: specs.map((s) => s.key), redisFn, timeoutMs });
  const records = scanRunRecords({ logsDir: paths.logsDir, sinceMs: dollarWindowsSinceMs(specs, now), nowMs: now.getTime(), fs });
  out.windows = dollarWindowRows({ specs, counters, records: Array.isArray(records) ? records : [], jobCapMicros });
  if (counters?.unreachable) out.countersUnreachable = counters.unreachable;
  if (!Array.isArray(records)) out.recordsUnreachable = records?.unreachable ?? "unreadable";
  return out;
}

/**
 * How many index members this reader will hydrate in one pass. A ceiling rather than a full read, because
 * the index is the one structure here that can grow without an operator noticing; past it the caller is
 * told the listing is truncated rather than shown a number it cannot stand behind.
 */
const HELD_HYDRATE_MAX = 200;

/**
 * The jobs the worker is currently HOLDING on `run.waitFor` (issue #230).
 *
 * Read from the worker's own `wait:job:*` hashes rather than by enumerating the delayed set, and the
 * difference is the whole design. A delayed job's `.data` carries the issue title, body and username, so
 * hydrating one to build a panel row would pull PII into the snapshot that `fetchSnapshot` refuses to hold
 * -- its only precedent for touching a queue job reads ONE id off the active one, and says why. When this was
 * written it would also have needed a classifier, because the delayed set mixes cron next-occurrences, retry
 * backoff, quiet hours, scope deferrals and waits, and nothing in it recorded which. Since issue #737 the
 * worker records why it deferred a job (`defer:job:<id>`), and `readWaiting` lists the delayed set from its
 * ids, scores and those records, still without a job's data; this reader stays the held jobs' own. These
 * hashes carry exactly the fields the worker chose to publish: an id-only target and an operator-authored
 * condition label, both PII-free by construction, and only for jobs actually held on a wait.
 *
 * The worker's `wait:held` index, not a keyspace walk: SMEMBERS, then each member's hash, bounded by
 * `HELD_HYDRATE_MAX`. A set cannot expire its members, so this reader prunes a member whose hash is gone
 * (wait-state.mjs says why the index exists anyway); the caller is told when the index was longer than this
 * reader hydrates rather than shown a silently short list.
 */
/**
 * The capacity report for `dispatch_capacity` (issue #599, phase 2, INT-CAPACITY-REPORT): the CLI's read and the CLI's
 * function (`readCapacityRecords`, `computeCapacity`, `onlyHost`, `capacityText`), so the tool, `pi-dispatch capacity`
 * and doctor cannot disagree. READ-ONLY: the registry is read with `prune: false` and the mirror reader prunes nothing.
 * `{ report, text }`, or `{ error }` for a window it does not offer, a host the report does not have, or a retention the
 * worker would refuse. An unreachable Valkey is not an error: the report reads this host's files and says why.
 */
export async function readCapacity({ url, env = process.env, window = "7d", host, now = () => Date.now(), redisFn = makeRedisClient, timeoutMs = 2000, fs, span } = {}) {
  // `span` is the insights page's own window (issue #599, phase 4): `{ sinceMs(nowMs), bucketMs }`, a start that may be a
  // calendar instant (`mtd`, the start of the month) and a bucket its chart reads well at. `window` is then only the
  // label the text says it in. The numbers are the same function's over the same records either way.
  const w = span ? null : Object.hasOwn(CAPACITY_WINDOWS, window) ? CAPACITY_WINDOWS[window] : null;
  if (!span && !w) return { error: `window must be one of ${Object.keys(CAPACITY_WINDOWS).join(", ")} (got ${JSON.stringify(window)})` };
  const facts = await deploymentFacts(env);
  if (facts.problem) return { error: facts.problem };
  const nowMs = now();
  const sinceMs = span ? span.sinceMs(nowMs) : nowMs - w.ms;
  const bucketMs = span ? span.bucketMs : w.bucketMs;
  if (!Number.isSafeInteger(sinceMs) || sinceMs >= nowMs || !Number.isSafeInteger(bucketMs) || bucketMs <= 0) return { error: "the window must start before now, with a positive bucket" };
  let redis = null;
  let noMirrorReason = null;
  try {
    parseConnection(url, { failFast: true }); // throws on junk before any client exists
    redis = redisFn(url);
    redis.on?.("error", () => {});
  } catch (err) {
    redis = null;
    noMirrorReason = `the Valkey URL is not usable (${err?.message ?? "error"}): only this host's files were read`;
  }
  try {
    const [fleet, read] = await Promise.all([
      redis ? readLiveHosts(redis, { now, timeoutMs, prune: false }).catch((e) => ({ unreachable: e?.message ?? "registry unreadable" })) : { unreachable: null },
      readCapacityRecords({ redis, logsDir: facts.logsDir, sinceMs, nowMs, retentionDays: facts.retentionDays, localHost: facts.localHost, noMirrorReason, timeoutMs, ...(fs ? { fs } : {}) }),
    ]);
    const coverage = { ...read.coverage, reason: [read.coverage.reason, fleet.unreachable ? `host registry unreadable (${fleet.unreachable})` : null].filter(Boolean).join("; ") || null };
    const report = computeCapacity({ records: read.records, live: fleet.hosts ?? [], windowStartMs: sinceMs, nowMs, bucketMs, coverage });
    const shown = host === undefined || host === null ? { report } : onlyHost(report, host);
    if (shown.unknown) return { error: `no host named ${JSON.stringify(host)} in the last ${window}${shown.unknown.length > 0 ? ` (hosts: ${shown.unknown.join(", ")})` : ""}` };
    return { report: shown.report, text: capacityText(shown.report, { since: window }) };
  } finally {
    try {
      redis?.disconnect?.();
    } catch {
      // best-effort teardown
    }
  }
}

/**
 * The fleet (issue #57): every live worker's own row, newest heartbeat first, pruned as it is read.
 *
 * A sibling of `readHeldJobs` rather than a leg of `readQueueState`: its own client, its own timeout, and
 * one responsibility. It reuses the WORKER's `readLiveHosts` rather than reimplementing the walk, so the
 * panel and the worker can never disagree about which hosts are live or about when a row is stale --
 * the `scopeKeyPrefix` doctrine of one export and N consumers.
 *
 * `{ unreachable }` and an empty list stay distinguishable all the way to the renderer. "There are no
 * other hosts" and "I could not find out" are different facts, and a panel that shows the second as the
 * first tells an operator their fleet is gone when Valkey merely blinked.
 */
export async function readHosts({ url, redisFn = makeRedisClient, timeoutMs = 2500, now = () => Date.now() } = {}) {
  let redis;
  try {
    parseConnection(url, { failFast: true }); // throws on junk before any client exists
    redis = redisFn(url);
    // `timeoutMs` goes INWARD as well as around. Without it the inner per-operation bound stayed at its
    // 2000ms default while the outer 2500ms had to cover a sequential `1 + N` round-trip walk, so past a
    // handful of hosts on a slow Valkey the outer timer always won -- and the caller degraded to the
    // shared queue alone for no reason but fleet size. Halved inward so N operations fit inside one outer
    // budget rather than one operation consuming it.
    const res = await withTimeout(readLiveHosts(redis, { now, timeoutMs: Math.max(250, Math.floor(timeoutMs / 2)) }), timeoutMs, { unreachable: "timed out reaching the registry" });
    if (res.unreachable) return { unreachable: res.unreachable };
    return { hosts: res.hosts };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (redis) redis.disconnect?.();
  }
}

/**
 * How many workers this deployment has, and what they are called.
 *
 * TWO SOURCES, and the precedence is the point. The registry is authoritative because it is ordinary
 * keys; `getWorkers()` rests on CLIENT SETNAME, which BullMQ's own doc-comment says some providers do not
 * support -- which is exactly what `readWorkerCount`'s `"unknown"` fallback has always been papering
 * over. So a registry that answers wins, `getWorkers()` is the fallback for a fleet that has not been
 * named yet, and `"unknown"` survives only when neither can say.
 *
 * Pure, so the panel, the plain renderer and the MCP tool cannot drift on it.
 */
export function resolveWorkerCount({ hosts, workerCount }) {
  if (Array.isArray(hosts) && hosts.length > 0) {
    // NAMES ONLY WHERE A NAME WAS DECLARED. Every worker publishes a registry row, named or not, so a
    // plain one-worker deployment has a row too -- and returning its hostname here made the status line
    // read `workers: 1 (my-mac)` where it has always read `workers: 1`, breaking #57's own acceptance line
    // for no gain. Declaring is the right discriminator rather than counting hosts: an operator who named
    // two minis and has one up wants to be told WHICH one, and that is exactly the case a `length > 1`
    // rule would go quiet for.
    const declared = hosts.filter((h) => h?.routes === true || h?.routes === "true");
    const names = declared.map((h) => h.name).filter(Boolean).sort();
    return { count: hosts.length, names };
  }
  if (typeof workerCount === "number" && workerCount > 0) return { count: workerCount, names: [] };
  return { count: "unknown", names: [] };
}

export async function readHeldJobs({ url, limit = 20, redisFn = makeRedisClient, timeoutMs = 2500, now = () => Date.now() } = {}) {
  let redis;
  try {
    parseConnection(url, { failFast: true }); // throws on junk before any client exists
    redis = redisFn(url);
    const settled = (async () => {
      // SMEMBERS of the worker's index, not a SCAN. A scan of `wait:job:*` walks the whole keyspace, and
      // walks ALL of it precisely when nothing is held, which is the deployment least willing to pay for it.
      const ids = await redis.smembers(HELD_SET);
      const hydrated = await Promise.all(
        ids.slice(0, HELD_HYDRATE_MAX).map(async (jobId) => {
          try {
            const h = await redis.hgetall(jobKey(jobId));
            // A member with no hash is STALE: the hash expired or the hold was released without the index
            // being updated. The reader prunes it, which is what makes an index safe here at all -- a set
            // cannot expire its own members, so the alternative is a set that only grows.
            if (!h || !h.since) {
              await redis.srem(HELD_SET, jobId).catch(() => {});
              return null;
            }
            const since = Number(h.since);
            return {
              jobId,
              target: h.target || null,
              label: h.label || null,
              waitedMs: Number.isFinite(since) && since > 0 ? Math.max(0, now() - since) : null,
              checks: Number(h.checks) || 0,
            };
          } catch {
            // One unreadable member degrades one row, never the listing (a stray key of the wrong type).
            return null;
          }
        }),
      );
      const rows = hydrated.filter(Boolean);
      // Sorted BEFORE the cut, so the row an operator is looking for -- the one that has been stuck longest
      // -- is in the listing. Slicing first would have shown an arbitrary sample and called it the top.
      rows.sort((a, b) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1));
      return {
        rows: rows.slice(0, limit),
        more: Math.max(0, rows.length - limit),
        // True when the index itself was longer than this reader will hydrate: `more` is then a floor, and
        // a caller that renders a total must say so rather than state a number it cannot know.
        truncated: ids.length > HELD_HYDRATE_MAX,
      };
    })();
    return await withTimeout(settled, timeoutMs, { unreachable: "timed out reaching the queue" });
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Cancel a job that is waiting on a `run.waitFor` condition (issue #230).
 *
 * One of the two doors that stop a held job (the CLI's `pi-dispatch cancel` is the other, issue #287), and
 * it needs to exist because every other lever misses: a held job spends nothing while it waits, so no budget cap will
 * ever refuse it; deleting the trigger does not reach a job already enqueued, since `job.data.trigger` is a
 * frozen snapshot; and the queue's own retention prunes completed and failed jobs, never delayed ones.
 *
 * Refuses a job that is not HELD, checked against the worker's own `wait:job:` hash rather than against the
 * queue. Removing an arbitrary delayed job would reach cron next-occurrences and retry backoff too, and a
 * tool whose blast radius is "anything in the delayed set" is not the tool this description promises. The console's
 * `cancel-queued` (issue #737, `planCancelQueued`) is the tool that reaches the rest, and only by its own rules: a job
 * that never started and is not its scheduler's next run, judged at the preview and again at the confirm.
 *
 * Writes no run record: `INT-RUN-HISTORY-FILE-CONTRACT` records terminal states of runs, and a held job is in none
 * (one held again on a retry keeps the records its earlier attempts wrote; the result's `attemptsMade` says so, #477). The hold's own keys go with it, so the panel stops showing a row for a job that no longer exists.
 *
 * Returns `{ ok: true, jobId, attemptsMade }`, `{ invalid }` (refused, or failed before anything was asked: nothing was
 * changed), or `{ invalid, partial: true }` once the removal was asked for and did not finish (issue #737): the bound
 * fired after that, or the job's removal failed after its hold was cleared (`heldClearedAnswer`, from its state read
 * again). Answers within `timeoutMs` whatever Valkey does: its clients' release is started, never awaited. An error's
 * own words (`removeHeldJob`'s refusal can be a client's error, or a parse of the job's data) reach the answer only
 * through `boundedText`: this answer is a page's, the audit's and the model's.
 */
export async function cancelHeldJob({ url, jobId, redisFn = makeRedisClient, queueFn = makeQueue, timeoutMs = 2500, touchStore = undefined, touchOutbox = null, now = Date.now, interventionOrigin = "human" } = {}) {
  if (typeof jobId !== "string" || jobId === "") return { invalid: "a job id is required" };
  let redis;
  const queues = [];
  // Whether the removal has been asked for (issue #737): from then on a timeout may have cut it part-way, so the answer
  // says so and is `partial`, never "timed out reaching the queue", which reads as nothing changed. Asked for, not sent:
  // `removeHeldJob` reads the hold and the job's state before its first delete, and the bound can fire there too.
  let asked = false;
  // The clients' release, STARTED and never awaited: BullMQ's close QUITs its connection and waits for the answer, which
  // a Valkey that stopped answering on an open socket never sends, and this answer is owed within `timeoutMs`. Each call
  // closes the queues opened since the last, so a lookup still in flight when the bound fired is closed when it settles.
  const release = () => {
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
    for (const queue of queues.splice(0)) {
      try {
        // A bullmq Queue has BOTH `disconnect` and `close`; `close` is the one that releases its blocking
        // connections, so it is named explicitly rather than reached through a `??` that short-circuits.
        Promise.resolve(queue?.close?.()).catch(() => {});
      } catch {
        // already closed
      }
    }
  };
  let settled = null;
  try {
    parseConnection(url, { failFast: true });
    redis = redisFn(url);
    // EVERY fleet queue (issue #642), as `pi-dispatch cancel` searches them (cancel-cli.mjs): a held job lives on the queue
    // it was enqueued onto, and a named host's cron, chained children and routed forge jobs live on `pi-jobs@<name>`.
    // Looking only in the shared queue refused every held job on a host queue as "no longer in the queue", for a job
    // the panel was showing. The first queue that knows the id owns it (ids are unique across queues by construction);
    // when none does, the shared queue answers, so the refusal keeps its words.
    settled = (async () => {
      // Half the budget for the discovery, so the queue reads and the removal still fit inside the outer bound.
      const { names } = await readFleetQueues({ url, redisFn, timeoutMs: Math.max(250, Math.floor(timeoutMs / 2)) });
      let owner = null;
      for (const name of names) {
        const q = queueFn(parseConnection(url, { failFast: true }), { name });
        queues.push(q);
        if (owner === null && (await q.getJob(jobId))) owner = q;
        if (owner !== null) break;
      }
      const queue = owner ?? queues[0];
      // The sequence itself (hash-with-a-clock check, state check, hold keys before the job) lives in the
      // worker's cancel-state.mjs since issue #287 gave it a second caller: one body, imported rather than
      // re-implemented, which is this module's own rule for everything it shares with the worker.
      asked = true;
      const res = await removeHeldJob({ redis, queue, jobId, touchStore, touchOutbox, now, interventionOrigin });
      if (res?.ok) return res;
      if (res?.cleared !== true) return heldRefused(jobId, res?.invalid);
      // The hold is gone and the job stayed (issue #737): never "nothing was changed", and never the error's own words.
      // Its state read again says whether a worker took it.
      const state = await Promise.resolve()
        .then(() => queue.getJobState(jobId))
        .catch(() => "unknown");
      return heldClearedAnswer(jobId, state);
    })();
    const got = await withTimeout(settled, timeoutMs, CANCEL_HELD_TIMED_OUT);
    if (got !== CANCEL_HELD_TIMED_OUT) return got;
    return asked ? heldRemovalUnanswered(jobId) : { invalid: "timed out reaching the queue" };
  } catch (err) {
    return { invalid: boundedText(err?.message ?? String(err)) };
  } finally {
    release();
    settled?.then(release, release);
  }
}

/** `cancelHeldJob`'s bound firing, told apart from any answer the sequence can give. */
const CANCEL_HELD_TIMED_OUT = Object.freeze({ timedOut: true });

/**
 * Read + validate the operator-declared subscriptions file (DES-SUBSCRIPTIONS-ARE-COUNTERFACTUAL-ONLY).
 * Returns `{ version, subscriptions }` of normalized entries, or `{ missing }` / `{ invalid }` so the
 * viewer degrades rather than throwing — the `{ invalid }` case includes a file written by a newer
 * pi-dispatch, whose fail-loud message names both versions. Uses the SHARED `parseSubscriptions`, so the
 * admin and the worker's exported validator cannot drift on the schema. The admin is the ONLY reader:
 * the worker never opens this file at job time, because the prices here change no runtime behavior —
 * they price what already happened.
 */
export function readSubscriptions({ subscriptionsPath, fs = nodeFs }) {
  if (subscriptionsPath === null || subscriptionsPath === undefined) return { missing: true };
  let text;
  try {
    text = fs.readFileSync(subscriptionsPath, "utf8");
  } catch {
    return { missing: true };
  }
  try {
    return parseSubscriptions(text, subscriptionsPath);
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
}

/**
 * Read-modify-write the subscriptions file (mirrors `writePauseWindows`): `mutate(subscriptions)` receives
 * a copy of the current normalized entry array and returns the new array; the result is re-serialized to
 * the versioned file shape, VALIDATED through the SHARED `parseSubscriptions` (fail-closed — a rejected
 * result is NEVER written), and written ATOMICALLY (tmp + rename). A missing or unparseable existing file
 * starts from the empty v1 shape, so a validated write REPAIRS it. Returns `{ ok }` or `{ invalid }`.
 */
export function writeSubscriptions({ subscriptionsPath, mutate, fs = nodeFs }) {
  let current = [];
  try {
    current = parseSubscriptions(fs.readFileSync(subscriptionsPath, "utf8"), subscriptionsPath).subscriptions;
  } catch {
    // Missing/invalid file: start from the empty v1 shape; the validated atomic write below repairs it.
  }
  const next = mutate(current.map((s) => ({ ...s })));
  const text = `${JSON.stringify({ version: SUBSCRIPTIONS_VERSION, subscriptions: next }, null, 2)}\n`;
  try {
    parseSubscriptions(text, subscriptionsPath); // the loaders' own validator -- never write a file they would reject
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
  const tmp = `${subscriptionsPath}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, subscriptionsPath);
  return { ok: true };
}

async function readWorkerCount(queue) {
  try {
    const list = await queue.getWorkers();
    return Array.isArray(list) && list.length > 0 ? list.length : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Read the resident job schedulers and compute per-entry `overdueMs`: BullMQ's no-overlap scheduler can
 * silently under-fire under load, so the admin surfaces `next` drift rather than let it look healthy
 * (design.md:249). Returns an array, or `{ unreachable }` on a connection error.
 */
export async function readSchedulers({
  url,
  makeQueueFn = makeQueue,
  parseConnectionFn = parseConnection,
  redisFn = makeRedisClient,
  timeoutMs = 2500,
  now = Date.now,
} = {}) {
  const opened = [];
  try {
    // ACROSS EVERY QUEUE (issue #57). A named host installs its own schedulers on `pi-jobs@<name>`, so a
    // read of the shared queue alone would show ZERO schedulers while cron was running -- a panel that
    // contradicts a working deployment is worse than one that says nothing.
    const fleet = await readHosts({ url, redisFn, timeoutMs });
    const queues = fleetQueueNames(fleet.hosts).map((name) => makeQueueFn(parseConnectionFn(url, { failFast: true }), { name }));
    opened.push(...queues);
    // The SHARED queue's failure is a real connection failure and must surface as `{ unreachable }`;
    // an additional HOST queue's is caught, because one unreadable host must degrade to its own rows
    // missing rather than to a panel that says the whole deployment is unreachable.
    // EVERY wait bounded (issue #599, phase 4's review): BullMQ's scheduler list rides a second connection of its own,
    // and against a Valkey that nothing answers it neither resolves nor rejects, so `/dispatch insights` (which reads
    // the schedulers for its topology) never finished. Past `timeoutMs` the shared queue reads as unreachable, a host
    // queue as empty, and the queues are closed under the same bound.
    const UNANSWERED = Symbol("unanswered");
    // The queue's own client is awaited FIRST: BullMQ builds the scheduler inside an async Promise executor that awaits
    // that client, so a client that fails there is an unhandled rejection no caller can catch; awaited here, it is this
    // read's own catchable failure, and the scheduler is never built.
    const bounded = (q) => withTimeout(Promise.resolve().then(async () => {
      await q.client;
      return q.getJobSchedulers(0, -1, true);
    }), timeoutMs, UNANSWERED);
    const [primary, ...rest] = queues;
    const first = await bounded(primary);
    if (first === UNANSWERED) return { unreachable: "timed out reading the job schedulers" };
    const others = await Promise.all(rest.map((q) => bounded(q).then((l) => (l === UNANSWERED ? [] : l), () => [])));
    return mapSchedulers([first, ...others].flat(), now());
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    await withTimeout(Promise.all(opened.map((q) => Promise.resolve().then(() => q.close()).catch(() => {}))), timeoutMs, null);
  }
}

/**
 * The longest scheduler id or name the snapshot carries (`mapSchedulers`): the triggers loader's longest cron id
 * (`CRON_ID_MAX`), so every id the loader takes is one this read keeps, and a scheduler the worker upserts is never
 * read as one with no id.
 */
export const SCHEDULER_NAME_MAX = CRON_ID_MAX;
const SCHEDULER_NAME_RE = new RegExp(`^[A-Za-z0-9._-]{1,${SCHEDULER_NAME_MAX}}$`);

/**
 * A scheduler's id (`key`) or job name as the snapshot carries it: the triggers loader's cron id charset
 * (`[A-Za-z0-9._-]`, its `ID_CHARSET`) at most `SCHEDULER_NAME_MAX` characters, else null. BOUNDED WHERE IT IS READ,
 * because nothing writes a scheduler only through the worker: anything holding the Valkey's URL can add one, and every
 * surface prints the id in running text (the overview's Scheduled line, the Fleet's Schedules table, the TUI, the
 * status tool), so a planted 3,000-character id widened the overview to 23,512 px. Bounding each surface instead would
 * be one rule per printer, and the next printer would forget it. Null, never a cut: a cut id would name a scheduler
 * that does not exist, and could match a trigger that is not its own. A refused value keeps its entry (its pattern, its
 * next fire and its overdue time still say a schedule is there), and each surface draws it as it draws a scheduler
 * BullMQ answered without that field.
 */
const schedulerNameOf = (v) => (typeof v === "string" && SCHEDULER_NAME_RE.test(v) ? v : null);

/**
 * Map raw BullMQ job-scheduler entries to the PII-free display shape, computing per-entry `overdueMs`
 * against `nowMs`. Pure, so the live dashboard can map the entries it reads off its own held queue
 * without re-opening a connection per tick. A non-array input maps to an empty list. `key` is the scheduler's id (the
 * cron trigger's `on.id`), `name` the job name it mints its runs with (the worker's is `local` for every one), each
 * through `schedulerNameOf`. The key is BullMQ's `key` alone (issue #737): an entry with none has no key, never its
 * name standing in, since every surface names and matches a scheduler by its key.
 */
export function mapSchedulers(list, nowMs) {
  return (Array.isArray(list) ? list : []).map((s) => {
    const next = typeof s?.next === "number" ? s.next : null;
    return {
      key: schedulerNameOf(s?.key),
      name: schedulerNameOf(s?.name),
      pattern: s?.pattern ?? null,
      every: s?.every ?? null,
      next,
      overdueMs: next !== null && next < nowMs ? nowMs - next : null,
    };
  });
}

/**
 * Read the reserved counts for all three spend windows, plus the daily token counter, with plain,
 * side-effect-free GETs of the worker's own `dayKey()` / `weekKey()` / `monthKey()` / `tokenDayKey()` --
 * NEVER an INCR/EXPIRE, so observing the budget cannot consume a slot or a token. Returns
 * `{ day, week, month, tokensToday }` (the caps live in the settings overlay, resolved by the
 * renderer). `makeRedisClient` has no failFast option and would otherwise buffer the GETs forever while
 * disconnected, so the read is bounded by a timeout that degrades to `{ unreachable }` -- and a junk URL
 * degrades SYNCHRONOUSLY through the same parse `readSchedulers` fails fast on, because burning the full
 * timeout on an unparseable URL is how a canned "not-a-url" test fixture turns into 2.5 wasted seconds
 * per invocation. The client is force-disconnected in `finally`.
 */
export async function readBudget({ url, redisFn = makeRedisClient, timeoutMs = 2500, now = new Date() } = {}) {
  let redis;
  try {
    parseConnection(url, { failFast: true }); // throws on junk before any client exists
    redis = redisFn(url);
    const settled = Promise.all([redis.get(dayKey(now)), redis.get(weekKey(now)), redis.get(monthKey(now)), redis.get(tokenDayKey(now))]).then(
      ([day, week, month, tokens]) => ({ day: Number(day ?? 0), week: Number(week ?? 0), month: Number(month ?? 0), tokensToday: Number(tokens ?? 0) }),
      (err) => ({ unreachable: err?.message ?? String(err) }),
    );
    return await withTimeout(settled, timeoutMs, { unreachable: "timed out reaching the queue" });
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // already closed
      }
    }
  }
}

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * List the most recent run records: parse every `*.json`, drop unparseable or mid-read-deleted entries
 * (the boot reaper may unlink between scan and read), sort by `endedAt` descending with nulls last, and
 * cap the count to 1..50. A missing logs dir is a normal empty history `[]`; any other readdir error is
 * `{ unreachable }`.
 */
/**
 * `listRuns` for a fleet, ON A CLIENT THE CALLER OWNS: this host's files, merged with every other host's
 * mirrored records (issue #57, Gap 3). Never disconnects what it was handed.
 *
 * A SIBLING rather than a replacement, and `listRuns` stays byte-identical, because the local read is the
 * truth and the single-host path. On a shared `PI_LOGS_DIR` the local read is ALSO already the merged read,
 * and `mergeRuns(local, [])` is the identity function -- one reader, two sources, one of them empty. That
 * is why no second code path is needed for the shared-storage shape.
 *
 * `hosts` is computed from the RECORDS' own `host` field rather than from where each row came from, so the
 * host count is right on both shapes with no extra work.
 *
 * Degradation is a discriminated channel and never a silence: `"off"` (no index, which is what both a
 * single-host deployment and a fleet still below the version floor look like), `"ok"`, `"truncated"`, or
 * `"unreachable (...)"`. `"off"` and `"unreachable"` must not collapse -- a new panel meeting old workers
 * has to read "off", not "error".
 *
 * `prune` (default true) is handed to `readMirroredRuns`: false makes this read write nothing (the fleet reader's
 * `readOnly`, issue #641), at the cost of an expired id staying in the index until a pruning reader passes.
 */
export async function mergedRunsOn(redis, { logsDir, limit = 10, fs = nodeFs, timeoutMs = 2500, prune = true } = {}) {
  const local = listRuns({ logsDir, limit, fs });
  // A local read that FAILED is passed straight through. The mirror is a view of OTHER hosts' work; it
  // cannot stand in for this host's own history, and reporting a partial list as if it were whole is the
  // silent no-op this project refuses.
  if (!Array.isArray(local)) return { runs: [], hosts: [], mirror: "off", ...local };
  try {
    // Asked for MORE than the display cap, because the merge dedups and the two sources overlap on every
    // run this host both wrote and mirrored: cutting each source at the cap first would let a duplicate
    // pair squeeze a real run off the end.
    const { runs: mirrored, degraded } = await readMirroredRuns(redis, { limit: Math.max(limit * 2, 50), timeoutMs, prune });
    const runs = mergeRuns(local, mirrored, { limit });
    return { runs, hosts: hostsIn(runs), mirror: degraded };
  } catch (err) {
    return { runs: local, hosts: hostsIn(local), mirror: `unreachable (${err?.message ?? "?"})` };
  }
}

/**
 * The one-shot wrapper: opens a client, reads, closes it.
 *
 * Split from the core deliberately, and it is not stylistic. The panel holds its clients for the life of
 * the overlay, so a reader that disconnected the client it was handed would tear down the whole dashboard's
 * Valkey connection on its first tick. `readBudget` makes the same split for the same reason; this one
 * improves on the `readHeldJobs` precedent, whose connection-first shape forced `dashboard.ts` to keep an
 * inline copy that a source-text parity test then had to police.
 */
export async function listRunsMerged({ logsDir, limit = 10, url, fs = nodeFs, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  let redis;
  try {
    redis = redisFn(url);
    redis.on?.("error", () => {}); // one clean line on a down Valkey, never ioredis stack traces
    return await mergedRunsOn(redis, { logsDir, limit, fs, timeoutMs });
  } catch (err) {
    const local = listRuns({ logsDir, limit, fs });
    const runs = Array.isArray(local) ? local : [];
    return { runs, hosts: hostsIn(runs), mirror: `unreachable (${err?.message ?? "?"})` };
  } finally {
    try {
      redis?.disconnect?.();
    } catch {
      // best-effort teardown
    }
  }
}

export function listRuns({ logsDir, limit = 10, fs = nodeFs }) {
  const cap = clampLimit(limit);
  let names;
  try {
    names = fs.readdirSync(logsDir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    return { unreachable: `logs dir unreadable (${err?.code ?? "read-error"})` };
  }

  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readJsonFile(join(logsDir, name), fs);
    if (record && typeof record === "object") records.push(record);
  }
  records.sort(byEndedAtDesc);
  return records.slice(0, cap);
}

// scanRunRecords' hard cap on how far back a fold may reach. The scan exists for the cost fold, and the
// one deployment that needs the cap most is the one that turned retention OFF (PI_LOG_RETENTION_DAYS=0,
// keep forever): without it, the scan's work grows without bound exactly where the reaper was disabled
// deliberately. 92 days ~= a quarter -- more than any spend view needs, small enough to stay a file walk.
const SCAN_WINDOW_MAX_DAYS = 92;

/**
 * Scan run records for the cost fold: every `*.json` whose `endedAt` (or `startedAt`, for a record that
 * never ended) falls at or after `sinceMs`. The `listRuns` sibling WITHOUT the 1..50 display clamp --
 * and, like `makeFindPreviousRun` (worker/src/run-history.mjs), explicitly NOT a query surface: a
 * bounded, filename-keyed, read-only walk over the flat sidecar files, upholding
 * DES-RUN-HISTORY-FLAT-FILES-NO-DB's no-database stance (the fold happens in memory at read time;
 * nothing here indexes, caches, or writes). `sinceMs` is clamped to at most SCAN_WINDOW_MAX_DAYS before
 * `nowMs`, so even a keep-forever deployment folds at most a quarter. Records come back in directory
 * order -- bucketing and sorting are the fold's business, not the scan's. A missing logs dir is a normal
 * empty history `[]`; any other readdir error is `{ unreachable }`; an unparseable or mid-read-deleted
 * entry (the boot reaper may unlink between scan and read) is skipped, exactly as in `listRuns`.
 */
export function scanRunRecords({ logsDir, sinceMs, nowMs = Date.now(), fs = nodeFs }) {
  const oldestMs = nowMs - SCAN_WINDOW_MAX_DAYS * 24 * 60 * 60 * 1000;
  const cutoffMs = Math.max(Number.isFinite(sinceMs) ? sinceMs : oldestMs, oldestMs);
  let names;
  try {
    names = fs.readdirSync(logsDir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    return { unreachable: `logs dir unreadable (${err?.code ?? "read-error"})` };
  }

  const records = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const record = readJsonFile(join(logsDir, name), fs);
    if (!record || typeof record !== "object") continue;
    const at = Date.parse(record.endedAt ?? record.startedAt ?? "");
    if (!Number.isFinite(at) || at < cutoffMs) continue; // no usable timestamp, or outside the window
    records.push(record);
  }
  return records;
}

/**
 * The size suggestions of the given projects (issue #596, phase 3, DES-SIZE-SUGGESTIONS), for the PROJECTS view, the
 * `dispatch_limit_edit` preview and the insights page: per project id, the worker's own `suggestSize` over this host's
 * run records, with the exact call that applies it (`suggestionCall`) and its evidence in words. The records are read
 * ONCE for every project, by the worker's own bounded reader (`readSizingRecords`: an mtime prefilter, a 256 KiB cap
 * per file, the newest 50 measured runs per project), the one doctor uses. `limits` are the parsed scoped-limits rows
 * (a project's size and its row index come from them), `env` the deployment's settings (`PI_JOB_MEMORY`, `PI_JOB_CPUS`).
 *
 * `hostBudgets` are the live hosts' published budgets (`hostBudgetsOf`), and each project's raise is capped over them,
 * every host judged on its OWN pair (`suggestSize`'s `hosts`), each budget at the project's `hostShare` of it where its
 * row has one; a call is offered exactly when admission would accept the suggested pair (`sizeRefusal`, the rule doctor
 * uses: withheld only when every live host that published an integer budget refuses it, `refusal` then says how);
 * `hostBudgets` is null when no budget was read here (the edit preview), so a raise offers no call. Returns `{ projects: { [id]: suggestion }, skipped }`, or `{ unreachable }` when the logs
 * directory is unreadable. With `withSeries`, each also carries `series`, the same runs' peaks oldest first
 * (`peakSeries`), for the insights chart. A project whose size the worker would refuse is left out. Nothing here
 * applies anything.
 */
export function readSizeSuggestions({ logsDir, projectIds = [], limits = [], env = {}, hostBudgets = null, nowMs, withSeries = false, fs = nodeFs }) {
  const read = readSizingRecords(logsDir, { nowMs, fs });
  if (read.unreachable) return { unreachable: read.unreachable };
  const records = read.records;
  const projects = {};
  for (const id of projectIds) {
    let current;
    try {
      current = resolveJobSize({ project: id, limits, env });
    } catch {
      continue;
    }
    // the project's hostShare caps each host's budget at its share (a job above it is refused there), as doctor's does
    const share = projectBudgetRow(limits, id).hostShare;
    const s = suggestSize({ project: id, records, current, hosts: Array.isArray(hostBudgets) ? hostBudgets : null, hostShare: share, now: nowMs });
    // THE ONE RULE doctor uses too (`sizeRefusal`): the call is withheld exactly when every live host that published an
    // integer budget would refuse the suggested pair for ever; with no such host, admission refuses nothing, so it is offered.
    const call = suggestionCall(s, limits);
    const refusal = call === null ? null : sizeRefusal({ memMiB: s.memory.suggested ?? current.memMiB, cpuCenti: s.cpu.suggested ?? current.cpuCenti }, hostBudgets, share);
    projects[id] = { ...s, call: refusal === null ? call : null, refusal, words: { ...suggestionEvidence(s), refusal: refusalWords(refusal, s, share) }, ...(withSeries ? { series: peakSeries({ project: id, records, now: nowMs }) } : {}) };
  }
  return { projects, skipped: read.skipped };
}

/**
 * The live hosts' budgets, each host's own pair (`{ memMiB, cpuCenti }`, an integer, Infinity for off, or null), from
 * registry rows (`readLiveHosts`). Kept per host: a suggestion is judged against each host's pair (`fleetCap`), never
 * against the largest per dimension across hosts, which is a pair no host has.
 */
export function hostBudgetsOf(hosts) {
  return (Array.isArray(hosts) ? hosts : []).map((h) => publishedBudget(h));
}

/** Read one run record by (raw) job id via its sanitized filename, or `null` when absent/unreadable. */
export function readRun({ logsDir, jobId, fs = nodeFs }) {
  return readJsonFile(join(logsDir, `${sanitizeJobId(jobId)}.json`), fs);
}

/**
 * Read the tail of a job's raw `.log`. Returns `{ lines }`, `{ missing: true }` when capture is off or the
 * file is absent, or `{ missing: true, elsewhere: <host> }` when the run happened on another machine.
 * An ENOENT is the normal "no captured log" case and never throws. The caller shows these lines ONLY in the
 * overlay viewer; they are never rendered into or sent to model context.
 *
 * THE RAW LOG DOES NOT TRAVEL; THE POINTER DOES (issue #57, Gap 3). It is the one artifact here holding
 * issue text, comment text and tool output, so it stays on the machine that wrote it. But a foreign run
 * falling into a bare `{missing: true}` is a lie by omission -- it renders as "no captured log" while the
 * bytes sit on the other host. The fix needs no new I/O and no change to this read: the answer is on the
 * RECORD, which the caller already holds, so `host` is passed in rather than looked up.
 */
export function readLogTail({ logsDir, jobId, lines = 200, fs = nodeFs, host = null, self = null }) {
  let text;
  try {
    text = fs.readFileSync(join(logsDir, `${sanitizeJobId(jobId)}.log`), "utf8");
  } catch {
    const foreign = typeof host === "string" && host !== "" && typeof self === "string" && self !== "" && host !== self;
    return foreign ? { missing: true, elsewhere: host } : { missing: true };
  }
  // The runner newline-DELIMITS its events (issue #224): each line is written `\n{...}\n`, so the raw
  // .log carries a blank line before every runner event plus the trailing-newline segment. Drop every
  // empty segment, not just the last, so the delimiters do not consume slots in the overlay viewport.
  const all = text.split("\n").filter((line) => line !== "");
  const cap = clampLines(lines);
  return { lines: all.slice(Math.max(0, all.length - cap)) };
}

/**
 * A settings view (`readSettingsView`) without the operator-only overlay keys (`OPERATOR_ONLY_KEYS`: `secretProfiles`,
 * `secretBundles`), for what a MODEL-CALLABLE tool returns (issue #704 review). They map names to resolver paths the
 * worker executes; no tool can set them, and a model needs none of them to reason about a setting.
 */
export function withoutOperatorOnly(view) {
  if (!view?.overlay || typeof view.overlay !== "object") return view;
  const overlay = Object.fromEntries(Object.entries(view.overlay).filter(([k]) => !OPERATOR_ONLY_KEYS.includes(k)));
  return { ...view, overlay };
}

/** Read the settings overlay via the worker's own validator. Returns `{ path, overlay }` or `{ path, invalid }`. */
export function readSettingsView({ settingsFile, fs = nodeFs }) {
  const result = readOverlay(settingsFile, { fs });
  if (result.invalid) return { path: settingsFile, invalid: result.invalid };
  return { path: settingsFile, overlay: result.overlay };
}

/**
 * Read the unified committed `triggers.json` for display (OQ-008). Unlike the worker/receiver fail-loud
 * `parseTriggers` (boot semantics), a viewer degrades: an absent file is `{ missing: true }`, JSON or
 * shape errors are `{ invalid }`, and each entry normalizes into `{ triggers: [ { type, ... } ] }`
 * discriminated on `on.type` (cron | label | comment | pull_request | issue). Missing selectors default to `[]`
 * and non-string members are dropped; an entry that is not a usable `{ on, run }` object is skipped, not
 * fatal.
 *
 * Custom: fail-soft display normalizer, not the shared fail-loud `parseTriggers`; a viewer degrades and
 * shows what it can rather than throwing on one bad entry.
 */
export function readTriggers({ triggersPath, fs = nodeFs }) {
  let text;
  try {
    text = fs.readFileSync(triggersPath, "utf8");
  } catch {
    return { missing: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { invalid: "triggers file is not valid JSON" };
  }
  const entries = parsed?.triggers;
  if (!Array.isArray(entries)) {
    return { invalid: 'triggers file must have a "triggers" array' };
  }
  const triggers = [];
  entries.forEach((entry, index) => {
    const display = normalizeTriggerForDisplay(entry);
    // The RAW array position rides every display record (issue #54). It is the identity the receiver's
    // matched.index and the record's persisted triggerIndex both count -- cron entries AND unusable
    // entries included -- so it must be the file's position, not this filtered array's: a dropped entry
    // above row i would otherwise shift every attribution below it onto the wrong trigger.
    if (display) triggers.push({ ...display, index });
  });
  // `count` is the RAW entries length, for the same reason `index` is raw: the attribution range
  // guard must accept an index that points at an unusable-but-present row (triggers.length would
  // reject it and miscount the run as stale).
  // The project secret bundles (issue #704), read as leniently as the entries: a key only when the file has the block,
  // so every other read is key-identical to before. Never a bundle's `ref` (`normalizeSecretBundlesForDisplay`).
  const bundles = normalizeSecretBundlesForDisplay(parsed?.secretBundles);
  return { triggers, count: entries.length, ...(bundles !== null && { secretBundles: bundles }) };
}

/** File locations for either role: only the final folder, with the account's home replaced before projection. */
export function configLocationsOf({ paths = {}, deploymentDir = null, home = homedir() } = {}) {
  const absolute = (p) => typeof p === "string" && p !== "" ? resolvePath(deploymentDir ?? ".", p) : null;
  const describe = (p) => {
    const full = absolute(p);
    if (full === null) return null;
    const parts = full.replace(/\\/g, "/").split("/").filter(Boolean);
    const normalizedHome = resolvePath(home).replace(/\\/g, "/");
    if (full.replace(/\\/g, "/") === `${normalizedHome}/.pi-dispatch/settings.json`) return "~/.pi-dispatch/settings.json";
    if (parts.slice(0, -1).join("/") === normalizedHome.replace(/^\//, "")) return `~/${parts.at(-1)}`;
    return `.../${parts.slice(-2).join("/")}`;
  };
  const settings = absolute(paths.settingsFile);
  const deployment = deploymentDir === null ? null : resolvePath(deploymentDir);
  return {
    settings: describe(paths.settingsFile), triggers: describe(paths.triggersPath),
    settingsOutsideDeployment: settings === null || deployment === null ? null : settings !== deployment && !settings.startsWith(`${deployment}${sep}`),
  };
}

/** Editor hints are advisory reads, never authorization, and carry no secret values or prompt text. */
export function readTriggerEditor({ paths, env = {}, folder = null, deploymentDir = null, platform = process.platform, uid = process.geteuid?.(), fs = nodeFs, folderSkillsFn = readFolderSkills, overlaySkillsFn = readOverlaySkills, stagedSkillsFn = readStagedSkillsList } = {}) {
  const settings = readSettingsView({ settingsFile: paths.settingsFile, fs });
  const overlay = settings.overlay ?? {};
  // These are display facts only. In particular, this never resolves PI_BACKENDS or paid-start grants from .env.
  // Credentials are read only to decide endpoint presence and are projected to forge names before leaving here.
  const metadata = deploymentDir === null ? null : deploymentServiceEnv({ env, dir: deploymentDir, keys: ["WEBHOOK_SECRET", "GITLAB_WEBHOOK_SECRET", "FORGEJO_WEBHOOK_SECRET", "AZURE_WEBHOOK_SECRET", "PI_MODEL", "PI_PROVIDER", "PI_MAX_TURNS", "PI_RUN_PROGRESS", "PI_JOB_IMAGE", "PI_ALLOWED_MODELS", "PI_MAX_COST_USD"], platform, fs, uid });
  const hints = metadata?.env ?? env;
  let backends = [];
  let venueProblem = null;
  try { backends = parseBackendList(env.PI_BACKENDS).map((name) => ({ name, serves: servesOf(name) })); } catch { venueProblem = "The deployment's blessed venues do not load."; }
  const has = (k) => typeof hints[k] === "string" && hints[k].trim() !== "";
  const forges = [
    ...(has("WEBHOOK_SECRET") ? ["github"] : []),
    ...(has("GITLAB_WEBHOOK_SECRET") ? ["gitlab"] : []),
    ...(has("FORGEJO_WEBHOOK_SECRET") ? ["forgejo"] : []),
    ...(has("AZURE_WEBHOOK_SECRET") ? ["azure"] : []),
  ];
  // Existing cron repositories are the only repository trees the admin knows locally. Forge repositories are not
  // cloned for a suggestion. Bound these advisory git reads, and disclose a cut alongside an unread tier.
  const configured = readTriggers({ triggersPath: paths.triggersPath, fs }).triggers ?? [];
  const folders = [...new Set([folder, ...configured.filter((t) => t.type === "cron").map((t) => t.folder)].filter((f) => typeof f === "string" && f !== ""))];
  const repositories = folders.slice(0, 16).map((folder) => folderSkillsFn({ folder }));
  const tiers = [
    { tier: "repository", skills: repositories.flatMap((r) => r.skills ?? []), unreachable: repositories.some((r) => r.unreachable) || folders.length === 0, truncated: folders.length > 16 || repositories.some((r) => r.truncated) },
    { tier: "overlay", ...overlaySkillsFn({ globalPiDir: paths.globalPiDir, fs }) },
    { tier: "packages", ...stagedSkillsFn({ globalPiDir: paths.globalPiDir, fs }) },
  ];
  let provider = null;
  let model = null;
  let image = null;
  let models = null;
  try { provider = overlay.provider ?? providerFrom(hints); model = overlay.model ?? modelFrom(hints); image = jobImageFrom(hints); models = allowedModelsFrom(hints); } catch {}
  return {
    defaults: { flow: "required by the trigger", kind: "selected by the trigger kind", folder: "required for cron", task: "required for cron", repository: "forge routing", backend: backends[0]?.name ?? null, provider, model, image, models: models ?? "unrestricted", maxCostUsd: overlay.maxCostUsd ?? hints.PI_MAX_COST_USD ?? "no per-job dollar cap", packages: true, github: false, replicas: 1, resume: false, awaitInput: false, secrets: "none", secretsProfile: "none", secretBundle: "project default", waitFor: "none", skillsDir: "none", instructions: "none", command: "none", portfolio: false, fallbackModels: "none", excludeTools: "none", mcp: "none unless named by the trigger", gates: "none", gateTimeout: "no trigger expiry override", gateBudgetRaiseUsd: "none", maxTurns: overlay.maxTurns ?? parseNonNegInt(hints.PI_MAX_TURNS, 30), progress: false, statusComment: false, recover: false, steer: false },
    ...readTriggerEgress({ deploymentDir, env, fs }),
    backends, venueProblem, forges, settingsProblem: settings.invalid ?? null, progressAvailable: hints.PI_RUN_PROGRESS !== "0", forgeProblem: metadata && (metadata.unreadable || metadata.untrusted || metadata.hazardSkipped.length || metadata.unread.length) ? "The deployment metadata could not be read completely; configured webhook endpoints may be missing." : null,
    flows: tiers.flatMap((t) => (t.skills ?? []).filter((s) => !s.isSub).map((s) => ({ name: s.name, tier: t.tier }))),
    flowProblems: tiers.filter((t) => t.unreachable || t.truncated).map((t) => ({ tier: t.tier, unavailable: Boolean(t.unreachable), truncated: Boolean(t.truncated) })),
  };
}

/**
 * Read at most 200 in-line jobs through the worker's exact skew checker. Only ids and the missing field leave this
 * function; job data can contain forge text. A short queue read is a floor, never evidence that no other job is skewed.
 */
export async function readTriggerSkew({ index, waiting, triggersPath, lookupJob, fs = nodeFs, timeoutMs = 2500 } = {}) {
  if (!Array.isArray(waiting?.rows) || typeof lookupJob !== "function") return { rows: [], incomplete: true };
  try {
    if (!Array.isArray(JSON.parse(fs.readFileSync(triggersPath, "utf8"))?.triggers)) return { rows: [], incomplete: true };
  } catch { return { rows: [], incomplete: true }; }
  const check = makeCheckWaitSkew({ triggersPath, fs });
  let incomplete = Boolean(waiting.truncated || waiting.queuesCut || waiting.unreachable || waiting.rows.length > 200);
  const rows = [];
  const queued = [];
  await Promise.all(waiting.rows.slice(0, 200).map(async (row) => {
    try {
      const job = await withTimeout(Promise.resolve(lookupJob(row.queue, row.jobId)), timeoutMs, null);
      if (!job?.data) { incomplete = true; return; }
      if (job.data.trigger?.matched?.index !== index) return;
      queued.push(Object.fromEntries(["jobId", "queue", "state", "bucket", "why", "dueAt", "queuedAt", "project", "host", "holder"].filter((k) => Object.hasOwn(row, k)).map((k) => [k, row[k]])));
      const result = await check(job.data);
      if (result.skewed) rows.push({ jobId: row.jobId, queue: row.queue, ...(result.field ? { field: result.field } : {}), ...(result.conditions ? { conditions: result.conditions } : {}) });
    } catch { incomplete = true; }
  }));
  rows.sort((a, b) => a.jobId.localeCompare(b.jobId));
  queued.sort((a, b) => a.jobId.localeCompare(b.jobId));
  return { rows, queued, incomplete };
}

/** Cron stall counts beside the prompt-free tool display. An unread counter is null, never a fabricated zero. */
export async function readTriggersWithStalls({ triggersPath, url, fs = nodeFs, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  const view = readTriggers({ triggersPath, fs });
  const cron = view.triggers?.filter((t) => t.type === "cron" && typeof t.id === "string" && t.id !== "") ?? [];
  if (cron.length === 0) return view;
  let redis;
  let values = null;
  try {
    redis = redisFn(url);
    redis.on?.("error", () => {});
    values = await withTimeout(redis.mget(...cron.map((t) => stallKey(t.id))), timeoutMs, null);
  } catch {} finally { redis?.disconnect?.(); }
  const counts = new Map(cron.map((t, i) => [t.index, Array.isArray(values) ? decimalOf(values[i] ?? "0") : null]));
  return { ...view, triggers: view.triggers.map((t) => t.type === "cron" ? { ...t, stalls: counts.get(t.index) ?? null } : t) };
}

/**
 * A trigger's bounded history, using the same raw-index/type guard as attribution and the same cost classifier as
 * Spend. Prompt maps deliberately stay outside this object. Missing queue/record reads remain unknown.
 */
export function triggerDetailOf(snapshot, index, { now = snapshot?.readAt, subscriptions = [], pricing } = {}) {
  const trigger = snapshot?.triggers?.triggers?.find((t) => t.index === index);
  if (!trigger) return null;
  const value = trigger.type === "cron" ? trigger.id : String(index);
  const matches = (r) => triggerValueOf(r) === value && (trigger.type === "cron" || r.triggerType === trigger.type);
  const history = snapshot.recordDetails instanceof Map ? [...snapshot.recordDetails.values()] : snapshot.runs ?? [];
  const runs = history.filter((r) => matches(r) && runAt(r) <= now).sort((a, b) => runAt(b) - runAt(a));
  const runs24h = runs.filter((r) => runAt(r) >= now - DAY_MS && runAt(r) <= now);
  const measured = runs24h.map((r) => meteredRunMicros(r, { subscriptions, ...(pricing ? { pricing } : {}) }));
  const queued = snapshot.waiting?.unreachable || !snapshot.waiting ? null : (snapshot.waiting.rows ?? []).filter((r) => String(r.trigger ?? triggerValueOf(r)) === value);
  const scheduler = snapshot.schedulers?.find((s) => s.key === trigger.id) ?? null;
  const stalls = snapshot.schedulerStalls?.[trigger.id] ?? null;
  const backend = trigger.backend ?? snapshot.defaultBackend ?? null;
  return {
    trigger, index, runs24h, count24h: runs24h.length,
    cost24h: measured.reduce((sum, n) => sum + (n ?? 0), 0) / 1_000_000,
    cost24hMicros: measured.reduce((sum, n) => sum + (n ?? 0), 0),
    costIncomplete: measured.some((n) => n === null),
    historyIncomplete: Boolean(snapshot.parkedUnreachable || snapshot.failures24hFloor),
    lastRuns: runs.slice(0, 5), queued: trigger.type === "cron" ? queued : snapshot.triggerSkew?.[index]?.queued ?? queued,
    skewed: snapshot.triggerSkew?.[index]?.rows ?? null,
    skewIncomplete: snapshot.triggerSkew?.[index]?.incomplete ?? true,
    cron: trigger.type === "cron" ? { scheduler, next: scheduler?.next ?? null, overdueMs: scheduler?.overdueMs ?? null, stalls, stallLimit: (snapshot.schedulerStallMax ?? 2) + 1 } : null,
    sandbox: { backend, deploymentDefault: trigger.backend == null, serves: servesOf(backend), retentionHours: snapshot.sandboxRetentionHours ?? 24, replicas: trigger.once ? 1 : trigger.replicas ?? 1 },
  };
}

/** The most bundles, and the most endpoint names per bundle, the display keeps: the worker's own caps are smaller. */
const BUNDLES_SHOWN_MAX = 256;
const BUNDLE_ENDPOINTS_SHOWN_MAX = 64;

/**
 * The triggers file's top-level `secretBundles` for DISPLAY (issue #704): `[{ id, project, profile, forkReviews,
 * endpoints: [{ name, host }] }]` sorted by id, or null when the file has no such object. LENIENT like
 * `normalizeTriggerForDisplay`, never the worker's strict `validateSecretBundles`: a viewer shows what it can, and a
 * malformed block is the loaders' to refuse (doctor names why). A field of the wrong type reads as null, an entry that
 * is not an object is skipped. NEVER the `ref`: a bundle's reference is the address of the operator's environment in
 * their manager, the class `run.secrets`' references are kept out of every display for, and a field this function does
 * not copy cannot reach the model-callable `dispatch_triggers` read or a panel. The endpoint names and hosts are
 * operator text from the reviewed file, shown so the operator sees which variables a venue holds as placeholders.
 * Every string here is the file's own, unescaped: each surface escapes it where it renders, as for every trigger field.
 */
export function normalizeSecretBundlesForDisplay(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const str = (v) => (typeof v === "string" && v !== "" ? v : null);
  const out = [];
  for (const id of Object.keys(value).slice(0, BUNDLES_SHOWN_MAX)) {
    const b = value[id];
    if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
    const ends = b.endpoints !== null && typeof b.endpoints === "object" && !Array.isArray(b.endpoints) ? b.endpoints : {};
    const endpoints = Object.keys(ends)
      .slice(0, BUNDLE_ENDPOINTS_SHOWN_MAX)
      .map((name) => ({ name, host: str(ends[name]?.host) }))
      .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    out.push({ id, project: str(b.project), profile: str(b.profile), forkReviews: b.forkReviews === true, endpoints });
  }
  return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * The panel's TRIGGER_DETAIL read (issue #482): the same display view `readTriggers` returns, plus each
 * entry's `run.instructions` TEXT keyed by its raw file index.
 *
 * A SEPARATE function and a SEPARATE key, never a field on the display record, and that is the whole
 * design. `readTriggers`' records are what the model-callable `dispatch_triggers` tool returns verbatim,
 * which is why `normalizeTriggerForDisplay` carries `instructions` as a boolean: up to 2000 characters of
 * operator standing text has no business in a tool result. The overlay is not model context, so the words
 * can be shown there, and only there; nothing but `createDashboardDeps` calls this.
 *
 * ONE read of the file, captured through `readTriggers`' own `fs` seam, so the text and the view can never
 * describe two different versions of a file an operator saved between two reads. The view's shapes pass
 * through untouched (`missing`, `invalid`), with an empty map beside them.
 */
export function readTriggersWithInstructions({ triggersPath, fs = nodeFs, includeTasks = false }) {
  let text = null;
  const capture = { readFileSync: (p, enc) => (text = fs.readFileSync(p, enc)) };
  const view = readTriggers({ triggersPath, fs: capture });
  const instructions = {};
  const tasks = {};
  if (Array.isArray(view?.triggers) && typeof text === "string") {
    const entries = JSON.parse(text).triggers;
    for (const t of view.triggers) {
      const raw = entries?.[t.index]?.run?.instructions;
      if (typeof raw === "string" && raw.trim() !== "") instructions[t.index] = raw;
      const task = entries?.[t.index]?.run?.task;
      if (typeof task === "string" && task.trim() !== "") tasks[t.index] = task;
    }
  }
  return { view, instructions, ...(includeTasks ? { tasks } : {}) };
}

/**
 * Normalize one `{ on, run }` entry into its display record, or `null` when it is not usable. Exported for
 * the display tests; `readTriggers` is the only production caller.
 *
 * `packages` -- whether the trigger loads the operator-staged third-party pi packages
 * (INT-TRIGGERS-FILE-CONTRACT, REQ-GLOBAL-PI-OVERLAY) -- is carried on ALL FOUR kinds: a trigger that runs
 * third-party code with open network egress must not render identically to one that does not. It is an
 * opt-OUT, so `!== false`: absent and `true` both load, and only an explicit `false` withholds. The
 * `=== true` this replaced was the display half of a polarity that flipped in the worker and did not flip
 * here, and it was silent in exactly the wrong direction -- the commonest loading trigger is one that omits
 * the flag entirely, and it rendered with no marker at all.
 *
 * The display MIRRORS the worker rather than re-validating. `parseTriggers` refuses a non-boolean fail-loud
 * at load, so a string "false" never reaches this function; a display that "failed closed" on it would be
 * inventing a state the system cannot be in, and would disagree with the job that actually runs.
 *
 * `image` -- the trigger's own container image (INT-TRIGGERS-FILE-CONTRACT, issue #41) -- is carried on every
 * kind for the same reason and shown for a sharper one: which image a job runs IS which code it runs
 * (the pi version, the runner, the guardrail floor and the loader posture all come from it). `null` is the
 * default-image sentinel, matching this function's own `flow`/`model`/`phrase` convention, and anything that
 * is not a non-empty string reads as the default -- mirroring the worker's `job.image ?? config.jobImage`
 * rather than re-validating a value the loader already refused.
 *
 * `forge` -- which forge a webhook trigger listens to (issue #42) -- is carried on the webhook kinds
 * and is `null` on cron, which has no forge at all. It is `run.kind` VERBATIM rather than a validated enum:
 * this normalizer is fail-soft by design (a viewer degrades, it never throws), and showing an operator the
 * kind their file actually contains is more useful than mapping an unknown one onto a plausible default --
 * the worker refuses to boot on it, and the panel saying so is how they find out why.
 */
export function normalizeTriggerForDisplay(entry) {
  if (entry === null || typeof entry !== "object") return null;
  const on = entry.on;
  if (on === null || typeof on !== "object") return null;
  const run = entry.run !== null && typeof entry.run === "object" ? entry.run : {};
  const flow = typeof run.flow === "string" ? run.flow : null;
  // `run.command` (issue #189) -- flow's mutually-exclusive sibling: the trigger dispatches a registered
  // pi extension command instead of a flow. Carried with flow's exact fail-soft test (a string passes,
  // junk degrades to null) because the shared parser refuses everything else fail-loud at load, and a
  // display that "corrected" the value would disagree with the job that actually runs.
  const command = typeof run.command === "string" ? run.command : null;
  const packages = run.packages !== false;
  const image = typeof run.image === "string" && run.image.trim() !== "" ? run.image : null;
  // #227. Null when the trigger names no venue, so the panel can print "deployment default" as a checked
  // fact rather than leaving where the box was built implicit -- the argument the image row already makes.
  const backend = typeof run.backend === "string" && run.backend.trim() !== "" ? run.backend : null;
  // #291. The pi tools this trigger's session must NOT have. `null` is the full-set sentinel, matching
  // this function's own convention, and the value MIRRORS the loader (a non-empty all-string array
  // passes, junk degrades to null) rather than re-validating names it already refused. A fresh copy,
  // so nothing downstream shares the raw entry's array. Names only, never values, so carrying it into
  // the model-callable dispatch_triggers read is as safe as `backend` one line up.
  const excludeTools = Array.isArray(run.excludeTools) && run.excludeTools.length > 0 && run.excludeTools.every((t) => typeof t === "string") ? [...run.excludeTools] : null;
  // The trigger's injected skills dir (REQ-PER-TRIGGER-SKILLS, issue #60). Carried on every kind like
  // `image`, and shown for the same reason: which skills a job loads IS what the agent can do. `null` is
  // the none sentinel, matching this function's own convention.
  const skillsDir = typeof run.skillsDir === "string" && run.skillsDir.trim() !== "" ? run.skillsDir : null;
  // Whether this trigger attaches operator standing text (REQ-PER-TRIGGER-INSTRUCTION). A BOOLEAN, not
  // the text: the panel line must say that a trigger carries one, and the text itself may be 2000
  // characters. The detail view is where the words belong.
  const instructions = typeof run.instructions === "string" && run.instructions.trim() !== "";
  // An opt-IN, so `=== true` and not `!== false` -- the opposite test from `packages` directly above, and
  // the difference is the whole point. Getting this polarity wrong is the defect 0.1.4 shipped a fix for:
  // the riskiest triggers rendered with no badge and no warning, quiet exactly where the risk was.
  const resume = run.resume === true;
  const forge = typeof run.kind === "string" && run.kind.trim() !== "" ? run.kind : null;
  // How many sandboxes race this trigger (INT-TRIGGERS-FILE-CONTRACT, REQ-REPLICA-RUNS). `null` is the
  // one-run default, matching this function's flow/model/phrase convention, and `> 1` is the test rather
  // than `!== undefined` because the only thing worth rendering is a trigger that MULTIPLIES SPEND -- the
  // sharpest version of the reason `image` and `resume` are shown at all. Carried on the three webhook kinds
  // and absent on cron, like `forge`: the loader refuses `run.replicas` on a cron entry outright.
  const replicas = Number.isInteger(run.replicas) && run.replicas > 1 ? run.replicas : null;
  // Whether this trigger binds vault secrets, and which resolver profile reads them (REQ-TRIGGER-SECRETS,
  // issue #225). A COUNT and a NAME, never the references: the reference list is the map of the operator's
  // vault, and this object reaches the model-callable `dispatch_triggers` read tool. The count is what makes
  // the badge honest, and `secretsProfile` is the operator's own label, the same class as `image`.
  //
  // Shown at all for `resume`'s reason, in its sharpest form yet: what a job can REACH is what the agent can
  // do, and unlike a flow (which lives in the repo, behind a merge) this lives only in triggers.json, so
  // nothing else would put it in front of the operator. Carried on every kind, because unlike
  // `replicas` the loader accepts this on cron too.
  const secrets = run.secrets !== null && typeof run.secrets === "object" && !Array.isArray(run.secrets) ? Object.keys(run.secrets).length : 0;
  const secretsProfile = typeof run.secretsProfile === "string" && run.secretsProfile.trim() !== "" ? run.secretsProfile : null;
  // Which model this trigger's jobs run on (issue #502): every kind may name `provider`, `model` and
  // `maxTurns` since #502, and before it the record carried `model` for cron only, so the model-callable
  // dispatch_triggers read and the drill-in said "deployment default" for a webhook trigger that chose one.
  // Mirrors the loader's shapes (a string, a positive integer) rather than re-validating. Spread only when
  // present, so a record for a trigger that names none keeps exactly its pre-#502 keys; cron keeps its
  // long-standing `model: null` sentinel below.
  const modelRef = {
    // Prompt text stays in the separate operator read. Optional configuration stays absent when absent.
    ...(typeof run.task === "string" && run.task.trim() !== "" && { task: true }),
    ...(typeof run.repository === "string" && { repository: run.repository }),
    ...(Array.isArray(run.gates) && { gates: run.gates.filter((g) => typeof g === "string") }),
    ...(Number.isSafeInteger(run.gateTimeout) && { gateTimeout: run.gateTimeout }),
    ...((typeof run.gateBudgetRaiseUsd === "number" || typeof run.gateBudgetRaiseUsd === "string") && { gateBudgetRaiseUsd: String(run.gateBudgetRaiseUsd) }),
    ...(Array.isArray(on.reviewState) && { reviewState: on.reviewState.filter((v) => typeof v === "string") }),
    ...(Array.isArray(run.waitFor) && { waitFor: run.waitFor.flatMap((v) => typeof v?.after === "string" ? [{ after: v.after }] : typeof v?.profile === "string" ? [{ profile: v.profile }] : []) }),
    ...Object.fromEntries(["awaitInput", "github", "progress", "statusComment", "recover", "steer"].filter((k) => typeof run[k] === "boolean").map((k) => [k, run[k]])),
    ...(typeof run.provider === "string" && run.provider !== "" && { provider: run.provider }),
    ...(typeof run.model === "string" && run.model !== "" && { model: run.model }),
    ...(Number.isSafeInteger(run.maxTurns) && run.maxTurns >= 1 && { maxTurns: run.maxTurns }),
    // The two spend narrowings no tool can set (issue #501, part 7): the allowed-model list (a fresh copy,
    // all strings, the loader's shape; the obligation from PR #536's review) and the per-job dollar cap, as written.
    // Shown because they decide what the trigger's jobs can reach and spend, and only the file says so. Model ids and
    // a dollar amount, the operator's own words, never a value a job chose. Spread only when present, so a trigger
    // that sets neither keeps exactly its keys.
    ...(Array.isArray(run.models) && run.models.length > 0 && run.models.every((m) => typeof m === "string") && { models: [...run.models] }),
    ...(Array.isArray(run.fallbackModels) && run.fallbackModels.length > 0 && run.fallbackModels.every((m) => typeof m === "string") && { fallbackModels: [...run.fallbackModels] }),
    ...((typeof run.maxCostUsd === "string" || typeof run.maxCostUsd === "number") && { maxCostUsd: String(run.maxCostUsd) }),
    // The overlay MCP servers the jobs connect (REQ-MCP-OPERATOR-SERVERS), by name: the operator's own words, never a
    // server's definition or a credential. Shown for `secrets`' reason: what a job can reach is set only in this file.
    ...(Array.isArray(run.mcp) && run.mcp.length > 0 && run.mcp.every((name) => typeof name === "string") && { mcp: [...run.mcp] }),
    // The project secret bundle opt-out (issue #704, `run.secretBundle: false`): this trigger's jobs run WITHOUT their
    // project's bundle, so the row and the drill-in say so beside the secrets they do bind. Spread only when false, so
    // every other trigger keeps exactly its keys; `true` is the default and says nothing.
    ...(run.secretBundle === false && { secretBundle: false }),
  };
  switch (on.type) {
    case "watch":
      return { type: "watch", id: typeof on.id === "string" ? on.id : null, source: typeof on.source === "string" ? on.source : null, mode: typeof run.mode === "string" ? run.mode : "investigate", maxPerDay: Number.isSafeInteger(on.maxPerDay) ? on.maxPerDay : null, cooldownMs: (() => { try { return watchDurationMs(on.cooldown); } catch { return null; } })(), folder: typeof run.folder === "string" ? run.folder : null, flow, command, ...modelRef, packages, image, backend, excludeTools, skillsDir, instructions, resume, secrets, secretsProfile, forge: null };
    case "cron":
      return {
        type: "cron",
        id: typeof on.id === "string" ? on.id : null,
        pattern: typeof on.pattern === "string" ? on.pattern : null,
        folder: typeof run.folder === "string" ? run.folder : null,
        flow,
        command,
        // Optional per-cron model override (passthrough into job.data); null when the entry resolves the
        // deployment default. Surfaced so the drill-in shows which schedules pin their own model.
        model: typeof run.model === "string" ? run.model : null,
        ...modelRef,
        packages,
        image,
        backend,
        excludeTools,
        skillsDir,
        instructions,
        resume,
        secrets,
        secretsProfile,
        // The portfolio flag (issue #505): this trigger's jobs write the budget split for every project, so the row and
        // the drill-in say so (issue #507). Cron only, as the loader allows it. Spread only when true, so every other cron
        // record keeps exactly its keys, and `dispatch_triggers` shows the boolean only on the trigger that carries it.
        ...(run.portfolio === true && { portfolio: true }),
      };
    case "label":
      return { type: "label", any: normalizeSelector(on.any), all: normalizeSelector(on.all), none: normalizeSelector(on.none), flow, command, ...modelRef, packages, image, backend, excludeTools, skillsDir, instructions, resume, secrets, secretsProfile, replicas, forge };
    case "comment":
      return { type: "comment", phrase: typeof on.phrase === "string" ? on.phrase : null, flow, command, ...modelRef, packages, image, backend, excludeTools, skillsDir, instructions, resume, secrets, secretsProfile, replicas, forge };
    case "pull_request": {
      // A close-only PR rule carries the same #231 trio the issue arm does, on the issue arm's terms
      // (see its comments): without them here, a spent PR one-shot renders byte-identical to an armed
      // one on every surface INCLUDING the model-callable dispatch_triggers -- the exact confusion the
      // spent-row-in-front-of-them rationale below exists to prevent. Conditionally spread so every
      // pre-#231 rule's record stays key-identical.
      const prDisarmed = on.disarmed !== null && typeof on.disarmed === "object" && !Array.isArray(on.disarmed) ? on.disarmed : null;
      return {
        type: "pull_request",
        action: normalizeSelector(on.action),
        any: normalizeSelector(on.any),
        all: normalizeSelector(on.all),
        none: normalizeSelector(on.none),
        ...(Number.isInteger(on.number) && on.number >= 1 && { number: on.number }),
        ...(on.once === true && { once: true }),
        ...(prDisarmed !== null && { disarmed: prDisarmed }),
        flow,
        command,
        ...modelRef,
        packages,
        image,
        backend,
        excludeTools,
        skillsDir,
        instructions,
        resume,
        secrets,
        secretsProfile,
        replicas,
        forge,
      };
    }
    case "issue": {
      // The close-trigger kind (issue #231). A spent one-shot KEEPS its raw entry -- the worker's loader
      // collapses `on.disarmed` to a never-matches sentinel for dispatch, but this normalizer reads the RAW
      // file, and an operator asking "why did nothing fire" needs the spent row in front of them, not a hole
      // where a trigger used to be. So this arm returns a record disarmed or not, and carries the mark
      // verbatim when it is a usable object: the loader refused any other shape fail-loud, so re-validating
      // here would invent a state the file cannot be in -- the packages/image doctrine restated.
      const disarmed = on.disarmed !== null && typeof on.disarmed === "object" && !Array.isArray(on.disarmed) ? on.disarmed : null;
      return {
        type: "issue",
        action: normalizeSelector(on.action),
        // `null` is the every-item sentinel, this function's own flow/model/phrase convention; the loader
        // refused anything but an integer >= 1, so the display mirrors rather than re-validates.
        number: Number.isInteger(on.number) && on.number >= 1 ? on.number : null,
        // An opt-IN, `=== true` like `resume` above and NOT `!== false`: the rendering mistake that costs
        // is a one-shot with no marker, never a standing rule with a spurious one.
        once: on.once === true,
        // Absent, not null, when unspent: `disarmed` is a mark the worker adds, and a key that is usually
        // missing reads truer than a fifth null sentinel -- consumers test presence, not value.
        ...(disarmed !== null && { disarmed }),
        flow,
        command,
        ...modelRef,
        packages,
        image,
        backend,
        excludeTools,
        skillsDir,
        instructions,
        resume,
        secrets,
        secretsProfile,
        replicas,
        forge,
      };
    }
    default:
      return null;
  }
}

// Custom: fail-soft display normalizer, not the receiver's fail-loud validator; a viewer degrades, never throws.
function normalizeSelector(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((member) => typeof member === "string");
}

/**
 * Read the operator's staged pi packages for display: the `name@version` list a trigger with
 * `run.packages: true` arms (REQ-GLOBAL-PI-OVERLAY). The panel shows WHICH pinned third-party code an armed
 * trigger loads; it never stages, arms, or writes anything.
 *
 * Uses the worker's OWN `readStageManifest`, so the admin and the job path cannot drift on the manifest's
 * location, shape, or re-validation -- the same rule as `parseTriggers` / `readOverlay` above. Degrades in
 * every absent case to the SAME safe empty shape `{ stagedAt: null, packages: [] }` -- no overlay
 * configured, no manifest on disk, or a malformed one -- so the caller never has to discriminate. That
 * reader never throws by contract; the try/catch additionally covers the injected `fs` callbacks, so a
 * viewer degrades rather than killing the panel.
 */
export function readStagedPackages({ globalPiDir, fs = nodeFs, readManifest = readStageManifest } = {}) {
  const empty = { stagedAt: null, packages: [] };
  if (typeof globalPiDir !== "string" || globalPiDir === "") return empty;
  let manifest;
  try {
    manifest = readManifest({
      globalPiDir,
      readFile: (path) => fs.readFileSync(path, "utf8"),
      fileExists: (path) => fs.existsSync(path),
    });
  } catch {
    return empty;
  }
  const entries = Array.isArray(manifest?.packages) ? manifest.packages : [];
  return {
    stagedAt: typeof manifest?.stagedAt === "string" ? manifest.stagedAt : null,
    packages: entries.filter((p) => p && typeof p.name === "string").map(nameAtVersion),
  };
}

/**
 * The `run.mcp` name that is not the overlay's: the job's own forge server (DES-FORGE-MCP), whose entry the worker
 * writes. Re-exported from the worker's module so the panel names it by the same constant the pickup checks.
 */
export { FORGE_MCP_SERVER_NAME };

/**
 * The parser's diagnostic may quote a header/env name, an unaccepted field, or a normalized URL containing private
 * path text. Select fixed explanations by its rule, never echo its diagnostic. The real-parser tests keep these
 * categories tied to worker behavior; an unfamiliar future diagnostic remains explicitly invalid, never silent.
 */
function mcpProblemForDisplay(name, problem) {
  if (!MCP_SERVER_NAME_RE.test(name)) return "the server name must use lowercase letters and digits, joined by single hyphens, up to 32 characters";
  if (name.includes("dispatch")) return "a name holding `dispatch` is reserved for the dispatch admin";
  if (name === FORGE_MCP_SERVER_NAME) return "forge is reserved for the worker’s own forge server";
  const why = typeof problem === "string" ? problem : "";
  if (why.startsWith("the name must")) return "the server name must use lowercase letters and digits, joined by single hyphens, up to 32 characters";
  if (why === "the entry is not an object") return "the server declaration must be an object";
  if (why.startsWith("the legacy SSE")) return "the legacy SSE transport is not supported; use a streamable HTTP URL";
  if (why.startsWith("`type`") || why.startsWith("the entry needs exactly one")) return "declare exactly one HTTP URL or stdio command, with a matching supported transport type";
  if (why.startsWith("`description`")) return "a server description is required, one line of at most 300 characters with no control or format characters";
  if (why.startsWith("`toolExposure`")) return "tool exposure must map tool names or patterns to supported exposure modes";
  if (why.startsWith("`exposure`")) return "the server exposure must be one of the worker's supported exposure modes";
  if (why.startsWith("`enabled`")) return "the enabled switch must be true or false";
  if (why.startsWith("`timeout`")) return "the timeout must be a whole number of seconds from 1 to 600";
  if (why.startsWith("`url` query value")) return "URL query values must be whole named credential references; literal query values are refused";
  if (why.startsWith("`url` holds a reference in its host")) return "the HTTP URL's host must be written literally; a credential reference cannot choose the egress host";
  if (why.startsWith("`url` must not carry a user name or password")) return "the HTTP URL must not carry credentials; supply them through a named header reference";
  if (why.startsWith("`url`")) return "the HTTP URL must be a plain http or https URL, with a literal host, no fragment and only complete named references";
  if (why.startsWith("`headers`")) return "HTTP headers must map header names to named credential references";
  if (why.startsWith("header name ")) return "an HTTP header name is invalid or reserved";
  if (why.startsWith("header ")) return "HTTP header credentials must use complete named references; literal header values are refused";
  if (why.startsWith("`command`") && why.includes("fetches the server from a package registry")) return "a package runner fetches the server at job start; install it in the image or explicitly allow the package runner and its registry";
  if (why.startsWith("`command`")) return "the stdio command must be an admitted image executable or a bare name on its PATH, without substitutions or home-folder shorthand";
  if (why.startsWith("`allowPackageRunner`")) return "the package-runner permission must be true or false";
  if (why.startsWith("`args`")) return "stdio arguments must be a list of strings";
  if (why.startsWith("an argument ")) return "stdio arguments may use complete named references; command execution and home-folder shorthand are refused";
  if (why.startsWith("`env`")) return "the stdio environment must map variable names to complete named credential references";
  if (why.startsWith("env name ")) return "an environment variable name is invalid or reserved";
  if (why.startsWith("env ")) return "stdio environment values must be complete named credential references; literal values are refused";
  if (/ is not a key a (?:streamable HTTP|stdio) server takes here$/.test(why) || /^`[^`]+` is not accepted: /.test(why)) return "the server declaration contains a field this transport does not accept";
  return "the server declaration is invalid; check it with pi-dispatch doctor";
}

/**
 * The overlay's MCP servers for display (REQ-MCP-OPERATOR-SERVERS): what a trigger's `run.mcp` names resolve to. Read
 * through the worker's OWN parser (`@edgehero/pi-dispatch/mcp-config`), so the panel and the pickup cannot disagree
 * on which servers are offered. Per server its name, transport, where it runs (a url's host, or a command's
 * basename), its exposure, whether it is on, and the variable NAMES it references; never a header, an argument, a
 * value or a url's path. Never throws: `{ servers: [], refused: [], unreadable: null }` when there is no overlay or no
 * file, `unreadable` set when there is one that cannot be read whole.
 */
export function readOverlayMcpView({ globalPiDir, read = readOverlayMcp } = {}) {
  const empty = { servers: [], refused: [], unreadable: null };
  if (typeof globalPiDir !== "string" || globalPiDir === "") return empty;
  let parsed;
  try {
    parsed = read(globalPiDir);
  } catch (err) {
    return { ...empty, unreadable: err?.mcpConfig ? "invalid" : (err?.code ?? "unreadable") };
  }
  if (parsed === null) return empty;
  const servers = Object.entries(parsed.servers ?? {}).map(([name, server]) => ({
    name,
    transport: server.transport === "http" ? "http" : "stdio",
    where: mcpServerWhere(server),
    exposure: typeof server.exposure === "string" ? server.exposure : "codemode",
    enabled: server.enabled !== false,
    refs: Array.isArray(server.refs) ? [...server.refs] : [],
  }));
  const refused = (parsed.refused ?? []).filter((r) => typeof r.name === "string");
  const invalidNameCount = refused.filter((r) => !MCP_SERVER_NAME_RE.test(r.name)).length;
  const displayName = (name) => MCP_SERVER_NAME_RE.test(name) ? name : "invalid server name";
  return { servers, refused: refused.map((r) => displayName(r.name)), problems: refused.map((r) => ({ name: displayName(r.name), problem: mcpProblemForDisplay(r.name, r.problem) })), ...(invalidNameCount > 0 ? { invalidNameCount } : {}), unreadable: null };
}

/** One manifest entry as `name@version`, or bare `name` when the entry pins no version string. */
function nameAtVersion(pkg) {
  return typeof pkg.version === "string" && pkg.version !== "" ? `${pkg.name}@${pkg.version}` : pkg.name;
}

// ---------------------------------------------------------------------------------------------------
// The graph read-model (issue #54): the joins and enumerations the trigger/flow topology renders from.
// Every function below is never-throw and degrades to a safe empty shape (the readStagedPackages
// doctrine), because the graph is a viewer: one unreadable folder must dim one folder, not kill the
// panel. All bounds live in GRAPH_LIMITS, literal-pinned in the tests so widening one is a reviewed
// edit (the PI_LIMITS lesson).
// ---------------------------------------------------------------------------------------------------

export const GRAPH_LIMITS = Object.freeze({
  maxFoldersScanned: 16, // distinct cron folders enumerated per graph build; git spawns are the cost
  maxSkillsPerFolder: 64, // cat-file spawns per folder; mirrors PI_LIMITS.maxFilesPerSkill's altitude
  maxSkillBytes: 64 * 1024, // one SKILL.md read cap; frontmatter + prose, never a dataset
  maxMentionScanBytes: 32 * 1024, // sibling-name scan window into each SKILL.md
  maxEdges: 200, // distinct observed chain edges kept; beyond this the graph says "truncated"
  windowDays: 30, // run-record window the graph folds; matches the default PI_LOG_RETENTION_DAYS
  maxReposListed: 5, // repos named per forge group, from record targets; a scope label, not an inventory
  maxStagedSkills: 64, // staged-package skills kept for display; one stage read per graph build
});

/**
 * Fold run counts and the last outcome per cron scheduler id from already-parsed records.
 *
 * The join is the RAW jobId (`repeat:<id>:<millis>`, or `manual:<id>:<millis>` for a hand-fired run of the trigger,
 * INT-RUN-HISTORY-FILE-CONTRACT keeps it raw in
 * the body) against each scheduler id, with the digits-only tail as the disambiguator -- the same
 * doctrine as the worker's makeFindPreviousRun filename scan: scheduler `a` must not swallow
 * `a:1`-shaped siblings, and a millis tail is all digits while a foreign id segment is not. Pure over
 * its inputs (records come from scanRunRecords) so it costs no extra I/O and tests hand-build both.
 */
export function cronRunStats({ records, schedulerIds } = {}) {
  const byId = {};
  if (!Array.isArray(records) || !Array.isArray(schedulerIds)) return { byId };
  for (const id of schedulerIds) {
    if (typeof id !== "string" || id === "") continue;
    // A hand-fired run of the trigger (`pi-dispatch run --trigger`, issue #505) is `manual:<id>:<minute millis>`, and
    // the worker counts it as a run of its trigger; the panel does too, by the same digits-tail rule.
    const re = new RegExp(`^(?:repeat|manual):${escapeRegExp(id)}:(\\d+)$`);
    let runs = 0;
    let lastMillis = -1;
    let last = null;
    for (const record of records) {
      const m = typeof record?.jobId === "string" ? re.exec(record.jobId) : null;
      if (!m) continue;
      runs++;
      const millis = Number(m[1]);
      if (millis > lastMillis) {
        lastMillis = millis;
        last = record;
      }
    }
    byId[id] = {
      runs,
      lastOutcome: last?.outcome ?? null,
      lastEndedAt: last ? (last.endedAt ?? last.startedAt ?? null) : null,
    };
  }
  return { byId };
}

/**
 * Join forge run records to their triggers.json entry via the persisted `triggerIndex` AND
 * `triggerType` (INT-RUN-HISTORY-FILE-CONTRACT, issue #54). `triggerCount` is the CURRENT file's
 * length and `triggerTypes` maps each raw index to the entry's CURRENT `on.type`; both guards are
 * the honesty rule, because the file live-reloads (OQ-008). A record whose index no longer exists,
 * predates the field, points at a row the display dropped, or DISAGREES ON TYPE with the entry now
 * at that index counts under `unattributed` -- an edit that shifted a different kind of trigger onto
 * the row is detectable from the persisted pair and refused (found by adversarial review: without
 * the type check, deleting a cron above a comment trigger moved the comment's run history onto
 * whatever slid into its slot). The residual the pair cannot see -- a SAME-type reorder within range
 * -- is beneath these two integers-and-enums' resolution; catching it would need a persisted entry
 * identity, and the record's PII posture prices strings high, so it is documented in
 * REQ-TOPOLOGY-GRAPH instead of half-solved here. Index 0 attributes; only a forge-kind record can
 * be unattributed, because cron/local/chained runs never carried a matched index and their
 * attribution lives elsewhere.
 */
export function joinRunsToTriggers({ records, triggerCount, triggerTypes } = {}) {
  const byIndex = {};
  let unattributed = 0;
  if (!Array.isArray(records)) return { byIndex, unattributed };
  const count = Number.isInteger(triggerCount) && triggerCount >= 0 ? triggerCount : 0;
  const types = triggerTypes && typeof triggerTypes === "object" ? triggerTypes : null;
  for (const record of records) {
    if (!isForgeKind(record?.kind)) continue;
    const idx = record?.triggerIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) {
      unattributed++;
      continue;
    }
    // Type agreement, when the caller supplied the current types: an undefined slot means the row
    // exists in the file but not on the display (an unusable entry), so there is no node to carry
    // the count -- unattributed keeps it visible instead of vanishing it.
    if (types && (types[idx] === undefined || types[idx] !== record.triggerType)) {
      unattributed++;
      continue;
    }
    const slot = (byIndex[idx] ??= { runs: 0, lastOutcome: null, lastEndedAt: null });
    slot.runs++;
    const at = record.endedAt ?? record.startedAt ?? null;
    if (at !== null && (slot.lastEndedAt === null || at > slot.lastEndedAt)) {
      slot.lastEndedAt = at;
      slot.lastOutcome = record.outcome ?? null;
    }
  }
  return { byIndex, unattributed };
}

/**
 * Per-jobId trigger attribution over one scanned window -- the COST fold's join (issue #175),
 * produced HERE so the index+type agreement doctrine (joinRunsToTriggers above) and the raw
 * `repeat:<id>:<millis>` (or `manual:<id>:<millis>`) jobId grammar (cronRunStats above) are never re-derived by a second module;
 * costs.mjs stays fs-free and worker-import-free by taking this result as an argument. Pure over its
 * inputs. Returns `{ byJobId: { [jobId]: { key, index, type, label } } }` where `key` for a joined
 * run IS the graph node id (`trigger:<index>` -- graph-model mints exactly this), so a spend map
 * keyed by it lands on topology nodes with no second join vocabulary. A FORGE record whose persisted
 * index+type pair disagrees with the current file gets the explicit `key: "unattributed"` entry --
 * the fold cannot ask isForgeKind itself, and silence would let it misfile a refused join under
 * "manual". Records that match nothing get no entry; the fold classifies the remainder
 * (chained/manual) from record facts it already holds.
 */
export function attributeRunsToTriggers({ records, triggers } = {}) {
  const byJobId = {};
  if (!Array.isArray(records) || !Array.isArray(triggers)) return { byJobId };
  const cronRes = triggers
    .filter((t) => t?.type === "cron" && typeof t.id === "string" && t.id !== "" && Number.isInteger(t.index))
    // `manual:<id>:<millis>` too: a hand-fired run of the trigger (issue #505) is its run, so its cost is the trigger's.
    .map((t) => ({ t, re: new RegExp(`^(?:repeat|manual):${escapeRegExp(t.id)}:(\\d+)$`) }));
  const byIndex = new Map(triggers.filter((t) => Number.isInteger(t?.index)).map((t) => [t.index, t]));
  for (const record of records) {
    const jobId = typeof record?.jobId === "string" && record.jobId !== "" ? record.jobId : null;
    if (jobId === null) continue;
    // Cron first: the raw repeat jobId names its scheduler outright, digits-tail disambiguated.
    const cron = cronRes.find(({ re }) => re.test(jobId));
    if (cron) {
      byJobId[jobId] = { key: `trigger:${cron.t.index}`, index: cron.t.index, type: "cron", label: triggerMatchLabel(cron.t) };
      continue;
    }
    if (!isForgeKind(record?.kind)) continue;
    const idx = record?.triggerIndex;
    // A forge record with no persisted index (pre-#54) or a disagreeing index+type pair is
    // UNATTRIBUTED, never silent: it was forge-triggered, so letting the fold default it to
    // "manual" would misfile it -- the same accounting joinRunsToTriggers keeps for the graph.
    const t = Number.isInteger(idx) ? byIndex.get(idx) : undefined;
    if (!t || t.type !== record.triggerType) {
      byJobId[jobId] = { key: "unattributed", index: null, type: null, label: null };
      continue;
    }
    byJobId[jobId] = { key: `trigger:${idx}`, index: idx, type: t.type, label: triggerMatchLabel(t) };
  }
  return { byJobId };
}

/**
 * The OBSERVED flow->flow chain edges: child records joined to their parent via `parentJobId` over
 * one already-scanned window, folded per (parentFlow, childFlow, folder basename). Observed means
 * exactly that -- an edge exists here because a run actually spawned another, never because a skill
 * could. Same-target only, belt-and-suspenders on what the outbox already forces (OQ-009: the child
 * folder IS the parent's); a cross-target pair in the records would be a bug upstream, and drawing it
 * would draw the unrepresentable, so it is dropped. `refusals` counts chainRefused per parent flow --
 * attempts the caps or the gate blocked, which the graph shows beside the edges that did fire.
 */
export function observedChainEdges({ records } = {}) {
  const empty = { edges: [], refusals: {}, truncated: false };
  if (!Array.isArray(records)) return empty;
  const byJobId = new Map();
  for (const record of records) {
    if (typeof record?.jobId === "string" && record.jobId !== "") byJobId.set(record.jobId, record);
  }
  const folded = new Map();
  const refusals = {};
  let truncated = false;
  for (const child of records) {
    const parentId = child?.parentJobId;
    if (typeof parentId !== "string" || parentId === "") continue;
    const parent = byJobId.get(parentId);
    if (!parent) continue; // parent outside the window/retention: an edge with one visible end is no edge
    if (typeof parent.flow !== "string" || typeof child.flow !== "string") continue;
    if (parent.target !== child.target) continue; // unrepresentable by construction; never drawn
    const key = `${parent.flow} ${child.flow} ${parent.target ?? ""}`;
    let edge = folded.get(key);
    if (!edge) {
      if (folded.size >= GRAPH_LIMITS.maxEdges) {
        truncated = true;
        continue;
      }
      edge = { parentFlow: parent.flow, childFlow: child.flow, target: parent.target ?? null, count: 0, lastEndedAt: null };
      folded.set(key, edge);
    }
    edge.count++;
    const at = child.endedAt ?? child.startedAt ?? null;
    if (at !== null && (edge.lastEndedAt === null || at > edge.lastEndedAt)) edge.lastEndedAt = at;
  }
  for (const record of records) {
    if (Number.isInteger(record?.chainRefused) && record.chainRefused > 0 && typeof record?.flow === "string") {
      // Folder-scoped like the edges (adversarial-review finding): chaining is same-folder-only, so
      // two folders' same-named flows are genuinely different flows, and a flat per-flow counter
      // would blur their refusals into one number nobody can place.
      const scope = typeof record.target === "string" && record.target.startsWith("local:") ? `${record.target.slice("local:".length)}/${record.flow}` : record.flow;
      refusals[scope] = (refusals[scope] ?? 0) + record.chainRefused;
    }
  }
  return { edges: [...folded.values()], refusals, truncated };
}

// The ls-tree LISTING bound, separate from the per-skill byte caps for the same reason the worker's
// LS_TREE_MAX_BYTES is separate from PI_LIMITS: the caps are computed FROM the listing, so they
// cannot bound it.
const GRAPH_LS_TREE_MAX_BYTES = 1 << 20;

/**
 * Enumerate a cron folder's committed skills from the git OBJECT STORE at HEAD (issue #54, Gap 3):
 * `git ls-tree -r -l -z HEAD .pi/`, parsed by the worker's own selectEntries +
 * keepOnlyDeclaredSkills, then one bounded cat-file per top-level SKILL.md for the frontmatter facts
 * (`ai-trigger`, name, description) and the sibling-mention scan.
 *
 * ADVISORY, and labelled so wherever it renders: the chain gate's truth is readFlowGate at a
 * PRE-AGENT sha (DES-AI-TRIGGER-FLOW-GATE), while this reads HEAD at display time -- right for a
 * viewer (it shows what the NEXT run will see), wrong for a gate, and never used as one. The
 * object-store read (never the working tree) still holds here, for the same two reasons the gate's
 * Rejected records: an uncommitted SKILL.md is not what a job runs, and a blob read cannot follow a
 * symlink.
 *
 * Degrades per folder, never throws: `{ head: null, skills: [], truncated: false, unreachable: <why> }`
 * for a non-repo or failed git; the graph dims the folder as "unverified" rather than inventing
 * dangling-trigger flags from a read that never happened (deny != no-skill, one module up).
 */
export function readFolderSkills({ folder, exec = execFileSync } = {}) {
  const empty = { head: null, skills: [], truncated: false };
  if (typeof folder !== "string" || folder === "") return { ...empty, unreachable: "no-folder" };
  const head = revParseHead(folder, { exec });
  if (head === null) return { ...empty, unreachable: "not-a-git-repo" };
  let listing;
  try {
    // No hooks, no fsmonitor, no pager, so a hostile repo config cannot run code or corrupt output
    // during a read. Imported from the worker rather than mirrored: this comment used to say "keep in
    // sync" and one of the seven copies had not (issue #286's sweep).
    listing = exec(
      "git",
      [...GIT_READ_FLAGS, "-C", folder, "ls-tree", "-r", "-l", "-z", head, ".pi/"],
      { encoding: "utf8", maxBuffer: GRAPH_LS_TREE_MAX_BYTES, stdio: GIT_READ_STDIO },
    );
  } catch {
    return { head, skills: [], truncated: false, unreachable: "ls-tree-failed" };
  }
  let kept;
  try {
    const selected = selectEntries(listing);
    kept = keepOnlyDeclaredSkills(selected.entries).kept;
  } catch {
    // selectEntries throws on an unreadable size column (its own -l guard); for a viewer that is an
    // unreachable folder, not a crash.
    return { head, skills: [], truncated: false, unreachable: "listing-unparseable" };
  }

  // Top-level skills are flow candidates (outRel exactly pi/skills/<name>/SKILL.md); a deeper
  // SKILL.md is a helper sub-skill pi can load but the gate can never fire (the gate's path template
  // has no room for it), so it renders inside its group and is never an orphan candidate.
  const topLevel = new Map();
  const subs = [];
  for (const entry of kept) {
    if (entry.skill === null || !entry.outRel.endsWith("/SKILL.md")) continue;
    if (entry.outRel === `pi/skills/${entry.skill}/SKILL.md`) {
      topLevel.set(entry.skill, entry);
    } else {
      subs.push({ name: entry.outRel.slice("pi/skills/".length, -"/SKILL.md".length), group: entry.skill });
    }
  }

  const names = [...topLevel.keys()].sort();
  const truncated = names.length > GRAPH_LIMITS.maxSkillsPerFolder;
  const keptNames = names.slice(0, GRAPH_LIMITS.maxSkillsPerFolder);
  const skills = [];
  let anyUnread = false;
  for (const name of keptNames) {
    const entry = topLevel.get(name);
    let text = null;
    try {
      const buf = exec(
        "git",
        [...GIT_READ_FLAGS, "-C", folder, "cat-file", "blob", entry.oid],
        { maxBuffer: GRAPH_LIMITS.maxSkillBytes, stdio: GIT_READ_STDIO },
      );
      text = buf.toString("utf8");
    } catch {
      anyUnread = true; // oversized or unreadable: the skill still exists; its frontmatter facts do not
    }
    skills.push({
      name,
      isSub: false,
      group: null,
      // Fail-closed like the gate: an unreadable SKILL.md reads as not-chainable, never as chainable.
      aiTrigger: text !== null && aiTriggerAllows(text),
      meta: text !== null ? parseSkillMeta(text) : null,
      mentions:
        text !== null
          ? findSiblingMentions(text.slice(0, GRAPH_LIMITS.maxMentionScanBytes), keptNames.filter((n) => n !== name))
          : [],
      // The prose-loop hints (issue #54's grouped-inside-the-skill visual): scanned over the same
      // bounded window as the mentions, because both are text evidence of the same trust class.
      loops: text !== null ? findLoopHints(text.slice(0, GRAPH_LIMITS.maxMentionScanBytes)) : [],
      unread: text === null,
    });
  }
  for (const sub of subs.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    skills.push({ name: sub.name, isSub: true, group: sub.group, aiTrigger: false, meta: null, mentions: [], unread: false });
  }
  return { head, skills, truncated: truncated || anyUnread, unreachable: null };
}

/**
 * Enumerate a trigger's injected skills dir (`run.skillsDir`, REQ-PER-TRIGGER-SKILLS) for display.
 * A WORKING-TREE readdir on purpose, and labelled advisory where it renders: injected skills are
 * operator-authored host files with no git history, so there is no object store to prefer -- the
 * same posture as doctor's aiTriggerNames walk. The one fact worth the read: an injected skill
 * carrying `ai-trigger: allow` is a silent no-op (OQ-022, injected skills are never AI-reachable),
 * and today only doctor says so; the graph badges it loudly.
 */
export function readInjectedSkills({ skillsDir, fs = nodeFs } = {}) {
  if (typeof skillsDir !== "string" || skillsDir === "") return { skills: [], truncated: false, unreachable: null };
  let names;
  try {
    names = fs.readdirSync(skillsDir);
  } catch {
    return { skills: [], truncated: false, unreachable: "unreadable" };
  }
  const valid = names.filter((n) => SKILL_NAME_RE.test(n)).sort();
  const truncated = valid.length > GRAPH_LIMITS.maxSkillsPerFolder;
  const skills = [];
  for (const name of valid.slice(0, GRAPH_LIMITS.maxSkillsPerFolder)) {
    let aiTrigger = false;
    try {
      const text = fs.readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      aiTrigger = aiTriggerAllows(text);
    } catch {
      continue; // no SKILL.md at the layout's one required path: not a skill, skip
    }
    skills.push({ name, aiTrigger });
  }
  return { skills, truncated, unreachable: null };
}

/**
 * Enumerate the deployment overlay's `skills/` (REQ-GLOBAL-PI-OVERLAY) for display: a working-tree
 * readdir like readInjectedSkills, because the overlay is operator-authored host state with no git
 * history. Existence-only on purpose, no frontmatter read and no `ai-trigger` fact: an overlay skill
 * is never AI-reachable regardless of what its frontmatter claims (DES-AI-TRIGGER-FLOW-GATE), and the
 * flag vocabulary is closed, so a body read could add nothing the tip's "never AI-reachable" does not
 * already say. The unbadged overlay `ai-trigger: allow` no-op is a recorded residual, not an oversight.
 *
 * ENOENT on the readdir is KNOWN-EMPTY, not unreachable: an overlay carrying only models.json or
 * prompts/ is a legal deployment, and calling it unreadable would soften every dangling flow into
 * "tier not checkable" for deployments that simply stage no overlay skills. Every other failure is
 * "unreadable", which the resolution ladder treats as an unknown tier: a read that failed proves
 * nothing (the readFolderSkills doctrine, one tier over).
 */
export function readOverlaySkills({ globalPiDir, fs = nodeFs } = {}) {
  if (typeof globalPiDir !== "string" || globalPiDir === "") return { skills: [], truncated: false, unreachable: null };
  const dir = join(globalPiDir, "skills");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return { skills: [], truncated: false, unreachable: null };
    return { skills: [], truncated: false, unreachable: "unreadable" };
  }
  const valid = names.filter((n) => SKILL_NAME_RE.test(n)).sort();
  const truncated = valid.length > GRAPH_LIMITS.maxSkillsPerFolder;
  const skills = [];
  for (const name of valid.slice(0, GRAPH_LIMITS.maxSkillsPerFolder)) {
    let present = false;
    try {
      present = fs.existsSync(join(dir, name, "SKILL.md"));
    } catch {
      present = false; // an unstattable entry is not a skill the loader would take either
    }
    if (present) skills.push({ name });
  }
  return { skills, truncated, unreachable: null };
}

/**
 * Enumerate the staged pi packages' skills for display, through the worker's OWN readStagedSkills
 * (worker/src/packages.mjs): manifest-vs-convention semantics at the pin, glob/override packages
 * reported as unenumerable rather than guessed at, dir-basename naming (a frontmatter rename can
 * only turn a would-be resolution into a softened one, never invent one). Same anti-drift rule as
 * readStagedPackages above, and the same wrapper doctrine: that reader never throws by contract, and
 * the try/catch here additionally covers the injected fs callbacks.
 *
 * Manifest order is PRESERVED, no re-sort: resolution takes the first name match, the same package
 * doctor's staged probe names, and display determinism comes from the page normalizer's id sort,
 * never from this list.
 */
export function readStagedSkillsList({ globalPiDir, fs = nodeFs, readStaged = readStagedSkills } = {}) {
  const empty = { skills: [], unenumerable: [], truncated: false };
  if (typeof globalPiDir !== "string" || globalPiDir === "") return empty;
  let result;
  try {
    result = readStaged({
      globalPiDir,
      readFile: (path) => fs.readFileSync(path, "utf8"),
      fileExists: (path) => fs.existsSync(path),
      readDir: (path, opts) => fs.readdirSync(path, opts),
    });
  } catch {
    return empty;
  }
  const seen = new Set();
  const skills = [];
  for (const s of Array.isArray(result?.skills) ? result.skills : []) {
    if (typeof s?.name !== "string" || !SKILL_NAME_RE.test(s.name)) continue;
    if (typeof s.dir !== "string" || s.dir === "") continue;
    const key = `${s.dir} ${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    skills.push({ name: s.name, package: typeof s.package === "string" && s.package !== "" ? s.package : s.dir, dir: s.dir });
  }
  return {
    skills: skills.slice(0, GRAPH_LIMITS.maxStagedSkills),
    unenumerable: (Array.isArray(result?.unenumerable) ? result.unenumerable : []).filter((p) => typeof p === "string").sort(),
    truncated: skills.length > GRAPH_LIMITS.maxStagedSkills,
  };
}

/**
 * The one I/O aggregation for a graph build: enumerate every distinct cron folder and injected
 * skills dir the display triggers name, deduped and capped, plus the two deployment-wide skill tiers
 * (overlay `skills/` and staged packages) when this session can see the global pi dir at all. Lives
 * here so the dashboard seam and the `/dispatch graph` command share one folder-dedupe/caps
 * implementation; callers bring their own records/schedulers reads. Forge triggers contribute no
 * folder -- their repo is not on this host, which is exactly what the graph's "skills unverifiable
 * from the admin host" folder line says.
 *
 * `overlaySkills`/`stagedSkills` are null (not empty) when `globalPiDir` is unset: the deployment
 * pointer's env allowlist deliberately excludes PI_GLOBAL_PI_DIR, so a wizard-launched session sees
 * null even when the worker service has a real overlay. Null means "tier not checkable from this
 * session", never "tier empty", and the model softens rather than flagging.
 */
export function collectGraphInputs({
  triggers,
  globalPiDir = null,
  readFolder = readFolderSkills,
  readInjected = readInjectedSkills,
  readOverlay = readOverlaySkills,
  readStaged = readStagedSkillsList,
} = {}) {
  const out = { folderSkills: {}, injectedSkills: {}, overlaySkills: null, stagedSkills: null, foldersTruncated: false };
  if (!Array.isArray(triggers)) return out;
  const folders = [];
  const injectedDirs = [];
  for (const t of triggers) {
    if (t?.type === "cron" && typeof t.folder === "string" && t.folder !== "" && !folders.includes(t.folder)) folders.push(t.folder);
    if (typeof t?.skillsDir === "string" && t.skillsDir !== "" && !injectedDirs.includes(t.skillsDir)) injectedDirs.push(t.skillsDir);
  }
  out.foldersTruncated = folders.length > GRAPH_LIMITS.maxFoldersScanned;
  for (const folder of folders.slice(0, GRAPH_LIMITS.maxFoldersScanned)) {
    out.folderSkills[folder] = readFolder({ folder });
  }
  for (const dir of injectedDirs.slice(0, GRAPH_LIMITS.maxFoldersScanned)) {
    out.injectedSkills[dir] = readInjected({ skillsDir: dir });
  }
  if (typeof globalPiDir === "string" && globalPiDir !== "") {
    out.overlaySkills = readOverlay({ globalPiDir });
    out.stagedSkills = readStaged({ globalPiDir });
  }
  return out;
}

/**
 * The repositories each forge's records actually ran against in the window: `target` is the id-only
 * `repo#n` / `project!iid` string every runs view already shows, so the repo half is admissible
 * anywhere the record is. This is the graph's answer to "which repos is the forge group even about"
 * -- a github trigger's config names no repository (routing is the installation's), so the honest
 * source is history, labelled as such by the consumer. Pure over parsed records; capped per forge.
 */
export function forgeRepoTargets({ records } = {}) {
  const byKind = {};
  if (!Array.isArray(records)) return byKind;
  for (const record of records) {
    if (!isForgeKind(record?.kind) || typeof record?.target !== "string") continue;
    // One stripping grammar, shared with the cost fold's byRepo (costs.mjs repoOfTarget).
    const repo = repoOfTarget(record.target);
    if (repo === null || repo === record.target) continue; // no numeric tail: not a repo-shaped target
    (byKind[record.kind] ??= new Set()).add(repo);
  }
  return Object.fromEntries(
    Object.entries(byKind).map(([kind, set]) => [kind, [...set].sort().slice(0, GRAPH_LIMITS.maxReposListed)]),
  );
}

/** Escape a string for literal use inside a RegExp source (the cron id join above). */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The sanitized ids present in the logs dir (from `*.json` filenames), for `logs <id>` autocomplete. */
export function listRunIds({ logsDir, fs = nodeFs }) {
  let names;
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
}

function readJsonFile(path, fs) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return null; // ENOENT (reaper raced us) or unreadable: skip, do not fail the whole listing
  }
  try {
    return JSON.parse(text);
  } catch {
    return null; // a partial write / non-JSON line: skip
  }
}

function byEndedAtDesc(a, b) {
  const ae = a?.endedAt ?? null;
  const be = b?.endedAt ?? null;
  if (ae === be) return 0;
  if (ae === null) return 1; // nulls last
  if (be === null) return -1;
  return ae < be ? 1 : -1; // ISO-8601 strings sort lexically; descending
}

function clampLimit(limit) {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 10;
  return Math.min(50, Math.max(1, n));
}

function clampLines(lines) {
  const n = Number.isFinite(lines) ? Math.floor(lines) : 200;
  return Math.min(2000, Math.max(1, n));
}

// ---------------------------------------------------------------------------------------------------------------------
// THE FLEET READER (issue #641): the one 1 s snapshot of the deployment, shared by the `/dispatch` TUI and the console.
//
// MOVED here from `dashboard.ts` (`createDashboardDeps` and its `fetchSnapshot`), not rewritten: the TUI's tests pass
// unchanged against it, which is the proof. It lives in the read model because a second surface needed it, and a copy
// in the console would have been a third reader of the same keys (the precedent `heldJobs` below already paid for once,
// with a source-text parity test to police the copy). Everything below the move is additive: fields the TUI does not
// read, and the console's page readers.
// ---------------------------------------------------------------------------------------------------------------------

// Fetch the read-model's full window (listRuns clamps at 50); the TUI renders a cursor-following viewport of it.
const RUNS_ON_DASHBOARD = 50;

/** How many held rows the panel will hold at once. The section shows fewer; the rest are counted, not lost. */
const HELD_LIMIT = 20;

// The FAILED surface's bounds (issue #289): how many failed jobs each queue is asked for, and how many the drill view
// shows fleet-wide. The held section's own posture, one surface over.
const FAILED_PER_QUEUE = 20;
const FAILED_LIMIT = 20;

/**
 * The most active jobs a reader may ask each queue for (issue #641), the console's `activeLimit`. The TUI reads one
 * (`activeLimit` 1, its old `getActive(0, 0)`: it shows the first id alone); the console lists every running job,
 * bounded so a queue with a runaway concurrency cannot turn a 1 s tick into an unbounded hydration.
 */
const ACTIVE_PER_QUEUE_MAX = 50;

/**
 * The belt over a failedReason before it may enter the snapshot (issue #289). The reason is the error message the
 * WORKER itself threw -- the sources were de-payloaded at their sites (branch.mjs answers with a type, prepare-local
 * basenames its path) -- but the reader must hold the property locally rather than by trusting every future throw
 * site: control bytes (ANSI included) become spaces (`panel.mjs`'s class, see `scrubControl` in `dashboard.ts`), and
 * the length is capped at the `job_failed` line's own 120 (start.mjs's precedent). Applied in the reader, so the raw
 * string never reaches a surface.
 */
function scrubReason(reason) {
  if (typeof reason !== "string" || reason === "") return "-";
  return scrubControls(reason).slice(0, 120);
}

/** A decimal non-negative safe integer as a hash holds one (text), or as a number; null for anything else. */
function decimalOf(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * An instant in ms (issue #737): `decimalOf`, and at most the leaf's `DEFER_TIME_MAX_MS`, the last instant every
 * surface can draw, else null. Every instant this reader hands on from a hash is held to it (a hold's clock and its
 * `after`, an answer's `at`, a job's enqueue instant), as `parseDefer` holds a record's, so no row carries an instant
 * a page has no date for: these hashes live in a Valkey anything with its URL writes.
 */
function instantOf(value) {
  const n = decimalOf(value);
  return n !== null && n <= DEFER_TIME_MAX_MS ? n : null;
}

/** How many of a hold's per-profile answers a row carries (issue #737): the console names at most this many. */
const HELD_ANSWERS_MAX = 4;

/**
 * A hold's last answer per wait profile (issue #737), from the worker's `a:<profile>` fields (`<answer>:<ms>`, written by
 * `noteAnswer`): `[{ profile, answer, at }]`, sorted by profile, at most `HELD_ANSWERS_MAX`. A field whose profile, answer
 * or instant fails the worker's own rule is dropped, never shown: the hash lives in a Valkey anything with its URL writes.
 */
function heldAnswersOf(h) {
  const out = [];
  for (const [field, value] of Object.entries(h ?? {})) {
    if (!field.startsWith(WAIT_ANSWER_PREFIX) || typeof value !== "string") continue;
    const profile = field.slice(WAIT_ANSWER_PREFIX.length);
    const cut = value.indexOf(":");
    if (!WAIT_PROFILE_FIELD_RE.test(profile) || cut < 0) continue;
    const answer = value.slice(0, cut);
    const at = instantOf(value.slice(cut + 1));
    if (!WAIT_ANSWERS.includes(answer) || at === null) continue;
    out.push({ profile, answer, at });
  }
  out.sort((a, b) => (a.profile < b.profile ? -1 : a.profile > b.profile ? 1 : 0));
  return out.slice(0, HELD_ANSWERS_MAX);
}

/**
 * The held-jobs read, on the reader's own held client. A thin twin of `readHeldJobs` above -- duplicated because that
 * one opens its own connection per call, and the reader refreshes every second off one it already holds. Field-for-field
 * identical to it apart from `after` (the `after` instant the hold waits for, issue #737) and `answers` (each profile's
 * last answer, `heldAnswersOf`), which the console's rows read and the tool's listing does not. (`HELD_HYDRATE_MAX` is
 * that reader's own ceiling.)
 */
async function heldJobs(redis, { prune = true } = {}) {
  const ids = await redis.smembers("wait:held");
  const at = Date.now();
  const hydrated = await Promise.all(
    ids.slice(0, HELD_HYDRATE_MAX).map(async (jobId) => {
      try {
        const h = await redis.hgetall(`wait:job:${jobId}`);
        if (!h || !h.since) {
          // Stale index member: prune as we go, which is what makes an index safe when a SET cannot expire. Not on a
          // read-only reader (the console's): the row is skipped the same and left for the TUI or the worker to prune.
          if (prune) await redis.srem("wait:held", jobId).catch(() => {});
          return null;
        }
        const since = Number(h.since);
        return {
          jobId,
          target: h.target || null,
          label: h.label || null,
          waitedMs: Number.isFinite(since) && since > 0 ? Math.max(0, at - since) : null,
          checks: decimalOf(h.checks) ?? 0,
          after: instantOf(h.after),
          answers: heldAnswersOf(h),
        };
      } catch {
        return null; // one unreadable member degrades one row, never the section
      }
    }),
  );
  const rows = hydrated.filter(Boolean);
  rows.sort((a, b) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1));
  return { rows: rows.slice(0, HELD_LIMIT), more: Math.max(0, rows.length - HELD_LIMIT), truncated: ids.length > HELD_HYDRATE_MAX };
}

/**
 * How long the reader keeps one scan of the run records for the dollar windows (issue #501, part 7). A month window
 * folds up to a month of records, which is a directory walk, and the reader refreshes every second: the counters are
 * read every tick (they are what the next job is admitted against), the records' side at most this often. The local
 * run index below (issue #641) is cached for the same span and the same reason.
 */
const DOLLAR_RECORDS_TTL_MS = 15_000;

/**
 * A registry row as the snapshot carries it (issue #596 phase 3, issue #599 phase 3): the budget pair and what its jobs
 * hold (the PROJECTS view), and the slot count, the budget's running and waiting counts, the running jobs, the row's
 * age and whether it routes (the HOSTS view). Projected to these keys, so nothing else a row carries reaches the panel.
 * The jobs go through the worker's own allowlist again (`parseLiveJobs`, which takes the reader's parsed list too): a
 * row is another host's text, and a reader handed in by a caller may not have parsed it. An entry the allowlist drops
 * joins `jobsMore`, and a value that is there and is not a list is `jobsUnreadable`, never an empty list.
 */
function hostRowOf(h) {
  const live = parseLiveJobs(h?.jobs);
  const more = parseJobsMore(h?.jobsMore);
  return {
    name: h?.name,
    ...Object.fromEntries(["version", "startedAt", "pid", "image", "imageDigest", "piVersion", "tz", "fpCron", "fpUsd", "fpProjects", "fpEnvelope", "budgetSeed"].map((key) => [key, typeof h?.[key] === "string" || Number.isSafeInteger(h?.[key]) ? h[key] : null])),
    sandboxes: parseSandboxes(h?.sandboxes),
    sandboxesMore: parseJobsMore(h?.sandboxesMore),
    sandboxRetentionHours: parseJobsMore(h?.sandboxRetentionHours),
    budgetFrom: parseBudgetFrom(h?.budgetFrom),
    cpuReserve: parseCpuReserve(h?.cpuReserve),
    budgetMemMiB: h?.budgetMemMiB,
    budgetCpuCenti: h?.budgetCpuCenti,
    usedMemMiB: h?.usedMemMiB,
    usedCpuCenti: h?.usedCpuCenti,
    heldMemMiB: h?.heldMemMiB,
    heldCpuCenti: h?.heldCpuCenti,
    concurrency: h?.concurrency,
    budgetRunning: h?.budgetRunning,
    waiters: h?.waiters,
    jobs: live.jobs,
    jobsMore: live.jobs === null ? more : (more ?? 0) + live.dropped,
    jobsUnreadable: h?.jobsUnreadable === true || (live.jobs === null && h?.jobs !== undefined && h?.jobs !== null && h?.jobs !== ""),
    staleMs: Number.isSafeInteger(h?.staleMs) && h.staleMs >= 0 ? h.staleMs : null,
    // Issue #737: what Valkey's own clock says of the row (`readLiveHosts`, INT-HOST-REGISTRY-CONTRACT): how long ago the
    // row's expiry was last set (`ttlAgeMs`, a duration on Valkey's clock), this console's clock minus the host's beyond
    // that (`skewMs`, positive when the host is behind), and whether the row has no expiry at all. Re-checked like
    // `staleMs`: a reader handed in by a caller may not have judged them, and null is "not known", never 0 or false.
    ttlAgeMs: Number.isSafeInteger(h?.ttlAgeMs) && h.ttlAgeMs >= 0 ? h.ttlAgeMs : null,
    skewMs: Number.isSafeInteger(h?.skewMs) ? h.skewMs : null,
    noExpiry: h?.noExpiry === true ? true : h?.noExpiry === false ? false : null,
    routes: h?.routes,
    // Issue #712: the profiles this host advertises (`s:<profile>`, `w:<profile>`), through the worker's own allowlist and
    // sorted, so two ticks of one row compare equal; and its venues (`parseHostBackends`: the blessed list, the default,
    // the floor and the OpenShell engine and gateway word, or null for a worker from before the field). Both are another
    // host's text, re-checked here for `jobs`' reason.
    caps: [...parseCaps(h?.caps)].sort(),
    backends: parseHostBackends(typeof h?.backends === "string" ? h.backends : null),
    // Whether the row publishes a capability list at all (an older worker publishes none), so a reader can tell "this
    // host advertises nothing" from "this host says nothing"; `caps` alone is always an array.
    capsSeen: typeof h?.caps === "string",
  };
}

/** The host a reader runs on, as the worker names itself (`workerName`), or null for a name the worker refuses. */
function doctorSelfName(env) {
  try {
    return workerName({ PI_WORKER_NAME: typeof env?.PI_WORKER_NAME === "string" ? env.PI_WORKER_NAME : undefined });
  } catch {
    return null;
  }
}

/** How long the reader waits on the registry before drawing the fleet it last knew. */
const FLEET_READ_TIMEOUT_MS = 2_000;

/**
 * The most queues a switch preview reads (issue #737): `snapshot({ switchQueues: true })` reads a queue's paused flag,
 * counts, schedulers, active and failed jobs, one BullMQ queue (a connection) each, over the queues the kill switch
 * flips, and a keyspace scan names every `bull:pi-jobs@<name>:meta` key it finds, whoever wrote it: 2,000 planted keys
 * made a preview of 2,003 connections and a summary line of 134,000 characters. 200 is far past any fleet this project
 * runs. The SWITCH still flips every queue (`switchQueues`, unbounded, as the kill switch must be); only the preview's
 * reads stop here, and the snapshot says it did (`switchTruncated`, `switchTotal`).
 */
export const SWITCH_PREVIEW_QUEUES_MAX = 200;

/** Why a switch's set of queues may be short (`switchIncomplete`): the keyspace scan behind it did not finish. */
export const SWITCH_SCAN_INCOMPLETE = "the scan for the deployment's queues did not finish";

/**
 * The wide window the fleet reader folds `parked` and `failures24h` from (issue #641): the newest runs of the local
 * index and the mirror, merged, at most this many. Wider than the TUI's 50 because a parked run waits for a person and
 * may be days old; bounded because it is read on the tick (at most once per `DOLLAR_RECORDS_TTL_MS`).
 */
const WIDE_RUNS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The deployment's live snapshot, on ONE redis client and a pool of failFast queues, both created here and closed once
 * in `dispose` (the `/dispatch` panel's reader since issue #57, moved here by issue #641). `snapshot()` reads the whole
 * fleet in one pass off those held connections; `pause`/`resume` flip the durable paused state on the same pool, and
 * `cancelActive` raises the CLI's cancel request on the same client, so a surface holding a reader holds no second
 * connection for its kill switch. `getWorkers` is EMPTY on Redis providers without CLIENT SETNAME, so an error or empty
 * list degrades to "unknown" rather than reporting zero live workers.
 *
 * Every module-level dependency it uses to talk to Valkey is injectable, defaulting to the real one, because this
 * factory had no test at all -- and that is exactly how it came to build its own single queue and do its own pausing
 * while the fleet-aware readers sat unused beside it. The kill switch is the last place a silent no-op should hide.
 * `fs` (issue #641) reads the local run index and the session store's chain counter; `paths.sessionsDir` (optional) is
 * the worker's `PI_SESSIONS_DIR` when it is on this host.
 *
 * Two behaviour options sit beside the seams (issue #641), both defaulting to the TUI's behaviour:
 *   - `readOnly` (default false): `snapshot()` issues NO Valkey write. The three reads that prune as they go (the
 *     registry's stale members, the run mirror's expired ids and its horizon, the held index's stale members) skip the
 *     stale entry the same and leave it for a pruning reader (the TUI, the worker). The console passes true, because
 *     a page view that writes is a read that needs a writer's care. What it does NOT cover: BullMQ's own `Queue`
 *     constructor writes the queue's meta hash (`version`, `opts.maxLenEvents`) once per queue built, which
 *     `makeQueue` does not let a caller turn off; and `pause`, `resume` and `cancelActive` are writes by definition.
 *   - `activeLimit` (default 1, at most `ACTIVE_PER_QUEUE_MAX`): how many active jobs each queue is asked for. One is
 *     the TUI's old cost (it shows the first id); the console passes 50 to list them all.
 *
 * The waiting jobs are asked for per call, never per reader (issue #737): `snapshot({ waiting: true })` adds `waiting`,
 * the fleet's waiting jobs and why each waits (`readWaiting`), and `snapshot()` reads none and has no such field. One
 * reader serves every page of the console and its `/api/state`, and only the overview draws a waiting job, so a reader
 * built to read them would make the fleet, parked and config pages and every `/api/state` pay for a read none of them
 * draws. The read is shared by every call that asks: at most once per `WAITING_TTL_MS` for the same queues, caught as
 * a unit (`{ unreachable: true }`, no error text, kept for the window as a good read is), so a second overview tab
 * inside the window reads nothing. Its queues are every queue that EXISTS, not only the registry's: the registry's
 * first, then the keyspace discovery the planners use (kept for `WAITING_DISCOVERY_TTL_MS`, and served while the next
 * scan runs), so a stopped host's queued jobs are read, at most `WAITING_QUEUES_MAX` queues. Read-only whatever
 * `readOnly` says: it reads ids, scores, a job hash's short scalar fields and the worker's own hashes.
 */
export function createFleetReader(
  paths,
  {
    makeQueueFn = makeQueue,
    parseConnectionFn = parseConnection,
    redisFn = makeRedisClient,
    readLiveHostsFn = readLiveHosts,
    discoverHostQueuesFn = discoverHostQueuesReporting,
    // The env the deployment's dollar caps are read from (issue #501, part 7): the console's `deploymentEnv()`, whose
    // pointer reads the deployment's `.env`. Empty by default, so a test or a caller that passes none sees the
    // overlay's caps alone.
    dollarEnvFn = () => ({}),
    scanRecordsFn = scanRunRecords,
    nowFn = () => Date.now(),
    fs = nodeFs,
    readOnly = false,
    activeLimit = 1,
    // Issue #642: the kill switch's decision for `pause`/`resume` (`killSwitchPlan`'s shape: `({ paused }) => { refused }
    // | { urls, disagreement, context }`). The default is this reader's own Valkey alone, which is what `pause` did
    // before; a surface that knows its deployment passes the real plan (the TUI: `killSwitchPlan`, over the pointer),
    // so the two-Valkey refusal holds there exactly as it does for the tools.
    killSwitchPlanFn = null,
    // Issue #712: the published doctor results' read (`readDoctorResults`), a seam so a test hands rows without a Valkey.
    readDoctorResultsFn = readDoctorResults,
    // Issue #710: the panel's sandbox manifest verdict (`sandboxRetentionOf`, admin/src/sandbox-verdict.mjs), a seam
    // rather than an import because that module imports this one (`sandboxShellRefusal`), and the read model is
    // imported by modules held to a small graph (insights-assembly, write-plans). Null: `sandboxCheck` cannot tell, so
    // the run page keeps the command. The console passes the real one.
    sandboxRetentionFn = null,
    readSandboxInventoriesFn = readSandboxInventories,
    readSandboxSessionsFn = readSandboxSessions,
    requestSandboxEndFn = requestSandboxEnd,
    makeSandboxPrepareQueueFn = null,
    enqueueSandboxPreparationFn = null,
    readSandboxPreparationFn = null,
  } = {},
) {
  const prune = readOnly !== true;
  const activePerQueue = Number.isSafeInteger(activeLimit) ? Math.min(Math.max(activeLimit, 1), ACTIVE_PER_QUEUE_MAX) : 1;
  const queue = makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }));
  const redis = redisFn(paths.valkeyUrl);
  const sandboxQueues = new Map();
  const sandboxQueue = (host) => {
    if (typeof host !== "string" || !WORKER_NAME_RE.test(host)) throw new Error("a sandbox request needs a worker name");
    if (!sandboxQueues.has(host)) sandboxQueues.set(host, makeSandboxPrepareQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }), { host }));
    return sandboxQueues.get(host);
  };
  const watchStore = makeWatchStore(redis, { now: nowFn });
  const watch = { ...watchStore,
    async listSources() {
      let config;
      try { config = JSON.parse(fs.readFileSync(paths.triggersPath, "utf8")); } catch { throw new Error("watch configuration unreadable"); }
      const sources = config.watchSources ?? {};
      return Object.entries(sources).slice(0, 256).map(([id, source]) => ({ id, verify: source.verify, maxBodyBytes: source.maxBodyBytes, maxPerDay: source.maxPerDay }));
    },
    async listRules() {
    const configured = readTriggers({ triggersPath: paths.triggersPath, fs });
    if (configured.invalid) throw new Error("watch configuration unreadable");
    const rules = (configured.triggers ?? []).filter((t) => t.type === "watch");
    const observed = await watchStore.listRules();
    const merged = new Map(observed.map((r) => [r.id, r]));
    for (const rule of rules) merged.set(rule.id, { ...merged.get(rule.id), ...rule });
    return [...merged.values()];
  } };

  // EVERY named host drains a queue of its own, so the four things this reader does with a queue -- count, list
  // schedulers, pause, resume -- have to span them. Doing it here rather than through the fleet-aware one-shots above
  // because this reader is connection-first: it holds its clients for its whole life and a per-tick open/close of N
  // queues is the quiet load a dashboard must not add.
  const pool = new Map([[queue.name, queue]]);
  // The last set we successfully resolved. On an unreachable registry the fleet does NOT shrink to the shared queue:
  // that would silently pause half a deployment and print success, which is the failure this whole surface exists to
  // prevent. We keep what we last saw and mark the snapshot degraded instead.
  let lastNames = [queue.name];
  let fleetDegraded = null;
  // The registry rows last read (issue #596, phase 3): each live host's published budget and what its jobs hold, for
  // the PROJECTS view's size suggestions and its budget line. Kept like `lastNames` on an unreachable registry.
  let lastHosts = [];
  // When `lastHosts` was read (issue #737), on the reader's clock, or null before the first read: a sibling rather than a
  // property of the array, because `lastHosts` is reassigned on every good read and a property on it would go with it.
  // The snapshot's `hostsReadAt`, so a surface drawing the rows of a registry it could not read this tick says how old
  // they are.
  let lastHostsAt = null;

  const fleetQueues = async () => {
    const fleet = await readLiveHostsFn(redis, { timeoutMs: FLEET_READ_TIMEOUT_MS, prune }).catch((err) => ({
      unreachable: err?.message ?? String(err),
    }));
    if (fleet?.unreachable || !Array.isArray(fleet?.hosts)) {
      fleetDegraded = fleet?.unreachable ?? "registry unreadable";
    } else {
      fleetDegraded = null;
      lastNames = fleetQueueNames(fleet.hosts);
      lastHosts = fleet.hosts;
      lastHostsAt = nowFn();
    }
    for (const name of lastNames) {
      if (!pool.has(name)) pool.set(name, makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }), { name }));
    }
    // A host that left keeps its queue open until dispose. Closing it here would race a pause already in flight
    // against it, and an idle BullMQ Queue costs one connection -- cheaper than that race.
    return lastNames.map((n) => pool.get(n));
  };

  // One job by id across the fleet's queues (the first that knows it): the Job, null when no queue holds it, or undefined
  // when that cannot be said. Its `.data` stays with the caller in this file. The queues are the by-id lookup's
  // (`lookUp`: the registry's and the queues that exist), never the per-tick registry set, so a host that left the
  // registry still has its queue asked (issue #710). A set that is not whole (the registry or the keyspace scan unread,
  // the set cut, or no scan since the question) turns "no queue holds it" into undefined, which the checks report as
  // unreachable, so the page falls back to the record alone. `lookup` is the question's (`lookUp`: a live load's, or a
  // request's shared one). Bounded by twice the read timeout in all.
  const retainedJob = async (jobId, lookup) => {
    const ask = async ({ queues, whole }) => {
      for (const q of queues) {
        if (typeof q?.getJob !== "function") continue;
        const job = await q.getJob(jobId);
        if (job) return job;
      }
      return whole ? null : undefined;
    };
    const found = (job) => (job ? true : job === null ? false : null);
    return withTimeout(lookUp(ask, found, { ...questionOf(lookup), key: jobId }), 2 * FLEET_READ_TIMEOUT_MS, undefined);
  };

  // The KILL SWITCH's set, which is not the per-tick set. A registry row is a lease that expires ninety seconds after a
  // host stops writing, while that host's queue and its paused flag are permanent -- so pausing off the registry alone
  // misses a host that has gone quiet but is still draining, and resuming off it leaves that host's queue paused
  // forever with nothing able to name it. The union adds a SCAN of BullMQ's own meta keys, which is far too expensive
  // for a reader that runs every second and entirely affordable for a keypress. `{ names, incomplete }`: the union's
  // names, and whether the scan behind them read the whole keyspace (issue #737: `SWITCH_SCAN_INCOMPLETE`, or null).
  // Names only: a queue is built for a name when it is flipped or read, never for every name a scan returns.
  const killSwitchNames = async () => {
    // The seam answers `discoverHostQueuesReporting`'s shape or a bare list, which reads as whole (`fleetQueuesOn`'s
    // reading); a part-read keyspace still pauses what it read, and the preview says the set may be short.
    const got = await discoverHostQueuesFn(redis, { timeoutMs: FLEET_READ_TIMEOUT_MS });
    const existing = Array.isArray(got) ? got : Array.isArray(got?.names) ? got.names : [];
    const whole = Array.isArray(got) || (Array.isArray(got?.names) && (got.incomplete === null || got.incomplete === undefined));
    return { names: unionQueueNames(lastNames, existing), incomplete: whole ? null : SWITCH_SCAN_INCOMPLETE };
  };

  // The pool's queue for each name, built where it has none.
  const queuesNamed = (names) =>
    names.map((name) => {
      if (!pool.has(name)) pool.set(name, makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }), { name }));
      return pool.get(name);
    });

  // The queues a fleet pause or resume flips, read now: the registry afresh (so `lastNames` is this read's), then the
  // keyspace unioned onto it. ONE function for the switch (`poolSet`) and for the snapshot that previews a fleet or a
  // queue write (`snapshot({ switchQueues: true })`, issue #737), so a preview names, and its Undo pauses again, the
  // queues the write reaches: a stopped host's queue the registry no longer names included.
  const switchQueueNames = async () => {
    await fleetQueues();
    return killSwitchNames();
  };
  const switchQueues = async () => queuesNamed((await switchQueueNames()).names);

  // What a switch preview reads (issue #737): the queues the switch flips, in its order, at most
  // `SWITCH_PREVIEW_QUEUES_MAX` of them, and `queue` (a one-queue preview's) wherever it stands among them, so a
  // preview of a queue past the bound still reads that queue. `{ queues, total, truncated, incomplete }`. On a set past
  // the bound, WHICH queues are read goes by what they are: the shared queue and the registry's (live hosts, this
  // read's `lastNames`) first, then the queues only the keyspace scan names, in name order, so a fleet's live queues
  // are never the ones a planted `bull:pi-jobs@<name>:meta` key per name pushes out. They are drawn in the switch's
  // order either way.
  const switchPreviewQueues = async (queue) => {
    const { names, incomplete } = await switchQueueNames();
    const flipped = new Set(names);
    const chosen = new Set([...new Set([...lastNames, ...names])].filter((n) => flipped.has(n)).slice(0, SWITCH_PREVIEW_QUEUES_MAX));
    if (typeof queue === "string" && flipped.has(queue)) chosen.add(queue);
    const read = names.filter((n) => chosen.has(n));
    return { queues: queuesNamed(read), total: names.length, truncated: read.length < names.length, incomplete };
  };

  // Flip every kill-switch queue on THIS reader's Valkey through the held pool, `setQueuePaused`'s result shape.
  const poolSet = async (paused) => {
    const done = [];
    for (const q of await switchQueues()) {
      try {
        if (paused) await q.pause();
        else await q.resume();
      } catch (err) {
        return { unreachable: err?.message ?? String(err), partial: { done, failed: q?.name ?? "-", error: err?.message ?? String(err) }, ...(fleetDegraded ? { blind: fleetDegraded } : {}) };
      }
      done.push(q?.name ?? "-");
    }
    return { ok: true, paused, queues: done, ...(fleetDegraded ? { blind: fleetDegraded } : {}) };
  };
  const killSwitch = async (paused) => {
    const plan = killSwitchPlanFn ? killSwitchPlanFn({ paused }) : { urls: [paths.valkeyUrl], disagreement: null, context: null };
    return killSwitchSet({ paused, plan, setFn: (args) => (args.url === paths.valkeyUrl ? poolSet(paused) : setQueuePaused(args)) });
  };

  // The last records scan for the dollar windows, `{ at, sinceMs, records }`, reused for DOLLAR_RECORDS_TTL_MS.
  let dollarRecords = null;
  const dollarWindows = async (overlay, limits) => {
    const now = new Date(nowFn());
    const { caps, jobCapMicros, invalid } = deploymentDollarCaps(overlay ?? {}, dollarEnvFn() ?? {});
    const specs = dollarWindowSpecs({ caps, limits, now });
    if (specs.length === 0) return invalid.length > 0 ? { rows: [], invalid } : null;
    // The COUNTERS every tick, in ONE MGET on the held client: spent and held, what the worker admits against.
    const counters = await redis.mget(...specs.map((s) => s.key)).then(
      (values) => Object.fromEntries(specs.flatMap((s, i) => (values?.[i] === null || values?.[i] === undefined ? [] : [[s.key, Number(values[i])]]))),
      (err) => ({ unreachable: err?.message ?? String(err) }),
    );
    const sinceMs = dollarWindowsSinceMs(specs, now);
    if (!dollarRecords || dollarRecords.sinceMs !== sinceMs || now.getTime() - dollarRecords.at >= DOLLAR_RECORDS_TTL_MS) {
      const scanned = scanRecordsFn({ logsDir: paths.logsDir, sinceMs, nowMs: now.getTime() });
      dollarRecords = { at: now.getTime(), sinceMs, records: Array.isArray(scanned) ? scanned : [] };
    }
    return { rows: dollarWindowRows({ specs, counters, records: dollarRecords.records, jobCapMicros }), ...(invalid.length > 0 && { invalid }) };
  };

  // Issue #641: this host's run records, indexed once per DOLLAR_RECORDS_TTL_MS (the dollar records' rhythm), for the
  // wide window here and for `runsPage` below, so neither walks the logs directory on every tick or every request.
  const localIndex = makeLocalRunIndex({ logsDir: paths.logsDir, fs, now: nowFn });
  // The wide window, `{ at, runs, mirror }`, refreshed at the same rhythm. The mirror is read READ-ONLY (`prune:
  // false`) on every reader: the TUI's per-tick `mergedRunsOn` already prunes, and a second pruning read would only
  // race it.
  let wide = null;
  // The read of the wide window in flight, if one is (issue #737): every caller that finds the cache expired while it
  // runs waits on this one read instead of starting its own. Since the console's pages read the navigation's Parked
  // count off this window (`parkedCount`) beside the live hub's snapshots, several requests can arrive in the same
  // instant the cache runs out, and each would otherwise make its own mirror read of WIDE_RUNS runs. Cleared when it
  // settles, so a read that failed is retried by the next caller, never handed out again.
  let wideRead = null;
  // The last pending-answer scan for the parked rows (issue #647), `{ at, key, got }`, reused for DOLLAR_RECORDS_TTL_MS.
  let parkedPending = null;
  const wideRuns = async () => {
    const at = nowFn();
    if (wide && at >= wide.at && at - wide.at < DOLLAR_RECORDS_TTL_MS) return wide;
    if (wideRead !== null) return wideRead;
    const read = (async () => {
      const local = localIndex.records();
      const { runs: mirrored, degraded } = await readMirroredRuns(redis, { limit: WIDE_RUNS, prune: false, timeoutMs: FLEET_READ_TIMEOUT_MS });
      const runs = mergeRuns(Array.isArray(local?.records) ? local.records : [], mirrored, { limit: WIDE_RUNS });
      // Either side unread makes the window partial: a parked run on that side would be missing without a word.
      const partial = local?.unreachable ?? (typeof degraded === "string" && degraded.startsWith("unreachable") ? "the run mirror could not be read" : null);
      wide = { at, runs, mirror: degraded, partial };
      return wide;
    })();
    // Cleared in the first reaction to the read, on either outcome, before any waiting caller resumes. What the callers
    // hold is this derived promise, so a rejection reaches each of them and is handled there, as a direct call's was.
    wideRead = read.then(
      (w) => {
        wideRead = null;
        return w;
      },
      (err) => {
        wideRead = null;
        throw err;
      },
    );
    return wideRead;
  };

  // The published doctor results (issue #712, `INT-DOCTOR-RESULTS-KEY`), `{ at, got }`, read at most once per
  // DOLLAR_RECORDS_TTL_MS: a host publishes once a day, so a per-second MGET would be load for nothing. Read for the
  // index's hosts and the live ones, pruning only where this reader may write.
  let doctorRead = null;
  const doctorResults = async () => {
    const at = nowFn();
    if (doctorRead && at >= doctorRead.at && at - doctorRead.at < DOLLAR_RECORDS_TTL_MS) return doctorRead.got;
    const got = await readDoctorResultsFn(redis, { names: lastHosts.map((h) => h?.name).filter((n) => typeof n === "string"), prune, now: nowFn, timeoutMs: FLEET_READ_TIMEOUT_MS }).catch((err) => ({ unreachable: err?.message ?? String(err) }));
    doctorRead = { at, got };
    return got;
  };

  // The queues that EXIST (issue #737), for the waiting read and the by-id lookups: the keyspace discovery the planners
  // and the kill switch use. `existingQueueNames` (the waiting read's and a request's lookup) scans again at most once
  // per WAITING_DISCOVERY_TTL_MS on the reader's clock; on top of that, a request's lookup that misses over a set whose
  // scan started before its question waits for one scan started after it (`scanSince`, `lookUp`), and a live load's
  // lookup starts none. The registry alone drops a host ninety seconds after it stops, while its queue and the jobs
  // waiting in it stay. `discovered` is the last set a scan settled into, `{ at, seq, names, whole }` (`at` when that
  // scan started, `seq` its place among the scans this reader started, of which `scans` is the count), and
  // `discovering` the scan in flight, `{ seq, settled }`, which every caller in the meantime shares: one scan at a time.
  // A caller of `existingQueueNames` that has a set NEVER waits for a scan, it is handed the last set while the next one
  // runs, so a SCAN that takes its whole bound (FLEET_READ_TIMEOUT_MS) holds no snapshot; only the first, with no set
  // yet, waits for one. A scan that did not finish adds what it read to the last set, and one that failed keeps it: a
  // part-read keyspace never shrinks the set. A clock that went back is no proof the set is fresh. `whole` is false when
  // the scan the set settled from did not read the whole keyspace, so a queue it does not name may still exist.
  let discovered = null;
  let discovering = null;
  let scans = 0;
  const startScan = () => {
    const at = nowFn();
    scans += 1;
    const seq = scans;
    const previous = discovered?.names ?? [];
    const settled = Promise.resolve()
      .then(() => discoverHostQueuesFn(redis, { timeoutMs: FLEET_READ_TIMEOUT_MS }))
      .then((got) => {
        // The seam answers `discoverHostQueuesReporting`'s shape or a bare list (read as whole), as `fleetQueuesOn` does.
        if (Array.isArray(got)) return { names: got, whole: true };
        const list = Array.isArray(got?.names) ? got.names : [];
        return Array.isArray(got?.names) && (got.incomplete === null || got.incomplete === undefined) ? { names: list, whole: true } : { names: unionQueueNames(previous, list), whole: false };
      })
      .catch(() => ({ names: previous, whole: false }))
      .then((set) => {
        discovered = { at, seq, ...set };
        discovering = null;
        return discovered;
      });
    discovering = { seq, settled };
    return settled;
  };
  const existingQueueNames = () => {
    const at = nowFn();
    const fresh = discovered !== null && at >= discovered.at && at - discovered.at < WAITING_DISCOVERY_TTL_MS;
    if (!fresh && discovering === null) startScan();
    return discovered !== null ? discovered : discovering.settled;
  };
  // A set from a scan that started after `asked` (what `scans` was when a question was asked): the last set when its
  // scan did, else the scan in flight when it did, else one started now, after the scan in flight (one at a time).
  const scanSince = async (asked) => {
    for (;;) {
      if (discovered !== null && discovered.seq > asked) return discovered;
      if (discovering === null) startScan();
      else if (discovering.seq > asked) return discovering.settled;
      else await discovering.settled;
    }
  };

  // The queues a job is looked for in by its id (issue #737): the registry's (`registry`, read now), never cut, then the
  // queues the discovery `found` names that the registry does not, in name order, as many as fit beside the registry's
  // in `WAITING_QUEUES_MAX` (each one a BullMQ Queue the pool keeps, and a planted `bull:pi-jobs@<name>:meta` key per
  // name must not buy one), so none when the registry alone names that many. The kill switch's set, the queues a fleet
  // resume would start a job from, so a job waiting on a stopped host's queue is found. `{ queues, whole }`: `whole`
  // false when the registry could not be read now, the discovery did not read the whole keyspace, or the set was cut.
  const lookupSetOf = (registry, registryRead, found) => {
    const named = new Set(registry.map((q) => q?.name));
    const extras = [...new Set(found.names)].filter((n) => typeof n === "string" && !named.has(n)).sort();
    const room = Math.max(0, WAITING_QUEUES_MAX - registry.length);
    return { queues: [...registry, ...queuesNamed(extras.slice(0, room))], whole: registryRead && found.whole && extras.length <= room };
  };

  // The by-id lookup's first set: the registry read now and the kept discovery, `{ registry, registryRead, seq, queues,
  // whole }`, `seq` the discovery's scan. A request's (`live` false) takes the discovery through `existingQueueNames`,
  // which starts its window's scan when the set is older than WAITING_DISCOVERY_TTL_MS; a live load's takes the last set
  // as it is, of any age, or none, and starts no scan. Callers that overlap (a page's rows) share one read, a live one
  // and a request's each their own: one registry read and one discovery per load, never one per row.
  const lookupReads = { live: null, request: null };
  const NO_DISCOVERY = Object.freeze({ seq: 0, names: [], whole: false });
  const jobQueues = (live) => {
    const slot = live ? "live" : "request";
    if (lookupReads[slot] === null) {
      lookupReads[slot] = (async () => {
        const registry = await fleetQueues();
        const registryRead = fleetDegraded === null;
        const found = live ? (discovered ?? NO_DISCOVERY) : await existingQueueNames();
        return { registry, registryRead, seq: found.seq, ...lookupSetOf(registry, registryRead, found) };
      })().finally(() => {
        lookupReads[slot] = null;
      });
    }
    return lookupReads[slot];
  };

  // The job ids a request's lookup last found absent (issue #737), oldest first, at most LOOKUP_TOLD_MAX of them, so
  // ids a caller makes up cannot grow it: an id leaves when a request's lookup finds its job, or when that many ids were
  // found absent after it. A live load's lookup asks its set as whole for these ids alone (`lookUp`).
  const toldAbsent = new Set();
  const tell = (key, verdict) => {
    if (typeof key !== "string") return;
    if (verdict !== false) toldAbsent.delete(key);
    if (verdict !== false) return;
    toldAbsent.delete(key);
    toldAbsent.add(key);
    if (toldAbsent.size > LOOKUP_TOLD_MAX) toldAbsent.delete(toldAbsent.values().next().value);
  };

  // A caller's question (issue #737), as `lookUp` takes it: `{ live: true }` (a live load's), `{ asked }` (a request's,
  // the reader's `lookupQuestion`), or none (a request asked now).
  const questionOf = (lookup) => ({ live: lookup?.live === true, asked: Number.isSafeInteger(lookup?.asked) ? lookup.asked : null });

  // One by-id question (issue #737) about the job `key` names: `ask({ queues, whole })` answers it over a set of queues,
  // and `found(answer)` reads the answer: true (a queue holds the job), false (absent: none does, the set whole), null
  // (none of the queues asked does, and they may not be all of them) or anything else (the read failed).
  //
  // A REQUEST'S LOOKUP (`live` false: a page GET, `/api/run`). A JOB IS ABSENT ONLY FROM A SET READ AFTER THE QUESTION
  // WAS ASKED (`asked`, the load's `lookupQuestion`, else now). The kept discovery serves every hit at once; a miss
  // over one whose scan started before the question is asked again over a scan that started after it (`scanSince`,
  // beside the registry already read), since a queue made after that scan (a local run onto a new or a stopped host's own
  // queue) is in no set it settled into, and an idle console's set may be hours old. So a question costs at most one
  // scan, which every question asked before it started shares: one page load's lookups, which pass one `asked`, cost
  // one in all. `tellAbsent` false answers such a miss as it stands, not whole, for a caller to which an absence makes no
  // difference (`chatFactsOf` for a run with a record). The scan is waited for at most twice its budget (the one in
  // flight, then its own); one that does not settle in it leaves the first answer. A set that could not be built is not
  // whole. What the answer says of the job is kept for a live load's lookups (`tell`).
  //
  // A LIVE LOAD'S LOOKUP (`live` true: the hub's, every tick a page is open) STARTS NO SCAN and never makes an absence
  // of its own: it asks the registry read now and the last discovery, as whole only for a job a request's lookup last
  // found absent (`toldAbsent`), so a page's live loop keeps saying what its request was told, and a miss over any other
  // id is `found: null`. A job a queue in that set holds is found either way.
  const lookUp = async (ask, found, { key = null, live = false, asked = null, tellAbsent = true } = {}) => {
    const since = Number.isSafeInteger(asked) && asked >= 0 && asked <= scans ? asked : scans;
    const told = live === true && typeof key === "string" && toldAbsent.has(key);
    const answerOf = async (set) => {
      try {
        return await ask(set);
      } catch (error) {
        if (!live) tell(key, null);
        throw error;
      }
    };
    let kept;
    try {
      kept = await jobQueues(live === true);
    } catch {
      const answer = await answerOf({ queues: lastNames.map((n) => pool.get(n)), whole: told });
      if (!live) tell(key, found(answer));
      return answer;
    }
    if (live === true) return answerOf({ queues: kept.queues, whole: told });
    const current = kept.seq > since;
    let answer = await answerOf({ queues: kept.queues, whole: kept.whole && current });
    if (!current && tellAbsent && found(answer) === null) {
      const set = await withTimeout(scanSince(since), 2 * FLEET_READ_TIMEOUT_MS, null)
        .then((got) => (got === null ? null : lookupSetOf(kept.registry, kept.registryRead, got)))
        .catch(() => null);
      if (set !== null) answer = await answerOf(set);
    }
    tell(key, found(answer));
    return answer;
  };

  // The waiting jobs (issue #737), `{ at, key, got }`: one `readWaiting` per WAITING_TTL_MS for the same queues (`key`,
  // their names joined), on the reader's clock. The queues are the registry's (`queues`, this tick's) FIRST, then the
  // ones that exist (`existingQueueNames`) that it does not name, in name order, so when `readWaiting` reads only the
  // first WAITING_QUEUES_MAX (and counts the rest, `queuesCut`) a live host's queue is never the one cut while the
  // registry names at most that many. A queue the pool does not hold is read by its name alone, since the read needs
  // only its keys, never a BullMQ Queue of its own (a connection per stopped host). The promise is what is kept, so a
  // snapshot that starts while a read is in flight shares it, and an unreachable answer is kept for the window like any
  // other: a Valkey that times out is sent the whole pipeline once per WAITING_TTL_MS, never on every snapshot. Its
  // `unreachable` is a boolean: no client's words reach a snapshot.
  let waitingCache = null;
  const waitingOf = async (queues, projects, triggers) => {
    const registry = [...new Set(queues.map((q) => q?.name).filter((n) => typeof n === "string"))];
    const found = (await existingQueueNames()).names;
    const names = [...registry, ...[...new Set(found)].filter((n) => typeof n === "string" && !registry.includes(n)).sort()];
    const at = nowFn();
    const key = names.join("\n");
    if (waitingCache && waitingCache.key === key && at >= waitingCache.at && at - waitingCache.at < WAITING_TTL_MS) return waitingCache.got;
    const entry = { at, key, got: null };
    const list = names.map((name) => pool.get(name) ?? { name });
    entry.got = readWaiting(redis, { queues: list, now: nowFn, timeoutMs: FLEET_READ_TIMEOUT_MS, projects, triggers }).catch(() => ({ unreachable: true }));
    waitingCache = entry;
    return entry.got;
  };

  return {
    watch,
    // `waiting` (issue #737): true reads the waiting jobs into the snapshot's `waiting` (see the header); anything else
    // reads none, so a caller that draws no waiting job pays nothing for one.
    // `switchQueues` (issue #737): true reads every per-queue field over the queues the kill switch flips (`switchQueues`:
    // the registry's and every queue that exists), for a preview of a write that reaches them; anything else reads the
    // registry's queues, the set every surface draws. Such a snapshot reads at most `SWITCH_PREVIEW_QUEUES_MAX` of them
    // (and `opts.queue`, a one-queue preview's, wherever it stands), and says so beside them: `switchTotal`, how many the
    // switch flips; `switchTruncated`, true when `queueCounts` holds fewer; `switchIncomplete`, `SWITCH_SCAN_INCOMPLETE`
    // when the keyspace scan behind the set did not finish, else null.
    async triggerSkew(index, waiting) {
      return readTriggerSkew({ index, waiting, triggersPath: paths.triggersPath, fs, lookupJob: async (name, id) => {
        const queues = await fleetQueues();
        const q = queues.find((q) => q.name === name) ?? pool.get(name);
        return q ? q.getJob(id) : null;
      }, timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    async snapshot(opts = {}) {
      const waiting = opts?.waiting === true;
      const preview = opts?.switchQueues === true ? await switchPreviewQueues(opts?.queue) : null;
      const queues = preview !== null ? preview.queues : await fleetQueues();
      // Awaited alongside the queue reads rather than before them: it is two Valkey round trips and the panel already
      // pays for several, so it costs no extra tick.
      const merged = await mergedRunsOn(redis, { logsDir: paths.logsDir, limit: RUNS_ON_DASHBOARD, prune }).catch(() => ({ runs: [], hosts: [], mirror: "off" }));
      // The cron ids this deployment declares, read from the triggers file the same tick already reads SYNCHRONOUSLY.
      // Since issue #267 each scheduler's stall count is its own key, so the reader has to name them -- and naming them
      // from config is the repo's own doctrine for exactly this shape (`scoped-limits.json` enumerates every scope that
      // can carry a claim; `no KEYS, no SCAN, and no index set to leak`). A keyspace scan was measured and refused for
      // `wait:held` and `host:h:*` because the panel reads every second and a scan walks hardest when nothing is
      // registered. With the instructions TEXT beside the view rather than inside it (issue #482): the view's records
      // are the model-callable `dispatch_triggers` result, and the words belong to the overlay alone.
      const { view: triggersView, instructions: triggerInstructions, tasks: triggerTasks } = readTriggersWithInstructions({ triggersPath: paths.triggersPath, includeTasks: true });
      const cronIds = Array.isArray(triggersView?.triggers)
        ? triggersView.triggers.filter((t) => t?.type === "cron" && typeof t?.id === "string" && t.id !== "").map((t) => t.id)
        : [];
      // The projects as the WORKER reads them (issue #499 part C), read here rather than beside the settings below so the
      // waiting read (issue #737) can name a waiting job's project from it.
      const projectsView = readProjects({ projectsPath: paths.projectsFile });
      // Issue #737: the waiting jobs, started now beside the queue reads and awaited at the end (cached, so at most one
      // read per WAITING_TTL_MS). Null when this call did not ask for them.
      const waitingRead = waiting === true ? waitingOf(queues, Array.isArray(projectsView?.projects) ? projectsView.projects : null, Array.isArray(triggersView?.triggers) ? triggersView.triggers : null) : null;
      const [pausedStates, countsPer, workerList, dayRaw, weekRaw, monthRaw, tokenRaw, schedulerLists, activeLists, stallCounts] = await Promise.all([
        Promise.all(queues.map((q) => q.isPaused())),
        Promise.all(queues.map((q) => q.getJobCounts("waiting", "active", "paused", "delayed", "failed"))),
        queue.getWorkers().catch(() => []),
        redis.get(dayKey()),
        redis.get(weekKey()),
        redis.get(monthKey()),
        redis.get(tokenDayKey()), // issue #25 daily token spend (budget:t:YYYY-MM-DD)
        // The shared queue's failure is UNCAUGHT (the panel must not draw a scheduler list it could not read), a host
        // queue's is caught: one unreachable host degrades one host's triggers, never the view.
        Promise.all(queues.map((q, i) => (i === 0 ? q.getJobSchedulers(0, -1, true) : q.getJobSchedulers(0, -1, true).catch(() => [])))),
        // The active jobs, `activePerQueue` per queue (issue #641): one for the TUI, the console's bound for the console.
        Promise.all(queues.map((q) => q.getActive(0, activePerQueue - 1).catch(() => []))),
        // Per-scheduler stall counts (money backstop) for the cron drill-in; reuses the held client like the budget
        // GETs. ONE MGET for every declared cron id, so this stays one round trip however many schedulers exist. An
        // absent key reads as an honest 0 -- a scheduler that has never stalled -- which is the same posture
        // `readScopedBudget` takes for a scope that has never run.
        cronIds.length > 0 ? redis.mget(...cronIds.map((id) => stallKey(id))).catch(() => null) : Promise.resolve([]),
      ]);
      const workers = Array.isArray(workerList) && workerList.length > 0 ? workerList.length : "unknown";
      // Summed across the fleet, because a count of one queue is not a count of the deployment.
      const counts = {};
      for (const c of countsPer) for (const [k, v] of Object.entries(c ?? {})) counts[k] = (counts[k] ?? 0) + Number(v ?? 0);
      // A HALF-paused deployment must read as neither whole one: `every` is the honest AND, and `some` carries the
      // disagreement out so the header can name it rather than rounding it to one side.
      const pausedState = pausedStates.every(Boolean);
      const pausedPartial = !pausedState && pausedStates.some(Boolean);
      const schedulerList = schedulerLists.flat();
      // ONLY the id, the queue and the start off each active Job -- a Job's `.data` holds issue title/body/username
      // (PII), so it never enters the snapshot (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT). The host is read off
      // the registry rows this tick already holds (a host publishes the ids it runs), never off the Job.
      const hostOfJob = new Map();
      for (const h of lastHosts) for (const j of parseLiveJobs(h?.jobs).jobs ?? []) if (typeof h?.name === "string") hostOfJob.set(j.id, { host: h.name, project: j.p ?? null, size: j.m !== null || j.c !== null ? { memMiB: j.m, cpuCenti: j.c } : null });
      // Issue #646: of a Job's `.data`, ONE boolean (`steer`) and the run id it names (`recoveryOf`, through `runIdOf`)
      // are read, and the run id never leaves this function: it only spells the inbox keys below and, since issue #662,
      // the progress keys (a #645 recovery writes its progress under its RUN's id, so a `.r1` row read by its own id
      // showed none).
      const steerRows = [];
      const runIds = [];
      const active = activeLists.flatMap((list, qi) =>
        (Array.isArray(list) ? list : []).map((j) => {
          const row = {
            jobId: typeof j?.id === "string" ? j.id : j?.id === undefined || j?.id === null ? null : String(j.id),
            queue: queues[qi]?.name ?? "-",
            startedAt: Number.isSafeInteger(j?.processedOn) && j.processedOn > 0 ? j.processedOn : null,
            host: hostOfJob.get(String(j?.id))?.host ?? null,
            project: hostOfJob.get(String(j?.id))?.project ?? null,
            size: hostOfJob.get(String(j?.id))?.size ?? null,
          };
          if (j?.data?.steer === true && row.jobId !== null) steerRows.push({ row, runId: runIdOf(j) });
          const runId = row.jobId === null ? null : runIdOf(j);
          runIds.push(typeof runId === "string" ? runId : runId === null || runId === undefined ? null : String(runId));
          return row;
        }),
      );
      // Issue #646: each steer-armed active job's inbox WITHOUT ITS TEXT (`listInboxPublic`: id, mode, source, state,
      // at, bytes), for the console's state API and the TUI's ACTIVE row. Started now beside the progress MGET, at most
      // STEER_INBOX_ROWS_MAX of them, each one bounded MULTI on the held client. A row that is not armed carries neither
      // field, so a deployment that never steers reads the snapshot it always did.
      const inboxRead = Promise.all(
        steerRows.slice(0, STEER_INBOX_ROWS_MAX).map(({ runId }) => withTimeout(listInboxPublic({ redis, runId }).catch(() => ({ error: "valkey" })), FLEET_READ_TIMEOUT_MS, { error: "timeout" })),
      );
      // Issue #712: whether each of those runs takes a message NOW (`run:steer:open:<runId>`, the inbox's one authority,
      // the run page's `readJobInbox` reads the same key), so the TUI offers its steer keys only where the console offers
      // its forms. An armed run whose venue could not deliver never opens it. One EXISTS each, beside the list read.
      const openRead = Promise.all(
        steerRows.slice(0, STEER_INBOX_ROWS_MAX).map(({ runId }) => withTimeout(steerIsOpen({ redis, runId }).catch(() => null), FLEET_READ_TIMEOUT_MS, null)),
      );
      // Issue #644: each active job's progress, INTEGERS AND A CHARSET-CHECKED TOOL NAME ONLY (`activeProgressOf`): the
      // snapshot is what lists, hub panels and `/api/state` are drawn from, so the model's phase names and note never
      // enter it. ONE MGET for the first PROGRESS_BATCH_MAX ids, started now and awaited at the end, so it rides beside
      // the reads below rather than adding a round trip to the tick. Unreadable: every row's progress is null.
      const progressRead = readProgressMany(redis, runIds, { timeoutMs: FLEET_READ_TIMEOUT_MS });
      // The scoped limits + their live counters (issue #242): GET only the windows a row caps, each cell caught
      // individually so one bad read degrades one cell, never the snapshot. Keys recomputed from the shared
      // scopeKeyPrefix, so this reader and the worker's writer cannot drift.
      const scopedLimits = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
      const limitRows = Array.isArray(scopedLimits?.limits) ? scopedLimits.limits : [];
      const scopedNow = new Date();
      const scopedBudget = {
        rows: await Promise.all(
          limitRows.map(async (l) => {
            const prefix = scopeKeyPrefix(l.scope);
            const cell = (key) => redis.get(key).then((v) => Number(v ?? 0), () => null);
            const row = {};
            if (Number.isInteger(l.day)) row.day = await cell(dayKey(scopedNow, prefix));
            if (Number.isInteger(l.week)) row.week = await cell(weekKey(scopedNow, prefix));
            if (Number.isInteger(l.month)) row.month = await cell(monthKey(scopedNow, prefix));
            return row;
          }),
        ),
      };
      // Jobs the worker is holding on run.waitFor (issue #230). Caught individually like the scoped cells above, so a
      // dead key or a slow SCAN degrades one section rather than the whole snapshot. Reads the worker's own
      // `wait:job:*` hashes and never a delayed Job: a delayed job's `.data` holds the issue title and body.
      const held = await heldJobs(redis, { prune }).catch((err) => ({ unreachable: err?.message ?? String(err) }));

      // The failed set's first surface (issue #289). Each Job lives for one statement and ONLY host-chosen fields enter
      // the snapshot -- id, attempt count, the worker's own scrubbed throw message, the queue name and the finish
      // instant. `.data` (issue title/body/username) never crosses; a key-set pin holds the projection closed. Caught
      // as a unit like `held` above, so an unreadable failed set degrades one section, never the snapshot.
      const failed = await (async () => {
        const lists = await Promise.all(queues.map((q) => q.getFailed(0, FAILED_PER_QUEUE - 1)));
        const rows = lists
          .flatMap((list, qi) =>
            (Array.isArray(list) ? list : []).map((j) => ({
              jobId: j?.id ?? "-",
              attemptsMade: Number(j?.attemptsMade ?? 0),
              attempts: Number.isSafeInteger(j?.opts?.attempts) && j.opts.attempts > 0 ? j.opts.attempts : null,
              failedReason: scrubReason(j?.failedReason),
              queue: queues[qi]?.name ?? "-",
              endedAt: Number(j?.finishedOn ?? 0),
            })),
          )
          .sort((a, b) => b.endedAt - a.endedAt)
          .slice(0, FAILED_LIMIT);
        const total = counts.failed ?? 0;
        return { rows, more: Math.max(0, Number(total) - rows.length) };
      })().catch((err) => ({ unreachable: err?.message ?? String(err) }));

      // The dollar windows (issue #501, part 7): null when no dollar window is set, so a deployment without one renders
      // exactly the panel it always did. Caught as a unit, like `held`.
      const settings = readSettingsView({ settingsFile: paths.settingsFile });
      const dollars = await dollarWindows(settings?.overlay, limitRows).catch((err) => ({ rows: [], unreachable: err?.message ?? String(err) }));

      // Issue #641: the parked runs and the day's failures, off the wide window (cached, so at most one read of it per
      // DOLLAR_RECORDS_TTL_MS). Caught as a unit: a failure here costs these two fields, never the snapshot.
      const nowMs = nowFn();
      const fold = await wideRuns().then(
        (w) => ({
          // Answered runs are dropped BEFORE the chain counter is read, so a run nobody waits on costs no fs call.
          parked: readParkedRuns({ runs: w.runs, now: nowMs, sessionsDir: paths.sessionsDir ?? null, fs, unansweredOnly: true }),
          // By the console's word (issue #737), as `refusalsIn` counts refusals: a recovery end is recorded `policy` and
          // reads "failed" on every surface, so the overview's count and the runs page's agree.
          failures24h: w.runs.filter((r) => outcomeWord(r?.outcome, r?.reason).word === OUTCOME_WORDS.failed.word && runAt(r) >= nowMs - DAY_MS && runAt(r) <= nowMs).length,
          // Issue #710: the day's refusals beside its failures, off the same window, so the overview says both.
          refusals24h: refusalsIn(w.runs, nowMs),
          // A floor when the window ended before the day did: every one of WIDE_RUNS runs is inside the day. The same
          // window, so the same floor holds for `refusals24h`.
          failures24hFloor: w.runs.length >= WIDE_RUNS && runAt(w.runs[w.runs.length - 1]) >= nowMs - DAY_MS,
          parkedUnreachable: w.partial ? scrubReason(w.partial) : null,
          recordReasons: newestReasonsOf(w.runs),
          recordDetails: new Map(w.runs.map((r) => [r.jobId, r]).reverse()),
          // Issue #737: the overview's day of runs, its spend per hour and its soft-hold refusals, off the same window.
          runsDay: runsDayOf(w, nowMs),
          spendByHour: spendByHourOf(w, nowMs),
          softHoldToday: softHoldTodayOf(w, nowMs),
        }),
        // An empty `parked` alone would read as "nobody is waiting"; `parkedUnreachable` says the list is not known. The
        // three day folds are null for the same reason: not known, never an empty day.
        (err) => ({ parked: [], failures24h: null, refusals24h: null, failures24hFloor: false, parkedUnreachable: scrubReason(err?.message ?? String(err)) || "the runs could not be read", recordReasons: new Map(), runsDay: null, spendByHour: null, softHoldToday: null }),
      );
      // Issue #710: each failed job's record reason (its newest record in the wide window), the closed enum alone, so the
      // fleet page can say why in the row. BullMQ's own `failedReason` stays the operator's free text, never in a row.
      if (Array.isArray(failed?.rows)) for (const row of failed.rows) {
        row.reason = fold.recordReasons.get(row.jobId) ?? null;
        row.hasRecord = fold.recordReasons.has(row.jobId);
        row.target = fold.recordDetails?.get(row.jobId)?.target ?? null;
        row.outcome = fold.recordDetails?.get(row.jobId)?.outcome ?? null;
      }

      // Issue #647: whether each waiting park is being answered now (a job queued or running on its target, which has no
      // record yet: `readPendingOnTargets`, the rule the Chat panel and the planner use). Read only while something is
      // parked, and at most once per DOLLAR_RECORDS_TTL_MS for the same parks, so a park left for days does not list the
      // queues on every tick. `pendingScan` per row is the scan's answer for its target (`pendingScanFor`, the shape the
      // shared verdict `parkedVerdictOf` reads, so the inbox and the Chat panel decide alike), and `answering` the same
      // read as the job's id, false (the scan saw everything and found none), or null (unknown: partial or unreadable).
      if (fold.parked.length > 0) {
        const parkKey = fold.parked.map((p) => `${p.kind}\u0000${p.target}\u0000${p.jobId}`).join("\n");
        if (!parkedPending || parkedPending.key !== parkKey || nowMs < parkedPending.at || nowMs - parkedPending.at >= DOLLAR_RECORDS_TTL_MS) {
          const got = await readPendingOnTargets({ queues, targets: fold.parked.map((p) => ({ kind: p.kind, target: p.target, runId: typeof p.jobId === "string" ? p.jobId : null })), timeoutMs: FLEET_READ_TIMEOUT_MS });
          parkedPending = { at: nowMs, key: parkKey, got };
        }
        const got = parkedPending.got;
        for (const p of fold.parked) {
          p.pendingScan = pendingScanFor(got, targetKeyOf(p.kind, p.target));
          const facts = pendingFactsOf(p.pendingScan);
          p.answering = facts.pending === true ? facts.pendingJobId : facts.pending === false ? false : null;
        }
      }

      const progressGot = await progressRead;
      active.forEach((row, i) => {
        row.progress = runIds[i] === null ? null : activeProgressOf(progressGot.byId?.[runIds[i]]);
      });
      const inboxGot = await inboxRead;
      const openGot = await openRead;
      steerRows.forEach(({ row }, i) => {
        row.steer = true;
        // true, false, or null when unread (past the bound, or a read that failed): never guessed open.
        row.steerOpen = openGot[i] === true ? true : openGot[i] === false ? false : null;
        // null: past the per-tick bound, or unreadable this tick. Never `[]`, which would say "no message".
        row.inbox = Array.isArray(inboxGot[i]?.entries) ? inboxGot[i].entries.map(publicInboxEntry) : null;
      });

      const waitingJobs = waitingRead === null ? null : await waitingRead;
      if (Array.isArray(waitingJobs?.rows)) for (const row of waitingJobs.rows) row.size = resolveJobSize({ project: row.project, limits: limitRows, env: dollarEnvFn() ?? {} });
      if (waitingJobs && Array.isArray(held?.rows)) for (const row of held.rows) row.project = waitingJobs.rows?.find((job) => job.jobId === row.jobId)?.project ?? null;
      return {
        defaultSize: resolveJobSize({ env: dollarEnvFn() ?? {} }),
        waitMaxChecks: parseNonNegInt((dollarEnvFn() ?? {}).PI_WAIT_MAX_CHECKS, 96) || 96,
        waitMaxFaults: parseNonNegInt((dollarEnvFn() ?? {}).PI_WAIT_MAX_FAULTS, 5) || 5,
        waitMaxMs: parseNonNegInt((dollarEnvFn() ?? {}).PI_WAIT_MAX_MS, 24 * 3600 * 1000) || 24 * 3600 * 1000,
        valkey: urlShown(paths.valkeyUrl),
        readAt: nowMs,
        held,
        failed,
        scopedLimits,
        scopedBudget,
        dollars,
        queue: { pausedState, pausedPartial, counts, workers, queues: queues.length, fleetDegraded },
        // Issue #641: each queue's own counts beside the summed ones, so a surface can say which host's queue is deep.
        queueCounts: queues.map((q, i) => ({ queue: q?.name ?? "-", paused: Boolean(pausedStates[i]), counts: Object.fromEntries(Object.entries(countsPer[i] ?? {}).map(([k, v]) => [k, Number(v ?? 0)])) })),
        // Issue #596, phase 3: each live host's budget and use, as the registry publishes them (integers as text, `off`,
        // or "" while unknown). Read by the PROJECTS view; nothing here judges them. Issue #599, phase 3: with what the
        // HOSTS view's live lines read off the same rows (`hostRowOf`), so that view adds no read to this tick.
        hostBudgets: lastHosts.map(hostRowOf),
        // Issue #712: each host's last published doctor run, `{ hosts, more }` or `{ unreachable }`, through the worker's
        // own allowlist (`readDoctorResults`). Labels are another host's redacted text: every surface escapes them.
        doctor: await doctorResults(),
        // This console's or panel's own host, by the worker's name rule over the deployment's env, so a "does not load"
        // sentence quotes this host's doctor before another's (each host has its own copy of the files). Null when the
        // declared name is one the worker refuses.
        doctorSelf: doctorSelfName(dollarEnvFn() ?? {}),
        budget: { day: Number(dayRaw ?? 0), week: Number(weekRaw ?? 0), month: Number(monthRaw ?? 0), tokensToday: Number(tokenRaw ?? 0) },
        schedulers: mapSchedulers(schedulerList, nowMs).map((scheduler) => {
          const trigger = triggersView?.triggers?.find((t) => t.type === "cron" && t.id === scheduler.key);
          const project = typeof trigger?.folder === "string" ? projectOf({ kind: "local", folder: trigger.folder }, projectsView?.projects ?? []) : null;
          return { ...scheduler, project };
        }),
        // Rebuilt into the `{ id -> count }` shape the drill-in and the LIST badge already index by, so neither reader
        // changes.
        schedulerStalls: Object.fromEntries(cronIds.map((id, i) => [id, stallCounts === null ? null : decimalOf(stallCounts?.[i] ?? "0")])),
        schedulerStallMax: paths.schedulerStallMax,
        sandboxRetentionHours: paths.sandboxRetentionHours,
        // Merged across the fleet (issue #57, Gap 3). This host's files stay the truth and the single-host path; the
        // mirror adds the other hosts' records. On a shared `PI_LOGS_DIR` the local read is already the merged read and
        // the mirror adds nothing, which is why there is no second code path.
        runs: merged.runs,
        runHosts: merged.hosts,
        runMirror: merged.mirror,
        settings,
        triggers: triggersView,
        triggerInstructions,
        triggerTasks,
        pauseWindows: readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath }),
        // The projects as the WORKER reads them (issue #499 part C): `{ unset }` when PI_PROJECTS_FILE is unset.
        projects: projectsView,
        // The project secret bundles (issue #704): null when the triggers file binds none. Names, profiles and the
        // newest run's received variable names; never a reference or a value, and never resolved here.
        secretBundles: secretBundlesView({ triggers: triggersView, settings, env: dollarEnvFn() ?? {}, projects: projectsView, runs: merged.runs, fs }),
        // Issue #712: the secret profiles view (`secretProfilesView`): each profile's source, roots status, triggers,
        // projects, last resolve and the live hosts that advertise it. Names and words only, never a resolver path.
        secretProfiles: secretProfilesView({ triggers: triggersView, settings, env: dollarEnvFn() ?? {}, projects: projectsView, runs: merged.runs, hosts: fleetDegraded ? null : lastHosts.map(hostRowOf), hostsUnreadable: Boolean(fleetDegraded), fs }),
        // Issue #712: the PI_SECRET_PROFILES names this deployment declares (`envSecretProfiles`; never a path here, the
        // names-only rule of the overlay list beside it), so no surface says "none declared" over env-declared profiles.
        secretProfilesEnv: (() => {
          const got = envSecretProfiles((dollarEnvFn() ?? {}).PI_SECRET_PROFILES);
          return { names: Object.keys(got.profiles).sort(), malformed: got.malformed, seen: got.seen };
        })(),
        // Issue #712: the venue a trigger naming none runs in (`PI_BACKENDS[0]`, read as the trigger tools read it), for the
        // secrets disclosure's custody; null when the list does not parse.
        defaultBackend: triggerVenue(undefined, dollarEnvFn() ?? {}),
        // Issue #504 part C: whether the deployment names an allocation envelope, for the `b split` hint alone.
        envelopeSet: typeof paths.envelopeFile === "string" && paths.envelopeFile !== "",
        // The operator's staged third-party pi packages (REQ-GLOBAL-PI-OVERLAY), for the armed triggers' trust model.
        // A plain file read that degrades to a safe empty shape rather than throwing.
        stagedPackages: readStagedPackages({ globalPiDir: paths.globalPiDir }),
        // The overlay's MCP servers (REQ-MCP-OPERATOR-SERVERS), for a trigger's `run.mcp` lines: names and where each
        // runs, never a header, an argument or a value.
        overlayMcp: readOverlayMcpView({ globalPiDir: paths.globalPiDir }),
        // ONLY the id off the first active Job, for the TUI's ACTIVE row; `active` below is the whole list.
        activeJobId: active[0]?.jobId ?? null,
        active,
        parked: fold.parked,
        parkedUnreachable: fold.parkedUnreachable,
        failures24h: fold.failures24h,
        refusals24h: fold.refusals24h,
        failures24hFloor: fold.failures24hFloor,
        // Issue #737, off the wide window (each null when it could not be read): the last 24 hours' runs (`runsDayOf`),
        // today's settled spend per UTC hour (`spendByHourOf`) and today's soft-hold refusals (`softHoldTodayOf`).
        runsDay: fold.runsDay,
        spendByHour: fold.spendByHour,
        softHoldToday: fold.softHoldToday,
        // Issue #737: when the registry rows in `hostBudgets` were read (the reader's clock), null before any read.
        hostsReadAt: lastHostsAt,
        // Issue #737: the waiting jobs (`readWaiting`'s shape, or `{ unreachable: true }`), only on a call that asked.
        ...(waitingJobs !== null ? { waiting: waitingJobs } : {}),
        // Issue #737: what a switch preview's `queueCounts` cover, only on a call that asked for the switch's queues.
        ...(preview !== null ? { switchTotal: preview.total, switchTruncated: preview.truncated, switchIncomplete: preview.incomplete } : {}),
      };
    },
    /**
     * The console navigation's Parked count (issue #737) on a page that reads no snapshot: how many unanswered parked
     * runs the wide window holds, by the snapshot's own rule (`readParkedRuns`, `unansweredOnly`) off the same cached
     * window (and the same read, when one is in flight), so it costs no read the snapshot did not already pay for
     * within `DOLLAR_RECORDS_TTL_MS`. No chain counter is read (a count needs none), and no pending-answer scan. Null
     * when the window is partial or unreadable, as the snapshot's `parkedUnreachable` would say: a side that could not
     * be read is never offered as a whole count. Never throws.
     *
     * WHAT THE WINDOW CANNOT SEE. It is the newest WIDE_RUNS (1000) runs, so a park older than the 1000th run is not
     * counted, and that is not marked partial: the window was read whole, it just ends. Exactly as the parked inbox
     * (the snapshot's `parked`, the same fold of the same window) does not list such a park, so the count and the inbox
     * agree; a deployment that runs a thousand jobs while one waits has a park neither shows.
     */
    async parkedCount() {
      try {
        const w = await wideRuns();
        if (w.partial) return null;
        return readParkedRuns({ runs: w.runs, now: nowFn(), sessionsDir: null, fs, unansweredOnly: true }).length;
      } catch {
        return null;
      }
    },
    /**
     * The runs page's counts (issue #737): the last 24 hours of the same cached wide window `parkedCount` reads (and the
     * same read, when one is in flight), folded by `runsWindowOf`: counts by outcome key, project and reason, the
     * values each closed list offers, and the settled spend (`spentMicros`). Free within `DOLLAR_RECORDS_TTL_MS`, so
     * the runs page and the run page pay for no read the snapshot did not already pay for. A partial window is still a
     * window, marked `partial` (every count a floor), where a parked count is not: a count read short is said to be
     * short, a list that is short is never offered as whole. Null when the window cannot be read. Never throws.
     *
     * WHAT THE WINDOW CANNOT SEE is `parkedCount`'s: the newest WIDE_RUNS runs, so in a deployment that ran more than
     * that in 24 hours the window ends inside the day, and `floor` says so.
     */
    async runsWindow() {
      try {
        return runsWindowOf(await wideRuns(), nowFn());
      } catch {
        return null;
      }
    },
    /** This reader's held client, local index and clock, for `readRunsPage`/`readRunById` off the same connection. */
    async runsPage(opts = {}) {
      return readRunsPage(redis, { ...opts, logsDir: paths.logsDir, fs, now: nowFn, localIndex });
    },
    async runById(jobId) {
      return readRunById(redis, { logsDir: paths.logsDir, jobId, fs });
    },
    // The live transcript (issue #643), off this reader's held client and bounded by its timeout: `readTranscriptSince`
    // and `readTranscriptMeta`, whose shapes these return. Non-blocking XRANGE reads only, so a tail open beside the
    // panel never parks the snapshot's own reads behind it. Never throws.
    async transcriptSince(jobId, after = null, { count = TRANSCRIPT_PAGE_MAX } = {}) {
      return readTranscriptSince(redis, jobId, after, { count, timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    async transcriptMeta(jobId) {
      return readTranscriptMeta(redis, jobId, { timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    // Run progress (issue #644), off the same held client: one job's whole snapshot (`readProgress`, phase names and
    // note included, for an operator's surface alone), and many jobs' in one MGET (`readProgressMany`). Never throw.
    async progress(jobId) {
      return readProgress(redis, jobId, { timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    async progressFor(jobIds) {
      return readProgressMany(redis, jobIds, { timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    // The run page's progress (issue #662): the key read by the job's RUN id, and whether this attempt's run continues as
    // a recovery job (`readRunProgress`). Never throws.
    async progressOfRun(jobId, record = null) {
      const queues = await fleetQueues().catch(() => lastNames.map((n) => pool.get(n)));
      return readRunProgress({ redis, queues, jobId, record, timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    // The run page's inbox panel (issue #646): the job found across the fleet's queues (the registry read afresh, so a
    // run page open alone still sees a host queue), then its inbox without text. Never throws.
    async inbox(jobId) {
      const queues = await fleetQueues().catch(() => lastNames.map((n) => pool.get(n)));
      return readJobInbox({ redis, queues, jobId, timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    // The terminal chat's mode (issue #647): the job's queue state and its active recovery, for every job
    // (`readJobStatus`), across the by-id lookup's queues (`lookUp`, issue #737: the registry's and the queues that
    // exist), so a job on a stopped host's queue is found, and `found` is null rather than false where that set is not
    // whole or was read before the question. `tellAbsent` false: a miss is not asked again over a new scan (`lookUp`).
    // `live` and `asked` are the question's (`lookUp`, `lookupQuestion`): a live load's lookup scans nothing. Never throws.
    async jobStatus(jobId, { tellAbsent = true, live = false, asked = null } = {}) {
      const ask = ({ queues, whole }) => readJobStatus({ queues, jobId, whole, timeoutMs: FLEET_READ_TIMEOUT_MS });
      return lookUp(ask, (got) => got?.found, { ...questionOf({ live, asked }), key: jobId, tellAbsent: tellAbsent !== false }).catch(() => ({ unreachable: true }));
    },
    // Only the current row's display attribution, and only while its kind still matches the recorded one. No
    // instructions, secret references, environment values or job payload can leave through this read (#747).
    async runTrigger(index, kind) {
      if (!Number.isSafeInteger(index) || index < 0 || typeof kind !== "string") return null;
      let source = null;
      const view = readTriggers({ triggersPath: paths.triggersPath, fs: { readFileSync: (path, encoding) => (source = fs.readFileSync(path, encoding)) } });
      const row = view.triggers?.find((t) => t.index === index && t.type === kind);
      if (!row) return null;
      let raw;
      try { raw = JSON.parse(source).triggers?.[index]; } catch { return null; }
      const text = (v) => typeof v === "string" ? scrubControls(v).slice(0, 2000) : null;
      return { index, type: row.type, phrase: text(row.phrase), label: text(row.label ?? (row.type === "label" ? [...(row.any ?? []), ...(row.all ?? [])].join(", ") : null)), pattern: text(row.pattern),
        mcp: Array.isArray(row.mcp) ? row.mcp.slice(0, 64).filter((n) => typeof n === "string" && MCP_SERVER_NAME_RE.test(n)) : [],
        resume: row.resume === true, recover: raw?.run?.recover === true };
    },
    // A durable run's active dollar holds, read-only and numbers only; ledger keys and arbitrary hash fields stay here.
    async runHolds(jobId, record = null) {
      const base = recordedRecoveryOf(record?.recoveryOf) ?? jobId;
      if (typeof base !== "string" || !RUN_ID_RE.test(base)) return null;
      try {
        const got = await withTimeout(makeRunBudgetLedger({ redis, now: nowFn }).read(base), FLEET_READ_TIMEOUT_MS, null);
        if (!Array.isArray(got?.holds)) return null;
        return got.holds.filter((h) => Number.isSafeInteger(h.seq) && h.seq >= 1 && ["held", "settled", "released", "settled-crashed"].includes(h.state))
          .slice(0, 2 + RECOVERY_CAP).map((h) => ({ seq: h.seq, state: h.state, amountMicros: Number.isSafeInteger(h.amountMicros) && h.amountMicros >= 0 ? h.amountMicros : null }));
      } catch {
        return null;
      }
    },
    // The live run's facts, rebuilt by name before queue data leaves this reader (#747). The target is derived by
    // the record writer, so a local folder contributes its basename only; payload text has no route through here.
    async runLiveFacts(jobId, lookup = {}) {
      if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return null;
      try {
        const job = await retainedJob(jobId, lookup);
        if (!job) return null;
        const data = job.data ?? {};
        const text = (v, re) => typeof v === "string" && re.test(v) ? v : null;
        const settings = readSettingsView({ settingsFile: paths.settingsFile, fs }).overlay ?? {};
        const projects = readProjects({ projectsPath: paths.projectsPath, fs }).projects ?? [];
        const host = lastHosts.find((h) => parseLiveJobs(h?.jobs).jobs?.some((j) => j.id === jobId));
        const reportedKind = data.kind ?? job.name;
        const watchKind = reportedKind === "watch" && typeof data.watch?.ruleId === "string" && WATCH_RULE_ID_RE.test(data.watch.ruleId);
        const kind = RUN_KINDS.includes(reportedKind) || watchKind ? reportedKind : null;
        const backend = data.backend ?? parseHostBackends(typeof host?.backends === "string" ? host.backends : null)?.default ?? null;
        const instant = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15 ? new Date(v).toISOString() : null;
        const maxTurns = data.maxTurns ?? settings.maxTurns;
        return {
          target: text(targetFor(kind, data), /^[A-Za-z0-9._:/#! -]{1,300}$/), kind,
          flow: text(data.flow, SKILL_NAME_RE), backend: text(backend, /^[a-z][a-z-]{0,31}$/),
          provider: text(data.provider ?? settings.provider, RUN_PROVIDER_RE), model: text(data.model ?? settings.model, RUN_MODEL_RE),
          maxTurns: Number.isSafeInteger(maxTurns) && maxTurns > 0 ? maxTurns : null,
          project: text(projectOf(data, projects), PROJECT_ID_RE), host: text(host?.name, WORKER_NAME_RE),
          queue: text(job.queueName ?? job.queue?.name, /^[A-Za-z0-9@._-]{1,200}$/),
          queuedAt: queuedAtOf(job), startedAt: instant(job.processedOn),
        };
      } catch {
        return null;
      }
    },
    // A request's question for the by-id lookups of one page load (issue #737, `lookUp`): `{ asked }`, how many keyspace
    // scans this reader had started when it was asked, which the load hands each of them (`jobStatus`,
    // `parkedAnswerCheck`, `rerunCheck`), so a scan one of them waits for answers the others: one in all.
    lookupQuestion() {
      return { asked: scans };
    },
    // Whether a park is being answered now (issue #647): a job queued or running on its target, which has no record yet
    // (`readPendingAnswer`). Never throws.
    async pendingAnswer({ kind, target, runId = null } = {}) {
      const queues = await fleetQueues().catch(() => lastNames.map((n) => pool.get(n)));
      return readPendingAnswer({ queues, kind, target, runId, timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    // Whether a parked run's retained job can take a console answer (issue #647): the planner's own predicate
    // (`parkedAnswerRefusalOf`) over the job's data and the triggers file, so the Chat panel offers the reply form
    // exactly where `planParkedAnswer` would plan it. `{ refusal }` (a sentence), `{ ok: true }` or `{ unreachable: true }`.
    // `lookup` is the question's (`{ live }` or `{ asked }`, `lookUp`). The job's `.data` never leaves this method. Never
    // throws.
    async parkedAnswerCheck(jobId, lookup = {}) {
      if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { refusal: "a run id is letters, digits and . _ : -, at most 200 characters" };
      try {
        const job = await retainedJob(jobId, lookup);
        if (job === undefined) return { unreachable: true };
        const judged = parkedAnswerRefusalOf({ jobId, data: job?.data ?? null, triggersPath: paths.triggersPath ?? null, approval: Array.isArray(job?.data?.gates), fs });
        return judged.refusal ? { refusal: judged.refusal } : { ok: true };
      } catch {
        return { unreachable: true };
      }
    },
    // Whether run `jobId` (its record `record`) can be offered a re-run (issue #710): the planner's own cheap refusals
    // (`rerunRefusalOf`, which `planRerun` asks first) over the record and the job's retained data, so the run page hides
    // the form exactly where the planner refuses on those alone. `{ refusal }` (a sentence), `{ ok: true }` or
    // `{ unreachable: true }`. `lookup` is the question's, as `parkedAnswerCheck`'s. The job's `.data` never leaves this
    // method. Never throws.
    async rerunCheck(jobId, record, lookup = {}) {
      if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { refusal: RERUN_BAD_ID };
      try {
        const job = await retainedJob(jobId, lookup);
        if (job === undefined) return { unreachable: true };
        const refusal = rerunRefusalOf({ ...(record ?? {}), jobId }, nowFn(), job?.data ?? null);
        return refusal !== null ? { refusal } : { ok: true };
      } catch {
        return { unreachable: true };
      }
    },
    // Whether run `jobId`'s workspace is still re-openable (issue #710): the panel's manifest verdict
    // (`sandboxRetentionOf`, through the `sandboxRetentionFn` seam), read only for a record THIS host wrote, since the
    // manifest is on the host that ran the job and the console's host can say nothing of another's. `{ retained, why }`,
    // or `{ elsewhere: true }` for a run of another host, a host name this reader cannot tell, or no verdict wired. The
    // venue policy is unknown here (review round 1): PI_BACKENDS is the opener's shell's, never a key the console takes
    // (`OQ-038`), so the verdict is asked with `venuePolicy: "unknown"` and can refuse only what no shell's PI_BACKENDS
    // could open. Never throws.
    async sandboxCheck(jobId, record) {
      if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { elsewhere: true };
      try {
        const env = dollarEnvFn() ?? {};
        const self = doctorSelfName(env);
        const host = typeof record?.host === "string" && record.host !== "" ? record.host : null;
        if (host !== null && host !== self) return { elsewhere: true };
        if (typeof sandboxRetentionFn !== "function") return { elsewhere: true };
        const got = sandboxRetentionFn(paths, jobId, { now: nowFn, venuePolicy: "unknown" });
        return got.retained ? { retained: true, why: null, until: typeof got.until === "string" && Number.isFinite(Date.parse(got.until)) ? new Date(got.until).toISOString() : Number.isSafeInteger(got.until) && got.until >= 0 ? got.until : null } : { retained: false, why: got.why, reason: got.reason };
      } catch {
        return { elsewhere: true };
      }
    },
    // The kill switch (issue #642): ONE funnel with the tools' `killSwitchSet`, so a resume across two disagreeing
    // Valkeys is refused here too. Returns `killSwitchSet`'s shape: `{ refused }`, or `{ results: [{ url, shown, res }],
    // disagreement }`, where `res` is `{ ok: true, paused, queues }`, or `{ unreachable, partial: { done, failed, error } }`
    // for a loop that stopped part-way (it used to throw, which the TUI swallowed). This reader's own Valkey goes through
    // its held pool (no second connection for a keypress); any other Valkey the plan names, through `setQueuePaused`.
    async pause() {
      return killSwitch(true);
    },
    async resume() {
      // Resume spans the same set, and it is the direction that strands a deployment: a queue paused while its host
      // was live, then resumed while that host is down, stays paused with nothing naming it.
      return killSwitch(false);
    },
    /** One fleet queue (issue #642): `setQueuePausedOne` on this reader's Valkey. */
    async pauseQueue({ queue, paused }) {
      return setQueuePausedOne({ url: paths.valkeyUrl, queue, paused, makeQueueFn, parseConnectionFn, redisFn });
    },
    async cancelActive({ jobId, interventionOrigin = "human" }) {
      // The CLI's channel, byte for byte (issue #287, worker/src/cancel-state.mjs): a request key the owning worker
      // answers, carried on the reader's own held client -- `cancelJob` lives in the worker process and nothing here
      // can raise it directly.
      return requestCancel({ redis, jobId, interventionOrigin });
    },
    // Only dedicated operator page/action reads ask for these. snapshot()/api/state never carry them.
    async sandboxInventory() {
      await fleetQueues();
      return readSandboxInventoriesFn(redis, { now: nowFn, hosts: lastHosts.map((h) => h.name) });
    },
    async sandboxSessions() {
      await fleetQueues();
      return readSandboxSessionsFn(redis, { now: nowFn, hosts: lastHosts.map((h) => h.name), timeoutMs: FLEET_READ_TIMEOUT_MS });
    },
    async sandboxPrepare(request) { if (!enqueueSandboxPreparationFn) return { refused: "sandbox-not-wired", message: "Sandbox requests are not wired in this console." }; return enqueueSandboxPreparationFn(sandboxQueue(request.host), request, { now: nowFn }); },
    async sandboxPreparationStatus(host, id) { return readSandboxPreparationFn ? readSandboxPreparationFn(sandboxQueue(host), id) : { id, host, state: "unknown" }; },
    async sandboxEnd(request) { return requestSandboxEndFn({ redis, ...request, now: nowFn }); },
    async dispose() {
      for (const q of sandboxQueues.values()) { try { await q.close(); } catch { /* best effort teardown */ } }
      for (const q of pool.values()) {
        try {
          await q.close();
        } catch {
          // best-effort teardown
        }
      }
      try {
        redis.disconnect();
      } catch {
        // best-effort teardown
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The console's page readers (issue #641). Each takes a client the caller owns and never disconnects it (the
// `mergedRunsOn` split), and none writes: the mirror is read with `prune: false` or through the read-only page read.
// (The fleet reader's `snapshot()` writes nothing only when it was built `readOnly`: see `createFleetReader`.)
// ---------------------------------------------------------------------------------------------------------------------

/** How many reasons the overview's refusals list (issue #710): the five most frequent of the day. */
export const REFUSALS_TOP = 5;

/**
 * The refusals among `runs` in the 24 hours up to `nowMs` (issue #710), `{ count, top: [{ reason, count }] }`: runs whose
 * outcome reads "refused" in the console's words (`outcomeWord`, words.mjs), so a `policy` record with `operator-cancel`,
 * which both surfaces call "cancelled", is not counted: an operator stopping a run is not a rule saying no, and an
 * overview that counted it would send the operator looking for a rule to change. `top` is the `REFUSALS_TOP` most
 * frequent reasons, by count and then by token, so two reads of the same window list the same rows; a reason outside the
 * record's token charset is counted and never listed. Pure, and exported for its tests.
 */
export function refusalsIn(runs, nowMs) {
  const by = new Map();
  let total = 0;
  for (const r of Array.isArray(runs) ? runs : []) {
    const at = runAt(r);
    if (!(at >= nowMs - DAY_MS && at <= nowMs)) continue;
    if (outcomeWord(r?.outcome, r?.reason).word !== OUTCOME_WORDS.policy.word) continue;
    total += 1;
    const reason = recordReason(r);
    if (reason !== null) by.set(reason, (by.get(reason) ?? 0) + 1);
  }
  const top = [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, REFUSALS_TOP).map(([reason, count]) => ({ reason, count }));
  return { count: total, top };
}

/** Each job id's newest record reason in `runs` (newest first, as `mergeRuns` orders them), charset-checked, else null. */
function newestReasonsOf(runs) {
  const out = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (typeof r?.jobId !== "string" || out.has(r.jobId)) continue;
    out.set(r.jobId, recordReason(r));
  }
  return out;
}

/** A record's instant in millis, `endedAt` else `startedAt`, as the mirror scores it; -Infinity when it has neither. */
function runAt(r) {
  const t = Date.parse(r?.endedAt ?? r?.startedAt ?? "");
  return Number.isFinite(t) ? t : -Infinity;
}

/** Newest first; a stable order for equal instants (job id), so a page cut is the same cut on every read. */
function byRunAtDesc(a, b) {
  const d = runAt(b) - runAt(a);
  if (d !== 0 && !Number.isNaN(d)) return d > 0 ? 1 : -1;
  const ai = String(a?.jobId ?? "");
  const bi = String(b?.jobId ?? "");
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// The overview's day (issue #737): three folds of the fleet reader's wide window, each pure over `{ runs, partial }`
// (newest first, as `mergeRuns` orders them) and an instant. `floor` says the window ended inside the span, so the fold
// is a floor rather than a whole; `partial` that a side of the window (this host's files or the mirror) was not read.
// ---------------------------------------------------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

/** A record's kind as a day row carries it: the record's token shape (`local`, `github`, ...), else null. */
const RUN_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The longest target a day row carries; a record's target is a repository and a number, or `local:<folder name>`. */
const RUN_TARGET_MAX = 512;

/** The record's three outcomes (INT-RUN-HISTORY-FILE-CONTRACT); anything else is null. */
const RUN_OUTCOMES = Object.freeze(["completed", "policy", "failed"]);

/** An ISO instant in millis, or null. */
function msOf(iso) {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** The first instant of `ms`'s UTC day: the count windows' day (`COUNT_WINDOWS_UTC_TEXT`), so "today" is theirs. */
function utcDayStart(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Whether the window ended inside the span starting at `sinceMs`: every one of WIDE_RUNS runs is inside it. */
function windowFloor(runs, sinceMs) {
  return runs.length >= WIDE_RUNS && runAt(runs[runs.length - 1]) >= sinceMs;
}

/**
 * One record as a day row: the fields the timeline draws, each re-checked by its rule (a mirrored record is another
 * host's text), times in millis. Null for a record with no usable job id, which no row could link to.
 */
function dayRunOf(r) {
  if (typeof r?.jobId !== "string" || !RUN_ID_RE.test(r.jobId)) return null;
  return {
    jobId: r.jobId,
    kind: typeof r.kind === "string" && RUN_KIND_RE.test(r.kind) ? r.kind : null,
    target: typeof r.target === "string" && r.target !== "" && r.target.length <= RUN_TARGET_MAX && !hasControls(r.target) ? r.target : null,
    project: typeof r.project === "string" && DEFER_PROJECT_RE.test(r.project) ? r.project : null,
    host: typeof r.host === "string" && DEFER_HOST_RE.test(r.host) ? r.host : null,
    outcome: RUN_OUTCOMES.includes(r.outcome) ? r.outcome : null,
    reason: recordReason(r),
    startedAt: msOf(r.startedAt),
    endedAt: msOf(r.endedAt),
    parentJobId: typeof r.parentJobId === "string" && RUN_ID_RE.test(r.parentJobId) ? r.parentJobId : null,
  };
}

/**
 * The last 24 hours' runs (issue #737), `{ runs, floor, partial }`: each record whose instant (`endedAt`, else
 * `startedAt`) is in the 24 hours up to `nowMs` (the day's failures' span), as `dayRunOf` rebuilds it, newest first. A
 * record dated after `nowMs` is not in the day.
 */
function runsDayOf(w, nowMs) {
  const runs = [];
  for (const r of w.runs) {
    const at = runAt(r);
    if (!(at >= nowMs - DAY_MS && at <= nowMs)) continue;
    const row = dayRunOf(r);
    if (row !== null) runs.push(row);
  }
  return { runs, floor: windowFloor(w.runs, nowMs - DAY_MS), partial: Boolean(w.partial) };
}

/**
 * Today's settled spend per UTC hour (issue #737), `{ hours, unpriced, floor, partial }`: `hours` is 24 entries, the
 * micro-dollars of the records that ENDED in that hour of today (`dollars.settledMicros`, what the worker settled the
 * run at), 0 for an hour that has passed with none, and null for an hour still to come. `unpriced` counts today's
 * ended runs whose record carries no settled amount (no dollar window applied to them, or a malformed one), so a
 * surface can say the hours are not the day's whole spend. The window's counters stay the spend of record; these are
 * the records' side, by hour.
 */
function spendByHourOf(w, nowMs) {
  const dayStart = utcDayStart(nowMs);
  const current = Math.floor((nowMs - dayStart) / HOUR_MS);
  const hours = Array.from({ length: 24 }, (_, i) => (i <= current ? 0 : null));
  let unpriced = 0;
  for (const r of w.runs) {
    const ended = msOf(r?.endedAt);
    if (ended === null || ended < dayStart || ended > nowMs) continue;
    const micros = r.dollars !== null && typeof r.dollars === "object" ? r.dollars.settledMicros : undefined;
    if (Number.isSafeInteger(micros) && micros >= 0) hours[Math.floor((ended - dayStart) / HOUR_MS)] += micros;
    else unpriced += 1;
  }
  return { hours, unpriced, floor: windowFloor(w.runs, dayStart), partial: Boolean(w.partial) };
}

/** The most projects `runsWindow` counts one by one, the most runs first; the others are counted in `projectsMore`. */
export const RUNS_WINDOW_PROJECTS_MAX = 24;

/** The most values `runsWindow` lists for each of its closed lists, the most frequent kept. */
export const RUNS_WINDOW_VALUES_MAX = 50;

/** The record fields whose values `runsWindow` lists, each a runs filter field. */
const WINDOW_FIELDS = Object.freeze(["kind", "reason", "flow", "trigger", "host", "backend", "model"]);

/** A count per outcome key (words.mjs `OUTCOME_KEYS`), and `other` for an outcome this release does not know. */
const outcomeCounts = () => Object.fromEntries([...OUTCOME_KEYS, "other"].map((k) => [k, 0]));

/** Code-unit order, so two reads of one window list the same values in the same order whatever the host's locale. */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** A trigger's values in reading order: the triggers-file positions by number ("row 2" before "row 10"), then the scheduler ids. */
function byTriggerValue(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  return an ? -1 : bn ? 1 : byText(a, b);
}

/** A record's value of a listed field, as the runs filter matches it (`runMatches`), or null. */
function windowValueOf(field, r) {
  if (field === "backend") return runVenueOf(r);
  if (field === "trigger") return triggerValueOf(r);
  if (field === "reason") return recordReason(r);
  const v = r?.[field];
  return typeof v === "string" && v !== "" ? v : null;
}

/**
 * One listed field's values: each that the runs filter takes as it is (`parseRunFilter`, so a select never offers a
 * value whose link the page would refuse, and another host's text never reaches one), the `RUNS_WINDOW_VALUES_MAX`
 * most frequent (then by value), shown in order.
 */
function windowValuesOf(field, counts) {
  const ok = [...counts].filter(([v]) => parseRunFilter({ [field]: v }).filter?.[field] === v);
  const kept = ok.sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, RUNS_WINDOW_VALUES_MAX).map(([v]) => v);
  return Object.freeze(kept.sort(field === "trigger" ? byTriggerValue : byText));
}

/**
 * The runs page's last 24 hours (issue #737), the fleet reader's `runsWindow`: over the records whose instant
 * (`endedAt`, else `startedAt`) is in the 24 hours up to `nowMs`, `refusalsIn`'s rule, as one pass:
 *   - `byOutcome`: a count per outcome key (`outcomeKey`, the word a row's badge says), `other` for the rest;
 *   - `byProject`: `[{ project, count, byOutcome, spentMicros, unpriced }]` by count, then by id (the records with no
 *     project id, `null`, last among equals), at most `RUNS_WINDOW_PROJECTS_MAX`, and `projectsMore` the projects past
 *     them, so a page that shows one project counts and sums that project's runs alone;
 *   - `byReason`: a count per reason token (`recordReason`; a reason that is no token is counted nowhere), every
 *     token, for counting; the Reason select offers `values.reason`, bounded like every other list;
 *   - `values`: the kind, reason, flow, trigger, host, venue and model values the runs carry (`windowValuesOf`; the
 *     reason as `recordReason` shows it, a token or none);
 *   - `spentMicros`: the dollars the worker settled them at (`dollars.settledMicros`), null when the sum is no safe
 *     whole number, and `unpriced`, the runs whose record carries no settled amount (`spendByHourOf`'s rule).
 * `floor` is the window's own (it ended inside the 24 hours), `partial` that a side of it was not read; either makes a
 * count a floor. `at` is `nowMs`, the instant the 24 hours end.
 */
function runsWindowOf(w, nowMs) {
  const byOutcome = outcomeCounts();
  const projects = new Map();
  const reasons = new Map();
  const seen = Object.fromEntries(WINDOW_FIELDS.map((f) => [f, new Map()]));
  let spentMicros = 0;
  let unpriced = 0;
  for (const r of w.runs) {
    const at = runAt(r);
    if (!(at >= nowMs - DAY_MS && at <= nowMs)) continue;
    const key = outcomeKey(r?.outcome, r?.reason) ?? "other";
    byOutcome[key] += 1;
    const project = typeof r?.project === "string" && PROJECT_ID_RE.test(r.project) ? r.project : null;
    const p = projects.get(project) ?? { project, count: 0, byOutcome: outcomeCounts(), spentMicros: 0, unpriced: 0 };
    p.count += 1;
    p.byOutcome[key] += 1;
    projects.set(project, p);
    const reason = recordReason(r);
    if (reason !== null) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    for (const field of WINDOW_FIELDS) {
      const v = windowValueOf(field, r);
      if (v !== null) seen[field].set(v, (seen[field].get(v) ?? 0) + 1);
    }
    const micros = r?.dollars !== null && typeof r?.dollars === "object" ? r.dollars.settledMicros : undefined;
    if (Number.isSafeInteger(micros) && micros >= 0) {
      spentMicros += micros;
      p.spentMicros += micros;
    } else {
      unpriced += 1;
      p.unpriced += 1;
    }
  }
  const safe = (n) => (Number.isSafeInteger(n) ? n : null);
  const ranked = [...projects.values()].sort((a, b) => b.count - a.count || (a.project === null ? 1 : b.project === null ? -1 : byText(a.project, b.project)));
  const kept = ranked.slice(0, RUNS_WINDOW_PROJECTS_MAX).map((p) => Object.freeze({ project: p.project, count: p.count, byOutcome: Object.freeze(p.byOutcome), spentMicros: safe(p.spentMicros), unpriced: p.unpriced }));
  return Object.freeze({
    at: nowMs,
    floor: windowFloor(w.runs, nowMs - DAY_MS),
    partial: Boolean(w.partial),
    byOutcome: Object.freeze(byOutcome),
    byProject: Object.freeze(kept),
    projectsMore: ranked.length - kept.length,
    byReason: Object.freeze(Object.fromEntries([...reasons].sort((a, b) => byText(a[0], b[0])))),
    values: Object.freeze(Object.fromEntries(WINDOW_FIELDS.map((f) => [f, windowValuesOf(f, seen[f])]))),
    spentMicros: safe(spentMicros),
    unpriced,
  });
}

/**
 * Today's soft-hold refusals (issue #737), `{ count, floor, partial }`: the records of this UTC day up to `nowMs` whose
 * reason is `soft-hold`, the budget band that refuses new starts below a count window's cap (budget.mjs). Today, not
 * the last 24 hours, because the band belongs to the count windows and they are UTC days.
 */
function softHoldTodayOf(w, nowMs) {
  const dayStart = utcDayStart(nowMs);
  let count = 0;
  for (const r of w.runs) {
    const at = runAt(r);
    if (at >= dayStart && at <= nowMs && r?.reason === "soft-hold") count += 1;
  }
  return { count, floor: windowFloor(w.runs, dayStart), partial: Boolean(w.partial) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The waiting jobs (issue #737): every job in a fleet queue that has not started, and why it waits, read WITHOUT a
// job's data. `DES-WAITING-REASONS`.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The most jobs `readWaiting` reads from EACH of a queue's four lists (delayed, prioritized, wait, paused), so one queue
 * gives at most four times this; one more than this in any list marks the queue truncated.
 */
export const WAITING_PER_LIST_MAX = 200;

/**
 * The most queues one `readWaiting` reads (issue #737): the first this many it is given, the rest counted as
 * `queuesCut`. The fleet reader gives the registry's queues first, then the ones the keyspace discovery found, in name
 * order, so a live host's queue is never the one cut while the registry names at most this many. 64 is far past any
 * fleet this project runs, and bounds what a planted `bull:pi-jobs@<name>:meta` key per name can cost: five commands
 * and four lists of rows each.
 */
export const WAITING_QUEUES_MAX = 64;

/**
 * How far past its due instant a delayed job may sit before the reader calls it `due` ("Due since {due}; no worker has
 * taken it"), whatever its record says. A free worker takes a due job within about a second (BullMQ wakes it at the due
 * instant); the rest of the 10 s is the console's clock sitting a little off the worker's that set the due. Past it, no
 * worker has asked for a job since (every slot busy, or no worker draining the queue), and a record's reason has run
 * its course: its record outlives the due by only `DEFER_TTL_SLACK_MS`, so without this the job would read as that
 * reason and then as "no reason was recorded".
 */
export const WAITING_DUE_GRACE_MS = 10_000;

/**
 * How long the fleet reader keeps its keyspace discovery of the queues that exist (`discoverHostQueuesFn`, the planners'
 * and the kill switch's), for the waiting read: 60 s. The registry's queues are read every tick and a live host's queue
 * is in it at once, so the discovery only adds a queue the registry no longer names (a stopped host's, whose jobs still
 * wait), and those change when a host stops. A keyspace scan every second is the load the kill switch's note refuses.
 */
export const WAITING_DISCOVERY_TTL_MS = 60_000;

/**
 * How many job ids the fleet reader keeps as found absent by a request's by-id lookup (issue #737, `createFleetReader`'s
 * `lookUp`), for a live load's lookups to keep saying so: the console's per-run caches' bound, so a caller's made-up ids
 * push out only the oldest.
 */
export const LOOKUP_TOLD_MAX = 256;

/** How long the fleet reader keeps one `readWaiting` for the same queues (`createFleetReader`'s `waiting`). */
export const WAITING_TTL_MS = 5_000;

/** The BullMQ states of a job that has not started: the four lists `readWaiting` reads, in its order. */
export const WAITING_STATES = Object.freeze(["delayed", "waiting", "prioritized", "paused"]);

/**
 * The fields of a waiting job's own hash this reader asks for: the short scalars BullMQ's own `Job.fromJSON` reads
 * beside the data (bullmq 5.80.4): its kind (`name`), its dedup id (`deid`), its scheduler (`rjk`), its attempts
 * (`atm`, and the older `attemptsMade`), its stall count (`stc`) and its enqueue instant. Never `data`, `opts`,
 * `stacktrace` or `returnvalue`: a forge job's data holds the issue's title and body.
 */
const WAITING_JOB_FIELDS = Object.freeze(["name", "deid", "rjk", "atm", "attemptsMade", "stc", "timestamp"]);

/** A job's kind as its hash names it (the `name` BullMQ was given: `local`, `github`, ...), else null. */
const WAITING_KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** A cron trigger's id as BullMQ's scheduler key (`rjk`) carries it: the loader's charset (`[A-Za-z0-9._-]`, no `:`). */
const SCHEDULER_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

/** A cron trigger's job id: `repeat:<id>:<millis>` (its scheduler) or `manual:<id>:<millis>` (fired by hand). */
const TRIGGER_JOB_ID_RE = /^(repeat|manual):([A-Za-z0-9._-]{1,200}):(0|[1-9][0-9]{0,15})$/;

/** A recovery's job id (`recoveryJobId`: `<run id>.r<n>`). A hint for a row; the planner reads the data to know. */
const RECOVERY_JOB_ID_RE = /\.r[1-9][0-9]{0,5}$/;

/** The longest dedup id read for a project; the receiver's are `repo<sep>number:flow...`. */
const DEID_MAX = 1024;

/**
 * How far a delayed job's due instant may sit from its defer record's span before the record is read as stale. A
 * deferral moves the job to exactly the record's `until` (the worker's `deferTo` writes it, then hands BullMQ that very
 * instant; a past instant is clamped to the move, at most the write's bound after the record's `at`), and a retry's due
 * is BullMQ's own clock a little after the record's `until` (measured: up to about 2 s). A record outside that is from
 * an earlier episode, and the job now waits for a reason nobody recorded: it reads as "no reason was recorded", never
 * as the old reason. The record lives `DEFER_TTL_SLACK_MS` past its `until`, which is the window this closes.
 */
const DEFER_STALE_MS = 5_000;

/** Whether a delayed job's due instant agrees with its record: inside `[until, max(until, at)]`, give or take the bound. */
function recordMatchesDue(record, dueAt) {
  if (record === null || record.until === null || dueAt === null) return true; // nothing to judge it by
  const latest = Math.max(record.until, record.at ?? record.until);
  return dueAt >= record.until - DEFER_STALE_MS && dueAt <= latest + DEFER_STALE_MS;
}

/** A hold's label as the worker builds it (`waitLabel`): profile names and `after <instant>`, joined by ` + `. */
const WAIT_LABEL_RE = /^[A-Za-z0-9._:+ -]{1,512}$/;

/**
 * The command that asks whether a queue's meta `paused` field is there, `[cmd, key, field]`: `HEXISTS` where the client
 * has it, since presence is all BullMQ reads and the field's value, which anything with the URL can make ten megabytes,
 * would otherwise cross the wire on every read; `HGET` on a client without it (a hand-rolled fake), read by the same
 * presence rule (`isPausedFlag`).
 */
function pausedAsk(redis, q) {
  return [typeof redis?.hexists === "function" ? "hexists" : "hget", queueKeyOf(q, "meta"), "paused"];
}

/**
 * Whether a queue's meta `paused` field says paused, as BullMQ 5.80.4 reads it: the field's PRESENCE (`HEXISTS` in
 * isQueuePaused.lua and getTargetQueueList), whatever it holds, so `"0"` and `""` are paused too. Its pause writes `1`
 * and its resume deletes the field. `cmd` is the command `pausedAsk` sent: `HEXISTS` answers 1 for a field that is
 * there, `HGET` the value, null for none.
 */
function isPausedFlag(cmd, value) {
  if (cmd === "hexists") return value === 1 || value === "1";
  return value !== null && value !== undefined;
}

/** A queue's key for `type` (`bull:<name>:<type>`, or the queue's own `toKey`, which knows its prefix). */
function queueKeyOf(q, type) {
  return typeof q?.toKey === "function" ? q.toKey(type) : `bull:${q?.name}:${type}`;
}

/**
 * Send `commands` (`[name, ...args]`) as ONE pipeline when the client has one, else the same commands direct, and answer
 * each as `{ value }` or `{ error }`: one bad key (a stray key of the wrong type) costs its own answer, never the read.
 * A pipeline that cannot be sent at all rejects, and the caller reads that as unreachable.
 */
async function batched(redis, commands) {
  if (commands.length === 0) return [];
  if (typeof redis?.pipeline === "function") {
    const p = redis.pipeline();
    for (const [cmd, ...args] of commands) p[cmd](...args);
    const got = await p.exec();
    return commands.map((_, i) => {
      const pair = Array.isArray(got) ? got[i] : null;
      if (!Array.isArray(pair)) return { error: new Error("no answer") };
      return pair[0] ? { error: pair[0] } : { value: pair[1] };
    });
  }
  return Promise.all(
    commands.map(([cmd, ...args]) =>
      Promise.resolve()
        .then(() => {
          if (typeof redis?.[cmd] !== "function") throw new Error(`the client has no ${cmd}`);
          return redis[cmd](...args);
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
    ),
  );
}

/**
 * The ids of a list read, `ZRANGE` (with or without scores) or `LRANGE`, with the scores when there are any: `{ ids,
 * refused }`, `refused` how many members are no run id (`RUN_ID_RE`). A refused member is no row, since an id outside the
 * charset is no name a page may print, but it is a job the read could not show, so it makes its queue's read a floor
 * (`truncated`), never a whole count that misses it: a cron trigger's run id is `repeat:<id>:<ms>`, past 200 for an id
 * over 179 characters, and anything with the Valkey's URL can push a member of its own.
 */
function idsOf(got, { withScores = false } = {}) {
  const raw = Array.isArray(got?.value) ? got.value : [];
  const out = [];
  if (withScores) {
    for (let i = 0; i + 1 < raw.length; i += 2) out.push({ jobId: raw[i], score: raw[i + 1] });
  } else {
    for (const id of raw) out.push({ jobId: id, score: null });
  }
  const ids = out.filter((e) => typeof e.jobId === "string" && RUN_ID_RE.test(e.jobId));
  return { ids, refused: out.length - ids.length };
}

/** A job's attempts as BullMQ reads them (`attemptsMade || atm || 0`): 0 when neither is written, null when malformed. */
function attemptsOf(attemptsMade, atm) {
  const raw = attemptsMade !== null && attemptsMade !== undefined && attemptsMade !== "" ? attemptsMade : atm;
  if (raw === null || raw === undefined || raw === "") return 0;
  return decimalOf(raw);
}

/** A hold as a waiting row carries it, from the worker's `wait:job:<id>` hash, or null when the hash holds no clock. */
function waitingHeldOf(h) {
  if (h === null || typeof h !== "object" || typeof h.since !== "string" || h.since === "") return null;
  return {
    since: instantOf(h.since),
    label: typeof h.label === "string" && WAIT_LABEL_RE.test(h.label) ? h.label : null,
    checks: decimalOf(h.checks) ?? 0,
    after: instantOf(h.after),
    answers: heldAnswersOf(h),
  };
}

/** A project id from `projectOf`, re-checked by the projects id rule, or null. */
function projectIdOf(id) {
  return typeof id === "string" && DEFER_PROJECT_RE.test(id) ? id : null;
}

/**
 * The project a waiting job belongs to, `{ project, from }`, without its data: the worker's record when it named one,
 * else a forge job's repository read off its dedup id (`deid`'s `repo<sep>number:` prefix, the receiver's spelling)
 * through the worker's own `projectOf`, else a cron trigger's folder (the job id's `repeat:<id>:`/`manual:<id>:`)
 * through the triggers file, else none (the console says it is not known until the job starts).
 */
function waitingProjectOf({ record, kind, deid, jobId, projectList, triggerList }) {
  if (record?.project) return { project: record.project, from: "record" };
  if (projectList !== null && kind !== null && isForgeKind(kind) && typeof deid === "string" && deid.length <= DEID_MAX) {
    const m = DEID_TARGET_RE.exec(deid);
    const repo = m ? repoOfTarget(m[1]) : null;
    const id = repo !== null ? projectIdOf(projectOf({ kind, repo }, projectList)) : null;
    if (id !== null) return { project: id, from: "deid" };
  }
  const t = projectList !== null && triggerList !== null ? TRIGGER_JOB_ID_RE.exec(jobId) : null;
  if (t) {
    const trigger = triggerList.find((x) => x?.type === "cron" && x.id === t[2]);
    const id = typeof trigger?.folder === "string" && trigger.folder !== "" ? projectIdOf(projectOf({ kind: "local", folder: trigger.folder }, projectList)) : null;
    if (id !== null) return { project: id, from: "trigger" };
  }
  return { project: null, from: null };
}

/**
 * Hydrate `entries` (`[{ q, jobId, state, score, queuePaused }]`) into waiting rows and scheduled entries, in two more
 * pipelined rounds: each job's short hash fields, its defer record (a delayed job's), its hold (`heldIds` members, or
 * every job when `heldIds` is null), then the scheduler's next instant for each job that names a scheduler. A job whose
 * hash is gone (it left between the reads) is no row. `nowMs` is the read's clock, against which a delayed job is `due`.
 */
async function hydrateWaiting(redis, entries, { heldIds, projectList, triggerList, nowMs }) {
  const cmds = [];
  for (const e of entries) {
    e.atJob = cmds.length;
    cmds.push(["hmget", queueKeyOf(e.q, e.jobId), ...WAITING_JOB_FIELDS]);
    e.atDefer = null;
    if (e.state === "delayed") {
      e.atDefer = cmds.length;
      cmds.push(["hmget", deferKey(e.jobId), ...DEFER_FIELDS]);
    }
    e.atHeld = null;
    if (heldIds === null || heldIds.has(e.jobId)) {
      e.atHeld = cmds.length;
      cmds.push(["hgetall", jobKey(e.jobId)]);
    }
  }
  const got = await batched(redis, cmds);
  // The scheduler's next instant, once per queue and scheduler.
  const nextCmds = [];
  const nextAt = new Map();
  for (const e of entries) {
    const fields = Array.isArray(got[e.atJob]?.value) ? got[e.atJob].value : [];
    e.fields = fields;
    const rjk = typeof fields[2] === "string" && SCHEDULER_ID_RE.test(fields[2]) ? fields[2] : null;
    e.rjk = rjk;
    if (rjk === null) continue;
    const key = `${e.q?.name}\u0000${rjk}`;
    if (!nextAt.has(key)) {
      nextAt.set(key, nextCmds.length);
      nextCmds.push(["zscore", queueKeyOf(e.q, "repeat"), rjk]);
    }
    e.atNext = key;
  }
  const nexts = await batched(redis, nextCmds);
  const rows = [];
  const scheduled = [];
  for (const e of entries) {
    const [name, deid, , atm, attemptsMade, stc, timestamp] = e.fields;
    if (e.fields.length === 0 || e.fields.every((v) => v === null || v === undefined)) continue;
    const nextRaw = e.rjk !== null ? (nexts[nextAt.get(e.atNext)]?.value ?? null) : null;
    const schedulerNext = e.rjk !== null && isSchedulerNext(e.jobId, e.rjk, nextRaw);
    const dueAt = e.state === "delayed" && e.score !== null && e.score !== undefined && e.score !== "" ? dueOfScore(e.score) : null;
    // Past its due by more than the grace, and no worker has taken it: `due`, whatever its record says. A scheduler's
    // next run that is overdue is in line too (its fire time came), as one in the wait list is.
    const overdue = dueAt !== null && Number.isSafeInteger(nowMs) && dueAt < nowMs - WAITING_DUE_GRACE_MS;
    if (e.state === "delayed" && schedulerNext && !overdue) {
      scheduled.push({ jobId: e.jobId, queue: e.q?.name ?? "-", schedulerId: e.rjk, dueAt });
      continue;
    }
    const parsed = e.atDefer !== null ? parseDefer(Array.isArray(got[e.atDefer]?.value) ? got[e.atDefer].value : null) : null;
    // A `why` outside the reason charset is no reason at all (`parseDefer`), so its hash is no record either: a held job
    // with one still waits on its check.
    const recorded = parsed?.why === null ? null : parsed;
    const record = recordMatchesDue(recorded, dueAt) ? recorded : null;
    const held = e.atHeld !== null ? waitingHeldOf(got[e.atHeld]?.value ?? null) : null;
    const kind = typeof name === "string" && WAITING_KIND_RE.test(name) ? name : null;
    let bucket;
    if (overdue) bucket = "due";
    else if (e.state === "delayed") bucket = record !== null ? record.bucket : held !== null ? "check" : "none";
    // A paused queue keeps its prioritized jobs in their set (BullMQ's pause renames only the wait list), so a job there
    // waits on the pause, not on a slot.
    else if (e.state === "paused" || e.queuePaused) bucket = "paused";
    else bucket = "slot";
    const { project, from } = waitingProjectOf({ record, kind, deid, jobId: e.jobId, projectList, triggerList });
    // The scheduler's run of slot `<millis>` became eligible AT that slot; its hash's timestamp is when the run before it
    // minted it, one period earlier (queued-at.integration.test.mjs pins the same for the record's `queuedAt`).
    let queuedAt = instantOf(timestamp);
    const t = TRIGGER_JOB_ID_RE.exec(e.jobId);
    if (t && t[1] === "repeat" && t[2] === e.rjk) {
      const slot = instantOf(t[3]);
      if (slot !== null && (queuedAt === null || slot > queuedAt)) queuedAt = slot;
    }
    rows.push({
      jobId: e.jobId,
      queue: e.q?.name ?? "-",
      state: e.state,
      bucket,
      why: record?.why ?? null,
      known: record?.known === true,
      dueAt,
      queuedAt,
      recordedAt: record?.at ?? null,
      untilAt: record?.until ?? null,
      project,
      projectFrom: from,
      host: record?.host ?? null,
      holder: record?.holder ?? null,
      endpoint: record?.endpoint ?? null,
      budgetWhy: record?.budgetWhy ?? null,
      trigger: record?.trigger ?? null,
      attempt: record?.attempt ?? null,
      attempts: record?.attempts ?? null,
      attemptsMade: attemptsOf(attemptsMade, atm),
      stalled: stc === null || stc === undefined || stc === "" ? 0 : decimalOf(stc),
      kind,
      recovery: RECOVERY_JOB_ID_RE.test(e.jobId),
      schedulerNext,
      held,
    });
  }
  return { rows, scheduled };
}

/** Oldest first by `queuedAt` (an unknown one last), then queue and id, so two reads of one queue order alike. */
function byQueuedAt(a, b) {
  const qa = a.queuedAt ?? Infinity;
  const qb = b.queuedAt ?? Infinity;
  if (qa !== qb) return qa < qb ? -1 : 1;
  if (a.queue !== b.queue) return a.queue < b.queue ? -1 : 1;
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
}

/** The projects list from what a caller passes: the list, or `readProjects`' `{ projects }`; null for anything else. */
function projectListOf(projects) {
  if (Array.isArray(projects)) return projects;
  return Array.isArray(projects?.projects) ? projects.projects : null;
}

/** The triggers list from what a caller passes: the list, or the triggers view `{ triggers }`; null otherwise. */
function triggerListOf(triggers) {
  if (Array.isArray(triggers)) return triggers;
  return Array.isArray(triggers?.triggers) ? triggers.triggers : null;
}

/**
 * The jobs of `queues` that have not started, and why each waits (issue #737, `DES-WAITING-REASONS`). Never throws:
 * `{ unreachable: true }` when Valkey could not be read within `timeoutMs` (a boolean: whatever the client said, which
 * can name a host, stays in this process). Otherwise:
 *
 *   { at, rows, scheduled, byBucket, byQueue, truncated, queuesCut }
 *
 * `rows` are the jobs in line, oldest `queuedAt` first, each `{ jobId, queue, state, bucket, why, known, dueAt,
 * queuedAt, recordedAt, untilAt, project, projectFrom, host, holder, endpoint, budgetWhy, trigger, attempt, attempts,
 * attemptsMade, stalled, kind, recovery, schedulerNext, held }`; `scheduled` the delayed runs that are a cron trigger's
 * next fire (`{ jobId, queue, schedulerId, dueAt }`), which are not in line; `byBucket` the rows per `DEFER_BUCKETS`
 * bucket; `byQueue` per queue read `{ queue, inLine, scheduled, truncated }`; `queuesCut` how many of `queues` were not
 * read, past the first `WAITING_QUEUES_MAX`; `truncated` whether the rows are a floor (a queue truncated, or a queue
 * cut). A queue is truncated when a list holds more than the read takes, or a member the read refuses as no run id.
 *
 * WHY A JOB WAITS is the worker's own record of it (`defer:job:<id>`, written as it defers: `INT-DEFER-REASON-KEY`),
 * never a guess from the job:
 *   - a delayed job whose due instant is more than `WAITING_DUE_GRACE_MS` before the read is `due` ("Due since {due};
 *     no worker has taken it"), whatever its record says, its scheduler's next run included;
 *   - a delayed job that is its scheduler's current next run (`isSchedulerNext`: BullMQ's own test) is scheduled, not in
 *     line. A `repeat:` job a gate deferred after its scheduler minted the next one is a real run, and it IS in line;
 *   - a delayed job with a record: the record's bucket (`parseDefer`'s, so a reason this console has no words for is
 *     its own bucket, `unknown`, never `none`); one held on `run.waitFor` with none: `check`; neither: `none`,
 *     "no reason was recorded" (a worker older than the record, a raw rejection the queue retried, an `opts.delay`). A
 *     record whose span disagrees with the job's due instant (`DEFER_STALE_MS`) is an earlier episode's, and is none;
 *     one whose `why` fails the reason charset is no record at all;
 *   - a job in the wait list or the prioritized set waits for a free slot, unless its queue is paused; one in the
 *     paused list waits on the pause.
 * The due instant is the delayed set's score (`dueOfScore`), BullMQ's own; the record's `until` beside it is the
 * deferring worker's clock.
 *
 * WHAT IT READS, and what it never does. Per queue, in ONE pipeline: the delayed set's first `perList + 1` ids with
 * their scores (the soonest due), the prioritized set's first (the next to run), the wait and paused lists' LAST
 * `perList + 1` (BullMQ pushes on the left and takes from the right, so the right end is the oldest), and whether the
 * queue's paused flag is there (`HEXISTS`, `pausedAsk`); beside them `wait:held`. Then per job: `WAITING_JOB_FIELDS`
 * of its hash (`HMGET`), a delayed job's defer record (`HMGET` of `DEFER_FIELDS`) and a held job's `wait:job` hash.
 * Then `ZSCORE` of each named scheduler. Never a job's `data`, `opts`, `stacktrace` or `returnvalue`, never
 * `getJob`/`getJobs` (each hydrates the data), never a keyspace walk, and no write of any kind: a stale `wait:held`
 * member is skipped, not pruned. One read past
 * `perList` in any of the four lists marks the queue truncated, and so does a member of one that is no run id (`idsOf`);
 * its rows are then a floor. `perList` (at most
 * `WAITING_PER_LIST_MAX`, which a larger one is cut to) bounds each list, so one queue gives at most four times it, and
 * `WAITING_QUEUES_MAX` bounds the queues, the first of `queues` in the caller's order: a SCAN finds any meta key a
 * writer plants, so the queue count is a Valkey's to grow, and each costs five commands and four lists of rows.
 *
 * Every value is re-checked on the way out (the record by `parseDefer`, the hash fields here), because these keys live
 * in a Valkey anything with its URL can write. The project is the record's, else read off the dedup id or the cron
 * trigger's folder (`waitingProjectOf`) when `projects` (and `triggers`) are given.
 */
export async function readWaiting(redis, { queues, now = () => Date.now(), perList = WAITING_PER_LIST_MAX, timeoutMs = FLEET_READ_TIMEOUT_MS, projects = null, triggers = null } = {}) {
  const bound = Number.isSafeInteger(perList) && perList >= 1 && perList <= WAITING_PER_LIST_MAX ? perList : WAITING_PER_LIST_MAX;
  const named = Array.isArray(queues) ? queues.filter((q) => typeof q?.name === "string" && q.name !== "") : [];
  const list = named.slice(0, WAITING_QUEUES_MAX);
  const queuesCut = named.length - list.length;
  const projectList = projectListOf(projects);
  const triggerList = triggerListOf(triggers);
  const read = async () => {
    const at = now();
    const cmds = [];
    for (const q of list) {
      cmds.push(["zrange", queueKeyOf(q, "delayed"), 0, bound, "WITHSCORES"]);
      cmds.push(["zrange", queueKeyOf(q, "prioritized"), 0, bound]);
      cmds.push(["lrange", queueKeyOf(q, "wait"), -(bound + 1), -1]);
      cmds.push(["lrange", queueKeyOf(q, "paused"), -(bound + 1), -1]);
      cmds.push(pausedAsk(redis, q));
    }
    cmds.push(["smembers", HELD_SET]);
    const got = await batched(redis, cmds);
    const heldRaw = got[cmds.length - 1]?.value;
    const heldIds = new Set(Array.isArray(heldRaw) ? heldRaw.filter((id) => typeof id === "string") : []);
    const entries = [];
    const perQueueInfo = [];
    list.forEach((q, qi) => {
      const base = qi * 5;
      const lists = [idsOf(got[base], { withScores: true }), idsOf(got[base + 1]), idsOf(got[base + 2]), idsOf(got[base + 3])];
      const [delayed, prioritized, wait, paused] = lists.map((l) => l.ids);
      const queuePaused = isPausedFlag(cmds[base + 4][0], got[base + 4]?.value);
      // A member that is no run id is a job this read cannot show (`idsOf`): the queue's rows are then a floor.
      let truncated = lists.some((l) => l.refused > 0);
      // The delayed and prioritized sets are read from their head (soonest due, next to run): the extra is the last.
      // The lists from their tail (oldest): the extra is the first.
      const cut = (items, fromHead) => {
        if (items.length <= bound) return items;
        truncated = true;
        return fromHead ? items.slice(0, bound) : items.slice(items.length - bound);
      };
      const seen = new Set();
      const add = (items, state) => {
        for (const { jobId, score } of items) {
          if (seen.has(jobId)) continue; // a job moving between two lists while they were read is one job
          seen.add(jobId);
          entries.push({ q, jobId, state, score, queuePaused });
        }
      };
      add(cut(delayed, true), "delayed");
      add(cut(prioritized, true), "prioritized");
      add(cut(wait, false), "waiting");
      add(cut(paused, false), "paused");
      perQueueInfo.push({ queue: q.name, truncated });
    });
    const { rows, scheduled } = await hydrateWaiting(redis, entries, { heldIds, projectList, triggerList, nowMs: at });
    rows.sort(byQueuedAt);
    scheduled.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    const byBucket = Object.fromEntries(DEFER_BUCKETS.map((b) => [b, 0]));
    for (const r of rows) byBucket[r.bucket] += 1;
    const byQueue = perQueueInfo.map(({ queue, truncated }) => ({
      queue,
      inLine: rows.filter((r) => r.queue === queue).length,
      scheduled: scheduled.filter((s) => s.queue === queue).length,
      truncated,
    }));
    return { at, rows, scheduled, byBucket, byQueue, truncated: queuesCut > 0 || byQueue.some((q) => q.truncated), queuesCut };
  };
  try {
    return await withTimeout(read(), timeoutMs, { unreachable: true });
  } catch {
    return { unreachable: true };
  }
}

/**
 * ONE job's waiting row (issue #737), `readWaiting`'s row for it, for the cancel-queued planner: `{ row }`, `{ scheduled }`
 * (it is its scheduler's next run), `{ gone: true }` (its hash is gone) or `{ unreachable: true }`. `q` is the queue that
 * holds it and `state` the state the caller read; `now` the clock it is `due` against. The same reads per job as
 * `readWaiting` (its delayed score, its queue's paused flag, its short hash fields, its record and its hold), never its
 * data. Its hold is read whatever `wait:held` says, since one key costs one read here. Never throws.
 */
export async function readWaitingRow(redis, { q, jobId, state, now = () => Date.now(), timeoutMs = FLEET_READ_TIMEOUT_MS, projects = null, triggers = null } = {}) {
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId) || !WAITING_STATES.includes(state)) return { gone: true };
  const read = async () => {
    const ask = pausedAsk(redis, q);
    const [meta, score] = await batched(redis, [ask, ...(state === "delayed" ? [["zscore", queueKeyOf(q, "delayed"), jobId]] : [])]);
    const entry = { q, jobId, state, score: score?.value ?? null, queuePaused: isPausedFlag(ask[0], meta?.value) };
    const { rows, scheduled } = await hydrateWaiting(redis, [entry], { heldIds: null, projectList: projectListOf(projects), triggerList: triggerListOf(triggers), nowMs: now() });
    if (scheduled.length > 0) return { scheduled: scheduled[0] };
    return rows.length > 0 ? { row: rows[0] } : { gone: true };
  };
  try {
    return await withTimeout(read(), timeoutMs, { unreachable: true });
  } catch {
    return { unreachable: true };
  }
}

/**
 * This host's run records, newest first, read at most once per `ttlMs` (issue #641; the dollar records' 15 s rhythm).
 * `records()` returns `{ records, capped }` or `{ unreachable }` (an unreadable directory, never a throw; a missing one
 * is an empty history). At most `RUNS_INDEX_MAX` records are kept, the mirror's own cap, so the index costs what the
 * fleet view already does; `capped` says older ones exist on disk that no page reaches.
 */
export function makeLocalRunIndex({ logsDir, fs = nodeFs, now = () => Date.now(), ttlMs = DOLLAR_RECORDS_TTL_MS, max = RUNS_INDEX_MAX } = {}) {
  let cache = null;
  return {
    records() {
      const at = now();
      if (cache && at >= cache.at && at - cache.at < ttlMs) return cache.value;
      let names;
      let value;
      try {
        names = fs.readdirSync(logsDir);
      } catch (err) {
        names = null;
        value = err?.code === "ENOENT" ? { records: [], capped: false } : { unreachable: `logs dir unreadable (${err?.code ?? "read-error"})` };
      }
      if (names !== null) {
        const records = [];
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const record = readJsonFile(join(logsDir, name), fs);
          if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
        }
        records.sort(byRunAtDesc);
        value = { records: records.slice(0, max), capped: records.length > max };
      }
      cache = { at, value };
      return value;
    },
  };
}

/** The most records one `readRunsPage` examines, both sources together, before it answers with what it has. */
export const RUNS_PAGE_EXAMINE_MAX = 2000;
const RUNS_PAGE_BATCH = 200;

/**
 * One page of the merged run history, newest first (issue #641): `{ runs, next, mirror, truncated, examined }`, or
 * `{ refusal }` for a cursor or limit it will not take, or `{ runs: [], next: null, mirror, unreachable }` when this
 * host's logs directory is unreadable (the `mergedRunsOn` posture: the mirror cannot stand in for this host's own
 * history).
 *
 * THE CURSOR IS A SCORE, NOT AN OFFSET. `before` (millis, exclusive) is the instant of the last run the previous page
 * showed, so a run that lands while an operator pages lands ABOVE every cursor already handed out and moves nothing: an
 * offset would shift every later page by one and show one run twice. A page never ends inside a group of runs that share
 * one instant (it takes the whole group), because `(before` would otherwise skip the rest of it.
 *
 * `match` (issue #647) is a caller's predicate applied beside `filter`, never parsed from a URL: `/api/run` passes the
 * exact-target comparison (`targetKeyOf`), so `limit` counts runs on THAT target, where the filter's substring `q` let
 * `#120`, `#121`... fill the page and crowd out `#12`.
 *
 * FILTERED AFTER FETCHING, so it fetches in batches (`RUNS_PAGE_BATCH` from each source) until `limit` runs match or
 * both sources are exhausted, and stops at `examineMax` records examined. Stopping there reports `truncated: true` with
 * a `next` that resumes exactly where the examination stopped (`floor + 1`: every run above the floor was examined, the
 * runs AT it may not have been). A run is final only once both sources have been read past it: the mirror's batch and
 * the local batch each end somewhere, and a run between the two ends could still be outranked by one not yet fetched.
 *
 * The mirror side is the read-only `readMirroredPage` (no prune, nothing written); the local side is `localIndex` (a
 * `makeLocalRunIndex`, which the fleet reader holds across requests; a fresh one is read when none is passed). Merged
 * by the worker's `mergeRuns`, so a retry on another host shows the later attempt exactly as the TUI does. Named
 * residual: a job whose two attempts straddle a page boundary can show its earlier attempt on the later page.
 */
export async function readRunsPage(redis, { logsDir, before = null, limit = 50, filter = null, match = null, fs = nodeFs, now = () => Date.now(), timeoutMs = 2500, localIndex = null, examineMax = RUNS_PAGE_EXAMINE_MAX } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { refusal: "limit must be a whole number from 1 to 100" };
  if (before !== null && before !== undefined && !(Number.isSafeInteger(before) && before >= 0)) return { refusal: "before must be a non-negative whole number of milliseconds" };
  const bound = before === null || before === undefined ? null : before;
  const index = localIndex ?? makeLocalRunIndex({ logsDir, fs, now });
  const read = index.records();
  if (!Array.isArray(read?.records)) return { runs: [], next: null, mirror: "off", ...read };
  const local = bound === null ? read.records : read.records.filter((r) => runAt(r) < bound);

  let mirror = redis ? null : "off";
  let mirrored = [];
  let mirrorFetched = 0;
  let mirrorFrontier = null;
  let mirrorDone = !redis;
  let localTaken = 0;
  let examined = 0;
  for (;;) {
    if (!mirrorDone) {
      const page = await readMirroredPage(redis, { before: bound, offset: mirrorFetched, limit: RUNS_PAGE_BATCH, timeoutMs });
      if (page.degraded !== "ok") {
        // Unreachable part-way is unreachable: what was fetched is dropped rather than merged as if it were whole,
        // and the page is this host's own history, saying so.
        mirror = page.degraded;
        mirrored = [];
        mirrorDone = true;
      } else {
        if (mirror === null) mirror = "ok";
        mirrored.push(...page.runs);
        mirrorFetched += page.fetched;
        examined += page.fetched;
        if (page.fetched < RUNS_PAGE_BATCH) mirrorDone = true;
        else mirrorFrontier = page.frontier;
      }
    }
    const takeTo = Math.min(local.length, localTaken + RUNS_PAGE_BATCH);
    examined += takeTo - localTaken;
    localTaken = takeTo;
    const localFrontier = localTaken >= local.length ? null : runAt(local[localTaken - 1]);
    const frontiers = [mirrorDone ? null : mirrorFrontier, localFrontier].filter((f) => f !== null);
    // Every run strictly above the floor has been read from both sources; null means everything has.
    const floor = frontiers.length === 0 ? null : Math.max(...frontiers);
    const merged = mergeRuns(local.slice(0, localTaken), mirrored, { limit: Infinity }).sort(byRunAtDesc);
    const final = floor === null ? merged : merged.filter((r) => runAt(r) > floor);
    const matched = final.filter((r) => (!filter || runMatches(r, filter)) && (typeof match !== "function" || match(r) === true));
    if (matched.length > limit || floor === null || examined >= examineMax) {
      let runs = matched.slice(0, limit);
      if (matched.length > limit) {
        const lastAt = runAt(runs[runs.length - 1]);
        let k = limit;
        while (k < matched.length && runAt(matched[k]) === lastAt) k += 1;
        runs = matched.slice(0, k);
      }
      let next = null;
      let truncated = false;
      if (matched.length > runs.length) next = runAt(runs[runs.length - 1]);
      else if (floor !== null) {
        truncated = true;
        next = floor + 1;
      }
      if (next !== null && !Number.isFinite(next)) next = null;
      // An empty first range is either an index that does not exist (a single host, or a fleet below the floor:
      // "off", exactly as `readMirroredRuns` says it) or one that holds nothing older than the cursor ("ok").
      if (mirror === "ok" && mirrorFetched === 0) {
        const exists = await withTimeout(Promise.resolve().then(() => redis.exists(RUNS_INDEX)).catch(() => null), timeoutMs, null);
        if (exists === 0) mirror = "off";
      }
      return { runs, next, mirror: mirror ?? "off", truncated, examined };
    }
  }
}

/** A job id this reader will look up: the shapes the worker mints (`gh-…`, `repeat:<id>:<ms>`, a uuid), bounded. */
export const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** `readRunById`'s `unreadable` for this host's record file: it is there, and it is not a record that can be read. */
export const RUN_FILE_UNREADABLE = "this host's record of the run could not be read";
/** `readRunById`'s `unreadable` for the fleet's run mirror: no answer, or a value there that is not a record. */
export const RUN_MIRROR_UNREAD = "the fleet's run mirror could not be read";
/** A run's record as a caller says it when the reader itself failed (it threw): neither side is known. */
export const RUN_RECORD_UNREAD = "the run's record could not be read";

/**
 * One run by its job id (issue #641): `{ record, source }` with `source` "local" or "mirror", `{ missing: true }`,
 * `{ unreadable }`, or `{ invalid }` for an id outside the charset (checked FIRST, before any path or key is built from
 * it). This host's file first, because the file is the record and the mirror a view of it; then the mirror's by-id GET,
 * the one the lost-lock check already uses.
 *
 * `missing` IS A CLAIM THAT BOTH WERE READ (issue #737): no file here (the worker's own reader, `makeReadRecord`, which
 * tells no file from one it cannot read) and no key in the mirror. Anything else that found no record is
 * `{ unreadable }`, a fixed sentence (`RUN_FILE_UNREADABLE`, `RUN_MIRROR_UNREAD`): a file that is there but is not a
 * record, a mirror that did not answer within `timeoutMs` or could not be reached, a mirrored value that is not a
 * record (never shown), or no client to ask it with. A record either side can read is the answer whatever the other
 * said.
 */
export async function readRunById(redis, { logsDir, jobId, fs = nodeFs, timeoutMs = 2500 } = {}) {
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { invalid: "a run id is letters, digits and . _ : -, at most 200 characters" };
  const local = makeReadRecord({ logsDir, fs })(jobId);
  if (local !== null && local !== UNREADABLE_RECORD) return { record: local, source: "local" };
  const mirrored = redis ? await readMirroredRecord(redis, sanitizeJobId(jobId), { timeoutMs, tellUnread: true }) : UNREAD_RECORD;
  if (mirrored !== null && mirrored !== UNREADABLE_RECORD && mirrored !== UNREAD_RECORD) return { record: mirrored, source: "mirror" };
  if (local === UNREADABLE_RECORD) return { unreadable: RUN_FILE_UNREADABLE };
  return mirrored === null ? { missing: true } : { unreadable: RUN_MIRROR_UNREAD };
}

/**
 * The places a run is kept, as a page or an answer names one it could not read ("could not read <place>"):
 * `runPlaces`' `unread` words, in this order.
 */
export const RUN_PLACES = Object.freeze({
  file: "this host's record of the run",
  mirror: "the fleet's run mirror",
  record: "the run's record",
  queues: "every queue",
  transcript: "the live transcript",
  progress: "the run's progress",
});

/** `runPlaces`' `unread` as one phrase: "a", "a and b", "a, b and c". */
export function runPlacesText(unread) {
  const list = Array.isArray(unread) ? unread : [];
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/**
 * What each place a run is kept says of a run id (issue #737): `{ shown, unread }`. `shown` is true when one shows a
 * run: a record; the queue holding the job, or its run's active or queued recovery; the live transcript; a progress
 * snapshot. `unread` names, in `RUN_PLACES`' words and order, each place that gave no answer of its own: a record that
 * could not be read (`readRunById`'s `unreadable`, by its sentence), a queue lookup that was not whole, failed or was
 * not made, a stream or progress read that did not answer or answered something else, and a place with no reader at
 * all. `run` is `readRunById`'s answer (`missing`: this host's file and the fleet's mirror both read, neither holds
 * one); `lookup` the queue lookup's WHOLE answer, `chatFactsOf`'s (`found: false`, no queue holds the job with every
 * queue asked over a scan made after the question, and no `activeJobId` or `queuedJobId`, no recovery of its run
 * either); `transcript` the live stream's (`readTranscriptMeta`, `exists: false` read); `progress` the progress key's
 * (`readProgress`, `absent`).
 *
 * THE ONE RULE for the run page's status and `/api/run`'s answer: a run that a place shows is a run (200); one that none
 * shows while a place is unread could not be told (503, naming the places); and only one that none shows with every
 * place read, each saying its own none, is absent (`runAbsent`: the run-not-found page, 404).
 */
export function runPlaces({ run, lookup, transcript, progress } = {}) {
  const obj = (v) => v !== null && typeof v === "object";
  const id = (v) => typeof v === "string" && v !== "";
  const unread = [];
  let shown = false;
  if (obj(run) && run.record) shown = true;
  else if (!(obj(run) && run.missing === true)) unread.push(run?.unreadable === RUN_FILE_UNREADABLE ? RUN_PLACES.file : run?.unreadable === RUN_MIRROR_UNREAD ? RUN_PLACES.mirror : RUN_PLACES.record);
  if (obj(lookup) && (lookup.found === true || id(lookup.activeJobId) || id(lookup.queuedJobId))) shown = true;
  else if (!(obj(lookup) && !lookup.unreachable && lookup.found === false)) unread.push(RUN_PLACES.queues);
  if (obj(transcript) && transcript.exists === true) shown = true;
  else if (!(obj(transcript) && transcript.exists === false && !transcript.unreachable && !transcript.invalid)) unread.push(RUN_PLACES.transcript);
  if (isProgressSnapshot(progress)) shown = true;
  else if (!(obj(progress) && progress.absent === true)) unread.push(RUN_PLACES.progress);
  return { shown, unread };
}

/**
 * Whether a run id names no run at all (issue #737, `runPlaces`' rule): no place shows a run, and EVERY place was read
 * and said it holds none, each in its own explicit words. An answer that is not its place's none (unreadable,
 * unreachable, timed out, invalid, a lookup over a set that was not whole, or no reader at all) is no absence: the
 * caller keeps the run's page, or answers that the run could not be told, rather than say a run that may exist does not.
 */
export function runAbsent(places = {}) {
  const { shown, unread } = runPlaces(places);
  return !shown && unread.length === 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// The live transcript stream (issue #643, INT-LIVE-TRANSCRIPT-STREAM): the worker publishes a running job's redacted
// transcript to `run:live:<sanitized id>` as a capped Valkey stream; these read it, for the TUI's LIVE_TAIL and the
// console's run page. THE ENTRIES ARE AGENT-WRITTEN TEXT: the worker redacts the job's secrets and escapes the control
// class, and every surface still treats `text` as untrusted (scrub, then width; escape, then markup). Nothing here logs
// or keeps an entry.
//
// NON-BLOCKING BY CONSTRUCTION. Every read is an XRANGE (or XREVRANGE / XLEN), which answers at once, and never a
// blocking XREAD: the fleet reader holds ONE client for the whole snapshot, and a `BLOCK` read on it would park every
// GET and MGET of the next tick behind it for as long as the block lasts. Polling at the surface's own refresh rhythm
// costs one round trip a second; a blocking read would cost a second connection or a frozen panel.
// ---------------------------------------------------------------------------------------------------------------------

/** A stream entry id as Valkey writes it (`<ms>-<seq>`), bounded. The cursor is checked against it before any key or argument is built. */
export const TRANSCRIPT_ID_RE = /^\d{1,16}-\d{1,10}$/;
/** The most entries one read returns: the contract's page bound, so a hostile `count` cannot ask for the whole stream. */
export const TRANSCRIPT_PAGE_MAX = 200;
// The tool-name charset (`LIVE_TOOL_RE`: anything else reads as `?`) and the `end` entry's outcome vocabulary
// (`LIVE_OUTCOMES`: anything else reads as `unknown`, never free text) are the worker's, imported above.
/**
 * A belt over the worker's own cap (8192 code points for an assistant's text, after which the escaped form can grow by at
 * most ten units per character): a stream written by something other than this worker cannot hand a surface a megabyte
 * line. Cut at a code point, and marked truncated, as the worker marks its own cuts.
 */
const TRANSCRIPT_TEXT_MAX_UNITS = 65536;
const TRANSCRIPT_TIMEOUT_MS = 2500;

function transcriptRefusal(jobId, after) {
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { invalid: "a run id is letters, digits and . _ : -, at most 200 characters" };
  if (after !== null && after !== undefined && (typeof after !== "string" || !TRANSCRIPT_ID_RE.test(after))) return { invalid: "a transcript cursor is a stream id (<ms>-<seq>)" };
  return null;
}

/**
 * Order two stream ids (both already matched TRANSCRIPT_ID_RE) the way Valkey orders them: by milliseconds, then by
 * sequence, each as a NUMBER. One MULTI writes many entries in the same millisecond, so `<ms>-10` after `<ms>-9` is
 * normal, and a string compare would put it first. BigInt, because 16 digits passes 2^53. null (no cursor yet, the
 * stream's beginning) sorts before every id. The one ordering every transcript reader uses: this module's `ended`, and
 * the console hub's cursors (console/live.mjs).
 */
export function compareTranscriptIds(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const [am, as] = a.split("-").map(BigInt);
  const [bm, bs] = b.split("-").map(BigInt);
  return am === bm ? (as < bs ? -1 : as > bs ? 1 : 0) : am < bm ? -1 : 1;
}

/**
 * One raw XRANGE row (`[id, [field, value, ...]]`) as a display entry, or null for a row whose id is not a stream id.
 * Only the contract's fields are read, each from its FIRST occurrence and only as a string; an unknown `kind` is kept as
 * a `note` (a newer worker's kind still shows, as the plain line it is), so a reader one version behind degrades rather
 * than drops.
 */
function transcriptEntryOf(row) {
  const id = Array.isArray(row) ? row[0] : null;
  if (typeof id !== "string" || !TRANSCRIPT_ID_RE.test(id)) return null;
  const list = Array.isArray(row[1]) ? row[1] : [];
  const f = {};
  for (let i = 0; i + 1 < list.length; i += 2) {
    const name = list[i];
    const value = list[i + 1];
    if (typeof name !== "string" || typeof value !== "string" || Object.hasOwn(f, name)) continue;
    if (name === "kind" || name === "ts" || name === "text" || name === "tool" || name === "error" || name === "truncated" || name === "outcome") f[name] = value;
  }
  const kind = LIVE_KINDS.includes(f.kind) ? f.kind : "note";
  let text = typeof f.text === "string" && kind !== "reset" && kind !== "skipped" && kind !== "end" ? f.text : null;
  let truncated = f.truncated === "1";
  if (text !== null && text.length > TRANSCRIPT_TEXT_MAX_UNITS) {
    text = dropLoneHighSurrogate(text.slice(0, TRANSCRIPT_TEXT_MAX_UNITS));
    truncated = true;
  }
  return {
    id,
    kind,
    ts: typeof f.ts === "string" && /^\d{1,16}$/.test(f.ts) ? Number(f.ts) : null,
    text,
    tool: kind === "tool-call" || kind === "tool-result" ? (typeof f.tool === "string" && LIVE_TOOL_RE.test(f.tool) ? f.tool : "?") : null,
    error: kind === "tool-result" && f.error === "1",
    truncated,
    outcome: kind === "end" ? (LIVE_OUTCOMES.includes(f.outcome) ? f.outcome : "unknown") : null,
  };
}

function dropLoneHighSurrogate(s) {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

function transcriptCount(count) {
  return Number.isSafeInteger(count) && count >= 1 ? Math.min(count, TRANSCRIPT_PAGE_MAX) : TRANSCRIPT_PAGE_MAX;
}

async function boundedTranscriptRead(work, timeoutMs) {
  const ms = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : TRANSCRIPT_TIMEOUT_MS;
  try {
    return await withTimeout(work(), ms, { unreachable: "timed out reaching the transcript" });
  } catch (err) {
    return { unreachable: transcriptFailure(err) };
  }
}

/**
 * Why a transcript read failed, WITHOUT the error's own text: a connection error's message names the server
 * (`connect ECONNREFUSED 10.0.0.1:6379`), and this reason reaches the TUI's tail and the console. Only the error's code
 * survives (`err.code`, a token such as ECONNREFUSED or ETIMEDOUT), so the operator still learns refused from reset.
 */
const TRANSCRIPT_ERROR_CODE_RE = /^E[A-Z0-9_]{2,31}$/;
function transcriptFailure(err) {
  const code = typeof err?.code === "string" && TRANSCRIPT_ERROR_CODE_RE.test(err.code) ? err.code : null;
  return code ? `the transcript could not be read (${code})` : "the transcript could not be read";
}

/**
 * A job's transcript entries after `after`, ON A CLIENT THE CALLER OWNS (never disconnected): `{ entries, next, ended,
 * outcome }`, `{ invalid }` for a job id outside the run-id charset or a cursor that is not a stream id (both checked
 * BEFORE the key is built), or `{ unreachable }`. Never throws.
 *
 *   - `after` absent or null reads from the start (`-`); otherwise the read is EXCLUSIVE (`(after`), so a cursor handed
 *     back as `next` never returns its own entry twice.
 *   - `count` is clamped to 1..TRANSCRIPT_PAGE_MAX (200); a page that comes back full means more may wait.
 *   - `next` is the last entry's id, or `after` unchanged (null when there was none) when nothing is new.
 *   - `ended` is true once the reader has read UP TO the stream's `end` entry: the stream's last entry is `end` and
 *     `next` is at or past it. It is computed from the stream, not from the page, so a reader resuming after the end
 *     (a reconnect whose cursor is the `end` entry's id) still learns that the run is over. `outcome` is the end
 *     entry's outcome when ended, else null.
 *
 * Two commands, XRANGE for the page and an XREVRANGE COUNT 1 for the stream's last entry, issued together.
 */
export async function readTranscriptSince(redis, jobId, after = null, { count = TRANSCRIPT_PAGE_MAX, timeoutMs = TRANSCRIPT_TIMEOUT_MS } = {}) {
  const refused = transcriptRefusal(jobId, after);
  if (refused) return refused;
  if (!redis) return { unreachable: "no Valkey client" };
  const key = liveKeyFor(jobId);
  const n = transcriptCount(count);
  const start = typeof after === "string" ? `(${after}` : "-";
  return boundedTranscriptRead(async () => {
    const [rows, lastRows] = await Promise.all([redis.xrange(key, start, "+", "COUNT", n), redis.xrevrange(key, "+", "-", "COUNT", 1)]);
    const entries = (Array.isArray(rows) ? rows : []).map(transcriptEntryOf).filter((e) => e !== null);
    const next = entries.length > 0 ? entries[entries.length - 1].id : typeof after === "string" ? after : null;
    const last = Array.isArray(lastRows) && lastRows.length > 0 ? transcriptEntryOf(lastRows[0]) : null;
    const ended = last !== null && last.kind === "end" && next !== null && compareTranscriptIds(next, last.id) >= 0;
    return { entries, next, ended, outcome: ended ? last.outcome : null };
  }, timeoutMs);
}

/**
 * What the job's stream holds, without its text, ON A CLIENT THE CALLER OWNS: `{ exists, ended, outcome, length,
 * firstId, lastId }`, `{ invalid }` or `{ unreachable }`. `exists` false (length 0, every id null) is a job that never
 * published, published with `PI_LIVE_TRANSCRIPTS=0`, or whose stream has expired (24 h after its end, 7 days after its
 * first write); the stream itself cannot tell those apart, and a surface says so rather than picking one. `length` is
 * what the stream holds NOW, after the worker's `MAXLEN ~ 2000` trim, so `firstId` may be later than the run's first
 * entry. Never throws.
 */
export async function readTranscriptMeta(redis, jobId, { timeoutMs = TRANSCRIPT_TIMEOUT_MS } = {}) {
  const refused = transcriptRefusal(jobId, null);
  if (refused) return refused;
  if (!redis) return { unreachable: "no Valkey client" };
  const key = liveKeyFor(jobId);
  return boundedTranscriptRead(async () => {
    const [len, firstRows, lastRows] = await Promise.all([redis.xlen(key), redis.xrange(key, "-", "+", "COUNT", 1), redis.xrevrange(key, "+", "-", "COUNT", 1)]);
    const length = Number.isSafeInteger(Number(len)) && Number(len) > 0 ? Number(len) : 0;
    const first = Array.isArray(firstRows) && firstRows.length > 0 ? transcriptEntryOf(firstRows[0]) : null;
    const last = Array.isArray(lastRows) && lastRows.length > 0 ? transcriptEntryOf(lastRows[0]) : null;
    const exists = length > 0 && last !== null;
    const ended = exists && last.kind === "end";
    return { exists, ended, outcome: ended ? last.outcome : null, length: exists ? length : 0, firstId: exists ? first?.id ?? null : null, lastId: exists ? last.id : null };
  }, timeoutMs);
}

// ---------------------------------------------------------------------------------------------------------------------
// Run progress (issue #644, INT-RUN-PROGRESS-KEY): the worker keeps a running job's progress summary in
// `run:progress:<sanitized id>`, one JSON string. These read it, for the console and the `/dispatch` panel.
//
// ADVISORY, FORGEABLE AND PART MODEL TEXT. The worker builds the snapshot from a session file the agent can write, so
// nothing here judges a run by it. Its `phases` and `note` are the model's own words (redacted and escaped by the
// worker): they reach an operator's run page and the TUI alone, escaped again there, and never a list, a hub panel's
// shared snapshot or `/api/state`, which get `activeProgressOf`'s integers and a charset-checked tool name only.
//
// STRICT. A key is read as a snapshot only when every field is the contract's: `v` 1, no field the contract does not
// name, every number a non-negative safe integer, every list and string within the worker's own caps. Anything else is
// `{ invalid }` whole, never a half-trusted object: the key is written by this project's worker alone, so a value that
// fails is a newer or older worker, or something that is not the worker, and either way not a snapshot to draw.
// ---------------------------------------------------------------------------------------------------------------------

const PROGRESS_TIMEOUT_MS = 2000;
/** The most keys one `progressFor` MGET asks for: the console's active list is bounded well below it. */
export const PROGRESS_BATCH_MAX = 50;
const PROGRESS_FIELDS = Object.freeze(["v", "turn", "steps", "failed", "interrupted", "running", "recent", "phase", "phases", "note", "prior", "startedAt", "updatedAt", "ended", "outcome", "commentId", "replayed"]);
const PROGRESS_STATUSES = Object.freeze(["ok", "error", "interrupted"]);

const isProgressCount = (v) => Number.isSafeInteger(v) && v >= 0;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(o, k));
const codePoints = (s) => [...s].length;
/** The live stream's tool rule: the charset, else `?`. */
const progressTool = (t) => (typeof t === "string" && LIVE_TOOL_RE.test(t) ? t : "?");

/**
 * One raw key value as a snapshot, or `{ invalid: reason }`. The reason names the rule, never the value. `commentId`
 * is checked and dropped: it is the worker's own bookkeeping, and no surface shows it. Tool names outside the stream's
 * charset read as `?` rather than refusing the snapshot (the worker writes `?` itself; this is the belt). A
 * `phase.index` past the `phases` list is kept (the worker's 16 KiB cut drops names from the tail and leaves the index),
 * so a surface takes the name only when `phases[index]` exists.
 */
export function parseProgress(raw) {
  if (typeof raw !== "string") return { invalid: "the progress key is not a string" };
  if (Buffer.byteLength(raw) > PROGRESS_MAX_BYTES) return { invalid: "the progress key is larger than the contract allows" };
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return { invalid: "the progress key is not JSON" };
  }
  const bad = (rule) => ({ invalid: `the progress key ${rule}` });
  if (!isPlainObject(p)) return bad("is not an object");
  if (p.v !== 1) return bad("is not version 1");
  for (const k of Object.keys(p)) if (!PROGRESS_FIELDS.includes(k)) return bad("carries a field the contract does not name");
  // `commentId` and `replayed` (issue #645: safe calls a recovered run re-executed, written only when above zero) are optional.
  for (const k of PROGRESS_FIELDS) if (k !== "commentId" && k !== "replayed" && !Object.hasOwn(p, k)) return bad("is missing a field");
  if (Object.hasOwn(p, "replayed") && !isProgressCount(p.replayed)) return bad("has a replayed that is not a whole number");
  for (const k of ["turn", "steps", "failed", "interrupted", "startedAt", "updatedAt"]) if (!isProgressCount(p[k])) return bad(`has a ${k} that is not a whole number`);
  if (typeof p.ended !== "boolean") return bad("has an ended that is not a boolean");
  if (p.outcome !== null && !LIVE_OUTCOMES.includes(p.outcome)) return bad("has an outcome outside the vocabulary");
  if (Object.hasOwn(p, "commentId") && p.commentId !== null && !(typeof p.commentId === "string" && COMMENT_ID_RE.test(p.commentId))) return bad("has a comment id outside its charset");
  if (!Array.isArray(p.running) || p.running.length > PROGRESS_RUNNING_MAX) return bad("has a running list that is not a bounded list");
  const running = [];
  for (const r of p.running) {
    if (!isPlainObject(r) || !onlyKeys(r, ["tool", "since"]) || typeof r.tool !== "string" || !isProgressCount(r.since)) return bad("has a running step that is not one");
    running.push({ tool: progressTool(r.tool), since: r.since });
  }
  if (!Array.isArray(p.recent) || p.recent.length > PROGRESS_RECENT_MAX) return bad("has a recent list that is not a bounded list");
  const recent = [];
  for (const r of p.recent) {
    if (!isPlainObject(r) || !onlyKeys(r, ["tool", "status", "durationMs", "at"]) || typeof r.tool !== "string" || !PROGRESS_STATUSES.includes(r.status) || !(r.durationMs === null || isProgressCount(r.durationMs)) || !isProgressCount(r.at)) return bad("has a recent step that is not one");
    recent.push({ tool: progressTool(r.tool), status: r.status, durationMs: r.durationMs, at: r.at });
  }
  if (!Array.isArray(p.phases) || p.phases.length > PROGRESS_PHASES_MAX) return bad("has a phase list that is not a bounded list");
  for (const name of p.phases) if (typeof name !== "string" || name === "" || codePoints(name) > PROGRESS_PHASE_MAX) return bad("has a phase name that is not one");
  let phase = null;
  if (p.phase !== null) {
    const f = p.phase;
    if (!isPlainObject(f) || !onlyKeys(f, ["index", "done", "total"])) return bad("has a phase that is not one");
    if (!isProgressCount(f.index) || f.index >= PROGRESS_PHASES_MAX) return bad("has a phase index out of range");
    if (!(f.done === null || (isProgressCount(f.done) && f.done <= PROGRESS_COUNT_MAX))) return bad("has a phase done count out of range");
    if (!(f.total === null || (isProgressCount(f.total) && f.total >= 1 && f.total <= PROGRESS_COUNT_MAX))) return bad("has a phase total out of range");
    if (f.done !== null && f.total !== null && f.done > f.total) return bad("has a phase done past its total");
    phase = { index: f.index, done: f.done, total: f.total };
  }
  if (!(p.note === null || (typeof p.note === "string" && codePoints(p.note) <= PROGRESS_NOTE_MAX))) return bad("has a note that is not one");
  let prior = null;
  if (p.prior !== null) {
    if (!isPlainObject(p.prior) || !onlyKeys(p.prior, ["turns", "steps"]) || !isProgressCount(p.prior.turns) || !isProgressCount(p.prior.steps)) return bad("has a prior that is not one");
    prior = { turns: p.prior.turns, steps: p.prior.steps };
  }
  return { v: 1, turn: p.turn, steps: p.steps, failed: p.failed, interrupted: p.interrupted, running, recent, phase, phases: [...p.phases], note: p.note === "" ? null : p.note, prior, startedAt: p.startedAt, updatedAt: p.updatedAt, ended: p.ended, outcome: p.outcome, ...(Object.hasOwn(p, "replayed") ? { replayed: p.replayed } : {}) };
}

/** Whether `got` (a `readProgress` answer) is a snapshot rather than one of its three absences. */
export const isProgressSnapshot = (got) => isPlainObject(got) && got.v === 1;

/**
 * A job's progress snapshot ON A CLIENT THE CALLER OWNS (never disconnected): the snapshot (`parseProgress`), `{ absent:
 * true }` for no key (never published, `PI_RUN_PROGRESS=0`, or expired: 24 h after the end, 7 days after the first
 * write), `{ invalid }` for a key that is not the contract's or a job id outside the run-id charset (checked before the
 * key is built), or `{ unreachable }` (an error code at most, never the error's text). One GET, bounded. Never throws.
 */
export async function readProgress(redis, jobId, { timeoutMs = PROGRESS_TIMEOUT_MS } = {}) {
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { invalid: "a run id is letters, digits and . _ : -, at most 200 characters" };
  if (!redis) return { unreachable: "no Valkey client" };
  const ms = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROGRESS_TIMEOUT_MS;
  try {
    const raw = await withTimeout(redis.get(progressKeyFor(jobId)), ms, Symbol.for("progress-timeout"));
    if (raw === Symbol.for("progress-timeout")) return { unreachable: "timed out reaching the progress key" };
    if (raw === null || raw === undefined) return { absent: true };
    return parseProgress(raw);
  } catch (err) {
    return { unreachable: progressFailure(err) };
  }
}

function progressFailure(err) {
  const code = typeof err?.code === "string" && TRANSCRIPT_ERROR_CODE_RE.test(err.code) ? err.code : null;
  return code ? `the progress key could not be read (${code})` : "the progress key could not be read";
}

/**
 * Many jobs' progress in ONE MGET, ON A CLIENT THE CALLER OWNS: `{ byId: { [jobId]: snapshot | { absent } | { invalid }
 * } }` or `{ unreachable }` for the whole batch. At most `PROGRESS_BATCH_MAX` distinct ids, in the order given (the
 * rest, and ids outside the run-id charset, are left out of `byId`, which a surface reads as "not known"). Bounded by
 * `timeoutMs`. Never throws.
 */
export async function readProgressMany(redis, jobIds, { timeoutMs = PROGRESS_TIMEOUT_MS } = {}) {
  const ids = [...new Set((Array.isArray(jobIds) ? jobIds : []).filter((id) => typeof id === "string" && RUN_ID_RE.test(id)))].slice(0, PROGRESS_BATCH_MAX);
  if (ids.length === 0) return { byId: {} };
  if (!redis) return { unreachable: "no Valkey client" };
  const ms = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROGRESS_TIMEOUT_MS;
  try {
    const values = await withTimeout(redis.mget(...ids.map((id) => progressKeyFor(id))), ms, Symbol.for("progress-timeout"));
    if (!Array.isArray(values)) return { unreachable: "timed out reaching the progress keys" };
    const byId = {};
    ids.forEach((id, i) => {
      const raw = values[i];
      byId[id] = raw === null || raw === undefined ? { absent: true } : parseProgress(raw);
    });
    return { byId };
  } catch (err) {
    return { unreachable: progressFailure(err) };
  }
}

/**
 * The integers a list may carry of a snapshot (the fleet snapshot's `active[].progress`, `/api/state`, the console's
 * active table, the TUI's ACTIVE row): `{ turn, steps, failed, running: { tool, since } | null, phase: { index, count,
 * done, total } | null, ended, updatedAt }`, where `running` is the newest open step and `count` is how many phases
 * the run has declared (at least `index + 1`, since the worker's size cut can drop names), and `updatedAt` (the last
 * write) lets a surface say the progress is stale (`progressStaleFor`). No phase name, no note: null for anything that
 * is not a snapshot.
 */
export function activeProgressOf(got) {
  if (!isProgressSnapshot(got)) return null;
  const newest = got.running.length > 0 ? got.running[got.running.length - 1] : null;
  return {
    turn: got.turn,
    steps: got.steps,
    failed: got.failed,
    running: newest ? { tool: progressTool(newest.tool), since: newest.since } : null,
    phase: got.phase ? { index: got.phase.index, count: Math.max(got.phases.length, got.phase.index + 1), done: got.phase.done, total: got.phase.total } : null,
    ended: got.ended,
    updatedAt: got.updatedAt,
  };
}

/**
 * How long a running job's snapshot may go unwritten before a surface calls it stale. The worker rewrites the key at
 * least every 30 seconds while the run has not ended (a heartbeat, even with no step), so three minutes without a write
 * means the worker stopped writing: it died, lost Valkey, or the host went away.
 */
export const PROGRESS_STALE_MS = 180_000;

/**
 * How long, in ms, a snapshot (or its `activeProgressOf` projection) has gone without a write when that is past
 * `PROGRESS_STALE_MS`, else null. An ended snapshot is never stale (nothing more is written), and one without a usable
 * `updatedAt` or a clock is not judged. `now` is the caller's clock, never read here.
 */
export function progressStaleFor(p, now) {
  if (p === null || typeof p !== "object" || p.ended === true) return null;
  if (!Number.isSafeInteger(p.updatedAt) || !Number.isFinite(now)) return null;
  const age = now - p.updatedAt;
  return age > PROGRESS_STALE_MS ? age : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Durable runs (issue #645, INT-RUN-HISTORY-FILE-CONTRACT): a run record's tail fields `recoveryOf`, `recovered`,
// `recoverSkipped` and `checkpoints`, for the console's run page and the `/dispatch` RUN_DETAIL. REBUILT by the worker's
// own rules (`recordedRecovered`, `recordedCheckpoints`, `recordedRecoveryOf`, RECOVER_SKIPPED_REASONS), as the record's
// `progress` is by `recordedProgress` (issue #644), so the reader and the writer cannot disagree on what a valid value
// is. A record file is read back from disk or a mirror another host wrote, so it is NEVER trusted to be the worker's:
// every field is an integer, a closed enum or a charset-checked run id, and anything else is dropped (never copied,
// never shown as text). Nothing here is free text, so every role may see all of it.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A record's durable-run facts: `{ recoveryOf, recovered, recoverSkipped, checkpoints }`, each null when absent or not
 * valid, or null when the record carries none of them (every record of a job that never armed `run.recover`). The base
 * run's id passes the worker's charset AND this reader's `RUN_ID_RE`, so the console can link it to a page that opens.
 */
export function recordRecovery(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const of = Object.hasOwn(record, "recoveryOf") ? recordedRecoveryOf(record.recoveryOf) : null;
  const out = {
    recoveryOf: of !== null && RUN_ID_RE.test(of) ? of : null,
    recovered: Object.hasOwn(record, "recovered") ? recordedRecovered(record.recovered) : null,
    recoverSkipped: Object.hasOwn(record, "recoverSkipped") && RECOVER_SKIPPED_REASONS.includes(record.recoverSkipped) ? record.recoverSkipped : null,
    checkpoints: Object.hasOwn(record, "checkpoints") ? recordedCheckpoints(record.checkpoints) : null,
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * A `recovered` value's runner counts in words: "3 orphaned calls, 2 replayed, 1 interrupted". A count the runner did
 * not report (null) is left out, and so is a zero, except an orphan count of zero, which says the crash left nothing
 * open ("0 orphaned calls"). "" when there is nothing to say. Takes `recordRecovery`'s `recovered` only.
 */
export function recoveryCountsText(rec) {
  if (rec === null || typeof rec !== "object") return "";
  const parts = [];
  if (Number.isSafeInteger(rec.orphans)) parts.push(plural(rec.orphans, "orphaned call", "orphaned calls"));
  if (Number.isSafeInteger(rec.replayed) && rec.replayed > 0) parts.push(`${rec.replayed} replayed`);
  if (Number.isSafeInteger(rec.interrupted) && rec.interrupted > 0) parts.push(`${rec.interrupted} interrupted`);
  if (Number.isSafeInteger(rec.notStarted) && rec.notStarted > 0) parts.push(`${rec.notStarted} not started`);
  // Issue #662: counts read off the transcript (no exit line came, as from a killed container) say so: the transcript is
  // agent-writable, the runner's exit line is not.
  if (parts.length > 0 && rec.countsFrom === "transcript") return `${parts.join(", ")} (from the transcript)`;
  return parts.join(", ");
}

/**
 * Where a recovered run came from, in words: "recovered from a live checkpoint (recovery 1, attempt 2, checkpoint 4)",
 * the attempt and the checkpoint left out when the record holds none. Takes `recordRecovery`'s `recovered` only, whose
 * `from` is a closed enum, so nothing here is a value the record could have spelled freely.
 */
export function recoveredHeadText(rec) {
  if (rec === null || typeof rec !== "object") return "";
  const bits = [`recovery ${rec.n}`];
  if (Number.isSafeInteger(rec.fromAttempt)) bits.push(`attempt ${rec.fromAttempt}`);
  if (Number.isSafeInteger(rec.checkpointSeq)) bits.push(`checkpoint ${rec.checkpointSeq}`);
  return `recovered from ${rec.from === "exit" ? "an" : "a"} ${rec.from} checkpoint (${bits.join(", ")})`;
}

/** The whole sentence: `recoveredHeadText`, then `: ` and `recoveryCountsText` when there are counts. */
export function recoveredText(rec) {
  const head = recoveredHeadText(rec);
  const counts = recoveryCountsText(rec);
  return head === "" ? "" : counts === "" ? head : `${head}: ${counts}`;
}

/** A record's `checkpoints` in words: "4 written, 0 failed, 0 skipped". Takes `recordRecovery`'s `checkpoints` only. */
export function checkpointsText(c) {
  if (c === null || typeof c !== "object") return "";
  return `${c.written} written, ${c.failed} failed, ${c.skipped} skipped`;
}

/**
 * The session store's chain counter's file name (`RESUME_CHAIN_FILE` in worker/src/session-store.mjs, which does not
 * export it). A copy, so it is PINNED: admin/test/read-model-pages.test.mjs reads the worker's source for it.
 */
const RESUME_CHAIN_FILE = "resume-chain";
const SIDECAR_MAX_BYTES = 4096;

/** The chain counter for `key` under `sessionsDir`: an integer (0 for a key with no counter), or null when unknown. */
function readChainCount(sessionsDir, key, fs) {
  if (typeof sessionsDir !== "string" || sessionsDir === "" || typeof key !== "string") return null;
  const dir = join(sessionsDir, key);
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
  } catch {
    return null; // no directory for this key on this host: nothing to count, and not a count of zero
  }
  const file = join(dir, RESUME_CHAIN_FILE);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    return err?.code === "ENOENT" ? 0 : null;
  }
  // The store's own guard: regular files only (a planted link is not followed), size-bounded.
  if (!st.isFile() || st.size === 0 || st.size > SIDECAR_MAX_BYTES) return null;
  let raw;
  try {
    raw = String(fs.readFileSync(file, "utf8")).trim();
  } catch {
    return null;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && String(n) === raw ? n : null;
}

/**
 * The parked runs in `runs` (issue #641; REQ-AWAIT-INPUT, issue #625): a run that ended `completed` with reason
 * `awaiting-input` asked a person a question. `[{ target, kind, jobId, project, parkedAt, ageMs, answered, chainCount }]`,
 * newest first, `project` the record's (what money and limits were charged to, issue #737) when it is a project id
 * (`PROJECT_ID_RE`), else null. PURE over the runs it is handed, apart from the optional session-store read.
 *
 * `answered` is the rule the processor implies and nothing records: a LATER run on the same kind + target (an answer is
 * a new delivery on the same issue, which resumes the parked transcript), the target compared as `targetKeyOf` says. `chainCount` is the session store's
 * `resume-chain` counter for the run's re-derived key when `sessionsDir` is on this host and the key has a directory,
 * else null ("unknown"), never 0 for a store this host cannot see. `unansweredOnly` drops the answered runs BEFORE that
 * read, so a caller that shows only the waiting ones (the fleet reader) pays no fs call for a run nobody waits on.
 */
export function readParkedRuns({ runs, now = Date.now(), sessionsDir = null, fs = nodeFs, unansweredOnly = false } = {}) {
  const list = Array.isArray(runs) ? runs.filter((r) => r && typeof r === "object" && r.purpose !== "answer-draft") : [];
  const nowMs = typeof now === "function" ? now() : now;
  const latest = new Map(); // kind + target (`targetKeyOf`) -> the newest run's instant
  for (const r of list) {
    if (typeof r.target !== "string" || typeof r.kind !== "string") continue;
    const k = targetKeyOf(r.kind, r.target);
    const at = runAt(r);
    if (!latest.has(k) || at > latest.get(k)) latest.set(k, at);
  }
  const out = [];
  for (const r of list) {
    if (r.outcome !== "completed" || !["awaiting-input", "awaiting-approval"].includes(r.reason)) continue;
    const at = runAt(r);
    const known = typeof r.target === "string" && typeof r.kind === "string";
    const answered = known && Number.isFinite(at) && latest.get(targetKeyOf(r.kind, r.target)) > at;
    if (answered && unansweredOnly) continue;
    out.push({
      target: typeof r.target === "string" ? r.target : null,
      kind: typeof r.kind === "string" ? r.kind : null,
      jobId: r.jobId ?? null,
      project: typeof r.project === "string" && PROJECT_ID_RE.test(r.project) ? r.project : null,
      parkedAt: Number.isFinite(at) ? at : null,
      ageMs: Number.isFinite(at) && Number.isFinite(nowMs) ? Math.max(0, nowMs - at) : null,
      answered,
      ...(r.reason === "awaiting-approval" ? { reason: r.reason, approval: approvalRecordOf(r.approval) } : {}),
      chainCount: readChainCount(sessionsDir, sessionKeyOfRecord(r), fs),
    });
  }
  out.sort((a, b) => (b.parkedAt ?? -Infinity) - (a.parkedAt ?? -Infinity));
  return out;
}

/**
 * `PI_SECRET_PROFILES` as this deployment's `.env` (or pi's environment) sets it, read for display (issue #712):
 * `{ profiles: { name: path }, malformed, seen }`. The worker's own parser (`parseSecretProfiles`, imported), which
 * refuses to BOOT on a malformed value, so `malformed` is said rather than any half of it being shown as declared;
 * `seen` is whether the variable is visible here at all, since unset in what the panel reads (no pointer, or a `.env`
 * without the line) is not proof the worker's host declares none.
 */
export function envSecretProfiles(raw) {
  const seen = typeof raw === "string";
  try {
    return { profiles: { ...parseSecretProfiles(raw) }, malformed: false, seen };
  } catch {
    return { profiles: {}, malformed: true, seen };
  }
}

/** The secret profiles' NAMES in a settings view (`readSettingsView`), sorted; never a resolver path. */
export function secretProfileNames(settingsView) {
  const profiles = settingsView?.overlay?.secretProfiles;
  if (profiles === null || typeof profiles !== "object" || Array.isArray(profiles)) return [];
  // The worker's profile-name charset (secret-profiles.mjs): a key outside it is not a profile the worker loads.
  return Object.keys(profiles).filter((n) => /^[A-Za-z0-9._-]{1,64}$/.test(n)).sort();
}

/**
 * Where an overlay resolver at `path` stands against PI_SECRET_RESOLVER_ROOTS, by the worker's own rule (secrets.mjs:
 * the resolver's REALPATH against the roots AS WRITTEN, never resolved), judged on THIS host (issue #712):
 * `{ status, roots, real? }`, `status` one of `unseen` (the variable is not visible here, which is not proof the
 * worker's host has none), `empty` (set and empty: the worker refuses every overlay resolver), `unresolved` (this host
 * cannot resolve the path: an error with a `code`, so only the worker can judge it), `inside` or `outside`. Any other
 * error is a fault, not an answer, and is rethrown. The ONE rule `resolverRootsJudgement` (write-plans.mjs, the add's
 * pre-confirm check) and the profiles view (`secretProfilesView`) both read, so the view never calls inside what the
 * add refuses.
 */
export function resolverRootsStatus(path, env, fs = nodeFs) {
  if (typeof env?.PI_SECRET_RESOLVER_ROOTS !== "string") return { status: "unseen", roots: [] };
  const roots = delimitedList(env.PI_SECRET_RESOLVER_ROOTS);
  if (roots.length === 0) return { status: "empty", roots };
  const real = realPathOrNull(path, fs);
  if (real === null) return { status: "unresolved", roots };
  return { status: withinRoots(real, roots) ? "inside" : "outside", roots, real };
}

/** `fs.realpathSync(p)`, or null for an error with a `code` (not there, or not this host's); any other error is rethrown. */
export function realPathOrNull(p, fs = nodeFs) {
  // STRICT on the seam: an fs without realpath is a wiring fault, and it throws here (a TypeError has no `code`), so the
  // add's pre-confirm judgement can never fail open on it. Only the profiles view tolerates it, per row.
  try {
    return fs.realpathSync(p);
  } catch (error) {
    if (typeof error?.code === "string") return null;
    throw error;
  }
}

/**
 * The secret-resolve refusals a run record can carry (processor.mjs, the `run.secrets` resolve), so the profiles view
 * can tell "the resolve refused" from "the run ended elsewhere". `secret-name-reserved`, `secret-unresolved` and
 * `secret-resolver-unreachable` are also the project bundle read's (issue #704), which runs after the profile's, so on a
 * bundled run those three may be the bundle's: the view says so then (`BUNDLE_SHARED_REASONS`, `last.bundled`), never
 * pinning the refusal on the profile alone.
 */
export const SECRET_RESOLVE_REASONS = Object.freeze(["secret-profile-unknown", "secret-profile-ambiguous", "secret-name-reserved", "secret-unresolved", "secret-resolver-unreachable"]);

/** The three of those the project bundle's read reuses (processor.mjs, issue #704), said as either's on a bundled run. */
export const BUNDLE_SHARED_REASONS = Object.freeze(["secret-name-reserved", "secret-unresolved", "secret-resolver-unreachable"]);

/** The most trigger indices and projects a profile row lists; the rest are counted. */
const PROFILE_USES_MAX = 16;

/**
 * The secret profiles view (issue #712): one row per profile a source declares or a trigger names, sorted by name, or
 * null when there is none (so every surface renders what it did before). Each row:
 *   - `name`;
 *   - `source`: `env` (PI_SECRET_PROFILES), `overlay` (the settings file's `secretProfiles`), `ambiguous` (both: the
 *     worker refuses every secrets job, secret-profiles.mjs `mergeSecretProfiles`), or `undeclared` (a trigger names it
 *     and neither visible source declares it; `envSeen` says whether that can be known);
 *   - `roots`: an overlay row's `resolverRootsStatus(...).status`, else null (an env resolver is not bounded by roots);
 *   - `triggers`: the raw indices of the triggers whose jobs resolve through it (`run.secretsProfile`, or the implicit
 *     `default` when `run.secrets` is set: secrets.mjs' own rule), at most `PROFILE_USES_MAX`, `triggersMore` the rest;
 *   - `projects`: the projects those triggers' jobs belong to (a cron trigger's folder through the worker's
 *     `projectOf`), `anyRepo` whether a webhook trigger uses it (its jobs may land in any project);
 *   - `last`: the newest run in `runs` that recorded this profile (`secretsProfile`, the worker's rebuild), `{ jobId,
 *     at, outcome, reason }`: `outcome` is `refused` (a `SECRET_RESOLVE_REASONS` member), `resolved` (a container ran,
 *     which only a passed resolve allows) or `not-reached` (the run ended before a container, and the record cannot say
 *     whether the resolve ran); null when no run in view recorded it;
 *   - `hosts`: the live hosts whose registry row advertises `s:<name>` (`hostRowOf`'s `caps`), `hostsUnknown` how many
 *     rows publish no capability list at all (`capsSeen` false: an older worker).
 * NEVER a path on a row: the console and the panel are names-only for resolvers (REQ-OPERATOR-CONSOLE-SCREENS (g)), and
 * `/dispatch secrets list` prints the paths itself from the two sources. Never a reference or a value, and nothing is
 * resolved: the realpath is the add's own check, on this host.
 */
export function secretProfilesView({ triggers = null, settings = null, env = {}, projects = null, runs = [], hosts = null, hostsUnreadable = false, fs = nodeFs } = {}) {
  const fromEnv = envSecretProfiles(env?.PI_SECRET_PROFILES);
  const raw = settings?.overlay?.secretProfiles;
  const overlay = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const overlayNames = secretProfileNames(settings).filter((n) => typeof overlay[n] === "string");
  const entries = Array.isArray(triggers?.triggers) ? triggers.triggers : [];
  const projectList = Array.isArray(projects?.projects) ? projects.projects : null;
  const usedBy = new Map();
  for (const t of entries) {
    if (!Number.isInteger(t?.index) || !(t.secrets > 0)) continue;
    const name = typeof t.secretsProfile === "string" && t.secretsProfile !== "" ? t.secretsProfile : "default";
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) continue;
    if (!usedBy.has(name)) usedBy.set(name, []);
    usedBy.get(name).push(t);
  }
  const names = [...new Set([...Object.keys(fromEnv.profiles), ...overlayNames, ...usedBy.keys()])].sort();
  if (names.length === 0) return null;
  const recorded = (Array.isArray(runs) ? runs : [])
    .filter((r) => r !== null && typeof r === "object" && !Array.isArray(r) && Object.hasOwn(r, "secretsProfile") && recordSecretsProfile(r) !== null)
    .sort((a, b) => runAt(b) - runAt(a));
  // `hosts` null: this surface reads no registry (`/dispatch secrets list`), which is not "no host advertises it".
  const hostRows = Array.isArray(hosts) ? hosts : [];
  // Per row and tolerant, unlike the add's judgement: one resolver this host cannot judge (a fault, a bad seam) shows as
  // `unresolved` on its own row instead of failing the whole snapshot.
  const rootsOf = (path) => {
    try {
      return resolverRootsStatus(path, env, fs).status;
    } catch {
      return "unresolved";
    }
  };
  // The projects with a secret bundle: on such a run the bundle's read follows the profile's and reuses three of its
  // refusal reasons, so a refusal there is said as either's.
  const bundledProjects = new Set((Array.isArray(triggers?.secretBundles) ? triggers.secretBundles : []).map((b) => b?.project).filter((p) => typeof p === "string"));
  const rows = names.map((name) => {
    const inEnv = Object.hasOwn(fromEnv.profiles, name);
    const inOverlay = overlayNames.includes(name);
    const source = inEnv && inOverlay ? "ambiguous" : inEnv ? "env" : inOverlay ? "overlay" : "undeclared";
    const users = usedBy.get(name) ?? [];
    const projectIds = projectList === null ? [] : [...new Set(users.filter((t) => t.type === "cron" && typeof t.folder === "string").map((t) => projectOf({ kind: "local", folder: t.folder }, projectList)).filter((p) => p !== null))].sort();
    const hit = recorded.find((r) => recordSecretsProfile(r) === name);
    const ran = hit ? Number.isInteger(hit.exitCode) || (hit.tokens !== null && typeof hit.tokens === "object") || hit.outcome === "completed" : false;
    const reason = hit && typeof hit.reason === "string" && /^[a-z0-9-]{1,64}$/.test(hit.reason) ? hit.reason : null;
    const token = `${CAP_SECRET}:${name}`;
    return {
      name,
      source,
      roots: inOverlay ? rootsOf(overlay[name]) : null,
      triggers: users.slice(0, PROFILE_USES_MAX).map((t) => t.index),
      triggersMore: Math.max(0, users.length - PROFILE_USES_MAX),
      projects: projectIds.slice(0, PROFILE_USES_MAX),
      projectsMore: Math.max(0, projectIds.length - PROFILE_USES_MAX),
      anyRepo: users.some((t) => t.type !== "cron"),
      last: hit ? { jobId: typeof hit.jobId === "string" ? hit.jobId : null, at: Number.isFinite(runAt(hit)) ? new Date(runAt(hit)).toISOString() : null, outcome: reason !== null && SECRET_RESOLVE_REASONS.includes(reason) ? "refused" : ran ? "resolved" : "not-reached", reason, bundled: BUNDLE_SHARED_REASONS.includes(reason) && (Object.hasOwn(hit, "bundle") || (typeof hit.project === "string" && bundledProjects.has(hit.project))) } : null,
      hosts: hostRows.filter((h) => Array.isArray(h?.caps) && h.caps.includes(token) && typeof h.name === "string").map((h) => h.name).sort(),
      hostsUnknown: hostRows.filter((h) => h?.capsSeen === false || !Array.isArray(h?.caps)).length,
    };
  });
  return { profiles: rows, envSeen: fromEnv.seen, envMalformed: fromEnv.malformed, rootsSeen: typeof env?.PI_SECRET_RESOLVER_ROOTS === "string", hostsSeen: Array.isArray(hosts) ? hostRows.length : null, hostsUnreadable: !Array.isArray(hosts) && hostsUnreadable === true };
}

/** A profile row's `source` in words, the same on every surface. */
export const PROFILE_SOURCE_TEXT = Object.freeze({
  env: "declared in PI_SECRET_PROFILES",
  overlay: "declared in the settings overlay",
  ambiguous: "Ambiguous: declared in both PI_SECRET_PROFILES and the settings overlay, so the worker refuses every secrets job",
  undeclared: "named by a trigger, declared in no source this view can see",
});

/** An overlay row's `roots` in words; no path, so the console and the panel can show it. */
export const PROFILE_ROOTS_TEXT = Object.freeze({
  inside: "its resolver's real path on this host is inside PI_SECRET_RESOLVER_ROOTS as written",
  outside: "its resolver's real path on this host is outside PI_SECRET_RESOLVER_ROOTS, so the worker refuses every job naming it",
  unresolved: "its resolver cannot be resolved on this host, so only the worker can judge it against PI_SECRET_RESOLVER_ROOTS (doctor --secrets)",
  unseen: "PI_SECRET_RESOLVER_ROOTS is not visible here, so the roots are the worker's to judge (doctor --secrets)",
  empty: "PI_SECRET_RESOLVER_ROOTS is set and empty, so the worker refuses every overlay resolver",
});

/** A profile row's facts as short sentences, one per fact, for every surface (each scrubbed by the caller's renderer). */
export function secretProfileFacts(row, view = null) {
  if (row === null || typeof row !== "object") return [];
  const out = [PROFILE_SOURCE_TEXT[row.source] ?? PROFILE_SOURCE_TEXT.undeclared];
  if (row.source === "undeclared" && view?.envSeen === false) out[0] += " (PI_SECRET_PROFILES is not visible here)";
  if (row.roots !== null && Object.hasOwn(PROFILE_ROOTS_TEXT, row.roots)) out.push(PROFILE_ROOTS_TEXT[row.roots]);
  const trig = row.triggers.length > 0 ? `used by trigger${row.triggers.length + row.triggersMore === 1 ? "" : "s"} ${row.triggers.map((i) => `#${rowNumber(i)}`).join(", ")}${row.triggersMore > 0 ? ` and ${row.triggersMore} more` : ""}` : "used by no trigger";
  out.push(trig);
  if (row.projects.length > 0 || row.anyRepo) out.push(`projects: ${[...row.projects, ...(row.projectsMore > 0 ? [`${row.projectsMore} more`] : []), ...(row.anyRepo ? ["any (a webhook trigger)"] : [])].join(", ")}`);
  out.push(profileLastText(row.last));
  out.push(profileHostsText(row, view));
  return out;
}

/** "last resolve: refused (secret-unresolved) at <ISO>", or "no run in view recorded it". */
export function profileLastText(last) {
  if (last === null || typeof last !== "object") return "last resolve: no run in view recorded it";
  const at = last.at ? ` at ${last.at}` : "";
  if (last.outcome === "refused") return `last resolve: refused (${last.reason}${last.bundled ? ": the profile's or the project bundle's read" : ""})${at}`;
  if (last.outcome === "resolved") return `last resolve: resolved${at}`;
  return `last resolve: not reached, the run ended before a container${last.reason ? ` (${last.reason})` : ""}${at}`;
}

/** "served by: a, b", or why no host is named. */
export function profileHostsText(row, view = null) {
  // A registry read that failed this tick is not "no host": the rows last read may be stale, so none are named.
  if (view?.hostsUnreadable === true) return "served by: the host registry could not be read";
  if (view?.hostsSeen === null) return "served by: the registry is not read here (the console's and the panel's profiles show the live hosts)";
  if (row.hosts.length > 0) return `served by: ${row.hosts.join(", ")}${row.hostsUnknown > 0 ? ` (${row.hostsUnknown} host(s) publish no capabilities)` : ""}`;
  if (view?.hostsSeen === 0) return "served by: no live host in the registry";
  return row.hostsUnknown > 0 ? `served by: no live host advertises it (${row.hostsUnknown} host(s) publish no capabilities)` : "served by: no live host advertises it";
}

// ---------------------------------------------------------------------------------------------------------------------
// Project secret bundles (issue #704, DES-PROJECT-SECRET-BUNDLES): the bundles view and a run's bundle facts, for the
// console, the `/dispatch` panel and `/dispatch secrets`. DISPLAY ONLY: nothing here resolves a bundle (doctor
// --secrets does, on the host that runs the jobs), and nothing here carries a value or a reference.
// ---------------------------------------------------------------------------------------------------------------------

/** The output formats a bundle resolver declares: the worker's own list, imported, never a copy. */
export { BUNDLE_FORMATS };

/** A bundle profile name's shape, the worker's (secret-profiles.mjs `PROFILE_NAME`). */
const BUNDLE_PROFILE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * `PI_SECRET_BUNDLES` as this deployment's `.env` (or pi's environment) sets it, read for display:
 * `{ profiles: { name: { path, format } }, malformed }`. The worker's own parser (`parseSecretBundleProfiles`, imported),
 * which refuses to BOOT on a malformed value (a relative path, a missing format, a name twice), so `malformed` is said
 * rather than any half of it being shown as declared.
 */
export function envBundleProfiles(raw) {
  try {
    return { profiles: { ...parseSecretBundleProfiles(raw) }, malformed: false };
  } catch {
    return { profiles: {}, malformed: true };
  }
}

/** The settings overlay's bundle profiles (`readSettingsView`), `{ name: { path, format } }`; `{}` when none or unreadable. */
export function overlayBundleProfiles(settingsView) {
  const v = settingsView?.overlay?.secretBundles;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const name of Object.keys(v)) {
    const e = v[name];
    if (!BUNDLE_PROFILE_NAME.test(name) || e === null || typeof e !== "object" || typeof e.path !== "string") continue;
    Object.defineProperty(out, name, { value: { path: e.path, format: BUNDLE_FORMATS.includes(e.format) ? e.format : null }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The overlay's bundle profiles as a human reads them on their own host: names, formats and paths. */
export function renderBundleProfiles(bundles) {
  const names = Object.keys(bundles ?? {}).sort();
  if (names.length === 0) return "No bundle resolvers are declared in the settings overlay.";
  // The path through `scrubControls`: the overlay's validator holds it to a non-empty string, not to a charset.
  return ["Bundle resolvers (settings overlay):", ...names.map((n) => scrubControls(`  ${n}: ${bundles[n].path} (${bundles[n].format ?? "no format"})`))].join("\n");
}

/**
 * The bundles view (issue #704): one row per bundle the triggers file binds, or null when it binds none (so every
 * surface renders exactly what it did before the feature). Each row:
 *   - `id`, `project`, `profile`, `forkReviews`, `endpoints` (`normalizeSecretBundlesForDisplay`, never the `ref`);
 *   - `declared`: whether THIS deployment declares the profile, as the worker's lookup reads the two sources
 *     (`mergeSecretProfiles`): `env` (PI_SECRET_BUNDLES), `overlay` (the settings file's `secretBundles`), `ambiguous`
 *     (a name in both, which the worker refuses for EVERY bundle), `overlay-outside-roots` (an overlay path outside
 *     PI_SECRET_RESOLVER_ROOTS, lexically, said only when the panel can see the roots: `rootsSeen`), `env-malformed` (PI_SECRET_BUNDLES does not parse: the worker does not boot),
 *     `missing` (PI_SECRET_BUNDLES is visible and does not name it) or `unseen` (the panel cannot see PI_SECRET_BUNDLES); and `format`, the declared one or null. Another host may declare it
 *     differently: doctor judges each host, this reads the deployment this panel points at;
 *   - `projectKnown`: whether projects.json has the project (null when it cannot be read);
 *   - `optedOut`: the raw indices of the triggers whose jobs in this project run without it (`run.secretBundle:
 *     false`): a cron trigger whose folder is in the project, and every webhook trigger, which may fire on any repo;
 *   - `last`: the newest run in `runs` that recorded this bundle, `{ jobId, variables }` (names, rebuilt by the
 *     worker's `recordedBundle`), or null. Never resolved here: the names are what a run already held.
 * `byIndex` maps a trigger's raw index to `{ id, optedOut }`: the bundle a cron trigger's jobs hold (id null for a
 * trigger outside every bundled project or a webhook trigger, which belongs to no project until a repo does).
 */
export function secretBundlesView({ triggers, settings = null, env = {}, projects = null, runs = [], fs = nodeFs } = {}) {
  const list = Array.isArray(triggers?.secretBundles) ? triggers.secretBundles : [];
  if (list.length === 0) return null;
  const fromEnv = envBundleProfiles(env?.PI_SECRET_BUNDLES);
  const fromOverlay = overlayBundleProfiles(settings);
  const ambiguous = Object.keys(fromOverlay).some((n) => Object.hasOwn(fromEnv.profiles, n));
  // Whether the panel sees PI_SECRET_RESOLVER_ROOTS at all (final review): unset in what it reads is not proof the
  // worker's host has no roots, so "outside the roots" is claimed only against roots the panel can see.
  const rootsSeen = typeof env?.PI_SECRET_RESOLVER_ROOTS === "string";
  // Whether the panel sees the worker's PI_SECRET_BUNDLES at all: unset in what it reads (no pointer, or a `.env`
  // without the line) is not proof the worker's host declares none, so "missing" is said only when it is visible.
  const envSeen = typeof env?.PI_SECRET_BUNDLES === "string";
  const projectList = Array.isArray(projects?.projects) ? projects.projects : null;
  const entries = Array.isArray(triggers?.triggers) ? triggers.triggers : [];
  const byProject = new Map(list.filter((b) => b.project !== null).map((b) => [b.project, b.id]));
  const byIndex = {};
  for (const t of entries) {
    if (!Number.isInteger(t?.index)) continue;
    const project = t.type === "cron" && typeof t.folder === "string" && projectList !== null ? projectOf({ kind: "local", folder: t.folder }, projectList) : null;
    const id = project !== null ? (byProject.get(project) ?? null) : null;
    // An opt-out is said only where it decides something (review L5): a cron trigger in a bundled project, or a webhook
    // trigger, whose jobs may land in any bundled project; a cron trigger outside every bundled project opts out of nothing.
    byIndex[t.index] = { id, optedOut: t.secretBundle === false && (t.type !== "cron" || id !== null), cron: t.type === "cron" };
  }
  const recorded = (Array.isArray(runs) ? runs : [])
    .map((r) => ({ r, b: r && typeof r === "object" ? recordedBundle(r.bundle) : null }))
    .filter((x) => x.b !== null)
    .sort((x, y) => runAt(y.r) - runAt(x.r));
  const bundles = list.map((b) => {
    const inEnv = b.profile !== null && Object.hasOwn(fromEnv.profiles, b.profile);
    const inOverlay = b.profile !== null && Object.hasOwn(fromOverlay, b.profile);
    // A symlink crosses the roots in either direction (/tmp on macOS is a common example), so neither lexical yes
    // nor lexical no says what the worker will do. Use the profile view's realpath rule; another host's unresolved
    // path stays unknown, never a refusal or a claim that the resolver is inside.
    let rootsStatus = null;
    if (inOverlay) { try { rootsStatus = resolverRootsStatus(fromOverlay[b.profile].path, env, fs).status; } catch { rootsStatus = "unresolved"; } }
    const outside = inOverlay && ["outside", "empty"].includes(rootsStatus);
    const declared = fromEnv.malformed ? "env-malformed" : ambiguous ? "ambiguous" : inEnv ? "env" : outside ? "overlay-outside-roots" : inOverlay ? "overlay" : envSeen ? "missing" : "unseen";
    const format = declared === "env" ? fromEnv.profiles[b.profile].format : inOverlay && (declared === "overlay" || declared === "overlay-outside-roots") ? fromOverlay[b.profile].format : null;
    const optedOut = entries.filter((t) => t?.secretBundle === false && Number.isInteger(t.index) && (t.type !== "cron" || byIndex[t.index]?.id === b.id)).map((t) => t.index);
    const hit = recorded.find((x) => x.b.id === b.id);
    return {
      ...b,
      declared,
      format,
      rootsSeen,
      roots: rootsStatus,
      projectKnown: projectList === null || b.project === null ? null : projectList.some((p) => p.id === b.project),
      optedOut,
      last: hit ? { jobId: typeof hit.r.jobId === "string" ? hit.r.jobId : null, at: Number.isFinite(runAt(hit.r)) ? new Date(runAt(hit.r)).toISOString() : null, variables: hit.b.variables } : null,
    };
  });
  return { bundles, byIndex };
}

/** A bundle row's `declared` in words, the same on every surface. */
export function bundleDeclaredText(row) {
  switch (row?.declared) {
    case "env":
      return `declared in PI_SECRET_BUNDLES${row.format ? `, ${row.format}` : ""}; doctor --secrets checks it runs`;
    case "overlay":
      if (row.roots === "unresolved") return `declared in the settings overlay${row.format ? `, ${row.format}` : ""}; its resolver cannot be resolved on this host, so only the worker can judge it against PI_SECRET_RESOLVER_ROOTS; doctor --secrets checks it runs`;
      return row.rootsSeen === false
        ? `declared in the settings overlay${row.format ? `, ${row.format}` : ""}; PI_SECRET_RESOLVER_ROOTS is not visible to the panel; doctor --secrets checks it runs`
        : `declared in the settings overlay${row.format ? `, ${row.format}` : ""}, inside PI_SECRET_RESOLVER_ROOTS as written; doctor --secrets checks it runs`;
    case "overlay-outside-roots":
      return "declared in the settings overlay but outside PI_SECRET_RESOLVER_ROOTS, so the worker will not run it and this project's jobs are refused before they spend";
    case "ambiguous":
      return "declared in both PI_SECRET_BUNDLES and the overlay: the worker refuses every bundled job until one goes";
    case "env-malformed":
      return "PI_SECRET_BUNDLES does not parse: the worker does not start";
    case "unseen":
      return "not in the overlay, and PI_SECRET_BUNDLES is not visible to the panel; doctor --secrets on the worker's host says whether it is declared";
    default:
      return "not declared in the overlay or PI_SECRET_BUNDLES: this project's jobs are refused before they spend";
  }
}

/** A bundle row's endpoints in words: "STRIPE_KEY at api.stripe.com, ...", or "" when it declares none. */
export function bundleEndpointsText(row) {
  const list = Array.isArray(row?.endpoints) ? row.endpoints : [];
  return list.map((e) => `${e.name}${e.host ? ` at ${e.host}` : ""}`).join(", ");
}

/**
 * One bundle row's facts as short phrases, the same words on every surface: the project (and whether projects.json has
 * it), the profile and where it is declared, fork reviews, the endpoints and the opted-out triggers.
 */
export function bundleFacts(row) {
  const ends = Array.isArray(row?.endpoints) ? row.endpoints : [];
  return [
    `project ${row?.project ?? "-"}${row?.projectKnown === false ? " (not in projects.json)" : ""}`,
    `profile ${row?.profile ?? "-"} (${bundleDeclaredText(row)})`,
    row?.forkReviews ? "fork reviews get it" : "fork reviews do not",
    ends.length === 0 ? "no endpoints" : `${plural(ends.length, "endpoint", "endpoints")}: ${bundleEndpointsText(row)}`,
    Array.isArray(row?.optedOut) && row.optedOut.length > 0 ? `${plural(row.optedOut.length, "trigger opts", "triggers opt")} out: ${row.optedOut.map((i) => `#${rowNumber(i)}`).join(", ")}` : "no trigger opts out",
  ];
}

/**
 * The bundles view as plain text (`/dispatch secrets list`, `/dispatch triggers`, the panel's narrow path), or "" when
 * the triggers file binds none. Every string through `scrubControls`: the lenient reader admits any string, and two
 * of these surfaces are plain text with no other gate in front of the terminal. `names: false` leaves out the last
 * run's variable names, for the model-visible `/dispatch triggers` channel: they are the manager's contents, which no
 * model context needs to hold.
 */
export function renderSecretBundles(view, { names = true } = {}) {
  const rows = Array.isArray(view?.bundles) ? view.bundles : [];
  if (rows.length === 0) return "";
  const out = ["Secret bundles (triggers.json; names only, never a reference or a value):"];
  for (const row of rows) {
    out.push(scrubControls(`  ${row.id}: ${bundleFacts(row).join("; ")}`));
    if (names) out.push(scrubControls(row.last ? `    last run ${row.last.jobId ?? "-"} received: ${row.last.variables.length > 0 ? row.last.variables.join(", ") : "none"}` : "    no run in view recorded it yet"));
  }
  return out.join("\n");
}

/**
 * The profiles view (issue #712) as `/dispatch secrets list` prints it, under the declared tables (which carry the
 * paths): one line per profile, its facts after it. "" when there is none. Scrubbed: a profile name is charset-checked,
 * a reason and an instant are the worker's, and the rest is this file's own words.
 */
export function renderSecretProfilesView(view) {
  const rows = Array.isArray(view?.profiles) ? view.profiles : [];
  if (rows.length === 0) return "";
  const out = ["Secret profiles in use (names only; the resolver paths are listed above):"];
  for (const row of rows) out.push(scrubControls(`  ${row.name}: ${secretProfileFacts(row, view).join("; ")}`));
  if (view.envMalformed) out.push("  PI_SECRET_PROFILES does not parse, so the worker refuses to boot until it is fixed.");
  return out.join("\n");
}

/**
 * The bundle a trigger's row and drill-in name (issue #704): `{ id, optedOut }` from `secretBundlesView`'s `byIndex`,
 * or null when the deployment binds no bundle or the trigger neither belongs to a bundled project nor opts out.
 */
export function triggerBundleOf(trigger, view) {
  if (!view || !Number.isInteger(trigger?.index)) return null;
  const at = view.byIndex?.[trigger.index];
  if (!at || (at.id === null && !at.optedOut)) return null;
  return { id: at.id, optedOut: at.optedOut };
}

// Why a job ran without its project's bundle (`BUNDLE_SKIPPED_TEXT`), and why a run went without steering or a live transcript
// (`STEER_SKIPPED_TEXT`, `LIVE_SKIPPED_TEXT`): the worker's reason catalog holds all three since issue #710
// (INT-REASON-CATALOG), so the console, the panel and the catalog say one thing. Re-exported under the names every surface
// already imports.
export { BUNDLE_SKIPPED_TEXT, LIVE_SKIPPED_TEXT, STEER_SKIPPED_TEXT };

// ---------------------------------------------------------------------------------------------------------------------
// What a venue serves, and why a run went without a feature (issue #712): the sentences the console and the panel say,
// from the worker's own tables (`BACKENDS[*].serves`, `CREDENTIAL_CUSTODY`, `STEER_SKIPPED_REASONS`,
// `LIVE_SKIPPED_REASONS`), each held to its table by admin/test/venue-words.test.mjs so a new venue word, custody or
// reason cannot render as nothing. No surface restates which venue does what: it asks `servesOf`.
// ---------------------------------------------------------------------------------------------------------------------

/** Each `serves` entry's value in words (BACKENDS[*].serves), for every word SERVES_WORDS admits. */
export const SERVES_TEXT = Object.freeze({
  liveTranscript: Object.freeze({
    yes: "streams the live transcript and progress",
    no: "streams no live transcript or progress",
    image: "streams the live transcript and progress only from a job image that declares transcriptStderr and exitAuth",
  }),
  steering: Object.freeze({
    yes: "takes steering messages (run.steer)",
    no: "takes no steering messages",
    image: "takes steering messages only from a job image that declares steerStdin, transcriptStderr and exitAuth",
  }),
  recovery: Object.freeze({
    yes: "recovers a lost run (run.recover)",
    no: "recovers no lost run: run.recover is refused there",
    image: "recovers a lost run only from a job image that supports it",
  }),
  sandboxShell: Object.freeze({
    yes: "reopens a retained workspace (pi-dispatch sandbox)",
    no: "has no sandbox shell: pi-dispatch sandbox cannot reopen its runs",
    image: "reopens a retained workspace only from a job image that supports it",
  }),
});

/**
 * Where a trigger's `run.secrets` values end up, by its venue's `credentialCustody` (CREDENTIAL_CUSTODY): the panel's
 * secrets disclosure. `container` is the line it always said; `layer` is the OpenShell venues', whose per-job provider
 * holds the values and puts placeholders in the agent (CONST-VENUE-EGRESS-LAYER).
 */
export const CUSTODY_TEXT = Object.freeze({
  container: "the agent can read them, and the forge is on the egress allowlist",
  layer: "values with an endpoint are placeholders in the agent; run.secrets go to the job's provider",
});

/** A venue's credential custody (`container` when the table entry omits it, the worker's own reading), or null for an unknown name. */
export function venueCustody(venue) {
  if (typeof venue !== "string" || !BACKEND_NAMES.includes(venue)) return null;
  const custody = BACKENDS[venue].credentialCustody ?? "container";
  return CREDENTIAL_CUSTODY.includes(custody) ? custody : "container";
}

// ---------------------------------------------------------------------------------------------------------------------
// The Venues view (issue #712): every venue this build's table holds, the live hosts' published facts about it (the
// registry row's `backends` field), and the table's own declarations in words. NOTHING HERE RESOLVES ANYTHING LIVE: no
// CLI is spawned, no endpoint read and no observation made, so a word is the table's DECLARED word, and what a host
// observes (which can lower it to `asserted` there) is named as the condition, never judged from here.
// ---------------------------------------------------------------------------------------------------------------------

/** Each declaration word in a sentence (`docs/backends.md`'s table), keyed like ENFORCED, ASSERTED and ABSENT. */
export const DECLARATION_TEXT = Object.freeze({
  enforced: "this worker builds it in its own code, and a test reads it back off what was produced",
  asserted: "something outside the worker provides it (an image, a vendor's documentation): not verifiable from here",
  absent: "not provided: a floor that asks for it refuses this venue",
});

/**
 * A short name for each property (PROPERTY_NAMES), for the panel's narrow lines; the long form is the property's own
 * `question`, read from the worker's table. Keyed exactly like PROPERTIES, so a new property without one fails a test.
 */
export const PROPERTY_LABEL = Object.freeze({
  isolation: "isolation flags",
  ephemeral: "one container per job",
  mountSet: "declared mounts only",
  egress: "egress allowlist",
  jobToJobIsolation: "jobs cannot reach each other",
  imagePinning: "image never pulled",
  exitCodes: "exit code unmodified",
  abortable: "stoppable on timeout",
  readOnlyJobInputs: "read-only /job",
  nonRoot: "agent not root",
  secretsCustody: "no secret value logged",
  credentialTransit: "credentials stay on owned networks",
  localFolders: "local folders in place",
  pausable: "freezable",
});

/**
 * A host's OpenShell gateway word (HOST_GATEWAY_WORDS) in words. Every one says WHEN it was read: the worker reads its
 * gateway once, when it starts, so a gateway moved or started since is not in it.
 */
export const GATEWAY_TEXT = Object.freeze({
  local: "the gateway was on this host when the worker started",
  remote: "the gateway was not on this host when the worker started, so every job there is refused (openshell-gateway-not-local)",
  unknown: "the gateway's place was not read: it did not answer when the worker started",
});

/** The OpenShell setup of a host whose row blesses an OpenShell venue and carries no `os` part: not a failed boot read. */
export const OPENSHELL_UNPUBLISHED_TEXT = "not published by this host's worker";

/**
 * The Venues view's model from the snapshot's host rows (`hostRowOf`): `{ venues, others, floors, unpublished }`.
 *
 *   - `venues`: one entry per venue in BACKENDS, in the table's order: its description, the hosts that bless it and the
 *     ones whose default it is, its fourteen properties (`{ property, label, question, word, wordText, armedBy,
 *     observedBy, observedText, flooredOn }`, `flooredOn` naming each host whose floor asks for that property), what it
 *     serves in words (SERVES_TEXT), who holds its credentials (CUSTODY_TEXT), and per host that blesses it the
 *     OpenShell engine, gateway word and modes when it is an OpenShell venue;
 *   - `others`: venue names hosts bless that this build's table does not hold (a newer worker's), with those hosts;
 *   - `floors`: each host's PI_BACKEND_FLOOR, as it published it;
 *   - `unpublished`: the live hosts whose row carries no `backends` field (a worker from before it).
 */
export function venuesView(hostRows) {
  const rows = (Array.isArray(hostRows) ? hostRows : []).filter((h) => h && typeof h === "object");
  const nameOf = (h) => (typeof h.name === "string" && h.name !== "" ? h.name : "(no name)");
  const published = rows.filter((h) => h.backends && Array.isArray(h.backends.blessed));
  const unpublished = rows.filter((h) => !(h.backends && Array.isArray(h.backends.blessed))).map(nameOf);
  const floors = published.filter((h) => Object.keys(h.backends.floor ?? {}).length > 0).map((h) => ({ host: nameOf(h), floor: h.backends.floor }));
  const venues = BACKEND_NAMES.map((name) => {
    const entry = BACKENDS[name];
    const blessing = published.filter((h) => h.backends.blessed.includes(name));
    const custody = venueCustody(name);
    return {
      name,
      describe: entry.describe,
      blessedOn: blessing.map(nameOf),
      defaultOn: published.filter((h) => h.backends.default === name).map(nameOf),
      properties: PROPERTY_NAMES.map((property) => {
        const d = declarationOf(name, property);
        const word = isDeclaration(d?.word) ? d.word : ABSENT;
        return {
          property,
          label: PROPERTY_LABEL[property] ?? property,
          question: d?.question ?? "",
          word,
          wordText: DECLARATION_TEXT[word],
          assertedBy: d?.assertedBy ?? null,
          armedBy: d?.armedBy ?? null,
          observedBy: d?.observedBy ?? null,
          observedText: d?.observedBy ? (OBSERVATIONS[d.observedBy] ?? null) : null,
          flooredOn: published.filter((h) => Object.hasOwn(h.backends.floor ?? {}, property)).map((h) => {
            const observations = { openshellGatewayLocal: h.backends.openshell?.gateway === "local" };
            const have = d?.observedBy === "openshellGatewayLocal" ? effectiveWord(name, property, observations) : word;
            return { host: nameOf(h), want: h.backends.floor[property], have, meets: meets(have, h.backends.floor[property]), blessed: h.backends.blessed.includes(name) };
          }),
        };
      }),
      serves: SERVES.map((key) => ({ key, word: entry.serves[key], text: SERVES_TEXT[key]?.[entry.serves[key]] ?? null })),
      custody,
      custodyText: CUSTODY_TEXT[custody] ?? null,
      // A blessing row without an `os` part says nothing about its gateway (a hand-written row, a later encoding): it is
      // `unpublished`, never the failed-boot `unknown`, which is a word the worker published.
      openshell: OPENSHELL_BACKENDS.includes(name) ? blessing.map((h) => (h.backends.openshell ? { host: nameOf(h), ...h.backends.openshell } : { host: nameOf(h), engine: null, gateway: null, modes: [], unpublished: true })) : null,
    };
  });
  const otherNames = [...new Set(published.flatMap((h) => h.backends.blessed))].filter((n) => !BACKEND_NAMES.includes(n)).sort();
  const others = otherNames.map((name) => ({ name, blessedOn: published.filter((h) => h.backends.blessed.includes(name)).map(nameOf) }));
  return { venues, others, floors, unpublished };
}

/**
 * The venue a trigger's jobs run in: its explicit `run.backend`, else the deployment default `PI_BACKENDS[0]` read from
 * `env` through the worker's own parser, else null (a list that does not parse, which the worker refuses to boot on).
 */
export function triggerVenue(backend, env) {
  if (typeof backend === "string" && backend !== "") return backend;
  try {
    return parseBackendList(env?.PI_BACKENDS)[0] ?? null;
  } catch {
    return null;
  }
}

/** The record's `liveSkipped` and `steerSkipped`, each null when absent or outside its closed enum. */
export function recordSkips(record) {
  const r = record !== null && typeof record === "object" && !Array.isArray(record) ? record : {};
  return {
    liveSkipped: Object.hasOwn(r, "liveSkipped") && LIVE_SKIPPED_REASONS.includes(r.liveSkipped) ? r.liveSkipped : null,
    steerSkipped: Object.hasOwn(r, "steerSkipped") && STEER_SKIPPED_REASONS.includes(r.steerSkipped) ? r.steerSkipped : null,
  };
}

/** The clause the absent sentences add when the run's venue may be the cause: one spelling for every surface. */
export const VENUE_MAY_NOT_STREAM = "or its venue or job image does not stream it";

/**
 * Why a run may have no live transcript (and so no live progress), beyond the switch, the expiry and the start, which
 * the stream cannot tell apart: `{ skipped }`, the record's named skip in words (the cause, known); `{ venue }`, the run
 * is on a venue that does not always stream (`serves.liveTranscript` not `yes`) or on one this view cannot name (a
 * running job has no record yet), so `VENUE_MAY_NOT_STREAM` is one of the causes; or null, a venue that streams it.
 */
export function liveAbsentCause(record) {
  const { liveSkipped } = recordSkips(record);
  if (liveSkipped !== null) return { skipped: LIVE_SKIPPED_TEXT[liveSkipped] };
  // A record that names no venue was written before venues were recorded, when `local` was the only one
  // (`UNATTRIBUTED_BACKEND`, the worker's own reading of the same absence); no record at all is a running job, whose
  // venue this view cannot name.
  const isRecord = record !== null && typeof record === "object" && !Array.isArray(record);
  const venue = !isRecord ? null : typeof record.backend === "string" && record.backend !== "" ? record.backend : UNATTRIBUTED_BACKEND;
  return servesOf(venue)?.liveTranscript === "yes" ? null : { venue: true };
}

/** The live transcript's absent sentence for `record` (null for a running job), the three causes plus the venue's. */
export function transcriptAbsentText(record) {
  const cause = liveAbsentCause(record);
  if (cause?.skipped) return `No live transcript: ${cause.skipped}.`;
  return cause?.venue ? `No live transcript: not published (PI_LIVE_TRANSCRIPTS=0), expired, not started yet, ${VENUE_MAY_NOT_STREAM}.` : "No live transcript: not published (PI_LIVE_TRANSCRIPTS=0), expired, or not started yet.";
}

/** The live progress' absent sentence, `transcriptAbsentText`'s rule: progress is read off the live transcript. */
export function progressAbsentText(record) {
  const cause = liveAbsentCause(record);
  if (cause?.skipped) return `No live progress: it is read from the live transcript, and ${cause.skipped}.`;
  return cause?.venue ? `No live progress: not published (PI_RUN_PROGRESS=0), expired, no step recorded yet, ${VENUE_MAY_NOT_STREAM}.` : "No live progress: not published (PI_RUN_PROGRESS=0), expired, or no step has been recorded yet.";
}

/**
 * Why `pi-dispatch sandbox <id>` cannot reopen a run on `venue`, or null when the venue has a sandbox shell
 * (`serves.sandboxShell`, held to SANDBOX_LAUNCHERS by the worker's test). The panel's sandbox pane and the console's run
 * page say it in these words; kept under the pane's 53 columns for every venue name the table holds. A record with no
 * venue is a `local` run from before attribution (`UNATTRIBUTED_BACKEND`), which the caller passes as such.
 */
export function sandboxShellRefusal(venue) {
  const serves = servesOf(venue);
  if (serves?.sandboxShell === "yes") return null;
  return serves !== null ? `not reopenable (${venue} has no sandbox shell)` : `not reopenable here (ran on ${venue})`;
}


/**
 * A record's OpenShell policy facts (issue #712, INT-RUN-HISTORY-FILE-CONTRACT): the worker's own rebuild
 * (`recordedOpenshell`, held to the venue the record's `backend` names, hosts to the host-name charset, counts bounded),
 * so a record read back from disk or a mirror cannot put free text on a surface through it; null when absent or invalid.
 */
export function recordOpenshell(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record) || !Object.hasOwn(record, "openshell")) return null;
  return recordedOpenshell(record.openshell, record.backend);
}

/** A record's `secretsProfile` (issue #712), the worker's charset, or null. */
export function recordSecretsProfile(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record) || typeof record.secretsProfile !== "string") return null;
  return /^[A-Za-z0-9._-]{1,128}$/.test(record.secretsProfile) ? record.secretsProfile : null;
}

/** "copy mode, 1 provider, 2 placeholders" (the openshell policy's head, without the hosts). */
export function openshellCountsText(o) {
  if (o === null || typeof o !== "object") return "";
  return `${o.mode} mode, ${plural(o.providers, "credential provider", "credential providers")}, ${plural(o.placeholders, "placeholder", "placeholders")}`;
}

/** "3 rule hosts: a, b, c" (the hosts the policy admitted, and how many the record does not list). */
export function openshellHostsText(o) {
  if (o === null || typeof o !== "object") return "";
  if (o.ruleHostCount === 0) return "no rule host: the sandbox reaches nothing";
  const more = o.ruleHostCount - o.ruleHosts.length;
  return `${plural(o.ruleHostCount, "rule host", "rule hosts")}: ${o.ruleHosts.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

/**
 * A record's bundle facts (issue #704, INT-RUN-HISTORY-FILE-CONTRACT): `{ bundle, bundleSkipped }`, each null when
 * absent or not valid, or null when the record carries neither (every record of a project with no bundle). `bundle` is
 * the worker's own rebuild (`recordedBundle`: names held to the environment-name charset, counts bounded), so a record
 * file read back from disk or a mirror cannot put free text on a surface through it; `bundleSkipped` is the closed enum.
 */
export function recordBundle(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const bundle = Object.hasOwn(record, "bundle") ? recordedBundle(record.bundle) : null;
  if (bundle !== null && !OPENSHELL_BACKENDS.includes(record.backend)) delete bundle.placeholderNames;
  const bundleSkipped = Object.hasOwn(record, "bundleSkipped") && BUNDLE_SKIPPED_REASONS.includes(record.bundleSkipped) ? record.bundleSkipped : null;
  return bundle === null && bundleSkipped === null ? null : { bundle, bundleSkipped };
}

/**
 * A run record as a MODEL-CALLABLE tool returns it (issue #704 review): its `bundle` as COUNTS, `{ id, received,
 * shadowed, placeholders?, plain? }`, never the variable names. The names are the operator's manager's contents: the
 * operator's own views (the panel, the console, `/dispatch secrets`) show them, and no model context needs them to
 * reason about a run. A `bundle` the worker's rebuild refuses is dropped whole. Issue #712: `openshell` and
 * `secretsProfile` are rebuilt the same way (names that are operator config, and counts; never a resolver path).
 * Issue #737: the `reason` is the one every surface shows (words.mjs `recordReason`): a token, else null, so an older
 * worker's error text (a forge's API path, an address, a library's words) reaches no model either. Every other key is
 * the record's own, and a record with none of the three whose reason is a token or null is returned as it is (the same
 * object), so every other run reads byte-identical.
 */
export function modelRunRecord(record, { list = false } = {}) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return record;
  const hasBundle = Object.hasOwn(record, "bundle");
  const hasOpenshell = Object.hasOwn(record, "openshell");
  const hasProfile = Object.hasOwn(record, "secretsProfile");
  const hasRoles = Object.hasOwn(record, "modelRole") || Object.hasOwn(record, "modelRoles");
  const hasFailover = Object.hasOwn(record, "modelWhy") || Object.hasOwn(record, "providerFailure");
  const freeReason = Object.hasOwn(record, "reason") && record.reason !== null && recordReason(record) === null;
  if (!hasBundle && !hasOpenshell && !hasProfile && !freeReason && !hasFailover && !hasRoles) return record;
  const { modelRole: _modelRole, modelRoles: _modelRoles, bundle: raw, openshell: _openshell, secretsProfile: _profile, modelWhy: _modelWhy, providerFailure: _providerFailure, ...rest } = record;
  const out = { ...rest };
  if (freeReason) out.reason = null;
  if (modelRolesTelemetryOf(record.modelRoles)) out.modelRoles = modelRolesTelemetryOf(record.modelRoles);
  if (typeof record.modelRole === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(record.modelRole)) out.modelRole = record.modelRole;
  if (MODEL_WHY.includes(record.modelWhy)) out.modelWhy = record.modelWhy;
  const providerFailure = providerFailureOf(record.providerFailure);
  if (providerFailure !== null) out.providerFailure = providerFailure;
  if (hasBundle) {
    const b = recordedBundle(raw);
    if (b !== null) out.bundle = { id: b.id, received: b.variables.length, shadowed: b.shadowed.length, ...(Number.isSafeInteger(b.placeholders) ? { placeholders: b.placeholders, plain: b.plain } : {}) };
  }
  // Issue #712: the OpenShell facts REBUILT (`recordOpenshell`) or dropped whole. The rule hosts stay: they are the
  // operator's allowlist and model endpoints, the class `backend` and `host` already are, and "which hosts could this
  // run reach" is a question a model asked about a run can only answer with them. Counts for the credentials, as the
  // record has them; never a key name.
  // In a LIST of runs only the host count rides (a page of runs times 32 names is context no question about a list
  // needs); a single run read by its id carries the names.
  if (hasOpenshell) {
    const o = recordOpenshell(record);
    if (o !== null) out.openshell = list ? { mode: o.mode, ruleHostCount: o.ruleHostCount, providers: o.providers, placeholders: o.placeholders } : o;
  }
  // The profile's NAME, as `dispatch_triggers` already gives it (`secretsProfile` on a trigger); never its resolver path,
  // which no model-callable read carries (`OPERATOR_ONLY_KEYS`).
  if (hasProfile) {
    const name = recordSecretsProfile(record);
    if (name !== null) out.secretsProfile = name;
  }
  return out;
}

/** "Variables received: A, B, C (from bundle shop)", or "No variables received from bundle shop". */
export function bundleReceivedText(b) {
  if (b === null || typeof b !== "object") return "";
  return b.variables.length > 0 ? `Variables received: ${b.variables.join(", ")} (from bundle ${b.id})` : `No variables received from bundle ${b.id}`;
}

/** "3 as placeholders, 2 as values" (the openshell venues' counts), or "" when the record has none. */
export function bundleCountsText(b) {
  if (!Number.isSafeInteger(b?.placeholders) || !Number.isSafeInteger(b?.plain)) return "";
  return `${plural(b.placeholders, "as a placeholder", "as placeholders")}, ${plural(b.plain, "as a value", "as values")}`;
}

/**
 * Where a forge's instance lives, per kind: the deployment's own variable (what the worker's config reads) first, then
 * the job-container names the worker derives from it (`FORGES[kind].hostVars`). GitHub has one host and needs none.
 */
export const FORGE_HOST_ENV = Object.freeze({ gitlab: ["GITLAB_URL"], forgejo: ["FORGEJO_URL"], azure: ["AZURE_ORG_URL"] });

/** A repository path per forge: GitHub `owner/repo`, GitLab `group[/sub...]/project`, Forgejo `owner/repo`, Azure `project/repo`. */
const FORGE_REPO_RE = Object.freeze({
  github: /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/,
  forgejo: /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/,
  gitlab: /^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100}){1,20}$/,
  azure: /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/,
});

/** The base URL a forge kind's links are built on, or null: http(s) only, no credentials, query or fragment. */
function forgeBase(kind, env) {
  for (const name of [...(FORGE_HOST_ENV[kind] ?? []), ...(FORGES[kind]?.hostVars ?? [])]) {
    const raw = env?.[name];
    if (typeof raw !== "string" || raw === "") continue;
    if (hasControls(raw) || /\s/.test(raw)) return null;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  return null;
}

/**
 * The browsable URL of a run record's target, or null (issue #641). GitHub as `targetUrl` in dashboard.ts has always
 * built it (`https://github.com/<repo>/issues/<n>`, which GitHub redirects to the pull request when it is one); GitLab,
 * Forgejo and Azure on the DEPLOYMENT's own instance URL (`forgeBase`), with the target's separator choosing an issue or
 * a merge/pull request. Refused (null) on a control byte anywhere, a repository outside its forge's charset, an
 * instance URL that is not http(s), or an unknown host. Never a guessed host: a link an operator clicks to the wrong
 * place is worse than none.
 */
export function forgeLinkOf(record, env = {}) {
  const kind = record?.kind;
  const target = record?.target;
  if (!isForgeKind(kind) || typeof target !== "string" || target.length > 300 || hasControls(target)) return null;
  const m = /^(.+)([#!])(\d{1,12})$/.exec(target);
  if (!m) return null;
  const [, repo, sep, n] = m;
  // A `.` or `..` segment would walk the link's path out of the repository on the forge's own host.
  if (!FORGE_REPO_RE[kind]?.test(repo) || repo.split("/").some((seg) => seg === "." || seg === "..")) return null;
  const request = sep === "!";
  if (request && FORGES[kind].pullRequestSep !== "!") return null; // a separator this forge never writes
  if (kind === "github") return `https://github.com/${repo}/issues/${n}`;
  const base = forgeBase(kind, env);
  if (base === null) return null;
  if (kind === "gitlab") return `${base}/${repo}/-/${request ? "merge_requests" : "issues"}/${n}`;
  if (kind === "forgejo") return `${base}/${repo}/issues/${n}`;
  if (kind === "azure") {
    const [project, name] = repo.split("/");
    return request ? `${base}/${project}/_git/${name}/pullrequest/${n}` : `${base}/${project}/_workitems/edit/${n}`;
  }
  return null;
}

/** The longest URL `forgeTargetOf` reads; a forge link is well under it. */
export const FORGE_URL_MAX = 2048;

const FORGE_NUMBER_RE = /^\d{1,12}$/;

/**
 * A run target's comparison key (issue #647): `<kind>\0<target>`, with a forge target's repository path lowercased and
 * its number's leading zeros dropped, or null for a kind or target that is not a string. ONE rule for "the same target",
 * shared by the parked fold's answered rule (`readParkedRuns`), the parked answer's planner, `/api/run`'s URL lookup and
 * newer-run search, and the pending-answer scan (`readPendingOnTargets`), so none of them can call a run answered that
 * another offers a reply for. Case-insensitive because every forge this project speaks looks a repository up that way
 * (GitHub, Forgejo and GitLab paths, an Azure project and repository): `Acme/Web#12` and `acme/web#12` are one issue,
 * and an exact comparison would let a renamed-case repository's later run leave its park offering a second reply. A
 * local or cron target (`local:<basename>`, a scheduler's) is compared exactly: a folder name is case-sensitive.
 */
export function targetKeyOf(kind, target) {
  if (typeof kind !== "string" || typeof target !== "string") return null;
  if (isForgeKind(kind)) {
    const m = /^(.+)([#!])(\d{1,30})$/.exec(target);
    if (m) return `${kind}\u0000${m[1].toLowerCase()}${m[2]}${m[3].replace(/^0+(?=\d)/, "")}`;
  }
  return `${kind}\u0000${target}`;
}

/** A repository path for `kind` from URL path segments, or null: the forge's own charset, and no `.` or `..` segment. */
function forgeRepoOf(kind, segments) {
  const repo = segments.join("/");
  if (!FORGE_REPO_RE[kind]?.test(repo) || segments.some((seg) => seg === "." || seg === "..")) return null;
  return repo;
}

/**
 * The run target a forge URL names (issue #647): the INVERSE of `forgeLinkOf`, held to it by a round-trip test, so a
 * link the console draws is a link `pi-dispatch chat <url>` and `/api/run?url=` read back to the same target. Answers
 * `{ kind, target }`; for an Azure WORK ITEM `{ kind: "azure", project, number, ambiguous: true }`, because its URL names
 * the project and never the repository, so the target (`<project>/<repo>#<n>`) is whichever run records say (the caller
 * looks, and answers 409 with the candidates when there are several); or null.
 *
 * Read on the DEPLOYMENT's own instance URLs (`forgeBase`, the variables `forgeLinkOf` reads) and github.com, never a
 * guessed host: a URL on any other host is null, not a best guess. Beside `forgeLinkOf`'s own shapes it also reads the
 * request URLs a person copies from the forge, which `forgeLinkOf` never writes because GitHub and Forgejo redirect an
 * issue link to the pull request: GitHub's `/pull/<n>` and Forgejo's `/pulls/<n>` (both `#`, the separator those forges
 * share between issues and pull requests). A query or fragment (`#issuecomment-1`) is ignored; credentials, a control
 * byte, whitespace, a non-http(s) scheme, a path segment that does not decode, a segment that decodes to a `/` or a
 * control byte (`%2F` in a GitLab path is not a subgroup), and a repository outside its forge's charset are refused.
 * Where two configured instances share a prefix, the longer base wins. A number's leading zeros are dropped.
 */
export function forgeTargetOf(url, env = {}) {
  if (typeof url !== "string" || url === "" || url.length > FORGE_URL_MAX || hasControls(url) || /\s/.test(url)) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username !== "" || u.password !== "") return null;
  const href = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  let best = null;
  for (const kind of Object.keys(FORGES)) {
    const base = kind === "github" ? "https://github.com" : forgeBase(kind, env);
    if (base === null || !href.startsWith(`${base}/`)) continue;
    if (best === null || base.length > best.base.length) best = { kind, base };
  }
  if (best === null) return null;
  let segments;
  try {
    segments = href.slice(best.base.length + 1).split("/").map((seg) => decodeURIComponent(seg));
  } catch {
    return null; // a malformed percent escape
  }
  if (segments.some((seg) => seg === "" || seg.includes("/") || hasControls(seg))) return null;
  const { kind } = best;
  const digits = segments.at(-1);
  if (!FORGE_NUMBER_RE.test(digits ?? "")) return null;
  // `/issues/007` is issue 7 on every forge, and the worker writes the target with the forge's own number (no zeros).
  const n = digits.replace(/^0+(?=\d)/, "");
  const word = segments.at(-2);
  if (kind === "github" || kind === "forgejo") {
    if (segments.length !== 4) return null;
    const request = kind === "github" ? "pull" : "pulls";
    if (word !== "issues" && word !== request) return null;
    const repo = forgeRepoOf(kind, segments.slice(0, 2));
    return repo === null ? null : { kind, target: `${repo}#${n}` };
  }
  if (kind === "gitlab") {
    if (segments.length < 5 || segments.at(-3) !== "-" || (word !== "issues" && word !== "merge_requests")) return null;
    const repo = forgeRepoOf(kind, segments.slice(0, -3));
    return repo === null ? null : { kind, target: `${repo}${word === "merge_requests" ? "!" : "#"}${n}` };
  }
  if (kind === "azure") {
    if (segments.length === 4 && segments[1] === "_workitems" && segments[2] === "edit") {
      const project = segments[0];
      return forgeRepoOf(kind, [project, "x"]) === null ? null : { kind, project, number: n, ambiguous: true };
    }
    if (segments.length === 5 && segments[1] === "_git" && segments[3] === "pullrequest") {
      const repo = forgeRepoOf(kind, [segments[0], segments[2]]);
      return repo === null ? null : { kind, target: `${repo}!${n}` };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// A running job's inbox (issue #646, INT-STEER-INBOX-CONTRACT): what the console's run page, its state API and the TUI
// show of the messages sent into a steer-armed run. NEVER THE TEXT: `listInboxPublic` already drops it, and every field
// is rebuilt here by name against the inbox's own vocabularies, so a value another writer put in the list cannot ride
// along. The text is the sender's own words for one run; it reaches the run through its read-only mount and nothing
// that lists.
// ---------------------------------------------------------------------------------------------------------------------

/** The most steer-armed active jobs whose inbox one snapshot reads (one MULTI each). */
export const STEER_INBOX_ROWS_MAX = 16;

const BULL_STATE_RE = /^[a-z-]{1,24}$/;

/** One public inbox entry rebuilt field by field: `{ id, mode, source, state, at, bytes }`, null for what fails. */
export function publicInboxEntry(e) {
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  return {
    id: typeof e?.id === "string" && STEER_ID_RE.test(e.id) ? e.id : null,
    mode: STEER_MODES.includes(e?.mode) ? e.mode : null,
    source: STEER_SOURCES.includes(e?.source) ? e.source : null,
    state: STEER_STATES.includes(e?.state) ? e.state : null,
    at: n(e?.at),
    bytes: n(e?.bytes) ?? 0,
  };
}

/**
 * The ACTIVE job of run `runId` other than `exceptId` (review F4): a #645 recovery keeps the run id, so the base run's
 * page (its job failed) and a `.r1` page (whose `.r2` took over) name a run that is still going under another job id.
 * The candidates are the run's own id and its recovery ids (`recoveryJobId`, 1 to `RECOVERY_CAP`), newest first,
 * found through `getJob(id)` (which answers `{ job, queue }` or null). Null when none of them is active. Reads only.
 */
export async function activeJobOfRun(getJob, runId, exceptId = null) {
  if ((typeof runId !== "string" || runId === "") && !Number.isSafeInteger(runId)) return null;
  const base = String(runId);
  const ids = [];
  for (let n = RECOVERY_CAP; n >= 1; n -= 1) {
    const id = recoveryJobId(base, n);
    if (id !== null) ids.push(id);
  }
  ids.push(base);
  for (const id of ids) {
    if (id === exceptId) continue;
    const found = await getJob(id);
    if (!found?.job) continue;
    const state = await found.job.getState().catch(() => "unknown");
    if (state === "active") return found;
  }
  return null;
}

/**
 * The ACTIVE and the QUEUED job of run `runId` other than `exceptId` (issue #647): `{ active, queued }`, each `{ job,
 * queue }` or null, over the same candidates and order as `activeJobOfRun` (the recovery ids newest first, then the base).
 * `queued` is the newest candidate in one of chat-mode's `QUEUED_STATES` (a #645 recovery enqueued and not started yet):
 * the base attempt's record then says `recovery-enqueued`, which alone reads as a finished run, and a fork of it would
 * race the recovery that is about to write the same session. Stops at the first active one. Reads only.
 */
export async function liveJobsOfRun(getJob, runId, exceptId = null) {
  if ((typeof runId !== "string" || runId === "") && !Number.isSafeInteger(runId)) return { active: null, queued: null };
  const base = String(runId);
  const ids = [];
  for (let n = RECOVERY_CAP; n >= 1; n -= 1) {
    const id = recoveryJobId(base, n);
    if (id !== null) ids.push(id);
  }
  ids.push(base);
  let queued = null;
  for (const id of ids) {
    if (id === exceptId) continue;
    const found = await getJob(id);
    if (!found?.job) continue;
    const state = await found.job.getState().catch(() => "unknown");
    if (state === "active") return { active: found, queued: null };
    if (queued === null && QUEUED_STATES.includes(state)) queued = found;
  }
  return { active: null, queued };
}

/**
 * The recovery job that took run `runId` over after job `jobId` (issue #662): the newest of the run's recovery ids
 * (`recoveryJobId`, `RECOVERY_CAP` down) numbered after `jobId`'s own (the base run counts as 0) that `getJob` finds,
 * IN ANY STATE, unlike `activeJobOfRun`: a recovery that already finished still continued this run. The NEWEST, not the
 * next one: with `.r1` and `.r2` both held, the base attempt names `.r2`, on purpose, because that is where the run
 * lives now (`.r1`'s own page names `.r2` the same way, and `.r1` is one "Recovery of" link away from the base). Null
 * when none is found or `jobId` is not this run's. Reads only.
 */
export async function laterJobOfRun(getJob, runId, jobId) {
  if (typeof runId !== "string" || runId === "" || typeof jobId !== "string") return null;
  let own = jobId === runId ? 0 : null;
  for (let n = 1; own === null && n <= RECOVERY_CAP; n += 1) if (recoveryJobId(runId, n) === jobId) own = n;
  if (own === null) return null;
  for (let n = RECOVERY_CAP; n > own; n -= 1) {
    const id = recoveryJobId(runId, n);
    if (id === null) continue;
    const found = await getJob(id);
    if (found?.job) return found;
  }
  return null;
}

/**
 * The run page's progress (issue #662): `{ progress, continues, continuesAs }`. A #645 recovery writes its progress
 * under its RUN's id, so the key is read by that id (`runIdOf`): the record's `recoveryOf` when it has one, else the
 * queue job's `data.recoveryOf`, else the page's own id; a plain job and a BullMQ retry (same job id) read exactly the key
 * they always did. `continues` is true when this attempt's record says its run went on as a recovery (`reason:
 * "recovery-enqueued"`): the key then belongs to that recovery, not to this attempt, and the panel shows the record's
 * own progress with `continuesAs` (the recovery job's id, `laterJobOfRun`, or null once the queue no longer holds it).
 * `progress` is `readProgress`'s answer. Of a Job's `.data` it reads `recoveryOf` alone. Never throws.
 */
export async function readRunProgress({ redis, queues, jobId, record = null, timeoutMs = FLEET_READ_TIMEOUT_MS } = {}) {
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { progress: { invalid: "a run id is letters, digits and . _ : -, at most 200 characters" }, continues: false, continuesAs: null };
  const getJob = async (id) => {
    for (const q of Array.isArray(queues) ? queues : []) {
      if (typeof q?.getJob !== "function") continue;
      const job = await q.getJob(id).catch(() => null);
      if (job) return { job, queue: q.name };
    }
    return null;
  };
  const read = (async () => {
    const of = record && Object.hasOwn(record, "recoveryOf") ? recordedRecoveryOf(record.recoveryOf) : null;
    let runId = of !== null && RUN_ID_RE.test(of) ? of : null;
    if (runId === null) {
      const job = (await getJob(jobId))?.job ?? null;
      const id = job ? runIdOf(job) : jobId;
      runId = typeof id === "string" && RUN_ID_RE.test(id) ? id : jobId;
    }
    const continues = record?.reason === "recovery-enqueued";
    const [progress, next] = await Promise.all([readProgress(redis, runId, { timeoutMs }), continues ? laterJobOfRun(getJob, runId, jobId) : null]);
    const nextId = typeof next?.job?.id === "string" && RUN_ID_RE.test(next.job.id) ? next.job.id : null;
    return { progress, continues, continuesAs: nextId };
  })();
  try {
    return await withTimeout(read, timeoutMs, { progress: { unreachable: "timed out reaching the progress key" }, continues: record?.reason === "recovery-enqueued", continuesAs: null });
  } catch {
    return { progress: { unreachable: "the progress key could not be read" }, continues: record?.reason === "recovery-enqueued", continuesAs: null };
  }
}

/**
 * One job's queue state for the terminal chat's mode (issue #647, `chatModeOf`): `{ found, state, continuesAs,
 * queuedAs }`, the job found by id in `queues` (the first that knows it), its BullMQ state word (null when no queue holds
 * it), the id of its run's ACTIVE #645 recovery job when the job itself is not active, and, when none is active, the id
 * of its run's QUEUED recovery job (`liveJobsOfRun`; each null otherwise). For
 * every job, steer-armed or not, unlike `readJobInbox`. `{ invalid: true }` for an id outside the run-id charset and
 * `{ unreachable: true }` for a read that failed or ran out of time. Of the Job's `.data` it reads `recoveryOf` alone
 * (`runIdOf`). `whole` is whether `queues` are every queue the job could be in (issue #737): when they may not be, a
 * job none of them holds is `found: null`, not known to be absent. Never throws.
 */
export async function readJobStatus({ queues, jobId, whole = true, timeoutMs = FLEET_READ_TIMEOUT_MS } = {}) {
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { invalid: true };
  const read = (async () => {
    const getJob = async (id) => {
      for (const q of Array.isArray(queues) ? queues : []) {
        if (typeof q?.getJob !== "function") continue;
        const job = await q.getJob(id);
        if (job) return { job, queue: q.name };
      }
      return null;
    };
    const job = (await getJob(jobId))?.job ?? null;
    const raw = job ? await job.getState().catch(() => "unknown") : null;
    const state = raw === null ? null : typeof raw === "string" && BULL_STATE_RE.test(raw) ? raw : "unknown";
    // A job the queue no longer holds may still be a run's base whose recovery runs (`.r1` keeps the run id), so the
    // recovery ids are looked for by this id as the run id then.
    const runId = job ? runIdOf(job) : jobId;
    const live = state === "active" ? { active: null, queued: null } : await liveJobsOfRun(getJob, typeof runId === "string" ? runId : jobId, jobId);
    const idOf = (found) => (typeof found?.job?.id === "string" && RUN_ID_RE.test(found.job.id) ? found.job.id : null);
    return { found: job !== null ? true : whole === false ? null : false, state, continuesAs: idOf(live.active), queuedAs: idOf(live.queued) };
  })();
  try {
    return await withTimeout(read, timeoutMs, { unreachable: true });
  } catch {
    return { unreachable: true };
  }
}

/**
 * How many job ids the pending-answer scan lists in all, across every queue and state (issue #647, review round 2).
 * Past it the scan says so (`tooMany`) instead of guessing. One budget for the whole look, not a cap per state: a cap
 * per state made the first state with that many jobs declare everything partial, so a busy queue made every park
 * unanswerable. Listing an id and reading its two short hash fields costs about the same for any job, so the budget
 * bounds the read's time and memory whatever the jobs carry; 10,000 is far above a healthy queue and well inside
 * FLEET_READ_TIMEOUT_MS against a local Valkey (the 1,200-job live test reads in tens of milliseconds).
 */
export const PENDING_SCAN_BUDGET = 10_000;

/** Ids per list read: a page, so one huge state is read in bounded steps under the one budget. */
export const PENDING_SCAN_PAGE = 500;

/**
 * The most jobs whose whole `.data` the scan parses (a forge job with no semantic dedup id: a #645 recovery or a late
 * message's job). Past it the scan says `tooMany`: a job's data carries its issue's body and comment, so this is the
 * one read whose size the job's author chooses.
 */
export const PENDING_DATA_MAX = 500;

/**
 * The states a job on a park's target counts as taking its answer in: running, or about to (chat-mode's own list), in
 * the order a job moves through them, so a job that moves while the scan pages (delayed to waiting, waiting to active)
 * is met again in a state read later rather than slipping between two reads.
 */
export const PENDING_STATES = Object.freeze(["waiting-children", "delayed", "prioritized", "paused", "waiting", "active"]);

/** The forge job's semantic dedup id (`enqueueForgeJob`'s `repo<sep>number:flow...`): its target, the part before the flow. */
const DEID_TARGET_RE = /^([^:]+[#!]\d{1,30}):/;

/**
 * One queue's ids in `state`, `start` to `end` inclusive, and their `name` and `deid` hash fields, read the cheap way:
 * BullMQ's own range script for the ids, then one pipelined HMGET of two short fields per job, never the job's data.
 * A queue double (or a reader without the raw client) falls back to `getJobs`, whose jobs carry their data whole.
 */
async function pendingPage(q, state, start, end) {
  if (typeof q?.getRanges === "function" && typeof q?.toKey === "function" && q?.client) {
    const ids = (await q.getRanges([state], start, end)).filter((id) => typeof id === "string");
    if (ids.length === 0) return [];
    const client = await q.client;
    const pipe = client.pipeline();
    for (const id of ids) pipe.hmget(q.toKey(id), "name", "deid");
    const got = await pipe.exec();
    return ids.map((id, i) => {
      const [err, v] = got[i] ?? [];
      return { id, name: !err && Array.isArray(v) ? v[0] : null, deid: !err && Array.isArray(v) ? v[1] : null, data: undefined };
    });
  }
  if (typeof q?.getJobs !== "function") return null;
  const jobs = await q.getJobs([state], start, end);
  return (Array.isArray(jobs) ? jobs : []).map((job) => ({ id: job?.id, name: typeof job?.name === "string" ? job.name : null, deid: null, data: job?.data ?? null }));
}

/** The parsed `.data` of each id (null where it is missing or not JSON), one pipelined HGET. */
async function pendingData(q, ids) {
  const client = await q.client;
  const pipe = client.pipeline();
  for (const id of ids) pipe.hget(q.toKey(id), "data");
  const got = await pipe.exec();
  return ids.map((_, i) => {
    const [err, v] = got[i] ?? [];
    if (err || typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  });
}

/**
 * The jobs queued or running on parked runs' targets (issue #647): `{ byKey, complete, tooMany }`, `byKey` a Map from
 * each matched target's `targetKeyOf` to the first such job's id, `complete` false when the scan did not see every job
 * (so a target with no match is NOT known to have none), `tooMany` true when that was because the queues hold more than
 * the budget (`PENDING_SCAN_BUDGET` ids, `PENDING_DATA_MAX` data reads), or `{ unreachable: true }`. `targets` is
 * `[{ kind, target, runId }]`, `runId` the park's own run, whose jobs are never its answer.
 *
 * WHY A QUEUE SCAN AND NOT THE ANSWER'S KEYS. A run's record is written at its end, so the answer's resume run leaves no
 * record while it is queued or running, and the park would go on offering a reply that resumes the same transcript a
 * second time. The keys an answer leaves are no better: its delivery id is fresh per answer, and its semantic window
 * (`repo#n:flow`) names the COMMENT trigger's flow, not the park's, and lapses after ten minutes while the run may go on
 * for an hour. Listing the running and waiting jobs is what can say "a run on this target is coming", the parked fold's
 * own answered rule one step early.
 *
 * WHAT IT READS (review round 2: reading every job whole made a busy queue cost every park its answer). Ids page by
 * page under one budget, and per id only the hash's `name` (the job's kind: `local` for cron, CLI and chained jobs,
 * skipped at once unless a local park is wanted) and `deid`, the semantic dedup id every receiver and console forge job
 * carries, whose `repo<sep>number` prefix IS `targetFor`'s target. Only a forge job of a wanted kind without one (a
 * recovery or a late message's job) has its `.data` parsed, for what `targetFor` reads and `recoveryOf` (`runIdOf`).
 * Compared in memory; ids alone come back. It stops early once every target is matched. Never throws.
 */
export async function readPendingOnTargets({ queues, targets, budget = PENDING_SCAN_BUDGET, page = PENDING_SCAN_PAGE, dataMax = PENDING_DATA_MAX, timeoutMs = FLEET_READ_TIMEOUT_MS } = {}) {
  const want = new Map();
  for (const t of Array.isArray(targets) ? targets : []) {
    const key = targetKeyOf(t?.kind, t?.target);
    if (key !== null) want.set(key, typeof t.runId === "string" ? t.runId : null);
  }
  if (want.size === 0) return { byKey: new Map(), complete: true, tooMany: false };
  const kinds = new Set([...want.keys()].map((k) => k.slice(0, k.indexOf("\u0000"))));
  const read = (async () => {
    const byKey = new Map();
    let complete = true;
    let tooMany = false;
    let listed = 0;
    let parsed = 0;
    const match = (id, key, recoveryOf) => {
      if (key === null || !want.has(key) || byKey.has(key)) return;
      if (typeof id !== "string" || !RUN_ID_RE.test(id)) return;
      const own = want.get(key);
      if (own !== null && (id === own || recoveryOf === own)) return;
      byKey.set(key, id);
    };
    const fromData = (id, data) => {
      if (data === null || typeof data !== "object") return;
      if (data.purpose === "answer-draft" || data.answerDraft) return;
      let target = null;
      try {
        target = targetFor(data.kind, data);
      } catch {
        target = null; // a hand-built entry with no folder or repo has no target
      }
      match(id, targetKeyOf(data.kind, target), runIdOf({ id, data }));
    };
    scan: for (const q of Array.isArray(queues) ? queues : []) {
      for (const state of PENDING_STATES) {
        for (let start = 0; ; ) {
          if (byKey.size === want.size) break scan;
          const room = budget - listed;
          const take = Math.min(page, room);
          // One id past the page says whether more follow, so a state that holds exactly the budget is complete.
          const rows = take > 0 ? await pendingPage(q, state, start, start + take) : await pendingPage(q, state, start, start);
          if (rows === null) {
            complete = false; // a queue this reader cannot list
            continue scan;
          }
          if (take <= 0) {
            if (rows.length > 0) {
              complete = false;
              tooMany = true;
              break scan;
            }
            break;
          }
          const mine = rows.slice(0, take);
          listed += mine.length;
          const needData = [];
          for (const row of mine) {
            if (row.data !== undefined) {
              fromData(row.id, row.data); // a queue double's whole job
              continue;
            }
            if (!kinds.has(row.name)) continue; // another kind (a cron or CLI job when no local park is wanted)
            const deid = isForgeKind(row.name) && typeof row.deid === "string" ? DEID_TARGET_RE.exec(row.deid) : null;
            if (deid) match(row.id, targetKeyOf(row.name, deid[1]), null);
            else needData.push(row.id);
          }
          if (needData.length > 0) {
            if (parsed + needData.length > dataMax) {
              complete = false;
              tooMany = true;
              break scan;
            }
            parsed += needData.length;
            const datas = await pendingData(q, needData);
            needData.forEach((id, i) => fromData(id, datas[i]));
          }
          if (rows.length <= take) break;
          start += take;
        }
      }
    }
    return { byKey, complete, tooMany };
  })();
  try {
    return await withTimeout(read, timeoutMs, { unreachable: true });
  } catch {
    return { unreachable: true };
  }
}

/**
 * One target's answer off a `readPendingOnTargets` result: `{ jobId }` (the job on its target, or null when the scan saw
 * everything and found none), `{ unknown: true, tooMany }` (a partial scan with no match; `tooMany` when the queues were
 * deeper than its budget) or `{ unreachable: true }`. The shape chat-mode's `pendingFactsOf` reads, for the parked
 * inbox's rows and the single-park reader alike.
 */
export function pendingScanFor(got, key) {
  if (!got || got.unreachable) return { unreachable: true };
  const id = key === null ? null : (got.byKey?.get(key) ?? null);
  if (id !== null) return { jobId: id };
  if (key !== null && got.complete) return { jobId: null };
  return { unknown: true, tooMany: got.tooMany === true };
}

/** Whether one park is being answered now (issue #647, `readPendingOnTargets` for a single target): `pendingScanFor`'s shape. */
export async function readPendingAnswer({ queues, kind, target, runId = null, budget, page, dataMax, timeoutMs = FLEET_READ_TIMEOUT_MS } = {}) {
  const key = targetKeyOf(kind, target);
  if (key === null) return { unknown: true, tooMany: false };
  const got = await readPendingOnTargets({ queues, targets: [{ kind, target, runId }], budget, page, dataMax, timeoutMs });
  return pendingScanFor(got, key);
}

/**
 * One job's inbox for the run page: the job found by id in `queues` (the first that knows it), then, for a steer-armed
 * job, its queue state, whether its run takes messages now (`run:steer:open:<runId>`) and its entries without text.
 * Answers `{ invalid: true }` (an id outside the run-id charset), `{ found: false }`, `{ found: true, steer: false }`,
 * `{ found: true, steer: true, state, open (true, false, or null when unread), entries (null when unread), closed }` or
 * `{ unreachable: true }`, plus `continuesAs` (review F4: the id of the run's ACTIVE recovery job, `activeJobOfRun`)
 * when this job is not active but its run goes on under another id. Of the Job's `.data` it reads `steer` and
 * `recoveryOf` alone. Never throws.
 */
export async function readJobInbox({ redis, queues, jobId, timeoutMs = FLEET_READ_TIMEOUT_MS } = {}) {
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { invalid: true };
  const read = (async () => {
    const getJob = async (id) => {
      for (const q of Array.isArray(queues) ? queues : []) {
        if (typeof q?.getJob !== "function") continue;
        const job = await q.getJob(id);
        if (job) return { job, queue: q.name };
      }
      return null;
    };
    const job = (await getJob(jobId))?.job ?? null;
    if (!job) return { found: false };
    if (job.data?.steer !== true) return { found: true, steer: false };
    const runId = runIdOf(job);
    const [state, open, list] = await Promise.all([job.getState().catch(() => "unknown"), steerIsOpen({ redis, runId }), listInboxPublic({ redis, runId })]);
    const word = typeof state === "string" && BULL_STATE_RE.test(state) ? state : "unknown";
    const next = word === "active" ? null : await activeJobOfRun(getJob, runId, jobId);
    const nextId = typeof next?.job?.id === "string" && RUN_ID_RE.test(next.job.id) ? next.job.id : null;
    return {
      found: true,
      steer: true,
      state: word,
      open: open === true ? true : open === false ? false : null,
      entries: Array.isArray(list?.entries) ? list.entries.map(publicInboxEntry) : null,
      closed: list?.closed === true,
      ...(nextId !== null ? { continuesAs: nextId } : {}),
    };
  })();
  try {
    return await withTimeout(read, timeoutMs, { unreachable: true });
  } catch {
    return { unreachable: true };
  }
}

export { readForkPoints, planRunFork, enqueueRunFork } from "./run-fork.mjs";
