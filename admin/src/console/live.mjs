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
 *      end a stream within one tick. The end's data says why (`{"ended": <reason>}`, issue #737): the reason comes
 *      from the injected `endedReason` (the store's pure `verdict`, never `get`, which would delete the session under
 *      the request that should end it the ordinary way), held to `STREAM_ENDS` by `streamEndOf`, so a stream never
 *      ends with `restart` (this process opened it) nor with a word the page does not know; anything else is `null`,
 *      which the page reads as "signed out, reason unknown". `close()` ends every stream with `shutdown`, the console
 *      stopping, which the page and the terminal chat treat as a connection to wait for, not a sign-out.
 *
 *      A TOKENS FILE THAT CANNOT BE READ JUDGES NOBODY. Ending every stream then would sign every tab out over a
 *      chmod mistake, and drawing panels would send data to sessions nobody judged. So for that tick nothing is ended
 *      and nothing is written but the keep-alive: each page stream is told `stale` once, the line is logged once, and
 *      the first tick that reads the file again judges every session and draws as usual (a session that died in
 *      between ends then, with its reason);
 *   2. a stream whose socket buffer holds more than `maxBufferBytes` (a reader that stopped reading) is cut, so one
 *      stalled browser cannot grow this process's memory; it reconnects to a fresh snapshot;
 *   3. `loadPageData` runs ONCE per distinct page + data key, however many streams show it, and for a page with a
 *      `pageMinMs` (the runs page) at most once per that many ms. The data key is the part of the query the page's data
 *      depends on (`dataQueryOf`, issue #737): the overview's grouping, zoom and project only regroup one snapshot, so
 *      every overview query shares one load; any other page's is its whole query;
 *   4. `pagePanels` renders each view (page + whole query + the viewer's role and name: the role rule makes a viewer's
 *      panels differ from an operator's), and only the panels whose digest changed are written, each as
 *      `id: <seq>`, `event: panel`, `data: {"id","html"}`.
 *
 * A NEW STREAM gets every panel of its view after its state (below), unless its `Last-Event-ID` is the view's current
 * seq (it already holds exactly this). The seq carries a per-process epoch, so an id from before a restart never
 * matches by accident.
 *
 * A FAILURE IS ONE KEY'S. A `loadPageData` or `pagePanels` that throws skips that key this tick (its streams keep what
 * they last got) and logs the page name and an error code, never a message or data; the other keys and the loop go on.
 * The line is written when a key starts failing, not every second it stays failed (a down Valkey would otherwise write
 * one a second per open page), and once more when it recovers, which only a GOOD load (and render) is. A load whose
 * primary read failed (`data.readFailed`, which `loadPageData` sets where it swallowed the throw) is a failure too.
 *
 * A FAILED LOAD NEVER TOUCHES A VIEW. A view holds good renders only, so its digests are always those of what its
 * holders were last sent, and its next good render sends each of them every panel that changed since. A stream whose
 * browser HOLDS PANELS (`sub.holds`) is never sent a panel from a failed load: it is told `stale` once and keeps what it
 * shows. A stream holds panels once this hub sent it a good render, once it came with a `Last-Event-ID` (a browser
 * reconnecting holds the panels it was drawn with, whatever this hub still has; the view it was drawn from goes when its
 * last stream leaves), and once it was told `stale` (its page then says what it shows is as last seen). A stream that
 * holds none (a first stream, with no Last-Event-ID and nothing good or stale said to it yet) is drawn the degraded
 * panels the read-failed load makes, for it alone (`drawDegraded`, never into the view another stream of the same
 * person may hold a good render in): the page the server just drew already says "could not be read", and there is
 * nothing older to keep. It still needs its view whole once a good render comes. A load or a render that throws draws
 * nothing for anyone and tells each of its streams `stale`, so each then holds.
 *
 * EVERY PAGE STREAM IS TOLD ITS STATE, FIRST (issue #737). Kept panels would otherwise look current, and a page cannot
 * tell from its own stream opening whether what it holds is current. So before any panel a tick sends it, a page stream
 * is told: `event: fresh` once its page's load and render succeeded, `event: stale` with `{"since", "what"}` once they
 * failed and its browser holds panels, or (a throw, or the tokens file) once they failed at all. `since` is the hub
 * clock of its view's last good render, or null when the hub has none (a view goes with its last stream, so a lone tab
 * that reconnects is told null: the page keeps the time it was told before); `what` is `tokens` (the console's tokens
 * file, which judges nobody) or `data` (the page's load or render), so the page never blames the deployment's data
 * for a tokens file. Each is said once, and again only when it changes (`sub.said`), so a page stream's first message is
 * its state (a degraded draw, which says what the page already says, is the one draw with none), and the page takes its
 * dimming back on `fresh` alone. A reconnect is a new stream: one that comes back while its page still fails is told
 * `stale` before anything else, and one that comes back after it recovered is told `fresh`. At subscribe only the page's
 * data and render are judged: the stream's own request has just read the tokens file, so a tokens failure the last tick
 * saw is the next tick's to say again, if it still holds. Transcript streams never get either: their entries are a log,
 * not a picture that can go out of date.
 *
 * A SECOND SUBSCRIPTION TYPE, THE LIVE TRANSCRIPT (issue #643, `subscribeTranscript`): one run's transcript stream for
 * an operator. It shares everything above that is not a page: the slots (the server takes them for both kinds alike),
 * the session re-check with `peek` and its `event: end`, the 2 MiB cut, the ping and the one timer. Its own step 5:
 *
 *   5. `transcriptSince` runs ONCE per distinct job per tick, from the OLDEST cursor among that job's streams, and the
 *      page is fanned out to each stream from its own cursor (`id: <stream id>`, `event: entry`, `data: {"html"}`, the
 *      html server-rendered by `transcript.mjs`, or, for a `format=json` stream (issue #647), the structured entry
 *      `transcriptEntryJson` rebuilds). Streams at the tip, however many, cost one read; a stream that came
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
import { beatAgeOf } from "../doctor-view.mjs";
import { scrubControls } from "../panel.mjs";
import { LIVE_TOOL_RE } from "@edgehero/pi-dispatch/live-transcript";
import { STEER_ID_RE, STEER_MODES, STEER_SOURCES, STEER_STATES } from "@edgehero/pi-dispatch/steer-inbox";
import { compareTranscriptIds, TRANSCRIPT_PAGE_MAX } from "../read-model.mjs";
import { RUN_ID_RE } from "./panels.mjs";
import { STREAM_SHUTDOWN, streamEndOf } from "./session-ends.mjs";
import { transcriptEntryHtml, transcriptEntryJson } from "./transcript.mjs";

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

/** The line a tokens file that cannot be read logs once, and the one its return logs. */
export const TOKENS_HELD_LINE = "console: the tokens file cannot be read; live streams are held, sent nothing, until it can";
export const TOKENS_BACK_LINE = "console: the tokens file is read again; live streams are judged and drawn again";

/**
 * The hub. `loadPageData(page, query)` resolves the page's data (the CLI binds its deps), called with
 * `dataQueryOf(page, query)`; `pagePanels(page, ctx)` resolves `[{id, html}]` with `ctx = {query, session: {name, role},
 * data, readOnly}`, `query` the view's whole query; `peekSession(id, file)` and
 * `readTokens()` are the session store's `peek` and the server's token reader. `endedReason(id, file)` says why a
 * session that failed `peekSession` ended (the CLI binds the store's `verdict`); without it every end says null.
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
  endedReason = null,
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
  // Issue #737: the part of a page's query its DATA depends on (the CLI passes pages.mjs's `dataQueryOf`: the
  // overview's rows, zoom and project only regroup one snapshot, so its load takes `{}`), and that part's canonical
  // text. Streams whose data keys agree share one load per tick; each view is still keyed, and rendered, by its whole
  // query. The defaults are the whole query: one load per distinct page and query.
  dataQueryOf = (page, query) => query,
  dataKeyOf = (page, query) => queryKeyOf(page, dataQueryOf(page, query)),
  random = randomBytes,
  log = () => {},
}) {
  const epoch = random(4).toString("hex");
  /** Every open stream. */
  const subs = new Set();
  /**
   * viewKey -> {seq, at, panels: Map(id -> {digest, html})}, made and changed by GOOD renders alone (see the header);
   * dropped when its last stream leaves. `at` is the hub clock of the view's last render: what `stale` says the kept
   * panels date from.
   */
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
  /** The stream's data key: its page and the canonical text of the part of its query the load reads (`dataKeyOf`). */
  const dataKeyOfSub = (sub) => `${sub.page}\n${sub.dkey}`;
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

  /**
   * Tell a stream it is over and why, then close it. The data is never empty (a browser drops a data-less event) and
   * the reason is always one of `STREAM_ENDS` or null: `streamEndOf` is the one gate, so a caller that passes
   * `restart`, a typo or anything a store returned cannot put another word on the wire.
   */
  function finish(sub, ended = null) {
    remove(sub);
    try {
      sub.res.write(`event: end\ndata: ${JSON.stringify({ ended: streamEndOf(ended) })}\n\n`);
      sub.res.end();
    } catch {
      // already gone
    }
  }

  /** Why the session `id` ended, from the injected verdict; null when there is none or it threw. */
  function reasonFor(id, file) {
    if (typeof endedReason !== "function") return null;
    try {
      return endedReason(id, file) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The tokens file as this tick judges with it, or null when it cannot be read: a throw, a refusal (no `file`), or a
   * file with no token list, which the store would read as "nobody holds a token" and so end every session over it.
   */
  function tokensFile() {
    try {
      const file = readTokens()?.file ?? null;
      return file !== null && typeof file === "object" && Array.isArray(file.tokens) ? file : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether `sub`'s page data or its view's render failed at their last attempt: the subscribe's judgment (see the
   * header). Never the tokens file: the stream's own request has just read it.
   */
  const failingNow = (sub) => failing.has(`data\n${dataKeyOfSub(sub)}`) || failing.has(`view\n${viewKeyOf(sub)}`);

  /**
   * `stale` to a page stream, saying `what` failed (issue #737: the page words the two apart, since a tokens file it
   * cannot read is not the deployment's data); a transcript stream, or one already told exactly that, gets nothing. A
   * stream told `data` and then failing on the tokens file (or the reverse) is told again, so the page's note never names
   * the wrong one. A page stream told it holds panels from then on: its page says what it shows is as last seen, so no
   * degraded draw may go over it.
   */
  function markStale(sub, since, what) {
    const kind = what === "tokens" ? "tokens" : "data";
    if (!isPage(sub) || !subs.has(sub)) return;
    sub.holds = true;
    if (sub.said === kind) return;
    sub.said = kind;
    send(sub, `event: stale\ndata: ${JSON.stringify({ since: typeof since === "number" ? since : null, what: kind })}\n\n`);
  }

  /** `fresh` to a page stream not told it already: its first message, or the first after a `stale`. */
  function markFresh(sub) {
    if (!isPage(sub) || sub.said === "fresh" || !subs.has(sub)) return;
    sub.said = "fresh";
    send(sub, "event: fresh\ndata: {}\n\n");
  }

  const panelEvent = (seq, id, html) => `id: ${seq}\nevent: panel\ndata: ${JSON.stringify({ id, html })}\n\n`;

  function sendFull(sub, view) {
    for (const [id, p] of view.panels) if (!send(sub, panelEvent(view.seq, id, p.html))) return;
    sub.needsFull = false;
  }

  /**
   * The degraded panels of a load whose read failed, to a stream that holds none (see the header), and to it alone:
   * nothing goes into a view, and the stream still needs its view whole (`needsFull`) once a good render comes. What it
   * was last drawn so is kept on the stream (`sub.degraded`, id -> digest), so a lasting outage sends it only the panels
   * that changed, not the whole page every tick.
   */
  function drawDegraded(sub, rendered) {
    const was = sub.degraded ?? new Map();
    const drawn = new Map();
    let seq = null;
    for (const p of Array.isArray(rendered) ? rendered : []) {
      if (typeof p?.id !== "string") continue;
      const html = String(p.html ?? "");
      const digest = digestOf(html);
      drawn.set(p.id, digest);
      if (was.get(p.id) === digest) continue;
      seq ??= nextSeq();
      if (!send(sub, panelEvent(seq, p.id, html))) return;
    }
    sub.degraded = drawn;
  }

  async function runTick() {
    const t = now();
    // 1. sessions, with ONE read of the tokens file for every stream. An unreadable file judges nobody: no stream is
    // ended and none is written a panel or an entry this tick (steps 3 to 5 are skipped), only `stale` and the ping.
    const file = tokensFile();
    if (file === null) {
      failed("tokens", TOKENS_HELD_LINE);
      // Every stream is offered `stale`; `markStale` is the one place that keeps transcript streams out of it.
      for (const sub of [...subs]) markStale(sub, views.get(viewKeyOf(sub))?.at ?? null, "tokens");
    } else {
      recovered("tokens", TOKENS_BACK_LINE);
      for (const sub of [...subs]) {
        let alive = null;
        try {
          alive = peekSession(sub.sessionId, file);
        } catch {
          alive = null;
        }
        if (!alive) finish(sub, reasonFor(sub.sessionId, file));
      }
    }
    // 2. stalled readers.
    for (const sub of [...subs]) if ((sub.res.writableLength ?? 0) > maxBufferBytes) cut(sub);
    if (file !== null) await drawTick(t);
    // A key nobody shows any more is forgotten, failing or not, so a long-running console holds only what is open. The
    // tokens file's failure is the console's, not a key's: it is kept until the file reads again, so it is said once.
    const shown = new Set(["tokens", ...[...subs].flatMap((sub) => (isPage(sub) ? [`data\n${dataKeyOfSub(sub)}`, `view\n${viewKeyOf(sub)}`] : [`transcript\n${sub.jobId}`]))]);
    for (const key of [...failing]) if (!shown.has(key)) failing.delete(key);
    for (const dk of [...loaded.keys()]) if (!shown.has(`data\n${dk}`)) loaded.delete(dk);
    // The keep-alive, so a proxy or the browser does not take a quiet stream for a dead one.
    if (t - lastPing >= pingMs) {
      lastPing = t;
      for (const sub of [...subs]) send(sub, ": ping\n\n");
    }
  }

  /** Steps 3 to 5, on a tick whose tokens file was read: every page view drawn, every transcript fanned out. */
  async function drawTick(t) {
    // 3 and 4. one load per data key (with the part of the query the data depends on), one render per view (with the
    // view's whole query).
    const byData = new Map();
    for (const sub of pageSubs()) {
      const dk = dataKeyOfSub(sub);
      if (!byData.has(dk)) byData.set(dk, { page: sub.page, query: sub.dquery, subs: [] });
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
        for (const sub of group) markStale(sub, views.get(viewKeyOf(sub))?.at ?? null, "data");
        continue;
      }
      // A read that failed inside the load is a failed load (see the header): logged once, never a recovery, never
      // into a view. Each stream that holds panels is told stale and sent nothing; the others are drawn its degraded
      // panels, each for itself.
      const readFailed = data?.readFailed === true;
      let drawn = group;
      if (readFailed) {
        failed(`data\n${dk}`, `console: live data for page ${page} could not be read; its streams keep their last panels`);
        for (const sub of group) if (sub.holds) markStale(sub, views.get(viewKeyOf(sub))?.at ?? null, "data");
        drawn = group.filter((sub) => !sub.holds);
        if (drawn.length === 0) continue;
      } else recovered(`data\n${dk}`, `console: live data for page ${page} is read again`);
      const byView = new Map();
      for (const sub of drawn) {
        const vk = viewKeyOf(sub);
        if (!byView.has(vk)) byView.set(vk, []);
        byView.get(vk).push(sub);
      }
      for (const [vk, viewers] of byView) {
        const live = viewers.filter((s) => subs.has(s));
        if (live.length === 0) continue;
        let rendered;
        try {
          rendered = await pagePanels(page, { query: live[0].query, session: { name: live[0].session.name, role: live[0].session.role }, data, readOnly });
        } catch (e) {
          failed(`view\n${vk}`, `console: live panels for page ${page} failed (${codeOf(e)}); its streams keep their last panels`);
          // A render is one view's (a role's, a name's): only its streams were not drawn, so only they are told.
          for (const sub of live) markStale(sub, views.get(vk)?.at ?? null, "data");
          continue;
        }
        if (readFailed) {
          for (const sub of live) if (subs.has(sub)) drawDegraded(sub, rendered);
          continue;
        }
        recovered(`view\n${vk}`, `console: live panels for page ${page} render again`);
        const view = views.get(vk) ?? { seq: null, at: null, panels: new Map() };
        const changed = [];
        for (const p of Array.isArray(rendered) ? rendered : []) {
          if (typeof p?.id !== "string") continue;
          const html = String(p.html ?? "");
          const digest = digestOf(html);
          if (view.panels.get(p.id)?.digest !== digest) changed.push(p.id);
          view.panels.set(p.id, { digest, html });
        }
        if (changed.length > 0 || view.seq === null) view.seq = nextSeq();
        view.at = t;
        // A stream may have left during the awaits above; only a view someone still shows is kept.
        if (!live.some((s) => subs.has(s))) continue;
        views.set(vk, view);
        for (const sub of live) {
          // The state before the panels (see the header).
          markFresh(sub);
          if (!subs.has(sub)) continue;
          if (sub.needsFull) sendFull(sub, view);
          else for (const id of changed) if (!send(sub, panelEvent(view.seq, id, view.panels.get(id).html))) break;
          if (subs.has(sub)) sub.holds = true;
        }
      }
    }
    // 5. the live transcripts: one read per job, fanned out.
    await transcriptTick();
  }

  // The `data` per format (issue #647): `{"html"}` for the run page, the structured entry for the terminal chat. Both
  // are JSON.stringify'd, so no newline in the text can end an event early.
  const entryEvent = (id, data) => `id: ${id}\nevent: entry\ndata: ${JSON.stringify(data)}\n\n`;
  const ENTRY_DATA = Object.freeze({ html: (entry) => ({ html: String(transcriptEntryHtml(entry)) }), json: (entry) => transcriptEntryJson(entry) });

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
        // Rendered once per entry and format, whichever streams it goes to, and only in the formats a stream asked for.
        const rendered = new Map();
        const eventsIn = (format) => {
          if (!rendered.has(format)) rendered.set(format, read.entries.map((entry) => ({ id: entry.id, event: entryEvent(entry.id, ENTRY_DATA[format](entry)) })));
          return rendered.get(format);
        };
        for (const sub of live) {
          if (!subs.has(sub)) continue;
          for (const r of eventsIn(sub.format)) {
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
      // `holds`: this stream's browser holds panels a failed load must not draw over (a Last-Event-ID says it does; a good
      // render sent to it, or a stale told it, makes it so); `said`: the state it was last told, null before its first;
      // `degraded`: what it was last drawn from a failed load, while it holds nothing (see the header).
      // `dquery`/`dkey`: the part of the query the page's data depends on and its canonical text (`dataQueryOf`,
      // `dataKeyOf`), which the load is shared by; `qkey` keys the view.
      const sub = { kind: "page", res, sessionId, session: { name: String(session?.name ?? ""), role: String(session?.role ?? "") }, page, query, qkey: String(queryKeyOf(page, query)), dquery: dataQueryOf(page, query), dkey: String(dataKeyOf(page, query)), needsFull: true, holds: typeof lastEventId === "string", said: null, degraded: null };
      subs.add(sub);
      startTimer();
      const view = views.get(viewKeyOf(sub));
      if (view) {
        // A view is a good render (see the header): the newest this browser can be given, so it is sent, after the state
        // that says whether it is current (the data's and the render's to say, not the tokens file's: see the header).
        if (failingNow(sub)) markStale(sub, view.at, "data");
        else markFresh(sub);
        if (typeof lastEventId === "string" && lastEventId === view.seq) sub.needsFull = false;
        else sendFull(sub, view);
        sub.holds = true;
      } else {
        // No view yet: the tick draws it now (the panels; for a failed load, the degraded panels, or stale for a stream
        // that holds panels), rather than leave the page blank for a tick.
        void tick();
      }
      return () => remove(sub);
    },

    /**
     * One run's live transcript (issue #643): entries after `lastEventId` (a stream id the caller validated, else null
     * for the beginning), as `format` (`html`, the default, or `json`, issue #647; anything else is `html`). The first
     * entries are read now rather than a tick later.
     */
    subscribeTranscript({ res, sessionId, session, jobId, lastEventId = null, format = "html" }) {
      if (closed) {
        try {
          res.end();
        } catch {
          // already gone
        }
        return () => {};
      }
      const sub = { kind: "transcript", res, sessionId, session: { name: String(session?.name ?? ""), role: String(session?.role ?? "") }, jobId: String(jobId), cursor: typeof lastEventId === "string" ? lastEventId : null, format: Object.hasOwn(ENTRY_DATA, format) ? format : "html" };
      subs.add(sub);
      startTimer();
      void tick();
      return () => remove(sub);
    },

    /**
     * End every stream of a session at once (logout, a sign-in that replaced this browser's), saying `reason`: the
     * server passes `elsewhere`, and the end carries only a `STREAM_ENDS` word or null whatever is passed.
     */
    endSession(sessionId, reason = null) {
      for (const sub of [...subs]) if (sub.sessionId === sessionId) finish(sub, reason);
    },

    /**
     * End every stream with `shutdown` and stop the timer; later subscribes are closed at once. Not a sign-out: the
     * sessions die with this process, but the page learns that from its next request, not from this goodbye.
     */
    close() {
      closed = true;
      for (const sub of [...subs]) finish(sub, STREAM_SHUTDOWN);
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

/** A record reason in a state document: the record's token charset (the runs filter's), else null. */
const REASON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The snapshot's `refusals24h` rebuilt by name (issue #710): `{ count, top: [{ reason, count }] }`, or null. */
function refusalsOf(r) {
  if (r === null || typeof r !== "object" || num(r.count) === null) return null;
  const top = Array.isArray(r.top) ? r.top : [];
  return { count: num(r.count), top: top.filter((t) => typeof t?.reason === "string" && REASON_RE.test(t.reason) && num(t.count) !== null).map((t) => ({ reason: t.reason, count: num(t.count) })) };
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
      // How long ago the host last beat, by the overview's rule: Valkey's measure of the row's last refresh where known.
      lastBeatAgeMs: num(beatAgeOf(h)),
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
    // Issue #647: with the parked run's `jobId` (a worker-minted run id, the run-id charset or null), so a script or the
    // terminal chat can open the run, or answer it through the `parked-answer` action, without a second lookup.
    parked: (Array.isArray(s.parked) ? s.parked : []).map((p) => ({ target: str(p?.target), kind: str(p?.kind), jobId: typeof p?.jobId === "string" && RUN_ID_RE.test(p.jobId) ? p.jobId : null, ageMs: num(p?.ageMs), chainCount: num(p?.chainCount) })),
    // True when the parked list could not be read: `parked: []` then means "unknown", never "nobody is waiting".
    parkedUnknown: Boolean(s.parkedUnreachable),
    failures24h: num(s.failures24h),
    // Issue #710: the day's refusals (`refusalsIn`: what both surfaces call "refused", so an operator's cancel is not
    // one), each listed reason held to the record's token charset; null where `failures24h` is (the runs unread).
    refusals24h: refusalsOf(s.refusals24h),
    failures24hFloor: Boolean(s.failures24hFloor),
    active: (Array.isArray(s.active) ? s.active : []).map((a) => ({ jobId: str(a?.jobId), queue: str(a?.queue), startedAt: num(a?.startedAt), host: str(a?.host), progress: progressOf(a?.progress), steer: a?.steer === true, inbox: inboxOf(a) })),
    schedulers: (Array.isArray(s.schedulers) ? s.schedulers : []).map((x) => {
      // The trigger's id, the scheduler's key; BullMQ's `name` is the job's ("local"), never a stand-in for a refused key.
      const name = x?.key ?? null;
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
