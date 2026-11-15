import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { getTimeline, makeTimelineReader, parseHistoryQuery } from "../src/console/history-api.mjs";
import { historyPageHtml } from "../src/console/history-view.mjs";
import { timelineModel } from "../src/console/timeline.mjs";
import { execFileSync } from "node:child_process";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { Event, runConsoleScript, fakeTimers, flush } from "./helpers/script-dom.mjs";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const q = () => parseHistoryQuery(new URLSearchParams({ anchor: String(NOW), zoom: "24h" }), NOW);
const row = (id) => ({ jobId: id, project: "web", host: "a", outcome: "completed", startedAt: NOW - 10000, endedAt: NOW - 1000 });

test("history cursors bind the person, time range and stable source list", async () => {
  const calls = [];
  const reader = makeTimelineReader({ now: () => NOW, random: () => "a".repeat(32), fleet: {
    historySources: async () => ({ hosts: ["b"] }),
    historyPage: async (a) => { calls.push(a); return { runs: [row("gh-" + calls.length)], next: null, olderAt: null }; },
  } });
  const first = await reader(q(), "alice.viewer");
  assert.ok(first.next);
  assert.equal((await reader({ ...q(), cursor: first.next }, "bob.viewer")).error, "cursor-expired");
  assert.equal((await reader({ ...q(), cursor: first.next, anchor: NOW - 1000 }, "alice.viewer")).error, "cursor-expired");
  await reader({ ...q(), cursor: first.next }, "alice.viewer");
  const last = await reader({ ...q(), cursor: first.next }, "alice.viewer");
  assert.deepEqual(calls.map((c) => c.host), [null, "b", "@mirror"]);
  assert.equal(last.next, null);
});

test("offline hosts leave explicit partial coverage and do not hide another host's records", async () => {
  const reader = makeTimelineReader({ now: () => NOW, fleet: { historySources: async () => ({ hosts: ["offline"] }), historyPage: async ({ host }) => host === "offline" ? { error: "host-unavailable" } : { runs: [row("gh-ok")], next: null } } });
  let page = await reader(q(), "p");
  page = await reader({ ...q(), cursor: page.next }, "p");
  assert.equal(page.partial, true);
  assert.match(String(historyPageHtml({ query: q(), now: NOW, page: { ...page, next: null }, runHref: (id) => "/run?id=" + id })), /History is incomplete/);
});

test("historical geometry uses actual instants and never draws today's waiting jobs in the past", () => {
  const anchor = NOW - 7 * 86400000;
  const model = timelineModel({ now: NOW, anchor, zoom: "1h", runs: [{ ...row("gh-past"), startedAt: anchor - 60000, endedAt: anchor + 60000 }], active: [{ jobId: "gh-live", startedAt: NOW - 10000 }], waiting: [{ jobId: "gh-wait" }] });
  assert.equal(model.current, false);
  assert.equal(model.rows.flatMap((r) => r.lanes.flat()).length, 1);
  assert.equal(model.rows[0].lanes[0][0].endAt - model.rows[0].lanes[0][0].startAt, 120000);
});

test("dense overlapping runs and projects beyond the picture's cap remain individually linked", () => {
  const runs = Array.from({ length: 100 }, (_, i) => ({ ...row("gh-" + i), project: "p" + i }));
  const text = String(historyPageHtml({ query: q(), now: NOW, page: { runs, next: "a".repeat(32), partial: false, olderAt: null }, runHref: (id) => "/run?id=" + id }));
  for (const r of runs) assert.ok(text.includes(`href="/run?id=${r.jobId}"`));
  assert.match(text, /More runs in this window/);
});

test("invalid and duplicate inputs are refused before history reads", () => {
  for (const s of ["anchor=no", "zoom=forever", "anchor=1", "project=../x", "cursor=secret", "zoom=1h&zoom=3h", "host=other"]) assert.equal(parseHistoryQuery(new URLSearchParams(s), NOW), null);
});

test("an agent's expired cursor is still a failed read after privacy projection", async () => {
  const ctx = { deps: { now: () => NOW, pageDeps: { fleet: { historySources() { throw new Error("must not read"); }, historyPage() { throw new Error("must not read"); } } } }, session: { name: "agent", role: "agent" }, searchParams: new URLSearchParams({ anchor: String(NOW), cursor: "f".repeat(32) }), json: (status, body) => ({ status, body }) };
  const response = await getTimeline(ctx);
  assert.equal(response.status, 409);
  assert.match(response.body.html, /Run history could not be read/);
});

test("archive questions state the recorded request, never invent an answer or a continuing wait", () => {
  const page = { runs: [{ ...row("gh-question"), reason: "awaiting-input" }], next: null, partial: false, olderAt: null };
  const text = String(historyPageHtml({ query: q(), now: NOW, page, runHref: (id) => "/run?id=" + id }));
  assert.match(text, /requested input at/);
  assert.doesNotMatch(text, /answered since|class="tail"/);
});

test("the console's history styles are the published design's bytes and recorded hash", () => {
  const generator = readFileSync(new URL("../../design/tools/gen_overview.py", import.meta.url), "utf8");
  const consoleCss = readFileSync(new URL("../src/console/page-css.mjs", import.meta.url), "utf8");
  const source = generator.match(/HISTORY_CSS = """([\s\S]*?)"""/)[1];
  assert.equal(consoleCss.match(/const HISTORY_CSS = `([\s\S]*?)`/)[1], source);
  assert.ok(consoleCss.includes("sha256 " + createHash("sha256").update(source).digest("hex")));
});

test("Amsterdam winter, summer and both clock changes use each instant's offset; UTC stays UTC", () => {
  const instants = ["2026-01-15T12:00:00Z", "2026-07-15T12:00:00Z", "2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z", "2026-03-29T00:30:00Z", "2026-03-29T01:30:00Z"];
  const source = `import { timelineLocalTime } from ${JSON.stringify(new URL("../src/console/history-browser.mjs", import.meta.url).href)}; console.log(JSON.stringify(${JSON.stringify(instants)}.map((s) => timelineLocalTime(Date.parse(s)))));`;
  const read = (TZ) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, TZ }, encoding: "utf8" }));
  assert.deepEqual(read("Europe/Amsterdam"), ["2026-01-15 13:00 UTC+1", "2026-07-15 14:00 UTC+2", "2026-10-25 02:30 UTC+2", "2026-10-25 02:30 UTC+1", "2026-03-29 01:30 UTC+1", "2026-03-29 03:30 UTC+2"]);
  assert.deepEqual(read("UTC"), instants.map((s) => s.slice(0, 16).replace("T", " ") + " UTC"));
});

test("the served browser code fetches history, keeps its anchor and refuses a live replacement while browsing", async () => {
  const card = String(historyPageHtml({ query: q(), now: NOW, page: { runs: [row("gh-one")], next: null, partial: false, olderAt: null }, runHref: (id) => "/run?id=" + id }));
  const markup = `<html><body data-page="overview" data-live="overview"><span class="who" data-name="alice" data-role="viewer"></span><section data-panel id="p-timeline">${card}</section></body></html>`;
  const w = runConsoleScript(CONSOLE_SCRIPT, markup, { url: "/?anchor=" + NOW, timers: fakeTimers(NOW) });
  assert.equal(w.fetch.calls.length, 1);
  assert.match(w.fetch.calls[0].url, /^\/api\/timeline\?/);
  await w.fetch.calls[0].answer(200, { html: card, count: 1, next: null });
  await flush();
  assert.match(w.location.search, /anchor=/);
  assert.ok(w.document.querySelector(".tl-run"));
  w.streams[0].emit("panel", { id: "p-timeline", html: "<p>unexpected replacement</p>" });
  assert.ok(w.document.querySelector(".tl-run"), "history was not replaced by the live window");
  w.document.querySelector(".tl-run").focus();
  w.document.querySelector("[data-history-preview] button").click();
  assert.equal(w.document.querySelector("[data-history-preview]").hidden, true, "closing the preview keeps it closed when focus returns");
  w.document.querySelector(".history-window").dispatchEvent(new Event("keydown", { key: "ArrowLeft", bubbles: true }));
  assert.equal(w.fetch.calls.length, 2, "one key press moves one window, even after panel initialization");
  await w.fetch.calls[1].answer(200, { html: card, count: 1, next: null });
  await flush();
  for (let i = 0; i < 2; i++) {
    const scroll = w.document.querySelector(".history-window");
    scroll.dispatchEvent(new Event("wheel"));
    scroll.scrollLeft = 0;
    scroll.dispatchEvent(new Event("scroll"));
    assert.equal(w.fetch.calls.length, 3 + i);
    await w.fetch.calls[2 + i].answer(200, { html: card, count: 1, next: null });
    await flush();
    assert.ok(w.document.querySelector(".history-window").scrollLeft > 2, "a new window opens away from the edge so the next gesture works");
  }
});
