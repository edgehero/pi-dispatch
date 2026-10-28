import { test } from "node:test";
import assert from "node:assert/strict";
import { getForkPoints } from "../src/console/fork-api.mjs";
import { ROUTES } from "../src/console/server.mjs";

function ctx(query, readForkPoints) {
  const replies = [];
  return { replies, searchParams: new URLSearchParams(query), deps: { actionDeps: { rm: { readForkPoints }, env: {} }, now: () => 0 }, json(status, body) { replies.push({ status, body }); } };
}

test("fork metadata route requires operator authentication and is read-only", () => {
  const route = ROUTES.find((r) => r.path === "/api/fork-points");
  assert.equal(route.auth, "operator");
  assert.equal(route.write, false);
});

test("fork points expose only entry metadata, never source transcript or filesystem path", async () => {
  const c = ctx("id=source", async () => ({ ok: true, transcriptPath: "/private/file", entries: [{ id: "entry", parentId: null, type: "message", role: "user", positions: ["before"], text: "private source text" }] }));
  await getForkPoints(c);
  assert.equal(c.replies[0].status, 200);
  assert.deepEqual(c.replies[0].body, { entries: [{ id: "entry", parentId: null, type: "message", role: "user", positions: ["before"] }] });
});

test("missing, repeated and unexpected query fields are refused before source reads", async () => {
  for (const query of ["", "id=a&id=b", "id=a&path=/private"]) {
    const c = ctx(query, () => { throw new Error("must not read"); });
    await getForkPoints(c);
    assert.equal(c.replies[0].status, 400);
  }
});

test("an unavailable source has a named refusal and no metadata", async () => {
  const c = ctx("id=old", async () => ({ refusal: "fork-source-expired" }));
  await getForkPoints(c);
  assert.deepEqual(c.replies, [{ status: 409, body: { error: "fork-source-expired" } }]);
});

test("run actions offer exactly supported point combinations and withhold fork controls from viewers", async () => {
  const { runActionsPanel } = await import("../src/console/panels/run.mjs");
  const data = { run: { record: { jobId: "source", kind: "github", target: "owner/repo#7", outcome: "completed" } }, rerunCheck: { ok: true }, forkPoints: { ok: true, entries: [{ id: "first", type: "message", role: "user", positions: ["before"] }, { id: "next", type: "message", role: "assistant", positions: ["at"] }, { id: "unsafe", type: "message", positions: [] }] } };
  const view = { role: "operator", now: 0, query: { id: "source" }, data };
  const page = String(runActionsPanel(view));
  assert.match(page, /data-action="run-fork"/);
  assert.match(page, /value="first:before"/);
  assert.match(page, /value="next:at"/);
  assert.doesNotMatch(page, /value="first:at"|value="next:before"|unsafe/);
  assert.doesNotMatch(String(runActionsPanel({ ...view, role: "viewer" })), /run-fork/);
  assert.doesNotMatch(String(runActionsPanel({ ...view, data: { ...data, forkPoints: { refusal: "openshell-fork-unsupported" } } })), /data-action="run-fork"/);
});


test("run facts link validated fork lineage and ignore damaged source paths or message text", async () => {
  const { runSummary } = await import("../src/console/panels/run.mjs");
  const record = { jobId: "fork-job", kind: "github", target: "owner/repo#7", outcome: "completed", fork: { id: "a".repeat(32), fromJob: "source-job", fromEntry: "1234abcd", position: "before", model: "model-x", message: "private text" } };
  const view = { role: "operator", now: 0, data: { run: { record } } };
  const text = String(runSummary(view));
  assert.match(text, /Forked from/);
  assert.match(text, /href="\/run\?id=source-job"/);
  assert.match(text, /before 1234abcd/);
  assert.match(text, /model-x/);
  assert.doesNotMatch(text, /private text/);
  const bad = String(runSummary({ ...view, data: { run: { record: { ...record, fork: { ...record.fork, fromJob: "../../private" } } } } }));
  assert.doesNotMatch(bad, /Forked from|private/);
});


test("unavailable fork controls explain the run record's bounded archival refusal", async () => {
  const { runActionsPanel } = await import("../src/console/panels/run.mjs");
  const record = { jobId: "source", kind: "github", target: "owner/repo#7", outcome: "completed", forkSource: { saved: false, reason: "capacity" } };
  const view = { role: "operator", now: 0, data: { run: { record }, forkPoints: { refusal: "fork-source-missing" } } };
  assert.match(String(runActionsPanel(view)), /Fork unavailable: capacity/);
  record.forkSource.reason = "/private/raw-error";
  assert.doesNotMatch(String(runActionsPanel(view)), /private|raw-error/);
});
