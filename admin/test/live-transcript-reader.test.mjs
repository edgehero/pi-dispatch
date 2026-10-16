import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { compareTranscriptIds, createFleetReader, readTranscriptMeta, readTranscriptSince, TRANSCRIPT_PAGE_MAX } from "../src/read-model.mjs";
import { LIVE_KEY_PREFIX, liveKeyFor } from "@edgehero/pi-dispatch/live-transcript";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";

/**
 * The live transcript readers (issue #643, INT-LIVE-TRANSCRIPT-STREAM): `readTranscriptSince` / `readTranscriptMeta` and
 * the fleet reader's `transcriptSince` / `transcriptMeta`, against a LIVE Valkey (VALKEY_TEST_URL, database 15, flushed
 * before each test). The stream is seeded with plain XADDs in the contract's shape, so these tests pin the READER's
 * reading of the contract and not the worker's writing of it.
 */
const BASE = process.env.VALKEY_TEST_URL;
const URL15 = BASE
  ? (() => {
      const u = new URL(BASE);
      u.pathname = "/15";
      return u.toString();
    })()
  : null;
const live = { skip: URL15 ? false : "needs VALKEY_TEST_URL", timeout: 30_000 };

// The stream's key, the worker's own derivation (`run:live:` and the run mirror's sanitized id), pinned to that shape.
const keyOf = (jobId) => liveKeyFor(jobId);
test("the key the reader reads is the contract's: run:live: and the sanitized id", () => {
  assert.equal(LIVE_KEY_PREFIX, "run:live:");
  assert.equal(liveKeyFor("repeat:nightly:17"), `run:live:${sanitizeJobId("repeat:nightly:17")}`);
});

let client = null;
async function fresh() {
  if (!client) {
    const { Redis } = await import("ioredis");
    client = new Redis(URL15, { maxRetriesPerRequest: 1 });
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

async function add(redis, jobId, fields) {
  return redis.xadd(keyOf(jobId), "*", ...Object.entries(fields).flat());
}

test("pages with an exclusive cursor: each page starts after the last id it handed back", live, async () => {
  const redis = await fresh();
  const job = "repeat:nightly:1760000000000";
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await add(redis, job, { kind: "assistant", ts: String(1760000000000 + i), text: `line ${i}` }));

  const first = await readTranscriptSince(redis, job, null, { count: 2 });
  assert.deepEqual(first.entries.map((e) => e.text), ["line 0", "line 1"]);
  assert.equal(first.next, ids[1], "next is the last entry's own id");
  assert.equal(first.ended, false);
  assert.deepEqual(first.entries[0], { id: ids[0], kind: "assistant", ts: 1760000000000, text: "line 0", tool: null, error: false, truncated: false, outcome: null });

  const second = await readTranscriptSince(redis, job, first.next, { count: 2 });
  assert.deepEqual(second.entries.map((e) => e.text), ["line 2", "line 3"], "exclusive: the cursor's own entry is not returned twice");
  const third = await readTranscriptSince(redis, job, second.next, { count: 2 });
  assert.deepEqual(third.entries.map((e) => e.text), ["line 4"]);
  const none = await readTranscriptSince(redis, job, third.next, { count: 2 });
  assert.deepEqual(none.entries, []);
  assert.equal(none.next, third.next, "nothing new keeps the cursor where it was");
});

test("ended once the reader reaches the end entry, also when it resumes after it; tool, error and outcome", live, async () => {
  const redis = await fresh();
  const job = "gh-acme-web-7";
  await add(redis, job, { kind: "tool-call", ts: "1", tool: "bash", text: '{"cmd":"ls"}' });
  await add(redis, job, { kind: "tool-result", ts: "2", tool: "bash", error: "1", truncated: "1", text: "boom" });
  await add(redis, job, { kind: "tool-result", ts: "3", tool: "bad tool name!", text: "ok" });
  const endId = await add(redis, job, { kind: "end", ts: "4", outcome: "policy", text: "should not be read" });

  const before = await readTranscriptSince(redis, job, null, { count: 2 });
  assert.equal(before.ended, false, "not ended while the end entry is still ahead of the cursor");
  assert.deepEqual(before.entries.map((e) => [e.kind, e.tool, e.error, e.truncated]), [["tool-call", "bash", false, false], ["tool-result", "bash", true, true]]);

  const rest = await readTranscriptSince(redis, job, before.next);
  assert.equal(rest.entries[0].tool, "?", "a tool name outside the charset reads as ?");
  const end = rest.entries[1];
  assert.deepEqual([end.kind, end.text, end.outcome, end.id], ["end", null, "policy", endId], "the end entry carries its outcome and never text");
  assert.equal(rest.ended, true);
  assert.equal(rest.outcome, "policy");

  const resumed = await readTranscriptSince(redis, job, endId);
  assert.deepEqual(resumed.entries, []);
  assert.equal(resumed.ended, true, "a reconnect whose cursor is the end entry still learns the run is over");
  assert.equal(resumed.outcome, "policy");

  const meta = await readTranscriptMeta(redis, job);
  assert.deepEqual(meta, { exists: true, ended: true, outcome: "policy", length: 4, firstId: before.entries[0].id, lastId: endId });
});

test("an outcome outside the enum reads unknown; an unknown kind is kept as a note; a stream nobody wrote does not exist", live, async () => {
  const redis = await fresh();
  const job = "gh-x-1";
  await add(redis, job, { kind: "telepathy", ts: "1", text: "a newer worker's kind" });
  await add(redis, job, { kind: "end", ts: "2", outcome: "rm -rf /" });
  const page = await readTranscriptSince(redis, job);
  assert.deepEqual(page.entries.map((e) => [e.kind, e.text]), [["note", "a newer worker's kind"], ["end", null]]);
  assert.equal(page.outcome, "unknown", "free text never reaches a surface as an outcome");

  assert.deepEqual(await readTranscriptMeta(redis, "gh-never-ran"), { exists: false, ended: false, outcome: null, length: 0, firstId: null, lastId: null });
  const empty = await readTranscriptSince(redis, "gh-never-ran");
  assert.deepEqual(empty, { entries: [], next: null, ended: false, outcome: null });
});

test("validation refuses a bad id or cursor before any key is built, and clamps a huge count to the page bound", live, async () => {
  const redis = await fresh();
  const job = "gh-y-2";
  for (let i = 0; i < TRANSCRIPT_PAGE_MAX + 5; i++) await add(redis, job, { kind: "note", ts: String(i), text: String(i) });

  // A spy client: any command at all on a refused read is a key built from an unchecked string.
  const calls = [];
  const spy = new Proxy(redis, { get: (t, p) => (typeof t[p] === "function" ? (...a) => (calls.push(String(p)), t[p](...a)) : t[p]) });
  for (const bad of ["", "a b", "x".repeat(201), "gh-1\r\nFLUSHALL", "*", 7, null]) {
    assert.match(String((await readTranscriptSince(spy, bad)).invalid), /run id/, `id ${JSON.stringify(bad)}`);
    assert.match(String((await readTranscriptMeta(spy, bad)).invalid), /run id/, `meta id ${JSON.stringify(bad)}`);
  }
  for (const bad of ["-", "+", "1", "1-", "-1", "1-2-3", "(1-0", "12345678901234567-0", "1-12345678901", "1-0 ", 5]) {
    assert.match(String((await readTranscriptSince(spy, job, bad)).invalid), /cursor/, `cursor ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(calls, [], "no refused read reached Valkey");

  const huge = await readTranscriptSince(redis, job, null, { count: 1e9 });
  assert.equal(huge.entries.length, TRANSCRIPT_PAGE_MAX, "a huge count is clamped to 200");
  assert.equal((await readTranscriptSince(redis, job, null, { count: -3 })).entries.length, TRANSCRIPT_PAGE_MAX, "a nonsense count reads one full page");
  assert.equal((await readTranscriptSince(redis, job, null, { count: 3 })).entries.length, 3);
  assert.equal((await readTranscriptSince(redis, job, "9999999999999999-0")).entries.length, 0, "a cursor past the end reads nothing");
});

test("never throws: a dead client and a stalled one both come back unreachable, the reason naming no host or address", async () => {
  const refused = () => Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:6379 (valkey.internal.example)"), { code: "ECONNREFUSED" });
  const dead = { xrange: async () => { throw refused(); }, xrevrange: async () => [], xlen: async () => 0 };
  for (const read of [await readTranscriptSince(dead, "gh-1"), await readTranscriptMeta(dead, "gh-1")]) {
    assert.equal(read.unreachable, "the transcript could not be read (ECONNREFUSED)", "the code alone survives");
    assert.doesNotMatch(read.unreachable, /10\.0\.0\.1|6379|valkey\.internal|connect /, "never the error's own text");
  }
  // An error without a code, or with one that is not a code token, carries nothing of its text.
  const odd = { xrange: async () => { throw Object.assign(new Error("WRONGTYPE at host-a:6379"), { code: "host-a:6379" }); }, xrevrange: async () => [], xlen: async () => 0 };
  assert.equal((await readTranscriptSince(odd, "gh-1")).unreachable, "the transcript could not be read");
  const stalled = { xrange: () => new Promise(() => {}), xrevrange: () => new Promise(() => {}), xlen: () => new Promise(() => {}) };
  const socket = setInterval(() => {}, 1000); // a real client's socket keeps the process up; the read's timer is unref'd
  try {
    const t0 = Date.now();
    assert.match((await readTranscriptSince(stalled, "gh-1", null, { timeoutMs: 50 })).unreachable, /timed out/);
    assert.match((await readTranscriptMeta(stalled, "gh-1", { timeoutMs: 50 })).unreachable, /timed out/);
    assert.ok(Date.now() - t0 < 2000, "bounded by the timeout");
  } finally {
    clearInterval(socket);
  }
});

test("the fleet reader's transcript read never blocks the snapshot on the same client", live, async () => {
  const redis = await fresh();
  const job = "gh-z-3";
  await add(redis, job, { kind: "user", ts: "1", text: "hello" });
  const logsDir = tempDir("live-643-");
  const queue = (_c, { name = "pi-jobs" } = {}) => ({
    name,
    isPaused: async () => false,
    getJobCounts: async () => ({ waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }),
    getWorkers: async () => [],
    getJobSchedulers: async () => [],
    getActive: async () => [],
    getFailed: async () => [],
    close: async () => {},
  });
  const reader = createFleetReader({ valkeyUrl: URL15, logsDir }, { makeQueueFn: queue, readLiveHostsFn: async () => ({ hosts: [] }), readOnly: true, nowFn: () => Date.parse("2026-10-16T12:00:00Z") });
  try {
    await reader.snapshot(); // warm the connection, so the timing below is the reads and not the connect
    // The transcript read first, the snapshot right behind it on the same connection: a blocking read (XREAD BLOCK)
    // would hold the connection and every snapshot GET would queue behind it for the whole block.
    const t0 = Date.now();
    const [page, snap, meta] = await Promise.all([reader.transcriptSince(job, null), reader.snapshot().then((s) => [s, Date.now() - t0]), reader.transcriptMeta(job)]);
    assert.deepEqual(page.entries.map((e) => e.text), ["hello"]);
    assert.equal(meta.exists, true);
    assert.ok(snap[0] && !snap[0].unreachable, "the snapshot answered");
    assert.ok(snap[1] < 1000, `the snapshot waited ${snap[1]} ms beside the transcript read`);
    assert.match(String((await reader.transcriptSince("bad id")).invalid), /run id/);
    assert.match(String((await reader.transcriptSince(job, "nope")).invalid), /cursor/);
  } finally {
    await reader.dispose();
  }
});

test("no blocking stream read anywhere in the read model", () => {
  const src = readFileSync(new URL("../src/read-model.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\.xread(group)?\s*\(/i, "an XREAD on a held client parks every later read behind it");
  assert.doesNotMatch(src, /["']BLOCK["']/i);
});

// ---- review findings: id order, entry parsing, the fleet reader's bound ----------------------------------------------

test("stream ids order numerically: <ms>-10 after <ms>-9 in the same millisecond, and a 14-digit ms after a 13-digit one", () => {
  assert.equal(compareTranscriptIds("1760000000000-9", "1760000000000-10"), -1);
  assert.equal(compareTranscriptIds("1760000000000-10", "1760000000000-9"), 1);
  assert.equal(compareTranscriptIds("9999999999999-5", "10000000000000-0"), -1);
  assert.equal(compareTranscriptIds("10000000000000-0", "9999999999999-5"), 1);
  assert.equal(compareTranscriptIds("9007199254740993-0", "9007199254740992-0"), 1, "past 2^53, still exact");
  assert.equal(compareTranscriptIds("5-5", "5-5"), 0);
  assert.equal(compareTranscriptIds(null, "0-0"), -1, "no cursor sorts first");
  assert.equal(compareTranscriptIds("0-0", null), 1);
});

test("ended waits for the end entry when ids pass a digit boundary: same millisecond -9/-10, and 13 to 14 digit ms", live, async () => {
  const redis = await fresh();
  const ms = "1760000000000";
  const job = "gh-seq-1";
  for (let i = 0; i <= 9; i++) await redis.xadd(keyOf(job), `${ms}-${i}`, "kind", "note", "ts", "1", "text", `n${i}`);
  await redis.xadd(keyOf(job), `${ms}-10`, "kind", "end", "ts", "1", "outcome", "completed");
  const nine = await readTranscriptSince(redis, job, null, { count: 10 });
  assert.equal(nine.next, `${ms}-9`);
  assert.equal(nine.ended, false, "the cursor at -9 is still before the end entry at -10");
  assert.equal(nine.outcome, null);
  const rest = await readTranscriptSince(redis, job, nine.next);
  assert.deepEqual(rest.entries.map((e) => e.id), [`${ms}-10`]);
  assert.equal(rest.ended, true);

  const wide = "gh-seq-2";
  await redis.xadd(keyOf(wide), "9999999999999-5", "kind", "note", "ts", "1", "text", "last line");
  await redis.xadd(keyOf(wide), "10000000000000-0", "kind", "end", "ts", "1", "outcome", "failed");
  const before = await readTranscriptSince(redis, wide, null, { count: 1 });
  assert.equal(before.next, "9999999999999-5");
  assert.equal(before.ended, false, "a 13-digit cursor is before a 14-digit end");
  const after14 = await readTranscriptSince(redis, wide, before.next);
  assert.deepEqual([after14.entries.map((e) => e.id), after14.ended, after14.outcome], [["10000000000000-0"], true, "failed"]);
});

test("entry parsing: the 65,536-unit cap, the first of a duplicated field, error on a tool result only, and ts validation", live, async () => {
  const redis = await fresh();
  const job = "gh-parse-1";
  const big = "a".repeat(70_000);
  const straddle = `${"b".repeat(65_535)}\u{1F600}tail`; // the pair's high half is unit 65,536
  const exact = "c".repeat(65_536);
  const rows = [
    ["kind", "assistant", "ts", "1", "text", big],
    ["kind", "assistant", "ts", "2", "text", straddle],
    ["kind", "assistant", "ts", "3", "text", exact],
    ["kind", "assistant", "kind", "end", "text", "first", "text", "second", "ts", "4", "ts", "5", "tool", "x"],
    ["kind", "tool-call", "ts", "6", "tool", "bash", "error", "1", "text", "{}"],
    ["kind", "tool-result", "ts", "7", "tool", "bash", "error", "true", "text", "r"],
    ["kind", "note", "ts", "12a", "error", "1", "text", "n"],
    ["kind", "note", "ts", "12345678901234567", "text", "n"],
    ["kind", "note", "ts", "1234567890123456", "text", "n"],
    ["kind", "note", "ts", "", "text", "n"],
    ["kind", "note", "ts", "-5", "text", "n"],
  ];
  for (const r of rows) await redis.xadd(keyOf(job), "*", ...r);
  const { entries } = await readTranscriptSince(redis, job);
  assert.equal(entries[0].text.length, 65_536, "cut at 65,536 units");
  assert.equal(entries[0].truncated, true, "and marked truncated");
  assert.equal(entries[1].text, "b".repeat(65_535), "a pair cut in half loses its high half, never leaves it lone");
  assert.equal(entries[1].truncated, true);
  assert.equal(entries[2].text, exact, "exactly at the cap is kept whole");
  assert.equal(entries[2].truncated, false);
  assert.deepEqual([entries[3].kind, entries[3].text, entries[3].ts, entries[3].tool], ["assistant", "first", 4, null], "the first occurrence of each field wins");
  assert.equal(entries[4].error, false, "error is a tool result's marker, not a tool call's");
  assert.equal(entries[5].error, false, "only the string 1 marks an error");
  assert.equal(entries[6].error, false);
  assert.deepEqual(entries.slice(6).map((e) => e.ts), [null, null, 1234567890123456, null, null], "ts is 1 to 16 digits, else null");
});

test("the fleet reader bounds a transcript read at 2 s on a client that never answers", { timeout: 30_000 }, async () => {
  const hang = () => new Promise(() => {});
  const stalled = { xrange: hang, xrevrange: hang, xlen: hang, get: hang, mget: hang, smembers: hang, disconnect() {}, quit: async () => {} };
  const queue = (_c, { name = "pi-jobs" } = {}) => ({ name, close: async () => {} });
  const reader = createFleetReader({ valkeyUrl: "redis://unused:1", logsDir: tempDir("live-643-bound-") }, { redisFn: () => stalled, makeQueueFn: queue, readLiveHostsFn: async () => ({ hosts: [] }), readOnly: true });
  // The read's timer is unref'd (a real client's socket is what keeps a process up); this stands in for that socket, so
  // the test waits on the bound rather than ending with the read still pending.
  const socket = setInterval(() => {}, 1000);
  try {
    for (const read of [() => reader.transcriptSince("gh-1", null), () => reader.transcriptMeta("gh-1")]) {
      const t0 = Date.now();
      const res = await read();
      const took = Date.now() - t0;
      assert.match(String(res.unreachable), /timed out/);
      assert.ok(took >= 1900 && took < 2400, `bounded at the fleet reader's 2 s, took ${took} ms`);
    }
  } finally {
    clearInterval(socket);
    await reader.dispose();
  }
});
