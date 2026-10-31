import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const module = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
function tool() {
  const registered = [];
  module.default(new Proxy({}, { get: (_target, key) => key === "registerTool" ? (entry) => registered.push(entry) : () => {} }));
  return registered.find((entry) => entry.name === "dispatch_set");
}

test("actual tool registration captures an exact process grant for its session and never rereads a later value", async () => {
  const keys = ["PI_DISPATCH_AGENT_WRITES", "PI_SETTINGS_FILE", "PI_LOGS_DIR"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = tempDir("pd-766-index-grant-");
  const settings = join(dir, "settings.json");
  process.env.PI_SETTINGS_FILE = settings; process.env.PI_LOGS_DIR = dir;
  try {
    for (const grant of [undefined, "0", "true", " 1"]) {
      writeFileSync(settings, '{"dailyCap":10}');
      if (grant === undefined) delete process.env.PI_DISPATCH_AGENT_WRITES; else process.env.PI_DISPATCH_AGENT_WRITES = grant;
      const registered = tool();
      process.env.PI_DISPATCH_AGENT_WRITES = "1";
      await assert.rejects(registered.execute("call", { key: "dailyCap", value: "5", PI_DISPATCH_AGENT_WRITES: "1" }, null, null, { hasUI: false }), /pi process's own environment/);
      assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { dailyCap: 10 });
    }
    process.env.PI_DISPATCH_AGENT_WRITES = "1";
    const granted = tool();
    delete process.env.PI_DISPATCH_AGENT_WRITES;
    const result = await granted.execute("call", { key: "dailyCap", value: "5" }, null, null, { hasUI: false });
    assert.equal(JSON.parse(result.content[0].text).applied, true);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { dailyCap: 5 });
    await assert.rejects(granted.execute("call", { key: "dailyCap", value: "20" }, null, null, { hasUI: false }), /is confirm:/);
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { dailyCap: 5 }, "a captured grant still cannot widen the boundary");
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
