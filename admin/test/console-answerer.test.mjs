import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { renderPage, pagePanels, parsePageQuery, loadPageData } from "../src/console/pages.mjs";
import { answerForm } from "../src/console/kit.mjs";
import { answererParked, answererProbabilities, offeredAnswerDraft } from "../src/console/panels/answerer.mjs";
import { ANSWERER_CSS } from "../src/console/answerer-css.mjs";
import { AGENT_POLICY_CSS } from "../src/console/agent-policy-css.mjs";
import { parseAuditQuery, auditQueryString, readAuditView } from "../src/console/audit-view.mjs";
import { answererFixture, answererParkedRows, renderAnswererState } from "./helpers/answerer-goldens.mjs";

const AT = Date.parse("2026-10-31T12:00:00Z");

test("answer rules show named evidence and probabilities in the inbox, never question or draft bytes", async () => {
  const page = await renderAnswererState("populated", "operator", { now: AT });
  const fixture = answererFixture(AT);
  assert.ok(!page.includes(fixture.privateDraft.question));
  assert.ok(!page.includes(fixture.privateDraft.draft));
  assert.match(page, /docs\/CONTRIBUTING\.md/);
  assert.match(page, /aria-label="category: convention, 0\.86"/);
  assert.match(page, /aria-label="answerable_from_sources: yes, 0\.91"/);
  assert.match(page, /href="\/run\?id=gh-6e1d">Open the draft/);
  assert.match(page, /href="\/parked\/rules#narrow-known-conventions-convention"/);
  assert.match(page, /Adopted by you/);
  assert.match(page, /confirmed|confirm/i);
});

test("probability bars show all recorded choices and refuse to invent a missing or malformed distribution", () => {
  const fixture = answererFixture(AT), meta = fixture.rows[0], rule = fixture.rules[0];
  const complete = String(answererProbabilities(meta, rule));
  for (const [name, p] of Object.entries(meta.probabilities)) assert.ok(complete.includes(`aria-label="category: ${name}, ${p.toFixed(2)}"`));
  assert.match(complete, /answerable_from_sources: no, 0\.09/);
  assert.match(complete, /complement of the recorded binary yes confidence/);
  assert.match(complete, /width="86"/);
  for (const probabilities of [undefined, { convention: 0.86 }, { ...meta.probabilities, convention: 0.4 }, { ...meta.probabilities, surprise: 0 }]) {
    const old = String(answererProbabilities({ ...meta, probabilities }, rule));
    assert.match(old, /Category distribution unavailable\. Recorded selected confidence: 0\.86/);
    assert.ok(!old.includes('aria-label="category:'));
  }
});

test("viewer and agent rendering removes classification, sources, standing text, rules and every action even from a private shared load", () => {
  const fixture = answererFixture(AT);
  for (const role of ["viewer", "agent"]) {
    const page = String(answererParked({ role, now: AT, data: { answerer: fixture, snapshot: { parked: answererParkedRows(AT) } } }));
    assert.match(page, /A draft is ready/);
    assert.ok(!page.includes('class="cols"'), "A role without a sidebar receives the full available width");
    assert.match(page, /answered by ops/);
    for (const canary of [fixture.privateDraft.question, fixture.privateDraft.draft, "CONTRIBUTING", "convention", "category-disallowed", "0.86", "standing-answer-add", "data-action", "textarea", "example/drafter"]) assert.ok(!page.includes(canary), `${role}: ${canary}`);
  }
});

test("run answer prefill binds the exact retained source and refuses source-free, low-confidence or mismatched drafts", async () => {
  const fixture = answererFixture(AT);
  const view = { role: "operator", query: { id: fixture.privateDraft.meta.runId }, data: { answerer: fixture } };
  assert.equal(offeredAnswerDraft(view).draft, fixture.privateDraft.draft);
  for (const change of [draft => { draft.sources = []; draft.meta.sources = []; }, draft => { draft.meta.confidence = 0.79; }, draft => { draft.meta.category = "security"; }, draft => { draft.meta.runId = "wrong-run"; }]) {
    const bad = structuredClone(view); change(bad.data.answerer.privateDraft);
    assert.equal(offeredAnswerDraft(bad), null);
  }
  const page = await renderAnswererState("run", "operator", { now: AT });
  assert.match(page, /name="draftRunId" value="gh-a07c"/);
  assert.match(page, /name="draftDigest" value="[a-f0-9]{64}"/);
  assert.match(page, /name="text"[^>]*>Run npm test/);
  assert.match(page, /data-keep-standing/);
  assert.match(page, /name="repo" value="github:acme\/web"/);
  const stale = await renderAnswererState("stale", "operator", { now: AT });
  assert.match(stale, /This draft cannot be offered/);
  assert.match(stale, /the reviewed answer configuration changed/);
  assert.ok(!stale.includes(fixture.privateDraft.draft));
});

test("a helper run shows its private draft to an operator and can never prefill or attribute a helper reply", async () => {
  const fixture = answererFixture(AT), id = fixture.privateDraft.meta.draftRunId;
  const data = { now: AT, answerer: fixture, run: { record: { jobId: id, purpose: "answer-draft", answerDraft: { sourceRunId: fixture.privateDraft.meta.runId, ruleId: fixture.rules[0].id }, project: "web", kind: "github", target: "acme/web#512", reason: "awaiting-input", outcome: "completed", endedAt: new Date(AT - 60000).toISOString() } }, chat: { mode: "reply", state: "parked", jobState: "completed" }, chatAnswer: { ok: true }, transcript: { exists: false, ended: true } };
  const operator = String((await renderPage("run", { session: { name: "ops", role: "operator" }, query: { id }, data })).html);
  assert.ok(operator.includes(fixture.privateDraft.question)); assert.ok(operator.includes(fixture.privateDraft.draft));
  assert.ok(!operator.includes('data-action="parked-answer"'));
  assert.ok(operator.includes('the parked source run'));
  for (const role of ["viewer", "agent"]) {
    const page = String((await renderPage("run", { session: { name: role, role }, query: { id }, data })).html);
    for (const canary of [fixture.privateDraft.question, fixture.privateDraft.draft, "CONTRIBUTING", "Answer draft"]) assert.ok(!page.includes(canary), role);
  }
});

test("a manual answer sends no draft attribution and prefilled hostile text is escaped inside the textarea", () => {
  const plain = String(answerForm({ jobId: "gh-source", id: "answer", hint: "Review" }));
  assert.ok(!plain.includes("draftRunId"));
  const draft = String(answerForm({ jobId: "gh-source", id: "answer", hint: "Review", value: "</textarea><script>HOSTILE</script>", draft: { draftRunId: "gh-draft", digest: "a".repeat(64) } }));
  assert.ok(!draft.includes("<script>"));
  assert.match(draft, /&lt;\/textarea&gt;&lt;script&gt;HOSTILE/);
});

test("a read-only operator keeps sources and rule facts but has no answer, drop or adoption forms", async () => {
  const page = await renderAnswererState("populated", "operator", { now: AT, readOnly: true });
  assert.match(page, /docs\/CONTRIBUTING\.md/);
  assert.match(page, /example\/drafter/);
  assert.ok(!page.includes("<form"));
  const rules = await renderAnswererState("rules", "operator", { now: AT, readOnly: true });
  assert.match(rules, /Read only here/);
  assert.match(rules, /Remove convention/);
  assert.ok(!rules.includes("<form"));
});

test("the rule detail route is operator-only, has no query authority and stays navigable without scripts", async () => {
  assert.deepEqual(parsePageQuery("answer-rules", "").query, {});
  assert.ok(parsePageQuery("answer-rules", "mode=send").refusal);
  for (const role of ["viewer", "agent"]) assert.equal((await renderPage("answer-rules", { session: { role }, data: { now: AT }, query: {} })).status, 403);
  const page = await renderAnswererState("rules", "operator", { now: AT });
  assert.match(page, /<fieldset data-answerer-control disabled>/);
  assert.match(page, /<noscript>/);
  assert.match(page, /Reading and navigation work without JavaScript/);
});

test("answerer and action capability CSS are exact copies of the correctly styled source generators", () => {
  const source = readFileSync(new URL("../../design/tools/gen_answerer.py", import.meta.url), "utf8");
  const css = source.match(/^CSS = """([\s\S]*?)"""/m)[1];
  const extra = [...source.matchAll(/^CSS \+= """([\s\S]*?)"""/gm)].map(m => m[1]).join("");
  const variants = source.match(/^VARIANT_CSS = """([\s\S]*?)"""/m)[1];
  assert.equal(ANSWERER_CSS, css + extra + variants);
  const actions = readFileSync(new URL("../../design/tools/gen_components.py", import.meta.url), "utf8");
  assert.equal(AGENT_POLICY_CSS, actions.match(/^AGENT_POLICY_CSS = """([\s\S]*?)"""/m)[1]);
});

test("agent audit filter is native, closed, preserved in cursors and isolates roles sharing one name", async () => {
  const q = parseAuditQuery("role=agent&who=ops&action=write-applied").query;
  assert.equal(q.role, "agent");
  assert.equal(auditQueryString(q, { before: "2026-10:3" }), "before=2026-10%3A3&who=ops&role=agent&action=write-applied");
  assert.ok(parseAuditQuery("role=SECRET").refusal && !parseAuditQuery("role=SECRET").refusal.includes("SECRET"));
  assert.ok(parseAuditQuery("role=agent&role=operator").refusal);
  assert.ok(parseAuditQuery("role=agent&seq=2").refusal);
  const entries = [{ seq: 3, actor: { name: "ops", role: "operator" }, action: "write-applied", outcome: "ok" }, { seq: 2, actor: { name: "ops", role: "agent" }, action: "write-applied", outcome: "ok" }, { seq: 1, actor: { name: "ops", role: "agent" }, action: "write", outcome: "refused" }];
  const read = await readAuditView({ query: q, read: async () => ({ rows: entries, positions: ["2026-10:3", "2026-10:2", "2026-10:1"], next: null }), verify: async () => ({ ok: true, rows: 3, startsAt: null, last: { file: "2026-10.jsonl", line: 3, seq: 3 }, files: [{ file: "2026-10.jsonl", seq: 1, rows: 3 }] }) });
  assert.deepEqual(read.rows.map(row => row.entry.seq), [2]);
});

test("trusted shared live loads keep the operator draft while viewer, agent and unspecified requests never ask for private bytes", async () => {
  const calls = [];
  const deps = { now: () => AT, answerer: { read: async request => { calls.push(request); return {}; } }, fleet: { runById: async () => ({ missing: true }) } };
  for (const who of [{ role: "operator" }, { live: true }, { role: "viewer" }, { role: "agent" }, {}, { live: true, role: "viewer" }, { live: true, role: "agent" }]) await loadPageData("run", { id: "gh-source" }, deps, who);
  assert.deepEqual(calls.slice(0, 2), [{ role: "operator", runId: "gh-source" }, { role: "operator", runId: "gh-source" }]);
  assert.deepEqual(calls.slice(2), [{ role: "viewer" }, { role: "agent" }, { role: "viewer" }, { role: "viewer" }, { role: "agent" }]);
});
