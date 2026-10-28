import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS } from "../src/console/actions.mjs";
import { PAGES } from "../src/console/pages.mjs";
import { parkedQuestions } from "../src/console/panels/parked.mjs";
import { runChat } from "../src/console/panels/run.mjs";
import { safeRunOf } from "../src/console/run-api.mjs";
import { readParkedRuns } from "../src/read-model.mjs";
import { outcomeWord, outcomeKey } from "../src/words.mjs";

const AT = Date.UTC(2026, 9, 28, 12);
const approval = { jobId: "gh-approval", kind: "github", target: "acme/web#1", outcome: "completed", reason: "awaiting-approval", endedAt: new Date(AT).toISOString(), approval: { requestId: "a".repeat(64), action: "budget-raise", summary: "PRIVATE-SUMMARY" } };

test("approval parks stay in the shared inbox, carry only identifiers, and leave after a newer run answers", () => {
  const rows = readParkedRuns({ runs: [approval], now: () => AT, unansweredOnly: true });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].approval, { requestId: "a".repeat(64), action: "budget-raise" });
  assert.equal(rows[0].reason, "awaiting-approval");
  assert.ok(!JSON.stringify(rows).includes("PRIVATE-SUMMARY"));
  assert.deepEqual(readParkedRuns({ runs: [approval, { ...approval, jobId: "gh-answer", reason: null, endedAt: new Date(AT + 1).toISOString() }], now: () => AT + 1, unansweredOnly: true }), []);
  assert.equal(outcomeWord("completed", "awaiting-approval").word, "awaiting approval");
  assert.equal(outcomeKey("completed", "awaiting-approval"), "awaiting-approval");
});

test("approval controls share the answer confirmation action, and viewers and read-only consoles have none", () => {
  const [row] = readParkedRuns({ runs: [approval], now: () => AT });
  const draw = (role, readOnly = false, action = "budget-raise") => String(parkedQuestions({ pages: PAGES, role, readOnly, now: AT, data: { snapshot: { parked: [{ ...row, approval: { ...row.approval, action }, pendingScan: { jobId: null } }] }, parkedChecks: { "gh-approval": { ok: true } } } }));
  const op = draw("operator");
  assert.match(op, /Awaiting approval for/);
  assert.match(op, /Worker-enforced/);
  assert.match(op, /name="decision" value="approve"/);
  assert.match(op, /name="decision" value="decline"/);
  assert.equal((op.match(/data-action="parked-answer"/g) ?? []).length, 3);
  assert.match(op, /question and no approval is granted/);
  assert.match(draw("operator", false, "deploy:staging"), /Advisory: the worker does not enforce/);
  assert.ok(!op.includes("PRIVATE-SUMMARY"));
  for (const out of [draw("viewer"), draw("operator", true)]) assert.doesNotMatch(out, /<form|name="decision"/);
});

test("typed console decisions canonicalize into the existing answer planner and preserve the authenticated actor", async () => {
  const action = ACTIONS.find((a) => a.name === "parked-answer");
  const seen = [];
  const ctx = { a: { paths: {}, env: {}, rm: { planParkedAnswer: async (args) => { seen.push(args); return { refusal: "test stopped before enqueue" }; } } }, session: { name: "operator" }, now: () => AT };
  for (const [body, expected] of [[{ decision: "approve", text: "ignored" }, "/approve"], [{ decision: "decline", text: "  stay on staging  " }, "/decline stay on staging"], [{ decision: "decline" }, "/decline"], [{ text: "Which deployment?" }, "Which deployment?"]]) {
    await action.preview({ jobId: "gh-approval", ...body }, ctx);
    assert.equal(seen.at(-1).text, expected);
    assert.equal(seen.at(-1).by, "operator");
  }
  const count = seen.length;
  assert.match((await action.preview({ jobId: "gh-approval", decision: "other" }, ctx)).refusal, /must be approve or decline/);
  assert.equal(seen.length, count, "invalid decisions fail before reading or queueing");
});

test("the terminal API exposes only validated approval metadata", () => {
  assert.deepEqual(safeRunOf("gh-approval", approval).approval, { requestId: "a".repeat(64), action: "budget-raise" });
  assert.equal(safeRunOf("gh-approval", { ...approval, approval: { requestId: "bad", action: "PRIVATE-SUMMARY" } }).approval, undefined);
});

test("the run chat names the approval gate and its enforcement boundary above the decision controls", () => {
  const draw = (action) => String(runChat({ role: "operator", readOnly: false, now: AT, env: {}, query: { id: approval.jobId }, data: { chat: { mode: "reply", state: "awaiting-approval" }, chatAnswer: { ok: true }, run: { record: { ...approval, approval: { ...approval.approval, action } } } } }));
  assert.match(draw("budget-raise"), /Awaiting approval for <span class="code">budget-raise/);
  assert.match(draw("budget-raise"), /Worker-enforced/);
  assert.match(draw("deploy:staging"), /Advisory: the worker does not enforce/);
  assert.match(draw("budget-raise"), /name="decision" value="approve"/);
});
