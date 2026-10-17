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
  estimateReserve,
  planFailedBulk,
  planParkedAnswer,
  planRerun,
  removeFailedJob,
  retryFailedJob,
  retryFailedJobs,
  setQueuePausedOne,
} from "../src/read-model.mjs";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeQueue, enqueueForgeJob, forgeDeliveryJobId, manualTriggerJobId } from "@edgehero/pi-dispatch/queue";
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
      const second = await planParkedAnswer({ url: URL12, logsDir, jobId, text: "again", by: "bob", triggersPath, runsFn: async () => [], now });
      const dup = await enqueueParkedAnswer(second.plan, { url: URL12 });
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

test("the read model re-exports the worker's reserve rule for the console", () => {
  assert.deepEqual(estimateReserve({ kind: "github", maxCostUsd: "0.5" }, { env: { PI_MAX_COST_USD: "2" } }), { slots: 1, dollarsMicros: 500_000, capMicros: 500_000, zeroRated: false });
});
