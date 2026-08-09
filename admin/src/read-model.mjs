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
import { defaultLogsDir, defaultSandboxDir } from "@edgehero/pi-dispatch/config";
import { settingsFilePath, readOverlay, writeOverlay, KNOWN_KEYS } from "@edgehero/pi-dispatch/runtime-settings";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { dayKey, weekKey, monthKey } from "@edgehero/pi-dispatch/budget";
import { parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { parsePauseWindows } from "@edgehero/pi-dispatch/pause-windows";
// The subscriptions validator is shared for the same anti-drift reason: the admin prices finished runs
// against the exact schema the file declares, and re-deriving it here is how the two would disagree.
import { parseSubscriptions, SUBSCRIPTIONS_VERSION } from "@edgehero/pi-dispatch/subscriptions";
import { parseConnection, makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { makeQueue, enqueueLocalJob } from "@edgehero/pi-dispatch/queue";
import { readFlowGate } from "@edgehero/pi-dispatch/flow-gate";
import { gitDirty } from "@edgehero/pi-dispatch/git-dirty";
import { readStageManifest } from "@edgehero/pi-dispatch/packages";

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
 * Read-modify-write the unified triggers.json. `mutate(entries)` receives a copy of the current raw
 * `{ on, run }` entry array and returns the new array; the result is re-serialized to the
 * `{ triggers: [...] }` file shape, VALIDATED through the SHARED `parseTriggers` (fail-closed -- an invalid
 * result is NEVER written, so the worker/receiver loaders can always parse the file), and written
 * ATOMICALLY (tmp + rename), so a live-reload watcher never observes a half-written file.
 *
 * Human-approved writes only: reached from the operator-typed `/dispatch trigger …` handlers AND from the
 * `dispatch_trigger_*` LLM tools, but the tools route through `confirmedWrite`, which requires an operator to
 * approve a confirm dialog before this runs. The human keypress is the approval, so CONST-TRIGGER-AUTHOR-GATE's
 * principle holds either way. A missing or unparseable existing file starts from an empty set; the validated
 * write repairs it. Returns `{ ok: true }` or `{ invalid }` with the parser's reason.
 */
export function writeTriggers({ triggersPath, mutate, fs = nodeFs }) {
  let current = [];
  try {
    const raw = JSON.parse(fs.readFileSync(triggersPath, "utf8"));
    if (Array.isArray(raw?.triggers)) current = raw.triggers;
  } catch {
    // Missing/invalid file: start from empty; the validated atomic write below repairs it.
  }
  const next = mutate(current.map((t) => ({ ...t })));
  const text = `${JSON.stringify({ triggers: next }, null, 2)}\n`;
  try {
    parseTriggers(text, triggersPath); // the loaders' own validator -- never write a file they would reject
  } catch (e) {
    return { invalid: e?.message ?? String(e) };
  }
  const tmp = `${triggersPath}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, triggersPath);
  return { ok: true };
}

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
 * Read the reserved counts for all three spend windows with plain, side-effect-free GETs of the worker's own
 * `dayKey()` / `weekKey()` / `monthKey()` -- NEVER an INCR/EXPIRE, so observing the budget cannot consume a
 * slot. Returns `{ day, week, month }` reserved counts (the caps live in the settings overlay, resolved by
 * the renderer). `makeRedisClient` has no failFast option and would otherwise buffer the GETs forever while
 * disconnected, so the read is bounded by a timeout that degrades to `{ unreachable }`; the client is
 * force-disconnected in `finally`.
 */
export async function readBudget({ url, redisFn = makeRedisClient, timeoutMs = 2500 } = {}) {
  let redis;
  try {
    redis = redisFn(url);
    const settled = Promise.all([redis.get(dayKey()), redis.get(weekKey()), redis.get(monthKey())]).then(
      ([day, week, month]) => ({ day: Number(day ?? 0), week: Number(week ?? 0), month: Number(month ?? 0) }),
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
  const all = text.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop(); // drop the trailing-newline empty segment
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
 * discriminated on `on.type` (cron | label | comment | pull_request). Missing selectors default to `[]`
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
  for (const entry of entries) {
    const display = normalizeTriggerForDisplay(entry);
    if (display) triggers.push(display);
  }
  return { triggers };
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
 * `image` -- the trigger's own container image (INT-TRIGGERS-FILE-CONTRACT, issue #41) -- is carried on all
 * four kinds for the same reason and shown for a sharper one: which image a job runs IS which code it runs
 * (the pi version, the runner, the guardrail floor and the loader posture all come from it). `null` is the
 * default-image sentinel, matching this function's own `flow`/`model`/`phrase` convention, and anything that
 * is not a non-empty string reads as the default -- mirroring the worker's `job.image ?? config.jobImage`
 * rather than re-validating a value the loader already refused.
 *
 * `forge` -- which forge a webhook trigger listens to (issue #42) -- is carried on the three webhook kinds
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
  const packages = run.packages !== false;
  const image = typeof run.image === "string" && run.image.trim() !== "" ? run.image : null;
  // The trigger's injected skills dir (REQ-PER-TRIGGER-SKILLS, issue #60). Carried on all four kinds like
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
  switch (on.type) {
    case "cron":
      return {
        type: "cron",
        id: typeof on.id === "string" ? on.id : null,
        pattern: typeof on.pattern === "string" ? on.pattern : null,
        folder: typeof run.folder === "string" ? run.folder : null,
        flow,
        // Optional per-cron model override (passthrough into job.data); null when the entry resolves the
        // deployment default. Surfaced so the drill-in shows which schedules pin their own model.
        model: typeof run.model === "string" ? run.model : null,
        packages,
        image,
        skillsDir,
        instructions,
        resume,
      };
    case "label":
      return { type: "label", any: normalizeSelector(on.any), all: normalizeSelector(on.all), none: normalizeSelector(on.none), flow, packages, image, skillsDir, instructions, resume, replicas, forge };
    case "comment":
      return { type: "comment", phrase: typeof on.phrase === "string" ? on.phrase : null, flow, packages, image, skillsDir, instructions, resume, replicas, forge };
    case "pull_request":
      return {
        type: "pull_request",
        action: normalizeSelector(on.action),
        any: normalizeSelector(on.any),
        all: normalizeSelector(on.all),
        none: normalizeSelector(on.none),
        flow,
        packages,
        image,
        skillsDir,
        instructions,
        resume,
        replicas,
        forge,
      };
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
