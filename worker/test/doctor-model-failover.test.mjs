import { test } from "node:test";
import assert from "node:assert/strict";
import { cooldownModelRefs, modelCooldownChecks } from "../src/doctor.mjs";
import { buildDoctorRecord, parseDoctorRecord } from "../src/doctor-results.mjs";

const AT = Date.UTC(2026, 9, 28, 12);

test("doctor reads only configured failover candidates, resolving defaults and deduplicating without a scan", () => {
	const deployment = { provider: "anthropic", model: "primary" };
	assert.deepEqual(cooldownModelRefs([{ models: ["openai/unrelated"] }], deployment), []);
	assert.deepEqual(cooldownModelRefs([
		{ fallbackModels: ["openai/fallback", "anthropic/primary"] },
		{ provider: "openai", model: "custom", fallbackModels: ["openai/fallback"] },
	], deployment), ["anthropic/primary", "openai/fallback", "openai/custom"]);
});

test("doctor reports the model, fixed cause and reset time, and distinguishes unreadable from empty", () => {
	assert.deepEqual(modelCooldownChecks([]), []);
	const unread = modelCooldownChecks(null);
	assert.equal(unread[0].warn, true);
	assert.match(unread[0].label, /could not be read/);
	const [check] = modelCooldownChecks([{ ref: "anthropic/primary", kind: "quota-exhausted", until: AT + 60_000 }]);
	assert.equal(check.warn, true);
	assert.match(check.label, /anthropic\/primary.*2026-10-28T12:01:00.000Z.*quota-exhausted/);
	assert.match(check.fix, /reviewed fallback list/);
	for (const row of [
		{ ref: "secret text", kind: "overloaded", until: AT },
		{ ref: "openai/model", kind: "arbitrary error body", until: AT },
		{ ref: "openai/model", kind: "overloaded", until: Infinity },
		{ ref: "openai/model", kind: "overloaded", until: 8.64e15 },
	]) assert.deepEqual(modelCooldownChecks([row]), []);
});

test("cooldown warnings survive doctor's redacted published result for console viewers", () => {
	const checks = modelCooldownChecks([{ ref: "anthropic/primary", kind: "rate-limited", until: AT + 60_000 }]);
	const record = buildDoctorRecord({ checks, ids: ["models.1"], at: AT, version: "4.3.1", every: 24 });
	const parsed = parseDoctorRecord(JSON.stringify(record));
	assert.equal(parsed.checks[0].level, "warn");
	assert.match(parsed.checks[0].label, /anthropic\/primary.*2026-10-28T12:01:00.000Z/);
});
