import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { executeToolAction, switchPartialRefusal, toolActionRequest, TOOL_FLEET_METHODS } from "../src/tool-actions.mjs";
import { modelToolRefusal } from "../src/tool-refusals.mjs";
import { failedForAgent, waitingForAgent, readOperationalTool } from "../src/tool-reads.mjs";
import { createFleetReader, readHeldJobs } from "../src/read-model.mjs";
import { answeredWith, discoveryRedis, keyedRedis, noAnswer, quietQueue, registryKeys } from "./helpers/fleet-reader-fakes.mjs";
import { readLiveHosts } from "@edgehero/pi-dispatch/host-registry";
import { DOCTOR_HOSTS, assignCheckIds, buildDoctorRecord, doctorKey } from "@edgehero/pi-dispatch/doctor-results";
import { DELAYED_SCORE_SHIFT, deferHsetArgs, deferKey } from "@edgehero/pi-dispatch/defer-reasons";
import { HELD_SET, jobKey as heldJobKey } from "@edgehero/pi-dispatch/wait-state";

const NOW = Date.UTC(2026, 9, 31);
/** `[field, value, ...]` as `[[field, value], ...]`. */
const chunks = (flat) => flat.flatMap((v, i) => (i % 2 === 0 ? [[v, flat[i + 1]]] : []));
function fixture() {
  const dir = tempDir("pd-766-tool-");
  const paths = { settingsFile: join(dir, "settings.json"), triggersPath: join(dir, "triggers.json"), pauseWindowsPath: join(dir, "pauses.json"), scopedLimitsPath: join(dir, "limits.json"), projectsFile: join(dir, "projects.json"), logsDir: dir, valkeyUrl: "redis://unreachable.invalid" };
  writeFileSync(paths.settingsFile, JSON.stringify({ dailyCap: 10 }));
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["fix"] }, run: { kind: "github", flow: "fix", steer: true } }] }));
  const rows = [];
  const options = { paths, env: {}, grantsEnv: {}, granted: true, now: () => NOW, fleet: { snapshot: async () => ({}), dispose: async () => {} }, audit: { append: (r) => rows.push(r) }, actor: { name: "automation", role: "agent", session: null } };
  const read = () => JSON.parse(readFileSync(paths.settingsFile, "utf8"));
  return { paths, rows, options, read };
}

test("a headless agent lowers an explicit cap through the real shared writer, with an applied receipt", async () => {
  const f = fixture();
  assert.equal((await executeToolAction("dispatch_set", { key: "dailyCap", value: "5" }, { hasUI: false }, f.options)).applied, true);
  assert.equal(f.read().dailyCap, 5);
  assert.deepEqual(f.rows.map((r) => [r.action, r.actor.role]), [["write", "agent"], ["write-applied", "agent"]]);
});

test("unattended changes cannot raise, unset, infer an inherited cap or mix flag-off with flow change", async () => {
  for (const params of [{ key: "dailyCap", value: "11" }, { key: "dailyCap" }, { key: "maxTurns", value: "5" }, { key: "provider", value: "anthropic" }]) {
    const f = fixture();
    await assert.rejects(executeToolAction("dispatch_set", params, { hasUI: false }, f.options), /confirm/);
    assert.deepEqual(f.read(), { dailyCap: 10 });
    assert.ok(!f.rows.some((r) => r.action === "write-applied"));
  }
  const f = fixture();
  await assert.rejects(executeToolAction("dispatch_trigger_edit", { index: 0, flow: "another", steer: false }, { hasUI: false }, f.options), /confirm/);
  assert.equal(JSON.parse(readFileSync(f.paths.triggersPath, "utf8")).triggers[0].run.steer, true);
  assert.equal((await executeToolAction("dispatch_trigger_edit", { index: 0, steer: false }, { hasUI: false }, f.options)).applied, true);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.triggersPath, "utf8")).triggers[0].run, { kind: "github", flow: "fix", steer: false });
});

test("interactive proposals keep confirmation, and a changed file cannot borrow the old approval", async () => {
  const f = fixture();
  const dialogs = [];
  const declined = await executeToolAction("dispatch_set", { key: "dailyCap", value: "15" }, { hasUI: true, ui: { confirm: async (...args) => { dialogs.push(args); return false; } } }, f.options);
  assert.equal(declined.applied, false);
  assert.equal(f.read().dailyCap, 10);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].join(" "), /dailyCap.*10.*15/);
  await assert.rejects(executeToolAction("dispatch_set", { key: "dailyCap", value: "15" }, { hasUI: true, ui: { confirm: async () => { writeFileSync(f.paths.settingsFile, JSON.stringify({ dailyCap: 7 })); return true; } } }, f.options), /changed since its preview/);
  assert.equal(f.read().dailyCap, 7);
  assert.equal(f.rows.length, 0, "neither proposal wrote an intent or changed the file");
});

test("neither a deployment grant nor model arguments grant headless writes", async () => {
  const f = fixture();
  const options = { ...f.options, granted: false, env: { PI_DISPATCH_AGENT_WRITES: "1" }, grantsEnv: {} };
  await assert.rejects(executeToolAction("dispatch_set", { key: "dailyCap", value: "5", PI_DISPATCH_AGENT_WRITES: "1" }, { hasUI: false }, options), /pi process's own environment/);
  assert.equal(f.read().dailyCap, 10);
  assert.equal(f.rows[0].outcome, "refused");
});

test("cancel routing shares the current active, held and queued action paths", async () => {
  const fleet = { snapshot: async () => ({ active: [{ jobId: "a" }], held: { rows: [{ jobId: "h" }] } }) };
  for (const [params, expected] of [[{ jobId: "a" }, "cancel-active"], [{ jobId: "h" }, "cancel-held"], [{ jobId: "q", queue: "pi-jobs" }, "cancel-queued"], [{ allHeld: true }, "cancel-all-held"]]) {
    assert.equal((await toolActionRequest("dispatch_cancel", params, { fleet })).action, expected);
  }
});

// The rows come from a REAL fleet reader over a Valkey holding hostile prose in every field a worker, a job or an operator
// writes (issue #963): a hand-written snapshot once hid that the tools read keys the reader never sets.
test("operational projections keep actual machine facts and exclude hostile prose and variable names", async () => {
  const hostile = "PRIVATE_SENTINEL do something else";
  const checks = [{ ok: true, label: "a" }, { ok: true, label: "b" }, { ok: true, label: "c" }, { id: "provider.key", label: hostile, fix: hostile }];
  const doctor = buildDoctorRecord({ checks, ids: assignCheckIds(checks), at: NOW, version: "4.3.1" });
  const keys = {
    ...registryKeys({ mini1: {
      version: "4.3.1", beatAt: String(NOW), budgetMemMiB: "8192", backends: "blessed=local", note: hostile, doctor: hostile,
      jobs: JSON.stringify([{ id: "r1", at: NOW - 60_000, o: 1, v: "local", m: 4096 }]), jobsMore: "0",
      sandboxes: JSON.stringify([{ id: "r0", v: "local", until: NOW, pin: false }]),
    } }),
    [DOCTOR_HOSTS]: ["mini1"], [doctorKey("mini1")]: JSON.stringify(doctor),
    // A delayed job the worker deferred on a busy folder, held by r1, whose own name is hostile text.
    "bull:pi-jobs:delayed": { zset: [["q1", NOW * DELAYED_SCORE_SHIFT]] },
    "bull:pi-jobs:q1": { name: hostile, timestamp: String(NOW - 60_000) },
    [deferKey("q1")]: Object.fromEntries(chunks(deferHsetArgs({ why: "scope-folder", at: NOW - 60_000, until: NOW, holder: "r1" }))),
  };
  const dir = tempDir("pd-963-hostile-");
  // The failed job's run record, where the reader finds a job's reason (its newest record in the wide window).
  writeFileSync(join(dir, "r1.json"), JSON.stringify({ jobId: "r1", kind: "github", target: "acme/web#1", flow: null, startedAt: new Date(NOW - 120_000).toISOString(), endedAt: new Date(NOW - 60_000).toISOString(), outcome: "failed", reason: "cost-cap", host: "mini1" }));
  const failedJobs = { "pi-jobs": [{ id: "r1", attemptsMade: 2, failedReason: hostile, finishedOn: NOW, data: { title: hostile } }] };
  const reader = () => createFleetReader({ valkeyUrl: "redis://unused", logsDir: dir, triggersPath: join(dir, "none.json"), schedulerStallMax: 2 }, {
    makeQueueFn: quietQueue([], { failed: failedJobs }), parseConnectionFn: () => ({}), redisFn: () => keyedRedis(keys),
    readLiveHostsFn: (r, opts) => readLiveHosts(r, { ...opts, now: () => NOW }), nowFn: () => NOW, readOnly: true,
  });
  const tool = (kind) => readOperationalTool(kind, { paths: {}, reads: { fleet: reader } });
  const failed = await tool("failed");
  assert.deepEqual(failed.jobs[0], { jobId: "r1", queue: "pi-jobs", attempts: 2, reason: "cost-cap", supersededBy: null });
  // Issue #897: the run that did a failed job's work since, as a run id, so an agent never proposes a paid retry of it.
  assert.equal(failedForAgent({ rows: [{ jobId: "r1", queue: "pi-jobs", supersededBy: "repeat:nightly:1794722400000" }] }).jobs[0].supersededBy, "repeat:nightly:1794722400000");
  assert.equal(failedForAgent({ rows: [{ jobId: "r1", queue: "pi-jobs", supersededBy: hostile }] }).jobs[0].supersededBy, null, "only a run id's shape");
  const waiting = await tool("waiting");
  assert.deepEqual([waiting.jobs[0].jobId, waiting.jobs[0].due, waiting.jobs[0].holder, waiting.jobs[0].reason], ["q1", NOW, "r1", "scope-folder"]);
  const held = waitingForAgent(await readHeldJobs({ url: "redis://unused", now: () => NOW, redisFn: () => keyedRedis({ [HELD_SET]: ["w1"], [heldJobKey("w1")]: { since: String(NOW - 60_000), checks: "1", target: "acme/web", label: hostile } }) }));
  assert.equal(held.jobs[0].jobId, "w1");
  const hosts = await tool("hosts");
  assert.equal(hosts.hosts[0].capacity.budgetMemMiB, 8192);
  assert.deepEqual([hosts.hosts[0].jobs[0].orphan, hosts.hosts[0].jobs[0].backend], [true, "local"]);
  assert.equal(hosts.hosts[0].doctor.fail, 1);
  assert.equal(hosts.hosts[0].kept[0].id, "r0");
  assert.ok(hosts.hosts[0].venues[0].declarations);
  const setup = await tool("setup");
  assert.ok(setup.steps.length > 0);
  assert.match(JSON.stringify(await reader().snapshot({ waiting: true })), /PRIVATE_SENTINEL/, "the reader's rows do carry the hostile text");
  assert.doesNotMatch(JSON.stringify({ failed, waiting, held, hosts, setup }), /PRIVATE_SENTINEL/);
});

test("bulk removals audit each exact job and return real partial outcomes without private reasons", async () => {
  const f = fixture();
  const effects = [];
  const rows = [{ jobId: "j1", queue: "pi-jobs", attemptsMade: 1, finishedOn: NOW }, { jobId: "j2", queue: "pi-jobs", attemptsMade: 2, finishedOn: NOW }];
  const rm = await import("../src/read-model.mjs");
  const readModel = { ...rm, planFailedBulk: async () => ({ jobs: rows, more: 0, examinedAll: true }), removeFailedJob: async (args) => {
    effects.push(args); return args.jobId === "j1" ? { ok: true } : { invalid: "PRIVATE_SENTINEL raw job failure" };
  } };
  const out = await executeToolAction("dispatch_remove_failed", { all: true }, { hasUI: false }, { ...f.options, readModel });
  assert.deepEqual(effects.map((r) => [r.jobId, r.expect]), rows.map((r) => [r.jobId, { attemptsMade: r.attemptsMade, finishedOn: r.finishedOn }]));
  assert.deepEqual(out.results, [{ jobId: "j1", ok: true }, { jobId: "j2", ok: false }]);
  assert.equal(out.done, 1); assert.equal(out.refused, 1);
  assert.ok(!JSON.stringify(out).includes("PRIVATE_SENTINEL"));
  assert.deepEqual(f.rows.map((r) => [r.target, r.action, r.outcome]), [["j1", "write", "ok"], ["j1", "write-applied", "ok"], ["j2", "write", "ok"], ["j2", "write", "failed"]]);
  assert.equal(f.rows[0].ticket, f.rows[1].ticket);
  assert.equal(f.rows[2].ticket, f.rows[3].ticket);
  assert.notEqual(f.rows[0].ticket, f.rows[2].ticket);
});

test("the lazy fleet adapter preserves actual pause methods through the origin wrapper", async () => {
  const f = fixture();
  const calls = [];
  const rm = await import("../src/read-model.mjs");
  const readModel = { ...rm, createFleetReader: () => ({ snapshot: async () => ({ queueCounts: [{ queue: "pi-jobs", paused: false }] }), pauseQueue: async (args) => { calls.push(args); return { ok: true }; }, dispose: async () => { calls.push("disposed"); } }) };
  const out = await executeToolAction("dispatch_pause", { queue: "pi-jobs" }, { hasUI: false }, { ...f.options, fleet: undefined, readModel });
  assert.equal(out.applied, true);
  assert.deepEqual(calls, [{ queue: "pi-jobs", paused: true }, "disposed"]);
});

test("a tool's write that throws is audited as one closed word: action-unconfirmed where Valkey may still run it, action-unavailable where it could not be reached, action-refused otherwise (#965)", async () => {
  const marked = [
    [() => Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", valkeyMayStillRun: true }), "action-unconfirmed"],
    [() => Object.assign(new Error("Valkey did not connect within 6 seconds"), { valkeyNotSent: true }), "action-unavailable"],
    [() => Object.assign(new Error("boom"), { code: "EBOOM" }), "action-refused"],
  ];
  for (const [error, reason] of marked) {
    const f = fixture();
    const fleet = { snapshot: async () => ({ queueCounts: [{ queue: "pi-jobs", paused: false }] }), pauseQueue: async () => { throw error(); }, dispose: async () => {} };
    await assert.rejects(executeToolAction("dispatch_pause", { queue: "pi-jobs" }, { hasUI: false }, { ...f.options, fleet }));
    assert.deepEqual(f.rows.map((r) => [r.action, r.outcome, r.reason ?? null]), [["write", "ok", null], ["write", "failed", reason]], reason);
  }
});

// Issue #964: over a REAL fleet reader whose host registry does not answer (its SMEMBERS rejects), so the reader itself
// marks the set of queues it switched as one that may be short.
test("dispatch_pause over a set of queues that may be short answers queuesMayBeShort with an audit row of its own, and a part-way one a refusal that names the queues and no Valkey (#964, #1064)", async () => {
  const f = fixture();
  let answer = () => Promise.resolve();
  const make = quietQueue();
  const reader = createFleetReader(f.paths, { makeQueueFn: (c, o) => ({ ...make(c, o), pause: () => answer(), resume: () => answer() }), parseConnectionFn: () => ({}), redisFn: () => keyedRedis({}, { registryDown: () => true }), readOnly: true, switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  const rm = await import("../src/read-model.mjs");
  const options = { ...f.options, fleet: reader, readModel: { ...rm, killSwitchPlan: () => ({ urls: [f.paths.valkeyUrl], disagreement: null, context: null }) } };
  const rows = () => f.rows.map((r) => [r.action, r.outcome, r.reason ?? null]);
  let keep = null;
  try {
    const out = await executeToolAction("dispatch_pause", {}, { hasUI: false }, options);
    assert.deepEqual([out.applied, out.queuesMayBeShort], [true, true], JSON.stringify(out));
    assert.deepEqual(rows(), [["write", "ok", null], ["write", "ok", "queues-may-be-short"], ["write-applied", "ok", null]]);
    // Sent and never answered: part of the fleet may be paused, said in words a model may be handed. The step's own timer
    // is unref'd, so this test holds the event loop open while it runs out.
    answer = () => new Promise(() => {});
    keep = setInterval(() => {}, 20);
    // The queues by name since issue #1064, as the page and the CLI say them, and no Valkey's address.
    const sentence = "The fleet pause did not reach every queue, so some queues may be paused and others not, and the list of queues may be short, so other queues may exist and were not paused. By queue: not confirmed for pi-jobs (the pause may or may not have been made); paused: none. An operator can look at the fleet in the console and pause it again once Valkey answers.";
    await assert.rejects(executeToolAction("dispatch_pause", {}, { hasUI: false }, options), (e) => (assert.equal(modelToolRefusal(e), sentence), e.message === sentence));
    assert.equal(switchPartialRefusal(true, true, true, false, null, null, ["not confirmed for pi-jobs (the pause may or may not have been made); paused: none"]), sentence);
    assert.equal(switchPartialRefusal(true, true, true), "The fleet pause did not reach every queue, so some queues may be paused and others not, and the list of queues may be short, so other queues may exist and were not paused. An operator can look at the fleet in the console and pause it again once Valkey answers.", "with no list handed on, the sentence as it was");
    assert.deepEqual(rows().slice(3), [["write", "ok", null], ["write", "failed", "action-unconfirmed"]]);
  } finally {
    clearInterval(keep);
    await reader.dispose();
  }
});

/**
 * The real fleet reader for a tool call over a Valkey client whose discovery reads answer as `how()` says now (issue
 * #1035, `discoveryRedis`), with queues whose pause and resume answer as `flip(name)` gives. `snapshots` counts the
 * reader's snapshot reads, one per preview of a fleet switch.
 */
function shortToolFleet(f, how, { flip = () => Promise.resolve() } = {}) {
  const make = quietQueue();
  const reader = createFleetReader(f.paths, { makeQueueFn: (c, o) => ({ ...make(c, o), pause: () => flip(o?.name ?? "pi-jobs"), resume: () => flip(o?.name ?? "pi-jobs") }), parseConnectionFn: () => ({}), redisFn: () => discoveryRedis(how, { beatAt: NOW }), nowFn: () => NOW, readOnly: true, switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  const counted = { snapshots: 0 };
  const fleet = { snapshot: (opts) => { counted.snapshots += 1; return reader.snapshot(opts); }, pause: () => reader.pause(), resume: () => reader.resume(), pauseQueue: (args) => reader.pauseQueue(args), dispose: () => reader.dispose() };
  return { reader, fleet, counted };
}

// Issue #1035: the tools said "pause again once Valkey answers" of every short list, also where Valkey had answered
// with an error that stays until a key or the ACL is put right.
test("dispatch_pause and dispatch_resume over a list that may be short answer the class of a cause that stays, audit it under that class's word, and refuse a part-way switch with the key, the code and what its class supports (#1035)", async () => {
  const rm = await import("../src/read-model.mjs");
  const CASES = [
    // what, the reads, the answer's class, the audit's word, what a part-way refusal adds
    ["a key of another type", { index: answeredWith("WRONGTYPE") }, "key", "queues-may-be-short-key", " Valkey answers host:live with WRONGTYPE. Waiting does not change that: remove or repair that key, then pause again."],
    ["a permission", { rows: { "host:h:hostw": answeredWith("NOPERM") } }, "permission", "queues-may-be-short-permission", " Valkey answers host:h:hostw with NOPERM. Waiting does not change that: fix this Valkey user's ACL, then pause again."],
    ["a passing state", { scan: answeredWith("BUSY") }, undefined, "queues-may-be-short", " Valkey answers the look for queues with BUSY. A later read may succeed: pause the fleet again."],
    ["a code of no class", { index: answeredWith("READONLY") }, undefined, "queues-may-be-short", " Valkey answers host:live with READONLY. Pause the fleet again once the list can be read whole."],
    ["no answer", { index: noAnswer }, undefined, "queues-may-be-short", ""],
    ["an error reply and a read with no answer", { index: answeredWith("WRONGTYPE"), scan: noAnswer }, "key", "queues-may-be-short-key", " Valkey answers host:live with WRONGTYPE. Waiting does not change that: remove or repair that key. Another read got no answer: pause the fleet again once Valkey answers and that is put right."],
  ];
  for (const [what, reads, lasting, word, added] of CASES) {
    const f = fixture();
    let flip = () => Promise.resolve();
    const { fleet } = shortToolFleet(f, () => reads, { flip: (name) => flip(name) });
    const options = { ...f.options, fleet, readModel: { ...rm, killSwitchPlan: () => ({ urls: [f.paths.valkeyUrl], disagreement: null, context: null }) } };
    const rows = () => f.rows.map((r) => [r.action, r.outcome, r.reason ?? null]);
    let keep = null;
    try {
      // A resume is a person's to confirm, so it goes through a dialog; a pause runs headless.
      for (const [tool, toolCtx] of [["dispatch_pause", { hasUI: false }], ["dispatch_resume", { hasUI: true, ui: { confirm: async () => true } }]]) {
        f.rows.length = 0;
        const out = await executeToolAction(tool, {}, toolCtx, options);
        assert.deepEqual([out.applied, out.queuesMayBeShort, out.queuesShortLasting], [true, true, lasting], `${what}, ${tool}: ${JSON.stringify(out)}`);
        assert.deepEqual(rows(), [["write", "ok", null], ["write", "ok", word], ["write-applied", "ok", null]], `${what}, ${tool}`);
      }
      // Part-way: the shared queue's pause is sent and never answered. The step's own timer is unref'd, so this test
      // holds the event loop open while it runs out.
      flip = (name) => (name === "pi-jobs" ? new Promise(() => {}) : Promise.resolve());
      keep = setInterval(() => {}, 20);
      // The queues by name (issue #1064): the shared queue's pause got no answer, and each host's queue the registry's
      // read named took its pause (none over an index not read, one where the other's row was not read, else both).
      const sentence = `The fleet pause did not reach every queue, so some queues may be paused and others not, and the list of queues may be short, so other queues may exist and were not paused. By queue: not confirmed for pi-jobs (the pause may or may not have been made); paused: ${reads.index ? "none" : reads.rows ? "pi-jobs@hosta" : "pi-jobs@hosta, pi-jobs@hostw"}.${added} An operator can look at the fleet in the console and pause it again once Valkey answers.`;
      await assert.rejects(executeToolAction("dispatch_pause", {}, { hasUI: false }, options), (e) => (assert.equal(modelToolRefusal(e), sentence, what), true));
      assert.doesNotMatch(added, /refus/i);
    } finally {
      clearInterval(keep);
      await fleet.dispose();
    }
  }
  // The refusal's own words by the cause, with the flags a result carries.
  assert.equal(switchPartialRefusal(false, true, false, false, { waits: false, errors: [{ key: "host:live", code: "WRONGTYPE" }] }), "The fleet resume did not reach every queue, so some queues may be resumed and others not, and the list of queues may be short, so other queues may exist and were not resumed. Valkey answers host:live with WRONGTYPE. Waiting does not change that: remove or repair that key, then resume again. An operator can look at the fleet in the console before trying the resume again.");
  assert.equal(switchPartialRefusal(true, false, false, false, { waits: false, errors: [{ key: "host:live", code: "WRONGTYPE" }] }), switchPartialRefusal(true, false, false), "a list that is not short says nothing of a cause");
  assert.equal(switchPartialRefusal(true, true, true, false, null), switchPartialRefusal(true, true, true));
});

// Issue #1035: the tool previewed twice, so on a Valkey that does not answer a pause waited its snapshot's bound two
// times before the kill switch was sent.
test("a fleet pause or resume through its tool previews once and rereads only the plan's refusal before the write; an action with no recheck is still previewed twice (#1035)", async () => {
  const rm = await import("../src/read-model.mjs");
  const f = fixture();
  const asked = [];
  const { fleet, counted } = shortToolFleet(f, () => ({}), { flip: (name) => (asked.push(name), Promise.resolve()) });
  let plans = 0;
  let refuseFrom = Infinity;
  const killSwitchPlan = ({ paused }) => {
    plans += 1;
    return plans >= refuseFrom && !paused ? { refused: "this console's Valkey and the service's disagree; a resume reaches neither until they agree" } : { urls: [f.paths.valkeyUrl], disagreement: null, context: null };
  };
  const options = { ...f.options, fleet, readModel: { ...rm, killSwitchPlan } };
  const dialogs = [];
  const person = { hasUI: true, ui: { confirm: async (...args) => (dialogs.push(args), true) } };
  try {
    counted.snapshots = 0;
    assert.equal((await executeToolAction("dispatch_pause", {}, { hasUI: false }, options)).applied, true);
    assert.equal(counted.snapshots, 1, "a headless pause: one preview, so one snapshot");
    for (const tool of ["dispatch_pause", "dispatch_resume"]) {
      counted.snapshots = 0;
      assert.equal((await executeToolAction(tool, {}, person, options)).applied, true, tool);
      assert.equal(counted.snapshots, 1, `${tool}: one preview behind the dialog too`);
    }
    // The control: one queue's pause has no recheck, and is previewed again after its dialog.
    counted.snapshots = 0;
    assert.equal((await executeToolAction("dispatch_pause", { queue: "pi-jobs" }, person, options)).applied, true);
    assert.equal(counted.snapshots, 2, "previewed twice, as every action without a recheck is");
    // What the recheck rereads: the plan. It comes to refuse a resume while the dialog is open, and nothing is sent.
    asked.length = 0;
    f.rows.length = 0;
    const openDialog = { hasUI: true, ui: { confirm: async () => { refuseFrom = plans + 1; return true; } } };
    await assert.rejects(executeToolAction("dispatch_resume", {}, openDialog, options), /changed since its preview/);
    assert.deepEqual([asked, f.rows.filter((r) => r.action === "write").length], [[], 0], "no resume was sent and no write was audited");
    refuseFrom = Infinity;
    // One Undo in the dialog of a pause previewed without a snapshot: the dialog's own.
    const unread = { ...fleet, snapshot: async () => null };
    dialogs.length = 0;
    assert.equal((await executeToolAction("dispatch_pause", {}, person, { ...options, fleet: unread })).applied, true);
    assert.equal(dialogs.length, 1);
    assert.equal((dialogs[0][1].match(/Undo: /g) ?? []).length, 1, dialogs[0][1]);
    assert.match(dialogs[0][1], /could not be read; a pause still reaches every queue the kill switch finds/);
  } finally {
    await fleet.dispose();
  }
});

test("dispatch_pause refused by a Valkey that answers, over a whole set, points at the fleet, never at Valkey answering (#964)", async () => {
  const f = fixture();
  // A real reader whose registry names hostb and whose scan is whole; hostb's queue refuses its pause (an error that came
  // back, not a lost answer) while the shared queue takes it.
  const make = quietQueue();
  const reader = createFleetReader(f.paths, { makeQueueFn: (c, o) => ({ ...make(c, o), pause: async () => { if (o?.name === "pi-jobs@hostb") throw new Error("refused"); } }), parseConnectionFn: () => ({}), redisFn: () => keyedRedis(registryKeys({ hostb: { routes: "true", beatAt: String(NOW) } })), readOnly: true, switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  const rm = await import("../src/read-model.mjs");
  const options = { ...f.options, fleet: reader, readModel: { ...rm, killSwitchPlan: () => ({ urls: [f.paths.valkeyUrl], disagreement: null, context: null }) } };
  try {
    const sentence = "The fleet pause did not reach every queue, so some queues may be paused and others not. By queue: not paused: pi-jobs@hostb; paused: pi-jobs. An operator can look at the fleet in the console before trying the pause again.";
    await assert.rejects(executeToolAction("dispatch_pause", {}, { hasUI: false }, options), (e) => (assert.equal(modelToolRefusal(e), sentence), true));
    assert.equal(switchPartialRefusal(true, false, false, false, null, null, ["not paused: pi-jobs@hostb; paused: pi-jobs"]), sentence);
    assert.equal(switchPartialRefusal(true, false, false), "The fleet pause did not reach every queue, so some queues may be paused and others not. An operator can look at the fleet in the console before trying the pause again.");
    // One entry per Valkey, and an entry with anything but a queue name and the console's closed words is left out.
    assert.equal(switchPartialRefusal(false, false, false, false, null, null, ["not tried: pi-jobs@hostb; resumed: pi-jobs", "resumed: pi-jobs"]), "The fleet resume did not reach every queue, so some queues may be resumed and others not. By queue: not tried: pi-jobs@hostb; resumed: pi-jobs; and on another Valkey: resumed: pi-jobs. An operator can look at the fleet in the console before trying the resume again.");
    assert.equal(switchPartialRefusal(true, false, false, false, null, null, ["paused: <b>pi-jobs</b>", "redis://10.0.0.7:6379/0 paused: pi-jobs", 7]), switchPartialRefusal(true, false, false));
    assert.equal(switchPartialRefusal(false, true, false), "The fleet resume did not reach every queue, so some queues may be resumed and others not, and the list of queues may be short, so other queues may exist and were not resumed. An operator can look at the fleet in the console before trying the resume again.");
  } finally {
    await reader.dispose();
  }
});

// Issues #964 and #1014 together, over a REAL fleet reader: the registry does not answer and Valkey answers a queue's pause
// with an error after its script paused it. The model is told both, in fixed words that name no queue.
test("dispatch_pause answered with an error over a set that may be short tells a model both, with the queues by name and no Valkey's address (#964, #1014, #1064)", async () => {
  const f = fixture();
  const make = quietQueue();
  const inScript = () => Object.assign(new Error("WRONGTYPE Operation against a key holding the wrong kind of value script: b4514f4b39660691beec2ab3023b9b46b093b439, on @user_script:57."), { name: "ReplyError" });
  const reader = createFleetReader(f.paths, { makeQueueFn: (c, o) => ({ ...make(c, o), pause: async () => { throw inScript(); }, isPaused: async () => true }), parseConnectionFn: () => ({}), redisFn: () => keyedRedis({}, { registryDown: () => true }), readOnly: true, switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  const rm = await import("../src/read-model.mjs");
  const options = { ...f.options, fleet: reader, readModel: { ...rm, killSwitchPlan: () => ({ urls: [f.paths.valkeyUrl], disagreement: null, context: null }) } };
  try {
    // Issue #1064: the reply's code and what its class supports, and no word of trying the pause again while the
    // cause lasts. It closed "before trying the pause again", which is the same answer again over a key of another type.
    const sentence = "The fleet pause did not reach every queue, so some queues may be paused and others not, and Valkey answered a pause with an error, which can come after the queue was paused, and the list of queues may be short, so other queues may exist and were not paused. By queue: answered with an error for pi-jobs (reads paused now); confirmed paused: none. Valkey answered a queue's pause with WRONGTYPE: a key of that queue holds another kind of value. Trying again does not change that: an operator has to remove or repair that key first. An operator can look at the fleet in the console; the pause is worth trying again only once that is put right.";
    await assert.rejects(executeToolAction("dispatch_pause", {}, { hasUI: false }, options), (e) => modelToolRefusal(e) === sentence || assert.fail(modelToolRefusal(e)));
    assert.equal(switchPartialRefusal(true, true, false, true, null, "WRONGTYPE", ["answered with an error for pi-jobs (reads paused now); confirmed paused: none"]), sentence);
    // By the code's class: a permission, the credentials, a passing state, any other code.
    const lead = "The fleet resume did not reach every queue, so some queues may be resumed and others not.";
    assert.equal(switchPartialRefusal(false, false, false, false, null, "NOPERM"), `${lead} Valkey answered a queue's resume with NOPERM: the Valkey user this connects as may not run the command or read the key. Trying again does not change that: an operator has to fix this Valkey user's ACL first. An operator can look at the fleet in the console; the resume is worth trying again only once that is put right.`);
    assert.equal(switchPartialRefusal(false, false, false, false, null, "NOAUTH"), `${lead} Valkey answered a queue's resume with NOAUTH: this connection has not signed in to Valkey. Trying again does not change that: an operator has to fix the Valkey user and password first. An operator can look at the fleet in the console; the resume is worth trying again only once that is put right.`);
    assert.equal(switchPartialRefusal(false, false, false, false, null, "BUSY"), `${lead} Valkey answered a queue's resume with BUSY: Valkey could not serve the command just then. A later try may succeed. An operator can look at the fleet in the console before trying the resume again.`);
    assert.equal(switchPartialRefusal(false, false, false, false, null, "READONLY"), `${lead} Valkey answered a queue's resume with READONLY. An operator can look at the fleet in the console before trying the resume again.`);
    // A switch that was sent and not answered still waits on Valkey, whatever another queue was answered.
    assert.match(switchPartialRefusal(false, false, true, true, null, "WRONGTYPE"), /remove or repair that key first\. An operator can look at the fleet in the console and resume it again once Valkey answers\.$/);
    // With no code handed on, and for anything that is no code, the sentence as it was.
    assert.equal(switchPartialRefusal(true, true, false, true), "The fleet pause did not reach every queue, so some queues may be paused and others not, and Valkey answered a pause with an error, which can come after the queue was paused, and the list of queues may be short, so other queues may exist and were not paused. An operator can look at the fleet in the console before trying the pause again.");
    assert.equal(switchPartialRefusal(true, true, false, true, null, "two words"), switchPartialRefusal(true, true, false, true));
    assert.equal(switchPartialRefusal(false, false, true, true), "The fleet resume did not reach every queue, so some queues may be resumed and others not, and Valkey answered a resume with an error, which can come after the queue was resumed. An operator can look at the fleet in the console and resume it again once Valkey answers.");
    assert.deepEqual(f.rows.slice(-2).map((r) => [r.action, r.outcome, r.reason ?? null]), [["write", "ok", null], ["write", "failed", "action-unconfirmed"]]);
  } finally {
    await reader.dispose();
  }
});

// Issue #1041: a read back Valkey answers with an error too keeps the queue answered with an error, so a model is told
// the same fixed clause, where it was told only that some queues may be paused and others not.
test("dispatch_pause whose read back Valkey answered with an error too tells a model that Valkey answered with an error, the queue by name (#1041, #1064)", async () => {
  const f = fixture();
  const make = quietQueue();
  const reply = (message) => Object.assign(new Error(message), { name: "ReplyError" });
  const reader = createFleetReader(f.paths, { makeQueueFn: (c, o) => ({ ...make(c, o), pause: async () => { throw reply("WRONGTYPE Operation against a key holding the wrong kind of value script: b4514f4b39660691beec2ab3023b9b46b093b439, on @user_script:30."); }, isPaused: async () => { throw reply("WRONGTYPE Operation against a key holding the wrong kind of value"); } }), parseConnectionFn: () => ({}), redisFn: () => keyedRedis({}), readOnly: true, switchStepTimeoutMs: 80, closeTimeoutMs: 30 });
  const rm = await import("../src/read-model.mjs");
  const options = { ...f.options, fleet: reader, readModel: { ...rm, killSwitchPlan: () => ({ urls: [f.paths.valkeyUrl], disagreement: null, context: null }) } };
  try {
    await assert.rejects(executeToolAction("dispatch_pause", {}, { hasUI: false }, options), (e) => modelToolRefusal(e) === switchPartialRefusal(true, false, false, true, null, "WRONGTYPE", ["answered with an error for pi-jobs (its state could not be read, so it may have partly applied); confirmed paused: none"]) || assert.fail(modelToolRefusal(e)));
  } finally {
    await reader.dispose();
  }
});

// Issue #1064: a fleet resume stopped at the first queue Valkey answered with an error and left every queue after it
// paused, on every call. Through the tool's own reader (no fleet handed in: the adapter and the reader it builds, over
// seams that dial nothing) and the reader's real walk, with that queue first, in the middle and last.
test("dispatch_resume through the tool's own reader reaches every queue Valkey answers for, wherever the one it answers with an error stands, and tells a model which queues, the code and what to put right, never to try again (#1064)", async () => {
  const rm = await import("../src/read-model.mjs");
  const names = ["pi-jobs", "pi-jobs@hosta", "pi-jobs@hostb", "pi-jobs@hostc"];
  const wrongtype = (tail = "") => Object.assign(new Error(`WRONGTYPE Operation against a key holding the wrong kind of value${tail}`), { name: "ReplyError" });
  for (const [where, bad] of [["first", names[0]], ["middle", names[2]], ["last", names[3]]]) {
    const f = fixture();
    const sent = [];
    const make = quietQueue();
    const seams = {
      makeQueueFn: (c, o) => {
        const q = make(c, o);
        return { ...q, isPaused: async () => { if (q.name === bad) throw wrongtype(); return true; }, resume: async () => { sent.push(q.name); if (q.name === bad) throw wrongtype(" script: b4514f4b39660691beec2ab3023b9b46b093b439, on @user_script:57."); } };
      },
      parseConnectionFn: () => ({}),
      redisFn: () => keyedRedis(registryKeys(Object.fromEntries(["hosta", "hostb", "hostc"].map((h) => [h, { routes: "true", beatAt: String(NOW) }])))),
      switchStepTimeoutMs: 80,
      closeTimeoutMs: 30,
    };
    const { fleet: _handedIn, ...options } = f.options;
    const readModel = { ...rm, createFleetReader: (paths, opts) => rm.createFleetReader(paths, { ...opts, ...seams }), killSwitchPlan: () => ({ urls: [f.paths.valkeyUrl], disagreement: null, context: null }) };
    let said = null;
    await assert.rejects(executeToolAction("dispatch_resume", {}, { hasUI: true, ui: { confirm: async () => true } }, { ...options, readModel }), (e) => { said = modelToolRefusal(e); return true; });
    assert.equal(said, `The fleet resume did not reach every queue, so some queues may be resumed and others not, and Valkey answered a resume with an error, which can come after the queue was resumed. By queue: answered with an error for ${bad} (its state could not be read, so it may have partly applied); confirmed resumed: ${names.filter((n) => n !== bad).join(", ")}. Valkey answered a queue's resume with WRONGTYPE: a key of that queue holds another kind of value. Trying again does not change that: an operator has to remove or repair that key first. An operator can look at the fleet in the console; the resume is worth trying again only once that is put right.`, where);
    assert.deepEqual(sent, names, `${where}: every queue was sent its resume, the ones after ${bad} too`);
    assert.ok(!said.includes("redis://") && !said.includes("not tried"), "the queues by name, and no Valkey's address");
  }
});

// Issue #1036: the adapter handed its action five of the reader's methods, and a planner that asked for a sixth found
// none and took the branch it has for a reader that cannot answer. `dispatch_cancel`'s lookup by id never ran in the
// registered tool, while its test handed the request a whole reader and never met the adapter.
test("the fleet a tool's action is handed has exactly the methods the tool's request and the console's actions ask their fleet for, and each reaches the reader the tool builds (#1036)", async () => {
  const asked = new Set();
  for (const m of readFileSync(new URL("../src/console/actions.mjs", import.meta.url), "utf8").matchAll(/\bctx\??\.a\??\.fleet\??\.([A-Za-z]+)/g)) asked.add(m[1]);
  for (const m of readFileSync(new URL("../src/tool-actions.mjs", import.meta.url), "utf8").matchAll(/(?<![\w.`])fleet\??\.([A-Za-z]+)/g)) asked.add(m[1]);
  // The adapter's own, which ends the reader it built.
  asked.delete("dispose");
  assert.deepEqual([...asked].sort(), [...TOOL_FLEET_METHODS].sort(), "a method a planner asks its fleet for joins TOOL_FLEET_METHODS, and one nothing asks for leaves it");
  assert.ok(TOOL_FLEET_METHODS.includes("jobStatus") && TOOL_FLEET_METHODS.includes("supersededOf"));
  // The adapter as the tool builds it, with no fleet handed in: an action sees those methods and no other, and each
  // call goes to the reader.
  const f = fixture();
  const rm = await import("../src/read-model.mjs");
  const called = [];
  const reader = new Proxy({}, { get: (_t, method) => (typeof method !== "string" || method === "then" ? undefined : async () => { called.push(method); return method === "supersededOf" ? new Map() : {}; }) });
  let handed = null;
  const action = { name: "setting-set", kind: "setting-set", fields: ["key", "value"], preview: async (_body, ctx) => { handed = Object.keys(ctx.a.fleet).sort(); for (const method of TOOL_FLEET_METHODS) await ctx.a.fleet[method]({}); return { unchanged: true }; } };
  const { fleet: _handedIn, ...options } = f.options;
  assert.deepEqual(await executeToolAction("dispatch_set", { key: "dailyCap", value: "5" }, { hasUI: false }, { ...options, readModel: { ...rm, createFleetReader: () => reader }, actionLookup: () => action }), { applied: false, unchanged: true });
  assert.deepEqual(handed, [...TOOL_FLEET_METHODS, "dispose"].sort());
  assert.deepEqual(called, [...TOOL_FLEET_METHODS, "dispose"], "each in turn, then the reader is ended");
});

// Issue #1036: `dispatch_cancel` through the tool's own adapter (no fleet handed in), over a reader whose running list
// is not whole. The lookup by id decides: with `jobStatus` not handed on, each of these was refused.
test("dispatch_cancel through the tool's own adapter looks the job up by its id: found running it is cancelled as running, and found nowhere it is refused with the row's key and code (#1036)", async () => {
  const rm = await import("../src/read-model.mjs");
  const run = async (jobId, status) => {
    const f = fixture();
    const cancelled = [];
    const reader = {
      snapshot: async () => ({ active: [], held: { rows: [] }, activeUnreachable: true, queue: { fleetError: null, unreadHosts: [{ name: "hostw", error: "WRONGTYPE" }] } }),
      jobStatus: async (id, opts) => ({ ...status, asked: [id, opts] }),
      cancelActive: async ({ jobId: id }) => { cancelled.push(id); return { ack: "hostw" }; },
      dispose: async () => {},
    };
    const { fleet: _handedIn, ...options } = f.options;
    try {
      const out = await executeToolAction("dispatch_cancel", { jobId }, { hasUI: true, ui: { confirm: async () => true } }, { ...options, readModel: { ...rm, createFleetReader: () => reader } });
      return { out, cancelled };
    } catch (e) {
      return { refused: modelToolRefusal(e) ?? e.message, cancelled };
    }
  };
  const running = await run("gh-run-w", { found: true, state: "active" });
  assert.deepEqual([running.out?.applied, running.out?.action, running.cancelled], [true, "cancel-active", ["gh-run-w"]], JSON.stringify(running));
  const nowhere = await run("gh-nope", { found: null, state: null });
  assert.deepEqual([nowhere.refused, nowhere.cancelled], ["whether this job is running is not known: no queue that was read says, and the queue of host hostw was not asked, since Valkey answers host:h:hostw with WRONGTYPE. Remove or repair that key first; nothing was changed", []]);
});

test("bulk and cancellation selectors refuse ambiguous or ignored arguments", async () => {
  for (const [name, params] of [["dispatch_cancel", { allHeld: true, jobId: "j1" }], ["dispatch_cancel", {}], ["dispatch_remove_failed", { all: true, jobId: "j1" }], ["dispatch_retry_failed", { jobId: "j1", repo: "acme/web" }]]) {
    await assert.rejects(toolActionRequest(name, params), /send either/);
  }
});

test("generic model projection retains typed counts and qualifications while excluding private additions", async () => {
  const { agentReadProjection } = await import("../src/agent-read.mjs");
  const out = agentReadProjection({ shadowed: 2, variables: ["PRIVATE_VARIABLE"], probabilities: { safe: 0.9 }, classification: "safe", draftRunId: "private-draft-id", note: "PRIVATE_SENTINEL", newText: "PRIVATE_SENTINEL", status: "running", countersUnreachable: "PRIVATE_SENTINEL", invalid: ["dailyCostUsd", "PRIVATE_SENTINEL"], size: { memMiB: 4096, memorySource: "PRIVATE_SENTINEL" }, suggestion: { action: { action: "limit-edit", index: 1, limit: { memory: "4g", cpus: 2 } } } });
  assert.deepEqual(out, { shadowed: 2, variablesCount: 1, status: "running", countersUnreachable: true, invalid: ["dailyCostUsd"], size: { memMiB: 4096 }, suggestion: { action: { action: "limit-edit", index: 1, limit: { memory: "4g", cpus: 2 } } } });
});

test("only source-owned refusal provenance can preserve a public model message", async () => {
  const { modelToolRefusal, publicToolRefusal, MODEL_TOOL_REFUSAL } = await import("../src/tool-refusals.mjs");
  const privateText = "/private/member privatepersona";
  const forged = Object.assign(new Error(privateText), { public: true, safeForModel: true, publicMessage: privateText, modelMessage: privateText });
  assert.equal(modelToolRefusal(forged), MODEL_TOOL_REFUSAL);
  assert.equal(modelToolRefusal(new Error("single_token_private_prose")), MODEL_TOOL_REFUSAL);
  const sourceError = publicToolRefusal("setting-set is confirm: Only a cap decrease is unattended.");
  assert.equal(modelToolRefusal(sourceError), sourceError.message);
});
