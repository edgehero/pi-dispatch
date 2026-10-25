import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cancelQueuedJob, cancelQueuedRefusal, planCancelQueued } from "../src/read-model.mjs";
import { heldClearedAnswer } from "../src/job-actions.mjs";
import { removeQueuedJob } from "@edgehero/pi-dispatch/cancel-state";
import { makeQueue } from "@edgehero/pi-dispatch/queue";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { deferHsetArgs, deferKey } from "@edgehero/pi-dispatch/defer-reasons";

/**
 * Issue #737: the console's `cancel-queued` planner and funnel against a LIVE Valkey and the pinned BullMQ (5.80.4): a
 * job that never started goes with its defer record and its hold's keys; a job that made an attempt, was handed back
 * after a stall, recovers a run, or is its scheduler's next run is refused in the console's words; a job a worker took
 * between the preview and the confirm answers "started". The planner finds a job the way every console write does
 * (`openFleet`: the registry unioned with the `bull:pi-jobs@*` queues that exist), so each test's queue is a host queue
 * of its own, `pi-jobs@cq-<now>-<n>-<random>`, on the base database; job ids carry a random tail, and only this test's
 * keys are deleted (`defer:job:*`, `wait:*` and `host:live` are deployment-wide). Skips without VALKEY_TEST_URL, and
 * refuses to skip when CI requires the integration tests. The sentences and the funnel's mapping of each
 * `removeQueuedJob` answer run on any machine.
 */

const URL_ = process.env.VALKEY_TEST_URL;
if (!URL_ && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
  throw new Error("cancel-queued REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const live = { skip: URL_ ? false : "VALKEY_TEST_URL not set; cancel-queued's live checks skipped locally", timeout: 30_000 };

let counter = 0;
const uniqueQueueName = () => `pi-jobs@cq-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2, 8)}`;
const tail = () => `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

/** A host queue of its own, a raw client, and a teardown that removes only what this test made. */
async function setup() {
  const redis = makeRedisClient(URL_);
  const name = uniqueQueueName();
  const queue = makeQueue(parseConnection(URL_, { failFast: true }), { name });
  await until(async () => (await redis.exists(`bull:${name}:meta`)) === 1);
  const workers = [];
  const ids = new Set();
  const leases = new Set();
  return {
    redis,
    queue,
    name,
    id: (what) => {
      const id = `cq-${what}-${tail()}`;
      ids.add(id);
      return id;
    },
    lease: (dedupId) => leases.add(dedupId),
    async worker(processor) {
      const { Worker } = await import("bullmq");
      const w = new Worker(name, processor, { connection: parseConnection(URL_) });
      workers.push(w);
      return w;
    },
    async done() {
      for (const w of workers) await w.close(true).catch(() => {});
      for (const s of (await queue.getJobSchedulers(0, -1, true).catch(() => [])) ?? []) await queue.removeJobScheduler(s.key ?? s.id ?? s.name).catch(() => {});
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close().catch(() => {});
      for (const id of ids) {
        await redis.del(deferKey(id), `wait:job:${id}`).catch(() => {});
        await redis.srem("wait:held", id).catch(() => {});
      }
      for (const d of leases) await redis.del(`wait:key:${d}`).catch(() => {});
      redis.disconnect();
    },
  };
}

const forgeData = (n, extra = {}) => ({ kind: "github", repo: "acme/web", target: { type: "issue", number: n }, title: "SECRET TITLE", ...extra });

async function writeRecord(redis, jobId, rec) {
  await redis.hset(deferKey(jobId), ...deferHsetArgs({ at: Date.now(), n: randomBytes(8).toString("hex"), ...rec }));
}

// --- the sentences --------------------------------------------------------------------------------------------------

test("cancelQueuedRefusal: one sentence per reason, each ending 'nothing was changed'; an unknown reason is a programming error", () => {
  const cases = {
    retried: [{ jobId: "gh-1", attempts: 2 }, "job gh-1 has made 2 attempts and waits to retry: a retry keeps its run's steer and held replies open for the next attempt, so the console cancels only a job that never started; once it runs, Cancel on its run page stops it; nothing was changed"],
    stalled: [{ jobId: "gh-1" }, "job gh-1 was handed back after a stall, so an attempt of it may have finished; nothing was changed"],
    recovery: [{ jobId: "gh-1.r1", run: "gh-1" }, "job gh-1.r1 recovers run gh-1 and owes that run its final record; nothing was changed"],
    scheduled: [{ jobId: "repeat:nightly:1", scheduler: "nightly" }, "job repeat:nightly:1 is cron trigger nightly's next run: pause the trigger or edit its schedule; BullMQ refuses to remove a scheduler's next job; nothing was changed"],
    notQueued: [{ jobId: "gh-1", state: "active" }, "job gh-1 is active, not waiting to start; nothing was changed"],
    started: [{ jobId: "gh-1" }, "job gh-1 started since the preview; nothing was changed"],
    changed: [{ jobId: "gh-1" }, "job gh-1 changed since the preview; nothing was changed"],
  };
  for (const [kind, [facts, sentence]] of Object.entries(cases)) {
    assert.equal(cancelQueuedRefusal(kind, facts), sentence, kind);
    assert.match(sentence, /; nothing was changed$/, kind);
  }
  assert.match(cancelQueuedRefusal("retried", { jobId: "gh-1", attempts: 1 }), /^job gh-1 has made 1 attempt and waits/);
  assert.throws(() => cancelQueuedRefusal("bored", { jobId: "gh-1" }), RangeError);
});

test("planCancelQueued and cancelQueuedJob refuse a malformed id or expect before any read", async () => {
  const never = () => {
    throw new Error("no client may be made");
  };
  assert.deepEqual(await planCancelQueued({ url: "redis://x", jobId: "a b", redisFn: never, queueFn: never }), { refusal: "a job id is letters, digits and . _ : -, at most 200 characters", status: 400 });
  assert.deepEqual(await planCancelQueued({ url: "redis://x", jobId: "gh-1", queue: 5, redisFn: never, queueFn: never }), { refusal: "queue must be a queue name", status: 400 });
  for (const [expect, why] of [
    [null, "the preview's queue, attemptsMade and stalledCounter are required"],
    [{ attemptsMade: 0, stalledCounter: 0 }, "expect.queue must be the preview's queue"],
    [{ queue: "pi-jobs", attemptsMade: -1, stalledCounter: 0 }, "expect.attemptsMade must be a non-negative integer"],
    [{ queue: "pi-jobs", attemptsMade: 0, stalledCounter: "0" }, "expect.stalledCounter must be a non-negative integer"],
  ]) {
    assert.deepEqual(await cancelQueuedJob({ url: "redis://x", jobId: "gh-1", expect, redisFn: never, queueFn: never }), { invalid: why });
  }
  assert.deepEqual(await cancelQueuedJob({ url: "redis://x", jobId: "", expect: { queue: "pi-jobs", attemptsMade: 0, stalledCounter: 0 }, redisFn: never, queueFn: never }), { invalid: "a job id is letters, digits and . _ : -, at most 200 characters" });
});

// --- against BullMQ ---------------------------------------------------------------------------------------------------

test("a never-started delayed job: the plan says why it waits; the confirm removes it and its defer record", live, async () => {
  const v = await setup();
  try {
    const jobId = v.id("delayed");
    await v.queue.add("github", forgeData(3), { jobId, delay: 60_000 });
    await writeRecord(v.redis, jobId, { why: "host-slot", until: Date.now() + 60_000, host: "build3" });
    const planned = await planCancelQueued({ url: URL_, jobId, queue: v.name });
    assert.ok(planned.plan, JSON.stringify(planned));
    const { waiting, ...plan } = planned.plan;
    assert.deepEqual(plan, { jobId, queue: v.name, state: "delayed", held: false, attemptsMade: 0, stalledCounter: 0, kind: "github", target: "acme/web#3" });
    assert.deepEqual([waiting.bucket, waiting.why, waiting.host, waiting.jobId], ["slot", "host-slot", "build3", jobId]);
    assert.ok(!JSON.stringify(planned).includes("SECRET"), "the job's data never leaves the planner");
    const done = await cancelQueuedJob({ url: URL_, jobId, expect: { queue: v.name, attemptsMade: 0, stalledCounter: 0 } });
    assert.deepEqual(done, { ok: true, jobId, queue: v.name, held: false });
    assert.equal(await v.queue.getJob(jobId), undefined);
    assert.equal(await v.redis.exists(deferKey(jobId)), 0, "its defer record went with it");
    // The planner, asked again, finds no such job.
    const gone = await planCancelQueued({ url: URL_, jobId, queue: v.name });
    assert.equal(gone.status, 404);
    assert.match(gone.refusal, new RegExp(`^no job ${jobId} in \\d+ queues?.*; nothing was changed$`));
  } finally {
    await v.done();
  }
});

test("a held job: the confirm leaves no wait:held member, no wait:job hash and no supersede lease", live, async () => {
  const v = await setup();
  try {
    const jobId = v.id("held");
    const dedupId = `acme/web#7:deploy#0-${tail()}`;
    v.lease(dedupId);
    await v.queue.add("github", forgeData(7), { jobId, delay: 60_000 });
    await v.redis.hset(`wait:job:${jobId}`, { since: String(Date.now() - 5000), target: "acme/web#7", label: "jira", dedupId });
    await v.redis.sadd("wait:held", jobId);
    await v.redis.set(`wait:key:${dedupId}`, jobId, "PX", 60_000);
    const planned = await planCancelQueued({ url: URL_, jobId, queue: v.name });
    assert.equal(planned.plan?.held, true, JSON.stringify(planned));
    assert.equal(planned.plan.waiting.held.label, "jira");
    assert.equal(planned.plan.waiting.bucket, "check", "held with no record: waiting on a check");
    const done = await cancelQueuedJob({ url: URL_, jobId, expect: { queue: v.name, attemptsMade: 0, stalledCounter: 0 } });
    assert.deepEqual(done, { ok: true, jobId, queue: v.name, held: true });
    assert.equal(await v.redis.sismember("wait:held", jobId), 0);
    assert.equal(await v.redis.exists(`wait:job:${jobId}`), 0);
    assert.equal(await v.redis.exists(`wait:key:${dedupId}`), 0);
    assert.equal(await v.queue.getJob(jobId), undefined);
  } finally {
    await v.done();
  }
});

test("refused, and nothing changes: a job waiting to retry, one handed back after a stall, a recovery, and the scheduler's next run", live, async () => {
  const v = await setup();
  try {
    // A real attempt: the worker throws once, BullMQ moves the job to delayed with its backoff.
    const retry = v.id("retry");
    await v.queue.add("github", forgeData(1), { jobId: retry, attempts: 2, backoff: { type: "fixed", delay: 60_000 } });
    let threw = false;
    const w = await v.worker(async () => {
      threw = true;
      throw new Error("infra");
    });
    await until(async () => threw && (await (await v.queue.getJob(retry)).getState()) === "delayed");
    await w.close();
    const stalled = v.id("stalled");
    await v.queue.add("github", forgeData(2), { jobId: stalled, delay: 60_000 });
    await v.redis.hset(`bull:${v.name}:${stalled}`, "stc", "1"); // test-only: BullMQ's own stall count, as a stall leaves it
    const recovery = `${v.id("run")}.r1`;
    await v.queue.add("github", forgeData(4, { recoveryOf: "gh-run-x", recovery: 1 }), { jobId: recovery, delay: 60_000 });
    const schedulerId = `cq-sched-${tail()}`;
    await v.queue.upsertJobScheduler(schedulerId, { every: 3_600_000 }, { name: "local", data: { kind: "local" } });
    await until(async () => (await v.queue.getJobCounts("waiting", "delayed")).waiting === 1);
    const [next] = await v.queue.getJobs(["waiting"]);
    const cases = [
      [retry, "delayed", cancelQueuedRefusal("retried", { jobId: retry, attempts: 1 })],
      [stalled, "delayed", cancelQueuedRefusal("stalled", { jobId: stalled })],
      [recovery, "delayed", cancelQueuedRefusal("recovery", { jobId: recovery, run: "gh-run-x" })],
      [next.id, "waiting", cancelQueuedRefusal("scheduled", { jobId: next.id, scheduler: schedulerId })],
    ];
    for (const [jobId, state, sentence] of cases) {
      assert.deepEqual(await planCancelQueued({ url: URL_, jobId, queue: v.name }), { refusal: sentence, status: 409 }, jobId);
      // The confirm re-checks the same rules, so a forged ticket for any of them changes nothing either.
      const job = await v.queue.getJob(jobId);
      const res = await cancelQueuedJob({ url: URL_, jobId, expect: { queue: v.name, attemptsMade: job.attemptsMade, stalledCounter: job.stalledCounter } });
      assert.deepEqual(res, { invalid: sentence }, `${jobId}: the confirm refuses too`);
      assert.equal(await job.getState(), state, `${jobId} is still queued`);
    }
  } finally {
    await v.done();
  }
});

test("a job a worker took between the preview and the confirm answers 'started since the preview', and runs on", live, async () => {
  const v = await setup();
  try {
    const jobId = v.id("taken");
    await v.queue.add("github", forgeData(5), { jobId });
    const planned = await planCancelQueued({ url: URL_, jobId, queue: v.name });
    assert.equal(planned.plan?.state, "waiting", JSON.stringify(planned));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await v.worker(async () => gate);
    await until(async () => (await (await v.queue.getJob(jobId)).getState()) === "active");
    const res = await cancelQueuedJob({ url: URL_, jobId, expect: { queue: planned.plan.queue, attemptsMade: 0, stalledCounter: 0 } });
    assert.deepEqual(res, { invalid: cancelQueuedRefusal("started", { jobId }) });
    assert.equal(await (await v.queue.getJob(jobId)).getState(), "active", "the run was not touched");
    release();
    await until(async () => (await (await v.queue.getJob(jobId)).getState()) === "completed");
  } finally {
    await v.done();
  }
});

test("the confirm re-finds the job: another queue or other counts is changed, counts that grew is started", live, async () => {
  const v = await setup();
  try {
    const jobId = v.id("moved");
    await v.queue.add("github", forgeData(6), { jobId, delay: 60_000 });
    const expect = { queue: v.name, attemptsMade: 0, stalledCounter: 0 };
    assert.deepEqual(await cancelQueuedJob({ url: URL_, jobId, expect: { ...expect, queue: "pi-jobs" } }), { invalid: cancelQueuedRefusal("changed", { jobId }) });
    assert.deepEqual(await cancelQueuedJob({ url: URL_, jobId, expect: { ...expect, attemptsMade: 1 } }), { invalid: cancelQueuedRefusal("changed", { jobId }) });
    await v.redis.hset(`bull:${v.name}:${jobId}`, "atm", "1");
    assert.deepEqual(await cancelQueuedJob({ url: URL_, jobId, expect }), { invalid: cancelQueuedRefusal("started", { jobId }) }, "an attempt made since the preview");
    await v.redis.hset(`bull:${v.name}:${jobId}`, "atm", "0", "stc", "1");
    assert.deepEqual(await cancelQueuedJob({ url: URL_, jobId, expect }), { invalid: cancelQueuedRefusal("started", { jobId }) }, "a stall since the preview");
    assert.notEqual(await v.queue.getJob(jobId), undefined, "still queued");
  } finally {
    await v.done();
  }
});

test("each removeQueuedJob answer in the console's words: a lock is started, another throw is named, a removal that does not answer may have landed", live, async () => {
  const v = await setup();
  try {
    const jobId = v.id("seam");
    await v.queue.add("github", forgeData(8), { jobId, delay: 60_000 });
    const expect = { queue: v.name, attemptsMade: 0, stalledCounter: 0 };
    const seen = [];
    const answer = (res) => async (args) => {
      // The guard asked while the confirm holds its clients, as the worker's sequence asks it.
      seen.push({ ...args, verdict: seen.length === 0 ? await args.guard(args.job) : undefined });
      if (typeof res === "function") return res();
      return res;
    };
    const run = (res, extra = {}) => cancelQueuedJob({ url: URL_, jobId, expect, removeQueuedJobFn: answer(res), ...extra });
    assert.deepEqual(await run({ raced: true, state: "active", error: new Error("locked") }), { invalid: cancelQueuedRefusal("started", { jobId }) });
    assert.deepEqual(await run({ raced: true, state: "delayed", error: new Error(`Job ${jobId} belongs to a job scheduler and cannot be removed directly. remove`) }), { invalid: `job ${jobId} could not be removed: it is delayed now, and the remove failed with: Job ${jobId} belongs to a job scheduler and cannot be removed directly. remove; nothing was changed` });
    assert.deepEqual(await run({ notQueued: true, state: "completed" }), { invalid: cancelQueuedRefusal("started", { jobId }) });
    assert.deepEqual(await run({ notQueued: true, state: "waiting-children" }), { invalid: cancelQueuedRefusal("notQueued", { jobId, state: "waiting-children" }) });
    assert.deepEqual(await run({ invalid: "job x is not waiting on a condition" }), { invalid: "job x is not waiting on a condition" });
    assert.deepEqual(await run({ ok: true, held: false, jobId, state: "delayed", attemptsMade: 0 }), { ok: true, jobId, queue: v.name, held: false });
    // The bound covers the removal's first reads as well as its writes, so its answer says the removal was asked for and
    // may have landed, never that it was sent: a removal that hangs in its first read sent nothing.
    const unanswered = `the removal of job ${jobId} was asked for and not answered within the bound, so it may or may not have landed; look at the fleet to see whether the job is still queued`;
    assert.deepEqual(await run(() => new Promise(() => {}), { timeoutMs: 1500 }), { invalid: unanswered, partial: true }, "a removal that hangs is not 'unreachable, nothing was changed'");
    // A throw, or an answer this does not know, is no timeout: it may have landed, in words that say only that.
    const unread = `the removal of job ${jobId} answered in a way this console cannot read, so it may or may not have landed; look at the fleet to see whether the job is still queued`;
    assert.deepEqual(await run(() => { throw new Error("bug"); }), { invalid: unread, partial: true });
    assert.deepEqual(await run({ weird: true }), { invalid: unread, partial: true });
    assert.deepEqual(await run(undefined), { invalid: unread, partial: true });
    // A remove that threw and a job that could not be read back: the remove may have landed.
    assert.deepEqual(await run({ raced: true, state: "unknown", error: new Error("Connection is closed.") }), { invalid: `the removal of job ${jobId} failed (Connection is closed.) and the job could not be read back, so it may or may not have been removed; look at the fleet to see whether the job is still queued`, partial: true });
    // The guard refused before anything was sent: its words, and nothing was changed.
    assert.deepEqual(await run({ refused: cancelQueuedRefusal("started", { jobId }) }), { invalid: cancelQueuedRefusal("started", { jobId }) });
    assert.deepEqual(await run({ refused: null, error: new Error("ECONNRESET") }), { invalid: `job ${jobId} could not be read again right before its removal, so it was not removed; nothing was changed` });
    // A held job whose removal failed after its hold was cleared: partial, from the job's state read again (here still
    // delayed, the seam having removed nothing), and never BullMQ's words.
    const locked = `Job ${jobId} could not be removed because it is locked by another worker`;
    const cleared = await run({ invalid: locked, cleared: true });
    assert.deepEqual(cleared, heldClearedAnswer(jobId, "delayed"));
    assert.equal(cleared.partial, true);
    assert.ok(!cleared.invalid.includes("locked by another worker") && !/nothing was changed/i.test(cleared.invalid), cleared.invalid);
    // Another module's words are bounded on the way out: control bytes made spaces, at most 200 characters.
    const long = `x\u001b[2Jy${"z".repeat(300)}`;
    const raced = await run({ raced: true, state: "delayed", error: new Error(long) });
    assert.equal(raced.invalid, `job ${jobId} could not be removed: it is delayed now, and the remove failed with: ${`x [2Jy${"z".repeat(300)}`.slice(0, 200)}; nothing was changed`);
    assert.deepEqual(await run({ invalid: long }), { invalid: `x [2Jy${"z".repeat(300)}`.slice(0, 200) });
    // The sequence is handed the job the confirm found, on its queue, with the state it read, and the guard.
    assert.deepEqual([seen[0].jobId, seen[0].queue.name, seen[0].job.id, seen[0].state, typeof seen[0].guard], [jobId, v.name, jobId, "delayed", "function"]);
    assert.equal(seen[0].verdict, null, "the guard of a job that has not moved lets the removal go");
    assert.notEqual(await v.queue.getJob(jobId), undefined, "the seam removed nothing");
    // A job the re-checks read as held: the answer that cannot say what landed names its hold too, whose keys go first.
    await v.redis.hset(`wait:job:${jobId}`, { since: String(Date.now() - 1000), label: "jira" });
    assert.deepEqual(await run(() => new Promise(() => {}), { timeoutMs: 1500 }), { invalid: `the removal of job ${jobId} and its hold was asked for and not answered within the bound, so its hold, or the job, may or may not be gone; look at the fleet to see whether the job is still queued`, partial: true });
    assert.deepEqual(await run({ weird: true }), { invalid: `the removal of job ${jobId} and its hold answered in a way this console cannot read, so its hold, or the job, may or may not be gone; look at the fleet to see whether the job is still queued`, partial: true });
  } finally {
    await v.done();
  }
});

test("the confirm reads the job again right before the removal: one a worker finished, or failed back to the delayed set, since its checks is refused as started and stays", live, async () => {
  const v = await setup();
  try {
    // A worker takes the job and finishes it between the confirm's checks and the removal. BullMQ's remove checks only
    // the lock and the scheduler, so without the fresh read it would remove the finished job and answer ok.
    const finished = v.id("finished");
    await v.queue.add("github", forgeData(11), { jobId: finished });
    const expect = { queue: v.name, attemptsMade: 0, stalledCounter: 0 };
    const finishFirst = async (args) => {
      const w = await v.worker(async () => "done");
      await until(async () => (await v.queue.getJobState(finished)) === "completed");
      await w.close();
      return removeQueuedJob(args);
    };
    assert.deepEqual(await cancelQueuedJob({ url: URL_, jobId: finished, expect, removeQueuedJobFn: finishFirst }), { invalid: cancelQueuedRefusal("started", { jobId: finished }) });
    assert.equal(await v.queue.getJobState(finished), "completed", "the finished job was not removed");
    // A job that made an attempt and went back to the delayed set to retry: its attempt count moved.
    const retried = v.id("retried");
    await v.queue.add("github", forgeData(12), { jobId: retried, delay: 60_000 });
    const attemptFirst = async (args) => {
      await v.redis.hset(`bull:${v.name}:${retried}`, "atm", "1"); // test-only: the count a failed attempt leaves
      return removeQueuedJob(args);
    };
    assert.deepEqual(await cancelQueuedJob({ url: URL_, jobId: retried, expect, removeQueuedJobFn: attemptFirst }), { invalid: cancelQueuedRefusal("started", { jobId: retried }) });
    assert.notEqual(await v.queue.getJob(retried), undefined, "still queued");
    // A finish instant on a job read back as waiting: it finished an attempt since.
    const stamped = v.id("stamped");
    await v.queue.add("github", forgeData(13), { jobId: stamped, delay: 60_000 });
    const stampFirst = async (args) => {
      await v.redis.hset(`bull:${v.name}:${stamped}`, "finishedOn", String(Date.now()));
      return removeQueuedJob(args);
    };
    assert.deepEqual(await cancelQueuedJob({ url: URL_, jobId: stamped, expect, removeQueuedJobFn: stampFirst }), { invalid: cancelQueuedRefusal("started", { jobId: stamped }) });
    assert.notEqual(await v.queue.getJob(stamped), undefined);
  } finally {
    await v.done();
  }
});

test("a job a worker locks between the fresh read and the remove is started, and runs on: BullMQ's remove refused it, so nothing was changed", live, async () => {
  const v = await setup();
  try {
    const jobId = v.id("locked");
    await v.queue.add("github", forgeData(14), { jobId });
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const lockAfterRead = (args) =>
      removeQueuedJob({
        ...args,
        guard: async (job) => {
          const verdict = await args.guard(job);
          await v.worker(async () => gate);
          await until(async () => (await v.queue.getJobState(jobId)) === "active");
          return verdict;
        },
      });
    const res = await cancelQueuedJob({ url: URL_, jobId, expect: { queue: v.name, attemptsMade: 0, stalledCounter: 0 }, removeQueuedJobFn: lockAfterRead });
    assert.deepEqual(res, { invalid: cancelQueuedRefusal("started", { jobId }) }, "true: the remove is one script and the job is still there");
    assert.equal(await v.queue.getJobState(jobId), "active");
    release();
    await until(async () => (await v.queue.getJobState(jobId)) === "completed");
  } finally {
    await v.done();
  }
});

test("a held job a worker locks during its removal: its hold was cleared, so the answer is partial and started, never BullMQ's words or 'nothing was changed'", live, async () => {
  const v = await setup();
  try {
    const jobId = v.id("held-locked");
    await v.queue.add("github", forgeData(15), { jobId, delay: 60_000 });
    await v.redis.hset(`wait:job:${jobId}`, { since: String(Date.now() - 5000), label: "jira" });
    await v.redis.sadd("wait:held", jobId);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    // The job's due comes and a worker takes it just as removeHeldJob, its hold already cleared, asks BullMQ to remove it.
    const lockingQueue = (q) => ({
      ...q,
      name: q.name,
      async getJob(id) {
        const job = await q.getJob(id);
        if (!job) return job;
        const remove = job.remove.bind(job);
        job.remove = async (...a) => {
          await job.promote();
          await v.worker(async () => gate);
          await until(async () => (await v.queue.getJobState(jobId)) === "active");
          return remove(...a);
        };
        return job;
      },
    });
    const res = await cancelQueuedJob({ url: URL_, jobId, expect: { queue: v.name, attemptsMade: 0, stalledCounter: 0 }, removeQueuedJobFn: (args) => removeQueuedJob({ ...args, queue: lockingQueue(args.queue) }) });
    assert.deepEqual(res, heldClearedAnswer(jobId, "active"));
    assert.equal(res.partial, true);
    assert.match(res.invalid, new RegExp(`^job ${jobId} started while its hold was being cleared`));
    assert.ok(!/locked by another worker|nothing was changed/i.test(res.invalid), res.invalid);
    assert.equal(await v.redis.exists(`wait:job:${jobId}`), 0, "the hold was cleared, as the answer says");
    assert.equal(await v.redis.sismember("wait:held", jobId), 0);
    assert.equal(await v.queue.getJobState(jobId), "active", "and the job was not removed");
    release();
    await until(async () => (await v.queue.getJobState(jobId)) === "completed");
  } finally {
    await v.done();
  }
});

test("the planner refuses by the never-started rules in their order, and reads hostile counts and a hostile recovery as BullMQ does", live, async () => {
  const v = await setup();
  try {
    // A first attempt running now: not waiting to start, 409.
    const active = v.id("active");
    await v.queue.add("github", forgeData(21), { jobId: active });
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    await v.worker(async () => gate);
    await until(async () => (await v.queue.getJobState(active)) === "active");
    assert.deepEqual(await planCancelQueued({ url: URL_, jobId: active, queue: v.name }), { refusal: cancelQueuedRefusal("notQueued", { jobId: active, state: "active" }), status: 409 });
    release();
    await until(async () => (await v.queue.getJobState(active)) === "completed");
    const delayed = async (what, fields, data = {}) => {
      const jobId = v.id(what);
      await v.queue.add("github", forgeData(22, data), { jobId, delay: 60_000 });
      if (Object.keys(fields).length > 0) await v.redis.hset(`bull:${v.name}:${jobId}`, fields); // test-only: the counts as found
      return jobId;
    };
    const cases = [
      // Both an attempt and a stall: the attempt is the more useful sentence, said first.
      [await delayed("both", { atm: "1", stc: "1" }), (jobId) => cancelQueuedRefusal("retried", { jobId, attempts: 1 })],
      // A count BullMQ reads as NaN is no count the console can call none: refused, an attempt or a stall as the field says.
      [await delayed("nan-atm", { atm: "abc" }), (jobId) => cancelQueuedRefusal("retried", { jobId, attempts: 1 })],
      [await delayed("nan-stc", { stc: "abc" }), (jobId) => cancelQueuedRefusal("stalled", { jobId })],
      // A recovery whose run id is markup is named by words, never by the id.
      [await delayed("markup-run", {}, { recoveryOf: "<b>gh</b>", recovery: 1 }), (jobId) => cancelQueuedRefusal("recovery", { jobId, run: "an earlier run" })],
    ];
    for (const [jobId, sentence] of cases) {
      assert.deepEqual(await planCancelQueued({ url: URL_, jobId, queue: v.name }), { refusal: sentence(jobId), status: 409 }, jobId);
      assert.notEqual(await v.queue.getJob(jobId), undefined);
    }
  } finally {
    await v.done();
  }
});

test("a queue whose close never settles: the preview and the confirm still answer within their bound", async () => {
  // The fleet discovery answers (an empty registry, no host queues); the queue answers its reads and never its close,
  // as BullMQ's QUIT does on a socket Valkey stopped answering on.
  const redisFn = () => ({ on() {}, async smembers() { return []; }, async scan() { return ["0", []]; }, async zscore() { return null; }, async hget() { return null; }, pipeline: undefined, disconnect() {} });
  const closes = [];
  const job = { id: "gh-1", name: "github", data: { kind: "github", repo: "acme/web", target: { type: "issue", number: 1 } }, attemptsMade: 0, stalledCounter: 0, async getState() { return "delayed"; } };
  const queueFn = (getJob) => (_c, { name }) => ({ name, toKey: (type) => `bull:${name}:${type}`, getJob, close: () => (closes.push(name), new Promise(() => {})) });
  const timeoutMs = 300;
  const bounded = async (promise) => {
    const t0 = Date.now();
    let timer;
    const res = await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve("hung"), 5_000)))]);
    clearTimeout(timer);
    return { res, ms: Date.now() - t0 };
  };
  const common = { url: "redis://x", redisFn, parseConnectionFn: () => ({}), timeoutMs };
  const expect = { queue: "pi-jobs", attemptsMade: 0, stalledCounter: 0 };
  for (const [what, getJob, wantPlan, wantConfirm] of [
    ["a job no queue holds", async () => undefined, (r) => r.status === 404, (r) => r.invalid === cancelQueuedRefusal("changed", { jobId: "gh-1" })],
    ["a lookup that never answers", () => new Promise(() => {}), (r) => r.unreachable !== undefined, (r) => r.unreachable !== undefined],
    ["a job that is removed", async () => job, (r) => r.plan?.jobId === "gh-1", (r) => r.ok === true],
  ]) {
    const plan = await bounded(planCancelQueued({ ...common, jobId: "gh-1", queueFn: queueFn(getJob) }));
    assert.notEqual(plan.res, "hung", `${what}: the preview answered`);
    assert.ok(wantPlan(plan.res) && plan.ms < timeoutMs * 3, `${what}: ${JSON.stringify(plan.res)} in ${plan.ms} ms`);
    const confirm = await bounded(cancelQueuedJob({ ...common, jobId: "gh-1", expect, queueFn: queueFn(getJob), removeQueuedJobFn: async () => ({ ok: true, held: false }) }));
    assert.notEqual(confirm.res, "hung", `${what}: the confirm answered`);
    assert.ok(wantConfirm(confirm.res) && confirm.ms < timeoutMs * 3, `${what}: ${JSON.stringify(confirm.res)} in ${confirm.ms} ms`);
  }
  assert.ok(closes.length >= 6, `every queue opened was asked to close (${closes.length})`);
});

test("a Valkey that does not answer before the removal is sent is unreachable: nothing was changed", async () => {
  // The fleet discovery answers (an empty registry, no host queues), and the job lookup never does.
  const redisFn = () => ({ on() {}, async smembers() { return []; }, async scan() { return ["0", []]; }, disconnect() {} });
  const closed = [];
  const queueFn = (_c, { name }) => ({ name, getJob: () => new Promise(() => {}), async close() { closed.push(name); } });
  const removeQueuedJobFn = () => {
    throw new Error("the removal must not be reached");
  };
  const alive = setInterval(() => {}, 1000); // the bound's timer is unref'd; a real client's socket would hold the loop
  try {
    assert.deepEqual(await planCancelQueued({ url: "redis://x", jobId: "gh-1", redisFn, queueFn, parseConnectionFn: () => ({}), timeoutMs: 50 }), { unreachable: "timed out reaching the queue" });
    assert.deepEqual(await cancelQueuedJob({ url: "redis://x", jobId: "gh-1", expect: { queue: "pi-jobs", attemptsMade: 0, stalledCounter: 0 }, redisFn, queueFn, parseConnectionFn: () => ({}), removeQueuedJobFn, timeoutMs: 50 }), { unreachable: "timed out reaching the queue" });
    assert.deepEqual(closed, ["pi-jobs", "pi-jobs"], "each queue opened is closed, though its lookup never answered");
  } finally {
    clearInterval(alive);
  }
});

// --- the funnel's own guards, on fakes ------------------------------------------------------------------------------

/** A client whose fleet discovery finds an empty registry and no host queues, and whose other reads find nothing. */
const quietRedis = (over = {}) => ({ on() {}, async smembers() { return []; }, async scan() { return ["0", []]; }, async zscore() { return null; }, async hget() { return null; }, async hgetall() { return {}; }, pipeline: undefined, disconnect() {}, ...over });
/** A job that never started, delayed. */
const quietJob = (over = {}) => ({ id: "gh-1", name: "github", data: { kind: "github", repo: "acme/web", target: { type: "issue", number: 1 } }, attemptsMade: 0, stalledCounter: 0, async getState() { return "delayed"; }, async remove() {}, ...over });
const onFakes = { url: "redis://x", jobId: "gh-1", parseConnectionFn: () => ({}), timeoutMs: 200 };
const asPreviewed = { queue: "pi-jobs", attemptsMade: 0, stalledCounter: 0 };
/** `promise`, or "hung" when it has not settled within `ms`. */
async function settledWithin(promise, ms = 5_000) {
  let timer;
  const res = await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve("hung"), ms)))]);
  clearTimeout(timer);
  return res;
}

test("a queue whose close rejects: the preview and the confirm answer, and no rejection reaches the process", async () => {
  const seen = [];
  const onRejection = (reason) => seen.push(String(reason));
  process.on("unhandledRejection", onRejection);
  try {
    // BullMQ's close rethrows an error that is not a connection's.
    const queueFn = (_c, { name }) => ({ name, toKey: (type) => `bull:${name}:${type}`, getJob: async () => quietJob(), close: async () => { throw new Error("ERR close refused"); } });
    const plan = await planCancelQueued({ ...onFakes, redisFn: () => quietRedis(), queueFn });
    assert.equal(plan.plan?.jobId, "gh-1", JSON.stringify(plan));
    const done = await cancelQueuedJob({ ...onFakes, expect: asPreviewed, redisFn: () => quietRedis(), queueFn, removeQueuedJobFn: async () => ({ ok: true, held: false }) });
    assert.deepEqual(done, { ok: true, jobId: "gh-1", queue: "pi-jobs", held: false });
    await sleep(50);
    assert.deepEqual(seen, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("every raw client the preview and the confirm make is disconnected, whatever they answer", async () => {
  const made = [];
  const redisFn = () => {
    const client = quietRedis({ disconnect() { client.disconnects += 1; } });
    client.disconnects = 0;
    made.push(client);
    return client;
  };
  const queueFn = (_c, { name }) => ({ name, toKey: (type) => `bull:${name}:${type}`, getJob: async () => quietJob(), close: async () => {} });
  assert.equal((await planCancelQueued({ ...onFakes, redisFn, queueFn })).plan?.jobId, "gh-1");
  assert.equal((await cancelQueuedJob({ ...onFakes, expect: asPreviewed, redisFn, queueFn, removeQueuedJobFn: async () => ({ ok: true, held: false }) })).ok, true);
  // The discovery's own client, and the one each action reads the job's keys on.
  assert.equal(made.length, 4);
  assert.deepEqual(made.map((c) => c.disconnects >= 1), [true, true, true, true], "each was disconnected");
});

test("a lookup that outlasts the bound: the queue it opens after the bound is closed once it settles, in the preview and the confirm", async () => {
  const T = 200;
  for (const which of ["preview", "confirm"]) {
    const opened = [];
    const closed = [];
    // A host queue the keyspace holds, asked after the shared queue, whose lookup takes twice the bound.
    const redisFn = () => quietRedis({ async scan() { return ["0", ["bull:pi-jobs@h1:meta"]]; } });
    const queueFn = (_c, { name }) => {
      opened.push(name);
      return { name, toKey: (type) => `bull:${name}:${type}`, getJob: async () => (name === "pi-jobs" ? (await sleep(2 * T), undefined) : quietJob()), close: async () => closed.push(name) };
    };
    const res = which === "preview" ? await planCancelQueued({ ...onFakes, redisFn, queueFn, timeoutMs: T }) : await cancelQueuedJob({ ...onFakes, expect: asPreviewed, redisFn, queueFn, removeQueuedJobFn: async () => ({ ok: true, held: false }), timeoutMs: T });
    assert.equal(res.unreachable, "timed out reaching the queue", which);
    await sleep(5 * T);
    assert.deepEqual(opened, ["pi-jobs", "pi-jobs@h1"], `${which}: the second queue was opened after the bound`);
    assert.deepEqual([...closed].sort(), [...opened].sort(), `${which}: every queue opened was closed once the read settled`);
  }
});

test("the read right before the removal: a job gone is changed, a read that throws refuses, and a job that fails back between its state and its hash is started; none is removed", async () => {
  // The job is gone when the guard looks again: changed since the preview, never a removal of nothing.
  let gets = 0;
  let removed = 0;
  const gone = quietJob({ async remove() { removed += 1; } });
  const goneQueue = (_c, { name }) => ({ name, toKey: (type) => `bull:${name}:${type}`, getJob: async () => (++gets === 1 ? gone : undefined), close: async () => {} });
  assert.deepEqual(await cancelQueuedJob({ ...onFakes, expect: asPreviewed, redisFn: () => quietRedis(), queueFn: goneQueue, removeQueuedJobFn: removeQueuedJob }), { invalid: cancelQueuedRefusal("changed", { jobId: "gh-1" }) });
  assert.equal(removed, 0);
  // The guard's own state read throws: nothing has been sent, so it refuses and says nothing changed.
  let states = 0;
  const unread = quietJob({ async getState() { if (++states >= 2) throw new Error("ECONNRESET"); return "delayed"; }, async remove() { removed += 1; } });
  const unreadQueue = (_c, { name }) => ({ name, toKey: (type) => `bull:${name}:${type}`, getJob: async () => unread, close: async () => {} });
  assert.deepEqual(await cancelQueuedJob({ ...onFakes, expect: asPreviewed, redisFn: () => quietRedis(), queueFn: unreadQueue, removeQueuedJobFn: removeQueuedJob }), { invalid: "job gh-1 could not be read again right before its removal, so it was not removed; nothing was changed" });
  assert.equal(removed, 0);
  // The job fails back to the delayed set (an attempt made) just after the guard reads its state: the hash read after
  // it sees the attempt. Read the other way round, the hash would be from before and the state from after.
  let calls = 0;
  let failedBack = false;
  const racing = quietJob({
    async getState() {
      calls += 1;
      if (calls === 2) setImmediate(() => (failedBack = true));
      await sleep(5);
      return "delayed";
    },
    async remove() { removed += 1; },
  });
  let reads = 0;
  const racingQueue = (_c, { name }) => ({ name, toKey: (type) => `bull:${name}:${type}`, getJob: async () => (++reads === 1 ? racing : { ...racing, attemptsMade: failedBack ? 1 : 0 }), close: async () => {} });
  assert.deepEqual(await cancelQueuedJob({ ...onFakes, expect: asPreviewed, redisFn: () => quietRedis(), queueFn: racingQueue, removeQueuedJobFn: removeQueuedJob }), { invalid: cancelQueuedRefusal("started", { jobId: "gh-1" }) });
  assert.equal(removed, 0);
});

test("a held job whose hold was cleared and whose state never answers again: the confirm still answers within its bound, partial", async () => {
  let states = 0;
  const job = quietJob({ getState: () => (++states === 1 ? Promise.resolve("delayed") : new Promise(() => {})) });
  const queueFn = (_c, { name }) => ({ name, toKey: (type) => `bull:${name}:${type}`, getJob: async () => job, close: async () => {} });
  const alive = setInterval(() => {}, 1000); // the bound's timer is unref'd; a real client's socket would hold the loop
  try {
    const res = await settledWithin(cancelQueuedJob({ ...onFakes, expect: asPreviewed, redisFn: () => quietRedis(), queueFn, removeQueuedJobFn: async () => ({ invalid: "locked", cleared: true }) }));
    assert.deepEqual(res, heldClearedAnswer("gh-1", "unknown"));
  } finally {
    clearInterval(alive);
  }
});
