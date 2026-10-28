import assert from "node:assert/strict";
import { test } from "node:test";
import { makeLiveHub } from "../src/console/live.mjs";
import { transcriptEntryHtml } from "../src/console/transcript.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { runConsoleScript } from "./helpers/script-dom.mjs";

const AT = Date.UTC(2026, 9, 28, 12);
const OP = { name: "op", role: "operator" };
function response() {
  return { chunks: [], writableLength: 0, ended: false, destroyed: false,
    write(s) { this.chunks.push(s); }, end() { this.ended = true; }, destroy() { this.destroyed = true; },
    take() { const s = this.chunks.join(""); this.chunks = []; return s; } };
}
function rig() {
  let data = { transcript: { exists: false } };
  let entries = [];
  let unreachable = false;
  let tokens = true;
  const reads = [];
  const logs = [];
  const hub = makeLiveHub({ now: () => AT, pageMinMs: {}, timers: { setInterval: () => 1, clearInterval() {} },
    log: (line) => logs.push(line),
    loadPageData: async () => data,
    pagePanels: async () => [{ id: "p-chat", html: "safe panel" }],
    readTokens: () => ({ file: tokens ? { tokens: [] } : null }), peekSession: () => ({}),
    transcriptSince: async (job, after) => {
      reads.push([job, after]);
      if (unreachable) return { unreachable: true };
      const next = entries.at(-1)?.id ?? null;
      return { entries: entries.filter((e) => after === null || BigInt(e.id.split("-")[0]) > BigInt(after.split("-")[0])), next, ended: entries.at(-1)?.kind === "end", outcome: "policy" };
    },
  });
  const open = (role = "operator", lastEventId = null) => {
    const res = response();
    const unsubscribe = hub.subscribe({ res, sessionId: "s", session: { ...OP, role }, page: "run", query: { id: "gh-747" }, lastEventId });
    return { res, unsubscribe };
  };
  return { hub, reads, logs, open, setData(v) { data = v; }, setEntries(v) { entries = v; }, fail(v) { unreachable = v; }, tokens(v) { tokens = v; } };
}
const entry = (id, kind = "assistant") => ({ id, kind, ts: AT, text: "private transcript", outcome: kind === "end" ? "policy" : null });
const events = (s, name) => [...s.matchAll(new RegExp(`event: ${name}\\ndata: (.+)\\n\\n`, "g"))].map((m) => JSON.parse(m[1]));

test("run page attaches a later transcript on its one connection; viewers never attach and panels carry no cursor", async () => {
  const r = rig();
  const op = r.open(); const viewer = r.open("viewer");
  await r.hub.tick();
  assert.equal(r.reads.length, 0);
  assert.doesNotMatch(op.res.take(), /id:/);
  r.setData({ transcript: { exists: true, ended: false } }); r.setEntries([entry("1-0")]);
  await r.hub.tick();
  assert.deepEqual(r.reads, [["gh-747", null]]);
  assert.equal(events(op.res.take(), "entry").length, 1);
  assert.doesNotMatch(viewer.res.take(), /private transcript|event: entry/);
  assert.equal(r.hub.size().streams, 2);
  op.unsubscribe(); viewer.unsubscribe();
  assert.equal(r.hub.size().streams, 0);
});

test("run reconnect replays every panel without overwriting transcript cursor; end keeps page open and terminal closes", async () => {
  const r = rig();
  r.setData({ transcript: { exists: true, ended: true }, run: { record: { outcome: "policy", reason: "operator-cancel" } } });
  r.setEntries([entry("1-0"), entry("2-0", "end")]);
  const op = r.open("operator", "1-0"); await r.hub.tick();
  const text = op.res.take();
  assert.equal(events(text, "panel").length, 1);
  assert.doesNotMatch(text, /id: [^\n]+\nevent: panel/);
  assert.equal(events(text, "entry").length, 1);
  assert.equal(events(text, "tdone").length, 1);
  assert.equal(op.res.ended, false);
  await r.hub.tick(); assert.equal(events(op.res.take(), "tdone").length, 0);
  const atEnd = r.open("operator", "2-0"); await r.hub.tick();
  assert.equal(events(atEnd.res.take(), "tdone").length, 1, "tip reconnect still learns completion");
  const terminal = response();
  r.hub.subscribeTranscript({ res: terminal, sessionId: "s", session: OP, jobId: "gh-747", lastEventId: "2-0" });
  await r.hub.tick();
  assert.equal(events(terminal.take(), "done").length, 1);
  assert.equal(terminal.ended, true);
  r.hub.close();
});

test("degraded run panels have no ids, attach only after recovery, retry failed reads and pause for unreadable tokens", async () => {
  const r = rig();
  r.setData({ readFailed: true, transcript: { exists: true } });
  const op = r.open(); await r.hub.tick();
  assert.doesNotMatch(op.res.take(), /id:/); assert.equal(r.reads.length, 0);
  r.setData({ transcript: { exists: true } }); r.fail(true); await r.hub.tick();
  assert.equal(events(op.res.take(), "entry").length, 0);
  r.fail(false); r.setEntries([entry("1-0")]); r.tokens(false); await r.hub.tick();
  assert.equal(events(op.res.take(), "entry").length, 0);
  r.tokens(true); await r.hub.tick(); assert.equal(events(op.res.take(), "entry").length, 1);
  r.hub.close();
});

test("two run tabs share transcript reads but keep separate cursors and connection lifetimes", async () => {
  const r = rig(); r.setData({ transcript: { exists: true } }); r.setEntries([entry("1-0"), entry("2-0")]);
  const a = r.open(); await r.hub.tick(); a.res.take();
  r.reads.length = 0;
  const b = r.open("operator", "1-0"); await r.hub.tick();
  assert.ok(r.reads.length <= 2, "subscribe plus explicit tick, never one read per tab");
  assert.equal(events(a.res.take(), "entry").length, 0);
  assert.equal(events(b.res.take(), "entry").length, 1);
  b.res.writableLength = 3 * 1024 * 1024; await r.hub.tick();
  assert.equal(b.res.destroyed, true); assert.equal(r.hub.size().streams, 1);
  r.hub.close(); assert.equal(a.res.ended, true);
});

const markup = `<html><body data-live="run" data-query="id=gh-747"><main id="main"><section id="p-chat" data-panel><div data-run-question></div></section><section id="p-tail" data-panel><div data-run-tail></div></section><section id="p-transcript" data-panel><p data-transcript-status></p></section><div data-transcript data-job="gh-747"></div><button data-transcript-filter="all"></button><button data-transcript-filter="messages"></button><button data-transcript-filter="tools"></button><span data-transcript-following></span><button data-transcript-newest></button></main></body></html>`;
function browserEntry(kind, text, tool = "", ts = AT) {
  return `<article class="tx__entry" data-kind="${kind}" data-tool="${tool}" data-ts="${ts}"><header></header><div class="tx__body"><pre>${text}</pre></div></article>`;
}

test("browser uses only the page stream, safely fills question/tail after swaps and leaves it open after tdone", () => {
  const d = runConsoleScript(CONSOLE_SCRIPT, markup);
  assert.equal(d.streams.length, 1); assert.match(d.streams[0].url, /api\/events/);
  const s = d.streams[0];
  const questionEntry = { html: String(transcriptEntryHtml({ id: "1-0", kind: "assistant", ts: AT, text: "<img src=x onerror=bad>What now?" })) };
  s.emit("entry", questionEntry, "1-0");
  s.emit("entry", questionEntry, "1-0");
  assert.equal(d.document.querySelectorAll("[data-transcript] article").length, 1, "replayed cursor is not duplicated");
  assert.equal(d.document.querySelector("[data-run-question]").textContent, "<img src=x onerror=bad>What now?");
  assert.equal(d.document.querySelector("[data-run-question]").querySelector("img"), null);
  s.emit("panel", { id: "p-chat", html: "<div data-run-question></div>" });
  assert.match(d.document.querySelector("[data-run-question]").textContent, /What now/);
  s.emit("panel", { id: "p-tail", html: "<div data-run-tail></div>" });
  assert.equal(d.document.querySelectorAll("[data-run-tail] article").length, 1);
  s.emit("tdone", { outcome: "cancelled" });
  assert.equal(s.closed, false);
  assert.equal(d.document.querySelector("[data-transcript-status]").textContent, "ended (cancelled)");
  s.emit("panel", { id: "p-transcript", html: "<p data-transcript-status></p>" });
  assert.equal(d.document.querySelector("[data-transcript-status]").textContent, "ended (cancelled)");
});

test("browser filters and running-call timer update on result; reset clears the parked question", () => {
  const d = runConsoleScript(CONSOLE_SCRIPT, markup);
  const s = d.streams[0];
  s.emit("entry", { html: browserEntry("assistant", "question") });
  s.emit("entry", { html: String(transcriptEntryHtml({ kind: "tool-call", text: "args", tool: "bash", ts: 1000 })) });
  assert.ok(d.document.querySelector("[data-call-elapsed]"));
  d.document.querySelector('[data-transcript-filter="messages"]').click();
  assert.equal(d.document.querySelector('[data-transcript] [data-kind="tool-call"]').hidden, true);
  assert.equal(d.document.querySelector('[data-run-tail] [data-kind="assistant"]').hidden, false, "tail entries are independent of the whole transcript's filter");
  s.emit("entry", { html: browserEntry("tool-result", "result", "bash") });
  assert.equal(d.document.querySelector("[data-call-elapsed]"), null);
  s.emit("entry", { html: browserEntry("reset", "") });
  assert.equal(d.document.querySelector("[data-run-question]").textContent, "");
});


test("an authoritative record corrects an earlier transcript end, and a resumed publisher attaches again", async () => {
  const r = rig(); r.setData({ transcript: { exists: true, ended: true } }); r.setEntries([entry("1-0", "end")]);
  const op = r.open(); await r.hub.tick();
  assert.deepEqual(events(op.res.take(), "tdone"), [{ outcome: "refused" }]);
  r.setData({ transcript: { exists: true, ended: true }, run: { record: { outcome: "policy", reason: "operator-cancel" } } });
  await r.hub.tick(); assert.deepEqual(events(op.res.take(), "tdone"), [{ outcome: "cancelled" }]);
  r.setData({ transcript: { exists: true, ended: false, lastId: "2-0" } }); r.setEntries([entry("2-0")]);
  await r.hub.tick(); assert.equal(events(op.res.take(), "entry").length, 1);
  r.hub.close();
});


test("cached pre-end metadata never repeats transcript completion", async () => {
  const r = rig(); r.setData({ transcript: { exists: true, ended: false, lastId: "1-0" } });
  r.setEntries([entry("1-0"), entry("2-0", "end")]);
  const op = r.open(); await r.hub.tick(); assert.equal(events(op.res.take(), "tdone").length, 1);
  await r.hub.tick(); await r.hub.tick(); assert.equal(events(op.res.take(), "tdone").length, 0);
  r.hub.close();
});


test("a persistent attached transcript read failure logs once and once on recovery", async () => {
  const r = rig(); r.setData({ transcript: { exists: true } }); r.fail(true);
  r.open(); await r.hub.tick(); await r.hub.tick(); await r.hub.tick();
  assert.equal(r.logs.filter((line) => line.includes("transcript could not be read")).length, 1);
  r.fail(false); await r.hub.tick();
  assert.equal(r.logs.filter((line) => line.includes("transcript is read again")).length, 1);
  r.hub.close();
});

test("concurrent calls of the same tool keep separate timers until their results arrive", () => {
  const d = runConsoleScript(CONSOLE_SCRIPT, markup); const s = d.streams[0];
  for (const ts of [1000, 1100]) s.emit("entry", { html: String(transcriptEntryHtml({ kind: "tool-call", text: "args", tool: "bash", ts })) });
  assert.equal(d.document.querySelectorAll("[data-transcript] [data-call-elapsed]").length, 2);
  s.emit("entry", { html: String(transcriptEntryHtml({ kind: "tool-result", text: "first result", tool: "bash", ts: 1200 })) });
  assert.equal(d.document.querySelectorAll("[data-transcript] [data-call-elapsed]").length, 1);
  s.emit("entry", { html: String(transcriptEntryHtml({ kind: "tool-result", text: "second result", tool: "bash", ts: 1300 })) });
  assert.equal(d.document.querySelectorAll("[data-transcript] [data-call-elapsed]").length, 0);
});


test("a replacement transcript already ended between page loads is caught up too", async () => {
  const r = rig(); r.setData({ transcript: { exists: true, ended: true, lastId: "1-0" } }); r.setEntries([entry("1-0", "end")]);
  const op = r.open(); await r.hub.tick(); op.res.take();
  r.setData({ transcript: { exists: true, ended: true, lastId: "3-0" } }); r.setEntries([entry("2-0"), entry("3-0", "end")]);
  await r.hub.tick(); const text = op.res.take();
  assert.equal(events(text, "entry").length, 2); assert.equal(events(text, "tdone").length, 1);
  r.hub.close();
});

test("a live swap promotes the parked question to the hero and returns live chat without duplicating transcript entries", () => {
  const layout = `<html><body data-live="run" data-query="id=gh-747"><main id="main"><div class="cols"><div class="stack run-main"><section id="p-outcome" data-panel></section><div data-transcript data-job="gh-747"></div></div><div class="stack run-side"><section id="p-chat" data-panel><p>Live</p></section></div></div></main></body></html>`;
  const d = runConsoleScript(CONSOLE_SCRIPT, layout);
  const s = d.streams[0], chat = d.document.getElementById("p-chat"), transcript = d.document.querySelector("[data-transcript]");
  s.emit("entry", { html: String(transcriptEntryHtml({ id: "1-0", kind: "assistant", text: "What now?", ts: AT })) }, "1-0");
  s.emit("panel", { id: "p-chat", html: '<article class="qcard"><div data-run-question></div><form><textarea name="text"></textarea></form></article>' });
  assert.equal(chat.parentNode, d.document.querySelector(".run-main"));
  assert.equal(chat.parentNode.firstChild, chat);
  assert.equal(d.document.querySelector("[data-run-question]").textContent, "What now?");
  assert.equal(d.document.querySelectorAll('#p-chat').length, 1);
  assert.equal(d.document.querySelector("[data-transcript]"), transcript);
  s.emit("panel", { id: "p-chat", html: '<p>Live again</p>' });
  assert.equal(chat.parentNode, d.document.querySelector(".run-side"));
  assert.equal(d.document.querySelectorAll('[data-transcript] article').length, 1);
});


test("a future record outcome remains authoritative over an older transcript's raw exit outcome", async () => {
  const r = rig(); r.setData({ transcript: { exists: true, ended: true }, run: { record: { outcome: "future-outcome", reason: null } } }); r.setEntries([entry("1-0", "end")]);
  const op = r.open(); await r.hub.tick(); const text = op.res.take();
  assert.deepEqual(events(text, "tdone"), [{ outcome: "future-outcome" }]);
  assert.match(events(text, "entry")[0].html, /future-outcome/);
  r.hub.close();
});
