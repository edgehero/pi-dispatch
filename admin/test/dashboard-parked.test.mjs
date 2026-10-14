import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripAnsi, visibleLen } from "../src/style.mjs";
import { loadVisibleWidth } from "./helpers/renderer.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * The PARKED view (issue #641): the `/dispatch` overlay's parked inbox, fed by the fleet reader's `parked` field
 * (`[{target, kind, jobId, parkedAt, ageMs, answered, chainCount}]`, unanswered only). Offline against a canned
 * snapshot, the dashboard.test.mjs harness: `makeDashboard` loaded through pi's own jiti.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard, createDashboardDeps } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const flush = () => new Promise((resolve) => setImmediate(resolve));
const fakeTui = () => ({ requestRender() {} });
const AT = Date.UTC(2026, 6, 21, 12, 0, 0);
const ESC = "\x1b";
const DOWN = "\x1b[B";

const RUN = {
  jobId: "gh-run-1",
  target: "acme/web#7",
  kind: "github",
  flow: "fix",
  outcome: "completed",
  reason: "awaiting-input",
  turns: 4,
  tokens: { input: 4000, output: 1000, total: 5000, cost: 0.0523 },
  endedAt: "2026-07-21T10:00:00.000Z",
};

const SNAPSHOT = {
  queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 1, week: 0, month: 0 },
  settings: { path: "/s", overlay: { model: "claude-x", dailyCap: 25 } },
  runs: [RUN],
  schedulers: [],
};

const PARKED = [
  { target: "acme/web#7", kind: "github", jobId: "gh-run-1", parkedAt: AT - 7_200_000, ageMs: 7_200_000, answered: false, chainCount: 2 },
  { target: "acme/api#9", kind: "gitlab", jobId: "gl-old-9", parkedAt: AT - 3 * 86_400_000, ageMs: 3 * 86_400_000, answered: false, chainCount: null },
  { target: "acme/ops#3", kind: "forgejo", jobId: "fj-3", parkedAt: AT - 60_000, ageMs: 60_000, answered: false, chainCount: 0 },
  { target: "acme/ops#4", kind: "forgejo", jobId: "fj-4", parkedAt: AT - 30_000, ageMs: 30_000, answered: false, chainCount: 1 },
];

function dash(snap, extra = {}) {
  return makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 100000,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT, ...extra },
  });
}

const text = (comp, w = 80) => stripAnsi(comp.render(w).join("\n"));

test("the LIST's parked badge appears only when a run waits, counts every one, and names k", async () => {
  const none = dash(SNAPSHOT);
  const empty = dash({ ...SNAPSHOT, parked: [] });
  const some = dash({ ...SNAPSHOT, parked: PARKED });
  await flush();
  const scrub = (lines) => lines.map((l) => l.replace(/\d\d:\d\d:\d\d/, "HH:MM:SS"));
  assert.deepEqual(scrub(empty.render(80)), scrub(none.render(80)), "an empty parked list renders exactly nothing");
  assert.doesNotMatch(text(none), /parked/i);

  const out = text(some);
  assert.match(out, /PARKED/, "the section divider");
  assert.match(out, /4 waiting for an answer · k view/, "the count badge names the key");
  assert.match(out, /acme\/web#7 · github · waiting 2h0m · chain 2/);
  assert.match(out, /acme\/api#9 · gitlab · waiting 3d0h · chain \?/, "an unknown chain count is ?, never 0");
  assert.doesNotMatch(out, /acme\/ops#4/, "the fourth row is past the section's bound");
  assert.match(out, /↓ 1 more/);
  for (const c of [none, empty, some]) await c.dispose();
});

test("k opens PARKED with every row, its hint and keys; Esc returns to the LIST", async () => {
  const comp = dash({ ...SNAPSHOT, parked: PARKED });
  await flush();
  comp.handleInput("k");
  const view = text(comp);
  assert.match(view, /parked · 4 waiting for an answer/, "the title counts the inbox");
  assert.match(view, /asked a question on its issue/, "the hint says what the run waits for");
  assert.match(view, /› acme\/web#7 · github · waiting 2h0m · chain 2 · gh-run-1/, "the cursor row with its job id");
  assert.match(view, /acme\/ops#4 · forgejo · waiting 30s · chain 1 · fj-4/, "past the section's 3-row bound");
  assert.match(view, /↑↓ select {2}· {2}↵ open run {2}· {2}esc back/);
  assert.doesNotMatch(view, /SPEND & LIMITS/);
  comp.handleInput(ESC);
  assert.match(text(comp), /SPEND & LIMITS/, "Esc backs out to the LIST");
  await comp.dispose();
});

test("PARKED's empty and unreachable states", async () => {
  const empty = dash({ ...SNAPSHOT, parked: [] });
  await flush();
  empty.handleInput("k");
  const e = text(empty);
  assert.match(e, /parked · 0 waiting for an answer/);
  assert.match(e, /\(nothing parked\)/);
  await empty.dispose();

  const down = dash({ unreachable: "connect ECONNREFUSED" });
  await flush();
  down.handleInput("k");
  const d = text(down);
  assert.match(d, /unreachable \(connect ECONNREFUSED\)/);
  assert.doesNotMatch(d, /nothing parked/, "an unreadable fleet is not an empty inbox");
  await down.dispose();

  // The fleet answered but the parked fold did not: still not an empty inbox.
  const unknown = dash({ ...SNAPSHOT, parked: [], parkedUnreachable: "the runs could not be read" });
  await flush();
  unknown.handleInput("k");
  const u = text(unknown);
  assert.match(u, /parked runs unknown \(the runs could not be read\)/);
  assert.doesNotMatch(u, /nothing parked/);
  await unknown.dispose();
});

test("Enter on a run in the snapshot opens RUN_DETAIL, and Esc returns to PARKED", async () => {
  const comp = dash({ ...SNAPSHOT, parked: PARKED }, { runById: async () => { throw new Error("not called"); } });
  await flush();
  comp.handleInput("k");
  comp.handleInput("\r");
  const detail = text(comp);
  assert.match(detail, /run gh-run-1/, "the run's own drill-in");
  assert.match(detail, /awaiting-input/);
  comp.handleInput(ESC);
  assert.match(text(comp), /parked · 4 waiting/, "back to the inbox, not the LIST");
  comp.handleInput(ESC);
  assert.match(text(comp), /SPEND & LIMITS/);
  await comp.dispose();
});

test("Enter on a run older than the runs list reads it by id; a missing or unreadable run says so", async () => {
  const asked = [];
  const old = { ...RUN, jobId: "gl-old-9", target: "acme/api#9", kind: "gitlab" };
  const comp = dash({ ...SNAPSHOT, parked: PARKED }, { runById: async (id) => (asked.push(id), id === "gl-old-9" ? { record: old, source: "mirror" } : { missing: true }) });
  await flush();
  comp.handleInput("k");
  comp.handleInput(DOWN);
  comp.handleInput("\r");
  await flush();
  assert.deepEqual(asked, ["gl-old-9"]);
  assert.match(text(comp), /run gl-old-9/, "the mirror's record opens in RUN_DETAIL");
  comp.handleInput(ESC);
  comp.handleInput(DOWN);
  comp.handleInput("\r");
  await flush();
  const miss = text(comp);
  assert.match(miss, /parked · 4 waiting/, "still the inbox");
  assert.match(miss, /no record of this run on this host or in the mirror/);
  await comp.dispose();

  const failing = dash({ ...SNAPSHOT, parked: PARKED }, { runById: async () => { throw new Error("timed out"); } });
  await flush();
  failing.handleInput("k");
  failing.handleInput(DOWN);
  failing.handleInput("\r");
  await flush();
  assert.match(text(failing), /the run could not be read \(timed out\)/);
  await failing.dispose();

  const unwired = dash({ ...SNAPSHOT, parked: PARKED });
  await flush();
  unwired.handleInput("k");
  unwired.handleInput(DOWN);
  unwired.handleInput("\r");
  assert.match(text(unwired), /older than the runs list/, "without the seam the row is all there is, and the view says so");
  await unwired.dispose();
});

test("a by-id answer that lands after Esc is never drawn (the view check alone: Esc numbers no new read)", async () => {
  let release;
  const comp = dash({ ...SNAPSHOT, parked: PARKED }, { runById: () => new Promise((r) => { release = r; }) });
  await flush();
  comp.handleInput("k");
  comp.handleInput(DOWN);
  comp.handleInput("\r");
  assert.match(text(comp), /reading the run/);
  comp.handleInput(ESC);
  release({ record: { ...RUN, jobId: "gl-old-9" } });
  await flush();
  assert.match(text(comp), /SPEND & LIMITS/, "the LIST stays; the late record does not open a detail");
  await comp.dispose();
});

test("a by-id answer that lands after a cursor move is never drawn (the seq check alone: the view is still PARKED)", async () => {
  let release;
  const comp = dash({ ...SNAPSHOT, parked: PARKED }, { runById: () => new Promise((r) => { release = r; }) });
  await flush();
  comp.handleInput("k");
  comp.handleInput(DOWN);
  comp.handleInput("\r");
  assert.match(text(comp), /reading the run/);
  comp.handleInput(DOWN);
  release({ record: { ...RUN, jobId: "gl-old-9" } });
  await flush();
  const after = text(comp);
  assert.match(after, /parked · 4 waiting/, "still the inbox");
  assert.match(after, /› acme\/ops#3 /, "the cursor stays where it moved");
  assert.doesNotMatch(after, /run gl-old-9/, "the late record opens nothing");
  // and up: a read for acme/ops#3 abandoned by a move back
  comp.handleInput("\r");
  assert.match(text(comp), /reading the run/);
  comp.handleInput("\x1b[A");
  release({ record: { ...RUN, jobId: "fj-3" } });
  await flush();
  assert.match(text(comp), /› acme\/api#9 /);
  assert.doesNotMatch(text(comp), /run fj-3/);
  await comp.dispose();
});

test("a by-id answer that lands after Esc then k reopening PARKED is never drawn (the seq check, with the view PARKED again)", async () => {
  let release;
  const comp = dash({ ...SNAPSHOT, parked: PARKED }, { runById: () => new Promise((r) => { release = r; }) });
  await flush();
  comp.handleInput("k");
  comp.handleInput(DOWN);
  comp.handleInput("\r");
  comp.handleInput(ESC);
  comp.handleInput("k");
  release({ record: { ...RUN, jobId: "gl-old-9" } });
  await flush();
  assert.match(text(comp), /parked · 4 waiting/);
  assert.doesNotMatch(text(comp), /run gl-old-9/);
  await comp.dispose();
});

test("the cursor clamps when the parked list shrinks between snapshots: drawn on the last row, and Enter opens that row", async () => {
  let snap = { ...SNAPSHOT, parked: PARKED };
  const comp = makeDashboard({
    paths: {},
    done() {},
    tui: fakeTui(),
    intervalMs: 10,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT, runById: async () => ({ missing: true }) },
  });
  await flush();
  comp.handleInput("k");
  for (let i = 0; i < 3; i++) comp.handleInput(DOWN);
  assert.match(text(comp), /› acme\/ops#4 /);
  snap = { ...SNAPSHOT, parked: PARKED.slice(0, 1) };
  for (let i = 0; i < 200 && !/parked · 1 waiting/.test(text(comp)); i++) await new Promise((r) => setTimeout(r, 5));
  const shrunk = text(comp);
  assert.match(shrunk, /parked · 1 waiting/);
  assert.match(shrunk, /› acme\/web#7 /, "the cursor is drawn on the one row left");
  comp.handleInput("\r");
  assert.match(text(comp), /run gh-run-1/, "Enter opens the row the cursor is drawn on, not a row that is gone");
  await comp.dispose();
});

test("K opens PARKED as k does (the view keys take either case, as u/U and the others do)", async () => {
  const comp = dash({ ...SNAPSHOT, parked: PARKED });
  await flush();
  comp.handleInput("K");
  assert.match(text(comp), /parked · 4 waiting for an answer/);
  assert.match(text(comp), /› acme\/web#7 /);
  await comp.dispose();
});

test("a hostile target and job id cannot carry a control byte out or push a line past the frame", async () => {
  const nasty = (base) => `${base}\r\x1b[2J\x1b]8;;http://evil\x07\x9b会社`;
  const parked = [
    { target: nasty("acme/web#7"), kind: nasty("github"), jobId: nasty("gh-1"), ageMs: 1000, chainCount: 1 },
    { target: "a/b#1", kind: "github", jobId: nasty("gh-clean"), ageMs: 1000, chainCount: null },
  ];
  const theme = { fg: (_c, t) => `\x1b[38;5;42m${t}\x1b[39m`, bold: (t) => `\x1b[1m${t}\x1b[22m`, bg: (_c, t) => t };
  const visibleWidth = await loadVisibleWidth();
  assert.equal(typeof visibleWidth, "function");
  const list = makeDashboard({ paths: {}, done() {}, tui: fakeTui(), intervalMs: 100000, theme, deps: { fetchSnapshot: async () => ({ ...SNAPSHOT, parked }), pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => AT } });
  await flush();
  const listLines = list.render(80);
  const listTiny = list.render(6);
  const listNaN = list.render(NaN).join("\n");
  list.handleInput("k");
  const viewLines = list.render(80);
  const narrow = list.render(30);
  const tiny = list.render(6);
  await list.dispose();

  assert.match(stripAnsi(viewLines.join("\n")), /gh-clean/, "the clean row's job id cell is on screen");
  for (const [what, lines] of [["LIST", listLines], ["LIST unframed", listTiny], ["LIST unclipped degrade", [listNaN]], ["PARKED", viewLines], ["PARKED at 30", narrow], ["PARKED unframed", tiny]]) {
    const sgrOnly = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.doesNotMatch(sgrOnly, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, `no control byte reaches ${what}`);
  }
  for (const l of listLines) assert.equal(visibleWidth(l), 80, "LIST lines are exactly the frame");
  for (const l of viewLines) assert.ok(visibleWidth(l) <= 80, "PARKED lines fit");
  for (const l of narrow) {
    assert.equal(visibleLen(l), 30, `width 30: ${JSON.stringify(stripAnsi(l))}`);
    assert.equal(visibleWidth(l), 30, "and pi agrees");
  }
  assert.match(listNaN, /PARKED · 2 · k view/, "the degraded LIST names the parked runs too");
  for (const l of [...tiny, ...listTiny]) assert.ok(visibleWidth(l) <= 6, `the unframed degrade honours its width: ${JSON.stringify(l)}`);
});

test("the PARKED cursor scrolls a long inbox in a bounded viewport", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ target: `o/r#${i}`, kind: "github", jobId: `gh-${i}`, ageMs: i * 1000, chainCount: i }));
  const comp = dash({ ...SNAPSHOT, parked: many });
  await flush();
  comp.handleInput("k");
  const first = text(comp);
  assert.match(first, /↓ 28 more/);
  assert.doesNotMatch(first, /o\/r#12 /);
  for (let i = 0; i < 39; i++) comp.handleInput(DOWN);
  const last = text(comp);
  assert.match(last, /› o\/r#39 /, "the cursor reaches the last row");
  assert.match(last, /↑ 28 more/);
  const lines = comp.render(80);
  assert.ok(lines.length < 30, "the frame does not grow with the inbox");
  await comp.dispose();
});

test("the real deps carry the reader's runById: a local record by id, and a refused id before any read", async () => {
  const logsDir = tempDir("parked-runbyid-");
  writeFileSync(join(logsDir, "gl-old-9.json"), JSON.stringify({ ...RUN, jobId: "gl-old-9" }));
  const queue = { name: "pi-jobs", async close() {} };
  const redis = { async get() { return null; }, on() {}, disconnect() {} };
  const deps = createDashboardDeps({ valkeyUrl: "redis://x", logsDir }, { makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis });
  try {
    const found = await deps.runById("gl-old-9");
    assert.equal(found.source, "local");
    assert.equal(found.record.jobId, "gl-old-9");
    assert.ok((await deps.runById("no such\nid")).invalid, "an id outside the charset is refused");
  } finally {
    await deps.dispose();
  }
});
