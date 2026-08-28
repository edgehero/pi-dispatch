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
import { join, delimiter, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultLogsDir, defaultSandboxDir, defaultGraphDir, CHAIN_DEPTH_MAX_DEFAULT, CHAIN_MAX_PER_JOB_DEFAULT } from "@edgehero/pi-dispatch/config";
import { settingsFilePath, readOverlay, writeOverlay, KNOWN_KEYS } from "@edgehero/pi-dispatch/runtime-settings";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { dayKey, weekKey, monthKey, tokenDayKey } from "@edgehero/pi-dispatch/budget";
import { parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
// The subscriptions validator is shared for the same anti-drift reason: the admin prices finished runs
// against the exact schema the file declares, and re-deriving it here is how the two would disagree.
import { parseSubscriptions, SUBSCRIPTIONS_VERSION } from "@edgehero/pi-dispatch/subscriptions";
import { parseConnection, makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { makeQueue, enqueueLocalJob } from "@edgehero/pi-dispatch/queue";
import { readFlowGate, aiTriggerAllows, SKILL_NAME_RE } from "@edgehero/pi-dispatch/flow-gate";
import { gitDirty } from "@edgehero/pi-dispatch/git-dirty";
import { readStageManifest, readStagedSkills } from "@edgehero/pi-dispatch/packages";
// The skill enumeration reuses the worker's OWN listing parsers (issue #54), the same anti-drift rule
// as parseTriggers/readOverlay above: selectEntries keeps only regular blobs at allowed paths, and
// keepOnlyDeclaredSkills drops a subtree that declares no SKILL.md -- re-deriving either here is how
// the graph would show a skill the job path can never materialise.
import { selectEntries, keepOnlyDeclaredSkills } from "@edgehero/pi-dispatch/materialize";
import { isForgeKind } from "@edgehero/pi-dispatch/forges";
// The two pure text scanners live in graph-model.mjs (the pure side of the graph feature); this module
// supplies them bytes, never the other way around -- the dependency points read-model -> graph-model.
import { parseSkillMeta, findSiblingMentions, findLoopHints, triggerMatchLabel } from "./graph-model.mjs";
import { repoOfTarget } from "./costs.mjs";

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
    logsDir: env.PI_LOGS_DIR || defaultLogsDir(),
    settingsFile: settingsFilePath(env),
    // Cwd defaults match what `pi-dispatch init` scaffolds (and, since issue #80, what the receiver
    // reads), so a deployment folder works without env wiring when pi is launched from it. The old
    // `deploy/…` defaults pointed at the repo's committed EXAMPLE files — right only from a checkout
    // root, and silently wrong (demo triggers) everywhere else.
    triggersPath: env.PI_TRIGGERS_FILE ?? "./triggers.json",
    pauseWindowsPath: env.PI_PAUSE_WINDOWS_FILE ?? "./pause-windows.json",
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
    // Where the graph HTML artifact lands (issue #54): the worker's own temp-dir default, imported
    // like defaultLogsDir/defaultSandboxDir above, so the admin and any future worker consumer agree
    // on the path without loadConfig. Deliberately NOT logsDir -- that directory's filename shape is
    // contract (INT-RUN-HISTORY-FILE-CONTRACT).
    graphDir: env.PI_GRAPH_DIR || defaultGraphDir(env),
  };
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
export async function readQueueState({ url, makeQueueFn = makeQueue, parseConnectionFn = parseConnection } = {}) {
  let queue;
  try {
    queue = makeQueueFn(parseConnectionFn(url, { failFast: true }));
    const pausedState = await queue.isPaused();
    const counts = await queue.getJobCounts("waiting", "active", "paused", "delayed", "failed");
    const workers = await readWorkerCount(queue);
    return { pausedState, counts, workers };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
  }
}

/**
 * Set the queue's durable paused state through one failFast Queue, always closed. `pause()`/`resume()`
 * mirror the CLI kill switch (cli.mjs:90-95): the state survives a worker restart. Returns
 * `{ ok: true, paused }` on success, or `{ unreachable }` on a connection error, closing in `finally`.
 */
export async function setQueuePaused({ url, paused, makeQueueFn = makeQueue, parseConnectionFn = parseConnection } = {}) {
  let queue;
  try {
    queue = makeQueueFn(parseConnectionFn(url, { failFast: true }));
    if (paused) await queue.pause();
    else await queue.resume();
    return { ok: true, paused };
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
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
export function revParseHead(folder, { exec = execFileSync } = {}) {
  try {
    const out = exec("git", ["-C", folder, "rev-parse", "HEAD"], { encoding: "utf8" });
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

  // 3. dirty-tree, no force (BOTH paths). A local run edits the folder in place with no undo.
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
    queue = makeQueueFn(parseConnectionFn(valkeyUrl, { failFast: true }));
    const jobId = await enqueueLocalJob(queue, { folder, flow, task });
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
 * Read-modify-write the settings overlay: read the current file, apply `mutate` to a copy of the base
 * overlay, and write the result through the worker's own atomic `writeOverlay`. When the existing file is
 * invalid, the base is empty `{}` and `rebuiltFrom` carries the read reason so the caller can surface the
 * loud repair notice (INT-CONFIG-OVERLAY-CONTRACT write protocol). Validation stays in `writeOverlay`; a
 * rejected candidate returns `{ invalid }`. Returns `{ ok: true, overlay, rebuiltFrom? }`.
 */
export function writeSettings({ settingsFile, mutate, fs = nodeFs }) {
  const res = readOverlay(settingsFile, { fs });
  const base = res.overlay ?? {};
  const next = mutate({ ...base });
  const w = writeOverlay(settingsFile, next, { fs });
  if (w.invalid) return { invalid: w.invalid };
  return res.invalid ? { ok: true, overlay: next, rebuiltFrom: res.invalid } : { ok: true, overlay: next };
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
 */
export function writePauseWindows({ pauseWindowsPath, mutate, fs = nodeFs }) {
  let current = [];
  try {
    const raw = JSON.parse(fs.readFileSync(pauseWindowsPath, "utf8"));
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
  const tmp = `${pauseWindowsPath}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, pauseWindowsPath);
  return { ok: true };
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
  now = Date.now,
} = {}) {
  let queue;
  try {
    queue = makeQueueFn(parseConnectionFn(url, { failFast: true }));
    const list = await queue.getJobSchedulers(0, -1, true);
    return mapSchedulers(list, now());
  } catch (err) {
    return { unreachable: err?.message ?? String(err) };
  } finally {
    if (queue) await queue.close().catch(() => {});
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

/** Read one run record by (raw) job id via its sanitized filename, or `null` when absent/unreadable. */
export function readRun({ logsDir, jobId, fs = nodeFs }) {
  return readJsonFile(join(logsDir, `${sanitizeJobId(jobId)}.json`), fs);
}

/**
 * Read the tail of a job's raw `.log`. Returns `{ lines }` or `{ missing: true }` when capture is off or
 * the file is absent -- an ENOENT is the normal "no captured log" case and never throws. The caller shows
 * these lines ONLY in the overlay viewer; they are never rendered into or sent to model context.
 */
export function readLogTail({ logsDir, jobId, lines = 200, fs = nodeFs }) {
  let text;
  try {
    text = fs.readFileSync(join(logsDir, `${sanitizeJobId(jobId)}.log`), "utf8");
  } catch {
    return { missing: true };
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
        packages,
        image,
        skillsDir,
        instructions,
        resume,
        secrets,
        secretsProfile,
      };
    case "label":
      return { type: "label", any: normalizeSelector(on.any), all: normalizeSelector(on.all), none: normalizeSelector(on.none), flow, command, packages, image, skillsDir, instructions, resume, secrets, secretsProfile, replicas, forge };
    case "comment":
      return { type: "comment", phrase: typeof on.phrase === "string" ? on.phrase : null, flow, command, packages, image, skillsDir, instructions, resume, secrets, secretsProfile, replicas, forge };
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
        packages,
        image,
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
        packages,
        image,
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
 * The join is the RAW jobId (`repeat:<id>:<millis>`, INT-RUN-HISTORY-FILE-CONTRACT keeps it raw in
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
    const re = new RegExp(`^repeat:${escapeRegExp(id)}:(\\d+)$`);
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
 * `repeat:<id>:<millis>` jobId grammar (cronRunStats above) are never re-derived by a second module;
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
    .map((t) => ({ t, re: new RegExp(`^repeat:${escapeRegExp(t.id)}:(\\d+)$`) }));
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
    // Hardening flags mirror materialize.mjs defaultGit -- keep in sync: no hooks, no fsmonitor, no
    // pager, so a hostile repo config cannot run code or corrupt output during a read.
    listing = exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-pager", "-C", folder, "ls-tree", "-r", "-l", "-z", head, ".pi/"],
      { encoding: "utf8", maxBuffer: GRAPH_LS_TREE_MAX_BYTES },
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
        ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "--no-pager", "-C", folder, "cat-file", "blob", entry.oid],
        { maxBuffer: GRAPH_LIMITS.maxSkillBytes },
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
