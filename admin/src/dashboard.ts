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
 * fields; LIVE_TAIL -- a tail of a running job's `.log`; TRIGGER_DETAIL -- one trigger's trust model;
 * COSTS (issue #53) -- the read-time cost fold over the run sidecars and declared subscriptions; and
 * GRAPH (issue #54) -- the trigger/flow topology, rendered from the same assembled model as
 * `/dispatch graph`, refreshed only on entry and on `r` (the enumeration spawns git per folder).
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): LIST and RUN_DETAIL surface only
 * PII-free run records, counts, budget, schedulers and the settings overlay. LIVE_TAIL renders tail bytes
 * obtained through the injected `tailLog` seam whose `fs` access lives in index.ts, so this module never
 * touches the filesystem -- the bytes reach the overlay alone, never `snapshot`, never a shared renderer,
 * never a message.
 */
import { dayKey, weekKey, monthKey, tokenDayKey, windowState } from "@edgehero/pi-dispatch/budget";
import { parseConnection, makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { makeQueue } from "@edgehero/pi-dispatch/queue";
import { STALL_KEY } from "@edgehero/pi-dispatch/scheduler-stall-guard";
import { windowEndAt } from "@edgehero/pi-dispatch/pause-windows";
// The pricing façade is imported HERE and wired into the deps factory alone: dashboard views call
// injected seams (`fetchCosts`/`listPricedModels`/`whatIf`), never the façade, so tests stay fully
// canned and the one worker/pricing coupling sits beside the queue and redis this module already owns.
import * as pricing from "@edgehero/pi-dispatch/pricing";
import { listRuns, readSettingsView, mapSchedulers, readTriggers, readPauseWindows, readStagedPackages, readSubscriptions, scanRunRecords, GRAPH_LIMITS, cronRunStats, joinRunsToTriggers, attributeRunsToTriggers, observedChainEdges, collectGraphInputs, forgeRepoTargets } from "./read-model.mjs";
import { renderStatus, renderBudget, renderTriggers, renderSettingsView, renderGraph } from "./render.mjs";
import { buildGraphModel } from "./graph-model.mjs";
import { matchesKey } from "./keys.mjs";
import { box, meter, clip, fmtUsd, makeLineInput } from "./panel.mjs";
import { makeStyler, frame, RULE } from "./style.mjs";
import { COSTS_WINDOWS, costsSinceMs, foldCosts, whatIfFlow } from "./costs.mjs";

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
// COSTS: the staleness bound the poll tick refreshes against (the `t`-cycled windows themselves are
// costs.mjs' COSTS_WINDOWS -- one list beside the fold whose proration they denominate). The fold is
// cheap, but the scan behind fetchCosts reads EVERY run sidecar in the window -- a per-second
// full-directory read is the kind of quiet load a dashboard must not add, so while the view is open a
// poll tick refreshes the fold only once the last fetch is older than this.
const COSTS_STALE_MS = 10_000;
// The rollup tables `f` cycles through (issue #175 added trigger and repo -- the joins the graph
// already owned, finally answering "which trigger burns the most" and "what does repo X cost").
const COSTS_TABLES = ["flow", "model", "trigger", "repo"];
// GRAPH: the cursor-following row window, on the RUNS_VIEWPORT/TAIL_VIEWPORT precedent -- a fixed
// bound with no height dependency, so an unknown terminal height changes nothing. The graph REFRESHES
// only on entry and on `r`, never on the poll tick: fetchGraph spawns git per enumerated folder, a
// heavier read than even the costs scan, and topology changes when the operator edits things, not per
// second.
const GRAPH_VIEWPORT = 16;

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
export function createDashboardDeps(paths: any) {
  const queue = makeQueue(parseConnection(paths.valkeyUrl, { failFast: true }));
  const redis = makeRedisClient(paths.valkeyUrl);
  return {
    async fetchSnapshot() {
      const [pausedState, counts, workerList, dayRaw, weekRaw, monthRaw, tokenRaw, schedulerList, activeList, stallHash] = await Promise.all([
        queue.isPaused(),
        queue.getJobCounts("waiting", "active", "paused", "delayed", "failed"),
        queue.getWorkers().catch(() => []),
        redis.get(dayKey()),
        redis.get(weekKey()),
        redis.get(monthKey()),
        redis.get(tokenDayKey()), // issue #25 daily token spend (budget:t:YYYY-MM-DD)
        queue.getJobSchedulers(0, -1, true),
        queue.getActive(0, 0).catch(() => []),
        // Per-scheduler stall counts (money backstop) for the cron drill-in; reuses the held client like the
        // budget GETs. HGETALL of an absent key is `{}`, so a never-stalled deployment shows 0 stalls.
        redis.hgetall(STALL_KEY).catch(() => ({})),
      ]);
      const workers = Array.isArray(workerList) && workerList.length > 0 ? workerList.length : "unknown";
      return {
        queue: { pausedState, counts, workers },
        budget: { day: Number(dayRaw ?? 0), week: Number(weekRaw ?? 0), month: Number(monthRaw ?? 0), tokensToday: Number(tokenRaw ?? 0) },
        schedulers: mapSchedulers(schedulerList, Date.now()),
        schedulerStalls: stallHash ?? {},
        schedulerStallMax: paths.schedulerStallMax,
        runs: listRuns({ logsDir: paths.logsDir, limit: RUNS_ON_DASHBOARD }),
        settings: readSettingsView({ settingsFile: paths.settingsFile }),
        triggers: readTriggers({ triggersPath: paths.triggersPath }),
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
    /**
     * One COSTS read: scan the run sidecars for the window, read the declared subscriptions, and fold
     * them at the REAL pricing façade's rates (pinned by its own piAiVersion). A scan error degrades to
     * `{ unreachable }` so the view renders it in-frame; the subscriptions file missing or invalid
     * degrades to no plans -- the fold still prices what it can. `records` ride along in the result
     * because the what-if seam re-folds them per target.
     */
    fetchCosts({ windowKey }: any) {
      const nowMs = Date.now();
      const sinceMs = costsSinceMs(windowKey, nowMs);
      const records = scanRunRecords({ logsDir: paths.logsDir, sinceMs, nowMs });
      if (!Array.isArray(records)) return { unreachable: (records as any)?.unreachable ?? "scan failed" };
      const subsView: any = readSubscriptions({ subscriptionsPath: paths.subscriptionsPath });
      const subscriptions = Array.isArray(subsView?.subscriptions) ? subsView.subscriptions : [];
      // The trigger join behind byTrigger: one FILE read (readTriggers, the fetchSnapshot kind) plus a
      // pure fold -- no git spawn anywhere on this path, so the 10s stale-gated poll piggyback stays
      // exactly as cheap as it was. The graph's entry+`r`-only policy is about spawns, not reads.
      const triggersView: any = readTriggers({ triggersPath: paths.triggersPath });
      const triggerJoin = attributeRunsToTriggers({ records, triggers: Array.isArray(triggersView?.triggers) ? triggersView.triggers : [] });
      const fold = foldCosts({ records, subscriptions, pricing, nowMs, piAiPin: pricing.piAiVersion(), sinceMs, triggerJoin });
      return { fold, records, subscriptions };
    },
    /**
     * One GRAPH read (issue #54): triggers FRESH (OQ-008 -- a cached topology is a stale topology),
     * one bounded record scan, the folder/injected enumerations, and the pure fold. Schedulers ride
     * in from the caller's snapshot so this seam opens no second queue read. All fs/git access lives
     * in the read-model functions this calls; this module still touches nothing itself.
     */
    fetchGraph({ schedulers }: any = {}) {
      const nowMs = Date.now();
      const triggersView: any = readTriggers({ triggersPath: paths.triggersPath });
      const triggerList: any[] = Array.isArray(triggersView?.triggers) ? triggersView.triggers : [];
      const records: any = scanRunRecords({ logsDir: paths.logsDir, sinceMs: nowMs - GRAPH_LIMITS.windowDays * 24 * 60 * 60 * 1000, nowMs });
      const recs: any[] = Array.isArray(records) ? records : [];
      return buildGraphModel({
        triggers: triggersView,
        schedulers: Array.isArray(schedulers) ? schedulers : [],
        ...collectGraphInputs({ triggers: triggerList }),
        cronStats: cronRunStats({ records: recs, schedulerIds: triggerList.filter((t) => t.type === "cron" && typeof t.id === "string").map((t) => t.id) }),
        runJoin: joinRunsToTriggers({ records: recs, triggerCount: triggersView?.count, triggerTypes: Object.fromEntries(triggerList.map((t) => [t.index, t.type])) }),
        chainEdges: observedChainEdges({ records: recs }),
        forgeRepos: forgeRepoTargets({ records: recs }),
        caps: { chainDepthMax: paths.chainDepthMax, chainMaxPerJob: paths.chainMaxPerJob, windowDays: GRAPH_LIMITS.windowDays },
        nowMs,
      });
    },
    /** The priced-model catalog for the what-if `/` filter -- the façade stays behind this seam. */
    listPricedModels() {
      return pricing.listPricedModels();
    },
    /** One what-if estimate at the real rates, over the records the last fetchCosts served. */
    whatIf({ records, flow, target }: any) {
      return whatIfFlow({ records, flow, target, pricing });
    },
    async pause() {
      await queue.pause();
    },
    async resume() {
      await queue.resume();
    },
    async dispose() {
      try {
        await queue.close();
      } catch {
        // best-effort teardown
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
  // Which view TRIGGER_DETAIL returns to on Esc: the drill opens from LIST and from GRAPH, and Esc
  // pops ONE layer -- landing a graph-entered drill back in LIST would discard the operator's graph
  // position and force a fresh git-spawning fetch to get back (review finding).
  let detailReturnTo = "LIST";
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
  // COSTS (issue #53): the last fetchCosts result and the view's own layers. `data` is whatever the seam
  // returned ({ fold, records, subscriptions } or { unreachable }); `fetchedAt` drives the poll-tick
  // staleness gate; `table` picks the by-flow or by-model rollup; `whatIf` is the layered estimate state
  // (null when closed) -- the flow it targets, the target shortlist and its cursor, and the optional `/`
  // filter input over the priced-model catalog. `costsSel` is the table's row cursor (the LIST idiom).
  let costs: any = { data: null, windowKey: "mtd", fetchedAt: 0, table: "flow", whatIf: null };
  let costsSel = 0;
  let costsFetching = false;
  // GRAPH (issue #54): the last fetched model, its error, and the view's own cursor/folds. `folded`
  // holds folder keys the operator collapsed with Enter; it survives a refresh on purpose -- a refresh
  // answers "what changed", not "start over".
  let graph: any = { model: null, error: null, fetchedAt: 0, folded: new Set() };
  let graphSel = 0;
  let graphFetching = false;

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
      // COSTS piggyback (the policy lives on fetchCostsNow): only while the view is open, and only once
      // the last fold has gone stale -- never a full sidecar scan per poll tick.
      if (view === "COSTS" && Date.now() - costs.fetchedAt > COSTS_STALE_MS) {
        await fetchCostsNow();
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

  // COSTS refresh policy: fetch on view entry and on every windowKey change (both call this directly);
  // while the view is open the 1s poll piggybacks a refresh ONLY once the last fetch is older than
  // COSTS_STALE_MS (see `refresh`). Errors degrade to an in-frame message, never a throw, and an
  // in-flight fetch suppresses the next so a slow scan cannot stack directory reads.
  const fetchCostsNow = async () => {
    if (typeof deps?.fetchCosts !== "function" || costsFetching || disposed) return;
    costsFetching = true;
    try {
      costs.data = await deps.fetchCosts({ windowKey: costs.windowKey });
    } catch (err: any) {
      costs.data = { unreachable: err?.message ?? String(err) };
    } finally {
      costs.fetchedAt = Date.now();
      costsFetching = false;
      if (costs.whatIf) computeWhatIf(); // fresh records re-price an open estimate
      tui?.requestRender?.();
    }
  };

  // GRAPH refresh policy: on entry and on `r`, NEVER on the poll tick -- the strictest of the three
  // view policies, because fetchGraph spawns git per enumerated folder. Errors degrade to an in-frame
  // message; an in-flight fetch suppresses the next so a slow enumeration cannot stack spawns.
  const fetchGraphNow = async () => {
    if (typeof deps?.fetchGraph !== "function" || graphFetching || disposed) return;
    graphFetching = true;
    try {
      graph.model = await deps.fetchGraph({ schedulers: snapshot?.schedulers ?? [] });
      graph.error = null;
    } catch (err: any) {
      graph.error = err?.message ?? String(err);
    } finally {
      graph.fetchedAt = Date.now();
      graphFetching = false;
      tui?.requestRender?.();
    }
  };

  /** Re-run the injected what-if seam for the current target and stash the result for render(). The
   * estimate is computed at key time, not per frame -- render() stays a pure read of component state. */
  const computeWhatIf = () => {
    const wi = costs.whatIf;
    if (!wi) return;
    wi.target = wi.targets[wi.index] ?? null;
    wi.result =
      wi.target !== null && typeof deps?.whatIf === "function"
        ? deps.whatIf({ records: costs.data?.records ?? [], flow: wi.flowKey, target: wi.target })
        : null;
  };

  /** Re-filter the priced-model catalog against the `/` input (a `provider/id` substring match). */
  const refreshWhatIfMatches = () => {
    const wi = costs.whatIf;
    if (!wi || !wi.input) return;
    const query = wi.input.value().toLowerCase();
    const catalog = typeof deps?.listPricedModels === "function" ? deps.listPricedModels() : [];
    wi.matches = catalog.filter((m: any) => `${m.provider}/${m.id}`.toLowerCase().includes(query));
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
      // Same clamp for the COSTS table cursor: a table that shrank on refresh (or the `f` flip to a
      // shorter rollup) can never leave the cursor pointing past the end.
      if (view === "COSTS" && costsSel > costsTableRows(costs).length - 1) {
        costsSel = Math.max(0, costsTableRows(costs).length - 1);
      }
      // And for the GRAPH cursor: a refresh (or a fold) can shrink the row list under it.
      if (view === "GRAPH" && graphSel > graphRows(graph.model, graph.folded).length - 1) {
        graphSel = Math.max(0, graphRows(graph.model, graph.folded).length - 1);
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
        costs,
        costsSel,
        costsAvailable: typeof deps?.fetchCosts === "function",
        graph,
        graphSel,
        graphAvailable: typeof deps?.fetchGraph === "function",
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
          // Esc pops ONE layer: back to whichever view opened the drill (LIST or GRAPH).
          view = detailReturnTo;
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
        // The `/` search input is the innermost layer, routed BEFORE every view key (the COSTS filter is
        // the template): a printable byte must land in the query, never fire a scroll or view key.
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
      if (view === "COSTS") {
        const wi = costs.whatIf;
        // The `/` filter input is the innermost layer, routed BEFORE every view key: typing "f" or "t"
        // into the filter must narrow the model list, not flip the table under the operator's cursor.
        if (wi && wi.filter && wi.input) {
          if (matchesKey(data, "escape")) {
            wi.filter = false;
            wi.input = null;
            tui?.requestRender?.();
            return;
          }
          if (data === "\r" || data === "\n") {
            // Enter applies the top match as the active target: an already-listed pick moves the cycle
            // cursor onto it; a new one is spliced in AT the cursor so `w` keeps cycling from there.
            const pick = wi.matches?.[0];
            if (pick) {
              const target = { provider: pick.provider, id: pick.id };
              const at = wi.targets.findIndex((t: any) => t.provider === target.provider && t.id === target.id);
              if (at >= 0) wi.index = at;
              else wi.targets.splice(wi.index, 0, target);
              computeWhatIf();
            }
            wi.filter = false;
            wi.input = null;
            tui?.requestRender?.();
            return;
          }
          if (matchesKey(data, "backspace")) wi.input.backspace();
          else if (matchesKey(data, "left")) wi.input.left();
          else if (matchesKey(data, "right")) wi.input.right();
          else if (matchesKey(data, "home")) wi.input.home();
          else if (matchesKey(data, "end")) wi.input.end();
          else if (!data.startsWith("\x1b") && data >= " ") wi.input.insert(data);
          else return; // any other control sequence is inert while the filter is up
          refreshWhatIfMatches();
          tui?.requestRender?.();
          return;
        }
        // Esc pops ONE layer at a time: what-if -> COSTS -> LIST (the filter layer popped above).
        if (matchesKey(data, "escape")) {
          if (costs.whatIf) costs.whatIf = null;
          else view = "LIST";
          tui?.requestRender?.();
          return;
        }
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          const step = matchesKey(data, "up") ? -1 : 1;
          costsSel = Math.min(Math.max(0, costsTableRows(costs).length - 1), Math.max(0, costsSel + step));
          tui?.requestRender?.();
          return;
        }
        if (data === "f" || data === "F") {
          costs.table = COSTS_TABLES[(COSTS_TABLES.indexOf(costs.table) + 1) % COSTS_TABLES.length];
          costsSel = 0;
          tui?.requestRender?.();
          return;
        }
        if (data === "t" || data === "T") {
          costs.windowKey = COSTS_WINDOWS[(COSTS_WINDOWS.indexOf(costs.windowKey) + 1) % COSTS_WINDOWS.length];
          void fetchCostsNow(); // a window change is a different scan cutoff -- fetch now, not on the tick
          tui?.requestRender?.();
          return;
        }
        if (data === "w" || data === "W") {
          // What-if targets FLOWS (whatIfFlow's grain), so on the model table the key is inert.
          if (costs.table !== "flow") return;
          if (costs.whatIf) {
            costs.whatIf.index = (costs.whatIf.index + 1) % costs.whatIf.targets.length;
            computeWhatIf();
            tui?.requestRender?.();
            return;
          }
          const row = (costs.data?.fold?.byFlow ?? [])[costsSel];
          const targets = whatIfTargets(costs.data);
          if (!row || targets.length === 0) return;
          // flowKey is the MACHINE key (null for the no-flow bucket -- whatIfFlow matches `flow ?? null`,
          // and the "(no flow)" display label matches no record); flowLabel is what the header prints.
          // The `in` check keeps a fold without flowKey working: for real flows the two are identical.
          costs.whatIf = { flowKey: "flowKey" in row ? row.flowKey : row.flow, flowLabel: row.flow, targets, index: 0, filter: false, input: null };
          computeWhatIf();
          tui?.requestRender?.();
          return;
        }
        if (data === "/") {
          if (!costs.whatIf) return; // the filter refines an open what-if; it is not a view of its own
          costs.whatIf.filter = true;
          costs.whatIf.input = makeLineInput("");
          refreshWhatIfMatches();
          tui?.requestRender?.();
          return;
        }
        // Everything else -- including q/p/r -- is inert in COSTS; leaving is Esc's job alone.
        return;
      }
      if (view === "GRAPH") {
        // Esc pops one layer to LIST; everything else the view does not own is inert (the COSTS rule).
        if (matchesKey(data, "escape")) {
          view = "LIST";
          tui?.requestRender?.();
          return;
        }
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          const step = matchesKey(data, "up") ? -1 : 1;
          graphSel = Math.min(Math.max(0, graphRows(graph.model, graph.folded).length - 1), Math.max(0, graphSel + step));
          tui?.requestRender?.();
          return;
        }
        if (data === "\r" || data === "\n") {
          const row = graphRows(graph.model, graph.folded)[graphSel];
          if (!row) return;
          if (row.kind === "folder") {
            // Enter on a group header folds/unfolds it; the fold set survives a refresh on purpose.
            if (graph.folded.has(row.key)) graph.folded.delete(row.key);
            else graph.folded.add(row.key);
            tui?.requestRender?.();
            return;
          }
          if (row.kind === "gtrigger") {
            // The graph's trigger rows reuse the existing drill: the display record comes from the
            // snapshot by RAW index (the identity both sides carry), so TRIGGER_DETAIL behaves exactly
            // as it does from LIST -- same editor, same delete confirm, same trust model.
            const record = (snapshot?.triggers?.triggers ?? []).find((t: any) => t?.index === row.node.index);
            if (!record) return;
            detailTrigger = { record, index: row.node.index };
            pendingDelete = false;
            detailReturnTo = "GRAPH";
            view = "TRIGGER_DETAIL";
            tui?.requestRender?.();
            return;
          }
          return;
        }
        // `r` refreshes the model -- the ONLY re-read path besides entry; the poll tick never does.
        if (data === "r" || data === "R") {
          void fetchGraphNow();
          return;
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
          detailReturnTo = "LIST";
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
      // `c` -- the COSTS view (issue #53): the read-time fold over the window's run sidecars and the
      // declared subscriptions. Fetch on entry (the poll only piggybacks once the data is stale); the
      // window key survives re-entry on purpose -- an operator flipping back is asking the same question.
      if (data === "c" || data === "C") {
        view = "COSTS";
        costsSel = 0;
        costs.whatIf = null;
        void fetchCostsNow();
        tui?.requestRender?.();
        return;
      }
      // `g` -- the GRAPH view (issue #54): the trigger/flow topology from the same assembled model as
      // /dispatch graph. Fetch on entry; the fold set survives re-entry (same reason the costs window
      // does -- an operator flipping back is asking the same question).
      if (data === "g" || data === "G") {
        view = "GRAPH";
        graphSel = 0;
        void fetchGraphNow();
        tui?.requestRender?.();
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
  const { view, selected, detailRun, detailTrigger, tailJobId, tail, tailTop, tailFollow, tailAvailable, tailSearchInput, tailQuery, tailMatchLine, detailSandbox, sandboxAvailable, pendingDelete, runSort, costs, costsSel, costsAvailable, graph, graphSel, graphAvailable, copiedNote, copyAvailable, terminalRows } = state;
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

  if (view === "COSTS") {
    return renderCosts({ costs, costsSel, costsAvailable, framed, width: Math.trunc(width), styler, availableRows: terminalRows });
  }

  if (view === "GRAPH") {
    return renderGraphView({ graph, graphSel, graphAvailable, framed, width: Math.trunc(width), styler });
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
    { title: "RUNS", lines: renderRunList(buildRows(snapshot, runSort), selected, 24) },
    { title: "SETTINGS", lines: toLines(renderSettingsView(snapshot.settings)) },
  ];
  const plain = [title];
  for (const section of sections) plain.push(section.title, ...section.lines);
  plain.push(KEY_HINTS);
  return plain.join("\n\n").split("\n");
}

// ── colored LIST builders (overlay-only; every returned line is exactly `inner` visible columns) ────────

const KIND_COLOR: Record<string, string> = { cron: "accent", label: "syntaxType", comment: "syntaxKeyword", pull_request: "syntaxFunction" };
const KIND_WIDTH = 13; // fits "pull_request "

/** Pad an already-colored line up to `inner` visible columns; if it overflows, clip its plain form. */
function fitLine(line: string, inner: number, styler: any): string {
  const vis = styler.visibleLen(line);
  if (vis === inner) return line;
  if (vis < inner) return line + " ".repeat(inner - vis);
  return styler.cell(styler.stripAnsi(line), inner);
}

// The frame rows around a composed body -- top border, footer rule, footer, bottom border -- charged to
// the collapse budget before any section is measured. Shared by the LIST and COSTS budgets because both
// frame with the same chrome.
const FRAME_CHROME_ROWS = 4;

/**
 * The pure collapse decision, shared by LIST and COSTS: which sections give way when the composed panel
 * outgrows the terminal. `sections` carry `{ key, rows, keptRows, priority }`; `baseRows` is everything
 * that never collapses (frame chrome, RULE separators, the fixed blocks); collapsing a section keeps
 * `keptRows` of it -- LIST keeps the divider line, COSTS keeps a one-line marker or nothing. Sections
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
      lines.push(styler.divider(s.head[0], `(${s.body.length} hidden — ${s.viewKey} to view)`, inner));
      return;
    }
    if (s.head) lines.push(styler.divider(s.head[0], s.head[1], inner));
    for (const l of s.body) lines.push(l);
  });
  return lines;
}

/** The one-line STATUS header: `● RUNNING  N waiting · … · K workers        HH:MM:SS`. */
function statusHeader(queue: any, inner: number, styler: any): string {
  if (!queue || queue.unreachable) {
    return styler.cell(`queue unreachable (${queue?.unreachable ?? "?"})`, inner, { color: "error" });
  }
  const c = queue.counts ?? {};
  const running = !queue.pausedState;
  const failed = Number(c.failed ?? 0);
  const stateColor = running ? "success" : "warning";
  const dot = styler.fg(stateColor, "●");
  const word = styler.bold(styler.fg(stateColor, running ? "RUNNING" : "PAUSED"));
  const sep = styler.fg("dim", " · ");
  const vitals =
    `${c.waiting ?? 0} waiting` + sep + `${c.active ?? 0} active` + sep +
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
  // Health is a LIST-level fact, not only a drill-in one: an overdue scheduler or a stall counter at the
  // backstop max is exactly the row an operator must notice without opening it. Amber, appended last like
  // the other risk badges; a healthy or non-cron row renders byte-identically to before.
  const health = sched && (sched.overdueMs || (sched.stallMax > 0 && sched.stalls >= sched.stallMax))
    ? " " + styler.fg("warning", sched.overdueMs ? "⚠ overdue" : "⚠ stalled")
    : "";
  return fitLine(`${cursor} ${badge} ${matchColored(t, styler)} ${targetColored(t, styler)}${pkgs}${img}${res}${rep}${health}`, inner, styler);
}

function matchColored(t: any, styler: any): string {
  switch (t?.type) {
    case "cron": return styler.fg("text", `${t.id ?? "-"}  ${t.pattern ?? "-"}`);
    case "comment": return styler.fg("text", `"${t.phrase ?? "-"}"`);
    case "label":
    case "pull_request": {
      const parts: string[] = [];
      if (t.type === "pull_request") parts.push(styler.fg("muted", `[${(t.action ?? []).join(",")}]`));
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
  const flow = styler.bold(styler.fg("text", t?.flow ?? "-"));
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
  let header = styler.fg(KIND_COLOR[t.type] ?? "muted", t.type ?? "?") + "  " + styler.bold(styler.fg("text", `→ ${t.flow ?? "-"}`));
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
    out.push(kv("any of", (t.any ?? []).join(" · ") || "-", "success"));
    out.push(kv("all of", (t.all ?? []).join(" · ") || "-", "success"));
    out.push(kv("none of", (t.none ?? []).join(" · ") || "-", "error"));
  } else if (t.type === "comment") {
    out.push(kv("phrase", `"${t.phrase ?? "-"}"`));
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
  // Same shape as the model row -- a per-trigger override of a deployment default -- and rendered on BOTH
  // branches, because unlike model, all four kinds can carry an image. The dim "deployment default" is
  // deliberate rather than an omitted row: a missing row would read as "I don't know", this reads as
  // "I checked". Which image runs is which code runs, so it is not a fact to leave implicit.
  out.push(kv("image", t.image ?? "deployment default", t.image ? "accent" : "dim"));
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
  switch (t?.forge) {
    case "gitlab":
      return [
        "authorized by the actor's resolved project access level (>= Developer) — a label is NOT approval here",
        "HMAC over the body (19.0+) or a bare X-Gitlab-Token · dedup by webhook-id",
        where,
      ];
    case "forgejo":
      return [
        "authorized by the actor's resolved repository permission (admin|write), on every trigger type",
        "HMAC over the body (GitHub-compatible) · dedup by X-GitHub-Delivery GUID",
        where,
      ];
    case "azure":
      return [
        "authorized by the actor's resolved project membership — work items name the actor only by email",
        "NO HMAC: a shared secret that covers no bytes · dedup by the payload's own id (OQ-015)",
        where,
      ];
    default:
      return [
        // A review trigger reads the REVIEWER's author_association, not the PR author's (issue #66), so it
        // cannot share the generic line: an operator reading "author gate" would picture the wrong person.
        t?.type === "comment"
          ? "authorized by a collaborator comment (author_association) + HMAC"
          : t?.type === "pull_request" && (t?.action ?? []).includes("review_submitted")
            ? "authorized by the REVIEWER's author_association (not the PR author's) + HMAC"
            : "authorized by a collaborator's label + HMAC webhook + author gate",
        "dedup by X-GitHub-Delivery GUID (redelivery-safe)",
        where,
      ];
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
 * so the full row plus `c costs` fits a width-80 frame (inner 76) with no ellipsis; the fit is pinned
 * by the dashboard test, so a new hint here must pay for itself in label characters. */
function keyHints(inner: number, styler: any): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  // Exactly 76 visible columns -- the width-80 frame's whole inner row -- and the arithmetic is the
  // review gate: labels 55 + seven separators × 3 = 76. `g graph` (issue #54) paid for itself by
  // merging the pause/resume pair into one hint (both keys still work; the pair shares a label the
  // way ↑↓/↵ share "open") and dropping ↵ from the nav hint. A new hint here must again say what it
  // shortened, or the footer clips and a key silently disappears.
  const hints = [k("↑↓", "open"), k("a", "add"), k("w", "pauses"), k("l", "logs"), k("c", "costs"), k("g", "graph"), k("p/r", "pause"), k("q", "quit")].join(styler.fg("dim", " · "));
  return fitLine(hints, inner, styler);
}

// ── GRAPH view (issue #54): the topology as a folder-grouped tree, one node per row ────────────────────

/**
 * Flatten the graph model into the view's selectable rows: a folder header per group (foldable), its
 * trigger nodes, its skills with their outgoing edges as annotation rows, then the injected skills.
 * Pure over (model, folded) so handleInput and render() cannot disagree about what the cursor is on.
 * Unverified flow nodes are skipped here exactly as renderGraph skips them -- their fact (the config
 * edge) is already on the trigger row, and a second row would double-count the same string.
 */
function graphRows(model: any, folded: any): any[] {
  if (!model) return [];
  const nodeById = new Map((model.nodes ?? []).map((n: any) => [n.id, n]));
  const flagsByNode = new Map<string, string[]>();
  for (const f of model.flags ?? []) {
    if (!flagsByNode.has(f.nodeId)) flagsByNode.set(f.nodeId, []);
    flagsByNode.get(f.nodeId)!.push(f.flag);
  }
  const rows: any[] = [];
  for (const group of model.folders ?? []) {
    if ((group.triggerIds?.length ?? 0) === 0 && (group.skillIds?.length ?? 0) === 0) continue;
    const isFolded = folded?.has?.(group.key) === true;
    rows.push({ kind: "folder", key: group.key, group, folded: isFolded });
    if (isFolded) continue;
    for (const id of group.triggerIds ?? []) {
      const node: any = nodeById.get(id);
      if (node) rows.push({ kind: "gtrigger", node, flags: flagsByNode.get(id) ?? [] });
    }
    for (const id of group.skillIds ?? []) {
      const node: any = nodeById.get(id);
      if (!node || node.kind === "skill-unverified") continue;
      rows.push({ kind: "gskill", node, flags: flagsByNode.get(id) ?? [] });
      for (const e of model.edges ?? []) {
        if (e.from !== id || e.kind === "cron-rearm") continue;
        rows.push({ kind: "gedge", edge: e, target: nodeById.get(e.to) });
      }
    }
  }
  for (const n of model.nodes ?? []) {
    if (n.kind === "injected") rows.push({ kind: "ginjected", node: n, flags: flagsByNode.get(n.id) ?? [] });
  }
  return rows;
}

/** One graph row as a colored line of exactly `inner` visible columns. `cursor` prefixes the LIST `›`. */
function graphRowLine(row: any, cursor: boolean, inner: number, styler: any): string {
  const G = styler.glyphs;
  const pre = cursor ? styler.fg("accent", "› ") : "  ";
  if (row.kind === "folder") {
    const g = row.group;
    const fold = styler.fg("accent", row.folded ? G.foldClosed : G.foldOpen);
    const label = g.kind === "forge" ? `forge ${g.label}` : `folder ${g.path ?? g.label}`;
    // Record-derived scope for a forge group: which repos its runs actually hit in the window,
    // because a forge trigger's config names none and "github" alone answers nothing.
    const seen = g.kind === "forge" && Array.isArray(g.repos) && g.repos.length > 0 ? styler.fg("dim", ` · ran against ${g.repos.join(", ")}`) : "";
    const state = g.unreachable ? styler.fg("warning", ` · ${g.kind === "forge" ? "skills unverifiable from this host" : g.unreachable}`) : g.head ? styler.fg("dim", ` · HEAD ${String(g.head).slice(0, 7)}`) : "";
    return fitLine(pre + fold + " " + styler.fg("accent", label) + seen + state, inner, styler);
  }
  if (row.kind === "gtrigger") {
    const t = row.node;
    const kind = styler.cell(t.onType, KIND_WIDTH, { color: KIND_COLOR[t.onType] ?? "text" });
    const stats = t.runs > 0 ? `runs ${t.runs}${t.lastOutcome ? ` · last ${t.lastOutcome}` : ""}` : "no runs in window";
    const statColor = t.lastOutcome === "completed" ? "success" : t.lastOutcome ? "warning" : "dim";
    const badges = graphBadges(row.flags, styler);
    const left = pre + kind + styler.stripAnsi(t.label ?? "") + " " + styler.fg("dim", G.arrowRight) + " " + (t.flow ?? "(no flow)") + (t.replicas ? styler.fg("warning", ` x${t.replicas}`) : "") + badges;
    const right = styler.fg(statColor, stats);
    return joinEnds(left, right, inner, styler);
  }
  if (row.kind === "gskill") {
    const s = row.node;
    const missing = s.kind === "skill-missing";
    const name = missing ? styler.fg("error", s.name) : s.name;
    const marks: string[] = [];
    if (missing) marks.push(styler.fg("error", "[missing at HEAD]"));
    if (s.isSub) marks.push(styler.fg("dim", `[sub of ${s.group}]`));
    if (s.aiTrigger) marks.push(styler.fg("success", "[chainable]"));
    for (const loop of Array.isArray(s.loops) ? s.loops : []) marks.push(styler.fg("accent", `${G.rearm} "${loop.hint}"`));
    const badges = graphBadges(row.flags, styler);
    return fitLine(pre + styler.fg("dim", "skill ") + name + (marks.length ? " " + marks.join(" ") : "") + badges, inner, styler);
  }
  if (row.kind === "gedge") {
    const e = row.edge;
    const name = row.target?.name ?? "(unknown)";
    const label =
      e.kind === "observed"
        ? styler.fg("accent", `observed x${e.count}`)
        : e.kind === "potential"
          ? styler.fg("dim", `mention (potential${e.strong ? ", strong" : ""}; ${e.eligible ? "could fire" : "can never fire"})`)
          : styler.fg("dim", e.kind);
    return fitLine(pre + "  " + styler.fg("dim", `${G.bl} ${G.arrowRight} `) + name + "  " + label, inner, styler);
  }
  if (row.kind === "ginjected") {
    const warn = row.flags.includes("injected-ai-trigger") ? " " + styler.fg("error", "[ai-trigger is a silent no-op here]") : "";
    return fitLine(pre + styler.fg("dim", "injected ") + row.node.name + styler.fg("dim", ` (${row.node.dir})`) + warn, inner, styler);
  }
  return fitLine(pre, inner, styler);
}

/** The flag badges every graph row shares, colored by severity; the vocabulary is graph-model's. */
function graphBadges(flags: string[], styler: any): string {
  const parts: string[] = [];
  for (const flag of flags ?? []) {
    if (flag === "no-skill") parts.push(styler.fg("error", "[no-skill]"));
    else if (flag === "charset-invalid") parts.push(styler.fg("error", "[invalid name]"));
    else if (flag === "orphan") parts.push(styler.fg("warning", "[orphan]"));
    else if (flag === "ai-reachable-no-trigger") parts.push(styler.fg("warning", "[AI-reachable, no trigger]"));
    else if (flag === "unread") parts.push(styler.fg("warning", "[unread]"));
    else if (flag === "pr-spend-loop-risk") parts.push(styler.fg("error", "[spend-loop risk]"));
  }
  return parts.length ? " " + parts.join(" ") : "";
}

/** Left content + right-aligned tail in exactly `inner` visible columns (clips the left, never the right). */
function joinEnds(left: string, right: string, inner: number, styler: any): string {
  const rightLen = styler.visibleLen(right);
  const leftMax = Math.max(0, inner - rightLen - 2);
  const leftFit = styler.visibleLen(left) > leftMax ? styler.cell(styler.stripAnsi(left), leftMax) : left + " ".repeat(leftMax - styler.visibleLen(left));
  return leftFit + "  " + right;
}

/**
 * The GRAPH panel: a cursor-following GRAPH_VIEWPORT window over graphRows (the RUNS_VIEWPORT
 * precedent -- a fixed bound, no height dependency), the honesty counters, and the caps line, which
 * renders ALWAYS (DES-GRAPH-EDGE-DERIVATION: edges without their bounds invite extrapolating an
 * unbounded chain fabric). The unframed degrade reuses renderGraph -- the same model through the same
 * pure renderer `/dispatch graph` prints, whole and uncollapsed.
 */
function renderGraphView({ graph, graphSel, graphAvailable, framed, width, styler }: any): string[] {
  // The title's rule glyphs come from the styler's twin table, not a literal, so the ascii overlay
  // stays pure ASCII in its border line too.
  const title = `pi-dispatch ${styler.glyphs.h}${styler.glyphs.h} GRAPH · triggers and flows`;
  const inner = width - 4;
  const model = graph?.model ?? null;

  if (!framed) {
    // The error outranks a stale model here too (review finding): a failed refresh at a tiny width
    // must not render yesterday's topology -- or an eternal "loading" -- as if nothing happened.
    const plain = graph?.error
      ? [`graph unreachable (${graph.error})`]
      : model
        ? renderGraph(model).split("\n")
        : [graphAvailable ? "loading graph…" : "graph unavailable in this build"];
    return [styler.stripAnsi(title), "", ...plain, "", "↑↓ move · ↵ open/fold · r refresh · esc back"];
  }

  const lines: any[] = [];
  if (graph?.error) {
    lines.push(fitLine(styler.fg("error", `graph unreachable (${graph.error})`), inner, styler));
  } else if (model === null) {
    lines.push(fitLine(styler.fg("dim", graphAvailable ? "loading graph…" : "graph unavailable in this build"), inner, styler));
  } else if (model.meta?.triggersMissing) {
    lines.push(fitLine(styler.fg("warning", "no triggers file found"), inner, styler));
  } else if (typeof model.meta?.triggersInvalid === "string" && model.meta.triggersInvalid !== "") {
    lines.push(fitLine(styler.fg("error", `triggers file invalid: ${model.meta.triggersInvalid}`), inner, styler));
  } else {
    const rows = graphRows(model, graph.folded);
    if (rows.length === 0) {
      lines.push(fitLine(styler.fg("dim", "no triggers configured"), inner, styler));
    } else {
      const top = Math.max(0, Math.min(graphSel - GRAPH_VIEWPORT + 1, rows.length - GRAPH_VIEWPORT));
      if (top > 0) lines.push(fitLine(styler.fg("dim", `… ${top} above`), inner, styler));
      rows.slice(top, top + GRAPH_VIEWPORT).forEach((row, i) => {
        lines.push(graphRowLine(row, top + i === graphSel, inner, styler));
      });
      const below = rows.length - (top + GRAPH_VIEWPORT);
      if (below > 0) lines.push(fitLine(styler.fg("dim", `… ${below} below`), inner, styler));
    }
    const counters = graphCounterLine(model, styler);
    lines.push(RULE);
    if (counters) lines.push(fitLine(counters, inner, styler));
    lines.push(fitLine(styler.fg("dim", capsLineText(model.caps)), inner, styler));
  }
  return frame(styler, { title, width, lines, footer: graphHints(inner, styler) });
}

/** The one-line honesty counters, or null when there is nothing to say (the caps line still renders). */
function graphCounterLine(model: any, styler: any): string | null {
  const bits: string[] = [];
  const meta = model?.meta ?? {};
  if ((meta.unattributedRuns ?? 0) > 0) bits.push(`${meta.unattributedRuns} runs unattributed`);
  const refused = Object.values(meta.chainRefusals ?? {}).reduce((a: number, n: any) => a + (Number(n) || 0), 0);
  if (refused > 0) bits.push(`${refused} chain requests refused`);
  const t = meta.truncated ?? {};
  if (t.folders) bits.push("folders truncated");
  if (t.skills) bits.push("skills truncated/unread");
  if (t.edges) bits.push("edges truncated");
  if ((meta.droppedObservedEdges ?? 0) > 0) bits.push(`${meta.droppedObservedEdges} observed edges dropped`);
  if ((meta.injectedUnreachable ?? []).length > 0) bits.push(`${meta.injectedUnreachable.length} injected dirs unreadable`);
  return bits.length ? styler.fg("warning", bits.join(" · ")) : null;
}

/** The caps sentence every render carries, from the model's own caps (never a second literal). */
function capsLineText(caps: any): string {
  return `caps: chain depth <= ${caps?.chainDepthMax ?? "?"} · <= ${caps?.chainMaxPerJob ?? "?"} per job · same folder only · window ${caps?.windowDays ?? "?"}d`;
}

function graphHints(inner: number, styler: any): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  const hints = [k("↑↓", "move"), k("↵", "open/fold"), k("r", "refresh"), k("esc", "back")].join(styler.fg("dim", " · "));
  return fitLine(hints, inner, styler);
}

// ── COSTS view (issue #53): full-width like LIST, every body line exactly `inner` visible columns ──────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The frame-title window label: `Aug 2026 (mtd)` for the calendar window, `last 7d`/`last 30d` else. */
function costsWindowLabel(windowKey: string): string {
  if (windowKey !== "mtd") return `last ${windowKey}`;
  const now = new Date();
  return `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()} (mtd)`;
}

/** The active COSTS table's rows -- the array `costsSel` and ↑↓ span. byTrigger may be null (the
 * seam wired no triggers): the empty array degrades the table to its stated empty line. */
function costsTableRows(costs: any): any[] {
  const fold = costs?.data?.fold;
  const rows =
    costs?.table === "model" ? fold?.byModel : costs?.table === "trigger" ? fold?.byTrigger : costs?.table === "repo" ? fold?.byRepo : fold?.byFlow;
  return Array.isArray(rows) ? rows : [];
}

/** The what-if target shortlist: every (provider,model) pair the window actually ran (byModel order,
 * deduped, minus the honest "unknown" attribution rows -- there is nothing to price there), then every
 * subscription's declared counterfactualModel. */
function whatIfTargets(data: any): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  const add = (provider: any, id: any) => {
    if (typeof provider !== "string" || typeof id !== "string") return;
    if (provider === "unknown" || id === "unknown") return;
    // The ledger's 8-row overflow bucket is an aggregation artifact, not a model: getPricedModel of
    // ("other","other") is null, so offering it would silently degrade the estimate to the seeded band.
    if (provider === "other" && id === "other") return;
    const key = `${provider}/${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider, id });
  };
  for (const m of data?.fold?.byModel ?? []) add(m.provider, m.model);
  for (const s of data?.subscriptions ?? []) add(s.counterfactualModel?.provider, s.counterfactualModel?.id);
  return out;
}

/** The provider that carried most of a flow's tokens in the scanned window (ledger rows preferred, the
 * host-effective provider as the pre-ledger fallback), or null when nothing attributes. The what-if
 * cross-provider caveat keys off this: same-provider re-pricing is arithmetic, cross-provider assumes a
 * token profile survives a tokenizer change. Flow matching mirrors whatIfFlow's own (`flow ?? null`). */
function dominantProvider(records: any, flow: any): string | null {
  const totals = new Map<string, number>();
  const bump = (provider: any, tokens: any) => {
    if (typeof provider !== "string" || provider === "unknown") return;
    totals.set(provider, (totals.get(provider) ?? 0) + (Number.isFinite(tokens) ? tokens : 0));
  };
  for (const r of Array.isArray(records) ? records : []) {
    if ((r?.flow ?? null) !== flow) continue;
    const rows = r?.usage?.models;
    if (Array.isArray(rows) && rows.length > 0) for (const m of rows) bump(m?.provider, m?.total ?? 0);
    else bump(r?.provider, r?.tokens?.total ?? 0);
  }
  let best: string | null = null;
  let bestTokens = -1;
  for (const [provider, tokens] of totals) {
    if (tokens > bestTokens) {
      best = provider;
      bestTokens = tokens;
    }
  }
  return best;
}

/**
 * The COSTS view: full-width like LIST (DRILL_WIDTH would waste the table's columns), composed with the
 * same fitLine/styler discipline -- every body line exactly `inner` visible columns, RULE sentinels
 * between sections, and the same unframed degrade below MIN_WIDTH. Everything rendered is the injected
 * fetchCosts snapshot; every money surface funnels through styler.fmtCost, so a plan-covered row can
 * never read as $0.00 and an estimate can never pass as a metered figure.
 */
function renderCosts({ costs, costsSel, costsAvailable, framed, width, styler, availableRows }: any): string[] {
  const inner = framed ? width - 4 : Math.max(24, width);
  const title = `COSTS · ${costsWindowLabel(costs.windowKey)}`;
  // The collapse budget applies to the framed path only, like LIST's: the unframed degrade is already
  // the everything-else-failed rendering and stays whole.
  const lines = buildCostsLines(costs, costsSel, inner, styler, costsAvailable, framed ? availableRows : null);
  const footer = costsHints(inner, styler);
  if (!framed) {
    const plain = lines.filter((l: any) => l !== RULE).map((l: any) => styler.stripAnsi(l));
    return [title, "", ...plain, "", styler.stripAnsi(footer)];
  }
  return frame(styler, { title, width, lines, footer });
}

/** The COSTS body: verdicts, the daily sparkline, the selectable rollup table, the optional what-if
 * block, the plans facts and the provenance footer -- or the loading/unreachable degrades. With a known
 * terminal height the blocks collapse by priority (see below); an unknown height composes exactly the
 * full body it always did -- byte-identical by construction. */
function buildCostsLines(costs: any, costsSel: number, inner: number, styler: any, available: boolean, availableRows: any = null): any[] {
  if (costs.data === null) {
    return [fitLine(styler.fg("dim", available ? "loading costs…" : "costs unavailable in this build"), inner, styler)];
  }
  if (costs.data.unreachable) {
    return [fitLine(styler.fg("error", `costs unreachable (${costs.data.unreachable})`), inner, styler)];
  }
  const fold = costs.data.fold ?? {};
  const verdict = verdictLines(fold, costs.windowKey, inner, styler);
  const daily = dailyLine(fold, inner, styler);
  const table = costsTableLines(fold, costs.table, costsSel, inner, styler);
  const what = costs.whatIf ? whatIfLines(costs.whatIf, costs.data, inner, styler) : null;
  const plans = planLines(fold, inner, styler);
  const prov = provenanceLine(fold, inner, styler);
  // COSTS collapse order: the rollup table first (the bulk of the body, and ↑↓/f/w still act on the full
  // model underneath), then the plans block, then the daily row. The verdict block NEVER collapses -- it
  // is the sentence this view exists to say -- and neither does an open what-if: the operator just asked
  // for it, so it sits in the fixed budget beside the verdicts and the provenance ledger. `keptRows` is 1
  // for the blocks that leave a marker and 0 for the one-line daily row, where a marker would save nothing.
  const collapsed = collapseKeys(
    [
      { key: "table", rows: table.length, keptRows: 1, priority: 1 },
      { key: "plans", rows: plans.length, keptRows: plans.length > 0 ? 1 : 0, priority: 2 },
      { key: "daily", rows: 1, keptRows: 0, priority: 3 },
    ],
    availableRows,
    null,
    FRAME_CHROME_ROWS + 2 + (what ? 1 : 0) + verdict.length + 1 + (what ? what.length : 0), // chrome + RULEs + verdicts + provenance + open what-if
  );
  const out: any[] = [...verdict];
  if (!collapsed.has("daily")) out.push(daily);
  out.push(RULE);
  if (collapsed.has("table")) out.push(fitLine(styler.fg("dim", `(table · ${table.length} hidden)`), inner, styler));
  else for (const l of table) out.push(l);
  if (what) {
    out.push(RULE);
    for (const l of what) out.push(l);
  }
  out.push(RULE);
  if (collapsed.has("plans") && plans.length > 0) out.push(fitLine(styler.fg("dim", `(plans · ${plans.length} hidden)`), inner, styler));
  else for (const l of plans) out.push(l);
  out.push(prov);
  return out;
}

/**
 * One verdict line per declared plan, owned before hypothetical -- the fold already scored them, this
 * only phrases the kinds. The dollar inside every phrasing is styler.fmtCost of the fold's typed delta,
 * so a verdict figure always wears its `~`/`est.` provisional dress. The owned second line shows the
 * arithmetic the verdict came from: declared price -> window proration, and the covered runs' API-rate
 * equivalent. NO_BASELINE names the missing declaration instead of inventing a baseline.
 */
function verdictLines(fold: any, windowKey: string, inner: number, styler: any): string[] {
  const plans = Array.isArray(fold.plans) ? fold.plans : [];
  if (plans.length === 0) {
    return [fitLine(styler.fg("dim", "no subscriptions declared · edit subscriptions.json"), inner, styler)];
  }
  const noun = windowKey === "mtd" ? "this month" : `over last ${windowKey}`;
  const days = Number(fold.window?.days ?? 0);
  const label = styler.bold(styler.fg("muted", "VERDICT")) + "  ";
  const indent = " ".repeat(9);
  const out: string[] = [];
  for (const p of [...plans].sort((a, b) => (a.hypothetical ? 1 : 0) - (b.hypothetical ? 1 : 0))) {
    const kind = p.verdict?.kind;
    if (kind === "SAVING" || kind === "LOSING") {
      const color = kind === "SAVING" ? "success" : "warning";
      out.push(fitLine(label + styler.fg(color, `${p.id} is ${kind} `) + styler.fmtCost(p.verdict.usd) + styler.fg(color, ` ${noun}`), inner, styler));
      // Display math only, mirroring the fold's own 30-day-month proration proxy (buildPlans) -- the
      // same coarse-on-purpose number, shown so the verdict's inputs are checkable at a glance.
      const prorated = Number(p.price?.amount ?? 0) * (days / 30);
      out.push(fitLine(indent + styler.fg("dim", `plan price (prorated) ${fmtUsd(Number(p.price?.amount ?? 0))} → ${fmtUsd(prorated)} · plan runs @ API `) + styler.fmtCost(p.apiEquiv), inner, styler));
    } else if (kind === "WOULD_SAVE" || kind === "WOULD_LOSE") {
      const color = kind === "WOULD_SAVE" ? "success" : "warning";
      const word = kind === "WOULD_SAVE" ? "WOULD SAVE" : "WOULD LOSE";
      out.push(fitLine(label + styler.fg(color, `${p.id} ${word} `) + styler.fmtCost(p.verdict.usd) + styler.fg(color, ` ${noun}`) + styler.fg("dim", " (hypothetical)"), inner, styler));
    } else {
      out.push(fitLine(label + styler.fg("dim", `${p.id}: no API-rate baseline declared — set counterfactualModel to compare`), inner, styler));
    }
  }
  return out;
}

/** `daily  <sparkline>  Σ <total> · max $x/d`. Zero-run days ARE zero cells (the fold keeps gap days as
 * zero-run entries, and a quiet day must render quiet, never compress away); the ceiling is the window's
 * own max day, and the Σ is the provenance total -- the one typed dollar for the whole window. */
function dailyLine(fold: any, inner: number, styler: any): string {
  const daily = Array.isArray(fold.daily) ? fold.daily : [];
  const values = daily.map((d: any) => (typeof d?.cost?.usd === "number" ? d.cost.usd : null));
  const maxDay = values.reduce((m: number, v: any) => (typeof v === "number" && v > m ? v : m), 0);
  const label = styler.fg("muted", "daily") + "  ";
  const suffix = styler.fg("muted", "  Σ ") + styler.fmtCost(fold.provenance?.total) + styler.fg("dim", ` · max ${fmtUsd(maxDay)}/d`);
  const sparkW = Math.max(8, inner - styler.visibleLen(label) - styler.visibleLen(suffix));
  return fitLine(label + styler.sparkline(values, sparkW) + suffix, inner, styler);
}

/**
 * The selectable rollup table -- two shapes behind one cursor: by-flow (with the plan rows' API-rate
 * equivalent column) and by-model. Every money cell is styler.fmtCost, the ONLY renderer of a typed
 * dollar, so a plan-covered row reads `plan:<id>` (never $0.00) and a zero-rated one `$0 (unrated)`
 * (never "free"); a null api-equiv is an em dash, not a guess.
 */
function costsTableLines(fold: any, table: string, costsSel: number, inner: number, styler: any): string[] {
  const gap = "  ";
  const wRuns = 5;
  const wTok = 7;
  const head = (text: string, w: number, align = "left") => styler.cell(text, w, { color: "muted", align });
  const cursor = (sel: boolean) => (sel ? styler.fg("accent", "›") : " ");
  const out: string[] = [];
  if (table === "model") {
    const wName = 30;
    const wCost = Math.max(8, inner - 2 - wName - wRuns - wTok - 3 * gap.length);
    out.push(fitLine("  " + [head("PROVIDER/MODEL", wName), head("RUNS", wRuns, "right"), head("TOKENS", wTok, "right"), head("COST", wCost)].join(gap), inner, styler));
    const rows = Array.isArray(fold.byModel) ? fold.byModel : [];
    if (rows.length === 0) return [...out, fitLine(styler.fg("dim", "  (no runs in this window)"), inner, styler)];
    rows.forEach((r: any, i: number) => {
      const cells = [
        styler.cell(`${r.provider}/${r.model}`, wName),
        styler.cell(String(r.runs ?? 0), wRuns, { align: "right" }),
        styler.cell(fmtTokens(r.tokens ?? 0), wTok, { align: "right" }),
        styler.fmtCost(r.cost, wCost),
      ];
      out.push(fitLine(cursor(i === costsSel) + " " + cells.join(gap), inner, styler));
    });
    return out;
  }
  if (table === "trigger") {
    // The per-trigger rollup (issue #175): the FAIL column and the failed-spend suffix exist because
    // a trigger whose spend is mostly failures is a different problem than an expensive one. The
    // suffix rides inside the flexible COST column only when nonzero, so the row count (and with it
    // the collapse budget) never depends on outcomes.
    const wName = 24;
    const wFail = 4;
    const wCost = Math.max(8, inner - 2 - wName - wRuns - wFail - wTok - 4 * gap.length);
    out.push(fitLine("  " + [head("TRIGGER", wName), head("RUNS", wRuns, "right"), head("FAIL", wFail, "right"), head("TOKENS", wTok, "right"), head("COST", wCost)].join(gap), inner, styler));
    const rows = Array.isArray(fold.byTrigger) ? fold.byTrigger : [];
    if (rows.length === 0) return [...out, fitLine(styler.fg("dim", "  (no runs in this window)"), inner, styler)];
    rows.forEach((r: any, i: number) => {
      const failed = r.outcomes?.failed ?? 0;
      const costCell =
        r.failedCost && failed > 0
          ? styler.fmtCost(r.cost) + styler.fg("dim", ` (failed `) + styler.fmtCost(r.failedCost) + styler.fg("dim", `)`)
          : styler.fmtCost(r.cost, wCost);
      const cells = [
        styler.cell(r.label ?? r.key ?? "-", wName),
        styler.cell(String(r.runs ?? 0), wRuns, { align: "right" }),
        styler.cell(failed > 0 ? String(failed) : "·", wFail, { align: "right" }),
        styler.cell(fmtTokens(r.tokens ?? 0), wTok, { align: "right" }),
        costCell,
      ];
      out.push(fitLine(cursor(i === costsSel) + " " + cells.join(gap), inner, styler));
    });
    return out;
  }
  if (table === "repo") {
    const wName = 30;
    const wCost = Math.max(8, inner - 2 - wName - wRuns - wTok - 3 * gap.length);
    out.push(fitLine("  " + [head("REPO/TARGET", wName), head("RUNS", wRuns, "right"), head("TOKENS", wTok, "right"), head("COST", wCost)].join(gap), inner, styler));
    const rows = Array.isArray(fold.byRepo) ? fold.byRepo : [];
    if (rows.length === 0) return [...out, fitLine(styler.fg("dim", "  (no runs in this window)"), inner, styler)];
    rows.forEach((r: any, i: number) => {
      const cells = [
        styler.cell(r.label ?? "-", wName),
        styler.cell(String(r.runs ?? 0), wRuns, { align: "right" }),
        styler.cell(fmtTokens(r.tokens ?? 0), wTok, { align: "right" }),
        styler.fmtCost(r.cost, wCost),
      ];
      out.push(fitLine(cursor(i === costsSel) + " " + cells.join(gap), inner, styler));
    });
    return out;
  }
  const wFlow = 18;
  const wCost = 14;
  const wApi = Math.max(8, inner - 2 - wFlow - wRuns - wTok - wCost - 4 * gap.length);
  out.push(fitLine("  " + [head("FLOW", wFlow), head("RUNS", wRuns, "right"), head("TOKENS", wTok, "right"), head("COST", wCost), head("API-EQUIV", wApi)].join(gap), inner, styler));
  const rows = Array.isArray(fold.byFlow) ? fold.byFlow : [];
  if (rows.length === 0) return [...out, fitLine(styler.fg("dim", "  (no runs in this window)"), inner, styler)];
  rows.forEach((r: any, i: number) => {
    const cells = [
      styler.cell(r.flow ?? "-", wFlow),
      styler.cell(String(r.runs ?? 0), wRuns, { align: "right" }),
      styler.cell(fmtTokens(r.tokens ?? 0), wTok, { align: "right" }),
      styler.fmtCost(r.cost, wCost),
      styler.fmtCost(r.apiEquiv, wApi),
    ];
    out.push(fitLine(cursor(i === costsSel) + " " + cells.join(gap), inner, styler));
  });
  return out;
}

/**
 * The what-if delta block under the table. The estimate came from the injected seam (whatIfFlow at the
 * real rates); this only phrases the two shapes it returns: a measured-median estimate with the delta
 * against the flow's current window cost and its coverage honesty line, or the seeded requirements band
 * when no ledgered run has ever measured the flow. The cross-provider caveat renders ONLY when the
 * target provider differs from the flow's dominant one -- same-provider re-pricing is arithmetic,
 * cross-provider assumes the token profile survives a tokenizer change, and that assumption is stated
 * rather than silently priced in.
 */
function whatIfLines(wi: any, data: any, inner: number, styler: any): string[] {
  const out: string[] = [];
  const t = wi.target;
  const header = styler.bold(styler.fg("accent", `WHAT-IF ${wi.flowLabel} → ${t ? `${t.provider}/${t.id}` : "?"}`)) +
    styler.fg("dim", `  (${wi.index + 1}/${wi.targets.length} · w next · / search)`);
  out.push(fitLine(header, inner, styler));
  const r = wi.result;
  if (!r) {
    out.push(fitLine(styler.fg("dim", "no estimate available"), inner, styler));
  } else if (r.class === "seeded") {
    // The zero-knowledge band: requirements.md's unmeasured $0.5-$5/job seed, never a $0 that looks
    // like an answer. The note names the tracking id so the band cannot pass as a measurement.
    out.push(fitLine(styler.fg("warning", `~~${fmtUsd(r.low)}–${fmtUsd(r.high)} seeded`) + styler.fg("dim", ` · ${r.note ?? "unmeasured (OQ-002)"}`), inner, styler));
  } else {
    const current = (data?.fold?.byFlow ?? []).find((x: any) => x.flow === wi.flowLabel)?.cost?.usd;
    const delta = typeof current === "number" ? r.usd - current : null;
    const deltaPart = delta === null ? "" : ` (${delta <= 0 ? "−" : "+"}${fmtUsd(Math.abs(delta))} vs current)`;
    out.push(fitLine(styler.fmtCost({ usd: r.usd, class: "estimated", floor: false }) + styler.fg("dim", `${deltaPart} · rates@${r.ratesVersion ?? "?"}`), inner, styler));
    const dom = dominantProvider(data?.records, wi.flowKey);
    if (t && dom !== null && t.provider !== dom) {
      out.push(fitLine(styler.fg("dim", "cross-provider: same token profile, tokenizers differ — directional only"), inner, styler));
    }
    out.push(fitLine(styler.fg("dim", `coverage ${Math.round((r.coverage ?? 0) * 100)}% (${r.excluded ?? 0} runs excluded)`), inner, styler));
  }
  if (wi.filter && wi.input) {
    const count = Array.isArray(wi.matches) ? wi.matches.length : 0;
    const top = wi.matches?.[0];
    const note = styler.fg("dim", ` ${count} match${count === 1 ? "" : "es"}${top ? ` → ${top.provider}/${top.id}` : ""}`);
    const inputW = Math.max(8, inner - 2 - styler.visibleLen(note));
    out.push(fitLine(styler.fg("accent", "/ ") + styler.lineInput(wi.input, inputW) + note, inner, styler));
  }
  return out;
}

/**
 * The plans block, FACTS only: the declared price, the window's attributed runs and the amortized
 * per-run figure, then each declared vendor window's OBSERVED peak. No remaining, no burn-down: the
 * fold reports what happened, and where the vendor discloses no limit the line says exactly that
 * rather than inventing a denominator -- the same refusal the spend meter makes on an unknown cap.
 */
function planLines(fold: any, inner: number, styler: any): string[] {
  const plans = Array.isArray(fold.plans) ? fold.plans : [];
  if (plans.length === 0) return [];
  const out: string[] = [];
  plans.forEach((p: any, i: number) => {
    const label = i === 0 ? styler.fg("muted", "plans") + "  " : " ".repeat(7);
    const price = `$${p.price?.amount ?? "?"}/${p.price?.per === "month" ? "mo" : p.price?.per ?? "mo"}`;
    const amortized = p.amortizedPerRun
      ? styler.fmtCost(p.amortizedPerRun) + styler.fg("dim", "/run amortized")
      : styler.fg("dim", "no runs attributed");
    out.push(fitLine(label + styler.fg("text", `${p.id}${p.hypothetical ? " (hypothetical)" : ""} ${price} · ${p.attributedRuns ?? 0} runs · `) + amortized, inner, styler));
    for (const w of p.windows ?? []) {
      const limit = w.limit === null || w.limit === undefined ? "limit undisclosed by vendor" : `limit ${w.limit} ${w.unit ?? ""}`.trim();
      out.push(fitLine(" ".repeat(7) + styler.fg("dim", `peak ${w.per}${w.rolling ? " rolling" : ""} window: ${w.peakRuns} runs, ${fmtTokens(w.peakTokens ?? 0)} tok — ${limit}`), inner, styler));
    }
  });
  return out;
}

/** The honesty ledger beside the numbers: which pi-ai priced them, how many runs were never measured or
 * cannot be re-priced, and (only when it happened) how many were priced under a different pi-ai. */
function provenanceLine(fold: any, inner: number, styler: any): string {
  const prov = fold.provenance ?? {};
  let text = `~ estimates at pi-ai ${prov.piAiPin ?? "?"} · ${prov.runsUnmetered ?? 0} runs unmetered · ${prov.runsUnledgered ?? 0} not repriceable`;
  if ((prov.ratesDrifted ?? 0) > 0) text += ` · ${prov.ratesDrifted} priced under older rates`;
  // Only when it happened, like the drift counter: a fanout past the 8-row ledger cap loses per-model
  // attribution, and the by-model table must not look complete while rows hide inside `other`.
  if ((prov.runsLedgerTruncated ?? 0) > 0) text += ` · ${prov.runsLedgerTruncated} ledgers truncated`;
  return fitLine(styler.fg("dim", text), inner, styler);
}

/** The COSTS footer hints -- one line, every layer's keys named. `[f] table` names the cycle rather
 * than enumerating four table names into a footer that must fit width 80 whole. */
function costsHints(inner: number, styler: any): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  return fitLine([k("[↑↓]", "row"), k("[f]", "table"), k("[t]", "7d/30d/mtd"), k("[w]", "what-if"), k("[esc]", "back")].join(" "), inner, styler);
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
  // The search bar is the view's last body line, COSTS-filter style: a 2-col `/ ` sigil plus the focused
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
      (x) => x?.replica > 0 && x.replica !== r.replica && x.target === r.target && x.flow === r.flow,
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
