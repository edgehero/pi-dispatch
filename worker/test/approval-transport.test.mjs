import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainerEnv } from "../src/env-allowlist.mjs";
import { openshellExecArgs } from "../src/backend-openshell.mjs";
import { NON_SECRET_ENV_KEYS, secretValuesOf } from "../src/redact-secrets.mjs";

const metadata = { requestId: "a".repeat(64), action: "deploy:staging", toolCallId: "call_1|fc_2", decision: "declined" };
const PRIVATE = "private person's explanation\nwith details";
const options = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "job-649", hostEnv: { ANTHROPIC_API_KEY: "fake-provider-credential" }, approvalGates: ["deploy:staging"], approvalDecision: { ...metadata, text: PRIVATE, summary: "private summary" } };

test("approval container env carries identifiers only, leaving human text to the existing event file", () => {
	const env = buildContainerEnv(options);
	assert.equal(env.PI_APPROVAL_GATES, '["deploy:staging"]');
	assert.deepEqual(JSON.parse(env.PI_APPROVAL_DECISION), metadata);
	assert.equal(JSON.stringify(env).includes("private"), false);
	assert.equal(NON_SECRET_ENV_KEYS.has("PI_APPROVAL_GATES"), true);
	assert.equal(NON_SECRET_ENV_KEYS.has("PI_APPROVAL_DECISION"), true);
	assert.equal(secretValuesOf(env).includes(env.PI_APPROVAL_GATES), false);
	assert.equal(secretValuesOf(env).includes(env.PI_APPROVAL_DECISION), false);
});

for (const mode of ["copy", "bind"]) test(`OpenShell ${mode} transports approval metadata without exposing human text on exec argv`, () => {
	const env = buildContainerEnv({ ...options, layout: mode === "copy" ? "sandbox" : "mounts" });
	const argv = openshellExecArgs({ name: "job-649", env, mode });
	assert.ok(argv.includes(`PI_APPROVAL_GATES=${env.PI_APPROVAL_GATES}`));
	assert.ok(argv.includes(`PI_APPROVAL_DECISION=${env.PI_APPROVAL_DECISION}`));
	assert.equal(JSON.stringify(argv).includes("private"), false);
	assert.equal(argv.some((arg) => arg.includes("fake-provider-credential")), false);
});
