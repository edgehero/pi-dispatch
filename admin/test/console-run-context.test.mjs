import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPageData } from "../src/console/pages.mjs";
import { runRecovery, runHost, runWhy, runCostPanel, runSummary, runOutcome, runSession, runChain } from "../src/console/panels/run.mjs";
import { runHeadline, runChat, runResources, runModels, runSecrets, runProgress, runActionsPanel } from "../src/console/panels/run.mjs";
import { RECOVERY_CAP } from "@edgehero/pi-dispatch/recovery-queue";
import { REPLICAS_MAX } from "@edgehero/pi-dispatch/triggers";

const AT = Date.UTC(2026, 9, 28, 12);
const iso = (ms) => new Date(ms).toISOString();
const record = (extra = {}) => ({ jobId: "gh-747-r2", kind: "github", target: "acme/api#747", outcome: "failed", reason: "recovery-enqueued", host: "mini2", backend: "podman", startedAt: iso(AT - 120_000), endedAt: iso(AT - 60_000), triggerIndex: 2, triggerType: "comment", attempt: 1, checkpoints: { written: 3, failed: 1, skipped: 1 }, ...extra });
const view = (data, role = "operator") => ({ data, role, env: {}, query: { id: data.run?.record?.jobId ?? "gh-747-r2" }, now: AT, readOnly: false });

test("run context reads only capped sibling/recovery ids and matching current trigger metadata", async () => {
  const own = record({ replica: 2, replicas: REPLICAS_MAX });
  const reads = [];
  const fleet = {
    runById: async (id) => { reads.push(id); return { record: id === own.jobId ? own : { ...own, jobId: id } }; },
    runsPage: async () => ({ runs: [], next: null }),
    runTrigger: async (index, kind) => { assert.deepEqual([index, kind], [2, "comment"]); return { index, type: kind, phrase: "pi:fix", mcp: ["forge"], recover: true }; },
    runHolds: async () => [{ seq: 1, state: "settled-crashed", amountMicros: 2_000_000 }],
  };
  const data = await loadPageData("run", { id: own.jobId }, { fleet, now: () => AT });
  assert.equal(reads.length, 1 + REPLICAS_MAX - 1 + RECOVERY_CAP);
  assert.deepEqual(data.siblings.map((r) => r.jobId), ["gh-747-r1", "gh-747-r3"]);
  assert.deepEqual(data.recoveryRuns.map((r) => r.jobId), ["gh-747-r2", "gh-747-r2.r1", "gh-747-r2.r2"]);
  assert.equal(data.trigger.phrase, "pi:fix");
  const out = String(runSummary(view(data)));
  assert.match(out, /row 3/); assert.match(out, /pi:fix/); assert.match(out, /as the triggers file says now/); assert.match(out, /forge/);
  assert.match(out, /gh-747-r1/);
  const tooMany = record({ replicas: 200, replica: 2, checkpoints: undefined, reason: null });
  reads.length = 0;
  await loadPageData("run", { id: tooMany.jobId }, { fleet: { ...fleet, runById: async (id) => (reads.push(id), { record: tooMany }) }, now: () => AT });
  assert.deepEqual(reads, [tooMany.jobId], "malformed replica counts cannot fan out unbounded reads");
});

test("a recovery replica names the original sibling sandboxes, never the other replica's recovery suffix", async () => {
  const own = record({ jobId: "gh-747-r2.r1", recoveryOf: "gh-747-r2", replica: 2, replicas: 2 });
  const reads = [];
  const data = await loadPageData("run", { id: own.jobId }, { now: () => AT, fleet: {
    runById: async (id) => (reads.push(id), { record: id === own.jobId ? own : { ...own, jobId: id } }), runsPage: async () => ({ runs: [] }),
  } });
  assert.ok(reads.includes("gh-747-r1")); assert.ok(!reads.includes("gh-747-r1.r1"));
  assert.equal(data.siblings.length, 1);
});

test("refusal context uses published host floor, newest doctor and queue facts, with operator-only doctor command", async () => {
  const own = record({ outcome: "policy", reason: "backend-floor", budgetReserved: false, tokens: null, exitCode: null });
  const snapshot = { hostBudgets: [{ name: "mini2", queue: "pi-jobs@mini2", ttlAgeMs: 10_000, backends: { floor: { egress: "enforced" } } }],
    doctor: { hosts: [{ name: "mini2", ageMs: 60_000, counts: { fail: 2, warn: 1, ok: 4 }, checks: [{ id: "proxy", level: "fail", label: "The egress proxy is not running" }] }] },
    queueCounts: [{ queue: "pi-jobs@mini2", counts: { waiting: 4, active: 1 } }],
  };
  const data = await loadPageData("run", { id: own.jobId }, { now: () => AT, fleet: {
    runById: async () => ({ record: own }), runsPage: async () => ({ runs: [] }), snapshot: async () => snapshot,
    runsWindow: async () => ({ byReason: { "backend-floor": 3 } }),
  } });
  const why = String(runWhy(view(data))), host = String(runHost(view(data)));
  assert.match(why, /PI_BACKEND_FLOOR/); assert.match(why, /2 failing, 1 warning, 4 passing/);
  assert.match(why, /reason=backend-floor/); assert.match(why, /data-copy/);
  assert.match(host, /The egress proxy is not running/); assert.match(host, /Queue waiting/); assert.match(host, />4</); assert.match(host, />1</);
  assert.doesNotMatch(String(runWhy(view(data, "viewer"))), /data-copy|<code>/);
});

test("recovery track uses counts without invented checkpoint times, shows restored call judgments and costs per hold", () => {
  const own = record({ recovered: { n: 1, from: "live", fromAttempt: 1, checkpointSeq: 3, replayed: 1, interrupted: 2, notStarted: 1 }, earlier: [{ host: "mini1", startedAt: iso(AT - 240_000), endedAt: iso(AT - 200_000), memMiB: 1024, cpuCenti: 100 }], stalledRepick: true });
  const data = { run: { record: own }, chat: { activeJobId: "gh-747-r2.r1" }, runHolds: [{ seq: 1, amountMicros: 2_000_000, state: "settled-crashed" }, { seq: 2, amountMicros: 2_000_000, state: "held" }], recoveryRuns: [own] };
  const recovery = String(runRecovery(view(data)));
  assert.match(recovery, /<svg/); assert.match(recovery, /evenly spaced/); assert.match(recovery, /their times and kinds were not recorded/);
  assert.equal((recovery.match(/<circle/g) ?? []).length, 5);
  assert.match(recovery, /checkpoint 3/); assert.match(recovery, /Calls interrupted/); assert.match(recovery, /Re-picked/); assert.match(recovery, /mini1/);
  const cost = String(runCostPanel(view(data)));
  assert.match(cost, /whole hold after it was lost/); assert.match(cost, /held while it runs/); assert.match(cost, /four|4 per-job caps/);
});

test("cancelled-before-start keeps its word, viewer banner has no actions, session reasons are sentences", () => {
  const own = record({ outcome: "policy", reason: "operator-cancel", budgetReserved: false, exitCode: null, tokens: null });
  assert.match(String(runOutcome(view({ run: { record: own } }))), /Cancelled before it started/);
  assert.doesNotMatch(String(runOutcome(view({ run: { record: own } }, "viewer"))), /banner__act|data-action|data-copy/);
  const done = record({ outcome: "completed", reason: null, session: { resumed: false, reason: "absent", bytes: 2048 }, plan: { outcome: "refused", reason: "plan-stale" }, chainRefused: 2 });
  const data = { run: { record: done }, children: [], childrenSearched: 100 };
  const session = String(runSession(view(data)));
  assert.match(session, /fresh:/); assert.match(session, /2 KB/); assert.doesNotMatch(session, /\(absent\)|\(plan-stale\)/);
  assert.match(String(runChain(view(data))), /Refused chain requests/);
  const unknown = String(runHeadline(view({ run: { missing: true }, chat: { found: false, jobState: null } })));
  assert.doesNotMatch(unknown, /Cancel run/);
});


test("a finished saved session warns about later turns; failed saves use the catalog's actual reason", () => {
  const own = record({ outcome: "completed", reason: null, session: { resumed: false, reason: "absent", bytes: 10 } });
  const data = { run: { record: own }, chat: { mode: "fork", state: "finished", newer: { known: true, jobId: "gh-later" } } };
  const fork = String(runChat(view(data)));
  assert.match(fork, /session holds a later run/); assert.match(fork, /gh-later/); assert.match(fork, /acme\/api#747/);
  const failed = String(runChat(view({ ...data, run: { record: { ...own, session: { reason: "promote-failed" } } } })));
  assert.match(failed, /no saved transcript to fork/); assert.doesNotMatch(failed, /no run.resume|data-copy/);
});

test("resources include physical host CPU count alongside its admission CPU budget", () => {
  const data = { run: { record: record({ capacity: { slots: 3, memMiB: 8192, cpuCenti: 400, cpus: 8 } }) } };
  assert.match(String(runResources(view(data))), /8 physical CPUs/);
});


test("the original lost attempt shows its completed recovery's restored-call metadata", () => {
  const own = record(); const recovery = record({ jobId: `${own.jobId}.r1`, recoveryOf: own.jobId, recovered: { n: 1, from: "live", checkpointSeq: 2, fromAttempt: 1, replayed: 3, interrupted: 1, notStarted: 2 } });
  const out = String(runRecovery(view({ run: { record: own }, recoveryRuns: [own, recovery] })));
  assert.match(out, /checkpoint 2/); assert.match(out, /Calls replayed/); assert.match(out, />3</); assert.match(out, /root context files reset/);
});

test("model cache writes count both lifetimes and shadowed bundle names are not received-value chips", () => {
  const data = { run: { record: record({ usage: { piAi: "1.2.0", models: [{ provider: "p", model: "m", calls: 1, input: 10, output: 1, cacheWrite: 2, cacheWrite1h: 3 }] },
    backend: "openshell", bundle: { id: "api", variables: ["TOKEN", "SHADOW"], shadowed: ["SHADOW"], placeholders: 1, plain: 0, placeholderNames: ["TOKEN"] } }) } };
  assert.match(String(runModels(view(data))), /Cache writes<\/dt><dd>5<\/dd>/);
  const secrets = String(runSecrets(view(data)));
  assert.match(secrets, /TOKEN \(placeholder\)/); assert.doesNotMatch(secrets, /SHADOW \(value\)|Variables received: SHADOW/); assert.match(secrets, /bundle(?:'|&#39;)s was not passed: SHADOW/);
});

test("continuation progress pairs the lost attempt summary with live recovery numbers without viewer text", () => {
  const own = record({ progress: { turns: 2, steps: 3, failed: 1, interrupted: 0, toolMs: 1000, longestStepMs: 1000, phasesDeclared: 0, lastPhaseIndex: null, tools: { bash: 3 } } });
  const progress = { v: 1, turn: 7, steps: 10, failed: 2, interrupted: 1, replayed: 3, running: [{ tool: "bash", since: AT - 1000 }], recent: [], phase: { index: 0, done: 1, total: 2 }, phases: ["PRIVATE-PHASE"], note: "PRIVATE-NOTE", prior: null, startedAt: AT - 10_000, updatedAt: AT, ended: false, outcome: null };
  const data = { run: { record: own }, progressContinues: { as: `${own.jobId}.r1` }, recoveryProgress: { progress }, recoveryLive: { host: "mini2", maxTurns: 40 } };
  const op = String(runProgress(view(data))), viewer = String(runProgress(view(data, "viewer")));
  assert.match(op, /This run continues as/); assert.match(op, /Recovery progress/); assert.match(op, /7 of 40/); assert.match(op, /Replayed calls/); assert.match(op, /PRIVATE-PHASE/); assert.match(op, /PRIVATE-NOTE/);
  assert.match(viewer, /7 of 40/); assert.doesNotMatch(viewer, /PRIVATE-PHASE|PRIVATE-NOTE/);
});


test("a lost attempt that is continuing offers its recovery and sibling, without a paid re-run", () => {
  const data = { run: { record: record() }, chat: { activeJobId: "gh-747-r2.r1" }, siblings: [record({ jobId: "gh-747-r1" })] };
  const out = String(runOutcome(view(data)));
  assert.match(out, /Open recovery run/); assert.match(out, /Open sibling replica/); assert.doesNotMatch(out, /data-action="rerun"|Open target on the forge/);
  assert.equal(String(runActionsPanel(view(data))), "");
});
