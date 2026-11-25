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
  assert.match(op, /This run continues as/); assert.match(op, /Recovery progress/); assert.match(op, /<b>7<\/b> of 40/); assert.match(op, /Replayed calls/); assert.match(op, /PRIVATE-PHASE/); assert.match(op, /PRIVATE-NOTE/);
  assert.match(viewer, /<b>7<\/b> of 40/); assert.doesNotMatch(viewer, /PRIVATE-PHASE|PRIVATE-NOTE/);
});


test("a lost attempt that is continuing offers its recovery and sibling, without a paid re-run", () => {
  const data = { run: { record: record() }, chat: { activeJobId: "gh-747-r2.r1" }, siblings: [record({ jobId: "gh-747-r1" })] };
  const out = String(runOutcome(view(data)));
  assert.match(out, /Open recovery run/); assert.match(out, /Open sibling replica/); assert.doesNotMatch(out, /data-action="rerun"|Open target on the forge/);
  assert.equal(String(runActionsPanel(view(data))), "");
});

test("issue #888: resources say what bounded the run, and why it kept the 30-minute limit when it did", () => {
  const watched = record({ limits: { idleMinutes: 15, stallMinutes: 240, maxMinutes: null, basis: "activity", channel: "file", lastStepAt: "2026-11-14T10:00:00.000Z", lastActivityAt: "2026-11-14T10:05:00.000Z" } });
  const out = String(runResources(view({ run: { record: watched } })));
  assert.match(out, /idle 15 min, stall 240 min, no ceiling; stopped only when idle, stalled or at the ceiling/);
  assert.match(out, /Last step seen/);
  assert.match(out, /Last activity seen/);
  const kept = record({ limits: { idleMinutes: 15, stallMinutes: 0, maxMinutes: 60, basis: "wall-clock", why: "subscription" } });
  assert.match(String(runResources(view({ run: { record: kept } }))), /idle 15 min, stall off, ceiling 60 min; kept the 30-minute limit because it signed in to its model with a subscription/);
  assert.doesNotMatch(String(runResources(view({ run: { record: record({}) } }))), /Limits|Last step seen/, "a record without limits shows no row");
});

test("a capped run's cost panel says what the cap charged, the part above pi's price, the calls that waited, the warning and the refusal's numbers; a run without them renders as before (issue #985)", () => {
  const tokens = { input: 1000, output: 100, total: 1100, cost: 27.51, metered: true, calls: 663, costCapMicros: 150_000_000, costRefused: 1, costChargedMicros: 118_940_000, costLiftedMicros: 91_420_000, costWaited: 12, costWarned: 1 };
  const capped = record({ outcome: "policy", reason: "cost-cap", why: "over-cap", tokens, costRefusal: { spentMicros: 118_940_000, inflightMicros: 30_780_000, externalMicros: 0, boundMicros: 15_100_000 } });
  const out = String(runCostPanel(view({ run: { record: capped } })));
  assert.match(out, /Charged against the cap/); assert.match(out, /\$118\.94, this run and its subprocesses/);
  assert.match(out, /Above pi&#39;s price|Above pi's price/); assert.match(out, /\$91\.42: calls charged their most \(failed or cut after they started, with broken usage, without a price, or a provider&#39;s forward\)/);
  assert.match(out, /Calls that waited/); assert.match(out, /12 waited for room under the cap/);
  assert.match(out, /Cost warning/); assert.match(out, /queued for the agent at 70% of the cap/);
  assert.match(out, /Refused at/); assert.match(out, /\$118\.94 spent \+ \$30\.78 held by calls in flight \+ \$0\.00 elsewhere in the job \+ \$15\.10 for the refused call = \$164\.82, against the \$150\.00 cap/);
  const quiet = String(runCostPanel(view({ run: { record: record({ outcome: "completed", reason: null, tokens: { ...tokens, costLiftedMicros: 0, costWarned: 0 } }) } })));
  assert.match(quiet, /<dt>Above pi&#39;s price<\/dt><dd>\$0\.00<\/dd>/); assert.match(quiet, /not queued/); assert.doesNotMatch(quiet, /Refused at/);
  const before = { input: 1000, output: 100, total: 1100, cost: 27.51, metered: true, calls: 663, costCapMicros: 150_000_000, costRefused: 1 };
  const older = String(runCostPanel(view({ run: { record: record({ outcome: "policy", reason: "cost-cap", why: "over-cap", tokens: before, costRefusal: { spentMicros: 1, inflightMicros: -2, externalMicros: 0, boundMicros: 4 } }) } })));
  for (const label of ["Charged against the cap", "Above pi", "Calls that waited", "Cost warning", "Refused at"]) assert.doesNotMatch(older, new RegExp(label), `${label}: no row for a record from before the keys, or a malformed refusal`);
});

test("issue #1008: a mixed run's cost panel shows billed and notional apart and the allowance against its limit; the cap meter plots what the cap charged", () => {
  const usage = { v: 1, truncated: 0, models: [{ provider: "anthropic", model: "claude-opus-5-5", calls: 600, input: 1, output: 1, cost: 59.75 }, { provider: "openrouter", model: "qwen-max", calls: 63, input: 1, output: 1, cost: 0.33 }] };
  const tokens = { input: 1000, output: 100, total: 1100, cost: 60.08, metered: true, calls: 663, costNotional: 59.75, costCapMicros: 150_000_000, allowanceMicros: 100_000_000, costChargedMicros: 330_000 };
  const mixed = record({ outcome: "completed", reason: null, tokens, usage, notionalProviders: ["anthropic"], dollars: { reservedMicros: 150_000_000, settledMicros: 330_000, basis: "metered" } });
  const out = String(runCostPanel(view({ run: { record: mixed } })));
  assert.match(out, /<dt>Cost<\/dt><dd>\$0\.33 \+ \$59\.75 notional<\/dd>/);
  assert.match(out, /<dt>Billed<\/dt><dd>\$0\.33: the calls the job cap and the dollar windows count<\/dd>/);
  assert.match(out, /<dt>Notional<\/dt><dd>\$59\.75 at list price on anthropic&#39;s subscription: not billed, so no cap or dollar window counts it<\/dd>/);
  assert.match(out, /<dt>Subscription allowance<\/dt><dd>\$59\.75 of \$100\.00 at list price \(59%\)<\/dd>/);
  assert.match(out, /aria-valuenow="0" aria-valuemin="0" aria-valuemax="100" aria-label="Job cap \(dollars\)"/, "the cap charged $0.33 of $150, not the $60.08 recorded");
  assert.equal((out.match(/role="meter"/g) ?? []).length, 1, "one meter, the cap's: the allowance is said in its row");
  // The issue's own run: stopped at $141.70 charged with $37.50 recorded read 25% here.
  const stopped = record({ outcome: "policy", reason: "cost-cap", tokens: { input: 1, output: 1, total: 2, cost: 37.5, metered: true, calls: 9, costCapMicros: 150_000_000, costChargedMicros: 141_700_000 } });
  assert.match(String(runCostPanel(view({ run: { record: stopped } }))), /aria-valuenow="94" aria-valuemin="0" aria-valuemax="100" aria-label="Job cap \(dollars\)"/);
  // An older image's record (notionalProviders without costNotional) and one with no subscription render as before.
  const older = String(runCostPanel(view({ run: { record: record({ outcome: "completed", reason: null, tokens: { ...tokens, costNotional: undefined, allowanceMicros: undefined, costChargedMicros: undefined }, usage, notionalProviders: ["anthropic"] }) } })));
  for (const label of ["Billed", "Notional", "Subscription allowance"]) assert.doesNotMatch(older, new RegExp(`<dt>${label}</dt>`));
  assert.match(older, /<dt>Cost<\/dt><dd>\$60\.08<\/dd>/);
  assert.match(older, /aria-valuenow="40" aria-valuemin="0" aria-valuemax="100" aria-label="Job cap \(dollars\)"/, "without costChargedMicros the recorded cost is what the cap counted");
  const models = String(runModels(view({ run: { record: mixed } })));
  assert.match(models, /\$59\.75 notional<\/td>/); assert.match(models, /\$0\.33<\/td>/);
});

test("issue #1008: a run that reserved nothing names the cap it ran under; one with no ledger reads billed and notional the same way in every row; the notional word needs costNotional", () => {
  const subOnly = { input: 1, output: 1, total: 2, cost: 7.5, metered: true, calls: 9, costNotional: 7.5, costCapMicros: 150_000_000, costChargedMicros: 0, costRefused: 1 };
  const refusal = { spentMicros: 0, inflightMicros: 0, externalMicros: 0, boundMicros: 151_000_000 };
  const unreserved = record({ outcome: "policy", reason: "cost-cap", why: "over-cap", tokens: subOnly, usage: null, notionalProviders: ["anthropic"], provider: "anthropic", model: "claude-opus-5-5", dollars: { reservedMicros: 0, settledMicros: 0, basis: "unreserved" }, costRefusal: refusal });
  const out = String(runCostPanel(view({ run: { record: unreserved } })));
  assert.match(out, /<dt>Job cap<\/dt><dd>\$150\.00<\/dd>/, "never the reservation's $0.00");
  assert.match(out, /against the \$150\.00 cap/);
  assert.match(out, /<dt>Reserved<\/dt><dd>\$0\.00<\/dd>/);
  // No usage ledger: the Cost row and the Billed and Notional rows say one split, the worker's.
  assert.match(out, /<dt>Cost<\/dt><dd>\$7\.50 notional<\/dd>/);
  assert.match(out, /<dt>Cost class<\/dt><dd>subscription<\/dd>/);
  assert.match(out, /<dt>Billed<\/dt><dd>\$0\.00: /);
  assert.match(out, /<dt>Notional<\/dt><dd>\$7\.50 at list price/);
  // A reserved run keeps the reservation as its cap.
  assert.match(String(runCostPanel(view({ run: { record: { ...unreserved, dollars: { reservedMicros: 120_000_000, settledMicros: 0, basis: "metered" } } } }))), /<dt>Job cap<\/dt><dd>\$120\.00<\/dd>/);
  // The Model usage word follows the record's own word on both keys: no costNotional, no notional row.
  const usage = { v: 1, truncated: 0, models: [{ provider: "anthropic", model: "claude-opus-5-5", calls: 9, input: 1, output: 1, cost: 7.5 }] };
  const older = record({ outcome: "completed", reason: null, tokens: { ...subOnly, costNotional: undefined }, usage, notionalProviders: ["anthropic"] });
  assert.doesNotMatch(String(runModels(view({ run: { record: older } }))), /notional/);
  assert.match(String(runModels(view({ run: { record: { ...older, tokens: subOnly } } }))), /\$7\.50 notional<\/td>/);
});

test("issue #1008: the allowance used rounds up, as the runner's allowance guard reads it, and a damaged Model usage row is skipped", () => {
  const tokens = { input: 1, output: 1, total: 2, cost: 12.3456781, metered: true, calls: 3, costNotional: 12.3456781, allowanceMicros: 100_000_000 };
  const r = record({ outcome: "completed", reason: null, tokens, usage: { v: 1, truncated: 0, models: [null, { provider: "anthropic", model: "claude-opus-5-5", calls: 3, input: 1, output: 1, cost: 12.3456781 }] }, notionalProviders: ["anthropic"] });
  const out = String(runCostPanel(view({ run: { record: r } })));
  assert.match(out, /<dt>Subscription allowance<\/dt><dd>\$12\.345679 of \$100\.00 at list price \(12%\)<\/dd>/, "12,345,678.1 micro-dollars read as 12,345,679, the guard's Math.ceil");
  const models = String(runModels(view({ run: { record: r } })));
  assert.equal((models.match(/<tr><td>/g) ?? []).length, 1, "the null row is no table row");
  assert.doesNotMatch(models, /undefined/);
});

test("a run says whether the warnings at 70% of its turn and time limits were queued, and a run without the keys renders as before (issue #1055)", () => {
  const run = (tokens, limits = { idleMinutes: 15, stallMinutes: 0, maxMinutes: 60, basis: "activity" }) => view({ run: { record: record({ outcome: "completed", reason: null, turns: 22, maxTurns: 30, tokens: { input: 1, output: 1, total: 2, metered: true, ...tokens }, limits }) } });
  const warned = run({ turnsWarned: 1, timeWarned: 1 });
  assert.match(String(runSummary(warned)), /<dt>Turn warning<\/dt><dd>queued for the agent at 70% of the turn limit<\/dd>/);
  assert.match(String(runResources(warned)), /<dt>Time warning<\/dt><dd>queued for the agent at 70% of the time limit<\/dd>/);
  const quiet = run({ turnsWarned: 0, timeWarned: 0 });
  assert.match(String(runSummary(quiet)), /<dt>Turn warning<\/dt><dd>not queued<\/dd>/);
  assert.match(String(runResources(quiet)), /<dt>Time warning<\/dt><dd>not queued<\/dd>/);
  // A run that watched no time limit (none was set) carries `turnsWarned` alone; one from before issue #1055 neither.
  const noCeiling = run({ turnsWarned: 0 }, { idleMinutes: 15, stallMinutes: 0, maxMinutes: null, basis: "activity" });
  assert.doesNotMatch(String(runResources(noCeiling)), /Time warning/);
  const older = run({});
  assert.doesNotMatch(String(runSummary(older)), /Turn warning/);
  assert.doesNotMatch(String(runResources(older)), /Time warning/);
  for (const bad of [true, "1", 2, -1]) assert.doesNotMatch(String(runSummary(run({ turnsWarned: bad }))), /Turn warning/, `${bad}: only 0 or 1 is said`);
});
