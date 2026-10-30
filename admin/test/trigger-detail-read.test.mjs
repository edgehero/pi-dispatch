import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readTriggers, readTriggersWithInstructions, readTriggersWithStalls, triggerDetailOf, readTriggerEditor, readTriggerSkew, configLocationsOf } from "../src/read-model.mjs";
import { stateOf } from "../src/console/live.mjs";
import { stallKey } from "@edgehero/pi-dispatch/scheduler-stall-guard";

const AT = Date.UTC(2026, 9, 30, 12);
const fileFs = (triggers) => ({ readFileSync: () => JSON.stringify({ triggers }) });

test("trigger display carries explicit configuration and keeps task and instruction text in separate operator maps", () => {
  const fs = fileFs([null, { on: { type: "pull_request", action: ["review_submitted"], reviewState: ["approved"] }, run: { kind: "github", flow: "review", task: "PRIVATE TASK", instructions: "PRIVATE INSTRUCTIONS", repository: "acme/web", awaitInput: true, github: false, progress: false, statusComment: true, recover: true, steer: false, waitFor: [{ profile: "ready", ignored: "PRIVATE" }, { after: "2026-11-01T00:00:00Z" }] } }]);
  const got = readTriggersWithInstructions({ triggersPath: "/t", fs, includeTasks: true });
  assert.deepEqual(got.tasks, { 1: "PRIVATE TASK" });
  assert.deepEqual(got.instructions, { 1: "PRIVATE INSTRUCTIONS" });
  const row = got.view.triggers[0];
  assert.equal(row.index, 1);
  assert.equal(row.task, true);
  assert.equal(row.instructions, true);
  assert.equal(row.repository, "acme/web");
  assert.deepEqual(row.reviewState, ["approved"]);
  assert.deepEqual(row.waitFor, [{ profile: "ready" }, { after: "2026-11-01T00:00:00Z" }]);
  for (const [key, value] of Object.entries({ awaitInput: true, github: false, progress: false, statusComment: true, recover: true, steer: false })) assert.equal(row[key], value);
  assert.doesNotMatch(JSON.stringify(got.view), /PRIVATE/);
  const empty = readTriggers({ triggersPath: "/t", fs: fileFs([{ on: { type: "comment" }, run: { flow: "fix" } }]) }).triggers[0];
  for (const key of ["task", "repository", "reviewState", "waitFor", "awaitInput", "github", "progress", "statusComment", "recover", "steer"]) assert.equal(Object.hasOwn(empty, key), false, key);
  for (const role of ["viewer", "operator"]) assert.doesNotMatch(JSON.stringify(stateOf({ triggers: got.view, triggerInstructions: got.instructions, triggerTasks: got.tasks }, role, { now: AT })), /PRIVATE/);
});

test("cron tool display reads named counters without scanning and distinguishes zero from an unread counter", async () => {
  const fs = fileFs([{ on: { type: "cron", id: "daily" }, run: {} }, { on: { type: "label" }, run: {} }, { on: { type: "cron", id: "weekly" }, run: {} }]);
  let closed = 0;
  const got = await readTriggersWithStalls({ triggersPath: "/t", url: "redis://fake", fs, redisFn: () => ({ mget: async (...keys) => { assert.deepEqual(keys, [stallKey("daily"), stallKey("weekly")]); return [null, "2"]; }, disconnect: () => closed++ }) });
  assert.equal(got.triggers[0].stalls, 0);
  assert.equal(Object.hasOwn(got.triggers[1], "stalls"), false);
  assert.equal(got.triggers[2].stalls, 2);
  assert.equal(closed, 1);
  const failed = await readTriggersWithStalls({ triggersPath: "/t", fs, redisFn: () => { throw Error("secret connection value"); } });
  assert.equal(failed.triggers[0].stalls, null);
  assert.doesNotMatch(JSON.stringify(failed), /secret connection/);
  await readTriggersWithStalls({ triggersPath: "/t", fs: fileFs([]), redisFn: () => { throw Error("must not connect"); } });
});

const rec = (id, hours, extra = {}) => ({ jobId: id, triggerIndex: 2, triggerType: "label", startedAt: new Date(AT - hours * 3600_000).toISOString(), endedAt: new Date(AT - hours * 3600_000).toISOString(), outcome: "completed", tokens: { cost: 0.25, metered: true, input: 1, output: 1, total: 2, calls: 1 }, provider: "provider", model: "model", ...extra });

test("detail counts only this trigger inside the day, uses wide history, orders five runs and preserves unknowns", () => {
  const runs = Array.from({ length: 7 }, (_, i) => rec(`j${i}`, i));
  runs.push(rec("old", 25), rec("future", -1), rec("wrong-type", 1, { triggerType: "comment" }), rec("wrong-index", 1, { triggerIndex: 3 }));
  const snapshot = { readAt: AT, triggers: { triggers: [{ index: 2, type: "label", replicas: 3 }] }, recordDetails: new Map(runs.map((r) => [r.jobId, r])), runs: [], defaultBackend: "openshell", sandboxRetentionHours: 0, waiting: { rows: [{ jobId: "queued", trigger: 2 }, { jobId: "other", trigger: 3 }] } };
  const got = triggerDetailOf(snapshot, 2, { now: AT });
  assert.equal(got.count24h, 7);
  assert.equal(got.cost24h, 1.75);
  assert.equal(got.costIncomplete, false);
  assert.deepEqual(got.lastRuns.map((r) => r.jobId), ["j0", "j1", "j2", "j3", "j4"]);
  assert.deepEqual(got.queued.map((r) => r.jobId), ["queued"]);
  assert.equal(got.sandbox.backend, "openshell");
  assert.equal(got.sandbox.serves.recovery, "no");
  assert.equal(got.sandbox.serves.sandboxShell, "no");
  assert.equal(got.sandbox.retentionHours, 0);
  assert.equal(got.sandbox.replicas, 3);
  assert.equal(got.skewed, null);
  assert.equal(triggerDetailOf(snapshot, 99), null);
  assert.equal(triggerDetailOf({ ...snapshot, waiting: { unreachable: true } }, 2).queued, null);
});

test("cron detail matches the scheduler id, not a neighbouring row, and uses the teardown threshold", () => {
  const trigger = { index: 0, type: "cron", id: "daily" };
  const got = triggerDetailOf({ readAt: AT, triggers: { triggers: [trigger] }, runs: [rec("manual:daily:123", 1, { triggerIndex: null }), rec("repeat:daily:456", 2, { triggerIndex: null }), rec("manual:other:123", 1, { triggerIndex: null })], schedulers: [{ key: "daily", next: AT + 1000, overdueMs: null }], schedulerStalls: { daily: 2 }, schedulerStallMax: 2 }, 0);
  assert.equal(got.count24h, 2);
  assert.equal(got.cron.next, AT + 1000);
  assert.equal(got.cron.stalls, 2);
  assert.equal(got.cron.stallLimit, 3);
});

test("editor suggestions expose tier names and blessed capabilities without secret values", () => {
  const got = readTriggerEditor({ folder: "/repo", paths: { settingsFile: "/settings", globalPiDir: "/pi" }, env: { PI_BACKENDS: "openshell,local", WEBHOOK_SECRET: "PRIVATE_SECRET", GITLAB_TOKEN: "PRIVATE_TOKEN", FORGEJO_WEBHOOK_SECRET: "PRIVATE_SECRET" }, fs: { readFileSync: () => "{}" }, folderSkillsFn: () => ({ skills: [{ name: "fix" }, { name: "helper", isSub: true }] }), overlaySkillsFn: () => ({ skills: [{ name: "review" }] }), stagedSkillsFn: () => ({ skills: [{ name: "test" }] }) });
  assert.deepEqual(got.forges, ["github", "forgejo"]);
  assert.deepEqual(got.flows, [{ name: "fix", tier: "repository" }, { name: "review", tier: "overlay" }, { name: "test", tier: "packages" }]);
  assert.equal(got.defaults.maxTurns, 30);
  assert.equal(got.defaults.backend, "openshell");
  assert.equal(got.backends[0].serves.sandboxShell, "no");
  assert.doesNotMatch(JSON.stringify(got), /PRIVATE/);
});

test("skew warning uses the worker's identity guard and returns only matching refused jobs", async () => {
  const fs = fileFs([{ on: { type: "label" }, run: { kind: "github", flow: "fix", models: ["provider/model"], steer: true } }]);
  const job = (over = {}) => ({ kind: "github", flow: "fix", trigger: { matched: { index: 0, type: "label" } }, ...over });
  const jobs = { stale: job(), present: job({ models: ["provider/model"], steer: true }), changed: job({ flow: "other" }), other: job({ trigger: { matched: { index: 1, type: "label" } } }) };
  const waiting = { rows: Object.keys(jobs).map((jobId) => ({ queue: "q", jobId })) };
  const got = await readTriggerSkew({ index: 0, waiting, triggersPath: "/t", fs, lookupJob: async (_q, id) => ({ data: { ...jobs[id], body: "PRIVATE BODY" } }) });
  assert.deepEqual(got.rows, [{ jobId: "stale", queue: "q", field: "models" }]);
  assert.deepEqual(got.queued.map((r) => r.jobId), ["changed", "present", "stale"]);
  assert.equal(got.incomplete, false);
  assert.doesNotMatch(JSON.stringify(got), /PRIVATE/);
  const failed = await readTriggerSkew({ index: 0, waiting, triggersPath: "/t", fs, lookupJob: async () => { throw Error("private"); } });
  assert.deepEqual(failed, { rows: [], queued: [], incomplete: true });
});


test("detail metered spend excludes plan-covered and unmetered runs and names the incomplete coverage", () => {
  const runs = [rec("paid", 1), rec("plan", 2, { provider: "plan-provider" }), rec("unknown", 3, { tokens: null })];
  const got = triggerDetailOf({ readAt: AT, triggers: { triggers: [{ index: 2, type: "label" }] }, runs }, 2, { subscriptions: [{ id: "plan", provider: "plan-provider", models: ["*"] }] });
  assert.equal(got.cost24h, 0.25);
  assert.equal(got.count24h, 3);
  assert.equal(got.costIncomplete, true);
});

test("skew read bounds its queue lookups and never calls an unread file a clean queue", async () => {
  let calls = 0;
  const waiting = { rows: Array.from({ length: 201 }, (_, i) => ({ queue: "q", jobId: `j${i}` })) };
  const got = await readTriggerSkew({ index: 0, waiting, triggersPath: "/t", fs: fileFs([]), lookupJob: async () => { calls++; return { data: {} }; } });
  assert.equal(calls, 200);
  assert.equal(got.incomplete, true);
  const missing = await readTriggerSkew({ index: 0, waiting, triggersPath: "/t", fs: { readFileSync: () => { throw Error("unreadable"); } }, lookupJob: () => { throw Error("must not read jobs"); } });
  assert.deepEqual(missing, { rows: [], incomplete: true });
});


test("repository suggestions use known local cron folders and disclose the bounded cut", () => {
  const triggers = Array.from({ length: 18 }, (_, index) => ({ on: { type: "cron", id: `c${index}` }, run: { folder: `/repo/${index}` } }));
  const visited = [];
  const got = readTriggerEditor({ paths: { settingsFile: "/settings", triggersPath: "/triggers" }, fs: { readFileSync: (path) => path === "/settings" ? "{}" : JSON.stringify({ triggers }) }, folderSkillsFn: ({ folder }) => { visited.push(folder); return { skills: [{ name: "fix" }] }; }, overlaySkillsFn: () => ({ skills: [] }), stagedSkillsFn: () => ({ skills: [] }) });
  assert.equal(visited.length, 16);
  assert.deepEqual(visited, Array.from({ length: 16 }, (_, i) => `/repo/${i}`));
  assert.equal(got.flows.length, 16);
  assert.deepEqual(got.flowProblems, [{ tier: "repository", unavailable: false, truncated: true }]);
});


test("manual console editor resolves endpoint presence and deployment defaults from trusted .env without taking capability grants", () => {
  const deploymentDir = tempDir("trigger-editor-env-");
  writeFileSync(join(deploymentDir, ".env"), "WEBHOOK_SECRET=PRIVATE_GH\nFORGEJO_WEBHOOK_SECRET=PRIVATE_FJ\nPI_MAX_TURNS=17\nPI_RUN_PROGRESS=0\nPI_BACKENDS=openshell\nPI_DISPATCH_RUN_ROOTS=/untrusted/grant\nPI_DISPATCH_RUN_PER_HOUR=999\n", { mode: 0o600 });
  const env = {};
  const got = readTriggerEditor({ deploymentDir, env, paths: { settingsFile: join(deploymentDir, "settings.json"), triggersPath: join(deploymentDir, "triggers.json") } });
  assert.deepEqual(got.forges, ["github", "forgejo"]);
  assert.equal(got.defaults.maxTurns, 17);
  assert.equal(got.defaults.backend, "local", "the file cannot bless a venue");
  assert.equal(got.defaults.progress, false, "global progress machinery does not opt a trigger into phases");
  assert.equal(got.defaults.statusComment, false, "status comments are per-trigger opt in");
  assert.equal(got.progressAvailable, false);
  assert.deepEqual(env, {}, "the original environment and grants are untouched");
  assert.doesNotMatch(JSON.stringify(got), /PRIVATE|untrusted\/grant|999/);
  assert.equal(got.forgeProblem, null);
});

test("configuration file labels expose only final folders and precisely identify settings outside the deployment", () => {
  const home = "/Users/private-user";
  const standard = configLocationsOf({ home, deploymentDir: "/srv/dispatch", paths: { settingsFile: `${home}/.pi-dispatch/settings.json`, triggersPath: "./triggers.json" } });
  assert.deepEqual(standard, { settings: "~/.pi-dispatch/settings.json", triggers: ".../dispatch/triggers.json", settingsOutsideDeployment: true });
  const inside = configLocationsOf({ home, deploymentDir: "/srv/dispatch", paths: { settingsFile: "/srv/dispatch/settings.json", triggersPath: `${home}/triggers.json` } });
  assert.deepEqual(inside, { settings: ".../dispatch/settings.json", triggers: "~/triggers.json", settingsOutsideDeployment: false });
  const sibling = configLocationsOf({ home, deploymentDir: "/srv/dispatch", paths: { settingsFile: "/srv/dispatch-other/custom.json" } });
  assert.equal(sibling.settingsOutsideDeployment, true, "sibling prefix is outside");
  assert.doesNotMatch(JSON.stringify([standard, inside, sibling]), /private-user|\/Users\/|\/srv\//);
});

test("the trigger field inventory is the loader's normalized run contract, including shared model and approval fields", async () => {
  const { readFileSync } = await import("node:fs");
  const { EDIT_FIELDS, HAND_FIELDS } = await import("../src/console/panels/trigger.mjs");
  const source = readFileSync(new URL("../../worker/src/triggers.mjs", import.meta.url), "utf8");
  // Each normalizer returns one explicit run literal. Include conditional object literals inside it, and refuse a
  // new unrecognized spread rather than letting the inventory silently miss a shared validator's new fields.
  const normalized = [...source.matchAll(/^\s*run: \{([^\n]+)\},?$/gm)].map((m) => m[1]);
  assert.ok(normalized.length >= 5, "the cron and four forge-kind normalizers must be found");
  const keys = new Set();
  const addKeys = (body) => {
    for (const match of body.matchAll(/(?:^|[{,])\s*([A-Za-z_]\w*)\s*(?=:|[,}])/g)) keys.add(match[1]);
  };
  for (const body of normalized) {
    addKeys(body);
    for (const spread of body.matchAll(/\.\.\.([A-Za-z_]\w*)/g)) assert.ok(["ref", "validateApprovalConfig"].includes(spread[1]), `account for spread ${spread[1]} in the field inventory`);
  }
  const model = readFileSync(new URL("../../worker/src/model-ref.mjs", import.meta.url), "utf8");
  for (const match of model.matchAll(/\bout\.([A-Za-z_]\w*)\s*=/g)) keys.add(match[1]);
  const approval = readFileSync(new URL("../../worker/src/approval-policy.mjs", import.meta.url), "utf8");
  const approvalReturn = approval.match(/^\s*return \{ gates:[^\n]+$/m);
  assert.ok(approvalReturn, "the approval normalizer must be found");
  addKeys(approvalReturn[0].slice(approvalReturn[0].indexOf("{") + 1));
  const actual = [...EDIT_FIELDS, ...HAND_FIELDS];
  assert.equal(new Set(actual).size, actual.length, "every run field belongs to exactly one group");
  assert.deepEqual([...actual].sort(), [...keys].sort());
  assert.ok(!actual.includes("modelRoles"), "modelRoles is a top-level file policy, never a run field");
});
