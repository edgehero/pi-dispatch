import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { planTriggerFire, enqueueTriggerFire, CANARY_UNCONFIRMED, FIRE_UNCONFIRMED } from "../src/trigger-fire.mjs";
import { ALLOWANCE_UNREAD, checkDispatchRun, DISPATCH_RUN_COUNT_SCRIPT } from "../src/read-model.mjs";
import { LOOK_FIRST } from "../src/job-actions.mjs";
import { CONSOLE_AUDIT_FIELD_MAX } from "@edgehero/pi-dispatch/console-audit";

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

test("a canary is the same template with one more field, under an identity of its own (issue #796)", async () => {
  const f = fixture();
  const { plan } = await planTriggerFire(f.options);
  const canary = { name: "pi-lint", version: "1.4.3" };
  const fired = await enqueueTriggerFire(plan, f.options);
  assert.equal(fired.ok, true);
  const res = await enqueueTriggerFire(plan, { ...f.options, packageCanary: canary });
  assert.equal(res.ok, true, "a fire in the same minute does not swallow it");
  assert.notEqual(res.jobId, fired.jobId);
  assert.match(res.jobId, /^manual:daily:\d+$/, "every reader that attributes a run to its trigger still does");
  const { enqueueNonce, packageCanary, dataVersion, ...data } = f.adds[1].data;
  assert.deepEqual(packageCanary, canary);
  assert.equal(dataVersion, 2, "a worker from before canaries waits for an upgrade instead of paying for a plain run");
  assert.deepEqual(data, plan.schedule.data, "nothing else about the job moves");
  assert.equal(f.adds[0].data.packageCanary, undefined, "the plain fire carries none");
  const again = await enqueueTriggerFire(plan, { ...f.options, packageCanary: canary });
  assert.equal(again.deduplicated, true, "a second canary in one minute is one canary");
  assert.equal(f.adds.length, 2);
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
    redisFn: () => ({ async get() { return count; }, async eval(script, keys, key, ttl) { assert.deepEqual([script, keys, ttl], [DISPATCH_RUN_COUNT_SCRIPT, 1, 7200]); rates.push(key); return ++count; }, disconnect() {} }) };
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


test("a random trigger refuses an extension canary before consuming the hourly allowance or enqueueing", async () => {
  const f = fixture();
  delete f.raw.run.provider;
  delete f.raw.run.model;
  f.raw.run.modelSelection = { strategy: "random", candidates: ["openai/gpt-5.4"] };
  writeFileSync(f.triggersPath, JSON.stringify({ version: 6, triggers: [f.raw] }));
  const { plan } = await planTriggerFire(f.options);
  assert.ok(plan);
  const res = await enqueueTriggerFire(plan, { ...f.options, packageCanary: { name: "pi-lint", version: "1.4.3" } });
  assert.match(res.refusal, /fixed model trigger/);
  assert.equal(f.adds.length, 0);
  assert.ok(f.admissions.every((a) => a.consumeRate === false));
});

// ---- issue #961: Fire now on a Valkey that is connected and stopped answering ------------------------------------------

const lostAnswer = () => Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", valkeyMayStillRun: true });
/** `promise`'s answer, or "hung" after `ms` (which also holds the event loop: a bound's own timer does not). */
const settled = async (promise, ms = 3000) => {
  let timer;
  const res = await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms, "hung")))]);
  clearTimeout(timer);
  return res;
};

test("Fire now connects its queue before it uses the hour's allowance or the minute's latch, and a queue that never connects costs neither (#961)", async () => {
  const f = fixture();
  const { plan } = await planTriggerFire(f.options);
  const conns = [];
  let built = 0;
  let closed = 0;
  // The plan's own queue answers; the queue the fire would add to never connects.
  const queueFn = (c, opts) => {
    built += 1;
    const queue = f.options.queueFn(c, opts);
    return built === 1 ? queue : { ...queue, client: new Promise(() => {}), close: async () => { closed += 1; } };
  };
  let latched = 0;
  const redisFn = () => ({ async set() { latched += 1; return "OK"; }, disconnect() {} });
  const before = f.admissions.length;
  const res = await settled(enqueueTriggerFire(plan, { ...f.options, queueFn, redisFn, parseConnectionFn: (_url, options) => (conns.push(options), {}), connectTimeoutMs: 60 }));
  assert.deepEqual(res, { unreachable: "The deployment's queue could not be reached. Nothing was queued." });
  assert.deepEqual(f.admissions.slice(before).map((a) => a.consumeRate), [false], "the allowance was read for the plan and never counted");
  assert.equal(latched, 0, "the minute is not taken");
  assert.equal(f.adds.length, 0);
  assert.deepEqual(conns, Array(2).fill({ failFast: true, commandTimeoutMs: 5000 }), "both queues are the console's bounded kind");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, 1, "and the queue is closed, so nothing is sent later");
  // The same minute is still free.
  assert.equal((await enqueueTriggerFire(plan, f.options)).ok, true);
});

test("Fire now whose count or latch was sent and not answered queues nothing and says what may have been used (#961)", async () => {
  const f = fixture();
  const { plan } = await planTriggerFire(f.options);
  // The hour's count, sent and not answered (`checkDispatchRun`'s `allowanceMayBeUsed`).
  const counted = await enqueueTriggerFire(plan, { ...f.options, admissionFn: async ({ consumeRate }) => (consumeRate ? { unreachable: "Command timed out", allowanceMayBeUsed: true } : {}) });
  assert.deepEqual(counted, { invalid: "Nothing was queued and one start of this hour may have been used: the dispatch_run hourly allowance was sent this fire and did not answer.", partial: true });
  // The allowance not read at all: nothing was used.
  const unread = await enqueueTriggerFire(plan, { ...f.options, admissionFn: async ({ consumeRate }) => (consumeRate ? { unreachable: "Command timed out" } : {}) });
  assert.deepEqual(unread, { unreachable: "The dispatch_run hourly allowance could not be read. Nothing was queued." });
  // The latch, on the console's bounded client: sent and not answered, the minute may be taken.
  const made = [];
  const latch = (error) => (_url, options) => (made.push(options), { on() {}, set: () => Promise.reject(error), disconnect() {} });
  const lost = await enqueueTriggerFire(plan, { ...f.options, redisFn: latch(lostAnswer()) });
  assert.deepEqual(lost, { invalid: "Nothing was queued, one start of this hour was used, and this minute's Fire now may be taken: its latch was sent and did not answer. Try again next minute.", partial: true });
  assert.deepEqual(made, [{ commandTimeoutMs: 5000, disconnectTimeoutMs: 0 }]);
  // Not sent: the minute is free, and the hour's count is still gone, so this is never "nothing was changed".
  const unsent = await enqueueTriggerFire(plan, { ...f.options, redisFn: latch(new Error("Connection is closed.")) });
  assert.deepEqual(unsent, { invalid: "Nothing was queued and one start of this hour was used: Fire now's latch for this minute could not be set.", partial: true });
  assert.equal(f.adds.length, 0);
});

test("a canary's answers after its start was counted name the canary, and Fire now's are word for word what they were (#987)", async () => {
  const canary = { name: "pi-lint", version: "1.4.3" };
  // Each stop of an enqueue past the hour's count, asked as a Fire now and as a canary of the same trigger.
  const both = async (arrange) => {
    const said = [];
    for (const extra of [{}, { packageCanary: canary }]) {
      const f = fixture();
      const { plan } = await planTriggerFire(f.options);
      said.push(await enqueueTriggerFire(plan, { ...f.options, ...extra, ...arrange(f, plan) }));
    }
    return said.map((res) => res.invalid);
  };
  const latch = (error) => () => ({ on() {}, set: () => Promise.reject(error), disconnect() {} });
  // The add was started and threw.
  assert.deepEqual(await both((f) => (f.setBroken(true), {})), [FIRE_UNCONFIRMED, CANARY_UNCONFIRMED]);
  assert.equal(FIRE_UNCONFIRMED, "A run may have been queued and one start of this hour was used: Fire now got no queue acknowledgement. Preview it again first: the preview says when one is already queued or running");
  assert.equal(CANARY_UNCONFIRMED, "A run may have been queued and one start of this hour was used: the canary got no queue acknowledgement. Preview it again first: the preview says when one is already queued or running");
  assert.ok(CANARY_UNCONFIRMED.endsWith(LOOK_FIRST), "the same pointer as every other paid start's");
  assert.ok([...CANARY_UNCONFIRMED].length <= CONSOLE_AUDIT_FIELD_MAX, "an audit row keeps the whole sentence, the start it used included");
  // The add was answered and its read back was not.
  assert.deepEqual(await both((f, plan) => ((f.options.queueFn({}, { name: plan.queue }).getJob = async () => { throw new Error("lost readback"); }), {})), [
    `A run may have been queued and one start of this hour was used: Fire now could not verify the queued job. ${LOOK_FIRST}`,
    `A run may have been queued and one start of this hour was used: the canary could not verify the queued job. ${LOOK_FIRST}`,
  ]);
  // The minute's latch: sent and not answered, not sent, and a stop before it was asked.
  assert.deepEqual(await both(() => ({ redisFn: latch(lostAnswer()) })), [
    "Nothing was queued, one start of this hour was used, and this minute's Fire now may be taken: its latch was sent and did not answer. Try again next minute.",
    "Nothing was queued, one start of this hour was used, and this minute's canary may be taken: its latch was sent and did not answer. Try again next minute.",
  ]);
  assert.deepEqual(await both(() => ({ redisFn: latch(new Error("Connection is closed.")) })), [
    "Nothing was queued and one start of this hour was used: Fire now's latch for this minute could not be set.",
    "Nothing was queued and one start of this hour was used: the canary's latch for this minute could not be set.",
  ]);
  assert.deepEqual(await both(() => ({ redisFn: () => { throw new Error("no client"); } })), [
    "Nothing was queued and one start of this hour was used: Fire now stopped before it queued anything.",
    "Nothing was queued and one start of this hour was used: the canary stopped before it queued anything.",
  ]);
  // The allowance that could not be read is one sentence, the read model's, for a fire and for the run-enqueue preview.
  assert.equal(ALLOWANCE_UNREAD, "The dispatch_run hourly allowance could not be read. Nothing was queued.");
  const f = fixture();
  const { plan } = await planTriggerFire(f.options);
  const unread = async ({ consumeRate }) => (consumeRate ? { unreachable: "Connection is closed." } : {});
  assert.deepEqual(await enqueueTriggerFire(plan, { ...f.options, admissionFn: unread }), { unreachable: ALLOWANCE_UNREAD });
  assert.deepEqual(await planTriggerFire({ ...f.options, admissionFn: async () => ({ unreachable: "Connection is closed." }) }), { unreachable: ALLOWANCE_UNREAD });
});

test("a Fire now preview whose scheduler read never answers ends at its bound and waits for no close (#961)", async () => {
  const f = fixture();
  let closes = 0;
  const queueFn = () => ({ getJobScheduler: () => new Promise(() => {}), close: () => { closes += 1; return new Promise(() => {}); }, disconnect() {} });
  const res = await settled(planTriggerFire({ ...f.options, queueFn, planTimeoutMs: 60 }));
  assert.deepEqual(res, { unreachable: "The deployment's queue could not be read. Nothing was queued." });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closes, 1);
  assert.equal(f.admissions.length, 0, "the allowance is not asked of a Valkey that did not answer the queue");
});
