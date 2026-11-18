import assert from "node:assert/strict";
import { test } from "node:test";
import { wideningFieldRefusal } from "../src/write-plans.mjs";
import { diffHtmlOf } from "../src/console/confirm-view.mjs";
import { modelRunRecord, normalizeTriggerForDisplay } from "../src/read-model.mjs";
import { agentReadProjection } from "../src/agent-read.mjs";

test("tools cannot grant file secrets under any supported near miss or nesting", () => {
  for (const key of ["secretFiles", "secretFile", "secret_files", "SecretFiles", "secret-files", "secretf\u0456les"]) {
    for (const params of [{ [key]: { KEY: "reference-canary" } }, { run: { [key]: {} } }, { opaque: [{ [key]: false }] }]) {
      const refusal = wideningFieldRefusal(params, "dispatch_trigger_add");
      assert.match(refusal, /cannot set run.secretFiles/);
      assert.doesNotMatch(refusal, /reference-canary/);
    }
  }
});

test("file-only trigger display counts its grants without exposing references, and confirmation diffs hide them", () => {
  const entry = { on: { type: "label", any: ["test"] }, run: { kind: "github", flow: "test", secretFiles: { DEVICE_KEY: "reference-canary" } } };
  const display = normalizeTriggerForDisplay(entry);
  assert.equal(display.secrets, 1);
  assert.equal(display.secretFiles, 1);
  assert.doesNotMatch(JSON.stringify(display), /reference-canary|DEVICE_KEY/);
  const shown = diffHtmlOf(JSON.stringify({ triggers: [] }), JSON.stringify({ version: 8, triggers: [entry] }));
  assert.doesNotMatch(String(shown), /reference-canary/);
  assert.match(String(shown), /DEVICE_KEY/);
  assert.match(String(shown), /secret reference, not shown/);
});

test("run tools and agent console reads expose delivered file counts without their names", () => {
  const record = { jobId: "gh-test", outcome: "completed", secretFiles: ["CANARY_DEVICE_KEY", "CANARY_DEVICE_CERT"] };
  const expected = { jobId: "gh-test", outcome: "completed", secretFiles: 2 };
  assert.deepEqual(modelRunRecord(record), expected);
  assert.deepEqual(modelRunRecord(record, { list: true }), expected);
  assert.deepEqual(agentReadProjection(record), expected);
  assert.deepEqual(agentReadProjection({ runs: [record] }), { runs: [expected] });
  assert.deepEqual(agentReadProjection(modelRunRecord(record)), expected);
  assert.doesNotMatch(JSON.stringify([modelRunRecord(record), agentReadProjection(record)]), /CANARY_DEVICE/);
  assert.equal(Object.hasOwn(modelRunRecord({ ...record, v: 2 }), "secretFiles"), false, "newer records stay at their stable core");
  const old = { jobId: "gh-old", outcome: "completed" };
  assert.equal(modelRunRecord(old), old, "records without file delivery preserve their old shape");
  for (const malformed of [{ name: "CANARY_REF", DEVICE_KEY: "CANARY_REF" }, ["/run/secrets/DEVICE_KEY"], ["CON"], ["KEY", "key"], Array(1), 81, -1, true]) {
    const got = { ...old, secretFiles: malformed };
    assert.equal(Object.hasOwn(modelRunRecord(got), "secretFiles"), false);
    assert.equal(Object.hasOwn(agentReadProjection(got), "secretFiles"), false);
  }
});
