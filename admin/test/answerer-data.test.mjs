import { answerRuleConfigDigest } from "@edgehero/pi-dispatch/answerer";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeAnswererService, answererStats } from "../src/answerer-data.mjs";
import { planStandingAnswerAdd, applyStandingAnswerAdd, planAnswerDraftDrop } from "../src/answerer-actions.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { answererFixture } from "./helpers/answerer-goldens.mjs";

const AT = Date.parse("2026-10-31T12:00:00Z");
const fixture = answererFixture(AT);
const setup = ({ env = {}, source = {} } = {}) => {
  const dir = tempDir("answerer-data-");
  const paths = { triggersPath: join(dir, "triggers.json"), valkeyUrl: "redis://example.invalid" };
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [], answerRules: fixture.rules, standingAnswers: fixture.standing.map(({ used, ...answer }) => answer) }));
  const doc = JSON.parse(readFileSync(paths.triggersPath));
  let privateReads = 0;
  const store = { privateInput: async () => ({ runId: fixture.privateDraft.meta.runId, ruleId: fixture.rules[0].id, configDigest: answerRuleConfigDigest(doc, fixture.rules[0]), project: "web", source: { kind: "github", repo: "acme/web", apiUrl: "https://api.github.com", target: { type: "issue", number: 512 }, ...source } }), publicSnapshot: async () => fixture, privateDraft: async () => { privateReads++; return structuredClone(fixture.privateDraft); }, drop: async () => true, markSent: async () => true };
  const service = makeAnswererService({ paths, env, now: () => AT, redisFn: () => ({ disconnect() {} }), storeFn: () => store });
  return { paths, service, store, privateReads: () => privateReads };
};

test("viewer and agent answerer projections never read or contain private question, draft, sources, decisions or configuration", async () => {
  const { service, privateReads } = setup();
  for (const role of ["viewer", "agent", "unknown"]) {
    const got = await service.read({ role, runId: "gh-6e1d" });
    assert.equal(privateReads(), 0);
    assert.deepEqual(Object.keys(got), ["state", "partial", "rows"]);
    assert.equal(got.rows[0].draftExists, true);
    assert.equal(got.rows[2].sentBy, "ops");
    const serialized = JSON.stringify(got);
    for (const privateText of [fixture.privateDraft.question, fixture.privateDraft.draft, "CONTRIBUTING", "confidence", "category", "standing", "known-conventions"]) assert.ok(!serialized.includes(privateText), privateText);
  }
});

test("only an operator's selected run receives draft bytes; its draft run resolves the same retained source", async () => {
  const { service, privateReads } = setup();
  const list = await service.read({ role: "operator" });
  assert.equal(privateReads(), 0);
  assert.ok(!Object.hasOwn(list, "privateDraft"));
  assert.equal(list.standing[0].used, 2);
  assert.equal((await service.read({ role: "operator", runId: "gh-a07c" })).privateDraft.draft, fixture.privateDraft.draft);
  assert.equal(privateReads(), 1);
});

test("completed drafts remain bound to the current configured HTTPS forge base for offer, prefill and sent accounting", async () => {
  const cases = [
    { kind: "github", source: "https://API.GITHUB.COM/", env: {}, allowed: true },
    { kind: "github", source: "https://other.invalid", env: {}, allowed: false },
    { kind: "gitlab", source: "https://old.invalid/team", env: { GITLAB_TOKEN: "synthetic", GITLAB_URL: "https://new.invalid/team" }, allowed: false },
    { kind: "gitlab", source: "https://GITLAB.invalid/team/", env: { GITLAB_TOKEN: "synthetic", GITLAB_URL: "https://gitlab.invalid/team" }, allowed: true },
    { kind: "gitlab", source: "https://gitlab.com/", env: { GITLAB_TOKEN: "synthetic" }, allowed: true },
    { kind: "gitlab", source: "https://gitlab.invalid/team", env: { GITLAB_TOKEN: "synthetic", GITLAB_URL: "https://gitlab.invalid/other" }, allowed: false },
    { kind: "gitlab", source: "https://gitlab.invalid/team/api/v4", env: { GITLAB_TOKEN: "synthetic", GITLAB_URL: "https://gitlab.invalid/team" }, allowed: false },
    { kind: "gitlab", source: "https://gitlab.invalid/team", env: { GITLAB_URL: "https://gitlab.invalid/team" }, allowed: false },
    { kind: "forgejo", source: "https://forge.invalid/base", env: { FORGEJO_TOKEN: "synthetic", FORGEJO_URL: "https://FORGE.invalid/base///" }, allowed: true },
    { kind: "forgejo", source: "https://forge.invalid/base/api/v1", env: { FORGEJO_TOKEN: "synthetic", FORGEJO_URL: "https://forge.invalid/base" }, allowed: false },
    { kind: "azure", source: "https://DEV.AZURE.COM/org/", env: { AZURE_TOKEN: "synthetic", AZURE_ORG_URL: "https://dev.azure.com/org" }, allowed: true },
    { kind: "azure", source: "https://dev.azure.com/old", env: { AZURE_TOKEN: "synthetic", AZURE_ORG_URL: "https://dev.azure.com/new" }, allowed: false },
    { kind: "azure", source: "http://dev.azure.com/org", env: { AZURE_TOKEN: "synthetic", AZURE_ORG_URL: "http://dev.azure.com/org" }, allowed: false },
  ];
  for (const scenario of cases) {
    const { service, store } = setup({ env: scenario.env, source: { kind: scenario.kind, apiUrl: scenario.source } });
    let sent = 0; store.markSent = async () => { sent++; return true; };
    const result = await service.read({ role: "operator", runId: fixture.privateDraft.meta.runId });
    assert.equal(Boolean(result.privateDraft), scenario.allowed, `${scenario.kind} configured base binding`);
    assert.equal(Boolean(await service.privateDraft(fixture.privateDraft.meta.runId)), scenario.allowed);
    assert.equal(await service.sent({ runId: fixture.privateDraft.meta.runId, draftRunId: fixture.privateDraft.meta.draftRunId, digest: fixture.privateDraft.digest, text: fixture.privateDraft.draft, by: "ops" }), scenario.allowed);
    assert.equal(sent, scenario.allowed ? 1 : 0);
    if (!scenario.allowed) {
      assert.equal(result.privateDraftProblem, "config-changed");
      const problem = JSON.stringify(result.privateDraftProblem);
      assert.ok(!problem.includes(scenario.source), "The refusal never includes a private forge URL");
    }
  }
});

test("standing adoption previews exact scoped text and refuses stale, duplicate, unscoped or nonperson writes", () => {
  const { paths } = setup();
  const params = { title: "Reviewed convention", text: "Use the existing test helper.\nRun the full suite.", projects: ["api"], repo: "github:acme/api" };
  const got = planStandingAnswerAdd({ params, paths });
  assert.ok(got.plan);
  assert.ok(got.plan.afterText.includes("Reviewed convention"));
  assert.equal(JSON.parse(readFileSync(paths.triggersPath)).standingAnswers.length, 1, "Preview writes nothing");
  assert.ok(planStandingAnswerAdd({ params, paths, surface: "tool" }).refusal);
  assert.ok(planStandingAnswerAdd({ params: { ...params, projects: [] }, paths }).refusal);
  writeFileSync(paths.triggersPath, `${readFileSync(paths.triggersPath)}\n`);
  assert.ok(applyStandingAnswerAdd({ plan: got.plan, paths }).invalid, "Never overwrite a file changed after preview");
  const fresh = planStandingAnswerAdd({ params, paths }).plan;
  assert.equal(applyStandingAnswerAdd({ plan: fresh, paths }).ok, true);
  assert.ok(planStandingAnswerAdd({ params, paths }).unchanged);
});

test("drop is bound to the exact retained draft and never accepts an arbitrary model result", () => {
  const draft = fixture.privateDraft;
  const params = { runId: draft.meta.runId, draftRunId: draft.meta.draftRunId, digest: draft.digest };
  assert.ok(planAnswerDraftDrop({ params, draft }).plan);
  for (const bad of [{ ...params, digest: "f".repeat(64) }, { ...params, draftRunId: "another-draft" }, { ...params, runId: "another-source" }]) assert.ok(planAnswerDraftDrop({ params: bad, draft }).refusal);
  assert.ok(planAnswerDraftDrop({ params, draft, surface: "tool" }).refusal);
  assert.ok(planAnswerDraftDrop({ params, draft: null }).refusal);
});

test("sent accounting binds the exact body digest and reports a concurrent terminal transition", async () => {
  const { service, store } = setup(), draft = fixture.privateDraft, writes = [];
  store.markSent = async (runId, fields) => { writes.push({ runId, fields }); return writes.length === 1; };
  const params = { runId: draft.meta.runId, draftRunId: draft.meta.draftRunId, digest: draft.digest, text: draft.draft, by: "ops" };
  assert.equal(await service.sent({ ...params, digest: "f".repeat(64) }), false);
  assert.equal(writes.length, 0, "An unrelated body never changes retained accounting");
  assert.equal(await service.sent(params), true);
  assert.deepEqual(writes[0], { runId: params.runId, fields: { by: "ops", at: AT, draftRunId: params.draftRunId, draftDigest: draft.digest, disposition: "as-drafted" } });
  assert.equal(await service.sent({ ...params, text: "An edited answer." }), false, "A store CAS refusal is returned to the caller");
  assert.equal(writes[1].fields.disposition, "edited");
});

test("retained answerer statistics distinguish human sends, edits, drops and passes with an injected clock", () => {
  const stats = answererStats([...fixture.rows, { ...fixture.rows[0], at: AT - 31 * 86400000, disposition: "edited" }], AT);
  assert.equal(stats.sent, 1);
  assert.equal(stats.edited, 0);
  assert.equal(stats.passed, 1);
  assert.equal(stats.jobs, 3);
  assert.ok(Math.abs(stats.costUsd - 0.009) < 1e-9);
});
