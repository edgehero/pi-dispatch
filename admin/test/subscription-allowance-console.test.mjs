import { test } from "node:test";
import assert from "node:assert/strict";
import { runFieldsLines } from "../src/console/actions.mjs";
import { triggerGetsOf } from "../src/trigger-gets-view.mjs";
import { readTriggers } from "../src/read-model.mjs";
import { GETS_ENTRY, TRIGGER_GETS_PATH, fileOnlyFs, triggerGetsPage } from "./helpers/trigger-gets-goldens.mjs";

// Issue #1008: what the console shows of a trigger's subscription allowance (`run.maxSubscriptionUsd`), and only where
// one is set, so every other preview and card reads as it did.

test("a re-run's preview names the subscription allowance only when the job carries one", () => {
  assert.match(runFieldsLines({ flow: "fix", maxCostUsd: "1.5", maxSubscriptionUsd: "12.50" }, "It runs")[0], /per-job cap \$1\.5; subscription allowance \$12\.50 at list price/);
  for (const maxSubscriptionUsd of [undefined, null]) assert.doesNotMatch(runFieldsLines({ flow: "fix", maxSubscriptionUsd }, "It runs")[0], /subscription allowance/);
});

test("the card's model row carries the allowance as written for its form, and its read line names it only when set", () => {
  const set = triggerGetsOf({ trigger: { index: 1, type: "comment", flow: "fix", maxSubscriptionUsd: "12.50" } }).model;
  assert.equal(set.allowance, "12.50");
  assert.match(set.read, /\$12\.50 subscription allowance$/);
  const none = triggerGetsOf({ trigger: { index: 1, type: "comment", flow: "fix" } }).model;
  assert.equal(none.allowance, "");
  assert.doesNotMatch(none.read, /subscription allowance/);
});

test("the trigger's page shows the allowance its file sets, read through the real reader: the form's value for an operator, the read line for a viewer", async () => {
  const entry = { ...GETS_ENTRY, run: { ...GETS_ENTRY.run, maxSubscriptionUsd: "12.50" } };
  const text = `${JSON.stringify({ version: 11, triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "triage" } }, { on: { type: "label", any: ["frontend"] }, run: { kind: "github", flow: "frontend-fix" } }, entry] }, null, 2)}\n`;
  const read = readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs: fileOnlyFs(text) });
  assert.equal(read.doesNotLoad, undefined, "the premise: the worker's loader takes this file");
  assert.equal(read.triggers.find((row) => row.index === 2).maxSubscriptionUsd, "12.50", "the display projection carries it as written");
  const operator = await triggerGetsPage({ entry, text });
  assert.match(operator, /<input id="te-allowance" class="input" name="maxSubscriptionUsd" type="text" value="12\.50"/);
  const viewer = await triggerGetsPage({ entry, text, role: "viewer" });
  assert.doesNotMatch(viewer, /name="maxSubscriptionUsd"/, "a viewer has no form");
  assert.match(viewer, /\$12\.50 subscription allowance/);
});
