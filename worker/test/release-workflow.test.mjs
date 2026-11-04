import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Issue #813: release.yml's suite ran with no Valkey and none of the REQUIRE flags, so every integration test skipped
// there, and from 2026-10-17 a test that booted the worker anyway hung the step until Actions' six-hour cap cancelled
// the run. Its test step now runs as the contract job's does (pi-upgrade-check.yml), and this holds the two together:
// a setup dropped or moved on one side alone fails here, not as a release that stops publishing again.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = (file) => parse(readFileSync(join(REPO, ".github", "workflows", file), "utf8"));
/** The one step of `job` whose name starts with `name`. */
const stepOf = (job, name) => {
	const found = (job?.steps ?? []).filter((step) => typeof step?.name === "string" && step.name.startsWith(name));
	assert.equal(found.length, 1, `one step named "${name}..."`);
	return found[0];
};
const SUITE_ENV = ["VALKEY_TEST_URL", "PI_DISPATCH_REQUIRE_LOADER_TESTS", "PI_DISPATCH_REQUIRE_WORKER_TESTS", "PI_DISPATCH_REQUIRE_RECEIVER_TESTS"];
const suiteEnv = (step) => Object.fromEntries(SUITE_ENV.map((key) => [key, step?.env?.[key]]));

test("release.yml's suite runs with the contract job's Valkey, VALKEY_TEST_URL and REQUIRE flags, inside a 60-minute limit (issue #813)", () => {
	const contract = workflow("pi-upgrade-check.yml").jobs?.["contract-tests"];
	const release = workflow("release.yml").jobs?.release;
	assert.ok(contract && release, "both jobs are where this test reads them");
	const contractSuite = stepOf(contract, "Contract tests");
	const releaseSuite = stepOf(release, "Test everything being shipped");
	assert.equal(releaseSuite.run, "npm test", "the release's step is the one that runs the whole suite");
	// Non-vacuous: the contract job's own step sets all four, so "equal" cannot mean "both unset".
	assert.deepEqual(suiteEnv(contractSuite), { VALKEY_TEST_URL: "redis://127.0.0.1:6379", PI_DISPATCH_REQUIRE_LOADER_TESTS: "1", PI_DISPATCH_REQUIRE_WORKER_TESTS: "1", PI_DISPATCH_REQUIRE_RECEIVER_TESTS: "1" });
	assert.deepEqual(suiteEnv(releaseSuite), suiteEnv(contractSuite), "the release's suite step sets what the contract job's does");
	assert.ok(contract.services?.valkey?.image, "the contract job's Valkey service is where this test reads it");
	assert.deepEqual(release.services?.valkey, contract.services.valkey, "the release job runs the contract job's Valkey service");
	assert.ok(release.services.valkey.ports.includes(`${new URL(releaseSuite.env.VALKEY_TEST_URL).port}:6379`), "VALKEY_TEST_URL names the port the service publishes");
	assert.equal(release["timeout-minutes"], 60, "a hang ends in an hour, the contract job's own limit, not at Actions' six");
	assert.equal(contract["timeout-minutes"], 60);
});
