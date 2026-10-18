import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tempDir } from "./helpers/temp-dir.mjs";
import {
  cancelHeldJob,
  createFleetReader,
  enqueueParkedAnswer,
  enqueueRerun,
  enqueueSteer,
  estimateReserve,
  planFailedBulk,
  planParkedAnswer,
  planRerun,
  PENDING_SCAN_BUDGET,
  readPendingAnswer,
  planSteer,
  planSteerWithdraw,
  removeFailedJob,
  retryFailedJob,
  retryFailedJobs,
  setQueuePausedOne,
  withdrawSteerMessage,
  readJobInbox,
  publicInboxEntry,
  STEER_INBOX_ROWS_MAX,
  steerAuditTarget,
} from "../src/read-model.mjs";
import { createHash } from "node:crypto";
import { closeInbox, listInboxPublic, markState, readInbox, registerLive } from "@edgehero/pi-dispatch/steer-inbox";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeQueue, enqueueForgeJob, enqueueLateForgeJob, forgeDeliveryJobId, manualTriggerJobId } from "@edgehero/pi-dispatch/queue";
import { CHAT_REFUSALS } from "@edgehero/pi-dispatch/chat-mode";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { filter } from "../../receiver/src/filter.mjs";
import { filterGitLab } from "../../receiver/src/filter-gitlab.mjs";
import { filterForgejo } from "../../receiver/src/filter-forgejo.mjs";
import { reloadTriggers } from "../../receiver/src/config.mjs";

// Issue #642: the console's job funnels against a LIVE Valkey (VALKEY_TEST_URL, required in CI), on database 12 of it,
// flushed before each test: BullMQ's queue names are fixed (`pi-jobs`, `pi-jobs@<host>`), so a database of its own is
// the isolation. Every Valkey-free piece (the pause funnel's refusal, the bounds) runs on fakes too.

const BASE = process.env.VALKEY_TEST_URL;
const URL12 = BASE
  ? (() => {
      const u = new URL(BASE);
      u.pathname = "/12";
      return u.toString();
    })()
  : null;
const live = { skip: URL12 ? false : "needs VALKEY_TEST_URL", timeout: 60_000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await sleep(25);
  }
}

/** A flushed database 12 and the queues a test opens, all closed in `done()`. */
async function freshValkey() {
  const redis = makeRedisClient(URL12);
  await redis.flushdb();
  const opened = [];
  // Ready once its meta hash exists: BullMQ writes it just after construction, and fleet discovery reads it.
  const q = async (name) => {
    const queue = makeQueue(parseConnection(URL12, { failFast: true }), { name });
    opened.push(queue);
    await until(async () => (await redis.exists(`bull:${name}:meta`)) === 1);
    return queue;
  };
  return {
    redis,
    q,
    async done() {
      for (const queue of opened) await queue.close().catch(() => {});
      redis.disconnect();
    },
  };
}

/** Jobs that FAILED for real: added, then taken by a bare BullMQ Worker whose processor throws (one attempt each). */
async function makeFailed(v, name, jobs) {
  const { Worker } = await import("bullmq");
  const queue = await v.q(name);
  for (const j of jobs) await queue.add(j.data.kind ?? "x", j.data, { jobId: j.id, attempts: 1 });
  const worker = new Worker(name, async () => {
    throw new Error("boom");
  }, { connection: parseConnection(URL12) });
  await until(async () => (await queue.getJobCounts("failed")).failed === jobs.length);
  await worker.close();
  return queue;
}

/** A registry row the way a worker beats one (host-registry.mjs), fresh now. */
async function beat(redis, name, caps) {
  await redis.sadd("host:live", name);
  await redis.hset(`host:h:${name}`, { name, routes: "true", caps, beatAt: String(Date.now()) });
}

/** A git repository root with one commit, the folder rule's minimum. */
function gitRepo(prefix) {
  const dir = tempDir(prefix);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  writeFileSync(join(dir, "README"), "x\n");
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "README"]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  return dir;
}

function writeRecord(logsDir, record) {
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, `${sanitizeJobId(record.jobId)}.json`), JSON.stringify(record));
}

// ---- cancel held: every fleet queue ----

test("cancelHeldJob finds a held job on a HOST queue, which the shared-queue-only version refused as gone", live, async () => {
  const v = await freshValkey();
  try {
    const host = await v.q("pi-jobs@mini1");
    await v.q("pi-jobs"); // the shared queue exists too, and does not hold it
    await host.add("github", { kind: "github" }, { jobId: "gh-held-1", delay: 60 * 60 * 1000 });
    await v.redis.hset("wait:job:gh-held-1", { since: String(Date.now()), target: "o/r#1", label: "jira" });
    await v.redis.sadd("wait:held", "gh-held-1");
    const res = await cancelHeldJob({ url: URL12, jobId: "gh-held-1" });
    assert.deepEqual(res, { ok: true, jobId: "gh-held-1", attemptsMade: 0 });
    assert.equal(await host.getJob("gh-held-1"), undefined, "removed from the host queue it was on");
    assert.equal(await v.redis.exists("wait:job:gh-held-1"), 0, "its hold went with it");
  } finally {
    await v.done();
  }
});

// ---- single-queue pause ----

test("setQueuePausedOne pauses exactly one fleet queue and refuses a name the fleet does not drain", live, async () => {
  const v = await freshValkey();
  try {
    const shared = await v.q("pi-jobs");
    const host = await v.q("pi-jobs@mini1");
    assert.deepEqual(await setQueuePausedOne({ url: URL12, queue: "pi-jobs@mini1", paused: true }), { ok: true, paused: true, queue: "pi-jobs@mini1" });
    assert.equal(await host.isPaused(), true);
    assert.equal(await shared.isPaused(), false, "the rest of the fleet keeps running");
    const ghost = await setQueuePausedOne({ url: URL12, queue: "pi-jobs@ghost", paused: true });
    assert.match(ghost.invalid, /"pi-jobs@ghost" is not a queue this deployment drains \(pi-jobs, pi-jobs@mini1\)\. Nothing was changed/);
    assert.equal(await v.redis.exists("bull:pi-jobs@ghost:meta"), 0, "no phantom queue was created by the refusal");
    assert.deepEqual(await setQueuePausedOne({ url: URL12, queue: "pi-jobs@mini1", paused: false }), { ok: true, paused: false, queue: "pi-jobs@mini1" });
    assert.equal(await host.isPaused(), false);
    assert.match((await setQueuePausedOne({ url: URL12, queue: "pi-jobs", paused: "yes" })).invalid, /true or false/);
  } finally {
    await v.done();
  }
});

// ---- one pause funnel ----

test("the fleet reader's pause/resume go through the kill switch's decision: a disagreement refuses resume, a pause reaches both Valkeys", live, async () => {
  const v = await freshValkey();
  const flipped = [];
  const pool = new Map();
  const seams = {
    makeQueueFn: (_c, { name = "pi-jobs" } = {}) => {
      if (!pool.has(name)) pool.set(name, { name, pause: async () => flipped.push(`pause ${name}`), resume: async () => flipped.push(`resume ${name}`), close: async () => {} });
      return pool.get(name);
    },
    parseConnectionFn: () => ({}),
    redisFn: () => ({ on() {}, disconnect() {} }),
    readLiveHostsFn: async () => ({ hosts: [] }),
    discoverHostQueuesFn: async () => [],
  };
  try {
    // A disagreement: the plan refuses resume, and the reader resumes NOTHING.
    const refusing = createFleetReader({ valkeyUrl: "redis://reader" }, { ...seams, killSwitchPlanFn: ({ paused }) => (paused ? { urls: ["redis://reader"], disagreement: null } : { refused: "VALKEY_URL is A in this shell and B in .env: resume would start jobs on one of them, so it resumes neither" }) });
    assert.match((await refusing.resume()).refused, /resumes neither/);
    assert.deepEqual(flipped, [], "nothing resumed");
    // A pause across two Valkeys: the reader's own through its held pool, the other (database 12 here) through setQueuePaused.
    const shared = await v.q("pi-jobs");
    const both = createFleetReader({ valkeyUrl: "redis://reader" }, { ...seams, killSwitchPlanFn: () => ({ urls: ["redis://reader", URL12], disagreement: "VALKEY_URL disagrees", context: null }) });
    const res = await both.pause();
    assert.equal(res.disagreement, "VALKEY_URL disagrees");
    assert.deepEqual(res.results.map((r) => [r.url, r.res.ok, r.res.queues]), [["redis://reader", true, ["pi-jobs"]], [URL12, true, ["pi-jobs"]]]);
    assert.deepEqual(flipped, ["pause pi-jobs"]);
    assert.equal(await shared.isPaused(), true, "the other Valkey's queue paused too");
    // No plan: the reader's own Valkey alone, today's behaviour, now with a result.
    const plain = createFleetReader({ valkeyUrl: "redis://reader" }, seams);
    assert.deepEqual((await plain.resume()).results[0].res, { ok: true, paused: false, queues: ["pi-jobs"] });
    // A queue that throws part-way is a PARTIAL result naming what changed, never a throw the TUI swallows.
    const failing = createFleetReader({ valkeyUrl: "redis://reader" }, { ...seams, makeQueueFn: () => ({ name: "pi-jobs", pause: async () => { throw new Error("down"); }, close: async () => {} }) });
    assert.deepEqual((await failing.pause()).results[0].res.partial, { done: [], failed: "pi-jobs", error: "down" });
    for (const r of [refusing, both, plain, failing]) await r.dispose();
  } finally {
    await v.done();
  }
});

// ---- failed jobs: retry, remove, bulk ----

test("retryFailedJob and removeFailedJob act only on a job still failed as previewed, across the fleet", live, async () => {
  const v = await freshValkey();
  try {
    const host = await makeFailed(v, "pi-jobs@mini1", [{ id: "gh-f1", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } } }, { id: "gh-f2", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 2 } } }]);
    const f1 = await host.getJob("gh-f1");
    const expect = { attemptsMade: f1.attemptsMade, finishedOn: f1.finishedOn };
    // A stale preview (another attempt since) refuses and leaves the job failed.
    const stale = await retryFailedJob({ url: URL12, jobId: "gh-f1", expect: { ...expect, finishedOn: expect.finishedOn - 1 } });
    assert.match(stale.invalid, /changed since the preview/);
    assert.equal(await (await host.getJob("gh-f1")).getState(), "failed");
    assert.match((await retryFailedJob({ url: URL12, jobId: "gh-f1" })).invalid, /attemptsMade and finishedOn are required/);
    // The previewed one retries: back to waiting on the queue it was on.
    assert.deepEqual(await retryFailedJob({ url: URL12, jobId: "gh-f1", expect }), { ok: true, jobId: "gh-f1", queue: "pi-jobs@mini1" });
    assert.equal(await (await host.getJob("gh-f1")).getState(), "waiting");
    // Now it is not failed: a second retry from the same preview refuses.
    assert.match((await retryFailedJob({ url: URL12, jobId: "gh-f1", expect })).invalid, /is waiting now, not failed: it changed since the preview/);
    const f2 = await host.getJob("gh-f2");
    assert.deepEqual(await removeFailedJob({ url: URL12, jobId: "gh-f2", expect: { attemptsMade: f2.attemptsMade, finishedOn: f2.finishedOn } }), { ok: true, jobId: "gh-f2", queue: "pi-jobs@mini1" });
    assert.equal(await host.getJob("gh-f2"), undefined);
    assert.match((await removeFailedJob({ url: URL12, jobId: "gh-f2", expect: { attemptsMade: 1, finishedOn: 1 } })).invalid, /no job gh-f2 in 2 queue\(s\)/);
  } finally {
    await v.done();
  }
});

test("planFailedBulk lists the failed set (filtered by queue or repo, bounded) and the bulk apply reports per job", live, async () => {
  const v = await freshValkey();
  try {
    await makeFailed(v, "pi-jobs", [{ id: "gh-a", data: { kind: "github", repo: "o/a", target: { type: "issue", number: 1 } } }, { id: "gh-b", data: { kind: "github", repo: "o/b", target: { type: "pull_request", number: 2 } } }]);
    await makeFailed(v, "pi-jobs@mini1", [{ id: "local-c", data: { kind: "local", folder: "/srv/c", flow: "f", task: "t" } }]);
    const all = await planFailedBulk({ url: URL12 });
    assert.equal(all.more, 0);
    assert.equal(all.examinedAll, true);
    assert.deepEqual(all.jobs.map((j) => [j.jobId, j.queue, j.target]).sort(), [["gh-a", "pi-jobs", "o/a#1"], ["gh-b", "pi-jobs", "o/b#2"], ["local-c", "pi-jobs@mini1", "local:c"]]);
    for (const j of all.jobs) assert.ok(Number.isInteger(j.attemptsMade) && Number.isFinite(j.finishedOn), "each job carries what the ticket binds");
    assert.deepEqual((await planFailedBulk({ url: URL12, filter: { queue: "pi-jobs@mini1" } })).jobs.map((j) => j.jobId), ["local-c"]);
    assert.deepEqual((await planFailedBulk({ url: URL12, filter: { repo: "o/b" } })).jobs.map((j) => j.jobId), ["gh-b"]);
    const one = await planFailedBulk({ url: URL12, limit: 1 });
    assert.equal(one.jobs.length + one.more, 3, "the limit cuts, and `more` counts what it cut");
    assert.match((await planFailedBulk({ url: URL12, filter: { queue: "pi-jobs@ghost" } })).invalid, /not a queue this deployment drains/);
    // Apply: one entry went stale, the others act; results in the list's order.
    const list = all.jobs.map((j) => (j.jobId === "gh-b" ? { ...j, attemptsMade: j.attemptsMade + 1 } : j));
    const res = await retryFailedJobs({ url: URL12, jobs: list });
    const byId = Object.fromEntries(res.results.map((r) => [r.jobId, r]));
    assert.equal(byId["gh-a"].ok, true);
    assert.equal(byId["local-c"].ok, true);
    assert.match(byId["gh-b"].invalid, /changed since the preview/);
    assert.deepEqual(res.results.map((r) => r.jobId), list.map((j) => j.jobId));
    assert.match((await retryFailedJobs({ url: URL12, jobs: Array.from({ length: 101 }, (_, i) => ({ jobId: `x${i}`, attemptsMade: 0, finishedOn: 0 })) })).invalid, /at most 100 jobs/);
    assert.match((await retryFailedJobs({ url: URL12, jobs: "all" })).invalid, /preview's list/);
  } finally {
    await v.done();
  }
});

test("planFailedBulk is newest first across every fleet queue: the newest failure on a host queue leads, not the first queue's backlog", live, async () => {
  const v = await freshValkey();
  try {
    await makeFailed(v, "pi-jobs", [{ id: "gh-old-1", data: { kind: "github", repo: "o/a", target: { type: "issue", number: 1 } } }, { id: "gh-old-2", data: { kind: "github", repo: "o/a", target: { type: "issue", number: 2 } } }]);
    await sleep(20);
    await makeFailed(v, "pi-jobs@mini1", [{ id: "gh-new", data: { kind: "github", repo: "o/a", target: { type: "issue", number: 3 } } }]);
    const one = await planFailedBulk({ url: URL12, limit: 1 });
    assert.deepEqual(one.jobs.map((j) => [j.jobId, j.queue]), [["gh-new", "pi-jobs@mini1"]], "the newest failure in the fleet, though its queue is discovered second");
    assert.equal(one.more, 2, "the two older ones are counted past the limit");
    const all = await planFailedBulk({ url: URL12 });
    assert.equal(all.jobs[0].jobId, "gh-new");
    assert.deepEqual(all.jobs.map((j) => j.finishedOn), [...all.jobs.map((j) => j.finishedOn)].sort((a, b) => b - a), "ordered by finishedOn, newest first");
    // The same with a repo filter (the read-on path).
    assert.deepEqual((await planFailedBulk({ url: URL12, limit: 1, filter: { repo: "o/a" } })).jobs.map((j) => j.jobId), ["gh-new"]);
  } finally {
    await v.done();
  }
});

test("a failed job past the bulk preview's 100 is still retried and removed by id; the preview clamps to BULK_MAX and counts the rest", { ...live, timeout: 120_000 }, async () => {
  const v = await freshValkey();
  try {
    const jobs = Array.from({ length: 101 }, (_, i) => ({ id: `gh-f${String(i).padStart(3, "0")}`, data: { kind: "github", repo: "o/r", target: { type: "issue", number: i + 1 } } }));
    const shared = await makeFailed(v, "pi-jobs", jobs);
    await v.q("pi-jobs@mini1"); // a second fleet queue, asked first by no hint
    const preview = await planFailedBulk({ url: URL12, limit: 500 });
    assert.equal(preview.jobs.length, 100, "a limit above BULK_MAX is clamped to it");
    assert.equal(preview.more, 1);
    const listed = new Set(preview.jobs.map((j) => j.jobId));
    const outside = jobs.map((j) => j.id).filter((id) => !listed.has(id));
    assert.equal(outside.length, 1);
    const [id] = outside;
    const job = await shared.getJob(id);
    const expect = { attemptsMade: job.attemptsMade, finishedOn: job.finishedOn };
    assert.deepEqual(await retryFailedJob({ url: URL12, jobId: id, expect }), { ok: true, jobId: id, queue: "pi-jobs" }, "found by id with no queue hint");
    assert.equal(await (await shared.getJob(id)).getState(), "waiting");
    // With a hint (right or stale), the same id lookup.
    const other = preview.jobs[preview.jobs.length - 1];
    assert.deepEqual(await removeFailedJob({ url: URL12, jobId: other.jobId, queue: "pi-jobs@mini1", expect: { attemptsMade: other.attemptsMade, finishedOn: other.finishedOn } }), { ok: true, jobId: other.jobId, queue: "pi-jobs" }, "a stale hint costs a lookup, not a miss");
    const third = preview.jobs[0];
    assert.deepEqual(await removeFailedJob({ url: URL12, jobId: third.jobId, queue: "pi-jobs", expect: { attemptsMade: third.attemptsMade, finishedOn: third.finishedOn } }), { ok: true, jobId: third.jobId, queue: "pi-jobs" });
  } finally {
    await v.done();
  }
});

test("the expect a retry or remove carries is checked before anything is read: a negative attempt count, a non-number finish", async () => {
  // No Valkey: the refusal comes before the fleet is opened (a fleet read here would come back unreachable instead).
  const seams = { url: "redis://unused", redisFn: () => { throw new Error("reached Valkey"); } };
  assert.deepEqual(await retryFailedJob({ ...seams, jobId: "gh-1", expect: { attemptsMade: -1, finishedOn: 1 } }), { jobId: "gh-1", invalid: "expect.attemptsMade must be a non-negative integer" });
  assert.deepEqual(await retryFailedJob({ ...seams, jobId: "gh-1", expect: { attemptsMade: 1.5, finishedOn: 1 } }), { jobId: "gh-1", invalid: "expect.attemptsMade must be a non-negative integer" });
  assert.deepEqual(await removeFailedJob({ ...seams, jobId: "gh-1", expect: { attemptsMade: 0, finishedOn: "1" } }), { jobId: "gh-1", invalid: "expect.finishedOn must be a number or null" });
  assert.deepEqual(await removeFailedJob({ ...seams, jobId: "gh-1", expect: { attemptsMade: 0, finishedOn: Infinity } }), { jobId: "gh-1", invalid: "expect.finishedOn must be a number or null" });
  // Zero attempts and a null finish are a valid expect: it goes on to the fleet (here, a Valkey that is not there).
  assert.equal(typeof (await retryFailedJob({ ...seams, jobId: "gh-1", expect: { attemptsMade: 0, finishedOn: null } })).unreachable, "string");
});

// ---- re-run ----

/** The label trigger a forge run in these tests matched (index 0), with the run fields a re-run must take from the file. */
const LABEL_RUN = { kind: "github", flow: "fix", secretsProfile: "prod", secrets: { TOKEN: "op://x" }, maxCostUsd: "1.5", model: "claude-sonnet-5-5", provider: "anthropic", image: "pi-job:v1" };
function forgeTriggers(path, entries = [{ on: { type: "label", any: ["pi"] }, run: LABEL_RUN }]) {
  writeFileSync(path, JSON.stringify({ triggers: entries }));
}

test("planRerun of a forge run: the where from retained data, the run fields from the trigger now, a fresh console delivery id, routed like the receiver; the window and expiry refuse by name", live, async () => {
  const v = await freshValkey();
  const dir = tempDir("pd-642-rerun-");
  const logsDir = join(dir, "logs");
  const triggersPath = join(dir, "triggers.json");
  try {
    forgeTriggers(triggersPath);
    await beat(v.redis, "mini1", "s:prod");
    await beat(v.redis, "mini2", "");
    const mini1 = await v.q("pi-jobs@mini1");
    const shared = await v.q("pi-jobs");
    const original = { repo: "org/repo", target: { type: "issue", number: 7, title: "T", body: "B" }, flow: "fix", secretsProfile: "prod", secrets: { TOKEN: "op://x" }, maxCostUsd: "1.5", model: "claude-sonnet-5-5", provider: "anthropic", image: "pi-job:v1", trigger: { event: "issues", action: "labeled", deliveryId: "orig-1", sender: { id: 9 }, matched: { index: 0, type: "label", label: "pi" } } };
    // On mini1's queue, where the receiver routed it: the one queue whose semantic window a re-run can collide with.
    const { jobId } = await enqueueForgeJob(mini1, "github", original);
    writeRecord(logsDir, { jobId, kind: "github", target: "org/repo#7", outcome: "failed", reason: "exit-1" });
    const random = (n) => Buffer.alloc(n, 0xab);
    const planned = await planRerun({ url: URL12, logsDir, jobId, triggersPath, env: { PI_MAX_COST_USD: "2" }, random });
    assert.equal(planned.plan.kind, "forge", JSON.stringify(planned));
    assert.equal(planned.plan.deliveryId, "console-abababababababab");
    assert.equal(planned.plan.queue, "pi-jobs@mini1", "a secret profile only mini1 serves: routed to its queue, as the receiver would");
    // An unchanged trigger: the re-run is the receiver's job for the same delivery, but for the delivery id.
    const cfg = {};
    assert.deepEqual(reloadTriggers({ PI_TRIGGERS_FILE: triggersPath }, cfg), { ok: true });
    const fresh = filter("issues", { action: "labeled", sender: { id: 9 }, repository: { full_name: "org/repo" }, issue: { number: 7, title: "T", body: "B", labels: [{ name: "pi" }] } }, cfg, 1, "orig-1").job;
    assert.deepEqual(planned.plan.job, { ...fresh, trigger: { ...fresh.trigger, deliveryId: "console-abababababababab" } }, "field for field the receiver's job");
    assert.deepEqual(planned.plan.runFields, { flow: "fix", model: "anthropic/claude-sonnet-5-5", models: null, maxCostUsd: "1.5", secretsProfile: "prod", image: "pi-job:v1", backend: null });
    assert.equal(JSON.stringify(planned.plan.runFields).includes("op://"), false, "names only: no secret reference in what the preview shows");
    assert.deepEqual(planned.plan.reserve, { slots: 1, dollarsMicros: 1_500_000, capMicros: 1_500_000, zeroRated: false });
    // The original's semantic window still holds (same target and flow, minutes ago): the enqueue says so, nothing queued.
    const swallowed = await enqueueRerun(planned.plan, { url: URL12 });
    assert.equal(swallowed.deduplicated, true);
    assert.match(swallowed.refusal, /semantic window took this re-run as a duplicate and nothing was queued/);
    assert.equal(swallowed.survivingJobId, jobId);
    // Once the window is gone, it queues on the routed host queue under the new delivery's id.
    await mini1.removeDeduplicationKey("org/repo#7:fix");
    const ok = await enqueueRerun(planned.plan, { url: URL12 });
    assert.deepEqual(ok, { ok: true, jobId: forgeDeliveryJobId("github", "console-abababababababab"), queue: "pi-jobs@mini1" });
    // Refusals by name.
    writeRecord(logsDir, { jobId: "gh-gone", kind: "github", target: "org/repo#8", outcome: "completed" });
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "gh-gone", triggersPath })).refusal, /the queue no longer holds gh-gone's data \(a forge job's data is kept 31 days\)/);
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "gh-nothing", triggersPath })).refusal, /no run record for gh-nothing/);
    assert.match((await planRerun({ url: URL12, logsDir, jobId })).refusal, /triggers file is not known here .*forge run cannot be rebuilt from its trigger/);
    const cmd = await enqueueForgeJob(shared, "github", { ...original, flow: undefined, command: "triage", trigger: { ...original.trigger, deliveryId: "orig-cmd" } });
    writeRecord(logsDir, { jobId: cmd.jobId, kind: "github", target: "org/repo#7", outcome: "completed" });
    assert.match((await planRerun({ url: URL12, logsDir, jobId: cmd.jobId, triggersPath })).refusal, /ran the command \/triage, and a \/command run is not re-run/);
    const reply = await enqueueForgeJob(shared, "github", { ...original, parkedReply: true, trigger: { ...original.trigger, deliveryId: "orig-reply" } });
    writeRecord(logsDir, { jobId: reply.jobId, kind: "github", target: "org/repo#7", outcome: "completed" });
    assert.match((await planRerun({ url: URL12, logsDir, jobId: reply.jobId, triggersPath })).refusal, /answered a parked run; answer the parked run again/);
  } finally {
    await v.done();
  }
});

test("a forge re-run takes its authority from the trigger NOW: deleted, replaced by another kind, narrowed, a console field never copied", live, async () => {
  const v = await freshValkey();
  const dir = tempDir("pd-642-rerun-auth-");
  const logsDir = join(dir, "logs");
  const triggersPath = join(dir, "triggers.json");
  try {
    const shared = await v.q("pi-jobs");
    // The retained job carries the WIDE fields it ran with, and a `console` field built by hand (enqueueForgeJob would
    // keep it), which a re-run must never carry: it is not an answer.
    const data = { kind: "github", repo: "org/repo", target: { type: "issue", number: 7, title: "T", body: "B" }, flow: "fix", maxCostUsd: "5", models: ["anthropic/claude-opus-5-5"], secretsProfile: "prod", image: "pi-job:wide", console: { by: "alice" }, trigger: { event: "issues", action: "labeled", deliveryId: "auth-1", sender: { id: 9 }, matched: { index: 1, type: "label", label: "pi" } } };
    await shared.add("github", data, { jobId: "gh-auth-1" });
    writeRecord(logsDir, { jobId: "gh-auth-1", kind: "github", target: "org/repo#7", outcome: "completed" });
    const cron = { on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/tmp", flow: "audit", task: "t" } };
    const plan = () => planRerun({ url: URL12, logsDir, jobId: "gh-auth-1", triggersPath, env: {} });
    // Deleted: the file has nothing at index 1 any more.
    forgeTriggers(triggersPath, [cron]);
    assert.match((await plan()).refusal, /^the trigger that started this run changed or is gone; start it again from the forge \(no trigger at index 1 any more\)/);
    // Replaced: the label trigger above it was deleted, so index 1 is now a comment trigger (another kind of authority).
    forgeTriggers(triggersPath, [cron, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } }]);
    assert.match((await plan()).refusal, /changed or is gone; .*is a comment trigger now, not label/);
    // Another forge's trigger at that index.
    forgeTriggers(triggersPath, [cron, { on: { type: "label", any: ["pi"] }, run: { kind: "gitlab", flow: "fix" } }]);
    assert.match((await plan()).refusal, /changed or is gone; .*is a gitlab trigger now, not github/);
    // The same type but no longer selecting the label that matched, or running another flow, or a command.
    forgeTriggers(triggersPath, [cron, { on: { type: "label", any: ["other"] }, run: { kind: "github", flow: "fix" } }]);
    assert.match((await plan()).refusal, /no longer selects the label pi/);
    forgeTriggers(triggersPath, [cron, { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "review" } }]);
    assert.match((await plan()).refusal, /runs "review" now, not "fix"/);
    forgeTriggers(triggersPath, [cron, { on: { type: "label", any: ["pi"] }, run: { kind: "github", command: "triage" } }]);
    assert.match((await plan()).refusal, /changed or is gone/);
    // Narrowed: the same trigger with a smaller cap, one model, no secret profile, the default image. The re-run takes
    // exactly those, never the retained wide ones.
    forgeTriggers(triggersPath, [cron, { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", maxCostUsd: "0.5", models: ["anthropic/claude-sonnet-5-5"] } }]);
    const narrowed = await plan();
    assert.ok(narrowed.plan, JSON.stringify(narrowed));
    assert.equal(narrowed.plan.job.maxCostUsd, "0.5");
    assert.deepEqual(narrowed.plan.job.models, ["anthropic/claude-sonnet-5-5"]);
    for (const k of ["secretsProfile", "image", "console"]) assert.equal(k in narrowed.plan.job, false, `${k} is not replayed from the retained job`);
    assert.deepEqual(narrowed.plan.runFields, { flow: "fix", model: null, models: ["anthropic/claude-sonnet-5-5"], maxCostUsd: "0.5", secretsProfile: null, image: null, backend: null });
    assert.equal(narrowed.plan.reserve.capMicros, 500_000, "the reserve is the narrowed cap");
    assert.equal(narrowed.plan.queue, "pi-jobs", "no secret profile any more: the shared queue");
    assert.deepEqual([narrowed.plan.job.repo, narrowed.plan.job.target, narrowed.plan.job.trigger.matched], [data.repo, data.target, data.trigger.matched], "the where is the retained job's");
    // A comment run's `<phrase> <flow>` override re-runs while the file still routes that flow, but never through a
    // comment trigger that has become a command.
    const said = { ...data, flow: "review", console: undefined, trigger: { event: "issue_comment", action: "created", deliveryId: "auth-2", sender: { id: 9 }, matched: { index: 1, type: "comment", phrase: "@pi" }, comment: { body: "@pi review", author_association: "MEMBER" } } };
    await shared.add("github", said, { jobId: "gh-auth-2" });
    writeRecord(logsDir, { jobId: "gh-auth-2", kind: "github", target: "org/repo#7", outcome: "completed" });
    const review = { on: { type: "label", any: ["rv"] }, run: { kind: "github", flow: "review" } };
    forgeTriggers(triggersPath, [review, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", maxCostUsd: "0.25" } }]);
    const overridden = await planRerun({ url: URL12, logsDir, jobId: "gh-auth-2", triggersPath, env: {} });
    assert.deepEqual([overridden.plan?.job.flow, overridden.plan?.job.maxCostUsd], ["review", "0.25"], "the override's flow, the comment trigger's fields");
    forgeTriggers(triggersPath, [review, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", command: "triage" } }]);
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "gh-auth-2", triggersPath, env: {} })).refusal, /changed or is gone; .*runs a command now/);
    forgeTriggers(triggersPath, [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } }, cron]);
    // (index 1 is the cron entry now)
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "gh-auth-2", triggersPath, env: {} })).refusal, /changed or is gone; .*is a local trigger now, not github/);
    // A pull request run's action: the trigger at its index must still fire on it.
    await shared.add("github", { ...data, console: undefined, target: { type: "pull_request", number: 9, title: "t", body: "b" }, trigger: { event: "pull_request", action: "opened", deliveryId: "auth-4", sender: { id: 9 }, matched: { index: 1, type: "pull_request", action: "opened" } } }, { jobId: "gh-auth-4" });
    writeRecord(logsDir, { jobId: "gh-auth-4", kind: "github", target: "org/repo#9", outcome: "completed" });
    forgeTriggers(triggersPath, [cron, { on: { type: "pull_request", action: ["opened", "synchronize"] }, run: { kind: "github", flow: "fix" } }]);
    assert.ok((await planRerun({ url: URL12, logsDir, jobId: "gh-auth-4", triggersPath, env: {} })).plan, "still fires on opened");
    forgeTriggers(triggersPath, [cron, { on: { type: "pull_request", action: ["synchronize"] }, run: { kind: "github", flow: "fix" } }]);
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "gh-auth-4", triggersPath, env: {} })).refusal, /no longer fires on opened/);
    // A replica re-runs as itself only while the trigger still races that many.
    await shared.add("github", { ...data, console: undefined, replica: 2, replicas: 2, trigger: { ...data.trigger, deliveryId: "auth-3" } }, { jobId: "gh-auth-3" });
    writeRecord(logsDir, { jobId: "gh-auth-3", kind: "github", target: "org/repo#7", outcome: "completed" });
    forgeTriggers(triggersPath, [cron, { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", replicas: 2 } }]);
    const replica = await planRerun({ url: URL12, logsDir, jobId: "gh-auth-3", triggersPath, env: {} });
    assert.deepEqual([replica.plan?.job.replica, replica.plan?.job.replicas], [2, 2]);
    forgeTriggers(triggersPath, [cron, { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix" } }]);
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "gh-auth-3", triggersPath, env: {} })).refusal, /start it again from the forge \(it no longer runs replica 2\)/);
  } finally {
    await v.done();
  }
});

test("planRerun of a local run re-runs its folder, flow and task on this host's queue, after the folder rule", live, async () => {
  const v = await freshValkey();
  const logsDir = join(tempDir("pd-642-rerun-l-"), "logs");
  try {
    const folder = gitRepo("pd-642-repo-");
    const shared = await v.q("pi-jobs");
    await shared.add("local", { kind: "local", folder, flow: "fix", task: "do it", chainDepth: 1 }, { jobId: "local-abc" });
    writeRecord(logsDir, { jobId: "local-abc", kind: "local", target: "local:x", outcome: "completed" });
    const env = { PI_WORKER_NAME: "mini1" };
    const planned = await planRerun({ url: URL12, logsDir, jobId: "local-abc", env });
    assert.deepEqual([planned.plan.kind, planned.plan.queue, planned.plan.job], ["local", "pi-jobs@mini1", { folder, flow: "fix", task: "do it" }], "a root run: the folder, flow and task only");
    const ok = await enqueueRerun(planned.plan, { url: URL12 });
    assert.equal(ok.ok, true);
    assert.equal(ok.queue, "pi-jobs@mini1");
    const queued = await (await v.q("pi-jobs@mini1")).getJob(ok.jobId);
    assert.deepEqual([queued.data.folder, queued.data.flow, queued.data.task], [folder, "fix", "do it"]);
    // The same run again in the same minute: the local dedup answers, and the enqueue says nothing new was queued.
    const again = await enqueueRerun(planned.plan, { url: URL12 });
    assert.equal(again.deduplicated, true);
    assert.match(again.refusal, /an identical run was queued/);
    // The folder rule: a dirty tree refuses at the plan, and at the enqueue when it turned dirty after the preview.
    writeFileSync(join(folder, "dirty"), "x\n");
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "local-abc", env })).refusal, /uncommitted changes/);
    assert.match((await enqueueRerun(planned.plan, { url: URL12 })).refusal, /uncommitted changes .*changed since the preview/);
    // Expired data names its retention.
    writeRecord(logsDir, { jobId: "local-old", kind: "local", target: "local:x", outcome: "completed" });
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "local-old", env })).refusal, /24 hours after it completes and 7 days after it fails/);
  } finally {
    await v.done();
  }
});

test("planRerun of a cron run fires its trigger as the file says now (`pi-dispatch run --trigger`'s path)", live, async () => {
  const v = await freshValkey();
  const dir = tempDir("pd-642-rerun-c-");
  const logsDir = join(dir, "logs");
  const triggersPath = join(dir, "triggers.json");
  const now = () => Date.parse("2026-10-15T12:34:56Z");
  try {
    const folder = gitRepo("pd-642-cron-");
    writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder, flow: "audit", task: "t" } }] }));
    writeRecord(logsDir, { jobId: "repeat:nightly:1760500000000", kind: "local", target: "local:x", outcome: "completed" });
    const planned = await planRerun({ url: URL12, logsDir, jobId: "repeat:nightly:1760500000000", triggersPath, env: {} });
    assert.equal(planned.plan.kind, "cron");
    assert.equal(planned.plan.queue, "pi-jobs");
    assert.equal(planned.plan.job.flow, "audit");
    const ok = await enqueueRerun(planned.plan, { url: URL12, now });
    assert.deepEqual(ok, { ok: true, jobId: manualTriggerJobId({ triggerId: "nightly", now: new Date(now()) }), queue: "pi-jobs" });
    writeFileSync(triggersPath, JSON.stringify({ triggers: [] }));
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "repeat:nightly:1760500000000", triggersPath, env: {} })).refusal, /no cron trigger with id "nightly" .* any more/);
    assert.match((await planRerun({ url: URL12, logsDir, jobId: "repeat:nightly:1760500000000", env: {} })).refusal, /triggers file is not known here/);
  } finally {
    await v.done();
  }
});

test("planRerun's cron refusals and its fleet flag: another host's trigger, a /command trigger, and fleet = PI_WORKER_NAME set", live, async () => {
  const v = await freshValkey();
  const dir = tempDir("pd-642-rerun-cs-");
  const logsDir = join(dir, "logs");
  const triggersPath = join(dir, "triggers.json");
  try {
    writeFileSync(triggersPath, JSON.stringify({ triggers: [] }));
    await v.q("pi-jobs");
    writeRecord(logsDir, { jobId: "repeat:nightly:1760500000000", kind: "local", target: "local:x", outcome: "completed" });
    const seen = [];
    const plan = (schedule, env = {}) => planRerun({ url: URL12, logsDir, jobId: "repeat:nightly:1760500000000", triggersPath, env, loadSchedulesFn: (cfg, opts) => (seen.push(opts), [schedule]) });
    assert.match((await plan({ schedulerId: "nightly", unserved: true, data: { folder: "/elsewhere", flow: "f" } })).refusal, /cron trigger "nightly" runs on another host: its folder is not on this machine/);
    assert.match((await plan({ schedulerId: "nightly", data: { folder: "/x", command: "triage" } })).refusal, /cron trigger "nightly" runs the command \/triage, and a \/command run is not re-run from the console/);
    // The fleet flag the loader is asked with: whether this deployment names its worker (a fleet member), as the worker's own loader is.
    seen.length = 0;
    await plan({ schedulerId: "other" }, { PI_WORKER_NAME: "mini1" });
    await plan({ schedulerId: "other" }, { PI_WORKER_NAME: "" });
    await plan({ schedulerId: "other" }, {});
    assert.deepEqual(seen, [{ fleet: true }, { fleet: false }, { fleet: false }]);
  } finally {
    await v.done();
  }
});

test("planRerun of a local run that named no flow (blank) is refused by name", live, async () => {
  const v = await freshValkey();
  const logsDir = join(tempDir("pd-642-rerun-nf-"), "logs");
  try {
    const shared = await v.q("pi-jobs");
    await shared.add("local", { kind: "local", folder: "/srv/x", flow: "  ", task: "t" }, { jobId: "local-noflow" });
    writeRecord(logsDir, { jobId: "local-noflow", kind: "local", target: "local:x", outcome: "completed" });
    assert.equal((await planRerun({ url: URL12, logsDir, jobId: "local-noflow", localRepoProblemFn: () => null, gitDirtyFn: () => false })).refusal, "local-noflow named no flow, and a run needs one");
  } finally {
    await v.done();
  }
});

test("the reserve of a re-run and a parked answer uses the deployment's model endpoints and PI_ALLOWED_MODELS (the worker's inputs)", live, async () => {
  const v = await freshValkey();
  const dir = tempDir("pd-642-reserve-");
  const logsDir = join(dir, "logs");
  const triggersPath = join(dir, "triggers.json");
  try {
    const modelEndpoints = { endpoints: [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true }], models: { providers: { "local-ollama": { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "q" }] } } } };
    writeFileSync(
      triggersPath,
      JSON.stringify({
        triggers: [
          { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", provider: "local-ollama", model: "q", resume: true, awaitInput: true } },
          { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", provider: "local-ollama", model: "q", resume: true } },
        ],
      }),
    );
    const shared = await v.q("pi-jobs");
    const data = { repo: "org/repo", target: { type: "issue", ...ISSUE }, flow: "fix", provider: "local-ollama", model: "q", resume: true, awaitInput: true, trigger: { event: "issues", action: "labeled", deliveryId: "z-1", sender: { id: 5 }, matched: { index: 0, type: "label", label: "pi" } } };
    const { jobId } = await enqueueForgeJob(shared, "github", data);
    writeRecord(logsDir, { jobId, kind: "github", target: "org/repo#7", outcome: "completed", reason: "awaiting-input", endedAt: "2026-10-15T10:00:00.000Z" });
    const now = () => Date.parse("2026-10-15T11:00:00Z");
    const env = { PI_MAX_COST_USD: "2" };
    const rerun = (over) => planRerun({ url: URL12, logsDir, jobId, triggersPath, env, ...over });
    const answer = (over) => planParkedAnswer({ url: URL12, logsDir, jobId, text: "ok", by: "alice", triggersPath, env, runsFn: async () => [], now, ...over });
    for (const [what, fn] of [["re-run", rerun], ["parked answer", answer]]) {
      assert.equal((await fn({ modelEndpoints })).plan.reserve.dollarsMicros, 0, `${what}: zero-rated on the declared endpoint, so $0`);
      assert.equal((await fn({})).plan.reserve.dollarsMicros, 2_000_000, `${what}: without the snapshot, fail closed to the cap`);
      const listed = await fn({ modelEndpoints, env: { ...env, PI_ALLOWED_MODELS: "local-ollama/q,anthropic/claude-sonnet-5-5" } });
      assert.equal(listed.plan.reserve.dollarsMicros, 2_000_000, `${what}: the deployment's list holds a hosted model, so the cap`);
    }
  } finally {
    await v.done();
  }
});

// ---- answering a parked run ----

/** The triggers file for a forge: a label trigger that parks, and the comment trigger a reply goes through. */
function parkedTriggers(path, kind) {
  writeFileSync(
    path,
    JSON.stringify({
      triggers: [
        { on: { type: "label", any: ["pi"] }, run: { kind, flow: "fix", resume: true, awaitInput: true } },
        { on: { type: "comment", phrase: "@pi" }, run: { kind, flow: "fix", resume: true, awaitInput: true, progress: true, statusComment: true, recover: true, steer: true, model: "claude-sonnet-5-5", provider: "anthropic", maxCostUsd: "1.25", instructions: "be brief" } },
      ],
    }),
  );
}

const ISSUE = { number: 7, title: "Flaky test", body: "It fails on Mondays" };
const PARKED = "pi-awaiting-input";

/** What each forge's receiver arm makes of a phrase-free reply on the parked issue: the real filter over the real config. */
function receiverReply(kind, triggersPath, body) {
  const cfg = {};
  const loaded = reloadTriggers({ PI_TRIGGERS_FILE: triggersPath }, cfg);
  assert.deepEqual(loaded, { ok: true });
  if (kind === "github") {
    return filter("issue_comment", { action: "created", sender: { id: 42 }, repository: { full_name: "org/repo" }, issue: { ...ISSUE, labels: [{ name: PARKED }] }, comment: { body, author_association: "MEMBER" } }, cfg, 1, "gh-delivery-1").job;
  }
  if (kind === "gitlab") {
    return filterGitLab({ objectKind: "note", action: "create", user: { id: 42 }, project: { id: 99, path: "org/repo" }, noteableType: "Issue", note: body, target: { iid: ISSUE.number, title: ISSUE.title, description: ISSUE.body, labels: [{ name: PARKED }] } }, cfg.triggers.gitlab, cfg.triggers.knownFlows, 1, true, "gl-delivery-1").job;
  }
  return filterForgejo("issue_comment", { action: "created", sender: { id: 42 }, repository: { full_name: "org/repo" }, isPull: false, issue: { ...ISSUE, labels: [{ name: PARKED }] }, comment: { body } }, cfg.triggers.forgejo, cfg.triggers.knownFlows, 1, true, "fj-delivery-1").job;
}

for (const kind of ["github", "gitlab", "forgejo"]) {
  test(`a console answer on ${kind} is the receiver's parked reply field for field, but for delivery id, sender, comment text and console`, live, async () => {
    const v = await freshValkey();
    const dir = tempDir(`pd-642-park-${kind}-`);
    const logsDir = join(dir, "logs");
    const triggersPath = join(dir, "triggers.json");
    try {
      parkedTriggers(triggersPath, kind);
      const shared = await v.q("pi-jobs");
      // The run that parked: a label job on the issue, kept in the queue with its data.
      const parkedData = { repo: "org/repo", ...(kind === "gitlab" ? { projectId: 99 } : {}), target: { type: "issue", ...ISSUE }, flow: "fix", resume: true, awaitInput: true, trigger: { event: "issues", action: "labeled", deliveryId: "orig-1", sender: { id: 5 }, matched: { index: 0, type: "label", label: "pi" } } };
      const { jobId } = await enqueueForgeJob(shared, kind, parkedData);
      // The park released its semantic window (releaseSemanticWindow), so an answer is not a duplicate of it.
      await shared.removeDeduplicationKey("org/repo#7:fix");
      writeRecord(logsDir, { jobId, kind, target: "org/repo#7", outcome: "completed", reason: "awaiting-input", endedAt: "2026-10-15T10:00:00.000Z" });
      const now = () => Date.parse("2026-10-15T11:00:00Z");
      const planned = await planParkedAnswer({ url: URL12, logsDir, jobId, text: "use\u0000 the staging db", by: "alice", triggersPath, runsFn: async () => [], random: (n) => Buffer.alloc(n, 1), now });
      assert.ok(planned.plan, JSON.stringify(planned));
      const consoleJob = planned.plan.job;
      const receiverJob = receiverReply(kind, triggersPath, "use the staging db");
      assert.equal(receiverJob.parkedReply, true, "the receiver routed it as a parked reply");
      const strip = (job) => {
        const { console: _c, trigger, ...rest } = job;
        const { deliveryId: _d, sender: _s, comment, ...t } = trigger;
        const { author_association: _a, ...c } = comment;
        return { ...rest, trigger: { ...t, comment: c } };
      };
      assert.deepEqual(strip(consoleJob), strip(receiverJob), "the same job but for the four named fields");
      assert.equal(consoleJob.trigger.comment.body, "use the staging db", "the answer, scrubbed of control characters");
      assert.deepEqual(consoleJob.console, { by: "alice" });
      assert.equal(consoleJob.trigger.deliveryId, "console-0101010101010101");
      assert.deepEqual(consoleJob.trigger.sender, { id: null });
      if (kind === "github") assert.equal(consoleJob.trigger.comment.author_association, "OWNER");
      else assert.equal("author_association" in consoleJob.trigger.comment, false, "only GitHub's comments carry an association");
      assert.equal(planned.plan.queue, "pi-jobs");
      assert.deepEqual(planned.plan.reserve, { slots: 1, dollarsMicros: 1_250_000, capMicros: 1_250_000, zeroRated: false });
      // Queued with the console field, and a second answer while it is queued is the semantic window's duplicate.
      const ok = await enqueueParkedAnswer(planned.plan, { url: URL12 });
      assert.deepEqual(ok, { ok: true, jobIds: [forgeDeliveryJobId(kind, "console-0101010101010101")], queue: "pi-jobs" });
      assert.deepEqual((await shared.getJob(ok.jobIds[0])).data.console, { by: "alice" });
      // Issue #647: once an answer is queued, the planner refuses a second one by name (no record yet, so the later-run
      // check cannot see it); the semantic window stays the enqueue's own backstop for a plan made before.
      const second = await planParkedAnswer({ url: URL12, logsDir, jobId, text: "again", by: "bob", triggersPath, runsFn: async () => [], now });
      assert.equal(second.refusal, `${jobId} is being answered: ${ok.jobIds[0]} is queued or running on ${planned.plan.job.repo}#${planned.plan.job.target.number}`);
      const racing = { ...planned.plan, job: { ...planned.plan.job, trigger: { ...planned.plan.job.trigger, deliveryId: "console-0202020202020202" } } };
      const dup = await enqueueParkedAnswer(racing, { url: URL12 });
      assert.equal(dup.deduplicated, true);
      assert.match(dup.refusal, /an answer to this issue is already queued or running/);
    } finally {
      await v.done();
    }
  });
}

test("planParkedAnswer refuses by name: not parked, already answered, a pull request, no reply route, bad text or name, expired data", live, async () => {
  const v = await freshValkey();
  const dir = tempDir("pd-642-park-no-");
  const logsDir = join(dir, "logs");
  const triggersPath = join(dir, "triggers.json");
  const now = () => Date.parse("2026-10-15T11:00:00Z");
  try {
    parkedTriggers(triggersPath, "github");
    const shared = await v.q("pi-jobs");
    const base = { repo: "org/repo", target: { type: "issue", ...ISSUE }, flow: "fix", resume: true, awaitInput: true, trigger: { event: "issues", action: "labeled", deliveryId: "p-1", sender: { id: 5 }, matched: { index: 0, type: "label", label: "pi" } } };
    const { jobId } = await enqueueForgeJob(shared, "github", base);
    writeRecord(logsDir, { jobId, kind: "github", target: "org/repo#7", outcome: "completed", reason: "awaiting-input", endedAt: "2026-10-15T10:00:00.000Z" });
    const plan = (over = {}) => planParkedAnswer({ url: URL12, logsDir, jobId, text: "ok", by: "alice", triggersPath, runsFn: async () => [], now, ...over });
    assert.ok((await plan()).plan);
    assert.match((await plan({ text: " \u0007 " })).refusal, /the answer is empty/);
    assert.match((await plan({ text: "x".repeat(8193) })).refusal, /above the 8192-byte limit/);
    assert.match((await plan({ by: "Alice!" })).refusal, /token's name/);
    // Issue #647 part 2: `panel` is the panel's reserved signature. A console token of that name cannot answer, and the
    // panel's answer is signed `panel` whatever `by` it passes, so the worker's trail says the panel answered.
    assert.match((await plan({ by: "panel" })).refusal, /console token is named "panel", the name the \/dispatch panel's answers are signed with/);
    assert.deepEqual((await plan({ by: "alice", from: "panel" })).plan.job.console, { by: "panel" });
    assert.deepEqual((await plan()).plan.job.console, { by: "alice" });
    // A later run on the same target answered it already.
    assert.match((await plan({ runsFn: async () => [{ jobId: "gh-later", kind: "github", target: "org/repo#7", endedAt: "2026-10-15T10:30:00.000Z" }] })).refusal, /already answered: gh-later ran on org\/repo#7 after it/);
    // A later run on the same target string by ANOTHER forge is another issue: it does not answer this one.
    assert.ok((await plan({ runsFn: async () => [{ jobId: "gl-later", kind: "gitlab", target: "org/repo#7", endedAt: "2026-10-15T10:30:00.000Z" }] })).plan);
    // An earlier run, or one on another issue, does not count.
    assert.ok((await plan({ runsFn: async () => [{ jobId: "gh-before", kind: "github", target: "org/repo#7", endedAt: "2026-10-15T09:00:00.000Z" }, { jobId: "gh-other", kind: "github", target: "org/repo#8", endedAt: "2026-10-15T10:30:00.000Z" }] })).plan);
    // The default window: a later record on this host is found without a runsFn.
    writeRecord(logsDir, { jobId: "gh-later-local", kind: "github", target: "org/repo#7", outcome: "completed", endedAt: "2026-10-15T10:45:00.000Z" });
    assert.match((await plan({ runsFn: null })).refusal, /already answered: gh-later-local/);
    // Not parked.
    writeRecord(logsDir, { jobId: "gh-done", kind: "github", target: "org/repo#9", outcome: "completed", endedAt: "2026-10-15T10:00:00.000Z" });
    assert.match((await plan({ jobId: "gh-done" })).refusal, /gh-done is not parked \(it ended completed\)/);
    // Parked on a pull request: its reply keeps the phrase.
    const pr = await enqueueForgeJob(shared, "github", { ...base, target: { type: "pull_request", number: 11, title: "t", body: "b" }, trigger: { ...base.trigger, deliveryId: "p-pr" } });
    writeRecord(logsDir, { jobId: pr.jobId, kind: "github", target: "org/repo#11", outcome: "completed", reason: "awaiting-input", endedAt: "2026-10-15T10:00:00.000Z" });
    assert.match((await plan({ jobId: pr.jobId })).refusal, /parked on a pull request/);
    // Expired data.
    writeRecord(logsDir, { jobId: "gh-expired", kind: "github", target: "org/repo#12", outcome: "completed", reason: "awaiting-input", endedAt: "2026-10-15T10:00:00.000Z" });
    assert.match((await plan({ jobId: "gh-expired" })).refusal, /no longer holds gh-expired's data/);
    // The receiver would not route a reply: no resume on the comment trigger, or no comment trigger at all.
    writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } }] }));
    assert.match((await plan()).refusal, /does not set run\.resume/);
    writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", command: "triage" } }] }));
    assert.match((await plan()).refusal, /the github comment trigger runs a command, and a parked reply resumes only a flow/);
    writeFileSync(triggersPath, JSON.stringify({ triggers: [] }));
    assert.match((await plan()).refusal, /has no github comment trigger/);
    assert.match((await plan({ triggersPath: null })).refusal, /triggers file is not known here/);
  } finally {
    await v.done();
  }
});

test("a park behind a paused queue of 1,200 forge jobs stays answerable: the pending scan reads names and dedup ids inside the fleet read's time, finds an answer however deep, and a queue past its budget is refused with the honest sentence (review round 2)", live, async () => {
  const v = await freshValkey();
  const dir = tempDir("pd-647-deep-");
  const logsDir = join(dir, "logs");
  const triggersPath = join(dir, "triggers.json");
  const now = () => Date.parse("2026-10-15T11:00:00Z");
  try {
    parkedTriggers(triggersPath, "github");
    const shared = await v.q("pi-jobs");
    await shared.pause();
    const comment = "x".repeat(8000); // each job carries a large comment, which the scan never reads
    const base = { repo: "org/repo", target: { type: "issue", ...ISSUE }, flow: "fix", resume: true, awaitInput: true, trigger: { event: "issues", action: "labeled", deliveryId: "deep-park", sender: { id: 5 }, matched: { index: 0, type: "label", label: "pi" } } };
    const { jobId } = await enqueueForgeJob(shared, "github", base);
    await shared.removeDeduplicationKey("org/repo#7:fix");
    writeRecord(logsDir, { jobId, kind: "github", target: "org/repo#7", outcome: "completed", reason: "awaiting-input", endedAt: "2026-10-15T10:00:00.000Z" });
    // 1,200 receiver jobs on other issues, the OLDEST on issue 8 (listed last, newest first), plus cron jobs.
    const other = (i) => ({ ...base, target: { type: "issue", number: 8 + i, title: "t", body: comment }, trigger: { event: "issue_comment", action: "created", deliveryId: `deep-${i}`, sender: { id: 6 }, matched: { index: 1, type: "comment", phrase: "@pi" }, comment: { body: comment } } });
    for (let i = 0; i < 1200; i += 100) await Promise.all(Array.from({ length: 100 }, (_, k) => enqueueForgeJob(shared, "github", other(i + k))));
    await shared.addBulk(Array.from({ length: 100 }, (_, i) => ({ name: "local", data: { kind: "local", folder: `/srv/x${i}`, flow: "nightly" }, opts: { jobId: `local-deep-${i}` } })));
    const counts = await shared.getJobCounts();
    assert.equal(counts.paused + counts.waiting, 1301, JSON.stringify(counts));
    assert.ok(1301 < PENDING_SCAN_BUDGET, "a queue this deep is inside the one budget");
    const read = (over = {}) => readPendingAnswer({ queues: [shared], kind: "github", target: "org/repo#7", runId: jobId, ...over });
    const t0 = performance.now();
    const got = await read();
    const took = performance.now() - t0;
    assert.deepEqual(got, { jobId: null }, "every job seen, none on the park's target: a complete look");
    assert.ok(took < 2000, `inside FLEET_READ_TIMEOUT_MS (${Math.round(took)} ms)`);
    assert.deepEqual(await read({ dataMax: 0 }), { jobId: null }, "no job's data is parsed: forge jobs by their dedup id, cron jobs skipped by name");
    assert.deepEqual(await readPendingAnswer({ queues: [shared], kind: "github", target: "org/repo#8", runId: null }), { jobId: forgeDeliveryJobId("github", "deep-0") }, "the oldest job, listed last, is found");
    assert.ok((await planParkedAnswer({ url: URL12, logsDir, jobId, text: "ok", by: "alice", triggersPath, runsFn: async () => [], now })).plan, "the park is answerable");
    // A budget below the queue's depth: the scan cannot tell, the planner refuses with chat-mode's honest sentence.
    assert.deepEqual(await read({ budget: 1000 }), { unknown: true, tooMany: true });
    const deep = await planParkedAnswer({ url: URL12, logsDir, jobId, text: "ok", by: "alice", triggersPath, runsFn: async () => [], now, pendingBudget: 1000 });
    assert.equal(deep.refusal, `${CHAT_REFUSALS.parkedTooMany} Nothing was queued.`);
    // A job with no dedup id (a late message's, a recovery's) is read through its data: the park's own recovery is not
    // its answer, a late message's job on its target is.
    await shared.add("github", { ...base, kind: "github", recoveryOf: jobId }, { jobId: `${jobId}.r1` });
    assert.deepEqual(await read(), { jobId: null }, "the park's own recovery");
    await enqueueLateForgeJob(shared, "github", { ...base, trigger: { ...base.trigger, deliveryId: "deep-late" } });
    assert.deepEqual(await read(), { jobId: forgeDeliveryJobId("github", "deep-late") });
  } finally {
    await v.done();
  }
});

test("the read model re-exports the worker's reserve rule for the console", () => {
  assert.deepEqual(estimateReserve({ kind: "github", maxCostUsd: "0.5" }, { env: { PI_MAX_COST_USD: "2" } }), { slots: 1, dollarsMicros: 500_000, capMicros: 500_000, zeroRated: false });
});

// ---- steering a running job (issue #646) ----

/** A job held ACTIVE by a bare BullMQ Worker until `release()`: what a running steer-armed run looks like to a queue. */
async function activeJob(v, name, id, data) {
  const { Worker } = await import("bullmq");
  const queue = await v.q(name);
  let release;
  const held = new Promise((r) => (release = r));
  await queue.add(data.kind ?? "x", data, { jobId: id, attempts: 1 });
  const worker = new Worker(name, () => held, { connection: parseConnection(URL12), concurrency: 1 });
  await until(async () => (await (await queue.getJob(id))?.getState()) === "active");
  return {
    queue,
    async stop() {
      release();
      await worker.close();
    },
  };
}

test("planSteer refuses by name before anything is written: source, sender, mode, empty and oversize text, no job, not active, not armed, not open", live, async () => {
  const v = await freshValkey();
  const held = [];
  try {
    const armed = await activeJob(v, "pi-jobs", "gh-s1", { kind: "github", repo: "o/r", steer: true, target: { type: "issue", number: 1 } });
    held.push(armed);
    // While the shared queue's one worker is busy, a second armed job stays waiting there.
    await armed.queue.add("github", { kind: "github", repo: "o/r", steer: true }, { jobId: "gh-s3" });
    held.push(await activeJob(v, "pi-jobs@h2", "gh-s2", { kind: "github", repo: "o/r", target: { type: "issue", number: 2 } }));
    const plan = (over = {}) => planSteer({ url: URL12, jobId: "gh-s1", text: "use the staging db", mode: "steer", by: "alice", ...over });
    assert.match((await plan({ source: "forge" })).refusal, /the source is not one of console, panel/);
    assert.match((await plan({ by: "Alice!" })).refusal, /sender's name/);
    assert.match((await plan({ mode: "later" })).refusal, /the mode is not one of steer, followUp/);
    assert.match((await plan({ text: " \u0007\u200b " })).refusal, /the message is empty/);
    assert.match((await plan({ text: "x".repeat(8193) })).refusal, /8193 bytes, above the 8192-byte limit; shorten it\. Nothing was sent/);
    assert.match((await plan({ jobId: "gh-none" })).refusal, /no job gh-none in 2 queue\(s\); nothing was sent/);
    assert.match((await plan({ jobId: "gh-s3" })).refusal, /job gh-s3 is waiting: only a running job takes messages\. Nothing was sent/);
    assert.match((await plan({ jobId: "gh-s2" })).refusal, /job gh-s2 is not steer-armed \(its trigger does not set run\.steer\)/);
    // Armed and active, but the relay has not opened the run (no `run:steer:open:` key): one sentence for all three causes.
    assert.match((await plan()).refusal, /the run is not accepting messages: it is not steer-armed, not running, or its venue cannot deliver/);
    await registerLive({ redis: v.redis, runId: "gh-s1", host: "h1" });
    const ok = await plan({ text: "use the\u200b staging db\r\n" });
    assert.equal(ok.plan.kind, "steer");
    assert.equal(ok.plan.runId, "gh-s1");
    assert.equal(ok.plan.text, "use the staging db\n", "the bounded text: invisible characters removed, line endings folded, never cut");
    assert.equal(ok.plan.bytes, Buffer.byteLength(ok.plan.text));
    assert.match(ok.plan.id, /^[0-9a-f]{32}$/);
    assert.equal(ok.plan.digest.length, 64);
    assert.deepEqual(await listInboxPublic({ redis: v.redis, runId: "gh-s1" }), { entries: [], closed: false }, "a plan writes nothing");
  } finally {
    for (const h of held) await h.stop();
    await v.done();
  }
});

test("enqueueSteer pushes exactly the plan as an operator message; withdraw names the prior state; a closed inbox refuses", live, async () => {
  const v = await freshValkey();
  const held = [];
  try {
    held.push(await activeJob(v, "pi-jobs", "gh-r1", { kind: "github", repo: "o/r", steer: true, recoveryOf: "gh-base", target: { type: "issue", number: 1 } }));
    // A recovery job steers the run it continues: the open key and the inbox are the base run's.
    await registerLive({ redis: v.redis, runId: "gh-base", host: "h1" });
    const plan = async (text, mode = "steer", source = "console", by = "alice") => (await planSteer({ url: URL12, jobId: "gh-r1", text, mode, by, source })).plan;
    const p1 = await plan("first", "followUp");
    assert.equal(p1.runId, "gh-base");
    assert.deepEqual(await enqueueSteer(p1, { url: URL12, now: () => 1_791_000_000_000 }), { ok: true, jobId: "gh-r1", id: p1.id, mode: "followUp", state: "queued" });
    const stored = (await readInbox({ redis: v.redis, runId: "gh-base" })).entries[0];
    assert.deepEqual(stored, { v: 1, id: p1.id, mode: "followUp", source: "console", author: { kind: "operator", by: "alice" }, text: "first", at: 1_791_000_000_000 });
    assert.match((await enqueueSteer(p1, { url: URL12 })).refusal, /already in the run's inbox; nothing new was sent/, "a replayed plan is dup");
    const p2 = await plan("second", "steer", "panel", "panel");
    assert.equal((await enqueueSteer(p2, { url: URL12 })).ok, true);
    assert.equal((await readInbox({ redis: v.redis, runId: "gh-base" })).entries[1].source, "panel");
    // Withdraw a queued message: guaranteed.
    const w1 = await planSteerWithdraw({ url: URL12, jobId: "gh-r1", id: p1.id });
    assert.deepEqual(w1.plan, { kind: "steer-withdraw", jobId: "gh-r1", runId: "gh-base", id: p1.id, prior: "queued" });
    const done1 = await withdrawSteerMessage(w1.plan, { url: URL12 });
    assert.deepEqual([done1.ok, done1.prior, done1.guaranteed], [true, "queued", true]);
    assert.match(done1.said, /was queued, so the run never sees it \(guaranteed\)/);
    assert.match((await planSteerWithdraw({ url: URL12, jobId: "gh-r1", id: p1.id })).unchanged, /already withdrawn; nothing was changed/);
    // Withdraw a written message: best effort, said so.
    await markState({ redis: v.redis, runId: "gh-base", id: p2.id, from: ["queued"], to: "written" });
    const w2 = await planSteerWithdraw({ url: URL12, jobId: "gh-r1", id: p2.id });
    assert.equal(w2.plan.prior, "written");
    const done2 = await withdrawSteerMessage(w2.plan, { url: URL12 });
    assert.deepEqual([done2.ok, done2.prior, done2.guaranteed], [true, "written", false]);
    assert.match(done2.said, /best effort: the agent may have read it/);
    // Delivered and unknown messages cannot be withdrawn.
    const p3 = await plan("third");
    await enqueueSteer(p3, { url: URL12 });
    await markState({ redis: v.redis, runId: "gh-base", id: p3.id, from: ["queued"], to: "delivered" });
    assert.match((await planSteerWithdraw({ url: URL12, jobId: "gh-r1", id: p3.id })).refusal, /already delivered: the agent has received it/);
    assert.match((await planSteerWithdraw({ url: URL12, jobId: "gh-r1", id: "f".repeat(32) })).refusal, /no message f{32} in the inbox of gh-r1/);
    assert.match((await planSteerWithdraw({ url: URL12, jobId: "gh-r1", id: "nope" })).refusal, /32 lowercase hex/);
    // A plan made while open, pushed after the final close, is refused: it is never accepted and silently unseen.
    const p4 = await plan("fourth");
    await closeInbox({ redis: v.redis, runId: "gh-base" });
    assert.match((await enqueueSteer(p4, { url: URL12 })).refusal, /the run has finished and its inbox is closed\. Nothing was sent/);
    assert.match((await enqueueSteer({ kind: "rerun" }, { url: URL12 })).refusal, /not a steer plan/);
    // The public list never carries the text.
    const pub = await listInboxPublic({ redis: v.redis, runId: "gh-base" });
    assert.ok(!JSON.stringify(pub).includes("first") && !JSON.stringify(pub).includes("third"));
  } finally {
    for (const h of held) await h.stop();
    await v.done();
  }
});

test("the fleet reader's inbox read and snapshot: a steer-armed active job's entries without text; an unarmed job carries neither field", live, async () => {
  const v = await freshValkey();
  const held = [];
  const dir = tempDir("pd-646-reader-");
  const reader = createFleetReader({ valkeyUrl: URL12, logsDir: join(dir, "logs"), triggersPath: join(dir, "triggers.json") }, { readOnly: true, activeLimit: 50 });
  try {
    held.push(await activeJob(v, "pi-jobs", "gh-a1", { kind: "github", repo: "o/r", steer: true, target: { type: "issue", number: 1 } }));
    held.push(await activeJob(v, "pi-jobs@h2", "gh-a2", { kind: "github", repo: "o/r", target: { type: "issue", number: 2 } }));
    await beat(v.redis, "h2", "");
    await registerLive({ redis: v.redis, runId: "gh-a1", host: "h1" });
    const p = (await planSteer({ url: URL12, jobId: "gh-a1", text: "READER-TEXT-CANARY", by: "alice" })).plan;
    await enqueueSteer(p, { url: URL12, now: () => 1_791_000_000_000 });
    const one = await reader.inbox("gh-a1");
    assert.deepEqual(one, { found: true, steer: true, state: "active", open: true, entries: [{ id: p.id, mode: "steer", source: "console", state: "queued", at: 1_791_000_000_000, bytes: 18 }], closed: false });
    assert.deepEqual(await reader.inbox("gh-a2"), { found: true, steer: false }, "found on a registered host's queue, not armed");
    assert.deepEqual(await reader.inbox("gh-none"), { found: false });
    assert.deepEqual(await reader.inbox("<b>"), { invalid: true });
    const snap = await reader.snapshot();
    const byId = Object.fromEntries(snap.active.map((a) => [a.jobId, a]));
    assert.deepEqual([byId["gh-a1"].steer, byId["gh-a1"].inbox], [true, one.entries]);
    assert.equal("steer" in byId["gh-a2"] || "inbox" in byId["gh-a2"], false);
    assert.ok(!JSON.stringify(snap).includes("READER-TEXT-CANARY"), "the snapshot never holds the text");
  } finally {
    await reader.dispose();
    for (const h of held) await h.stop();
    await v.done();
  }
});

// ---- review round 1 (issue #646 part 3): the refusals and branches the first tests left unpinned ----

const sha = (t) => createHash("sha256").update(t).digest("hex");

/** A job that COMPLETED for real: added, then taken by a bare Worker whose processor returns. */
async function completedJob(v, name, id, data) {
  const { Worker } = await import("bullmq");
  const queue = await v.q(name);
  await queue.add(data.kind ?? "x", data, { jobId: id, attempts: 1 });
  const worker = new Worker(name, async () => "done", { connection: parseConnection(URL12) });
  await until(async () => (await (await queue.getJob(id))?.getState()) === "completed");
  await worker.close();
  return queue;
}

test("planSteer, every branch: completed and unknown states, an open read that fails, a bad job id, the framed-file cap, the cli source, multibyte bytes, the digest and the queue", live, async () => {
  const v = await freshValkey();
  const held = [];
  try {
    held.push(await activeJob(v, "pi-jobs", "gh-b1", { kind: "github", repo: "o/r", steer: true, target: { type: "issue", number: 1 } }));
    await completedJob(v, "pi-jobs@h3", "gh-done", { kind: "github", repo: "o/r", steer: true });
    await registerLive({ redis: v.redis, runId: "gh-b1", host: "h1" });
    const plan = (over = {}) => planSteer({ url: URL12, jobId: "gh-b1", text: "go", mode: "steer", by: "alice", ...over });
    assert.match((await plan({ jobId: "gh-done" })).refusal, /^job gh-done is completed: only a running job takes messages\. Nothing was sent$/);
    assert.match((await plan({ source: "cli" })).refusal, /the source is not one of console, panel/, "the CLI's own source is not the console's to write");
    assert.match((await plan({ jobId: "gh b1" })).refusal, /a job id is letters, digits and \. _ : -, at most 200 characters/);
    // The framed inbox file's cap (normalizeSteerEntry's own refusal): backslashes double in JSON.
    assert.match((await plan({ text: "\\".repeat(8190) })).refusal, /above the 16384-byte inbox file limit/);
    const ok = (await plan({ text: "üñï" })).plan;
    assert.deepEqual([ok.bytes, ok.text.length, ok.queue, ok.digest, ok.jobId], [6, 3, "pi-jobs", sha("üñï"), "gh-b1"]);
    // A state the queue cannot read is "unknown", and an open read that fails is said, not taken for "not open".
    const realQueue = (conn, o) => makeQueue(conn, o);
    const queueFn = (conn, o) => {
      const q = realQueue(conn, o);
      return new Proxy(q, { get: (t, k) => (k === "getJob" ? async (id) => { const j = await t.getJob(id); return j && id === "gh-b1" ? Object.assign(Object.create(Object.getPrototypeOf(j)), j, { getState: async () => { throw new Error("gone"); } }) : j; } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
    };
    assert.match((await plan({ queueFn })).refusal, /job gh-b1 is unknown: only a running job takes messages/);
    const redisFn = (url) => {
      const c = makeRedisClient(url);
      return new Proxy(c, { get: (t, k) => (k === "exists" ? async (key) => { if (String(key).startsWith("run:steer:open:")) throw Object.assign(new Error("x"), { code: "ECONNRESET" }); return t.exists(key); } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
    };
    assert.match((await plan({ redisFn })).refusal, /the run's inbox could not be read \(Valkey said ECONNRESET\); nothing was sent/);
  } finally {
    for (const h of held) await h.stop();
    await v.done();
  }
});

test("enqueueSteer and the withdraw funnels, every branch: gone, full, an entry refused, Valkey down, the plan guards, late, not in the fleet, a state read that fails, the race to delivered", live, async () => {
  const v = await freshValkey();
  const held = [];
  try {
    held.push(await activeJob(v, "pi-jobs", "gh-e1", { kind: "github", repo: "o/r", steer: true, target: { type: "issue", number: 1 } }));
    await registerLive({ redis: v.redis, runId: "gh-e1", host: "h1" });
    const mk = async (text = "m") => (await planSteer({ url: URL12, jobId: "gh-e1", text, by: "alice" })).plan;
    const p = await mk();
    const down = () => ({ on() {}, disconnect() {}, eval: async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); }, hget: async () => { throw Object.assign(new Error("y"), { code: "ECONNREFUSED" }); } });
    assert.deepEqual(await enqueueSteer(p, { url: URL12, redisFn: down }), { unreachable: "Valkey said ECONNREFUSED" });
    assert.match((await enqueueSteer({ ...p, by: "Bad!" }, { url: URL12 })).refusal, /an operator message needs an operator author/);
    assert.equal((await enqueueSteer({ ...p, kind: "rerun" }, { url: URL12 })).refusal, "not a steer plan");
    assert.equal((await enqueueSteer({ ...p, source: "cli" }, { url: URL12 })).refusal, "not a steer plan");
    // Full: 16 messages per run, then the 17th.
    for (let i = 0; i < 16; i += 1) assert.equal((await enqueueSteer(await mk(`m${i}`), { url: URL12 })).ok, true);
    assert.match((await enqueueSteer(await mk("one more"), { url: URL12 })).refusal, /the run's inbox is full \(at most 16 messages and 65536 bytes per run, withdrawn ones included\)\. Nothing was sent/);
    // Gone: the relay stopped refreshing (the open key lapsed) after the plan.
    const fresh = v.redis;
    await fresh.del("run:inbox:gh-e1", "run:inbox:state:gh-e1");
    const p2 = await mk("late plan");
    await fresh.del("run:steer:open:gh-e1");
    assert.match((await enqueueSteer(p2, { url: URL12 })).refusal, /the run stopped accepting messages before this one arrived/);
    await registerLive({ redis: fresh, runId: "gh-e1", host: "h1" });
    // Withdraw: late is refused at the plan; a race to delivered between plan and withdraw is refused at the withdraw.
    const p3 = await mk("three");
    await enqueueSteer(p3, { url: URL12 });
    await markState({ redis: fresh, runId: "gh-e1", id: p3.id, from: ["queued"], to: "late" });
    assert.match((await planSteerWithdraw({ url: URL12, jobId: "gh-e1", id: p3.id })).refusal, /arrived after the run had ended \(late\)/);
    const p4 = await mk("four");
    await enqueueSteer(p4, { url: URL12 });
    const w4 = (await planSteerWithdraw({ url: URL12, jobId: "gh-e1", id: p4.id })).plan;
    await markState({ redis: fresh, runId: "gh-e1", id: p4.id, from: ["queued"], to: "delivered" });
    assert.match((await withdrawSteerMessage(w4, { url: URL12 })).refusal, /already delivered/, "the script's answer, not the preview's");
    assert.equal(await (await import("@edgehero/pi-dispatch/steer-inbox")).messageState({ redis: fresh, runId: "gh-e1", id: p4.id }), "delivered", "nothing changed");
    assert.match((await withdrawSteerMessage({ ...w4, id: "nope" }, { url: URL12 })).refusal, /32 lowercase hex/);
    assert.deepEqual(await withdrawSteerMessage(w4, { url: URL12, redisFn: down }), { unreachable: "Valkey said ECONNREFUSED" });
    assert.equal((await withdrawSteerMessage({ ...w4, kind: "steer" }, { url: URL12 })).refusal, "not a steer-withdraw plan");
    assert.match((await planSteerWithdraw({ url: URL12, jobId: "gh-none", id: p4.id })).refusal, /^no job gh-none in \d+ queue\(s\); nothing was changed$/);
    const badHget = (url) => {
      const c = makeRedisClient(url);
      return new Proxy(c, { get: (t, k) => (k === "hget" ? async () => { throw Object.assign(new Error("z"), { code: "ETIMEDOUT" }); } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
    };
    assert.match((await planSteerWithdraw({ url: URL12, jobId: "gh-e1", id: p4.id, redisFn: badHget })).refusal, /the run's inbox could not be read \(Valkey said ETIMEDOUT\); nothing was changed/);
  } finally {
    for (const h of held) await h.stop();
    await v.done();
  }
});

test("a recovered run (review F4): the base job failed and its .r1 runs; the base page's inbox names the recovery job and a message planned there goes through it", live, async () => {
  const v = await freshValkey();
  const held = [];
  try {
    await makeFailed(v, "pi-jobs@h4", [{ id: "gh-base", data: { kind: "github", repo: "o/r", steer: true, target: { type: "issue", number: 1 } } }]);
    held.push(await activeJob(v, "pi-jobs", "gh-base.r1", { kind: "github", repo: "o/r", steer: true, recoveryOf: "gh-base", recovery: 1, target: { type: "issue", number: 1 } }));
    await registerLive({ redis: v.redis, runId: "gh-base", host: "h1" });
    const p = (await planSteer({ url: URL12, jobId: "gh-base", text: "from the base page", by: "alice" })).plan;
    assert.deepEqual([p.jobId, p.runId, p.queue], ["gh-base.r1", "gh-base", "pi-jobs"]);
    assert.equal((await enqueueSteer(p, { url: URL12 })).jobId, "gh-base.r1");
    const queues = [makeQueue(parseConnection(URL12, { failFast: true }), { name: "pi-jobs" }), makeQueue(parseConnection(URL12, { failFast: true }), { name: "pi-jobs@h4" })];
    try {
      const base = await readJobInbox({ redis: v.redis, queues, jobId: "gh-base" });
      assert.deepEqual([base.state, base.open, base.continuesAs, base.entries.length], ["failed", true, "gh-base.r1", 1]);
      const r1 = await readJobInbox({ redis: v.redis, queues, jobId: "gh-base.r1" });
      assert.deepEqual([r1.state, "continuesAs" in r1, r1.entries[0].id], ["active", false, p.id], "the recovery job reads the base run's inbox (runIdOf)");
    } finally {
      for (const q of queues) await q.close();
    }
  } finally {
    for (const h of held) await h.stop();
    await v.done();
  }
});

test("the snapshot's inbox read: 16 armed rows per tick (the 17th null, never []), the recovery's run id, steer must be true, and the rows rebuilt", live, async () => {
  const v = await freshValkey();
  const dir = tempDir("pd-646-bound-");
  try {
    const { pushSteer } = await import("@edgehero/pi-dispatch/steer-inbox");
    const jobs = Array.from({ length: STEER_INBOX_ROWS_MAX + 1 }, (_, i) => ({ id: `gh-k${String(i).padStart(2, "0")}`, data: { steer: true }, processedOn: 1000 + i }));
    jobs.push({ id: "gh-rec.r1", data: { steer: true, recoveryOf: "gh-rec" }, processedOn: 5 }, { id: "gh-truthy", data: { steer: "yes" }, processedOn: 6 });
    // The recovery's message lives under its base run's id; the 16 bounded rows have none.
    await registerLive({ redis: v.redis, runId: "gh-rec", host: "h1" });
    await pushSteer({ redis: v.redis, runId: "gh-rec", entry: { v: 1, id: "c".repeat(32), mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "x", at: 7 } });
    // The recovery row first, so it is inside the per-tick bound.
    const ordered = [jobs.at(-2), ...jobs.slice(0, -2), jobs.at(-1)];
    const canned = (_c, { name = "pi-jobs" } = {}) => ({ name, isPaused: async () => false, getJobCounts: async () => ({}), getWorkers: async () => [], getJobSchedulers: async () => [], getActive: async () => (name === "pi-jobs" ? ordered : []), getFailed: async () => [], close: async () => {} });
    const reader = createFleetReader({ valkeyUrl: URL12, logsDir: join(dir, "logs"), triggersPath: join(dir, "t.json") }, { makeQueueFn: canned, readOnly: true, activeLimit: 50, readLiveHostsFn: async () => ({ hosts: [] }) });
    try {
      const snap = await reader.snapshot();
      const rows = snap.active;
      const armed = rows.filter((r) => r.steer === true);
      assert.equal(armed.length, STEER_INBOX_ROWS_MAX + 2, "every armed row is marked");
      assert.equal(armed.filter((r) => Array.isArray(r.inbox)).length, STEER_INBOX_ROWS_MAX, "16 read per tick");
      assert.equal(armed.at(-1).inbox, null, "the 17th armed row is null (not read), never []");
      assert.deepEqual(rows.find((r) => r.jobId === "gh-rec.r1").inbox.map((e) => e.id), ["c".repeat(32)], "read under recoveryOf");
      assert.deepEqual(rows.find((r) => r.jobId === "gh-k00").inbox, [], "a read inbox with no message is []");
      const truthy = rows.find((r) => r.jobId === "gh-truthy");
      assert.equal("steer" in truthy || "inbox" in truthy, false, "a truthy steer that is not true is unarmed");
    } finally {
      await reader.dispose();
    }
  } finally {
    await v.done();
  }
});

test("publicInboxEntry rebuilds each field and drops what fails; readJobInbox keeps the state charset, open null apart from false, closed, and bounds its wait", async () => {
  assert.deepEqual(publicInboxEntry({ id: "<b>", mode: "shout", source: "evil", state: "gone", at: -1, bytes: "9", text: "T" }), { id: null, mode: null, source: null, state: null, at: null, bytes: 0 });
  const id = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(publicInboxEntry({ id, mode: "followUp", source: "panel", state: "late", at: 5, bytes: 3 }), { id, mode: "followUp", source: "panel", state: "late", at: 5, bytes: 3 });
  const job = (state, data = { steer: true }) => ({ id: "gh-1", data, getState: async () => state });
  const q = (j) => [{ name: "pi-jobs", getJob: async (x) => (x === j.id ? j : null) }];
  const redis = (over = {}) => ({
    exists: async () => 1,
    multi: () => {
      const c = { hgetall: () => c, exists: () => c, exec: async () => [[null, { [id]: "queued", [`m:${id}`]: "1 steer cli 5 2" }], [null, over.closed ?? 0]] };
      return c;
    },
    ...over,
  });
  const got = await readJobInbox({ redis: redis({ closed: 1 }), queues: q(job("Weird State!")), jobId: "gh-1" });
  assert.deepEqual(got, { found: true, steer: true, state: "unknown", open: true, entries: [{ id, mode: "steer", source: "cli", state: "queued", at: 5, bytes: 2 }], closed: true });
  const openFails = await readJobInbox({ redis: redis({ exists: async () => { throw new Error("x"); } }), queues: q(job("active")), jobId: "gh-1" });
  assert.equal(openFails.open, null, "an unread open key is null, never false");
  const shut = await readJobInbox({ redis: redis({ exists: async () => 0 }), queues: q(job("active")), jobId: "gh-1" });
  assert.equal(shut.open, false);
  const listFails = await readJobInbox({ redis: redis({ multi: () => { throw new Error("m"); } }), queues: q(job("active")), jobId: "gh-1" });
  assert.equal(listFails.entries, null, "an unread list is null, never []");
  assert.deepEqual(await readJobInbox({ redis: redis(), queues: [{ name: "q", getJob: () => new Promise(() => {}) }], jobId: "gh-1", timeoutMs: 20 }), { unreachable: true }, "a read that never answers is bounded");
  assert.deepEqual(await readJobInbox({ redis: redis(), queues: q(job("active", { steer: 1 })), jobId: "gh-1" }), { found: true, steer: false });
});

test("steerAuditTarget: the job and the 32-hex message id, split on the last #; a long job id is cut, the message id kept", () => {
  const id = "a".repeat(32);
  assert.equal(steerAuditTarget("gh-1", id), `gh-1#${id}`);
  const long = "j".repeat(200);
  const t = steerAuditTarget(long, id);
  assert.equal(t, `${"j".repeat(166)}#${id}`);
  assert.equal(t.length, 199, "inside the audit row's 200-character cap");
});
