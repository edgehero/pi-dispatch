import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS } from "../src/console/actions.mjs";
import { ACTION_AGENT_POLICIES, actionAgentPolicy, authorizeTransition, evaluateAgentAction } from "../src/action-policy.mjs";
import { agentReadProjection } from "../src/agent-read.mjs";
import { paidStartEnvironment } from "../src/agent-starts.mjs";

const agent = { role: "agent", name: "controller" };
const mode = (action, transition) => evaluateAgentAction(action, transition).mode;
test("every action has an explicit policy with a reason and non-person actions have a tool", () => {
  for (const action of ACTIONS) {
    assert.ok(Object.hasOwn(ACTION_AGENT_POLICIES, action.name), action.name);
    assert.deepEqual(action.agent, actionAgentPolicy(action.name));
    assert.ok(action.agent.reason.length > 15);
    if (action.agent.mode !== "person") assert.ok(action.agent.tools.length, action.name);
  }
  assert.throws(() => actionAgentPolicy("new-action-without-review"), /no explicit/);
});

test("only actual explicit decreases authorize settings, including exact micro-dollars", () => {
  for (const [key, old, next] of [["dailyCap", 10, 9], ["maxTokens", 200, 100], ["concurrency", 3, 2], ["maxTurns", 30, 20], ["softHoldPct", 90, 80], ["dailyCostUsd", "2.000002", "2.000001"], ["maxCostUsd", 2.000002, "2.000001"], ["dailyCostUsd", 3, 2]]) {
    const transition = { before: { [key]: old, provider: "fixed" }, after: { [key]: next, provider: "fixed" } };
    assert.equal(mode("setting-set", transition), "unattended", key);
    assert.equal(mode("setting-set", { before: transition.after, after: transition.before }), "confirm", `${key} raise`);
    assert.equal(mode("setting-set", { before: {}, after: { [key]: next } }), "confirm", `${key} inherited`);
    assert.equal(mode("setting-set", { before: transition.before, after: {} }), "confirm", `${key} unset`);
    assert.equal(mode("setting-set", { ...transition, after: { ...transition.after, provider: "changed" } }), "confirm", `${key} mixed`);
  }
  for (const value of [null, NaN, Infinity, "10", {}, -1]) assert.equal(mode("setting-set", { before: { dailyCap: value }, after: { dailyCap: 1 } }), "confirm");
  assert.equal(mode("setting-set", { before: { dailyCostUsd: "2" }, after: { dailyCostUsd: "1e-6" } }), "confirm");
  for (const value of [NaN, Infinity, 0.0000001, 0.1 + 0.2, "0.1234567", "0", 0]) assert.equal(mode("setting-set", { before: { dailyCostUsd: 2 }, after: { dailyCostUsd: value } }), "confirm", String(value));
});

test("scoped edits preserve scope, size, minima and every unedited row", () => {
  const before = { version: 3, limits: [{ scope: "project:alpha", day: 10, hostShare: 50, memory: "2g", minJobs: 1 }, { scope: "project:beta", day: 20 }] };
  const edited = { ...before, limits: [{ ...before.limits[0], day: 9, hostShare: 40 }, before.limits[1]] };
  assert.equal(mode("limit-edit", { before, after: edited, plan: { index: 0 } }), "unattended");
  assert.equal(mode("limit-edit", { before: { version: 2, limits: [{ scope: "acme/web", dayUsd: 2 }] }, after: { version: 2, limits: [{ scope: "acme/web", dayUsd: "1.999999" }] }, plan: { index: 0 } }), "unattended");
  for (const change of [{ scope: "project:other" }, { memory: "4g" }, { minJobs: 2 }, { day: undefined }, { week: 5 }]) {
    const after = { ...edited, limits: [{ ...edited.limits[0], ...change }, edited.limits[1]] };
    assert.equal(mode("limit-edit", { before, after, plan: { index: 0 } }), "confirm");
  }
  assert.equal(mode("limit-edit", { before, after: { ...edited, limits: [edited.limits[0], { ...edited.limits[1], day: 19 }] }, plan: { index: 0 } }), "confirm");
  const base = { version: 3, limits: [] };
  assert.equal(mode("limit-add", { before: base, after: { ...base, limits: [{ scope: "project:alpha", day: 1 }] } }), "unattended");
  for (const extra of [{ minJobs: 1 }, { memory: "2g" }, { cpus: "1" }, { unknown: true }]) assert.equal(mode("limit-add", { before: base, after: { ...base, limits: [{ scope: "project:alpha", day: 1, ...extra }] } }), "confirm");
});

test("flag-only edits do not carry a hidden flow, model, turn, scope or rule change", () => {
  const before = { triggers: [{ on: { type: "comment", phrase: "please" }, run: { flow: "review", recover: true, steer: true, maxTurns: 40 } }], answerRules: [{ id: "manual" }] };
  const after = { ...before, triggers: [{ ...before.triggers[0], run: { ...before.triggers[0].run, recover: false, steer: false } }] };
  assert.equal(mode("trigger-edit", { before, after, plan: { index: 0 } }), "unattended");
  for (const changed of [{ flow: "other" }, { model: "new" }, { maxTurns: 20 }, { progress: false }]) {
    assert.equal(mode("trigger-edit", { before, after: { ...after, triggers: [{ ...after.triggers[0], run: { ...after.triggers[0].run, ...changed } }] }, plan: { index: 0 } }), "confirm");
  }
  assert.equal(mode("trigger-edit", { before, after: { ...after, answerRules: [] }, plan: { index: 0 } }), "confirm");
});

test("agent API and headless tools share refusal semantics; persona cannot grant authority", () => {
  for (const action of ["fleet-resume", "retry-failed", "trigger-add", "parked-answer", "standing-answer-add", "answer-draft-drop", "sandbox-prepare", "model-role-edit"]) {
    for (const surface of ["api", "tool"]) assert.equal(authorizeTransition({ actor: agent, action, surface, granted: true, transition: { persona: { approved: true }, safe: true } }).ok, false, action);
  }
  assert.equal(authorizeTransition({ actor: agent, action: "fleet-pause", surface: "tool" }).ok, false);
  assert.equal(authorizeTransition({ actor: agent, action: "fleet-pause", surface: "tool", granted: true }).ok, true);
  assert.equal(authorizeTransition({ actor: { role: "viewer" }, action: "fleet-pause" }).ok, false);
  assert.equal(authorizeTransition({ actor: { role: "operator" }, action: "fleet-resume", surface: "tool", interactive: true }).ok, true);
  assert.equal(authorizeTransition({ actor: { role: "operator" }, action: "parked-answer", surface: "tool", interactive: true }).ok, false);
  assert.equal(authorizeTransition({ actor: agent, action: "setting-set", transition: { before: { dailyCap: 3 }, after: { dailyCap: 4 } } }).ok, false, "Undo of lowering is a raise");
});

test("agent reads rebuild counts and identifiers while unknown prose and private context are withheld", () => {
  const privateText = "PRIVATE_CONTEXT_CANARY_42";
  const projected = agentReadProjection({ run: { jobId: "gh-1", turns: 2, reason: "cost-cap", note: privateText, task: privateText, futureProse: privateText }, bundle: { id: "shared", variables: [privateText], placeholderNames: [privateText] }, privateDraft: { draft: privateText }, answerRules: [{ id: privateText }], progress: { note: privateText } });
  assert.deepEqual(projected, { run: { jobId: "gh-1", turns: 2, reason: "cost-cap" }, bundle: { id: "shared", variablesCount: 1, placeholderNamesCount: 1 } });
  assert.ok(!JSON.stringify(projected).includes(privateText));
});

test("paid grants are process-owned and both must be explicit", () => {
  const deployment = { PI_DISPATCH_RUN_ROOTS: "/allowed", PI_DISPATCH_RUN_PER_HOUR: "9" };
  assert.ok(paidStartEnvironment(deployment, {}).refusal);
  assert.ok(paidStartEnvironment(deployment, { PI_DISPATCH_RUN_ROOTS: "/allowed" }).refusal);
  assert.ok(paidStartEnvironment(deployment, { PI_DISPATCH_RUN_ROOTS: "/allowed", PI_DISPATCH_RUN_PER_HOUR: "Infinity" }).refusal);
  assert.equal(paidStartEnvironment(deployment, { PI_DISPATCH_RUN_ROOTS: "/process", PI_DISPATCH_RUN_PER_HOUR: "2" }).env.PI_DISPATCH_RUN_ROOTS, "/process");
});
