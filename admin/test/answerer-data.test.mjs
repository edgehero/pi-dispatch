import { answerRuleConfigDigest } from "@edgehero/pi-dispatch/answerer";
import { FORGE_KINDS } from "@edgehero/pi-dispatch/forges";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DRAFT_DROP_UNCONFIRMED, makeAnswererService, answererStats } from "../src/answerer-data.mjs";
import { planStandingAnswerAdd, applyStandingAnswerAdd, planAnswerDraftDrop } from "../src/answerer-actions.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { answererRules } from "../src/console/panels/answerer.mjs";
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

test("the service's client carries an error listener, so an outage outlasting a call is not a stack trace per reconnect attempt", async () => {
  const dir = tempDir("answerer-data-");
  const paths = { triggersPath: join(dir, "triggers.json"), valkeyUrl: "redis://example.invalid" };
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [] }));
  const heard = [];
  const service = makeAnswererService({ paths, now: () => AT, redisFn: () => ({ on(event) { heard.push(event); }, disconnect() {} }), storeFn: () => ({ publicSnapshot: async () => ({ partial: false, rows: [] }) }) });
  await service.read({ role: "viewer" }).catch(() => {});
  assert.deepEqual(heard, ["error"]);
  const seam = makeAnswererService({ paths, now: () => AT, redisFn: () => ({ disconnect() {} }), storeFn: () => ({ publicSnapshot: async () => ({ partial: false, rows: [] }) }) });
  await seam.read({ role: "viewer" });
});

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

test("an operator's rule view names a rule's declared provider keys, apart the ones its draft jobs do not receive, and never their references (issue #1013)", async () => {
  const { paths, service } = setup();
  const doc = JSON.parse(readFileSync(paths.triggersPath));
  const reference = "op://ci/rule-openai-reference";
  doc.answerRules[0] = { ...doc.answerRules[0], model: "openai/gpt-5-mini", decisionModel: "openrouter/typesafe/jev-1.13", secrets: { OPENAI_API_KEY: reference, OPENROUTER_API_KEY: "op://ci/or", ANTHROPIC_API_KEY: "op://ci/anthropic" }, secretsProfile: "vault" };
  writeFileSync(paths.triggersPath, JSON.stringify({ version: 12, ...doc }));
  const got = await service.read({ role: "operator" });
  assert.deepEqual(got.rules[0].secretNames, ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]);
  assert.deepEqual(got.rules[0].secretsNotPassed, ["ANTHROPIC_API_KEY"], "neither model runs on anthropic");
  assert.equal(got.rules[0].secretsProfile, "vault");
  assert.equal(JSON.stringify(got).includes(reference), false);
  const page = String(answererRules({ role: "operator", page: "answer-rules", data: { answerer: got } }));
  assert.equal(page.includes(reference), false, "the rule's JSON on its page carries the names alone");
  assert.match(page, /<dt>Keys<\/dt><dd>OPENAI_API_KEY and OPENROUTER_API_KEY, declared in the rule&#39;s own secrets and passed to its draft jobs; references are not shown<\/dd>/);
  assert.match(page, /<dt>Not passed<\/dt><dd>ANTHROPIC_API_KEY: declared, but neither of the rule&#39;s models runs on a provider that reads it, so the draft jobs do not receive it<\/dd>/);
  assert.equal(page.includes("secretsNotPassed"), false, "the rule's JSON is the rule's fields, not the page's reading of them");
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

test("a draft's source is a forge exactly when FORGE_KINDS names it, and the source check holds no copy of the list", async () => {
  for (const kind of ["local", "bitbucket", "constructor", "GitHub"]) {
    const { service } = setup({ source: { kind } });
    assert.equal((await service.read({ role: "operator", runId: fixture.privateDraft.meta.runId })).privateDraftProblem, "source-unavailable", kind);
  }
  // Two forge names side by side are a copy of the list, which a forge added to FORGES would not reach: every draft of
  // that forge would read as source-unavailable.
  const names = FORGE_KINDS.join("|");
  assert.doesNotMatch(readFileSync(new URL("../src/answerer-data.mjs", import.meta.url), "utf8"), new RegExp(`\\b(?:${names})\\b\\W+\\b(?:${names})\\b`));
});

// Issue #824: the configured root is the forge table's (`forgeApiRoot`), so a forge added to FORGES is bound to its own
// root, not read as config-changed. A forge needs an env here that configures it and the root a draft captured under it,
// and that is the walk's point.
const CONFIGURED = {
  github: [{}, "https://api.github.com"],
  gitlab: [{ GITLAB_TOKEN: "synthetic", GITLAB_URL: "https://gitlab.example/team" }, "https://gitlab.example/team"],
  forgejo: [{ FORGEJO_TOKEN: "synthetic", FORGEJO_URL: "https://code.example" }, "https://code.example"],
  azure: [{ AZURE_TOKEN: "synthetic", AZURE_ORG_URL: "https://dev.azure.com/acme" }, "https://dev.azure.com/acme"],
};
const unbound = async (kinds) => {
  const refused = [];
  for (const kind of kinds) {
    const [env, apiUrl] = CONFIGURED[kind] ?? [{}, "https://forge.example"];
    const { service } = setup({ env, source: { kind, apiUrl } });
    if (!(await service.read({ role: "operator", runId: fixture.privateDraft.meta.runId })).privateDraft) refused.push(`${kind}: configuredApiRoot (admin/src/answerer-data.mjs) does not bind a draft to its configured root`);
  }
  return refused;
};

test("configuredApiRoot binds a draft of every FORGE_KINDS forge to its configured root, through the forge table, one loader at a time (#824)", async () => {
  assert.deepEqual(await unbound(FORGE_KINDS), []);
  assert.deepEqual(await unbound([...FORGE_KINDS, "bitbucket"]), ["bitbucket: configuredApiRoot (admin/src/answerer-data.mjs) does not bind a draft to its configured root"]);
  // Only the asked forge's loader runs: a GitLab block the loader refuses leaves a Forgejo draft bound.
  const { service } = setup({ env: { ...CONFIGURED.forgejo[0], GITLAB_TOKEN: "synthetic", GITLAB_AUTH_SOURCE: "app" }, source: { kind: "forgejo", apiUrl: CONFIGURED.forgejo[1] } });
  assert.ok((await service.read({ role: "operator", runId: fixture.privateDraft.meta.runId })).privateDraft);
  // GitHub's root is the table's, not written here again.
  assert.doesNotMatch(readFileSync(new URL("../src/answerer-data.mjs", import.meta.url), "utf8"), /api\.github\.com/);
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

test("a standing answer is checked and previewed as the writer writes it: stamped, without a dropped version 1, and today's bytes with no rule", async () => {
  // A Forgejo repository stands in for a forge a later release adds to FORGES, whose answers need a version 2 rule.
  const versions = { blockValueTable: Object.freeze({ standingAnswers: answers => (Array.isArray(answers) && answers.some(a => String(a?.repo).startsWith("forgejo:")) ? 2 : 1) }), supported: 2 };
  const params = { title: "Forgejo convention", text: "Use the repository's own test helper.", projects: ["api"], repo: "forgejo:acme/api" };
  const stamped = setup();
  const got = planStandingAnswerAdd({ params, paths: stamped.paths, now: () => AT, versions });
  assert.ok(got.plan, JSON.stringify(got));
  assert.ok(got.plan.afterText.startsWith('{\n  "version": 2,\n  "triggers": ['), got.plan.afterText);
  assert.deepEqual(applyStandingAnswerAdd({ plan: got.plan, paths: stamped.paths, versions }), { ok: true });
  assert.equal(readFileSync(stamped.paths.triggersPath, "utf8"), got.plan.afterText, "the applied file is the preview");
  // The stamped file is read by the same rules, and the next answer keeps its stamp.
  const next = planStandingAnswerAdd({ params: { ...params, title: "Second convention" }, paths: stamped.paths, now: () => AT, versions });
  assert.ok(next.plan?.afterText.startsWith('{\n  "version": 2,\n  "triggers": ['), JSON.stringify(next));

  // A hand-written "version": 1 is dropped by the writer, so the preview the service confirms and its digest drop it too.
  const one = setup();
  const raw = JSON.parse(readFileSync(one.paths.triggersPath, "utf8"));
  writeFileSync(one.paths.triggersPath, JSON.stringify({ version: 1, ...raw }));
  const plan = (await one.service.preview("standing-answer-add", params)).plan;
  assert.ok(plan);
  assert.doesNotMatch(plan.afterText, /"version"/);
  assert.deepEqual(await one.service.apply("standing-answer-add", { payload: { params, adoptedAt: plan.answer.adoptedAt }, beforeDigest: plan.beforeDigest, afterDigest: plan.afterDigest }), { ok: true });
  assert.equal(readFileSync(one.paths.triggersPath, "utf8"), plan.afterText);

  // With every table empty the same answer is accepted unstamped, in today's exact bytes.
  const today = setup();
  const plain = planStandingAnswerAdd({ params, paths: today.paths, now: () => AT });
  assert.equal(plain.plan.afterText, `${JSON.stringify({ ...raw, standingAnswers: [...raw.standingAnswers, plain.plan.answer] }, null, 2)}\n`);
  assert.deepEqual(applyStandingAnswerAdd({ plan: plain.plan, paths: today.paths }), { ok: true });
  assert.equal(readFileSync(today.paths.triggersPath, "utf8"), plain.plan.afterText);
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

test("a triggers file that does not load gives an operator no standing list, where a loaded one with none gives an empty list", async () => {
  const { paths, service } = setup();
  assert.deepEqual((await service.read({ role: "operator" })).standing.map((answer) => answer.id), fixture.standing.map((answer) => answer.id));
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [] }));
  assert.deepEqual((await service.read({ role: "operator" })).standing, [], "a file that loaded and holds none");
  writeFileSync(paths.triggersPath, "{ not json");
  const got = await service.read({ role: "operator" });
  assert.equal(got.state, "configuration-unavailable");
  assert.ok(!Object.hasOwn(got, "standing"), "no list, so the page cannot say none was adopted");
  assert.deepEqual(got.rules, []);
});

test("a draft's drop that its store gave up on says may or may not once the write was asked for, and Valkey unreachable while it had only read (#987)", async () => {
  // The store ends each command by a timer of its own and throws an error that cannot say whether the command was sent:
  // what was asked of the client says it. The real service over a store that asks the client as the real one does.
  const { paths } = setup();
  const doc = JSON.parse(readFileSync(paths.triggersPath));
  const asked = [];
  const gaveUp = () => { throw new Error("answer-store-timeout"); };
  const service = (drop) => makeAnswererService({
    paths, now: () => AT,
    redisFn: () => ({ get: async (key) => (asked.push(`get ${key}`), null), eval: async (...args) => (asked.push(`eval ${args[2]}`), 1), del: async (key) => (asked.push(`del ${key}`), 1), disconnect() {} }),
    storeFn: ({ redis }) => ({
      privateInput: async () => ({ runId: fixture.privateDraft.meta.runId, ruleId: fixture.rules[0].id, configDigest: answerRuleConfigDigest(doc, fixture.rules[0]), project: "web", source: { kind: "github", repo: "acme/web", apiUrl: "https://api.github.com", target: { type: "issue", number: 512 } } }),
      privateDraft: async () => fixture.privateDraft,
      drop: () => drop(redis),
    }),
  });
  const entry = { payload: { params: { runId: fixture.privateDraft.meta.runId, draftRunId: fixture.privateDraft.meta.draftRunId, digest: fixture.privateDraft.digest } } };
  const dropped = (drop) => service(drop).apply("answer-draft-drop", entry);
  // The row's compare-and-set was asked for and the store gave up on it: it may land when Valkey answers.
  assert.deepEqual(await dropped(async (redis) => { await redis.get("meta"); await redis.eval("script", 1, "meta"); gaveUp(); }), { invalid: DRAFT_DROP_UNCONFIRMED, partial: true });
  assert.equal(DRAFT_DROP_UNCONFIRMED, "The draft may or may not have been dropped: the drop was asked for and Valkey did not answer. Reload its run page once Valkey answers before trying again.");
  assert.ok([...DRAFT_DROP_UNCONFIRMED].length <= 200, "an audit row keeps the whole sentence");
  // So does the delete of the draft's body, asked for after a row that was answered.
  assert.deepEqual(await dropped(async (redis) => { await redis.eval("script", 1, "meta"); await redis.del("private"); gaveUp(); }), { invalid: DRAFT_DROP_UNCONFIRMED, partial: true });
  // The store gave up at its own read of the row: nothing was asked to change.
  assert.deepEqual(await dropped(async (redis) => { await redis.get("meta"); gaveUp(); }), { unreachable: true });
  // Valkey's own reply is an answer, and is thrown on as it is.
  const replied = Object.assign(new Error("READONLY You can't write against a read only replica."), { name: "ReplyError" });
  await assert.rejects(dropped(async (redis) => { await redis.eval("script", 1, "meta"); throw replied; }), (error) => error === replied);
  // A drop that was answered says what it said.
  assert.deepEqual(await dropped(async () => true), { ok: true });
  assert.deepEqual(await dropped(async () => false), { invalid: "The draft changed before it could be dropped. Reload its run page." });
  assert.deepEqual(asked, ["get meta", "eval meta", "eval meta", "del private", "get meta", "eval meta"]);
});
