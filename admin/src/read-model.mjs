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

import * as nodeFs from "node:fs";
import { randomBytes } from "node:crypto";
import { GIT_READ_FLAGS } from "@edgehero/pi-dispatch/git-hardening";
import { join, delimiter, sep, isAbsolute, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { logsDirPath, defaultSandboxDir, CHAIN_DEPTH_MAX_DEFAULT, CHAIN_MAX_PER_JOB_DEFAULT } from "@edgehero/pi-dispatch/config";
import { settingsFilePath, readOverlay, writeOverlay, KNOWN_KEYS } from "@edgehero/pi-dispatch/runtime-settings";
import { DOLLAR_ENV_NAMES, DOLLAR_SETTING_KEYS, checkDollarInvariant, formatMicros } from "@edgehero/pi-dispatch/money";
import { RECOVER_SKIPPED_REASONS, recordedCheckpoints, recordedRecovered, recordedRecoveryOf, sanitizeJobId, UNREADABLE_RECORD } from "@edgehero/pi-dispatch/run-history";
import { FORGE_MCP_SERVER_NAME, mcpServerWhere, readOverlayMcp } from "@edgehero/pi-dispatch/mcp-config";
import { dayKey, weekKey, monthKey, tokenDayKey } from "@edgehero/pi-dispatch/budget";
import { parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
// The scoped-limits validator is shared for the anti-drift reason the pause/subscriptions ones are: the
// write goes through the exact parser the worker boot-loads, so the sides cannot disagree on the schema.
import { danglingProjectRows, dollarKeyPrefixFor, isModelScope, isProjectScope, parseScopedLimits, scopeDollarKeyPrefix, scopedLimitsVersionFor, scopeKeyPrefix, USD_LIMIT_FIELDS } from "@edgehero/pi-dispatch/scoped-limits";
// The projects parser, for the same anti-drift reason: a `project:<id>` row is written only when the id is a project the
// worker would load (issue #499 part B).
import { parseProjects } from "@edgehero/pi-dispatch/projects";
// The allocation envelope, the plan module and the applied split (issue #504 part C), the worker's own: the admin judges an
// envelope with the parser the worker boots with, and applies or reverts a plan through the worker's `applyPlan` and
// `revert`, so the ladder, the step and the compare-and-set are one implementation.
import { ENVELOPE_VERSION, envelopeDigest, parseEnvelope } from "@edgehero/pi-dispatch/envelope";
import { OTHER, PLAN_VERSION, envelopeEntries, scopeRef } from "@edgehero/pi-dispatch/priorities";
import { ALLOC_EXPECTED_KEY, ALLOC_LOG_KEY, ALLOC_PLAN_KEY, makeAllocationAudit, makeAllocationState, parseState } from "@edgehero/pi-dispatch/allocation";
import { DOLLAR_KEY_PREFIX } from "@edgehero/pi-dispatch/dollar-budget";
import { removeHeldJob, requestCancel } from "@edgehero/pi-dispatch/cancel-state";
import { RECOVERY_CAP, recoveryJobId, runIdOf } from "@edgehero/pi-dispatch/recovery-queue";
import { STEER_ID_RE, STEER_MODES, STEER_SOURCES, STEER_STATES, isOpen as steerIsOpen, listInboxPublic } from "@edgehero/pi-dispatch/steer-inbox";
import { HELD_SET, jobKey } from "@edgehero/pi-dispatch/wait-state";
// The subscriptions validator is shared for the same anti-drift reason: the admin prices finished runs
// against the exact schema the file declares, and re-deriving it here is how the two would disagree.
import { parseSubscriptions, SUBSCRIPTIONS_VERSION } from "@edgehero/pi-dispatch/subscriptions";
import { parseConnection, makeRedisClient, killSwitchValkeyUrls, urlShown, useValkeyContext, valkeyContextFromKeys, VALKEY_CONTEXT_KEYS } from "@edgehero/pi-dispatch/connection";
import { pointerState } from "./deployment-pointer.mjs";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";
import { CAPACITY_WINDOWS, computeCapacity } from "@edgehero/pi-dispatch/capacity";
import { readCapacityRecords } from "@edgehero/pi-dispatch/capacity-records";
import { capacityText, deploymentFacts, onlyHost } from "@edgehero/pi-dispatch/capacity-cli";
import { resolveJobSize } from "@edgehero/pi-dispatch/job-size";
import { projectBudgetRow, publishedBudget } from "@edgehero/pi-dispatch/host-budget";
import { peakSeries, refusalWords, sizeRefusal, suggestSize, suggestionCall, suggestionEvidence } from "@edgehero/pi-dispatch/size-suggest";
import { readSizingRecords } from "@edgehero/pi-dispatch/size-records";
import { QUEUE, makeQueue, enqueueLocalJobReporting, swallowedRunSentence, fleetQueueNames, hostQueueName, discoverHostQueues, unionQueueNames } from "@edgehero/pi-dispatch/queue";
import { RUNS_INDEX, RUNS_INDEX_MAX, hostsIn, mergeRuns, readMirroredPage, readMirroredRecord, readMirroredRuns } from "@edgehero/pi-dispatch/run-mirror";
import { stallKey } from "@edgehero/pi-dispatch/scheduler-stall-guard";
import { parseJobsMore, parseLiveJobs } from "@edgehero/pi-dispatch/live-jobs";
import { sessionKeyFor } from "@edgehero/pi-dispatch/session-key";
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
import { FORGES, isForgeKind } from "@edgehero/pi-dispatch/forges";
import { hasControls, scrubControls } from "./panel.mjs";
import { runMatches } from "./run-filter.mjs";
// The two pure text scanners live in graph-model.mjs (the pure side of the graph feature); this module
// supplies them bytes, never the other way around -- the dependency points read-model -> graph-model.
import { parseSkillMeta, findSiblingMentions, findLoopHints, triggerMatchLabel } from "./graph-model.mjs";
import { repoOfTarget } from "./costs.mjs";
import { deploymentDollarCaps, dollarWindowRows, dollarWindowSpecs, dollarWindowsSinceMs } from "./dollar-windows.mjs";
// Issue #471: the ONE resolver of a deployment's service keys, shared with `doctor` (the package boundary allows it: the
// admin already takes its config helpers from the worker the same way).
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";

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
export const PANEL_SERVICE_KEYS = Object.freeze(["VALKEY_URL", "PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_TRIGGERS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_ENVELOPE_FILE", "PI_CONSOLE_TOKENS_FILE", "PI_GLOBAL_PI_DIR", "PI_SANDBOX_DIR", "PI_SANDBOX_RETENTION_HOURS", "PI_SANDBOX_IDLE_MINUTES", "PI_CAPTURE_JOB_LOGS", "PI_SCHEDULER_STALL_MAX", "PI_CHAIN_DEPTH_MAX", "PI_CHAIN_MAX_PER_JOB", "PI_WORKER_NAME", "PI_CONSOLE_LISTEN", "PI_CONSOLE_BIND_PUBLIC", "TMPDIR", "TEMP", ...Object.values(DOLLAR_ENV_NAMES)]);
// The console's address (the insights move to the console): `/dispatch insights` and the `i` key print the spend
// screen's URL from the PI_CONSOLE_LISTEN the console itself reads from this `.env` (`console/link.mjs`).
// The dollar settings (issue #501) are among them: `dispatch_set`'s confirm states a dollar key's effective value, and
// in a pointer deployment the cap the worker runs under lives in the deployment's `.env`, not in pi's environment.
// Of those, the paths: a relative one in `.env` is relative to the service's working directory, the deployment folder.
const PANEL_PATH_KEYS = new Set(["PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_TRIGGERS_FILE", "PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_ENVELOPE_FILE", "PI_CONSOLE_TOKENS_FILE", "PI_GLOBAL_PI_DIR", "PI_SANDBOX_DIR", "TMPDIR", "TEMP"]);

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
    // CONCURRENTLY, sharing one budget. Serialising them doubled the worst case, so a status read against
    // an unreachable Valkey took twice as long to say the same thing.
    // The inner per-operation bound is HALVED, like `readHosts`: `readLiveHosts` walks `1 + N` operations
    // sequentially, so an inner bound equal to the outer one lets a single hung operation consume the whole
    // budget and the two timers fire together. Halved, one slow host costs half the budget rather than all
    // of it, and the walk can still finish.
    const [fleet, existing] = await Promise.all([
      withTimeout(readLiveHosts(redis, { timeoutMs: Math.max(250, Math.floor(timeoutMs / 2)) }), timeoutMs, { unreachable: "timed out reaching the registry" }),
      discoverHostQueues(redis, { timeoutMs }),
    ]);
    return { names: unionQueueNames(fleetQueueNames(fleet?.hosts), existing), blind: fleet?.unreachable ?? null, hosts: fleet?.hosts ?? [] };
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
  if (picked.urls.length > 1 && !paused) {
    return { refused: `${picked.disagreement}: resume would start jobs on one of them, so it resumes neither. Make them agree (the .env is what the service reads), or run: pi-dispatch resume --valkey-url <url>` };
  }
  return { urls: picked.urls, disagreement: picked.urls.length > 1 ? picked.disagreement : null, context };
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
      return { invalid: `${JSON.stringify(queue)} is not a queue this deployment drains (${names.join(", ")})${blind ? `; the host registry could not be read (${blind}), so a host's queue may be missing from that list` : ""}. Nothing was changed` };
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
      const count = Number(await redis.incr(key));
      if (count === 1) await redis.expire(key, DISPATCH_RUN_TTL_SECONDS);
      if (count > dispatchRunPerHour) {
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
export { BULK_MAX, enqueueParkedAnswer, enqueueRerun, enqueueSteer, planFailedBulk, planParkedAnswer, planRerun, planSteer, planSteerWithdraw, removeFailedJob, removeFailedJobs, retryFailedJob, retryFailedJobs, steerAuditTarget, steerWithdrawSentence, withdrawSteerMessage } from "./job-actions.mjs";
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
 * Returns `{ text, projects, pending? }` or `{ invalid }`. No message quotes a `name`.
 */
export function planProjectsWrite({ projectsPath, scopedLimitsPath = null, mutate, envelope = null, fs = nodeFs }) {
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
      if (removed.length > 0) return { invalid: `the scoped-limits file ${scopedLimitsPath} could not be read (${unreadableCode(raw)}), so a row naming ${removed.join(", ")} cannot be ruled out; fix it first. Nothing was written` };
    } else if (raw !== null) {
      try {
        limits = parseScopedLimits(raw, scopedLimitsPath);
      } catch (e) {
        if (removed.length > 0) return { invalid: `the scoped-limits file does not load (${e?.message ?? String(e)}), so a row naming ${removed.join(", ")} cannot be ruled out; fix it first. Nothing was written` };
        limits = [];
      }
    }
  }
  // The two files this plan was judged against, as read: `writeProjects` re-reads both right before its rename.
  const inputs = [{ path: projectsPath, text: existing }];
  if (scopedLimitsPath !== null && scopedLimitsPath !== undefined) inputs.push({ path: scopedLimitsPath, text: raw });
  // Issue #504 part C: a project removed or renamed that the allocation envelope floors would leave the envelope
  // invalid (`envelopeRefusal`), so it is refused here, before the confirm and again after it, naming the conflict.
  const broken = envelope ? envelopeRefusal({ envelopeFile: envelope.file, projectsPath, scopedLimitsPath, maxCostMicros: envelope.maxCostMicros, next: { projects: written }, fs }) : null;
  if (broken) return { invalid: broken };
  const dangling = danglingProjectRows(limits, written);
  const blocking = dangling.filter((d) => removed.includes(d.id));
  if (blocking.length > 0) {
    const rows = blocking.map((d) => `project:${d.id} (index ${d.index})`).join(", ");
    return { invalid: `${rows} in ${scopedLimitsPath} names this project, and the worker keeps its last good projects while a row names a missing one; delete or change that row first (dispatch_limit_delete or dispatch_limit_edit). Nothing was written` };
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
export function writeProjects({ projectsPath, scopedLimitsPath = null, mutate, expect = null, envelope = null, fs = nodeFs }) {
  const plan = planProjectsWrite({ projectsPath, scopedLimitsPath, mutate, envelope, fs });
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
export function envelopeRefusal({ envelopeFile, projectsPath = null, scopedLimitsPath = null, maxCostMicros = null, next = {}, fs = nodeFs }) {
  if (envelopeFile === null || envelopeFile === undefined) return null;
  const text = fileSnapshot(fs, envelopeFile);
  if (text === null || isUnreadable(text)) return null;
  const cur = envelopeContext({ projectsPath, scopedLimitsPath, fs });
  try {
    parseEnvelope(text, envelopeFile, { ...cur, maxCostMicros });
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
    if (a !== b) lines.push(`${label}: ${a} -> ${b}`);
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
    return { invalid: `could not reach Valkey to record the new envelope's digest in ${key} (${err?.message ?? String(err)}), so the file was not written: the fleet would read it as a hand edit and refuse its jobs` };
  }
  try {
    // SET with GET: the value this write REPLACED, read in the same step, so a rollback puts back what was there when
    // this writer took the key, never a value another writer has since replaced.
    let previous;
    try {
      previous = await redis.set(key, plan.digest, "GET");
    } catch (err) {
      // A SET that failed on the client side may still have been applied by the server (a timeout after the write).
      return { invalid: `could not record the new envelope's digest in ${key} (${err?.message ?? String(err)}), so the file was not written; ${key} may already hold the new digest ${plan.digest}, in which case set it back to the envelope digest the hosts run (doctor prints it) by hand (docs/allocation.md)` };
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
        return { invalid: `${replaced.invalid}; and ${key} could not be put back to ${previous ?? "absent"} (${err?.message ?? String(err)}): it may hold ${plan.digest}, a digest no file has; set it by hand (docs/allocation.md)` };
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
export async function readScopedBudget({ url, limits, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  if (!Array.isArray(limits) || limits.length === 0) return { rows: [] };
  let redis;
  try {
    parseConnection(url, { failFast: true }); // throws on junk before any client exists
    redis = redisFn(url);
    redis.on?.("error", () => {}); // a down Valkey is `{ unreachable }`, never ioredis stack traces (PR #550's review)
    const now = new Date();
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
 * -- its only precedent for touching a queue job reads ONE id off the active one, and says why. It would
 * also need a classifier, because the delayed set mixes cron next-occurrences, retry backoff, quiet hours,
 * scope deferrals and waits, and nothing in it records which. These hashes carry exactly the fields the
 * worker chose to publish: an id-only target and an operator-authored condition label, both PII-free by
 * construction, and only for jobs actually held on a wait.
 *
 * SCAN rather than an index set, because the worker deliberately keeps none: a set cannot expire its
 * members, so it would be the one structure in that keyspace that leaks permanently. Every hash carries a
 * TTL instead, which makes this read self-cleaning. Bounded by `limit` and by a COUNT hint, so a deployment
 * holding thousands never turns a panel refresh into a full keyspace walk; the caller is told when the
 * listing was truncated rather than shown a silently short list.
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
 * tool whose blast radius is "anything in the delayed set" is not the tool this description promises.
 *
 * Writes no run record: `INT-RUN-HISTORY-FILE-CONTRACT` records terminal states of runs, and a held job is in none
 * (one held again on a retry keeps the records its earlier attempts wrote; the result's `attemptsMade` says so, #477). The hold's own keys go with it, so the panel stops showing a row for a job that no longer exists.
 */
export async function cancelHeldJob({ url, jobId, redisFn = makeRedisClient, queueFn = makeQueue, timeoutMs = 2500 } = {}) {
  if (typeof jobId !== "string" || jobId === "") return { invalid: "a job id is required" };
  let redis;
  const queues = [];
  try {
    parseConnection(url, { failFast: true });
    redis = redisFn(url);
    // EVERY fleet queue (issue #642), as `pi-dispatch cancel` searches them (cancel-cli.mjs): a held job lives on the queue
    // it was enqueued onto, and a named host's cron, chained children and routed forge jobs live on `pi-jobs@<name>`.
    // Looking only in the shared queue refused every held job on a host queue as "no longer in the queue", for a job
    // the panel was showing. The first queue that knows the id owns it (ids are unique across queues by construction);
    // when none does, the shared queue answers, so the refusal keeps its words.
    const settled = (async () => {
      // Half the budget for the discovery, so the queue reads and the removal still fit inside the outer bound.
      const { names } = await readFleetQueues({ url, redisFn, timeoutMs: Math.max(250, Math.floor(timeoutMs / 2)) });
      let owner = null;
      for (const name of names) {
        const q = queueFn(parseConnection(url, { failFast: true }), { name });
        queues.push(q);
        if (owner === null && (await q.getJob(jobId))) owner = q;
        if (owner !== null) break;
      }
      // The sequence itself (hash-with-a-clock check, state check, hold keys before the job) lives in the
      // worker's cancel-state.mjs since issue #287 gave it a second caller: one body, imported rather than
      // re-implemented, which is this module's own rule for everything it shares with the worker.
      return removeHeldJob({ redis, queue: owner ?? queues[0], jobId });
    })();
    return await withTimeout(settled, timeoutMs, { invalid: "timed out reaching the queue" });
  } catch (err) {
    return { invalid: err?.message ?? String(err) };
  } finally {
    try {
      redis?.disconnect?.();
    } catch {
      // already closed
    }
    for (const queue of queues) {
      try {
        // A bullmq Queue has BOTH `disconnect` and `close`; `close` is the one that releases its blocking
        // connections, so it is named explicitly rather than reached through a `??` that short-circuits.
        await queue?.close?.();
      } catch {
        // already closed
      }
    }
  }
}

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
 * Map raw BullMQ job-scheduler entries to the PII-free display shape, computing per-entry `overdueMs`
 * against `nowMs`. Pure, so the live dashboard can map the entries it reads off its own held queue
 * without re-opening a connection per tick. A non-array input maps to an empty list.
 */
export function mapSchedulers(list, nowMs) {
  return (Array.isArray(list) ? list : []).map((s) => {
    const next = typeof s?.next === "number" ? s.next : null;
    return {
      key: s?.key ?? s?.id ?? s?.name ?? null,
      name: s?.name ?? null,
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
export async function readBudget({ url, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  let redis;
  try {
    parseConnection(url, { failFast: true }); // throws on junk before any client exists
    redis = redisFn(url);
    const settled = Promise.all([redis.get(dayKey()), redis.get(weekKey()), redis.get(monthKey()), redis.get(tokenDayKey())]).then(
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
  return { triggers, count: entries.length };
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
export function readTriggersWithInstructions({ triggersPath, fs = nodeFs }) {
  let text = null;
  const capture = { readFileSync: (p, enc) => (text = fs.readFileSync(p, enc)) };
  const view = readTriggers({ triggersPath, fs: capture });
  const instructions = {};
  if (Array.isArray(view?.triggers) && typeof text === "string") {
    const entries = JSON.parse(text).triggers;
    for (const t of view.triggers) {
      const raw = entries?.[t.index]?.run?.instructions;
      if (typeof raw === "string" && raw.trim() !== "") instructions[t.index] = raw;
    }
  }
  return { view, instructions };
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
    ...(typeof run.provider === "string" && run.provider !== "" && { provider: run.provider }),
    ...(typeof run.model === "string" && run.model !== "" && { model: run.model }),
    ...(Number.isSafeInteger(run.maxTurns) && run.maxTurns >= 1 && { maxTurns: run.maxTurns }),
    // The two spend narrowings no tool can set (issue #501, part 7): the allowed-model list (a fresh copy,
    // all strings, the loader's shape; the obligation from PR #536's review) and the per-job dollar cap, as written.
    // Shown because they decide what the trigger's jobs can reach and spend, and only the file says so. Model ids and
    // a dollar amount, the operator's own words, never a value a job chose. Spread only when present, so a trigger
    // that sets neither keeps exactly its keys.
    ...(Array.isArray(run.models) && run.models.length > 0 && run.models.every((m) => typeof m === "string") && { models: [...run.models] }),
    ...((typeof run.maxCostUsd === "string" || typeof run.maxCostUsd === "number") && { maxCostUsd: String(run.maxCostUsd) }),
    // The overlay MCP servers the jobs connect (REQ-MCP-OPERATOR-SERVERS), by name: the operator's own words, never a
    // server's definition or a credential. Shown for `secrets`' reason: what a job can reach is set only in this file.
    ...(Array.isArray(run.mcp) && run.mcp.length > 0 && run.mcp.every((name) => typeof name === "string") && { mcp: [...run.mcp] }),
  };
  switch (on.type) {
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
  return { servers, refused: (parsed.refused ?? []).map((r) => r.name).filter((n) => typeof n === "string"), unreadable: null };
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

/**
 * The held-jobs read, on the reader's own held client. A thin twin of `readHeldJobs` above -- duplicated because that
 * one opens its own connection per call, and the reader refreshes every second off one it already holds. Field-for-field
 * identical to it apart from `checks`, which no row renders. (`HELD_HYDRATE_MAX` is that reader's own ceiling.)
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
    budgetMemMiB: h?.budgetMemMiB,
    budgetCpuCenti: h?.budgetCpuCenti,
    usedMemMiB: h?.usedMemMiB,
    usedCpuCenti: h?.usedCpuCenti,
    concurrency: h?.concurrency,
    budgetRunning: h?.budgetRunning,
    waiters: h?.waiters,
    jobs: live.jobs,
    jobsMore: live.jobs === null ? more : (more ?? 0) + live.dropped,
    jobsUnreadable: h?.jobsUnreadable === true || (live.jobs === null && h?.jobs !== undefined && h?.jobs !== null && h?.jobs !== ""),
    staleMs: Number.isSafeInteger(h?.staleMs) && h.staleMs >= 0 ? h.staleMs : null,
    routes: h?.routes,
  };
}

/** How long the reader waits on the registry before drawing the fleet it last knew. */
const FLEET_READ_TIMEOUT_MS = 2_000;

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
 */
export function createFleetReader(
  paths,
  {
    makeQueueFn = makeQueue,
    parseConnectionFn = parseConnection,
    redisFn = makeRedisClient,
    readLiveHostsFn = readLiveHosts,
    discoverHostQueuesFn = discoverHostQueues,
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
  } = {},
) {
  const prune = readOnly !== true;
  const activePerQueue = Number.isSafeInteger(activeLimit) ? Math.min(Math.max(activeLimit, 1), ACTIVE_PER_QUEUE_MAX) : 1;
  const queue = makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }));
  const redis = redisFn(paths.valkeyUrl);

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
    }
    for (const name of lastNames) {
      if (!pool.has(name)) pool.set(name, makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }), { name }));
    }
    // A host that left keeps its queue open until dispose. Closing it here would race a pause already in flight
    // against it, and an idle BullMQ Queue costs one connection -- cheaper than that race.
    return lastNames.map((n) => pool.get(n));
  };

  // The KILL SWITCH's set, which is not the per-tick set. A registry row is a lease that expires ninety seconds after a
  // host stops writing, while that host's queue and its paused flag are permanent -- so pausing off the registry alone
  // misses a host that has gone quiet but is still draining, and resuming off it leaves that host's queue paused
  // forever with nothing able to name it. The union adds a SCAN of BullMQ's own meta keys, which is far too expensive
  // for a reader that runs every second and entirely affordable for a keypress.
  const killSwitchQueues = async () => {
    const existing = await discoverHostQueuesFn(redis, { timeoutMs: FLEET_READ_TIMEOUT_MS });
    for (const name of unionQueueNames(lastNames, existing)) {
      if (!pool.has(name)) pool.set(name, makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }), { name }));
    }
    return unionQueueNames(lastNames, existing).map((n) => pool.get(n));
  };

  // Flip every kill-switch queue on THIS reader's Valkey through the held pool, `setQueuePaused`'s result shape.
  const poolSet = async (paused) => {
    await fleetQueues(); // refresh `lastNames` from the registry before unioning the keyspace onto it
    const done = [];
    for (const q of await killSwitchQueues()) {
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
  const wideRuns = async () => {
    const at = nowFn();
    if (wide && at >= wide.at && at - wide.at < DOLLAR_RECORDS_TTL_MS) return wide;
    const local = localIndex.records();
    const { runs: mirrored, degraded } = await readMirroredRuns(redis, { limit: WIDE_RUNS, prune: false, timeoutMs: FLEET_READ_TIMEOUT_MS });
    const runs = mergeRuns(Array.isArray(local?.records) ? local.records : [], mirrored, { limit: WIDE_RUNS });
    // Either side unread makes the window partial: a parked run on that side would be missing without a word.
    const partial = local?.unreachable ?? (typeof degraded === "string" && degraded.startsWith("unreachable") ? "the run mirror could not be read" : null);
    wide = { at, runs, mirror: degraded, partial };
    return wide;
  };

  return {
    async snapshot() {
      const queues = await fleetQueues();
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
      const { view: triggersView, instructions: triggerInstructions } = readTriggersWithInstructions({ triggersPath: paths.triggersPath });
      const cronIds = Array.isArray(triggersView?.triggers)
        ? triggersView.triggers.filter((t) => t?.type === "cron" && typeof t?.id === "string" && t.id !== "").map((t) => t.id)
        : [];
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
        cronIds.length > 0 ? redis.mget(...cronIds.map((id) => stallKey(id))).catch(() => []) : Promise.resolve([]),
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
      for (const h of lastHosts) for (const j of parseLiveJobs(h?.jobs).jobs ?? []) if (typeof h?.name === "string") hostOfJob.set(j.id, h.name);
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
            host: hostOfJob.get(String(j?.id)) ?? null,
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
          failures24h: w.runs.filter((r) => r?.outcome === "failed" && runAt(r) >= nowMs - DAY_MS && runAt(r) <= nowMs).length,
          // A floor when the window ended before the day did: every one of WIDE_RUNS runs is inside the day.
          failures24hFloor: w.runs.length >= WIDE_RUNS && runAt(w.runs[w.runs.length - 1]) >= nowMs - DAY_MS,
          parkedUnreachable: w.partial ? scrubReason(w.partial) : null,
        }),
        // An empty `parked` alone would read as "nobody is waiting"; `parkedUnreachable` says the list is not known.
        (err) => ({ parked: [], failures24h: null, failures24hFloor: false, parkedUnreachable: scrubReason(err?.message ?? String(err)) || "the runs could not be read" }),
      );

      const progressGot = await progressRead;
      active.forEach((row, i) => {
        row.progress = runIds[i] === null ? null : activeProgressOf(progressGot.byId?.[runIds[i]]);
      });
      const inboxGot = await inboxRead;
      steerRows.forEach(({ row }, i) => {
        row.steer = true;
        // null: past the per-tick bound, or unreadable this tick. Never `[]`, which would say "no message".
        row.inbox = Array.isArray(inboxGot[i]?.entries) ? inboxGot[i].entries.map(publicInboxEntry) : null;
      });

      return {
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
        budget: { day: Number(dayRaw ?? 0), week: Number(weekRaw ?? 0), month: Number(monthRaw ?? 0), tokensToday: Number(tokenRaw ?? 0) },
        schedulers: mapSchedulers(schedulerList, Date.now()),
        // Rebuilt into the `{ id -> count }` shape the drill-in and the LIST badge already index by, so neither reader
        // changes.
        schedulerStalls: Object.fromEntries(cronIds.map((id, i) => [id, Number(stallCounts?.[i] ?? 0) || 0])),
        schedulerStallMax: paths.schedulerStallMax,
        // Merged across the fleet (issue #57, Gap 3). This host's files stay the truth and the single-host path; the
        // mirror adds the other hosts' records. On a shared `PI_LOGS_DIR` the local read is already the merged read and
        // the mirror adds nothing, which is why there is no second code path.
        runs: merged.runs,
        runHosts: merged.hosts,
        runMirror: merged.mirror,
        settings,
        triggers: triggersView,
        triggerInstructions,
        pauseWindows: readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath }),
        // The projects as the WORKER reads them (issue #499 part C): `{ unset }` when PI_PROJECTS_FILE is unset.
        projects: readProjects({ projectsPath: paths.projectsFile }),
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
        failures24hFloor: fold.failures24hFloor,
      };
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
    async cancelActive({ jobId }) {
      // The CLI's channel, byte for byte (issue #287, worker/src/cancel-state.mjs): a request key the owning worker
      // answers, carried on the reader's own held client -- `cancelJob` lives in the worker process and nothing here
      // can raise it directly.
      return requestCancel({ redis, jobId });
    },
    async dispose() {
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
export async function readRunsPage(redis, { logsDir, before = null, limit = 50, filter = null, fs = nodeFs, now = () => Date.now(), timeoutMs = 2500, localIndex = null, examineMax = RUNS_PAGE_EXAMINE_MAX } = {}) {
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
    const matched = filter ? final.filter((r) => runMatches(r, filter)) : final;
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
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * One run by its job id (issue #641): `{ record, source }` with `source` "local" or "mirror", `{ missing: true }`, or
 * `{ invalid }` for an id outside the charset (checked FIRST, before any path or key is built from it). This host's file
 * first, because the file is the record and the mirror a view of it; then the mirror's by-id GET, the one the lost-lock
 * check already uses. A mirrored value that is not a record is reported missing, never shown.
 */
export async function readRunById(redis, { logsDir, jobId, fs = nodeFs, timeoutMs = 2500 } = {}) {
  if (typeof jobId !== "string" || !RUN_ID_RE.test(jobId)) return { invalid: "a run id is letters, digits and . _ : -, at most 200 characters" };
  const local = readRun({ logsDir, jobId, fs });
  if (local && typeof local === "object" && !Array.isArray(local)) return { record: local, source: "local" };
  if (!redis) return { missing: true };
  const mirrored = await readMirroredRecord(redis, sanitizeJobId(jobId), { timeoutMs });
  if (mirrored && typeof mirrored === "object" && mirrored !== UNREADABLE_RECORD && !Array.isArray(mirrored)) return { record: mirrored, source: "mirror" };
  return { missing: true };
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

/**
 * A parked run's session key, re-derived the way the worker derives it (`sessionKeyFor`, DES-SESSION-KEY-IS-DERIVED-
 * NOT-INDEXED): a forge ISSUE from kind + repo + its number, a cron run from its scheduler id. Null where the record
 * cannot say: a pull or merge request's key needs its head ref, which the record deliberately does not carry.
 */
function parkedSessionKey(record) {
  const kind = record?.kind;
  if (kind === "local") {
    const m = typeof record?.jobId === "string" ? /^(?:repeat|manual):(.+):\d+$/.exec(record.jobId) : null;
    return m ? sessionKeyFor({ kind: "local", trigger: { id: m[1] } }) : null;
  }
  if (!isForgeKind(kind) || typeof record?.target !== "string") return null;
  const m = /^(.+)#(\d+)$/.exec(record.target);
  if (!m) return null;
  // `#` is the issue separator on every forge; GitHub and Forgejo also spell a pull request with it, and only the
  // trigger type can say which (a `pull_request` trigger); a comment on a pull request stays ambiguous, so a key that
  // names no directory reads as unknown below, never as a chain of zero.
  if (record.triggerType === "pull_request") return null;
  return sessionKeyFor({ kind, repo: m[1], target: { type: "issue", number: Number(m[2]) } });
}

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
 * `awaiting-input` asked a person a question. `[{ target, kind, jobId, parkedAt, ageMs, answered, chainCount }]`, newest
 * first. PURE over the runs it is handed, apart from the optional session-store read.
 *
 * `answered` is the rule the processor implies and nothing records: a LATER run on the same kind + target (an answer is
 * a new delivery on the same issue, which resumes the parked transcript). `chainCount` is the session store's
 * `resume-chain` counter for the run's re-derived key when `sessionsDir` is on this host and the key has a directory,
 * else null ("unknown"), never 0 for a store this host cannot see. `unansweredOnly` drops the answered runs BEFORE that
 * read, so a caller that shows only the waiting ones (the fleet reader) pays no fs call for a run nobody waits on.
 */
export function readParkedRuns({ runs, now = Date.now(), sessionsDir = null, fs = nodeFs, unansweredOnly = false } = {}) {
  const list = Array.isArray(runs) ? runs.filter((r) => r && typeof r === "object") : [];
  const nowMs = typeof now === "function" ? now() : now;
  const latest = new Map(); // kind + target -> the newest run's instant
  for (const r of list) {
    if (typeof r.target !== "string" || typeof r.kind !== "string") continue;
    const k = `${r.kind}\u0000${r.target}`;
    const at = runAt(r);
    if (!latest.has(k) || at > latest.get(k)) latest.set(k, at);
  }
  const out = [];
  for (const r of list) {
    if (r.outcome !== "completed" || r.reason !== "awaiting-input") continue;
    const at = runAt(r);
    const known = typeof r.target === "string" && typeof r.kind === "string";
    const answered = known && Number.isFinite(at) && latest.get(`${r.kind}\u0000${r.target}`) > at;
    if (answered && unansweredOnly) continue;
    out.push({
      target: typeof r.target === "string" ? r.target : null,
      kind: typeof r.kind === "string" ? r.kind : null,
      jobId: r.jobId ?? null,
      parkedAt: Number.isFinite(at) ? at : null,
      ageMs: Number.isFinite(at) && Number.isFinite(nowMs) ? Math.max(0, nowMs - at) : null,
      answered,
      chainCount: readChainCount(sessionsDir, parkedSessionKey(r), fs),
    });
  }
  out.sort((a, b) => (b.parkedAt ?? -Infinity) - (a.parkedAt ?? -Infinity));
  return out;
}

/** The secret profiles' NAMES in a settings view (`readSettingsView`), sorted; never a resolver path. */
export function secretProfileNames(settingsView) {
  const profiles = settingsView?.overlay?.secretProfiles;
  if (profiles === null || typeof profiles !== "object" || Array.isArray(profiles)) return [];
  // The worker's profile-name charset (secret-profiles.mjs): a key outside it is not a profile the worker loads.
  return Object.keys(profiles).filter((n) => /^[A-Za-z0-9._-]{1,64}$/.test(n)).sort();
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
