import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { keyedRedis, quietQueue, registryKeys } from "./helpers/fleet-reader-fakes.mjs";
import { WAITING_QUEUES_MAX, createFleetReader, readHeldJobs } from "../src/read-model.mjs";
import { readOperationalTool, readHeldForAgent, waitingForAgent } from "../src/tool-reads.mjs";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";
import { HELD_SET, jobKey } from "@edgehero/pi-dispatch/wait-state";

/**
 * The agent's operational reads over a REAL fleet reader (issue #963): unread is not empty. Each degraded state is the
 * one `createFleetReader` makes itself from a seam that fails (a host registry whose SMEMBERS rejects, a keyspace scan
 * that rejects, a `readLiveHostsFn` that throws), so the keys the tools read are the keys the reader sets. Every clock is
 * injected, the registry reader's included.
 */
const AT = Date.UTC(2026, 10, 21, 12);
const MIN = 60_000;
const PTTL = 45_000; // a row whose expiry was set 45 s ago (HOST_TTL_MS 90 s)

function paths() {
  const logsDir = tempDir("pd-963-reads-");
  return { valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 };
}

/**
 * A real fleet reader over `keys`. `registryDown()` and `scanDown()` fail the registry's SMEMBERS and the keyspace
 * SCAN; `failed` is each queue's failed jobs; `clock` an object whose `t` is the reader's now; `pttl` a host row's PTTL
 * (-1: no expiry); `built`, when given, gets the name of each queue the reader builds.
 */
function readerOver(keys, { registryDown, scanDown, failed, clock = { t: AT }, readLiveHostsFn, redis: wrap = (r) => r, pttl = PTTL, built = null } = {}) {
  const redis = wrap(keyedRedis(keys, { registryDown, scanDown, pttlOf: (key) => (key.startsWith("host:h:") ? pttl : -1) }));
  const make = quietQueue([], { failed });
  return createFleetReader(paths(), {
    makeQueueFn: (c, opts) => {
      built?.push(opts?.name ?? "pi-jobs");
      return make(c, opts);
    },
    parseConnectionFn: () => ({}),
    redisFn: () => redis,
    readLiveHostsFn: readLiveHostsFn ?? ((r, opts) => readLiveHosts(r, { ...opts, now: () => clock.t })),
    nowFn: () => clock.t,
    readOnly: true,
  });
}

// The tool's own read over `reader`, which it disposes after; `readKept` leaves it open for a second read.
const read = (kind, reader) => readOperationalTool(kind, { paths: paths(), reads: { fleet: () => reader } });
const readKept = (kind, reader) => readOperationalTool(kind, { paths: paths(), fleet: reader });

// A host row as a worker writes it: every field a string, its jobs (oldest first) and sandboxes JSON.
const row = (extra = {}) => ({
  version: "5.4.2",
  beatAt: String(AT - PTTL),
  budgetMemMiB: "8192",
  backends: "blessed=local",
  jobs: JSON.stringify([
    { id: "r0", at: AT - 9 * MIN, o: 1, v: "local", m: 4096, s: AT - 2 * MIN },
    { id: "r1", at: AT - 5 * MIN, m: 2048 },
  ]),
  jobsMore: "0",
  sandboxes: JSON.stringify([{ id: "r9", v: "local", until: AT + 60 * MIN, pin: true }]),
  ...extra,
});

// --- dispatch_hosts ---------------------------------------------------------------------------------------------------

test("dispatch_hosts read now: available, the read's instant, each beat from the row's age, a job's venue from `v`", async () => {
  const got = await read("hosts", readerOver(registryKeys({ mini1: row() })));
  assert.equal(got.unavailable, false);
  assert.equal(got.readAt, AT);
  const [h] = got.hosts;
  assert.equal(h.name, "mini1");
  assert.equal(h.beatAgeMs, PTTL, "Valkey's own measure of the row's age");
  assert.equal(h.beat, AT - PTTL, "the read's instant less that age, never null for a row that beat");
  assert.deepEqual(h.jobs.map((j) => [j.jobId, j.backend, j.orphan]), [["r0", "local", true], ["r1", null, false]]);
  assert.deepEqual(h.kept, [{ id: "r9", backend: "local", until: AT + 60 * MIN, pinned: true }]);
});

test("dispatch_hosts: a row with no expiry is aged by its own beat (`staleMs`), and one with neither has no beat, never the read's instant", async () => {
  const { beatAt: _, ...unbeaten } = row();
  const hostOf = async (r) => (await read("hosts", readerOver(registryKeys({ mini1: r }), { pttl: -1 }))).hosts[0];
  const own = await hostOf(row({ beatAt: String(AT - 30_000) }));
  assert.deepEqual([own.noExpiry, own.beatAgeMs, own.beat], [true, 30_000, AT - 30_000]);
  const none = await hostOf(unbeaten);
  assert.deepEqual([none.noExpiry, none.beatAgeMs, none.beat], [true, null, null]);
});

test("dispatch_hosts never read: hosts null and unavailable, never an empty list that says no host exists", async () => {
  const down = await read("hosts", readerOver(registryKeys({ mini1: row() }), { registryDown: () => true }));
  assert.deepEqual(down, { unavailable: true, readAt: null, hosts: null });
  const thrown = await read("hosts", readerOver(registryKeys({ mini1: row() }), { readLiveHostsFn: async () => { throw new Error("ECONNRESET"); } }));
  assert.deepEqual(thrown, { unavailable: true, readAt: null, hosts: null }, "a registry read that rejects is the same unread");
});

test("dispatch_hosts unread after a good read: the rows as last seen, unavailable, with the old read's instant", async () => {
  const clock = { t: AT };
  let down = false;
  const reader = readerOver(registryKeys({ mini1: row() }), { registryDown: () => down, clock });
  try {
    assert.equal((await readKept("hosts", reader)).unavailable, false);
    clock.t = AT + 5 * MIN;
    down = true;
    const got = await readKept("hosts", reader);
    assert.equal(got.unavailable, true);
    assert.equal(got.readAt, AT, "when the rows were read, not now");
    assert.deepEqual(got.hosts.map((h) => [h.name, h.beat]), [["mini1", AT - PTTL]]);
  } finally { await reader.dispose(); }
});

test("dispatch_hosts over a registry read in part: read, said in part, the rows it read dated by that read, a kept row marked and given no beat (#1062)", async () => {
  const clock = { t: AT };
  let answer = { hosts: [{ ...row(), name: "mini1", ttlAgeMs: PTTL }], incomplete: "1 of 2 host rows not read" };
  const reader = readerOver(registryKeys({}), { readLiveHostsFn: async () => answer, clock });
  try {
    const first = await readKept("hosts", reader);
    assert.deepEqual([first.unavailable, first.readInPart, first.readAt, first.hosts.map((h) => [h.name, h.notRead === true, h.beat])], [false, true, AT, [["mini1", false, AT - PTTL]]], "a first read in part is read, never hosts null");
    answer = { hosts: [{ ...row(), name: "mini1", ttlAgeMs: PTTL }, { ...row(), name: "mini2", ttlAgeMs: PTTL }] };
    clock.t = AT + MIN;
    await readKept("hosts", reader);
    answer = { hosts: [{ ...row(), name: "mini2", ttlAgeMs: PTTL }], incomplete: "1 of 2 host rows not read", unreadHosts: ["mini1"] };
    clock.t = AT + 2 * MIN;
    const again = await readKept("hosts", reader);
    assert.deepEqual([again.unavailable, again.readInPart, again.readAt], [false, true, AT + 2 * MIN]);
    assert.deepEqual(again.hosts.map((h) => [h.name, h.notRead === true, h.beat, h.beatAgeMs]), [["mini1", true, null, null], ["mini2", false, AT + 2 * MIN - PTTL, PTTL]], "the kept row is not dated by a read that did not reach it, nor aged");
  } finally { await reader.dispose(); }
});

test("dispatch_hosts: a jobs value that is no list and sandboxes that do not parse are null (not known), never []", async () => {
  const got = await read("hosts", readerOver(registryKeys({ mini1: row({ jobs: "not json", sandboxes: "{\"id\":" }) })));
  const [h] = got.hosts;
  assert.equal(h.jobs, null);
  assert.equal(h.jobsUnreadable, true);
  assert.equal(h.kept, null);
});

// --- dispatch_waiting and dispatch_waits ------------------------------------------------------------------------------

const metas = (...names) => Object.fromEntries(names.map((n) => [`bull:${n}:meta`, { opts: "{}" }]));

test("dispatch_waiting is complete only over a whole set of queues: a scan that failed or an unread registry is not", async () => {
  const keys = { ...registryKeys({ mini1: row() }), ...metas("pi-jobs@mini1", "pi-jobs@gone") };
  const whole = await read("waiting", readerOver(keys));
  assert.deepEqual([whole.unavailable, whole.complete, whole.queuesCut], [false, true, 0]);
  assert.deepEqual(whole.jobs, []);
  const scan = await read("waiting", readerOver(keys, { scanDown: () => true }));
  assert.deepEqual([scan.unavailable, scan.complete], [false, false], "the keyspace scan failed: a stopped host's queue may be unread");
  const registry = await read("waiting", readerOver(keys, { registryDown: () => true }));
  assert.deepEqual([registry.unavailable, registry.complete], [false, false], "the registry was not read: a live host's queue may be unread");
});

test("the fleet reader says per call when the waiting read's queues may be short, the kept read unchanged", async () => {
  const clock = { t: AT };
  let down = false;
  const reader = readerOver({ ...registryKeys({ mini1: row() }), ...metas("pi-jobs@mini1") }, { registryDown: () => down, clock });
  try {
    assert.equal((await reader.snapshot({ waiting: true })).waiting.queuesShort, undefined);
    down = true;
    clock.t = AT + 1000; // inside the waiting window: the same kept read answers
    assert.equal((await reader.snapshot({ waiting: true })).waiting.queuesShort, true);
    down = false;
    clock.t = AT + 2000;
    assert.equal((await reader.snapshot({ waiting: true })).waiting.queuesShort, undefined, "the flag was never written onto the kept read");
  } finally { await reader.dispose(); }
});

test("dispatch_waiting over a waiting read that failed: jobs null and unavailable, never an empty line", async () => {
  const failing = (r) => ({ ...r, pipeline: () => new Proxy({}, { get: (_t, key) => (key === "exec" ? async () => { throw new Error("ETIMEDOUT"); } : () => {}) }) });
  const got = await read("waiting", readerOver(registryKeys({}), { redis: failing }));
  assert.deepEqual(got, { unavailable: true, more: null, queuesCut: null, complete: false, jobs: null });
});

test("dispatch_waits is complete only when no held job is past the listing (`more`)", async () => {
  const held = (count) => {
    const keys = { [HELD_SET]: [] };
    for (let i = 0; i < count; i++) {
      keys[HELD_SET].push(`h${i}`);
      keys[jobKey(`h${i}`)] = { since: String(AT - (i + 1) * MIN), checks: "1", target: "acme/web", label: "deploy is green" };
    }
    return readHeldJobs({ url: "redis://unused", redisFn: () => keyedRedis(keys), now: () => AT });
  };
  const few = waitingForAgent(await held(3));
  assert.deepEqual([few.more, few.complete, few.jobs.length], [0, true, 3]);
  const many = waitingForAgent(await held(25));
  assert.deepEqual([many.more, many.complete, many.jobs.length], [5, false, 20]);
});

// --- dispatch_failed --------------------------------------------------------------------------------------------------

const failedJob = (id, finishedOn) => ({ id, attemptsMade: 3, opts: { attempts: 3 }, failedReason: "boom", finishedOn, data: {} });

test("dispatch_failed reads every queue the kill switch reaches, and is complete only over that whole set", async () => {
  const keys = { ...registryKeys({ mini1: row() }), ...metas("pi-jobs@mini1", "pi-jobs@gone") };
  const failed = { "pi-jobs": [failedJob("f1", AT - MIN)], "pi-jobs@gone": [failedJob("f2", AT - 2 * MIN)] };
  const whole = await read("failed", readerOver(keys, { failed }));
  assert.deepEqual([whole.unavailable, whole.more, whole.complete], [false, 0, true]);
  assert.deepEqual(whole.jobs.map((j) => [j.jobId, j.queue]), [["f1", "pi-jobs"], ["f2", "pi-jobs@gone"]], "a stopped host's queue is read too");
  const degraded = await read("failed", readerOver(keys, { failed, registryDown: () => true }));
  assert.deepEqual([degraded.unavailable, degraded.complete], [false, false], "the registry was not read");
  const scan = await read("failed", readerOver(keys, { failed, scanDown: () => true }));
  assert.deepEqual([scan.complete, scan.jobs.map((j) => j.jobId)], [false, ["f1"]], "the scan failed: the stopped host's queue was not found");
  const many = { "pi-jobs": Array.from({ length: 22 }, (_, i) => failedJob(`f${i}`, AT - i * MIN)) };
  const cut = await read("failed", readerOver(keys, { failed: many }));
  assert.deepEqual([cut.more, cut.complete], [2, false], "failed jobs past the list");
});

test("dispatch_failed builds the registry's queues and at most as many others as fit beside them in WAITING_QUEUES_MAX, and a set that bound cut is not complete", async () => {
  const stale = Array.from({ length: 100 }, (_, i) => `pi-jobs@stale${String(i).padStart(3, "0")}`);
  const keys = { ...registryKeys({ mini1: row() }), ...metas("pi-jobs@mini1", ...stale) };
  const built = [];
  const got = await read("failed", readerOver(keys, { built, failed: { "pi-jobs@mini1": [failedJob("f1", AT - MIN)] } }));
  assert.equal(got.complete, false, "past the bound: the queues not read may hold failed jobs");
  assert.deepEqual(got.jobs.map((j) => [j.jobId, j.queue]), [["f1", "pi-jobs@mini1"]], "the registry's queue is never the one cut");
  assert.equal(built.length, WAITING_QUEUES_MAX, "one queue (one client) each for the shared queue, the registry's and 62 others, not 102");
  const fit = await read("failed", readerOver({ ...registryKeys({ mini1: row() }), ...metas("pi-jobs@mini1", ...stale.slice(0, WAITING_QUEUES_MAX - 2)) }));
  assert.equal(fit.complete, true, "exactly the bound: nothing was cut");
});

// Issue #1053: the failed read goes through the kill switch's set, whose read names a queue Valkey answered with an
// error (`switchErrored`) instead of failing; that queue is in no count, so the failed total leaves its jobs out.
test("dispatch_failed over a queue whose read Valkey answered with an error is not complete, and how many more is not known (#1053)", async () => {
  const keys = { ...registryKeys({}), ...metas("pi-jobs@hostb") };
  const failed = { "pi-jobs@hostb": Array.from({ length: 25 }, (_, i) => failedJob(`f${i}`, AT - i * MIN)) };
  const wrongtype = () => Promise.reject(Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value"), { name: "ReplyError" }));
  const make = quietQueue([], { failed });
  const reader = createFleetReader(paths(), {
    makeQueueFn: (c, opts) => {
      const q = make(c, opts);
      return q.name === "pi-jobs@hostb" ? { ...q, isPaused: wrongtype } : q;
    },
    parseConnectionFn: () => ({}),
    redisFn: () => keyedRedis(keys),
    readLiveHostsFn: (r, o) => readLiveHosts(r, { ...o, now: () => AT }),
    nowFn: () => AT,
    readOnly: true,
  });
  const got = await read("failed", reader);
  assert.deepEqual([got.unavailable, got.more, got.complete, got.jobs.length], [false, null, false, 20], "its 25 failed jobs are in no total: neither none more nor complete");
  // The same set read whole is complete, and its count is known again.
  const whole = await read("failed", readerOver(keys, { failed }));
  assert.deepEqual([whole.more, whole.complete], [5, false]);
});

test("dispatch_failed over a failed set that could not be read: jobs null and unavailable", async () => {
  // Each queue's failed list rejects; the snapshot catches the failed read as a unit into `{ unreachable }`.
  const broken = createFleetReader(paths(), {
    makeQueueFn: (c, opts) => ({ ...quietQueue()(c, opts), async getFailed() { throw new Error("ETIMEDOUT"); } }),
    parseConnectionFn: () => ({}),
    redisFn: () => keyedRedis(registryKeys({})),
    readLiveHostsFn: (r, o) => readLiveHosts(r, { ...o, now: () => AT }),
    nowFn: () => AT,
    readOnly: true,
  });
  const got = await read("failed", broken);
  assert.deepEqual(got, { unavailable: true, more: null, complete: false, jobs: null });
});

// --- dispatch_costs' held money ---------------------------------------------------------------------------------------

test("dispatch_costs held: an unread registry is unknown, never $0; a registry read with no host holds 0", async () => {
  const held = (opts) => readHeldForAgent({ paths: paths(), nowMs: AT, reads: { fleet: () => readerOver(registryKeys({}), opts) } });
  assert.deepEqual(await held({ registryDown: () => true }), { heldMicros: null, heldJobs: null, unknown: true });
  assert.deepEqual(await held({}), { heldMicros: 0, heldJobs: 0, unknownHosts: [] });
});
