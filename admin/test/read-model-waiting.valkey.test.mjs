import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readWaiting } from "../src/read-model.mjs";
import { makeQueue } from "@edgehero/pi-dispatch/queue";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { deferHsetArgs, deferKey, deferTtlMs, DELAYED_SCORE_SHIFT } from "@edgehero/pi-dispatch/defer-reasons";

/**
 * Issue #737: `readWaiting` against a LIVE Valkey and the pinned BullMQ (5.80.4), for what fakes cannot show: that a
 * delayed set's score decodes to the instant BullMQ was given (`floor(score / 4096)`, getDelayedScore.lua), taken with
 * REAL clock instants because `job.moveToDelayed` clamps a past instant to its own `Date.now()`; that the scheduler's
 * next run is told from a `repeat:` run a gate deferred after the next was minted; that a paused queue's jobs wait on
 * the pause; and that over the real client nothing reads a job's data or writes anything.
 *
 * On the base database of VALKEY_TEST_URL with names of its own (`pi-jobs-waiting-<now>-<n>-<random>`), deleting only
 * its own keys: `defer:job:*` and `wait:held` are not queue-scoped, so job ids carry a random tail too. Skips without
 * VALKEY_TEST_URL, and refuses to skip when CI requires the integration tests.
 */

const URL_ = process.env.VALKEY_TEST_URL;
if (!URL_ && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
  throw new Error("read-model-waiting.valkey REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = URL_ ? false : "VALKEY_TEST_URL not set; the waiting reader's live checks skipped locally";

let counter = 0;
const uniqueQueueName = () => `pi-jobs-waiting-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
const tail = () => `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const SECRET = "SECRET ISSUE BODY";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

/** A queue of its own, a raw client, and a teardown that removes only what this test made. */
async function setup() {
  const redis = makeRedisClient(URL_);
  const queues = [];
  const workers = [];
  const ids = new Set();
  const q = async () => {
    const name = uniqueQueueName();
    const queue = makeQueue(parseConnection(URL_, { failFast: true }), { name });
    queues.push(queue);
    await until(async () => (await redis.exists(`bull:${name}:meta`)) === 1);
    return queue;
  };
  const worker = async (queue, processor) => {
    const { Worker } = await import("bullmq");
    const w = new Worker(queue.name, processor, { connection: parseConnection(URL_) });
    workers.push(w);
    return w;
  };
  return {
    redis,
    q,
    worker,
    id: (what) => {
      const id = `wv-${what}-${tail()}`;
      ids.add(id);
      return id;
    },
    own: (id) => ids.add(id),
    async done() {
      for (const w of workers) await w.close().catch(() => {});
      for (const queue of queues) {
        for (const s of (await queue.getJobSchedulers(0, -1, true).catch(() => [])) ?? []) await queue.removeJobScheduler(s.key ?? s.id ?? s.name).catch(() => {});
        await queue.obliterate({ force: true }).catch(() => {});
        await queue.close().catch(() => {});
      }
      for (const id of ids) {
        await redis.del(deferKey(id), `wait:job:${id}`).catch(() => {});
        await redis.srem("wait:held", id).catch(() => {});
      }
      redis.disconnect();
    },
  };
}

/** A defer record as the worker writes one: the leaf's arguments, DEL then HSET then PEXPIRE in one MULTI. */
async function writeRecord(redis, jobId, rec) {
  const at = Date.now();
  await redis.multi().del(deferKey(jobId)).hset(deferKey(jobId), ...deferHsetArgs({ at, n: randomBytes(8).toString("hex"), ...rec })).pexpire(deferKey(jobId), deferTtlMs(rec.until, at)).exec();
}

test("a delayed job's due instant is its score's quotient: an added delay and a worker's moveToDelayed, on real clock instants", { skip, timeout: 30_000 }, async () => {
  const v = await setup();
  try {
    const queue = await v.q();
    const added = v.id("added");
    const before = Date.now();
    await queue.add("github", { kind: "github", repo: "o/r", body: SECRET }, { jobId: added, delay: 7_000 });
    const after = Date.now();
    // A real worker defers the second job the way a gate does: its record first, then the move.
    const moved = v.id("moved");
    const marks = new Map();
    await queue.add("github", { kind: "github", repo: "o/r", body: SECRET }, { jobId: moved });
    const { DelayedError } = await import("bullmq");
    await v.worker(queue, async (job, token) => {
      const untilMs = Date.now() + 5_000;
      marks.set(job.id, untilMs);
      await writeRecord(v.redis, job.id, { why: "host-slot", until: untilMs, host: "build3" });
      await job.moveToDelayed(untilMs, token);
      throw new DelayedError();
    });
    await until(async () => marks.has(moved) && (await (await queue.getJob(moved)).getState()) === "delayed");
    const got = await readWaiting(v.redis, { queues: [queue] });
    const by = Object.fromEntries(got.rows.map((r) => [r.jobId, r]));
    assert.ok(by[added].dueAt >= before + 7_000 && by[added].dueAt <= after + 7_000, `${by[added].dueAt} within [${before + 7_000}, ${after + 7_000}]`);
    assert.deepEqual([by[added].bucket, by[added].why], ["none", null], "an added delay records no reason, and none is guessed");
    assert.equal(by[moved].dueAt, marks.get(moved), "a future instant is kept to the millisecond");
    assert.deepEqual([by[moved].bucket, by[moved].why, by[moved].untilAt, by[moved].host, by[moved].attemptsMade], ["slot", "host-slot", marks.get(moved), "build3", 0], "a deferral costs no attempt");
    const score = Number(await v.redis.zscore(`bull:${queue.name}:delayed`, moved));
    assert.equal(Math.floor(score / DELAYED_SCORE_SHIFT), marks.get(moved), "BullMQ's own encoding, read raw");
    assert.equal(by[moved].queuedAt, (await queue.getJob(moved)).timestamp, "queued since it was added");
  } finally {
    await v.done();
  }
});

test("the scheduler's next run is scheduled, not in line; the repeat: run a gate deferred after its next was minted is in line", { skip, timeout: 30_000 }, async () => {
  const v = await setup();
  try {
    const queue = await v.q();
    const schedulerId = `wv-sched-${tail()}`;
    await queue.upsertJobScheduler(schedulerId, { every: 3_600_000 }, { name: "local", data: { kind: "local", folder: "/srv/x" } });
    // `every` puts its first run in line at once: still the scheduler's next, so BullMQ would refuse to remove it.
    await until(async () => (await queue.getJobCounts("waiting")).waiting === 1);
    const first = await readWaiting(v.redis, { queues: [queue] });
    assert.equal(first.rows.length, 1);
    assert.match(first.rows[0].jobId, new RegExp(`^repeat:${schedulerId}:\\d+$`));
    assert.deepEqual([first.rows[0].state, first.rows[0].bucket, first.rows[0].schedulerNext], ["waiting", "slot", true]);
    v.own(first.rows[0].jobId);
    // A worker takes it (the scheduler mints the next run) and a gate defers it.
    const { DelayedError } = await import("bullmq");
    let deferred = null;
    await v.worker(queue, async (job, token) => {
      deferred = job.id;
      await job.moveToDelayed(Date.now() + 60_000, token);
      throw new DelayedError();
    });
    await until(async () => deferred !== null && (await queue.getJobCounts("delayed")).delayed === 2);
    const got = await readWaiting(v.redis, { queues: [queue] });
    assert.equal(got.scheduled.length, 1, "the next fire");
    assert.equal(got.scheduled[0].schedulerId, schedulerId);
    assert.notEqual(got.scheduled[0].jobId, deferred);
    v.own(got.scheduled[0].jobId);
    assert.deepEqual(got.rows.map((r) => [r.jobId, r.state, r.schedulerNext]), [[deferred, "delayed", false]], "the deferred run waits in line");
    assert.deepEqual(got.byQueue, [{ queue: queue.name, inLine: 1, scheduled: 1, truncated: false }]);
  } finally {
    await v.done();
  }
});

test("a paused queue's jobs, waiting and prioritized, wait on the pause; a running queue's prioritized job waits for a slot", { skip, timeout: 30_000 }, async () => {
  const v = await setup();
  try {
    const paused = await v.q();
    const running = await v.q();
    await paused.pause();
    const a = v.id("paused-a");
    const b = v.id("paused-b");
    const c = v.id("running-c");
    await paused.add("github", { kind: "github" }, { jobId: a });
    await paused.add("github", { kind: "github" }, { jobId: b, priority: 5 });
    await running.add("github", { kind: "github" }, { jobId: c, priority: 5 });
    const got = await readWaiting(v.redis, { queues: [paused, running] });
    const by = Object.fromEntries(got.rows.map((r) => [r.jobId, [r.state, r.bucket]]));
    assert.deepEqual(by, { [a]: ["paused", "paused"], [b]: ["prioritized", "paused"], [c]: ["prioritized", "slot"] });
    await paused.resume();
    const resumed = await readWaiting(v.redis, { queues: [paused] });
    assert.deepEqual(resumed.rows.map((r) => [r.jobId, r.state, r.bucket]).sort(), [[a, "waiting", "slot"], [b, "prioritized", "slot"]].sort(), "resumed: in line for a slot");
  } finally {
    await v.done();
  }
});

test("over the real client every read is a pipelined read-only command, and none asks a job hash for its data", { skip, timeout: 30_000 }, async () => {
  const { exists: isCommand, hasFlag } = await import("@ioredis/commands");
  const v = await setup();
  try {
    const queue = await v.q();
    const held = v.id("held");
    const plain = v.id("plain");
    await queue.add("github", { kind: "github", repo: "o/r", body: SECRET }, { jobId: held, delay: 60_000 });
    await queue.add("github", { kind: "github", repo: "o/r", body: SECRET }, { jobId: plain, deduplication: { id: "o/r#9:triage" } });
    await v.redis.hset(`wait:job:${held}`, { since: String(Date.now()), label: "jira", target: SECRET, "a:jira": `hold:${Date.now()}` });
    await v.redis.sadd("wait:held", held);
    await writeRecord(v.redis, held, { why: "wait-hold", until: Date.now() + 60_000 });
    const log = [];
    const record = (target) => (prop, fn) => (...args) => {
      log.push([prop.toLowerCase(), ...args]);
      return fn.apply(target, args);
    };
    const spied = new Proxy(v.redis, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "pipeline") {
          return (...a) => {
            const p = value.apply(target, a);
            return new Proxy(p, {
              get(pt, pp) {
                const pv = Reflect.get(pt, pp, pt);
                if (typeof pv !== "function") return pv;
                if (typeof pp === "string" && pp !== "exec" && isCommand(pp.toLowerCase())) return record(pt)(pp, pv);
                return pv.bind(pt);
              },
            });
          };
        }
        if (typeof value !== "function") return value;
        if (typeof prop === "string" && isCommand(prop.toLowerCase())) return (...args) => (log.push(["direct", prop.toLowerCase(), ...args]), value.apply(target, args));
        return value.bind(target);
      },
    });
    const got = await readWaiting(spied, { queues: [queue] });
    assert.deepEqual(got.rows.map((r) => [r.jobId, r.bucket]).sort(), [[held, "check"], [plain, "slot"]].sort());
    assert.deepEqual(got.rows.find((r) => r.jobId === held).held.answers.map((x) => x.profile), ["jira"]);
    assert.ok(log.length > 0);
    assert.deepEqual(log.filter(([cmd]) => cmd === "direct"), [], "nothing sent outside a pipeline");
    assert.deepEqual(log.filter(([cmd]) => !hasFlag(cmd, "readonly")).map(([cmd]) => cmd), [], "read-only commands only");
    for (const [cmd, key, ...rest] of log) {
      assert.ok(!(cmd === "hgetall" && String(key).startsWith("bull:")), `no HGETALL of ${key}`);
      if (cmd === "hget" || cmd === "hmget") for (const f of rest) assert.ok(!["data", "opts", "stacktrace", "returnvalue"].includes(f), `${cmd} ${key} ${f}`);
      assert.notEqual(cmd, "scan");
    }
    assert.ok(!JSON.stringify(got).includes("SECRET"));
  } finally {
    await v.done();
  }
});
