import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { MODEL_TOOL_READ_UNAVAILABLE } from "../src/tool-refusals.mjs";
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const module = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
function tool(name) {
  const registered = [];
  module.default(new Proxy({}, { get: (_target, key) => key === "registerTool" ? (entry) => registered.push(entry) : () => {} }));
  return registered.find((entry) => entry.name === name);
}
const PRIVATE = "PRIVATE_OPERATOR_RETENTION_CANARY";
async function fixedFailure(run) {
  await assert.rejects(run, (error) => {
    assert.equal(error.message, MODEL_TOOL_READ_UNAVAILABLE);
    assert.ok(!error.message.includes(PRIVATE));
    return true;
  });
}

test("actual registered capacity read keeps malformed private retention configuration out of model errors", async () => {
  const keys = ["PI_LOG_RETENTION_DAYS", "VALKEY_URL", "PI_LOGS_DIR"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const logs = tempDir("pd-766-private-read-");
  Object.assign(process.env, { PI_LOG_RETENTION_DAYS: PRIVATE, VALKEY_URL: "not-a-url", PI_LOGS_DIR: logs });
  try {
    const read = tool("dispatch_capacity");
    const local = [];
    await fixedFailure(() => read.execute("call", {}, null, null, { hasUI: true, ui: { notify: (message) => local.push(String(message)) } }));
    assert.equal(local.length, 1);
    assert.ok(local[0].includes(PRIVATE), "the local operator retains the real configuration diagnosis");
    await fixedFailure(() => read.execute("call", {}, null, null, { hasUI: false }));
    await fixedFailure(() => read.execute("call", {}, null, null, { hasUI: true, get ui() { throw Error("/private/secondary-read-diagnosis"); } }));
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("typed operational reads also reject forged public error properties and throwing message getters", async () => {
  const failures = [Object.assign(new Error(PRIVATE), { safe: true, public: true, publicMessage: PRIVATE, modelMessage: PRIVATE }), { message: PRIVATE, public: true }, Object.defineProperty(new Error(), "message", { get() { throw Error(PRIVATE); } })];
  try {
    for (const failure of failures) {
      module.setToolReadDepsForTest({ failed: async () => { throw failure; } });
      const read = tool("dispatch_failed");
      await fixedFailure(() => read.execute("call", {}, null, null, { hasUI: true, ui: { notify() {} } }));
    }
  } finally { module.setToolReadDepsForTest({}); }
});

test("the registered allocations read withholds a private infrastructure exception", async () => {
  const keys = ["PI_PROJECTS_FILE", "PI_ENVELOPE_FILE", "PI_SETTINGS_FILE", "VALKEY_URL"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = tempDir("pd-766-private-alloc-read-");
  const projects = join(dir, "projects.json"), envelope = join(dir, "envelope.json"), settings = join(dir, "settings.json");
  writeFileSync(projects, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }] }));
  writeFileSync(envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "10", floorsUsd: { web: "0", _other: "0" }, defaultWeights: { web: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }));
  writeFileSync(settings, '{"maxCostUsd":"1"}');
  Object.assign(process.env, { PI_PROJECTS_FILE: projects, PI_ENVELOPE_FILE: envelope, PI_SETTINGS_FILE: settings, VALKEY_URL: "redis://unit.invalid" });
  module._setAllocationSeamsForTests({ redisFn: () => { throw Object.assign(new Error(PRIVATE), { publicMessage: PRIVATE, safe: true }); }, now: () => new Date(Date.UTC(2026, 9, 31)) });
  try {
    const local = [];
    await fixedFailure(() => tool("dispatch_allocations").execute("call", {}, null, null, { hasUI: true, ui: { notify: (message) => local.push(String(message)) } }));
    assert.equal(local.length, 1);
    assert.ok(local[0].includes(PRIVATE));
  } finally {
    module._setAllocationSeamsForTests({});
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
