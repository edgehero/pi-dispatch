import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { OPERATOR_ONLY_KEYS } from "@edgehero/pi-dispatch/runtime-settings";
import { TOOL_ACTIONS } from "../src/tool-actions.mjs";
import { actionAgentPolicy } from "../src/action-policy.mjs";

const skill = readFileSync(new URL("../skills/operate-pi-dispatch/SKILL.md", import.meta.url), "utf8");
test("the shipped skill accounts for every registered read/write tool and no unavailable tool", async () => {
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = piRequire("jiti");
  const module = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  const registered = new Set();
  module.default(new Proxy({}, { get: (_target, key) => key === "registerTool" ? (tool) => registered.add(tool.name) : () => {} }));
  const described = new Set(skill.match(/dispatch_[a-z_]+/g));
  assert.ok(registered.size > 0);
  assert.deepEqual([...described].sort(), [...registered].sort());
  for (const [tool, action] of Object.entries(TOOL_ACTIONS)) assert.ok(actionAgentPolicy(action).tools.includes(tool), `${tool} uses the declared action policy`);
});
test("the skill names every operator-only settings family and actual tool-proof field", () => {
  for (const key of OPERATOR_ONLY_KEYS) assert.ok(skill.includes(`\`${key}\``), key);
  const plans = readFileSync(new URL("../src/write-plans.mjs", import.meta.url), "utf8");
  const fields = /const TOOL_PROOF_FIELDS = new Set\(\[([^]*?)\]\)/.exec(plans)[1];
  for (const [, key] of fields.matchAll(/"([^"]+)"/g)) assert.ok(skill.includes(`\`${key}\``), key);
});
