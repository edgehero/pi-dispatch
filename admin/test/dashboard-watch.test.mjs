import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "../src/style.mjs";
const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = require("jiti");
const { makeDashboard } = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the watch panel lists public findings, has a visible entry hint, and returns with Escape", async () => {
  const PRIVATE = "private-sample-never-in-panel";
  const component = makeDashboard({ deps: {
    now: () => 100, fetchSnapshot: async () => ({ triggers: { triggers: [{ type: "watch", id: "shop", source: "alerts", flow: "triage" }] }, runs: [], schedulers: [] }), dispose: async () => {},
    watch: { listRules: async () => [{ id: "shop", source: "alerts", summary: { suppressed: "24", capped: "2" } }], listFindings: async () => [{ fingerprint: "abc123", count: 37, status: "capped", samples: [PRIVATE] }] },
  }, intervalMs: 100000 });
  try {
    await flush();
    assert.match(component.render(100).map(stripAnsi).join("\n"), /z watch findings/);
    component.handleInput("z");
    await flush();
    const output = component.render(100).map(stripAnsi).join("\n");
    assert.match(output, /37 events, capped/);
    assert.match(output, /24 suppressed, 2 capped/);
    assert.ok(!output.includes(PRIVATE));
    component.handleInput("\u001b");
    assert.match(component.render(100).map(stripAnsi).join("\n"), /z watch findings/);
  } finally { await component.dispose(); }
});

test("the watch panel explicitly reports a failed read", async () => {
  const component = makeDashboard({ deps: { now: () => 100, fetchSnapshot: async () => ({}), dispose: async () => {}, watch: { listRules() { throw Error("private server detail"); } } }, intervalMs: 100000 });
  try {
    component.handleInput("z"); await flush();
    const output = component.render(100).map(stripAnsi).join("\n");
    assert.match(output, /could not be read/);
    assert.ok(!output.includes("private server detail"));
  } finally { await component.dispose(); }
});
