import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import Redis from "ioredis";
import { tempDir } from "./helpers/temp-dir.mjs";
import { buildRecord } from "@edgehero/pi-dispatch/run-history";
import { makeQuestionGroupStore } from "@edgehero/pi-dispatch/question-groups";
import { makeZeroTouchFixStore } from "@edgehero/pi-dispatch/zero-touch-fixes";
import { makeTouchStore } from "@edgehero/pi-dispatch/touch-state";
import { makeZeroTouchService } from "../src/zero-touch-data.mjs";

const base = process.env.VALKEY_TEST_URL;
if (!base && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("Zero touch review integration requires VALKEY_TEST_URL");
const skip = base ? false : "VALKEY_TEST_URL not set";
const NOW = Date.UTC(2026, 9, 30, 12), DAY = 86400000;
const hash = value => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const prefix = `zero-touch-review-${randomUUID()}:`;
  const redisFn = () => new Redis(base, { keyPrefix: prefix, maxRetriesPerRequest: null });
  const redis = redisFn();
  t.after(async () => {
    // ioredis prefixes keys, including Lua KEYS and MULTI commands; discovery itself does not add a prefix.
    const raw = new Redis(base, { maxRetriesPerRequest: null });
    const keys = await raw.keys(`${prefix}*`);
    if (keys.length) await raw.del(...keys);
    await raw.quit();
    redis.disconnect();
  });
  const root = tempDir("zero-touch-review-");
  const paths = { logsDir: join(root, "logs"), triggersPath: join(root, "triggers.json"), valkeyUrl: base };
  fs.mkdirSync(paths.logsDir);
  const doc = { triggers: [{ on: { type: "label", any: ["fix"] }, run: { kind: "github", flow: "fix" } }], zeroTouch: { capture: true, model: "test/classifier", maxCostUsd: "0.05", names: {} } };
  fs.writeFileSync(paths.triggersPath, JSON.stringify(doc));
  let clock = NOW - 100 * DAY;
  const now = () => clock;
  const touches = makeTouchStore({ redis, now, retentionDays: 365 });
  await touches.initialize();
  clock = NOW;
  const service = makeZeroTouchService({ paths, env: { PI_LOG_RETENTION_DAYS: "365" }, now, redisFn, triggerBindingFn: async ({ jobId, index }) => ({ ok: true, runId: jobId, index, triggerDigest: hash(JSON.stringify(JSON.parse(fs.readFileSync(paths.triggersPath, "utf8")).triggers[index])) }) });
  function record(jobId, scopeId, { project = null, reason = null } = {}) {
    const value = buildRecord({ job: { id: jobId, data: { kind: "github", repo: "acme/api", touchScopeId: scopeId, trigger: { matched: { index: 0, type: "label", label: "fix" } } } }, result: { outcome: "completed", reason }, startedAt: new Date(NOW - DAY - 1000).toISOString(), endedAt: new Date(NOW - DAY).toISOString(), host: "review-host", project, touchTracking: true });
    fs.writeFileSync(join(paths.logsDir, `${jobId}.json`), JSON.stringify(value));
    return value;
  }
  return { paths, redis, service, touches, record, now, advance: () => clock += 1000 };
}

test("the actual touched-run service keeps missing and literally unassigned projects separate", { skip }, async t => {
  const f = await fixture(t), missingScope = "a".repeat(64), namedScope = "b".repeat(64);
  f.record("missing", missingScope);
  f.record("named", namedScope, { project: "unassigned" });
  await f.touches.write({ runId: "missing", cause: "steer", at: NOW - DAY, scopeId: missingScope });
  await f.touches.write({ runId: "named", cause: "rerun", at: NOW - DAY, scopeId: namedScope, project: "unassigned" });
  const missing = await f.service.read({ project: "~", windowDays: 7 });
  assert.deepEqual(missing.projects.map(p => [p.project, p.name, p.touched]), [["~", "No project recorded", 1]]);
  assert.deepEqual((await f.service.runs({ filter: { project: "~", touched: "1" }, windowDays: 7 })).runs.map(r => r.jobId), ["missing"]);
  assert.deepEqual((await f.service.runs({ filter: { project: "unassigned", touched: "1" }, windowDays: 7 })).runs.map(r => r.jobId), ["named"]);
  assert.deepEqual((await f.service.runs({ filter: { project: "~", touched: "1" }, scopeId: namedScope, windowDays: 7 })).runs, [], "scope and missing-project predicates both apply");
});

test("the actual service scopes fix rows and grouping-status totals with its project and repository", { skip }, async t => {
  const f = await fixture(t), missingScope = "a".repeat(64), namedScope = "b".repeat(64);
  f.record("missing", missingScope, { reason: "awaiting-input" });
  f.record("named", namedScope, { project: "unassigned", reason: "awaiting-input" });
  const groups = makeQuestionGroupStore({ redis: f.redis, now: f.now, retentionDays: 365 });
  for (const [runId, scopeId, project] of [["missing", missingScope, null], ["named", namedScope, "unassigned"]]) {
    assert.equal((await groups.capture({ runId, scopeId, project, text: "Which package manager applies?", redact: value => value })).ok, true);
  }
  await groups.setStatus("missing", "pending");
  const fixes = makeZeroTouchFixStore({ redis: f.redis, now: f.now, retentionDays: 365 });
  for (const [runId, scopeId, project] of [["fix-missing", missingScope, null], ["fix-named", namedScope, "unassigned"]]) {
    assert.equal((await fixes.add({ kind: "config", runId, scopeId, project, reason: "secret-unresolved", at: NOW - DAY })).ok, true);
  }
  const missing = await f.service.read({ project: "~", windowDays: 7 });
  assert.deepEqual(missing.fixes.map(row => row.runId), ["fix-missing"]);
  assert.deepEqual([missing.grouping.pending, missing.grouping.unassigned, missing.ungroupedRunIds], [1, 1, ["missing"]]);
  const named = await f.service.read({ project: "unassigned", windowDays: 7 });
  assert.deepEqual(named.fixes.map(row => row.runId), ["fix-named"]);
  assert.deepEqual([named.grouping.pending, named.grouping.unassigned, named.ungroupedRunIds], [0, 1, ["named"]]);
  const contradictory = await f.service.read({ project: "~", scopeId: namedScope, windowDays: 7 });
  assert.deepEqual(contradictory.fixes, []);
  assert.deepEqual([contradictory.grouping.pending, contradictory.grouping.unassigned, contradictory.ungroupedRunIds], [0, 0, []]);
  const repository = await f.service.read({ scopeId: missingScope, windowDays: 7 });
  assert.deepEqual(repository.fixes.map(row => row.runId), ["fix-missing"]);
  assert.deepEqual([repository.grouping.pending, repository.grouping.unassigned], [1, 1]);
});

test("applying the identical instruction after Undo records a new current fix", { skip }, async t => {
  const f = await fixture(t), scopeId = "c".repeat(64);
  f.record("source", scopeId, { reason: "awaiting-input" });
  const groups = makeQuestionGroupStore({ redis: f.redis, now: f.now, retentionDays: 365 });
  await groups.capture({ runId: "source", scopeId, text: "Which package manager should this repository use?", redact: value => value, triggerIndex: 0 });
  const meta = await groups.readMeta("source");
  const assigned = await groups.assign({ runId: "source", digest: meta.digest, revision: 0 });
  assert.equal(assigned.status, "assigned");
  const params = { runId: "source", groupId: assigned.groupId, index: 0, sentence: "Use pnpm in this repository." };
  const entryOf = (plan, params) => ({ expect: plan.expect, afterDigest: hash(plan.afterText), ticketDigest: hash(randomUUID()), payload: { params } });
  const firstPlan = (await f.service.preview("zero-touch-instruction", params)).plan;
  const first = await f.service.apply("zero-touch-instruction", entryOf(firstPlan, params));
  assert.equal(first.ok, true);
  f.advance();
  const undoParams = { fixId: first.fixId }, undo = (await f.service.preview("zero-touch-undo", undoParams)).plan;
  assert.equal((await f.service.apply("zero-touch-undo", entryOf(undo, undoParams))).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(f.paths.triggersPath)).triggers[0].run.instructions, undefined);
  f.advance();
  const repeatedPlan = (await f.service.preview("zero-touch-instruction", params)).plan;
  assert.equal(hash(repeatedPlan.afterText), hash(firstPlan.afterText), "the repeated edit really has the same output digest");
  const second = await f.service.apply("zero-touch-instruction", entryOf(repeatedPlan, params));
  assert.equal(second.ok, true);
  assert.notEqual(second.fixId, first.fixId, "a later human confirmation has a new fix identity");
  const fixes = await makeZeroTouchFixStore({ redis: f.redis, now: f.now, retentionDays: 365 }).publicSnapshot();
  assert.equal(fixes.fixes.length, 2);
  assert.ok(fixes.fixes.find(row => row.id === first.fixId).undoneAt);
  assert.equal(fixes.fixes.find(row => row.id === second.fixId).undoneAt, undefined);
  assert.equal((await f.service.read()).groups.find(row => row.id === assigned.groupId).status, "fixed");
  assert.equal(JSON.parse(fs.readFileSync(f.paths.triggersPath)).triggers[0].run.instructions, params.sentence);
});
