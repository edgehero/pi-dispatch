import assert from "node:assert/strict";
import { test } from "node:test";
import { failoverModelStatus, failoverPriceEligible } from "../src/model-status.mjs";
import { failoverModelView as sharedView } from "../src/model-status.mjs";
import { failoverModelView as workerView, readModelCooldowns as workerCooldowns } from "../src/model-failover.mjs";
import { readModelCooldowns } from "../src/model-cooldowns.mjs";
import { resolveConfiguredModelRuns } from "../src/model-observation.mjs";
import { buildDoctorRecord, parseDoctorRecord, assignCheckIds, DOCTOR_LABEL_MAX } from "../src/doctor-results.mjs";
import { modelProposalOf } from "../src/model-proposal-protocol.mjs";
import { roleProposalChecks } from "../src/model-proposals.mjs";

const NOW = Date.UTC(2026, 9, 31);
const model = { api: "openai-completions", baseUrl: "https://api.openai.com/v1", maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

test("console observations share the actual failover model composition and cooldown reader", () => {
	assert.equal(sharedView, workerView);
	assert.equal(readModelCooldowns, workerCooldowns);
	assert.equal(failoverPriceEligible(model), true, "a verified zero-rate table is priced");
	for (const bad of [{ ...model, api: "pi-messages" }, { ...model, maxTokens: 0 }, { ...model, cost: { ...model.cost, output: NaN } }, { ...model, cost: { ...model.cost, input: -1 } }, { ...model, cost: { input: 0, output: 0 } }]) assert.equal(failoverPriceEligible(bad), false);
	assert.equal(failoverModelStatus("unknown/not-a-model").known, false);
	const overlay = { providers: { custom: { api: "openai-completions", baseUrl: "http://192.0.2.1/v1", compat: { maxTokensField: "max_tokens" }, models: [{ id: "priced", cost: model.cost }, { id: "rate-not-enough", api: "pi-messages", cost: model.cost }] } } };
	assert.equal(failoverModelStatus("custom/priced", { models: overlay }).priced, true);
	assert.deepEqual(failoverModelStatus("custom/rate-not-enough", { models: overlay }), { known: true, priced: false, reason: "model-unpriced", api: "pi-messages" });
});

test("configured observations keep source row and authored provider while finding project overrides", () => {
	const out = resolveConfiguredModelRuns({ runs: [{ sourceIndex: 4, label: "trigger 5", kind: "github", provider: "p", authoredProvider: undefined, model: "role:editor" }], deployment: { provider: "p", model: "default" }, modelRoles: { default: { editor: "p/main" }, web: { editor: "other/override" } }, projects: [{ id: "web", members: ["github:acme/web"] }] });
	assert.equal(out.checks.length, 0);
	assert.deepEqual(out.runs.map(row => [row.sourceIndex, row.project, row.roleScope, row.provider]), [[4, null, "default", "p"], [4, "web", "web", "other"]]);
});

test("only closed typed proposals publish successful doctor labels and publication keeps redaction and limits", () => {
	const proposal = { kind: "newer-sibling", scope: "default", role: "editor", model: "p/old", candidate: "p/new" };
	const checks = [
		{ ok: true, label: "unrelated secret success text" },
		{ ok: true, proposal, label: `New model at /Users/secret/config with api_key=known-secret-value ${"x".repeat(DOCTOR_LABEL_MAX)}`, fix: "review /Users/secret/file" },
		{ ok: true, proposal: { kind: "anything", text: "unbounded" }, label: "invalid typed secret success" },
	];
	const record = buildDoctorRecord({ checks, ids: assignCheckIds(checks), at: NOW, version: "1.4.0", secrets: ["known-secret-value"] });
	assert.deepEqual(record.checks[0], { id: "env.1", level: "ok" });
	assert.deepEqual(record.checks[2], { id: "env.3", level: "ok" });
	assert.deepEqual(record.checks[1].proposal, proposal);
	assert.match(record.checks[1].label, /<path>/);
	assert.ok(record.checks[1].label.length <= DOCTOR_LABEL_MAX);
	assert.doesNotMatch(JSON.stringify(record), /known-secret-value|Users\/secret|unrelated secret|invalid typed secret/);
	const parsed = parseDoctorRecord(JSON.stringify(record));
	assert.deepEqual(parsed.checks[1], record.checks[1]);
	const hostile = parseDoctorRecord(JSON.stringify({ ...record, checks: [{ id: "models.1", level: "ok", label: "must not publish", proposal: { kind: "newer-sibling", scope: "default", role: "bad role", model: "p/old", candidate: "p/new" } }] }));
	assert.deepEqual(hostile.checks, [{ id: "models.1", level: "ok" }]);
});

test("proposal metadata is rebuilt rather than spread and provider declared siblings retain machine facts", () => {
	const proposal = modelProposalOf({ kind: "cheaper-route", model: "p/main", candidate: "other/alternative", command: "run private code", text: "private text" });
	assert.deepEqual(proposal, { kind: "cheaper-route", model: "p/main", candidate: "other/alternative" });
	assert.equal(modelProposalOf({ kind: "newer-sibling", scope: "default", role: "inherit", model: "p/m", candidate: "p/n" }), null);
	const checks = roleProposalChecks({ roles: { default: { editor: "anthropic/old" } }, now: NOW, catalogs: { anthropic: [{ id: "old", line: "declared", createdAt: "2026-01-01", deprecated: false, retiresAt: null }, { id: "new", line: "declared", createdAt: "2026-02-01", deprecated: false, retiresAt: null }] } });
	assert.deepEqual(checks[0].proposal, { kind: "newer-sibling", scope: "default", role: "editor", model: "anthropic/old", candidate: "anthropic/new" });
});
