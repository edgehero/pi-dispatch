import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tempDir } from "./helpers/temp-dir.mjs";
import { validateModelRoles, roleMapFor, resolveModelRoles } from "../src/model-roles.mjs";
import { makeReadModelRoles } from "../src/model-roles-file.mjs";
import { parseTriggersDocument } from "../src/triggers.mjs";
import { snapshotAgents, stageModelRoleInputs, parseAgentDefinition } from "../src/agent-snapshot.mjs";
import { CAPABILITY_GATES } from "../src/image-preflight.mjs";

const roles = { default: { planner: "anthropic/opus", editor: "anthropic/sonnet", explorer: "anthropic/haiku" }, shop: { editor: "openai/gpt" } };
const job = { provider: "anthropic", model: "role:editor", kind: "local" };

test("reviewed deployment roles merge by project, resolve physical provider, and join the allowed ceiling", () => {
	const doc = validateModelRoles(roles);
	assert.equal(roleMapFor(doc, "shop").planner, "anthropic/opus");
	const resolved = resolveModelRoles(job, doc, "shop");
	assert.equal(resolved.provider, "openai");
	assert.equal(resolved.model, "gpt");
	assert.equal(resolved.modelRole, "editor");
	assert.deepEqual(resolved.models, ["openai/gpt", "anthropic/opus", "anthropic/haiku"]);
	assert.throws(() => resolveModelRoles(job, doc, "shop", { authoredProvider: "anthropic" }), { modelSelectionReason: "model-role-provider-conflict" });
	assert.equal(job.model, "role:editor");
});

test("role maps reject invalid policy and unknown references, including union overflow and case collisions", () => {
	for (const value of [null, [], { default: { inherit: "p/m" } }, { default: { editor: "role:planner" } }, { default: { editor: { model: "p/m", unexpected: true } } }]) assert.throws(() => validateModelRoles(value));
	assert.throws(() => resolveModelRoles({ ...job, model: "role:missing" }, roles), { modelSelectionReason: "model-role-unknown" });
	assert.throws(() => resolveModelRoles({ ...job, models: Array.from({ length: 16 }, (_, n) => `p/m${n}`) }, roles), { modelSelectionReason: "model-roles-invalid" });
	assert.throws(() => resolveModelRoles({ ...job, models: ["anthropic/SONNET"] }, roles), { modelSelectionReason: "model-roles-invalid" });
	assert.equal(resolveModelRoles({ provider: "p", model: "m" }, {}).modelRoles, undefined);
});

test("role fallback candidates enter the ceiling before existing failover narrows it", () => {
	const doc = validateModelRoles({ default: { editor: { model: "p/main", fallbackModels: ["q/next"] } } });
	const resolved = resolveModelRoles(job, doc);
	assert.deepEqual(resolved.fallbackModels, ["q/next"]);
	assert.deepEqual(resolved.models, ["p/main", "q/next"]);
	assert.throws(() => resolveModelRoles({ ...job, fallbackModels: ["q/other"] }, doc));
});

test("the shared trigger schema preserves reviewed roles and rejects near misses and duplicate keys", () => {
	assert.deepEqual(parseTriggersDocument(JSON.stringify({ triggers: [], modelRoles: roles }), "test").modelRoles, roles);
	assert.throws(() => parseTriggersDocument('{"triggers":[],"model_roles":{}}', "test"));
	assert.throws(() => parseTriggersDocument('{"triggers":[],"ｍodelRoles":{}}', "test"));
	assert.throws(() => parseTriggersDocument('{"triggers":[],"modelRoles":{},"modelRoles":{}}', "test"));
});

test("pickup reads edits without trigger changes; a broken save keeps and names last-good policy", () => {
	const dir = tempDir("model-roles-");
	const path = join(dir, "triggers.json");
	const logs = [];
	writeFileSync(path, JSON.stringify({ triggers: [], modelRoles: roles }));
	const read = makeReadModelRoles({ triggersPath: path, log: (...args) => logs.push(args) });
	assert.equal(resolveModelRoles(job, read()).model, "sonnet");
	writeFileSync(path, JSON.stringify({ triggers: [], modelRoles: { default: { editor: "p/new" } } }));
	assert.equal(resolveModelRoles(job, read()).model, "new");
	writeFileSync(path, "broken");
	assert.equal(resolveModelRoles(job, read()).model, "new");
	assert.equal(logs.at(-1)[0], "model_roles_last_good");
	assert.throws(() => makeReadModelRoles({ triggersPath: path })(), { modelSelectionReason: "model-roles-invalid" });
});

test("agent snapshots read the base blobs, excluding modified worktree definitions and symlinks", async () => {
	const workspace = tempDir("model-roles-");
	const git = (...args) => execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
	git("init", "--quiet");
	mkdirSync(join(workspace, ".pi/agents"), { recursive: true });
	const path = join(workspace, ".pi/agents/explorer.md");
	writeFileSync(path, "---\nname: explorer\ndescription: Explore\nmodel: explorer\ntools: [read, bash]\n---\nTrusted prompt\n");
	git("add", ".");
	git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
	const sha = git("rev-parse", "HEAD");
	writeFileSync(path, "agent-written content");
	const snapshot = await snapshotAgents({ workspace, sha });
	assert.equal(snapshot.agents[0].content, "Trusted prompt\n");
	const jobDir = tempDir("model-roles-");
	const resolved = resolveModelRoles(job, roles);
	await stageModelRoleInputs(resolved, { workspace, sha, jobDir });
	assert.equal(JSON.parse(readFileSync(join(jobDir, "model-roles.json"))).parent, "anthropic/sonnet");
	assert.equal(JSON.parse(readFileSync(join(jobDir, "agents.json"))).agents[0].model, "explorer");
	assert.throws(() => parseAgentDefinition("---\nname: a\nname: b\ndescription: Bad\n---\nx"));
});

test("older job images cannot silently ignore a role map", () => {
	const gate = CAPABILITY_GATES.find((gate) => gate.token === "modelRoles");
	assert.equal(gate.needed(resolveModelRoles(job, roles)), true);
	assert.equal(gate.needed({ model: "literal" }), false);
});


test("queued maps carry no authority and a reviewed map never implicitly admits an unmapped main", () => {
	const queued = { provider: "p", model: "m", modelRoles: { editor: "evil/model" }, modelRole: "forged" };
	assert.deepEqual(resolveModelRoles(queued, {}), { provider: "p", model: "m" });
	const resolved = resolveModelRoles({ provider: "p", model: "off", models: ["p/only"] }, { default: { editor: "q/editor" } });
	assert.deepEqual(resolved.models, ["p/only", "q/editor"]);
});


test("default and project rows may merge 32 aliases while the physical list stays within 16", async () => {
	const { validateRoleInputs } = await import("../../image/runner/src/model-roles.mjs");
	const row = (prefix) => Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`${prefix}${n}`, "p/model"]));
	const policy = validateModelRoles({ default: row("default"), shop: row("project") });
	const resolved = resolveModelRoles({ provider: "p", model: "role:default0" }, policy, "shop");
	assert.equal(Object.keys(resolved.modelRoles).length, 32);
	assert.deepEqual(resolved.models, ["p/model"]);
	assert.doesNotThrow(() => validateRoleInputs({ version: 1, roles: resolved.modelRoles, parent: "p/model", models: resolved.models }, { version: 1, agents: [] }));
	assert.throws(() => validateRoleInputs({ version: 1, roles: { ...resolved.modelRoles, extra: "p/model" }, parent: "p/model", models: resolved.models }, { version: 1, agents: [] }));
});


test("JSON escaping cannot push an admissible agent set past the runner input bound after reserves", async () => {
	const workspace = tempDir("model-roles-size-");
	const jobDir = tempDir("model-roles-size-");
	mkdirSync(join(workspace, ".git"));
	const entries = Array.from({ length: 24 }, (_, n) => ({ name: `agent${n}`, hash: n.toString(16).padStart(40, "0") }));
	const git = async (_workspace, args) => args[0] === "ls-tree" ? entries.map(({ name, hash }) => `100644 blob ${hash}\t.pi/agents/${name}.md\0`).join("") : `---\nname: agent${parseInt(args[2], 16)}\ndescription: Test\n---\n${"\u0001".repeat(120000)}`;
	await assert.rejects(() => stageModelRoleInputs({ provider: "p", model: "m", modelRoles: { editor: "p/m" }, models: ["p/m"] }, { workspace, jobDir, sha: "a".repeat(40) }, { git }), { piDispatchConfig: true });
	assert.equal(existsSync(join(jobDir, "agents.json")), false);
	assert.equal(existsSync(join(jobDir, "model-roles.json")), false);
});


test("agent names are YAML strings, never coerced missing or boolean values", () => {
	for (const name of ["", "name: true\n", "name: false\n", "name: null\n"]) {
		assert.throws(() => parseAgentDefinition(`---\n${name}description: Explore\n---\nPrompt`), { piDispatchConfig: true });
	}
});
