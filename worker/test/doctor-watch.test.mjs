import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_ID_RE } from "../src/doctor-results.mjs";
import { watchDoctorChecks } from "../src/doctor.mjs";
test("doctor lists watch source and rule counts and warns on missing signing and pull secrets", () => {
	const checks = watchDoctorChecks({ sources: { prod: { secretEnv: "WATCH_SIGNING", pull: { secretEnv: "LOKI_TOKEN" } } }, rules: 2 });
	assert.match(checks[0].label, /1 watch source\(s\), 2 watch rule/);
	assert.equal(checks.filter(c => c.warn && !c.ok).length, 2);
	assert.ok(checks.every(c => CHECK_ID_RE.test(c.id)));
	assert.match(checks.find(c => c.id.startsWith("watch.secret-")).fix, /WATCH_SIGNING/);
});
test("doctor secret availability never prints secret values and is silent without watch sources", () => {
	const checks = watchDoctorChecks({ sources: { prod: { secretEnv: "WATCH_SIGNING", pull: { secretEnv: "LOKI_TOKEN" } } }, rules: 1, env: { WATCH_SIGNING: "private-signing-value", LOKI_TOKEN: "private-query-token" } });
	assert.ok(checks.every(c => c.ok)); assert.doesNotMatch(JSON.stringify(checks), /private-signing-value|private-query-token/);
	assert.deepEqual(watchDoctorChecks(), []);
});
