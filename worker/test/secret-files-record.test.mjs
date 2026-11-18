import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecord, recordedSecretFiles } from "../src/run-history.mjs";
import { caseInput } from "./fixtures/run-records/cases.mjs";

test("recorded file grants rebuild a bounded sorted names-only list", () => {
	const names = ["Z_KEY", "A_KEY"];
	const rebuilt = recordedSecretFiles(names);
	assert.deepEqual(rebuilt, ["A_KEY", "Z_KEY"]);
	assert.notEqual(rebuilt, names);
	assert.deepEqual(names, ["Z_KEY", "A_KEY"]);
	assert.equal(recordedSecretFiles(Array.from({ length: 80 }, (_, i) => `KEY_${i}`)).length, 80);
	assert.deepEqual(recordedSecretFiles(["A".repeat(128)]), ["A".repeat(128)]);
	for (const bad of [undefined, null, [], {}, "KEY", ["KEY", "key"], ["KEY", "KEY"], Array(1), [null], ["../KEY"], ["/run/secrets/KEY"], ["vault://key"], ["A=B"], ["CON"], ["nul"], ["LPT1"], ["__proto__"], ["A".repeat(129)], Array.from({ length: 81 }, (_, i) => `KEY_${i}`)]) {
		assert.equal(recordedSecretFiles(bad), null);
	}
});

test("records use resolved delivery facts, never queued references, including infrastructure failures", () => {
	const input = caseInput("forge-completed");
	input.job.data.secretFiles = { DEVICE_KEY: "private-reference-canary" };
	const baseline = buildRecord(input);
	assert.equal(Object.hasOwn(baseline, "secretFiles"), false, "an authored grant alone is not delivery evidence");
	const resolved = buildRecord({ ...input, result: { ...input.result, secretFiles: ["DEVICE_KEY"] } });
	assert.deepEqual(resolved.secretFiles, ["DEVICE_KEY"]);
	assert.equal(resolved.secretsProfile, "default", "file-only jobs record the profile they used");
	assert.equal(resolved.v, baseline.v, "an optional names-only field leaves older records readable");
	assert.doesNotMatch(JSON.stringify(resolved), /private-reference-canary/);
	const failed = caseInput("failed-infra");
	failed.error.secretFiles = ["DEVICE_KEY"];
	assert.deepEqual(buildRecord(failed).secretFiles, ["DEVICE_KEY"]);
	for (const bad of [{ DEVICE_KEY: "private-reference-canary" }, ["/run/secrets/DEVICE_KEY"], ["CON"]]) {
		assert.equal(Object.hasOwn(buildRecord({ ...input, result: { ...input.result, secretFiles: bad } }), "secretFiles"), false);
	}
});
