import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionsEvidenceProblems } from "../../.github/scripts/console-connections-browser.mjs";

const evidence = () => ({
  canvas: "#000000", fonts: "loaded", font: "system-ui", css: true, cardRadius: 12, width: 390, csp: [],
  forges: "", notify: "", endpoints: "One server, one id", problems: "check the webhook secret on both sides",
  unauthorized: "2", receiverPort: "3000", receiverTimes: 2,
  links: ["/fleet/host?name=mini1", "/run?id=gh-timeout-775"],
  hookCounts: { exit: 1, timeout: 1 }, hookAttention: ["timeout"], hookTimes: 1,
  hostSlots: { "local-model:mini1": "1 of 2", "shared-model:mini2": "2 of 3", "shared-model:build3": "1 of 4" }, localScope: true,
});
const options = { slice: "all", width: 390, theme: "dark", receiverPort: 3000 };

test("the browser oracle judges observed values, navigation and exception classification", () => {
  assert.deepEqual(connectionsEvidenceProblems(evidence(), options), []);
  for (const [field, wrong, message] of [
    ["unauthorized", "0", "actual unauthorized count"], ["receiverPort", "4000", "actual listening port"],
    ["hookCounts", { exit: 2, timeout: 0 }, "Retained hook detail counts"], ["hookAttention", [], "timeout lost"],
    ["hostSlots", { "local-model:mini1": "0 of 2", "shared-model:mini2": "2 of 3", "shared-model:build3": "0 of 4" }, "host usage"],
    ["links", [], "link is wrong"], ["localScope", false, "claims a fleet bound"],
  ]) assert.ok(connectionsEvidenceProblems({ ...evidence(), [field]: wrong }, options).some(problem => problem.includes(message)), field);
});

test("the browser oracle refuses missing shared styles and facts after metadata deletion", () => {
  for (const change of [{ css: false }, { canvas: "white" }, { font: "Times New Roman" }, { width: 1000 }, { csp: ["script-src:inline"] }]) {
    assert.ok(connectionsEvidenceProblems({ ...evidence(), ...change }, options).length > 0);
  }
  const removed = { ...evidence(), forges: "No live receiver", notify: "no hook run published", endpoints: "host occupancy not reported" };
  assert.deepEqual(connectionsEvidenceProblems(removed, { ...options, absent: true }), []);
  for (const slice of ["receiver", "hooks", "endpoints"]) assert.ok(connectionsEvidenceProblems(evidence(), { ...options, slice, absent: true }).length > 0, slice);
});
