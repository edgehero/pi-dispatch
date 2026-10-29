import assert from "node:assert/strict";
import { test } from "node:test";
import { cappedModelNames, cooldownModelRefs, costCapFitChecks, modelSubjects, resolveDoctorModelRuns, unknownModelChecks, listedProviderCredentialChecks } from "../src/doctor.mjs";
const deployment = { provider: "base", model: "default", maxCostUsd: "0.01" };
const modelRoles = { default: { editor: "base/editor", explorer: "other/scout" }, shop: { editor: { model: "fast/project", fallbackModels: ["other/backup"] } } };
const projects = [{ id: "shop", members: ["github:org/repo", "/srv/shop"] }, { id: "gitlab-only", members: ["gitlab:org/repo"] }];
const run = { label: "trigger 1", kind: "github", model: "role:editor" };

test("broad forge triggers check default and every reachable project role override", () => {
	const facts = resolveDoctorModelRuns({ runs: [run], deployment, modelRoles, projects });
	assert.deepEqual(facts.checks, []);
	assert.deepEqual(facts.runs.map((row) => [row.label, row.provider, row.model]), [["trigger 1", "base", "editor"], ["trigger 1 (project shop)", "fast", "project"]]);
	assert.deepEqual(facts.runs[1].models, ["fast/project", "other/scout", "other/backup"]);
	assert.deepEqual(facts.runs[1].fallbackModels, ["other/backup"]);
	assert.equal(facts.runs.some((row) => row.label.includes("gitlab-only")), false);
});

test("known repository and local folder resolve only their assigned project", () => {
	for (const context of [{ kind: "local", folder: "/srv/shop" }, { kind: "github", repo: "org/repo" }]) {
		const facts = resolveDoctorModelRuns({ runs: [{ ...run, ...context }], deployment, modelRoles, projects });
		assert.equal(facts.runs.length, 1);
		assert.equal(facts.runs[0].model, "project");
	}
	assert.equal(resolveDoctorModelRuns({ runs: [{ ...run, kind: "local", folder: "/srv/elsewhere" }], deployment, modelRoles, projects }).runs[0].model, "editor");
});

test("unknown role and project provider conflicts become actionable warnings, never literal catalog lookups", () => {
	const unknown = resolveDoctorModelRuns({ runs: [{ ...run, model: "role:missing" }], deployment, modelRoles, projects });
	assert.equal(unknown.runs.length, 0);
	assert.equal(unknown.checks.length, 2);
	assert.match(unknown.checks[0].label, /model-role-unknown/);
	assert.match(unknown.checks[0].fix, /triggers.json modelRoles/);
	const conflict = resolveDoctorModelRuns({ runs: [{ ...run, provider: "base" }], deployment, modelRoles, projects });
	assert.equal(conflict.runs.length, 1);
	assert.match(conflict.checks[0].label, /project shop.*model-role-provider-conflict/);
});

test("catalog, credential and deployment-cap checks see physical role models and the mapped union", () => {
	const subjects = modelSubjects({ runs: [run], deployment, modelRoles, projects });
	const refs = [];
	unknownModelChecks(subjects, (models) => { refs.push(...models); return { ok: true }; }, () => null);
	assert.equal(refs.some((ref) => ref.id.startsWith("role:")), false);
	assert.ok(refs.some((ref) => ref.provider === "fast" && ref.id === "project"));
	assert.ok(refs.some((ref) => ref.provider === "other" && ref.id === "scout"));
	const capChecks = costCapFitChecks(subjects, () => ({ id: "m", api: "anthropic-messages", maxTokens: 1000, cost: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 } }));
	assert.ok(capChecks.some((check) => check.label.includes("fast/project")));
	assert.ok(capChecks.some((check) => check.label.includes("other/scout")));
	const names = cappedModelNames({}, { runs: [run], deployment, modelRoles, projects });
	assert.ok(names.has("fast/project"));
	assert.equal([...names].some((name) => name.includes("role:")), false);
	const credentials = listedProviderCredentialChecks(subjects, { candidatesOf: (provider) => [`${provider.toUpperCase()}_API_KEY`] });
	assert.ok(credentials.some((check) => check.label.includes("other")));
});

test("cooldowns include role fallbacks and actual selected primary, preserving legacy nonrole behavior", () => {
	assert.deepEqual(cooldownModelRefs([run], deployment, { modelRoles, projects }), ["fast/project", "other/backup"]);
	const legacy = { label: "literal", provider: "old", model: "fixed", models: ["other/listed"] };
	assert.deepEqual(modelSubjects({ runs: [legacy], deployment }), modelSubjects({ runs: [legacy], deployment, modelRoles: {}, projects }));
});


test("local project matching uses the resolved workspace folder as pickup does", () => {
	const facts = resolveDoctorModelRuns({ runs: [{ ...run, kind: "local", folder: "/alias/shop" }], deployment, modelRoles, projects, resolveFolder: (folder) => { assert.equal(folder, "/alias/shop"); return "/srv/shop"; } });
	assert.equal(facts.runs[0].model, "project");
});
