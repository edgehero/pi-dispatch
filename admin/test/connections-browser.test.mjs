import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionsEvidenceProblems, receiverIdentityProblems } from "../../.github/scripts/console-connections-browser.mjs";

test("the receiver identity oracle rejects clipped characters even when the complete page fits", () => {
  const name = "W".repeat(64);
  const options = { name, width: 390 };
  const good = { text: name, href: `/fleet/host?name=${name}`, pageWidth: 390,
    header: { left: 0, right: 300, top: 0, bottom: 80 }, clip: { left: 0, right: 390, top: 0, bottom: 1000 },
    characters: Array.from({ length: 64 }, (_, i) => ({ left: i % 20 * 12, right: i % 20 * 12 + 12, top: Math.floor(i / 20) * 20, bottom: Math.floor(i / 20) * 20 + 16 })),
  };
  assert.deepEqual(receiverIdentityProblems(good, options), []);
  assert.ok(receiverIdentityProblems({ ...good, clip: { ...good.clip, right: 80 } }, options).some(p => p.includes("characters are clipped")), "a clipping parent cannot hide behind a fitting page");
  assert.ok(receiverIdentityProblems({ ...good, characters: good.characters.slice(1) }, options).some(p => p.includes("geometry is incomplete")));
  assert.ok(receiverIdentityProblems({ ...good, text: name.slice(1) }, options).some(p => p.includes("complete receiver identity")));
  assert.ok(receiverIdentityProblems({ ...good, href: "/fleet/host?name=mini1" }, options).some(p => p.includes("another host")));
  assert.ok(receiverIdentityProblems({ ...good, pageWidth: 867 }, options).some(p => p.includes("widens the page")));
});

const evidence = () => ({
  canvas: "#000000", fonts: "loaded", font: "system-ui", css: true, cardRadius: 12, width: 390, csp: [],
  forges: "", notify: "", endpoints: "One server, one id", problems: "check the webhook secret on both sides",
  unauthorized: "2", receiverPort: "3000", receiverTimes: 2,
  links: ["/fleet/host?name=mini1", "/run?id=gh-timeout-775"],
  hookCounts: { exit: 1, timeout: 1 }, hookAttention: ["timeout"], hookTimes: 1, hookWordsOk: true, hookScrollOk: true,
  hostSlots: { "local-model:mini1": "1 of 2", "shared-model:mini2": "2 of 3", "shared-model:build3": "1 of 4" }, fleetSlots: { "shared-model": "Fleet leases: 3 in use" }, localScope: true, endpointWordsOk: true, endpointPortsOk: true,
});
const options = { slice: "all", width: 390, theme: "dark", receiverPort: 3000 };

test("the browser oracle judges observed values, navigation and exception classification", () => {
  assert.deepEqual(connectionsEvidenceProblems(evidence(), options), []);
  for (const [field, wrong, message] of [
    ["unauthorized", "0", "actual unauthorized count"], ["receiverPort", "4000", "actual listening port"],
    ["hookCounts", { exit: 2, timeout: 0 }, "Retained hook detail counts"], ["hookWordsOk", false, "host identities or header words"], ["hookScrollOk", false, "not keyboard accessible"], ["hookAttention", [], "timeout lost"],
    ["hostSlots", { "local-model:mini1": "0 of 2", "shared-model:mini2": "2 of 3", "shared-model:build3": "0 of 4" }, "host usage"],
    ["links", [], "link is wrong"], ["localScope", false, "claims a fleet bound"], ["endpointWordsOk", false, "squeezed into fragments"], ["endpointPortsOk", false, "ports are split"], ["fleetSlots", { "shared-model": "Fleet leases: 0 in use" }, "positive fleet lease count"],
  ]) assert.ok(connectionsEvidenceProblems({ ...evidence(), [field]: wrong }, options).some(problem => problem.includes(message)), field);
});

test("hook paints require real receiver observations, including after hook-only deletion", () => {
  const hookOptions = { ...options, slice: "hooks" };
  for (const absent of [false, true]) {
    const current = { ...evidence(), ...(absent ? { notify: "no hook run published" } : {}) };
    assert.deepEqual(connectionsEvidenceProblems(current, { ...hookOptions, absent }), []);
    for (const [field, wrong, message] of [["unauthorized", "0", "actual unauthorized count"], ["receiverPort", "4000", "actual listening port"], ["receiverTimes", 0, "Receiver times"]]) {
      assert.ok(connectionsEvidenceProblems({ ...current, [field]: wrong }, { ...hookOptions, absent }).some(problem => problem.includes(message)), `${field}, absent=${absent}`);
    }
  }
});

test("the browser oracle refuses missing shared styles and facts after metadata deletion", () => {
  for (const change of [{ css: false }, { canvas: "white" }, { font: "Times New Roman" }, { width: 1000 }, { csp: ["script-src:inline"] }]) {
    assert.ok(connectionsEvidenceProblems({ ...evidence(), ...change }, options).length > 0);
  }
  const removed = { ...evidence(), forges: "No live receiver", notify: "no hook run published", endpoints: "host occupancy not reported", fleetSlots: { "shared-model": "Fleet leases: 3 of 4" } };
  assert.deepEqual(connectionsEvidenceProblems(removed, { ...options, absent: true }), []);
  for (const slice of ["receiver", "hooks", "endpoints"]) assert.ok(connectionsEvidenceProblems(evidence(), { ...options, slice, absent: true }).length > 0, slice);
});


test("endpoint paints retain receiver and hook facts when only endpoint observations are removed", () => {
  const endpointOptions = { ...options, slice: "endpoints" };
  for (const absent of [false, true]) {
    const current = { ...evidence(), ...(absent ? { endpoints: "host occupancy not reported", fleetSlots: { "shared-model": "Fleet leases: 3 of 4" } } : {}) };
    assert.deepEqual(connectionsEvidenceProblems(current, { ...endpointOptions, absent }), []);
    for (const [field, wrong, message] of [
      ["unauthorized", "0", "actual unauthorized count"], ["receiverPort", "4000", "actual listening port"], ["receiverTimes", 0, "Receiver times"],
      ["hookCounts", { exit: 0, timeout: 0 }, "Retained hook detail counts"], ["hookAttention", [], "timeout lost"], ["hookTimes", 0, "hook time"],
      ["fleetSlots", { "shared-model": "Fleet leases: 0 in use" }, absent ? "changed the existing positive fleet leases" : "positive fleet lease count"],
    ]) assert.ok(connectionsEvidenceProblems({ ...current, [field]: wrong }, { ...endpointOptions, absent }).some(problem => problem.includes(message)), `${field}, absent=${absent}`);
  }
});
