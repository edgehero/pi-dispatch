import assert from "node:assert/strict";
import { test } from "node:test";
import { wideningFieldRefusal } from "../src/write-plans.mjs";
import { modelRunRecord } from "../src/read-model.mjs";
import { safeRunOf } from "../src/console/run-api.mjs";
import { runSummary } from "../src/console/panels/run.mjs";

test("model-callable edits refuse role maps at any nesting or near-miss spelling", () => {
  for (const params of [{ modelRoles: {} }, { "ｍodelRoles": {} }, { run: { "modelRοles": {} } }, { run: { Model_Roles: {} } }, { unrelated: [{ deep: { "model-roles": {} } }] }]) {
    assert.match(wideningFieldRefusal(params, "dispatch_trigger_edit"), /cannot set modelRoles/);
  }
  assert.equal(wideningFieldRefusal({ flow: "fix" }, "dispatch_trigger_edit"), null);
});

test("run surfaces expose validated role and physical model with hashed refusal telemetry", () => {
  const record = { jobId: "gh-717", provider: "anthropic", model: "physical", modelRole: "editor", modelRoles: { refusals: [{ agentHash: "a".repeat(64), reason: "unknown-role" }] }, outcome: "completed" };
  const visible = modelRunRecord(record);
  assert.equal(visible.modelRole, "editor");
  assert.equal(visible.model, "physical");
  assert.deepEqual(visible.modelRoles, record.modelRoles);
  const api = safeRunOf("gh-717", record);
  assert.equal(api.modelRole, "editor");
  assert.equal(api.model, "physical");
  assert.deepEqual(api.modelRoles, record.modelRoles);
  const rendered = String(runSummary({ role: "operator", data: { run: { record } }, query: { id: record.jobId }, env: {} }));
  assert.match(rendered, /Model role/);
  assert.match(rendered, /editor/);
  assert.match(rendered, /physical/);
  assert.match(rendered, /Agent refusals/);
  const invalid = { ...record, modelRole: "<private-name>", modelRoles: { refusals: [{ agentHash: "raw-private-name", reason: "unknown-role" }] } };
  for (const result of [modelRunRecord(invalid), safeRunOf("gh-717", invalid)]) {
    assert.equal(result.modelRole, undefined);
    assert.equal(result.modelRoles, undefined);
  }
});
