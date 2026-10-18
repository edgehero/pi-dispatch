/**
 * The console's live hub (issue #641, DES-OPERATOR-CONSOLE "Stream lifecycle"): server-rendered panels over
 * Server-Sent Events, and the JSON projection `/api/state` answers with.
 *
 * ONE POLL LOOP, ONLY WHILE SOMEONE WATCHES. The timer starts with the first stream and stops with the last, so a
 * console nobody has open costs Valkey nothing. Each tick:
 *
 *   1. the tokens file is read ONCE, and every stream's session is re-judged with `peekSession` (every check `get`
 *      makes, without moving `lastSeen`: an open tab must not keep an idle session alive, only a request does). A dead
 *      session gets `event: end` and its stream is closed, so logout elsewhere, revoke, rotate, end-all and expiry all
 *      end a stream within one tick;
 *   2. a stream whose socket buffer holds more than `maxBufferBytes` (a reader that stopped reading) is cut, so one
 *      stalled browser cannot grow this process's memory; it reconnects to a fresh snapshot;
 *   3. `loadPageData` runs ONCE per distinct page + query, however many streams show it, and for a page with a
 *      `pageMinMs` (the runs page) at most once per that many ms;
 *   4. `pagePanels` renders each view (page + query + the viewer's role and name: the role rule makes a viewer's panels
 *      differ from an operator's), and only the panels whose digest changed are written, each as
 *      `id: <seq>`, `event: panel`, `data: {"id","html"}`.
 *
 * A NEW STREAM gets every panel of its view first, unless its `Last-Event-ID` is the view's current seq (it already
 * holds exactly this). The seq carries a per-process epoch, so an id from before a restart never matches by accident.
 *
 * A FAILURE IS ONE KEY'S. A `loadPageData` or `pagePanels` that throws skips that key this tick (its streams keep what
 * they last got) and logs the page name and an error code, never a message or data; the other keys and the loop go on.
 * The line is written when a key starts failing, not every second it stays failed (a down Valkey would otherwise write
 * one a second per open page), and once more when it recovers.
 *
 * A SECOND SUBSCRIPTION TYPE, THE LIVE TRANSCRIPT (issue #643, `subscribeTranscript`): one run's transcript stream for
 * an operator. It shares everything above that is not a page: the slots (the server takes them for both kinds alike),
 * the session re-check with `peek` and its `event: end`, the 2 MiB cut, the ping and the one timer. Its own step 5:
 *
 *   5. `transcriptSince` runs ONCE per distinct job per tick, from the OLDEST cursor among that job's streams, and the
 *      page is fanned out to each stream from its own cursor (`id: <stream id>`, `event: entry`, `data: {"html"}`, the
 *      html server-rendered by `transcript.mjs`). Streams at the tip, however many, cost one read; a stream that came
 *      in behind (a reconnect with an old `Last-Event-ID`, or none) is caught up a few pages per tick
 *      (`transcriptPagesPerTick`), the others waiting at most those ticks. A stream whose cursor reaches the `end`
 *      entry gets `event: done` with `{"outcome"}` and is closed (the browser closes its EventSource on it, so it is
 *      not reopened). A read that is unreachable skips that job this tick, logged once, as a failing page is.
 *
 * Transcript text never enters a view, a panel or `/api/state`: it goes from the read to the one stream that asked.
 *
 * Every seam is injected (`now`, `timers`, `random`), so the tests drive ticks by hand and never wait 15 seconds.
 */
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { scrubControls } from "../panel.mjs";
import { LIVE_TOOL_RE } from "@edgehero/pi-dispatch/live-transcript";
import { STEER_ID_RE, STEER_MODES, STEER_SOURCES, STEER_STATES } from "@edgehero/pi-dispatch/steer-inbox";
import { compareTranscriptIds, TRANSCRIPT_PAGE_MAX } from "../read-model.mjs";
import { transcriptEntryHtml } from "./transcript.mjs";

/**
 * `pageMinMs`: pages whose data is read at most once per that many ms, however often the loop ticks. The runs page
 * examines up to 2000 records per distinct filter, so 32 streams with 32 filters at the 1 s tick would keep a core busy;
 * at 5 s its views still move, at a fifth of the cost. The run detail (live since issue #644, for its progress panel)
 * reads its record, its children (up to three runs pages), two Valkey keys and (issue #646) the job's inbox per load, so
 * it is held to 2 s; the worker writes progress at most once a second, so a 2 s view misses nothing an operator could
 * read. Between loads the last data is rendered again (cheap), so a new
 * view of the same page and query is drawn at once from it.
 */
export const LIVE_DEFAULTS = Object.freeze({ intervalMs: 1000, pingMs: 15_000, maxBufferBytes: 2 * 1024 * 1024, pageMinMs: Object.freeze({ runs: 5000, run: 2000 }), transcriptPagesPerTick: 4 });

const digestOf = (text) => createHash("sha256").update(text).digest("hex");

/** A canonical text for a parsed page query (keys sorted), so equal queries share one data key. */
export function queryKey(query) {
  if (query === null || query === undefined || typeof query !== "object") return "";
  const sorted = {};
  for (const k of Object.keys(query).sort()) sorted[k] = query[k];
  return JSON.stringify(sorted);
}

/** An error's code or name for a log line: a short word, never its message. */
function codeOf(e) {
  const c = e?.code ?? e?.name ?? "error";
  return typeof c === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(c) ? c : "error";
}

/**
 * The hub. `loadPageData(page, query)` resolves the page's data (the CLI binds its deps); `pagePanels(page, ctx)`
 * resolves `[{id, html}]` with `ctx = {query, session: {name, role}, data, readOnly}`; `peekSession(id, file)` and
 * `readTokens()` are the session store's `peek` and the server's token reader.
 *
 * THE ROLE IS PART OF EVERY VIEW KEY. A viewer's panels and an operator's differ (the operator's carry BullMQ's free
 * text), so a render is never shared across roles, nor across names: no stream is ever written a panel drawn for
 * another session's role.
 *
 * Returns `{ subscribe, subscribeTranscript, endSession, close, tick, size }`. `subscribe({res, sessionId, session,
 * page, query, lastEventId})` and `subscribeTranscript({res, sessionId, session, jobId, lastEventId})` return an
 * idempotent unsubscribe; the caller wires it to `res.on("close")`. The hub writes only the stream's body; the caller
 * has already sent the headers. `transcriptSince(jobId, after, {count})` is the fleet reader's (issue #643); without it
 * a transcript stream gets nothing but pings.
 */
export function makeLiveHub({
  loadPageData,
  pagePanels,
  peekSession,
  readTokens,
  readOnly = false,
  transcriptSince = null,
  transcriptPagesPerTick = LIVE_DEFAULTS.transcriptPagesPerTick,
  now = () => Date.now(),
  intervalMs = LIVE_DEFAULTS.intervalMs,
  pingMs = LIVE_DEFAULTS.pingMs,
  maxBufferBytes = LIVE_DEFAULTS.maxBufferBytes,
  pageMinMs = LIVE_DEFAULTS.pageMinMs,
  timers = { setInterval, clearInterval },
  // The canonical text of a page's query (the CLI passes pages.mjs's `pageQueryString`), so the hub and the page's
  // links agree on when two queries are the same view.
  queryKeyOf = (page, query) => queryKey(query),
  random = randomBytes,
  log = () => {},
}) {
  const epoch = random(4).toString("hex");
  /** Every open stream. */
  const subs = new Set();
  /** viewKey -> {seq, panels: Map(id -> {digest, html})}; dropped when its last stream leaves. */
  const views = new Map();
  let counter = 0;
  let timer = null;
  let lastPing = now();
  let running = null;
  let again = false;
  let closed = false;
  /** dataKey -> {at, data}: the last load of a page with a `pageMinMs`, reused until it is that old. */
  const loaded = new Map();
  /** Data and view keys that failed at their last attempt, so a lasting failure is logged once. */
  const failing = new Set();
  const failed = (key, line) => {
    if (!failing.has(key)) log(line);
    failing.add(key);
  };
  const recovered = (key, line) => {
    if (failing.delete(key)) log(line);
  };

  const viewKeyOf = (sub) => `${sub.page}\n${sub.qkey}\n${sub.session.role}\n${sub.session.name}`;
  const isPage = (sub) => sub.kind === "page";
  const pageSubs = () => [...subs].filter(isPage);
  const nextSeq = () => `${epoch}-${(counter += 1)}`;

  function startTimer() {
    if (timer === null) {
      lastPing = now();
      timer = timers.setInterval(() => void tick(), intervalMs);
      timer?.unref?.();
    }
  }

  function stopTimerIfIdle() {
    if (subs.size === 0 && timer !== null) {
      timers.clearInterval(timer);
      timer = null;
    }
  }

  function remove(sub) {
    if (!subs.delete(sub)) return;
    if (isPage(sub)) {
      const key = viewKeyOf(sub);
      if (!pageSubs().some((s) => viewKeyOf(s) === key)) views.delete(key);
    }
    stopTimerIfIdle();
  }

  /** Write to one stream; false (and the stream cut) when it threw or its buffer passed the limit. */
  function send(sub, text) {
    try {
      sub.res.write(text);
    } catch {
      cut(sub);
      return false;
    }
    if ((sub.res.writableLength ?? 0) > maxBufferBytes) {
      cut(sub);
      return false;
    }
    return true;
  }

  /** Drop a stream without a goodbye: its reader is not reading, so nothing more is queued behind the backlog. */
  function cut(sub) {
    remove(sub);
    try {
      sub.res.destroy();
    } catch {
      // already gone
    }
  }

  /** Tell a stream its session is over, then close it; the browser goes to /login on `end`. */
  function finish(sub) {
    remove(sub);
    try {
      sub.res.write("event: end\ndata: {}\n\n");
      sub.res.end();
    } catch {
      // already gone
    }
  }

  const panelEvent = (seq, id, html) => `id: ${seq}\nevent: panel\ndata: ${JSON.stringify({ id, html })}\n\n`;

  function sendFull(sub, view) {
    for (const [id, p] of view.panels) if (!send(sub, panelEvent(view.seq, id, p.html))) return;
    sub.needsFull = false;
  }

  async function runTick() {
    const t = now();
    // 1. sessions, with ONE read of the tokens file for every stream.
    let file = null;
    try {
      file = readTokens()?.file ?? null;
    } catch {
      file = null;
    }
    for (const sub of [...subs]) {
      let alive = null;
      try {
        alive = peekSession(sub.sessionId, file);
      } catch {
        alive = null;
      }
      if (!alive) finish(sub);
    }
    // 2. stalled readers.
    for (const sub of [...subs]) if ((sub.res.writableLength ?? 0) > maxBufferBytes) cut(sub);
    // 3 and 4. one load per data key, one render per view.
    const byData = new Map();
    for (const sub of pageSubs()) {
      const dk = `${sub.page}\n${sub.qkey}`;
      if (!byData.has(dk)) byData.set(dk, { page: sub.page, query: sub.query, subs: [] });
      byData.get(dk).subs.push(sub);
    }
    for (const [dk, { page, query, subs: group }] of byData) {
      let data;
      const minMs = Object.hasOwn(pageMinMs, page) ? pageMinMs[page] : 0;
      const held = minMs > 0 ? loaded.get(dk) : undefined;
      try {
        if (held && t - held.at < minMs) data = held.data;
        else {
          data = await loadPageData(page, query);
          if (minMs > 0) loaded.set(dk, { at: t, data });
        }
      } catch (e) {
        failed(`data\n${dk}`, `console: live data for page ${page} failed (${codeOf(e)}); its streams keep their last panels`);
        continue;
      }
      recovered(`data\n${dk}`, `console: live data for page ${page} is read again`);
      const byView = new Map();
      for (const sub of group) {
        const vk = viewKeyOf(sub);
        if (!byView.has(vk)) byView.set(vk, []);
        byView.get(vk).push(sub);
      }
      for (const [vk, viewers] of byView) {
        const live = viewers.filter((s) => subs.has(s));
        if (live.length === 0) continue;
        let rendered;
        try {
          rendered = await pagePanels(page, { query, session: { name: live[0].session.name, role: live[0].session.role }, data, readOnly });
        } catch (e) {
          failed(`view\n${vk}`, `console: live panels for page ${page} failed (${codeOf(e)}); its streams keep their last panels`);
          continue;
        }
        recovered(`view\n${vk}`, `console: live panels for page ${page} render again`);
        const view = views.get(vk) ?? { seq: null, panels: new Map() };
        const changed = [];
        for (const p of Array.isArray(rendered) ? rendered : []) {
          if (typeof p?.id !== "string") continue;
          const html = String(p.html ?? "");
          const digest = digestOf(html);
          if (view.panels.get(p.id)?.digest !== digest) changed.push(p.id);
          view.panels.set(p.id, { digest, html });
        }
        if (changed.length > 0 || view.seq === null) view.seq = nextSeq();
        // A stream may have left during the awaits above; only a view someone still shows is kept.
        if (!live.some((s) => subs.has(s))) continue;
        views.set(vk, view);
        for (const sub of live) {
          if (!subs.has(sub)) continue;
          if (sub.needsFull) {
            sendFull(sub, view);
            continue;
          }
          for (const id of changed) if (!send(sub, panelEvent(view.seq, id, view.panels.get(id).html))) break;
        }
      }
    }
    // 5. the live transcripts: one read per job, fanned out.
    await transcriptTick();
    // A key nobody shows any more is forgotten, failing or not, so a long-running console holds only what is open.
    const shown = new Set([...subs].flatMap((sub) => (isPage(sub) ? [`data\n${sub.page}\n${sub.qkey}`, `view\n${viewKeyOf(sub)}`] : [`transcript\n${sub.jobId}`])));
    for (const key of [...failing]) if (!shown.has(key)) failing.delete(key);
    for (const dk of [...loaded.keys()]) if (!shown.has(`data\n${dk}`)) loaded.delete(dk);
    // The keep-alive, so a proxy or the browser does not take a quiet stream for a dead one.
    if (t - lastPing >= pingMs) {
      lastPing = t;
      for (const sub of [...subs]) send(sub, ": ping\n\n");
    }
  }

  const entryEvent = (id, htmlText) => `id: ${id}\nevent: entry\ndata: ${JSON.stringify({ html: htmlText })}\n\n`;

  /** The run is over for this stream: `event: done` with the outcome, then close; the browser closes its EventSource. */
  function done(sub, outcome) {
    remove(sub);
    try {
      sub.res.write(`event: done\ndata: ${JSON.stringify({ outcome: typeof outcome === "string" ? outcome : "unknown" })}\n\n`);
      sub.res.end();
    } catch {
      // already gone
    }
  }

  /**
   * Step 5. Per job: read from the oldest cursor, write each stream the entries past its own cursor, and repeat while
   * a page came back full and a stream is still behind, up to `transcriptPagesPerTick` reads. A stream whose cursor is
   * at the `end` entry (the read says `ended` and its cursor is the read's `next`) is done.
   */
  async function transcriptTick() {
    if (typeof transcriptSince !== "function") return;
    const byJob = new Map();
    for (const sub of subs) {
      if (sub.kind !== "transcript") continue;
      if (!byJob.has(sub.jobId)) byJob.set(sub.jobId, []);
      byJob.get(sub.jobId).push(sub);
    }
    for (const [jobId, group] of byJob) {
      for (let page = 0; page < transcriptPagesPerTick; page += 1) {
        const live = group.filter((s) => subs.has(s));
        if (live.length === 0) break;
        const from = live.reduce((min, s) => (compareTranscriptIds(s.cursor, min) < 0 ? s.cursor : min), live[0].cursor);
        let read;
        try {
          read = await transcriptSince(jobId, from, { count: TRANSCRIPT_PAGE_MAX });
        } catch (e) {
          read = { unreachable: codeOf(e) };
        }
        if (!read || read.unreachable || read.invalid || !Array.isArray(read.entries)) {
          failed(`transcript\n${jobId}`, "console: a live transcript could not be read; its streams wait for the next tick");
          break;
        }
        recovered(`transcript\n${jobId}`, "console: a live transcript is read again");
        // Rendered once per entry, whichever streams it goes to.
        const rendered = read.entries.map((entry) => ({ id: entry.id, event: entryEvent(entry.id, String(transcriptEntryHtml(entry))) }));
        for (const sub of live) {
          if (!subs.has(sub)) continue;
          for (const r of rendered) {
            if (compareTranscriptIds(r.id, sub.cursor) <= 0) continue;
            if (!send(sub, r.event)) break;
            sub.cursor = r.id;
          }
          if (subs.has(sub) && read.ended && sub.cursor !== null && sub.cursor === read.next) done(sub, read.outcome);
        }
        // Another page only while this one was full (more may wait) and a stream is still behind the read.
        const full = read.entries.length >= TRANSCRIPT_PAGE_MAX;
        if (!full || !group.some((s) => subs.has(s) && compareTranscriptIds(s.cursor, read.next) <= 0)) break;
      }
    }
  }

  /** One tick; a tick asked for while one runs is folded into one more run after it, never run alongside. */
  function tick() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await runTick();
        } while (again && subs.size > 0);
      } catch (e) {
        log(`console: live tick failed (${codeOf(e)})`);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    subscribe({ res, sessionId, session, page, query = {}, lastEventId = null }) {
      if (closed) {
        try {
          res.end();
        } catch {
          // already gone
        }
        return () => {};
      }
      const sub = { kind: "page", res, sessionId, session: { name: String(session?.name ?? ""), role: String(session?.role ?? "") }, page, query, qkey: String(queryKeyOf(page, query)), needsFull: true };
      subs.add(sub);
      startTimer();
      const view = views.get(viewKeyOf(sub));
      if (view && view.seq !== null) {
        if (typeof lastEventId === "string" && lastEventId === view.seq) sub.needsFull = false;
        else sendFull(sub, view);
      } else {
        // Nothing rendered for this view yet: render it now rather than leave the page blank for a tick.
        void tick();
      }
      return () => remove(sub);
    },

    /**
     * One run's live transcript (issue #643): entries after `lastEventId` (a stream id the caller validated, else null
     * for the beginning). The first entries are read now rather than a tick later.
     */
    subscribeTranscript({ res, sessionId, session, jobId, lastEventId = null }) {
      if (closed) {
        try {
          res.end();
        } catch {
          // already gone
        }
        return () => {};
      }
      const sub = { kind: "transcript", res, sessionId, session: { name: String(session?.name ?? ""), role: String(session?.role ?? "") }, jobId: String(jobId), cursor: typeof lastEventId === "string" ? lastEventId : null };
      subs.add(sub);
      startTimer();
      void tick();
      return () => remove(sub);
    },

    /** End every stream of a session at once (logout). */
    endSession(sessionId) {
      for (const sub of [...subs]) if (sub.sessionId === sessionId) finish(sub);
    },

    /** End every stream and stop the timer; later subscribes are closed at once. */
    close() {
      closed = true;
      for (const sub of [...subs]) finish(sub);
      views.clear();
      loaded.clear();
      if (timer !== null) {
        timers.clearInterval(timer);
        timer = null;
      }
    },

    tick,

    /** Open streams and whether the timer runs, for tests and the log. */
    size() {
      return { streams: subs.size, views: views.size, timer: timer !== null };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// `/api/state`: the snapshot as JSON, PII-free and role-aware.
// ---------------------------------------------------------------------------------------------------------------------

const str = (v) => (typeof v === "string" ? scrubControls(v).slice(0, 200) : v === null || v === undefined ? null : scrubControls(String(v)).slice(0, 200));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const COUNT_KEYS = Object.freeze(["waiting", "active", "paused", "delayed", "failed"]);

function countsOf(c) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = num(Number(c?.[k] ?? 0)) ?? 0;
  return out;
}

/** A host's integer-as-text registry field as a number, or null for `off`, "" and anything else. */
function intOf(v) {
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string" && /^[0-9]{1,12}$/.test(v)) return Number(v);
  return null;
}

/**
 * An active row's progress (issue #644) as `/api/state` carries it: rebuilt field by field from the snapshot's integer
 * projection (`activeProgressOf`), so nothing else a row might hold rides along. Never a phase name or a note; the tool
 * name is the live stream's charset or `?`. Null when the row has none.
 */
function progressOf(p) {
  if (p === null || typeof p !== "object") return null;
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const r = p.running;
  const f = p.phase;
  return {
    turn: n(p.turn),
    steps: n(p.steps),
    failed: n(p.failed),
    running: r && typeof r === "object" ? { tool: typeof r.tool === "string" && LIVE_TOOL_RE.test(r.tool) ? r.tool : "?", since: n(r.since) } : null,
    phase: f && typeof f === "object" ? { index: n(f.index), count: n(f.count), done: n(f.done), total: n(f.total) } : null,
    ended: p.ended === true,
    updatedAt: n(p.updatedAt),
  };
}

/**
 * A steer-armed active job's inbox (issue #646) as `/api/state` carries it: each entry rebuilt by name against the
 * inbox's own vocabularies (`id`, `mode`, `source`, `state`, `at`, `bytes`), NEVER the text, which the snapshot does not
 * hold either. Null for a job that is not steer-armed, and for one whose inbox could not be read this tick (so `[]`
 * always means "no message").
 */
function inboxOf(a) {
  if (a?.steer !== true || !Array.isArray(a.inbox)) return null;
  const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  return a.inbox.map((e) => ({
    id: typeof e?.id === "string" && STEER_ID_RE.test(e.id) ? e.id : null,
    mode: STEER_MODES.includes(e?.mode) ? e.mode : null,
    source: STEER_SOURCES.includes(e?.source) ? e.source : null,
    state: STEER_STATES.includes(e?.state) ? e.state : null,
    at: n(e?.at),
    bytes: n(e?.bytes) ?? 0,
  }));
}

/** The `/api/state` document's version: a script checks it before it reads a field, and a breaking change bumps it. */
export const STATE_VERSION = 1;

/**
 * The JSON `/api/state` answers (the scripts' interface). Only host-chosen fields, by name: never a Job's `.data`,
 * never an error message (a Valkey error can name a host and port), never a host path (a folder scope's name is
 * dropped). `failed[].failedReason`, BullMQ's free text, is the operator's only; a viewer gets the rows without it.
 * Every `unreachable` is a boolean: whatever the reader caught stays in this process. `version` is `STATE_VERSION`.
 */
export function stateOf(snapshot, role, { now = Date.now() } = {}) {
  const s = snapshot ?? {};
  const operator = role === "operator";
  const q = s.queue ?? {};
  const failed = s.failed?.unreachable
    ? { unreachable: true, rows: [], more: 0 }
    : {
        unreachable: false,
        rows: (Array.isArray(s.failed?.rows) ? s.failed.rows : []).map((r) => ({
          jobId: str(r?.jobId),
          queue: str(r?.queue),
          attemptsMade: num(r?.attemptsMade),
          endedAt: num(r?.endedAt),
          ...(operator && { failedReason: str(r?.failedReason) }),
        })),
        more: num(s.failed?.more) ?? 0,
      };
  const dollarRows = Array.isArray(s.dollars?.rows) ? s.dollars.rows : [];
  return {
    version: STATE_VERSION,
    at: now,
    role: operator ? "operator" : "viewer",
    paused: { state: Boolean(q.pausedState), partial: Boolean(q.pausedPartial) },
    counts: countsOf(q.counts),
    queues: (Array.isArray(s.queueCounts) ? s.queueCounts : []).map((c) => ({ queue: str(c?.queue), paused: Boolean(c?.paused), counts: countsOf(c?.counts) })),
    workers: typeof q.workers === "number" ? q.workers : null,
    fleetDegraded: Boolean(q.fleetDegraded),
    hosts: (Array.isArray(s.hostBudgets) ? s.hostBudgets : []).map((h) => ({
      name: str(h?.name),
      lastBeatAgeMs: num(h?.staleMs),
      capacity: { memMiB: intOf(h?.budgetMemMiB), cpuCenti: intOf(h?.budgetCpuCenti), concurrency: intOf(h?.concurrency) },
      running: Array.isArray(h?.jobs) ? h.jobs.length + (num(h?.jobsMore) ?? 0) : intOf(h?.budgetRunning),
    })),
    budget: {
      day: num(s.budget?.day),
      week: num(s.budget?.week),
      month: num(s.budget?.month),
      tokensToday: num(s.budget?.tokensToday),
    },
    dollars: {
      unreachable: Boolean(s.dollars?.unreachable),
      windows: dollarRows.map((r) => ({
        ledger: str(r?.ledger),
        scope: typeof r?.name === "string" && !isAbsolute(r.name) ? str(r.name) : null,
        window: str(r?.window),
        capMicros: num(r?.capMicros),
        counterMicros: num(r?.counterMicros),
        full: Boolean(r?.full),
      })),
    },
    parked: (Array.isArray(s.parked) ? s.parked : []).map((p) => ({ target: str(p?.target), kind: str(p?.kind), ageMs: num(p?.ageMs), chainCount: num(p?.chainCount) })),
    // True when the parked list could not be read: `parked: []` then means "unknown", never "nobody is waiting".
    parkedUnknown: Boolean(s.parkedUnreachable),
    failures24h: num(s.failures24h),
    failures24hFloor: Boolean(s.failures24hFloor),
    active: (Array.isArray(s.active) ? s.active : []).map((a) => ({ jobId: str(a?.jobId), queue: str(a?.queue), startedAt: num(a?.startedAt), host: str(a?.host), progress: progressOf(a?.progress), steer: a?.steer === true, inbox: inboxOf(a) })),
    schedulers: (Array.isArray(s.schedulers) ? s.schedulers : []).map((x) => {
      const name = x?.key ?? x?.name ?? null;
      return {
        name: str(name),
        next: num(x?.next),
        overdue: num(x?.overdueMs) !== null && x.overdueMs > 0,
        overdueMs: num(x?.overdueMs),
        stalls: num(Number(s.schedulerStalls?.[name] ?? 0)) ?? 0,
      };
    }),
    schedulerStallMax: num(s.schedulerStallMax),
    failed,
  };
}
