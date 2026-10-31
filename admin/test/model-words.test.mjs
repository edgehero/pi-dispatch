import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_WHY, PROVIDER_FAILURE_KINDS } from "@edgehero/pi-dispatch/model-failover-protocol";
import { modelChoiceSentence, providerFailureSentence, providerFailureWords } from "../src/model-words.mjs";
import { runSummary } from "../src/console/panels/run.mjs";
import { html } from "../src/console/html.mjs";

const base = { provider: "anthropic", model: "claude-sonnet-5-5", modelRole: "editor" };
test("every selection reason says which physical model ran and why, without inventing the primary identity", () => {
  const reasons = {
    primary: "as its primary model",
    "fallback-cooldown": "primary model was cooling down",
    "fallback-window": "primary model's dollar window had no room",
    "fallback-unavailable": "an earlier candidate was unavailable",
    "fallback-context": "needed a larger context window",
  };
  assert.deepEqual(Object.keys(reasons), [...MODEL_WHY]);
  for (const [modelWhy, reason] of Object.entries(reasons)) {
    const sentence = modelChoiceSentence({ ...base, modelWhy });
    assert.ok(sentence.includes("anthropic/claude-sonnet-5-5"));
    assert.ok(sentence.includes("for role editor"));
    assert.ok(sentence.includes(reason));
    assert.equal(sentence.includes("used fallback"), modelWhy !== "primary");
  }
  assert.equal(modelChoiceSentence({ ...base, modelWhy: "PRIVATE_UNKNOWN_REASON" }), null);
  assert.equal(modelChoiceSentence({ ...base, modelWhy: "primary", model: "<private>" }), null);
  assert.ok(!modelChoiceSentence({ ...base, modelWhy: "primary", modelRole: "<private>" }).includes("private"));
});

test("provider failure words cover the source vocabulary and ignore response prose", () => {
  for (const kind of PROVIDER_FAILURE_KINDS) {
    assert.ok(providerFailureWords(kind));
    const sentence = providerFailureSentence({ kind, resetAt: 123, body: "PRIVATE_PROVIDER_BODY" });
    assert.ok(sentence.endsWith("."));
    assert.ok(!sentence.includes("PRIVATE"));
  }
  assert.match(providerFailureSentence({ kind: "rate-limited" }), /rate limited/);
  assert.match(providerFailureSentence({ kind: "quota-exhausted" }), /quota/);
  assert.match(providerFailureSentence({ kind: "overloaded" }), /overloaded/);
  assert.match(providerFailureSentence({ kind: "context-overflow" }), /context window/);
  for (const value of [{ kind: "raw_failure" }, { kind: "overloaded", resetAt: -1 }, null]) assert.equal(providerFailureSentence(value), null);
  assert.equal(providerFailureWords("constructor"), null);
});

test("the actual Run record panel uses the shared model and provider sentences", () => {
  const record = { ...base, jobId: "canary-773", modelWhy: "fallback-window", providerFailure: { kind: "rate-limited", resetAt: 1_800_000_000_000 }, outcome: "failed" };
  const rendered = String(runSummary({ role: "operator", data: { run: { record } }, query: { id: record.jobId }, env: {} }));
  assert.ok(rendered.includes(String(html`${modelChoiceSentence(record)}`)));
  assert.ok(rendered.includes(providerFailureSentence(record.providerFailure)));
  assert.ok(!rendered.includes(">fallback-window<"));
  assert.ok(!rendered.includes(">rate-limited<"));
  assert.ok(rendered.includes("Provider reset"));
});
