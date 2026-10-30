import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readTriggerEgress } from "../src/read-trigger-egress.mjs";
import { triggerSandboxHosts } from "../src/console/trigger-sandbox.mjs";

test("trigger sandbox distinguishes host defaults, absent blessings and unknown capability publications", () => {
  const rows = [
    { name: "a", capsSeen: true, caps: ["s:work"], backends: { blessed: ["local", "podman"], default: "podman" } },
    { name: "b", capsSeen: true, caps: [], backends: { blessed: ["local"], default: "local" } },
    { name: "old", capsSeen: false, caps: [], backends: null },
  ];
  const snapshot = { hostBudgets: rows };
  assert.deepEqual(triggerSandboxHosts({ type: "comment", secretsProfile: "work" }, snapshot), [
    { name: "a", backend: "podman", deploymentDefault: true, blessed: true, capabilityUnknown: false },
    { name: "old", backend: null, deploymentDefault: true, blessed: null, capabilityUnknown: true },
  ]);
  const explicit = triggerSandboxHosts({ type: "comment", backend: "podman" }, snapshot);
  assert.deepEqual(explicit.map((h) => [h.name, h.backend, h.blessed]), [["a", "podman", true], ["b", "podman", false], ["old", "podman", null]]);
  assert.deepEqual(triggerSandboxHosts({ type: "label" }, {}), [], "an unread registry cannot invent a local blessing");
});

test("current OpenShell rule hosts come from the worker's allowlist and endpoint policy, without URLs or credentials", () => {
  const deploymentDir = tempDir("pd-750-egress-");
  writeFileSync(join(deploymentDir, "egress-allowlist.conf"), "# policy\napi.example.test\n.example.org\nlocalhost\nignored two words\n");
  writeFileSync(join(deploymentDir, "model-endpoints.json"), JSON.stringify({ version: 1, endpoints: [{ id: "local-model", host: "host.docker.internal", port: 11434, slots: 2 }] }));
  const got = readTriggerEgress({ deploymentDir });
  assert.equal(got.egressProblem, null);
  assert.deepEqual(got.egressHosts, ["*.example.org", "api.example.test", "example.org", "host.docker.internal", "localhost"]);
  assert.doesNotMatch(JSON.stringify(got), /ignored|11434|model-endpoints|password/);
  const broken = readTriggerEgress({ deploymentDir, env: { PI_MODEL_ENDPOINTS_FILE: "missing.json" } });
  assert.equal(broken.egressHosts, null);
  assert.match(broken.egressProblem, /model endpoints could not be read/);
  assert.equal(readTriggerEgress({}).egressHosts, null, "unknown folder is not an empty network");
  assert.deepEqual(readTriggerEgress({ deploymentDir: tempDir("pd-750-egress-empty-") }), { egressHosts: [], egressProblem: null }, "missing default policy sources admit no hosts");
});
