// Issue #961 against a LIVE Valkey (VALKEY_TEST_URL, required in CI) that stops answering, as `kill -STOP` leaves it:
// through a proxy that holds the bytes both ways and passes them on a thaw. Each paid enqueue is stopped at its add and
// before its connect, the allowance at its count, Fire now at its latch, the package facts at a canary's read, and the
// budget writes at their own command. After the thaw the number of jobs is what the sentence allowed: none where it
// said nothing was queued, none or one where it said may or may not.
// Issue #987 adds what a forge enqueue says before its add was ever sent: through a forwarder that takes the connection
// and closes it, with an approval that is no longer the pending one, and with the queue an approval is routed to
// stopped at its connect. And the budget writes: a plan stopped at its first read, a revert stopped at its
// compare-and-set (one bound, and what it leaves to be seen), and two plans racing on one basis. And a held job's
// cancel, which leaves no connection open behind its answer on a Valkey that stopped answering.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect as netConnect, createServer } from "node:net";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeQueue } from "@edgehero/pi-dispatch/queue";
import { publishLook, updatesCanaryKey } from "@edgehero/pi-dispatch/updates";
import { makeQuestionGroupStore } from "@edgehero/pi-dispatch/question-groups";
import { approvalTargetKey, makeApprovalStore } from "@edgehero/pi-dispatch/approval-state";
import { freezingProxy } from "../../worker/test/helpers/freezing-proxy.mjs";
import { commandOn, trippingProxy } from "./helpers/tripping-proxy.mjs";
import { closingForwarder } from "./helpers/closing-forwarder.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { DISPATCH_RUN_COUNT_SCRIPT, QUEUE_CLOSE_TIMEOUT_MS, applyPriorities, cancelHeldJob, cancelQueuedJob, checkDispatchRun, enqueueDispatchRun, enqueueParkedAnswer, enqueueRerun, envelopeDigestUnconfirmed, planCancelQueued, planEnvelopeWrite, planParkedAnswer, planRerun, readAllocations, readEnvelope, revertAllocation, writeEnvelope } from "../src/read-model.mjs";
import { makeAllocationState } from "@edgehero/pi-dispatch/allocation";
import { historyBehind } from "../src/render.mjs";
import { APPROVAL_NOT_PENDING, CONNECT_ENDED, dispatchRunAlready, enqueueUnconfirmed } from "../src/job-actions.mjs";
import { enqueueTriggerFire, FIRE_UNCONFIRMED, planTriggerFire } from "../src/trigger-fire.mjs";
import { readUpdates } from "../src/updates-view.mjs";
import { GROUP_STATUS_UNANSWERED, GROUP_UNCONFIRMED, makeZeroTouchService } from "../src/zero-touch-data.mjs";

const VALKEY = process.env.VALKEY_TEST_URL;
// CI sets this, which turns a missing URL into a failure rather than a quiet skip.
if (!VALKEY && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS) throw new Error("bounded-requests.valkey.test REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS is set");
const live = { skip: VALKEY ? false : "needs VALKEY_TEST_URL (CI sets it)", timeout: 120_000 };

// Database 3, shared with the receiver's steer test: every queue, key and run id here carries a tag of its own, and
// each test deletes what it wrote and never flushes.
const databaseUrl = () => {
  const url = new URL(VALKEY);
  url.pathname = "/3";
  return url.href;
};

// The clients' command bound is shortened here (the console's is 5 s), and so is a connect's; everything else is the
// real functions, BullMQ and ioredis.
const BOUND = 400;
const CONNECT = 600;
const boundedHere = (url, options = {}) => parseConnection(url, { ...options, ...(options.commandTimeoutMs ? { commandTimeoutMs: BOUND } : {}) });
const clientHere = (url, options = {}) => makeRedisClient(url, { ...options, ...(options.commandTimeoutMs ? { commandTimeoutMs: BOUND } : {}) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** An answer and how long it took; a throw is its answer too. */
const clocked = async (promise) => {
  const t0 = Date.now();
  const res = await promise.then((value) => value, (error) => ({ thrown: error }));
  return { res, ms: Date.now() - t0 };
};
const stoppedAt = (frozen) => Promise.race([frozen.then(() => "stopped"), sleep(1000).then(() => "never sent")]);

/** One test's own corner of the database: a tag, a direct client, direct queues, and the deletion of what it wrote. */
async function scene(issue = "t961") {
  const url = databaseUrl();
  const tag = `${issue}-${randomBytes(5).toString("hex")}`;
  const redis = makeRedisClient(url, {});
  const closers = [];
  const patterns = [`bull:pi-jobs@${tag}:*`, `*${tag}*`];
  return {
    url, tag, redis,
    queueName: `pi-jobs@${tag}`,
    queue(name = `pi-jobs@${tag}`) {
      const q = makeQueue(parseConnection(url, { failFast: true }), { name });
      closers.push(() => q.close().catch(() => {}));
      return q;
    },
    /** How many jobs `name` holds in any state, read on a connection the proxy is not on. */
    async jobs(name = `pi-jobs@${tag}`) {
      const counts = await this.queue(name).getJobCounts();
      return Object.values(counts).reduce((n, c) => n + c, 0);
    },
    own(...more) {
      patterns.push(...more);
    },
    onDone(fn) {
      closers.push(fn);
    },
    async done() {
      // Until none is left: a closer may open a queue of its own to remove a job.
      while (closers.length > 0) for (const close of closers.splice(0).reverse()) await Promise.resolve().then(close).catch(() => {});
      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) await redis.del(...keys);
      }
      redis.disconnect();
    },
  };
}

// BullMQ's add as it leaves: an EVAL of its add script, whose text fills the first chunks (the job's own arguments come
// in a later one), so the stop is at the script's first bytes and the whole command is held.
const THE_ADD = /\r\n\$4\r\neval\r\n\$\d+\r\n--\[\[\s+Adds a (?:\w+ )?job/i;

/** The three paid enqueues that take a plan or fields: each as `(scene, url) => answer`, its add's own bytes, and its name. */
const ENQUEUES = [
  {
    name: "a re-run", what: (s) => `the re-run of local-${s.tag}`,
    run: (s, url, extra = {}) => enqueueRerun({ kind: "local", jobId: `local-${s.tag}`, queue: s.queueName, job: { folder: `/srv/${s.tag}`, flow: "fix", task: "t" } }, { url, parseConnectionFn: boundedHere, localRepoProblemFn: () => null, gitDirtyFn: () => false, ...extra }),
  },
  {
    name: "a parked answer", what: (s) => `the answer to gh-${s.tag}`,
    run: (s, url, extra = {}) => enqueueParkedAnswer({
      kind: "parked-answer", jobId: `gh-${s.tag}`, forge: "github", queue: s.queueName,
      job: { repo: `acme/${s.tag}`, target: { type: "issue", number: 7, title: "t", body: "b" }, flow: "fix", resume: true, parkedReply: true, console: { by: "ops" }, trigger: { event: "issue_comment", action: "created", deliveryId: "console-0123456789abcdef", sender: { id: null }, matched: { index: 0, type: "comment", phrase: "/pi" }, comment: { body: "yes" } } },
    }, { url, parseConnectionFn: boundedHere, ...extra }),
  },
  {
    name: "a dispatch run", what: () => "the run",
    run: (s, url, extra = {}) => enqueueDispatchRun({ folder: `/srv/${s.tag}`, flow: "fix", task: "t", aiInvoked: false, env: { VALKEY_URL: url, PI_WORKER_NAME: s.tag }, parseConnectionFn: boundedHere, gitDirtyFn: () => false, localRepoProblemFn: () => null, ...extra }),
  },
];

for (const enqueue of ENQUEUES) {
  test(`${enqueue.name} on a Valkey that stops answering at its add says may or may not, within the client's bound, and at most one job is there after the wake (#961)`, live, async () => {
    const s = await scene();
    const proxy = await trippingProxy(s.url);
    try {
      const frozen = proxy.freezeAt(THE_ADD);
      const got = await clocked(enqueue.run(s, proxy.url));
      assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at the add");
      assert.deepEqual(got.res, enqueueUnconfirmed(enqueue.what(s)), JSON.stringify(got.res?.thrown?.message ?? got.res));
      assert.ok(got.ms < BOUND + 2500, `the client's bound decided, not a wait for Valkey (${got.ms} ms)`);
      assert.equal(await s.jobs(), 0, "nothing reached Valkey while it did not answer");
      proxy.thaw();
      await sleep(700);
      const after = await s.jobs();
      assert.ok(after === 0 || after === 1, `none or one after the wake, never two (${after})`);
    } finally {
      proxy.close();
      await s.done();
    }
  });

  test(`${enqueue.name} on a Valkey that answers no connection says nothing was queued within the connect bound, and nothing is queued after the wake (#961)`, live, async () => {
    const s = await scene();
    const proxy = await freezingProxy(s.url);
    try {
      proxy.freeze();
      const got = await clocked(enqueue.run(s, proxy.url, { connectTimeoutMs: CONNECT }));
      assert.deepEqual(got.res, { unreachable: `the queue did not connect within ${CONNECT / 1000} seconds; nothing was queued` }, JSON.stringify(got.res?.thrown?.message ?? got.res));
      assert.ok(got.ms < CONNECT + 2000, `${got.ms} ms`);
      proxy.thaw();
      await sleep(1500);
      assert.equal(await s.jobs(), 0, "nothing was sent, and nothing is sent when the connection comes up");
    } finally {
      proxy.close();
      await s.done();
    }
  });
}

// Any script as it leaves, by its text or by its digest: BullMQ's add is one of them, and so is every other write of a queue.
const ANY_SCRIPT = /\r\n\$(?:4\r\neval|7\r\nevalsha)\r\n/i;

/** A forge job as the console builds one for an issue of this test's own repository. */
const forgeJob = (s, extra = {}) => ({ repo: `acme/${s.tag}`, target: { type: "issue", number: 7, title: "t", body: "b" }, flow: "fix", trigger: { event: "issue_comment", action: "created", deliveryId: "console-0123456789abcdef", sender: { id: null }, matched: { index: 0, type: "comment", phrase: "/pi" }, comment: { body: "yes" } }, ...extra });

/** The two forge enqueues of the console, each as `(scene, url, extra) => answer` (a re-run of a forge job, a parked answer). */
const FORGE_ENQUEUES = [
  ["a parked answer", (s, url, extra = {}) => enqueueParkedAnswer({ kind: "parked-answer", jobId: `gh-${s.tag}`, forge: "github", queue: s.queueName, job: forgeJob(s, { resume: true, parkedReply: true, console: { by: "ops" } }) }, { url, ...extra })],
  ["a forge re-run", (s, url, extra = {}) => enqueueRerun({ kind: "forge", forge: "github", jobId: `gh-${s.tag}`, deliveryId: "console-0123456789abcdef", queue: s.queueName, job: forgeJob(s) }, { url, ...extra })],
];

for (const [name, run] of FORGE_ENQUEUES) {
  test(`${name} through a forwarder that takes each connection and closes it says nothing was queued, at once, with no add on the wire (#987)`, live, async () => {
    const s = await scene("t987");
    // The console's own command bound here, never this file's short one: nothing waits on it, and a short one ends the
    // connect with a command that timed out before the client has run out of retries, which is another answer.
    const forwarder = await closingForwarder(s.url);
    try {
      // Three times, as a person who tries again: the answer is the same each time.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const got = await clocked(run(s, forwarder.url));
        assert.deepEqual(got.res, { unreachable: CONNECT_ENDED }, `attempt ${attempt}: ${JSON.stringify(got.res?.thrown?.message ?? got.res)}`);
        assert.ok(got.ms < 1500, `attempt ${attempt}: ${got.ms} ms`);
      }
      const sent = forwarder.bytes();
      assert.ok(forwarder.connections() >= 3 && /\r\n\$6\r\nselect\r\n/i.test(sent), "the queue's client reached the forwarder and greeted it each time");
      assert.equal(THE_ADD.test(sent), false, "no add left the console");
      assert.equal(ANY_SCRIPT.test(sent), false, "nor any other script of a queue");
      assert.equal(await s.jobs(), 0);
    } finally {
      forwarder.close();
      await s.done();
    }
  });
}

/**
 * A durable approval of this test's own, pending on its issue and owned by another host than the plan's queue names,
 * in the real approval store, and the console's answer to it. The store's keys carry no tag, so they are named here
 * for the scene to delete.
 */
async function pendingApproval(s) {
  const T0 = 1_800_000_000_000;
  const store = makeApprovalStore({ redis: s.redis, now: () => T0 });
  const requestId = createHash("sha256").update(`approval:${s.tag}`).digest("hex");
  const host = `${s.tag}-owner`;
  const request = { requestId, runId: `gh-${s.tag}`, kind: "github", repo: `acme/${s.tag}`, target: { type: "issue", number: 7 }, action: "deploy:staging", toolCallId: "call-1", configDigest: "digest", sessionKey: "session-1", host, hostQueue: `pi-jobs@${host}`, createdAt: T0 };
  s.own(`run:approval:request:${requestId}`, approvalTargetKey(request));
  assert.equal((await store.publish(request)).ok, true);
  const plan = (deliveryId = "console-0123456789abcdef") => ({ kind: "parked-answer", jobId: request.runId, forge: "github", queue: s.queueName, job: forgeJob(s, { resume: true, parkedReply: false, approvalRequestId: requestId, console: { by: "ops" }, trigger: { ...forgeJob(s).trigger, deliveryId, comment: { body: "/approve" } } }) });
  return { store, request, requestId, hostQueue: request.hostQueue, plan };
}

test("an answer to an approval is queued on its owner host's queue alone, and one whose approval is no longer the pending one says so and queues nothing (#987)", live, async () => {
  const s = await scene("t987");
  try {
    const approval = await pendingApproval(s);
    const queued = await enqueueParkedAnswer(approval.plan(), { url: s.url, parseConnectionFn: boundedHere });
    assert.deepEqual(queued, { ok: true, jobIds: ["gh-console-0123456789abcdef"], queue: approval.hostQueue }, JSON.stringify(queued));
    assert.deepEqual([await s.jobs(), await s.jobs(approval.hostQueue)], [0, 1], "on the owner's queue, never on the plan's");
    // The request ends (the worker revoked it): the item has no active request, and a second answer binds a stale one.
    assert.equal((await approval.store.cancel({ requestId: approval.requestId, jobId: `gh-${s.tag}-revoked` })).ok, true);
    const stale = await clocked(enqueueParkedAnswer(approval.plan("console-fedcba9876543210"), { url: s.url, parseConnectionFn: boundedHere }));
    assert.deepEqual(stale.res, { refusal: APPROVAL_NOT_PENDING }, JSON.stringify(stale.res?.thrown?.message ?? stale.res));
    assert.ok(stale.ms < 2000, `${stale.ms} ms`);
    await sleep(300);
    assert.deepEqual([await s.jobs(), await s.jobs(approval.hostQueue)], [0, 1], "nothing was queued by the refused answer");
  } finally {
    await s.done();
  }
});

test("a forge re-run that an approval routes to its owner host's queue answers that queue, and the cancel its Undo opens finds the job there and removes it (#987)", live, async () => {
  const s = await scene("t987");
  try {
    const approval = await pendingApproval(s);
    // A re-run of a gated comment job on the item the approval waits on: the helper binds it and routes it. Its
    // delivery id carries this test's tag, so every key named after the job is this test's to delete.
    const deliveryId = `console-${s.tag}`;
    const plan = { kind: "forge", forge: "github", jobId: `gh-${s.tag}`, deliveryId, queue: s.queueName, job: forgeJob(s, { gates: ["deploy:staging"], trigger: { ...forgeJob(s).trigger, deliveryId, comment: { body: "/pi fix" } } }) };
    const queued = await enqueueRerun(plan, { url: s.url, parseConnectionFn: boundedHere });
    assert.deepEqual(queued, { ok: true, jobId: `gh-${deliveryId}`, queue: approval.hostQueue }, JSON.stringify(queued));
    assert.deepEqual([await s.jobs(), await s.jobs(approval.hostQueue)], [0, 1], "on the owner's queue, never on the plan's");
    // The banner's Undo is the cancel of that job by the id and the queue the re-run answered: its preview finds the
    // job on that queue, and its confirm, which refuses a job found on another queue than the preview's, removes it.
    const seams = { url: s.url, redisFn: clientHere, parseConnectionFn: boundedHere };
    const preview = await planCancelQueued({ ...seams, jobId: queued.jobId, queue: queued.queue });
    assert.equal(preview.plan?.queue, approval.hostQueue, JSON.stringify(preview));
    const cancelled = await cancelQueuedJob({ ...seams, jobId: queued.jobId, expect: { queue: preview.plan.queue, attemptsMade: preview.plan.attemptsMade, stalledCounter: preview.plan.stalledCounter }, touchStore: null });
    assert.deepEqual(cancelled, { ok: true, jobId: queued.jobId, queue: approval.hostQueue, held: false }, JSON.stringify(cancelled));
    await sleep(300);
    assert.deepEqual([await s.jobs(), await s.jobs(approval.hostQueue)], [0, 0]);
  } finally {
    await s.done();
  }
});

test("an answer to an approval whose owner queue Valkey stops answering at its connect says nothing was queued at the connect bound, and nothing is queued after the wake (#987)", live, async () => {
  const s = await scene("t987");
  const proxy = await trippingProxy(s.url);
  try {
    const approval = await pendingApproval(s);
    let frozen = null;
    // Armed as the routed queue is built: the plan's own queue is connected by then and the approval was read on it, so
    // the next ready check to leave is the routed queue's.
    const queueFn = (connection, options) => {
      if (options.name === approval.hostQueue) frozen = proxy.freezeAt(/\r\n\$4\r\ninfo\r\n/i);
      return makeQueue(connection, options);
    };
    const got = await clocked(enqueueParkedAnswer(approval.plan(), { url: proxy.url, parseConnectionFn: boundedHere, queueFn, connectTimeoutMs: CONNECT }));
    assert.ok(frozen, "the routed queue was built through the console's own seam");
    assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at the routed queue's connect");
    assert.deepEqual(got.res, { unreachable: `the queue did not connect within ${CONNECT / 1000} seconds; nothing was queued` }, JSON.stringify(got.res?.thrown?.message ?? got.res));
    assert.ok(got.ms >= CONNECT - 50 && got.ms < CONNECT + 2000, `one connect bound past the first queue's connect (${got.ms} ms)`);
    proxy.thaw();
    await sleep(1500);
    assert.deepEqual([await s.jobs(), await s.jobs(approval.hostQueue)], [0, 0], "nothing was sent, and nothing is sent when the connection comes up");
  } finally {
    proxy.thaw();
    proxy.close();
    await s.done();
  }
});

test("a re-run's add that Valkey took before it stopped answering is a job after the wake: may or may not was the true sentence (#961)", live, async () => {
  const s = await scene();
  const proxy = await trippingProxy(s.url);
  try {
    // What the next preview looks for: a run of this flow in this folder on this host's queue. None yet.
    const look = () => dispatchRunAlready({ url: s.url, folder: `/srv/${s.tag}`, flow: "fix", env: { PI_WORKER_NAME: s.tag }, parseConnectionFn: boundedHere });
    // A cron trigger on this folder and flow: its next tick waits in the queue for its time, and is no run "already queued".
    await s.queue().upsertJobScheduler(`tick-${s.tag}`, { pattern: "0 6 * * *" }, { name: "local", data: { kind: "local", folder: `/srv/${s.tag}`, flow: "fix" } });
    assert.equal(await s.jobs(), 1, "the tick is there");
    assert.equal(await look(), null, "nothing but the tick is queued, so a preview says nothing");
    const frozen = proxy.freezeAt(THE_ADD);
    const got = await clocked(ENQUEUES[0].run(s, proxy.url));
    assert.equal(await stoppedAt(frozen), "stopped");
    assert.equal(got.res.partial, true, JSON.stringify(got.res));
    // The wake comes before the queue's connection is dropped (its close has a second), so the bytes Valkey had been
    // sent are run, as on a `kill -CONT`.
    proxy.thaw();
    let jobs = 0;
    for (const until = Date.now() + 3000; Date.now() < until && jobs < 2; await sleep(50)) jobs = await s.jobs();
    assert.equal(jobs, 2, "the run the answer could not confirm was queued, beside the tick");
    // A minute later its id would be another, and a second confirm a second paid run: the preview says one is there.
    const already = await look();
    assert.match(already?.jobId ?? "", /^local-[a-f0-9]{16}$/, JSON.stringify(already));
    assert.ok(Number.isFinite(already.queuedAt));
  } finally {
    proxy.close();
    await s.done();
  }
});

test("the hour's count is one script: its expiry is set with the first count and on a key found without one, and a count Valkey took and did not answer says a start may be used (#961)", live, async () => {
  const s = await scene();
  const proxy = await trippingProxy(s.url);
  const root = realpathSync(tempDir("pd-961-count-"));
  const folder = join(root, "repo");
  mkdirSync(folder);
  // An hour of this test's own, far from any other test's clock.
  const at = Date.UTC(2040 + Math.floor(Math.random() * 40), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27), Math.floor(Math.random() * 24));
  const key = `dispatch-run:${new Date(at).toISOString().slice(0, 13).replace("T", "-")}`;
  s.own(key);
  const deps = (url) => ({ folder, flow: "fix", env: { VALKEY_URL: url, PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "9" }, gitDirtyFn: () => false, localRepoProblemFn: () => null, revParseHeadFn: () => "deadbeef", readFlowGateFn: async () => ({ gate: "allow" }), now: () => at, redisFn: clientHere });
  try {
    assert.deepEqual(await checkDispatchRun(deps(s.url)), {});
    assert.equal(await s.redis.get(key), "1");
    const ttl = await s.redis.ttl(key);
    assert.ok(ttl > 0 && ttl <= 7200, `the first count sets the hour's end (${ttl})`);
    // A key left without an end (the two-command form lost its EXPIRE) is given one by the next count.
    await s.redis.persist(key);
    assert.equal(await s.redis.ttl(key), -1);
    assert.equal(Number(await s.redis.eval(DISPATCH_RUN_COUNT_SCRIPT, 1, key, 7200)), 2);
    assert.ok((await s.redis.ttl(key)) > 0);
    // A preview reads and counts nothing.
    assert.deepEqual(await checkDispatchRun({ ...deps(s.url), consumeRate: false }), {});
    assert.equal(await s.redis.get(key), "2");
    const frozen = proxy.freezeAt(/\r\n\$4\r\neval\r\n[\s\S]*INCR/i);
    const got = await clocked(checkDispatchRun(deps(proxy.url)));
    assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at the count");
    assert.deepEqual(got.res, { unreachable: "Command timed out", allowanceMayBeUsed: true });
    assert.ok(got.ms < BOUND + 2000, `${got.ms} ms`);
    assert.equal(await s.redis.get(key), "2", "nothing reached Valkey while it did not answer");
    proxy.thaw();
    await sleep(400);
    assert.ok(["2", "3"].includes(await s.redis.get(key)), "used or not, never twice");
    // A Valkey that answers no connection: the count was never sent, so nothing can have been used.
    proxy.freeze();
    const unsent = await clocked(checkDispatchRun(deps(proxy.url)));
    assert.deepEqual(unsent.res, { unreachable: "Command timed out" });
    assert.ok(unsent.ms < BOUND + 2000, `${unsent.ms} ms`);
  } finally {
    proxy.close();
    await s.done();
  }
});

test("Fire now on a Valkey that stops answering at its latch or its add queues at most one run and says which may have happened (#961)", live, async () => {
  const s = await scene();
  const proxy = await trippingProxy(s.url);
  const dir = tempDir("pd-961-fire-");
  const folder = join(dir, "repo");
  mkdirSync(folder);
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: `daily-${s.tag}`, pattern: "0 6 * * *" }, run: { kind: "local", folder, flow: "fix", task: "t", maxCostUsd: "1" } }] }));
  let instant = Date.UTC(2026, 9, 20, 12, 0, 10);
  const admissions = [];
  const options = (url) => ({ index: 0, url, triggersPath, env: { PI_WORKER_NAME: s.tag, PI_MAX_COST_USD: "2" }, grantsEnv: {}, now: () => instant, parseConnectionFn: boundedHere, redisFn: clientHere, admissionFn: async (args) => (admissions.push(args.consumeRate), {}) });
  try {
    await s.queue().upsertJobScheduler(`daily-${s.tag}`, { pattern: "0 6 * * *" }, { name: "local", data: { kind: "local", folder, flow: "fix" } });
    const base = await s.jobs();
    const { plan, already: before } = await planTriggerFire({ ...options(s.url), lookAlready: true });
    assert.ok(plan, "the plan reads the real scheduler");
    assert.equal(before, null, "the scheduler's own next tick waits in the queue and is no hand fire");
    // The latch: nothing was queued, and the minute may be taken.
    const latch = proxy.freezeAt(commandOn("set", `trigger-fire:${s.queueName}:`));
    const lost = await clocked(enqueueTriggerFire(plan, options(proxy.url)));
    assert.equal(await stoppedAt(latch), "stopped", "Valkey stopped answering at the latch");
    assert.deepEqual(lost.res, { invalid: "Nothing was queued, one start of this hour was used, and this minute's Fire now may be taken: its latch was sent and did not answer. Try again next minute.", partial: true });
    assert.ok(lost.ms < BOUND + 2500, `${lost.ms} ms`);
    proxy.thaw();
    await sleep(500);
    assert.equal(await s.jobs(), base, "no run was queued");
    // The add, in a minute of its own: a run may have been queued, and at most one is.
    instant += 120_000;
    const add = proxy.freezeAt(THE_ADD);
    const unconfirmed = await clocked(enqueueTriggerFire(plan, options(proxy.url)));
    assert.equal(await stoppedAt(add), "stopped", "Valkey stopped answering at the add");
    assert.deepEqual(unconfirmed.res, { invalid: FIRE_UNCONFIRMED, partial: true });
    assert.ok(unconfirmed.ms < BOUND + 2500, `${unconfirmed.ms} ms`);
    assert.equal(await s.jobs(), base, "nothing reached Valkey while it did not answer");
    proxy.thaw();
    let after = 0;
    for (const until = Date.now() + 3000; Date.now() < until && after === 0; await sleep(50)) after = (await s.jobs()) - base;
    assert.equal(after, 1, "the add Valkey had been sent ran at the wake");
    // The next preview says a hand fire is already queued, by its id.
    const second = await planTriggerFire({ ...options(s.url), lookAlready: true });
    assert.match(second.already?.jobId ?? "", new RegExp(`^manual:daily-${s.tag}:\\d+$`), JSON.stringify(second.already));
    // The same minute again: its latch is held, so a second try cannot queue a second run.
    const again = await enqueueTriggerFire(plan, options(s.url));
    assert.equal(again.deduplicated, true, JSON.stringify(again));
    assert.equal((await s.jobs()) - base, after);
    // A Valkey that answers no connection: the preview ends at its bound, and a fire uses neither count nor latch.
    instant += 120_000;
    proxy.freeze();
    const preview = await clocked(planTriggerFire({ ...options(proxy.url), planTimeoutMs: CONNECT }));
    assert.deepEqual(preview.res, { unreachable: "The deployment's queue could not be read. Nothing was queued." });
    assert.ok(preview.ms < CONNECT + 2000, `${preview.ms} ms`);
    const counted = admissions.filter((consume) => consume === true).length;
    const fire = await clocked(enqueueTriggerFire(plan, { ...options(proxy.url), planTimeoutMs: CONNECT, connectTimeoutMs: CONNECT }));
    assert.deepEqual(fire.res, { unreachable: "The deployment's queue could not be read. Nothing was queued." });
    assert.equal(admissions.filter((consume) => consume === true).length, counted, "the hour's allowance was not counted");
    proxy.thaw();
    await sleep(600);
    assert.equal((await s.jobs()) - base, after);
  } finally {
    proxy.close();
    await s.done();
  }
});

test("the previews of a re-run and a parked answer end at their bound on a Valkey that answers no connection (#961)", live, async () => {
  const s = await scene();
  const proxy = await freezingProxy(s.url);
  const logsDir = tempDir("pd-961-plan-logs-");
  const triggersPath = join(tempDir("pd-961-plan-triggers-"), "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [] }));
  try {
    proxy.freeze();
    const common = { url: proxy.url, logsDir, parseConnectionFn: boundedHere, redisFn: clientHere, planTimeoutMs: CONNECT };
    const rerun = await clocked(planRerun({ ...common, jobId: `gh-${s.tag}` }));
    const parked = await clocked(planParkedAnswer({ ...common, jobId: `gh-${s.tag}`, text: "yes", by: "ops", triggersPath }));
    for (const got of [rerun, parked]) {
      assert.match(String(got.res.refusal), /nothing was queued$|could not be read|not read/, JSON.stringify(got.res));
      assert.ok(got.ms < CONNECT + 2000, `${got.ms} ms`);
    }
  } finally {
    proxy.close();
    await s.done();
  }
});

test("readUpdates on a Valkey that stops answering at a canary's facts says those facts were not read, in one bound, with every package in order (#961)", live, async () => {
  const s = await scene();
  const proxy = await trippingProxy(s.url);
  s.own("updates:*");
  const names = [`pi-a-${s.tag}`, `pi-b-${s.tag}`];
  const at = Date.now();
  const through = clientHere(proxy.url, {});
  s.onDone(() => through.disconnect());
  try {
    await publishLook(s.redis, { v: 1, host: `host-${s.tag}`, at, everyHours: 24, pi: { pinned: "1.5.0", newest: "1.5.0", read: "ok", checks: null }, hostPi: { version: "1.5.0", tested: "1.5.0", state: "same", needles: "ok", extension: "ok" }, packages: names.map((name) => ({ name, version: "1.0.0", newest: "1.1.0", read: "ok" })) });
    const staged = { packages: names.map((name) => ({ name, version: "1.0.0", dir: `${name}--1.0.0--aaaaaaaa`, from: "pi-packages" })) };
    const whole = await readUpdates({ redis: through, staged, now: at });
    assert.deepEqual([whole.state, whole.factsUnread, whole.packages.map((p) => p.name)], ["looking", false, names]);
    const frozen = proxy.freezeAt(commandOn("get", updatesCanaryKey(names[0], "1.1.0").slice(0, 15)));
    const got = await clocked(readUpdates({ redis: through, staged, now: at }));
    assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at a canary's facts");
    assert.equal(got.res.factsUnread, true, "asked for and not answered is not the same as none published");
    assert.deepEqual(got.res.packages.map((p) => p.name), names);
    assert.ok(got.ms < 4500, `one bound, not one per read (${got.ms} ms)`);
  } finally {
    proxy.thaw();
    proxy.close();
    await s.done();
  }
});

test("the budget writes on a Valkey that stops answering: an envelope's digest, a priorities plan and a revert say may or may not, and none of them waits for the wake (#961)", live, async () => {
  const s = await scene();
  const proxy = await trippingProxy(s.url);
  const prefix = `alloc-${s.tag}`;
  const dir = tempDir("pd-961-budget-");
  const files = { projects: join(dir, "projects.json"), envelope: join(dir, "envelope.json"), logs: join(dir, "logs") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }, { id: "platform", members: ["github:acme/infra"] }] }));
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10", _other: "0" }, defaultWeights: { shop: 1, platform: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  const before = readFileSync(files.envelope, "utf8");
  const r = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 });
  const NOW = Date.parse("2026-10-05T12:00:00Z");
  const alloc = (url) => ({ url, envelope: r.envelope, digest: r.digest, projects: r.projects, host: "live", logsDir: files.logs, now: new Date(NOW), prefix, redisFn: clientHere, connectTimeoutMs: CONNECT });
  const envelope = (url) => ({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000, change: { totalUsd: "90" }, url, prefix, redisFn: clientHere, connectTimeoutMs: CONNECT });
  const anyWrite = new RegExp(`\\r\\n\\$\\d+\\r\\n(?:set|eval|evalsha)\\r\\n[\\s\\S]*${prefix}`, "i");
  try {
    const plan = planEnvelopeWrite(envelope(s.url));
    // The envelope: stopped at the digest's SET.
    let frozen = proxy.freezeAt(commandOn("set", `${prefix}:envelope:expected`));
    const lost = await clocked(writeEnvelope(envelope(proxy.url)));
    assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at the digest");
    assert.deepEqual(lost.res, { invalid: envelopeDigestUnconfirmed(`${prefix}:envelope:expected`, plan.digest), partial: true });
    assert.ok(lost.ms < BOUND + 2000, `${lost.ms} ms`);
    assert.equal(readFileSync(files.envelope, "utf8"), before, "the file was not written");
    proxy.thaw();
    await sleep(300);
    assert.ok([null, plan.digest].includes(await s.redis.get(`${prefix}:envelope:expected`)));
    await s.redis.del(`${prefix}:envelope:expected`);
    // A plan and a revert: stopped at their first write, the client's own error is thrown on with its mark.
    const writes = [
      ["a priorities plan", () => applyPriorities({ ...alloc(proxy.url), now: new Date(NOW), plan: { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] }, keepOther: true })],
      ["a revert", () => revertAllocation({ ...alloc(proxy.url), now: new Date(NOW), target: { at: new Date(NOW).toISOString(), outcome: "neutral", planId: null, weights: { shop: 1, platform: 1, _other: 0 } } })],
    ];
    for (const [name, write] of writes) {
      frozen = proxy.freezeAt(anyWrite);
      const got = await clocked(write());
      assert.equal(await stoppedAt(frozen), "stopped", `${name}: Valkey stopped answering at a write`);
      assert.equal(got.res.thrown?.valkeyMayStillRun, true, `${name}: ${JSON.stringify(got.res.thrown?.message ?? got.res)}`);
      assert.ok(got.ms < BOUND + 2000, `${name}: ${got.ms} ms`);
      proxy.thaw();
      await sleep(300);
    }
    // A Valkey that answers no connection: nothing was sent, said within the connect bound, with no mark.
    proxy.freeze();
    for (const [name, write] of writes) {
      const got = await clocked(write());
      assert.equal(got.res.thrown?.message, `Valkey did not connect within ${CONNECT / 1000} seconds`, name);
      assert.equal(got.res.thrown?.valkeyMayStillRun, undefined, name);
      assert.equal(got.res.thrown?.valkeyNotSent, true, name);
      assert.ok(got.ms < CONNECT + 2000, `${name}: ${got.ms} ms`);
    }
    // The envelope's write too, before its key or its file (issue #965): the same error, thrown on with the same mark.
    const unsent = await clocked(writeEnvelope(envelope(proxy.url)));
    assert.equal(unsent.res.thrown?.message, `Valkey did not connect within ${CONNECT / 1000} seconds`);
    assert.equal(unsent.res.thrown?.valkeyNotSent, true);
    assert.ok(unsent.ms < CONNECT + 2000, `${unsent.ms} ms`);
    assert.equal(readFileSync(files.envelope, "utf8"), before);
  } finally {
    proxy.thaw();
    proxy.close();
    await s.done();
  }
});

/** A split of this test's own under its own key prefix: the envelope files, the allocation inputs and the keys. */
function splitScene(s, name) {
  const prefix = `alloc-${s.tag}`;
  const dir = tempDir(name);
  const files = { projects: join(dir, "projects.json"), envelope: join(dir, "envelope.json"), logs: join(dir, "logs") };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }, { id: "platform", members: ["github:acme/infra"] }] }));
  writeFileSync(files.envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10", _other: "0" }, defaultWeights: { shop: 1, platform: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  const r = readEnvelope({ envelopeFile: files.envelope, projectsPath: files.projects, maxCostMicros: 2_000_000 });
  const NOW = Date.parse("2026-10-05T12:00:00Z");
  const keys = { plan: `${prefix}:plan`, lock: `${prefix}:lock`, log: `${prefix}:log`, expected: `${prefix}:envelope:expected` };
  return {
    prefix, files, r, NOW, keys,
    /** What a budget write is handed, through `url`, at `at`. */
    alloc: (url, at = NOW) => ({ url, envelope: r.envelope, digest: r.digest, projects: r.projects, host: "live", logsDir: files.logs, now: new Date(at), prefix, redisFn: clientHere, connectTimeoutMs: CONNECT }),
    /** The neutral split seeded by a host, on a connection the proxy is not on. */
    seed: () => makeAllocationState({ redis: s.redis, host: "seed", audit: { append() {} }, prefix }).reconcile({ envelope: r.envelope, digest: r.digest, now: NOW - 60_000 }),
    /**
     * A write's client whose drop is held back until the scene ends. The proxy stands between the write and Valkey and
     * drops what it holds for a connection once that connection closes, where a Valkey that stopped answering already
     * has those bytes in its socket and runs them when it wakes. A budget write drops its client the moment it answers.
     */
    keptOpen: (url, options) => {
      const client = clientHere(url, options);
      const drop = client.disconnect.bind(client);
      client.disconnect = () => s.onDone(drop);
      return client;
    },
    /** The rows this host's allocations file holds, oldest first. */
    fileRows: () => readFileSync(join(files.logs, "allocations", "2026-10.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    logRows: async () => (await s.redis.lrange(keys.log, 0, -1)).map((text) => JSON.parse(text)),
  };
}

test("a priorities plan on a Valkey that stops answering at its first read says nothing was sent, and nothing of it is there after the wake: no lock, no plan, no row (#987)", live, async () => {
  const s = await scene("t987");
  const proxy = await trippingProxy(s.url);
  const split = splitScene(s, "pd-987-plan-read-");
  try {
    await split.seed();
    const seeded = await s.redis.get(split.keys.plan);
    const rows = await s.redis.llen(split.keys.log);
    const frozen = proxy.freezeAt(commandOn("get", split.keys.plan));
    const got = await clocked(applyPriorities({ ...split.alloc(proxy.url), redisFn: split.keptOpen, plan: { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] }, keepOther: true }));
    assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at the plan's first GET");
    // Only a read had left: Valkey could not be reached and nothing was changed, where the read's own mark said the
    // change may or may not have been made.
    assert.deepEqual([got.res.thrown?.valkeyNotSent, got.res.thrown?.valkeyMayStillRun, got.res.thrown?.code], [true, undefined, "ETIMEDOUT"], JSON.stringify(got.res.thrown?.message ?? got.res));
    assert.ok(got.ms < BOUND + 2000, `${got.ms} ms`);
    proxy.thaw();
    await sleep(500);
    assert.deepEqual([await s.redis.exists(split.keys.lock), await s.redis.get(split.keys.plan) === seeded, await s.redis.llen(split.keys.log)], [0, true, rows], "the wake brings no lock, no changed plan and no new row");
  } finally {
    proxy.thaw();
    proxy.close();
    await s.done();
  }
});

test("a revert on a Valkey that stops answering at its compare-and-set ends in ONE bound and says may or may not; at the wake the split is the revert's, its row is in the file and not in the history, and the page's notice says so (#987)", live, async () => {
  const s = await scene("t987");
  const proxy = await trippingProxy(s.url);
  const split = splitScene(s, "pd-987-revert-cas-");
  try {
    await split.seed();
    // The first script of this write that names the plan's key is its compare-and-set: the split is seeded, so
    // nothing is seeded here, and the lock before it is a SET.
    let stoppedMs = null;
    const frozen = proxy.freezeAt(new RegExp(`\\r\\n\\$4\\r\\neval\\r\\n[\\s\\S]*${split.keys.plan}`, "i")).then(() => (stoppedMs = Date.now()));
    const at = split.NOW + 1000;
    const got = await clocked(revertAllocation({ ...split.alloc(proxy.url, at), redisFn: split.keptOpen, target: { at: new Date(split.NOW).toISOString(), outcome: "neutral", planId: null, weights: { shop: 1, platform: 1, _other: 0 } } }));
    const answeredMs = Date.now();
    assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at the compare-and-set");
    assert.deepEqual([got.res.thrown?.valkeyMayStillRun, got.res.thrown?.valkeyNotSent], [true, undefined], JSON.stringify(got.res.thrown?.message ?? got.res));
    // One bound: the lock's release in the worker's `finally` is not sent after a lost answer, where it waited out a
    // second bound on the Valkey that had just not answered.
    assert.ok(answeredMs - stoppedMs < 1.6 * BOUND, `${answeredMs - stoppedMs} ms after the stop, with a bound of ${BOUND} ms`);
    assert.equal(JSON.parse(await s.redis.get(split.keys.plan)).writer, "default", "nothing reached Valkey while it did not answer");
    proxy.thaw();
    let state = null;
    for (const until = Date.now() + 3000; Date.now() < until && state?.writer !== "operator-revert"; await sleep(50)) state = JSON.parse(await s.redis.get(split.keys.plan));
    assert.deepEqual([state.writer, state.appliedAt], ["operator-revert", new Date(at).toISOString()], "the compare-and-set Valkey had been sent ran at the wake");
    // The file has the row, written before the write; the history never got it: the writer had stopped before its push.
    assert.deepEqual(split.fileRows().map((row) => row.outcome), ["reverted"]);
    assert.deepEqual((await split.logRows()).map((row) => row.outcome), ["neutral"]);
    // What the page then reads, through the real reader: the split has no row in its history, said once it is 15 s old.
    const alloc = await readAllocations({ url: s.url, prefix: split.prefix, redisFn: clientHere, limit: 20 });
    assert.equal(alloc.state.writer, "operator-revert");
    assert.deepEqual(historyBehind(alloc.state, alloc.log, { limit: 20, nowMs: at + 60_000 }), { writer: "operator-revert", at: "10-05 12:00" });
    assert.equal(historyBehind(alloc.state, alloc.log, { limit: 20, nowMs: at + 5_000 }), null);
  } finally {
    proxy.thaw();
    proxy.close();
    await s.done();
  }
});

test("two plans racing on one basis on a real Valkey: one applies, and its split has its row in the history whatever the loser pushed after it (#987)", live, async () => {
  const s = await scene("t987");
  const split = splitScene(s, "pd-987-plan-race-");
  // One client a side, so the commands race on the server; the same writer at the same instant on both.
  const sides = [clientHere(s.url, {}), clientHere(s.url, {})];
  s.onDone(() => sides.forEach((side) => side.disconnect()));
  try {
    const losers = {};
    for (let round = 0; round < 10; round += 1) {
      const stale = await s.redis.keys(`${split.prefix}:*`);
      if (stale.length > 0) await s.redis.del(...stale);
      const [a, b] = sides.map((redis, i) => makeAllocationState({ redis, host: `side${i}`, audit: { append() {} }, prefix: split.prefix }));
      await a.reconcile({ envelope: split.r.envelope, digest: split.r.digest, now: split.NOW });
      const apply = (state, weights) => state.applyPlan({ envelope: split.r.envelope, digest: split.r.digest, projects: split.r.projects, text: JSON.stringify({ version: 1, basis: null, projects: Object.entries(weights).map(([id, weight]) => ({ id, weight })) }), writer: { kind: "operator-session" }, now: split.NOW + 1000 });
      const answers = await Promise.all([apply(a, { shop: 3, platform: 1, _other: 0 }), apply(b, { shop: 1, platform: 3, _other: 0 })]);
      const won = answers.filter((answer) => answer.outcome === "applied");
      assert.equal(won.length, 1, `round ${round}: ${JSON.stringify(answers)}`);
      const lost = answers.find((answer) => answer.outcome !== "applied");
      losers[lost.reason] = (losers[lost.reason] ?? 0) + 1;
      const alloc = await readAllocations({ url: s.url, prefix: split.prefix, redisFn: clientHere, limit: 20 });
      assert.equal(alloc.state.planId, won[0].planId, `round ${round}: the split is the winner's`);
      // The history holds one `applied` row, the winner's, and the loser's row beside it, pushed before or after.
      assert.deepEqual(alloc.log.filter((row) => row.outcome === "applied").map((row) => row.planId), [won[0].planId], `round ${round}: ${JSON.stringify(alloc.log.map((row) => row.outcome))}`);
      assert.ok(alloc.log.some((row) => row.outcome !== "applied" && row.outcome !== "neutral"), `round ${round}: the loser's attempt has its row`);
      assert.equal(historyBehind(alloc.state, alloc.log, { limit: 20, nowMs: split.NOW + 61_000 }), null, `round ${round}: ${JSON.stringify(alloc.log.map((row) => row.outcome))}`);
    }
    // Which way the losers lost is the server's to decide; each way is one this test took.
    assert.ok(Object.keys(losers).every((reason) => ["plan-stale", "plan-busy", "plan-too-soon"].includes(reason)), JSON.stringify(losers));
  } finally {
    await s.done();
  }
});

/**
 * A pass-through in front of `target` that says how many client connections are open now. One counts until the client
 * ends or destroys it: the front closes back at once, where a Valkey that stopped answering would not, and ioredis
 * destroys a socket it ended and nobody closed back 2 s later.
 */
async function countingFront(target) {
  const to = new URL(target);
  const open = new Set();
  const server = createServer((client) => {
    const upstream = netConnect({ host: to.hostname, port: Number(to.port) });
    open.add(client);
    for (const socket of [client, upstream]) socket.on("error", () => {});
    client.on("data", (data) => upstream.write(data));
    upstream.on("data", (data) => client.write(data));
    client.on("close", () => (open.delete(client), upstream.destroy()));
    upstream.on("close", () => client.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const via = new URL(target);
  via.port = String(server.address().port);
  return {
    url: via.toString(),
    open: () => open.size,
    close: () => {
      for (const socket of open) socket.destroy();
      server.close();
    },
  };
}

test("a held job's cancel on a Valkey that stops answering at its lookup answers at its own bound, and no connection of the cancel is open once the close bound has passed (#987)", live, async () => {
  const s = await scene("t987");
  // The lookup asks the shared queue first: its meta key in this database is this test's to delete.
  s.own("bull:pi-jobs:*");
  const proxy = await trippingProxy(s.url);
  const front = await countingFront(proxy.url);
  const TIMER = 700;
  const settled = async () => {
    // Past the close bound, when a queue whose close was not answered has had its connection dropped.
    await sleep(QUEUE_CLOSE_TIMEOUT_MS + 400);
    return front.open();
  };
  try {
    // The held cancel, stopped at its lookup of the job: its queue is connected by then, so its close is a QUIT that
    // Valkey never answers, and a bare close kept that connection open for as long as Valkey stayed silent.
    const frozen = proxy.freezeAt(commandOn("hgetall", "bull:pi-jobs"));
    const held = await clocked(cancelHeldJob({ url: front.url, jobId: `gh-${s.tag}`, redisFn: clientHere, timeoutMs: TIMER }));
    assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at the lookup");
    assert.deepEqual(held.res, { invalid: "timed out reaching the queue" }, "its own timer answers, as before");
    assert.ok(held.ms < TIMER + 1500, `${held.ms} ms`);
    assert.ok(front.open() >= 1, "its queue's connection is still open when the answer leaves");
    assert.equal(await settled(), 0, "and none is open once the close bound has passed");
  } finally {
    proxy.thaw();
    front.close();
    proxy.close();
    await s.done();
  }
});

test("the zero touch grouping job is one job per confirm, says may or may not when its add is not answered, and nothing was queued when its queue never connects (#961)", live, async () => {
  const s = await scene();
  const proxy = await trippingProxy(s.url);
  const dir = tempDir("pd-961-group-");
  const paths = { valkeyUrl: proxy.url, triggersPath: join(dir, "triggers.json"), logsDir: join(dir, "logs") };
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(paths.triggersPath, `${JSON.stringify({ triggers: [], zeroTouch: { capture: true, model: "classifier/small", maxCostUsd: "0.01", names: {} } }, null, 2)}\n`);
  const T0 = Date.now();
  const now = () => T0;
  const runId = `gh-${s.tag}`;
  const ticket = (n) => createHash("sha256").update(`${s.tag}:${n}`).digest("hex");
  const jobOf = (digest) => s.queue("pi-jobs").getJob(`question-group-${digest}`);
  // The question store's keys are digests and the grouping job goes to the shared queue: both are this test's alone in
  // this database.
  s.own("zero-touch:*", "bull:pi-jobs:*");
  s.onDone(async () => {
    for (const n of [1, 2, 3, 4, 9]) await (await jobOf(ticket(n)))?.remove().catch(() => {});
  });
  try {
    const captured = await makeQuestionGroupStore({ redis: s.redis, now }).capture({ runId, scopeId: "a".repeat(64), project: "web", repo: "acme/web", at: T0 - 1000, text: "a private question", redact: (text) => text, triggerIndex: 0 });
    assert.equal(captured.ok, true, JSON.stringify(captured));
    const service = makeZeroTouchService({ paths, now, redisFn: clientHere, parseConnectionFn: boundedHere, stepTimeoutMs: CONNECT });
    const PENDING_LINE = /A previous grouping is pending or its result could not be confirmed\. Confirming this request can pay for another classification\./;
    const warned = async (id = runId) => PENDING_LINE.test((await service.preview("zero-touch-group", { runId: id })).plan.summary.join("\n"));
    assert.equal(await warned(), false, "nothing was asked for yet");
    // A second question, for the add Valkey refuses: its status is put back, so its preview warns of nothing.
    const refusedRun = `gh-${s.tag}-refused`;
    assert.equal((await makeQuestionGroupStore({ redis: s.redis, now }).capture({ runId: refusedRun, scopeId: "a".repeat(64), project: "web", repo: "acme/web", at: T0 - 900, text: "another private question", redact: (text) => text, triggerIndex: 0 })).ok, true);
    const refusing = makeZeroTouchService({ paths, now, redisFn: clientHere, parseConnectionFn: boundedHere, stepTimeoutMs: CONNECT, queueFn: () => ({ add: () => Promise.reject(Object.assign(new Error("READONLY"), { name: "ReplyError" })), close: async () => {}, disconnect() {} }) });
    const refusedPlan = (await refusing.preview("zero-touch-group", { runId: refusedRun })).plan;
    assert.deepEqual(await refusing.apply("zero-touch-group", { payload: { params: { runId: refusedRun }, configDigest: refusedPlan.configDigest, digest: refusedPlan.digest }, ticketDigest: ticket(9) }), { unreachable: true });
    assert.equal(await warned(refusedRun), false, "an add Valkey refused queued nothing, so the status went back");
    const entry = async (n) => {
      const { plan } = await service.preview("zero-touch-group", { runId });
      assert.ok(plan, "the grouping plan");
      return { payload: { params: { runId }, configDigest: plan.configDigest, digest: plan.digest }, ticketDigest: ticket(n) };
    };
    // One confirm is one job, however often its add is sent.
    const first = await entry(1);
    const queued = await service.apply("zero-touch-group", first);
    assert.deepEqual(queued, { ok: true, jobId: `question-group-${ticket(1)}` });
    const twice = await service.apply("zero-touch-group", first);
    assert.equal(twice.jobId, queued.jobId);
    const before = await s.jobs("pi-jobs");
    assert.ok(await jobOf(ticket(1)));
    // Stopped at the add.
    // A question nobody asked to group yet, so its status is its own: the lost add below is what makes it pending.
    const lostRun = `gh-${s.tag}-lost`;
    assert.equal((await makeQuestionGroupStore({ redis: s.redis, now }).capture({ runId: lostRun, scopeId: "a".repeat(64), project: "web", repo: "acme/web", at: T0 - 800, text: "a third private question", redact: (text) => text, triggerIndex: 0 })).ok, true);
    assert.equal(await warned(lostRun), false);
    const lostPlan = (await service.preview("zero-touch-group", { runId: lostRun })).plan;
    const second = { payload: { params: { runId: lostRun }, configDigest: lostPlan.configDigest, digest: lostPlan.digest }, ticketDigest: ticket(2) };
    const frozen = proxy.freezeAt(THE_ADD);
    const lost = await clocked(service.apply("zero-touch-group", second));
    assert.equal(await stoppedAt(frozen), "stopped", "Valkey stopped answering at the add");
    assert.deepEqual(lost.res, { invalid: GROUP_UNCONFIRMED, partial: true });
    assert.ok(lost.ms < BOUND + 2500, `${lost.ms} ms`);
    proxy.thaw();
    await sleep(700);
    // Whether or not it landed, the next preview says so: the status was written before the add and left there.
    assert.equal(await warned(lostRun), true);
    const after = (await s.jobs("pi-jobs")) - before;
    assert.ok(after === 0 || after === 1, `none or one after the wake (${after})`);
    // Stopped at the STATUS write, before any add: the store's own two second timer ends it with an error that
    // cannot say whether it was sent. Nothing was queued, and the question may read as pending: said, never 503.
    const statusRun = `gh-${s.tag}-status`;
    assert.equal((await makeQuestionGroupStore({ redis: s.redis, now }).capture({ runId: statusRun, scopeId: "a".repeat(64), project: "web", repo: "acme/web", at: T0 - 700, text: "a fourth private question", redact: (text) => text, triggerIndex: 0 })).ok, true);
    const statusPlan = (await service.preview("zero-touch-group", { runId: statusRun })).plan;
    const beforeStatus = await s.jobs("pi-jobs");
    const atStatus = proxy.freezeAt(/\r\n\$4\r\neval\r\n[\s\S]*local raw=redis\.call\("GET"/i);
    const unanswered = await clocked(service.apply("zero-touch-group", { payload: { params: { runId: statusRun }, configDigest: statusPlan.configDigest, digest: statusPlan.digest }, ticketDigest: ticket(4) }));
    assert.equal(await stoppedAt(atStatus), "stopped", "Valkey stopped answering at the status write");
    assert.deepEqual(unanswered.res, { invalid: GROUP_STATUS_UNANSWERED, partial: true });
    assert.equal(GROUP_STATUS_UNANSWERED, "Nothing was queued: the question's grouping status write was not answered, so it may read as pending.");
    assert.ok(unanswered.ms < 4000, `${unanswered.ms} ms`);
    proxy.thaw();
    await sleep(400);
    assert.equal(await s.jobs("pi-jobs"), beforeStatus, "no job was queued");
    // A queue that never connects, on a Valkey whose stores answered: nothing was queued.
    const third = await entry(3);
    const unconnected = makeZeroTouchService({ paths, now, redisFn: clientHere, parseConnectionFn: boundedHere, stepTimeoutMs: 80, queueFn: () => ({ client: new Promise(() => {}), add: async () => assert.fail("no add on a queue that never connected"), close: async () => {}, disconnect() {} }) });
    const none = await clocked(unconnected.apply("zero-touch-group", third));
    assert.deepEqual(none.res, { unreachable: "the queue did not connect within 0.08 seconds; nothing was queued" });
    assert.equal(await jobOf(ticket(3)), undefined);
    // The page's read and a preview end at their bound on a Valkey that answers nothing, on a client that is dropped.
    proxy.freeze();
    const short = makeZeroTouchService({ paths, now, redisFn: clientHere, parseConnectionFn: boundedHere, readTimeoutMs: CONNECT, stepTimeoutMs: CONNECT });
    for (const reading of [() => short.read({}), () => short.preview("zero-touch-group", { runId })]) {
      const got = await clocked(reading());
      assert.ok(got.res.thrown instanceof Error, JSON.stringify(got.res));
      assert.ok(got.ms < CONNECT + 2000, `${got.ms} ms`);
    }
  } finally {
    proxy.thaw();
    proxy.close();
    await s.done();
  }
});
