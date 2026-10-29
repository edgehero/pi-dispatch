import assert from "node:assert/strict";
import { test } from "node:test";
import * as names from "../src/container-names.mjs";
import * as local from "../src/backend-local.mjs";
import * as openshell from "../src/backend-openshell.mjs";

// Operator guidance must name precisely what the runtime created, without loading its implementations in production.
test("runtime adapters re-export the shared naming functions rather than carrying parallel copies (#748)", () => {
	assert.equal(local.jobContainerName, names.jobContainerName);
	assert.equal(local.JOB_NAME_PREFIX, names.JOB_NAME_PREFIX);
	assert.equal(openshell.sandboxNameOf, names.sandboxNameOf);
	assert.equal(openshell.SANDBOX_NAME, names.SANDBOX_NAME);
});

test("queue ids are sanitized before deriving their bounded OpenShell name, and seeded sandbox names remain themselves (#748)", () => {
	assert.equal(names.jobContainerName("repeat:nightly:1790361600000"), "pi-job-repeat_nightly_1790361600000");
	assert.equal(names.jobContainerName("manual:nightly:1790361600000"), "pi-job-manual_nightly_1790361600000");
	for (const id of ["gh-job", "repeat:nightly:1790361600000", "manual:nightly:1790361600000", "hostile/quote'\\\n", "x".repeat(1024)]) {
		const container = names.jobContainerName(id);
		assert.match(container, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
		const sandbox = names.sandboxNameOf(container);
		assert.match(sandbox, names.SANDBOX_NAME);
		assert.equal(sandbox.length, 19);
		assert.equal(names.sandboxNameOf(sandbox), sandbox, "a seeded survivor is already a real sandbox name");
	}
});
