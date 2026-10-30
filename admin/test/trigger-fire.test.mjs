import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { planTriggerFire, enqueueTriggerFire } from "../src/trigger-fire.mjs";
import { checkDispatchRun } from "../src/read-model.mjs";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 10);
function fixture() {
  const root = tempDir("pd-750-fire-");
  const folder = join(root, "repo");
  mkdirSync(folder);
  const triggersPath = join(root, "triggers.json");
  const raw = { on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder, flow: "fix", task: "operator task never in display", provider: "anthropic", model: "claude-sonnet-4-5", maxTurns: 7, progress: true, steer: true, backend: "local", maxCostUsd: "1", excludeTools: ["bash"], secrets: { TOKEN: "vault/private" }, secretsProfile: "work" } };
  const save = () => writeFileSync(triggersPath, JSON.stringify({ triggers: [raw] }));
  save();
  const jobs = new Map(), latches = new Set(), admissions = [], queues = [], adds = [];
  let served = true, broken = false, instant = NOW;
  const queue = {
    getJobScheduler: async () => served ? { key: "daily" } : null,
    close: async () => {},
    async add(name, data, opts) {
      if (broken) throw new Error("private connection error");
      adds.push({ name, data, opts });
      if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, { data, timestamp: instant, getState: async () => "waiting" });
    },
    getJob: async (id) => jobs.get(id),
  };
  const options = {
    index: 0, triggersPath, url: "redis://unit.invalid", env: { PI_WORKER_NAME: "host1", PI_MAX_COST_USD: "2", PI_DISPATCH_RUN_ROOTS: "/ignored-deployment-grant" },
    grantsEnv: { PI_DISPATCH_RUN_ROOTS: root, PI_DISPATCH_RUN_PER_HOUR: "3" }, now: () => instant,
    queueFn: (_c, opts) => { queues.push(opts.name); return queue; }, parseConnectionFn: () => ({}),
    admissionFn: async (args) => { admissions.push(args); return {}; },
    redisFn: () => ({ async set(key, _v, ...opts) { assert.deepEqual(opts, ["EX", 120, "NX"]); if (latches.has(key)) return null; latches.add(key); return "OK"; }, disconnect() {} }),
  };
  return { raw, save, folder, root, triggersPath, options, jobs, admissions, queues, adds, setServed: (v) => { served = v; }, setBroken: (v) => { broken = v; }, setNow: (v) => { instant = v; } };
}

test("Fire now previews without rate writes, executes the worker's entire cron template and uses only process grants", async () => {
  const f = fixture();
  const { plan } = await planTriggerFire(f.options);
  assert.ok(plan);
  assert.equal(plan.queue, "pi-jobs@host1");
  assert.equal(plan.reserve.dollarsMicros, 1_000_000);
  assert.equal(f.adds.length, 0);
  assert.equal(f.admissions.length, 1);
  assert.equal(f.admissions[0].consumeRate, false);
  assert.equal(f.admissions[0].env.PI_DISPATCH_RUN_ROOTS, f.root);
  assert.doesNotMatch(plan.message, /operator task|vault\/private/);
  const res = await enqueueTriggerFire(plan, f.options);
  assert.equal(res.ok, true);
  assert.equal(res.queue, "pi-jobs@host1");
  assert.equal(f.adds.length, 1);
  const { enqueueNonce, ...data } = f.adds[0].data;
  assert.equal(typeof enqueueNonce, "string");
  assert.deepEqual(data, plan.schedule.data);
  assert.equal(data.task, f.raw.run.task);
  assert.deepEqual(data.secrets, f.raw.run.secrets);
  assert.deepEqual(f.adds[0].opts, { ...plan.schedule.opts, jobId: res.jobId });
  assert.deepEqual(f.admissions.map((a) => a.consumeRate), [false, false, true]);
  assert.ok(f.queues.every((q) => q === "pi-jobs@host1"));
});

test("Fire now refuses non-cron, command, portfolio, absent index, unserved and undeclared schedules", async () => {
  for (const [change, expected] of [
    [(f) => { f.raw.on = { type: "label", any: ["fix"] }; f.raw.run = { kind: "github", flow: "fix" }; }, /Only a cron/],
    [(f) => { delete f.raw.run.flow; delete f.raw.run.task; delete f.raw.run.progress; delete f.raw.run.steer; f.raw.run.command = "wf"; }, /run.command/],
    [(f) => { f.raw.run.portfolio = true; }, /portfolio/],
    [(f) => { f.options.index = 1; }, /no trigger at row 2/],
    [(f) => { f.setServed(false); }, /not in this deployment's queue/],
    [(f) => { f.raw.run.folder = join(f.root, "elsewhere"); }, /another host/],
  ]) {
    const f = fixture(); change(f); f.save();
    const result = await planTriggerFire(f.options);
    assert.match(result.refusal, expected);
    assert.equal(f.adds.length, 0);
  }
});

test("Fire now confirms against the exact file, scheduler and admission checks anew", async () => {
  const f = fixture();
  const { plan } = await planTriggerFire(f.options);
  f.raw.run.maxTurns = 8; f.save();
  assert.match((await enqueueTriggerFire(plan, f.options)).refusal, /changed since the preview/);
  f.raw.run.maxTurns = 7; f.save();
  f.setServed(false);
  assert.match((await enqueueTriggerFire(plan, f.options)).refusal, /not in this deployment's queue/);
  f.setServed(true);
  for (const reason of ["folder not under PI_DISPATCH_RUN_ROOTS", "uncommitted changes", "flow is not AI-triggerable at HEAD", "dispatch_run hourly limit (3) reached"]) {
    const admissionFn = async ({ consumeRate }) => consumeRate ? { refused: reason } : {};
    assert.equal((await enqueueTriggerFire(plan, { ...f.options, admissionFn })).refusal, reason);
  }
  assert.equal(f.adds.length, 0);
});

test("two independent tickets race once per minute, including after cancel removes the queued job", async () => {
  const f = fixture();
  const [one, two] = await Promise.all([planTriggerFire(f.options), planTriggerFire(f.options)]);
  const results = await Promise.all([enqueueTriggerFire(one.plan, f.options), enqueueTriggerFire(two.plan, f.options)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.deduplicated).length, 1);
  assert.equal(f.adds.length, 1);
  f.jobs.clear();
  assert.equal((await enqueueTriggerFire(one.plan, f.options)).deduplicated, true);
  assert.equal(f.adds.length, 1, "removal cannot reopen the minute");
  f.setNow(NOW + 60_000);
  assert.equal((await enqueueTriggerFire(one.plan, f.options)).ok, true);
  assert.equal(f.adds.length, 2);
});

test("minute latch stays on an uncertain enqueue, and infrastructure failure never claims nothing changed", async () => {
  const f = fixture();
  const { plan } = await planTriggerFire(f.options);
  f.setBroken(true);
  const result = await enqueueTriggerFire(plan, f.options);
  assert.equal(result.partial, true);
  assert.match(result.invalid, /may have been queued/);
  assert.doesNotMatch(JSON.stringify(result), /private connection error|Nothing was queued/);
  f.setBroken(false);
  assert.equal((await enqueueTriggerFire(plan, f.options)).deduplicated, true);
});

test("dispatch_run shared admission reads HEAD anew, keeps the dirty-tree gate, and previews consume no hourly count", async () => {
  const f = fixture();
  const seen = [], rates = [];
  let dirty = false, head = "a", gate = "allow", count = 0;
  const deps = { folder: f.folder, flow: "fix", env: f.options.grantsEnv, now: f.options.now, localRepoProblemFn: () => null, gitDirtyFn: () => dirty, revParseHeadFn: () => head,
    readFlowGateFn: async (p) => { seen.push(p.sha); return { gate }; },
    redisFn: () => ({ async get() { return count; }, async incr(key) { rates.push(key); return ++count; }, async expire(_key, ttl) { assert.equal(ttl, 7200); }, disconnect() {} }) };
  assert.deepEqual(await checkDispatchRun({ ...deps, consumeRate: false }), {});
  assert.equal(rates.length, 0);
  head = "b";
  assert.deepEqual(await checkDispatchRun(deps), {});
  assert.deepEqual(seen, ["a", "b"]);
  dirty = true;
  assert.match((await checkDispatchRun(deps)).refused, /uncommitted changes/);
  dirty = false; gate = "deny";
  assert.match((await checkDispatchRun(deps)).refused, /not AI-triggerable/);
  gate = "allow";
  assert.match((await checkDispatchRun({ ...deps, env: {} })).refused, /folder not under/);
  assert.deepEqual(await checkDispatchRun(deps), {});
  assert.deepEqual(await checkDispatchRun(deps), {});
  assert.match((await checkDispatchRun(deps)).refused, /hourly limit \(3\)/);
  assert.equal(rates.length, 4);
});


test("a queue add whose readback failed is an unknown result, never a successful Fire now", async () => {
  const f = fixture();
  const { plan } = await planTriggerFire(f.options);
  const queue = f.options.queueFn({}, { name: plan.queue });
  queue.getJob = async () => { throw new Error("lost readback"); };
  const res = await enqueueTriggerFire(plan, f.options);
  assert.equal(res.partial, true);
  assert.equal(res.ok, undefined);
  assert.match(res.invalid, /could not verify/);
  assert.equal(res.jobId, f.adds[0].opts.jobId);
});
