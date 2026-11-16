import assert from "node:assert/strict";
import { test } from "node:test";
import { recordedModelSelection } from "../src/model-selection-record.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { caseInput } from "./fixtures/run-records/cases.mjs";
import { cooldownModelRefs, resolveConfiguredModelRuns } from "../src/model-observation.mjs";
import { modelSubjects, listedProviderCredentialChecks, unknownModelChecks } from "../src/doctor.mjs";
import { SubscriptionWait } from "../src/subscription-wait.mjs";

const pool = { strategy: "random", candidates: ["openai/ExactCase", "anthropic/other"], previous: "anthropic/other" };
test("public random history keeps reviewed identifiers and discards host authority and arbitrary extras", () => {
	const input = caseInput("maximal");
	input.result.modelSelectionInfo = { ...pool, binding: "private", identityDigest: "private", secret: "private" };
	const record = buildRecord(input);
	assert.deepEqual(record.modelSelection, pool);
	assert.ok(!JSON.stringify(record.modelSelection).includes("private"));
	for (const value of [null, {}, { ...pool, strategy: "weighted" }, { ...pool, candidates: [] }, { ...pool, candidates: ["role:fast"] }, { ...pool, candidates: ["openai/role:fast"] }, { ...pool, candidates: ["openai/A", "openai/a"] }, { ...pool, previous: "invalid" }, { ...pool, previous: "openai/role:fast" }]) {
		assert.equal(recordedModelSelection(value), null);
		input.result.modelSelectionInfo = value;
		assert.equal(buildRecord(input).modelSelection, undefined);
	}
	delete input.result.modelSelectionInfo;
	input.job.data.modelSelectionInfo = pool;
	assert.equal(buildRecord(input).modelSelection, undefined, "queued extras are not host selection facts");
});

test("doctor and cooldown observations enumerate random candidates without synthesizing a default or role primary", () => {
	const run = { label: "random", modelSelection: { strategy: "random", candidates: pool.candidates }, models: pool.candidates };
	const deployment = { provider: "default", model: "never-candidate" };
	const modelRoles = { default: { fast: "different/role" } };
	assert.deepEqual(resolveConfiguredModelRuns({ runs: [run], deployment, modelRoles }).runs, [run]);
	assert.deepEqual(cooldownModelRefs([run], deployment, { modelRoles }), pool.candidates);
	const subjects = modelSubjects({ runs: [run], deployment, modelRoles }).slice(1);
	assert.deepEqual(subjects.map((subject) => `${subject.main.provider}/${subject.main.id}`), pool.candidates);
	assert.ok(subjects.every((subject) => subject.list.length === 1 && subject.list[0] === subject.main));
	assert.deepEqual(listedProviderCredentialChecks(subjects, { candidatesOf: () => ["API_KEY"] }), [], "random runs never need another candidate's secondary credential forwarded");
	const checks = unknownModelChecks(subjects, (refs) => refs[0].provider === "openai" ? { unknown: refs[0], why: "not-in-catalog" } : {}, () => null);
	assert.equal(checks.length, 1);
	assert.match(checks[0].label, /Other eligible candidates can still run/);
	for (const models of [undefined, [pool.candidates[0]]]) {
		const observed = resolveConfiguredModelRuns({ runs: [{ ...run, models }], deployment, modelRoles });
		assert.equal(observed.checks[0].reason, "model-selection-policy-changed", "singleton diagnostics do not grant a missing or narrowed authorization ceiling");
	}
	assert.equal(resolveConfiguredModelRuns({ runs: [{ ...run, models: undefined }], deployment, envList: pool.candidates }).checks.length, 0);
});

test("only authoritative exhausted subscription waits carry positive prestart quota proof", () => {
	for (const status of [null, { state: "unknown" }, { state: "available" }, { state: "exhausted", bindingValid: false }]) assert.equal(new SubscriptionWait({ wait: "subscription-quota", until: 100, status }).quotaConfirmed, false);
	assert.equal(new SubscriptionWait({ wait: "subscription-quota", until: 100, status: { state: "exhausted" } }).quotaConfirmed, true);
	assert.equal(new SubscriptionWait({ wait: "subscription-auth", until: 100, status: { state: "exhausted" } }).quotaConfirmed, false);
});
