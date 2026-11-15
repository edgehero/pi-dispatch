import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildLoadedResourceLoader, GUARDRAILS_PATH } from "../../src/loader.mjs";
import { guardrailsForMerge, readMergePolicy } from "../../src/merge-policy.mjs";

const wanted = process.argv[2];
assert.ok(wanted === "allow" || wanted === "deny");
const mayMerge = readMergePolicy();
assert.equal(mayMerge, wanted === "allow");
const loader = await buildLoadedResourceLoader({ mayMerge, log: () => {} });
const floor = loader.getAppendSystemPrompt()[0];
assert.equal(floor, guardrailsForMerge(readFileSync(GUARDRAILS_PATH, "utf8"), mayMerge));
assert.equal(floor.includes("Never merge"), !mayMerge);
assert.match(floor, /GUARDRAILS-SENTINEL: pi-dispatch-guardrails-v1/);
assert.match(floor, /Never exfiltrate credentials/);
if (mayMerge) {
	assert.match(floor, /ordinary checks and approvals/);
	assert.match(floor, /branch protection, branch policies, repository or project settings/);
}
process.stdout.write(`merge-policy-${wanted}-ok\n`);
