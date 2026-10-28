import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { liveKeyFor, makeLiveTranscript } from "@edgehero/pi-dispatch/live-transcript";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeLiveHub, stateOf } from "../src/console/live.mjs";
import * as realPages from "../src/console/pages.mjs";
import { createConsoleServer } from "../src/console/server.mjs";
import * as sessionsModule from "../src/console/sessions.mjs";
import { preText, runTranscriptSection, TRANSCRIPT_ABSENT, TRANSCRIPT_FORMATS, transcriptEntryHtml, transcriptEntryJson } from "../src/console/transcript.mjs";
import { transcriptAbsentText } from "../src/read-model.mjs";
import { compareTranscriptIds, readTranscriptMeta, readTranscriptSince } from "../src/read-model.mjs";

// The console's live transcript (issue #643, DES-OPERATOR-CONSOLE "Live transcript"): the entry html, the run page's
// section, the hub's second subscription type on a fake reader with ticks driven by hand, and `/api/transcript` over a
// real node:http server, end to end against a real Valkey stream written by the worker's own producer
// (`makeLiveTranscript` on a temp file; VALKEY_TEST_URL, database 13, flushed before and after). Every clock is injected.

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;
const ESC = String.fromCharCode(27);
const RLO = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0);

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

/** setInterval/clearInterval that never fire on their own: the tests call `hub.tick()`. */
function fakeTimers() {
  const timers = { started: 0, cleared: 0 };
  timers.setInterval = () => ({ id: (timers.started += 1) });
  timers.clearInterval = () => (timers.cleared += 1);
  return timers;
}

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
    take() {
      const out = res.chunks.join("");
      res.chunks.length = 0;
      return out;
    },
  };
  return res;
}

/** The entry events in stream text: `[{id, html}]`. */
function entriesIn(text) {
  return [...text.matchAll(/id: (\S+)\nevent: entry\ndata: (.+)\n\n/g)].map(([, id, data]) => ({ id, ...JSON.parse(data) }));
}
const doneIn = (text) => [...text.matchAll(/event: done\ndata: (.+)\n\n/g)].map(([, d]) => JSON.parse(d));

// ---- the entry html ----------------------------------------------------------------------------------------------------

test("entry html: Pulse kinds, UTC time, folded arguments, open failed results and truncated marks", () => {
  const ts = Date.UTC(2026, 9, 14, 12, 34, 56);
  const assistant = String(transcriptEntryHtml({ id: "1-0", kind: "assistant", ts, text: "line one\nline\ttwo" }));
  assert.match(assistant, /class="tx__e tx__entry tx__e--assistant" data-kind="assistant" data-entry-id="1-0"/);
  assert.match(assistant, /<pre>line one\nline\ttwo<\/pre>/);
  assert.match(assistant, /<time class="tx__t" datetime="2026-10-14T12:34:56.000Z">12:34:56 UTC<\/time>/);
  const call = String(transcriptEntryHtml({ id: "2-0", kind: "tool-call", ts, tool: "bash", text: '{"cmd":"ls"}', truncated: true }));
  assert.match(call, /<details><summary>arguments<\/summary>/);
  assert.match(call, /class="tx__trunc">truncated/);
  assert.match(call, /data-tool-timer/);
  const result = String(transcriptEntryHtml({ id: "3-0", kind: "tool-result", text: "boom", tool: "bash", error: true }));
  assert.match(result, /<details open><summary>result<\/summary><pre>boom<\/pre>/);
  for (const [raw, word] of [["policy", "refused"], ["unknown", "unknown"]]) assert.match(String(transcriptEntryHtml({ kind: "end", outcome: raw })), new RegExp("The run is over \\(" + word + "\\)"));
  assert.match(String(transcriptEntryHtml({ kind: "end", outcome: "policy" }, { outcomeWord: "cancelled" })), /over \(cancelled\)/);
  assert.match(String(transcriptEntryHtml({ kind: "reset" })), /starts over/);
  assert.match(String(transcriptEntryHtml({ kind: "skipped" })), /left out/);
  assert.match(String(transcriptEntryHtml({ kind: "invented", text: "x" })), /data-kind="note"/);
  assert.match(String(transcriptEntryHtml({ kind: "steer", text: "operator: go" })), /data-kind="steer"/);
  for (const h of [assistant, call, result]) assert.doesNotMatch(h, /style=|<script|\son[a-z]+=/i);
});

test("hostile entries are escaped: markup, a fake </pre>, raw control and bidi bytes, spelled-out escapes and very long text", () => {
  const hostile = `</pre><script>alert(1)</script><img src=x onerror=alert(2)>${ESC}[31m red ${RLO}gnp.exe ${NUL} \\u{202E} & "q" 'a'`;
  const out = String(transcriptEntryHtml({ id: "1-0", kind: "user", ts: 1, text: `${hostile}\n${hostile}` }));
  assert.equal((out.match(/<\/pre>/g) ?? []).length, 1, "the only </pre> is the entry's own");
  assert.ok(!out.includes("<script") && !out.includes("<img"), "no element from the text");
  assert.ok(!out.includes(ESC) && !out.includes(RLO) && !out.includes(NUL), "no raw control or bidi byte survives");
  assert.ok(out.includes("&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), "the markup is shown as text");
  assert.ok(out.includes("\\u{202E}"), "a spelled-out escape stays visible as text");
  assert.ok(out.includes("&amp; &quot;q&quot; &#39;a&#39;"));
  assert.equal((out.match(/\n/g) ?? []).length, 1, "the one real newline is kept, nothing else becomes one");
  const tool = String(transcriptEntryHtml({ id: "1-1", kind: "tool-call", ts: 1, tool: "x</span><b>", text: "a" }));
  assert.ok(tool.includes("x&lt;/span&gt;&lt;b&gt;"), "a tool name is escaped too (the reader already maps a bad one to ?)");
  const long = "<".repeat(70_000);
  const big = String(transcriptEntryHtml({ id: "1-2", kind: "assistant", ts: 1, text: long }));
  assert.equal((big.match(/&lt;/g) ?? []).length, 70_000, "very long text is escaped whole");
  assert.equal(preText("a\nb").map(String).join(""), "a\nb");
});

test("the static transcript box waits through every state; availability is a separate swapped panel", () => {
  const view = (role, data) => ({ role, query: { id: "gh-1" }, data });
  for (const transcript of [{ exists: true }, { exists: false }, { unreachable: true }, { exists: true, ended: true }]) {
    const box = String(runTranscriptSection(view("operator", { transcript })));
    assert.match(box, /data-transcript data-job="gh-1"/);
    assert.match(box, /data-transcript-filter="messages"/);
    assert.doesNotMatch(box, /Reload to check|data-transcript-status/);
  }
  const viewer = String(runTranscriptSection(view("viewer", {})));
  assert.match(viewer, /Transcripts are shown to operators only/);
  assert.doesNotMatch(viewer, /data-transcript/);
  assert.match(String(runTranscriptSection({ role: "operator", query: { id: `x"><script>` } })), /data-job="x&quot;&gt;&lt;script&gt;"/);
});

// ---- the hub, on a fake reader -----------------------------------------------------------------------------------------

/** An in-memory stream per job, read the way `readTranscriptSince` reads one (exclusive cursor, ended from the stream). */
function fakeStreams() {
  const jobs = new Map();
  const calls = [];
  let n = 0;
  const add = (jobId, fields) => {
    if (!jobs.has(jobId)) jobs.set(jobId, []);
    const id = `${1760000000000 + (n += 1)}-0`;
    jobs.get(jobId).push({ id, kind: "assistant", ts: T0, text: null, tool: null, error: false, truncated: false, outcome: null, ...fields });
    return id;
  };
  const since = async (jobId, after, { count = 200 } = {}) => {
    calls.push([jobId, after, count]);
    const rows = jobs.get(jobId) ?? [];
    const entries = rows.filter((r) => after === null || compareTranscriptIds(r.id, after) > 0).slice(0, count);
    const next = entries.length > 0 ? entries.at(-1).id : after;
    const last = rows.at(-1) ?? null;
    const ended = last !== null && last.kind === "end" && next !== null && compareTranscriptIds(next, last.id) >= 0;
    return { entries, next, ended, outcome: ended ? last.outcome : null };
  };
  return { add, since, calls };
}

const OP = { name: "rob", role: "operator" };
const FILE = { version: 1, generation: 0, tokens: [] };

function hubOn({ streams = fakeStreams(), alive = new Set(["s1", "s2", "s3", "s4"]), transcriptSince, ...rest } = {}) {
  const logs = [];
  const hub = makeLiveHub({
    loadPageData: async () => ({}),
    pagePanels: async () => [],
    peekSession: (id, file) => (file === FILE && alive.has(id) ? { id } : null),
    // The store's verdict, faked: a session that left `alive` was revoked.
    endedReason: (id, file) => (file === FILE && !alive.has(id) ? "revoked" : null),
    readTokens: () => ({ file: FILE }),
    transcriptSince: transcriptSince ?? streams.since,
    now: clock(),
    timers: fakeTimers(),
    random: () => Buffer.from("cafebabe", "hex"),
    log: (line) => logs.push(line),
    ...rest,
  });
  return { hub, streams, alive, logs };
}

test("hub: entries go out in order with their stream ids, rendered by the server; later ticks send only what is new", async () => {
  const h = hubOn();
  const ids = [h.streams.add("job-a", { text: "one" }), h.streams.add("job-a", { kind: "tool-call", tool: "bash", text: "{}" })];
  const res = fakeRes();
  h.hub.subscribeTranscript({ res, sessionId: "s1", session: OP, jobId: "job-a" });
  await h.hub.tick();
  const first = entriesIn(res.take());
  assert.deepEqual(first.map((e) => e.id), ids);
  assert.equal(first[0].html, String(transcriptEntryHtml({ id: ids[0], kind: "assistant", ts: T0, text: "one", tool: null, error: false, truncated: false })));
  await h.hub.tick();
  assert.equal(res.take(), "", "nothing new, nothing sent");
  const third = h.streams.add("job-a", { text: "three" });
  await h.hub.tick();
  assert.deepEqual(entriesIn(res.take()).map((e) => e.id), [third]);
  assert.equal(h.hub.size().views, 0, "a transcript is never a view: no panel holds its text");
});

test("hub: a format it does not write is the HTML stream, never passed through; json is the structured entry (review i02)", async () => {
  const formats = ["json", "xml", "__proto__", "toString", undefined];
  const h = hubOn({ alive: new Set(formats.map((f) => `s-${String(f)}`)) });
  const id = h.streams.add("job-f", { text: "one" });
  const subs = formats.map((format) => {
    const res = fakeRes();
    h.hub.subscribeTranscript({ res, sessionId: `s-${String(format)}`, session: OP, jobId: "job-f", ...(format !== undefined ? { format } : {}) });
    return { format, res };
  });
  await h.hub.tick();
  for (const { format, res } of subs) {
    const [entry] = entriesIn(res.take());
    assert.equal(entry.id, id, String(format));
    if (format === "json") assert.deepEqual(entry, { id, ...transcriptEntryJson({ id, kind: "assistant", ts: T0, text: "one", tool: null, error: false, truncated: false }) });
    else assert.deepEqual(Object.keys(entry).sort(), ["html", "id"], `${String(format)}: the HTML stream`);
  }
});

test("hub: ONE transcriptSince per job per tick for several subscribers, each with its own cursor; a late one catches up a few pages per tick", async () => {
  const h = hubOn({ transcriptPagesPerTick: 2 });
  for (let i = 0; i < 3; i += 1) h.streams.add("job-a", { text: `a${i}` });
  h.streams.add("job-b", { text: "b0" });
  const resA = [fakeRes(), fakeRes(), fakeRes()];
  resA.forEach((res, i) => h.hub.subscribeTranscript({ res, sessionId: `s${i + 1}`, session: OP, jobId: "job-a" }));
  const resB = fakeRes();
  h.hub.subscribeTranscript({ res: resB, sessionId: "s4", session: OP, jobId: "job-b" });
  await h.hub.tick();
  for (const r of resA) r.take();
  resB.take();
  h.streams.calls.length = 0;
  h.streams.add("job-a", { text: "a3" });
  await h.hub.tick();
  assert.deepEqual(h.streams.calls.map(([job]) => job).sort(), ["job-a", "job-b"], "one read per distinct job, however many streams");
  for (const r of resA) assert.deepEqual(entriesIn(r.take()).map((e) => JSON.stringify(e.html).includes("a3")), [true], "each stream got the new entry once");

  // A stream behind the others (a reconnect from far back): the job is read from ITS cursor, a full page at a time.
  const g = hubOn({ transcriptPagesPerTick: 2 });
  const all = [];
  for (let i = 0; i < 1000; i += 1) all.push(g.streams.add("job-c", { text: `c${i}` }));
  const tip = fakeRes();
  g.hub.subscribeTranscript({ res: tip, sessionId: "s1", session: OP, jobId: "job-c", lastEventId: all.at(-1) });
  await g.hub.tick();
  assert.equal(entriesIn(tip.take()).length, 0, "a stream at the tip gets nothing old");
  const late = fakeRes();
  g.streams.calls.length = 0;
  // The subscribe runs a tick at once, and the tick asked for here is folded into one more after it: two ticks.
  g.hub.subscribeTranscript({ res: late, sessionId: "s2", session: OP, jobId: "job-c", lastEventId: all[9] });
  await g.hub.tick();
  assert.deepEqual(g.streams.calls.map(([, after]) => after), [all[9], all[209], all[409], all[609]], "two pages a tick (transcriptPagesPerTick), not the whole stream");
  let got = entriesIn(late.take()).map((e) => e.id);
  assert.deepEqual(got, all.slice(10, 810), "in order, from the Last-Event-ID on");
  await g.hub.tick();
  got = entriesIn(late.take()).map((e) => e.id);
  assert.deepEqual(got, all.slice(810), "the rest at the next tick");
  assert.equal(entriesIn(tip.take()).length, 0, "and never a duplicate to the stream already at the tip");
  g.streams.calls.length = 0;
  await g.hub.tick();
  assert.equal(g.streams.calls.length, 1, "caught up: one read again");
});

test("hub: after the end entry, event: done with the outcome and the stream ends; a resume at the end id gets done at once", async () => {
  const h = hubOn();
  h.streams.add("job-a", { text: "x" });
  const endId = h.streams.add("job-a", { kind: "end", outcome: "failed" });
  const res = fakeRes();
  h.hub.subscribeTranscript({ res, sessionId: "s1", session: OP, jobId: "job-a" });
  await h.hub.tick();
  const text = res.take();
  assert.deepEqual(entriesIn(text).map((e) => e.id).at(-1), endId, "the end entry is shown");
  assert.deepEqual(doneIn(text), [{ outcome: "failed" }]);
  assert.ok(text.indexOf("event: done") > text.lastIndexOf("event: entry"), "done comes last");
  assert.equal(res.ended, true);
  assert.equal(h.hub.size().streams, 0);
  const again = fakeRes();
  h.hub.subscribeTranscript({ res: again, sessionId: "s1", session: OP, jobId: "job-a", lastEventId: endId });
  await h.hub.tick();
  const t2 = again.take();
  assert.equal(entriesIn(t2).length, 0);
  assert.deepEqual(doneIn(t2), [{ outcome: "failed" }]);
});

test("hub: ids past a digit boundary (a 12-digit ms then a 13-digit one, <ms>-9 then <ms>-10) are all sent, in order, and done waits for the end", async () => {
  // A stream read by POSITION, so the fake's order is the stream's own and never the compare under test.
  const ms = "1000000000000";
  const row = (id, fields = {}) => ({ id, kind: "note", ts: T0, text: id, tool: null, error: false, truncated: false, outcome: null, ...fields });
  // Valkey's own order: a 12-digit ms, then eleven entries in one 13-digit millisecond (-0 to -10), then the end.
  const stream = [row("999999999999-3"), ...Array.from({ length: 11 }, (_, i) => row(`${ms}-${i}`)), row("1000000000001-0", { kind: "end", text: null, outcome: "completed" })];
  const reads = [];
  const since = async (_jobId, after, { count = 200 } = {}) => {
    reads.push(after);
    const at = after === null ? 0 : stream.findIndex((r) => r.id === after) + 1;
    const entries = stream.slice(at, at + Math.min(count, 5));
    const next = entries.length > 0 ? entries.at(-1).id : after;
    const ended = next === stream.at(-1).id;
    return { entries, next, ended, outcome: ended ? "completed" : null };
  };
  const h = hubOn({ transcriptSince: since });
  const res = fakeRes();
  h.hub.subscribeTranscript({ res, sessionId: "s1", session: OP, jobId: "job-seq" });
  for (let i = 0; i < 4 && !res.ended; i += 1) await h.hub.tick();
  const text = res.take();
  assert.deepEqual(entriesIn(text).map((e) => e.id), stream.map((r) => r.id), "every entry once, in the stream's order");
  assert.deepEqual(doneIn(text), [{ outcome: "completed" }], "done after the end entry");
  assert.ok(text.indexOf("event: done") > text.lastIndexOf("event: entry"));
  assert.equal(res.ended, true);

  // Two streams on the job, one at <ms>-9 and one at <ms>-10: the job is read from the OLDER cursor, -9, so the stream
  // behind still gets <ms>-10.
  reads.length = 0;
  const g = hubOn({ transcriptSince: since });
  const behind = fakeRes();
  const ahead = fakeRes();
  g.hub.subscribeTranscript({ res: ahead, sessionId: "s1", session: OP, jobId: "job-seq", lastEventId: `${ms}-10` });
  g.hub.subscribeTranscript({ res: behind, sessionId: "s2", session: OP, jobId: "job-seq", lastEventId: `${ms}-9` });
  await g.hub.tick();
  assert.ok(reads.includes(`${ms}-9`), `read from the older cursor: ${JSON.stringify(reads)}`);
  assert.deepEqual(entriesIn(behind.take()).map((e) => e.id)[0], `${ms}-10`, "the stream at -9 gets -10 first");
  assert.ok(!entriesIn(ahead.take()).some((e) => e.id === `${ms}-10` || e.id === `${ms}-9`), "the stream at -10 gets nothing it has");
});

test("hub: a transcript stream whose session fails peek gets event: end with its reason; one whose buffer passes 2 MiB is cut; an unreachable read is logged once, without text", async () => {
  const h = hubOn();
  h.streams.add("job-a", { text: "x" });
  const dead = fakeRes();
  const full = fakeRes();
  const ok = fakeRes();
  h.hub.subscribeTranscript({ res: dead, sessionId: "s1", session: OP, jobId: "job-a" });
  h.hub.subscribeTranscript({ res: full, sessionId: "s2", session: OP, jobId: "job-a" });
  h.hub.subscribeTranscript({ res: ok, sessionId: "s3", session: OP, jobId: "job-a" });
  await h.hub.tick();
  h.alive.delete("s1");
  full.writableLength = 2 * 1024 * 1024 + 1;
  await h.hub.tick();
  assert.match(dead.take(), /event: end\ndata: \{"ended":"revoked"\}\n\n$/);
  assert.equal(dead.ended, true);
  assert.equal(full.destroyed, true, "cut, not ended");
  assert.equal(h.hub.size().streams, 1);

  let fail = true;
  const s = fakeStreams();
  const u = hubOn({ streams: s, transcriptSince: async (...a) => (fail ? { unreachable: "SECRET host:6379 refused" } : s.since(...a)) });
  s.add("job-z", { text: "later" });
  const res = fakeRes();
  u.hub.subscribeTranscript({ res, sessionId: "s1", session: OP, jobId: "job-z" });
  await u.hub.tick();
  await u.hub.tick();
  assert.equal(u.logs.filter((l) => /could not be read/.test(l)).length, 1, "logged when it starts failing, not every tick");
  assert.ok(!u.logs.join("\n").includes("SECRET"), "never the reader's text");
  assert.equal(u.hub.size().streams, 1, "the stream waits");
  fail = false;
  await u.hub.tick();
  assert.equal(entriesIn(res.take()).length, 1);
  assert.equal(u.logs.filter((l) => /read again/.test(l)).length, 1);
});

test("hub: a transcript stream is never told stale or fresh (its entries are a log, not a picture), on a failed read or an unreadable tokens file; close says shutdown", async () => {
  let read = () => ({ file: FILE });
  let unreachable = false;
  const s = fakeStreams();
  const h = hubOn({ streams: s, readTokens: () => read(), transcriptSince: async (...a) => (unreachable ? { unreachable: "down" } : s.since(...a)) });
  s.add("job-a", { text: "one" });
  const res = fakeRes();
  h.hub.subscribeTranscript({ res, sessionId: "s1", session: OP, jobId: "job-a" });
  await h.hub.tick();
  unreachable = true;
  await h.hub.tick();
  read = () => ({ refusal: "the tokens file is readable by others" });
  s.add("job-a", { text: "two" });
  h.alive.delete("s1");
  await h.hub.tick();
  assert.equal(res.ended, false, "an unreadable tokens file ends no transcript stream either");
  unreachable = false;
  read = () => ({ file: FILE });
  h.alive.add("s1");
  await h.hub.tick();
  const text = res.take();
  assert.doesNotMatch(text, /event: (stale|fresh)\n/);
  assert.deepEqual(entriesIn(text).map((e) => JSON.stringify(e.html).includes("two")), [false, true], "the entry held back is sent once the file reads again");
  h.hub.close();
  assert.match(res.take(), /^event: end\ndata: \{"ended":"shutdown"\}\n\n$/);
});

// ---- over HTTP ---------------------------------------------------------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const OP_TOKEN = `pdc_${"o".repeat(43)}`;
const VIEW_TOKEN = `pdc_${"v".repeat(43)}`;
const SNAPSHOT = { queue: { counts: { waiting: 0, active: 1 } }, active: [{ jobId: "job-live", queue: "pi-jobs", startedAt: T0, host: "mini1" }], failed: { rows: [], more: 0 } };

const servers = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((resolve) => s.close(resolve));
  }
});

/** A console with the real session store, the real hub (ticks by hand) and the real pages; `fleet` is the test's. */
async function transcriptConsole({ fleet, maxStreams = 4, readOnly = false } = {}) {
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
  const sessions = sessionsModule.makeSessionStore({ now, idleMs: 60 * MIN, maxMs: 12 * 60 * MIN, maxStreams });
  const pageDeps = { fleet, insights: async () => null, audit: async () => ({ rows: [], next: null }), subscriptions: async () => [], env: {}, now };
  const hub = makeLiveHub({
    loadPageData: (p, q) => realPages.loadPageData(p, q, pageDeps),
    pagePanels: realPages.pagePanels,
    queryKeyOf: realPages.pageQueryString,
    peekSession: (id, file) => sessions.peek(id, file),
    // Wired as cli.mjs wires it: the reason a stream ends is the store's pure verdict.
    endedReason: (id, file) => sessions.verdict(id, file).ended ?? null,
    readTokens,
    transcriptSince: (jobId, after, opts) => fleet.transcriptSince(jobId, after, opts),
    readOnly,
    now,
    timers: fakeTimers(),
  });
  const server = createConsoleServer({
    config: { allowedHosts: [], readOnly, maxMs: 12 * 60 * MIN },
    now,
    audit: { append: (row) => row },
    sessions,
    cookies: sessionsModule,
    tickets: { issue: () => ({ ticket: "t", expiresAt: now() + 5 * MIN }), redeem: () => ({ refusal: "no" }) },
    readTokens,
    findToken: (file, presented) => file.tokens.find((e) => e.sha256 === sha256(presented)) ?? null,
    consumeLoginCode: () => ({ refusal: "unknown" }),
    writePauseWindows: () => ({ ok: true }),
    pageDeps,
    hub,
    stateOf,
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
  const writeHeaders = { origin: `http://${host}`, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const login = async (token = OP_TOKEN) => {
    const res = await send({ method: "POST", path: "/login", headers: writeHeaders, body: JSON.stringify({ token }) });
    assert.equal(res.status, 200, res.text);
    return res.headers["set-cookie"][0].split(";")[0];
  };
  function stream(cookie, path, headers = {}) {
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
  /** Wait (bounded) until the hub holds `n` streams, so a closed stream's slots are back. */
  const settle = async (n) => {
    for (let i = 0; i < 200 && hub.size().streams !== n; i += 1) await new Promise((r) => setTimeout(r, 5));
  };
  return { server, now, tokens, sessions, hub, send, login, stream, settle, writeHeaders };
}

/** A fleet whose transcript is a fake stream (no Valkey): the admission tests. */
function fakeFleet(streams = fakeStreams()) {
  return {
    snapshot: async () => SNAPSHOT,
    runsPage: async () => ({ runs: [], next: null, mirror: "off" }),
    runById: async () => ({ missing: true }),
    transcriptSince: streams.since,
    transcriptMeta: async () => ({ exists: true, ended: false, outcome: null, length: 1, firstId: null, lastId: null }),
  };
}

test("over HTTP: /api/transcript is an operator's: viewer 403, signed out 401, a read-only console still serves it (a read)", { timeout: 20_000 }, async () => {
  const streams = fakeStreams();
  streams.add("job-1", { text: "hello" });
  const c = await transcriptConsole({ fleet: fakeFleet(streams) });
  const op = await c.login();
  const s = await c.stream(op, "/api/transcript?id=job-1");
  assert.equal(s.status, 200);
  assert.equal(s.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(s.headers["cache-control"], "no-store");
  assert.ok(s.headers["content-security-policy"], "the security headers too");
  await s.waitFor(/event: entry/);
  assert.ok(s.text.startsWith("retry: 2000\n\n"));
  s.destroy();
  await s.done;
  const viewer = await c.login(VIEW_TOKEN);
  const v = await c.stream(viewer, "/api/transcript?id=job-1");
  assert.equal(v.status, 403);
  await v.done;
  assert.ok(!v.text.includes("hello"));
  const anon = await c.stream("pdc_session=none", "/api/transcript?id=job-1");
  assert.equal(anon.status, 401);
  await anon.done;
  await c.settle(0);
  assert.equal(c.hub.size().streams, 0, "no refused request took a stream");

  const ro = await transcriptConsole({ fleet: fakeFleet(streams), readOnly: true });
  const r = await ro.stream(await ro.login(), "/api/transcript?id=job-1");
  assert.equal(r.status, 200, "a read-only console refuses writes, not reads");
  await r.waitFor(/event: entry/);
  r.destroy();
  await r.done;
});

test("over HTTP: a bad id is 400 before any slot (missing, twice, outside the run-id charset, an extra parameter); HEAD is 405 with Allow: GET", { timeout: 20_000 }, async () => {
  const c = await transcriptConsole({ fleet: fakeFleet(), maxStreams: 1 });
  const op = await c.login();
  for (const path of ["/api/transcript", "/api/transcript?id=", "/api/transcript?id=a&id=b", "/api/transcript?id=a%20b", "/api/transcript?id=%3Cscript%3E", `/api/transcript?id=${"a".repeat(201)}`, "/api/transcript?id=a&page=overview", "/api/transcript?id=a&id"]) {
    const s = await c.stream(op, path);
    assert.equal(s.status, 400, path);
    await s.done;
    assert.ok(!s.text.includes("<script") && !s.text.includes("aaaaaaaaaa"), `${path}: the refusal never echoes the value`);
  }
  const head = await c.send({ method: "HEAD", path: "/api/transcript?id=a", headers: { cookie: op } });
  assert.equal(head.status, 405);
  assert.equal(head.headers.allow, "GET");
  assert.ok(head.headers["content-security-policy"]);
  const s = await c.stream(op, "/api/transcript?id=a");
  assert.equal(s.status, 200, "the token's one slot is still free after every refusal");
  s.destroy();
  await s.done;
});

test("over HTTP: the slots are shared with /api/events: a token at its cap gets 429 on either route, and a closed stream frees it for the other", { timeout: 20_000 }, async () => {
  const c = await transcriptConsole({ fleet: fakeFleet(), maxStreams: 1 });
  const op = await c.login();
  const events = await c.stream(op, "/api/events?page=overview");
  assert.equal(events.status, 200);
  const t1 = await c.stream(op, "/api/transcript?id=job-1");
  assert.equal(t1.status, 429);
  assert.equal(t1.headers["retry-after"], "5");
  assert.match(t1.text, /this token's sign-ins hold as many live streams/);
  events.destroy();
  await events.done;
  await c.settle(0);
  const t2 = await c.stream(op, "/api/transcript?id=job-1");
  assert.equal(t2.status, 200, "the page stream's slot came back");
  const e2 = await c.stream(op, "/api/events?page=overview");
  assert.equal(e2.status, 429, "and a transcript holds a slot a page stream then cannot take");
  t2.destroy();
  await t2.done;
});

test("over HTTP: Last-Event-ID resumes in the stream's own shape; a panel-shaped id is ignored and the stream starts from the beginning", { timeout: 20_000 }, async () => {
  const streams = fakeStreams();
  const ids = [1, 2, 3].map((i) => streams.add("job-1", { text: `e${i}` }));
  const c = await transcriptConsole({ fleet: fakeFleet(streams) });
  const op = await c.login();
  const resumed = await c.stream(op, "/api/transcript?id=job-1", { "last-event-id": ids[0] });
  await resumed.waitFor(new RegExp(`id: ${ids[2]}\\n`));
  assert.deepEqual(entriesIn(resumed.text).map((e) => e.id), ids.slice(1));
  for (const bad of ["cafebabe-3", "abc", `${ids[1]}x`, "1-2-3"]) {
    const s = await c.stream(op, "/api/transcript?id=job-1", { "last-event-id": bad });
    await s.waitFor(new RegExp(`id: ${ids[2]}\\n`));
    assert.deepEqual(entriesIn(s.text).map((e) => e.id), ids, `${bad}: from the beginning`);
    s.destroy();
    await s.done;
  }
  resumed.destroy();
  await resumed.done;
});

test("over HTTP: a session that ends mid-stream (logout, revoke) gets event: end on its transcript stream, saying why", { timeout: 20_000 }, async () => {
  const c = await transcriptConsole({ fleet: fakeFleet() });
  const op = await c.login();
  const s = await c.stream(op, "/api/transcript?id=job-1");
  await s.waitFor(/^retry: 2000\n\n/);
  await c.send({ method: "POST", path: "/logout", headers: { ...c.writeHeaders, cookie: op } });
  await s.waitFor(/event: end\ndata: /);
  await s.done;
  assert.match(s.text, /event: end\ndata: \{"ended":"elsewhere"\}\n\n$/, "this browser signed out in another tab");
  const op2 = await c.login();
  const s2 = await c.stream(op2, "/api/transcript?id=job-1");
  await s2.waitFor(/^retry: 2000\n\n/);
  c.tokens.file = { ...c.tokens.file, tokens: c.tokens.file.tokens.filter((t) => t.name !== "alice") };
  await c.hub.tick();
  await s2.waitFor(/event: end\ndata: /);
  await s2.done;
  assert.match(s2.text, /event: end\ndata: \{"ended":"revoked"\}\n\n$/);
  await c.settle(0);
  assert.equal(c.hub.size().streams, 0);
});

// ---- end to end: the worker's producer, a real Valkey stream, the real readers -----------------------------------------

const BASE = process.env.VALKEY_TEST_URL;
const URL13 = BASE
  ? (() => {
      const u = new URL(BASE);
      u.pathname = "/13";
      return u.toString();
    })()
  : null;
const live = { skip: URL13 ? false : "needs VALKEY_TEST_URL", timeout: 30_000 };

let client = null;
async function fresh() {
  if (!client) {
    const { Redis } = await import("ioredis");
    client = new Redis(URL13, { maxRetriesPerRequest: 1 });
  }
  await client.flushdb();
  return client;
}
after(async () => {
  if (client) {
    await client.flushdb().catch(() => {});
    await client.quit().catch(() => {});
  }
});

test("end to end: the producer's stream reaches the operator's /api/transcript in order, escaped, then done with the outcome; text only in operator entry events, never /api/state, initial HTML or panel events", live, async () => {
  const redis = await fresh();
  const jobId = "job-live";
  const MARK = "TRANSCRIPT-ONLY-MARK";
  const file = join(tempDir("console-transcript-"), "current.jsonl");
  const at = (s) => new Date(T0 + s * 1000).toISOString();
  const line = (o) => `${JSON.stringify(o)}\n`;
  writeFileSync(file, line({ type: "session", version: 3, id: "s1", timestamp: at(0), cwd: "/workspace" }));
  appendFileSync(file, line({ type: "message", id: "u", parentId: null, timestamp: at(1), message: { role: "user", content: `${MARK} fix it\n</pre><script>alert(1)</script>${RLO}` } }));
  appendFileSync(file, line({ type: "message", id: "a", parentId: null, timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: `${MARK} on it` }, { type: "toolCall", id: "t", name: "bash", arguments: { cmd: "ls <x>" } }] } }));
  const producer = makeLiveTranscript({ file, jobId, redis, now: clock(T0) });
  await producer.poll();

  // The fleet the console reads through: the real readers on the real client.
  const fleet = {
    snapshot: async () => SNAPSHOT,
    runsPage: async () => ({ runs: [], next: null, mirror: "off" }),
    runById: async () => ({ missing: true }),
    transcriptSince: (id, after, { count } = {}) => readTranscriptSince(redis, id, after, { count }),
    transcriptMeta: (id) => readTranscriptMeta(redis, id),
  };
  let reads = 0;
  const counted = { ...fleet, transcriptSince: (...a) => ((reads += 1), fleet.transcriptSince(...a)) };
  const c = await transcriptConsole({ fleet: counted });
  const op = await c.login();
  const viewer = await c.login(VIEW_TOKEN);

  // The run page: no record yet (it is running), a stream: the operator's section opens it, 200 not 404.
  const page = await c.send({ path: `/run?id=${jobId}`, headers: { cookie: op } });
  assert.equal(page.status, 200);
  assert.match(page.text, /<div id="transcript" class="run-transcript">/);
  assert.match(page.text, /<div class="tx transcript" data-transcript data-job="job-live" tabindex="0" aria-label="Run transcript"><\/div>/);
  assert.ok(!page.text.includes(MARK), "the run page itself carries no transcript text");
  const vpage = await c.send({ path: `/run?id=${jobId}`, headers: { cookie: viewer } });
  assert.match(vpage.text, /Transcripts are shown to operators only\./);
  assert.doesNotMatch(vpage.text, /data-transcript data-job/);

  const a = await c.stream(op, `/api/transcript?id=${jobId}`);
  const b = await c.stream(op, `/api/transcript?id=${jobId}`);
  const panels = await c.stream(op, "/api/events?page=overview");
  await a.waitFor(/tool call/);
  await b.waitFor(/tool call/);
  const got = entriesIn(a.text);
  assert.deepEqual(got.map((e) => /data-kind="([^"]+)"/.exec(e.html)[1]), ["note", "user", "assistant", "tool-call"]);
  for (const e of got) assert.match(e.id, /^\d{1,16}-\d{1,10}$/, "the id is the stream's own");
  assert.deepEqual(entriesIn(b.text).map((e) => e.id), got.map((e) => e.id), "both streams, the same entries");
  const user = got[1].html;
  assert.ok(user.includes(`${MARK} fix it\n&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;\\u{202E}`), user);
  assert.equal((user.match(/<\/pre>/g) ?? []).length, 1);
  assert.match(got[3].html, /<details><summary>arguments<\/summary><pre>\{&quot;cmd&quot;:&quot;ls &lt;x&gt;&quot;\}<\/pre><\/details>/);

  // Several subscribers, one read per job per tick (a tick first, to drain the ones the subscribes started).
  await c.hub.tick();
  reads = 0;
  await c.hub.tick();
  assert.equal(reads, 1, "two streams on one job: one read");

  // More arrives, then the run ends: done with the outcome, and the streams close.
  appendFileSync(file, line({ type: "message", id: "r", parentId: null, timestamp: at(3), message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "no such file" }] } }));
  await producer.finish("completed");
  await c.hub.tick();
  for (const s of [a, b]) {
    await s.waitFor(/event: done\ndata: \{"outcome":"completed"\}\n\n/);
    await s.done;
  }
  const all = entriesIn(a.text);
  assert.deepEqual(all.slice(-2).map((e) => /data-kind="([^"]+)"/.exec(e.html)[1]), ["tool-result", "end"]);
  assert.match(all.at(-2).html, /tx__e--error[\s\S]*?<span>error<\/span>/);

  // Nothing of it outside the operator's transcript stream.
  const state = await c.send({ path: "/api/state", headers: { cookie: op } });
  assert.equal(state.status, 200);
  assert.ok(!state.text.includes(MARK), "/api/state carries no transcript text");
  await c.hub.tick();
  assert.match(panels.text, /event: panel/);
  assert.ok(!panels.text.includes(MARK), "no panel carries transcript text");
  const runData = await realPages.loadPageData("run", { id: jobId }, { fleet, now: T0 });
  for (const role of ["operator", "viewer"]) {
    for (const p of await realPages.pagePanels("run", { query: { id: jobId }, session: { role }, data: runData, readOnly: false })) assert.ok(!p.html.includes(MARK), `${role}: panel ${p.id}`);
  }
  assert.ok(!JSON.stringify(runData).includes(MARK), "the run page's data holds no text, only the stream's facts");
  const ended = await c.send({ path: `/run?id=${jobId}`, headers: { cookie: op } });
  assert.match(ended.text, /Ended \(completed\)/);
  panels.destroy();
  await panels.done;
});

test("end to end: an expired or unpublished stream gives the run page its reason, and a stream past 2 MiB in the socket is cut", live, async () => {
  const redis = await fresh();
  const fleet = {
    snapshot: async () => SNAPSHOT,
    runsPage: async () => ({ runs: [], next: null, mirror: "off" }),
    runById: async () => ({ record: { jobId: "gone-1", outcome: "completed", startedAt: "2026-10-14T10:00:00.000Z", endedAt: "2026-10-14T10:05:00.000Z" }, source: "local" }),
    transcriptSince: (id, after, { count } = {}) => readTranscriptSince(redis, id, after, { count }),
    transcriptMeta: (id) => readTranscriptMeta(redis, id),
  };
  const c = await transcriptConsole({ fleet });
  const op = await c.login();
  const page = await c.send({ path: "/run?id=gone-1", headers: { cookie: op } });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(TRANSCRIPT_ABSENT), "the reason, naming all three causes");
  assert.match(page.text, /data-transcript data-job="gone-1"/, "a static box waits without a second stream");

  // The cut, on the hub the server uses: a reader that stopped reading is destroyed, its slot given back.
  const res = fakeRes();
  const hubCut = makeLiveHub({ loadPageData: async () => ({}), pagePanels: async () => [], peekSession: () => ({}), readTokens: () => ({ file: FILE }), transcriptSince: fleet.transcriptSince, now: clock(), timers: fakeTimers() });
  await redis.xadd(liveKeyFor("big-1"), "*", "kind", "assistant", "ts", String(T0), "text", "x".repeat(1000));
  hubCut.subscribeTranscript({ res, sessionId: "s1", session: OP, jobId: "big-1" });
  res.writableLength = 2 * 1024 * 1024 + 1;
  await hubCut.tick();
  assert.equal(res.destroyed, true);
  assert.equal(hubCut.size().streams, 0);
});

// ---- the JSON format (issue #647): the terminal chat's entries ----------------------------------------------------------

const JSON_KEYS = ["error", "id", "kind", "outcome", "text", "tool", "truncated", "ts"];

test("entry json: exactly {id, kind, ts, text, tool, error, truncated, outcome}, rebuilt by name; a field that is not its type is null or false", () => {
  const ts = Date.UTC(2026, 9, 14, 12, 34, 56);
  assert.deepEqual(transcriptEntryJson({ id: "1-0", kind: "tool-result", ts, text: "out", tool: "bash", error: true, truncated: true, outcome: null, extra: "SMUGGLED" }), { id: "1-0", kind: "tool-result", ts, text: "out", tool: "bash", error: true, truncated: true, outcome: null });
  assert.deepEqual(transcriptEntryJson({ id: "2-0", kind: "end", ts, text: null, tool: null, error: false, truncated: false, outcome: "completed" }).outcome, "completed");
  assert.equal(transcriptEntryJson({ id: "3-0", kind: "end", outcome: "made up words" }).outcome, "unknown", "an end's outcome is the worker's vocabulary or unknown");
  assert.equal(transcriptEntryJson({ id: "3-1", kind: "assistant", outcome: "completed" }).outcome, null, "only an end carries an outcome");
  const odd = transcriptEntryJson({ id: "not an id", kind: "new-kind", ts: -1, text: 7, tool: "bad tool name!", error: "1", truncated: 1 });
  assert.deepEqual(odd, { id: null, kind: "note", ts: null, text: null, tool: "?", error: false, truncated: false, outcome: null });
  assert.deepEqual(Object.keys(transcriptEntryJson(null)).sort(), JSON_KEYS);
  assert.deepEqual(TRANSCRIPT_FORMATS, ["html", "json"]);
});

test("hub: a format=json stream gets the structured entry, an html stream beside it on the same job gets html, from ONE read", async () => {
  const h = hubOn();
  const ids = [h.streams.add("job-a", { text: "one" }), h.streams.add("job-a", { kind: "tool-call", tool: "bash", text: "{}" })];
  const asJson = fakeRes();
  const asHtml = fakeRes();
  h.hub.subscribeTranscript({ res: asJson, sessionId: "s1", session: OP, jobId: "job-a", format: "json" });
  h.hub.subscribeTranscript({ res: asHtml, sessionId: "s2", session: OP, jobId: "job-a" });
  await h.hub.tick();
  const j = entriesIn(asJson.take());
  assert.deepEqual(j.map((e) => e.id), ids);
  assert.deepEqual(j[1], { id: ids[1], kind: "tool-call", ts: T0, text: "{}", tool: "bash", error: false, truncated: false, outcome: null });
  assert.ok(j.every((e) => !("html" in e)), "no html in a json stream");
  const x = entriesIn(asHtml.take());
  assert.deepEqual(Object.keys(x[0]).sort(), ["html", "id"], "the html stream is what it was");
  h.streams.calls.length = 0;
  const third = h.streams.add("job-a", { text: "three" });
  await h.hub.tick();
  assert.equal(h.streams.calls.length, 1, "both formats from one read per tick");
  assert.deepEqual(entriesIn(asJson.take()).map((e) => [e.id, e.text]), [[third, "three"]]);
  assert.deepEqual(entriesIn(asHtml.take()).map((e) => e.id), [third]);
  // An unknown format is the html one: the route refuses it first; this is the hub's own belt.
  const odd = fakeRes();
  h.hub.subscribeTranscript({ res: odd, sessionId: "s3", session: OP, jobId: "job-a", format: "xml" });
  await h.hub.tick();
  assert.ok(entriesIn(odd.take()).every((e) => typeof e.html === "string"));
});

test("over HTTP: format=json streams JSON entries, resumes on Last-Event-ID, ends with done; a viewer is 403 and format is validated before any slot", { timeout: 20_000 }, async () => {
  const streams = fakeStreams();
  // Hostile text: SSE framing, markup and terminal escapes. It must arrive as the same JSON string, inert.
  const hostile = `line\n\nevent: end\ndata: {}\n\n<script>alert(1)</script>${ESC}[2J${RLO}${NUL}\r\n`;
  const ids = [streams.add("job-1", { text: "hello" }), streams.add("job-1", { text: hostile })];
  const c = await transcriptConsole({ fleet: fakeFleet(streams), maxStreams: 1 });
  const op = await c.login();
  const s = await c.stream(op, "/api/transcript?id=job-1&format=json");
  assert.equal(s.status, 200);
  assert.equal(s.headers["content-type"], "text/event-stream; charset=utf-8");
  await s.waitFor(new RegExp(`id: ${ids[1]}\\n`));
  const got = entriesIn(s.text);
  assert.deepEqual(got.map((e) => e.id), ids);
  for (const e of got) assert.deepEqual(Object.keys(e).sort(), JSON_KEYS);
  assert.equal(got[1].text, hostile, "the hostile text is one JSON string, byte for byte");
  assert.doesNotMatch(s.text, /\nevent: end\n/, "and it never framed an event of its own");
  assert.ok(!s.text.includes(ESC) && !s.text.includes("\r"), "no raw ESC or CR on the wire: JSON escapes them");
  s.destroy();
  await s.done;
  await c.settle(0);
  // Resume past the first entry, then the run ends.
  const resumed = await c.stream(op, "/api/transcript?format=json&id=job-1", { "last-event-id": ids[0] });
  await resumed.waitFor(new RegExp(`id: ${ids[1]}\\n`));
  assert.deepEqual(entriesIn(resumed.text).map((e) => e.id), [ids[1]]);
  const endId = streams.add("job-1", { kind: "end", outcome: "completed" });
  await c.hub.tick();
  await resumed.waitFor(/event: done\n/);
  assert.deepEqual(entriesIn(resumed.text).at(-1), { id: endId, kind: "end", ts: T0, text: null, tool: null, error: false, truncated: false, outcome: "completed" });
  assert.deepEqual(doneIn(resumed.text), [{ outcome: "completed" }]);
  await resumed.done;
  await c.settle(0);
  // The role and the parameter rules.
  const v = await c.stream(await c.login(VIEW_TOKEN), "/api/transcript?id=job-1&format=json");
  assert.equal(v.status, 403);
  await v.done;
  assert.ok(!v.text.includes("hello"));
  for (const path of ["/api/transcript?id=job-1&format=xml", "/api/transcript?id=job-1&format=", "/api/transcript?id=job-1&format=json&format=html", "/api/transcript?id=job-1&format=JSON", "/api/transcript?id=job-1&format=%3Cscript%3E"]) {
    const r = await c.stream(op, path);
    assert.equal(r.status, 400, path);
    await r.done;
    assert.ok(!r.text.includes("<script") && !r.text.includes("xml") && !r.text.includes("JSON"), `${path}: the refusal never echoes the value`);
  }
  const html = await c.stream(op, "/api/transcript?id=job-1&format=html");
  assert.equal(html.status, 200, "format=html is the default spelled out, and the one slot was free after every refusal");
  await html.waitFor(/event: entry/);
  assert.ok(entriesIn(html.text).every((e) => typeof e.html === "string"));
  html.destroy();
  await html.done;
});

test("#747 HTTP run pages carry operator entries on one connection each, preserve cursors and leave spare slots", { timeout: 20_000 }, async () => {
  const streams = fakeStreams();
  const ids = [streams.add("job-1", { text: "only-in-entry-747" }), streams.add("job-1", { text: "second-entry-747" })];
  const c = await transcriptConsole({ fleet: fakeFleet(streams), maxStreams: 4 });
  const op = await c.login();
  const one = await c.stream(op, "/api/events?page=run&id=job-1");
  const two = await c.stream(op, "/api/events?page=run&id=job-1");
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  await one.waitFor(/only-in-entry-747/);
  await two.waitFor(/second-entry-747/);
  assert.equal(c.hub.size().streams, 2, "each tab holds exactly its page connection");
  for (const connection of [one, two]) {
    assert.deepEqual(entriesIn(connection.text).map((e) => e.id), ids);
    for (const [, data] of connection.text.matchAll(/event: panel\ndata: (.+)\n\n/g)) assert.doesNotMatch(data, /only-in-entry|second-entry/);
    assert.doesNotMatch(connection.text, /id: [^\n]+\nevent: panel/);
  }
  const spare = await c.stream(op, "/api/events?page=overview");
  assert.equal(spare.status, 200, "two run tabs leave room for another page");
  one.destroy(); two.destroy(); spare.destroy();
  await Promise.all([one.done, two.done, spare.done]);
  await c.settle(0);
  const resumed = await c.stream(op, "/api/events?page=run&id=job-1", { "last-event-id": ids[0] });
  await resumed.waitFor(/second-entry-747/);
  assert.deepEqual(entriesIn(resumed.text).map((e) => e.id), ids.slice(1));
  resumed.destroy(); await resumed.done;
  const viewer = await c.stream(await c.login(VIEW_TOKEN), "/api/events?page=run&id=job-1");
  await viewer.waitFor(/event: panel/);
  assert.doesNotMatch(viewer.text, /event: entry|only-in-entry-747|second-entry-747/);
  viewer.destroy(); await viewer.done;
});
