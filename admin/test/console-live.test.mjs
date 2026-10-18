import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { after, test } from "node:test";
import { page, html } from "../src/console/html.mjs";
import { LIVE_DEFAULTS, makeLiveHub, queryKey, stateOf } from "../src/console/live.mjs";
import * as realPages from "../src/console/pages.mjs";
import { createConsoleServer } from "../src/console/server.mjs";
import * as sessionsModule from "../src/console/sessions.mjs";

// The console's live hub (issue #641, DES-OPERATOR-CONSOLE "Stream lifecycle"): first on fake responses with the
// ticks driven by hand, then over a real node:http server with the real session store, so the lifecycle claims (a dead
// session ends its stream within one tick, an open stream does not keep a session alive, the caps, the timeouts) are
// held against the code that serves them. Every clock is injected; nothing waits 15 seconds.

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

/** setInterval/clearInterval that never fire on their own: the tests call `hub.tick()`. */
function fakeTimers() {
  const timers = { started: 0, cleared: 0, live: 0 };
  timers.setInterval = () => {
    timers.started += 1;
    timers.live += 1;
    return { id: timers.started };
  };
  timers.clearInterval = () => {
    timers.cleared += 1;
    timers.live -= 1;
  };
  return timers;
}

/** A response the hub writes to; `writableLength` is whatever the test says. */
function fakeRes() {
  const res = {
    chunks: [],
    writableLength: 0,
    ended: false,
    destroyed: false,
    write(text) {
      res.chunks.push(text);
      return true;
    },
    end() {
      res.ended = true;
    },
    destroy() {
      res.destroyed = true;
    },
    text() {
      return res.chunks.join("");
    },
    take() {
      const out = res.chunks.join("");
      res.chunks.length = 0;
      return out;
    },
  };
  return res;
}

/** The panel events in a chunk of stream text: `[{seq, id, html}]`. */
function panelsIn(text) {
  return [...text.matchAll(/id: (\S+)\nevent: panel\ndata: (.+)\n\n/g)].map(([, seq, data]) => ({ seq, ...JSON.parse(data) }));
}

const H = (c) => c.repeat(64);
const FILE = { version: 1, generation: 0, tokens: [{ name: "rob", role: "operator", sha256: H("a"), createdAt: "2026-10-01T00:00:00.000Z" }] };

/** A hub on fakes: panels come from `content[page]` (a Map id -> html), sessions from `alive`. */
function hubOn({ now = clock(), content = {}, alive = new Set(["s1", "s2", "s3"]), load, ...rest } = {}) {
  const timers = fakeTimers();
  const loads = [];
  const renders = [];
  const logs = [];
  let tokenReads = 0;
  const hub = makeLiveHub({
    loadPageData: load ?? (async (pageName, query) => (loads.push([pageName, queryKey(query)]), { pageName })),
    pagePanels: async (pageName, ctx) => {
      renders.push([pageName, ctx.session.role, queryKey(ctx.query)]);
      const m = content[pageName] ?? new Map([["p-main", `<p>${pageName}</p>`]]);
      return [...m].map(([id, h]) => ({ id, html: `${h}|${ctx.session.role}` }));
    },
    peekSession: (id, file) => (file === FILE && alive.has(id) ? { id } : null),
    readTokens: () => ((tokenReads += 1), { file: FILE }),
    now,
    timers,
    log: (line) => logs.push(line),
    random: () => Buffer.from("cafebabe", "hex"),
    // Every page loads every tick here unless a test asks for the cadence (`pageMinMs: undefined` takes the default).
    pageMinMs: {},
    ...rest,
  });
  return { hub, timers, loads, renders, logs, now, alive, tokenReads: () => tokenReads };
}

const OP = { name: "rob", role: "operator" };
const VIEW = { name: "vic", role: "viewer" };

test("a new stream gets every panel first; later ticks send only the panels that changed, under a new id", async () => {
  const content = { overview: new Map([["p-a", "a1"], ["p-b", "b1"]]) };
  const h = hubOn({ content });
  const res = fakeRes();
  h.hub.subscribe({ res, sessionId: "s1", session: OP, page: "overview", query: {} });
  await h.hub.tick();
  const first = panelsIn(res.take());
  assert.deepEqual(first.map((p) => [p.id, p.html]), [["p-a", "a1|operator"], ["p-b", "b1|operator"]]);
  assert.equal(new Set(first.map((p) => p.seq)).size, 1, "one id for one render");
  assert.match(first[0].seq, /^cafebabe-\d+$/, "the id carries the process epoch");

  await h.hub.tick();
  assert.equal(res.take(), "", "nothing changed, nothing is sent");

  content.overview.set("p-b", "b2");
  await h.hub.tick();
  const next = panelsIn(res.take());
  assert.deepEqual(next.map((p) => [p.id, p.html]), [["p-b", "b2|operator"]]);
  assert.notEqual(next[0].seq, first[0].seq);
});

test("one loadPageData per page and query per tick, however many streams; one render per view (page, query, role, name)", async () => {
  const h = hubOn();
  const subs = [
    ["s1", OP, "overview", {}],
    ["s2", OP, "overview", {}],
    ["s3", VIEW, "overview", {}],
    ["s1", OP, "runs", { repo: "a/b" }],
    ["s2", OP, "runs", { repo: "a/b" }],
    ["s3", VIEW, "runs", { repo: "c/d" }],
  ];
  const resps = subs.map(([sessionId, session, pageName, query]) => {
    const res = fakeRes();
    h.hub.subscribe({ res, sessionId, session, page: pageName, query });
    return res;
  });
  await h.hub.tick();
  h.loads.length = 0;
  h.renders.length = 0;
  const reads = h.tokenReads();
  await h.hub.tick();
  assert.deepEqual(h.loads.sort(), [["overview", "{}"], ["runs", '{"repo":"a/b"}'], ["runs", '{"repo":"c/d"}']]);
  assert.equal(h.renders.length, 4, "overview x {operator rob, viewer vic}, runs a/b x operator, runs c/d x viewer");
  assert.equal(h.tokenReads() - reads, 1, "ONE read of the tokens file per tick, for every stream");
  assert.match(resps[2].text(), /p-main.*overview<\/p>\|viewer/, "the viewer got the viewer's render");
  assert.equal(queryKey({ b: 1, a: 2 }), queryKey({ a: 2, b: 1 }), "equal queries share a key whatever their order");
});

test("SECURITY: a viewer and an operator on the same page and query never share a render; the viewer's events carry no failedReason", async () => {
  const REASON = "failedReason: token for alice@example.test refused";
  const h = hubOn({ content: {} });
  // A renderer that, like the real fleet panel, adds the free text for an operator only.
  const hub = makeLiveHub({
    loadPageData: async () => ({ reason: REASON }),
    pagePanels: async (pageName, ctx) => [{ id: "p-failed", html: ctx.session.role === "operator" ? `<p>${ctx.data.reason}</p>` : "<p>j7 failed</p>" }],
    peekSession: (id) => ({ id }),
    readTokens: () => ({ file: FILE }),
    timers: h.timers,
  });
  const op = fakeRes();
  const viewer = fakeRes();
  const lateViewer = fakeRes();
  hub.subscribe({ res: op, sessionId: "s1", session: OP, page: "fleet", query: {} });
  await hub.tick();
  // The operator's view is cached now; a viewer subscribing after must not be served from it.
  hub.subscribe({ res: viewer, sessionId: "s2", session: VIEW, page: "fleet", query: {} });
  await hub.tick();
  const opSeq = panelsIn(op.text())[0].seq;
  hub.subscribe({ res: lateViewer, sessionId: "s3", session: { name: "vic", role: "viewer" }, page: "fleet", query: {}, lastEventId: opSeq });
  await hub.tick();
  assert.ok(op.text().includes(REASON));
  for (const res of [viewer, lateViewer]) {
    assert.ok(!res.text().includes("failedReason") && !res.text().includes("alice@"), res.text());
    assert.deepEqual(panelsIn(res.text()).map((p) => p.html), ["<p>j7 failed</p>"]);
  }
  hub.close();
});

test("a runs view is loaded at most every pageMinMs (5 s), not every tick; other pages load every tick; a new filter loads at once", async () => {
  // The run detail is held to 2 s since issue #644 made it live (its load reads a record and searches for children).
  assert.deepEqual(LIVE_DEFAULTS.pageMinMs, { runs: 5000, run: 2000 });
  const now = clock();
  const h = hubOn({ now, pageMinMs: undefined });
  h.hub.subscribe({ res: fakeRes(), sessionId: "s1", session: OP, page: "runs", query: { q: "zz1" } });
  h.hub.subscribe({ res: fakeRes(), sessionId: "s1", session: OP, page: "overview", query: {} });
  await h.hub.tick();
  const count = (page) => h.loads.filter(([p]) => p === page).length;
  assert.deepEqual([count("runs"), count("overview")], [1, 1]);
  for (let i = 0; i < 4; i++) {
    now.advance(1000);
    await h.hub.tick();
  }
  assert.deepEqual([count("runs"), count("overview")], [1, 5], "four ticks inside 5 s: the runs data is reused");
  const viewer = fakeRes();
  h.hub.subscribe({ res: viewer, sessionId: "s2", session: VIEW, page: "runs", query: { q: "zz1" } });
  await h.hub.tick();
  assert.equal(count("runs"), 1, "a new view of the same runs query is drawn from the held data");
  assert.equal(panelsIn(viewer.text()).length, 1, "and drawn at once");
  h.hub.subscribe({ res: fakeRes(), sessionId: "s3", session: OP, page: "runs", query: { q: "zz2" } });
  await h.hub.tick();
  assert.equal(count("runs"), 2, "another filter is its own data key, loaded at once");
  now.advance(1000);
  await h.hub.tick();
  assert.equal(count("runs"), 3, "5 s after its last load, zz1 is read again (zz2 is not yet)");
});

test("the canonical query key is the injected one (pages.mjs's pageQueryString): queries it calls equal share one load", async () => {
  const loads = [];
  const h = hubOn({ content: {} });
  const hub = makeLiveHub({
    loadPageData: async (pageName, query) => (loads.push(query), {}),
    pagePanels: async () => [{ id: "p-runs", html: "x" }],
    peekSession: (id) => ({ id }),
    readTokens: () => ({ file: FILE }),
    timers: h.timers,
    queryKeyOf: realPages.pageQueryString,
    pageMinMs: {},
  });
  hub.subscribe({ res: fakeRes(), sessionId: "s1", session: OP, page: "runs", query: { filter: { repo: "a/b" }, before: null, extra: 1 } });
  hub.subscribe({ res: fakeRes(), sessionId: "s2", session: OP, page: "runs", query: { filter: { repo: "a/b" } } });
  await hub.tick();
  loads.length = 0;
  await hub.tick();
  assert.equal(loads.length, 1);
  hub.close();
});

test("Last-Event-ID equal to the view's current id sends nothing at subscribe; any other id gets the whole view again", async () => {
  const h = hubOn({ content: { fleet: new Map([["p-x", "x"], ["p-y", "y"]]) } });
  const a = fakeRes();
  h.hub.subscribe({ res: a, sessionId: "s1", session: OP, page: "fleet", query: {} });
  await h.hub.tick();
  const seq = panelsIn(a.take())[0].seq;

  const same = fakeRes();
  h.hub.subscribe({ res: same, sessionId: "s2", session: OP, page: "fleet", query: {}, lastEventId: seq });
  assert.equal(same.text(), "", "it already holds this exact view");
  await h.hub.tick();
  assert.equal(same.text(), "", "and nothing changed since");

  const stale = fakeRes();
  h.hub.subscribe({ res: stale, sessionId: "s3", session: OP, page: "fleet", query: {}, lastEventId: "cafebabe-0" });
  assert.deepEqual(panelsIn(stale.text()).map((p) => p.id), ["p-x", "p-y"], "an old id gets the whole view at once, from the cache");
});

test("Last-Event-ID with the view's counter but another epoch (an id from before a restart) gets the whole view", async () => {
  const h = hubOn({ content: { fleet: new Map([["p-x", "x"], ["p-y", "y"]]) } });
  const a = fakeRes();
  h.hub.subscribe({ res: a, sessionId: "s1", session: OP, page: "fleet", query: {} });
  await h.hub.tick();
  const seq = panelsIn(a.take())[0].seq;
  const [epoch, counter] = seq.split("-");
  assert.equal(epoch, "cafebabe");
  const restarted = fakeRes();
  h.hub.subscribe({ res: restarted, sessionId: "s2", session: OP, page: "fleet", query: {}, lastEventId: `deadbeef-${counter}` });
  assert.deepEqual(panelsIn(restarted.text()).map((p) => [p.id, p.seq]), [["p-x", seq], ["p-y", seq]], "the same counter under another epoch never matches");
});

test("a ping every pingMs on the injected clock, and none before", async () => {
  const now = clock();
  const h = hubOn({ now });
  const res = fakeRes();
  h.hub.subscribe({ res, sessionId: "s1", session: OP, page: "overview", query: {} });
  await h.hub.tick();
  res.take();
  now.advance(LIVE_DEFAULTS.pingMs - 1);
  await h.hub.tick();
  assert.equal(res.take(), "");
  now.advance(1);
  await h.hub.tick();
  assert.equal(res.take(), ": ping\n\n");
  now.advance(1000);
  await h.hub.tick();
  assert.equal(res.take(), "", "the next one is another pingMs away");
});

test("a stream whose socket buffer passes 2 MiB is cut (destroyed, not ended), whether found at a tick or right after a write", async () => {
  const content = { overview: new Map([["p-a", "a1"]]) };
  const h = hubOn({ content });
  const stalled = fakeRes();
  const healthy = fakeRes();
  h.hub.subscribe({ res: stalled, sessionId: "s1", session: OP, page: "overview", query: {} });
  h.hub.subscribe({ res: healthy, sessionId: "s2", session: OP, page: "overview", query: {} });
  await h.hub.tick();
  stalled.writableLength = LIVE_DEFAULTS.maxBufferBytes;
  content.overview.set("p-a", "a2");
  await h.hub.tick();
  assert.equal(stalled.destroyed, false, "exactly the limit is still kept");
  stalled.writableLength = LIVE_DEFAULTS.maxBufferBytes + 1;
  await h.hub.tick();
  assert.equal(stalled.destroyed, true);
  assert.equal(stalled.ended, false, "a reader that does not read gets no goodbye queued behind its backlog");
  assert.equal(h.hub.size().streams, 1);

  // Over the limit because of what the hub itself just wrote.
  const filling = fakeRes();
  filling.write = (text) => {
    filling.chunks.push(text);
    filling.writableLength += 3 * 1024 * 1024;
    return false;
  };
  h.hub.subscribe({ res: filling, sessionId: "s3", session: OP, page: "overview", query: {} });
  assert.equal(filling.destroyed, true, "the cached view's first panel pushed it over");
  assert.equal(h.hub.size().streams, 1);
  assert.equal(healthy.destroyed, false);
});

test("a session that fails peek gets event: end with data (a browser drops a data-less event) and its stream ends; others go on", async () => {
  const h = hubOn();
  const gone = fakeRes();
  const kept = fakeRes();
  h.hub.subscribe({ res: gone, sessionId: "s1", session: OP, page: "overview", query: {} });
  h.hub.subscribe({ res: kept, sessionId: "s2", session: OP, page: "overview", query: {} });
  await h.hub.tick();
  h.alive.delete("s1");
  await h.hub.tick();
  assert.match(gone.text(), /event: end\ndata: \{\}\n\n$/);
  assert.equal(gone.ended, true);
  assert.equal(kept.ended, false);
  assert.equal(h.hub.size().streams, 1);
});

test("endSession ends that session's streams at once; close ends all and stops the timer; a subscribe after close is ended", async () => {
  const h = hubOn();
  const a1 = fakeRes();
  const a2 = fakeRes();
  const b = fakeRes();
  h.hub.subscribe({ res: a1, sessionId: "s1", session: OP, page: "overview", query: {} });
  h.hub.subscribe({ res: a2, sessionId: "s1", session: OP, page: "runs", query: {} });
  h.hub.subscribe({ res: b, sessionId: "s2", session: OP, page: "overview", query: {} });
  h.hub.endSession("s1");
  assert.equal(a1.ended && a2.ended, true);
  assert.match(a1.text(), /event: end/);
  assert.equal(b.ended, false);
  h.hub.close();
  assert.equal(b.ended, true);
  assert.deepEqual(h.hub.size(), { streams: 0, views: 0, timer: false });
  const late = fakeRes();
  h.hub.subscribe({ res: late, sessionId: "s2", session: OP, page: "overview", query: {} });
  assert.equal(late.ended, true);
});

test("the timer runs only while a stream is open: started by the first, cleared when the last leaves, started again by the next", async () => {
  const h = hubOn();
  assert.equal(h.timers.started, 0);
  const u1 = h.hub.subscribe({ res: fakeRes(), sessionId: "s1", session: OP, page: "overview", query: {} });
  const u2 = h.hub.subscribe({ res: fakeRes(), sessionId: "s2", session: OP, page: "overview", query: {} });
  assert.equal(h.timers.started, 1, "one timer, however many streams");
  u1();
  assert.equal(h.timers.live, 1);
  u2();
  u2();
  assert.equal(h.timers.live, 0, "the last stream gone, the poll stops");
  assert.equal(h.hub.size().views, 0, "and its rendered view is forgotten");
  h.hub.subscribe({ res: fakeRes(), sessionId: "s1", session: OP, page: "overview", query: {} });
  assert.equal(h.timers.started, 2);
  h.hub.close();
  assert.equal(h.timers.live, 0);
});

test("a page whose data load or render throws costs that key one tick; the other keys and the loop go on, and the log names no message", async () => {
  let failing = true;
  const h = hubOn({
    load: async (pageName) => {
      if (pageName === "fleet" && failing) {
        const e = new Error("connect ECONNREFUSED 10.0.0.9:6379 password=hunter2");
        e.code = "ECONNREFUSED";
        throw e;
      }
      return {};
    },
  });
  const bad = fakeRes();
  const good = fakeRes();
  h.hub.subscribe({ res: bad, sessionId: "s1", session: OP, page: "fleet", query: {} });
  h.hub.subscribe({ res: good, sessionId: "s2", session: OP, page: "overview", query: {} });
  await h.hub.tick();
  assert.equal(panelsIn(good.text()).length, 1);
  assert.equal(bad.text(), "");
  assert.equal(bad.ended || bad.destroyed, false, "a failed load does not end the stream");
  assert.deepEqual(h.logs, ["console: live data for page fleet failed (ECONNREFUSED); its streams keep their last panels"]);
  await h.hub.tick();
  await h.hub.tick();
  assert.equal(h.logs.length, 1, "a lasting failure is said once, not every second");
  failing = false;
  await h.hub.tick();
  assert.equal(panelsIn(bad.text()).length, 1, "it recovers on the next tick");
  assert.deepEqual(h.logs.slice(1), ["console: live data for page fleet is read again"]);
});

// ---- /api/state's projection ----

const SNAPSHOT = {
  queue: { pausedState: false, pausedPartial: true, counts: { waiting: 3, active: 1, paused: 0, delayed: 2, failed: 4, junk: 9 }, workers: 2, queues: 2, fleetDegraded: "connect ECONNREFUSED 10.0.0.9:6379" },
  queueCounts: [{ queue: "pi", paused: false, counts: { waiting: 3 } }],
  hostBudgets: [{ name: "h1", staleMs: 1200, budgetMemMiB: "4096", budgetCpuCenti: "off", concurrency: "2", jobs: [{ id: "j9" }], jobsMore: 1, routes: "secret-route" }],
  budget: { day: 1, week: 2, month: 3, tokensToday: 400 },
  dollars: { rows: [{ ledger: "scope", name: "/home/rob/work/repo", window: "day", capMicros: 5, counterMicros: 1, full: false, records: [{ target: "x" }] }, { ledger: "model", name: "openai/gpt", window: "week", capMicros: 9, counterMicros: 9, full: true }] },
  parked: [{ target: "o/r#12", kind: "github", jobId: "j1", parkedAt: "2026-10-14T11:00:00.000Z", ageMs: 3600000, answered: false, chainCount: 2 }],
  failures24h: 4,
  failures24hFloor: false,
  active: [{ jobId: "j9", queue: "pi", startedAt: T0 - 1000, host: "h1" }],
  schedulers: [{ key: "nightly", name: "nightly", pattern: "0 3 * * *", every: null, next: T0 - 5000, overdueMs: 5000 }],
  schedulerStalls: { nightly: 1 },
  schedulerStallMax: 2,
  failed: { rows: [{ jobId: "j7", attemptsMade: 3, failedReason: "repo o/r: token for alice@example.test refused", queue: "pi", endedAt: T0 }], more: 1 },
  runs: [{ target: "should-not-appear" }],
  settings: { overlay: { secret: "x" } },
};

test("stateOf: an unreadable parked list is parkedUnknown, so an empty list is never read as nobody waiting", () => {
  assert.equal(stateOf(SNAPSHOT, "viewer", { now: T0 }).parkedUnknown, false);
  const lost = stateOf({ ...SNAPSHOT, parked: [], parkedUnreachable: "x" }, "viewer", { now: T0 });
  assert.equal(lost.parkedUnknown, true);
  assert.deepEqual(lost.parked, []);
});

test("stateOf: a steer-armed active job carries its inbox, each entry rebuilt by name and never its text; unread is null, never []", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const snap = {
    ...SNAPSHOT,
    active: [
      { jobId: "j9", queue: "pi", startedAt: T0 - 1000, host: "h1", steer: true, inbox: [{ id, mode: "followUp", source: "console", state: "written", at: T0 - 50, bytes: 42, text: "INBOX-TEXT-CANARY", author: { kind: "operator", by: "inbox-author-canary" } }, { id: "<b>", mode: "shout", source: "evil", state: "gone", at: -1, bytes: "x" }] },
      { jobId: "j10", queue: "pi", startedAt: T0 - 2000, host: "h1", steer: true, inbox: null },
      { jobId: "j11", queue: "pi", startedAt: T0 - 3000, host: "h1", inbox: [{ id }] },
    ],
  };
  for (const role of ["operator", "viewer"]) {
    const st = stateOf(snap, role, { now: T0 });
    assert.deepEqual(st.active.map((a) => [a.jobId, a.steer, a.inbox]), [
      ["j9", true, [{ id, mode: "followUp", source: "console", state: "written", at: T0 - 50, bytes: 42 }, { id: null, mode: null, source: null, state: null, at: null, bytes: 0 }]],
      ["j10", true, null],
      ["j11", false, null],
    ]);
    assert.ok(!JSON.stringify(st).includes("INBOX-TEXT-CANARY") && !JSON.stringify(st).includes("inbox-author-canary"), "no text and no author ride along");
  }
});

test("stateOf: the named fields only, numbers as numbers, no error text, no host path, and failedReason for an operator alone", () => {
  const op = stateOf(SNAPSHOT, "operator", { now: T0 });
  const viewer = stateOf(SNAPSHOT, "viewer", { now: T0 });
  assert.deepEqual(Object.keys(op).sort(), ["active", "at", "budget", "counts", "dollars", "failed", "failures24h", "failures24hFloor", "fleetDegraded", "hosts", "parked", "parkedUnknown", "paused", "queues", "role", "schedulerStallMax", "schedulers", "version", "workers"]);
  assert.equal(op.version, 1, "the scripts' interface carries its version");
  assert.deepEqual(op.paused, { state: false, partial: true });
  assert.deepEqual(op.counts, { waiting: 3, active: 1, paused: 0, delayed: 2, failed: 4 });
  assert.equal(op.fleetDegraded, true);
  assert.deepEqual(op.hosts, [{ name: "h1", lastBeatAgeMs: 1200, capacity: { memMiB: 4096, cpuCenti: null, concurrency: 2 }, running: 2 }]);
  assert.deepEqual(op.dollars.windows.map((w) => w.scope), [null, "openai/gpt"], "a folder scope's host path is dropped");
  assert.deepEqual(op.parked, [{ target: "o/r#12", kind: "github", ageMs: 3600000, chainCount: 2 }]);
  assert.deepEqual(op.active, [{ jobId: "j9", queue: "pi", startedAt: T0 - 1000, host: "h1", progress: null, steer: false, inbox: null }]);
  assert.deepEqual(op.schedulers, [{ name: "nightly", next: T0 - 5000, overdue: true, overdueMs: 5000, stalls: 1 }]);
  assert.equal(op.failed.rows[0].failedReason, "repo o/r: token for alice@example.test refused");
  assert.equal("failedReason" in viewer.failed.rows[0], false, "a viewer gets the row without BullMQ's free text");
  assert.equal(viewer.failed.rows[0].jobId, "j7");
  assert.equal(viewer.role, "viewer");
  assert.equal(stateOf(SNAPSHOT, "anything-else").role, "viewer", "an unknown role is the lesser one");
  const text = JSON.stringify(viewer);
  for (const needle of ["ECONNREFUSED", "/home/rob", "should-not-appear", "secret", "alice@", "records"]) assert.ok(!text.includes(needle), needle);
  assert.deepEqual(stateOf({ failed: { unreachable: "down" } }, "operator").failed, { unreachable: true, rows: [], more: 0 });
  assert.equal(stateOf(null, "viewer").counts.waiting, 0, "an empty snapshot is an empty state, not a throw");
  const hostile = stateOf({ active: [{ jobId: "j\u001b[31m‮1" }] }, "viewer");
  assert.equal(/[\u0000-\u001f‮]/.test(hostile.active[0].jobId), false, "control and bidi bytes are scrubbed");
});

// ---- over real HTTP, with the real session store ----

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const OP_TOKEN = `pdc_${"o".repeat(43)}`;
const VIEW_TOKEN = `pdc_${"v".repeat(43)}`;

const servers = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
});

/** A console with the real session store and the real hub on a hand-driven clock; the tokens file is `tokens.file`. */
async function liveConsole({ idleMs = 60 * MIN, maxMs = 12 * 60 * MIN, maxStreams = 4, limits = {} } = {}) {
  const now = clock();
  const tokens = {
    file: {
      version: 1,
      generation: 0,
      tokens: [
        { name: "alice", role: "operator", sha256: sha256(OP_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
        { name: "vic", role: "viewer", sha256: sha256(VIEW_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
      ],
    },
  };
  const readTokens = () => ({ file: tokens.file });
  const sessions = sessionsModule.makeSessionStore({ now, idleMs, maxMs, maxStreams });
  let n = 0;
  const content = { value: "v1" };
  const timers = fakeTimers();
  const pages = {
    ...realPages,
    loadPageData: async () => ({ value: content.value }),
    pagePanels: async (name, ctx) => [{ id: "p-main", html: `<p>${name} ${ctx.data.value}</p>` }],
    renderPage: async (name, ctx) => ({ status: 200, html: page({ title: name, name, body: html`<main>${ctx.session.name}</main>` }) }),
  };
  const hub = makeLiveHub({ loadPageData: (p, q) => pages.loadPageData(p, q), pagePanels: pages.pagePanels, peekSession: (id, file) => sessions.peek(id, file), readTokens, now, timers });
  const server = createConsoleServer({
    config: { allowedHosts: [], readOnly: false, maxMs },
    now,
    audit: { append: (row) => row },
    sessions,
    cookies: sessionsModule,
    tickets: { issue: () => ({ ticket: `t${(n += 1)}` }), redeem: () => ({ refusal: "no" }) },
    readTokens,
    findToken: (file, presented) => file.tokens.find((e) => e.sha256 === sha256(presented)) ?? null,
    consumeLoginCode: () => ({ refusal: "unknown" }),
    writePauseWindows: () => ({ ok: true }),
    pages,
    pageDeps: { fleet: { snapshot: async () => SNAPSHOT } },
    hub,
    limits,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;

  function send({ method = "GET", path, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers }, setHost: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body ?? undefined);
    });
  }
  const writeHeaders = { origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  async function login(token = OP_TOKEN) {
    const res = await send({ method: "POST", path: "/login", headers: writeHeaders, body: JSON.stringify({ token }) });
    assert.equal(res.status, 200, res.text);
    return res.headers["set-cookie"][0].split(";")[0];
  }
  /** Open a stream; `text` grows as it arrives, `waitFor(re)` resolves when it matches, `done` when it ends. */
  function stream(cookie, path = "/api/events?page=overview", headers = {}) {
    return new Promise((resolve, reject) => {
      const s = { text: "", status: null, headers: null, waiters: [] };
      const req = request({ host: "127.0.0.1", port, path, headers: { host, cookie, ...headers }, setHost: false }, (res) => {
        s.status = res.statusCode;
        s.headers = res.headers;
        s.done = new Promise((done) => {
          res.on("end", done);
          res.on("close", done);
          res.on("error", done);
        });
        res.on("data", (c) => {
          s.text += c;
          for (const w of [...s.waiters]) if (w.re.test(s.text)) (s.waiters.splice(s.waiters.indexOf(w), 1), w.resolve());
        });
        resolve(s);
      });
      s.waitFor = (re) => (re.test(s.text) ? Promise.resolve() : new Promise((r) => s.waiters.push({ re, resolve: r })));
      s.destroy = () => req.destroy();
      req.on("error", (e) => (s.status === null ? reject(e) : null));
      req.end();
    });
  }
  return { server, port, now, tokens, sessions, hub, timers, content, send, login, stream, writeHeaders };
}

test("over HTTP: the stream's headers, its first panel, a change at the next tick, and nothing in between", async () => {
  const c = await liveConsole();
  const cookie = await c.login();
  const s = await c.stream(cookie);
  assert.equal(s.status, 200);
  assert.equal(s.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(s.headers["cache-control"], "no-store");
  assert.equal(s.headers["x-accel-buffering"], "no");
  assert.ok(s.headers["content-security-policy"], "the security headers too");
  await s.waitFor(/p-main","html":"<p>overview v1<\/p>/);
  c.content.value = "v2";
  await c.hub.tick();
  await s.waitFor(/overview v2/);
  assert.equal(panelsIn(s.text).length, 2);
  s.destroy();
  await s.done;
});

test("over HTTP: a stream ends within one tick of logout, revoke, rotate, end-all and expiry", async () => {
  const cases = {
    logout: async (c, cookie) => {
      await c.send({ method: "POST", path: "/logout", headers: { ...c.writeHeaders, cookie }, body: "{}" });
      return false; // ends at once, no tick needed
    },
    revoke: async (c) => {
      c.tokens.file = { ...c.tokens.file, tokens: c.tokens.file.tokens.filter((t) => t.name !== "alice") };
      return true;
    },
    rotate: async (c) => {
      c.tokens.file = { ...c.tokens.file, tokens: c.tokens.file.tokens.map((t) => (t.name === "alice" ? { ...t, sha256: sha256("new") } : t)) };
      return true;
    },
    "end-all": async (c) => {
      c.tokens.file = { ...c.tokens.file, generation: 1 };
      return true;
    },
    expiry: async (c) => {
      c.now.advance(12 * 60 * MIN + 1);
      return true;
    },
  };
  for (const [name, act] of Object.entries(cases)) {
    const c = await liveConsole({ idleMs: 13 * 60 * MIN });
    const cookie = await c.login();
    const s = await c.stream(cookie);
    await s.waitFor(/event: panel/);
    const needsTick = await act(c, cookie);
    if (needsTick) await c.hub.tick();
    await s.waitFor(/event: end\ndata: \{\}\n\n/);
    await s.done;
    assert.equal(c.hub.size().streams, 0, name);
  }
});

test("over HTTP: a stream whose token's role changes in the tokens file (operator to viewer) ends within one tick", async () => {
  const c = await liveConsole();
  const cookie = await c.login();
  const s = await c.stream(cookie);
  await s.waitFor(/event: panel/);
  await c.hub.tick();
  assert.equal(c.hub.size().streams, 1, "an unchanged file keeps it");
  c.tokens.file = { ...c.tokens.file, tokens: c.tokens.file.tokens.map((t) => (t.name === "alice" ? { ...t, role: "viewer" } : t)) };
  await c.hub.tick();
  await s.waitFor(/event: end\ndata: \{\}\n\n/);
  await s.done;
  assert.equal(c.hub.size().streams, 0);
});

test("over HTTP: retry: 2000 is the stream's first line, and the view's own id sent back as Last-Event-ID gets nothing at subscribe", async () => {
  const c = await liveConsole();
  const cookie = await c.login();
  const first = await c.stream(cookie);
  await first.waitFor(/event: panel/);
  assert.ok(first.text.startsWith("retry: 2000\n\n"), JSON.stringify(first.text.slice(0, 40)));
  const seq = panelsIn(first.text)[0].seq;
  const same = await c.stream(cookie, "/api/events?page=overview", { "last-event-id": seq });
  await same.waitFor(/^retry: 2000\n\n/);
  await c.hub.tick();
  assert.equal(panelsIn(same.text).length, 0, "the right id reaches the hub: it already holds this view");
  for (const x of [first, same]) x.destroy();
  await Promise.all([first.done, same.done]);
});

test("over HTTP: an open stream does NOT keep an idle session alive; only a request does", async () => {
  const c = await liveConsole({ idleMs: 60 * MIN });
  const cookie = await c.login();
  const s = await c.stream(cookie);
  await s.waitFor(/event: panel/);
  for (let i = 0; i < 6; i += 1) {
    c.now.advance(10 * MIN);
    await c.hub.tick(); // re-judged by peek every tick, for an hour
  }
  assert.equal(c.hub.size().streams, 1, "exactly the idle limit is still live");
  c.now.advance(1);
  await c.hub.tick();
  await s.waitFor(/event: end/);
  await s.done;
  assert.equal((await c.send({ path: "/api/whoami", headers: { cookie } })).status, 401, "the session is over: the stream never moved lastSeen");

  // The control: a request in the same hour does keep it.
  const d = await liveConsole({ idleMs: 60 * MIN });
  const cookie2 = await d.login();
  const s2 = await d.stream(cookie2);
  await s2.waitFor(/event: panel/);
  d.now.advance(50 * MIN);
  assert.equal((await d.send({ path: "/api/whoami", headers: { cookie: cookie2 } })).status, 200);
  d.now.advance(50 * MIN);
  await d.hub.tick();
  assert.equal(d.hub.size().streams, 1);
  s2.destroy();
  await s2.done;
});

test("over HTTP: per-session and console-wide stream caps answer 429 with Retry-After, and a closed stream frees its slot", async () => {
  const c = await liveConsole({ maxStreams: 2, limits: { streamsTotal: 3, streamsOperatorReserve: 0 } });
  const alice = await c.login();
  const a1 = await c.stream(alice);
  const a2 = await c.stream(alice);
  const a3 = await c.stream(alice);
  assert.deepEqual([a1.status, a2.status, a3.status], [200, 200, 429]);
  assert.equal(a3.headers["retry-after"], "5");
  assert.match(a3.text, /this token's sign-ins hold as many live streams/);
  const vic = await c.login(VIEW_TOKEN);
  const v1 = await c.stream(vic);
  const v2 = await c.stream(vic);
  assert.deepEqual([v1.status, v2.status], [200, 429]);
  assert.match(v2.text, /the console holds as many live streams/);
  a1.destroy();
  await a1.done;
  for (let i = 0; i < 50 && c.hub.size().streams !== 2; i += 1) await new Promise((r) => setImmediate(r));
  const v3 = await c.stream(vic);
  assert.equal(v3.status, 200, "the closed stream's slots came back, both of them");
  for (const s of [a2, v1, v3]) s.destroy();
});

test("over HTTP: a token's many sign-ins share one stream budget, and viewer streams stop short of the operators' reserve", async () => {
  const c = await liveConsole({ maxStreams: 2, limits: { streamsTotal: 6, streamsOperatorReserve: 2 } });
  const viewerToken = (ch) => `pdc_${ch.repeat(43)}`;
  c.tokens.file = { ...c.tokens.file, tokens: [...c.tokens.file.tokens, ...["w", "x"].map((ch) => ({ name: `viewer-${ch}`, role: "viewer", sha256: sha256(viewerToken(ch)), createdAt: "2026-10-01T00:00:00.000Z" }))] };
  // One viewer token, signed in three times: two streams between all of its sign-ins.
  const [v1, v2, v3] = [await c.login(VIEW_TOKEN), await c.login(VIEW_TOKEN), await c.login(VIEW_TOKEN)];
  const s1 = await c.stream(v1);
  const s2 = await c.stream(v2);
  const s3 = await c.stream(v3);
  assert.deepEqual([s1.status, s2.status, s3.status], [200, 200, 429]);
  assert.match(s3.text, /this token's sign-ins hold as many live streams/);
  // A second viewer token takes the viewers' last two slots (4 of 6); a third is refused: the last 2 are the operators'.
  const w = await c.login(viewerToken("w"));
  const w1 = await c.stream(w);
  const w2 = await c.stream(w);
  assert.deepEqual([w1.status, w2.status], [200, 200]);
  const x1 = await c.stream(await c.login(viewerToken("x")));
  assert.equal(x1.status, 429);
  assert.match(x1.text, /kept for operators/);
  // An operator still gets both reserved slots.
  const op = await c.login();
  const o1 = await c.stream(op);
  const o2 = await c.stream(op);
  assert.deepEqual([o1.status, o2.status], [200, 200]);
  const open = [s1, s2, w1, w2, o1, o2];
  for (const s of open) s.destroy();
  await Promise.all(open.map((s) => s.done));
});

test("over HTTP: stream refusals before any event: unknown or non-live page 400, a bad page query 400, signed out 401", async () => {
  const c = await liveConsole();
  const cookie = await c.login(VIEW_TOKEN);
  const liveNames = Object.entries(realPages.PAGES).filter(([, p]) => p.live).map(([n]) => n);
  const deadNames = Object.entries(realPages.PAGES).filter(([, p]) => !p.live).map(([n]) => n);
  assert.ok(liveNames.length > 0);
  for (const path of ["/api/events", "/api/events?page=nowhere", "/api/events?page=__proto__", "/api/events?page=toString", ...deadNames.map((n) => `/api/events?page=${n}`), `/api/events?page=${liveNames[0]}&zz%00=1`]) {
    const s = await c.stream(cookie, path);
    assert.equal(s.status, 400, path);
    await s.done;
  }
  const anon = await c.stream("pdc_session=none", "/api/events?page=overview");
  assert.equal(anon.status, 401);
  // A second `page` is refused as every other parameter's second is, whichever page either names.
  for (const path of ["/api/events?page=runs&page=fleet", "/api/events?page=overview&page=overview"]) {
    const s = await c.stream(cookie, path);
    assert.equal(s.status, 400, path);
    await s.done;
    assert.match(s.text, /page is given more than once/);
  }
  assert.equal(c.hub.size().streams, 0);
});

test("over HTTP: HEAD /api/events is 405 with Allow: GET and the security headers, before any stream slot is taken", { timeout: 10_000 }, async () => {
  const c = await liveConsole({ maxStreams: 1 });
  const cookie = await c.login();
  const head = await c.send({ method: "HEAD", path: "/api/events?page=overview", headers: { cookie } });
  assert.equal(head.status, 405);
  assert.equal(head.headers.allow, "GET");
  assert.ok(head.headers["content-security-policy"]);
  assert.equal(c.hub.size().streams, 0);
  const s = await c.stream(cookie);
  assert.equal(s.status, 200, "the one slot this token has is still free");
  s.destroy();
  await s.done;
});

test("over HTTP: with short injected header and request timeouts, an SSE stream stays open well past both", { timeout: 20_000 }, async () => {
  const c = await liveConsole({ limits: { headersTimeout: 300, requestTimeout: 300, connectionsCheckingInterval: 100 } });
  assert.equal(c.server.requestTimeout, 300);
  assert.equal(c.server.headersTimeout, 300);
  const cookie = await c.login();
  const s = await c.stream(cookie);
  await s.waitFor(/event: panel/);
  await new Promise((r) => setTimeout(r, 1200));
  c.content.value = "after-the-timeouts";
  await c.hub.tick();
  await s.waitFor(/after-the-timeouts/);
  assert.equal(c.hub.size().streams, 1);
  s.destroy();
  await s.done;
});

// ---- the real screens through the real server and hub (C's pages.mjs, wired as cli.mjs wires it) ----

test("integration: every real page renders through the server, and a real live stream carries the real panels, role-aware", async () => {
  const now = clock();
  const tokens = { file: { version: 1, generation: 0, tokens: [
    { name: "alice", role: "operator", sha256: sha256(OP_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
    { name: "vic", role: "viewer", sha256: sha256(VIEW_TOKEN), createdAt: "2026-10-01T00:00:00.000Z" },
  ] } };
  const readTokens = () => ({ file: tokens.file });
  const sessions = sessionsModule.makeSessionStore({ now });
  const run = { jobId: "job-1", target: "o/r#12", kind: "github", flow: "fix", outcome: "completed", startedAt: "2026-10-14T11:00:00.000Z", endedAt: "2026-10-14T11:05:00.000Z" };
  const pageDeps = {
    fleet: {
      snapshot: async () => SNAPSHOT,
      runsPage: async () => ({ runs: [run], next: null, mirror: "off", truncated: false, examined: 1 }),
      runById: async (id) => (id === "job-1" ? { record: run, source: "local" } : { missing: true }),
    },
    insights: async () => null,
    audit: async () => ({ rows: [], next: null }),
    subscriptions: async () => [],
    env: {},
    now,
  };
  const timers = fakeTimers();
  const hub = makeLiveHub({ loadPageData: (p, q) => realPages.loadPageData(p, q, pageDeps), pagePanels: realPages.pagePanels, queryKeyOf: realPages.pageQueryString, peekSession: (id, file) => sessions.peek(id, file), readTokens, now, timers });
  const server = createConsoleServer({
    config: { allowedHosts: [], readOnly: false, maxMs: 12 * 60 * MIN },
    now,
    audit: { append: (row) => row },
    sessions,
    cookies: sessionsModule,
    tickets: { issue: () => ({ ticket: "t" }), redeem: () => ({ refusal: "no" }) },
    readTokens,
    findToken: (file, presented) => file.tokens.find((e) => e.sha256 === sha256(presented)) ?? null,
    consumeLoginCode: () => ({ refusal: "unknown" }),
    writePauseWindows: () => ({ ok: true }),
    pageDeps,
    hub,
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const send = ({ method = "GET", path, headers = {}, body = null }) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers }, setHost: false }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
      });
      req.on("error", reject);
      req.end(body ?? undefined);
    });
  const login = async (token) => {
    const res = await send({ method: "POST", path: "/login", headers: { origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ token }) });
    assert.equal(res.status, 200, res.text);
    return res.headers["set-cookie"][0].split(";")[0];
  };
  const op = await login(OP_TOKEN);
  const viewer = await login(VIEW_TOKEN);

  for (const [name, spec] of Object.entries(realPages.PAGES)) {
    const path = name === "run" ? `${spec.path}?id=job-1` : spec.path;
    const res = await send({ path, headers: { cookie: op } });
    assert.equal(res.status, 200, `${path}: ${res.text.slice(0, 300)}`);
    assert.match(res.text, /<link rel="stylesheet" href="\/static\/console.css">|href="\/static\/console.css"/, `${path} links the stylesheet`);
    assert.equal(/<script(?![^>]*src=)/.test(res.text), false, `${path}: no inline script`);
    assert.equal(/ style=/.test(res.text), false, `${path}: no inline style`);
    for (const id of (await realPages.pagePanels(name, { query: name === "run" ? { id: "job-1" } : {}, session: { name: "alice", role: "operator" }, data: await realPages.loadPageData(name, name === "run" ? { id: "job-1" } : {}, pageDeps), readOnly: false })).map((p) => p.id)) {
      assert.match(res.text, new RegExp(`<section id="${id}" data-panel>`), `${path}: panel ${id} is a live region`);
    }
  }
  assert.equal((await send({ path: "/run?id=nope", headers: { cookie: op } })).status, 404, "an unknown run id");
  assert.equal((await send({ path: "/audit", headers: { cookie: viewer } })).status, 403);

  // The fleet page's failed reason: the operator's stream carries it, the viewer's never does.
  const open = (cookie, path) =>
    new Promise((resolve, reject) => {
      const s = { text: "" };
      const req = request({ host: "127.0.0.1", port, path, headers: { host, cookie }, setHost: false }, (res) => {
        s.status = res.statusCode;
        s.done = new Promise((done) => res.on("close", done));
        res.on("data", (c) => (s.text += c));
        resolve(s);
      });
      s.destroy = () => req.destroy();
      req.on("error", reject);
      req.end();
    });
  const opStream = await open(op, "/api/events?page=fleet");
  const viewStream = await open(viewer, "/api/events?page=fleet");
  assert.deepEqual([opStream.status, viewStream.status], [200, 200]);
  await hub.tick();
  for (let i = 0; i < 100 && !(opStream.text.includes("p-failed") && viewStream.text.includes("p-failed")); i += 1) await new Promise((r) => setTimeout(r, 5));
  const opPanels = panelsIn(opStream.text);
  const viewPanels = panelsIn(viewStream.text);
  assert.deepEqual(opPanels.map((p) => p.id).sort(), (await realPages.pagePanels("fleet", { query: {}, session: { role: "operator" }, data: { snapshot: SNAPSHOT, now: T0 }, readOnly: false })).map((p) => p.id).sort());
  // Each stream got its own role's render of the same data.
  const data = await realPages.loadPageData("fleet", {}, pageDeps);
  const expect = async (role) => (await realPages.pagePanels("fleet", { query: {}, session: { role }, data, readOnly: false })).find((p) => p.id === "p-failed").html;
  assert.equal(opPanels.find((p) => p.id === "p-failed").html, await expect("operator"));
  assert.equal(viewPanels.find((p) => p.id === "p-failed").html, await expect("viewer"));
  assert.ok(!viewStream.text.includes("token for alice"), "the viewer's stream never carries BullMQ's free text");
  hub.close();
  await Promise.all([opStream.done, viewStream.done]);
});
