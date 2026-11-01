import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { loadPageData, renderPage, pagePanels, parsePageQuery, returnPathOf, pageQueryString } from "../src/console/pages.mjs";
import { setupState, setupFacts, SETUP_ACTIONS, SETUP_REASON_TEXT } from "../src/setup-view.mjs";
import { TRIGGER_RECIPES } from "../src/trigger-recipes.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { runConsoleScript, parseDocument, trapGlobalFetch } from "./helpers/script-dom.mjs";
import { planTriggerAdd } from "../src/write-plans.mjs";
import { writeTriggers } from "../src/read-model.mjs";

const NOW = Date.UTC(2026, 10, 1, 12);
export const setupSnapshot = () => ({ readAt: NOW, runs: [], runsDay: { runs: [], partial: false }, hostBudgets: [], queue: { workers: 0 }, triggers: { triggers: [] }, doctor: { hosts: [{ name: "build3", ageMs: 60_000, every: 24, checks: [{ id: "egress.proxy", level: "fail" }, { id: "provider.key", level: "fail" }] }] } });
const facts = () => ({ enabled: true, actions: [...SETUP_ACTIONS], providerKey: "ANTHROPIC_API_KEY", allowlistCount: 12, progress: [] });
async function draw({ role = "operator", readOnly = false, snapshot = setupSnapshot(), setup = facts() } = {}) {
  const data = await loadPageData("setup", {}, { now: () => NOW, deployment: { folder: "pi-dispatch" }, fleet: { snapshot: async () => snapshot }, setup: () => setup }, { role });
  const ctx = { data, session: { name: "private-session-name", role }, readOnly, query: {} };
  return { data, ctx, page: String((await renderPage("setup", ctx)).html) };
}

test("setup GET reads only safe facts once, remains a direct destination and renders the same live panels", async () => {
  const calls = [];
  const data = await loadPageData("setup", {}, { now: () => NOW, deployment: { folder: "deploy" }, fleet: { snapshot: async () => { calls.push("snapshot"); return setupSnapshot(); } }, setup: ({ role, snapshot }) => { assert.equal(role, "operator"); assert.ok(snapshot); calls.push("setup"); return facts(); }, modelsView: () => assert.fail("unrelated expensive read"), connections: () => assert.fail("no unrelated host read") }, { role: "operator" });
  assert.deepEqual(calls, ["snapshot", "setup"]);
  assert.equal(returnPathOf("/setup"), "/setup");
  assert.ok(parsePageQuery("setup", "command=whoami").refusal);
  const { ctx, page } = await draw({ snapshot: { ...setupSnapshot(), runs: [{ jobId: "gh-existing" }] } });
  assert.match(page, /Getting ready/);
  for (const panel of await pagePanels("setup", ctx)) assert.ok(page.includes(panel.html), `initial/live ${panel.id} use identical markup`);
  assert.ok(data.setup.actions.includes("setup-worker-start"));
});

test("setup role/read-only projections withhold mutation fields, names and endpoint addresses", async () => {
  const operator = await draw();
  assert.match(operator.page, /data-action="setup-worker-start"/);
  assert.match(operator.page, /href="\/config\/connections#p-provider-keys"/);
  assert.doesNotMatch(operator.page, /data-action="setup-provider-key/);
  const doc = parseDocument(operator.page);
  for (const form of doc.querySelectorAll("form[data-action]")) assert.equal(form.querySelector("fieldset").disabled, true, "no-script mutations start disabled");
  for (const role of ["viewer", "agent"]) {
    const got = await draw({ role });
    assert.doesNotMatch(got.page, /data-action="setup-|type="password"|name="value"|ANTHROPIC_API_KEY/);
    assert.deepEqual(got.data.setup.actions, []);
    assert.equal(got.data.setup.providerKey, null);
    for (const panel of await pagePanels("setup", got.ctx)) assert.doesNotMatch(panel.html, /private-session-name|redis:\/\//, "shared panels never carry a sign-in name or endpoint");
  }
  const ro = await draw({ readOnly: true });
  assert.doesNotMatch(ro.page, /data-action="setup-|type="password"/);
  assert.match(ro.page, /In a terminal instead/);
  assert.match(ro.page, /read-only/);
});

test("the lack of host authority keeps terminal recovery without inventing available actions", async () => {
  const got = await draw({ setup: { ...facts(), enabled: false, reason: "unsafe-entry" } });
  assert.doesNotMatch(got.page, /data-action="setup-/);
  assert.ok(got.page.includes(SETUP_REASON_TEXT["unsafe-entry"]));
  assert.match(got.page, /In a terminal instead/);
  assert.equal(setupFacts({ ...facts(), actions: ["arbitrary-shell"], progress: [{ step: "worker", state: "starting", stage: "secret-output", reason: "secret-output", text: "private" }] }, { role: "operator" }).progress[0].stage, null);
  assert.doesNotMatch(JSON.stringify(setupFacts({ ...facts(), reason: "secret-output", actions: ["arbitrary-shell"], progress: [{ step: "worker", state: "starting", stage: "secret-output", text: "private" }] }, { role: "operator" })), /secret-output|private|arbitrary-shell/);
});

test("actual Starting never substitutes for published readiness; expiry and partial observations stay explicit", () => {
  const s = setupSnapshot();
  const options = { role: "operator", deployment: { folder: "deploy" }, now: NOW, facts: { ...facts(), progress: [{ step: "worker", state: "starting", stage: "waiting-heartbeat", atMs: NOW - 10_000 }] } };
  assert.equal(setupState(s, options).steps.find(step => step.id === "worker").state, "starting");
  assert.equal(setupState(s, { ...options, now: NOW + 90_001 }).steps.find(step => step.id === "worker").state, "check");
  s.hostBudgets = [{ name: "build3", ttlAgeMs: 1000 }];
  assert.equal(setupState(s, options).steps.find(step => step.id === "worker").state, "starting", "a previously healthy beat cannot finish a new start");
  const freshOptions = { ...options, facts: { ...options.facts, progress: [{ step: "worker", state: "applied", stage: "complete", atMs: NOW }] } };
  assert.equal(setupState(s, freshOptions).steps.find(step => step.id === "worker").state, "ready", "the backend first proves the new action has a fresh beat");
  const timeoutOptions = { ...options, facts: { ...options.facts, progress: [{ step: "worker", state: "timeout", stage: "complete", atMs: NOW }] } };
  assert.equal(setupState(s, timeoutOptions).steps.find(step => step.id === "worker").state, "check", "a timeout cannot revive an older ready observation");
  s.doctor.hosts[0].checks = [{ id: "provider.key", level: "ok" }, { id: "egress.proxy", level: "ok" }];
  assert.equal(setupState(s, options).steps.find(step => step.id === "provider").state, "ready", "a managed subscription can satisfy the same published provider check");
  s.doctor.hosts[0].ageMs = 49 * 3600_000;
  assert.equal(setupState(s, options).steps.find(step => step.id === "provider").state, "check");
  s.doctor.hosts[0].ageMs = 1000; s.doctor.partial = true;
  assert.equal(setupState(s, options).steps.find(step => step.id === "provider").state, "check");
  assert.doesNotMatch(JSON.stringify(setupState(setupSnapshot(), options)), /Jobs use this host's pi login|Nothing starts a job until/);
});

test("recipe query is closed and round-trips; hostile or repeated parameters cannot become editable defaults", () => {
  for (const recipe of Object.keys(TRIGGER_RECIPES)) {
    const parsed = parsePageQuery("trigger-add", `recipe=${recipe}`);
    assert.deepEqual(parsed.query, { recipe });
    assert.equal(pageQueryString("trigger-add", parsed.query), `recipe=${recipe}`);
  }
  for (const query of ["recipe=", "recipe=nope", "recipe=label-fix&recipe=comment-answer", `recipe=${"x".repeat(257)}`, "recipe=label-fix&value=secret", "recipe=%3Cscript%3E"]) assert.ok(parsePageQuery("trigger-add", query).refusal, query);
});

for (const [id, recipe] of Object.entries(TRIGGER_RECIPES)) test(`recipe ${id}: editable browser fields reach the real planner and expected-input writer`, () => trapGlobalFetch(async () => {
  const dir = tempDir("setup-recipe-"), path = join(dir, "triggers.json");
  writeFileSync(path, JSON.stringify({ triggers: [] }));
  const query = parsePageQuery("trigger-add", `recipe=${id}`).query;
  const data = await loadPageData("trigger-add", query, { now: () => NOW, fleet: { snapshot: async () => setupSnapshot() }, triggerEditor: () => ({ forges: ["github"], backends: [], flows: ["fix", "tidy"], defaults: {} }) }, { role: "operator" });
  const markup = String((await renderPage("trigger-add", { data, query, session: { name: "ops", role: "operator" } })).html);
  const w = runConsoleScript(CONSOLE_SCRIPT, markup, { url: `/config/trigger-add?recipe=${id}` });
  const form = w.document.querySelector('form[data-structured="trigger"]');
  assert.equal(form.querySelector('[name="kind"]').value, recipe.fields.kind);
  assert.equal(form.querySelector('[name="flow"]').value, recipe.fields.flow);
  form.querySelector('[name="flow"]').value = "review";
  if (recipe.fields.kind === "cron") { form.querySelector('[name="folder"]').value = dir; form.querySelector('[name="task"]').value = "Review repository maintenance"; }
  w.submit(form);
  const request = w.fetch.open("/api/act/trigger-add/preview");
  const params = request.body.trigger;
  assert.equal(params.flow, "review", "edits override the recipe");
  assert.equal(params.kind, recipe.fields.kind);
  if (params.kind === "label") assert.deepEqual(params.labels, ["pi:fix"]);
  if (params.kind === "comment") assert.equal(params.phrase, "@pi");
  if (params.kind === "cron") { assert.equal(params.pattern, "0 2 * * *"); assert.equal(params.folder, dir); }
  const before = readFileSync(path, "utf8");
  const planned = planTriggerAdd({ params, paths: { triggersPath: path }, env: { PI_BACKENDS: "local" } });
  assert.ok(planned.plan, planned.refusal);
  assert.equal(readFileSync(path, "utf8"), before, "GET and preview do not save or arm a trigger");
  const written = writeTriggers({ triggersPath: path, mutate: planned.plan.mutate, expect: planned.plan.expect });
  assert.equal(written.ok, true, written.invalid);
  const saved = JSON.parse(readFileSync(path, "utf8")).triggers[0];
  assert.equal(saved.run.flow, "review");
  assert.equal(saved.on.type, recipe.fields.kind);
  assert.equal(saved.run.secretBundle, false, "a recipe cannot grant project secrets");
  if (params.kind === "label") assert.deepEqual(saved.on.any, ["pi:fix"]);
  if (params.kind === "comment") assert.equal(saved.on.phrase, "@pi");
  await request.answer(400, { refusal: "Synthetic preview ended without a confirm." });
}));


test("the setup stylesheet is copied exactly from the source generator before page scoping", async () => {
  const { SETUP_CSS } = await import("../src/console/setup-css.mjs");
  const source = readFileSync(new URL("../../design/tools/gen_access.py", import.meta.url), "utf8");
  assert.equal(SETUP_CSS, /SETUP_CSS = """([^]*?)"""/.exec(source)?.[1]);
});


test("doctor failures and uncertain effects remain visible even beside already-ready steps", async () => {
  const setup = facts();
  setup.progress = [{ step: "doctor", state: "unknown", stage: "complete", atMs: NOW, reason: "readback-unavailable" }, { step: "worker", state: "partial", stage: "complete", atMs: NOW, reason: "process-timeout" }];
  const snapshot = setupSnapshot(); snapshot.hostBudgets = [{ name: "build3", ttlAgeMs: 1000 }];
  const got = await draw({ setup, snapshot });
  assert.match(got.page, /Doctor: Outcome unknown/);
  assert.match(got.page, /Host operation: Partly applied/);
  assert.match(got.page, /Inspect the host before retrying|Inspect its effects before retrying/);
});
