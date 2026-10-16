import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { activeProgressOf, createFleetReader, parseProgress, PROGRESS_BATCH_MAX, PROGRESS_STALE_MS, progressStaleFor, readProgress, readProgressMany } from "../src/read-model.mjs";
import { stateOf } from "../src/console/live.mjs";
import { pagePanels } from "../src/console/pages.mjs";
import { makeProgress, PROGRESS_MAX_BYTES, PROGRESS_PHASES_MAX, progressKeyFor, serializeProgress } from "@edgehero/pi-dispatch/run-progress";

/**
 * The run progress readers (issue #644, INT-RUN-PROGRESS-KEY): `parseProgress`, `readProgress`, `readProgressMany` and
 * the fleet snapshot's integer projection. The key is seeded with the worker's own `serializeProgress`, or by hand for
 * the hostile shapes, so these pin the READER's reading of the contract. The live tests use database 11 of
 * VALKEY_TEST_URL (no other test file takes it), flushed before each test and after the file.
 */
const BASE = process.env.VALKEY_TEST_URL;
const URL11 = BASE
  ? (() => {
      const u = new URL(BASE);
      u.pathname = "/11";
      return u.toString();
    })()
  : null;
const live = { skip: URL11 ? false : "needs VALKEY_TEST_URL", timeout: 30_000 };
const AT = Date.UTC(2026, 9, 16, 12, 0, 0);

let client = null;
async function fresh() {
  if (!client) {
    const { Redis } = await import("ioredis");
    client = new Redis(URL11, { maxRetriesPerRequest: 1 });
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

/** A snapshot the way the worker builds one: a turn with a bash call open, a phase report closed, a note. */
function workerSnapshot() {
  let t = AT;
  const p = makeProgress({ jobId: "gh-1", phasesEnabled: true, now: () => t });
  const msg = (message) => ({ type: "message", message });
  p.consume(msg({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "report_progress", arguments: { phase: "survey", done: 1, total: 4, note: "looking around" } }] }), AT + 1);
  p.consume(msg({ role: "toolResult", toolCallId: "c1", toolName: "report_progress", isError: false, durationMs: 3 }), AT + 2);
  p.consume(msg({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: {} }] }), AT + 3);
  t = AT + 10;
  return { ...p.snapshot(), commentId: "123" };
}

test("parseProgress reads the worker's own snapshot, dropping the comment id; activeProgressOf keeps integers and the tool", () => {
  const snap = workerSnapshot();
  const got = parseProgress(serializeProgress(snap));
  const { commentId, ...rest } = snap;
  assert.equal(commentId, "123");
  assert.deepEqual(got, rest);
  assert.deepEqual(activeProgressOf(got), { turn: 2, steps: 1, failed: 0, running: { tool: "bash", since: AT + 3 }, phase: { index: 0, count: 1, done: 1, total: 4 }, ended: false, updatedAt: got.updatedAt });
  assert.ok(!JSON.stringify(activeProgressOf(got)).includes("survey") && !JSON.stringify(activeProgressOf(got)).includes("looking"), "no phase name or note in the projection");
  for (const absent of [{ absent: true }, { invalid: "x" }, { unreachable: "x" }, null, undefined]) assert.equal(activeProgressOf(absent), null);
});

test("parseProgress refuses hostile snapshots whole, and reads off-charset tool names as ?", () => {
  const good = JSON.parse(serializeProgress(workerSnapshot()));
  const variant = (patch) => JSON.stringify({ ...good, ...patch });
  const refused = {
    "an unknown field": variant({ extra: "x" }),
    "a missing field": JSON.stringify({ ...good, note: undefined }),
    "version 2": variant({ v: 2 }),
    "a string count": variant({ turn: "7" }),
    "a negative count": variant({ steps: -1 }),
    "a fractional count": variant({ failed: 1.5 }),
    "an unsafe count": variant({ turn: 2 ** 53 }),
    "an outcome outside the vocabulary": variant({ ended: true, outcome: "<b>won</b>" }),
    "a string ended": variant({ ended: "yes" }),
    "a comment id outside its charset": variant({ commentId: "1 OR 1" }),
    "too many running steps": variant({ running: Array.from({ length: 9 }, () => ({ tool: "bash", since: 1 })) }),
    "a running step with an extra key": variant({ running: [{ tool: "bash", since: 1, text: "x" }] }),
    "a recent status outside the set": variant({ recent: [{ tool: "bash", status: "pwned", durationMs: 1, at: 1 }] }),
    "too many phases": variant({ phases: Array.from({ length: PROGRESS_PHASES_MAX + 1 }, (_, i) => `p${i}`) }),
    "a phase name too long": variant({ phases: ["x".repeat(65)] }),
    "an empty phase name": variant({ phases: [""] }),
    "a phase index at the cap": variant({ phase: { index: PROGRESS_PHASES_MAX, done: null, total: null } }),
    "done past total": variant({ phase: { index: 0, done: 5, total: 4 } }),
    "a zero total": variant({ phase: { index: 0, done: 0, total: 0 } }),
    "a note too long": variant({ note: "n".repeat(201) }),
    "a prior with an extra key": variant({ prior: { turns: 1, steps: 1, x: 1 } }),
    "an array": "[]",
    "not JSON": "{",
    "oversize": JSON.stringify({ ...good, pad: "x".repeat(PROGRESS_MAX_BYTES) }),
  };
  for (const [what, raw] of Object.entries(refused)) {
    const got = parseProgress(raw);
    assert.equal(typeof got.invalid, "string", what);
    assert.ok(!got.invalid.includes("pwned") && !got.invalid.includes("<b>"), `${what}: the reason never quotes the value`);
  }
  // Off-charset tool names (the worker writes `?` itself; this is the belt) read as `?`, the snapshot kept.
  const tools = parseProgress(variant({ running: [{ tool: "rm -rf /", since: 1 }], recent: [{ tool: "<script>", status: "ok", durationMs: null, at: 1 }] }));
  assert.equal(tools.running[0].tool, "?");
  assert.equal(tools.recent[0].tool, "?");
  // A phase index past the (size-cut) list but under the cap is kept; the count covers it and no name is invented.
  const cut = parseProgress(variant({ phase: { index: 5, done: null, total: null }, phases: ["a", "b"] }));
  assert.equal(cut.phase.index, 5);
  assert.deepEqual(activeProgressOf(cut).phase, { index: 5, count: 6, done: null, total: null });
});

test("readProgress: a snapshot, absent, invalid (a bad key or a run id outside the charset, before any read)", live, async () => {
  const redis = await fresh();
  const snap = workerSnapshot();
  await redis.set(progressKeyFor("gh-1"), serializeProgress(snap));
  await redis.set(progressKeyFor("gh-2"), JSON.stringify({ v: 1, phases: ["x"] }));
  assert.equal((await readProgress(redis, "gh-1")).turn, 2);
  assert.deepEqual(await readProgress(redis, "gh-none"), { absent: true });
  assert.equal(typeof (await readProgress(redis, "gh-2")).invalid, "string");
  let reads = 0;
  const spy = { get: async () => (reads++, null) };
  assert.equal(typeof (await readProgress(spy, "bad id with spaces")).invalid, "string");
  assert.equal(reads, 0, "the id is refused before a key is built");
});

test("readProgressMany: ONE MGET for at most PROGRESS_BATCH_MAX distinct ids, ids outside the charset left out", live, async () => {
  const redis = await fresh();
  await redis.set(progressKeyFor("gh-0"), serializeProgress(workerSnapshot()));
  await redis.set(progressKeyFor("gh-1"), "not json");
  const calls = [];
  const counted = new Proxy(redis, { get: (t, k) => (k === "mget" ? (...keys) => (calls.push(keys), t.mget(...keys)) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  const ids = [...Array.from({ length: 60 }, (_, i) => `gh-${i}`), "gh-0", "has space", null];
  const got = await readProgressMany(counted, ids);
  assert.equal(calls.length, 1, "one round trip");
  assert.equal(calls[0].length, PROGRESS_BATCH_MAX);
  assert.equal(Object.keys(got.byId).length, PROGRESS_BATCH_MAX);
  assert.equal(got.byId["gh-0"].turn, 2);
  assert.equal(typeof got.byId["gh-1"].invalid, "string");
  assert.deepEqual(got.byId["gh-2"], { absent: true });
  assert.equal(got.byId["gh-55"], undefined, "past the cap: not known, and not read");
  assert.deepEqual(await readProgressMany(counted, []), { byId: {} });
  assert.equal(calls.length, 1, "nothing to read, no read");
});

test("progressStaleFor: a running snapshot unwritten past the heartbeat's three minutes is stale; an ended one, or one with no time, never is", () => {
  const p = { ended: false, updatedAt: AT };
  assert.equal(PROGRESS_STALE_MS, 180_000);
  assert.equal(progressStaleFor(p, AT + PROGRESS_STALE_MS), null, "exactly at the bound: not yet");
  assert.equal(progressStaleFor(p, AT + PROGRESS_STALE_MS + 1), PROGRESS_STALE_MS + 1);
  assert.equal(progressStaleFor({ ...p, ended: true }, AT + 3_600_000), null, "an ended run writes no more");
  assert.equal(progressStaleFor({ ended: false }, AT + 3_600_000), null, "no updatedAt: not judged");
  assert.equal(progressStaleFor(p, Number.NaN), null, "no clock: not judged");
  assert.equal(progressStaleFor(null, AT), null);
  const proj = activeProgressOf(parseProgress(serializeProgress(workerSnapshot())));
  assert.equal(progressStaleFor(proj, proj.updatedAt + 4 * 60_000), 4 * 60_000, "the projection carries what it needs");
});

test("unreachable: an error's code survives, its text (a host and port) never does; a hung read is bounded", async () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:6379"), { code: "ECONNREFUSED" });
  const down = { get: async () => { throw err; }, mget: async () => { throw err; } };
  for (const got of [await readProgress(down, "gh-1"), await readProgressMany(down, ["gh-1"])]) {
    assert.equal(got.unreachable, "the progress key could not be read (ECONNREFUSED)");
  }
  const hung = { get: () => new Promise(() => {}), mget: () => new Promise(() => {}) };
  // The bound's timer is unref'd on purpose (a CLI read must never hold the process open), and a promise that never
  // settles holds nothing either, so with no Valkey client open this file's loop would empty and node:test would cancel
  // the test as still pending. A ref'd timer here keeps the loop up until the bound has fired.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.match((await readProgress(hung, "gh-1", { timeoutMs: 20 })).unreachable, /timed out/);
    assert.match((await readProgressMany(hung, ["gh-1"], { timeoutMs: 20 })).unreachable, /timed out/);
  } finally {
    clearInterval(keepAlive);
  }
  assert.deepEqual(await readProgress(null, "gh-1"), { unreachable: "no Valkey client" });
});

test("the fleet snapshot's active rows carry integers and a tool name only, a remote host's job too; /api/state and the hub panels hold no phase or note", live, async () => {
  const redis = await fresh();
  const logsDir = tempDir("pd-644-fleet-");
  const hostile = { ...workerSnapshot(), phases: ["PHASE-NAME-TEXT <b>x</b>"], phase: { index: 0, done: 2, total: 9 }, note: "NOTE-TEXT" };
  await redis.set(progressKeyFor("gh-remote"), serializeProgress(hostile));
  await redis.set(progressKeyFor("gh-bad"), JSON.stringify({ v: 1, note: "NOTE-TEXT" }));
  const lists = { "pi-jobs": [{ id: "gh-local", processedOn: AT - 60_000 }, { id: "gh-bad", processedOn: AT - 30_000 }], "pi-jobs@hostb": [{ id: "gh-remote", processedOn: AT - 120_000 }] };
  const mk = (_c, opts) => {
    const name = opts?.name ?? "pi-jobs";
    return { name, isPaused: async () => false, getJobCounts: async () => ({ waiting: 0, active: 1, paused: 0, delayed: 0, failed: 0 }), getWorkers: async () => [], getJobSchedulers: async () => [], getActive: async () => lists[name] ?? [], getFailed: async () => [], close: async () => {} };
  };
  const hosts = [{ name: "hostb", routes: true, jobs: JSON.stringify([{ id: "gh-remote", p: null, at: AT - 120_000 }]) }];
  const reader = createFleetReader(
    { valkeyUrl: URL11, logsDir, triggersPath: join(logsDir, "none.json") },
    { makeQueueFn: mk, parseConnectionFn: () => ({}), redisFn: () => redis.duplicate(), readLiveHostsFn: async () => ({ hosts }), discoverHostQueuesFn: async () => ["pi-jobs@hostb"], nowFn: () => AT, activeLimit: 10 },
  );
  try {
    const snap = await reader.snapshot();
    const byId = Object.fromEntries(snap.active.map((a) => [a.jobId, a]));
    assert.equal(byId["gh-remote"].host, "hostb");
    assert.deepEqual(byId["gh-remote"].progress, { turn: 2, steps: 1, failed: 0, running: { tool: "bash", since: AT + 3 }, phase: { index: 0, count: 1, done: 2, total: 9 }, ended: false, updatedAt: hostile.updatedAt });
    assert.equal(byId["gh-local"].progress, null, "no key");
    assert.equal(byId["gh-bad"].progress, null, "an invalid key draws nothing");
    const leaks = (text, where) => assert.ok(!text.includes("PHASE-NAME-TEXT") && !text.includes("NOTE-TEXT"), `${where} holds no phase name or note`);
    leaks(JSON.stringify(snap), "the snapshot");
    for (const role of ["operator", "viewer"]) {
      const state = stateOf(snap, role, { now: AT });
      leaks(JSON.stringify(state), `/api/state for ${role}`);
      assert.deepEqual(state.active.find((a) => a.jobId === "gh-remote").progress.phase, { index: 0, count: 1, done: 2, total: 9 });
      for (const page of ["overview", "fleet"]) {
        const panels = await pagePanels(page, { query: {}, session: { name: "x", role }, data: { page, now: AT, env: {}, snapshot: snap }, readOnly: false });
        const text = panels.map((p) => p.html).join("");
        leaks(text, `the ${page} panels for ${role}`);
        assert.match(text, /turn 2, 1 step, bash running, phase 1\/1/, `the ${page} panels show the integers (a since after now shows no age)`);
      }
    }
    // The single read (the run page's and the TUI's) carries the whole snapshot, names included: an operator surface's.
    assert.deepEqual((await reader.progress("gh-remote")).phases, ["PHASE-NAME-TEXT <b>x</b>"]);
    assert.deepEqual(Object.keys((await reader.progressFor(["gh-remote", "gh-local"])).byId), ["gh-remote", "gh-local"]);
  } finally {
    await reader.dispose();
  }
});
