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
 * Three in-component views share this one overlay: LIST -- a framed monochrome panel of status, spend,
 * the unified TRIGGERS pane and an interactive runs list; RUN_DETAIL -- a drill-in of one run's PII-free
 * `.json` fields; and LIVE_TAIL -- a tail of a running job's `.log`.
 *
 * PII discipline (no-pii-in-logs, INT-RUN-HISTORY-FILE-CONTRACT): LIST and RUN_DETAIL surface only
 * PII-free run records, counts, budget, schedulers and the settings overlay. LIVE_TAIL renders tail bytes
 * obtained through the injected `tailLog` seam whose `fs` access lives in index.ts, so this module never
 * touches the filesystem -- the bytes reach the overlay alone, never `snapshot`, never a shared renderer,
 * never a message.
 */
import { dayKey, weekKey, monthKey, tokenDayKey, windowState } from "@pi-dispatch/worker/budget";
import { parseConnection, makeRedisClient } from "@pi-dispatch/worker/connection";
import { makeQueue } from "@pi-dispatch/worker/queue";
import { STALL_KEY } from "@pi-dispatch/worker/scheduler-stall-guard";
import { windowEndAt } from "@pi-dispatch/worker/pause-windows";
import { listRuns, readSettingsView, mapSchedulers, readTriggers, readPauseWindows, readStagedPackages } from "./read-model.mjs";
import { renderStatus, renderBudget, renderTriggers, renderSettingsView } from "./render.mjs";
import { matchesKey } from "./keys.mjs";
import { box, meter, clip } from "./panel.mjs";
import { makeStyler, frame, RULE } from "./style.mjs";

const KEY_HINTS = "[p]ause  [r]esume  [q]uit";
const RUNS_ON_DASHBOARD = 10;
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
  const styler = makeStyler(theme);
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

  const refresh = async () => {
    if (fetching || disposed) return;
    fetching = true;
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
      const rows = buildRows(snapshot);
      if (selected > rows.length - 1) selected = Math.max(0, rows.length - 1);
      // Clamp the tail scroll so a shrinking log can never scroll past the end.
      if (view === "LIVE_TAIL") {
        const len = Array.isArray(tail?.lines) ? tail.lines.length : 0;
        const maxTop = Math.max(0, len - TAIL_VIEWPORT);
        tailTop = Math.min(Math.max(0, tailTop), maxTop);
      }
      return renderPanel(snapshot, width, {
        view,
        selected,
        detailRun,
        detailTrigger,
        tailJobId,
        tail,
        tailTop,
        tailAvailable: typeof deps?.tailLog === "function",
        detailSandbox,
        sandboxAvailable: typeof deps?.launchSandbox === "function",
      }, styler);
    },
    invalidate(): void {
      // No cached render state to clear; the TUI redraws from render().
    },
    handleInput(data: string): void {
      if (view === "RUN_DETAIL") {
        // Escape backs out to the list only; it never closes the overlay or disposes the held clients.
        if (matchesKey(data, "escape")) {
          view = "LIST";
          detailSandbox = null;
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
        // Every other key (including q/p/r) is inert in the detail view.
        return;
      }
      if (view === "TRIGGER_DETAIL") {
        // Read-only trust-model view. `e` edits the flow, `x` deletes -- both close the overlay with a CRUD
        // action the command loop drives via ctx.ui dialogs, then reopens; Esc backs out to the list.
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
          void dispose().finally(() => done({ action: "deleteTrigger", index: detailTrigger?.index }));
          return;
        }
        return;
      }
      if (view === "LIVE_TAIL") {
        // Escape backs out to the list and drops the held tail bytes; scroll keys move the window. Every
        // other key is inert. This view never closes the overlay or disposes the held clients.
        if (matchesKey(data, "escape")) {
          view = "LIST";
          tailJobId = null;
          tail = null;
          tailTop = 0;
          tui?.requestRender?.();
          return;
        }
        const len = Array.isArray(tail?.lines) ? tail.lines.length : 0;
        const maxTop = Math.max(0, len - TAIL_VIEWPORT);
        if (matchesKey(data, "up")) {
          tailTop = Math.max(0, tailTop - 1);
          tui?.requestRender?.();
        } else if (matchesKey(data, "down")) {
          tailTop = Math.min(maxTop, tailTop + 1);
          tui?.requestRender?.();
        } else if (matchesKey(data, "pageUp")) {
          tailTop = Math.max(0, tailTop - TAIL_VIEWPORT);
          tui?.requestRender?.();
        } else if (matchesKey(data, "pageDown")) {
          tailTop = Math.min(maxTop, tailTop + TAIL_VIEWPORT);
          tui?.requestRender?.();
        }
        return;
      }
      if (matchesKey(data, "escape") || data === "q" || data === "Q") {
        void dispose().finally(() => done(undefined));
        return;
      }
      if (data === "\r" || data === "\n") {
        const rows = buildRows(snapshot);
        const row = rows[selected];
        if (!row) return;
        if (row.kind === "trigger") {
          detailTrigger = { record: row.trigger, index: row.index };
          view = "TRIGGER_DETAIL";
          tui?.requestRender?.();
        } else if (row.kind === "active") {
          // Opening the tail: fire an immediate fetch so the first frame carries the tail, not the next tick.
          tailJobId = row.jobId;
          tailTop = 0;
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
        selected = Math.min(Math.max(0, buildRows(snapshot).length - 1), selected + 1);
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
  const { view, selected, detailRun, detailTrigger, tailJobId, tail, tailTop, tailAvailable, detailSandbox, sandboxAvailable } = state;
  const framed = Number.isFinite(width) && Math.trunc(width) >= MIN_WIDTH;
  const inner = Math.trunc(width) - 4;
  const title = "pi-dispatch";

  if (view === "TRIGGER_DETAIL") {
    const t = detailTrigger?.record;
    const detailTitle = `trigger · ${t?.type ?? "?"}`;
    const dw = framed ? Math.min(Math.trunc(width), DRILL_WIDTH) : Math.trunc(width);
    const sched = cronSchedInfo(t, snapshot);
    const lines = renderTriggerDetail(t, framed ? dw - 4 : 24, styler, sched, snapshot?.stagedPackages);
    if (!framed) return [detailTitle, "", ...lines.map((l: string) => styler.stripAnsi(l)), "", "e edit · x delete · esc back"];
    const boxed = frame(styler, { title: detailTitle, width: dw, lines, footer: triggerDetailHints(dw - 4, styler) });
    return centerBlock(boxed, Math.trunc(width), dw);
  }

  if (view === "RUN_DETAIL") {
    const detailTitle = `run ${detailRun?.jobId ?? "-"}`;
    const dw = framed ? Math.min(Math.trunc(width), DRILL_WIDTH) : Math.trunc(width);
    const allRuns = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
    const canOpen = Boolean(sandboxAvailable && detailSandbox?.retained);
    const lines = renderRunDetail(detailRun, framed ? dw - 4 : 24, styler, allRuns, detailSandbox);
    if (!framed) return [detailTitle, "", ...lines.map((l: string) => styler.stripAnsi(l)), "", canOpen ? "b sandbox · esc back" : "esc back"];
    const boxed = frame(styler, { title: detailTitle, width: dw, lines, footer: runDetailHints(dw - 4, styler, canOpen) });
    return centerBlock(boxed, Math.trunc(width), dw);
  }

  if (view === "LIVE_TAIL") {
    return renderLiveTail({ snapshot, framed, width, tailJobId, tail, tailTop, tailAvailable });
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
  // and colored last, so pi's ANSI-aware visibleWidth frames it correctly.
  if (framed) {
    const lines = buildListLines(snapshot, selected, inner, styler);
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
    { title: "RUNS", lines: renderRunList(buildRows(snapshot), selected, 24) },
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

/** Compose the colored LIST body lines (RULE marks a `├──┤` separator). */
function buildListLines(snapshot: any, selected: number, inner: number, styler: any): any[] {
  const lines: any[] = [];
  lines.push(statusHeader(snapshot.queue, inner, styler));
  lines.push(RULE);

  lines.push(styler.divider("spend & limits", "jobs & tokens/day · s set", inner));
  for (const l of spendLines(snapshot.budget, snapshot.settings, inner, styler)) lines.push(l);
  lines.push(RULE);

  // Triggers are selectable and come FIRST in buildRows, so a trigger's file index == its selection index.
  const trg = triggerLines(snapshot.triggers, selected, inner, styler);
  lines.push(styler.divider("triggers", `${trg.count} standing · a add · ↵ open`, inner));
  for (const l of trg.lines) lines.push(l);
  lines.push(RULE);

  const pw = pauseLines(snapshot.pauseWindows, inner, styler);
  lines.push(styler.divider("pause windows", `${pw.count} · w manage`, inner));
  for (const l of pw.lines) lines.push(l);
  lines.push(RULE);

  // Active + run rows follow the triggers in buildRows, so offset the selection index by the trigger count.
  const runRows = buildRows(snapshot).slice(trg.count);
  const runCount = Array.isArray(snapshot.runs) ? snapshot.runs.length : 0;
  lines.push(styler.divider("runs", `last ${runCount}`, inner));
  for (const l of runLines(runRows, selected - trg.count, inner, styler)) lines.push(l);
  lines.push(RULE);

  lines.push(styler.divider("settings", "s edit", inner));
  for (const l of settingsLines(snapshot.settings, inner, styler)) lines.push(l);
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

/** The configured triggers as colored rows: `<kind>  <match>  → <target> <flow>`. */
function triggerLines(triggers: any, selected: number, inner: number, styler: any): { count: number; lines: string[] } {
  const lines: string[] = [];
  if (triggers && triggers.missing) { lines.push(styler.cell("(triggers file not found · a to add)", inner, { color: "dim" })); return { count: 0, lines }; }
  if (triggers && triggers.invalid) { lines.push(styler.cell(`(triggers file invalid: ${triggers.invalid})`, inner, { color: "error" })); return { count: 0, lines }; }
  const list = (triggers && triggers.triggers) ?? [];
  if (list.length === 0) { lines.push(styler.cell("(no triggers · a to add)", inner, { color: "dim" })); return { count: 0, lines }; }
  list.forEach((t: any, i: number) => lines.push(triggerRow(t, i === selected, inner, styler)));
  return { count: list.length, lines };
}

function triggerRow(t: any, sel: boolean, inner: number, styler: any): string {
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
  return fitLine(`${cursor} ${badge} ${matchColored(t, styler)} ${targetColored(t, styler)}${pkgs}${img}${res}${rep}`, inner, styler);
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

/** The interactive RUNS list, colored: cursor, id, target, flow, outcome (✔/⚠/✘), turns, tokens. */
function runLines(rows: any[], selected: number, inner: number, styler: any): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [styler.cell("(no runs)", inner, { color: "dim" })];
  return rows.map((row, i) => runRow(row, i === selected, inner, styler));
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
  const cells = [
    styler.fg("text", r.jobId ?? "-"),
    styler.fg("muted", r.target ?? "-"),
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
        t?.type === "comment" ? "authorized by a collaborator comment (author_association) + HMAC" : "authorized by a collaborator's label + HMAC webhook + author gate",
        "dedup by X-GitHub-Delivery GUID (redelivery-safe)",
        where,
      ];
  }
}

/** The TRIGGER_DETAIL footer hints. */
function triggerDetailHints(inner: number, styler: any): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  return fitLine([k("e", "edit flow"), k("x", "delete"), k("esc", "back")].join(styler.fg("dim", "  ·  ")), inner, styler);
}

/** The colored key-hint footer. */
function keyHints(inner: number, styler: any): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  const hints = [k("↑↓", "select"), k("↵", "open"), k("a", "add"), k("w", "pauses"), k("l", "logs"), k("p", "pause"), k("r", "resume"), k("q", "quit")].join(styler.fg("dim", " · "));
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
function buildRows(snapshot: any): any[] {
  // Triggers lead the selectable list (Enter -> TRIGGER_DETAIL), then the optional ACTIVE row, then runs.
  // A trigger row carries its file `index` so a CRUD action can target the right entry in triggers.json.
  const triggers = (snapshot?.triggers?.triggers ?? []).map((t: any, i: number) => ({ kind: "trigger", trigger: t, index: i }));
  const active = snapshot?.activeJobId ? [{ kind: "active", jobId: snapshot.activeJobId }] : [];
  const runs = (Array.isArray(snapshot?.runs) ? snapshot.runs : []).map((record: any) => ({ kind: "run", record }));
  return [...triggers, ...active, ...runs];
}

/**
 * The interactive RUNS list over the rows model: one compact row per entry, cursor-prefixed (`›` on the
 * selected row, space otherwise). The ACTIVE row leads with its id-only job id; run rows lead with `jobId`
 * so a jobId match still hits. Each row is `clip`ped to the inner column count so a long target can neither
 * overflow the frame nor mis-size a row. Operates only on the passed rows -- no read, no `.log`, no `.data`.
 */
function renderRunList(rows: any[], selected: number, w: number): string[] {
  if (!Array.isArray(rows) || rows.length === 0) return [clip("(no runs)", w)];
  return rows.map((row, i) => {
    const cursor = i === selected ? "›" : " ";
    if (row.kind === "active") return clip(`${cursor} * ACTIVE ${row.jobId} running`, w);
    const run = row.record;
    // The plain twin of the colored badge in `runRow`. It has to be here too: this is the renderer a
    // non-TTY/no-color panel uses, and "one of two racing runs" must not be a fact only the pretty one tells.
    const rep = run?.replica > 0 ? `r${run.replica}/${run.replicas ?? "?"} ` : "";
    const cells = [run?.jobId, run?.target, run?.flow, run?.outcome, run?.turns, run?.tokens?.total]
      .map((f) => (f === null || f === undefined ? "-" : String(f)))
      .join(" · ");
    return clip(`${cursor} ${rep}${cells}`, w);
  });
}

/**
 * The LIVE_TAIL view: a bounded, scrollable window of a running job's captured `.log`, framed in the
 * overlay. The tail bytes arrive here only through render() -> this pure function and are returned as
 * overlay lines; they never enter `snapshot`, a shared renderer, or `sendMessage` (INT-RUN-HISTORY-FILE-CONTRACT).
 * Four states: capability absent, no captured log, the windowed tail, and the tail after the job left the
 * active slot. `tailTop` is clamped to `[0, maxTop]` so a shrunk log cannot scroll past the end.
 */
function renderLiveTail({ snapshot, framed, width, tailJobId, tail, tailTop, tailAvailable }: any): string[] {
  const boxTitle = `live ${tailJobId}`;
  let lines: string[];
  let footer: string;
  if (tail === null && !tailAvailable) {
    lines = ["live tail unavailable in this build"];
    footer = "Esc back";
  } else if (tail?.missing) {
    lines = [`live ${tailJobId} -- no captured log (PI_CAPTURE_JOB_LOGS off or not found)`];
    footer = "Esc back";
  } else {
    const all = Array.isArray(tail?.lines) ? tail.lines : [];
    const len = all.length;
    const maxTop = Math.max(0, len - TAIL_VIEWPORT);
    const top = Math.min(Math.max(0, tailTop), maxTop);
    lines = [`live ${tailJobId} -- ${len} line(s)`, ...all.slice(top, top + TAIL_VIEWPORT)];
    // The job left the active slot (ended, or a different job now runs): keep showing the last tail.
    if (snapshot?.activeJobId !== tailJobId) lines.push("(run ended -- Esc to go back)");
    footer = `[${Math.min(top + TAIL_VIEWPORT, len)}/${len}]  Up/Down PgUp/PgDn scroll, Esc back`;
  }
  if (!framed) return [boxTitle, "", ...lines, "", footer];
  return box({ title: boxTitle, footer, width, sections: [{ lines }] });
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

  out.push(kv("target", `${show(r.target)} · flow ${show(r.flow)}`, "accent"));

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
 * The RUN_DETAIL footer hint. Still a read-only post-mortem, with one action: `b` re-opens this run's
 * sandbox, offered ONLY while a retained workspace exists, so the key is never advertised where it would
 * do nothing (`triggerDetailHints` is the shape).
 */
function runDetailHints(inner: number, styler: any, canOpen = false): string {
  const k = (key: string, label: string) => styler.fg("accent", key) + " " + styler.fg("dim", label);
  const bits = canOpen ? [k("b", "sandbox"), k("esc", "back")] : [k("esc", "back")];
  return fitLine(bits.join(styler.fg("dim", "  ·  ")), inner, styler);
}
