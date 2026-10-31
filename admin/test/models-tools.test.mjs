import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readModelsTool } from "../src/models-tools.mjs";
import { modelsViewOf } from "../src/models-view.mjs";

const NOW = Date.UTC(2026, 9, 31, 12);
const PRIVATE = "PRIVATE_MODEL_OPERATOR_PROSE";
const primary = "anthropic/claude-sonnet-5-5", candidate = "openai/gpt-4o";
function view() {
  const source = { jobId: "gh-source", provider: "anthropic", model: "claude-sonnet-5-5", modelRole: "editor", flow: "fix", outcome: "completed", endedAt: new Date(NOW - 60000).toISOString(), turns: 8, tokens: { metered: true, cost: 0.24, total: 120000 } };
  const replay = { ...source, jobId: "canary-773", provider: "openai", model: "gpt-4o", turns: 10, tokens: { metered: true, cost: 0.06, total: 140000 }, canary: { sourceJobId: source.jobId, role: "editor", candidate }, endedAt: new Date(NOW - 30000).toISOString() };
  const value = modelsViewOf({ now: NOW, entries: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", model: "role:editor", flow: "fix" } }], modelRoles: { default: { editor: { model: primary, fallbackModels: [candidate] } } }, deployment: { provider: "anthropic", model: "claude-sonnet-5-5" }, records: [source, replay], cooldowns: [{ ref: primary, kind: "rate-limited", until: NOW + 10000 }], windows: [{ ledger: "model", name: primary, window: "week", capMicros: 80000000, counterMicros: 32460000 }], snapshot: { doctor: { hosts: [{ name: "host1", at: NOW, ageMs: 0, checks: [{ id: "models.1", level: "ok", label: PRIVATE, proposal: { kind: "newer-sibling", scope: "default", role: "editor", model: primary, candidate } }] }] }, waiting: { rows: [] } } });
  value.command = PRIVATE; value.path = `/private/${PRIVATE}`; value.diff = PRIVATE;
  return value;
}
function reads(value = view()) {
  const calls = [];
  return { calls, fleet(paths, options) {
    calls.push({ paths, options });
    return { snapshot: async options => { calls.push(options); return {}; }, dispose: async () => calls.push("disposed") };
  }, models: async options => { calls.push(options); return value; } };
}

test("the Models tool retains safe candidate, lineage, cooldown and window facts but removes operator context", async () => {
  const io = reads();
  const result = await readModelsTool({ paths: {}, env: {}, now: () => NOW, reads: io });
  assert.equal(io.calls[0].options.readOnly, true);
  assert.deepEqual(io.calls[1], { waiting: true });
  assert.equal(io.calls.at(-1), "disposed");
  assert.equal(result.roles[0].model, primary);
  assert.equal(result.proposals[0].candidate, candidate);
  assert.equal(result.canaries[0].candidateStats.costPerRun, 0.06);
  assert.equal(result.canaries[0].sourceStats.averageTokens, 120000);
  assert.equal(result.canaries[0].rows[0].sourceJobId, "gh-source");
  assert.equal(result.cooldowns[0].until, NOW + 10000);
  assert.equal(result.models.find(row => row.ref === primary).windows[0].spentMicros, 32460000);
  assert.ok(!JSON.stringify(result).includes(PRIVATE));
});

test("a failed Models observation closes its one-shot fleet reader", async () => {
  const io = reads(); io.models = async () => { throw Error(PRIVATE); };
  await assert.rejects(readModelsTool({ paths: {}, now: () => NOW, reads: io }), /PRIVATE_MODEL/);
  assert.equal(io.calls.at(-1), "disposed");
});

test("the registered dispatch_models preserves its typed read and has no role mutation tool", async () => {
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = piRequire("jiti");
  const module = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  const entries = [];
  module.default(new Proxy({}, { get: (_target, key) => key === "registerTool" ? entry => entries.push(entry) : () => {} }));
  const tool = entries.find(entry => entry.name === "dispatch_models");
  assert.ok(tool);
  assert.ok(!entries.some(entry => /model.*(?:edit|adopt)|(?:edit|adopt).*model/.test(entry.name)));
  try {
    module.setModelsToolReadsForTest(reads());
    const result = JSON.parse((await tool.execute("call", {}, null, null, { hasUI: false })).content[0].text);
    assert.equal(result.canaries[0].candidateStats.averageTurns, 10);
    assert.equal(result.proposals[0].candidate, candidate);
    assert.ok(!JSON.stringify(result).includes(PRIVATE));
    module.setModelsToolReadsForTest({ ...reads(), models: async () => { throw Object.assign(Error(PRIVATE), { safe: true, publicMessage: PRIVATE }); } });
    await assert.rejects(tool.execute("call", {}, null, null, { hasUI: false }), error => !error.message.includes(PRIVATE) && /unavailable|could not/i.test(error.message));
  } finally { module.setModelsToolReadsForTest({}); }
});
