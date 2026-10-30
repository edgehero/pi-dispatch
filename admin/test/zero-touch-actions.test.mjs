import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tempDir } from "./helpers/temp-dir.mjs";
import { planZeroTouchName, planZeroTouchGroup, planZeroTouchInstruction, planZeroTouchInstructionUndo, applyZeroTouchFilePlan } from "../src/zero-touch-actions.mjs";
import { checkTriggerFixSource } from "../src/job-actions.mjs";
const config = { capture: true, model: "test/classifier", maxCostUsd: "0.05", names: {} };
const groupId = "a".repeat(32), scopeId = "b".repeat(64);
function fixture() {
  const paths = { triggersPath: join(tempDir("zt-action-"), "triggers.json") };
  const doc = { triggers: [{ on: { type: "label", any: ["fix"] }, run: { kind: "github", flow: "fix" } }], zeroTouch: config, untouched: { key: true } };
  writeFileSync(paths.triggersPath, JSON.stringify(doc));
  const sourceRecord = { jobId: "source", touchScopeId: scopeId, kind: "github", triggerIndex: 0, outcome: "completed", reason: "awaiting-input" };
  const group = { id: groupId, scopeId, runIds: ["source"] };
  const binding = { ok: true, runId: "source", index: 0, triggerDigest: createHash("sha256").update(JSON.stringify(doc.triggers[0])).digest("hex") };
  return { paths, doc, sourceRecord, group, binding };
}
test("operator group name write preserves all unrelated fields and is refused after a concurrent edit", () => {
  const { paths } = fixture();
  const built = planZeroTouchName({ params: { groupId, name: "Package manager" }, paths });
  assert.ok(built.plan);
  assert.equal(applyZeroTouchFilePlan({ plan: built.plan, paths }).ok, true);
  const written = JSON.parse(readFileSync(paths.triggersPath));
  assert.equal(written.zeroTouch.names[groupId], "Package manager");
  assert.deepEqual(written.untouched, { key: true });
  const stale = planZeroTouchName({ params: { groupId, name: "Changed" }, paths });
  writeFileSync(paths.triggersPath, JSON.stringify({ ...written, unrelated: 1 }));
  assert.match(applyZeroTouchFilePlan({ plan: stale.plan, paths }).invalid, /changed/);
  assert.equal(JSON.parse(readFileSync(paths.triggersPath)).zeroTouch.names[groupId], "Package manager");
});
test("instruction preview writes the exact sentence and safe Undo restores absence", () => {
  const { paths, sourceRecord, group, binding } = fixture();
  const params = { runId: "source", groupId, index: 0, sentence: "Use pnpm in this repository." };
  const { plan } = planZeroTouchInstruction({ params, paths, sourceRecord, group, binding });
  assert.ok(plan);
  assert.equal(JSON.parse(plan.afterText).triggers[0].run.instructions, params.sentence);
  assert.equal(applyZeroTouchFilePlan({ plan, paths }).ok, true);
  const fix = { id: groupId, kind: "instructions", undo: plan.privateUndo };
  const undo = planZeroTouchInstructionUndo({ params: { fixId: groupId }, paths, fix });
  assert.ok(undo.plan);
  assert.equal(applyZeroTouchFilePlan({ plan: undo.plan, paths }).ok, true);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths.triggersPath)).triggers[0].run, "instructions"), false);
});
test("a replacement trigger with the same instruction sentence is not an Undo target", () => {
  const { paths, sourceRecord, group, binding } = fixture();
  const { plan } = planZeroTouchInstruction({ params: { runId: "source", groupId, index: 0, sentence: "Use pnpm." }, paths, sourceRecord, group, binding });
  applyZeroTouchFilePlan({ plan, paths });
  const doc = JSON.parse(readFileSync(paths.triggersPath)); doc.triggers[0].on.any = ["different"];
  writeFileSync(paths.triggersPath, JSON.stringify(doc));
  assert.match(planZeroTouchInstructionUndo({ params: { fixId: groupId }, paths, fix: { id: groupId, kind: "instructions", undo: plan.privateUndo } }).refusal, /changed/);
});
test("instructions are console-only, bounded and require matching source lineage", () => {
  const { paths, sourceRecord, group, binding } = fixture();
  const args = { params: { runId: "source", groupId, index: 0, sentence: "Use pnpm." }, paths, sourceRecord, group, binding };
  assert.match(planZeroTouchInstruction({ ...args, surface: "tool" }).refusal, /only.*console/);
  assert.match(planZeroTouchInstruction({ ...args, params: { ...args.params, sentence: "x".repeat(2001) } }).refusal, /2,000/);
  assert.match(planZeroTouchInstruction({ ...args, sourceRecord: { ...sourceRecord, triggerIndex: 1 } }).refusal, /does not identify/);
  assert.match(planZeroTouchInstruction({ ...args, group: { ...group, scopeId: "c".repeat(64) } }).refusal, /explicit source/);
  assert.equal(JSON.parse(readFileSync(paths.triggersPath)).triggers[0].run.instructions, undefined);
  assert.match(planZeroTouchInstruction({ ...args, binding: null }).refusal, /identity is unavailable/);
});
test("a cron cause does not gain an ignored instructions field", () => {
  const { paths, sourceRecord } = fixture();
  const doc = { triggers: [{ on: { type: "cron", id: "daily", pattern: "0 0 * * *" }, run: { kind: "local", folder: "/repo", flow: "fix", task: "Check" } }] };
  writeFileSync(paths.triggersPath, JSON.stringify(doc));
  const out = planZeroTouchInstruction({ params: { runId: "source", index: 0, sentence: "Use pnpm." }, paths, sourceRecord: { ...sourceRecord, kind: "local", outcome: "policy", reason: "secret-unresolved" } });
  assert.match(out.refusal, /cron instructions belong in its task/);
});
test("grouping plan refuses absent capture, invalid source and tool calls; preview names actual model and cap", () => {
  const args = { params: { runId: "source" }, config, meta: { runId: "source", status: "unassigned", digest: "a".repeat(64) } };
  assert.match(planZeroTouchGroup({ ...args, surface: "tool" }).refusal, /only/);
  assert.match(planZeroTouchGroup({ ...args, config: { ...config, capture: false } }).refusal, /not enabled/);
  assert.match(planZeroTouchGroup({ ...args, meta: { ...args.meta, status: "source-expired" } }).refusal, /no available/);
  const { plan } = planZeroTouchGroup(args);
  assert.equal(plan.model, "test/classifier"); assert.equal(plan.maxCostUsd, "0.05");
  for (const status of ["failed", "stale", "refused"]) assert.ok(planZeroTouchGroup({ ...args, meta: { ...args.meta, status } }).plan, status);
  assert.match(planZeroTouchGroup({ ...args, meta: { ...args.meta, status: "pending" } }).plan.summary.join(" "), /pay for another classification/);
});

test("source identity checks retained trigger type, label and flow before accepting a same-kind array position", async () => {
  const { paths, doc, sourceRecord, group } = fixture();
  const data = { kind: "github", flow: "fix", target: { type: "issue", number: 1 }, trigger: { matched: { index: 0, type: "label", label: "fix" } } };
  const args = { jobId: "source", index: 0, triggersPath: paths.triggersPath, readRetainedJob: async () => data };
  const good = await checkTriggerFixSource(args);
  assert.equal(good.ok, true);
  const params = { runId: "source", groupId, index: 0, sentence: "Use pnpm." };
  assert.ok(planZeroTouchInstruction({ params, paths, sourceRecord, group, binding: good }).plan);
  for (const replacement of [
    { ...doc.triggers[0], on: { type: "label", any: ["another-label"] } },
    { ...doc.triggers[0], run: { kind: "github", flow: "another-flow" } },
    { ...doc.triggers[0], on: { type: "comment", phrase: "@pi" } },
  ]) {
    writeFileSync(paths.triggersPath, JSON.stringify({ ...doc, triggers: [replacement] }));
    assert.match((await checkTriggerFixSource(args)).refusal, /changed or moved/);
    assert.match(planZeroTouchInstruction({ params, paths, sourceRecord, group, binding: good }).refusal, /identity is unavailable or changed/);
  }
  assert.match((await checkTriggerFixSource({ ...args, readRetainedJob: async () => null })).refusal, /no longer holds/);
});
