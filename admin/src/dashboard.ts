/**
 * The live `/dispatch` dashboard overlay: a self-refreshing TUI panel over the same read-model the slash
 * commands use. It holds ONE queue and ONE redis client for its whole lifetime and polls them on a fixed
 * interval -- the self-closing read-model wrappers are one-shots for a single command, so a per-second
 * tick through them would open and drop a connection every second.
 *
 * The render never blocks on I/O: a background fetch writes the latest snapshot and the component always
 * renders the last one, so a slow or unreachable queue degrades the panel rather than freezing it. A
 * fetch already in flight suppresses the next tick's fetch, so a stall cannot stack overlapping reads.
 *
 * The in-component views sharing this one overlay: LIST -- a framed panel of status, spend, the unified
 * TRIGGERS pane and an interactive runs list; RUN_DETAIL -- a drill-in of one run's PII-free `.json`
 * fields; LIVE_TAIL -- a tail of a running job's `.log`; and TRIGGER_DETAIL -- one trigger's trust
 * model. Analytics live on the insights page (issue #181): the `i` key writes and opens it.
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): LIST and RUN_DETAIL surface only
 * PII-free run records, counts, budget, schedulers and the settings overlay. LIVE_TAIL renders tail bytes
 * obtained through the injected `tailLog` seam whose `fs` access lives in index.ts, so this module never
 * touches the filesystem -- the bytes reach the overlay alone, never `snapshot`, never a shared renderer,
 * never a message.
 */
import { dayKey, weekKey, monthKey, tokenDayKey, windowState } from "@edgehero/pi-dispatch/budget";
import { parseConnection, makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { makeQueue, fleetQueueNames, discoverHostQueues, unionQueueNames } from "@edgehero/pi-dispatch/queue";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";
import { stallKey } from "@edgehero/pi-dispatch/scheduler-stall-guard";
import { windowEndAt } from "@edgehero/pi-dispatch/pause-windows";
import { listRuns, mergedRunsOn, readSettingsView, mapSchedulers, readTriggers, readPauseWindows, readScopedLimits, readStagedPackages } from "./read-model.mjs";
import { scopeKeyPrefix } from "@edgehero/pi-dispatch/scoped-limits";
import { renderStatus, renderBudget, renderHeldJobs, renderScopedLimits, renderTriggers, renderSettingsView, commandSlashLabel } from "./render.mjs";
import { matchesKey } from "./keys.mjs";
import { box, meter, clip, makeLineInput } from "./panel.mjs";
import { makeStyler, frame, RULE } from "./style.mjs";

const KEY_HINTS = "[p]ause  [r]esume  [q]uit";
// Fetch the read-model's full window (listRuns clamps at 50) but render a cursor-following viewport of
// RUNS_VIEWPORT rows -- runs 11..50 must be reachable without the frame growing 40 rows taller.
const RUNS_ON_DASHBOARD = 50;
const RUNS_VIEWPORT = 10;
// The runs-list orderings `o` cycles through. "time" is listRuns' own endedAt-descending order; the other
// three re-sort the records already in the snapshot and never re-read.
const RUN_SORTS = ["time", "tokens", "cost", "outcome"];
const REFRESH_MS = 1000;
// Lines requested per tail fetch, and the on-screen window of them the LIVE_TAIL view scrolls through.
const TAIL_LINES = 200;
const TAIL_VIEWPORT = 20;
// panel.mjs floors a box to this width; below it (or a missing/non-finite width) the panel degrades to
// unframed plain lines rather than a ragged or over-width frame.
const MIN_WIDTH = 8;
// Drill-in views (TRIGGER_DETAIL, RUN_DETAIL) are small; they frame to a compact width and center within
// the wider overlay rather than stretching a handful of key/value lines across the full LIST width.
const DRILL_WIDTH = 70;

/** Left-pad each line to center a `blockWidth`-wide frame within the `overlayWidth` overlay. */
function centerBlock(lines: string[], overlayWidth: number, blockWidth: number): string[] {
  const pad = Math.max(0, Math.floor((overlayWidth - blockWidth) / 2));
  if (pad === 0) return lines;
  const prefix = " ".repeat(pad);
  return lines.map((l) => prefix + l);
}

/**
 * Build the read/act/close deps for a live dashboard from resolved paths: ONE failFast queue and ONE
 * redis client, both created here and closed once in `dispose`. `fetchSnapshot` reads the whole panel in
 * one pass off those held connections; `pause`/`resume` flip the durable paused state on the same queue.
 * `getWorkers` is EMPTY on Redis providers without CLIENT SETNAME, so an error or empty list degrades to
 * "unknown" rather than reporting zero live workers.
 */
/** How many held rows the panel will hold at once. The section shows fewer; the rest are counted, not lost. */
const HELD_LIMIT = 20;

/** The hydration ceiling, matching read-model.mjs: past it the count is a floor and the caller says so. */
const HELD_HYDRATE_MAX = 200;

/**
 * The held-jobs read, on the panel's own held client. A thin twin of `read-model.mjs`'s `readHeldJobs` --
 * duplicated for the reason `readScopedBudget` is duplicated here: that module opens its own connection per
 * call, and the panel refreshes every second off one it already holds. Field-for-field identical to it
 * apart from `checks`, which no row renders.
 */
async function heldJobs(redis: any) {
  const ids: string[] = await redis.smembers("wait:held");
  const at = Date.now();
  const hydrated = await Promise.all(
    ids.slice(0, HELD_HYDRATE_MAX).map(async (jobId: string) => {
      try {
        const h = await redis.hgetall(`wait:job:${jobId}`);
        if (!h || !h.since) {
          // Stale index member: prune as we go, which is what makes an index safe when a SET cannot expire.
          await redis.srem("wait:held", jobId).catch(() => {});
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
  const rows = hydrated.filter(Boolean) as any[];
  rows.sort((a: any, b: any) => (b.waitedMs ?? -1) - (a.waitedMs ?? -1));
  return { rows: rows.slice(0, HELD_LIMIT), more: Math.max(0, rows.length - HELD_LIMIT), truncated: ids.length > HELD_HYDRATE_MAX };
}

/** How long the panel waits on the registry before drawing the fleet it last knew. */
const FLEET_READ_TIMEOUT_MS = 2_000;

/**
 * The panel's REAL plumbing. Every module-level dependency it uses to talk to Valkey is injectable through
 * the second parameter, defaulting to the real one, because this factory had no test at all -- and that is
 * exactly how it came to build its own single queue and do its own pausing while the fleet-aware readers
 * sat unused beside it. The panel's kill switch is the last place a silent no-op should be able to hide.
 */
export function createDashboardDeps(
  paths: any,
  {
    makeQueueFn = makeQueue,
    parseConnectionFn = parseConnection,
    redisFn = makeRedisClient,
    readLiveHostsFn = readLiveHosts,
    discoverHostQueuesFn = discoverHostQueues,
  }: any = {},
) {
  const queue = makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }));
  const redis = redisFn(paths.valkeyUrl);

  // EVERY named host drains a queue of its own, so the four things this panel does with a queue -- count,
  // list schedulers, pause, resume -- have to span them. Doing it here rather than through read-model's
  // fleet-aware readers because this panel is connection-first: it holds its clients for the life of the
  // overlay and a per-tick open/close of N queues is the quiet load a dashboard must not add.
  const pool = new Map<string, any>([[queue.name, queue]]);
  // The last set we successfully resolved. On an unreachable registry the fleet does NOT shrink to the
  // shared queue: that would silently pause half a deployment and print success, which is the failure this
  // whole surface exists to prevent. We keep what we last saw and mark the snapshot degraded instead.
  let lastNames: string[] = [queue.name];
  let fleetDegraded: string | null = null;

  const fleetQueues = async () => {
    const fleet: any = await readLiveHostsFn(redis, { timeoutMs: FLEET_READ_TIMEOUT_MS }).catch((err: any) => ({
      unreachable: err?.message ?? String(err),
    }));
    if (fleet?.unreachable || !Array.isArray(fleet?.hosts)) {
      fleetDegraded = fleet?.unreachable ?? "registry unreadable";
    } else {
      fleetDegraded = null;
      lastNames = fleetQueueNames(fleet.hosts);
    }
    for (const name of lastNames) {
      if (!pool.has(name)) pool.set(name, makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }), { name }));
    }
    // A host that left keeps its queue open until dispose. Closing it here would race a pause already in
    // flight against it, and an idle BullMQ Queue costs one connection -- cheaper than that race.
    return lastNames.map((n) => pool.get(n));
  };

  // The KILL SWITCH's set, which is not the per-tick set. A registry row is a lease that expires ninety
  // seconds after a host stops writing, while that host's queue and its paused flag are permanent -- so
  // pausing off the registry alone misses a host that has gone quiet but is still draining, and resuming
  // off it leaves that host's queue paused forever with nothing able to name it. The union adds a SCAN of
  // BullMQ's own meta keys, which is far too expensive for a reader that runs every second and entirely
  // affordable for a keypress.
  const killSwitchQueues = async () => {
    const existing = await discoverHostQueuesFn(redis, { timeoutMs: FLEET_READ_TIMEOUT_MS });
    for (const name of unionQueueNames(lastNames, existing)) {
      if (!pool.has(name)) pool.set(name, makeQueueFn(parseConnectionFn(paths.valkeyUrl, { failFast: true }), { name }));
    }
    return unionQueueNames(lastNames, existing).map((n) => pool.get(n));
  };

  return {
    async fetchSnapshot() {
      const queues = await fleetQueues();
      // Awaited alongside the queue reads rather than before them: it is two Valkey round trips and the
      // panel already pays for several, so it costs no extra tick.
      const merged = await mergedRunsOn(redis, { logsDir: paths.logsDir, limit: RUNS_ON_DASHBOARD }).catch(() => ({ runs: [], hosts: [], mirror: "off" }));
      // The cron ids this deployment declares, read from the triggers file the same tick already reads
      // SYNCHRONOUSLY. Since issue #267 each scheduler's stall count is its own key, so the reader has to
      // name them -- and naming them from config is the repo's own doctrine for exactly this shape
      // (`scoped-limits.json` enumerates every scope that can carry a claim; `no KEYS, no SCAN, and no index
      // set to leak`). A keyspace scan was measured and refused for `wait:held` and `host:h:*` because the
      // panel reads every second and a scan walks hardest when nothing is registered.
      const triggersView: any = readTriggers({ triggersPath: paths.triggersPath });
      const cronIds: string[] = Array.isArray(triggersView?.triggers)
        ? triggersView.triggers.filter((t: any) => t?.type === "cron" && typeof t?.id === "string" && t.id !== "").map((t: any) => t.id)
        : [];
      const [pausedStates, countsPer, workerList, dayRaw, weekRaw, monthRaw, tokenRaw, schedulerLists, activeLists, stallCounts] = await Promise.all([
        Promise.all(queues.map((q: any) => q.isPaused())),
        Promise.all(queues.map((q: any) => q.getJobCounts("waiting", "active", "paused", "delayed", "failed"))),
        queue.getWorkers().catch(() => []),
        redis.get(dayKey()),
        redis.get(weekKey()),
        redis.get(monthKey()),
        redis.get(tokenDayKey()), // issue #25 daily token spend (budget:t:YYYY-MM-DD)
        // The shared queue's failure is UNCAUGHT (the panel must not draw a scheduler list it could not
        // read), a host queue's is caught: one unreachable host degrades one host's triggers, never the view.
        Promise.all(queues.map((q: any, i: number) => (i === 0 ? q.getJobSchedulers(0, -1, true) : q.getJobSchedulers(0, -1, true).catch(() => [])))),
        Promise.all(queues.map((q: any) => q.getActive(0, 0).catch(() => []))),
        // Per-scheduler stall counts (money backstop) for the cron drill-in; reuses the held client like the
        // budget GETs. ONE MGET for every declared cron id, so this stays one round trip however many
        // schedulers exist. An absent key reads as an honest 0 -- a scheduler that has never stalled -- which
        // is the same posture `readScopedBudget` takes for a scope that has never run.
        cronIds.length > 0 ? redis.mget(...cronIds.map((id) => stallKey(id))).catch(() => []) : Promise.resolve([]),
      ]);
      const workers = Array.isArray(workerList) && workerList.length > 0 ? workerList.length : "unknown";
      // Summed across the fleet, because a count of one queue is not a count of the deployment.
      const counts: any = {};
      for (const c of countsPer) for (const [k, v] of Object.entries(c ?? {})) counts[k] = (counts[k] ?? 0) + Number(v ?? 0);
      // A HALF-paused deployment must read as neither whole one: `every` is the honest AND, and `some`
      // carries the disagreement out so the header can name it rather than rounding it to one side.
      const pausedState = pausedStates.every(Boolean);
      const pausedPartial = !pausedState && pausedStates.some(Boolean);
      const schedulerList = schedulerLists.flat();
      const activeList = activeLists.flat();
      // The scoped limits + their live counters (issue #242): GET only the windows a row caps, each cell
      // caught individually so one bad read degrades one cell, never the snapshot. Keys recomputed from
      // the shared scopeKeyPrefix, so this reader and the worker's writer cannot drift.
      const scopedLimits: any = readScopedLimits({ scopedLimitsPath: paths.scopedLimitsPath });
      const limitRows: any[] = Array.isArray(scopedLimits?.limits) ? scopedLimits.limits : [];
      const scopedNow = new Date();
      const scopedBudget = {
        rows: await Promise.all(
          limitRows.map(async (l: any) => {
            const prefix = scopeKeyPrefix(l.scope);
            const cell = (key: string) => redis.get(key).then((v: any) => Number(v ?? 0), () => null);
            const row: any = {};
            if (Number.isInteger(l.day)) row.day = await cell(dayKey(scopedNow, prefix));
            if (Number.isInteger(l.week)) row.week = await cell(weekKey(scopedNow, prefix));
            if (Number.isInteger(l.month)) row.month = await cell(monthKey(scopedNow, prefix));
            return row;
          }),
        ),
      };
      // Jobs the worker is holding on run.waitFor (issue #230). Caught individually like the scoped cells
      // above, so a dead key or a slow SCAN degrades one section rather than the whole snapshot. Reads the
      // worker's own `wait:job:*` hashes and never a delayed Job: a delayed job's `.data` holds the issue
      // title and body, which is why the only queue-job read in this function takes an id and nothing else.
      const held = await heldJobs(redis).catch((err: any) => ({ unreachable: err?.message ?? String(err) }));

      return {
        held,
        scopedLimits,
        scopedBudget,
        queue: { pausedState, pausedPartial, counts, workers, queues: queues.length, fleetDegraded },
        budget: { day: Number(dayRaw ?? 0), week: Number(weekRaw ?? 0), month: Number(monthRaw ?? 0), tokensToday: Number(tokenRaw ?? 0) },
        schedulers: mapSchedulers(schedulerList, Date.now()),
        // Rebuilt into the `{ id -> count }` shape the drill-in and the LIST badge already index by, so
        // neither reader changes.
        schedulerStalls: Object.fromEntries(cronIds.map((id, i) => [id, Number((stallCounts as any[])?.[i] ?? 0) || 0])),
        schedulerStallMax: paths.schedulerStallMax,
        // Merged across the fleet (issue #57, Gap 3). This host's files stay the truth and the single-host
        // path; the mirror adds the other hosts' records. On a shared `PI_LOGS_DIR` the local read is
        // already the merged read and the mirror adds nothing, which is why there is no second code path.
        runs: merged.runs,
        runHosts: merged.hosts,
        runMirror: merged.mirror,
        settings: readSettingsView({ settingsFile: paths.settingsFile }),
        triggers: triggersView,
        pauseWindows: readPauseWindows({ pauseWindowsPath: paths.pauseWindowsPath }),
        // The operator's staged third-party pi packages (REQ-GLOBAL-PI-OVERLAY), for the armed triggers'
        // trust model. Like the four reads above it is a plain file read whose fs access lives entirely in
        // read-model.mjs -- this module never touches the filesystem -- and it degrades to a safe empty
        // shape rather than throwing, so a broken overlay cannot take the whole snapshot down.
        stagedPackages: readStagedPackages({ globalPiDir: paths.globalPiDir }),
        // ONLY the id off the active Job -- a Job's `.data` holds issue title/body/username (PII), so it
        // never enters the snapshot (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT).
        activeJobId: activeList?.[0]?.id ?? null,
      };
    },
    async pause() {
      await fleetQueues(); // refresh `lastNames` from the registry before unioning the keyspace onto it
      for (const q of await killSwitchQueues()) await q.pause();
    },
    async resume() {
      // Resume spans the same set, and it is the direction that strands a deployment: a queue paused while
      // its host was live, then resumed while that host is down, stays paused with nothing naming it.
      await fleetQueues();
      for (const q of await killSwitchQueues()) await q.resume();
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

/**
 * The dashboard overlay component. `deps` is the one injection seam: production defaults to a real
 * `createDashboardDeps(paths)` (one queue + one redis for the panel's lifetime); tests pass a canned
 * `fetchSnapshot` and `pause`/`resume`/`dispose` spies and never touch Redis. The first fetch fires
 * immediately so the panel is populated before the first interval tick; every fetch requests a re-render.
 */
export function makeDashboard({
  paths,
  done,
  tui,
  theme,
  intervalMs = REFRESH_MS,
  deps = createDashboardDeps(paths),
}: any = {}) {
  // The overlay-only color styler, bound to pi's injected theme (null in tests -> plain, same geometry).
  // The ascii opt-in rides the same resolved paths as panel.mjs' setGlyphs funnel, so PI_DISPATCH_ASCII=1
  // degrades the overlay frame and the panel primitives TOGETHER -- half-ASCII output was the pending gap
  // the old comment here deferred (issue #54's works-in-ASCII acceptance is what landed it).
  const styler = makeStyler(theme, { ascii: paths?.asciiGlyphs === true });
  let snapshot: any = null;
  let fetching = false;
  let disposed = false;
  let interval: any = null;
  // In-component view machine: LIST is the framed panel with the interactive run list; RUN_DETAIL is the
  // single-record dump; LIVE_TAIL tails a running job's `.log` inside the overlay. `selected` is the list
  // cursor; `detailRun` is the record captured on Enter.
  let view = "LIST";
  let selected = 0;
  let detailRun: any = null;
  // REQ-RESURRECTABLE-SANDBOX: whether the run opened in RUN_DETAIL still has a retained workspace, read
  // ONCE on entry through the injected seam rather than on every tick -- the answer changes at worker boot,
  // not per second, and this module does no I/O of its own.
  let detailSandbox: any = null;
  let detailTrigger: any = null; // the trigger opened in TRIGGER_DETAIL (its display record + file index)
  // LIVE_TAIL state, held here in dedicated component fields keyed only by the id-only `activeJobId`. The
  // raw `.log` bytes in `tail` are PII-bearing and untrusted: they live here and reach the TUI overlay via
  // render() alone -- never `snapshot`, never a shared renderer, never `sendMessage` (INT-RUN-HISTORY-FILE-CONTRACT).
  let tailJobId: any = null;
  let tail: any = null;
  let tailTop = 0;
  // Follow mode: the tail opens pinned to the BOTTOM (the newest lines are what the view is opened for)
  // and stays pinned as the log grows. Scrolling up pauses following; scrolling back to the bottom
  // re-arms it. The footer names the state, so a paused tail cannot masquerade as a live one.
  let tailFollow = true;
  // LIVE_TAIL search: `tailSearchInput` is the open `/` line input (null when closed), `tailQuery` the
  // armed case-insensitive substring (null when none), `tailMatchLine` the absolute index of the current
  // match in the tail. They live beside the other tail fields and reset with them on Esc-to-LIST; the
  // query only ever matches over the same held `tail` bytes the view already renders, so search adds no
  // new surface for the untrusted log to reach.
  let tailSearchInput: any = null;
  let tailQuery: any = null;
  let tailMatchLine: any = null;
  // RUN_DETAIL's transient clipboard acknowledgment: set by y/Y, cleared by the NEXT handleInput or
  // refresh, so it renders for exactly the frames between two inputs -- simple and test-observable.
  let copiedNote: any = null;
  // The active runs-list ordering (`o` cycles RUN_SORTS); named in the runs divider so the list is never
  // silently re-ordered.
  let runSort = "time";
  // TRIGGER_DETAIL: `x` armed a y/n confirm rendered in the frame's own footer, so the question costs a
  // keystroke rather than a dispose/reopen cycle of the whole overlay. Only the `y` closes the overlay,
  // carrying `confirmed: true` so the command loop does not ask the same question twice.
  let pendingDelete = false;
  const refresh = async () => {
    if (fetching || disposed) return;
    fetching = true;
    copiedNote = null; // the copy note is one-frame-transient: any refresh outdates it

    try {
      snapshot = await deps.fetchSnapshot();
      // Only while the tail view is open, and only through the injected capability, re-read the tail keyed
      // by the id-only `tailJobId`. `await` unwraps a synchronous return too. The bytes stay in `tail`.
      if (view === "LIVE_TAIL" && tailJobId && deps.tailLog) {
        tail = await deps.tailLog({ jobId: tailJobId, lines: TAIL_LINES });
      }
    } catch (err: any) {
      snapshot = { unreachable: err?.message ?? String(err) };
    } finally {
      fetching = false;
      tui?.requestRender?.();
    }
  };

  const act = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch {
      // A failed pause/resume surfaces as the next snapshot's paused state; never crash the overlay.
    }
    await refresh();
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
    try {
      await deps.dispose();
    } catch {
      // best-effort teardown
    }
  };

  interval = setInterval(() => void refresh(), intervalMs);
  interval?.unref?.(); // never keep the process alive on the poll timer alone (dispose still clears it)
  void refresh();

  const component = {
    render(width: number): string[] {
      // Clamp the cursor here so a rows list that shrank between ticks can never leave `selected` pointing
      // past the end. `rows` spans the optional ACTIVE row plus the run records.
      const rows = buildRows(snapshot, runSort);
      if (selected > rows.length - 1) selected = Math.max(0, rows.length - 1);
      // Clamp the tail scroll so a shrinking log can never scroll past the end; follow mode instead pins
      // the window to the bottom of every fresh tail.
      if (view === "LIVE_TAIL") {
        const len = Array.isArray(tail?.lines) ? tail.lines.length : 0;
        const maxTop = Math.max(0, len - TAIL_VIEWPORT);
        tailTop = tailFollow ? maxTop : Math.min(Math.max(0, tailTop), maxTop);
      }
      return renderPanel(snapshot, width, {
        view,
        selected,
        detailRun,
        detailTrigger,
        tailJobId,
        tail,
        tailTop,
        tailFollow,
        tailAvailable: typeof deps?.tailLog === "function",
        tailSearchInput,
        tailQuery,
        tailMatchLine,
        detailSandbox,
        sandboxAvailable: typeof deps?.launchSandbox === "function",
        pendingDelete,
        runSort,
        copiedNote,
        copyAvailable: typeof deps?.copyText === "function",
        // Height through the injected seam, read per frame (a resize changes it): null (seam absent, or
        // stdout not a TTY) means the collapse budget stays off and the panel composes exactly as before.
        terminalRows: typeof deps?.terminalRows === "function" ? deps.terminalRows() : null,
      }, styler);
    },
    invalidate(): void {
      // No cached render state to clear; the TUI redraws from render().
    },
    handleInput(data: string): void {
      // Whatever key arrives next outdates the copy acknowledgment; y/Y below set a fresh one AFTER this
      // line, so the note lives for exactly the renders between two inputs.
      copiedNote = null;
      if (view === "RUN_DETAIL") {
        // Escape backs out to the list only; it never closes the overlay or disposes the held clients.
        if (matchesKey(data, "escape")) {
          view = "LIST";
          detailSandbox = null;
          tui?.requestRender?.();
          return;
        }
        // ←/→ walk the run records in place: post-mortems are read in sequence, and Esc-arrow-Enter per
        // record is the tax this removes. The LIST cursor follows, so Esc lands on the run being read.
        if (matchesKey(data, "left") || matchesKey(data, "right")) {
          const rows = buildRows(snapshot, runSort);
          const i = rows.findIndex((r) => r.kind === "run" && r.record?.jobId && r.record.jobId === detailRun?.jobId);
          if (i === -1) return;
          const step = matchesKey(data, "left") ? -1 : 1;
          const next = rows[i + step];
          if (!next || next.kind !== "run") return;
          detailRun = next.record;
          // Same one-read-on-entry rule as Enter: sandbox state through the injected seam, never per tick.
          detailSandbox = typeof deps?.sandboxInfo === "function" ? deps.sandboxInfo({ jobId: detailRun?.jobId }) : null;
          selected = i + step;
          tui?.requestRender?.();
          return;
        }
        // `b` re-opens this run's sandbox as a shell (REQ-RESURRECTABLE-SANDBOX).
        //
        // Launched IN PLACE, unlike TRIGGER_DETAIL's `e`/`x`, which resolve the overlay so ctx.ui dialogs
        // can run after it closes. This needs the opposite: the LIVE `tui`, because handing the terminal to
        // an interactive container means suspending pi's own render loop and input handling for the
        // duration and restoring them after. `stop()`/`start()` are pi's designed pair for exactly that --
        // it uses them itself to launch $EDITOR -- and `requestRender(true)` forces the full redraw that
        // an external program's output has invalidated.
        //
        // The spawn itself is the injected `launchSandbox`; this module holds the tui and nothing else.
        if (data === "b" || data === "B") {
          if (typeof deps?.launchSandbox !== "function" || !detailRun?.jobId) return;
          if (detailSandbox && detailSandbox.retained === false) return; // nothing to open; the view says so
          void (async () => {
            tui?.stop?.();
            try {
              await deps.launchSandbox({ jobId: detailRun.jobId });
            } catch {
              // A failed launch must not leave the panel suspended -- the `finally` is the whole guarantee.
            } finally {
              tui?.start?.();
              tui?.requestRender?.(true);
            }
          })();
          return;
        }
        // OSC 52 copy, bound only while the seam is wired (the terminal write lives in index.ts beside
        // tailLog). `y` takes the job id -- the handle every other command keys off -- and `Y` the
        // browsable target URL when the record's forge yields one (github only; see targetUrl). Both are
        // operator-initiated, id-only strings; the acknowledgment rides the footer until the next input.
        if ((data === "y" || data === "Y") && typeof deps?.copyText === "function") {
          const text = data === "y" ? detailRun?.jobId : targetUrl(detailRun);
          if (!text) return; // nothing to copy: inert, no note
          deps.copyText(String(text));
          copiedNote = `copied ${data === "y" ? "job id" : "target url"}`;
          tui?.requestRender?.();
          return;
        }
        // Every other key (including q/p/r) is inert in the detail view.
        return;
      }
      if (view === "TRIGGER_DETAIL") {
        // Read-only trust-model view. `e` edits the flow via the command loop's dialogs; `x` arms an
        // in-frame y/n whose `y` alone closes the overlay with the delete action (carrying `confirmed`,
        // so the command loop does not ask the same question twice); Esc backs out to the list.
        if (pendingDelete) {
          if (data === "y" || data === "Y") {
            void dispose().finally(() => done({ action: "deleteTrigger", index: detailTrigger?.index, confirmed: true }));
            return;
          }
          // An explicit decline (or Esc) stands down; every other key is inert while the question is up,
          // so a buffered keystroke cannot answer it by accident.
          if (data === "n" || data === "N" || matchesKey(data, "escape")) {
            pendingDelete = false;
            tui?.requestRender?.();
          }
          return;
        }
        if (matchesKey(data, "escape")) {
          view = "LIST";
          detailTrigger = null;
          tui?.requestRender?.();
          return;
        }
        if (data === "e" || data === "E") {
          void dispose().finally(() => done({ action: "editTrigger", index: detailTrigger?.index }));
          return;
        }
        if (data === "x" || data === "X") {
          pendingDelete = true;
          tui?.requestRender?.();
          return;
        }
        return;
      }
      if (view === "LIVE_TAIL") {
        // The `/` search input is the innermost layer, routed BEFORE every view key: a printable byte
        // must land in the query, never fire a scroll or view key.
        if (tailSearchInput) {
          if (matchesKey(data, "escape")) {
            // Esc closes the SEARCH -- input and armed query together -- one layer above the view's own
            // Esc-to-LIST below, matching the pop-one-layer discipline everywhere else in the overlay.
            tailSearchInput = null;
            tailQuery = null;
            tailMatchLine = null;
            tui?.requestRender?.();
            return;
          }
          if (data === "\r" || data === "\n") {
            // Enter closes the input keeping the query armed; an empty query arms nothing.
            const q = tailSearchInput.value();
            tailQuery = q.length > 0 ? q : null;
            if (tailQuery === null) tailMatchLine = null;
            tailSearchInput = null;
            tui?.requestRender?.();
            return;
          }
          if (matchesKey(data, "backspace")) tailSearchInput.backspace();
          else if (matchesKey(data, "left")) tailSearchInput.left();
          else if (matchesKey(data, "right")) tailSearchInput.right();
          else if (matchesKey(data, "home")) tailSearchInput.home();
          else if (matchesKey(data, "end")) tailSearchInput.end();
          else if (!data.startsWith("\x1b") && data >= " ") tailSearchInput.insert(data);
          else return; // any other control sequence is inert while the search is up
          tui?.requestRender?.();
          return;
        }
        // Escape pops ONE layer: an armed query first, the view second. Backing out to the list drops the
        // held tail bytes AND the search state; scroll keys move the window. Every other key is inert.
        // This view never closes the overlay or disposes the held clients.
        if (matchesKey(data, "escape")) {
          if (tailQuery !== null) {
            tailQuery = null;
            tailMatchLine = null;
            tui?.requestRender?.();
            return;
          }
          view = "LIST";
          tailJobId = null;
          tail = null;
          tailTop = 0;
          tailFollow = true;
          tailSearchInput = null;
          tailMatchLine = null;
          tui?.requestRender?.();
          return;
        }
        if (data === "/") {
          // Seeded with the armed query (empty when none), so reopening the bar refines rather than
          // restarts; Enter re-arms whatever it says.
          tailSearchInput = makeLineInput(tailQuery ?? "");
          tui?.requestRender?.();
          return;
        }
        // Scrolling up pauses follow mode at the current window; reaching the bottom again re-arms it.
        const len = Array.isArray(tail?.lines) ? tail.lines.length : 0;
        const maxTop = Math.max(0, len - TAIL_VIEWPORT);
        // With a query armed, n/N jump to the next/previous matching line (wrapping). A matched jump is
        // manual scrolling in every way that matters, so it suspends follow exactly as the arrows do; with
        // no match there is nothing to jump to and the footer already says `no match`.
        if ((data === "n" || data === "N") && tailQuery !== null) {
          const all = Array.isArray(tail?.lines) ? tail.lines : [];
          const matches = tailMatches(all, tailQuery);
          if (matches.length === 0) return;
          const from = tailMatchLine === null ? tailTop : tailMatchLine;
          tailMatchLine =
            data === "n"
              ? matches.find((i) => i > from) ?? matches[0]
              : [...matches].reverse().find((i) => i < from) ?? matches[matches.length - 1];
          tailFollow = false;
          tailTop = Math.min(tailMatchLine, maxTop);
          tui?.requestRender?.();
          return;
        }
        if (matchesKey(data, "up")) {
          tailFollow = false;
          tailTop = Math.max(0, tailTop - 1);
          tui?.requestRender?.();
        } else if (matchesKey(data, "down")) {
          tailTop = Math.min(maxTop, tailTop + 1);
          if (tailTop >= maxTop) tailFollow = true;
          tui?.requestRender?.();
        } else if (matchesKey(data, "pageUp")) {
          tailFollow = false;
          tailTop = Math.max(0, tailTop - TAIL_VIEWPORT);
          tui?.requestRender?.();
        } else if (matchesKey(data, "pageDown")) {
          tailTop = Math.min(maxTop, tailTop + TAIL_VIEWPORT);
          if (tailTop >= maxTop) tailFollow = true;
          tui?.requestRender?.();
        }
        return;
      }
      if (matchesKey(data, "escape") || data === "q" || data === "Q") {
        void dispose().finally(() => done(undefined));
        return;
      }
      if (data === "\r" || data === "\n") {
        const rows = buildRows(snapshot, runSort);
        const row = rows[selected];
        if (!row) return;
        if (row.kind === "trigger") {
          detailTrigger = { record: row.trigger, index: row.index };
          pendingDelete = false;
          view = "TRIGGER_DETAIL";
          tui?.requestRender?.();
        } else if (row.kind === "active") {
          // Opening the tail: fire an immediate fetch so the first frame carries the tail, not the next tick.
          tailJobId = row.jobId;
          tailTop = 0;
          tailFollow = true;
          view = "LIVE_TAIL";
          void refresh();
        } else {
          detailRun = row.record;
          // One read on entry, through the seam whose fs access lives in index.ts.
          detailSandbox = typeof deps?.sandboxInfo === "function" ? deps.sandboxInfo({ jobId: row.record?.jobId }) : null;
          view = "RUN_DETAIL";
          tui?.requestRender?.();
        }
        return;
      }
      // `l` -- the footer's logs key: jump straight to the live tail when a job is running (the same path
      // Enter takes on the ACTIVE row); inert otherwise, because there is no log to open.
      if (data === "l" || data === "L") {
        if (!snapshot?.activeJobId) return;
        tailJobId = snapshot.activeJobId;
        tailTop = 0;
        tailFollow = true;
        view = "LIVE_TAIL";
        void refresh();
        return;
      }
      // `i` -- the insights page (issue #181): analytics live in the browser artifact now, so the key
      // resolves the overlay with a done-action, index.ts writes and opens the page between overlays
      // (the addTrigger route -- no dep seam here, no TUI suspend bracket), and the panel reopens.
      if (data === "i" || data === "I") {
        void dispose().finally(() => done({ action: "openInsights" }));
        return;
      }
      // Tab jumps between the two section heads (triggers <-> runs) instead of arrowing through every row.
      if (data === "\t") {
        const rows = buildRows(snapshot, runSort);
        if (rows.length === 0) return;
        const trgCount = (snapshot?.triggers?.triggers ?? []).length;
        selected = selected < trgCount && trgCount < rows.length ? trgCount : 0;
        tui?.requestRender?.();
        return;
      }
      // `o` cycles the runs-list order; the runs divider names the active one, so the list is never
      // silently re-ordered. Sorting reads the records already in the snapshot -- no re-read.
      if (data === "o" || data === "O") {
        runSort = RUN_SORTS[(RUN_SORTS.indexOf(runSort) + 1) % RUN_SORTS.length];
        tui?.requestRender?.();
        return;
      }
      // CRUD (operator-typed, live via the reload watchers): add a trigger, or edit the limits/settings.
      // Both close the overlay with an action the command loop drives via ctx.ui dialogs, then reopen.
      if (data === "a" || data === "A") {
        void dispose().finally(() => done({ action: "addTrigger" }));
        return;
      }
      if (data === "s" || data === "S") {
        void dispose().finally(() => done({ action: "editSettings" }));
        return;
      }
      if (data === "w" || data === "W") {
        void dispose().finally(() => done({ action: "managePauses" }));
        return;
      }
      if (data === "m" || data === "M") {
        void dispose().finally(() => done({ action: "manageLimits" }));
        return;
      }
      if (matchesKey(data, "up")) {
        selected = Math.max(0, selected - 1);
        tui?.requestRender?.();
        return;
      }
      if (matchesKey(data, "down")) {
        selected = Math.min(Math.max(0, buildRows(snapshot, runSort).length - 1), selected + 1);
        tui?.requestRender?.();
        return;
      }
      if (data === "p" || data === "P") {
        void act(deps.pause);
        return;
      }
      if (data === "r" || data === "R") {
        void act(deps.resume);
      }
    },
    dispose,
  };
  return component;
}

/** Split a renderer's multi-line string into the per-line array a `box` section expects. */
function toLines(text: string): string[] {
  return String(text).split("\n");
}

/**
 * One meter per spend window whose cap the admin can read (the overlay sets it). The day meter always shows
 * (parity with the single-window panel); week/month meters show only when their overlay cap is set. Each
 * meter's state comes from the worker's own `windowState`, so the bar's amber/red marker cannot drift from
 * what `reserveBudget` enforces. `meter` renders "cap unknown" for a window with no readable cap, so a
 * missing overlay cap degrades in place rather than guessing a denominator.
 */
function budgetMeters(budget: any, settings: any, width: number): string[] {
  const overlay = settings?.overlay ?? {};
  const pct = Number.isInteger(overlay.softHoldPct) ? overlay.softHoldPct : null;
  const specs = [
    { key: "day", cap: overlay.dailyCap, always: true },
    { key: "week", cap: overlay.weeklyCap, always: false },
    { key: "month", cap: overlay.monthlyCap, always: false },
  ];
  const out: string[] = [];
  for (const s of specs) {
    if (!s.always && !Number.isInteger(s.cap)) continue;
    const reserved = Number(budget?.[s.key] ?? 0);
    const state = Number.isInteger(s.cap) ? windowState(reserved, s.cap, pct) : "ok";
    out.push(meter(reserved, s.cap, width, state));
  }
  return out;
}

/**
 * Compose the monochrome framed panel from the last snapshot alone, reusing the slash-command renderers so
 * the panel and the commands cannot drift. A null snapshot is the pre-first-fetch loading state; a snapshot
 * carrying `unreachable` degrades the whole panel to one line rather than a wall of empty sections. A width
 * that is missing, non-finite, or below `MIN_WIDTH` degrades to unframed plain lines; a sane width frames
 * the same content with `box`, its inner column count driving every meter and clip.
 */
function renderPanel(snapshot: any, width: number, state: any, styler: any): string[] {
  const { view, selected, detailRun, detailTrigger, tailJobId, tail, tailTop, tailFollow, tailAvailable, tailSearchInput, tailQuery, tailMatchLine, detailSandbox, sandboxAvailable, pendingDelete, runSort, copiedNote, copyAvailable, terminalRows } = state;
  const framed = Number.isFinite(width) && Math.trunc(width) >= MIN_WIDTH;
  const inner = Math.trunc(width) - 4;
  const title = "pi-dispatch";

  if (view === "TRIGGER_DETAIL") {
    const t = detailTrigger?.record;
    const detailTitle = `trigger · ${t?.type ?? "?"}`;
    const dw = framed ? Math.min(Math.trunc(width), DRILL_WIDTH) : Math.trunc(width);
    const sched = cronSchedInfo(t, snapshot);
    const lines = renderTriggerDetail(t, framed ? dw - 4 : 24, styler, sched, snapshot?.stagedPackages);
    if (!framed) return [detailTitle, "", ...lines.map((l: string) => styler.stripAnsi(l)), "", pendingDelete ? "delete this trigger? y/n" : "e edit · x delete · esc back"];
    const boxed = frame(styler, { title: detailTitle, width: dw, lines, footer: triggerDetailHints(dw - 4, styler, pendingDelete) });
    return centerBlock(boxed, Math.trunc(width), dw);
  }

  if (view === "RUN_DETAIL") {
    const detailTitle = `run ${detailRun?.jobId ?? "-"}`;
    const dw = framed ? Math.min(Math.trunc(width), DRILL_WIDTH) : Math.trunc(width);
    const allRuns = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
    const canOpen = Boolean(sandboxAvailable && detailSandbox?.retained);
    const canCopy = Boolean(copyAvailable);
    const lines = renderRunDetail(detailRun, framed ? dw - 4 : 24, styler, allRuns, detailSandbox);
    if (!framed) {
      const bits = ["←→ prev/next"];
      if (canOpen) bits.push("b sandbox");
      if (canCopy) bits.push("y copy");
      bits.push("esc back");
      return [detailTitle, "", ...lines.map((l: string) => styler.stripAnsi(l)), "", (copiedNote ? `${copiedNote} · ` : "") + bits.join(" · ")];
    }
    const boxed = frame(styler, { title: detailTitle, width: dw, lines, footer: runDetailHints(dw - 4, styler, canOpen, canCopy, copiedNote) });
    return centerBlock(boxed, Math.trunc(width), dw);
  }

  if (view === "LIVE_TAIL") {
    return renderLiveTail({ snapshot, framed, width, tailJobId, tail, tailTop, tailFollow, tailAvailable, tailSearchInput, tailQuery, tailMatchLine, styler });
  }

  if (snapshot === null) {
    if (!framed) return [`${title} -- loading`, "", KEY_HINTS];
    return box({ title, sections: [{ lines: ["loading"] }], footer: KEY_HINTS, width });
  }
  if (snapshot.unreachable) {
    const msg = `unreachable (${snapshot.unreachable})`;
    if (!framed) return [`${title} -- ${msg}`, "", KEY_HINTS];
    return box({ title, sections: [{ lines: [msg] }], footer: KEY_HINTS, width });
  }

  // LIST — the colored dashboard. Content is composed on PLAIN text (widths via styler.cell/visibleLen)
  // and colored last, so pi's ANSI-aware visibleWidth frames it correctly. `terminalRows` (the injected
  // height, when known) drives the section collapse budget in buildListLines; the degraded path below
  // stays uncollapsed -- it is already the everything-else-failed rendering.
  if (framed) {
    const lines = buildListLines(snapshot, selected, inner, styler, runSort, terminalRows);
    return frame(styler, { title, width, lines, footer: keyHints(inner, styler) });
  }

  // Degraded (too-narrow) plain path — reuse the shared, plain renderers unframed.
  const sections = [
    { title: "STATUS", lines: toLines(renderStatus(snapshot.queue)) },
    {
      title: "SPEND",
      lines: [
        ...toLines(renderBudget({ budget: snapshot.budget, settings: snapshot.settings })),
        ...budgetMeters(snapshot.budget, snapshot.settings, 24),
      ],
    },
    { title: "TRIGGERS", lines: toLines(renderTriggers({ schedulers: snapshot.schedulers, triggers: snapshot.triggers })) },
    // The section TITLE carries the fleet fact, not a seventh cell in each row (issue #57, Gap 3). A cell
    // would compete with jobId and target inside one `fitLine(..., inner)` and clip silently at width 80;
    // the title answers the completeness question once rather than fifty times. Absent on a single host,
    // so that output is byte-identical.
    { title: runsTitle(snapshot), lines: renderRunList(buildRows(snapshot, runSort), selected, 24) },
    { title: "SETTINGS", lines: toLines(renderSettingsView(snapshot.settings)) },
  ];
  // Scoped limits appear only when configured (the mutex needs no line) -- renderScopedLimits returns
  // null for the nothing-configured case, and a section with no lines would render an empty box.
  const scopedText = renderScopedLimits({ limits: snapshot.scopedLimits, scopedBudget: snapshot.scopedBudget });
  if (scopedText) sections.splice(2, 0, { title: "SCOPED LIMITS", lines: toLines(scopedText) });
  // Held jobs appear only when something is held, for the same reason: a section with no lines renders an
  // empty box, and a deployment that never waits must look exactly as it did before the feature existed.
  const heldText = renderHeldJobs({ held: snapshot.held });
  if (heldText) sections.push({ title: "HELD", lines: toLines(heldText) });
  const plain = [title];
  for (const section of sections) plain.push(section.title, ...section.lines);
  plain.push(KEY_HINTS);
  return plain.join("\n\n").split("\n");
}

// ── colored LIST builders (overlay-only; every returned line is exactly `inner` visible columns) ────────

// One hue per kind so the badge column scans; issue takes a syntax color the other kinds left free, and
// not an amber one -- warning stays reserved for the risk badges appended after layout.
const KIND_COLOR: Record<string, string> = { cron: "accent", label: "syntaxType", comment: "syntaxKeyword", pull_request: "syntaxFunction", issue: "syntaxString" };
const KIND_WIDTH = 13; // fits "pull_request "

/** Pad an already-colored line up to `inner` visible columns; if it overflows, clip its plain form. */
function fitLine(line: string, inner: number, styler: any): string {
  const vis = styler.visibleLen(line);
  if (vis === inner) return line;
  if (vis < inner) return line + " ".repeat(inner - vis);
  return styler.cell(styler.stripAnsi(line), inner);
}

// The frame rows around a composed body -- top border, footer rule, footer, bottom border -- charged to
// the collapse budget before any section is measured. Kept beside the LIST budget because both
// frame with the same chrome.
const FRAME_CHROME_ROWS = 4;

/**
 * The pure collapse decision for the LIST budget: which sections give way when the composed panel
 * outgrows the terminal. `sections` carry `{ key, rows, keptRows, priority }`; `baseRows` is everything
 * that never collapses (frame chrome, RULE separators, the fixed blocks); collapsing a section keeps
 * `keptRows` of it -- LIST keeps the divider line. Sections
 * fold in ascending `priority`, never the `focus`ed one and never one without a priority, until the total
 * fits. A null/non-finite `availableRows` (seam absent, stdout not a TTY) collapses NOTHING, so an
 * unknown height renders byte-identically to the panel before this existed. Best-effort on purpose: when
 * everything foldable is folded the panel may still overflow, and the residue is the runs/tail viewport's
 * own already-bounded height.
 */
function collapseKeys(sections: any[], availableRows: any, focus: string | null, baseRows: number): Set<string> {
  const out = new Set<string>();
  if (!Number.isFinite(availableRows)) return out;
  let total = baseRows;
  for (const s of sections) total += s.rows;
  const order = sections
    .filter((s) => Number.isFinite(s.priority) && s.key !== focus)
    .sort((a, b) => a.priority - b.priority);
  for (const s of order) {
    if (total <= availableRows) break;
    out.add(s.key);
    total -= s.rows - s.keptRows;
  }
  return out;
}

/** Compose the colored LIST body lines (RULE marks a `├──┤` separator). With a known terminal height
 * (`availableRows` through the injected seam) sections collapse by priority until the frame fits; an
 * unknown height composes exactly the full panel it always did -- byte-identical by construction. */
function buildListLines(snapshot: any, selected: number, inner: number, styler: any, runSort = "time", availableRows: any = null): any[] {
  // Triggers are selectable and come FIRST in buildRows, so a trigger's file index == its selection index.
  const trg = triggerLines(snapshot, selected, inner, styler);
  const pw = pauseLines(snapshot.pauseWindows, inner, styler);
  const sl = limitLines(snapshot.scopedLimits, snapshot.scopedBudget, inner, styler);
  // Active + run rows follow the triggers in buildRows, so offset the selection index by the trigger count.
  const runRows = buildRows(snapshot, runSort).slice(trg.count);
  const runCount = Array.isArray(snapshot.runs) ? snapshot.runs.length : 0;
  // The panel as an ordered section model. `head` is the divider label+meta (null for the status header),
  // `priority` the collapse order -- pause windows give way first, then settings, then triggers, then
  // spend, roughly inverse to how often an operator acts on them from this panel -- and `viewKey` the key
  // the collapsed divider names. Status and runs carry no priority: the header is the panel's one
  // constant and the runs viewport already bounds itself.
  const sections: any[] = [
    { key: "status", head: null, body: [statusHeader(snapshot.queue, inner, styler)] },
    { key: "spend", head: ["spend & limits", "jobs & tokens/day · s set"], body: spendLines(snapshot.budget, snapshot.settings, inner, styler), priority: 4, viewKey: "s" },
    { key: "triggers", head: ["triggers", `${trg.count} standing · a add · ↵ open`], body: trg.lines, priority: 3, viewKey: "tab" },
    { key: "pauses", head: ["pause windows", `${pw.count} · w manage`], body: pw.lines, priority: 1, viewKey: "w" },
    // Priority 0: the section an operator acts on least often from the panel folds FIRST under the
    // collapse budget. The key hint lives in this divider, not the footer -- the footer's width
    // arithmetic has no headroom for another hint (its own comment), the s/o/Tab precedent.
    { key: "limits", head: ["scoped limits", `${sl.count} · m manage`], body: sl.lines, priority: 0, viewKey: "m" },
    ...heldSection(snapshot.held, inner, styler),
    { key: "runs", head: ["runs", `last ${runCount} · o ${runSort}`], body: runLines(runRows, selected - trg.count, inner, styler) },
    { key: "settings", head: ["settings", "s edit"], body: settingsLines(snapshot.settings, inner, styler), priority: 2, viewKey: "s" },
  ];
  // The cursor's section is never collapsed out from under it. Runs cannot collapse anyway; the rule is
  // stated for both so Tab-into-triggers always re-expands them on the very next frame.
  const focus = selected < trg.count ? "triggers" : "runs";
  const collapsed = collapseKeys(
    sections.map((s) => ({ key: s.key, rows: (s.head ? 1 : 0) + s.body.length, keptRows: 1, priority: s.priority })),
    availableRows,
    focus,
    FRAME_CHROME_ROWS + sections.length - 1, // chrome + one RULE between each pair of sections
  );
  const lines: any[] = [];
  sections.forEach((s, i) => {
    if (i > 0) lines.push(RULE);
    if (collapsed.has(s.key)) {
      // The divider line alone, its meta now saying what folded away and which key gets it back.
      // Only name a key when there IS one. A section can be foldable without being openable -- held jobs
      // have no view to bind -- and "(N hidden — undefined to view)" is worse than saying nothing.
      lines.push(styler.divider(s.head[0], s.viewKey ? `(${s.body.length} hidden — ${s.viewKey} to view)` : `(${s.body.length} hidden)`, inner));
      return;
    }
    if (s.head) lines.push(styler.divider(s.head[0], s.head[1], inner));
    for (const l of s.body) lines.push(l);
  });
  return lines;
}

/** How many held rows the section shows before it stops and counts the rest. */
const HELD_ON_DASHBOARD = 3;

/**
 * The held-jobs section, or NOTHING when nothing is held (issue #230).
 *
 * CONDITIONAL, which is the difference between a section and a lie. `buildListLines` charges one RULE plus
 * a divider for every section it is given, and its row budget is `chrome + sections.length - 1`, so an
 * unconditional section moves the floor on every deployment -- including those that never wait -- and the
 * byte-identity assertion this panel keeps would be false for a feature nobody enabled.
 *
 * SELF-BOUNDING like `runs`, rather than collapsible like the config sections. It carries no `priority` and
 * no `viewKey` on purpose: a priority without a keybinding renders "(N hidden — undefined to view)", and
 * there is no view to bind, because a held row has nothing to drill into. It bounds itself instead, the way
 * the runs viewport does, so it can never blow the frame however many jobs are waiting.
 */
function heldSection(held: any, inner: number, styler: any): any[] {
  if (!held) return [];
  if (held.unreachable) {
    return [{ key: "held", priority: 5, head: ["held", "waiting on conditions"], body: [styler.cell(`unreadable (${held.unreachable})`, inner, { color: "error" })] }];
  }
  const rows: any[] = Array.isArray(held.rows) ? held.rows : [];
  if (rows.length === 0) return [];
  const shown = rows.slice(0, HELD_ON_DASHBOARD);
  const hidden = rows.length - shown.length + (Number(held.more) || 0);
  const body = shown.map((r: any) => heldRow(r, inner, styler));
  if (hidden > 0) body.push(styler.cell(styler.fg("dim", `↓ ${hidden} more`), inner));
  const total = rows.length + (Number(held.more) || 0);
  // `truncated` means the index was longer than the reader would hydrate, so the count is a FLOOR. Said as
  // "200+" rather than stated flat: a header that names a number it cannot stand behind is the invented
  // figure this panel refuses everywhere else.
  return [{ key: "held", priority: 5, head: ["held", `${total}${held.truncated ? "+" : ""} waiting on conditions`], body }];
}

/** One held row: `○ owner/repo#7  after 2026-09-01T09:00Z + jira  waited 2h14m`. */
function heldRow(r: any, inner: number, styler: any): string {
  // Every cell is host-chosen: an id-only target the worker derived, an operator-authored condition label,
  // and a duration. No `.data` reaches this function, which is why the reader takes the worker's own hashes
  // rather than a delayed job -- a delayed job's data holds the issue title and body.
  const bits = [
    `${styler.fg("dim", "○")} ${styler.fg("accent", r.target ?? r.jobId ?? "-")}`,
    styler.fg("text", r.label ?? "-"),
    styler.fg("dim", `waited ${fmtDuration(r.waitedMs)}`),
  ];
  return fitLine(bits.join(styler.fg("dim", " · ")), inner, styler);
}

/** A compact, honest duration. `?` when the worker recorded no hold clock, never a fabricated zero. */
function fmtDuration(ms: any): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

/** The one-line STATUS header: `● RUNNING  N waiting · … · K workers        HH:MM:SS`. */
function statusHeader(queue: any, inner: number, styler: any): string {
  if (!queue || queue.unreachable) {
    return styler.cell(`queue unreachable (${queue?.unreachable ?? "?"})`, inner, { color: "error" });
  }
  const c = queue.counts ?? {};
  const running = !queue.pausedState && !queue.pausedPartial;
  const failed = Number(c.failed ?? 0);
  // Three states, not two. A fleet where one host is paused and another is spending is the state an
  // operator most needs named, and it is precisely the one a boolean cannot say.
  const stateColor = running ? "success" : "warning";
  const dot = styler.fg(stateColor, "●");
  const word = styler.bold(styler.fg(stateColor, running ? "RUNNING" : queue.pausedPartial ? "PART PAUSED" : "PAUSED"));
  const sep = styler.fg("dim", " · ");
  // `delayed` renders only when nonzero, NEUTRAL, never amber: every cron scheduler keeps one
  // permanent job in the delayed set (its next occurrence), and the count also mixes retry backoff,
  // quiet-hours, scope deferrals and -- since issue #230 -- jobs held on `run.waitFor`. That fifth
  // population is the only one with a section of its own, which is the point: the count stays an
  // undifferentiated number, and the operator reads the HELD section to learn what is actually waiting.
  // An always-on amber here would teach them to ignore it. Absent at zero, the header is byte-identical
  // to before the count existed.
  const delayed = Number(c.delayed ?? 0);
  const vitals =
    `${c.waiting ?? 0} waiting` + sep + `${c.active ?? 0} active` + sep +
    (delayed > 0 ? `${delayed} delayed` + sep : "") +
    (failed > 0 ? styler.fg("error", `${failed} failed`) : `${failed} failed`) + sep +
    `${queue.workers ?? "?"} workers`;
  const clock = new Date().toISOString().slice(11, 19); // HH:MM:SS UTC
  const left = `${dot} ${word}  ${vitals}`;
  const gap = inner - styler.visibleLen(left) - clock.length;
  if (gap < 1) return styler.cell(styler.stripAnsi(left), inner);
  return left + " ".repeat(gap) + styler.fg("dim", clock);
}

/** Colored spend meters (day/week/month) with reset countdown + soft-hold marker. */
function spendLines(budget: any, settings: any, inner: number, styler: any): string[] {
  if (!budget || budget.unreachable) {
    return [styler.cell(`budget unreachable (${budget?.unreachable ?? "?"})`, inner, { color: "error" })];
  }
  const overlay = (settings && settings.overlay) ?? {};
  const pct = Number.isInteger(overlay.softHoldPct) ? overlay.softHoldPct : null;
  const now = new Date();
  const specs = [
    { key: "day", label: "day", cap: overlay.dailyCap, reset: nextDayResetMs(now), always: true },
    { key: "week", label: "week", cap: overlay.weeklyCap, reset: nextWeekResetMs(now), always: false },
    { key: "month", label: "month", cap: overlay.monthlyCap, reset: nextMonthResetMs(now), always: false },
  ];
  const out: string[] = [];
  const labW = 6;
  for (const s of specs) {
    const reserved = Number(budget[s.key] ?? 0);
    const capSet = Number.isInteger(s.cap);
    // The day cap always applies (env default even when the overlay is silent). Week/month default to
    // disabled, so when the overlay sets no cap and nothing has reserved, show them as an off, enableable
    // window rather than hiding them — the operator sees every limit and which are switched off.
    if (!capSet && !s.always && reserved === 0) {
      out.push(styler.fg("muted", s.label.padEnd(labW)) + styler.fg("dim", "off · no cap set (s to enable)"));
      continue;
    }
    const state = capSet ? windowState(reserved, s.cap, pct) : "ok";
    const marker = state === "soft-hold" ? " · soft-hold" : state === "over" ? " · over" : "";
    const tail = countdownText(s.reset) + marker;
    const barW = Math.max(8, inner - labW - 2 - tail.length);
    const line =
      styler.cell(s.label, labW, { color: "muted" }) + " " +
      styler.meter(reserved, s.cap, barW, state) + " " +
      styler.fg("dim", tail);
    out.push(fitLine(line, inner, styler));
  }
  if (pct !== null) out.push(styler.cell(`soft-hold band: ${pct}% of each cap`, inner, { color: "muted" }));
  out.push(tokenLine(budget, overlay, pct, inner, styler));
  return out;
}

/** The daily token counter (issue #25): today's spend vs the daily token cap, plus the per-job budget. */
function tokenLine(budget: any, overlay: any, pct: number | null, inner: number, styler: any): string {
  const spent = Number(budget?.tokensToday ?? 0);
  const cap = overlay?.dailyTokenCap;
  const perJob = overlay?.maxTokens;
  const perJobNote = Number.isInteger(perJob) ? ` · per-job ${fmtTokens(perJob)}` : " · per-job budget off";
  const lab = styler.fg("muted", "tokens") + " "; // 6-wide label + space, matching the meter rows
  if (Number.isInteger(cap)) {
    const state = spent >= cap ? "over" : Number.isInteger(pct) && spent > Math.floor((cap * pct) / 100) ? "soft-hold" : "ok";
    const color = state === "over" ? "error" : state === "soft-hold" ? "warning" : "success";
    const marker = state === "soft-hold" ? " soft-hold" : state === "over" ? " over" : "";
    return fitLine(lab + styler.fg(color, `${fmtTokens(spent)} / ${fmtTokens(cap)} today${marker}`) + styler.fg("dim", perJobNote), inner, styler);
  }
  return fitLine(lab + styler.fg("text", `${fmtTokens(spent)} today`) + styler.fg("dim", ` · daily cap off${perJobNote}`), inner, styler);
}

/** Compact token count: 1234 -> "1.2k", 1234567 -> "1.2M". */
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** The configured triggers as colored rows: `<kind>  <match>  → <target> <flow>`. Takes the whole snapshot
 * (not just `snapshot.triggers`) so each cron row can join its resident scheduler for the health badge. */
function triggerLines(snapshot: any, selected: number, inner: number, styler: any): { count: number; lines: string[] } {
  const triggers = snapshot?.triggers;
  const lines: string[] = [];
  if (triggers && triggers.missing) { lines.push(styler.cell("(triggers file not found · a to add)", inner, { color: "dim" })); return { count: 0, lines }; }
  if (triggers && triggers.invalid) { lines.push(styler.cell(`(triggers file invalid: ${triggers.invalid})`, inner, { color: "error" })); return { count: 0, lines }; }
  const list = (triggers && triggers.triggers) ?? [];
  if (list.length === 0) { lines.push(styler.cell("(no triggers · a to add)", inner, { color: "dim" })); return { count: 0, lines }; }
  list.forEach((t: any, i: number) => lines.push(triggerRow(t, i === selected, inner, styler, cronSchedInfo(t, snapshot))));
  return { count: list.length, lines };
}

function triggerRow(t: any, sel: boolean, inner: number, styler: any, sched: any = null): string {
  const cursor = sel ? styler.fg("accent", "›") : " ";
  const kind = t?.type ?? "?";
  const badge = styler.cell(kind, KIND_WIDTH, { color: KIND_COLOR[kind] ?? "muted" });
  // A trigger that loads the operator-staged third-party pi packages says so: without this, a trigger
  // running third-party code with open network egress renders identically to one that does not. Loading is
  // the default (`run.packages` is an opt-out), so the badge is present unless the trigger declined.
  // Amber, and appended AFTER the layout parts, so color stays post-layout.
  // NO forge badge here, deliberately -- unlike render.mjs, which still needs one. This row's target now
  // NAMES the forge (`-> gitlab fix`), so a badge would say it twice. The badge existed because the target
  // used to read `-> github` for every forge, which made a gitlab row contradict its own badge; fixing the
  // target removed the badge's reason to exist rather than merely its wrongness. render.mjs keeps its badge
  // because its line goes straight to the flow (`-> fix`) and never names the forge at all.
  const pkgs = t?.packages === true ? " " + styler.fg("warning", "[packages]") : "";
  // A non-default image, in `accent` rather than `warning`: amber is reserved for the risk badge (third-party
  // code), and an operator-built image is not third-party. `accent` is already this file's colour for "this
  // trigger overrides a deployment default" -- the same choice the pinned-model row makes below.
  const img = t?.image ? " " + styler.fg("accent", `[${t.image}]`) : "";
  // `warning`, not `accent`: amber is this file's colour for a risk badge rather than for "overrides a
  // deployment default", and persisting the agent's full working history to host disk -- issue text, file
  // contents, tool output, its own reasoning -- is a disclosure, not a preference. Same class as
  // [packages], which is the badge whose inverted polarity 0.1.4 had to fix.
  const res = t?.resume === true ? " " + styler.fg("warning", "[resume]") : "";
  // `warning` for the same reason [resume] is: a spend multiplier is a risk badge, not a preference. A
  // trigger without it renders byte-identically -- the badge is purely additive, appended last.
  const rep = t?.replicas > 1 ? " " + styler.fg("warning", `[x${t.replicas}]`) : "";
  // The one-shot badges (issue #231). [once] in `accent`, NOT `warning`: amber is this file's colour for
  // a risk badge, and a one-shot NARROWS spend to a single future run -- [x N]'s inverse, an override of
  // the fire-forever default, which is exactly what `accent` marks ([image], the pinned model). [spent]
  // in `dim`: a rule that finished its job, not a risk -- the row stays on the list because the raw file
  // keeps the entry, and it dims so it cannot be misread as armed. Mutually exclusive by construction
  // (the worker only disarms once rules); absent otherwise, so every existing row is byte-identical.
  const shot = t?.disarmed ? " " + styler.fg("dim", "[spent]") : t?.once === true ? " " + styler.fg("accent", "[once]") : "";
  // Health is a LIST-level fact, not only a drill-in one: an overdue scheduler or a stall counter at the
  // backstop max is exactly the row an operator must notice without opening it. Amber, appended last like
  // the other risk badges; a healthy or non-cron row renders byte-identically to before.
  const health = sched && (sched.overdueMs || (sched.stallMax > 0 && sched.stalls >= sched.stallMax))
    ? " " + styler.fg("warning", sched.overdueMs ? "⚠ overdue" : "⚠ stalled")
    : "";
  return fitLine(`${cursor} ${badge} ${matchColored(t, styler)} ${targetColored(t, styler)}${pkgs}${img}${res}${rep}${shot}${health}`, inner, styler);
}

function matchColored(t: any, styler: any): string {
  switch (t?.type) {
    case "cron": return styler.fg("text", `${t.id ?? "-"}  ${t.pattern ?? "-"}`);
    case "comment": return styler.fg("text", `"${t.phrase ?? "-"}"`);
    case "issue": {
      // The pull_request idiom below -- muted [action] first -- then the one narrowing an issue rule can
      // carry: the item number, in `success` because it is the positive match term, exactly what a green
      // label is in the arm below (issue #231). An unnarrowed rule ends at the action: it matches every
      // item, and there is no selector for a placeholder to stand in for.
      const num = Number.isInteger(t.number) ? " " + styler.fg("success", `#${t.number}`) : "";
      return styler.fg("muted", `[${(t.action ?? []).join(",")}]`) + num;
    }
    case "label":
    case "pull_request": {
      const parts: string[] = [];
      if (t.type === "pull_request") parts.push(styler.fg("muted", `[${(t.action ?? []).join(",")}]`));
      // A close-only rule's narrowing renders as the issue arm's does (issue #231): the number IS the
      // positive match term, and a one-shot on #40 must not render like "every close".
      if (t.type === "pull_request" && Number.isInteger(t.number)) parts.push(styler.fg("success", `#${t.number}`));
      for (const x of t.any ?? []) parts.push(styler.fg("success", x));
      for (const x of t.all ?? []) parts.push(styler.fg("success", `+${x}`));
      for (const x of t.none ?? []) parts.push(styler.fg("error", `!${x}`));
      return parts.length ? parts.join(" ") : styler.fg("dim", "(any)");
    }
    default: return styler.fg("dim", "?");
  }
}

function targetColored(t: any, styler: any): string {
  const arrow = styler.fg("dim", "→");
  // A command trigger shows its `/name` in the flow position, through render.mjs's one exported
  // vocabulary (issue #188): before this fallback the row rendered a bare "-", as if the trigger
  // targeted nothing.
  const flow = styler.bold(styler.fg("text", t?.flow ?? commandSlashLabel(t) ?? "-"));
  if (t?.type === "cron") {
    // A local/cron trigger runs its flow against a folder — show `local <folder>/<flow>` so the target
    // (not just the flow name) is visible; github triggers get their repo from the webhook, so none there.
    const base = t.folder ? String(t.folder).split(/[/\\]/).filter(Boolean).pop() ?? "" : "";
    const folderPart = base ? styler.fg("muted", base) + styler.fg("dim", "/") : "";
    return `${arrow} ${styler.fg("success", "local")} ${folderPart}${flow}`;
  }
  // The forge is READ, never assumed. It was the literal "github" here, which rendered a gitlab or azure
  // trigger as `→ github <flow>  [gitlab]` -- the row contradicting its own badge. `forge` is carried
  // verbatim by read-model.mjs, so an unrecognised one shows as itself rather than as a plausible default.
  return `${arrow} ${styler.fg("accent", t?.forge ?? "github")} ${flow}`;
}

/** The scheduled pause windows as colored rows, each marked `●` (paused now, with a resume countdown) or `○`. */
function pauseLines(pauseWindows: any, inner: number, styler: any): { count: number; lines: string[] } {
  const lines: string[] = [];
  if (pauseWindows && pauseWindows.missing) { lines.push(styler.cell("(no pause windows · w to manage)", inner, { color: "dim" })); return { count: 0, lines }; }
  if (pauseWindows && pauseWindows.invalid) { lines.push(styler.cell(`(pause-windows file invalid: ${pauseWindows.invalid})`, inner, { color: "error" })); return { count: 0, lines }; }
  const list = (pauseWindows && pauseWindows.windows) ?? [];
  if (list.length === 0) { lines.push(styler.cell("(no pause windows · w to manage)", inner, { color: "dim" })); return { count: 0, lines }; }
  const now = Date.now();
  for (const w of list) lines.push(pauseRow(w, now, inner, styler));
  return { count: list.length, lines };
}

function pauseRow(w: any, now: number, inner: number, styler: any): string {
  const until = windowEndAt(w, now); // ms when this window resumes, or null when not active now
  const dot = until ? styler.fg("warning", "●") : styler.fg("dim", "○");
  const bits = [
    `${dot} ${styler.fg("accent", w.scope ?? "-")}`,
    styler.fg("text", `${w.from ?? "-"}–${w.to ?? "-"}`) + " " + styler.fg("dim", w.tz ?? "UTC"),
  ];
  if (w.days) bits.push(styler.fg("muted", `[${w.days.join(",")}]`));
  if (w.dateFrom || w.dateTo) bits.push(styler.fg("dim", `${w.dateFrom ?? "…"}→${w.dateTo ?? "…"}`));
  if (until) bits.push(styler.fg("warning", `resumes in ${humanizeMs(until - now) || "<1m"}`));
  return fitLine(bits.join(styler.fg("dim", "  ")), inner, styler);
}

/** The scoped limits (issue #242) as colored rows: used/cap per capped window, config-only concurrency. */
function limitLines(scopedLimits: any, scopedBudget: any, inner: number, styler: any): { count: number; lines: string[] } {
  const lines: string[] = [];
  if (scopedLimits && scopedLimits.missing) { lines.push(styler.cell("(no scoped limits · m to manage)", inner, { color: "dim" })); return { count: 0, lines }; }
  if (scopedLimits && scopedLimits.invalid) { lines.push(styler.cell(`(scoped-limits file invalid: ${scopedLimits.invalid})`, inner, { color: "error" })); return { count: 0, lines }; }
  const list = (scopedLimits && scopedLimits.limits) ?? [];
  if (list.length === 0) { lines.push(styler.cell("(no scoped limits · m to manage)", inner, { color: "dim" })); return { count: 0, lines }; }
  list.forEach((l: any, i: number) => lines.push(limitRow(l, scopedBudget?.rows?.[i] ?? null, inner, styler)));
  return { count: list.length, lines };
}

function limitRow(l: any, used: any, inner: number, styler: any): string {
  // The dot goes amber when any capped window's used count has reached its cap (the next job refuses
  // scope-cap). Concurrency never drives the dot: per-scope in-flight is worker-process state this
  // panel cannot see, and the panel never invents a number -- `≤K at once` is config, stated as such.
  let atCap = false;
  const windows: string[] = [];
  for (const key of ["day", "week", "month"]) {
    if (!Number.isInteger(l[key])) continue;
    const u = used && Number.isFinite(used[key]) ? used[key] : null;
    const over = u !== null && u >= l[key];
    if (over) atCap = true;
    windows.push(styler.fg(over ? "warning" : "text", `${key} ${u ?? "-"}/${l[key]}`));
  }
  const dot = atCap ? styler.fg("warning", "●") : styler.fg("dim", "○");
  const bits = [`${dot} ${styler.fg("accent", l.scope ?? "-")}`, ...windows];
  if (Number.isInteger(l.concurrent)) bits.push(styler.fg("muted", `≤${l.concurrent} at once`));
  return fitLine(bits.join(styler.fg("dim", "  ")), inner, styler);
}


/**
 * `RUNS`, or `RUNS · 2 hosts`, or `RUNS · this host only`.
 *
 * The mirror's degradation channel is what distinguishes the last one from a single-host deployment, and
 * the two must not read alike: "off" on a fleet means the other hosts are below the version floor or their
 * Valkey writes are failing, and an operator reading a short list needs to know it is short.
 */
function runsTitle(snapshot: any): string {
  const hosts: string[] = Array.isArray(snapshot?.runHosts) ? snapshot.runHosts : [];
  if (hosts.length > 1) return `RUNS · ${hosts.length} hosts`;
  const mirror = snapshot?.runMirror;
  if (typeof mirror === "string" && mirror.startsWith("unreachable")) return "RUNS · this host only";
  return "RUNS";
}

/** The interactive RUNS list, colored: cursor, id, target, flow, outcome (✔/⚠/✘), turns, tokens.
 * A cursor-following viewport of RUNS_VIEWPORT rows over the (up to 50) records, with `↑/↓ N more` edge
 * markers -- the frame stays the same height no matter how many records the read model served. */
function runLines(rows: any[], selected: number, inner: number, styler: any): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [styler.cell("(no runs)", inner, { color: "dim" })];
  const { top, count } = runsWindow(rows.length, selected);
  const out: string[] = [];
  if (top > 0) out.push(styler.cell(`↑ ${top} more`, inner, { color: "dim" }));
  for (let i = top; i < top + count; i++) out.push(runRow(rows[i], i === selected, inner, styler));
  const below = rows.length - top - count;
  if (below > 0) out.push(styler.cell(`↓ ${below} more`, inner, { color: "dim" }));
  return out;
}

/** The viewport over the run rows: centered on the cursor, clamped to the ends. A cursor outside the runs
 * section (negative `selected`, i.e. still up in the triggers) anchors the window at the top. */
function runsWindow(len: number, selected: number): { top: number; count: number } {
  const count = Math.min(len, RUNS_VIEWPORT);
  const want = selected >= 0 ? selected - Math.floor(RUNS_VIEWPORT / 2) : 0;
  const top = Math.min(Math.max(0, want), len - count);
  return { top, count };
}

/**
 * The browsable URL for a run record's target, or null. Only github is derivable: the record's target is
 * `repo#number`, and `https://github.com/<repo>/issues/<n>` resolves for BOTH kinds -- GitHub redirects
 * issues/N to pull/N when N is a PR, so one shape covers issues and pull requests without the record
 * having to say which. Everything else is null ON PURPOSE: gitlab/azure/forgejo run against
 * operator-hosted instances whose hosts are unknowable from the record, and a guessed URL an operator
 * would click is worse than no link at all.
 */
export function targetUrl(record: any): string | null {
  if (record?.kind !== "github" || typeof record?.target !== "string") return null;
  const m = record.target.match(/^([^#\s]+)#(\d+)$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/issues/${m[2]}`;
}

function runRow(row: any, sel: boolean, inner: number, styler: any): string {
  const cursor = sel ? styler.fg("accent", "›") : " ";
  if (row.kind === "active") {
    return fitLine(`${cursor} ${styler.fg("success", "● ACTIVE")} ${styler.fg("text", row.jobId)} ${styler.fg("dim", "running")}`, inner, styler);
  }
  const r = row.record ?? {};
  const tree = r.chainDepth > 0 ? styler.fg("dim", "└ ") : "";
  // The replica badge sits beside the chain glyph because it answers the same question the glyph does --
  // "is this run one of a set, and which one" -- and a row that is silently one of two racing jobs is the
  // one misreading this list can produce. Absent on an unreplicated run, so today's rows are unchanged.
  const rep = r.replica > 0 ? styler.fg("warning", `r${r.replica}/${r.replicas ?? "?"} `) : "";
  const sep = styler.fg("dim", " · ");
  // The target cell is an OSC-8 hyperlink when the record yields a URL. PLAIN_THEME's `link` is a
  // byte-identical passthrough, so the monochrome path and every width test are untouched by
  // construction; under a real theme, stripAnsi/visibleLen already strip OSC-8, so the linked cell still
  // measures exactly its text width and fitLine stays honest.
  const url = targetUrl(r);
  const targetCell = styler.fg("muted", r.target ?? "-");
  const cells = [
    styler.fg("text", r.jobId ?? "-"),
    url === null ? targetCell : styler.link(targetCell, url),
    styler.fg("accent", r.flow ?? "-"),
    outcomeColored(r.outcome, r.reason, styler),
    styler.fg("dim", `${r.turns ?? "-"}t`),
    styler.fg("dim", Number.isFinite(r.tokens?.total) ? fmtTokens(r.tokens.total) : "-"),
  ];
  return fitLine(`${cursor} ${tree}${rep}${cells.join(sep)}`, inner, styler);
}

function outcomeColored(outcome: any, reason: any, styler: any): string {
  if (outcome === "completed") return styler.fg("success", "✔ done");
  if (outcome === "policy") return styler.fg("warning", `⚠ ${reason ?? "policy"}`);
  return styler.fg("error", `✘ ${reason ?? outcome ?? "failed"}`);
}

/** A compact colored settings summary (the full editor is the `s` drill-in). */
function settingsLines(settings: any, inner: number, styler: any): string[] {
  if (settings && settings.invalid) return [styler.cell(`settings invalid: ${settings.invalid}`, inner, { color: "error" })];
  const o = (settings && settings.overlay) ?? {};
  const kv = (k: string, v: any) => styler.fg("muted", k) + " " + styler.fg("text", v === undefined ? "·" : String(v));
  // Token caps render compact (5000000 -> "5M") so the limits line never clips on a narrower overlay.
  const tk = (k: string, v: any) => styler.fg("muted", k) + " " + styler.fg("text", Number.isInteger(v) ? fmtTokens(v) : "·");
  const pctVal = Number.isInteger(o.softHoldPct) ? `${o.softHoldPct}%` : "·";
  const gap = styler.fg("dim", "   ");
  const l1 = [kv("model", o.model), kv("provider", o.provider), kv("maxTurns", o.maxTurns), tk("maxTokens", o.maxTokens)].join(gap);
  const l2 = [kv("dailyCap", o.dailyCap), tk("dailyTokenCap", o.dailyTokenCap), kv("concurrency", o.concurrency), styler.fg("muted", "softHold") + " " + styler.fg("text", pctVal)].join(gap);
  return [fitLine(l1, inner, styler), fitLine(l2, inner, styler)];
}

/**
 * The TRIGGER_DETAIL drill-in, three scannable sections: MATCHES (what fires it), RUNS (what it produces),
 * and a per-kind TRUST MODEL. The flow lives once in the header, so the sections carry only distinct facts —
 * no crammed "produces" line. Read-only; `e`/`x` drive edit/delete through the command loop. Every line is
 * `inner` cols.
 */
function renderTriggerDetail(t: any, inner: number, styler: any, sched: any = null, staged: any = null): string[] {
  if (!t) return [styler.cell("(no trigger)", inner, { color: "dim" })];
  const out: string[] = [];
  const kv = (k: string, v: string, color = "text") =>
    fitLine(styler.cell(k, 12, { color: "muted" }) + " " + styler.fg(color, v), inner, styler);
  const blank = () => out.push(styler.cell("", inner));
  const section = (label: string) => out.push(styler.divider(label, null, inner));

  // Header: kind badge -> flow, plus a health marker for cron (✔ healthy / ⚠ overdue) derived from the
  // scheduler's overdueMs. A trigger with no matching scheduler shows no health marker rather than a guess.
  let header = styler.fg(KIND_COLOR[t.type] ?? "muted", t.type ?? "?") + "  " + styler.bold(styler.fg("text", `→ ${t.flow ?? commandSlashLabel(t) ?? "-"}`));
  if (t.type === "cron" && sched) {
    const healthy = !sched.overdueMs;
    header += "   " + (healthy ? styler.fg("success", "✔ healthy") : styler.fg("warning", `⚠ overdue ${formatDuration(sched.overdueMs)}`));
  }
  out.push(fitLine(header, inner, styler));

  // MATCHES — the condition that fires this trigger.
  blank();
  section("matches");
  if (t.type === "cron") {
    out.push(kv("schedule", `${t.pattern ?? "-"}`));
    // next fire + countdown, and drift/stalls, from the resident scheduler + the stall backstop counter.
    // `next` is real (BullMQ scheduler); `last` fire time is not stored on the scheduler, so it is omitted
    // rather than faked. Absent scheduler -> next unknown.
    if (sched) {
      const inMs = typeof sched.next === "number" ? sched.next - Date.now() : NaN;
      const next = typeof sched.next === "number" ? `${formatTs(sched.next)} (${humanizeMs(inMs) ? `in ${humanizeMs(inMs)}` : "due"})` : "—";
      out.push(kv("next fire", next, "accent"));
      const drift = sched.overdueMs ? formatDuration(sched.overdueMs) : "0s";
      out.push(kv("health", `drift ${drift} · stalls ${sched.stalls}/${sched.stallMax}`, sched.overdueMs ? "warning" : "success"));
    }
  } else if (t.type === "label" || t.type === "pull_request") {
    if (t.type === "pull_request") out.push(kv("PR actions", (t.action ?? []).join(", ") || "-"));
    // A close-only rule's narrowing and one-shot state render here too (issue #231): the list row
    // shows both, and this detail view must not tell less than the row it drills into.
    if (t.type === "pull_request" && Number.isInteger(t.number)) out.push(kv("item", `#${t.number}`, "success"));
    if (t.once === true) out.push(kv("one-shot", t.disarmed ? `spent ${t.disarmed.at ?? "-"}${t.disarmed.jobId ? ` by ${t.disarmed.jobId}` : ""}` : "armed", t.disarmed ? "dim" : "accent"));
    out.push(kv("any of", (t.any ?? []).join(" · ") || "-", "success"));
    out.push(kv("all of", (t.all ?? []).join(" · ") || "-", "success"));
    out.push(kv("none of", (t.none ?? []).join(" · ") || "-", "error"));
  } else if (t.type === "comment") {
    out.push(kv("phrase", `"${t.phrase ?? "-"}"`));
  } else if (t.type === "issue") {
    // The close-trigger kind (issue #231): the action word, the item it is narrowed to, and the
    // one-shot state. `spent` renders dim rather than warning: a spent one-shot is a rule that
    // finished its job, not a risk.
    out.push(kv("issue actions", (t.action ?? []).join(", ") || "-"));
    if (Number.isInteger(t.number)) out.push(kv("item", `#${t.number}`, "success"));
    if (t.once === true) out.push(kv("one-shot", t.disarmed ? `spent ${t.disarmed.at ?? "-"}${t.disarmed.jobId ? ` by ${t.disarmed.jobId}` : ""}` : "armed", t.disarmed ? "dim" : "accent"));
  }

  // RUNS — what it produces when it fires. One fact per row.
  blank();
  section("runs");
  if (t.type === "cron") {
    out.push(kv("job", "local", "success"));
    out.push(kv("folder", `${t.folder ?? "-"}`, "success"));
    out.push(kv("model", t.model ?? "deployment default", t.model ? "accent" : "dim"));
  } else {
    // The forge is read from the entry, never assumed: with two forges configured, "which one does this
    // trigger listen to" is the first question the drill-in has to answer, and guessing github would be
    // wrong for half the file.
    out.push(kv("job", t.forge ?? "-", "accent"));
    out.push(kv("target", forgeTargetLabel(t?.forge), "accent"));
    out.push(kv("model", "deployment default", "dim"));
  }
  // A command trigger's full `/name args` line (issue #189): the list and header show the name only,
  // and this drill-in is where the args belong -- the reviewed file staged them, the operator's own
  // session shows them. Rendered only when armed, on both branches, because all four kinds can carry
  // a command; a flow trigger's pane stays byte-identical.
  if (typeof t.command === "string" && t.command.trim() !== "") out.push(kv("command", `/${t.command.trim()}`, "accent"));
  // Same shape as the model row -- a per-trigger override of a deployment default -- and rendered on BOTH
  // branches, because unlike model, all four kinds can carry an image. The dim "deployment default" is
  // deliberate rather than an omitted row: a missing row would read as "I don't know", this reads as
  // "I checked". Which image runs is which code runs, so it is not a fact to leave implicit.
  out.push(kv("image", t.image ?? "deployment default", t.image ? "accent" : "dim"));
  // #227, and it earns its row by the same argument the image row states: the dim "deployment default" is
  // "I checked". Where the box was BUILT bounds what the box can be, so it is not a fact to leave implicit
  // -- and without this row an operator has no surface anywhere (panel, run record, success log) on which
  // to confirm a venue their trigger named.
  out.push(kv("backend", t.backend ?? "deployment default", t.backend ? "accent" : "dim"));
  // Rendered on BOTH branches and on every kind, with the same "I checked" dim default the image row uses.
  // `warning` when armed, because this is the one row on this pane that describes something LEAVING the
  // job: everything above says what the job runs, this says what it writes down and hands to the next one.
  out.push(kv("resume", t.resume === true ? "continues the previous session" : "cold start", t.resume === true ? "warning" : "dim"));
  // The same "I checked" dim default, for the one field on this pane that changes what a delivery COSTS
  // (REQ-REPLICA-RUNS). `warning` when armed: this row is a multiplier, and a multiplier that renders like
  // a preference is the polarity mistake 0.1.4 shipped a fix for on [packages].
  out.push(kv("replicas", t.replicas > 1 ? `${t.replicas} sandboxes race this flow` : "one run per delivery", t.replicas > 1 ? "warning" : "dim"));

  // TRUST MODEL — who authorizes it, how it dedups, which service owns it.
  blank();
  section("trust model");
  for (const line of trustModel(t)) out.push(fitLine(styler.fg("border", "· ") + styler.fg("text", line), inner, styler));
  // A trigger that did not decline (`run.packages: false`) additionally loads the operator-staged
  // third-party pi packages into the job — name+version, so the operator sees exactly which pinned code this
  // trigger runs, plus the one-line consequence. Display only: declining is an edit to the reviewed triggers
  // file, never a panel key.
  if (t.packages === true) {
    const loads = (text: string) => out.push(fitLine(styler.fg("border", "· ") + styler.fg("warning", text), inner, styler));
    loads(`packages loaded · ${stagedNames(staged)}`);
    loads("third-party code on adversarial input, open network egress");
  }
  // The disclosure, stated where an operator is already reading the trust model rather than only in
  // SECURITY.md. A transcript is strictly MORE PII-bearing than the raw job log, which is opt-in and off
  // by default for exactly this reason -- and unlike that log it must exist for the feature to work.
  if (t.resume === true) {
    const keeps = (text: string) => out.push(fitLine(styler.fg("border", "· ") + styler.fg("warning", text), inner, styler));
    keeps("persists the agent transcript to PI_SESSIONS_DIR");
    keeps("issue text, file contents, tool output, the agent's own reasoning");
    keeps("replayed into the next job on the same branch; forks never resume");
  }
  // The sharpest disclosure on this panel, and it belongs where an operator is already reading the trust
  // model. [image] and [skills] change what the agent can DO; this changes what it can REACH. The COUNT and
  // the profile NAME, never the references: this view renders on the operator's own host, but the same
  // record feeds the model-callable read tool, and a reference list is the map of their vault.
  if (t.secrets > 0) {
    const holds = (text: string) => out.push(fitLine(styler.fg("border", "· ") + styler.fg("warning", text), inner, styler));
    holds(`${t.secrets} vault secret(s) injected${t.secretsProfile ? ` via profile ${t.secretsProfile}` : ""}`);
    holds("resolved on the host before the container; the job holds no vault credential");
    holds("the agent can read them, and the forge is on the egress allowlist");
  }
  // Stated beside the trust model rather than only in docs/replicas.md, because the multiplier is the whole
  // of what an operator needs to weigh: N replicas is N HONEST budget reservations, not a bypass, so the
  // daily/weekly/monthly caps stay the ceiling and simply divide by N (CONST-BUDGET-BEFORE-TOKENS).
  if (t.replicas > 1) {
    const races = (text: string) => out.push(fitLine(styler.fg("border", "· ") + styler.fg("warning", text), inner, styler));
    races(`each delivery starts ${t.replicas} independent jobs`);
    races(`${t.replicas} budget slots reserved, ${t.replicas}× the tokens, ${t.replicas} pull requests`);
    races("nothing cancels a sibling; a human picks the better result");
  }
  return out;
}

/** The staged `name@version` list for the armed trust-model line, or the nothing-staged notice. */
function stagedNames(staged: any): string {
  const list = Array.isArray(staged?.packages) ? staged.packages : [];
  return list.length > 0 ? list.join(" · ") : "(none staged in the overlay)";
}

/** The static per-kind trust model (who authorizes it, how it dedups, which service owns it). */
/** What the target of a forge trigger is called, in that forge's own notation. */
function forgeTargetLabel(forge: string | null | undefined): string {
  if (forge === "gitlab") return "the triggering project#issue / !MR";
  if (forge === "azure") return "the triggering project/repo#work-item / !PR";
  return "the triggering repo#issue / PR";
}

/**
 * How this trigger is authorized, deduplicated, and where it runs — per forge, because the answers really
 * do differ and the panel is where an operator checks them.
 *
 * These lines were GitHub's for every webhook kind: they said "HMAC" and "X-GitHub-Delivery GUID" on a
 * gitlab trigger, and would have said it on an azure one, where BOTH are false -- Azure has no HMAC at all
 * and no delivery-id header. A trust model that is wrong is worse than one that is absent, because an
 * operator reads it to decide whether they are comfortable.
 */
function trustModel(t: any): string[] {
  if (t?.type === "cron") {
    return [
      "authorized by the operator's triggers file, at boot",
      "dedup by time — deterministic repeat:<id>:<millis> id",
      "lives in the worker · task is operator-authored",
    ];
  }
  const subject = t?.type === "comment" ? "adversarial comment text" : "adversarial issue/PR text";
  const where = `lives in the receiver · task is ${subject}`;
  // A close-capable rule (the issue kind, or a pull_request whose action is the forge's close word —
  // the loader makes the close word ride alone) is gated on the CLOSER, and a one-shot's spend is
  // bookkept by the worker. Both join the per-forge lines: who may spend the trigger and who writes
  // the disarm are exactly what an operator reads this panel to learn (issue #231).
  const closeCapable = t?.type === "issue" || (t?.type === "pull_request" && (t?.action ?? []).some((a: string) => a === "closed" || a === "close"));
  const oneShot = (lines: string[]) =>
    closeCapable && (t?.once === true || t?.disarmed)
      ? [...lines, "one-shot: the WORKER writes on.disarmed into triggers.json, strictly after the run record — spent always has its run"]
      : lines;
  switch (t?.forge) {
    case "gitlab":
      return oneShot([
        "authorized by the actor's resolved project access level (>= Developer) — a label is NOT approval here",
        "HMAC over the body (19.0+) or a bare X-Gitlab-Token · dedup by webhook-id",
        where,
      ]);
    case "forgejo":
      return oneShot([
        "authorized by the actor's resolved repository permission (admin|write), on every trigger type",
        "HMAC over the body (GitHub-compatible) · dedup by X-GitHub-Delivery GUID",
        where,
      ]);
    case "azure":
      return oneShot([
        "authorized by the actor's resolved project membership — work items name the actor only by email",
        "NO HMAC: a shared secret that covers no bytes · dedup by the payload's own id (OQ-015)",
        where,
      ]);
    default:
      return oneShot([
        // A review trigger reads the REVIEWER's author_association, not the PR author's (issue #66), so it
        // cannot share the generic line: an operator reading "author gate" would picture the wrong person.
        // A close rule reads the CLOSER's resolved permission (issue #231), for the inversion's sharper
        // sibling: GitHub sends NO association for a close at all, so the collaborator-label line would
        // name a gate this rule never runs — and a wrong trust model is worse than an absent one.
        closeCapable
          ? "authorized by the CLOSER's resolved repository permission (admin|write) + HMAC — a close names no author_association"
          : t?.type === "comment"
            ? "authorized by a collaborator comment (author_association) + HMAC"
            : t?.type === "pull_request" && (t?.action ?? []).includes("review_submitted")
              ? "authorized by the REVIEWER's author_association (not the PR author's) + HMAC"
              : "authorized by a collaborator's label + HMAC webhook + author gate",
        "dedup by X-GitHub-Delivery GUID (redelivery-safe)",
        where,
      ]);
  }
}

/** The TRIGGER_DETAIL footer hints; with a delete armed, the footer IS the question. */
function triggerDetailHints(inner: number, styler: any, pendingDelete = false): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  if (pendingDelete) {
    return fitLine(styler.fg("warning", "delete this trigger?") + "  " + [k("y", "confirm"), k("n", "cancel")].join(styler.fg("dim", "  ·  ")), inner, styler);
  }
  return fitLine([k("e", "edit flow"), k("x", "delete"), k("esc", "back")].join(styler.fg("dim", "  ·  ")), inner, styler);
}

/** The colored key-hint footer. The labels stay COMPRESSED -- the select/open pair shares one hint --
 * so the full row fits a width-80 frame (inner 76) with no ellipsis; the fit is pinned by the
 * dashboard test, so a new hint here must pay for itself in label characters. */
function keyHints(inner: number, styler: any): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  // The arithmetic is the review gate against a width-80 frame (inner 76): labels 51 + six
  // separators × 3 = 69 visible columns, 7 of headroom. `i insights` (issue #181) replaced the
  // `c costs`/`g graph` pair when the analytics views left the terminal for the page, which is how
  // the row got its headroom back. A new hint must re-run this arithmetic, or the footer clips and
  // a key silently disappears.
  const hints = [k("↑↓", "open"), k("a", "add"), k("w", "pauses"), k("l", "logs"), k("i", "insights"), k("p/r", "pause"), k("q", "quit")].join(styler.fg("dim", " · "));
  return fitLine(hints, inner, styler);
}

/** ms until the next UTC midnight / Monday 00:00 UTC / month-1 00:00 UTC. */
function nextDayResetMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime();
}
function nextWeekResetMs(now: Date): number {
  const daysUntilMon = ((1 - now.getUTCDay() + 7) % 7) || 7;
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMon) - now.getTime();
}
function nextMonthResetMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime();
}

/** A bare positive span as "9h 54m" / "12m" / "3d"; "" when unknown or non-positive. */
function humanizeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin >= 2 * 1440) return `${Math.round(totalMin / 1440)}d`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "resets 9h 54m" / "resets 12m" / "" when unknown -- the spend-window reset countdown. */
function countdownText(ms: number): string {
  const h = humanizeMs(ms);
  return h ? `resets ${h}` : "";
}

/**
 * The selectable LIST rows: the optional ACTIVE row first (present only when the snapshot carries an
 * id-only `activeJobId`), then one row per run record. `selected` and up/down span this array; Enter
 * dispatches on `kind`. A null or malformed snapshot yields an empty list. No `.log`, no `.data` -- the
 * ACTIVE row carries only the id-only job id.
 */
function buildRows(snapshot: any, runSort = "time"): any[] {
  // Triggers lead the selectable list (Enter -> TRIGGER_DETAIL), then the optional ACTIVE row, then runs.
  // A trigger row carries its RAW file `index` -- the one every display record now carries (issue #54)
  // -- so a CRUD action targets the right entry in triggers.json even when the display dropped an
  // unusable row above it. The display POSITION this used before was a live-fire wrong-delete: one
  // garbage entry at row 0 and `x`+`y` on the visible trigger deleted the garbage while the real
  // trigger kept firing, reported as deleted (review finding). Falls back to the position only for a
  // record predating the field, where it is the best available claim.
  const triggers = (snapshot?.triggers?.triggers ?? []).map((t: any, i: number) => ({ kind: "trigger", trigger: t, index: Number.isInteger(t?.index) ? t.index : i }));
  const active = snapshot?.activeJobId ? [{ kind: "active", jobId: snapshot.activeJobId }] : [];
  const runs = (Array.isArray(snapshot?.runs) ? snapshot.runs : []).map((record: any) => ({ kind: "run", record }));
  return [...triggers, ...active, ...sortRuns(runs, runSort)];
}

/** Re-order the run rows for the `o` cycle. Absent numbers sort LAST under tokens/cost (a pre-metering
 * record is not a cheap one, it is an unknown one); "outcome" puts failures first, the triage order.
 * "time" returns the rows untouched -- listRuns' endedAt-descending order is already the time sort. */
function sortRuns(rows: any[], runSort: string): any[] {
  if (runSort === "time" || rows.length < 2) return rows;
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : -1);
  const outcomeRank = (r: any) => (r?.outcome === "completed" ? 2 : r?.outcome === "policy" ? 1 : 0);
  const sorted = [...rows];
  if (runSort === "tokens") sorted.sort((a, b) => num(b.record?.tokens?.total) - num(a.record?.tokens?.total));
  else if (runSort === "cost") sorted.sort((a, b) => num(b.record?.tokens?.cost) - num(a.record?.tokens?.cost));
  else if (runSort === "outcome") sorted.sort((a, b) => outcomeRank(a.record) - outcomeRank(b.record));
  return sorted;
}

/**
 * The interactive RUNS list over the rows model: one compact row per entry, cursor-prefixed (`›` on the
 * selected row, space otherwise). The ACTIVE row leads with its id-only job id; run rows lead with `jobId`
 * so a jobId match still hits. Each row is `clip`ped to the inner column count so a long target can neither
 * overflow the frame nor mis-size a row. Operates only on the passed rows -- no read, no `.log`, no `.data`.
 */
function renderRunList(rows: any[], selected: number, w: number): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [clip("(no runs)", w)];
  // The plain twin of runLines' viewport, with ASCII edge markers -- the windowing is a fact about which
  // rows are visible, and the monochrome panel must not silently show a different set than the colored one.
  const { top, count } = runsWindow(rows.length, selected);
  const out: string[] = [];
  if (top > 0) out.push(clip(`^ ${top} more`, w));
  for (let i = top; i < top + count; i++) {
    const row = rows[i];
    const cursor = i === selected ? "›" : " ";
    if (row.kind === "active") {
      out.push(clip(`${cursor} * ACTIVE ${row.jobId} running`, w));
      continue;
    }
    const run = row.record;
    // The plain twin of the colored badge in `runRow`. It has to be here too: this is the renderer a
    // non-TTY/no-color panel uses, and "one of two racing runs" must not be a fact only the pretty one tells.
    const rep = run?.replica > 0 ? `r${run.replica}/${run.replicas ?? "?"} ` : "";
    const cells = [run?.jobId, run?.target, run?.flow, run?.outcome, run?.turns, run?.tokens?.total]
      .map((f) => (f === null || f === undefined ? "-" : String(f)))
      .join(" · ");
    out.push(clip(`${cursor} ${rep}${cells}`, w));
  }
  const below = rows.length - top - count;
  if (below > 0) out.push(clip(`v ${below} more`, w));
  return out;
}

/** The indices of tail lines containing `query` (case-insensitive substring) -- the LIVE_TAIL search
 * model, computed over the held tail bytes alone, so search reads nothing the view does not already. */
function tailMatches(lines: any[], query: string): number[] {
  const q = String(query).toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (String(lines[i]).toLowerCase().includes(q)) out.push(i);
  }
  return out;
}

/**
 * The LIVE_TAIL view: a bounded, scrollable window of a running job's captured `.log`, framed in the
 * overlay. The tail bytes arrive here only through render() -> this pure function and are returned as
 * overlay lines; they never enter `snapshot`, a shared renderer, or `sendMessage` (INT-RUN-HISTORY-FILE-CONTRACT).
 * Four states: capability absent, no captured log, the windowed tail, and the tail after the job left the
 * active slot. `tailTop` is clamped to `[0, maxTop]` so a shrunk log cannot scroll past the end.
 *
 * The tail state frames through `frame` (not panel's box) because the search bar's cursor and the match
 * highlight are escapes box's own clip would strip; under PLAIN_THEME the two framers are byte-identical
 * for this content, so the plain path is unchanged. The ORDER inside is the security seam: every
 * untrusted tail byte passes through `clip` FIRST -- control-strip plus width -- and the warning color
 * wraps the ALREADY-clipped text, so a stray escape in the log still dies in clip and the highlight can
 * never carry raw bytes past it.
 */
function renderLiveTail({ snapshot, framed, width, tailJobId, tail, tailTop, tailFollow, tailAvailable, tailSearchInput, tailQuery, tailMatchLine, styler }: any): string[] {
  const boxTitle = `live ${tailJobId}`;
  if (tail === null && !tailAvailable) {
    const lines = ["live tail unavailable in this build"];
    if (!framed) return [boxTitle, "", ...lines, "", "Esc back"];
    return box({ title: boxTitle, footer: "Esc back", width, sections: [{ lines }] });
  }
  if (tail?.missing) {
    const lines = [`live ${tailJobId} -- no captured log (PI_CAPTURE_JOB_LOGS off or not found)`];
    if (!framed) return [boxTitle, "", ...lines, "", "Esc back"];
    return box({ title: boxTitle, footer: "Esc back", width, sections: [{ lines }] });
  }
  const all = Array.isArray(tail?.lines) ? tail.lines : [];
  const len = all.length;
  const maxTop = Math.max(0, len - TAIL_VIEWPORT);
  const top = Math.min(Math.max(0, tailTop), maxTop);
  const ended = snapshot?.activeJobId !== tailJobId;
  // The state is named, not implied: a paused tail reads "paused", so stale lines cannot pass as live.
  let footer = `[${Math.min(top + TAIL_VIEWPORT, len)}/${len}] ${tailFollow ? "follow" : "paused"} · Up/Down PgUp/PgDn scroll, Esc back`;
  // An armed query joins the footer with its match position (`/err · 3/7`; 0/N before the first jump),
  // or the honest `no match` -- the search state must be readable without guessing.
  if (tailQuery !== null) {
    const matches = tailMatches(all, tailQuery);
    const pos = tailMatchLine !== null ? matches.indexOf(tailMatchLine) + 1 : 0;
    footer += matches.length === 0 ? ` · /${tailQuery} · no match` : ` · /${tailQuery} · ${pos}/${matches.length}`;
  }
  if (!framed) {
    const plain = [`live ${tailJobId} -- ${len} line(s)`, ...all.slice(top, top + TAIL_VIEWPORT)];
    if (ended) plain.push("(run ended -- Esc to go back)");
    if (tailSearchInput) plain.push("/ " + tailSearchInput.value());
    return [boxTitle, "", ...plain, "", footer];
  }
  const inner = Math.trunc(width) - 4;
  const lines: any[] = [clip(`live ${tailJobId} -- ${len} line(s)`, inner)];
  for (let i = top; i < Math.min(top + TAIL_VIEWPORT, len); i++) {
    // clip FIRST (the untrusted-byte gate), color the clipped text second -- see the doc comment above.
    const safe = clip(all[i], inner);
    lines.push(tailQuery !== null && i === tailMatchLine ? styler.fg("warning", safe) : safe);
  }
  // The job left the active slot (ended, or a different job now runs): keep showing the last tail.
  if (ended) lines.push(clip("(run ended -- Esc to go back)", inner));
  // The search bar is the view's last body line, layered-input style: a 2-col `/ ` sigil plus the focused
  // line input (inverse-video cursor via styler.lineInput) filling the rest.
  if (tailSearchInput) lines.push(styler.fg("accent", "/ ") + styler.lineInput(tailSearchInput, Math.max(1, inner - 2)));
  return frame(styler, { title: boxTitle, width: Math.trunc(width), lines, footer: clip(footer, inner) });
}

/**
 * The RUN_DETAIL post-mortem: one run's PII-free record rendered as a colored, grouped drill-in (following
 * the design mock) -- outcome, target, timing (+ duration), turns/exit/budget, tokens/cost, and a chain line
 * that names spawned children found in the run window. Operates only on the passed record and the runs list
 * already in the snapshot: no read, no `.log`, no `.data` -- exactly the PII-free run-history fields
 * (INT-RUN-HISTORY-FILE-CONTRACT). Every line is `inner` cols; a missing field renders `-` rather than throw.
 */
function renderRunDetail(record: any, inner: number, styler: any, allRuns: any[] = [], sandbox: any = null): string[] {
  const r = record ?? {};
  const show = (v: any): string => (v === null || v === undefined ? "-" : String(v));
  const out: string[] = [];
  const kv = (k: string, v: string, color = "text") =>
    fitLine(styler.cell(k, 12, { color: "muted" }) + " " + styler.fg(color, v), inner, styler);

  // Header: colored outcome glyph + word, plus the reason when it is not a clean completion.
  const oc = String(r.outcome ?? "-");
  const outcomeColor = oc === "completed" ? "success" : oc === "policy" ? "warning" : "error";
  const glyph = oc === "completed" ? "✔" : oc === "policy" ? "⚠" : "✘";
  let head = styler.bold(styler.fg(outcomeColor, `${glyph} ${oc}`));
  if (r.reason) head += styler.fg("dim", ` · ${r.reason}`);
  out.push(fitLine(head, inner, styler));
  out.push(styler.cell("", inner));

  // The target is an OSC-8 hyperlink when the record's forge yields one (targetUrl; github only). Only
  // the target itself is linked, not the flow riding the same line -- and under PLAIN_THEME `link` is a
  // byte-identical passthrough, so the plain drill-in and its width math are untouched by construction.
  const url = targetUrl(r);
  const targetPart = url === null ? styler.fg("accent", show(r.target)) : styler.link(styler.fg("accent", show(r.target)), url);
  out.push(fitLine(styler.cell("target", 12, { color: "muted" }) + " " + targetPart + styler.fg("accent", ` · flow ${show(r.flow)}`), inner, styler));

  // timing: start -> end (+ duration when both timestamps resolve; they may be ms or ISO strings).
  const startMs = toMs(r.startedAt);
  const endMs = toMs(r.endedAt);
  const dur = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? ` (${formatDuration(endMs - startMs)})` : "";
  out.push(kv("timing", `${fmtStamp(r.startedAt)} → ${fmtStamp(r.endedAt)}${dur}`));
  // WHICH MACHINE, beside WHEN (issue #57). A drill-in line rather than a list column, deliberately: the
  // list row composes six cells into one `fitLine(..., inner)` and a seventh competes with the job id and
  // the target for the same budget, clipping silently at width 80 -- while this pane is variable-length
  // and framed at DRILL_WIDTH. Absent on records written before the field existed, and on a deployment
  // that never declared a name, so a single-host drill-in is byte-identical.
  if (r.host) out.push(kv("host", String(r.host)));

  // turns · exit · budget slot · attempt (each present only when the field is).
  const turnBits = [`${show(r.turns)} turns`, `exit ${show(r.exitCode)}`];
  if (r.budgetReserved !== null && r.budgetReserved !== undefined) turnBits.push(`${r.budgetReserved} budget slot`);
  if (r.attempt !== null && r.attempt !== undefined) turnBits.push(`attempt ${r.attempt}`);
  out.push(kv("turns", turnBits.join(" · ")));

  // Per-job token accounting (issue #25): total + cost-USD, or `-` when the container died before reporting.
  const cost = typeof r.tokens?.cost === "number" ? ` · $${r.tokens.cost.toFixed(4)}` : "";
  out.push(kv("tokens", `${show(r.tokens?.total)}${cost}`));

  // The share of that total spent by subagent sessions a staged package spawned in-process, from the
  // runner's process-wide metering. Records written BEFORE metering carry no `otherTotal`, so the line
  // appears only for a positive number -- never a NaN, and never a bare 0 on a pre-metering record.
  const otherTotal = r.tokens?.otherTotal;
  if (typeof otherTotal === "number" && Number.isFinite(otherTotal) && otherTotal > 0) {
    out.push(kv("of which", `subagents: ${otherTotal}`, "dim"));
  }

  // chain: root vs child, depth, spawned children (scanned from the run window -- best-effort, no new I/O),
  // and refused-child count.
  const children = (Array.isArray(allRuns) ? allRuns : []).filter((x) => x?.parentJobId && r.jobId && x.parentJobId === r.jobId);
  const chainBits = [r.parentJobId ? `child of ${r.parentJobId}` : "root"];
  if (r.chainDepth !== null && r.chainDepth !== undefined) chainBits.push(`depth ${r.chainDepth}`);
  if (children.length > 0) chainBits.push(`spawned ${children.length} → ${children.map((c) => c.jobId).join(", ")}`);
  if (r.chainRefused) chainBits.push(`${r.chainRefused} refused`);
  out.push(kv("chain", chainBits.join(" · ")));

  // replica: which member of a racing set this run is, and which siblings the scan `chain` already does can
  // see. Matched on target + flow + a DIFFERENT index -- the same fields the semantic dedup key uses, so
  // "same subject, same flow, other sandbox" is exactly what it finds. Best-effort like `chain`: the window
  // is the runs already in the snapshot, so a sibling that aged out is simply not named. The line appears
  // only for a replica run, so an ordinary post-mortem is unchanged.
  if (r.replica > 0) {
    const sibs = (Array.isArray(allRuns) ? allRuns : []).filter(
      // `kind` is load-bearing since #187, not decoration: `target` is repo + separator + number, and
      // targetFor renders github and forgejo with the SAME `#`, so a github `o/r#5` and a forgejo `o/r#5`
      // are one string. While only github could replicate, no two replica runs could collide; now they can,
      // and naming a stranger's job as your sibling is worse than naming none.
      (x) => x?.replica > 0 && x.replica !== r.replica && x.kind === r.kind && x.target === r.target && x.flow === r.flow,
    );
    const repBits = [`r${r.replica}/${r.replicas ?? "?"}`];
    repBits.push(sibs.length > 0 ? `sibling ${sibs.map((s) => `r${s.replica} ${s.jobId}`).join(", ")}` : "no sibling in this window");
    out.push(kv("replica", repBits.join(" · "), "warning"));
  }

  // REQ-RESURRECTABLE-SANDBOX. A retention state, never a path: the manifest holds a host path (which on
  // Windows embeds the operator's account name) and this view is the one that renders beside PII-free
  // record fields, so only the verdict crosses.
  if (sandbox) {
    const state = sandbox.retained
      ? `${sandbox.running ? "running" : "retained"}${sandbox.expiresIn ? ` · ${sandbox.expiresIn} left` : ""}`
      : (sandbox.reason ?? "swept");
    out.push(kv("sandbox", state, sandbox.retained ? "success" : "dim"));
  }

  out.push(styler.cell("", inner));
  out.push(styler.divider("post-mortem", null, inner));
  out.push(fitLine(styler.fg("dim", "container torn down at job end · stored PII-free fields + optional raw-log overlay only"), inner, styler));
  return out;
}

/**
 * Join a cron trigger to its resident scheduler + stall counter for the drill-in's next/health fields. Matches
 * by scheduler key/name === the cron id, else by pattern. Returns null for a non-cron trigger or no match, so
 * the detail view renders only real schedule data (`next` is the BullMQ scheduler's; `stalls` the money
 * backstop's). `last` is not stored on the scheduler and is deliberately not shown rather than faked.
 */
function cronSchedInfo(t: any, snapshot: any): any {
  if (t?.type !== "cron") return null;
  const schedulers = Array.isArray(snapshot?.schedulers) ? snapshot.schedulers : [];
  const s = schedulers.find((x: any) => (t.id && (x.key === t.id || x.name === t.id)) || (t.pattern && x.pattern === t.pattern));
  if (!s) return null;
  const stalls = Number(snapshot?.schedulerStalls?.[t.id] ?? 0) || 0;
  const stallMax = Number.isFinite(snapshot?.schedulerStallMax) ? snapshot.schedulerStallMax : 2;
  return { next: s.next, overdueMs: s.overdueMs, stalls, stallMax };
}

/** Coerce a timestamp field (ms number or ISO string) to ms, or NaN when it cannot resolve. */
function toMs(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v);
  return NaN;
}

/** A stored timestamp for display: `—` when absent, else a compact UTC stamp (parsing an ISO string), or the
 * string verbatim when it does not parse. Keeps the timing line short enough to carry its duration. */
function fmtStamp(v: any): string {
  if (v === null || v === undefined) return "—";
  const ms = toMs(v);
  return Number.isFinite(ms) ? formatTs(ms) : String(v);
}

/** A timestamp (ms) as compact UTC `YYYY-MM-DD HH:MM`; `—` when not a finite number. */
function formatTs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** A span in ms as `45s` / `1m 32s` / `2h 3m`; `0s` when not a positive finite number. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * The RUN_DETAIL footer hint. Still a read-only post-mortem, with two actions: `b` re-opens this run's
 * sandbox, offered ONLY while a retained workspace exists, and `y` copies -- offered only when the OSC 52
 * seam is wired, the same capability pattern, so neither key is ever advertised where it would do nothing
 * (`triggerDetailHints` is the shape). A fresh copy's acknowledgment leads the line and is gone by the
 * next input.
 */
function runDetailHints(inner: number, styler: any, canOpen = false, canCopy = false, copiedNote: any = null): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  const bits = [k("←→", "prev/next")];
  if (canOpen) bits.push(k("b", "sandbox"));
  if (canCopy) bits.push(k("y", "copy"));
  bits.push(k("esc", "back"));
  const line = bits.join(styler.fg("dim", "  ·  "));
  if (copiedNote) return fitLine(styler.fg("success", copiedNote) + styler.fg("dim", "  ·  ") + line, inner, styler);
  return fitLine(line, inner, styler);
}
