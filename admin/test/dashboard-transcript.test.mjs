import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripAnsi, visibleLen } from "../src/style.mjs";
import { scrubControls } from "../src/panel.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * LIVE_TAIL from the live transcript stream (issue #643): the `/dispatch` overlay reads a running job's transcript
 * through the `tailTranscript` / `transcriptMeta` seams (the fleet reader's held client in production), renders each
 * entry as a header and its scrubbed, wrapped text, keeps a cursor so a tick reads only what is new, names the end, and
 * falls back to this host's `.log` (or to "this run is on host X") when the run has no stream. Offline: canned seams,
 * never a Valkey.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard, createDashboardDeps, transcriptLines, activeProgressText } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeTui = () => ({ requestRender() {} });
const AT = Date.UTC(2026, 9, 16, 12, 0, 0);

const SNAP = () => ({
  queue: { pausedState: false, counts: { waiting: 0, active: 1, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 0, week: 0, month: 0 },
  settings: { path: "/s", overlay: {} },
  runs: [],
  schedulers: [],
  activeJobId: "jA",
  active: [{ jobId: "jA", queue: "pi-jobs@mini2", startedAt: AT - 60_000, host: "mini2" }],
});

function deps(overrides = {}) {
  return { fetchSnapshot: async () => SNAP(), pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT, ...overrides };
}

async function until(fn, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await delay(5);
  }
}

const e = (id, kind, text, extra = {}) => ({ id, kind, ts: 1, text, tool: null, error: false, truncated: false, outcome: null, ...extra });

/** A scripted stream: `pages[after ?? "start"]` answers a read from that cursor; anything else is an empty page. */
function scripted(pages, { meta = { exists: true, ended: false } } = {}) {
  const calls = [];
  return {
    calls,
    transcriptMeta: async () => meta,
    tailTranscript: async (jobId, after) => {
      calls.push({ jobId, after });
      return pages[after ?? "start"] ?? { entries: [], next: after, ended: false, outcome: null };
    },
  };
}

test("stream entries render as header and text, append on later ticks, and the cursor advances", { timeout: 20_000 }, async () => {
  const s = scripted({
    start: { entries: [e("1-1", "assistant", "hello world"), e("1-2", "tool-call", '{"cmd":"ls"}', { tool: "bash" })], next: "1-2", ended: false },
    "1-2": { entries: [e("1-3", "tool-result", "boom", { tool: "bash", error: true, truncated: true })], next: "1-3", ended: false },
  });
  let logReads = 0;
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 20, deps: deps({ ...s, tailLog: () => (logReads++, { lines: ["LOG"] }) }) });
  await flush();
  comp.handleInput("l");
  await until(() => s.calls.length >= 3, "three transcript reads");
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(out, /live jA -- live transcript, \d+ line\(s\)/, "the header names the source");
  assert.match(out, /> assistant\s/);
  assert.match(out, /  hello world/);
  assert.match(out, /> tool-call bash/);
  assert.match(out, /> tool-result bash ERROR \(truncated\)/);
  assert.match(out, /  boom/, "the second tick's entry was appended");
  assert.ok(out.indexOf("hello world") < out.indexOf("boom"), "in stream order");
  assert.deepEqual(s.calls.slice(0, 3).map((c) => c.after), [null, "1-2", "1-3"], "each read starts at the last id the previous one returned");
  assert.ok(s.calls.every((c) => c.jobId === "jA"));
  assert.equal(logReads, 0, "a run with a stream never reads the .log");
  assert.equal((out.match(/hello world/g) ?? []).length, 1, "no entry is drawn twice");
});

test("the end entry names the outcome, and the tail stops reading after it", { timeout: 20_000 }, async () => {
  const s = scripted({ start: { entries: [e("1-1", "user", "do it"), e("1-2", "end", null, { outcome: "failed" })], next: "1-2", ended: true, outcome: "failed" } });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 15, deps: deps(s) });
  await flush();
  comp.handleInput("l");
  await until(() => s.calls.length >= 1, "the first read");
  await delay(120);
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(out, /\(run ended: failed\)/);
  assert.doesNotMatch(out, /> end/, "the end entry is the ended line, not an entry");
  assert.equal(s.calls.length, 1, "nothing is read after the end");
});

test("a run with no stream falls back to this host's .log, told the job's host", { timeout: 20_000 }, async () => {
  const s = scripted({}, { meta: { exists: false } });
  const logCalls = [];
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: deps({ ...s, tailLog: (a) => (logCalls.push(a), { lines: ["LOG_LINE_1"] }) }) });
  await flush();
  comp.handleInput("l");
  await until(() => logCalls.length >= 1, "the .log read");
  await flush();
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(out, /LOG_LINE_1/);
  assert.match(out, /live jA -- 1 line\(s\)/, "the .log tail's header, unchanged");
  assert.equal(s.calls.length, 0, "no transcript read for a run without a stream");
  assert.deepEqual(logCalls[0], { jobId: "jA", lines: 200, host: "mini2" }, "the registry's host for the job rides along");
});

test("a registry host outside the worker-name charset is never handed on as the job's host", { timeout: 20_000 }, async () => {
  const logCalls = [];
  const snap = { ...SNAP(), active: [{ jobId: "jA", host: "evil\x1b[2J" }] };
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: deps({ ...scripted({}, { meta: { exists: false } }), fetchSnapshot: async () => snap, tailLog: (a) => (logCalls.push(a), { missing: true }) }) });
  await flush();
  comp.handleInput("l");
  await until(() => logCalls.length >= 1, "the .log read");
  await comp.dispose();
  assert.equal(logCalls[0].host, null);
});

test("opening a long run reads every retained page in one tick, not one page a second", { timeout: 20_000 }, async () => {
  const full = Array.from({ length: 200 }, (_, i) => e(`1-${i + 1}`, "note", `n${i + 1}`));
  const s = scripted({
    start: { entries: full, next: "1-200", ended: false },
    "1-200": { entries: [e("1-201", "assistant", "THE_NEWEST")], next: "1-201", ended: false },
  });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: deps(s) });
  await flush();
  comp.handleInput("l");
  await until(() => s.calls.length >= 2, "the second page");
  await flush();
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.deepEqual(s.calls.map((c) => c.after), [null, "1-200"], "a full page reads on; a short one stops");
  assert.match(out, /THE_NEWEST/);
  assert.match(out, /\[200\/200\] follow/, "the last TAIL_LINES lines, pinned to the bottom");
});

test("a foreign run with neither stream nor local log says which host and why", { timeout: 20_000 }, async () => {
  const s = scripted({}, { meta: { exists: false } });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: deps({ ...s, tailLog: () => ({ missing: true, elsewhere: "mini2" }) }) });
  await flush();
  comp.handleInput("l");
  await flush();
  await flush();
  for (const width of [80, 40]) {
    const lines = comp.render(width).map(stripAnsi);
    const out = lines.join(" ").replace(/[│\s]+/g, " ");
    assert.match(out, /this run is on host mini2\./, `width ${width}`);
    assert.match(out, /PI_LIVE_TRANSCRIPTS=0/);
    assert.match(out, /expired/);
    assert.match(out, /raw log stays on that host/);
    assert.doesNotMatch(out, /PI_CAPTURE_JOB_LOGS/, "not the local capture switch: this host could never have had the log");
    for (const l of lines) assert.ok(visibleLen(l) <= width, `over-wide at ${width}: ${l}`);
  }
  await comp.dispose();

  // The local miss with a transcript seam present names both switches.
  const local = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: deps({ ...scripted({}, { meta: { exists: false } }), tailLog: () => ({ missing: true }) }) });
  await flush();
  local.handleInput("l");
  await flush();
  await flush();
  const said = stripAnsi(local.render(120).join("\n"));
  await local.dispose();
  assert.match(said, /no captured log \(PI_CAPTURE_JOB_LOGS/);
  assert.match(said, /no live transcript in Valkey/);
});

test("index.ts's .log read is told the job's host and this host's name", async () => {
  const logsDir = tempDir("live-643-logs-");
  writeFileSync(join(logsDir, "gh-here.log"), "line one\nline two\n");
  const saved = { name: process.env.PI_WORKER_NAME, ptr: process.env.PI_DISPATCH_DEPLOYMENT_FILE };
  process.env.PI_DISPATCH_DEPLOYMENT_FILE = join(logsDir, "no-pointer.json");
  process.env.PI_WORKER_NAME = "mini1";
  try {
    const { panelTailLog } = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
    const tail = panelTailLog({ logsDir });
    assert.deepEqual(tail({ jobId: "gh-gone", lines: 200, host: "mini2" }), { missing: true, elsewhere: "mini2" }, "another host's run says where it is");
    assert.deepEqual(tail({ jobId: "gh-gone", lines: 200, host: "mini1" }), { missing: true }, "this host's own run is an uncaptured one");
    assert.deepEqual(tail({ jobId: "gh-gone", lines: 200 }), { missing: true }, "no host known, no claim");
    assert.deepEqual(tail({ jobId: "gh-here", lines: 200, host: "mini2" }), { lines: ["line one", "line two"] }, "a log that is here is read, wherever the registry says");
  } finally {
    for (const [k, v] of [["PI_WORKER_NAME", saved.name], ["PI_DISPATCH_DEPLOYMENT_FILE", saved.ptr]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("hostile entry text stays inert and inside the frame at every width", { timeout: 20_000 }, async () => {
  const ESC = "\x1b";
  const hostile = [
    `erase ${ESC}[2J csi \u009b31m bel \x07 cr \r osc8 ${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\ clip ${ESC}]52;c;aGk=\x07`,
    "漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字 wide",
    "family 👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦 zwj and bidi ‮evil‬ and zero width ​ here",
    "escaped by the worker \\u{001B}[2J line\\u{000A}second line",
  ].join("\n");
  const s = scripted({ start: { entries: [e("1-1", "tool-result", hostile, { tool: `b${ESC}[31mash` })], next: "1-1", ended: false } });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, deps: deps(s) });
  await flush();
  comp.handleInput("l");
  await until(() => s.calls.length >= 1, "the read");
  await flush();
  const dirty = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‮]/;
  for (const width of [80, 40, 20, 12, 8, NaN, 4]) {
    const lines = comp.render(width);
    assert.doesNotMatch(lines.join("\n"), dirty, `a control byte reached the pane at width ${width}`);
    if (Number.isFinite(width) && width >= 8) for (const l of lines) assert.ok(visibleLen(l) <= width, `over-wide at ${width}: ${JSON.stringify(l)}`);
  }
  const at80 = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.match(at80, /second line/, "the worker's escaped newline is a line break");
  assert.match(at80, /漢字/, "wide text is kept, wrapped");
});

test("long text wraps to the frame without losing a character, and a resize re-wraps", () => {
  const plainStyler = { visibleLen };
  const text = "abcdefghij".repeat(12);
  const at40 = transcriptLines([e("1-1", "assistant", text)], 36, plainStyler);
  assert.equal(at40[0], "> assistant");
  assert.ok(at40.length > 3, "wrapped onto several lines");
  for (const l of at40.slice(1)) assert.ok(visibleLen(l) <= 36 && l.startsWith("  "), JSON.stringify(l));
  assert.equal(at40.slice(1).map((l) => l.slice(2)).join(""), text, "every character kept, in order");
  const at80 = transcriptLines([e("1-1", "assistant", text)], 76, plainStyler);
  assert.ok(at80.length < at40.length, "a wider frame takes fewer lines");
  assert.deepEqual(transcriptLines([e("1-1", "note", "  indented  code")], null, plainStyler), ["> note", "    indented  code"], "unframed: no cut, spaces kept");
  const many = Array.from({ length: 300 }, (_, i) => e(`1-${i}`, "note", `n${i}`));
  const kept = transcriptLines(many, 76, plainStyler);
  assert.equal(kept.length, 200, "at most the last TAIL_LINES lines");
  assert.equal(kept[kept.length - 1], "  n299");
  // Scrubbed BEFORE the cut, so the cut measures what is drawn: a control byte is a column once substituted, and cutting
  // the raw text would leave a line over the width for the view's clip to eat characters from.
  const dirtyText = "ab\u0001cd\u0007ef".repeat(8);
  const cut = transcriptLines([e("1-1", "note", dirtyText)], 12, plainStyler).slice(1);
  assert.equal(cut.map((l) => l.slice(2)).join(""), scrubControls(dirtyText), "the scrubbed text, whole, in order");
  for (const l of cut) assert.ok(visibleLen(l) <= 12, JSON.stringify(l));
  // The worker writes a newline out as `\u{000A}` (escapeControls); it becomes a line break, never the character.
  assert.deepEqual(transcriptLines([e("1-1", "note", "one\\u{000A}two\\u{000D}\\u{000A}three\nfour")], null, plainStyler), ["> note", "  one", "  two", "  three", "  four"]);
  assert.deepEqual(transcriptLines([e("1-1", "reset", null), e("1-2", "skipped", null), e("1-3", "end", null, { outcome: "completed" })], 76, plainStyler), ["> reset: the transcript started over", "> skipped: an oversize or unreadable line"]);
});

test("scrubbed BEFORE the cut: an escape sequence or a wide character at the wrap boundary is measured as it is drawn", () => {
  const plainStyler = { visibleLen };
  const ESC = "\x1b";
  // At inner 12 the text gets 10 columns. Raw, a whole SGR sequence measures as nothing, so text that fits only while
  // its escapes are invisible (`abcdefgh` and `[31m`, drawn as 13 columns once the ESC is substituted) would go uncut
  // and overflow; an OSC 8 link hides its whole URL from the measure the same way, and wide characters before an
  // escape fill the budget it then overruns. Scrubbed first, every column the pane draws is counted.
  for (const text of [`abcdefgh${ESC}[31m`, `abc${ESC}]8;;https://evil.example${ESC}\\link${ESC}]8;;${ESC}\\`, `漢字漢字${ESC}[1mx`, `abcdefghi${ESC}[31mXYZ${ESC}[0m tail`]) {
    const cut = transcriptLines([e("1-1", "note", text)], 12, plainStyler).slice(1);
    assert.equal(cut.map((l) => l.slice(2)).join(""), scrubControls(text), `the scrubbed text, whole, in order: ${JSON.stringify(text)}`);
    for (const l of cut) {
      assert.ok(visibleLen(l) <= 12, `over the frame: ${JSON.stringify(l)}`);
      assert.ok(!l.includes(ESC), `a raw ESC reached a line: ${JSON.stringify(l)}`);
    }
  }
  // A wide character that would straddle the boundary goes to the next piece whole.
  const wide = transcriptLines([e("1-1", "note", "abcdefghi漢x")], 12, plainStyler).slice(1);
  assert.deepEqual(wide, ["  abcdefghi", "  漢x"]);
});

test("opening a long run reads at most TAIL_PAGES_MAX pages in one tick (the 2,000 retained over 200 a page, plus one), however much waits", { timeout: 20_000 }, async () => {
  let reads = 0;
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: deps({
      transcriptMeta: async () => ({ exists: true }),
      // Every read comes back full: an endless stream, so only the bound stops the tick.
      tailTranscript: async () => {
        reads += 1;
        const entries = Array.from({ length: 200 }, (_, i) => e(`${reads}-${i}`, "note", `p${reads}e${i}`));
        return { entries, next: entries.at(-1).id, ended: false };
      },
    }),
  });
  await flush();
  comp.handleInput("l");
  await until(() => reads >= 11, "eleven reads");
  await delay(100);
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.equal(reads, 11, "Math.ceil(LIVE_MAX_ENTRIES 2000 / page 200) + 1 reads, then the tick ends");
  assert.match(out, /p11e199/, "the newest page is drawn");
});

test("the held entries are bounded: a stream of far more entries than the retained lines keeps only the last TAIL_LINES", { timeout: 20_000 }, async () => {
  // Each entry records when a renderer reads it, so a re-wrap (a new width) shows how many entries are HELD, not drawn.
  const touched = new Set();
  const counted = (id, text) => {
    const entry = e(id, "note", text);
    return new Proxy(entry, { get: (t, p) => (p === "kind" && touched.add(t.id), t[p]) });
  };
  let reads = 0;
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: deps({
      transcriptMeta: async () => ({ exists: true }),
      tailTranscript: async () => {
        reads += 1;
        if (reads > 5) return { entries: [], next: `${reads - 1}-199`, ended: false };
        const entries = Array.from({ length: 200 }, (_, i) => counted(`${reads}-${i}`, `r${reads}i${i}`));
        return { entries, next: entries.at(-1).id, ended: false };
      },
    }),
  });
  await flush();
  comp.handleInput("l");
  await until(() => reads >= 6, "the reads");
  await delay(50);
  comp.render(80);
  touched.clear();
  comp.render(60); // a new width re-wraps every held entry
  await comp.dispose();
  assert.ok(touched.size > 0, "the re-wrap read the held entries");
  assert.ok(touched.size <= 200, `${touched.size} entries held after 1,000 were read`);
  assert.ok(touched.has("5-199") && !touched.has("1-0"), "the newest are kept, the oldest dropped");
});

test("a read that lands after Esc is dropped, never drawn into the next tail", { timeout: 20_000 }, async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  let reads = 0;
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: deps({
      transcriptMeta: async () => ({ exists: true }),
      tailTranscript: async () => {
        reads += 1;
        if (reads === 1) {
          await gate;
          return { entries: [e("1-1", "assistant", "STALE_ENTRY")], next: "1-1", ended: false };
        }
        return { entries: [], next: null, ended: false };
      },
    }),
  });
  await flush();
  comp.handleInput("l");
  await until(() => reads === 1, "the first read to start");
  comp.handleInput("\x1b"); // Esc back to the list while the read is in flight
  comp.handleInput("l"); // and straight back into a fresh tail
  release();
  await delay(20);
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.doesNotMatch(out, /STALE_ENTRY/);
});

test("transcript text never enters the snapshot, the list or any shared renderer", { timeout: 20_000 }, async () => {
  const CANARY = "transcript-canary-643-9b1f";
  const snap = SNAP();
  const finished = [];
  const s = scripted({ start: { entries: [e("1-1", "assistant", `the secret plan ${CANARY}`), e("1-2", "tool-call", CANARY, { tool: "bash" })], next: "1-2", ended: false } });
  const comp = makeDashboard({ paths: {}, done: (v) => finished.push(v), tui: fakeTui(), intervalMs: 100000, deps: deps({ ...s, fetchSnapshot: async () => snap }) });
  await flush();
  comp.handleInput("l");
  await until(() => s.calls.length >= 1, "the read");
  await flush();
  assert.match(comp.render(80).join("\n"), new RegExp(CANARY), "the overlay does draw it");
  assert.doesNotMatch(JSON.stringify(snap), new RegExp(CANARY), "the snapshot object holds none of it");
  comp.handleInput("\x1b");
  await flush();
  assert.doesNotMatch(comp.render(80).join("\n"), new RegExp(CANARY), "back on the list, nothing of it is drawn");
  comp.handleInput("l"); // reopening starts empty, before its first read lands
  assert.doesNotMatch(comp.render(80).join("\n"), new RegExp(CANARY), "the transcript did not outlive the view");
  await comp.dispose();
  assert.doesNotMatch(JSON.stringify(finished), new RegExp(CANARY), "nothing of it left with the overlay");
});

test("createDashboardDeps wires the transcript seams to the fleet reader's own client", async () => {
  const commands = [];
  const fakeRedis = {
    xrange: async (...a) => (commands.push(["xrange", ...a]), [["5-1", ["kind", "user", "ts", "5", "text", "hi"]]]),
    xrevrange: async (...a) => (commands.push(["xrevrange", ...a]), [["5-1", ["kind", "user", "ts", "5", "text", "hi"]]]),
    xlen: async (...a) => (commands.push(["xlen", ...a]), 1),
    disconnect() {},
  };
  const queue = () => ({ name: "pi-jobs", close: async () => {} });
  let clients = 0;
  const d = createDashboardDeps({ valkeyUrl: "redis://unused:1" }, { redisFn: () => (clients++, fakeRedis), makeQueueFn: queue });
  const page = await d.tailTranscript("gh-acme-1", null);
  assert.deepEqual(page.entries.map((x) => [x.id, x.kind, x.text]), [["5-1", "user", "hi"]]);
  assert.deepEqual(await d.transcriptMeta("gh-acme-1"), { exists: true, ended: false, outcome: null, length: 1, firstId: "5-1", lastId: "5-1" });
  assert.equal((await d.tailTranscript("gh-acme-1", "5-1")).next, "5-1");
  assert.deepEqual(commands[0], ["xrange", "run:live:gh-acme-1", "-", "+", "COUNT", 200]);
  assert.ok(commands.some((c) => c[0] === "xrange" && c[2] === "(5-1"), "the cursor is exclusive");
  assert.equal(clients, 1, "one client: the reader's own");
  await d.dispose();
});

// Issue #644: the ACTIVE row's progress. The integers come off the snapshot's active row; the phase NAME through the
// `progress` seam (the fleet reader's single read in production), scrubbed and clipped. The job runs on mini2, not
// this host: progress lives in the shared Valkey, so a remote job's row reads the same.
test("the ACTIVE row shows turn, steps, the running tool and the phase, rich and plain, within every width, for a remote host's job", { timeout: 20_000 }, async () => {
  const ESC = String.fromCharCode(27);
  const name = `migrate${ESC}[2J the ジョブ schema and then some more words`;
  const snap = () => ({ ...SNAP(), active: [{ ...SNAP().active[0], progress: { turn: 7, steps: 12, failed: 1, running: { tool: "bash", since: AT - 40_000 }, phase: { index: 1, count: 4, done: 3, total: 10 }, ended: false } }] });
  const reads = [];
  const progress = async (jobId) => (reads.push(jobId), { v: 1, phase: { index: 1, done: 3, total: 10 }, phases: ["survey", name] });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100_000, deps: deps({ fetchSnapshot: async () => snap(), progress }) });
  await until(() => reads.length > 0 && stripAnsi(comp.render(200).join("\n")).includes("phase 2/4"), "the progress read");
  const rich = stripAnsi(comp.render(200).join("\n"));
  const plain = comp.render(Number.NaN).join("\n");
  assert.deepEqual(reads, ["jA"], "one read, for the one job the row shows");
  // The name is scrubbed (the ESC becomes a space) and clipped to 24 columns, then the row is clipped to the pane.
  const expected = /ACTIVE jA running · turn 7 · 12 steps \(1 failed\) · bash 40s · phase 2\/4 migrate \[2J the ジョブ …/;
  assert.match(rich, expected, "rich");
  // The plain degrade draws its run list 24 columns wide (its own layout), so the row's progress is there and cut.
  assert.match(plain, /› \* ACTIVE jA running ·…/, "plain");
  assert.match(activeProgressText(snap().active[0].progress, name, AT), /^turn 7 · 12 steps \(1 failed\) · bash 40s · phase 2\/4 migrate \[2J the ジョブ …$/, "the text both forms draw");
  assert.doesNotMatch(rich + plain, /and then some more words/, "the phase name is clipped");
  for (const w of [30, 41, 60, 80, 99, 120, 160]) {
    for (const line of comp.render(w)) {
      assert.ok(visibleLen(line) <= w, `width ${w}: ${JSON.stringify(stripAnsi(line))}`);
      assert.doesNotMatch(stripAnsi(line), /[\u0000-\u0008\u000b-\u001f\u007f]/, `width ${w}: no control byte`);
    }
  }
  await comp.dispose();
});

// Issue #662: a #645 recovery writes its RUN's key, so the phase name is read by the run (`progressOfRun`) where the
// reader offers it; the row's integers already come off the snapshot, read by run id there.
test("the ACTIVE row of a running recovery names its phase through progressOfRun, by the run, within every width (#662)", { timeout: 20_000 }, async () => {
  const snap = () => ({ ...SNAP(), active: [{ ...SNAP().active[0], progress: { turn: 4, steps: 2, failed: 0, running: null, phase: { index: 0, count: 1, done: null, total: null }, ended: false } }] });
  const reads = [];
  const progress = async () => { throw new Error("the job-id read is not used when progressOfRun is there"); };
  const progressOfRun = async (jobId, record) => (reads.push([jobId, record]), { progress: { v: 1, phase: { index: 0, done: null, total: null }, phases: ["RECOVERY-PHASE"] }, continues: false, continuesAs: null });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100_000, deps: deps({ fetchSnapshot: async () => snap(), progress, progressOfRun }) });
  await until(() => reads.length > 0 && stripAnsi(comp.render(200).join("\n")).includes("RECOVERY-PHASE"), "the progress read");
  assert.deepEqual(reads[0], ["jA", null]);
  assert.match(stripAnsi(comp.render(200).join("\n")), /ACTIVE jA running · turn 4 · 2 steps · phase 1\/1 RECOVERY-PHASE/);
  for (const w of [30, 41, 60, 80, 120]) for (const line of comp.render(w)) assert.ok(visibleLen(line) <= w, `width ${w}: ${JSON.stringify(stripAnsi(line))}`);
  await comp.dispose();
  // The production deps carry the seam, bound to the reader.
  const gets = [];
  const d = createDashboardDeps({ valkeyUrl: "redis://unused:1" }, { redisFn: () => ({ status: "ready", on() {}, get: async (k) => (gets.push(k), null), quit: async () => {}, disconnect() {} }), makeQueueFn: () => ({ name: "pi-jobs", close: async () => {}, getJob: async () => null }) });
  // The wrapper hands the record on: its recoveryOf picks the key and its reason sets continues (review D13).
  const got = await d.progressOfRun("gh-9.r1", { jobId: "gh-9.r1", recoveryOf: "gh-9", reason: "recovery-enqueued" });
  assert.deepEqual(gets, ["run:progress:gh-9"]);
  assert.equal(got.continues, true);
  gets.length = 0;
  assert.equal((await d.progressOfRun("gh-9.r1")).continues, false);
  assert.deepEqual(gets, ["run:progress:gh-9.r1"]);
  await d.dispose();
});

test("the ACTIVE row without a progress seam, or with one that fails, keeps the integers and names no phase", { timeout: 20_000 }, async () => {
  const snap = () => ({ ...SNAP(), active: [{ ...SNAP().active[0], progress: { turn: 3, steps: 1, failed: 0, running: null, phase: { index: 0, count: 2, done: null, total: null }, ended: false } }] });
  for (const extra of [{}, { progress: async () => { throw new Error("down"); } }, { progress: async () => ({ unreachable: "x" }) }]) {
    const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100_000, deps: deps({ fetchSnapshot: async () => snap(), ...extra }) });
    await until(() => stripAnsi(comp.render(120).join("\n")).includes("ACTIVE jA"), "the snapshot");
    assert.match(stripAnsi(comp.render(120).join("\n")), /ACTIVE jA running · turn 3 · 1 step · phase 1\/2 /);
    await comp.dispose();
  }
});

// Issue #644: an infra retry keeps the job id, so the key an ACTIVE row reads can still be the ended attempt's until the
// new attempt writes; and a worker that stopped writing leaves a key whose running step would age forever.
test("the ACTIVE row ignores an ended snapshot (an earlier attempt's) and marks a stale one with no running age", { timeout: 20_000 }, async () => {
  const row = { turn: 7, steps: 12, failed: 1, running: { tool: "bash", since: AT - 600_000 }, phase: { index: 1, count: 4, done: 3, total: 10 }, ended: false, updatedAt: AT - 2_000 };
  assert.equal(activeProgressText({ ...row, ended: true }, "build", AT), "", "an ended key draws nothing on an active row");
  assert.equal(activeProgressText(row, null, AT), "turn 7 · 12 steps (1 failed) · bash 10m · phase 2/4");
  assert.equal(activeProgressText({ ...row, updatedAt: AT - 180_000 }, null, AT), "turn 7 · 12 steps (1 failed) · bash 10m · phase 2/4", "at the bound: not yet stale");
  assert.equal(activeProgressText({ ...row, updatedAt: AT - 300_000 }, null, AT), "no update for 5m, the worker may be gone · turn 7 · 12 steps (1 failed) · bash · phase 2/4");
  // Through the panel: an ended key read for the row yields no phase name, and the row keeps no progress of it.
  const snap = () => ({ ...SNAP(), active: [{ ...SNAP().active[0], progress: { ...row, ended: true } }] });
  const reads = [];
  const progress = async (jobId) => (reads.push(jobId), { v: 1, ended: true, phase: { index: 1, done: 3, total: 10 }, phases: ["survey", "OLD-ATTEMPT-PHASE"] });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100_000, deps: deps({ fetchSnapshot: async () => snap(), progress }) });
  await until(() => reads.length > 0 && stripAnsi(comp.render(200).join("\n")).includes("ACTIVE jA"), "the progress read");
  const rich = stripAnsi(comp.render(200).join("\n"));
  assert.match(rich, /ACTIVE jA running · x cancel/, "no progress between the state and the hint");
  assert.doesNotMatch(rich + comp.render(Number.NaN).join("\n"), /OLD-ATTEMPT-PHASE|turn 7/);
  await comp.dispose();
});

test("initialTail opens the overlay on that job's LIVE_TAIL, and Esc lands on its ACTIVE row, where t steers (#647 part 2)", { timeout: 20_000 }, async () => {
  const s = scripted({ start: { entries: [e("1-1", "assistant", "working on it")], next: "1-1", ended: false } });
  const snap = () => ({ ...SNAP(), triggers: { triggers: [{ index: 0, on: { type: "cron" } }] }, active: [{ jobId: "jA", queue: "pi-jobs@mini2", startedAt: AT - 60_000, host: "mini2", steer: true }] });
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, initialTail: "jA", deps: deps({ ...s, fetchSnapshot: async () => snap(), planSteer: async () => ({ refusal: "x" }), steer: async () => ({}) }) });
  await until(() => s.calls.length >= 1, "the first transcript read, with no key pressed");
  const tailOut = stripAnsi(comp.render(80).join("\n"));
  assert.match(tailOut, /live jA -- live transcript/, "opened straight on the job's tail");
  assert.match(tailOut, /working on it/);
  assert.ok(s.calls.every((c) => c.jobId === "jA"), "and read that job's stream");
  comp.handleInput("\x1b");
  const listOut = stripAnsi(comp.render(100).join("\n"));
  assert.doesNotMatch(listOut, /live jA -- live transcript/, "Esc left the tail");
  assert.match(listOut, /ACTIVE jA.*t steer/, "the cursor is on the ACTIVE row, not on the trigger above it");
  comp.handleInput("t");
  assert.match(stripAnsi(comp.render(100).join("\n")), /steer jA: /, "t opened the steer input for that job");
  await comp.dispose();
});

test("an initialTail outside the run-id charset is ignored: the overlay opens on the LIST (#647 part 2)", { timeout: 20_000 }, async () => {
  const s = scripted({});
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, initialTail: "j A\u001b", deps: deps(s) });
  await flush();
  await delay(20);
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.doesNotMatch(out, /live transcript/);
  assert.equal(s.calls.length, 0, "no tail was read");
});

test("Esc from a tail whose job is no longer the ACTIVE row: the cursor rests on NO row, a note says so, and t steers nobody (#647 part 2 review)", { timeout: 20_000 }, async () => {
  const s = scripted({ start: { entries: [e("1-1", "assistant", "done now")], next: "1-1", ended: false } });
  // jA ended between `/dispatch chat`'s lookup and the overlay: another steer-armed job is the ACTIVE row now, and the
  // snapshot lists several active jobs (only the ACTIVE row's is a list row).
  const snap = () => ({ ...SNAP(), triggers: { triggers: [] }, activeJobId: "jOther", active: [{ jobId: "jOther", queue: "pi-jobs@mini2", startedAt: AT - 60_000, host: "mini2", steer: true }, { jobId: "jThird", queue: "pi-jobs@mini3", startedAt: AT - 30_000, host: "mini3", steer: true }], runs: [{ jobId: "jR", kind: "github", target: "o/r#1", outcome: "completed", endedAt: new Date(AT - 1000).toISOString() }] });
  const planned = [];
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, initialTail: "jA", deps: deps({ ...s, fetchSnapshot: async () => snap(), planSteer: async (a) => (planned.push(a), { refusal: "x" }), steer: async () => ({}) }) });
  await until(() => s.calls.length >= 1, "the first transcript read");
  await delay(20);
  comp.handleInput("\x1b");
  const listOut = stripAnsi(comp.render(100).join("\n"));
  assert.match(listOut, /jA is no longer the active run; use the arrows to pick a row/);
  assert.doesNotMatch(listOut, /›/, "no row carries the cursor");
  comp.handleInput("t");
  assert.doesNotMatch(stripAnsi(comp.render(100).join("\n")), /steer jOther: /, "t opened no steer input for the other job");
  comp.handleInput("\x1b[B");
  assert.match(stripAnsi(comp.render(100).join("\n")), /› ● ACTIVE jOther/, "an arrow picks the first row again");
  await comp.dispose();
});

test("an initialTail of spaces is outside the run-id charset: the overlay opens on the LIST (#647 part 2 review)", { timeout: 20_000 }, async () => {
  const s = scripted({});
  const comp = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, initialTail: " ", deps: deps(s) });
  await flush();
  await delay(20);
  const out = stripAnsi(comp.render(80).join("\n"));
  await comp.dispose();
  assert.doesNotMatch(out, /┌─ live/);
  assert.equal(s.calls.length, 0, "no tail was read");
});
