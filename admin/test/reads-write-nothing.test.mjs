// Issue #1036: a read writes nothing, and a page view and a preview are reads. The rule is held on the wire, over a
// real console, in panel-audit-wiring.test.mjs; this file holds each call site to the read-only form by itself, over
// the real readers and a recording client, so a site that goes back to the default is named here. Two things a
// default read writes are watched: a queue built with BullMQ's meta write (`makeQueue` without `metaWrite: false`),
// and a stale `host:live` member removed (SREM) by a registry read that prunes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_SET } from "@edgehero/pi-dispatch/host-registry";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { cancelQueuedJob, checkTriggerFixSource, dispatchRunAlready, planCancelQueued, planFailedBulk, planParkedAnswer, planRerun, planSteer, planSteerWithdraw, retryFailedJobs } from "../src/job-actions.mjs";
import { readJobsData } from "../src/console/job-data.mjs";
import { assembleGraph, assembleInsightsView, assembleSizingView } from "../src/insights-assembly.mjs";
import { readSubscriptionStatusOf } from "../src/read-model.mjs";
import { planTriggerFire } from "../src/trigger-fire.mjs";
import { readTriggerScheduleZones } from "../src/trigger-schedule-zones.mjs";
import { keyedRedis, registryKeys } from "./helpers/fleet-reader-fakes.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = Date.now();
const STALE = "gone-host";

/**
 * A fleet as the real readers see it: `hosta` live, and `gone-host` listed in the registry with no row, the stale
 * member a pruning read removes. `redisFn` gives a client that records every SREM in `pruned`; `queueFn` builds a
 * queue that answers every read with nothing and records the options it was built with in `built`.
 */
function recordingFleet() {
  const pruned = [];
  const built = [];
  const keys = registryKeys({ hosta: { routes: "true", beatAt: String(NOW) } });
  keys[HOST_SET] = ["hosta", STALE];
  const redisFn = () => ({
    ...keyedRedis(keys),
    status: "ready",
    async srem(key, ...members) { pruned.push([key, ...members]); return members.length; },
    async zrange() { return []; },
    async eval() { return null; },
    async quit() {},
  });
  const queueFn = (_connection, options = {}) => {
    built.push({ ...options });
    return {
      name: options.name ?? "pi-jobs",
      client: Promise.resolve({ status: "ready", once() {} }),
      async getJob() { return null; },
      async getJobs() { return []; },
      async getFailed() { return []; },
      async getJobCounts() { return { failed: 0 }; },
      async getJobScheduler() { return null; },
      async getJobSchedulers() { return []; },
      async isPaused() { return false; },
      async close() {},
      disconnect() {},
    };
  };
  return { pruned, built, redisFn, queueFn, parseConnectionFn: () => ({}) };
}

/** A deployment's files in a temp folder: a triggers file with one label rule and one cron rule, and a logs folder. */
function files() {
  const dir = tempDir("pd-1036-reads-");
  const logsDir = join(dir, "logs");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(join(dir, "repo"));
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [
    { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "triage" } },
    { on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: join(dir, "repo"), flow: "fix", task: "look", maxCostUsd: "1" } },
  ] }));
  const record = (r) => writeFileSync(join(logsDir, `${sanitizeJobId(r.jobId)}.json`), JSON.stringify(r));
  return { dir, logsDir, triggersPath, record };
}

/** What a read-only walk leaves: every queue built without the meta write, and no member removed. */
function assertRead(what, f, { queues = true } = {}) {
  if (queues) assert.ok(f.built.length > 0, `${what}: it built a queue, so the check below is not empty`);
  assert.deepEqual(f.built.filter((o) => o.metaWrite !== false), [], `${what}: every queue is built without the meta write`);
  assert.deepEqual(f.pruned, [], `${what}: no registry member is removed`);
}

test("a preview's plan reads the fleet without writing: its queues are built without the meta write and its registry read prunes nothing (#1036)", async () => {
  const d = files();
  const iso = (ms) => new Date(ms).toISOString();
  d.record({ jobId: "local-done", kind: "local", target: "repo", flow: "fix", startedAt: iso(NOW - 120_000), endedAt: iso(NOW - 60_000), outcome: "completed", reason: null, host: "hosta" });
  d.record({ jobId: "gh-parked", kind: "github", target: "acme/web#1", flow: "triage", startedAt: iso(NOW - 120_000), endedAt: iso(NOW - 60_000), outcome: "completed", reason: "awaiting-input", host: "hosta" });
  const PLANS = [
    ["retry-all-failed and remove-all-failed (planFailedBulk)", (f) => planFailedBulk({ url: "redis://unit", ...f })],
    ["cancel-queued (planCancelQueued)", (f) => planCancelQueued({ url: "redis://unit", jobId: "local-w1", ...f })],
    ["rerun (planRerun)", (f) => planRerun({ url: "redis://unit", logsDir: d.logsDir, jobId: "local-done", triggersPath: d.triggersPath, ...f })],
    ["parked-answer (planParkedAnswer)", (f) => planParkedAnswer({ url: "redis://unit", logsDir: d.logsDir, jobId: "gh-parked", text: "yes", by: "ops", triggersPath: d.triggersPath, runsFn: async () => [], ...f })],
    ["steer (planSteer)", (f) => planSteer({ url: "redis://unit", jobId: "local-run", mode: "steer", text: "go on", by: "ops", ...f })],
    ["steer-withdraw (planSteerWithdraw)", (f) => planSteerWithdraw({ url: "redis://unit", jobId: "local-run", id: "a".repeat(32), ...f })],
    ["the zero touch fix's source check (checkTriggerFixSource)", (f) => checkTriggerFixSource({ url: "redis://unit", jobId: "gh-refused", index: 0, triggersPath: d.triggersPath, ...f })],
  ];
  for (const [what, plan] of PLANS) {
    const f = recordingFleet();
    const out = await plan(f);
    assert.ok(out !== null && typeof out === "object", `${what} answered`);
    assertRead(what, f);
  }
});

test("a confirm keeps the default: the write's own walk of the fleet builds its queues as before and prunes the registry (#1036)", async () => {
  const WRITES = [
    ["retry-failed's confirm (retryFailedJobs)", (f) => retryFailedJobs({ url: "redis://unit", jobs: [{ jobId: "local-f1", attemptsMade: 1, finishedOn: 1 }], ...f })],
    ["cancel-queued's confirm (cancelQueuedJob)", (f) => cancelQueuedJob({ url: "redis://unit", jobId: "local-w1", expect: { queue: "pi-jobs", attemptsMade: 0, stalledCounter: 0 }, ...f })],
  ];
  for (const [what, write] of WRITES) {
    const f = recordingFleet();
    await write(f);
    assert.ok(f.built.length > 0, `${what} built a queue`);
    assert.deepEqual(f.built.filter((o) => o.metaWrite === false), [], `${what}: built as a writer builds them`);
    assert.deepEqual(f.pruned, [[HOST_SET, STALE]], `${what}: the stale member is removed, as before`);
  }
});

test("the reads beside a preview write nothing: a dispatch_run's look for a run like it, a retry's job data, and the hosts' subscription status (#1036)", async () => {
  const run = recordingFleet();
  await dispatchRunAlready({ url: "redis://unit", folder: "/srv/repo", flow: "fix", env: {}, queueFn: run.queueFn, parseConnectionFn: run.parseConnectionFn });
  assertRead("dispatchRunAlready", run);
  const data = recordingFleet();
  await readJobsData({ url: "redis://unit", jobs: [{ jobId: "local-f1", queue: "pi-jobs@hosta" }, { jobId: "local-f2", queue: "pi-jobs" }], queueFn: data.queueFn, parseConnectionFn: data.parseConnectionFn });
  assertRead("readJobsData", data);
  assert.deepEqual(data.built.map((o) => o.name).sort(), ["pi-jobs", "pi-jobs@hosta"]);
  const status = recordingFleet();
  const answered = await readSubscriptionStatusOf({ url: "redis://127.0.0.1:1/0", redisFn: status.redisFn });
  assert.notEqual(answered, null, "the status was read");
  assertRead("readSubscriptionStatusOf", status, { queues: false });
});

test("a page view writes nothing: the trigger page's Fire now check, the triggers page's schedule zones and the Insights assemblies (#1036)", async () => {
  const d = files();
  // GET /config/trigger: the cron rule's schedule is looked up on this host's queue, built without the meta write.
  const fire = recordingFleet();
  await planTriggerFire({ index: 1, triggersPath: d.triggersPath, url: "redis://unit", env: { PI_WORKER_NAME: "hosta", PI_MAX_COST_USD: "2" }, grantsEnv: {}, queueFn: fire.queueFn, parseConnectionFn: fire.parseConnectionFn });
  assertRead("planTriggerFire", fire);
  assert.deepEqual(fire.built.map((o) => o.name), ["pi-jobs@hosta"]);
  // GET /triggers: each fleet queue's schedulers.
  const zones = recordingFleet();
  await readTriggerScheduleZones({ url: "redis://unit", triggers: [], readHostsFn: async () => ({ hosts: [{ name: "hosta", routes: "true" }], complete: true }), makeQueueFn: zones.queueFn, parseConnectionFn: zones.parseConnectionFn });
  assertRead("readTriggerScheduleZones", zones);
  // GET /insights/flows: the resident schedulers, asked for read-only.
  const asked = [];
  const paths = { triggersPath: d.triggersPath, logsDir: d.logsDir, valkeyUrl: "redis://unit" };
  const pricing = { piAiVersion: () => "test", listPricedModels: () => [], getPricedModel: () => ({}), isZeroRated: () => false, reprice: () => ({ usd: 0 }) };
  await assembleGraph(paths, { pricing, nowMs: NOW, readSchedulersFn: async (options) => (asked.push(options), []) });
  assert.deepEqual(asked, [{ url: "redis://unit", readOnly: true }], "assembleGraph asks for the schedulers read-only");
  // GET /insights and its three sibling pages: the registry, read without pruning.
  const hosts = [];
  await assembleSizingView(paths, NOW, { readHostsFn: async (options) => (hosts.push(options), { hosts: [] }), envFn: () => ({}) });
  assert.deepEqual(hosts, [{ url: "redis://unit", prune: false }], "assembleSizingView reads the registry without pruning");
  const seen = [];
  const reads = { hosts: async (options) => (seen.push(Object.keys(options).sort().join(",") + (options.prune === false ? " no-prune" : " PRUNES")), { hosts: [] }), capacity: async () => ({ hosts: [] }), costs: async () => ({ fold: null, records: [] }), graph: async () => ({}), budget: async () => ({}), allocation: async () => ({}), sizing: async () => ({}), projects: () => ({ projects: [] }), scan: () => [], subscriptions: () => ({}), settings: () => ({}) };
  for (const view of ["capacity", "spend", "budget-split", "flows", "breakdown"]) await assembleInsightsView(paths, "7d", { view, pricing, nowMs: NOW, envFn: () => ({}), reads }).catch(() => {});
  assert.ok(seen.length >= 3, `the views read the registry (${seen.length} reads)`);
  assert.deepEqual(seen.filter((s) => !s.endsWith(" no-prune")), [], "every registry read of an Insights view is one that prunes nothing");
});
