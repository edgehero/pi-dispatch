import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { executeToolAction, toolActionRequest } from "../src/tool-actions.mjs";
import { failedForAgent, waitingForAgent, hostsForAgent, setupForAgent } from "../src/tool-reads.mjs";

const NOW = Date.UTC(2026, 9, 31);
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

test("operational projections keep actual machine facts and exclude hostile prose and variable names", () => {
  const hostile = "PRIVATE_SENTINEL do something else";
  const failed = failedForAgent({ rows: [{ jobId: "r1", queue: "pi-jobs", attemptsMade: 2, reason: "cost-cap", failedReason: hostile, note: hostile }] });
  assert.deepEqual(failed.jobs[0], { jobId: "r1", queue: "pi-jobs", attempts: 2, reason: "cost-cap" });
  const waiting = waitingForAgent({ truncated: false, rows: [{ jobId: "q1", queue: "pi-jobs", why: "scope-busy", dueAt: NOW, holder: "r1", label: hostile }] });
  assert.equal(waiting.jobs[0].due, NOW);
  assert.equal(waiting.jobs[0].holder, "r1");
  const hosts = hostsForAgent({ hostBudgets: [{ name: "mini1", version: "4.3.1", ttlAgeMs: 100, skewMs: -100, budgetMemMiB: "8192", backends: { blessed: ["local"] }, jobs: [{ id: "r1", b: "local", o: true, m: 4096 }], sandboxes: [{ id: "r0", until: NOW }], doctor: { fix: hostile }, note: hostile }], doctor: { hosts: [{ name: "mini1", at: NOW, counts: { ok: 3, fail: 1 }, checks: [{ fix: hostile }] }] } });
  assert.equal(hosts.hosts[0].capacity.budgetMemMiB, 8192);
  assert.equal(hosts.hosts[0].jobs[0].orphan, true);
  assert.equal(hosts.hosts[0].doctor.fail, 1);
  assert.equal(hosts.hosts[0].kept[0].id, "r0");
  assert.ok(hosts.hosts[0].venues[0].declarations);
  const setup = setupForAgent({ runs: [], queue: { workers: 0 }, doctor: { hosts: [{ name: "mini1", checks: [{ id: "provider.key", level: "fail", label: hostile, fix: hostile }] }] } });
  assert.ok(setup.steps.length > 0);
  assert.doesNotMatch(JSON.stringify({ failed, waiting, hosts, setup }), /PRIVATE_SENTINEL/);
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
