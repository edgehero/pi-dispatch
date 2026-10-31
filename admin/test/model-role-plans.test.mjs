import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createModelRoleActions } from "../src/model-role-plans.mjs";
import { ACTIONS, previewAction } from "../src/console/actions.mjs";
import { authorizeTransition } from "../src/action-policy.mjs";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { resolveModelRoles } from "@edgehero/pi-dispatch/model-roles";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const operator = { surface: "console", role: "operator" };
const trigger = run => ({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", model: "role:editor", ...run } });
const body = { scope: "default", role: "editor", model: "openai/new" };
const known = new Set(["openai/old", "openai/new", "openai/backup", "anthropic/new", "anthropic/old", ...Array.from({ length: 40 }, (_, index) => `openai/m${index}`)]);
const knownCheck = (refs, { readOverlay }) => {
  const overlay = readOverlay();
  for (const ref of refs) if (!known.has(`${ref.provider}/${ref.id}`) && !overlay?.providers?.[ref.provider]?.models?.some(model => model.id === ref.id)) return { unknown: ref };
  return { ok: true };
};
function fixture({ doc = { modelRoles: { default: { editor: "openai/old" } }, triggers: [trigger()] }, projects = null, settings = {}, env = {}, canarySample = null, fs = nodeFs, checkModelsKnown = knownCheck, overlay = null } = {}) {
  const dir = tempDir("models-role-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: projects ? join(dir, "projects.json") : null, globalPiDir: overlay ? join(dir, "overlay") : null };
  nodeFs.writeFileSync(paths.triggersPath, `${JSON.stringify(doc, null, 2)}\n`);
  nodeFs.writeFileSync(paths.settingsFile, JSON.stringify(settings));
  if (projects) nodeFs.writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects }));
  if (overlay) { nodeFs.mkdirSync(paths.globalPiDir); nodeFs.writeFileSync(join(paths.globalPiDir, "models.json"), JSON.stringify(overlay)); }
  const read = () => JSON.parse(nodeFs.readFileSync(paths.triggersPath, "utf8"));
  const service = createModelRoleActions({ paths, env, fs, now: () => NOW, checkModelsKnown, canarySample });
  return { dir, paths, service, read, doc, env, write: doc => nodeFs.writeFileSync(paths.triggersPath, JSON.stringify(doc)) };
}
async function preview(f, params = body) {
  const out = await f.service.preview(params, operator);
  assert.ok(out.plan, JSON.stringify(out));
  return out;
}

test("preview changes nothing, confirm changes only reviewed modelRoles and the next delivery resolves it", async () => {
  const f = fixture({ doc: { modelRoles: { default: { editor: "openai/old" } }, secretBundles: {}, triggers: [trigger(), { on: { type: "label", any: ["review"] }, run: { kind: "github", model: "role:editor", flow: "review" } }], retained: { secret: "private-value" } } });
  const before = nodeFs.readFileSync(f.paths.triggersPath, "utf8");
  const planned = await preview(f, { ...body, fallbackModels: ["openai/backup", "anthropic/new"] });
  assert.equal(nodeFs.readFileSync(f.paths.triggersPath, "utf8"), before);
  assert.deepEqual(planned.plan.affected, [0, 1]);
  assert.match(planned.summary.join(" "), /Trigger rows 1, 2.*next delivery/);
  assert.match(planned.summary.join(" "), /Nothing runs now.*Recovery keeps/);
  assert.doesNotMatch(planned.beforeText + planned.afterText, /private-value|secretBundles|triggers/);
  assert.deepEqual(await f.service.apply(planned, operator), { ok: true });
  const after = f.read();
  assert.deepEqual(after.triggers, f.doc.triggers);
  assert.deepEqual(after.retained, f.doc.retained);
  assert.deepEqual(after.modelRoles.default.editor, { model: "openai/new", fallbackModels: ["openai/backup", "anthropic/new"] });
  for (const t of after.triggers) {
    const selected = resolveModelRoles(t.run, parseTriggersDocument(JSON.stringify(after)).modelRoles);
    assert.equal(selected.model, "new"); assert.equal(selected.provider, "openai");
    assert.deepEqual(selected.fallbackModels, ["openai/backup", "anthropic/new"]);
  }
});

test("Undo restores exact absent, string and object entries and refuses a subsequently changed mapping", async () => {
  for (const previous of [undefined, "openai/old", { model: "openai/old" }, { model: "openai/old", fallbackModels: ["anthropic/old", "openai/backup"] }]) {
    const original = previous === undefined ? { triggers: [] } : { modelRoles: { default: { editor: previous } }, triggers: [trigger()] };
    const f = fixture({ doc: original });
    const p = await preview(f);
    assert.deepEqual(await f.service.apply(p, operator), { ok: true });
    const u = await preview(f, p.plan.inverseBody);
    assert.deepEqual(await f.service.apply(u, operator), { ok: true });
    assert.deepEqual(f.read(), original);
    const p2 = await preview(f);
    await f.service.apply(p2, operator);
    f.write({ ...f.read(), modelRoles: { default: { editor: "anthropic/new" } } });
    assert.match((await f.service.preview(p2.plan.inverseBody, operator)).refusal, /role changed/);
  }
});

test("removing an override reveals the default; removing the effective last mapping is refused", async () => {
  const f = fixture({ doc: { modelRoles: { default: { editor: "openai/old" }, web: { editor: "openai/new" } }, triggers: [trigger()] }, projects: [{ id: "web", members: ["github:acme/web"] }] });
  const p = await preview(f, { scope: "web", role: "editor", remove: true });
  assert.deepEqual(p.plan.affected, [0]);
  await f.service.apply(p, operator);
  assert.equal(resolveModelRoles(f.read().triggers[0].run, f.read().modelRoles, "web").model, "old");
  assert.match((await f.service.preview({ scope: "default", role: "editor", remove: true }, operator)).refusal, /no longer be declared/);
});

test("every scope union is checked even with no consumers and a literal trigger can overflow", async () => {
  const defaultRoles = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`r${index}`, `openai/m${index}`]));
  const projectRoles = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`p${index}`, `openai/m${index + 12}`]));
  const noConsumers = fixture({ doc: { modelRoles: { default: defaultRoles, dormant: projectRoles }, triggers: [] } });
  assert.match((await noConsumers.service.preview({ scope: "default", role: "r0", model: "openai/new" }, operator)).refusal, /16 distinct models/);
  const refs = Array.from({ length: 16 }, (_, index) => `openai/m${index}`);
  const f = fixture({ doc: { modelRoles: { default: { editor: "openai/m0" } }, triggers: [trigger({ provider: "openai", model: "m0", models: refs })] } });
  assert.match((await f.service.preview(body, operator)).refusal, /Trigger row 1.*16 models/);
  const exact = fixture({ doc: { modelRoles: { default: { editor: "openai/m0" } }, triggers: [trigger({ provider: "openai", model: "m0", models: refs.slice(0, 15) })] } });
  assert.ok((await exact.service.preview(body, operator)).plan, "16 distinct effective refs is valid");
});

test("all reachable forge project policies, provider clashes and both fallback owners are checked", async () => {
  const f = fixture({ doc: { modelRoles: { default: { editor: "openai/old" }, web: { editor: "anthropic/old" } }, triggers: [trigger({ provider: "openai" })] }, projects: [{ id: "web", members: ["github:acme/web"] }] });
  assert.match((await f.service.preview(body, operator)).refusal, /provider.*clashes/);
  const fallbacks = fixture({ doc: { modelRoles: { default: { editor: "openai/old" } }, triggers: [trigger({ models: ["openai/old", "openai/new", "openai/backup"], fallbackModels: ["openai/backup"] })] } });
  assert.match((await fallbacks.service.preview({ ...body, fallbackModels: ["openai/backup"] }, operator)).refusal, /conflicting role and trigger fallbacks/);
});

test("the confirmation names literal and other-role jobs whose executable policy changes", async () => {
  const f = fixture({ doc: { modelRoles: { default: { editor: "openai/old", reviewer: "openai/backup" } }, triggers: [trigger(), { on: { type: "label", any: ["triage"] }, run: { kind: "github", model: "backup", provider: "openai", flow: "triage" } }, { on: { type: "label", any: ["review"] }, run: { kind: "github", model: "role:reviewer", flow: "review" } }] } });
  const p = await preview(f);
  assert.deepEqual(p.plan.affected, [0, 1, 2]);
  assert.match(p.summary.join(" "), /Trigger row 1 uses.*next delivery/);
  assert.match(p.summary.join(" "), /Trigger rows 2, 3 keep their selected model and fallback order, but the allowed-model list or role aliases change/);
  assert.deepEqual(await f.service.apply(p, operator), { ok: true });
  for (const index of [1, 2]) {
    const before = resolveModelRoles(f.doc.triggers[index].run, f.doc.modelRoles);
    const after = resolveModelRoles(f.read().triggers[index].run, f.read().modelRoles);
    assert.equal(after.model, before.model);
    assert.equal(after.provider, before.provider);
    assert.equal(before.models.includes("openai/new"), false);
    assert.equal(after.models.includes("openai/new"), true);
    assert.equal(after.modelRoles.editor, "openai/new");
  }
});

test("a changed child role alias is named even when its physical models were already allowed", async () => {
  const f = fixture({ doc: { modelRoles: { default: { editor: "openai/old", reviewer: "openai/new" } }, triggers: [trigger({ model: "role:reviewer", models: ["openai/old", "openai/new"] })] } });
  const p = await preview(f);
  assert.deepEqual(p.plan.affected, [0]);
  assert.match(p.summary.join(" "), /No current trigger changes its selected model.*Trigger row 1 keeps its.*role aliases change/);
});

test("invalid and unknown models, disallowed fields, duplicate fallbacks and reserved roles refuse", async () => {
  const f = fixture();
  for (const params of [
    { ...body, model: "openai/unknown" }, { ...body, model: "role:editor" },
    { ...body, fallbackModels: ["openai/backup", "OPENAI/BACKUP"] },
    { ...body, role: "inherit" }, { ...body, role: "constructor" },
    { ...body, entry: { model: "openai/old", extra: true }, model: undefined },
    { ...body, fallbackModels: Array.from({ length: 17 }, (_, index) => `openai/m${index}`) },
    { ...body, unknown: "private" },
  ]) assert.ok((await f.service.preview(params, operator)).refusal, JSON.stringify(params));
  const legacy = fixture({ doc: { modelRoles: { default: { editor: "openai/old", unused: "openai/unknown" } }, triggers: [trigger()] } });
  assert.match((await legacy.service.preview(body, operator)).refusal, /unknown/);
  assert.deepEqual(f.read(), f.doc);
});

test("the pinned catalog and actual operator overlay validate new models without a custom oracle", async () => {
  const f = fixture({ doc: { triggers: [] }, checkModelsKnown: undefined, overlay: { providers: { custom: { baseUrl: "https://models.example/v1", apiKey: "CUSTOM_KEY", api: "openai-completions", models: [{ id: "declared", name: "Declared", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } } });
  const real = createModelRoleActions({ paths: f.paths, env: {}, now: () => NOW });
  assert.ok((await real.preview({ ...body, model: "custom/declared" }, operator)).plan);
  assert.match((await real.preview({ ...body, model: "custom/unknown" }, operator)).refusal, /unknown/);
  assert.ok((await real.preview({ ...body, model: "anthropic/claude-sonnet-5-5" }, operator)).plan);
});

test("every policy dependency and environment is rechecked at confirm, including creation of a missing overlay", async () => {
  for (const input of ["triggersPath", "settingsFile", "projectsFile", "models"]) {
    const f = fixture({ projects: [{ id: "web", members: ["github:acme/web"] }], overlay: { providers: {} } });
    const p = await preview(f);
    const path = input === "models" ? join(f.paths.globalPiDir, "models.json") : f.paths[input];
    nodeFs.appendFileSync(path, " ");
    assert.match((await f.service.apply(p, operator)).invalid, /changed/);
    assert.equal(f.read().modelRoles.default.editor, "openai/old");
  }
  const env = { PI_MODEL: "old", PI_PROVIDER: "openai" };
  const f = fixture({ env });
  const p = await preview(f); env.PI_MODEL = "new";
  assert.match((await f.service.apply(p, operator)).invalid, /environment changed/);
  const missing = fixture();
  missing.paths.globalPiDir = join(missing.dir, "later-overlay");
  const service = createModelRoleActions({ paths: missing.paths, env: {}, now: () => NOW, checkModelsKnown: knownCheck });
  const first = await service.preview(body, operator); assert.ok(first.plan);
  nodeFs.mkdirSync(missing.paths.globalPiDir); nodeFs.writeFileSync(join(missing.paths.globalPiDir, "models.json"), '{"providers":{}}');
  assert.match((await service.apply(first, operator)).invalid, /changed/);
});

test("confirm binds effective folder attribution even when every policy file is unchanged", async () => {
  let resolved = "/work/one";
  const fs = { ...nodeFs, realpathSync() { return resolved; } };
  const f = fixture({ fs, doc: { modelRoles: { default: { editor: "openai/old" }, two: { editor: "openai/old" } }, triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", flow: "fix", folder: "/work/current", task: "Review", model: "role:editor" } }] }, projects: [{ id: "one", members: ["/work/one"] }, { id: "two", members: ["/work/two"] }] });
  const request = { ...body, scope: "two" };
  const p = await preview(f, request);
  assert.deepEqual(p.plan.affected, [], "the initial folder does not consume the edited project override");
  const bytes = nodeFs.readFileSync(f.paths.triggersPath, "utf8");
  resolved = "/work/two";
  const current = await preview(f, request);
  assert.deepEqual(current.plan.affected, [0], "the moved folder would change the trigger's next delivery");
  assert.notEqual(current.payload.effectDigest, p.payload.effectDigest);
  assert.match((await f.service.apply(p, operator)).invalid, /effective trigger scopes.*changed/);
  assert.equal(nodeFs.readFileSync(f.paths.triggersPath, "utf8"), bytes);
  assert.deepEqual(await f.service.apply(current, operator), { ok: true }, "a newly reviewed attribution is accepted");
});

test("the shared writer refuses a live lock and preserves the policy on parse and write failures", async () => {
  const f = fixture();
  const p = await preview(f);
  nodeFs.writeFileSync(`${f.paths.triggersPath}.lock`, "");
  nodeFs.utimesSync(`${f.paths.triggersPath}.lock`, NOW / 1000, NOW / 1000);
  assert.match((await f.service.apply(p, operator)).invalid, /locked/);
  nodeFs.unlinkSync(`${f.paths.triggersPath}.lock`);
  assert.deepEqual(f.read(), f.doc);
  f.write({ modelRoles: { default: { editor: "openai/old" } }, triggers: [] });
  nodeFs.writeFileSync(f.paths.triggersPath, '{"triggers":[],"modelRoles":{},"modelRoles":{}}');
  assert.match((await f.service.preview(body, operator)).refusal, /could not be validated/);
  assert.equal(nodeFs.readdirSync(f.dir).some(name => name.endsWith(".lock") || name.endsWith(".tmp")), false);
});

test("adoption binds retained server numbers and rechecks the sample instead of trusting request metrics", async () => {
  let digest = "a".repeat(64);
  const sample = () => ({ digest, candidateStats: { runs: 2, completed: 1, costPerRun: 0.02, knownCosts: 2, averageTurns: 4, knownTurns: 2, averageTokens: 120, knownTokens: 2 }, sourceStats: { runs: 2, completed: 2, costPerRun: 0.04, knownCosts: 2, averageTurns: 5, knownTurns: 2, averageTokens: 150, knownTokens: 2 } });
  let calls = 0;
  const f = fixture({ canarySample: async tuple => { assert.deepEqual(tuple, { role: "editor", candidate: "openai/new", flow: "fix" }); calls++; return sample(); } });
  const adopted = { ...body, canary: { role: "editor", candidate: "openai/new", flow: "fix", digest } };
  const p = await preview(f, adopted);
  assert.equal(calls, 1);
  assert.match(p.summary.join(" "), /Candidate: 1\/2 completed.*0.020000.*Sources: 2\/2 completed.*0.040000/);
  digest = "b".repeat(64);
  assert.match((await f.service.apply(p, operator)).invalid, /comparison changed/);
  assert.deepEqual(f.read(), f.doc);
  assert.match((await f.service.preview({ ...adopted, canary: { ...adopted.canary, runs: 100 } }, operator)).refusal, /comparison does not match/);
});

test("person-only checks happen before private reads for direct planners and action entry points", async () => {
  let reads = 0;
  const service = createModelRoleActions({ paths: { triggersPath: "/must-not-read" }, fs: { lstatSync() { reads++; assert.fail("private read"); } } });
  for (const ctx of [{ role: "agent", surface: "console" }, { role: "viewer", surface: "console" }, { role: "operator", surface: "tool" }, undefined]) {
    assert.equal((await service.preview(body, ctx)).status, 403);
    assert.match((await service.apply({ payload: { body } }, ctx)).invalid, /Only a person/);
  }
  const action = ACTIONS.find(action => action.name === "model-role-edit");
  assert.deepEqual(action.agent.tools, []);
  for (const role of ["viewer", "agent"]) {
    assert.equal(authorizeTransition({ actor: { role }, action, surface: "tool", granted: true, interactive: true }).ok, false);
    const out = await action.preview(body, { session: { role }, a: { modelRoles: { preview() { reads++; assert.fail("private planner"); } } } });
    assert.equal(out.status, 403);
  }
  const out = await previewAction({ deps: { actionDeps: { modelRoles: service } }, session: { role: "agent", id: "a" }, body, json: (status, body) => ({ status, body }) }, action);
  assert.equal(out.status, 403); assert.equal(reads, 0);
});
