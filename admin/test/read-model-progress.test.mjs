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
  // Issue #662: a #645 recovery job writes its progress under its RUN's id, so its row reads that key.
  await redis.set(progressKeyFor("gh-run"), serializeProgress({ ...workerSnapshot(), turn: 6 }));
  const lists = { "pi-jobs": [{ id: "gh-local", processedOn: AT - 60_000 }, { id: "gh-bad", processedOn: AT - 30_000 }, { id: "gh-run.r1", processedOn: AT - 10_000, data: { recoveryOf: "gh-run", title: "PII-TITLE" } }], "pi-jobs@hostb": [{ id: "gh-remote", processedOn: AT - 120_000 }] };
  const mk = (_c, opts) => {
    const name = opts?.name ?? "pi-jobs";
    return { name, isPaused: async () => false, getJobCounts: async () => ({ waiting: 0, active: 1, paused: 0, delayed: 0, failed: 0 }), getWorkers: async () => [], getJobSchedulers: async () => [], getActive: async () => lists[name] ?? [], getFailed: async () => [], close: async () => {} };
  };
  const hosts = [{ name: "hostb", routes: true, version: "4.3.1", tz: "UTC", fpUsd: "a".repeat(16), heldMemMiB: "2048", jobs: JSON.stringify([{ id: "gh-remote", p: "web", m: 4096, c: 200, at: AT - 120_000 }]), sandboxes: JSON.stringify([{ id: "gh-kept", v: "podman", until: AT + 3600000, pin: false }]), sandboxRetentionHours: "24", sandboxesMore: "2", cpuReserve: JSON.stringify([{ venue: "podman", status: "held", wantCenti: 200, quotaCenti: 200 }]) }];
  const reader = createFleetReader(
    { valkeyUrl: URL11, logsDir, triggersPath: join(logsDir, "none.json") },
    { makeQueueFn: mk, parseConnectionFn: () => ({}), redisFn: () => redis.duplicate(), readLiveHostsFn: async () => ({ hosts }), discoverHostQueuesFn: async () => ["pi-jobs@hostb"], nowFn: () => AT, activeLimit: 10 },
  );
  try {
    const snap = await reader.snapshot();
    const byId = Object.fromEntries(snap.active.map((a) => [a.jobId, a]));
    assert.equal(byId["gh-remote"].host, "hostb");
    assert.equal(byId["gh-remote"].project, "web");
    assert.deepEqual(byId["gh-remote"].size, { memMiB: 4096, cpuCenti: 200 });
    assert.equal(snap.hostBudgets[0].version, "4.3.1");
    assert.equal(snap.hostBudgets[0].heldMemMiB, "2048");
    assert.equal(snap.hostBudgets[0].sandboxRetentionHours, 24);
    assert.equal(snap.hostBudgets[0].sandboxesMore, 2);
    assert.deepEqual(snap.hostBudgets[0].sandboxes, [{ id: "gh-kept", v: "podman", until: AT + 3600000, pin: false }]);
    assert.deepEqual(snap.hostBudgets[0].cpuReserve, [{ venue: "podman", status: "held", wantCenti: 200, quotaCenti: 200 }]);
    assert.deepEqual(byId["gh-remote"].progress, { turn: 2, steps: 1, failed: 0, running: { tool: "bash", since: AT + 3 }, phase: { index: 0, count: 1, done: 2, total: 9 }, ended: false, updatedAt: hostile.updatedAt });
    assert.equal(byId["gh-local"].progress, null, "no key");
    assert.equal(byId["gh-bad"].progress, null, "an invalid key draws nothing");
    assert.equal(byId["gh-run.r1"].progress?.turn, 6, "a recovery's row reads its run's key (#662)");
    assert.ok(!JSON.stringify(snap).includes("PII-TITLE") && !JSON.stringify(snap.active).includes("\"gh-run\""), "the run id and the job's data never enter the snapshot");
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
        // Since issue #737 the active table with its progress is Fleet's alone: the overview counts the running jobs in
        // each host's slots.
        if (page === "fleet") assert.match(text, /turn 2, 1 step, bash running, phase 1\/1/, `the ${page} panels show the integers (a since after now shows no age)`);
      }
    }
    // The single read (the run page's and the TUI's) carries the whole snapshot, names included: an operator surface's.
    assert.deepEqual((await reader.progress("gh-remote")).phases, ["PHASE-NAME-TEXT <b>x</b>"]);
    assert.deepEqual(Object.keys((await reader.progressFor(["gh-remote", "gh-local"])).byId), ["gh-remote", "gh-local"]);
  } finally {
    await reader.dispose();
  }
});

test("parseProgress reads a recovered run's replayed count, optional and a whole number (#645)", () => {
  const good = JSON.parse(serializeProgress(workerSnapshot()));
  assert.equal(parseProgress(JSON.stringify({ ...good, replayed: 2 })).replayed, 2);
  assert.equal("replayed" in parseProgress(JSON.stringify(good)), false, "absent stays absent");
  for (const bad of [-1, 1.5, "2", null]) assert.ok(parseProgress(JSON.stringify({ ...good, replayed: bad })).invalid, JSON.stringify(bad));
});

// ---- durable-run record fields (issue #645) --------------------------------------------------------------------------

test("recordRecovery rebuilds a record's recovery fields by the worker's rules and drops every hostile value (issue #645)", async () => {
  const { recordRecovery, recoveredText, recoveryCountsText, checkpointsText } = await import("../src/read-model.mjs");
  const recovered = { from: "live", n: 1, fromAttempt: 2, checkpointSeq: 4, orphans: 3, replayed: 2, interrupted: 1, notStarted: 0 };
  const full = recordRecovery({ jobId: "gh-9.r1", recoveryOf: "gh-9", recovered, recoverSkipped: "base-unprimed", checkpoints: { written: 5, failed: 0, skipped: 1 } });
  assert.deepEqual(full, { recoveryOf: "gh-9", recovered, recoverSkipped: "base-unprimed", checkpoints: { written: 5, failed: 0, skipped: 1 } });
  assert.equal(recoveredText(full.recovered), "recovered from a live checkpoint (recovery 1, attempt 2, checkpoint 4): 3 orphaned calls, 2 replayed, 1 interrupted");
  assert.equal(checkpointsText(full.checkpoints), "5 written, 0 failed, 1 skipped");
  assert.equal(recoveryCountsText({ orphans: 1, replayed: 0, interrupted: null, notStarted: 2 }), "1 orphaned call, 2 not started");
  // A record with none of the keys (a job that never armed run.recover) has no recovery at all, and neither does a non-record.
  for (const r of [{ jobId: "gh-1" }, null, "gh-1", [], 7]) assert.equal(recordRecovery(r), null, JSON.stringify(r));
  // Hostile values, each dropped on its own, never copied.
  const one = (extra) => recordRecovery({ jobId: "gh-1", ...extra });
  for (const id of ["gh-1<script>", "-gh-1", ".gh", "a b", "x".repeat(201), "", 7, null, { id: "gh-1" }, "gh-1\u001b[31m"]) assert.equal(one({ recoveryOf: id }), null, `recoveryOf ${JSON.stringify(id)}`);
  for (const from of ["elsewhere", "LIVE", "", null, 1]) assert.equal(one({ recovered: { ...recovered, from } }), null, `from ${JSON.stringify(from)}`);
  for (const n of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) assert.equal(one({ recovered: { ...recovered, n } }), null, `n ${JSON.stringify(n)}`);
  for (const skip of ["because", "LOCAL", "", null, 3]) assert.equal(one({ recoverSkipped: skip }), null, `recoverSkipped ${JSON.stringify(skip)}`);
  for (const c of [{ written: 1.5, failed: 0, skipped: 0 }, { written: 1, failed: -1, skipped: 0 }, { written: 1, failed: 0 }, { written: "1", failed: 0, skipped: 0 }, [1, 0, 0], "5"]) assert.equal(one({ checkpoints: c }), null, `checkpoints ${JSON.stringify(c)}`);
  // A count that is not one is null on its own, an extra key is not carried, and the rest stands.
  const partial = one({ recovered: { ...recovered, fromAttempt: "2", checkpointSeq: -4, orphans: 1.5, note: "FREE TEXT", interrupted: Infinity } });
  assert.deepEqual(partial.recovered, { from: "live", n: 1, fromAttempt: null, checkpointSeq: null, orphans: null, replayed: 2, interrupted: null, notStarted: 0 });
  assert.equal(recoveredText(partial.recovered), "recovered from a live checkpoint (recovery 1): 2 replayed");
  assert.deepEqual(one({ checkpoints: { written: 1, failed: 0, skipped: 0, extra: "x" } }).checkpoints, { written: 1, failed: 0, skipped: 0 });
});

// ---- the run page's progress pairing (issue #662) -------------------------------------------------------------------

test("readRunProgress reads the key by the RUN id and says when the attempt's run continues as a recovery (#662)", async () => {
  const { readRunProgress, laterJobOfRun } = await import("../src/read-model.mjs");
  const snap = serializeProgress(workerSnapshot());
  const gets = [];
  const redis = { get: async (k) => (gets.push(k), k === progressKeyFor("gh-9") ? snap : null) };
  const jobs = { "gh-9": { id: "gh-9", data: {} }, "gh-9.r1": { id: "gh-9.r1", data: { recoveryOf: "gh-9" } }, "gh-9.r2": { id: "gh-9.r2", data: { recoveryOf: "gh-9" } } };
  const queues = [{ name: "pi-jobs", getJob: async (id) => jobs[id] ?? null }];

  // A plain job, or a retried one (same job id), reads its own key: today's pairing.
  const plain = await readRunProgress({ redis, queues, jobId: "gh-9", record: { jobId: "gh-9", outcome: "failed" } });
  assert.equal(plain.progress.v, 1);
  assert.deepEqual([plain.continues, plain.continuesAs], [false, null]);
  // A running recovery (no record yet) reads its RUN's key off the queue job's data.
  gets.length = 0;
  const running = await readRunProgress({ redis, queues, jobId: "gh-9.r1", record: null });
  assert.deepEqual(gets, [progressKeyFor("gh-9")]);
  assert.equal(running.progress.v, 1);
  // A recovery with a record names its run by the record's recoveryOf, even once the queue has dropped the job.
  gets.length = 0;
  await readRunProgress({ redis, queues: [], jobId: "gh-9.r1", record: { jobId: "gh-9.r1", recoveryOf: "gh-9", outcome: "completed" } });
  assert.deepEqual(gets, [progressKeyFor("gh-9")]);
  // The base attempt handed to a recovery: continues, and names the NEWEST recovery after it, in any state.
  const base = await readRunProgress({ redis, queues, jobId: "gh-9", record: { jobId: "gh-9", outcome: "failed", reason: "recovery-enqueued" } });
  assert.deepEqual([base.continues, base.continuesAs], [true, "gh-9.r2"]);
  // A first recovery handed to a second names the second; a queue that no longer holds it gives no id but still continues.
  assert.equal((await readRunProgress({ redis, queues, jobId: "gh-9.r1", record: { jobId: "gh-9.r1", recoveryOf: "gh-9", reason: "recovery-enqueued" } })).continuesAs, "gh-9.r2");
  const gone = await readRunProgress({ redis, queues: [], jobId: "gh-9", record: { jobId: "gh-9", reason: "recovery-enqueued" } });
  assert.deepEqual([gone.continues, gone.continuesAs], [true, null]);
  // laterJobOfRun never names the job itself or an earlier one, and refuses a job that is not the run's.
  const getJob = async (id) => (jobs[id] ? { job: jobs[id], queue: "pi-jobs" } : null);
  assert.equal(await laterJobOfRun(getJob, "gh-9", "gh-9.r2"), null);
  assert.equal(await laterJobOfRun(getJob, "gh-9", "gh-7"), null);
  // A hostile page id is invalid before any read; a queue that throws is no job, never a throw.
  assert.ok((await readRunProgress({ redis, queues, jobId: "gh 9<x>" })).progress.invalid);
  const throwing = [{ name: "q", getJob: async () => { throw new Error("down"); } }];
  assert.equal((await readRunProgress({ redis, queues: throwing, jobId: "gh-9", record: null })).progress.v, 1);
});

test("recoveryCountsText labels counts taken from the transcript (#662)", async () => {
  const { recoveryCountsText, recordRecovery } = await import("../src/read-model.mjs");
  const rec = recordRecovery({ jobId: "gh-9.r1", recoveryOf: "gh-9", recovered: { from: "live", n: 1, orphans: 2, replayed: 1, interrupted: 1, notStarted: 0, countsFrom: "transcript" } });
  assert.equal(rec.recovered.countsFrom, "transcript", "the admin's validator keeps it");
  assert.equal(recoveryCountsText(rec.recovered), "2 orphaned calls, 1 replayed, 1 interrupted (from the transcript)");
  assert.equal(recoveryCountsText({ ...rec.recovered, countsFrom: "exit-line" }), "2 orphaned calls, 1 replayed, 1 interrupted");
  assert.equal(recordRecovery({ jobId: "x", recovered: { from: "live", n: 1, countsFrom: "<b>" } }).recovered.countsFrom, undefined);
});

test("readRunProgress: a timeout or a throw keeps continues from the record, and a hostile recovery job id is dropped (#662 review)", async () => {
  const { readRunProgress } = await import("../src/read-model.mjs");
  const continued = { jobId: "gh-9", reason: "recovery-enqueued" };
  // A hung Valkey: the bound's fallback still says the attempt continues, so the page shows its own record.
  const hung = { get: () => new Promise(() => {}) };
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const t = await readRunProgress({ redis: hung, queues: [], jobId: "gh-9", record: continued, timeoutMs: 20 });
    assert.ok(t.progress.unreachable);
    assert.deepEqual([t.continues, t.continuesAs], [true, null]);
    assert.equal((await readRunProgress({ redis: hung, queues: [], jobId: "gh-9", record: { jobId: "gh-9", reason: "infra" }, timeoutMs: 20 })).continues, false);
  } finally {
    clearInterval(keepAlive);
  }
  // A read that throws (here a record whose recoveryOf getter throws): the same.
  const throwing = { reason: "recovery-enqueued", get recoveryOf() { throw new Error("boom"); } };
  const th = await readRunProgress({ redis: { get: async () => null }, queues: [], jobId: "gh-9", record: throwing });
  assert.ok(th.progress.unreachable);
  assert.deepEqual([th.continues, th.continuesAs], [true, null]);
  // A queue job whose id is not a run id is never named.
  const queues = [{ name: "q", getJob: async (id) => (id === "gh-9.r2" ? { id: "gh-9.r2\"><script>", data: {} } : null) }];
  assert.equal((await readRunProgress({ redis: { get: async () => null }, queues, jobId: "gh-9", record: continued })).continuesAs, null);
});

test("createFleetReader's progressOfRun hands the record on: its recoveryOf picks the key and its reason sets continues (#662 review)", async () => {
  const gets = [];
  const redis = { status: "ready", get: async (k) => (gets.push(k), null), on() {}, quit: async () => {}, disconnect() {} };
  const mk = (_c, opts) => ({ name: opts?.name ?? "pi-jobs", getJob: async () => null, close: async () => {} });
  const logsDir = tempDir("pd-662-reader-");
  const reader = createFleetReader(
    { valkeyUrl: "redis://unused:1", logsDir, triggersPath: join(logsDir, "none.json") },
    { makeQueueFn: mk, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => AT },
  );
  try {
    const got = await reader.progressOfRun("gh-9.r1", { jobId: "gh-9.r1", recoveryOf: "gh-9", reason: "recovery-enqueued" });
    assert.deepEqual(gets, [progressKeyFor("gh-9")], "the record's recoveryOf, not the page id");
    assert.equal(got.continues, true, "the record's reason");
    gets.length = 0;
    const bare = await reader.progressOfRun("gh-9.r1");
    assert.deepEqual(gets, [progressKeyFor("gh-9.r1")]);
    assert.equal(bare.continues, false);
  } finally {
    await reader.dispose();
  }
});
